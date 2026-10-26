/**
 * Writes an AnnData store as Zarr v2, uncompressed, the way anndata 0.12
 * writes one (every element's `encoding-type` and `encoding-version`,
 * consolidated `.zmetadata`), into a mapped store (`formats/zarr/stores/
 * mapped.js`): metadata and small arrays are held; every larger array is a
 * region of the transcode space (`space.js`), either a payload the parser
 * kept as it streamed (R's big-endian elements, declared as such: `>f8`,
 * `>i4`; the Zarr reader swaps on read) or bytes the transcoder derived.
 *
 * Chunking keeps each chunk one contiguous range of its region, so no byte
 * is copied to lay a chunk out:
 *
 * - a 1-D array: chunks of `chunkBytes`; the last chunk is stored whole
 *   (zeros past the data, as an uncompressed Zarr chunk at an array's edge
 *   is);
 * - a 2-D array in C order (rows contiguous): chunks of whole rows;
 * - a 2-D array in Fortran order (columns contiguous, as R stores every
 *   matrix): one chunk per column, `[rows, 1]`.
 *
 * @module data/anndata/transcode/zarr-writer
 */

/** Bytes of one chunk. */
export const CHUNK_BYTES = 4 * 1024 * 1024;

/** Arrays up to this many bytes are held in the store; larger ones go to the space. */
const HELD_BYTES = 64 * 1024;

const ITEM_SIZES = { b1: 1, i1: 1, u1: 1, i2: 2, u2: 2, i4: 4, u4: 4, f4: 4, i8: 8, u8: 8, f8: 8 };

/** The Zarr v2 dtype of a typed array, in host (little-endian) order. */
function dtypeOfValues(values) {
  if (values instanceof Float64Array) return '<f8';
  if (values instanceof Float32Array) return '<f4';
  if (values instanceof Int32Array) return '<i4';
  if (values instanceof Uint32Array) return '<u4';
  if (values instanceof Int16Array) return '<i2';
  if (values instanceof Int8Array) return '|i1';
  if (values instanceof Uint8Array) return '|u1';
  if (values instanceof BigInt64Array) return '<i8';
  throw new TypeError('An array to write must be a numeric typed array.');
}

function itemSizeOf(dtype) {
  const size = ITEM_SIZES[dtype.slice(1)];
  if (size === undefined) throw new TypeError(`The Zarr dtype '${dtype}' is not one this writer writes.`);
  return size;
}

function json(value) {
  return new TextEncoder().encode(JSON.stringify(value, null, 2));
}

const encoding = (type, version) => ({ 'encoding-type': type, 'encoding-version': version });

/** The bytes of one vlen-utf8 chunk: a count, then each string's length and UTF-8 bytes. */
export function vlenUtf8Chunk(values) {
  const encoder = new TextEncoder();
  const encoded = values.map(value => encoder.encode(value ?? ''));
  const total = 4 + encoded.reduce((sum, bytes) => sum + 4 + bytes.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, values.length, true);
  let offset = 4;
  for (const bytes of encoded) {
    view.setUint32(offset, bytes.length, true);
    out.set(bytes, offset + 4);
    offset += 4 + bytes.length;
  }
  return out;
}

export class AnnDataStoreWriter {
  /**
   * @param {import('./space.js').TranscodeSpace} space
   * @param {{chunkBytes?: number}} [options]
   */
  constructor(space, { chunkBytes = CHUNK_BYTES } = {}) {
    this.space = space;
    this.chunkBytes = chunkBytes;
    /** @type {Map<string, Object>} */
    this.entries = new Map();
    /** Metadata documents by key, consolidated at the end. */
    this.metadata = new Map();
    /** Blobs any entry refers to. */
    this.used = new Set();
  }

  _key(path, name) {
    return path === '' ? name : `${path}/${name}`;
  }

  _meta(path, name, value) {
    const key = this._key(path, name);
    this.metadata.set(key, value);
    this.entries.set(key, { bytes: json(value) });
  }

  /**
   * A group, with its attributes.
   *
   * @param {string} path - `''` for the root
   * @param {Object} [attrs]
   */
  group(path, attrs = {}) {
    this._meta(path, '.zgroup', { zarr_format: 2 });
    this._meta(path, '.zattrs', attrs);
  }

  /** A `dict` group (`obsm`, `layers`, `uns`, ...). */
  dict(path) {
    this.group(path, encoding('dict', '0.1.0'));
  }

  _arrayMeta(path, { shape, chunks, dtype, order = 'C', fill = 0, filters = null }, attrs) {
    this._meta(path, '.zarray', {
      chunks,
      compressor: null,
      dimension_separator: '.',
      dtype,
      fill_value: fill,
      filters,
      order,
      shape,
      zarr_format: 2,
    });
    this._meta(path, '.zattrs', attrs);
  }

  /** Map one chunk key to a range of a region (or held bytes). */
  _chunk(path, key, source, offset, length, size) {
    const full = this._key(path, key);
    if (source.bytes !== undefined) {
      const bytes = new Uint8Array(size);
      bytes.set(source.bytes.subarray(offset, offset + length));
      this.entries.set(full, { bytes });
      return;
    }
    this.used.add(source.store);
    this.entries.set(full, { blob: source.store, offset: source.offset + offset, length, size });
  }

