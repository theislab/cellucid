/**
 * Build real AnnData stores in memory, for contract tests of the AnnData
 * reader.
 *
 * A store is described as a plain tree of nodes (`group`, `array` and the
 * AnnData shapes built from them: `annData`, `dataFrame`, `mapping`,
 * `categorical`, `nullable`, `sparse`), written as a Zarr v2 store exactly as
 * described -- `.zgroup`/`.zattrs`/`.zarray` JSON and raw little-endian (or
 * big-endian, `>` dtypes) chunk bytes, uncompressed -- and opened with the
 * Zarr package's own `openZarr(memoryStore(...))`. Descriptions are mutable
 * until written, so a test builds a valid tree and breaks one thing in it.
 *
 * The store counts the chunks it serves (`fetched`), so a test can say which
 * array values a call read, or that it read none.
 */

import { memoryStore, openZarr } from '../../assets/js/formats/zarr/index.js';
import { deflateSync } from 'node:zlib';

import { crc32c } from '../../assets/js/formats/zarr/codecs/crc32c.js';
import { AnnDataReader } from '../../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../../assets/js/data/anndata/elements.js';

const DTYPE = /^([<>|=]?)([biufcOSU])(\d*)$/;
const METADATA_FILES = new Set(['.zgroup', '.zattrs', '.zarray', '.zmetadata']);
const encoder = new TextEncoder();

function parseDtype(dtype) {
  const match = DTYPE.exec(dtype);
  if (match === null) throw new TypeError(`Unknown test dtype '${dtype}'`);
  const [, order, code, digits] = match;
  return { code, size: digits === '' ? null : Number(digits), littleEndian: order !== '>' };
}

function isStringDtype(dtype) {
  return /^[|<>=]?[OSU]/.test(dtype);
}

/**
 * One array node.
 *
 * @param {ArrayLike<any>} values - Row-major values (numbers, BigInts, booleans or strings)
 * @param {{dtype?: string, shape?: number[], chunks?: number[], attrs?: Object|null,
 *   fillValue?: any, vlen?: 'utf-8'|'bytes', writeChunks?: boolean}} [options]
 *   `dtype` is a NumPy type string (`<f4`, `>f8`, `|b1`, `<i8`, `<c8`, `|O`
 *   for variable-length text, `|S8`, `<U4`); `attrs` defaults to the current
 *   AnnData array encoding (`string-array` for text), `null` writes none.
 *   `writeChunks: false` writes the metadata alone (an array whose chunks
 *   were never written reads as its fill value), for arrays too large to
 *   hold whose values a test must never read. `compressed: true` stores
 *   each chunk deflated (Zarr v2 `zlib`), so a chunk is decoded whole, as a
 *   written file's; otherwise a chunk is its values' bytes, read in part
 *   (`partialChunks`), as a served store's.
 */
export function array(values, {
  dtype = '<f4',
  shape = [values.length],
  chunks = null,
  attrs = undefined,
  fillValue = undefined,
  vlen = 'utf-8',
  writeChunks = true,
  compressed = false,
} = {}) {
  return {
    kind: 'array',
    values,
    dtype,
    shape: [...shape],
    chunks: chunks === null ? shape.map(extent => Math.max(1, extent)) : [...chunks],
    attrs: attrs === undefined
      ? { 'encoding-type': isStringDtype(dtype) ? 'string-array' : 'array', 'encoding-version': '0.2.0' }
      : attrs,
    fillValue,
    vlen,
    writeChunks,
    compressed,
  };
}

/** A variable-length UTF-8 string array (as anndata writes text). */
export function strings(values, options = {}) {
  return array(values, { dtype: '|O', ...options });
}

/** A dense numeric array of `shape`. */
export function dense(values, shape, options = {}) {
  return array(values, { shape, ...options });
}

export function group(children = {}, attrs = {}) {
  return { kind: 'group', children: { ...children }, attrs: attrs === null ? null : { ...attrs } };
}

export function annData(children) {
  return group(children, { 'encoding-type': 'anndata', 'encoding-version': '0.1.0' });
}

