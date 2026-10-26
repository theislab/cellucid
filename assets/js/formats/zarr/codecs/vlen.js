/**
 * Variable-length strings and bytes, as numcodecs `VLenUTF8` / `VLenBytes`
 * (Zarr v2 filters) and the Zarr v3 `vlen-utf8` / `vlen-bytes` codecs write
 * them: a little-endian 32-bit item count, then each item as a 32-bit length
 * and its bytes.
 *
 * @module formats/zarr/codecs/vlen
 */

import { ZarrFormatError } from '../errors.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The UTF-8 text of `bytes[start, end)`, refusing invalid UTF-8. Short ASCII
 * strings (most labels and names) skip the decoder, whose per-call cost
 * dominates for them.
 */
export function decodeUtf8(bytes, start, end, what) {
  const length = end - start;
  if (length <= 32) {
    let ascii = true;
    for (let i = start; i < end; i++) {
      if (bytes[i] >= 0x80) {
        ascii = false;
        break;
      }
    }
    if (ascii) {
      let text = '';
      for (let i = start; i < end; i++) text += String.fromCharCode(bytes[i]);
      return text;
    }
  }
  try {
    return utf8.decode(bytes.subarray(start, end));
  } catch (cause) {
    throw new ZarrFormatError(`${what} holds a string that is not valid UTF-8.`, { cause });
  }
}

/**
 * Decode `count` variable-length items.
 *
 * @param {Uint8Array} input
 * @param {number} count - Items the chunk must hold
 * @param {string} what - The array, for messages
 * @returns {string[]}
 */
export function vlenDecode(input, count, what) {
  if (input.length < 4) throw new ZarrFormatError(`${what}: a variable-length chunk is truncated.`);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const stored = view.getUint32(0, true);
  if (stored !== count) {
    throw new ZarrFormatError(`${what}: a chunk holds ${stored} strings, not the ${count} its shape declares.`);
  }
  // Each item takes at least its 4-byte length.
  if (count > (input.length - 4) / 4) throw new ZarrFormatError(`${what}: a variable-length chunk is truncated.`);
  const values = new Array(count);
  let at = 4;
  for (let i = 0; i < count; i++) {
    if (at + 4 > input.length) throw new ZarrFormatError(`${what}: a variable-length chunk is truncated.`);
    const length = view.getUint32(at, true);
    at += 4;
    if (at + length > input.length) throw new ZarrFormatError(`${what}: a variable-length chunk is truncated.`);
    values[i] = decodeUtf8(input, at, at + length, what);
    at += length;
  }
  if (at !== input.length) throw new ZarrFormatError(`${what}: a variable-length chunk has bytes after its last string.`);
  return values;
}
