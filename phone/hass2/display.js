// Sends card pictures to the glasses as LZ4 tiles on the private picture
// channel: the glasses decompress each tile, fold it into the picture they are
// assembling and paint it in one step once the last row is in. A GRAY_4 card is
// mostly long runs of one nibble, so the compressed tiles are several times
// smaller than the raw ones: the whole card crosses the link in one or two
// messages instead of six, which is what made a card take seconds to show.
//
// A notify on the page channel names the card first: it tells the glasses which
// page the picture belongs to and tears down the waiting body.

import { PAGES_CHANNEL, IMAGE_LZ4_CHANNEL, encodeNotifyCard } from './protocol.js';

/* Rows are kept as whole 16-pixel blocks: every tile boundary then falls on a
 * GRAY_4 byte, so a compressed tile decodes to exactly stride x height. */
const ROW_QUANTUM = 16;
/* Row grid used to cut a scroll patch, kept equal to the smallest tile height
 * so the strip lands on tile boundaries. */
const TILE_HEIGHT = 64;
/* Tile budget: 600 x 256 bytes = 76 800 pixel bytes, so a card travels in two
 * messages rather than one 105 KB tile. */
const MAX_TILE_BYTES = 76800;
const MIN_TILE_HEIGHT = 16;

// [page:u16 x:u16 y:u16 width:u16 height:u16 stride:u16 decoded:u32,
//  big-endian] + one raw LZ4 block.
const FRAME_TILE_HEADER_BYTES = 16;
// The glasses decode a tile into a 64 KiB static scratch, so a tile must never
// decode to more than that; MAX_TILE_BYTES (76 800) is the real cut and this
// guard only rejects a mis-sliced tile.
const MAX_DECODED_BYTES = 64 * 1024 - 12;
/* A match may not reach into the last 5 bytes: a block has to end on literals,
 * and the device's decoder rejects an offset read past the current position. */
const MATCH_TAIL = 5;
const MATCH_MIN = 4;
const OFFSET_LIMIT = 65535;

// Copy of one GRAY_4 row, as stored: byte i holds pixels 2i (high nibble) and
// 2i+1 (low nibble), exactly the order the Host framebuffer expects (see
// GlassSDK/docs/GRAPHICS.md: "even x = high nibble, odd x = low nibble"). The
// renderer already produces that order (rgbaToGray4 and renderToCanvas pack the
// even pixel in the high nibble), so the row is copied verbatim. It used to
// swap the nibbles "back" here on the belief that the phone rendered low-first,
// which flipped every horizontal pixel pair on the wire: a GRAY_4 card then
// reached the panel with its neighbouring pixels transposed, and thin glyph
// strokes came out as a dotted, half-missing mess.
function packRow(source, rowStart, stride) {
  return source.subarray(rowStart, rowStart + stride);
}

/* Writes one GRAY_4 row of tokens lazily. Every byte goes through `byte`, and
 * the length extension follows the LZ4 rule exactly: the token digit is 15, an
 * extension byte is then mandatory even for a zero remainder. */
class BlockWriter {
  constructor(capacity) {
    this.buf = new Uint8Array(capacity);
    this.cursor = 0;
  }

  byte(value) {
    this.buf[this.cursor] = value & 0xff;
    this.cursor += 1;
  }

  /* Extension bytes of a length whose token digit is `Math.min(15, length)`.
   * Below 15 the digit carries the length itself and nothing follows. */
  length(value) {
    if (value < 15) return;
    let remaining = value - 15;
    while (remaining >= 255) {
      this.byte(255);
      remaining -= 255;
    }
    this.byte(remaining);
  }

  copy(input, from, to) {
    for (let i = from; i < to; i += 1) this.byte(input[i]);
  }

  finish() {
    return this.buf.slice(0, this.cursor);
  }
}

// Last index of `input` where a 4-byte key can still start a match.
function matchScanLimit(sourceLength) {
  return sourceLength - MATCH_TAIL - MATCH_MIN;
}

/* Hash of a 4-byte key into `tableBits`. Math.imul keeps the product in 32 bits:
 * a plain `*` overflows the double mantissa, the low bits are lost and the shift
 * reads rounded noise. */
function hashSlot(sequence, tableBits) {
  const mixed = Math.imul(sequence, 0x9e3779b1) >>> 0;
  return (mixed >>> (32 - tableBits)) & ((1 << tableBits) - 1);
}

function readKey(input, offset) {
  return (input[offset] | (input[offset + 1] << 8) |
    (input[offset + 2] << 16) | (input[offset + 3] << 24)) >>> 0;
}

/* One greedy pass over `input[from..to)`, appending compressed sequences to the
 * writer. Matches never run into the last 5 bytes before `to`, never reach
 * further back than 65 535 bytes, and never start on byte 0. */
