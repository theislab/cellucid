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
 * are clear (`word & 0xfefefefe` is 0 for four such bytes), and `word * 255`
 * turns four 0/1 bytes into four 0/255 bytes with no carry between them
 * (each product is at most 255). Both hold in either byte order. The word
 * loops are functions of their own so each is compiled for its loop alone.
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

/**
 * Four 0/1 transparency bytes a word as their R8 bytes (0 or 255) into
 * `target[from, to)`, compared with `reference` (read before `target` is
 * written, so the two may be one array). Returns 1 when any byte
 * differs from `reference`, 0 when none does, and -1 when a source byte is
 * above 1 (the caller names it).
 */
function encodeAlphaWords(source, target, reference, from, to) {
  let seen = 0;
  let moved = 0;
  for (let i = from; i < to; i++) {
    const value = source[i];
    seen |= value;
    const encoded = Math.imul(value, 255);
    moved |= encoded ^ reference[i];
    target[i] = encoded;
  }
  if ((seen & 0xfefefefe) !== 0) return -1;
  return moved !== 0 ? 1 : 0;
}

/**
 * Word views over the byte arrays an R8 alpha encoding reads and writes, or
 * null when one of them does not start on a word boundary.
 *
 * @param {Uint8Array} alphas - Transparency, exactly 0 or 1 a cell.
 * @param {Uint8Array} target - R8 bytes written.
 * @param {Uint8Array} reference - R8 bytes compared with.
 * @returns {{source: Uint32Array, target: Uint32Array, reference: Uint32Array}|null}
 */
export function alphaEncodingWords(alphas, target, reference) {
  if (
    (alphas.byteOffset & 3) !== 0 ||
    (target.byteOffset & 3) !== 0 ||
    (reference.byteOffset & 3) !== 0
  ) {
    return null;
  }
  const words = array => new Uint32Array(array.buffer, array.byteOffset, array.length >>> 2);
  return { source: words(alphas), target: words(target), reference: words(reference) };
}

/**
 * Encode the transparency of cells `[from, to)` as R8 bytes, `alpha * 255`
 * (exactly `Math.round(value * 255)` for 0 and 1), into `target`, and
 * compare them with `reference`.
 *
 * @param {Uint8Array} alphas - Transparency, exactly 0 or 1 a cell.
 * @param {Uint8Array} target
 * @param {Uint8Array} reference
 * @param {{source: Uint32Array, target: Uint32Array, reference: Uint32Array}|null} words
 *   `alphaEncodingWords` of the three arrays; null encodes byte by byte.
 * @param {number} from - First cell; a multiple of 4 when `words` is given.
 * @param {number} to - End cell (exclusive), at most `alphas.length`.
 * @returns {number} 1 when a byte moved, 0 when none did, or `-(index + 1)`
 *   naming the first cell whose value is above 1.
 */
export function encodeAlphaSpan(alphas, target, reference, words, from, to) {
  let wordEnd = from;
  let result = 0;
  if (words !== null) {
    const wordFrom = from >>> 2;
    const wordTo = to >>> 2;
    if (wordTo > wordFrom) {
      result = encodeAlphaWords(words.source, words.target, words.reference, wordFrom, wordTo);
      if (result < 0) {
        let index = from;
        while (alphas[index] <= 1) index++;
        return -(index + 1);
      }
      wordEnd = wordTo * 4;
    }
  }
  let moved = 0;
  for (let i = wordEnd; i < to; i++) {
    const value = alphas[i];
    if (value > 1) return -(i + 1);
    const encoded = -value & 255;
    moved |= encoded ^ reference[i];
    target[i] = encoded;
  }
  return result !== 0 || moved !== 0 ? 1 : 0;
}