  /** Bytes as a region of the space when large, held otherwise. */
  async _source(values) {
    const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
    if (bytes.length <= HELD_BYTES) return { bytes: bytes.slice() };
    return this.space.put(bytes);
  }

  /**
   * A numeric array.
   *
   * @param {string} path
   * @param {{values?: ArrayBufferView, region?: import('./space.js').Region, dtype?: string,
   *          shape?: number[], order?: 'C'|'F', attrs?: Object}} array
   *   `values` (host order) or `region` (with its `dtype`, e.g. R's `>f8`);
   *   `shape` defaults to 1-D; `order: 'F'` for a column-major 2-D array
   */
  async array(path, { values = null, region = null, dtype = null, shape = null, order = 'C', attrs = encoding('array', '0.2.0') }) {
    const type = dtype ?? dtypeOfValues(values);
    const itemSize = itemSizeOf(type);
    const source = region ?? await this._source(values);
    const length = values !== null ? values.length : region.byteLength / itemSize;
    const dims = shape ?? [length];
    const fill = type.endsWith('b1') ? false : 0;
    if (dims.length === 0) {
      this._arrayMeta(path, { shape: [], chunks: [], dtype: type, fill }, attrs);
      this._chunk(path, '0', source, 0, itemSize, itemSize);
      return;
    }
    if (dims.length === 1) {
      const per = Math.max(1, Math.floor(this.chunkBytes / itemSize));
      const chunk = Math.max(1, Math.min(per, dims[0]));
      this._arrayMeta(path, { shape: dims, chunks: [chunk], dtype: type, fill }, attrs);
      const chunkBytes = chunk * itemSize;
      for (let index = 0, offset = 0; offset < dims[0] * itemSize; index++, offset += chunkBytes) {
        this._chunk(path, String(index), source, offset, Math.min(chunkBytes, dims[0] * itemSize - offset), chunkBytes);
      }
      return;
    }
    if (dims.length !== 2) throw new TypeError('The writer writes arrays of one or two dimensions.');
    const [rows, columns] = dims;
    if (order === 'F') {
      this._arrayMeta(path, { shape: dims, chunks: [Math.max(1, rows), 1], dtype: type, order: 'F', fill }, attrs);
      const columnBytes = rows * itemSize;
      if (columnBytes === 0) return;
      for (let column = 0; column < columns; column++) {
        this._chunk(path, `0.${column}`, source, column * columnBytes, columnBytes, columnBytes);
      }
      return;
    }
    const rowBytes = columns * itemSize;
    const rowsPer = Math.max(1, Math.min(rows, Math.floor(this.chunkBytes / Math.max(1, rowBytes))));
    this._arrayMeta(path, { shape: dims, chunks: [rowsPer, Math.max(1, columns)], dtype: type, fill }, attrs);
    const chunkBytes = rowsPer * rowBytes;
    if (chunkBytes === 0) return;
    for (let index = 0, offset = 0; offset < rows * rowBytes; index++, offset += chunkBytes) {
      this._chunk(path, `${index}.0`, source, offset, Math.min(chunkBytes, rows * rowBytes - offset), chunkBytes);
    }
  }

  /** A boolean array (`|b1`) from 0/1 bytes. */
  async booleans(path, bytes, attrs = encoding('array', '0.2.0')) {
    await this.array(path, { values: bytes, dtype: '|b1', attrs });
  }

  /**
   * A string array (`vlen-utf8`), chunked by the bytes its strings take.
   *
   * @param {string} path
   * @param {Array<string|null>} values
   * @param {Object} [attrs]
   */
  async strings(path, values, attrs = encoding('string-array', '0.2.0')) {
    const encoder = new TextEncoder();
    let averageBytes = 8;
    if (values.length > 0) {
      let sample = 0;
      const step = Math.max(1, Math.floor(values.length / 1000));
      let counted = 0;
      for (let i = 0; i < values.length; i += step, counted++) sample += encoder.encode(values[i] ?? '').length + 4;
      averageBytes = Math.max(1, sample / counted);
    }
    const chunk = Math.max(1, Math.min(values.length, Math.floor(this.chunkBytes / averageBytes)));
    this._arrayMeta(path, { shape: [values.length], chunks: [chunk], dtype: '|O', fill: '', filters: [{ id: 'vlen-utf8' }] }, attrs);
    for (let index = 0, start = 0; start < values.length; index++, start += chunk) {
      const part = values.slice(start, start + chunk);
      // A last chunk holds a whole chunk's elements: empty strings past the data.
      while (part.length < chunk) part.push('');
      const bytes = vlenUtf8Chunk(part);
      const source = bytes.length <= HELD_BYTES ? { bytes } : await this.space.put(bytes);
      this._chunk(path, String(index), source, 0, bytes.length, bytes.length);
    }
  }

