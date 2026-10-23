/**
 * Reading HDF5's little-endian binary structures.
 *
 * Every structure in an HDF5 file stores its numbers little-endian, its
 * addresses in "Size of Offsets" bytes and its lengths in "Size of Lengths"
 * bytes (both from the superblock), and marks an absent address with all
 * bits set. A `Cursor` walks one structure's bytes with those rules and
 * refuses to read past them, so a corrupt length can never index outside
 * the structure.
 *
 * Integers wider than 32 bits are read exactly. A value beyond
 * `Number.MAX_SAFE_INTEGER` cannot be an offset or a length in any file a
 * browser can hold, so where a number is required it is a format error,
 * never a silently rounded value; where the full value matters (attribute
 * data) the decoders use 64-bit typed arrays instead.
 *
 * @module formats/hdf5/binary
 */

import { formatError } from './errors.js';

const TWO_32 = 2 ** 32;

/** Bytes needed to encode `value` (HDF5's `H5VM_limit_enc_size`). */
export function limitEncodedSize(value) {
  const v = typeof value === 'bigint' ? value : BigInt(value);
  let bits = 0;
  for (let rest = v; rest > 1n; rest >>= 1n) bits++;
  return Math.floor(bits / 8) + 1;
}

/** log2 of a power of two, or -1 when `value` is not one. */
export function log2Exact(value) {
  if (!Number.isSafeInteger(value) || value < 1) return -1;
  const bits = Math.log2(value);
  return Number.isInteger(bits) && 2 ** bits === value ? bits : -1;
}

/**
 * Read an unsigned little-endian integer of `size` bytes (1-8) at `offset`
 * of `bytes`. Returns a number when it is exact, otherwise `null` when all
 * bits are set (HDF5's undefined address), otherwise throws through `fail`.
 */
export function readUintLE(bytes, offset, size, fail) {
  if (size === 8) {
    const low = (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
    const high = (bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24)) >>> 0;
    // Below 2^53: exact as a number.
    if (high < 0x200000) return high * TWO_32 + low;
    if (high === 0xffffffff && low === 0xffffffff) return null;
    return fail(`an 8-byte value exceeds ${Number.MAX_SAFE_INTEGER}`);
  }
  if (size === 4) return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  if (size === 2) return bytes[offset] | (bytes[offset + 1] << 8);
  if (size === 1) return bytes[offset];
  let low = 0;
  let high = 0;
  const lowBytes = Math.min(size, 4);
  for (let i = 0; i < lowBytes; i++) low += bytes[offset + i] * 2 ** (8 * i);
  for (let i = 4; i < size; i++) high += bytes[offset + i] * 2 ** (8 * (i - 4));
  if (size <= 4) return low;
  const value = high * TWO_32 + low;
  if (Number.isSafeInteger(value)) return value;
  let allSet = true;
  for (let i = 0; i < size; i++) {
    if (bytes[offset + i] !== 0xff) {
      allSet = false;
      break;
    }
  }
  if (allSet) return null;
  return fail(`a ${size}-byte value exceeds ${Number.MAX_SAFE_INTEGER}`);
}

/**
 * A position in one structure's bytes.
 *
 * `fileOffset` is the absolute file offset of `bytes[0]`, used only to say
 * where a problem is.
 */
