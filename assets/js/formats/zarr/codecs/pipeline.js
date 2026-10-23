/**
 * Codec pipelines: how a stored chunk becomes decoded bytes.
 *
 * Zarr v2 describes a chunk with a `compressor` and `filters`; Zarr v3 with a
 * list of `codecs` (array-to-array, then one array-to-bytes, then
 * bytes-to-bytes). Both are read into one `Pipeline`:
 *
 * - `decoders`: bytes-to-bytes steps in decode order (decompression, CRC-32C
 *   check, byte shuffle);
 * - `serializer`: how the decoded bytes hold elements, `bytes` (fixed-size
 *   elements in the type's byte order) or `vlen` (variable-length strings);
 * - `permutation`: the axis order the elements are stored in (a Zarr v2
 *   Fortran-order chunk, or Zarr v3 `transpose` codecs), or null for C order;
 * - `sharding`: for a Zarr v3 `sharding_indexed` array, the inner chunk shape,
 *   the inner pipeline and how the shard index is stored.
 *
 * Each decoder carries the codec it was built from (`{id, configuration}`),
 * so a chunk can be decoded on a decode worker (io/decode-pool.js), which
 * rebuilds the decoders from that list (`decodeWithCodecs`); its errors come
 * back as the same Zarr errors (`reviveZarrError`).
 *
 * A codec this reader cannot decode does not stop the store from opening:
 * the pipeline records why (`unsupported`), and reading that array fails
 * with a `ZarrUnsupportedError` naming the codec.
 *
 * @module formats/zarr/codecs/pipeline
 */

import { inflate } from '../../io/inflate.js';
import { genericError } from '../../io/decode-pool.js';
import { byteUnshuffle } from '../../io/shuffle.js';
import { ZarrFormatError, ZarrUnsupportedError } from '../errors.js';
import { hasByteOrder, vlenType, withByteOrder } from '../dtypes.js';
import { bloscDecode } from './blosc.js';
import { crc32cDecode } from './crc32c.js';
import { numcodecsLz4Decode } from './lz4.js';
import { zstdDecompress } from './zstd.js';

/**
 * @typedef {Object} BytesDecoder
 * @property {string} name
 * @property {(bytes: Uint8Array, expectedSize: number|null) => (Uint8Array|Promise<Uint8Array>)} decode
 * @property {boolean} allocates - Whether the output is a new buffer (not a view of the input)
 * @property {(outputSize: number|null) => (number|null)} inputSize - Encoded size for a decoded size, when fixed
 */

/**
 * @typedef {Object} Pipeline
 * @property {BytesDecoder[]} decoders
 * @property {{kind: 'bytes'}|{kind: 'vlen'}} serializer
 * @property {number[]|null} permutation
 * @property {import('../dtypes.js').StoredType} type
 * @property {Object|null} sharding
 * @property {ZarrUnsupportedError|null} unsupported
 */

const unknownSize = () => null;
const sameSize = size => size;

function inflateDecoder(name, format) {
  return {
    name,
    allocates: true,
    inputSize: unknownSize,
    async decode(bytes, expectedSize) {
      try {
        return await inflate(bytes, { format, expectedSize, label: `A ${name} chunk` });
      } catch (cause) {
        if (cause?.name === 'InflateError') throw new ZarrFormatError(cause.message, { cause });
        throw cause;
      }
    },
  };
}

/** numcodecs `Shuffle`: bytes of each element gathered by position. */
function shuffleDecoder(elementSize) {
  if (!Number.isSafeInteger(elementSize) || elementSize < 1) {
    throw new ZarrFormatError('A shuffle codec needs a positive element size.');
  }
  return {
    name: 'shuffle',
    allocates: true,
    inputSize: sameSize,
    decode: bytes => byteUnshuffle(bytes, elementSize),
  };
}

const CRC32C = {
  name: 'crc32c',
  allocates: false,
  inputSize: size => (size === null ? null : size + 4),
  decode: bytes => crc32cDecode(bytes),
};

