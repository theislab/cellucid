/**
 * @fileoverview Unsigned varint (LEB128) encode/decode helpers.
 *
 * The session bundle uses uvarint for compact integer encoding:
 * - 7 data bits per byte
 * - MSB is "continue"
 * - little-endian in the varint sense (least-significant 7-bit group first)
 *
 * Writers size their output first (`uvarintLength`) and then write into one
 * preallocated `Uint8Array` (`writeUvarint`), so encoding a set of half a
 * million cells allocates one buffer, not a growing array of numbers.
 *
 * This codec is intentionally small and dependency-free so other languages can
 * reimplement it easily.
 *
 * @module session/codecs/varint
 */

function assertUvarintValue(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Uvarint value must be a non-negative safe integer.');
  }
}

/**
 * Number of bytes `value` takes as a uvarint.
 * @param {number} value - Non-negative safe integer.
 * @returns {number}
 */
export function uvarintLength(value) {
  assertUvarintValue(value);
  if (value < 0x80) return 1;
  if (value < 0x4000) return 2;
  if (value < 0x20_0000) return 3;
  if (value < 0x1000_0000) return 4;
  let length = 4;
  let v = Math.floor(value / 0x1000_0000);
  while (v > 0) {
    length += 1;
    v = Math.floor(v / 0x80);
  }
  return length;
}

/**
 * Write one uvarint at `offset`.
 * @param {Uint8Array} out
 * @param {number} offset
 * @param {number} value - Non-negative safe integer.
 * @returns {number} The offset after the written bytes.
 */
export function writeUvarint(out, offset, value) {
  assertUvarintValue(value);
  let v = value;
  let position = offset;
  while (v >= 0x80) {
    // Modulo instead of bitwise ops so values above 2^32 stay exact.
    out[position++] = (v % 0x80) + 0x80;
    v = Math.floor(v / 0x80);
  }
  out[position++] = v;
  return position;
}

/**
 * Encode a short list of uvarints into its own buffer.
 * @param {number[]} values
 * @returns {Uint8Array}
 */
export function encodeUvarints(values) {
  let length = 0;
  for (const value of values) length += uvarintLength(value);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const value of values) offset = writeUvarint(out, offset, value);
  return out;
}

/**
 * Decode an unsigned varint from bytes starting at `offset`.
 * @param {Uint8Array} bytes
 * @param {number} [offset=0]
 * @returns {{ value: number, nextOffset: number }}
 */
export function decodeUvarint(bytes, offset = 0) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('decodeUvarint: expected Uint8Array.');
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.byteLength) {
    throw new TypeError('decodeUvarint: offset must be an exact in-range byte offset.');
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
    const group = b & 0x7f;
    result += group * Math.pow(2, shift);
    if (!Number.isSafeInteger(result)) {
      throw new Error('decodeUvarint: value exceeds JS safe integer range.');
    }
    if ((b & 0x80) === 0) {
      if (i > 0 && group === 0) {
        throw new Error('decodeUvarint: non-canonical varint encoding.');
      }
      return { value: result, nextOffset: pos };
    }
    shift += 7;
  }

  throw new Error('decodeUvarint: varint too long.');
}
