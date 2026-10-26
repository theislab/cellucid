/**
 * LZF decompression, for h5py's LZF filter (filter id 32000).
 *
 * LZF is a byte-oriented LZ77 variant: a control byte below 32 starts a run
 * of `ctrl + 1` literal bytes; anything else is a back reference of
 * `(ctrl >> 5) + 2` bytes (plus an extra length byte when that field is 7)
 * at distance `((ctrl & 31) << 8) + next + 1`.
 *
 * @module formats/hdf5/lzf
 */

import { copyMatch } from '../io/lz-match.js';

/**
 * Decompress `input` into exactly `outputSize` bytes.
 *
 * @param {Uint8Array} input
 * @param {number} outputSize
 * @returns {Uint8Array|null} null when the stream is corrupt or does not decode to `outputSize` bytes
 */
export function lzfDecompress(input, outputSize) {
  const output = new Uint8Array(outputSize);
  const view = new DataView(output.buffer);
  const inputLength = input.length;
  let ip = 0;
  let op = 0;
  while (ip < inputLength) {
    const ctrl = input[ip++];
    if (ctrl < 32) {
      const length = ctrl + 1;
      if (op + length > outputSize || ip + length > inputLength) return null;
      if (length < 16) {
        for (let i = 0; i < length; i++) output[op++] = input[ip++];
      } else {
        output.set(input.subarray(ip, ip + length), op);
        ip += length;
        op += length;
      }
    } else {
      let length = ctrl >> 5;
      if (length === 7) {
        if (ip >= inputLength) return null;
        length += input[ip++];
      }
      length += 2;
      if (ip >= inputLength) return null;
      const offset = ((ctrl & 0x1f) << 8) + input[ip++] + 1;
      if (offset > op || op + length > outputSize) return null;
      copyMatch(output, view, op, offset, length);
      op += length;
    }
  }
  return op === outputSize ? output : null;
}
