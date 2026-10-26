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
 *   hold whose values a test must never read.
 */
export function array(values, {
  dtype = '<f4',
  shape = [values.length],
  chunks = null,
  attrs = undefined,
  fillValue = undefined,
  vlen = 'utf-8',
  writeChunks = true,
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
} = {}) {
  const part = (values, dtype) => array(values, { dtype, attrs: null, chunks: chunks === null ? null : [chunks] });
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
    compressor: null,
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
    entries.set(`${prefix}${key}`, encodeChunk(node, coords));
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

function isChunkKey(key) {
  return !METADATA_FILES.has(key.slice(key.lastIndexOf('/') + 1));
}

/**
 * A memory store holding the tree, counting the chunks it serves: `fetched`
 * lists every chunk key read, in order (metadata files are not counted).
 * `onChunk(key, options)` runs before each chunk is served, with the read's
 * options (its `signal`); it may wait, or throw to fail that read.
 */
export function countingStore(root, { name = 'fixture.zarr', onChunk = null } = {}) {
  const inner = memoryStore(zarrEntries(root), { name });
  const fetched = [];
  const note = key => {
    if (isChunkKey(key)) fetched.push(key);
  };
  const store = {
    name,
    async get(key, options) {
      if (onChunk !== null && isChunkKey(key)) await onChunk(key, options);
      const bytes = await inner.get(key, options);
      if (bytes !== null) note(key);
      return bytes;
    },
    getMany(keys, options) {
      return Promise.all(keys.map(key => store.get(key, options)));
    },
    async getRanges(key, ranges, options) {
      const result = await inner.getRanges(key, ranges, options);
      if (result !== null) note(key);
      return result;
    },
    storedSize: inner.storedSize,
    list: inner.list,
  };
  return { store, fetched };
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