/** numcodecs `BitRound` only rounds when encoding; decoding is the identity. */
const IDENTITY = { name: 'bitround', allocates: false, inputSize: sameSize, decode: bytes => bytes };

class Unsupported extends Error {
  constructor(feature, message) {
    super(message);
    this.error = new ZarrUnsupportedError(feature, message);
  }
}

function unsupportedCodec(name, what) {
  return new Unsupported(`codec ${name}`, `${what} is compressed or encoded with '${name}', which this reader cannot decode.`);
}

/**
 * A bytes-to-bytes decoder for a numcodecs id (Zarr v2 compressor or filter,
 * or a `numcodecs.*` Zarr v3 codec), or null when the id is not one. The
 * decoder carries `codec` (`{id, configuration}`): what rebuilds it in a
 * decode worker.
 */
function numcodecsDecoder(id, configuration, what) {
  const decoder = numcodecsDecoderOf(id, configuration, what);
  return decoder === null ? null : { ...decoder, codec: { id, configuration: plainConfiguration(id, configuration) } };
}

/** The part of a codec's configuration its decoder reads (the rest may not be serialisable). */
function plainConfiguration(id, configuration) {
  return id === 'shuffle' ? { elementsize: configuration?.elementsize ?? 4 } : {};
}

function numcodecsDecoderOf(id, configuration, what) {
  switch (id) {
    case 'gzip':
      return inflateDecoder('gzip', 'gzip');
    case 'zlib':
      return inflateDecoder('zlib', 'deflate');
    case 'blosc':
      return { name: 'blosc', allocates: true, inputSize: unknownSize, decode: bloscDecode };
    case 'zstd':
      return { name: 'zstd', allocates: true, inputSize: unknownSize, decode: zstdDecompress };
    case 'lz4':
      return { name: 'lz4', allocates: true, inputSize: unknownSize, decode: numcodecsLz4Decode };
    case 'crc32c':
      return CRC32C;
    case 'shuffle':
      return shuffleDecoder(configuration?.elementsize ?? 4);
    case 'bitround':
      return IDENTITY;
    case 'bz2':
    case 'lzma':
    case 'lzf':
    case 'snappy':
    case 'zfpy':
    case 'pcodec':
      throw unsupportedCodec(id, what);
    default:
      return null;
  }
}

function emptyPipeline(type) {
  return { decoders: [], serializer: { kind: 'bytes' }, permutation: null, type, sharding: null, unsupported: null };
}

/**
 * The pipeline of a Zarr v2 array.
 *
 * @param {Object} meta - `.zarray`
 * @param {import('../dtypes.js').StoredType} type
 * @param {number} rank
 * @param {string} what
 * @returns {Pipeline}
 */