export class Cursor {
  /**
   * @param {Uint8Array} bytes
   * @param {{fileOffset?: number, label?: string, offsetSize?: number, lengthSize?: number, position?: number}} [options]
   */
  constructor(bytes, { fileOffset = NaN, label = 'HDF5 structure', offsetSize = 8, lengthSize = 8, position = 0 } = {}) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.fileOffset = fileOffset;
    this.label = label;
    this.offsetSize = offsetSize;
    this.lengthSize = lengthSize;
    this.position = position;
  }

  get remaining() {
    return this.bytes.length - this.position;
  }

  /** A format error naming this structure and the current file offset. */
  error(problem) {
    return formatError(this.label, this.fileOffset + this.position, problem);
  }

  fail = problem => {
    throw this.error(problem);
  };

  need(count) {
    if (count < 0 || this.position + count > this.bytes.length) {
      throw this.error(`needs ${count} more bytes but only ${Math.max(0, this.remaining)} remain`);
    }
  }

  seek(position) {
    if (position < 0 || position > this.bytes.length) {
      throw this.error(`position ${position} is outside the ${this.bytes.length}-byte structure`);
    }
    this.position = position;
  }

  skip(count) {
    this.need(count);
    this.position += count;
  }

  u8() {
    this.need(1);
    return this.bytes[this.position++];
  }

  u16() {
    this.need(2);
    const value = this.view.getUint16(this.position, true);
    this.position += 2;
    return value;
  }

  u32() {
    this.need(4);
    const value = this.view.getUint32(this.position, true);
    this.position += 4;
    return value;
  }

  /** An unsigned integer of `size` bytes that must be exact (not all-ones). */
  uint(size) {
    if (size === 0) return 0;
    if (size > 8) throw this.error(`a ${size}-byte integer field is wider than 8 bytes`);
    this.need(size);
    const value = readUintLE(this.bytes, this.position, size, this.fail);
    if (value === null) throw this.error(`a ${size}-byte value has every bit set where a number is required`);
    this.position += size;
    return value;
  }

  /** An unsigned integer of `size` bytes, or `null` when every bit is set. */
  uintOrUndefined(size) {
    this.need(size);
    const value = readUintLE(this.bytes, this.position, size, this.fail);
    this.position += size;
    return value;
  }

  u64() {
    return this.uint(8);
  }

  /** An address ("Size of Offsets" bytes); `null` for the undefined address. */
  address() {
    return this.uintOrUndefined(this.offsetSize);
  }

  /** A length ("Size of Lengths" bytes). */
  length() {
    return this.uint(this.lengthSize);
  }

  /** A length that may be the all-ones "unlimited" value (`null`). */
  lengthOrUnlimited() {
    return this.uintOrUndefined(this.lengthSize);
  }

  /** A view of the next `count` bytes. */
  take(count) {
    this.need(count);
    const view = this.bytes.subarray(this.position, this.position + count);
    this.position += count;
    return view;
  }

  /** Require the four-character signature `expected`. */
  signature(expected) {
    this.need(expected.length);
    for (let i = 0; i < expected.length; i++) {
      if (this.bytes[this.position + i] !== expected.charCodeAt(i)) {
        const found = String.fromCharCode(...this.bytes.subarray(this.position, this.position + expected.length));
        throw this.error(`expected the signature "${expected}", found ${JSON.stringify(found)}`);
      }
    }
    this.position += expected.length;
  }

  /** A NUL-terminated string; `padTo` rounds the bytes consumed up to a multiple. */
  cstring({ padTo = 1 } = {}) {
    const start = this.position;
    let end = start;
    while (end < this.bytes.length && this.bytes[end] !== 0) end++;
    if (end >= this.bytes.length) throw this.error('a name is not NUL-terminated');
    const text = decodeText(this.bytes.subarray(start, end));
    const consumed = end + 1 - start;
    this.skip(Math.ceil(consumed / padTo) * padTo);
    return text;
  }
}

const utf8 = new TextDecoder('utf-8');

/**
 * Decode string bytes. ASCII bytes take a fast path; anything else is
 * decoded as UTF-8 (a superset of ASCII), which is also how files that mark
 * UTF-8 text as ASCII are best read.
 */
export function decodeText(bytes) {
  const length = bytes.length;
  if (length === 0) return '';
  if (length <= 32) {
    let ascii = true;
    for (let i = 0; i < length; i++) {
      if (bytes[i] > 0x7f) {
        ascii = false;
        break;
      }
    }
    if (ascii) return String.fromCharCode.apply(null, bytes);
  }
  return utf8.decode(bytes);
}
