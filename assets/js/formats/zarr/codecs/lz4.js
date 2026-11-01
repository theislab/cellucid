/**
 * LZ4 blocks, decoded by lz4 1.10.0 itself compiled to WebAssembly
 * (`io/wasm-codecs.js`): the numcodecs `LZ4` framing (a 4-byte
 * little-endian decoded size, then one LZ4 block) and block framings that
 * hold several (hdf5plugin's LZ4 filter, `hdf5/filters.js`).
 *
 * Each block must fill the bytes its framing gives it exactly; the decoder
 * reads and writes nothing outside the block and its output, so a malformed
 * block is refused, never read or written out of bounds. Where the decode
 * pool measured the JavaScript decoder faster (`io/decoder-choice.js`,
 * family `lz4`), that one decodes (`javascript/lz4.js`).
 *
 * @module formats/zarr/codecs/lz4
 */

import { ZarrFormatError } from '../errors.js';
import { WasmCodecError, wasmCodecs } from '../../io/wasm-codecs.js';
import { decoderFor } from '../../io/decoder-choice.js';
import { lz4DecodeBlockInto, numcodecsLz4Decode as numcodecsLz4InJavaScript } from './javascript/lz4.js';
import { formatCountOf } from '../../../utils/format-units.js';

function corrupt(detail) {
  return new ZarrFormatError(`LZ4 data is corrupt: ${detail}.`);
}

/** The codec error of an LZ4 decode, as the Zarr error it is. */
function asFormatError(error) {
  if (!(error instanceof WasmCodecError)) return error;
  return corrupt(`a block does not decode to its size (${error.code})`);
}

/**
 * Blocks of one buffer into one output of `total` bytes: each segment
 * `{at, stored, start, size}` is `input[at, at + stored)`, an LZ4 block
 * that fills `output[start, start + size)` exactly, or those bytes as they
 * are when `stored === size`.
 *
 * @param {Uint8Array} input
 * @param {Array<{at: number, stored: number, start: number, size: number}>} segments
 * @param {number} total
 * @param {Object<string, string>|null} [choices] - The decoders a decode task names
 * @returns {Promise<Uint8Array>}
 */
export async function lz4DecodeBlocks(input, segments, total, choices = null) {
  if (decoderFor('lz4', total, choices) === 'js') {
    const output = new Uint8Array(total);
    for (const { at, stored, start, size } of segments) {
      if (at < 0 || stored < 0 || at + stored > input.length || start < 0 || size < 0 || start + size > total) {
        throw corrupt('a block does not decode to its size (a block lies outside its buffers)');
      }
      if (stored === size) output.set(input.subarray(at, at + stored), start);
      else lz4DecodeBlockInto(input.subarray(at, at + stored), output, start, start + size);
    }
    return output;
  }
  const codecs = await wasmCodecs();
  try {
    return codecs.lz4Blocks(input, segments, total);
  } catch (error) {
    throw asFormatError(error);
  }
}

/**
 * Decode numcodecs' LZ4 framing: a little-endian 32-bit decoded size, then
 * one LZ4 block.
 *
 * @param {Uint8Array} input
 * @param {number|null} expectedSize
 * @param {Object<string, string>|null} [choices] - The decoders a decode task names
 * @returns {Promise<Uint8Array>}
 */
export async function numcodecsLz4Decode(input, expectedSize, choices = null) {
  if (input.length < 4) throw corrupt('the size header is truncated');
  const size = (input[0] | (input[1] << 8) | (input[2] << 16) | (input[3] << 24)) >>> 0;
  if (expectedSize !== null && size !== expectedSize) {
    throw corrupt(`it declares ${formatCountOf(size, 'byte')}, not the ${expectedSize} expected`);
  }
  // LZ4 expands at most 255:1 (a 255-byte length extension per byte).
  if (size > (input.length - 4) * 255 + 16) throw corrupt(`it declares more bytes than LZ4 can encode in ${input.length}`);
  if (size === 0) return new Uint8Array(0);
  if (decoderFor('lz4', size, choices) === 'js') return numcodecsLz4InJavaScript(input, expectedSize);
  const codecs = await wasmCodecs();
  try {
    return codecs.lz4Block(input.subarray(4), size);
  } catch (error) {
    throw asFormatError(error);
  }
}