export function mapping(children = {}) {
  return group(children, { 'encoding-type': 'dict', 'encoding-version': '0.1.0' });
}

/**
 * A dataframe: `columns` holds the index and every column; `columnOrder`
 * defaults to every key but the index, in insertion order.
 */
export function dataFrame(columns, { index = '_index', columnOrder = undefined } = {}) {
  return group(columns, {
    'encoding-type': 'dataframe',
    'encoding-version': '0.2.0',
    _index: index,
    'column-order': columnOrder ?? Object.keys(columns).filter(key => key !== index),
  });
}

/** A dataframe of string index names and the given columns. */
export function stringFrame(names, columns = {}, { index = '_index' } = {}) {
  return dataFrame({ [index]: strings(names), ...columns }, { index, columnOrder: Object.keys(columns) });
}

/** A categorical column; `categories` is a node, or an array of strings. */
export function categorical(codes, categories, { ordered = false, codesDtype = '|i1' } = {}) {
  const attrs = { 'encoding-type': 'categorical', 'encoding-version': '0.2.0' };
  if (ordered !== undefined) attrs.ordered = ordered;
  return group({
    codes: array(codes, { dtype: codesDtype }),
    categories: Array.isArray(categories) ? strings(categories) : categories,
  }, attrs);
}

/** A nullable column (`nullable-integer`, `nullable-boolean`, `nullable-string-array`). */
export function nullable(encoding, values, mask, { valuesDtype = undefined } = {}) {
  const dtype = valuesDtype ?? (
    encoding === 'nullable-string-array' ? '|O' : encoding === 'nullable-boolean' ? '|b1' : '<i8'
  );
  return group({
    values: array(values, { dtype }),
    mask: array(Array.from(mask, Boolean), { dtype: '|b1' }),
  }, { 'encoding-type': encoding, 'encoding-version': '0.1.0' });
}

/** A sparse matrix group (`csr_matrix` / `csc_matrix` 0.1.0). */
export function sparse({
  format = 'csr',
  data = new Float32Array([1]),
  indices = new Int32Array([0]),
  indptr = new Int32Array([0, 1]),
  shape = [1, 1],
  dataDtype = '<f4',
  indicesDtype = '<i4',
  indptrDtype = '<i4',
  chunks = null,
  compressed = false,
} = {}) {
  const part = (values, dtype) => array(values, { dtype, attrs: null, chunks: chunks === null ? null : [chunks], compressed });
  return group({
    data: part(data, dataDtype),
    indices: part(indices, indicesDtype),
    indptr: part(indptr, indptrDtype),
  }, {
    'encoding-type': `${format}_matrix`,
    'encoding-version': '0.1.0',
    shape: [...shape],
  });
}

// ---------------------------------------------------------------------------
// Writing the tree as Zarr v2.
// ---------------------------------------------------------------------------

function elementBytes(dtype) {
  const { code, size } = parseDtype(dtype);
  if (code === 'O') return null;
  if (code === 'U') return size * 4;
  return size;
}

function writeElement(view, offset, value, dtype) {
  const { code, size, littleEndian } = parseDtype(dtype);
  if (code === 'b') {
    view.setUint8(offset, value === true || value === 1 || value === 1n ? 1 : Number(value));
    return;
  }
  if (code === 'S') {
    const bytes = encoder.encode(String(value));
    for (let i = 0; i < size && i < bytes.length; i++) view.setUint8(offset + i, bytes[i]);
    return;
  }
  if (code === 'U') {
    const points = [...String(value)].map(character => character.codePointAt(0));
    for (let i = 0; i < size && i < points.length; i++) view.setUint32(offset + 4 * i, points[i], littleEndian);
    return;
  }
  if (code === 'c') {
    const [real, imaginary] = Array.isArray(value) ? value : [Number(value), 0];
    const half = size / 2;
    const write = half === 4 ? view.setFloat32 : view.setFloat64;
    write.call(view, offset, real, littleEndian);
    write.call(view, offset + half, imaginary, littleEndian);
    return;
  }
  if (code === 'f') {
    if (size === 4) view.setFloat32(offset, Number(value), littleEndian);
    else view.setFloat64(offset, Number(value), littleEndian);
    return;
  }
  const signed = code === 'i';
  if (size === 8) {
    const big = typeof value === 'bigint' ? value : BigInt(value);
    if (signed) view.setBigInt64(offset, big, littleEndian);
    else view.setBigUint64(offset, big, littleEndian);
    return;
  }
  const number = Number(value);
  if (size === 1) (signed ? view.setInt8 : view.setUint8).call(view, offset, number);
  else if (size === 2) (signed ? view.setInt16 : view.setUint16).call(view, offset, number, littleEndian);
  else (signed ? view.setInt32 : view.setUint32).call(view, offset, number, littleEndian);
}

