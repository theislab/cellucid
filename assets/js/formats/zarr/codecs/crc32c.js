/**
 * The `crc32c` codec of Zarr v3: a CRC-32C (Castagnoli) checksum appended to
 * the encoded bytes, as little-endian 32 bits. Sharded arrays use it on every
 * shard index by default.
 *
 * @module formats/zarr/codecs/crc32c
 */

import { ZarrFormatError } from '../errors.js';

const TABLES = (() => {
  const tables = new Uint32Array(8 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    tables[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = tables[n];
    for (let t = 1; t < 8; t++) {
      c = tables[c & 0xff] ^ (c >>> 8);
      tables[t * 256 + n] = c >>> 0;
    }
  }
  return tables;
})();

/**
 * The CRC-32C of `bytes` (slicing by 8, eight bytes read as two words).
 *
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function crc32c(bytes) {
  const t = TABLES;
  let crc = 0xffffffff;
  let i = 0;
  const length = bytes.length;
  const fast = length - (length % 8);
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);
  for (; i < fast; i += 8) {
    const a = view.getInt32(i, true) ^ crc;
    const b = view.getInt32(i + 4, true);
    crc = t[1792 + (a & 0xff)] ^ t[1536 + ((a >>> 8) & 0xff)] ^
      t[1280 + ((a >>> 16) & 0xff)] ^ t[1024 + (a >>> 24)] ^
      t[768 + (b & 0xff)] ^ t[512 + ((b >>> 8) & 0xff)] ^
      t[256 + ((b >>> 16) & 0xff)] ^ t[b >>> 24];
  }
  for (; i < length; i++) crc = t[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

/**
 * Check and remove the trailing checksum.
 *
 * @param {Uint8Array} input
 * @returns {Uint8Array} A view of `input` without its checksum
 */
export function crc32cDecode(input) {
  if (input.length < 4) throw new ZarrFormatError('A CRC-32C checksum is truncated.');
  const end = input.length - 4;
  const stored = (input[end] | (input[end + 1] << 8) | (input[end + 2] << 16) | (input[end + 3] << 24)) >>> 0;
  if (crc32c(input.subarray(0, end)) !== stored) {
    throw new ZarrFormatError('A chunk is damaged: its CRC-32C checksum does not match.');
  }
  return input.subarray(0, end);
}
