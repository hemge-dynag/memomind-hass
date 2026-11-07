// Renders a Home Assistant card as a GRAY_4 bitmap (600x350) for the glasses.
// Used for cards the row list cannot express (gauge, markdown, thermostat,
// sensor, ...): the integration sends the card type and its raw config, and the
// phone paints a compact graphical version here, then pushes the pixels to the
// glasses, which display them through the public raw/LZ4 image channels.
//
// Everything here is pure pixel maths on a CanvasRenderingContext2D the caller
// owns, so it stays testable without a DOM.

import { defaultIconForDomain, iconPath, isKnownIcon } from './icons.js';

export const CARD_WIDTH = 600;
export const CARD_HEIGHT = 350;

const INK = '#f2f2f2';
const MUTED = '#c8c8c8';
const DIM = '#5e5e5e';
const TRACK = '#2a2a2a';

/* The canvas backend does not fall back from a generic family on its own: a
 * stack renders only if one of the named families is actually installed, and
 * `sans-serif` is not a family it will synthesise. A `system-ui`-first stack
 * therefore drew *nothing* on a host without system-ui (no ink at all, yet
 * measureText still answered), which is exactly the "texts are missing /
 * one pixel in two" report. Every host this ships on carries at least one of
 * these: the listed system faces, then the Liberation/DejaVu families that
 * ship with every Linux image (the Studio's renderer included). */
const FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, '
  + '"Liberation Sans", "DejaVu Sans", "Noto Sans", sans-serif';

// Shown under a full card when the head pans it: the card itself has no more
// content, and without a word the movement would look like a glitch.
const PAN_HINT = 'Tête haut/bas : déplacer la carte';

// Rows a head up/down moves a card that has no row stepping of its own.
export const PAN_STEP = 40;

// Fit `text` to `maxWidth` by shrinking the font, then by truncating.
function fitText(ctx, text, maxWidth, size, weight = '600') {
  let px = size;
  ctx.font = cardFont(weight, px);
  while (px > MIN_TEXT_PX && ctx.measureText(text).width > maxWidth) {
    px -= 1;
    ctx.font = cardFont(weight, px);
  }
  /* Truncate to fit on the *source* string: each pass drops one more character
   * and only then appends the ellipsis, so the candidate strictly shrinks and
   * the loop terminates at one character. (Truncating the already-truncated
   * string replaced `Ex…` by `Ex…` for ever, which hung the whole card
   * render: one grid cell label did it on the dashboard.) */
  let keep = text.length;
  let out = text;
  while (keep > 1 && ctx.measureText(out).width > maxWidth) {
    keep -= 1;
    out = `${text.slice(0, keep)}…`;
  }
  return { text: out, size: px };
}

/* A 1x1 canvas used only for text measurement: the glass panel's own context
 * carries a 2x scale, so measuring on it would compare a 2x glyph run against
 * a card-space box and shrink every string to the floor. */
let measureCanvas = null;
function measureCtx(ctx) {
  try {
    if (!measureCanvas) measureCanvas = document.createElement('canvas');
    setCanvasSize(measureCanvas, 1, 1);
    return measureCanvas.getContext('2d');
  } catch {
    return ctx;
  }
}

// Largest size <= `size` at which `text` still fits `maxWidth`, floored at
// MIN_TEXT_PX. Returns the size only; callers draw through drawText, which
// does the same measurement again and never grows the run.
function fitSize(ctx, text, maxWidth, size, weight = '600') {
  const mctx = measureCtx(ctx);
  mctx.font = cardFont(weight, size * SS);
  const m = mctx.measureText(text);
  const width = m.width / SS;
  const height = (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) / SS;
  let px = Math.max(MIN_TEXT_PX, Math.floor(size));
  if (width > maxWidth && width > 0) px = Math.max(MIN_TEXT_PX, Math.floor((px * maxWidth) / width));
  return px;
}

// Width and ascent of a run at `size`, in card pixels, measured on the 1:1
// canvas so the 2x panel scale never enters the number.
function cardRunWidth(ctx, text, size, weight = '600') {
  if (!text) return 0;
  const mctx = measureCtx(ctx);
  mctx.font = cardFont(weight, size * SS);
  return mctx.measureText(text).width / SS;
}

function cardRunAscent(ctx, text, size, weight = '600') {
  const mctx = measureCtx(ctx);
  mctx.font = cardFont(weight, size * SS);
  const m = mctx.measureText(text || '');
  const asc = Number.isFinite(m.actualBoundingBoxAscent) ? m.actualBoundingBoxAscent : size * SS * 0.72;
  return asc / SS;
}

// Drawn height of a run at `size`, in card pixels: the deck's own font metrics
// when the canvas reports them, else the nominal line box.
function runHeight(ctx, text, size, weight = '600') {
  const mctx = measureCtx(ctx);
  mctx.font = cardFont(weight, size * SS);
  const m = mctx.measureText(text || '');
  const asc = Number.isFinite(m.actualBoundingBoxAscent) ? m.actualBoundingBoxAscent : size * SS * 0.72;
  const desc = Number.isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent : size * SS * 0.18;
  return (asc + desc) / SS;
}

/* The card font: a system sans-serif. The wearer asked for the glyph strokes to
 * be half as wide ("reduit de moitié la largeur des traits des écritures"), so
 * every weight is dropped to a lighter face before drawing: 600/700/800/900 ->
 * 300, 400/500 -> 200. Measured in a real browser (Chromium headless), this
 * turns the average stroke run from ~12 px to ~6.5 px while glyphs stay
 * continuous through the GRAY_4 pipeline (not the broken dotted stems the old
 * "lift lighter weights to 600" rule was guarding against). Layout still
 * measures and draws with the same weight, so every fit/size decision stays
 * self-consistent.
 * Weights MUST stay multiples of 100: the host canvas backend only resolves
 * the standard faces and rejects odd values (250/350) with wildly wrong
 * metrics. */
function cardFont(weight, size) {
  const numeric = Number(weight);
  const base = Number.isFinite(numeric) ? numeric : 600;
  const drawn = base >= 500 ? 300 : 200;
  return `${drawn} ${layoutFont(size)} ${FAMILY}`;
}

