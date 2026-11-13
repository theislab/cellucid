/**
 * Variable-length strings and bytes, as numcodecs `VLenUTF8` / `VLenBytes`
 * (Zarr v2 filters) and the Zarr v3 `vlen-utf8` / `vlen-bytes` codecs write
 * them: a little-endian 32-bit item count, then each item as a 32-bit length
 * and its bytes.
 *
 * @module formats/zarr/codecs/vlen
 */

import { ZarrFormatError } from '../errors.js';
import { allocateTypedArray } from '../../../data/sparse-column-index.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The UTF-8 text of `bytes[start, end)`, refusing invalid UTF-8. Short ASCII
 * strings (most labels and names) skip the decoder, whose per-call cost
 * dominates for them, and are made in one piece: a string built a character
 * at a time is a chain of as many pieces until it is first read whole (a
 * column of names held several times the heap built so; measured:
 * 27_decisions_memory_model.md).
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
    if (ascii) return String.fromCharCode.apply(null, bytes.subarray(start, end));
  }
  try {
    return utf8.decode(bytes.subarray(start, end));
  } catch (cause) {
    throw new ZarrFormatError(`${what} holds a string that is not valid UTF-8.`, { cause });
  }
}

/**
 * A chunk of variable-length items as stored, each decoded when it is read
 * (`at`): a share of a chunk's rows (a subsample's kept cells) decodes those
 * items alone, and the chunk is held as its bytes and one offset per item,
 * not as a string per item.
 */
export class VlenItems {
  /**
   * @param {Uint8Array} bytes - The decoded chunk (its own buffer)
   * @param {Uint32Array|Float64Array} starts - Item i's bytes start at `starts[i]` and
   *   end 4 bytes before `starts[i + 1]` (its successor's length)
   * @param {string} what - The array, for messages
   */
  constructor(bytes, starts, what) {
    this.bytes = bytes;
    this.starts = starts;
    this.length = starts.length - 1;
    this.what = what;
  }

  /** Bytes held: the chunk and its offsets. */
  get byteLength() {
    return this.bytes.byteLength + this.starts.byteLength;
  }

  /** Item `i`, decoded (invalid UTF-8 refused). */
  at(i) {
    return decodeUtf8(this.bytes, this.starts[i], this.starts[i + 1] - 4, this.what);
  }

  /** Every item, decoded. */
  toArray() {
    const values = new Array(this.length);
    for (let i = 0; i < this.length; i++) values[i] = this.at(i);
    return values;
  }
}

/**
 * The `count` variable-length items of a decoded chunk, checked (count,
 * lengths, no trailing bytes) and indexed, each decoded when read.
 *
 * @param {Uint8Array} input
 * @param {number} count - Items the chunk must hold
 * @param {string} what - The array, for messages
 * @returns {VlenItems}
 */
export function vlenItems(input, count, what) {
  if (input.length < 4) throw new ZarrFormatError(`${what}: a variable-length chunk is truncated.`);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const stored = view.getUint32(0, true);
  if (stored !== count) {
    throw new ZarrFormatError(`${what}: a chunk holds ${stored} strings, not the ${count} its shape declares.`);
  }
  // Each item takes at least its 4-byte length.
  if (count > (input.length - 4) / 4) throw new ZarrFormatError(`${what}: a variable-length chunk is truncated.`);
  // Offsets as wide as the chunk needs: 32 bits up to 4 GiB.
  const starts = allocateTypedArray(input.length + 4 <= 0xffffffff ? Uint32Array : Float64Array, count + 1, `${what} item offsets`);
  let at = 4;
  for (let i = 0; i < count; i++) {
    if (at + 4 > input.length) throw new ZarrFormatError(`${what}: a variable-length chunk is truncated.`);
    const length = view.getUint32(at, true);
    at += 4;
    if (at + length > input.length) throw new ZarrFormatError(`${what}: a variable-length chunk is truncated.`);
    starts[i] = at;
    at += length;
  }
  if (at !== input.length) throw new ZarrFormatError(`${what}: a variable-length chunk has bytes after its last string.`);
  starts[count] = at + 4;
  return new VlenItems(input, starts, what);
}
