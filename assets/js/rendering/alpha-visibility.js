/**
 * Exact point-alpha visibility contract shared by CPU and GPU consumers.
 *
 * Point transparency is one byte a cell, a `Uint8Array` holding exactly 0
 * (hidden) or 1 (shown). Every producer is a binary predicate — category,
 * continuous-range, outlier and per-cell filters either keep a cell or drop
 * it — so no fractional value exists to represent, and a byte represents both
 * values exactly at a quarter of the Float32 cost.
 *
 * The renderer publishes it to WebGL as normalized R8 (`alpha * 255`, so 0 or
 * 255). The shaders discard encoded values below the float literal 0.01, so
 * byte 3 is the first visible value; POINT_VISIBILITY_THRESHOLD is that
 * boundary on the caller's scale, which 1 passes and 0 does not.
 */

import { formatCountOf } from '../utils/format-units.js';

export const MIN_VISIBLE_ALPHA_BYTE = 3;

/**
 * A cell's color (RGBA8) never carries its visibility: the transparency
 * does. Its alpha byte says how it is layered instead, three layers drawn
 * bottom to top:
 *
 * - `UNREAD_ALPHA_BYTE`: a cell a gene sample did not read (a gene read for
 *   a sample of the open cells, `data/anndata/subsample-plan.js`), which has
 *   no value yet. It is drawn first, flat, in a color derived from the
 *   view's background (`rendering/read-cell-layer.js`, `unreadCellColor`),
 *   so the map keeps its shape but recedes; its RGB bytes are not drawn.
 * - `BENEATH_ALPHA_BYTE`: a cell drawn beneath the colored ones -- a
 *   continuous field's no-value gray (a gene's cells read that do not express
 *   it, a missing value) -- so a sparse gene's expressing cells are never
 *   covered by the gray around them.
 * - 255: a cell drawn as usual, on top.
 *
 * The renderer draws a field with lower layers in one pass a layer over the
 * same points (`HighPerfRenderer`, `colorLayersOf`); while some cells are not
 * read, the cells read are drawn larger (their density on screen,
 * `readCellSizeMultiplier`) and, whenever there are no more of them than a
 * level of detail draws, every one at that level. A figure draws the
 * layers in the same order (`drawnSequence`).
 */
export const BENEATH_ALPHA_BYTE = 254;
export const UNREAD_ALPHA_BYTE = 253;

/**
 * What the alpha byte of an RGBA8 color array says, named by every consumer
 * that reads one: `'layer'` for a field's colors of the cells (255,
 * `BENEATH_ALPHA_BYTE` or `UNREAD_ALPHA_BYTE`; their visibility is the
 * transparency), `'opacity'` for the colors of markers of their own
 * (centroids), whose alpha byte is the marker's opacity, 0 hiding it.
 *
 * @param {unknown} meaning
 * @param {string} label - What to name in the failure.
 * @returns {'layer'|'opacity'}
 */
export function requireColorAlphaMeaning(meaning, label) {
  if (meaning !== 'layer' && meaning !== 'opacity') {
    throw new TypeError(`${label} must say what its colors' alpha byte is: 'layer' or 'opacity', not ${String(meaning)}.`);
  }
  return meaning;
}

/** Platform byte order of the RGBA8 words read below. */
const LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

/** The answer for colors with every cell on top. */
const SINGLE_LAYER = Object.freeze({ layered: false, unread: 0 });

/**
 * The layers of `colors` (RGBA8): whether any cell lies below the top layer
 * (its alpha byte below 255), and how many cells are not read
 * (`UNREAD_ALPHA_BYTE`). One pass of word reads.
 *
 * @param {Uint8Array} colors
 * @returns {Readonly<{layered: boolean, unread: number}>}
 */
export function colorLayersOf(colors) {
  let layered = false;
  let unread = 0;
  if (colors.byteOffset % 4 === 0) {
    const words = new Uint32Array(colors.buffer, colors.byteOffset, colors.length >>> 2);
    const shift = LITTLE_ENDIAN ? 24 : 0;
    for (let i = 0; i < words.length; i++) {
      const alpha = (words[i] >>> shift) & 0xff;
      if (alpha !== 255) {
        layered = true;
        if (alpha === UNREAD_ALPHA_BYTE) unread++;
      }
    }
  } else {
    for (let i = 3; i < colors.length; i += 4) {
      if (colors[i] !== 255) {
        layered = true;
        if (colors[i] === UNREAD_ALPHA_BYTE) unread++;
      }
    }
  }
  return layered ? Object.freeze({ layered, unread }) : SINGLE_LAYER;
}

export const POINT_VISIBILITY_THRESHOLD = Math.fround(
  (MIN_VISIBLE_ALPHA_BYTE - 0.5) / 255
);

/**
 * Require one exact point-transparency array: a `Uint8Array` of `pointCount`
 * entries, each exactly 0 or 1.
 *
 * @param {unknown} values
 * @param {number} pointCount
 * @param {string} label - What to name in the failure.
 * @returns {Uint8Array}
 */
export function requirePointTransparency(values, pointCount, label) {
  if (!(values instanceof Uint8Array) || values.length !== pointCount) {
    throw new TypeError(
      `${label} must be a Uint8Array with exactly ${formatCountOf(pointCount, 'entry', 'entries')}.`
    );
  }
  const index = firstNonBinaryByte(values);
  if (index >= 0) {
    throw new RangeError(
      `${label} entry ${index} must be exactly 0 or 1.`
    );
  }
  return values;
}

/*
 * Per-cell 0/1 byte arrays are read four cells to a 32-bit word where the
 * bytes start on a word boundary: a byte is 0 or 1 iff its upper seven bits
 * are clear (`word & 0xfefefefe` is 0 for four such bytes), in either byte
 * order. The word loop is a function of its own so it is compiled for its
 * loop alone.
 */

/** Index of the first word of `words[from, to)` holding a byte above 1, or -1. */
function firstNonBinaryWord(words, from, to) {
  for (let i = from; i < to; i++) {
    if ((words[i] & 0xfefefefe) !== 0) return i;
  }
  return -1;
}

/**
 * The index of the first byte of `bytes` that is neither 0 nor 1, or -1.
 *
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function firstNonBinaryByte(bytes) {
  const n = bytes.length;
  const head = Math.min(n, (4 - (bytes.byteOffset & 3)) & 3);
  for (let i = 0; i < head; i++) {
    if (bytes[i] > 1) return i;
  }
  const wordCount = (n - head) >>> 2;
  if (wordCount > 0) {
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset + head, wordCount);
    const word = firstNonBinaryWord(words, 0, wordCount);
    if (word >= 0) {
      let i = head + word * 4;
      while (bytes[i] <= 1) i++;
      return i;
    }
  }
  for (let i = head + wordCount * 4; i < n; i++) {
    if (bytes[i] > 1) return i;
  }
  return -1;
}