/** Positions (flat, row-major in the array) of one chunk's elements; -1 outside the array. */
function chunkPositions(shape, chunkShape, coords) {
  const total = chunkShape.reduce((product, extent) => product * extent, 1);
  const positions = new Array(total);
  const local = new Array(shape.length).fill(0);
  for (let n = 0; n < total; n++) {
    let flat = 0;
    let inside = true;
    for (let axis = 0; axis < shape.length; axis++) {
      const at = coords[axis] * chunkShape[axis] + local[axis];
      if (at >= shape[axis]) inside = false;
      flat = flat * shape[axis] + at;
    }
    positions[n] = inside ? flat : -1;
    for (let axis = shape.length - 1; axis >= 0; axis--) {
      local[axis]++;
      if (local[axis] < chunkShape[axis]) break;
      local[axis] = 0;
    }
  }
  return positions;
}

function encodeChunk(node, coords) {
  const positions = chunkPositions(node.shape, node.chunks, coords);
  const itemSize = elementBytes(node.dtype);
  if (itemSize === null) {
    const items = positions.map(at => encoder.encode(at < 0 ? '' : String(node.values[at])));
    const length = 4 + items.reduce((sum, item) => sum + 4 + item.length, 0);
    const bytes = new Uint8Array(length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, items.length, true);
    let offset = 4;
    for (const item of items) {
      view.setUint32(offset, item.length, true);
      bytes.set(item, offset + 4);
      offset += 4 + item.length;
    }
    return bytes;
  }
  const bytes = new Uint8Array(positions.length * itemSize);
  const view = new DataView(bytes.buffer);
  positions.forEach((at, n) => {
    if (at >= 0) writeElement(view, n * itemSize, node.values[at], node.dtype);
  });
  return bytes;
}

function json(value) {
  return encoder.encode(JSON.stringify(value));
}

function writeNode(entries, path, node) {
  const prefix = path === '' ? '' : `${path}/`;
  if (node.kind === 'group') {
    entries.set(`${prefix}.zgroup`, json({ zarr_format: 2 }));
    if (node.attrs !== null && Object.keys(node.attrs).length > 0) entries.set(`${prefix}.zattrs`, json(node.attrs));
    for (const [name, child] of Object.entries(node.children)) writeNode(entries, `${prefix}${name}`, child);
    return;
  }
  const { code } = parseDtype(node.dtype);
  const vlen = code === 'O';
  entries.set(`${prefix}.zarray`, json({
    zarr_format: 2,
    shape: node.shape,
    chunks: node.chunks.length === 0 ? [] : node.chunks,
    dtype: node.dtype,
    compressor: node.compressed ? { id: 'zlib', level: 1 } : null,
    fill_value: node.fillValue !== undefined ? node.fillValue : (vlen ? null : code === 'S' || code === 'U' ? '' : code === 'b' ? false : 0),
    order: 'C',
    filters: vlen ? [{ id: node.vlen === 'bytes' ? 'vlen-bytes' : 'vlen-utf8' }] : null,
  }));
  if (node.attrs !== null && Object.keys(node.attrs).length > 0) entries.set(`${prefix}.zattrs`, json(node.attrs));
  const grid = node.shape.map((extent, axis) => Math.ceil(extent / node.chunks[axis]));
  if (!node.writeChunks || grid.some(extent => extent === 0)) return;
  const coords = new Array(grid.length).fill(0);
  const count = grid.reduce((product, extent) => product * extent, 1);
  for (let n = 0; n < count; n++) {
    const key = coords.length === 0 ? '0' : coords.join('.');
    const chunk = encodeChunk(node, coords);
    entries.set(`${prefix}${key}`, node.compressed ? new Uint8Array(deflateSync(chunk, { level: 1 })) : chunk);
    for (let axis = grid.length - 1; axis >= 0; axis--) {
      coords[axis]++;
      if (coords[axis] < grid[axis]) break;
      coords[axis] = 0;
    }
  }
}

