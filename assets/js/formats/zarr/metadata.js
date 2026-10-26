/**
 * Array metadata: a Zarr v2 `.zarray` or a Zarr v3 array `zarr.json`, read
 * into one description of how the array is stored.
 *
 * - `shape`, and `chunkShape`: the grid reads are made on (for a sharded
 *   array, the inner chunks; `sharding` then describes the shards);
 * - `type` (`dtypes.js`), `fill` (`{value, raw}`; `value` null for a Zarr v2
 *   array whose fill is undefined);
 * - `pipeline` (`codecs/pipeline.js`) decoding one read-grid chunk;
 * - `chunkKey(coords)`: the store key of a chunk (v2 `0.1` or `0/1`; v3
 *   `c/0/1`, or v2-style keys when `chunk_key_encoding` says so).
 *
 * Malformed metadata is a `ZarrFormatError`; a valid array this reader cannot
 * decode keeps an `unsupported` error that its reads raise.
 *
 * @module formats/zarr/metadata
 */

import { ZarrFormatError, ZarrUnsupportedError } from './errors.js';
import { decodeFill, parseV2Dtype, parseV3DataType } from './dtypes.js';
import { v2Pipeline, v3Pipeline } from './codecs/pipeline.js';

function shapeOf(value, what, label, positive) {
  if (!Array.isArray(value) || !value.every(extent => Number.isSafeInteger(extent) && extent >= (positive ? 1 : 0))) {
    throw new ZarrFormatError(`${what}: ${label} must list ${positive ? 'positive' : 'non-negative'} whole numbers.`);
  }
  let product = 1;
  for (const extent of value) {
    product *= extent;
    if (!Number.isSafeInteger(product)) throw new ZarrFormatError(`${what}: ${label} holds more elements than can be addressed.`);
  }
  return Object.freeze(value.slice());
}

function keyPrefix(path) {
  const relative = path.replace(/^\/+/, '');
  return relative === '' ? '' : `${relative}/`;
}

/**
 * @param {Object} json - Parsed `.zarray`
 * @param {string} path - Absolute node path
 * @param {string} what - For messages
 */
export function parseV2Array(json, path, what) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new ZarrFormatError(`${what}: .zarray is not a JSON object.`);
  if (json.zarr_format !== 2) throw new ZarrFormatError(`${what}: .zarray must declare "zarr_format": 2.`);
  for (const field of ['shape', 'chunks', 'dtype', 'fill_value']) {
    if (!Object.hasOwn(json, field)) throw new ZarrFormatError(`${what}: .zarray has no '${field}'.`);
  }
  const shape = shapeOf(json.shape, what, 'shape', false);
  const chunkShape = shapeOf(json.chunks, what, 'chunks', true);
  if (chunkShape.length !== shape.length) throw new ZarrFormatError(`${what}: shape and chunks have different lengths.`);
  const order = json.order ?? 'C';
  if (order !== 'C' && order !== 'F') throw new ZarrFormatError(`${what}: order must be 'C' or 'F'.`);
  const separator = json.dimension_separator ?? '.';
  if (separator !== '.' && separator !== '/') throw new ZarrFormatError(`${what}: dimension_separator must be '.' or '/'.`);
  const pipeline = v2Pipeline(json, parseV2Dtype(json.dtype, what), shape.length, what);
  const type = pipeline.type;
  const fill = decodeFill(json.fill_value, type, 2, what);
  const prefix = keyPrefix(path);
  return {
    version: 2,
    shape,
    chunkShape,
    type,
    fill,
    pipeline,
    sharding: null,
    dimensionNames: null,
    unsupported: pipeline.unsupported,
    chunkKey: coords => prefix + (coords.length === 0 ? '0' : coords.join(separator)),
  };
}

const V3_ARRAY_FIELDS = new Set([
  'zarr_format', 'node_type', 'shape', 'data_type', 'chunk_grid', 'chunk_key_encoding',
  'fill_value', 'codecs', 'attributes', 'storage_transformers', 'dimension_names',
]);

function v3KeyEncoding(encoding, what) {
  const name = typeof encoding === 'string' ? encoding : encoding?.name;
  const separator = (typeof encoding === 'object' ? encoding?.configuration?.separator : undefined) ?? (name === 'v2' ? '.' : '/');
  if (separator !== '.' && separator !== '/') throw new ZarrFormatError(`${what}: the chunk key separator must be '.' or '/'.`);
  if (name === 'default') return coords => ['c', ...coords].join(separator);
  if (name === 'v2') return coords => (coords.length === 0 ? '0' : coords.join(separator));
  throw new ZarrFormatError(`${what}: unknown chunk_key_encoding '${name}'.`);
}