function cssColor(color) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (!hex) return color;
  const value = parseInt(hex[1], 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

/* Below this the GRAY_4 panel cannot hold a glyph: an x-height of ~3 px turns
 * every letter into a dotted line. Card text is laid out larger instead. */
const MIN_TEXT_PX = 10;

/* Grid cells used to shrink their text to half the card size to stop labels
 * crowding each other, which on the panel came out at the 10 px floor: every
 * name and value read as a dotted line. Cell text now follows the cell's own
 * size, so a cell that is half a panel still gets legible type; the crowding
 * is solved by the layout (one line, measured slots), not by a global shrink. */
const GRID_TEXT_SCALE = 1;

/* Air kept between a cell's name and its value, in card pixels. The old layout
 * placed the name's baseline 1 px above the value's top: on the panel the two
 * runs touched and read as one block of scribble. */
const NAME_VALUE_GAP = 6;

function drawText(ctx, text, x, y, maxWidth, size, { weight = '700', color = INK, align = 'left', baseline = 'alphabetic', fixedBaseline = false } = {}) {
  if (!text) return 0;
  ctx.save();
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (align === 'center') {
    ctx.font = cardFont(weight, size);
    while (size > MIN_TEXT_PX && ctx.measureText(text).width > maxWidth) {
      size -= 1;
      ctx.font = cardFont(weight, size);
    }
    ctx.fillText(text, x, y);
  } else if (align === 'right') {
    ctx.font = cardFont(weight, size);
    while (size > MIN_TEXT_PX && ctx.measureText(text).width > maxWidth) {
      size -= 1;
      ctx.font = cardFont(weight, size);
    }
    ctx.fillText(text, x, y);
  } else {
    const fitted = fitText(ctx, text, maxWidth, size, weight);
    ctx.font = cardFont(weight, fitted.size);
    if (baseline !== 'alphabetic') {
      ctx.fillText(fitted.text, x, y);
    } else if (fixedBaseline) {
      /* The caller laid the run out from its measured ascent and wants the
       * baseline exactly where it computed it. */
      ctx.fillText(fitted.text, x, y);
    } else {
      /* Alphabetic baselines do not auto-fit a box; a value drawn at a fixed
       * baseline used to have its bottom half clipped by the cell or the
       * picture band. Centre it on `y` instead, which is what callers mean. */
      ctx.fillText(fitted.text, x, y + Math.round(fitted.size * 0.35));
    }
  }
  ctx.restore();
  return size;
}

function wrapLines(ctx, text, maxWidth, size, weight = '700') {
  ctx.font = cardFont(weight, size);
  const lines = [];
  for (const paragraph of String(text).split(/\r?\n/)) {
    if (!paragraph.trim()) { lines.push(''); continue; }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/* The cell the phone's cursor sits on: a bright ring so the wearer can see
 * which entity the glasses' button will trigger. Drawn inside the tile's clip,
 * inset by half the stroke so the border is not cut by the cell edge. */
function drawFocusRing(ctx, x, y, w, h) {
  /* Half the old weight: the ring used to eat a visible bite out of the tile. */
  const stroke = Math.max(2, Math.round(Math.min(w, h) * 0.025));
  const inset = stroke / 2 + 1;
  ctx.save();
  roundRect(ctx, x + inset, y + inset, w - inset * 2, h - inset * 2, 10);
  ctx.lineWidth = stroke;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.restore();
}

// Clips the context to a cell; the caller must call ctx.restore().
function clipRect(ctx, x, y, w, h) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
}

/* Rows kept free at the top of every card so the glasses' page title sits on
 * empty background instead of over the card's first line. The plugin drops
 * these blank rows and moves the picture to the top of the panel, so the space
 * costs nothing on screen: it is only room for the title. */
const HEADER_GAP = 24;

/* Air kept above the weather hero, in card pixels. Shared by the hero layout
 * (which moves down by it) and the band crop (which keeps the blank rows), so
 * the two can never disagree. */
const WEATHER_TOP_BAND = 10;

function frame(ctx, width = CARD_WIDTH, height = CARD_HEIGHT) {
  /* The card is laid out in a fixed 600x350 space, so a taller canvas (a card
   * panned by the head) still paints the same picture: the extra height is
   * what the window below the top one reads. The fill covers the whole
   * device space first (`setTransform` ignores the 2x scale and the header
   * shift this context carries), then the layout space is cleared again. The
   * old fillRect only covered 600x350 *layout* units, which under the 2x scale
   * left the last 350 device rows black-untouched but also re-cleared the
   * title rows: harmless until supersampling put HEADER_GAP of them in. */
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, CARD_WIDTH, Math.max(height, CARD_HEIGHT));
}

/* Supersampling factor: the card is laid out at twice its real size and every
 * 2x2 block is reduced to one GRAY_4 pixel. A one-pixel font stem then covers a
 * whole block instead of landing between two panel pixels, which is what made
 * every small label read as a dotted line: the anti-aliased 600 px render left
 * text at levels 3-5 of 15, i.e. at the first quantisation threshold.
 * Measurements happen on the real-size canvas, so every other drawing call
 * keeps working in card pixels. */
const SS = 2;
const TALL_WIDTH = CARD_WIDTH * SS;
const TALL_HEIGHT = CARD_HEIGHT * SS;

/* Ink share of a 2x2 block that should map to a full GRAY_4 level. A thin
 * anti-aliased glyph stem lights only a fraction of the block it crosses, so
 * dividing by this instead of by 1 is what turns those stems into solid panel
 * pixels rather than skipping them. */
const INK_COVERAGE = 0.34;

/* The layout is measured on a 600x350 canvas while the pixels are painted at
 * 2x, so a font is asked through `cardFont()` for its card size and drawn at
 * twice that: assigning a 22 px font to a canvas scaled by 2 would otherwise
 * lay out a 44-px string. Every measurement stays on the real-size context the
 * caller keeps, exactly as before supersampling. */
function layoutFont(size, scale = SS) {
  return Number.isFinite(Number(size)) ? `${size * scale}px` : `${size}`;
}

function setCanvasSize(node, w, h) {
  node.width = w;
  node.height = h;
}

/* The grid a card is sized against, whatever it really holds: 6 cells (3 rows
 * of 2). Every grid card lays its cells out on this yardstick, so a 2-cell and
 * an 8-cell grid show tiles of the same height and the numbers read the same
 * from card to card. Three rows at 110 px plus a gutter apiece come out at
 * exactly the 350 px panel, so the reference grid is never scaled. */
const GRID_REF_ROWS = 3;
const GRID_REF_COLS = 2;
const FIT_CELL_H = 110;

/* Target value size on the panel, in *rendered* pixels, shared by every grid
 * card so their numbers read the same from card to card. A card is drawn at a
 * layout height then scaled to the panel; drawStack divides this by that scale
 * to get the drawn ceiling. Long values still shrink to fit their cell. */
const UNIFORM_VALUE_PX = 15;
/* The fit-to-screen inset, kept here so drawStack can predict the scale the
 * same way renderToCanvas applies it. */
const FIT_MARGIN = 8;

/* A stack is drawn at the panel's own height: both the reference grid and a
 * card with more rows use the same cell height, so there is nothing to scale
 * and a grid taller than 3 rows is simply cut to the rows that fit. */
function naturalCardHeight(card) {
  return CARD_HEIGHT;
}

/* Blank rows a card asks for above its first line. Only the weather card does:
 * its hero is pushed down by the same amount, so the picture keeps its height
 * and the air lands where the wearer asked for it. */
function topInsetFor(card) {
  const normalized = normalizeCard(card);
  const config = normalized.config && typeof normalized.config === 'object' ? normalized.config : {};
  const type = String(normalized.cardtype || config.type || '').toLowerCase();
  return type === 'weather' || type === 'weather-forecast' ? WEATHER_TOP_BAND : 0;
}

/* Paints a whole card into the big layout space, then copies only its content
 * band into the canvas the glasses read: HEADER_GAP blank rows at the top and
 * whatever the bottom of the design leaves empty are dropped. The glasses get
 * a picture that starts on the card's first inked line and ends on its last
 * one, so no empty background is ever painted on the panel. */
function isGridCard(card) {
  const normalized = normalizeCard(card);
  const type = String(normalized.cardtype || normalized.config?.type || '').toLowerCase();
  return STACK_CARD_TYPES.has(type);
}

function renderToCanvas(card, states, canvas, width, height, scroll = 0, focusId = '') {
  /* The card owns the whole picture: layout space is the full picture height
   * and no header rows are reserved. Reserving HEADER_GAP and then cropping
   * whatever was inked cut the bottom of every card by the same 24 rows as
   * soon as its content reached the bottom of the box. */
  /* Stack/grid cards may need more room than the panel to show every row at a
   * legible height; they are laid out at that natural height and the fit-to-
   * screen step above scales the whole picture back to the panel. Every other
   * card keeps the fixed 350 px layout. */
  const natural = naturalCardHeight(card);
  const layoutH = Math.max(height >= CARD_HEIGHT ? height : CARD_HEIGHT, natural);
  const frameH = layoutH * SS;
  const tall = document.createElement('canvas');
  setCanvasSize(tall, TALL_WIDTH, frameH);
  const tallCtx = tall.getContext('2d', { willReadFrequently: true });
  tallCtx.fillStyle = '#000000';
  tallCtx.fillRect(0, 0, TALL_WIDTH, frameH);
  tallCtx.scale(SS, SS);
  const box = { width: CARD_WIDTH, height: layoutH };
  drawCard(tallCtx, card, states, box, scroll, focusId);
  const pixels = tallCtx.getImageData(0, 0, TALL_WIDTH, frameH).data;

  let first = layoutH;
  let last = -1;
  for (let y = 0; y < frameH; y += 1) {
    const row = y * TALL_WIDTH * 4;
    let inked = false;
    for (let x = 0; x < TALL_WIDTH; x += 1) {
      if (pixels[row + x * 4]) { inked = true; break; }
    }
    if (!inked) continue;
    const cardY = Math.floor(y / SS);
    if (cardY < first) first = cardY;
    if (cardY > last) last = cardY;
  }
  /* The picture normally starts on its first inked row, so the glasses see no
   * empty background. A card that asks for breathing room at the top (the
   * weather hero, 10 px) gets that band kept above its first line instead: the
   * crop would otherwise swallow the blank rows the card just made room for,
   * and the "10 px margin" measured zero. The band never pushes the picture
   * past the panel, and it never cuts the last inked row. */
  if (last >= first) {
    const wantTop = Math.max(0, Math.min(topInsetFor(card), layoutH - (last - first + 1)));
    first = Math.max(0, first - wantTop);
  }
  /* A grid is always the full 2 x 3 board, empty cells included: cropping to
   * the inked band would throw away the empty rows below a two-entity grid and
   * the whole board would then be zoomed back to the panel by the fit step.
   * Its picture is the panel, so it is copied row for row. */
  const gridCard = isGridCard(card);
  if (gridCard) {
    first = 0;
    last = layoutH - 1;
  }
  setCanvasSize(canvas, width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  if (last < first) return ctx;

  /* The card is painted at 2x and reduced here rather than by a scaling
   * drawImage: the canvas backends of the Host resample a scaled blit along a
   * sine kernel, which leaves a faint rim around every glyph, and that rim is
   * what "one pixel in two" looked like on the panel. Each 2x2 block is summed
   * by hand: the share of the block that is actually lit, times the ink level,
   * becomes the single GRAY_4 pixel. A block half lit or more is painted at its
   * full level, anything less stays transparent index 0. */
  const bandHeight = last - first + 1;
  const stride = Math.ceil(width / 2);
  /* First reduce the 2x picture to a card-resolution band of width x
   * bandHeight (the natural content, before any fitting). */
  const band = new Uint8Array(stride * bandHeight);
  for (let y = 0; y < bandHeight; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = x * SS;
      const top = (y + first) * SS * TALL_WIDTH * 4;
      const s0 = top + sx * 4;
      const s1 = s0 + SS * 4;
      const s2 = s0 + TALL_WIDTH * 4;
      const s3 = s2 + SS * 4;
      let r = pixels[s0];
      let g = pixels[s0 + 1];
      let b = pixels[s0 + 2];
      let n = r || g || b ? 1 : 0;
      r += pixels[s1]; g += pixels[s1 + 1]; b += pixels[s1 + 2];
      n += pixels[s1] || pixels[s1 + 1] || pixels[s1 + 2] ? 1 : 0;
      r += pixels[s2]; g += pixels[s2 + 1]; b += pixels[s2 + 2];
      n += pixels[s2] || pixels[s2 + 1] || pixels[s2 + 2] ? 1 : 0;
      r += pixels[s3]; g += pixels[s3 + 1]; b += pixels[s3 + 2];
      n += pixels[s3] || pixels[s3 + 1] || pixels[s3 + 2] ? 1 : 0;
      if (!n) continue;
      /* Ink area of the block: the mean channel value already carries both the
       * anti-aliased coverage of each source pixel and how bright it is, so a
       * one-pixel stem crossing a 2x2 block reads as ~1/8..3/8 of an ink
       * pixel. A 50% rule discarded every such stem (measured: 6341 lit
       * blocks, all under 0.46) and the card came out empty; keep anything
       * visibly inked and scale it up so a half-inked block is legible. */
      const ink = ((r + g + b) / 3) / 255;
      if (ink < 0.08) continue;
      const level = Math.min(15, Math.max(1, Math.round((ink / INK_COVERAGE) * 15)));
      const at = y * stride + (x >> 1);
      band[at] |= (x & 1) === 0 ? level << 4 : level;
    }
  }

  /* Fit-to-screen, both ways. The wearer asked for the cards to be taken as
   * they are *and* sized to the panel, so a band taller than the panel is
   * scaled down uniformly (width and height together, centred) and a band
   * clearly shorter than the panel is scaled *up* the same way: a weather card
   * whose content only reached row 210 of 350 used to sit in the top 60% with
   * a black strip underneath. The upscale is bounded (MAX_UPSCALE) so a card
   * cropped to a couple of short lines is not blown into blocky letters, and
   * anything within UPSCALE_MIN_FILL of the panel stays 1:1, top-aligned. */
  /* Air kept on all four sides of the picture, even when the band fills the
   * panel after scaling, so no glyph ever touches (or is clipped by) the
   * panel edge. This used to be applied to the height only and skipped at
   * 1:1, so a band that reached the top/bottom edge sat flush against it and
   * a full-width band (weather) cut into the left/right columns: "the cards
   * go out of the display". */
  const availW = Math.max(1, width - FIT_MARGIN * 2);
  const availH = Math.max(1, height - FIT_MARGIN * 2);
  const MAX_UPSCALE = 1.5;
  /* A grid is always drawn as the full 2 x 3 board (empty cells outlined), so
   * its band is exactly the panel: no upscale is ever wanted there, and a
   * zoomed board would push the empty cells out of the panel. */
  const UPSCALE_MIN_FILL = gridCard ? 1.01 : 0.85;
  /* One uniform scale so the band never distorts: take the tighter of the
   * width and height ratios, then decide whether to use it. A band wider than
   * the available box is always shrunk; a shorter band is only grown past 1:1
   * when it is clearly under-filled, and never beyond MAX_UPSCALE. */
  const fitScale = Math.min(availH / bandHeight, availW / width);
  let scale = 1;
  if (fitScale < 1) scale = fitScale;
  else if (fitScale > 1 && bandHeight < availH * UPSCALE_MIN_FILL) {
    scale = Math.min(MAX_UPSCALE, fitScale);
  }
  const contentW = Math.max(1, Math.round(width * scale));
  const contentH = Math.round(bandHeight * scale);
  /* Centre the picture inside the inset box so every side keeps (at least)
   * FIT_MARGIN of black background. */
  const yoff = Math.round(FIT_MARGIN + Math.max(0, (availH - contentH) / 2));
  const xoff = Math.round(FIT_MARGIN + Math.max(0, (availW - contentW) / 2));
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const ly = y - yoff;
    if (ly < 0 || ly >= bandHeight * scale) continue;
    const sy0 = Math.min(bandHeight - 1, Math.floor(ly / scale));
    const sy1 = scale <= 1
      ? sy0
      : Math.min(bandHeight - 1, Math.floor((ly + 1) / scale - 1e-6));
    for (let x = 0; x < width; x += 1) {
      if (x < xoff || x >= xoff + contentW) continue;
      const sx0 = scale === 1 ? x : Math.max(0, Math.min(width - 1, Math.floor((x - xoff) / scale)));
      const sx1 = scale <= 1
        ? sx0
        : Math.max(sx0, Math.min(width - 1, Math.floor((x + 1 - xoff) / scale - 1e-6)));
      /* At 1:1 this is a plain copy. When the band is scaled, a panel pixel
       * covers a *rectangle* of card pixels: taking only the top-left one
       * dropped every glyph stroke narrower than the scale factor -- a 16 px
       * name in a 1.5x upscale came out as a dotted line -- so the pixel keeps
       * the strongest level of the cells it covers. Ink is light on black, so
       * the strongest is a max, not an average that would wash the stroke to
       * the background. */
      let level = 0;
      for (let sy = sy0; sy <= sy1 && level < 15; sy += 1) {
        for (let sx = sx0; sx <= sx1; sx += 1) {
          const packed = band[sy * stride + (sx >> 1)];
          const v = (sx & 1) === 0 ? packed >> 4 : packed & 0x0f;
          if (v > level) level = v;
          if (level === 15) break;
        }
      }
      const at = y * stride + (x >> 1);
      out[at] |= (x & 1) === 0 ? level << 4 : level;
    }
  }

  const write = ctx.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const packed = out[y * stride + (x >> 1)];
      const level = (x & 1) === 0 ? packed >> 4 : packed & 0x0f;
      const i = (y * width + x) * 4;
      write.data[i] = level * 17;
      write.data[i + 1] = level * 17;
      write.data[i + 2] = level * 17;
      write.data[i + 3] = 255;
    }
  }
  ctx.putImageData(write, 0, 0);
  return ctx;
}

// Reads the first entity of a card config, accepting the many shapes HA allows:
// "sensor.x", { entity: "sensor.x" }, a list of either.
export function firstEntityId(config, fallbackEntities) {
  const raw = config?.entity ?? config?.entities;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const item of list) {
    const id = typeof item === 'string' ? item : item?.entity;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  const fallback = Array.isArray(fallbackEntities) ? fallbackEntities : [];
  if (fallback.length && typeof fallback[0]?.id === 'string') return fallback[0].id;
  return '';
}

function stateOf(states, id) {
  if (!id || !states) return undefined;
  if (typeof states.get === 'function') return states.get(id);
  const found = states[id];
  return found && typeof found === 'object' ? found : undefined;
}

function numericState(state) {
  const value = Number(state?.state);
  return Number.isFinite(value) ? value : null;
}

/* A numeric state printed raw reads "26.8058816124411" or "2320.0": Home
 * Assistant itself shows the sensor's rounding, and one such run would force
 * a grid card to shrink every tile to fit it. Round for display only -- the
 * underlying state is untouched. A measurement is shown to 4 significant
 * digits (26.81, 2320) and a unitless ratio-like value to 2 decimals; integer
 * values keep no ".0". */
function displayValue(state, raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  const integerStates = /^-?\d+$/.test(String(raw).trim());
  if (integerStates) return String(raw).trim();
  const magnitude = Math.abs(value);
  let text;
  if (magnitude === 0 || (magnitude >= 1 && magnitude < 1000)) {
    text = value.toFixed(2);
  } else {
    text = String(Number(value.toPrecision(4)));
  }
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  if (text === '-0') text = '0';
  return text;
}

function unitOf(state) {
  const unit = state?.attributes?.unit_of_measurement;
  return typeof unit === 'string' ? unit : '';
}

function titleOf(config) {
  const title = config?.name ?? config?.title;
  return typeof title === 'string' ? title.trim() : '';
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function drawTitle(ctx, title) {
  if (!title) return;
  drawText(ctx, title, 28, 36, CARD_WIDTH - 56, 22, { weight: '700', color: INK });
}

/* Head of an entity tile: the friendly_name a HA entity carries defaults to its
 * entity id ("multiprise_pc_prise_pc"), which is unreadable on a 600 px panel.
 * Prefer the card's own name, then the state's label, then the id with its
 * domain and a leading device prefix of the id kept whole: a human name and an
 * id are told apart by the presence of a space or a capital. */
function tileLabel(config, state, entityId) {
  const chosen = typeof config?.name === 'string' ? config.name.trim() : '';
  if (chosen) return chosen;
  const friendly = state?.attributes?.friendly_name;
  const id = String(entityId || '');
  if (typeof friendly === 'string' && friendly.trim() && friendly.trim() !== id) {
    return friendly.trim();
  }
  const bare = id.includes('.') ? id.slice(id.indexOf('.') + 1) : id;
  return bare.replace(/[_]+/g, ' ').trim() || id;
}

function drawGauge(ctx, config, state) {
  drawTitle(ctx, titleOf(config));
  const min = num(config?.min, 0);
  const max = num(config?.max ?? config?.max_value, 100);
  const value = numericState(state);
  const ratio = value === null ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min || 1)));

  const cx = CARD_WIDTH / 2;
  const cy = 214;
  const radius = 104;
  const width = 22;
  const start = Math.PI * 0.8;
  const end = Math.PI * 2.2;

  // Arc rendered as short thick segments: works on any Canvas 2D implementation.
  const steps = 72;
  for (let i = 0; i < steps; i += 1) {
    const a0 = start + ((end - start) * i) / steps;
    const a1 = start + ((end - start) * (i + 1)) / steps + 0.015;
    ctx.beginPath();
    ctx.strokeStyle = i / steps < ratio ? INK : TRACK;
    ctx.lineWidth = width;
    ctx.lineCap = 'butt';
    ctx.arc(cx, cy, radius, a0, a1);
    ctx.stroke();
  }

  const shown = value === null ? (state ? String(state.state) : '—') : String(value);
  const used = drawText(ctx, shown, cx, cy + 12, 130, 54, { weight: '700', align: 'center' });
  const unit = unitOf(state) || (typeof config?.unit_of_measurement === 'string' ? config.unit_of_measurement : '');
  if (unit) drawText(ctx, unit, cx, cy + 12 + used * 0.85, 120, 20, { weight: '400', color: MUTED, align: 'center' });
  if (value !== null) {
    drawText(ctx, `${min}`, 150, 300, 90, 16, { color: DIM, align: 'center', weight: '400' });
    drawText(ctx, `${max}`, CARD_WIDTH - 150, 300, 90, 16, { color: DIM, align: 'center', weight: '400' });
  }
}