/** The store entries (key → bytes) of a described tree. */
export function zarrEntries(root) {
  const entries = new Map();
  writeNode(entries, '', root);
  return entries;
}

/** Zarr v3 data type names of the NumPy-style dtypes a tree uses. */
const V3_DATA_TYPES = {
  f4: 'float32', f8: 'float64', i1: 'int8', i2: 'int16', i4: 'int32', i8: 'int64',
  u1: 'uint8', u2: 'uint16', u4: 'uint32', u8: 'uint64', b1: 'bool', O: 'string',
};

function v3DataType(dtype) {
  const name = V3_DATA_TYPES[dtype.replace(/^[<>|=]/, '')];
  if (name === undefined) throw new Error(`no Zarr v3 data type for ${dtype}`);
  return name;
}

/**
 * The store entries of a described tree as Zarr v3 with every chunked array
 * sharded: each shard holds `factor` of the tree's chunks along the first
 * axis (all of them along the others), stored as their bytes (`bytes`, or
 * `vlen-utf8`), indexed at the end with a CRC-32C (`sharding_indexed`, as
 * zarr-python writes it). Returns the entries and `innerOf(key, offset)`:
 * the inner chunk at `offset` of shard `key`, named as `zarrEntries` names
 * that chunk (`path/0.1`), so a reader's reads compare chunk by chunk.
 */
