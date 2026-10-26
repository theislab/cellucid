/**
 * LZ4 block decompression, and the numcodecs `LZ4` framing (a 4-byte
 * little-endian decoded size, then one LZ4 block). Blosc's `lz4` and `lz4hc`
 * streams are plain LZ4 blocks.
 *
 * The output is allocated once at the size the caller expects, and every
 * literal run and match is checked against both buffers before it is copied:
 * a malformed block is refused, never read or written out of bounds. Short
 * literal runs and matches are copied sixteen and eight bytes at a time when
 * the block's output region has room past them (what follows overwrites the
 * extra bytes); nothing is ever written outside that region.
 *
 * @module formats/zarr/codecs/lz4
 */

import { ZarrFormatError } from '../errors.js';
import { BLOCK_COPY_BYTES, copyMatch } from '../../io/lz-match.js';
import { formatCountOf } from '../../../utils/format-units.js';

function corrupt(detail) {
  return new ZarrFormatError(`LZ4 data is corrupt: ${detail}.`);
}

/**
 * Decode one LZ4 block into `output[outputStart, outputEnd)`, which it must
 * fill exactly.
 *
 * @param {Uint8Array} input
 * @param {Uint8Array} output
 * @param {number} [outputStart]
 * @param {number} [outputEnd]
 */
export function lz4DecodeBlockInto(input, output, outputStart = 0, outputEnd = output.length) {
  const inputEnd = input.length;
  const inputView = new DataView(input.buffer, input.byteOffset, input.length);
  const view = new DataView(output.buffer, output.byteOffset, output.length);
  let i = 0;
  let o = outputStart;
  for (;;) {
    if (i >= inputEnd) throw corrupt('the block ends without its final literals');
    const token = input[i++];
    let literals = token >>> 4;
    if (literals === 15) {
      let byte;
      do {
        if (i >= inputEnd) throw corrupt('a literal length is truncated');
        byte = input[i++];
        literals += byte;
      } while (byte === 255);
    }
    if (i + literals > inputEnd || o + literals > outputEnd) throw corrupt('a literal run exceeds its bounds');
    if (literals <= 16 && i + 16 <= inputEnd && o + 16 <= outputEnd) {
      // Sixteen bytes, those past the run overwritten by what follows it.
      view.setInt32(o, inputView.getInt32(i, true), true);
      view.setInt32(o + 4, inputView.getInt32(i + 4, true), true);
      view.setInt32(o + 8, inputView.getInt32(i + 8, true), true);
      view.setInt32(o + 12, inputView.getInt32(i + 12, true), true);
    } else if (literals > 32) {
      output.set(input.subarray(i, i + literals), o);
    } else {
      for (let k = 0; k < literals; k++) output[o + k] = input[i + k];
    }
    i += literals;
    o += literals;
    if (i === inputEnd) break;
    if (i + 2 > inputEnd) throw corrupt('a match offset is truncated');
    const offset = input[i] | (input[i + 1] << 8);
    i += 2;
    if (offset === 0 || offset > o - outputStart) throw corrupt('a match offset reaches before the output');
    let length = token & 15;
    if (length === 15) {
      let byte;
      do {
        if (i >= inputEnd) throw corrupt('a match length is truncated');
        byte = input[i++];
        length += byte;
      } while (byte === 255);
    }
    length += 4;
    const stop = o + length;
    if (stop > outputEnd) throw corrupt('a match exceeds the output');
    if (offset >= 8 && length < BLOCK_COPY_BYTES && stop + 8 <= outputEnd) {
      // Eight bytes at a time, possibly past the match's end (bytes the rest
      // of the block overwrites): a source at least eight bytes back is
      // already written, so this also repeats a pattern of eight or more.
      let from = o - offset;
      do {
        view.setInt32(o, view.getInt32(from, true), true);
        view.setInt32(o + 4, view.getInt32(from + 4, true), true);
        o += 8;
        from += 8;
      } while (o < stop);
    } else {
      copyMatch(output, view, o, offset, length);
    }
    o = stop;
  }
  if (o !== outputEnd) throw corrupt(`it decodes to ${formatCountOf(o - outputStart, 'byte')}, not ${outputEnd - outputStart}`);
}

/**
 * Decode numcodecs' LZ4 framing: a little-endian 32-bit decoded size, then
 * one LZ4 block.
 *
 * @param {Uint8Array} input
 * @param {number|null} expectedSize
 * @returns {Uint8Array}
 */
export function numcodecsLz4Decode(input, expectedSize) {
  if (input.length < 4) throw corrupt('the size header is truncated');
  const size = (input[0] | (input[1] << 8) | (input[2] << 16) | (input[3] << 24)) >>> 0;
  if (expectedSize !== null && size !== expectedSize) {
    throw corrupt(`it declares ${formatCountOf(size, 'byte')}, not the ${expectedSize} expected`);
  }
  // LZ4 expands at most 255:1 (a 255-byte length extension per byte).
  if (size > (input.length - 4) * 255 + 16) throw corrupt(`it declares more bytes than LZ4 can encode in ${input.length}`);
  const output = new Uint8Array(size);
  if (size > 0) lz4DecodeBlockInto(input.subarray(4), output);
  return output;
}