function drawBar(ctx, config, state) {
  drawTitle(ctx, titleOf(config));
  const min = num(config?.min, 0);
  const max = num(config?.max, 100);
  const value = numericState(state);
  const ratio = value === null ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min || 1)));

  drawText(ctx, state?.attributes?.friendly_name || '', 40, 120, CARD_WIDTH - 80, 26, { weight: '500', color: MUTED });
  const shown = value === null ? (state ? String(state.state) : '—') : String(value);
  drawText(ctx, shown, 40, 220, 300, 64, { weight: '700' });
  const unit = unitOf(state);
  if (unit) drawText(ctx, unit, 40 + 8, 220 - 10, 200, 26, { weight: '400', color: MUTED });

  const x = 40;
  const y = 262;
  const w = CARD_WIDTH - 80;
  ctx.fillStyle = TRACK;
  roundRect(ctx, x, y, w, 16, 8);
  ctx.fill();
  if (ratio > 0) {
    ctx.fillStyle = INK;
    roundRect(ctx, x, y, Math.max(16, w * ratio), 16, 8);
    ctx.fill();
  }
}

function drawMarkdown(ctx, config) {
  drawTitle(ctx, titleOf(config));
  const raw = typeof config?.content === 'string' ? config.content : '';
  const text = raw
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_`>]/g, '')
    .trim();
  const top = titleOf(config) ? 92 : 60;
  const size = 26;
  const lines = wrapLines(ctx, text, CARD_WIDTH - 96, size, '400');
  let y = top;
  for (const line of lines) {
    if (y > CARD_HEIGHT - 32) break;
    drawText(ctx, line, 48, y, CARD_WIDTH - 96, size, { weight: '400', color: INK });
    y += Math.round(size * 1.4);
  }
}

// HA's thermostat card: a tall vertical dial on the left with the target in
// the middle and the set range underneath, the current temperature and the
// action on the right. Everything is driven by the climate attributes
// (temperature / current_temperature / min_temp / max_temp / hvac_action).
function drawThermostat(ctx, config, state, allStates, hassEntities) {
  // The climate attributes live on the entity's own state; fall back to the
  // card config or the entity list when the caller only forwarded a bare id.
  if (!state) state = stateOf(allStates, firstEntityId(config, hassEntities));
  const hvac = state;
  const attrs = hvac?.attributes || {};
  /* The tile header names the entity; a climate card is always titled with its
   * own name below the track's scale, so drawing it here too puts the entity
   * name under the "max" label. Only a custom title still gets the header. */
  const heading = typeof config?.title === 'string' && config.title.trim() ? config.title.trim() : '';
  drawTitle(ctx, heading);

  const unit = typeof attrs.temperature_unit === 'string' ? attrs.temperature_unit : '°C';
  const min = num(attrs.min_temp, 7);
  const max = num(attrs.max_temp, 30);
  const targetValue = Number(attrs.temperature);
  const target = Number.isFinite(targetValue) ? targetValue : numericState(hvac);
  const current = Number(attrs.current_temperature);
  const ratio = target === null ? 0 : Math.max(0, Math.min(1, (target - min) / (max - min || 1)));

  /* The dial sits in the left third only: it used to run 600-px-picture wide in
   * the eye because the right column (name, 88 px number, action line) reached
   * x=184 while the "min" label spanned 72..192 under it, so the scale read as
   * crossed by the number. The track is narrowed and the labels are kept inside
   * the dial's own column; the right column starts past it. */
  const cx = 104;
  const top = 72;
  const bottom = CARD_HEIGHT - 74;
  const thumbY = bottom - Math.round((bottom - top) * ratio);

  ctx.strokeStyle = TRACK;
  ctx.lineWidth = 18;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, top);
  ctx.lineTo(cx, bottom);
  ctx.stroke();
  if (target !== null && ratio > 0) {
    ctx.strokeStyle = INK;
    ctx.beginPath();
    ctx.moveTo(cx, bottom);
    ctx.lineTo(cx, thumbY);
    ctx.stroke();
  }
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(cx, thumbY, 17, 0, Math.PI * 2);
  ctx.fill();

  drawText(ctx, `max ${Math.round(max)}`, cx, top - 10, 96, 16, { weight: '500', color: DIM, align: 'center', baseline: 'bottom' });
  drawText(ctx, `min ${Math.round(min)}`, cx, bottom + 26, 96, 16, { weight: '500', color: DIM, align: 'center', baseline: 'top' });

  /* The right column is laid out top to bottom from measured block heights:
   * name, then the target number with its unit, then the action line. The old
   * fixed baselines put the name at 106, the 88 px number at 186 (descending to
   * ~210) and the action at 238, whose ascenders reached back into the number's
   * lower half. Each block now starts where the previous one actually ended. */
  const colLeft = 208;
  const colRight = CARD_WIDTH - 28;
  const colW = colRight - colLeft;
  const gap = 10;
  let y = 84;
  const name = config?.name || attrs.friendly_name || '';
  if (name) {
    const used = drawText(ctx, name, colLeft, y, colW, 22, { weight: '500', color: MUTED, baseline: 'top' });
    y += Math.round(used * 1.3) + gap;
  }
  const shown = target === null ? '—' : `${Math.round(target * 10) / 10}`;
  const unitSize = 34;
  /* The unit sits on the number's baseline, after its last glyph; the room the
   * unit and the gap take is what the number has to fit into. */
  ctx.font = cardFont('400', unitSize);
  const unitW = Math.ceil(ctx.measureText(unit).width);
  const numberRoom = Math.max(60, colW - unitW - 8);
  ctx.font = `700 ${layoutFont(88)} ${FAMILY}`;
  const numberW = ctx.measureText(shown).width;
  const numSize = Math.max(40, Math.min(88, Math.floor((88 * numberRoom) / Math.max(1, numberW))));
  ctx.font = `700 ${layoutFont(numSize)} ${FAMILY}`;
  const numberWFinal = ctx.measureText(shown).width;
  const numberH = Math.round(numSize * 0.74);
  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(shown, colLeft, y + numberH);
  drawText(ctx, unit, colLeft + numberWFinal + 8, y + numberH, colW - numberWFinal - 8, unitSize,
    { weight: '400', color: MUTED, baseline: 'bottom' });
  y += numberH + gap;

  const bits = [];
  if (Number.isFinite(current)) bits.push(`actuel ${Math.round(current * 10) / 10}${unit}`);
  const action = String(attrs.hvac_action || '').toLowerCase();
  if (action && action !== 'idle' && action !== 'off') {
    bits.push(HA_ACTIONS[action] || action);
  } else if (String(hvac?.state || '').toLowerCase() === 'off') {
    bits.push('Éteint');
  }
  if (bits.length) {
    drawText(ctx, bits.join('  ·  '), colLeft, y, colW, 24, {
      weight: '500', color: MUTED, baseline: 'top',
    });
  }
}

const HA_ACTIONS = {
  heating: 'Chauffe', cooling: 'Refroidit', drying: 'Déshumidifie',
  fan: 'Ventile', idle: 'Au repos', off: 'Éteint', preheating: 'Préchauffe',
  defrosting: 'Dégivre',
};

function drawSensor(ctx, config, state) {
  drawTitle(ctx, titleOf(config));
  const name = config?.name || config?.title || state?.attributes?.friendly_name || '';
  const entityId = firstEntityId(config);
  const iconName = cardIconName(config, state, entityId);
  const iconSize = 48;
  const iconGap = 14;
  /* The icon sits just left of the name, pulled in from the margins: a wide
   * panel only pays for the icon when the name's line still has room for a
   * legible run beside it. */
  const nameSize = 24;
  const nameW = name ? Math.ceil(cardRunWidth(ctx, name, nameSize, '500')) : 0;
  const iconFits = nameW === 0 || nameW <= CARD_WIDTH - 80 - iconSize - iconGap;
  const iconCol = iconFits ? iconSize + iconGap : 0;
  const iconColor = state && isOn(state) ? INK : MUTED;
  if (iconCol) drawIcon(ctx, iconName, 40, 110 - 4, iconSize, iconColor);
  if (name) {
    drawText(ctx, name, 40 + iconCol, 110, CARD_WIDTH - 80 - iconCol, nameSize,
      { weight: '500', color: MUTED });
  }
  const shown = state ? String(state.state) : '—';
  const used = drawText(ctx, shown, CARD_WIDTH / 2, 218, CARD_WIDTH - 80, 96, { weight: '700', align: 'center' });
  const unit = unitOf(state);
  if (unit) drawText(ctx, unit, CARD_WIDTH / 2, 218 + used * 0.9, 200, 28, { weight: '400', color: MUTED, align: 'center' });
}

/* Media player card, laid out like HA's own media-control tile: the device name
 * and a play/pause glyph on top, what is playing (media_title, then artist and
 * album) in the middle, a progress bar with elapsed/total time, and the source
 * or app at the bottom. A double press toggles playback (see plugin.js); the
 * card only reports state, it never draws the cover art (deferred). */
function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function drawPlayPause(ctx, x, y, size, playing, color) {
  ctx.save();
  ctx.fillStyle = color;
  if (playing) {
    const barW = Math.round(size * 0.28);
    const gap = Math.round(size * 0.16);
    const barH = Math.round(size * 0.9);
    const left = x + Math.round((size - (barW * 2 + gap)) / 2);
    const top = y + Math.round((size - barH) / 2);
    ctx.fillRect(left, top, barW, barH);
    ctx.fillRect(left + barW + gap, top, barW, barH);
  } else {
    const pad = Math.round(size * 0.08);
    ctx.beginPath();
    ctx.moveTo(x + pad, y);
    ctx.lineTo(x + size - pad, y + size / 2);
    ctx.lineTo(x + pad, y + size);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawMediaPlayer(ctx, config, state, allStates) {
  drawTitle(ctx, titleOf(config));
  const entityId = String(config?.entity || firstEntityId(config, null) || '');
  const media = stateOf(allStates, entityId) || state;
  const attrs = media?.attributes || {};
  const raw = String(media?.state || '').toLowerCase();
  const playing = raw === 'playing';
  const idle = !raw || raw === 'off' || raw === 'unavailable' || raw === 'unknown';

  const left = 40;
  const right = CARD_WIDTH - 40;
  const contentW = right - left;

  /* Header: device name on the left, play/pause glyph on the right. The glyph
   * mirrors the state so the wearer sees at a glance whether a double press
   * would resume or pause. */
  const name = tileLabel(config, media, entityId);
  const headerY = titleOf(config) ? 78 : 50;
  const glyph = 30;
  if (name) {
    drawText(ctx, name, left, headerY, contentW - glyph - 16, 24, { weight: '500', color: MUTED });
  }
  drawPlayPause(ctx, right - glyph, headerY - glyph + 4, glyph, playing, idle ? DIM : INK);

  if (idle) {
    drawText(ctx, stateLabel(raw || 'off'), CARD_WIDTH / 2, 210, contentW, 40,
      { weight: '600', color: MUTED, align: 'center' });
    return;
  }

  /* What is playing: title first, big; artist and album underneath as one or
   * two secondary lines. Missing attributes simply drop out. */
  const title = typeof attrs.media_title === 'string' ? attrs.media_title.trim() : '';
  const artist = typeof attrs.media_artist === 'string' ? attrs.media_artist.trim() : '';
  const album = typeof attrs.media_album_name === 'string' ? attrs.media_album_name.trim() : '';
  const subtitle = [artist, album && album !== artist ? album : ''].filter(Boolean).join('  ·  ');

  let cursor = Math.max(headerY + 34, 120);
  if (title) {
    const tSize = fitSize(ctx, title, contentW, 46, '700');
    drawText(ctx, title, left, cursor, contentW, tSize, { weight: '700', color: INK });
    cursor += Math.round(cardRunAscent(ctx, title, tSize, '700') + 22);
  }
  if (subtitle) {
    const sSize = fitSize(ctx, subtitle, contentW, 26, '500');
    drawText(ctx, subtitle, left, cursor, contentW, sSize, { weight: '500', color: MUTED });
    cursor += Math.round(cardRunAscent(ctx, subtitle, sSize, '500') + 18);
  }

  /* Progress: prefer HA's media_duration/media_position, advancing the position
   * by the time elapsed since media_position_updated_at when playing. */
  const duration = Number(attrs.media_duration);
  let position = Number(attrs.media_position);
  const updatedAt = attrs.media_position_updated_at;
  if (playing && Number.isFinite(position) && updatedAt) {
    const since = (Date.now() - Date.parse(updatedAt)) / 1000;
    if (Number.isFinite(since) && since > 0) position += since;
  }
  const hasProgress = Number.isFinite(duration) && duration > 0 && Number.isFinite(position);

  const barY = Math.max(cursor + 8, 268);
  if (hasProgress) {
    const clamped = Math.max(0, Math.min(position, duration));
    const ratio = clamped / duration;
    ctx.fillStyle = TRACK;
    roundRect(ctx, left, barY, contentW, 8, 4);
    ctx.fill();
    if (ratio > 0) {
      ctx.fillStyle = playing ? INK : MUTED;
      roundRect(ctx, left, barY, Math.max(8, Math.round(contentW * ratio)), 8, 4);
      ctx.fill();
    }
    drawText(ctx, formatClock(clamped), left, barY + 30, contentW / 2, 18, { weight: '400', color: DIM });
    drawText(ctx, formatClock(duration), right, barY + 30, contentW / 2, 18,
      { weight: '400', color: DIM, align: 'right' });
  }

  /* Footer: source or app, when the card has room and the info exists. */
  const footer = (typeof attrs.app_name === 'string' && attrs.app_name.trim())
    || (typeof attrs.source === 'string' && attrs.source.trim()) || '';
  if (footer) {
    const footerY = CARD_HEIGHT - 130;
    drawText(ctx, footer, left, footerY, contentW, 18, { weight: '400', color: DIM });
  }
}

// Weather conditions arrive as HA enum words ("rainy", "partlycloudy", ...).
const WEATHER_WORDS = {
  clear: 'Dégagé', sunny: 'Ensoleillé', cloudy: 'Nuageux', partlycloudy: 'Peu nuageux',
  rainy: 'Pluie', pouring: 'Forte pluie', lightning: 'Orage', lightning_rainy: 'Orage pluvieux',
  snowy: 'Neige', snowy_rainy: 'Neige mêlée', fog: 'Brouillard', hail: 'Grêle',
  windy: 'Vent', windy_variant: 'Vent fort', exceptional: 'Exceptionnel',
  unknown: '—', unavailable: '—',
};

const WEEKDAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];

function weatherWord(value) {
  const key = String(value || '').toLowerCase();
  return WEATHER_WORDS[key] || (key ? key.replace(/_/g, ' ') : '—');
}

// Hero block, like HA's own weather card: a large condition glyph, the current
// temperature next to it, the condition word underneath, then the day's
// high/low and humidity on a quiet line.
function drawWeatherNow(ctx, state, width = CARD_WIDTH, height = CARD_HEIGHT, topInset = 0) {
  /* The context carries the 2x panel scale, so measuring on it would compare a
   * 2x glyph run against a box in card pixels and every fit would collapse to
   * the floor. Measure on a 1x scratch canvas instead. */
  const mctx = measureCtx(ctx);
  const attrs = state?.attributes || {};
  const unit = attrs.temperature_unit || '\u00b0C';
  const temp = Number(attrs.temperature);

  /* Everything is placed from the picture's own box: the same composition
   * lands whole in a grid cell, and the three lines are stacked from measured
   * sizes so the condition word can never sit on the details line. */
  /* The card draws its own air above the hero: `topInset` is breathing room
   * the wearer asked for, so the band above the temperature is 10 px on the
   * weather card and unchanged anywhere else. */
  const pad = 28;
  const topPad = pad + Math.max(0, topInset);
  const left = pad;
  const right = width - pad;
  const boxW = Math.max(40, right - left);

  /* Details line first: it is the last line, so it claims the bottom rows and
   * the hero above gets whatever height is left. */
  const high = Number(attrs.forecast?.[0]?.temperature);
  const low = Number(attrs.forecast?.[0]?.templow);
  const bits = [];
  if (Number.isFinite(high)) bits.push(`max ${Math.round(high)}${unit}`);
  if (Number.isFinite(low)) bits.push(`min ${Math.round(low)}${unit}`);
  if (Number.isFinite(Number(attrs.humidity))) bits.push(`humidit\u00e9 ${Math.round(Number(attrs.humidity))} %`);
  if (Number.isFinite(Number(attrs.wind_speed))) {
    const wu = typeof attrs.wind_speed_unit === 'string' ? attrs.wind_speed_unit : '';
    bits.push(`${Math.round(Number(attrs.wind_speed))} ${wu}`.trim());
  }
  /* The details line carries the words the hero cannot: it is sized from the
   * box so it stays legible on the panel instead of being the smallest line
   * on the card. */
  const detailSize = Math.round(Math.max(MIN_TEXT_PX + 4, Math.min(24, boxW / 19)));
  /* drawText with baseline 'top' places the glyph tops on the line and lets
   * the descenders hang below it, so the line needs its own height kept clear
   * at the bottom -- a flat pad does not account for a 18 px line's ~7 px
   * descender, which is what pushed the details under the hero band. */
  const detailH = bits.length ? Math.round(detailSize * 1.5) : 0;
  const detailY = height - pad - detailH;

  const heroTop = topPad;
  const heroH = Math.max(40, height - pad - detailH - heroTop - 6);

  const textLeft = left;
  const textW = Math.max(40, right - textLeft);
  const shown = Number.isFinite(temp) ? `${Math.round(temp)}${unit}` : '\u2014';
  const word = weatherWord(state?.state);

  /* Two lines only: the reading, then the condition word beneath it. They are
   * stacked from the *drawn extents* of each glyph run, not from the declared
   * point size: a "10°C" fills more than its font size and a lowercase word
   * less, and laying them out on point sizes put the two lines on top of each
   * other. The reading is the biggest thing on the card; the word follows at a
   * readable, smaller size, with a real blank gap between them. */
  const measure = (text, size, weight) => {
    mctx.font = cardFont(weight, size * SS);
    const m = mctx.measureText(text || '');
    const ascent = Number.isFinite(m.actualBoundingBoxAscent) ? m.actualBoundingBoxAscent : size * SS * 0.72;
    const descent = Number.isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent : size * SS * 0.18;
    return { width: m.width / SS, ascent: ascent / SS, descent: descent / SS };
  };

  /* Two stacked lines, both left-aligned: the reading, then the condition
   * word under it. Fitted by the drawn extents, never by the declared point
   * size. The point size ceiling is lower than it used to be (40) and the
   * word is tied to it, so the whole "météo du jour" block is visibly smaller
   * than before without ceasing to be the headline. */
  /* The hero is measured *after* the glyph's column is reserved, so a long
   * reading never runs into the glyph or the panel edge. */
  const heroGlyphR = Math.max(16, Math.round(Math.min(heroH * 0.24, textW * 0.14)));
  const heroTextX = textLeft + heroGlyphR * 2 + Math.round(heroGlyphR * 0.6);
  const heroTextW = Math.max(40, right - heroTextX);
  let tempSize = Math.round(Math.min(56, heroH * 0.42));
  let tempExt = measure(shown, tempSize, '700');
  while (tempSize > MIN_TEXT_PX + 2 && (tempExt.width > heroTextW || tempSize > heroH * 0.55)) {
    tempSize -= 1;
    tempExt = measure(shown, tempSize, '700');
  }
  let wordSize = Math.round(Math.max(MIN_TEXT_PX + 1, Math.min(15, tempSize * 0.42)));
  let wordExt = measure(word, wordSize, '500');
  while (wordSize > MIN_TEXT_PX + 1 && wordExt.width > heroTextW) {
    wordSize -= 1;
    wordExt = measure(word, wordSize, '500');
  }
  const tempH = tempExt.ascent + tempExt.descent;
  const wordH = wordExt.ascent + wordExt.descent;
  /* A real blank band between the two lines: a third of the reading's height,
   * never less than a hair. */
  const gap = Math.max(6, Math.round(tempH * 0.3));
  const lineTop = heroTop + Math.max(0, Math.round((heroH - (tempH + gap + wordH)) / 2));

  /* drawText places an alphabetic baseline on the called y. The word sits
   * *under* the reading, left-aligned on the same column: side by side, the
   * two runs made a 300+ px line with only ~15 px between them, which the
   * wearer read as one tangled block on the panel. Underneath, the row is
   * never wider than the reading itself. */
  const baseline = lineTop + tempExt.ascent;
  /* The reading shares the hero with the condition glyph, as HA's own card
   * does: the bare number left the right half of the panel black on top of the
   * large empty band between the two text lines. */
  const glyphCy = lineTop + Math.round((tempH + gap + wordH) / 2);
  weatherGlyph(ctx, state?.state, textLeft + heroGlyphR, glyphCy, heroGlyphR);
  const textX = heroTextX;
  const textW2 = heroTextW;
  drawText(ctx, shown, textX, baseline, textW2, tempSize,
    { weight: '700', baseline: 'alphabetic' });
  const wordTop = lineTop + tempH + gap;
  if (word) {
    drawText(ctx, word, textX, wordTop + wordExt.ascent, textW2, wordSize,
      { weight: '500', color: MUTED, baseline: 'alphabetic' });
  }
  const wordBottom = wordTop + wordH;

  if (bits.length) {
    const detailTop = Math.max(wordBottom + Math.round(detailSize * 0.5), detailY);
    drawText(ctx, bits.join('   '), left, detailTop, boxW, detailSize,
      { weight: '400', color: DIM, baseline: 'top' });
  }
}

// Daily forecast: up to seven columns, one per day, with a condition glyph
// drawn from the sky itself (sun disc, cloud, drops, flakes) so the row reads
// at a glance without depending on an icon font.
function drawWeatherDay(ctx, day, x, w, top, gutter = 0, height = 0) {
  const date = day?.datetime ? new Date(day.datetime) : null;
  const valid = date && !Number.isNaN(date.getTime());
  /* "lun." does not fit a narrow column: the label is the one line that can be
   * cut, so it is measured against the column and allowed to shrink instead of
   * overflowing onto its neighbour. */
  const label = valid ? WEEKDAYS[date.getDay()] : '—';
  const cx = x + w / 2;
  const blockH = height > 0 ? height : 44;
  /* The column used to be a single 44 px line pinned under the divider, which
   * left the lower half of the picture black. The three items now stack --
   * weekday, sky glyph, max | min -- and every part is sized from the band the
   * caller hands over, so the row fills the room it has. */
  let labelSize = Math.max(MIN_TEXT_PX, Math.min(20, Math.round(w / 4.2), Math.round(blockH * 0.30)));
  while (labelSize > MIN_TEXT_PX && cardRunWidth(ctx, label, labelSize, '600') > w) labelSize -= 1;
  const unit = '\u00b0';
  const high = Number(day?.temperature);
  const low = Number(day?.templow);
  const highText = Number.isFinite(high) ? `${Math.round(high)}${unit}` : '\u2014';
  const lowText = Number.isFinite(low) ? `${Math.round(low)}${unit}` : '\u2014';
  let numSize = Math.max(MIN_TEXT_PX, Math.min(26, Math.round(w / 3.6), Math.round(blockH * 0.34)));
  {
    const two = `${highText} ${lowText}`;
    while (numSize > MIN_TEXT_PX && cardRunWidth(ctx, two, numSize, '700') > w) numSize -= 1;
  }
  const glyphR = Math.max(7, Math.round(Math.min(numSize * 0.62, w * 0.16, blockH * 0.16)));
  const labelH = Math.round(labelSize * 1.35);
  const numH = Math.round(numSize * 1.35);
  const glyphH = glyphR * 2.5;
  const total = labelH + glyphH + numH;
  let y = Math.round(top + Math.max(0, (blockH - total) / 2));
  drawText(ctx, label, cx, y, w, labelSize,
    { weight: '600', color: MUTED, align: 'center', baseline: 'top' });
  y += labelH;
  weatherGlyph(ctx, day?.condition, cx, y + Math.round(glyphH / 2), glyphR);
  y += glyphH;
  /* Max and min side by side on one line, centred as a pair: the max keeps the
   * bright ink and the min the dim one, as in the old single-line row. */
  const highW = cardRunWidth(ctx, highText, numSize, '700');
  const lowW = cardRunWidth(ctx, lowText, numSize, '700');
  const itemGap = Math.max(6, Math.round(numSize * 0.4));
  const startX = Math.round(cx - (highW + itemGap + lowW) / 2);
  const midY = y + Math.round(numH / 2);
  drawText(ctx, highText, startX, midY, highW + 1, numSize,
    { weight: '700', align: 'left', baseline: 'middle' });
  drawText(ctx, lowText, startX + highW + itemGap, midY, lowW + 1, numSize,
    { weight: '700', color: DIM, align: 'left', baseline: 'middle' });
}

function weatherGlyph(ctx, condition, cx, cy, r) {
  const key = String(condition || '').toLowerCase();
  const rain = /rain|pour|lightning|hail/.test(key);
  const snow = /snow|hail/.test(key);
  const storm = /lightning/.test(key);
  /* "partlycloudy" is HA's sun-behind-a-cloud: it must keep its sun. */
  const partly = /partly|mostly_sunny|sunny/.test(key);
  const cloud = /cloud|fog|rain|snow|hail|lightning|wind|except/.test(key);
  const night = /clear-night|night/.test(key);
  const sun = !night && (/clear|sunny/.test(key) || partly);
  /* A lone sun (clear/sunny) sits centred and large; a partly-cloudy sun hides
   * behind the cloud, so it moves up and left to stay visible. */
  const sunOnly = sun && !cloud;
  const sunX = sunOnly ? cx : cx - r * 0.5;
  const sunY = sunOnly ? cy : cy - r * 0.5;
  const sunR = sunOnly ? r * 0.5 : r * 0.42;

  ctx.save();
  ctx.lineWidth = 3;
  if (night) {
    /* Crescent: a dark disc shifted over the bright one. */
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.arc(cx + r * 0.22, cy - r * 0.18, r * 0.46, 0, Math.PI * 2);
    ctx.fill();
  } else if (sun) {
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
    ctx.fill();
    if (sunOnly) {
      ctx.strokeStyle = INK;
      for (let i = 0; i < 8; i += 1) {
        const a = (Math.PI / 4) * i;
        ctx.beginPath();
        ctx.moveTo(sunX + Math.cos(a) * r * 0.62, sunY + Math.sin(a) * r * 0.62);
        ctx.lineTo(sunX + Math.cos(a) * r * 0.86, sunY + Math.sin(a) * r * 0.86);
        ctx.stroke();
      }
    }
  } else if (!cloud) {
    ctx.strokeStyle = MUTED;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx + r, cy);
    ctx.stroke();
  }
  if (cloud) {
    /* With a sun behind, the cloud shifts right and down so both read. */
    const ox = sun ? r * 0.2 : 0;
    const by = cy + (sun ? r * 0.28 : 0);
    const lobes = [
      [cx - r * 0.34 + ox, by, r * 0.36],
      [cx + r * 0.02 + ox, by - r * 0.18, r * 0.44],
      [cx + r * 0.42 + ox, by, r * 0.32],
    ];
    /* A dark gap around the cloud keeps the sun visibly behind it instead of
     * melting into one white blob on 16-level grey. */
    if (sun) {
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      for (const [lx, ly, lr] of lobes) {
        ctx.moveTo(lx + lr + 3, ly);
        ctx.arc(lx, ly, lr + 3, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.fillStyle = key === 'fog' ? MUTED : INK;
    ctx.beginPath();
    for (const [lx, ly, lr] of lobes) {
      ctx.moveTo(lx + lr, ly);
      ctx.arc(lx, ly, lr, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  if (rain || snow) {
    ctx.strokeStyle = key === 'fog' ? DIM : MUTED;
    ctx.lineWidth = 3;
    for (let i = -1; i <= 1; i += 1) {
      const dx = cx + i * r * 0.42;
      const y0 = cy + r * 0.5;
      ctx.beginPath();
      ctx.moveTo(dx, y0);
      ctx.lineTo(dx + (snow ? 0 : -r * 0.12), y0 + r * 0.42);
      ctx.stroke();
    }
  }
  if (storm) {
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.moveTo(cx, cy + r * 0.42);
    ctx.lineTo(cx - r * 0.16, cy + r * 0.78);
    ctx.lineTo(cx + r * 0.06, cy + r * 0.78);
    ctx.lineTo(cx - r * 0.1, cy + r * 1.12);
    ctx.lineTo(cx + r * 0.24, cy + r * 0.66);
    ctx.lineTo(cx + r * 0.02, cy + r * 0.66);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawWeather(ctx, config, state, allStates, width = CARD_WIDTH, height = CARD_HEIGHT) {
  const attrName = typeof config?.entity === 'string' ? config.entity : '';
  const entityId = attrName && attrName.startsWith('weather.') ? attrName : firstEntityId(config, null);
  const weather = stateOf(allStates, entityId) || state;
  const hasDays = Array.isArray(weather?.attributes?.forecast) && weather.attributes.forecast.length > 0;
  /* Without days the hero owns the whole picture instead of leaving the lower
   * third empty above a divider that separates nothing. */
  /* A 10 px band of air above the weather block, as asked for on the panel.
   * The lower half keeps its share, so the band comes out of the hero, not out
   * of the day row. */
  const TOP_BAND = WEATHER_TOP_BAND + (hasDays ? 0 : Math.round(Math.max(0, height - CARD_HEIGHT) / 2));
  /* The hero claims less than half when a day row follows: at 182/350 the
   * divider and the one-line days left the bottom third of the picture black. */
  const nowH = hasDays ? Math.round((CARD_HEIGHT + WEATHER_TOP_BAND) / 2) : CARD_HEIGHT;
  /* HA look: current value on top, days underneath. */
  drawWeatherNow(ctx, weather, width, nowH, TOP_BAND);

  let days = Array.isArray(weather?.attributes?.forecast) ? weather.attributes.forecast.slice(0, 5) : [];
  /* HA moved daily forecasts out of the state in 2024. The old fallback printed
   * a one-day row built from the *current* values, which is the hero again; the
   * hero now takes the whole picture instead, without a divider or a row. */
  if (!days.length) return;

  /* Divider between "now" and the days ahead, as in the HA card. It is placed
   * from the hero band's own bottom so a hero that grows never collides with
   * it, and stays above the day labels, not through them. */
  const dividerY = nowH + 10;
  ctx.strokeStyle = TRACK;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(32, dividerY);
  ctx.lineTo(CARD_WIDTH - 32, dividerY);
  ctx.stroke();

  /* The forecast block sits under the divider; its top follows the divider.
   * The day lines are laid out from `dayTop` and must end above the panel's
   * last row: the old fixed offsets put the rain line at 373 in card space,
   * under a 350 px panel, and that bottom row was painted off-screen. */
  /* Two lines per day (weekday, glyph, then the two readings only) keep the
   * block compact: the wearer read the columns as laid on top of each other
   * horizontally, and the fastest way to open real air is to narrow what each
   * day claims while keeping it centred in its slot. The block still ends
   * above the panel's last row. */
  /* The row has fewer lines now that each day is one line, so it hangs closer
   * to the divider and leaves the bottom margin clean. */
  /* The day row is one line tall, so its block is top-aligned just under the
   * divider: centred in the lower half it left an 80 px black band between the
   * hero and the divider and another 40 px under the days. */
  const dayTop = dividerY + 12;
  const avail = CARD_WIDTH - 48;
  /* Each day owns an equal slot; its content is narrower than the slot, so the
   * columns are pulled in from the edges and the air lands as white *between*
   * two days (+50% vs the old equal slots, which left ~one gutter for the whole
   * row). Labels shrink to the narrower column; the glyph and numbers fit it. */
  const slot = avail / days.length;
  /* 0.62 (was 0.80) + the narrower day glyph/numbers buy the extra air the
   * wearer asked for between two forecasts, without moving the block. */
  const dayW = slot * 0.74;
  const gutter = slot - dayW;
  const w = dayW;
  const margin = 24 + gutter / 2;
  const dayH = Math.max(44, CARD_HEIGHT - dayTop - 14);
  days.forEach((day, index) => {
    drawWeatherDay(ctx, day, margin + index * (w + gutter), dayW, dayTop, gutter, dayH);
  });
}

// Cards whose first entity is shown as a big value, with a bar when the config
// carries min/max bounds (input_number, number, generic sensor rows).
function drawValue(ctx, config, state) {
  const min = config?.min ?? state?.attributes?.min;
  const max = config?.max ?? state?.attributes?.max;
  if (min !== undefined && max !== undefined && numericState(state) !== null) {
    drawBar(ctx, config, state);
    return;
  }
  drawSensor(ctx, config, state);
}

// HA "entity" card in a cell. The same renderer serves every cell a grid, a
// stack or the entities pane can hand it, and those cells are very different
// sizes: a 2-column grid cell at 600x350 is ~285x160, a 3-column one ~190x110.
// The layout is chosen from the cell's own shape and every run is measured at
// 1x before it is drawn, so a value can grow to the cell's size instead of
// being capped by a ratio picked for the full card:
//
//  - vertical (HA's tile card with `vertical: true`, squareish cell): icon over
//    name over value, centred;
//  - wide (clearly wider than tall): one line, icon | name | value | unit,
//    the value at the right edge;
//  - otherwise (a two-column grid cell): icon and name on the top line, the
//    value filling the bottom of the cell, left baseline under the name.
function drawEntityTile(ctx, config, state, entityId, x, y, w, h, uniform = null) {
  const TS = GRID_TEXT_SCALE;
  const label = tileLabel(config, state, entityId);
  const raw = state ? String(state.state) : '—';
  const unit = unitOf(state);
  const on = isOn(state);
  const iconName = cardIconName(config, state, entityId);
  /* Switches, locks, alarms and covers have no useful numeric value: their
   * state is a word ("on", "locked", "disarmed") that HA itself shows as text.
   * Those cells print the word, not the raw enum. */
  const domain = String(entityId || '').split('.')[0];
  const worded = WORDED_DOMAINS.has(domain);
  const shownValue = worded ? stateLabel(raw, domain) : displayValue(state, raw);

  /* Pure black: GRAY_4 index 0 is the palette's transparent entry, so the cell
   * costs nothing to transmit. */
  ctx.fillStyle = '#000000';
  roundRect(ctx, x, y, w, h, 10);
  ctx.fill();

  const pad = Math.max(6, Math.round(Math.min(w, h) * 0.07));
  const left = x + pad;
  const right = x + w - pad;
  const iconColor = on ? INK : MUTED;

  /* One `save` and one clip, so every branch exits through a single
   * ctx.restore() and no earlier cell keeps its clip open. */
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  const boxH = Math.max(0, h - pad * 2);
  const boxW = Math.max(16, right - left);
  const gap = Math.round(Math.max(4, Math.min(pad, boxH * 0.10)));

  if (verticalTile(config, h, w)) {
    drawTileVertical(ctx, { shownValue, label, unit, iconName, iconColor, worded, on },
      { x, y, w, h, pad, boxW, boxH, gap, TS, uniform });
    ctx.restore();
    return;
  }

  const wide = boxW >= 140 && h < 120 && w >= h * 2.2;
  if (wide) {
    drawTileLine(ctx, { shownValue, label, unit, iconName, iconColor, worded, on },
      { left, right, cy: y + Math.round(h / 2), h, boxW, gap, TS, uniform });
    ctx.restore();
    return;
  }

  drawTileStacked(ctx, { shownValue, label, unit, iconName, iconColor, worded, on },
    { x, y, w, h, pad, left, right, boxW, boxH, gap, TS, uniform });
  ctx.restore();
}

function verticalTile(config, h, w) {
  return config?.vertical === true && h >= w * 0.8 && h >= 90;
}

// Icon, name and value centred on the cell, one above the other. Every run is
// sized from the cell; a word ("Verrouillé") is sized by its width, a number by
// the height it may claim.
function drawTileVertical(ctx, tile, box) {
  const { shownValue, label, unit, iconName, iconColor, worded } = tile;
  const { x, y, w, h, pad, boxW, gap, TS, uniform } = box;
  const iconSize = Math.round(Math.max(12, Math.min(h * 0.26, w * 0.30, 40)));
  const labelSize = uniform
    ? Math.min(Math.round(Math.max(MIN_TEXT_PX, Math.min(h * 0.11, 16)) * TS), uniform.labelSize)
    : Math.round(Math.max(MIN_TEXT_PX, Math.min(h * 0.11, 16)) * TS);
  const wordSize = Math.round(Math.max(MIN_TEXT_PX,
    Math.min(boxW / Math.max(3.2, shownValue.length) * 0.95, h * 0.26)) * TS);
  const valueSize = Math.round(Math.min(h * 0.34, boxW * 0.30, 46) * TS);
  const size0 = worded ? wordSize : valueSize;
  const size = uniform ? Math.min(size0, uniform.valueSize) : size0;
  const block = iconSize + Math.round(labelSize * 1.5) + gap + Math.round(size * 1.1);
  let cursor = y + Math.max(pad, Math.round((h - block) / 2));
  const cx = x + w / 2;
  if (iconSize >= 10) {
    drawIcon(ctx, iconName, cx - iconSize / 2, cursor, iconSize, iconColor);
  }
  cursor += iconSize + gap;
  if (label) {
    drawText(ctx, label, x + pad, cursor, boxW, labelSize,
      { weight: '600', color: MUTED, align: 'center', baseline: 'top' });
    cursor += Math.round(labelSize * 1.5);
  }
  if (unit) {
    const valueW = Math.min(boxW * 0.62, Math.ceil(cardRunWidth(ctx, shownValue, size, '700')));
    const unitSize = Math.max(11, Math.round(size * 0.5));
    const unitW = Math.min(boxW * 0.28, Math.ceil(cardRunWidth(ctx, unit, unitSize, '600'))) + 2;
    const total = Math.min(boxW, valueW + unitW);
    const startX = cx - total / 2;
    drawText(ctx, shownValue, startX, cursor, Math.max(16, valueW + 2), size,
      { weight: '700', baseline: 'top' });
    drawText(ctx, unit, startX + valueW + 2, cursor, Math.max(16, unitW), unitSize,
      { weight: '600', color: MUTED, baseline: 'top' });
  } else {
    drawText(ctx, shownValue, cx, cursor, boxW, size,
      { weight: '700', color: INK, align: 'center', baseline: 'top' });
  }
}

// One line: icon | name | value | unit. The value keeps the right edge and is
// sized first, because it is what the wearer reads; the name then takes what is
// left and may shorten its font, never the value's.
function drawTileLine(ctx, tile, box) {
  const { shownValue, label, unit, iconName, iconColor, worded, on } = tile;
  const { left, right, cy, h, boxW, gap, TS, uniform } = box;
  const iconSize = Math.round(Math.max(0, Math.min(h * 0.30, boxW * 0.18, 44)));
  const iconCol = iconSize >= 12 && boxW >= 90 ? iconSize + gap : 0;
  if (iconCol) drawIcon(ctx, iconName, left, cy - iconSize / 2, iconSize, iconColor);

  const valueColor = worded ? (on ? INK : MUTED) : INK;
  const valueCap = Math.min(h * 0.52, 46) * TS;
  const value = shownValue || '';
  let unitSize = unit ? Math.round(Math.max(11, Math.min(valueCap * 0.42, 20))) : 0;
  const unitW0 = unit ? Math.ceil(cardRunWidth(ctx, unit, unitSize, '600')) : 0;
  /* A value whose own full-size run would leave the name nothing is fitted to
   * the share of the line it may use; a short value keeps its cap and leaves
   * the name the rest. */
  const fullW = cardRunWidth(ctx, value, valueCap, '700');
  const valueMax = Math.max(20, Math.round(boxW * 0.46));
  const valueSize0 = fullW > valueMax
    ? Math.max(MIN_TEXT_PX, Math.floor((valueCap * valueMax) / fullW))
    : Math.round(valueCap);
  const valueSize = uniform ? Math.min(valueSize0, uniform.valueSize) : valueSize0;
  const valueW = Math.ceil(cardRunWidth(ctx, value, valueSize, '700'));
  const unitW = unit ? unitW0 + 6 : 0;
  const slot = left + iconCol;
  const nameSlot = Math.max(24, right - unitW - valueW - slot - gap);
  const labelSize0 = Math.round(Math.max(MIN_TEXT_PX, Math.min(h * 0.34, 22, nameSlot / 11)) * TS);
  const labelSize = uniform ? Math.min(labelSize0, uniform.labelSize) : labelSize0;
  if (label) {
    const ls = Math.min(labelSize, fitSize(ctx, label, nameSlot, labelSize, '600'));
    drawText(ctx, label, slot, cy, nameSlot, ls,
      { weight: '600', color: MUTED, baseline: 'middle' });
  }
  drawText(ctx, value, right - unitW - valueW, cy, valueW + 1, valueSize,
    { weight: '700', color: valueColor, align: 'left', baseline: 'middle' });
  if (unit) {
    drawText(ctx, unit, right, cy, unitW, unitSize,
      { weight: '600', color: MUTED, align: 'right', baseline: 'middle' });
  }
}

// The grid-cell shape: the top line carries the icon and the name, the value
// fills the bottom of the cell. The value's size is chosen from the room it
// actually has (width *and* height, with the name's line taken out), then the
// two runs are centred as one block, so the pair sits in the middle of the cell
// instead of hugging its top edge.
function drawTileStacked(ctx, tile, box) {
  const { shownValue, label, unit, iconName, iconColor, worded, on } = tile;
  const { x, y, w, h, pad, left, right, boxW, boxH, gap, TS, uniform } = box;
  const valueColor = worded ? (on ? INK : MUTED) : INK;
  const value = shownValue || '';
  const weight = worded ? '600' : '700';

  /* Icon on the name's line, sized to the line it shares. It only costs width
   * the name already has to spare: the name is fitted to the *remaining* room,
   * so a long label still shrinks (or ellipsises) onto its one line instead of
   * pushing the value into a stub -- the value is sized first, as before, and
   * keeps the whole cell's width. A cell too narrow for both drops the icon. */
  const nameCap0 = Math.min(boxH * 0.30, boxW / 5.5, 22) * TS;
  let iconSize = Math.round(Math.max(0, Math.min(nameCap0 * 1.15, boxH * 0.34, 26)));
  if (iconSize < 12 || boxW < 96) iconSize = 0;
  const iconCol = iconSize ? iconSize + Math.round(Math.max(3, gap * 0.6)) : 0;
  const nameW = Math.max(16, boxW - iconCol);

  /* Everything the bottom line may use, unit included: the unit is drawn at the
   * right edge and the value is fitted to what is left of the same line. A run
   * is close to linear in its width, so a ratio lands it in the box and the
   * loop only trims the last pixel or two of hinting. */
  const unitSize = unit ? Math.round(Math.max(11, Math.min(boxH * 0.16, 24))) : 0;
  const unitW = unit ? Math.max(8, Math.ceil(cardRunWidth(ctx, unit, unitSize, '600'))) + 6 : 0;
  const valueMaxW = Math.max(16, boxW - unitW);
  const startSize = Math.round(Math.min(boxH * 0.62, 72) * TS);
  let vSize = uniform ? Math.min(startSize, uniform.valueSize) : startSize;
  for (let i = 0; i < 5; i += 1) {
    const runW = cardRunWidth(ctx, value, vSize, weight);
    if (runW <= valueMaxW || runW <= 0) break;
    vSize = Math.max(1, Math.floor((vSize * valueMaxW) / runW));
  }
  const valueH = runHeight(ctx, value, vSize, weight);

  /* The name takes the band above the value, fitted to it by height and then by
   * width, shortened with an ellipsis past the floor: a label that overflows its
   * cell is worse than a short one. A name that is *only* slightly wider than a
   * legible run still gets its line -- a cell whose name vanished left the value
   * floating with nothing to say what it measures -- by borrowing a little of
   * the value's air. */
  const nameRoom = Math.max(0, boxH - valueH - gap);
  const nameCap = Math.min(boxH * 0.30, boxW / 5.5, 22) * TS;
  const labelW = label ? cardRunWidth(ctx, label, nameCap, '600') : 0;
  const wideName = labelW > nameW * 1.4;
  let nameSize = 0;
  let nameText = '';
  if (label && (nameRoom >= MIN_TEXT_PX * 1.1 || (wideName && boxH >= valueH + MIN_TEXT_PX * 1.3))) {
    const roomSize = Math.max(MIN_TEXT_PX, nameRoom * 0.92);
    nameSize = Math.max(MIN_TEXT_PX, Math.round(Math.min(roomSize, nameCap)));
    if (uniform) nameSize = Math.min(nameSize, uniform.labelSize);
    for (let i = 0; i < 5; i += 1) {
      const nrw = cardRunWidth(ctx, label, nameSize, '600');
      if (nrw <= nameW) break;
      nameSize = Math.max(1, Math.floor((nameSize * nameW) / nrw));
    }
    nameText = label;
    if (cardRunWidth(ctx, label, nameSize, '600') > nameW) {
      let keep = label.length;
      while (keep > 1 && cardRunWidth(ctx, `${label.slice(0, keep)}…`, nameSize, '600') > nameW) keep -= 1;
      nameText = `${label.slice(0, keep)}…`;
    }
  }
  const nameH = nameSize ? runHeight(ctx, nameText, nameSize, '600') : 0;

  /* Centre the pair vertically, inside the padded band. */
  const blockH = (nameSize ? nameH + gap : 0) + valueH;
  let cursor = Math.max(y + pad, y + Math.round((h - blockH) / 2));
  if (nameSize) {
    if (iconCol) {
      /* The icon shares the name's line, its lower edge on the run's baseline,
       * so glyph and text read as one header rather than a sticker. */
      const top = cursor + Math.max(0, Math.round((nameH - iconSize) / 2));
      drawIcon(ctx, iconName, left, top, iconSize, iconColor);
    }
    drawText(ctx, nameText, left + iconCol, cursor, nameW + 2, nameSize,
      { weight: '600', color: MUTED, baseline: 'top' });
    cursor += Math.round(nameH + gap);
  }
  /* The value's baseline sits on the last drawn row of its own run: `cursor` is
   * the top of the value's line; the fixed baseline is placed from the measured
   * ascent, so the run's bottom lands on cursor + valueH. */
  const limit = y + h - pad;
  if (cursor + valueH > limit) cursor = Math.max(y + pad, limit - valueH);
  const baseline = cursor + cardRunAscent(ctx, value, vSize, weight);
  if (unit) {
    drawText(ctx, value, left, baseline, valueMaxW + 2, vSize,
      { weight, color: valueColor, baseline: 'alphabetic', fixedBaseline: true });
    drawText(ctx, unit, right, baseline, Math.max(16, unitW), unitSize,
      { weight: '600', color: MUTED, align: 'right', baseline: 'alphabetic', fixedBaseline: true });
  } else {
    drawText(ctx, value, left, baseline, boxW, vSize,
      { weight, color: valueColor, baseline: 'alphabetic', fixedBaseline: true });
  }
}

/* Domains whose state is a word, not a measurement. */
const WORDED_DOMAINS = new Set([
  'switch', 'light', 'fan', 'lock', 'cover', 'alarm_control_panel',
  'binary_sensor', 'input_boolean', 'vacuum', 'media_player', 'person',
  'device_tracker', 'climate', 'valve', 'siren', 'humidifier',
]);

const STATE_WORDS = {
  on: 'Allumé', off: 'Éteint', open: 'Ouvert', closed: 'Fermé',
  locked: 'Verrouillé', unlocked: 'Déverrouillé', locking: 'Verrouillage',
  unlocking: 'Déverrouillage', opening: 'Ouverture', closing: 'Fermeture',
  jammed: 'Bloqué', home: 'Présent', not_home: 'Absent', playing: 'Lecture',
  paused: 'Pause', idle: 'Au repos', standby: 'Veille', heat: 'Chauffe',
  cool: 'Refroidit', heat_cool: 'Auto', auto: 'Auto', dry: 'Déshumidifie',
  fan_only: 'Ventile', cleaning: 'Nettoyage', docked: 'Sur base',
  disarmed: 'Désarmé', armed_home: 'Armé maison', armed_away: 'Armé absent',
  armed_night: 'Armé nuit', armed_vacation: 'Armé vacances',
  armed_custom_bypass: 'Armé partiel', arming: 'Armement',
  pending: 'En attente', triggered: 'Déclenché', disarming: 'Désarmement',
  unavailable: 'Indisponible', unknown: '—',
};

function stateLabel(raw, domain) {
  const key = String(raw || '').toLowerCase();
  if (STATE_WORDS[key]) return STATE_WORDS[key];
  if (domain === 'alarm_control_panel' && key === 'armed_away') return 'Armé absent';
  return key ? key.replace(/_/g, ' ') : '—';
}

// Pane-list fallback for an entities list: the same cell renderer as a stack
// card, laid out on the whole panel. It used to cap the list at 6 cells in two
// fixed columns and silently drop the rest.
function drawEntityGrid(ctx, config, states, fallbackEntities, focusId = '') {
  drawTitle(ctx, titleOf(config));
  const source = Array.isArray(config?.entities) && config.entities.length
    ? config.entities
    : (fallbackEntities || []).map((e) => e?.id).filter(Boolean);
  const rows = [];
  for (const item of source) {
    const id = typeof item === 'string' ? item : item?.entity;
    if (typeof id === 'string' && id.trim()) {
      rows.push({ type: 'entity', entity: id.trim(), name: item?.name });
    }
  }
  if (!rows.length) return;

  /* A short list keeps the compact one-line cells; a long one is easier to
   * scan as full rows, one value per line, like the pane list it replaced. */
  const asked = Number(config?.columns);
  if (!(asked >= 1) && rows.length > 4) {
    const lineH = Math.max(28, Math.floor((CARD_HEIGHT - 62 - GUTTER) / Math.min(rows.length, VISIBLE_STACK_ROWS)));
    rows.forEach((child, index) => {
      if (index >= VISIBLE_STACK_ROWS) return;
      drawCell(ctx, child, states, GUTTER, 62 + index * lineH, CARD_WIDTH - GUTTER * 2, lineH - GUTTER, focusId);
    });
    return;
  }
  drawCells(ctx, rows, states, 62, Math.max(1, Math.min(rows.length, asked >= 1 ? asked : 2)), 0, focusId);
}

// Paints `children` as a grid of `cols` columns starting at `top`, keeping at
// most VISIBLE_STACK_ROWS rows. Shared by stack cards, the entities pane and
// the stack window, so all three size and place their cells the same way.
function drawCells(ctx, children, states, top, cols, firstRow = 0, focusId = '') {
  const total = Math.ceil(children.length / cols);
  const shown = Math.max(1, Math.min(total, VISIBLE_STACK_ROWS));
  const cellH = Math.max(28, Math.floor((CARD_HEIGHT - top - GUTTER) / shown) - GUTTER);
  const cellW = (CARD_WIDTH - GUTTER * (cols + 1)) / cols;
  for (let row = 0; row < shown; row += 1) {
    const source = row + firstRow;
    if (source >= total) break;
    for (let col = 0; col < cols; col += 1) {
      const child = children[source * cols + col];
      if (!child) break;
      const x = GUTTER + col * (cellW + GUTTER);
      const y = top + row * (cellH + GUTTER);
      drawCell(ctx, child, states, x, y, cellW, cellH, focusId);
    }
  }
}

function drawCell(ctx, child, states, x, y, w, h, focusId = '') {
  const card = normalizeCard(child);
  const config = card.config && typeof card.config === 'object' ? card.config : {};
  const type = String(card.cardtype || config.type || 'entities').toLowerCase();
  clipRect(ctx, x, y, w, h);
  if (ENTITY_TILE_TYPES.has(type) && !STACK_CARD_TYPES.has(type)) {
    drawEntityTile(ctx, config, stateOf(states, firstEntityId(config, card.entities)),
      firstEntityId(config, card.entities), x, y, w, h);
    if (focusId && firstEntityId(config, card.entities) === focusId) drawFocusRing(ctx, x, y, w, h);
    ctx.restore();
    return;
  }
  ctx.restore();
  drawChild(ctx, child, states, x, y, w, h);
}

// --- composite cards -------------------------------------------------------
//
// A grid / stack card carries its children under `cards`, each one written the
// way Lovelace writes it: { type, entity, name, icon } at the root, not under a
// `config` key. Every child is drawn straight into its own cell at the cell's
// size, so labels stay readable instead of being shrunk from a full card.

const STACK_CARD_TYPES = new Set([
  'vertical-stack', 'horizontal-stack', 'grid', 'stack', 'custom:auto-entities',
]);

const GUTTER = 10;

// A grid shows at most two rows at a time: on the glasses' small panel, cells
// any shorter stop being readable. Cards with more rows are scrolled with the
// head (see cardScrollRows / the `scroll` argument of renderCard).
const VISIBLE_STACK_ROWS = 2;

/* Rows a grid card shows at once. The cells are always sized for the reference
 * grid (see FIT_CELL_H), so three rows fill the panel exactly; a grid with
 * more rows shows the first three and the rest are reached by scrolling the
 * card (cardScrollRows). */
const VISIBLE_GRID_ROWS = GRID_REF_ROWS;

function normalizeCard(card) {
  if (!card || typeof card !== 'object') return {};
  if (card.config && typeof card.config === 'object') return card;
  return { cardtype: card.type, config: card, entities: [] };
}

function stackChildren(config) {
  const list = Array.isArray(config?.cards) ? config.cards : [];
  if (list.length) return list.filter((child) => child && typeof child === 'object');
  return config?.card && typeof config.card === 'object' ? [config.card] : [];
}

/* Domains whose entity a row action can drive (see ha.js actionService): a
 * sensor has nothing to toggle, a light/switch/button/scene does. Kept in sync
 * with the services callAction knows. */
export const ACTIONABLE_DOMAINS = new Set([
  'light', 'switch', 'fan', 'cover', 'lock', 'scene', 'script', 'automation',
  'button', 'input_boolean', 'input_select', 'input_number', 'number', 'select',
  'climate', 'media_player', 'vacuum', 'water_heater', 'valve', 'siren',
  'humidifier', 'counter', 'timer', 'remote', 'camera', 'alarm_control_panel',
]);

/* Entity ids of an `entities` card, in the exact order drawEntityGrid lays them
 * out. Same source fallback (config.entities, then the dashboard's own entity
 * list) so the focus cursor lands on the cell the ring is drawn on. */
function entitiesCardRows(config, fallbackEntities) {
  const source = Array.isArray(config?.entities) && config.entities.length
    ? config.entities
    : (fallbackEntities || []).map((e) => e?.id).filter(Boolean);
  const out = [];
  for (const item of source) {
    const id = typeof item === 'string' ? item : item?.entity;
    if (typeof id === 'string' && id.trim()) out.push(id.trim());
  }
  return out;
}

/* Ordered list of entities on a card that a button press can trigger, in the
 * order the card draws them (the same walk drawStack uses). This is the list
 * the up/down arrows step through: one entry per actionable tile, so the
 * cursor the phone keeps lines up with the tiles the wearer sees. */
export function cardFocusEntities(card) {
  return cardFocusEntries(card).map((entry) => entry.id);
}

/* The dashboard's own `tap_action` for each entry cardFocusEntities returns, in
 * the same order (one per actionable tile). A tile that binds a press to
 * something other than its entity's default service ("TV" running a script)
 * carries it here; a tile with no tap_action yields null so the caller keeps
 * the domain default (toggle). */
export function cardFocusActions(card) {
  return cardFocusEntries(card).map((entry) => entry.action);
}

/* Same walk as cardFocusEntities, but each entry keeps the tile's tap_action.
 * A dashboard can show one entity twice with a different action per tile (a
 * switch that toggles, and beside it a tile that runs a script): the focus
 * list only keeps one cell per entity id, so that second, action-bearing tile
 * would be unreachable on the glasses. Keeping a distinct entry when the
 * action differs lets the ring step onto it and run the script. */
export function cardFocusEntries(card) {
  const normalized = normalizeCard(card);
  const config = normalized.config && typeof normalized.config === 'object' ? normalized.config : {};
  const type = String(normalized.cardtype || config.type || '').toLowerCase();
  const out = [];
  const push = (id, rawAction) => {
    if (!id) return;
    const domain = id.split('.')[0];
    if (!ACTIONABLE_DOMAINS.has(domain)) return;
    const action = normalizeTapAction(rawAction);
    const key = id + '|' + (action ? action.service : '');
    if (out.some((entry) => entry.key === key)) return;
    out.push({ id, action, key });
  };
  const walk = (raw) => {
    const child = raw && typeof raw === 'object' ? normalizeCard(raw) : {};
    const childConfig = child.config && typeof child.config === 'object' ? child.config : {};
    const childType = String(child.cardtype || childConfig.type || 'entities').toLowerCase();
    if (STACK_CARD_TYPES.has(childType)) {
      const merged = { ...childConfig };
      for (const grand of stackChildren(merged)) walk(grand);
      return;
    }
    if (childType === 'entities') {
      for (const row of entitiesCardRows(childConfig, child.entities)) push(row, null);
      return;
    }
    push(firstEntityId(childConfig, child.entities), childConfig.tap_action);
  };
  if (STACK_CARD_TYPES.has(type)) {
    for (const child of stackChildren(config)) walk(child);
  } else if (type === 'entities') {
    for (const row of entitiesCardRows(config, normalized.entities)) push(row, null);
  } else {
    push(firstEntityId(config, normalized.entities), config.tap_action);
  }
  return out;
}

/* A tile's tap_action in the shape ha.js can run: { service: 'domain.name',
 * data } for a call, or null to fall back to the entity's default. HA writes
 * these as "toggle", "call-service"/"perform-action" (with perform_action or
 * service), or "more-info"/"url"/"navigate" (nothing the phone can do from a
 * card picture, so they fall back to the default toggle the wearer expects). */
function normalizeTapAction(action) {
  if (!action || typeof action !== 'object') return null;
  const kind = String(action.action || '').toLowerCase();
  if (kind === 'toggle') return null;
  if (kind === 'perform-action' || kind === 'call-service') {
    const service = String(action.perform_action || action.service || '').trim();
    if (!service || service.indexOf('.') <= 0) return null;
    const target = action.target && typeof action.target === 'object' ? action.target : {};
    const data = action.data && typeof action.data === 'object' ? { ...action.data } : {};
    if (target.entity_id !== undefined && data.entity_id === undefined) data.entity_id = target.entity_id;
    return { service, data };
  }
  return null;
}

// Column count: HA's own `columns` when the card asks for it, otherwise two.
function stackColumns(type, config, count) {
  const asked = Number(config?.columns);
  if (Number.isFinite(asked) && asked >= 1 && asked <= 4) return Math.floor(asked);
  if (type === 'horizontal-stack') return Math.min(count, 4);
  if (type === 'vertical-stack') return 1;
  return count === 1 ? 1 : 2;
}

// Geometry a stack card shares between drawing and scrolling: how many rows it
// has in total, how many fit on screen, and the last usable scroll offset.
function stackLayout(type, config) {
  const children = stackChildren(config);
  const cols = children.length
    ? Math.max(1, Math.min(children.length, stackColumns(type, config, children.length)))
    : 1;
  const rows = children.length ? Math.ceil(children.length / cols) : 0;
  /* A grid is always the reference board: three rows of two, even when the
   * card holds fewer entities -- two entities fill the first row and the cells
   * below stay empty, so every grid card reads the same. A long grid still
   * scrolls row by row (maxOffset counts only the rows past the third). */
  const visible = rows ? VISIBLE_GRID_ROWS : 0;
  return { children, cols, rows, visible, maxOffset: Math.max(0, rows - visible) };
}

/* Column count of the grid a card draws its focusable entities in, and the
 * row an entry lands on. Shared with plugin.js so the ring can reveal the row
 * it moved onto: the entries come from cardFocusEntities, which walks the card
 * in draw order (one listing per cell), so the only thing left to know is how
 * many cells share a row. */
export function gridColumnCount(card) {
  const normalized = normalizeCard(card);
  const config = normalized.config && typeof normalized.config === 'object' ? normalized.config : {};
  const type = String(normalized.cardtype || config.type || '').toLowerCase();
  if (!STACK_CARD_TYPES.has(type)) return 1;
  const children = stackChildren(config);
  if (!children.length) return 1;
  return Math.max(1, Math.min(children.length, stackColumns(type, config, children.length)));
}

export function gridRowOf(index, cols) {
  const width = Math.max(1, Math.floor(cols) || 1);
  return Math.floor(Math.max(0, Math.floor(index) || 0) / width);
}

// Number of scroll steps a card picture has: 0 when the card fits on screen.
// A grid taller than the panel scrolls row by row. Every other card is drawn at
// the picture size and cannot scroll; on those a head up/down scrolls the whole
// card instead, by a fixed share of the picture (see plugin.js).
export function cardScrollRows(card) {
  const normalized = normalizeCard(card);
  const config = normalized.config && typeof normalized.config === 'object' ? normalized.config : {};
  const type = String(normalized.cardtype || config.type || '').toLowerCase();
  if (!STACK_CARD_TYPES.has(type)) return 0;
  /* One step per hidden row: row 0 is always the first window, so the steps
   * are 1..maxOffset and each one brings the next row into view. */
  return stackLayout(type, config).maxOffset;
}

// Renders any card as a window that starts `scrollPx` rows down: the picture is
// drawn twice as tall and the wanted window is copied out. A grid keeps its own
// row stepping (drawn directly at its offset); every other card is a still
// picture whose head gesture must still be visible, so it pans.
export function cardToGray4Window(card, states, canvas, width, height, scrollPx = 0, focusId = '') {
  const offset = Math.max(0, Math.round(scrollPx) || 0);
  const normalized = normalizeCard(card);
  const config = normalized.config && typeof normalized.config === 'object' ? normalized.config : {};
  const type = String(normalized.cardtype || config.type || '').toLowerCase();
  if (STACK_CARD_TYPES.has(type) || offset === 0 || height <= 0) {
    return cardToGray4(card, states, canvas, width, height, offset, focusId);
  }
  const tall = document.createElement('canvas');
  setCanvasSize(tall, TALL_WIDTH, TALL_HEIGHT + offset * SS);
  const ctx = tall.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, tall.width, tall.height);
  ctx.scale(SS, SS);
  renderCard(ctx, card, states, 0, focusId);
  /* The card's lower part is flat black, so panning shows it moving instead of
   * sitting frozen: a banner names the card and says the picture can move. */
  const notice = document.createElement('canvas');
  setCanvasSize(notice, TALL_WIDTH, offset * SS);
  const nctx = notice.getContext('2d', { willReadFrequently: true });
  nctx.fillStyle = '#000000';
  nctx.fillRect(0, 0, notice.width, notice.height);
  nctx.scale(SS, SS);
  drawText(nctx, titleOf(config) || normalized.title || 'Home Assistant',
    40, Math.round(offset * 0.45), width - 80, 22, { weight: '500', color: MUTED });
  drawText(nctx, PAN_HINT, 40, Math.round(offset * 0.45) + 34, width - 80, 18,
    { weight: '400', color: MUTED });
  ctx.drawImage(notice, 0, height);
  const view = document.createElement('canvas');
  setCanvasSize(view, width, height);
  const out = view.getContext('2d', { willReadFrequently: true });
  out.fillStyle = '#000000';
  out.fillRect(0, 0, width, height);
  out.drawImage(tall, 0, offset * SS, TALL_WIDTH, height * SS, 0, 0, width, height);
  return rgbaToGray4(out.getImageData(0, 0, width, height).data, width, height);
}

function drawStack(ctx, type, config, states, width, height, scroll = 0, focusId = '') {
  const layout = stackLayout(type, config);
  if (!layout.rows) return;
  const { children, cols } = layout;
  /* Cells are sized for the reference grid, never for the rows this card
   * happens to hold: a 2-cell grid and a 9-cell one show the same tiles. The
   * rows drawn start at `scroll` (the first hidden row the wearer asked for)
   * and stop at the panel's bottom, so a long grid is read window by window. */
  const firstRow = Math.min(Math.max(Math.round(scroll) || 0, 0), layout.maxOffset);
  /* The board is always three rows tall: the cell height comes from the
   * reference grid, never from how many rows this card happens to hold. */
  const rows = layout.visible;
  const cellW = (width - GUTTER * (cols + 1)) / cols;
  const cellH = (height - GUTTER * (VISIBLE_GRID_ROWS + 1)) / VISIBLE_GRID_ROWS;
  /* One text size per card, and the same size on every card. Every grid uses
   * the same cell height, so a plain card is never scaled and the ceiling is
   * the target itself; the fit-to-screen step still compensates whenever a
   * picture does come out taller than the panel. Long values ("2320 W") still
   * shrink below the ceiling tile-by-tile -- the fit maths in drawTile* keeps
   * them inside their cell -- but every short value lands on one size. */
  const availH = Math.max(1, CARD_HEIGHT - 2 * FIT_MARGIN);
  const availW = Math.max(1, width - 2 * FIT_MARGIN);
  const fitScale = Math.min(availH / Math.max(1, height), availW / Math.max(1, width), 1);
  const valueCap = Math.round(UNIFORM_VALUE_PX / Math.max(0.1, fitScale));
  const uniform = uniformTileSizes(ctx, children, states, cellW, cellH, valueCap);
  for (let row = 0; row < rows; row += 1) {
    const source = row + firstRow;
    for (let col = 0; col < cols; col += 1) {
      const index = source * cols + col;
      /* Past the last entity the cell is still part of the board: it is handed
       * to drawChild empty so it can outline the slot instead of leaving a
       * hole. A two-entity grid must still paint its two empty rows below
       * row 0, so the loop never stops at the card's own row count. */
      drawChild(
        ctx,
        index < children.length ? children[index] : null,
        states,
        GUTTER + col * (cellW + GUTTER),
        GUTTER + row * (cellH + GUTTER),
        cellW,
        cellH,
        uniform,
        focusId,
        true,
      );
    }
  }
}

/* Shared value and name size for a stack's entity tiles: the smallest size any
 * of them would pick for itself. Measured, not drawn: `fit` mirrors what
 * drawEntityTile and the drawTile* layouts compute, on the same canvas. */
function uniformTileSizes(ctx, children, states, w, h, valueCap = Infinity) {
  let valueSize = Infinity;
  let labelSize = Infinity;
  for (const rawChild of children) {
    const child = rawChild && typeof rawChild === 'object' ? normalizeCard(rawChild) : {};
    const config = child.config && typeof child.config === 'object' ? child.config : {};
    const type = String(child.cardtype || config.type || 'entities').toLowerCase();
    if (!ENTITY_TILE_TYPES.has(type) || STACK_CARD_TYPES.has(type)) continue;
    const entityId = firstEntityId(config, child.entities);
    const state = stateOf(states, entityId);
    const label = tileLabel(config, state, entityId);
    const raw = state ? String(state.state) : '—';
    const domain = String(entityId || '').split('.')[0];
    const shownValue = WORDED_DOMAINS.has(domain) ? stateLabel(raw, domain) : displayValue(state, raw);
    const unit = unitOf(state);
    const pad = Math.max(6, Math.round(Math.min(w, h) * 0.07));
    const boxW = Math.max(16, w - pad * 2);
    const boxH = Math.max(0, h - pad * 2);
    const gap = Math.round(Math.max(4, Math.min(pad, boxH * 0.10)));
    const TS = GRID_TEXT_SCALE;
    if (verticalTile(config, h, w)) {
      const wordSize = Math.round(Math.max(MIN_TEXT_PX,
        Math.min(boxW / Math.max(3.2, shownValue.length) * 0.95, h * 0.26)) * TS);
      const vSize = WORDED_DOMAINS.has(domain)
        ? wordSize
        : Math.round(Math.min(h * 0.34, boxW * 0.30, 46) * TS);
      valueSize = Math.min(valueSize, vSize);
      labelSize = Math.min(labelSize, Math.round(Math.max(MIN_TEXT_PX, Math.min(h * 0.11, 16)) * TS));
      continue;
    }
    const wide = boxW >= 140 && h < 120 && w >= h * 2.2;
    if (wide) {
      const valueCap = Math.min(h * 0.52, 46) * TS;
      const fullW = cardRunWidth(ctx, shownValue, valueCap, '700');
      const valueMax = Math.max(20, Math.round(boxW * 0.46));
      const vSize = fullW > valueMax
        ? Math.max(MIN_TEXT_PX, Math.floor((valueCap * valueMax) / fullW))
        : Math.round(valueCap);
      valueSize = Math.min(valueSize, vSize);
      labelSize = Math.min(labelSize,
        Math.round(Math.max(MIN_TEXT_PX, Math.min(h * 0.34, 22, boxW / 11)) * TS));
      continue;
    }
    const unitSize = unit ? Math.round(Math.max(11, Math.min(boxH * 0.16, 24))) : 0;
    const unitW = unit ? Math.max(8, Math.ceil(cardRunWidth(ctx, unit, unitSize, '600'))) + 6 : 0;
    const valueMaxW = Math.max(16, boxW - unitW);
    let vSize = Math.round(Math.min(boxH * 0.62, 72) * TS);
    const weight = WORDED_DOMAINS.has(domain) ? '600' : '700';
    for (let i = 0; i < 5; i += 1) {
      const runW = cardRunWidth(ctx, shownValue, vSize, weight);
      if (runW <= valueMaxW || runW <= 0) break;
      vSize = Math.max(1, Math.floor((vSize * valueMaxW) / runW));
    }
    valueSize = Math.min(valueSize, vSize);
    if (label) {
      labelSize = Math.min(labelSize,
        Math.round(Math.max(MIN_TEXT_PX, Math.min(boxH * 0.30, boxW / 5.5, 22)) * TS));
    }
  }
  if (!Number.isFinite(valueSize) || !Number.isFinite(labelSize)) return null;
  /* A fixed ceiling so a card whose values all happen to be short does not
   * inflate its type past its neighbours'. Each tile's own fit still wins when
   * it is smaller (a long value in a narrow cell). */
  if (Number.isFinite(valueCap)) valueSize = Math.min(valueSize, valueCap);
  return { valueSize, labelSize };
}

// One child in its cell. Entity-like children (what a HA grid is almost always
// made of) get a dedicated compact layout; anything else is painted at card
// size and scaled down so it keeps its own composition.
function drawChild(ctx, rawChild, states, x, y, w, h, uniform = null, focusId = '', outline = false) {
  const child = normalizeCard(rawChild);
  const config = child.config && typeof child.config === 'object' ? child.config : {};
  const type = String(child.cardtype || config.type || 'entities').toLowerCase();
  const entityId = firstEntityId(config, child.entities);

  clipRect(ctx, x, y, w, h);
  /* An empty slot stays completely blank: the board is still laid out 2 x 3 so
   * the entities keep a uniform tile size, but a cell no entity fills draws
   * nothing at all (no outline, no placeholder). */
  if (outline && !entityId) {
    ctx.restore();
    return;
  }
  if (ENTITY_TILE_TYPES.has(type) && !STACK_CARD_TYPES.has(type)) {
    drawEntityTile(ctx, config, stateOf(states, entityId), entityId, x, y, w, h, uniform);
    if (focusId && entityId === focusId) drawFocusRing(ctx, x, y, w, h);
    ctx.restore();
    return;
  }
  /* Any other card used to be drawn at 600x350 and scaled down to cell size:
   * at a third of its size its 17 px text floor came out at 5 px on the panel,
   * under the GRAY_4 pipeline's readable size, and the result was a smudge in
   * one corner of the cell. Draw it at its own size inside the cell instead:
   * the composition degrades (a row list shows its first rows) but every line
   * it prints stays legible. */
  drawCard(ctx, child, states, { width: w, height: h }, 0, focusId);
  ctx.restore();
}

// Cards that are just "one entity, its name, its value": the ones a HA grid is
// built from. They fill their cell edge to edge.
const ENTITY_TILE_TYPES = new Set([
  'entity', 'sensor', 'statistic', 'button', 'tile',
  'switch', 'light', 'fan', 'cover', 'lock', 'alarm-panel', 'alarm_control_panel',
  'binary_sensor', 'input_boolean', 'number', 'input_number', 'select', 'input_select',
  'vacuum', 'media_player', 'person', 'device_tracker', 'climate', 'water_heater',
  'valve', 'siren', 'humidifier', 'weather', 'counter', 'timer', 'update',
  'button-entity', 'custom:bubble-card',
]);

function isOn(state) {
  const value = String(state?.state || '').toLowerCase();
  return value === 'on' || value === 'open' || value === 'home' || value === 'playing' || value === 'heat';
}

// Our 40-icon set cannot hold every MDI name a dashboard uses, so an unknown
// "mdi:cloud-percent" would fall back to a generic document glyph. Map the
// common measurements onto icons we do have before giving up.
const MDI_FALLBACKS = [
  // Order matters: the first pattern that matches wins, so the most specific
  // measurements come before the broad families they belong to.
  [/power|watt|consumption|energy|kwh/, 'power'],
  [/battery|charge|percent_charge|soc\b/, 'battery'],
  [/humidity|humidit|percent|droplet|moisture|hygro/, 'water'],
  [/pressure|barometer|pascal|hpa/, 'water'],
  [/thermometer|temperature|temp\b|heat|cool|climate/, 'thermometer'],
  [/motion|occupancy|presence|mouvement/, 'motion-sensor'],
  [/illuminance|brightness|lux|light|lampe|lumi/, 'lightbulb'],
  [/co2|carbon|air|gas|particulate|carbone/, 'air-conditioner'],
  [/signal|rssi|wifi|link|network|connexion/, 'wifi'],
  [/window|fenetre|fenêtre/, 'window-closed'],
  [/water|eau|flow|debit|débit/, 'water'],
  [/plug|prise/, 'power-plug'],
  [/switch|interrupteur/, 'toggle-switch'],
  [/speaker|enceinte|audio/, 'speaker'],
  [/camera|video/, 'camera'],
  [/snow|frost|gel|glace/, 'snowflake'],
  [/fire|smoke|fumee|fumée|flame/, 'fire'],
  [/fridge|frigo|refrigerat/, 'fridge'],
  [/washing|machine|lessive|lavage/, 'washing-machine'],
];

function iconFallbackName(raw) {
  const name = String(raw || '').replace(/^mdi:/, '');
  if (isKnownIcon(name)) return name;
  for (const [pattern, known] of MDI_FALLBACKS) {
    if (pattern.test(name)) return known;
  }
  return '';
}

// Sensors that carry no icon of their own still expose what they measure
// through `device_class`; map those onto icons we can draw so a temperature or
// humidity reading never falls back to the generic document glyph.
const DEVICE_CLASS_ICONS = {
  temperature: 'thermometer',
  humidity: 'water',
  moisture: 'water',
  pressure: 'water',
  battery: 'battery',
  power: 'power',
  energy: 'power',
  illuminance: 'lightbulb',
  motion: 'motion-sensor',
  occupancy: 'motion-sensor',
  carbon_dioxide: 'air-conditioner',
  signal_strength: 'wifi',
};

function cardIconName(config, state, entityId) {
  const explicit = iconFallbackName(config?.icon);
  if (explicit) return explicit;
  const fromState = iconFallbackName(state?.attributes?.icon);
  if (fromState) return fromState;
  const dc = String(state?.attributes?.device_class || '').toLowerCase();
  if (dc && DEVICE_CLASS_ICONS[dc] && isKnownIcon(DEVICE_CLASS_ICONS[dc])) {
    return DEVICE_CLASS_ICONS[dc];
  }
  return defaultIconForDomain(String(entityId || '').split('.')[0]);
}

function drawIcon(ctx, name, x, y, size, color = INK) {
  const data = iconPath(name);
  if (!data) return false;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = color;
  ctx.fill(new Path2D(data));
  ctx.restore();
  return true;
}

// Entry point: paints `card` (the wire shape from the integration) onto `ctx`.
// `states` is a Map of entity id -> HA state object. `scroll` is the row offset
// of a grid card, moved by the wearer's head (0 shows the first rows).
export function renderCard(ctx, card, states, scroll = 0, focusId = '') {
  drawCard(ctx, card, states, null, scroll, focusId);
}

// `box` lets composites paint a child at another size than the full card.
function drawCard(ctx, rawCard, states, box = null, scroll = 0, focusId = '') {
  const card = normalizeCard(rawCard);
  const width = box ? box.width : CARD_WIDTH;
  const height = box ? box.height : CARD_HEIGHT;
  frame(ctx, width, height);
  const config = card.config && typeof card.config === 'object' ? card.config : {};
  const type = String(card.cardtype || config.type || 'entities').toLowerCase();
  const entityId = firstEntityId(config, card?.entities);
  const state = stateOf(states, entityId);
  const title = titleOf(config) || (typeof card?.title === 'string' ? card.title : '');
  const merged = title && !titleOf(config) ? { ...config, name: title } : config;

  if (STACK_CARD_TYPES.has(type)) {
    drawStack(ctx, type, merged, states, width, height, scroll, focusId);
    return;
  }

  switch (type) {
    case 'gauge':
      drawGauge(ctx, merged, state);
      break;
    case 'markdown':
      drawMarkdown(ctx, merged);
      break;
    case 'thermostat':
    case 'climate':
      drawThermostat(ctx, merged, state, states, card?.entities);
      break;
    case 'weather':
    case 'weather-forecast':
      drawWeather(ctx, merged, state, states, width, height);
      break;
    case 'sensor':
    case 'entity':
      drawSensor(ctx, merged, state);
      break;
    case 'media-control':
    case 'media_player':
    case 'media-player':
      drawMediaPlayer(ctx, merged, state, states);
      break;
    case 'entities':
      drawEntityGrid(ctx, merged, states, card?.entities, focusId);
      break;
    case 'heading':
    case 'glance':
      // Composite cards: draw the first readable value instead of nothing.
      textOrReadout(ctx, merged, state);
      break;
    default:
      if (isReadoutCard(type, merged)) textOrReadout(ctx, merged, state);
      else if (isBarCard(type, merged)) drawBar(ctx, merged, state);
      else drawValue(ctx, merged, state);
      break;
  }
}

// Card types that always read as "one value + progress bar".
function isBarCard(type, config) {
  return (
    type === 'bar' ||
    type === 'input_number' ||
    type === 'number' ||
    type === 'progress' ||
    (config?.min !== undefined && config?.max !== undefined)
  );
}

// A card carrying neither a title nor a sentence is really a readout: draw its
// value big with the entity name above, whichever Lovelace type it came from.
function isReadoutCard(type, config) {
  if (isBarCard(type, config)) return false;
  if (typeof config?.content === 'string' && config.content.trim()) return false;
  return !titleOf(config);
}

// Plain text without any Lovelace type is a markdown card in HA practice.
function textOrReadout(ctx, config, state) {
  if (typeof config?.content === 'string' && config.content.trim()) {
    drawMarkdown(ctx, config);
    return;
  }
  /* Without a state the big readout would only hold a dash: say the entity
   * name instead, which is what the row list showed for this card. */
  if (!state) {
    drawSensor(ctx, config, undefined);
    return;
  }
  drawSensor(ctx, config, state);
}

// Converts RGBA pixels into GRAY_4 bytes: two pixels per byte, high nibble is
// the even (left) pixel, matching the glasses framebuffer format.
export function rgbaToGray4(pixels, width, height) {
  const stride = Math.ceil(width / 2);
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      const left = Math.round((pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722) / 17);
      let right = 0;
      if (x + 1 < width) {
        const j = i + 4;
        right = Math.round((pixels[j] * 0.2126 + pixels[j + 1] * 0.7152 + pixels[j + 2] * 0.0722) / 17);
      }
      out[y * stride + (x >> 1)] = (Math.min(15, Math.max(0, left)) << 4) | Math.min(15, Math.max(0, right));
    }
  }
  return out;
}

// Renders a card to GRAY_4 bytes using an offscreen canvas owned by the caller.
export function cardToGray4(card, states, canvas, width = CARD_WIDTH, height = CARD_HEIGHT, scroll = 0, focusId = '') {
  const ctx = renderToCanvas(card, states, canvas, width, height, scroll, focusId);
  const image = ctx.getImageData(0, 0, width, height);
  return rgbaToGray4(image.data, width, height);
}
