/**
 * @fileoverview Unsigned varint (LEB128) encode/decode helpers.
 *
 * The session bundle uses uvarint for compact integer encoding:
 * - 7 data bits per byte
 * - MSB is "continue"
 * - little-endian in the varint sense (least-significant 7-bit group first)
 *
 * This codec is intentionally small and dependency-free so other languages can
 * reimplement it easily.
 *
 * @module session/codecs/varint
 */

/**
 * Append an unsigned varint to a byte array.
 * @param {number} value - Non-negative integer (safe up to 2^53-1).
 * @param {number[]} out
 */
export function pushUvarint(value, out) {
  // Defensive: coerce and validate.
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`pushUvarint: invalid value ${value}`);
  }

  // Varint encodes 7 bits per byte.
  // We use >>> 0 only for the fast path, but keep the loop generic for JS numbers.
  let v = n;
  while (v >= 0x80) {
    // Use modulo instead of bitwise ops so values > 2^32 remain correct.
    const low7 = v % 0x80;
    out.push(low7 + 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
}

/**
 * Encode an unsigned varint into a compact Uint8Array.
 * @param {number} value
 * @returns {Uint8Array}
 */
export function encodeUvarint(value) {
  const bytes = [];
  pushUvarint(value, bytes);
  return new Uint8Array(bytes);
}

/**
 * Decode an unsigned varint from bytes starting at `offset`.
 * @param {Uint8Array} bytes
 * @param {number} [offset=0]
 * @returns {{ value: number, nextOffset: number }}
 */
export function decodeUvarint(bytes, offset = 0) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('decodeUvarint: expected Uint8Array.');
  }
  let result = 0;
  let shift = 0;
  let pos = offset;

  // Max 10 bytes covers up to 2^70, but we also enforce JS safe integer bounds.
  for (let i = 0; i < 10; i++) {
    if (pos >= bytes.byteLength) {
      throw new Error('decodeUvarint: truncated varint.');
    }
    const b = bytes[pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) {
      if (!Number.isSafeInteger(result)) {
        throw new Error('decodeUvarint: value exceeds JS safe integer range.');
      }
      return { value: result, nextOffset: pos };
    }
    shift += 7;
  }

  throw new Error('decodeUvarint: varint too long.');
}