/**
 * @param {Object} json - Parsed array `zarr.json`
 * @param {string} path
 * @param {string} what
 */
export function parseV3Array(json, path, what) {
  for (const field of ['shape', 'data_type', 'chunk_grid', 'chunk_key_encoding', 'fill_value', 'codecs']) {
    if (!Object.hasOwn(json, field)) throw new ZarrFormatError(`${what}: zarr.json has no '${field}'.`);
  }
  const shape = shapeOf(json.shape, what, 'shape', false);
  let unsupported = null;
  for (const [field, value] of Object.entries(json)) {
    if (V3_ARRAY_FIELDS.has(field)) continue;
    if (value !== null && typeof value === 'object' && value.must_understand === false) continue;
    unsupported ??= new ZarrUnsupportedError(`extension ${field}`, `${what} uses the Zarr extension '${field}', which this reader does not understand.`);
  }
  if (Array.isArray(json.storage_transformers) && json.storage_transformers.length > 0) {
    unsupported ??= new ZarrUnsupportedError('storage transformer', `${what} uses a storage transformer, which this reader does not read.`);
  }
  const grid = json.chunk_grid;
  if (grid?.name !== 'regular') {
    unsupported ??= new ZarrUnsupportedError(`chunk grid ${grid?.name}`, `${what} uses the '${grid?.name}' chunk grid; this reader reads regular chunk grids.`);
  }
  const outer = grid?.name === 'regular' ? shapeOf(grid.configuration?.chunk_shape, what, 'chunk_shape', true) : shape.map(extent => Math.max(1, extent));
  if (outer.length !== shape.length) throw new ZarrFormatError(`${what}: shape and chunk_shape have different lengths.`);
  const keyOf = v3KeyEncoding(json.chunk_key_encoding, what);
  const prefix = keyPrefix(path);
  const baseType = parseV3DataType(json.data_type, what);
  const pipeline = v3Pipeline(json.codecs, baseType, shape.length, what);
  unsupported ??= pipeline.unsupported;

  let chunkShape = outer;
  let readPipeline = pipeline;
  let sharding = null;
  if (pipeline.sharding !== null && !pipeline.unsupported) {
    const config = pipeline.sharding;
    const inner = shapeOf(config.chunk_shape, what, 'the inner chunk_shape', true);
    if (inner.length !== shape.length || inner.some((extent, axis) => outer[axis] % extent !== 0)) {
      throw new ZarrFormatError(`${what}: the inner chunk shape must divide the shard shape.`);
    }
    readPipeline = v3Pipeline(config.codecs, baseType, shape.length, what, { inner: true });
    const chunksPerShard = Object.freeze(outer.map((extent, axis) => extent / inner[axis]));
    const innerCount = chunksPerShard.reduce((a, b) => a * b, 1);
    const indexPipeline = v3Pipeline(config.index_codecs ?? [{ name: 'bytes', configuration: { endian: 'little' } }, { name: 'crc32c' }],
      parseV3DataType('uint64', what), shape.length + 1, `${what} (shard index)`);
    let indexBytes = innerCount * 16;
    for (let i = indexPipeline.decoders.length - 1; i >= 0 && indexBytes !== null; i--) indexBytes = indexPipeline.decoders[i].inputSize(indexBytes);
    const location = config.index_location ?? 'end';
    if (location !== 'start' && location !== 'end') throw new ZarrFormatError(`${what}: index_location must be 'start' or 'end'.`);
    if (indexBytes === null) {
      unsupported ??= new ZarrUnsupportedError('compressed shard index', `${what} compresses its shard indexes, which this reader does not read.`);
    }
    unsupported ??= readPipeline.unsupported ?? indexPipeline.unsupported;
    chunkShape = inner;
    sharding = {
      shardShape: outer,
      chunksPerShard,
      innerCount,
      indexPipeline,
      indexBytes,
      location,
      shardKey: coords => prefix + keyOf(coords),
    };
  }
  const type = readPipeline.type;
  const fill = decodeFill(json.fill_value, type, 3, what);
  return {
    version: 3,
    shape,
    chunkShape,
    type,
    fill,
    pipeline: readPipeline,
    sharding,
    dimensionNames: Array.isArray(json.dimension_names) ? Object.freeze(json.dimension_names.slice()) : null,
    unsupported,
    chunkKey: coords => prefix + keyOf(coords),
  };
}
