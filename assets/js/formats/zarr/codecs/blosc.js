/**
 * Blosc (version 1 frames, as numcodecs, Zarr's `blosc` codec and
 * hdf5plugin's Blosc filter write them), decoded by c-blosc 1.21.6 itself
 * compiled to WebAssembly (`io/wasm-codecs.js`), with the codecs it carries:
 * blosclz, LZ4 (lz4 1.10.0) and Zstandard (zstd 1.5.6), and its byte shuffle
 * and bit shuffle. A frame's zlib streams are inflated by the page's DEFLATE
 * decoder (`io/inflate.js`: the platform's stream or fflate, whichever the
 * decode pool measured faster, `io/decoder-choice.js`), each into its place,
 * all of a frame's at once, while c-blosc still reads the frame
 * (`io/wasm-codecs.js` `bloscZlib`, `codecs.c`).
 *
 * A frame is a 16-byte header (format version, codec version, flags, element
 * size, decoded size, block size, frame size), then, unless the frame is a
 * plain copy, one start offset per block. The header is checked here first,
 * so a frame this reader does not read is refused with its reason:
 *
 * - Blosc2 chunks (format version 3 and later), which numcodecs' Blosc never
 *   writes; the snappy codec; a codec stream format c-blosc 1 does not read.
 * - A frame whose sizes contradict it, or whose decoded size is not the one
 *   the array declares.
 *
 * Where the decode pool measured the JavaScript decoder faster
 * (`io/decoder-choice.js`, family `blosc`), a frame of other streams is
 * decoded by it (`javascript/blosc.js`).
 *
 * Read as c-blosc 1 reads its own frames, plus what it does not: a format
 * version 1 frame (laid out alike) and c-blosc2's delta flag (`0x08`), whose
 * delta is undone after the blocks are decoded (`codecs.c`).
 *
 * @module formats/zarr/codecs/blosc
 */

import { ZarrFormatError, ZarrUnsupportedError } from '../errors.js';
import { WasmCodecError, wasmCodecs } from '../../io/wasm-codecs.js';
import { inflate } from '../../io/inflate.js';
import { decoderFor } from '../../io/decoder-choice.js';
import { bloscDecode as bloscInJavaScript } from './javascript/blosc.js';
import { formatCountOf } from '../../../utils/format-units.js';

const HEADER_BYTES = 16;
const MEMCPYED = 0x02;
/** LZ4 expands at most 255:1: the bound on a frame's declared size when the array declares none. */
const LZ4_MAX_EXPANSION = 255;

const CODEC_NAMES = ['blosclz', 'lz4', 'snappy', 'zlib', 'zstd'];
const ZLIB = 3;
/** The codecs whose stream format c-blosc 1 checks (`*_VERSION_FORMAT`, all 1). */
const VERSIONED_CODECS = new Set([0, 1, 2]);

function corrupt(detail) {
  return new ZarrFormatError(`Blosc data is corrupt: ${detail}.`);
}

/**
 * The codec family a Blosc frame's decoder is chosen for: `'deflate'` when
 * its streams are zlib (they are inflated by the DEFLATE decoder), else
 * `'blosc'`.
 *
 * @param {Uint8Array} frame - At least its header
 * @returns {'deflate'|'blosc'}
 */
export function bloscFamily(frame) {
  return frame.length >= HEADER_BYTES && (frame[2] & MEMCPYED) === 0 && frame[2] >>> 5 === ZLIB ? 'deflate' : 'blosc';
}

/**
 * Decode one Blosc frame.
 *
 * @param {Uint8Array} input
 * @param {number|null} expectedSize - The decoded size the array declares
 * @param {Object<string, string>|null} [choices] - The decoders a decode task names (`io/decoder-choice.js`): a
 *   zlib frame's streams are inflated with the one chosen for DEFLATE at the frame's decoded size
 * @returns {Promise<Uint8Array>}
 */
export async function bloscDecode(input, expectedSize, choices = null) {
  if (input.length < HEADER_BYTES) throw corrupt('the header is truncated');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const version = input[0];
  const codecVersion = input[1];
  const flags = input[2];
  const nbytes = view.getUint32(4, true);
  const cbytes = view.getUint32(12, true);
  if (version < 1 || version > 2) {
    throw new ZarrUnsupportedError(`Blosc format version ${version}`, `This array uses Blosc format version ${version}; this reader reads Blosc 1 frames (versions 1 and 2), as numcodecs writes them.`);
  }
  if (cbytes !== input.length) throw corrupt(`the frame declares ${formatCountOf(cbytes, 'byte')} and holds ${input.length}`);
  if (expectedSize !== null && nbytes !== expectedSize) {
    throw corrupt(`the frame decodes to ${formatCountOf(nbytes, 'byte')}, not the ${expectedSize} expected`);
  }
  if (expectedSize === null && nbytes > input.length * LZ4_MAX_EXPANSION + 64) {
    throw corrupt(`the frame declares more bytes than its codecs can encode in ${input.length}`);
  }
  if (input[3] === 0) throw corrupt('the element size is zero');
  if ((flags & MEMCPYED) === 0) {
    const codec = flags >>> 5;
    if (codec > 4) throw corrupt(`the codec format ${codec} is unknown`);
    if (codec === 2) {
      throw new ZarrUnsupportedError('Blosc snappy', 'This array is compressed with Blosc using snappy, which this reader cannot decompress.');
    }
    if (codecVersion !== 1 && VERSIONED_CODECS.has(codec)) {
      throw new ZarrUnsupportedError(`Blosc ${CODEC_NAMES[codec]} format ${codecVersion}`, `This array uses Blosc ${CODEC_NAMES[codec]} stream format ${codecVersion}, which this reader does not read.`);
    }
  }
  if (nbytes === 0) return new Uint8Array(0);
  const codecs = await wasmCodecs();
  try {
    if ((flags & MEMCPYED) === 0 && flags >>> 5 === ZLIB) {
      const decoder = decoderFor('deflate', nbytes, choices);
      return await codecs.bloscZlib(input, nbytes, (stream, into) => (
        inflate(stream, { format: 'deflate', expectedSize: into.length, label: 'A Blosc zlib stream', decoder, into })
      ));
    }
    if (decoderFor('blosc', nbytes, choices) === 'js') return await bloscInJavaScript(input, expectedSize);
    return codecs.blosc(input, nbytes);
  } catch (error) {
    if (error?.name === 'InflateError') throw corrupt(error.message.replace(/\.$/, ''));
    if (!(error instanceof WasmCodecError)) throw error;
    throw corrupt(`c-blosc refused it (${error.code})`);
  }
}
