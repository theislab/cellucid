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

import { AnnDataElementWriter, encodingAttributes as encoding } from '../write/element-writer.js';
import { VLEN_UTF8, jsonBytes, itemSizeOf, v2ArrayDocument, vlenUtf8Chunk, zarrV2Dtype } from '../../../formats/zarr/format-v2.js';

/** Bytes of one chunk. */
export const CHUNK_BYTES = 4 * 1024 * 1024;

/** Arrays up to this many bytes are held in the store; larger ones go to the space. */
const HELD_BYTES = 64 * 1024;

export class AnnDataStoreWriter extends AnnDataElementWriter {
  /**
   * @param {import('./space.js').TranscodeSpace} space
   * @param {{chunkBytes?: number}} [options]
   */
  constructor(space, { chunkBytes = CHUNK_BYTES } = {}) {
    super();
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
    this.entries.set(key, { bytes: jsonBytes(value) });
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

  _arrayMeta(path, { shape, chunks, dtype, order = 'C', fill = 0, filters = null }, attrs) {
    this._meta(path, '.zarray', v2ArrayDocument({ shape, chunks, dtype, fill, order, filters, compressor: null }));
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
   *   `shape` defaults to 1-D; `order: 'F'` for a column-major 2-D array.
   *   Chunked by its bytes (`chunkBytes`), whatever its role.
   */
  async array(path, { values = null, region = null, dtype = null, shape = null, order = 'C', attrs = encoding('array', '0.2.0') }) {
    const type = dtype ?? zarrV2Dtype(values);
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

  /**
   * A string array (`vlen-utf8`), chunked by the bytes its strings take; or
   * with `scalar`, the one string of a 0-dimensional array.
   *
   * @param {string} path
   * @param {Array<string|null>} values
   * @param {Object} [attrs]
   * @param {{scalar?: boolean}} [options]
   */
  async strings(path, values, attrs = encoding('string-array', '0.2.0'), { scalar = false } = {}) {
    if (scalar) {
      this._arrayMeta(path, { shape: [], chunks: [], dtype: '|O', fill: '', filters: [VLEN_UTF8] }, attrs);
      const bytes = vlenUtf8Chunk(values);
      this._chunk(path, '0', { bytes }, 0, bytes.length, bytes.length);
      return;
    }
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
    this._arrayMeta(path, { shape: [values.length], chunks: [chunk], dtype: '|O', fill: '', filters: [VLEN_UTF8] }, attrs);
    for (let index = 0, start = 0; start < values.length; index++, start += chunk) {
      const part = values.slice(start, start + chunk);
      // A last chunk holds a whole chunk's elements: empty strings past the data.
      while (part.length < chunk) part.push('');
      const bytes = vlenUtf8Chunk(part);
      const source = bytes.length <= HELD_BYTES ? { bytes } : await this.space.put(bytes);
      this._chunk(path, String(index), source, 0, bytes.length, bytes.length);
    }
  }

  /**
   * A compressed sparse matrix that holds no entry yet: its shape, empty
   * `data` and `indices`, and pointers that are all zero, stored as no chunk
   * at all (an absent chunk reads as its array's fill value): the matrix of
   * a store opened before its entries arrive (`matrix-market.js`).
   *
   * @param {string} path
   * @param {{format: 'csr'|'csc', shape: [number, number]}} matrix
   */
  emptySparse(path, { format, shape }) {
    this.group(path, { shape, ...encoding(`${format}_matrix`, '0.1.0') });
    const pointers = (format === 'csr' ? shape[0] : shape[1]) + 1;
    this._arrayMeta(`${path}/data`, { shape: [0], chunks: [1], dtype: '<f4', fill: 0 }, {});
    this._arrayMeta(`${path}/indices`, { shape: [0], chunks: [1], dtype: '<i4', fill: 0 }, {});
    this._arrayMeta(`${path}/indptr`, { shape: [pointers], chunks: [Math.max(1, Math.min(pointers, Math.floor(this.chunkBytes / 4)))], dtype: '<i4', fill: 0 }, {});
  }

  /**
   * Finish: the consolidated metadata, and every entry.
   *
   * @returns {{entries: Map<string, Object>, used: Set<string>}}
   */
  finish() {
    const metadata = {};
    for (const [key, value] of [...this.metadata].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) metadata[key] = value;
    this.entries.set('.zmetadata', { bytes: jsonBytes({ metadata, zarr_consolidated_format: 1 }) });
    return { entries: this.entries, used: this.used };
  }
}
