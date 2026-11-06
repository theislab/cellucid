/**
 * Writing a Zarr v2 store as a stream: the mirror of `open.js` and the
 * codec pipeline (`codecs/`), which read what this writes. The format's
 * documents, dtypes and `vlen-utf8` bytes are `format-v2.js`'s (shared with
 * the transcoders' kept stores); what only a streamed, compressed store
 * needs is here, outside the transcoders' revision guards.
 *
 * - **Metadata.** `.zgroup` / `.zattrs` / `.zarray` per node, and the
 *   consolidated `.zmetadata` (`zarr_consolidated_format: 1`) naming every
 *   one, so a reader on a web host learns the whole tree with one request
 *   (`open.js`), written as `format-v2.js` `jsonBytes` writes JSON.
 * - **Codecs** (`v2Codecs`): numcodecs' `shuffle` filter (`elementsize`) on
 *   values wider than one byte when asked, then `zlib` at a level; strings
 *   through the `vlen-utf8` filter (`vlenUtf8Chunk`, the layout
 *   `codecs/vlen.js` reads). Deflate is fflate's (`assets/external`, the
 *   inflater `io/inflate.js` measures against the platform's), synchronous
 *   and at the level asked, so a chunk's bytes are the same in every engine
 *   and in Node. Measured on 2^14-value chunks of shuffled `int32` gene
 *   indices: fflate 79 MB/s, Node's zlib 134, `CompressionStream` 93; of
 *   float32 expression values 23 MB/s for all three, fflate's output 5%
 *   smaller (Node 26, Apple M1 Pro). A compressor with no level
 *   (`CompressionStream`) cannot write the level the metadata names.
 * - **Chunks** are whole: a chunk at an array's edge holds the chunk's full
 *   shape (the fill value past the data), as every Zarr v2 writer stores it
 *   and `chunks.js` decodes it. A chunk never written reads as the fill
 *   value. Keys are `<i>.<j>` (`dimension_separator: '.'`), `0` for a
 *   scalar.
 *
 * `ZarrV2StoreWriter` writes through a key sink `{put(key, bytes)}`: each
 * chunk as soon as it is encoded (a ZIP entry, `zarrZipSink`), the metadata
 * documents at `finish()`, the consolidated metadata last: in a `.zarr.zip`
 * the documents that describe the store then sit in the archive's end, which
 * a reader reads first (`zip/archive.js`), so it opens with one read.
 *
 * @module formats/zarr/writer
 */

import { zlibSync } from '../../../external/fflate-0.8.2/browser.js';
import { formatCountOf } from '../../utils/format-units.js';
import { VLEN_UTF8, defaultFillOf, itemSizeOf, jsonBytes, v2ArrayDocument, vlenUtf8Chunk } from './format-v2.js';

/** The deflate level of every Cellucid writer (cellucid-python's `DEFLATE_LEVEL`). */
export const DEFLATE_LEVEL = 6;

/**
 * Float16 values as their bits, from the float32 values a store reads them
 * as (`dtypes.js` `float16Values`): each the nearest float16, ties to even,
 * so a value that was a float16 is its own bits again (NaN as the quiet
 * NaN `0x7e00`, with its sign).
 *
 * @param {ArrayLike<number>} values
 * @returns {Uint16Array}
 */
