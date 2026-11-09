// Binary wire protocol shared with GlassSDK/examples/hass/hass.c.
// Keep both sides in sync if you change any layout or constant here.

export const PAGES_CHANNEL = 0x4A50; // 'JP', phone -> glasses
export const EVENT_CHANNEL = 0x4A51; // 'JQ', glasses -> phone
export const IMAGE_CHANNEL = 0x4A52; // 'JR', phone -> glasses, raw GRAY_4 tiles
/* 'JT', phone -> glasses: the same tiles, each one a raw LZ4 block. A GRAY_4
 * card is mostly long runs of one nibble, so a compressed card is several
 * times smaller and reaches the glasses in two or three messages instead of
 * six. Payload: page:u16 x:u16 y:u16 width:u16 height:u16 stride:u16
 * decoded:u32 then the raw LZ4 block. */
export const IMAGE_LZ4_CHANNEL = 0x4A54;
export const PROTOCOL_VERSION = 2;

export const COMMAND_SET_PAGES = 1;
export const COMMAND_CLEAR = 2;
/* Labels the tiles that follow with the page they belong to. Tiles carry the
 * page in their own header too: the two may arrive out of step. */
export const COMMAND_NOTIFY_CARD = 3;

export const EVENT_PAGE_CHANGED = 1;
export const EVENT_ACTION = 2;
/* The glasses ask for the picture of a card it cannot list (empty row set).
 * The phone then pushes it as GRAY_4 tiles on the public display channels. */
export const EVENT_REQUEST_CARD = 3;
/* Head up/down on a card picture that has more rows than fit on screen:
 * [version, EVENT_SCROLL, page, delta] with delta a signed byte (-1 up, +1
 * down). The phone re-renders that card one row further and pushes it. */
export const EVENT_SCROLL = 4;
/* The glasses' primary button on a card picture: [version, EVENT_CARD_ACTIVATE,
 * page, action]. The card's actionable entities live only on the phone, so the
 * glasses cannot name one; they say "trigger the entity the phone currently
 * focuses" and the phone runs callAction on it. `action` (1.0.28+) tells a
 * plain press (1) from a double press (2): on a media player the double press
 * toggles playback while a plain press keeps stepping the entity ring. An
 * older glasses build sends no fourth byte; decodeEvent treats that as 1. */
export const EVENT_CARD_ACTIVATE = 6;
export const CARD_ACTIVATE_SINGLE = 1;
export const CARD_ACTIVATE_DOUBLE = 2;
/* Head up/down on a card picture: [version, EVENT_CARD_FOCUS, page, delta] with
 * delta a signed byte (-1 up, +1 down). The entity ring lives on the phone (it
 * holds the entity list), so the glasses only report the step and the phone
 * repaints the card with the ring moved.
 *
 * Kept clear of every EVENT_NAV and protocol-version id: 7 collided with
 * NAV_FOCUS_DOWN, so a build-7 glasses' head-up event was decoded as a nav
 * command echo and dropped. */
export const EVENT_CARD_FOCUS = 8;
/* 7 used to carry head up/down on glasses builds 7 and earlier: decoded as a
 * card-focus step, otherwise ignored. */
const EVENT_CARD_FOCUS_LEGACY = 7;
/* Navigation, phone -> glasses, on EVENT_CHANNEL. Payload is
 * [version, EVENT_NAV, command]; the glasses answer with a page-changed
 * event. The dev navigation panel that used to send these is gone; the ids
 * stay so an older phone build cannot be misdecoded. */
export const EVENT_NAV = 5;
export const NAV_PAGE_PREV = 1;
export const NAV_PAGE_NEXT = 2;
export const NAV_ROW_UP = 3;
export const NAV_ROW_DOWN = 4;
export const NAV_ACTIVATE = 5;
/* Added in 1.0.13: ROW_UP/ROW_DOWN pan a picture, so the arrows sent them and
 * the card scrolled instead of moving the entity ring. These two commands do
 * exactly what the head does on a card picture. */
export const NAV_FOCUS_UP = 6;
export const NAV_FOCUS_DOWN = 7;

/* The glasses hold the page table in static RAM; this is the same ceiling. */
export const MAX_PAGES = 16;
/* Per page. The glasses buffer this many rows in a static table; a dashboard
 * card never shows more at once, and scrolling re-sends the window. */
export const MAX_ROWS = 24;
export const MAX_LABEL_BYTES = 32;
export const MAX_VALUE_BYTES = 24;
export const MAX_TITLE_BYTES = 32;
/* An action is an entity id echoed back when the row is activated, never a
 * service call payload; the glasses keep one byte per stored id in their static
 * page table, so both sides cap it here. */
export const MAX_ACTION_BYTES = 24;
/* Icon rows are addressed by id: an index into the glasses' built-in icon
 * table (hass_icons.h). 0xFF means "no icon" and is the default for entries the
 * phone cannot map. Keep the ids aligned with icons.js ICON_NAMES order. */