export function shardedEntries(root, { factor = 4 } = {}) {
  const entries = new Map();
  const inner = new Map();
  const write = (path, node) => {
    const prefix = path === '' ? '' : `${path}/`;
    if (node.kind === 'group') {
      entries.set(`${prefix}zarr.json`, json({ zarr_format: 3, node_type: 'group', attributes: node.attrs ?? {} }));
      for (const [name, child] of Object.entries(node.children)) write(`${prefix}${name}`, child);
      return;
    }
    const { code } = parseDtype(node.dtype);
    const vlen = code === 'O';
    const values = vlen ? [{ name: 'vlen-utf8' }] : [{ name: 'bytes', configuration: { endian: 'little' } }];
    const fill = node.fillValue !== undefined && node.fillValue !== null ? node.fillValue : (vlen ? '' : code === 'b' ? false : 0);
    const meta = { zarr_format: 3, node_type: 'array', shape: node.shape, data_type: v3DataType(node.dtype), fill_value: fill,
      chunk_key_encoding: { name: 'default', configuration: { separator: '/' } }, attributes: node.attrs ?? {} };
    const rank = node.shape.length;
    if (rank === 0) {
      entries.set(`${prefix}zarr.json`, json({ ...meta, chunk_grid: { name: 'regular', configuration: { chunk_shape: [] } }, codecs: values }));
      if (node.writeChunks) entries.set(`${prefix}c`, encodeChunk(node, []));
      return;
    }
    const chunks = node.chunks;
    const grid = node.shape.map((extent, axis) => Math.ceil(extent / chunks[axis]));
    // `factor` chunks along the first axis, every chunk along the others.
    const per = grid.map((extent, axis) => (axis === 0 ? factor : Math.max(1, extent)));
    const shard = chunks.map((extent, axis) => extent * per[axis]);
    entries.set(`${prefix}zarr.json`, json({ ...meta, chunk_grid: { name: 'regular', configuration: { chunk_shape: shard } },
      codecs: [{ name: 'sharding_indexed', configuration: { chunk_shape: chunks, codecs: values,
        index_codecs: [{ name: 'bytes', configuration: { endian: 'little' } }, { name: 'crc32c' }], index_location: 'end' } }] }));
    if (!node.writeChunks || grid.some(extent => extent === 0)) return;
    const count = per.reduce((a, b) => a * b, 1);
    for (let s = 0; s < Math.ceil(grid[0] / factor); s++) {
      const key = `${prefix}c/${[s, ...grid.slice(1).map(() => 0)].join('/')}`;
      const parts = [];
      const index = new DataView(new ArrayBuffer(count * 16));
      let offset = 0;
      const local = new Array(rank).fill(0);
      for (let n = 0; n < count; n++) {
        const coords = local.map((c, axis) => (axis === 0 ? s * factor + c : c));
        if (coords[0] >= grid[0]) {
          index.setBigUint64(n * 16, 0xffffffffffffffffn, true);
          index.setBigUint64(n * 16 + 8, 0xffffffffffffffffn, true);
        } else {
          const bytes = encodeChunk(node, coords);
          index.setBigUint64(n * 16, BigInt(offset), true);
          index.setBigUint64(n * 16 + 8, BigInt(bytes.length), true);
          inner.set(`${key}@${offset}`, `${prefix}${coords.join('.')}`);
          parts.push(bytes);
          offset += bytes.length;
        }
        for (let axis = rank - 1; axis >= 0; axis--) {
          if (++local[axis] < per[axis]) break;
          local[axis] = 0;
        }
      }
      const indexBytes = new Uint8Array(index.buffer);
      const crc = new Uint8Array(4);
      new DataView(crc.buffer).setUint32(0, crc32c(indexBytes), true);
      const file = new Uint8Array(offset + indexBytes.length + 4);
      let at = 0;
      for (const part of parts) {
        file.set(part, at);
        at += part.length;
      }
      file.set(indexBytes, at);
      file.set(crc, at + indexBytes.length);
      entries.set(key, file);
    }
  };
  write('', root);
  return { entries, innerOf: (key, offset) => inner.get(`${key}@${offset}`) ?? null };
}

/**
 * A memory store of `shardedEntries(root)` counting what it serves as
 * `countingStore` does, chunk by chunk: `fetched` lists each inner chunk a
 * ranged read covers (named as `zarrEntries` names it), `indexes` each shard
 * index read.
 */
export function countingShardedStore(root, { name = 'fixture.zarr', factor = 4 } = {}) {
  const { entries, innerOf } = shardedEntries(root, { factor });
  const inner = memoryStore(entries, { name });
  const fetched = [];
  const indexes = [];
  const store = {
    ...inner,
    name,
    async getRanges(key, ranges, options) {
      const result = await inner.getRanges(key, ranges, options);
      if (result === null) return result;
      for (const range of ranges) {
        if (range.suffix !== undefined) {
          indexes.push(key);
          continue;
        }
        const chunk = innerOf(key, range.offset);
        fetched.push(chunk ?? `${key}@${range.offset}`);
      }
      return result;
    },
    async get(key, options) {
      const bytes = await inner.get(key, options);
      if (bytes !== null && !key.endsWith('zarr.json')) fetched.push(key);
      return bytes;
    },
  };
  return { store, fetched, indexes, entries };
}

function isChunkKey(key) {
  return !METADATA_FILES.has(key.slice(key.lastIndexOf('/') + 1));
}

/**
 * A memory store holding the tree, counting the chunks it serves: `fetched`
 * lists every chunk key read, in order (metadata files are not counted), and
 * `reads` every chunk read's bytes (`{key, start, end}`: a whole chunk, or
 * a range of one read in part).
 * `onChunk(key, options)` runs before each chunk is served, with the read's
 * options (its `signal`); it may wait, or throw to fail that read.
 */