  /** A scalar string (`encoding-type: string`). */
  async string(path, value) {
    this._arrayMeta(path, { shape: [], chunks: [], dtype: '|O', fill: '', filters: [{ id: 'vlen-utf8' }] }, encoding('string', '0.2.0'));
    const bytes = vlenUtf8Chunk([value]);
    this._chunk(path, '0', { bytes }, 0, bytes.length, bytes.length);
  }

  /** A scalar number (`encoding-type: numeric-scalar`). */
  async number(path, value) {
    if (typeof value === 'boolean') {
      await this.array(path, { values: Uint8Array.of(value ? 1 : 0), dtype: '|b1', shape: [], attrs: encoding('numeric-scalar', '0.2.0') });
    } else if (Number.isInteger(value) && Math.abs(value) < 2 ** 31) {
      await this.array(path, { values: Int32Array.of(value), shape: [], attrs: encoding('numeric-scalar', '0.2.0') });
    } else {
      await this.array(path, { values: Float64Array.of(value), shape: [], attrs: encoding('numeric-scalar', '0.2.0') });
    }
  }

  /**
   * A JSON-like value under `uns`: a record becomes a dict, a string or
   * number a scalar, a list of strings a string array, a list of numbers an
   * array. `null` is left out.
   */
  async unsValue(path, value) {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') return this.string(path, value);
    if (typeof value === 'number' || typeof value === 'boolean') return this.number(path, value);
    if (Array.isArray(value)) {
      if (value.every(item => typeof item === 'string' || item === null)) return this.strings(path, value);
      if (value.every(item => typeof item === 'number')) return this.array(path, { values: Float64Array.from(value) });
      if (value.every(item => typeof item === 'boolean')) return this.booleans(path, Uint8Array.from(value, Number));
      return undefined;
    }
    if (ArrayBuffer.isView(value)) return this.array(path, { values: value });
    this.dict(path);
    for (const [key, item] of Object.entries(value)) await this.unsValue(`${path}/${key}`, item);
    return undefined;
  }

  /**
   * A dataframe: an index and columns (the kinds `column()` writes).
   *
   * @param {string} path
   * @param {{index: Array<string>, columns: Array<{name: string, column: Object}>}} frame
   */
  async dataframe(path, { index, columns }) {
    const names = [];
    const taken = new Set(['_index']);
    for (const { name } of columns) {
      if (taken.has(name) || name.includes('/') || name === '') continue;
      taken.add(name);
      names.push(name);
    }
    this.group(path, { '_index': '_index', 'column-order': names, ...encoding('dataframe', '0.2.0') });
    await this.strings(`${path}/_index`, index);
    for (const { name, column } of columns) {
      if (!names.includes(name)) continue;
      await this.column(`${path}/${name}`, column);
    }
  }

  /**
   * One dataframe column:
   *
   * - `{kind: 'numbers', values|region, dtype}` → array;
   * - `{kind: 'booleans', values: Uint8Array}` → bool array;
   * - `{kind: 'nullable-integer'|'nullable-boolean', values, mask: Uint8Array}`;
   * - `{kind: 'categorical', codes: Int8Array|Int16Array|Int32Array, categories, ordered}`;
   * - `{kind: 'strings', values}` → string array.
   */
  async column(path, column) {
    switch (column.kind) {
      case 'numbers':
        return this.array(path, column);
      case 'booleans':
        return this.booleans(path, column.values);
      case 'nullable-integer':
      case 'nullable-boolean':
        this.group(path, encoding(column.kind, '0.1.0'));
        if (column.kind === 'nullable-integer') await this.array(`${path}/values`, { values: column.values });
        else await this.booleans(`${path}/values`, column.values);
        return this.booleans(`${path}/mask`, column.mask);
      case 'categorical':
        this.group(path, { ordered: column.ordered === true, ...encoding('categorical', '0.2.0') });
        await this.array(`${path}/codes`, { values: column.codes });
        return this.strings(`${path}/categories`, column.categories);
      case 'strings':
        return this.strings(path, column.values);
      default:
        throw new TypeError(`Unknown column kind '${column.kind}'.`);
    }
  }

  /**
   * A compressed sparse matrix group: `csr_matrix` or `csc_matrix`.
   *
   * @param {string} path
   * @param {{format: 'csr'|'csc', shape: [number, number], data: Object, indices: Object, indptr: Object}} matrix
   *   Each part `{values}` or `{region, dtype}`
   */
  async sparse(path, { format, shape, data, indices, indptr }) {
    this.group(path, { shape, ...encoding(`${format}_matrix`, '0.1.0') });
    await this.array(`${path}/data`, { ...data, attrs: {} });
    await this.array(`${path}/indices`, { ...indices, attrs: {} });
    await this.array(`${path}/indptr`, { ...indptr, attrs: {} });
  }

  /**
   * Finish: the consolidated metadata, and every entry.
   *
   * @returns {{entries: Map<string, Object>, used: Set<string>}}
   */
  finish() {
    const metadata = {};
    for (const [key, value] of [...this.metadata].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) metadata[key] = value;
    this.entries.set('.zmetadata', { bytes: json({ metadata, zarr_consolidated_format: 1 }) });
    return { entries: this.entries, used: this.used };
  }
}