function compressRange(input, from, to, writer, tableBits) {
  const span = to - from;
  if (span <= 0) return;
  const tableSize = 1 << tableBits;
  const table = new Int32Array(tableSize).fill(-1);
  const start = matchScanLimit(span);
  const tail = span - MATCH_TAIL;
  let position = 0;
  let anchor = 0;
  while (position <= start) {
    const slot = hashSlot(readKey(input, from + position), tableBits);
    const candidate = table[slot];
    table[slot] = position;
    /* A match cannot reach behind the block start, and its offset must stay
     * positive: `position` is relative to `from`, so the furthest usable
     * candidate is 0 (`distance === position`), even though the LZ4 offset
     * field itself allows 65 535. */
    if (candidate < 0 || position - candidate > OFFSET_LIMIT) {
      position += 1;
      continue;
    }
    const distance = position - candidate;
    /* The match is compared against the candidate's own bytes, which sit
     * `distance` behind `position`, so its absolute index is `from + candidate`
     * (equivalently `from + position - distance`). Using `from + distance`
     * here would compare the position against itself whenever `from` is 0. */
    const biased = from + candidate;
    let length = 0;
    while (length < MATCH_MIN) {
      if (input[from + position + length] !== input[biased + length]) {
        break;
      }
      length += 1;
    }
    if (length < MATCH_MIN) {
      position += 1;
      continue;
    }
    /* Grow the match to the end of the repeated run. Matches stop before
     * `tail` so the block always closes on literals. */
    while (position + length < tail &&
           input[from + position + length] === input[biased + length]) {
      length += 1;
    }
    writeSequence(writer, input, from + anchor, from + position, distance, length);
    position += length;
    anchor = position;
    if (position >= tail) break;
  }
  closeLiteralRun(writer, input, from + anchor, to);
}

/* One LZ4 sequence: the token carries the literal length in its high digit and
 * the (match length - 4) in its low digit. Then come the literal length
 * extension, the literals, the 2-byte little-endian offset, and only then the
 * match length extension. `length` includes the 4-byte match minimum. */
function writeSequence(writer, input, literalFrom, literalTo, distance, length) {
  const literalLength = literalTo - literalFrom;
  const matchLength = length - MATCH_MIN;
  const literals = input.subarray(literalFrom, literalTo);
  writer.byte((Math.min(15, literalLength) << 4) + Math.min(15, matchLength));
  writer.length(literalLength);
  for (let i = 0; i < literalLength; i += 1) writer.byte(literals[i]);
  writer.byte(distance & 0xff);
  writer.byte((distance >> 8) & 0xff);
  writer.length(matchLength);
}

/* Closes a block with the bytes no match covers. */
function closeLiteralRun(writer, input, from, to) {
  const length = to - from;
  if (length <= 0) return;
  writer.byte(Math.min(15, length) << 4);
  writer.length(length);
  writer.copy(input, from, to);
}

/* Raw LZ4 block compression, greedy single pass. The device decodes one
 * unframed block per tile: the block is a stream of sequences, each one a token
 * (literal length in the high digit, match length in the low digit), the literal
 * bytes, the 2-byte little-endian match offset, then a final literal-only run. */
export function lz4CompressBlock(input) {
  const size = input.length;
  if (size === 0) return new Uint8Array(0);
  /* Worst case: every sequence costs a token and a literal plus its offset, and
   * a long run needs one byte per 255. An all-literal block needs that much. */
  const worst = size + Math.ceil(size / 255) + 16;
  const writer = new BlockWriter(worst);
  /* A full GRAY_4 screen is 105 000 bytes; a 12-bit hash table then collides so
   * often that every match is lost and the block can grow past the pixel
   * count. 16 bits still fits a 256 KB throwaway allocation and keeps the
   * card's long background runs matched. */
  compressRange(input, 0, size, writer, 16);
  return writer.finish();
}

// Cuts a GRAY_4 frame into device-sized tiles. Tiles are full-width and stacked
// vertically: the framed LZ4 channel draws at the geometry it is given, so a
// vertical split is what keeps a card down to a couple of messages.
export function sliceGray4(frame, width, height) {
  const tiles = [];
  if (!frame || !width || !height) return tiles;
  const stride = Math.ceil(width / 2);
  const rowBytes = Math.max(1, Math.floor(MAX_TILE_BYTES / stride));
  const rowsPerTile = Math.max(MIN_TILE_HEIGHT,
    Math.floor(Math.min(height, rowBytes) / ROW_QUANTUM) * ROW_QUANTUM);
  const rowCount = Math.ceil(height / rowsPerTile);
  const tileHeight = Math.ceil(height / rowCount);
  for (let y = 0; y < height; y += tileHeight) {
    const rows = Math.min(tileHeight, height - y);
    const bytes = new Uint8Array(stride * rows);
    for (let row = 0; row < rows; row += 1) {
      bytes.set(packRow(frame, (y + row) * stride, stride), row * stride);
    }
    tiles.push({ x: 0, y, width, height: rows, stride, bytes });
  }
  return tiles;
}