export function countingStore(root, { name = 'fixture.zarr', onChunk = null } = {}) {
  const entries = zarrEntries(root);
  const inner = memoryStore(entries, { name });
  const fetched = [];
  const reads = [];
  const note = (key, ranges) => {
    if (!isChunkKey(key)) return;
    fetched.push(key);
    for (const [start, end] of ranges) reads.push({ key, start, end });
  };
  const store = {
    name,
    async get(key, options) {
      if (onChunk !== null && isChunkKey(key)) await onChunk(key, options);
      const bytes = await inner.get(key, options);
      if (bytes !== null) note(key, [[0, bytes.length]]);
      return bytes;
    },
    getMany(keys, options) {
      return Promise.all(keys.map(key => store.get(key, options)));
    },
    async getRanges(key, ranges, options) {
      const result = await inner.getRanges(key, ranges, options);
      if (result !== null) {
        const size = entries.get(key)?.length ?? 0;
        note(key, ranges.map(range => (range.suffix !== undefined ? [size - range.suffix, size] : [range.offset, range.offset + range.length])));
      }
      return result;
    },
    storedSize: inner.storedSize,
    list: inner.list,
  };
  return { store, fetched, reads };
}

/** The chunk keys of `fetched` under one array path (`obs/label/categories`). */
export function chunksOf(fetched, path) {
  return fetched.filter(key => key.slice(0, key.lastIndexOf('/')) === path);
}

/**
 * A view of an opened store that records every array read: `reads` receives
 * `{path, selection}` for each `read()` (the selection as asked, `null` for
 * a whole-array read). Everything else is the store's own.
 */
export function recordingView(node, reads) {
  if (node.kind === 'array') {
    return Object.freeze({
      ...node,
      read(selection, options) {
        reads.push({ path: node.path, selection: selection === undefined ? null : selection.map(pair => [...pair]) });
        return node.read(selection, options);
      },
    });
  }
  const children = new Map();
  const view = {
    ...node,
    get(name) {
      if (!children.has(name)) {
        const child = node.get(name);
        children.set(name, child === null ? null : recordingView(child, reads));
      }
      return children.get(name);
    },
  };
  return Object.freeze(view);
}

/**
 * Open a described tree as a Zarr store root, without the AnnData reader.
 * With `record`, the root is a `recordingView` and `reads` lists its reads.
 */
export async function openStore(tree, {
  name = 'fixture.zarr',
  decodedChunkCacheBytes = 64 * 1024 * 1024,
  onChunk = null,
} = {}) {
  const { store, fetched } = countingStore(tree, { name, onChunk });
  const opened = await openZarr(store, { decodedChunkCacheBytes });
  const reads = [];
  return { root: recordingView(opened, reads), fetched, reads };
}

/**
 * Open a described tree as an AnnData reader. `fetched` lists the chunk keys
 * the store served; `reads` the array reads the reader made.
 *
 * @returns {Promise<{reader: AnnDataReader, root: Object, fetched: string[], reads: Array<{path: string, selection: Array|null}>}>}
 */
export async function openReader(tree, {
  name = 'fixture.zarr',
  decodedChunkCacheBytes = 64 * 1024 * 1024,
  onChunk = null,
  reader = new AnnDataReader(),
} = {}) {
  const { root, fetched, reads } = await openStore(tree, { name, decodedChunkCacheBytes, onChunk });
  await reader.open(root, { format: ZARR_FORMAT, name, decodedChunkBytes: decodedChunkCacheBytes });
  return { reader, root, fetched, reads };
}

/** A minimal valid dataset: `nObs` cells, the given genes, a 2-D UMAP. */
export function minimalAnnData({ nObs = 1, genes = ['gene'], X = undefined, obs = {}, obsm = undefined, extra = {} } = {}) {
  const cells = Array.from({ length: nObs }, (_, i) => `cell-${i}`);
  const children = {
    obs: stringFrame(cells, obs),
    var: stringFrame(genes),
    obsm: obsm ?? mapping({
      X_umap_2d: dense(Float32Array.from({ length: nObs * 2 }, (_, i) => i), [nObs, 2]),
    }),
    ...extra,
  };
  if (X !== null) {
    children.X = X ?? dense(new Float32Array(nObs * genes.length), [nObs, genes.length]);
  }
  return annData(children);
}
