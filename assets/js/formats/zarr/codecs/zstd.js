/**
 * Zstandard decompression (RFC 8878), the default codec of Zarr v3 as
 * zarr-python 3 writes it, one of numcodecs' codecs and hdf5plugin's
 * Zstandard filter: decoded by zstd 1.5.6 itself, compiled to WebAssembly
 * (`io/wasm-codecs.js`).
 *
 * The input is one or more frames (skippable frames skipped). The output is
 * exactly the size the array declares when it declares one, and the decoder
 * writes no byte past it; when it does not (variable-length strings, a
 * filter undone after this one), at most what the frames state, or `bound`.
 * A frame's content checksum, when written, is verified. Frames that need a
 * dictionary are refused: Zarr never writes one. Where the decode pool
 * measured the JavaScript decoder faster (`io/decoder-choice.js`, family
 * `zstd`), that one decodes (`javascript/zstd.js`).
 *
 * @module formats/zarr/codecs/zstd
 */

import { ZarrFormatError, ZarrUnsupportedError } from '../errors.js';
import { WasmCodecError, wasmCodecs } from '../../io/wasm-codecs.js';
import { decoderFor } from '../../io/decoder-choice.js';
import { zstdDecompress as zstdInJavaScript } from './javascript/zstd.js';
import { formatCountOf } from '../../../utils/format-units.js';

const FRAME_MAGIC = 0xfd2fb528;
const SKIPPABLE_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;
/** zstd's `ZSTD_error_dictionary_wrong`: the frame names a dictionary. */
const DICTIONARY_WRONG = 'a wrong dictionary';

function corrupt(detail) {
  return new ZarrFormatError(`Zstandard data is corrupt: ${detail}.`);
}

function startsWithFrame(input) {
  if (input.length < 4) return false;
  const magic = (input[0] | (input[1] << 8) | (input[2] << 16) | (input[3] << 24)) >>> 0;
  return magic === FRAME_MAGIC || ((magic & SKIPPABLE_MASK) >>> 0) === SKIPPABLE_MAGIC;
}

function lowered(message) {
  return message.charAt(0).toLowerCase() + message.slice(1).replace(/\.$/, '');
}

/**
 * Decompress every Zstandard frame of `input`.
 *
 * @param {Uint8Array} input
 * @param {number|null} [expectedSize] - The exact decompressed size, when known
 * @param {{bound?: number|null, choices?: Object<string, string>|null}} [options] - `bound`: the most it may
 *   decompress to, when the size is not known; `choices`: the decoders a decode task names
 * @returns {Promise<Uint8Array>}
 */
export async function zstdDecompress(input, expectedSize = null, { bound = null, choices = null } = {}) {
  if (!startsWithFrame(input)) throw corrupt('it does not start with a Zstandard frame');
  if (decoderFor('zstd', expectedSize, choices) === 'js') {
    const output = zstdInJavaScript(input, expectedSize);
    if (bound !== null && output.length > bound) throw corrupt(`it decodes to more than the ${formatCountOf(bound, 'byte')} it may hold`);
    return output;
  }
  const codecs = await wasmCodecs();
  try {
    return codecs.zstd(input, expectedSize, bound);
  } catch (error) {
    if (!(error instanceof WasmCodecError)) throw error;
    if (error.code === DICTIONARY_WRONG) {
      throw new ZarrUnsupportedError('Zstandard dictionary', 'This Zstandard data was compressed with a dictionary, which Zarr never uses and this reader does not read.');
    }
    throw corrupt(lowered(error.message));
  }
}
