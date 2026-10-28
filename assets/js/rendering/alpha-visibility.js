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