export function v2Pipeline(meta, type, rank, what) {
  const pipeline = emptyPipeline(type);
  if (meta.order === 'F' && rank > 1) pipeline.permutation = Array.from({ length: rank }, (_, axis) => rank - 1 - axis);
  try {
    const compressor = meta.compressor;
    if (compressor !== null && compressor !== undefined) {
      if (typeof compressor !== 'object' || typeof compressor.id !== 'string') {
        throw new ZarrFormatError(`${what}: the compressor must be null or an object with an id.`);
      }
      const decoder = numcodecsDecoder(compressor.id, compressor, what);
      if (decoder === null) throw unsupportedCodec(compressor.id, what);
      pipeline.decoders.push(decoder);
    }
    const filters = meta.filters ?? [];
    if (!Array.isArray(filters)) throw new ZarrFormatError(`${what}: filters must be null or a list.`);
    // Filters were applied first when writing, so they are undone last.
    for (let i = filters.length - 1; i >= 0; i--) {
      const id = filters[i]?.id;
      if (typeof id !== 'string') throw new ZarrFormatError(`${what}: a filter has no id.`);
      if (id === 'vlen-utf8' || id === 'vlen-bytes') {
        if (i !== 0) throw new ZarrUnsupportedError('filter after vlen', `${what} applies filters after its string codec, which this reader does not read.`);
        if (type.form !== 'vlen') throw new ZarrFormatError(`${what}: the '${id}' filter needs an object dtype (|O).`);
        pipeline.serializer = { kind: 'vlen' };
        pipeline.type = vlenType(id === 'vlen-utf8' ? 'utf-8' : 'bytes');
        continue;
      }
      if (id === 'vlen-array' || id === 'json2' || id === 'msgpack2' || id === 'pickle' || id === 'categorize') {
        throw unsupportedCodec(id, what);
      }
      const decoder = numcodecsDecoder(id, filters[i], what);
      if (decoder === null || decoder.inputSize !== sameSize) throw unsupportedCodec(id, what);
      pipeline.decoders.push(decoder);
    }
    if (type.form === 'vlen' && pipeline.serializer.kind !== 'vlen') {
      throw new ZarrFormatError(`${what} stores Python objects (|O) without a string codec (vlen-utf8 or vlen-bytes).`);
    }
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    pipeline.unsupported = error.error;
  }
  if (type.unsupported) pipeline.unsupported = type.unsupported;
  return pipeline;
}

function codecName(codec, what) {
  if (typeof codec === 'string') return { name: codec, configuration: {} };
  if (codec === null || typeof codec !== 'object' || typeof codec.name !== 'string') {
    throw new ZarrFormatError(`${what}: a codec must be an object with a name.`);
  }
  return { name: codec.name, configuration: codec.configuration ?? {} };
}

function transposeOrder(configuration, rank, what) {
  let order = configuration.order;
  if (order === 'C') return null;
  if (order === 'F') order = Array.from({ length: rank }, (_, axis) => rank - 1 - axis);
  if (!Array.isArray(order) || order.length !== rank ||
      [...order].sort((a, b) => a - b).some((axis, index) => axis !== index)) {
    throw new ZarrFormatError(`${what}: a transpose order must list every axis once.`);
  }
  return order;
}

/**
 * The pipeline of a Zarr v3 codec list.
 *
 * @param {unknown} codecs
 * @param {import('../dtypes.js').StoredType} type - Without byte order
 * @param {number} rank
 * @param {string} what
 * @param {{inner?: boolean}} [options]
 * @returns {Pipeline}
 */
export function v3Pipeline(codecs, type, rank, what, { inner = false } = {}) {
  if (!Array.isArray(codecs) || codecs.length === 0) throw new ZarrFormatError(`${what}: codecs must be a non-empty list.`);
  const pipeline = emptyPipeline(type);
  let serializerSeen = false;
  const encoders = [];
  try {
    for (const entry of codecs) {
      const { name, configuration } = codecName(entry, what);
      if (!serializerSeen) {
        if (name === 'transpose') {
          const order = transposeOrder(configuration, rank, what);
          if (order !== null) {
            // Transposes compose: storage axis k is array axis permutation[k].
            const previous = pipeline.permutation;
            pipeline.permutation = previous === null ? order : order.map(axis => previous[axis]);
          }
          continue;
        }
        if (name === 'bytes' || name === 'endian') {
          const endian = configuration.endian;
          if (endian !== undefined && endian !== 'little' && endian !== 'big') {
            throw new ZarrFormatError(`${what}: the bytes codec endian must be 'little' or 'big'.`);
          }
          if (endian === undefined && hasByteOrder(type)) {
            throw new ZarrFormatError(`${what}: the bytes codec needs an endian for multi-byte elements.`);
          }
          if (type.form === 'vlen') throw new ZarrFormatError(`${what}: variable-length strings need a vlen codec, not bytes.`);
          pipeline.type = withByteOrder(type, endian !== 'big');
          serializerSeen = true;
          continue;
        }
        if (name === 'vlen-utf8' || name === 'vlen-bytes') {
          if (type.form !== 'vlen') throw new ZarrFormatError(`${what}: '${name}' needs a variable-length data type.`);
          pipeline.serializer = { kind: 'vlen' };
          serializerSeen = true;
          continue;
        }
        if (name === 'sharding_indexed') {
          if (inner) throw new Unsupported('nested sharding', `${what} shards inside shards, which this reader does not read.`);
          pipeline.sharding = configuration;
          serializerSeen = true;
          continue;
        }
        if (name.startsWith('numcodecs.')) throw unsupportedCodec(name, what);
        throw unsupportedCodec(name, what);
      }
      let decoder = null;
      if (name === 'gzip' || name === 'zstd' || name === 'blosc' || name === 'crc32c') {
        decoder = numcodecsDecoder(name, configuration, what);
      } else if (name.startsWith('numcodecs.')) {
        decoder = numcodecsDecoder(name.slice('numcodecs.'.length), configuration, what);
      }
      if (decoder === null) throw unsupportedCodec(name, what);
      encoders.push(decoder);
    }
    if (!serializerSeen) throw new ZarrFormatError(`${what}: the codecs have no array-to-bytes codec (such as bytes).`);
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    pipeline.unsupported = error.error;
  }
  pipeline.decoders = encoders.reverse();
  if (type.unsupported) pipeline.unsupported = type.unsupported;
  return pipeline;
}