export function float16Bits(values) {
  const out = new Uint16Array(values.length);
  const word = new Float32Array(1);
  const bits = new Uint32Array(word.buffer);
  for (let i = 0; i < values.length; i++) {
    word[0] = values[i];
    const x = bits[0];
    const sign = (x >>> 16) & 0x8000;
    const exponent = (x >>> 23) & 0xff;
    const mantissa = x & 0x7fffff;
    if (exponent === 0xff) {
      out[i] = sign | (mantissa === 0 ? 0x7c00 : 0x7e00);
      continue;
    }
    const unbiased = exponent - 127;
    if (unbiased > 15) {
      out[i] = sign | 0x7c00;
      continue;
    }
    if (unbiased >= -14) {
      // A normal half: 10 mantissa bits, rounded to nearest, ties to even (a carry raises the exponent).
      let half = ((unbiased + 15) << 10) | (mantissa >>> 13);
      const rest = mantissa & 0x1fff;
      if (rest > 0x1000 || (rest === 0x1000 && (half & 1) === 1)) half++;
      out[i] = sign | half;
      continue;
    }
    // A subnormal half (or zero): the value in units of 2^-24, rounded to nearest, ties to even.
    const shift = -unbiased - 14 + 13;
    if (shift > 24) {
      out[i] = sign;
      continue;
    }
    const full = mantissa | 0x800000;
    let half = full >>> shift;
    const rest = full & ((1 << shift) - 1);
    const middle = 1 << (shift - 1);
    if (rest > middle || (rest === middle && (half & 1) === 1)) half++;
    out[i] = sign | half;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Codecs.

/**
 * The filters and compressor of an array: `vlen-utf8` for text; numcodecs'
 * `shuffle` for values wider than one byte when `shuffle`; `zlib` at
 * `level`, or none (`level` null).
 *
 * @param {string} dtype
 * @param {{shuffle?: boolean, level?: number|null}} [options]
 * @returns {{filters: Array<Object>|null, compressor: Object|null}}
 */
export function v2Codecs(dtype, { shuffle = true, level = DEFLATE_LEVEL } = {}) {
  const compressor = level === null ? null : { id: 'zlib', level };
  if (dtype === '|O') return { filters: [VLEN_UTF8], compressor };
  // Records and fixed-width text are bytes of mixed meaning: never shuffled.
  if (Array.isArray(dtype) || /^[<>]U/.test(dtype)) return { filters: null, compressor };
  const size = itemSizeOf(dtype);
  return { filters: shuffle && size > 1 ? [{ id: 'shuffle', elementsize: size }] : null, compressor };
}

/**
 * Byte-shuffle `bytes` (numcodecs `Shuffle`, HDF5's shuffle filter): lane
 * `b` holds byte `b` of every whole value in order; bytes past the last
 * whole value stay where they are. The inverse of `io/shuffle.js`.
 *
 * @param {Uint8Array} bytes
 * @param {number} typesize
 * @returns {Uint8Array}
 */
export function byteShuffle(bytes, typesize) {
  const out = new Uint8Array(bytes.length);
  const count = Math.floor(bytes.length / typesize);
  // Four-byte values a word at a time, read little-endian as every value here is.
  if (typesize === 4 && bytes.byteOffset % 4 === 0) {
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, count);
    for (let i = 0; i < count; i++) {
      const word = words[i];
      out[i] = word & 0xff;
      out[count + i] = (word >>> 8) & 0xff;
      out[2 * count + i] = (word >>> 16) & 0xff;
      out[3 * count + i] = word >>> 24;
    }
  } else {
    for (let byte = 0; byte < typesize; byte++) {
      const lane = byte * count;
      for (let i = 0, from = byte; i < count; i++, from += typesize) out[lane + i] = bytes[from];
    }
  }
  const done = count * typesize;
  if (done < bytes.length) out.set(bytes.subarray(done), done);
  return out;
}

/**
 * One chunk encoded through an array's filters and compressor (`v2Codecs`):
 * `values` are its values' bytes (host order) or, for `|O`, its strings.
 *
 * @param {Uint8Array|Array<string|null>} values
 * @param {{filters: Array<Object>|null, compressor: Object|null}} codecs
 * @returns {Uint8Array}
 */
export function encodeV2Chunk(values, { filters, compressor }) {
  let bytes = values;
  for (const filter of filters ?? []) {
    if (filter.id === 'vlen-utf8') bytes = vlenUtf8Chunk(bytes);
    else if (filter.id === 'shuffle') bytes = byteShuffle(bytes, filter.elementsize);
    else throw new TypeError(`The Zarr filter '${filter.id}' is not one this writer writes.`);
  }
  if (compressor === null) return bytes;
  if (compressor.id !== 'zlib') throw new TypeError(`The Zarr compressor '${compressor.id}' is not one this writer writes.`);
  return zlibSync(bytes, { level: compressor.level });
}

/** The key of the chunk at `coords` under its array (`0` for a scalar). */
export function chunkKeyV2(coords) {
  return coords.length === 0 ? '0' : coords.join('.');
}

// ---------------------------------------------------------------------------
// Streaming a store.

/**
 * @typedef {Object} ZarrKeySink
 * @property {(key: string, bytes: Uint8Array) => Promise<void>} put
 *   One stored key (a chunk or a metadata document), its bytes the sink's.
 */

/**
 * The writer of one array: chunks by their coordinates, and the rows of an
 * array chunked along its first dimension only, as they come.
 */
export class ZarrV2ArrayWriter {
  /** @private */
  constructor(store, path, { shape, chunks, dtype, codecs }) {
    this.store = store;
    this.path = path;
    this.shape = shape;
    this.chunks = chunks;
    this.dtype = dtype;
    this.codecs = codecs;
    this.itemSize = itemSizeOf(dtype);
    /** Values of one chunk (`chunks` multiplied). */
    this.chunkLength = chunks.reduce((product, extent) => product * extent, 1);
    /** Rows appended so far (`appendRows`). */
    this.rowsWritten = 0;
    /** Whether rows were appended (`appendRows`), so `end()` checks they all were. */
    this.appending = false;
    /** The chunk being filled by `appendRows`: values or strings, and how many are in. */
    this.pending = null;
    this.pendingLength = 0;
    /** Values per row of the array (every dimension after the first). */
    this.rowLength = shape.slice(1).reduce((product, extent) => product * extent, 1);
  }

  /**
   * Write the chunk at `coords`: its values' bytes (host order) or its
   * strings, exactly one chunk's worth (`chunkLength`; an edge chunk padded
   * with the fill value by the caller, or through `appendRows`).
   *
   * @param {number[]} coords
   * @param {Uint8Array|Array<string|null>} values
   */
  async writeChunk(coords, values) {
    const length = this.itemSize === null ? values.length : values.byteLength / this.itemSize;
    if (length !== this.chunkLength) {
      throw new RangeError(`${this.path}: a chunk holds ${formatCountOf(this.chunkLength, 'value')}, not ${length}.`);
    }
    await this.store.putChunk(this.path, chunkKeyV2(coords), values, this.codecs);
  }

  /**
   * Append rows of an array chunked along its first dimension only (every
   * other dimension whole): `values` hold whole rows, in order, as a typed
   * array (host order) or, for text, an `Array`. Full chunks are written as
   * they fill; `end()` writes the last.
   *
   * @param {ArrayBufferView|Array<string|null>} values
   */
  async appendRows(values) {
    const rowsPerChunk = this.chunks[0];
    if (this.chunks.slice(1).some((extent, axis) => extent !== this.shape[axis + 1])) {
      throw new TypeError(`${this.path}: rows are appended only to an array chunked along its first dimension.`);
    }
    const strings = this.itemSize === null;
    // Values are counted in the array's elements: a typed array of its dtype,
    // or raw element bytes (a compound array's records).
    const items = strings ? values : new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
    const size = strings ? 1 : this.itemSize;
    const count = items.length / size;
    if (!Number.isInteger(count) || count % this.rowLength !== 0) throw new RangeError(`${this.path}: rows are appended whole.`);
    this.appending = true;
    let at = 0;
    while (at < count) {
      const chunkIndex = Math.floor(this.rowsWritten / rowsPerChunk);
      // A whole chunk straight from the values, when one starts here and they hold it.
      if (this.pendingLength === 0 && count - at >= this.chunkLength) {
        const part = strings ? items.slice(at, at + this.chunkLength) : items.subarray(at * size, (at + this.chunkLength) * size);
        await this.writeChunk(this.rowCoords(chunkIndex), part);
        at += this.chunkLength;
        this.rowsWritten += rowsPerChunk;
        continue;
      }
      this.pending ??= strings ? new Array(this.chunkLength).fill('') : new Uint8Array(this.chunkLength * size);
      const take = Math.min(this.chunkLength - this.pendingLength, count - at);
      if (strings) {
        for (let i = 0; i < take; i++) this.pending[this.pendingLength + i] = items[at + i];
      } else {
        this.pending.set(items.subarray(at * size, (at + take) * size), this.pendingLength * size);
      }
      this.pendingLength += take;
      at += take;
      this.rowsWritten += take / this.rowLength;
      if (this.pendingLength === this.chunkLength) await this.flushPending(chunkIndex);
    }
  }

  /**
   * Write the chunks of a two-dimensional array that hold the block of rows
   * of chunk band `band` and columns `[firstColumn, firstColumn + width)`:
   * `values` is that block in C order (the band's rows, at the array's
   * edge fewer), `firstColumn` a chunk's first column, `width` whole chunks
   * of columns or reaching the array's last column. Each chunk is padded
   * with the fill value past the array's edge.
   *
   * @param {number} band
   * @param {number} firstColumn
   * @param {ArrayBufferView} values
   * @param {number} width
   */
  async writeColumnBlock(band, firstColumn, values, width) {
    const [chunkRows, chunkColumns] = this.chunks;
    if (this.shape.length !== 2 || firstColumn % chunkColumns !== 0) {
      throw new RangeError(`${this.path}: a block starts at a chunk of a two-dimensional array.`);
    }
    const rows = Math.min(chunkRows, this.shape[0] - band * chunkRows);
    if (values.length !== rows * width) throw new RangeError(`${this.path}: the block holds ${formatCountOf(values.length, 'value')}, not ${rows} × ${width}.`);
    const size = this.itemSize;
    const source = byteView(values, 0, values.length);
    for (let column = 0; column < width; column += chunkColumns) {
      const take = Math.min(chunkColumns, width - column);
      const chunk = new Uint8Array(this.chunkLength * size);
      for (let row = 0; row < rows; row++) {
        const from = (row * width + column) * size;
        chunk.set(source.subarray(from, from + take * size), row * chunkColumns * size);
      }
      await this.writeChunk([band, (firstColumn + column) / chunkColumns], chunk);
    }
  }

  /** The coordinates of row chunk `index` (every later coordinate 0). */
  rowCoords(index) {
    return [index, ...this.shape.slice(1).map(() => 0)];
  }

  /** @private */
  async flushPending(index) {
    const chunk = this.pending;
    this.pending = null;
    this.pendingLength = 0;
    await this.writeChunk(this.rowCoords(index), chunk);
  }

  /**
   * The last chunk of rows (its rest the fill value: zero bytes, or `''`),
   * and a check that every row was appended.
   */
  async end() {
    if (this.pendingLength > 0) {
      // The rest of the chunk is the fill: zeros (0, false), or empty strings.
      await this.flushPending(Math.floor((this.rowsWritten - 1) / this.chunks[0]));
    }
    if (this.appending && this.rowsWritten !== this.shape[0]) {
      throw new RangeError(`${this.path}: ${formatCountOf(this.rowsWritten, 'row')} of ${this.shape[0]} were written.`);
    }
  }
}

/** `count` values of `values` from `start`, as bytes (a view, never a copy). */
function byteView(values, start, count) {
  const size = values.BYTES_PER_ELEMENT;
  return new Uint8Array(values.buffer, values.byteOffset + start * size, count * size);
}

/**
 * A Zarr v2 store written through a key sink: chunks as they come, the
 * metadata at the end, the consolidated metadata last.
 */
export class ZarrV2StoreWriter {
  /**
   * @param {ZarrKeySink} sink
   * @param {{indent?: number, encode?: (values: Uint8Array|Array<string|null>, codecs: Object) => (Uint8Array|Promise<Uint8Array>),
   *   inFlight?: number}} [options]
   *   `indent`: the JSON indent of the metadata documents. `encode`: how a
   *   chunk is encoded (`encodeV2Chunk` here, or on other threads: the
   *   values are the encoder's from then on). `inFlight`: chunks encoded at
   *   once; each is put in the order it was written, so the store's bytes
   *   are the same whatever the number.
   */
  constructor(sink, { indent = 2, encode = encodeV2Chunk, inFlight = 1 } = {}) {
    if (sink === null || typeof sink !== 'object' || typeof sink.put !== 'function') {
      throw new TypeError('A Zarr store writer writes through a sink with put(key, bytes).');
    }
    this.sink = sink;
    this.indent = indent;
    this.encode = encode;
    this.inFlight = Math.max(1, inFlight);
    /** Chunks being encoded, in the order they were written: `{key, encoded}`. */
    this.encoding = [];
    /** Metadata documents by key. */
    this.metadata = new Map();
    this.finished = false;
    /** Chunks written. */
    this.chunks = 0;
  }

  _key(path, name) {
    return path === '' ? name : `${path}/${name}`;
  }

  _document(path, name, value) {
    if (this.finished) throw new Error('The Zarr store is finished.');
    this.metadata.set(this._key(path, name), value);
  }

  /** Whether a group or an array is declared at `path`. */
  has(path) {
    return this.metadata.has(this._key(path, '.zgroup')) || this.metadata.has(this._key(path, '.zarray'));
  }

  /**
   * A group, with its attributes.
   *
   * @param {string} path - `''` for the root
   * @param {Object} [attrs]
   */
  group(path, attrs = {}) {
    this._document(path, '.zgroup', { zarr_format: 2 });
    this._document(path, '.zattrs', attrs);
  }

  /**
   * Declare an array and return its writer (`ZarrV2ArrayWriter`). An array
   * with no value has chunks of 1 along every empty dimension.
   *
   * @param {string} path
   * @param {{shape: number[], chunks: number[], dtype: string, attrs?: Object, fill?: unknown,
   *          order?: 'C', filters?: Array<Object>|null, compressor?: Object|null}} array
   * @returns {ZarrV2ArrayWriter}
   */
  array(path, { shape, chunks, dtype, attrs = {}, fill = defaultFillOf(dtype), order = 'C', filters = null, compressor = null }) {
    if (shape.length !== chunks.length || chunks.some(extent => !Number.isSafeInteger(extent) || extent < 1)) {
      throw new RangeError(`${path}: chunks [${chunks}] do not fit shape [${shape}].`);
    }
    if (order !== 'C') throw new TypeError(`${path}: this writer writes arrays in C order.`);
    this._document(path, '.zarray', v2ArrayDocument({ shape, chunks, dtype, fill, order, filters, compressor }));
    this._document(path, '.zattrs', attrs);
    return new ZarrV2ArrayWriter(this, path, { shape, chunks, dtype, codecs: { filters, compressor } });
  }

  /**
   * Encode a chunk and put it in its turn: no more than `inFlight` are
   * being encoded at once.
   *
   * @private
   */
  async putChunk(path, key, values, codecs) {
    if (this.finished) throw new Error('The Zarr store is finished.');
    this.chunks++;
    const encoded = Promise.resolve().then(() => this.encode(values, codecs));
    // A failure is met when its turn comes (`putOldest`), never unhandled before.
    encoded.catch(() => {});
    this.encoding.push({ key: this._key(path, key), encoded });
    while (this.encoding.length >= this.inFlight) await this.putOldest();
  }

  /** @private */
  async putOldest() {
    const { key, encoded } = this.encoding.shift();
    await this.sink.put(key, await encoded);
  }

  /**
   * Every metadata document, in path order, then `.zmetadata`.
   *
   * @returns {Promise<{metadata: Object}>} The consolidated metadata
   */
  async finish() {
    if (this.finished) throw new Error('The Zarr store is finished already.');
    while (this.encoding.length > 0) await this.putOldest();
    this.finished = true;
    const keys = [...this.metadata.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const metadata = {};
    for (const key of keys) {
      metadata[key] = this.metadata.get(key);
      await this.sink.put(key, jsonBytes(metadata[key], this.indent));
    }
    const consolidated = { metadata, zarr_consolidated_format: 1 };
    await this.sink.put('.zmetadata', jsonBytes(consolidated, this.indent));
    return consolidated;
  }
}

/**
 * The key sink of a store at the top of a ZIP archive (`zip/writer.js`):
 * each key one stored entry, as a `.zarr.zip` holds its store.
 *
 * @param {import('../zip/writer.js').ZipWriter} zip
 * @returns {ZarrKeySink}
 */
export function zarrZipSink(zip) {
  return { put: (key, bytes) => zip.add(key, bytes) };
}