// [page:u16 x:u16 y:u16 w:u16 h:u16 stride:u16 decoded_size:u32] + raw LZ4.
export function encodeImageTile(tile, page) {
  const compressed = lz4CompressBlock(tile.bytes);
  if (tile.bytes.length > MAX_DECODED_BYTES) {
    throw new Error('tile exceeds the decoded ceiling');
  }
  const out = new Uint8Array(FRAME_TILE_HEADER_BYTES + compressed.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, page, false);
  view.setUint16(2, tile.x, false);
  view.setUint16(4, tile.y, false);
  view.setUint16(6, tile.width, false);
  view.setUint16(8, tile.height, false);
  view.setUint16(10, tile.stride, false);
  view.setUint32(12, tile.bytes.length, false);
  out.set(compressed, FRAME_TILE_HEADER_BYTES);
  return out;
}

// Ceiling the channel enforces on one message, header included.
const MAX_MESSAGE_BYTES = 81901;

// Pushes one GRAY_4 picture: a notify label naming the card, then its tiles,
// each compressed. A preload skips the label so a neighbouring page is
// assembled without being shown. Returns the tile count.
async function sendFrame(gm, tiles, page, { preload = false } = {}) {
  if (!preload) {
    await gm.plugin.sendMessage(PAGES_CHANNEL, encodeNotifyCard(page));
  }
  for (let index = 0; index < tiles.length; index += 1) {
    const message = encodeImageTile(tiles[index], page);
    if (message.length > MAX_MESSAGE_BYTES) {
      console.warn('[ha-phone] tile %d too large: %d bytes', index, message.length);
      continue;
    }
    await gm.plugin.sendMessage(IMAGE_LZ4_CHANNEL, message);
  }
  return tiles.length;
}

// Pushes only the rows of `frame` that differ from `previous` (the picture the
// glasses already hold). A head up/down scroll moves the window by a few rows:
// the rows in common are skipped and only the strip that scrolled in travels,
// except when the strip covers (almost) the whole card, in which case the whole
// window is sent as one replacement picture.
export async function presentGray4Patch(gm, frame, previous, width, height, page = 0) {
  if (!previous || previous.length !== frame.length) {
    return presentGray4(gm, frame, width, height, page);
  }
  const stride = Math.ceil(width / 2);
  let first = -1;
  let last = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    let same = true;
    for (let i = 0; i < stride; i += 1) {
      if (frame[row + i] !== previous[row + i]) {
        same = false;
        break;
      }
    }
    if (!same) {
      if (first === -1) first = y;
      last = y;
    }
  }
  // Nothing moved: the picture on the glasses is already right, so the scroll
  // costs no pixels. One notify still re-arms the page: the glasses fade the
  // picture of a page they are leaving, and a silent return would leave them
  // faded. on_screen makes that a repaint, not a zero-tile assembly.
  if (first === -1) {
    await gm.plugin.sendMessage(PAGES_CHANNEL, encodeNotifyCard(page));
    return -1;
  }
  // The strip is cut on the tile grid so it still travels in device-sized
  // tiles; a strip as tall as the card replaces the picture from its top.
  const stripTop = Math.floor(first / TILE_HEIGHT) * TILE_HEIGHT;
  const stripEnd = Math.min(height,
    Math.ceil((last + 1) / TILE_HEIGHT) * TILE_HEIGHT);
  const full = stripTop === 0 && stripEnd >= height;
  const rows = new Uint8Array(stride * (stripEnd - stripTop));
  rows.set(frame.subarray(stripTop * stride, stripEnd * stride));
  const tiles = sliceGray4(rows, width, stripEnd - stripTop).map((tile) => ({
    ...tile,
    y: tile.y + stripTop,
  }));
  const sent = await sendFrame(gm, tiles, page);
  console.info('[ha-phone] patch page=%d rows=%d..%d tiles=%d', page, first, last, sent);
  return full ? sent : -sent;
}

export async function presentGray4(gm, frame, width, height, page = 0,
                                   { preload = false } = {}) {
  const tiles = sliceGray4(frame, width, height);
  console.info('[ha-phone] present page=%d tiles=%d frame=%d', page, tiles.length, frame?.length ?? 0);
  if (tiles.length === 0) return 0;
  // One atomic frame: channel 8 announces the tile count and channel 9 carries
  // compressed tiles, so the glasses present the picture in one paint instead
  // of redrawing it after every tile. Every tile decodes to at most
  // MAX_DECODED_BYTES, well under the channel ceiling.
  return sendFrame(gm, tiles, page, { preload });
}