/**
 * Whether a pipeline's chunks are worth decoding on a decode worker: some
 * decoder decompresses or rearranges bytes (a checksum alone is not).
 *
 * @param {Pipeline} pipeline
 */
export function decodesOffThread(pipeline) {
  return pipeline.decoders.some(decoder => decoder.allocates);
}

/** The codec descriptions of a pipeline's decoders, in decode order (serialisable). */
export function codecsOf(pipeline) {
  return pipeline.decoders.map(decoder => decoder.codec);
}

/** Decoders rebuilt from codec descriptions, by description. */
const rebuilt = new Map();

/**
 * Run the decoders a codec list describes (in decode order) over `input`:
 * what a decode worker does with a Zarr chunk.
 *
 * @param {Uint8Array} input
 * @param {Array<{id: string, configuration: Object}>} codecs
 * @param {Array<number|null>} sizes - What each decoder must produce
 * @returns {Promise<Uint8Array>}
 */
export async function decodeWithCodecs(input, codecs, sizes) {
  const key = JSON.stringify(codecs);
  let decoders = rebuilt.get(key);
  if (decoders === undefined) {
    decoders = codecs.map(({ id, configuration }) => {
      const decoder = numcodecsDecoder(id, configuration, 'A chunk');
      if (decoder === null) throw new ZarrUnsupportedError(`codec ${id}`, `A chunk is compressed or encoded with '${id}', which this reader cannot decode.`);
      return decoder;
    });
    rebuilt.set(key, decoders);
  }
  let bytes = input;
  for (let i = 0; i < decoders.length; i++) bytes = await decoders[i].decode(bytes, sizes[i]);
  return bytes;
}

/**
 * A worker's error data as the error it was: Zarr errors keep their class,
 * feature and message.
 *
 * @param {{name: string, message: string, feature?: string}} data
 * @returns {Error}
 */
export function reviveZarrError(data) {
  if (data.name === 'ZarrFormatError') return new ZarrFormatError(data.message);
  if (data.name === 'ZarrUnsupportedError') return new ZarrUnsupportedError(data.feature, data.message);
  return genericError(data);
}

/**
 * The size each decoder must produce, given the decoded size the serializer
 * needs (null where the codecs do not fix it).
 *
 * @param {BytesDecoder[]} decoders
 * @param {number|null} decodedSize
 * @returns {Array<number|null>}
 */
export function expectedSizes(decoders, decodedSize) {
  const sizes = new Array(decoders.length);
  let size = decodedSize;
  for (let i = decoders.length - 1; i >= 0; i--) {
    sizes[i] = size;
    size = decoders[i].inputSize(size);
  }
  return sizes;
}