export const NO_ICON = 0xff;

const encoder = new TextEncoder();

function clampBytes(text, max) {
  let bytes = encoder.encode(text || '');
  if (bytes.length > max) bytes = bytes.slice(0, max);
  return bytes;
}

// [version, cmd, page_count(2),
//   { title_len, title,
//     row_count(2),
//     { icon_id, label_len, label, value_len, value, action_len, action } * row_count } * page_count ,
//   image_flag * page_count ]
// `action` is the entity id the glasses echo back when the row is activated.
// `icon_id` is the row's icon index in the glasses table (0xFF = none).
export function encodeSetPages(pages) {
  const list = (pages || []).slice(0, MAX_PAGES);
  const chunks = [];
  for (const page of list) {
    const title = clampBytes(page.title, MAX_TITLE_BYTES);
    const rows = (page.rows || []).slice(0, MAX_ROWS);
    const rowChunks = [];
    for (const row of rows) {
      const label = clampBytes(row.label, MAX_LABEL_BYTES);
      const value = clampBytes(row.value, MAX_VALUE_BYTES);
      const action = clampBytes(row.action, MAX_ACTION_BYTES);
      const icon = Number.isInteger(row.icon) && row.icon >= 0 && row.icon < 0xff
        ? row.icon : NO_ICON;
      rowChunks.push(new Uint8Array([icon, label.length]), label,
                     new Uint8Array([value.length]), value,
                     new Uint8Array([action.length]), action);
    }
    const rowCount = rows.length;
    chunks.push(
      new Uint8Array([title.length]), title,
      new Uint8Array([rowCount & 0xff, (rowCount >> 8) & 0xff]),
      ...rowChunks,
    );
  }
  const pageCount = list.length;
  const header = new Uint8Array([
    PROTOCOL_VERSION,
    COMMAND_SET_PAGES,
    pageCount & 0xff, (pageCount >> 8) & 0xff,
  ]);
  // Trailer: one flag per page, 1 = the page shows a card picture pushed
  // separately through the display channels instead of a row list.
  const flags = new Uint8Array(list.map((page) => (page.card ? 1 : 0)));
  return concat([header, ...chunks, flags]);
}

// [version, COMMAND_NOTIFY_CARD, page]
export function encodeNotifyCard(page) {
  return new Uint8Array([PROTOCOL_VERSION, COMMAND_NOTIFY_CARD, page & 0xff]);
}

/* [version, EVENT_NAV, command] */
export function encodeNav(command) {
  return new Uint8Array([PROTOCOL_VERSION, EVENT_NAV, command & 0xff]);
}

// [version, cmd, 0, 0]
export function encodeClear() {
  return new Uint8Array([PROTOCOL_VERSION, COMMAND_CLEAR, 0, 0]);
}

// [version, event, page_index]            -> { type: 'page-changed', index }
// [version, event, action_len, action...] -> { type: 'action', action }
// [version, event, page_index, offset]    -> { type: 'request-card', index, offset }
// [version, event, page_index, delta]     -> { type: 'scroll-card', index, delta }
// [version, event, page_index, delta]     -> { type: 'card-focus', index, delta }
// [version, event, page, action]          -> { type: 'card-activate', index, action }
export function decodeEvent(data) {
  if (!data || data.length < 3 || data[0] !== PROTOCOL_VERSION) return null;
  if (data[1] === EVENT_PAGE_CHANGED) return { type: 'page-changed', index: data[2] };
  if (data[1] === EVENT_REQUEST_CARD) {
    // Protocol 2.1 adds the first row of the card window the glasses want. A
    // request from a 2.0 plugin has no fourth byte and asks for the top.
    return { type: 'request-card', index: data[2], offset: data.length > 3 ? data[3] : 0 };
  }
  if (data[1] === EVENT_SCROLL) {
    if (data.length < 4) return null;
    const delta = data[3] > 127 ? data[3] - 256 : data[3];
    return { type: 'scroll-card', index: data[2], delta };
  }
  if (data[1] === EVENT_ACTION) {
    const len = data[2];
    if (data.length < 3 + len) return null;
    const action = new TextDecoder().decode(data.subarray(3, 3 + len));
    return { type: 'action', action };
  }
  if (data[1] === EVENT_CARD_ACTIVATE) {
    const action = data.length > 3 ? data[3] : CARD_ACTIVATE_SINGLE;
    return { type: 'card-activate', index: data[2], action };
  }
  if (data[1] === EVENT_CARD_FOCUS || data[1] === EVENT_CARD_FOCUS_LEGACY) {
    if (data.length < 4) return null;
    const delta = data[3] > 127 ? data[3] - 256 : data[3];
    return { type: 'card-focus', index: data[2], delta };
  }
  return null;
}

function concat(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}
