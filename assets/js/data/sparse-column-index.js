/**
 * @fileoverview Column access to a row-major expression matrix (CSR, or a
 * contiguous dense matrix) without ever holding the row-major matrix, shared
 * by the h5ad and Zarr readers in the AnnData reader worker.
 *
 * `RowMajorColumnIndex` builds a column store in the background, streaming
 * the matrix in row slabs:
 *
 * - pass 1 (sparse only) reads the column indices and counts the entries of
 *   every column, which fixes where each column lives in the store;
 * - pass 2 reads indices and values and writes every entry to its final
 *   column position.
 *
 * The peak is the store plus one slab. The store lives in memory (segmented
 * typed arrays, so no single-buffer maximum applies) when it fits the memory
 * budget, otherwise in the origin-private file system (OPFS, disk-backed),
 * and if neither can hold it, columns are answered by scanning.
 *
 * A gene asked for while the index builds is never a dead wait: its column is
 * extracted from the slabs the build reads anyway, starting at the slab after
 * the request, and returned as soon as every row has been seen once -- at
 * the latest when the store completes. Values are float32, the precision of
 * every gene payload; duplicate coordinates are summed exactly as the CSC
 * read always summed them.
 *
 * @module data/sparse-column-index
 */

/** Elements per segment: 2^27 (512 MiB of float32), under every engine's buffer maximum. */
export const SEGMENT_ELEMENTS = 2 ** 27;

/**
 * Allocate one typed array, reporting a refused allocation with the bytes it
 * needed and what it was for.
 *
 * @template T
 * @param {new (length: number) => T} ArrayType
 * @param {number} length
 * @param {string} label
 * @returns {T}
 */
export function allocateTypedArray(ArrayType, length, label) {
  try {
    return new ArrayType(length);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const bytes = length * ArrayType.BYTES_PER_ELEMENT;
    const failure = new RangeError(
      `${label} needs ${bytes.toLocaleString('en-US')} bytes, more memory than ` +
      'the browser could allocate.'
    );
    failure.code = 'TOO_LARGE';
    failure.bytes = bytes;
    throw failure;
  }
}

function allocateSegments(ArrayType, length, label) {
  const segments = [];
  for (let start = 0; start < length; start += SEGMENT_ELEMENTS) {
    segments.push(allocateTypedArray(
      ArrayType,
      Math.min(SEGMENT_ELEMENTS, length - start),
      label
    ));
  }
  return segments;
}

function addFloat32(current, value) {
  const sum = current + value;
  const narrowed = Math.fround(sum);
  if (Number.isFinite(sum) && !Number.isFinite(narrowed)) {
    throw new Error('Sparse column value is outside the Float32 range');
  }
  return narrowed;
}

function toCount(value, label) {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return number;
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

/**
 * A sparse column store in memory: entries of column `c` are
 * `columnStart[c]..columnStart[c+1]` of `rows`/`values` (segmented).
 */
class MemorySparseStore {
  constructor(nRows, nCols, columnStart, label) {
    const nnz = columnStart[nCols];
    this.nRows = nRows;
    this.nCols = nCols;
    this._columnStart = columnStart;
    this._next = allocateTypedArray(Float64Array, nCols, `${label} column cursor`);
    this._next.set(columnStart.subarray(0, nCols));
    this._rows = allocateSegments(Uint32Array, nnz, `${label} row index`);
    this._values = allocateSegments(Float32Array, nnz, `${label} values`);
    this.kind = 'memory';
    this.bytes = columnStart.byteLength + this._next.byteLength + nnz * 8;
  }

  writeSlab(slab, indices, values, label) {
    const { rowStart, rowEnd, pointers, pointerOffset, entryStart } = slab;
    const next = this._next;
    const nCols = this.nCols;
    const end = this._columnStart;
    const single = this._rows.length === 1;
    const rows0 = this._rows[0];
    const values0 = this._values[0];
    for (let row = rowStart; row < rowEnd; row++) {
      const local = pointerOffset + row - rowStart;
      const from = pointers[local] - entryStart;
      const to = pointers[local + 1] - entryStart;
      for (let entry = from; entry < to; entry++) {
        const column = indices[entry];
        if (!(column >= 0 && column < nCols) || next[column] >= end[column + 1]) {
          throw new Error(`${label} changed while it was read; reopen the file`);
        }
        const destination = next[column]++;
        if (single) {
          rows0[destination] = row;
          values0[destination] = values[entry];
        } else {
          const segment = Math.floor(destination / SEGMENT_ELEMENTS);
          const offset = destination - segment * SEGMENT_ELEMENTS;
          this._rows[segment][offset] = row;
          this._values[segment][offset] = values[entry];
        }
      }
    }
  }

  finish(label) {
    for (let column = 0; column < this.nCols; column++) {
      if (this._next[column] !== this._columnStart[column + 1]) {
        throw new Error(`${label} changed while it was read; reopen the file`);
      }
    }
    this._next = null;
  }

  column(column) {
    const result = new Float32Array(this.nRows);
    let entry = this._columnStart[column];
    const end = this._columnStart[column + 1];
    while (entry < end) {
      const segment = Math.floor(entry / SEGMENT_ELEMENTS);
      const offset = entry - segment * SEGMENT_ELEMENTS;
      const rows = this._rows[segment];
      const values = this._values[segment];
      const stop = Math.min(end - segment * SEGMENT_ELEMENTS, rows.length);
      for (let index = offset; index < stop; index++) {
        // Duplicate coordinates are legal and summed, as every CSC read did.
        result[rows[index]] = addFloat32(result[rows[index]], values[index]);
      }
      entry = segment * SEGMENT_ELEMENTS + stop;
    }
    return result;
  }

  dispose() {
    this._rows = [];
    this._values = [];
  }
}

/** A dense column store in memory (`values[c * nRows + r]`, segmented). */
class MemoryDenseStore {
  constructor(nRows, nCols, label) {
    this.nRows = nRows;
    this.nCols = nCols;
    this._values = allocateSegments(Float32Array, nRows * nCols, `${label} values`);
    this.kind = 'memory';
    this.bytes = nRows * nCols * 4;
  }

  writeRows(rowStart, rowEnd, block) {
    const nRows = this.nRows;
    const nCols = this.nCols;
    for (let column = 0; column < nCols; column++) {
      let destination = column * nRows + rowStart;
      for (let row = rowStart; row < rowEnd; row++, destination++) {
        const segment = Math.floor(destination / SEGMENT_ELEMENTS);
        this._values[segment][destination - segment * SEGMENT_ELEMENTS] =
          block[(row - rowStart) * nCols + column];
      }
    }
  }

  finish() {}

  column(column) {
    const result = new Float32Array(this.nRows);
    let written = 0;
    let at = column * this.nRows;
    while (written < this.nRows) {
      const segment = Math.floor(at / SEGMENT_ELEMENTS);
      const offset = at - segment * SEGMENT_ELEMENTS;
      const source = this._values[segment];
      const count = Math.min(this.nRows - written, source.length - offset);
      result.set(source.subarray(offset, offset + count), written);
      written += count;
      at += count;
    }
    return result;
  }

  dispose() {
    this._values = [];
  }
}

/** Entries buffered per column group of a disk store before it is written. */
const DISK_GROUP_BUFFER_ENTRIES = 1 << 18;
/** Entries buffered across all groups of a disk store (12 bytes each). */
const DISK_BUFFER_BUDGET_ENTRIES = 1 << 24;

/**
 * A sparse column store on disk (two OPFS files written through synchronous
 * access handles): the same layout as `MemorySparseStore`, with entries
 * buffered per column group and written as one contiguous run per column.
 */
export class DiskSparseStore {
  /**
   * @param {number} nRows
   * @param {number} nCols
   * @param {Float64Array} columnStart
   * @param {{rows: Object, values: Object}} handles - FileSystemSyncAccessHandle-like
   * @param {string} label
   */
  constructor(nRows, nCols, columnStart, handles, label) {
    this.nRows = nRows;
    this.nCols = nCols;
    this._columnStart = columnStart;
    this._handles = handles;
    this._written = allocateTypedArray(Float64Array, nCols, `${label} column cursor`);
    const nnz = columnStart[nCols];
    // Column groups of about equal entry counts, each with its own buffer.
    const groups = Math.max(1, Math.min(
      nCols,
      Math.ceil(nnz / DISK_GROUP_BUFFER_ENTRIES),
      Math.floor(DISK_BUFFER_BUDGET_ENTRIES / DISK_GROUP_BUFFER_ENTRIES)
    ));
    this._groupOf = allocateTypedArray(Uint32Array, nCols, `${label} column groups`);
    this._groupStart = new Uint32Array(groups + 1);
    let group = 0;
    for (let column = 0; column < nCols; column++) {
      while (group < groups - 1 && columnStart[column] >= ((group + 1) * nnz) / groups) {
        group++;
        this._groupStart[group] = column;
      }
      this._groupOf[column] = group;
    }
    for (let g = group + 1; g <= groups; g++) this._groupStart[g] = nCols;
    this._buffers = Array.from({ length: groups }, () => ({
      columns: new Uint32Array(DISK_GROUP_BUFFER_ENTRIES),
      rows: new Uint32Array(DISK_GROUP_BUFFER_ENTRIES),
      values: new Float32Array(DISK_GROUP_BUFFER_ENTRIES),
      length: 0,
    }));
    handles.rows.truncate(nnz * 4);
    handles.values.truncate(nnz * 4);
    this.kind = 'disk';
    this.bytes = columnStart.byteLength + this._written.byteLength +
      groups * DISK_GROUP_BUFFER_ENTRIES * 12;
  }

  writeSlab(slab, indices, values, label) {
    const { rowStart, rowEnd, pointers, pointerOffset, entryStart } = slab;
    const nCols = this.nCols;
    for (let row = rowStart; row < rowEnd; row++) {
      const local = pointerOffset + row - rowStart;
      const from = pointers[local] - entryStart;
      const to = pointers[local + 1] - entryStart;
      for (let entry = from; entry < to; entry++) {
        const column = indices[entry];
        if (!(column >= 0 && column < nCols)) {
          throw new Error(`${label} changed while it was read; reopen the file`);
        }
        this.write(column, row, values[entry]);
      }
    }
  }

  write(column, row, value) {
    const group = this._groupOf[column];
    const buffer = this._buffers[group];
    const at = buffer.length++;
    buffer.columns[at] = column;
    buffer.rows[at] = row;
    buffer.values[at] = value;
    if (buffer.length === DISK_GROUP_BUFFER_ENTRIES) this._flushGroup(group);
  }

  _flushGroup(group) {
    const buffer = this._buffers[group];
    if (buffer.length === 0) return;
    const first = this._groupStart[group];
    const width = this._groupStart[group + 1] - first;
    // Counting sort by column, stable in row order.
    const counts = new Uint32Array(width + 1);
    for (let i = 0; i < buffer.length; i++) counts[buffer.columns[i] - first + 1]++;
    for (let c = 0; c < width; c++) counts[c + 1] += counts[c];
    const cursor = counts.slice(0, width);
    const rows = new Uint32Array(buffer.length);
    const values = new Float32Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      const at = cursor[buffer.columns[i] - first]++;
      rows[at] = buffer.rows[i];
      values[at] = buffer.values[i];
    }
    for (let c = 0; c < width; c++) {
      const start = counts[c];
      const end = counts[c + 1];
      if (end === start) continue;
      const column = first + c;
      const position = (this._columnStart[column] + this._written[column]) * 4;
      this._handles.rows.write(rows.subarray(start, end), { at: position });
      this._handles.values.write(values.subarray(start, end), { at: position });
      this._written[column] += end - start;
    }
    buffer.length = 0;
  }

  finish(label) {
    for (let group = 0; group < this._buffers.length; group++) this._flushGroup(group);
    for (let column = 0; column < this.nCols; column++) {
      if (this._columnStart[column] + this._written[column] !== this._columnStart[column + 1]) {
        throw new Error(`${label} changed while it was read; reopen the file`);
      }
    }
    this._handles.rows.flush();
    this._handles.values.flush();
    this._buffers = [];
    this._written = null;
  }

  column(column) {
    const start = this._columnStart[column];
    const count = this._columnStart[column + 1] - start;
    const result = new Float32Array(this.nRows);
    if (count === 0) return result;
    const rows = new Uint32Array(count);
    const values = new Float32Array(count);
    this._handles.rows.read(rows, { at: start * 4 });
    this._handles.values.read(values, { at: start * 4 });
    for (let index = 0; index < count; index++) {
      result[rows[index]] = addFloat32(result[rows[index]], values[index]);
    }
    return result;
  }

  dispose() {
    for (const name of ['rows', 'values']) {
      try { this._handles[name].close(); } catch { /* already closed */ }
    }
    this._handles.release?.();
  }
}

/** A dense column store on disk: one OPFS file, column-major float32. */
export class DiskDenseStore {
  constructor(nRows, nCols, handles) {
    this.nRows = nRows;
    this.nCols = nCols;
    this._handles = handles;
    this._handle = handles.values;
    this._handle.truncate(nRows * nCols * 4);
    this.kind = 'disk';
    this.bytes = 0;
  }

  writeRows(rowStart, rowEnd, block) {
    const nCols = this.nCols;
    const height = rowEnd - rowStart;
    const run = new Float32Array(height);
    for (let column = 0; column < nCols; column++) {
      for (let row = 0; row < height; row++) run[row] = block[row * nCols + column];
      this._handle.write(run, { at: (column * this.nRows + rowStart) * 4 });
    }
  }

  finish() {
    this._handle.flush();
  }

  column(column) {
    const result = new Float32Array(this.nRows);
    this._handle.read(result, { at: column * this.nRows * 4 });
    return result;
  }

  dispose() {
    try { this._handle.close(); } catch { /* already closed */ }
    this._handles.release?.();
  }
}

/**
 * Where a column store is kept: in memory when it fits `memoryBudgetBytes`,
 * on disk when `openDiskFiles` can provide files, in memory regardless when
 * the disk cannot, and nowhere (columns are scanned) when nothing can hold it.
 *
 * @param {Object} options
 * @param {number} options.memoryBudgetBytes - A residency policy, not a limit
 * @param {((names: string[]) => Promise<Object|null>)|null} [options.openDiskFiles]
 *   Synchronous access handles by name, or null when there is no disk.
 */
export function createColumnStoreFactory({ memoryBudgetBytes, openDiskFiles = null }) {
  const inMemory = create => {
    try {
      return create();
    } catch (error) {
      if (error?.code !== 'TOO_LARGE') throw error;
      return null;
    }
  };
  return {
    async sparse(nRows, nCols, columnStart, label) {
      const bytes = columnStart[nCols] * 8 + nCols * 16;
      const create = () => new MemorySparseStore(nRows, nCols, columnStart, label);
      if (bytes <= memoryBudgetBytes) {
        const store = inMemory(create);
        if (store !== null) return store;
      }
      const files = openDiskFiles === null ? null : await openDiskFiles(['rows', 'values']);
      if (files !== null) return new DiskSparseStore(nRows, nCols, columnStart, files, label);
      return inMemory(create);
    },
    async dense(nRows, nCols, label) {
      const bytes = nRows * nCols * 4;
      const create = () => new MemoryDenseStore(nRows, nCols, label);
      if (bytes <= memoryBudgetBytes) {
        const store = inMemory(create);
        if (store !== null) return store;
      }
      const files = openDiskFiles === null ? null : await openDiskFiles(['values']);
      if (files !== null) return new DiskDenseStore(nRows, nCols, files);
      return inMemory(create);
    },
  };
}

// ---------------------------------------------------------------------------
// The background index
// ---------------------------------------------------------------------------

/**
 * Columns of one row-major matrix, built in the background and served
 * progressively.
 */
export class RowMajorColumnIndex {
  /**
   * @param {Object} options
   * @param {'sparse'|'dense'} options.layout
   * @param {number} options.nRows
   * @param {number} options.nCols
   * @param {number} [options.nnz] - Sparse only
   * Readers may be synchronous (h5wasm) or return promises (Zarr chunks).
   * @param {(start: number, end: number) => ArrayLike<number|bigint>} [options.readRowPointers]
   * @param {(start: number, end: number) => ArrayLike<number|bigint>} [options.readIndices]
   * @param {(start: number, end: number) => Float32Array} [options.readValues]
   * @param {(rowStart: number, rowEnd: number) => Float32Array} [options.readRows] - Dense only
   * @param {Object} options.storeFactory - `createColumnStoreFactory`
   * @param {number} [options.slabEntries] - Entries per step (a scheduling choice)
   * @param {() => Promise<void>} [options.yieldControl] - Called between slabs
   * @param {(event: Object) => void} [options.onProgress]
   * @param {string} [options.label]
   */
  constructor(options) {
    this._options = options;
    this.nRows = options.nRows;
    this.nCols = options.nCols;
    this._label = options.label ?? 'Matrix';
    this._store = null;
    this._requests = new Map();
    this._build = null;
    this._disposed = false;
    this._failure = null;
    this._scanning = null;
    this._retired = false;
    this._filling = null;
    this._retainedIndices = null;
    this.phase = 'idle';
  }

  /** Where the finished store lives (`memory`, `disk`), or null. */
  get storeKind() {
    return this._store?.kind ?? null;
  }

  /** Start building in the background (idempotent); resolves when built. */
  start() {
    if (this._build === null) {
      this._build = this._run().catch(error => {
        this._failure = error;
        for (const request of this._requests.values()) request.reject(error);
        this._requests.clear();
        throw error;
      });
      // A background failure reaches callers through their requests.
      this._build.catch(() => {});
    }
    return this._build;
  }

  /**
   * One column as a dense float32 vector.
   *
   * @param {number} column
   * @returns {Promise<Float32Array>}
   */
  column(column) {
    if (!Number.isSafeInteger(column) || column < 0 || column >= this.nCols) {
      return Promise.reject(new RangeError(`Column index ${column} is out of bounds`));
    }
    if (this._failure !== null) return Promise.reject(this._failure);
    if (this.phase === 'ready') {
      return Promise.resolve(this._store.column(column));
    }
    const restartScan = this.phase === 'unindexed';
    let request = this._requests.get(column);
    if (request === undefined) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      request = {
        column,
        promise,
        resolve,
        reject,
        values: new Float32Array(this.nRows),
        rowsSeen: 0,
      };
      this._requests.set(column, request);
    }
    if (restartScan) this._scanWhileRequested().catch(error => request.reject(error));
    else this.start();
    return request.promise;
  }

  /**
   * Stop being the index callers reach: genes already asked for are still
   * answered (from the passes under way, or from the store when it lands),
   * then everything is released. Nothing is built once no gene is waiting.
   */
  retire() {
    this._retired = true;
    if (this._requests.size === 0) this.dispose();
  }

  _releaseIfRetired() {
    if (this._retired && this._requests.size === 0) this.dispose();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._store?.dispose();
    this._store = null;
    // A store still being filled is released too (its disk files removed).
    this._filling?.dispose();
    this._filling = null;
    const error = new Error(`${this._label} was released; the request was superseded`);
    for (const request of this._requests.values()) request.reject(error);
    this._requests.clear();
  }

  _progress(done, total) {
    this._options.onProgress?.({
      kind: 'transpose',
      label: this._label,
      phase: this.phase,
      done,
      total,
    });
  }

  async _checkpoint() {
    await this._options.yieldControl?.();
    if (this._disposed) {
      throw new Error(`${this._label} was released; the request was superseded`);
    }
  }

  /** The requests waiting at this slab boundary, by column. */
  _active() {
    return this._requests.size === 0 ? null : new Map(this._requests);
  }

  /** Count the rows one slab gave each active request; resolve complete ones. */
  _account(active, rows) {
    if (active === null) return;
    for (const request of active.values()) {
      request.rowsSeen += rows;
      if (request.rowsSeen >= this.nRows && this._requests.get(request.column) === request) {
        this._requests.delete(request.column);
        request.resolve(request.values);
      }
    }
    this._releaseIfRetired();
  }

  _resolveFromStore() {
    for (const request of this._requests.values()) {
      request.resolve(this._store.column(request.column));
    }
    this._requests.clear();
    this._releaseIfRetired();
  }

  async _run() {
    if (this._options.layout === 'dense') await this._runDense();
    else await this._runSparse();
  }

  async _runDense() {
    const { nRows, nCols, storeFactory } = this._options;
    const slabEntries = this._options.slabEntries ?? (4 * 1024 * 1024);
    const rowsPerSlab = Math.max(1, Math.floor(slabEntries / Math.max(1, nCols)));
    this.phase = 'indexing';
    await this._checkpoint();
    const store = await storeFactory.dense(nRows, nCols, this._label);
    this._filling = store;
    await this._checkpoint();
    if (store === null) {
      await this._becomeUnindexed();
      return;
    }
    await this._denseScan(store, rowsPerSlab);
    store.finish(this._label);
    this._filling = null;
    this._store = store;
    this.phase = 'ready';
    this._resolveFromStore();
  }

  /** One pass over a dense matrix: into `store` (or none), extracting requests. */
  async _denseScan(store, rowsPerSlab) {
    const { nRows, nCols, readRows } = this._options;
    for (let rowStart = 0; rowStart < nRows; rowStart += rowsPerSlab) {
      if (store === null && this._requests.size === 0) break;
      const rowEnd = Math.min(nRows, rowStart + rowsPerSlab);
      const active = this._active();
      const block = await readRows(rowStart, rowEnd);
      if (block.length !== (rowEnd - rowStart) * nCols) {
        throw new Error(`${this._label} row slab does not match its selection`);
      }
      if (store !== null) store.writeRows(rowStart, rowEnd, block);
      if (active !== null) {
        for (const request of active.values()) {
          const values = request.values;
          for (let row = rowStart; row < rowEnd; row++) {
            values[row] = block[(row - rowStart) * nCols + request.column];
          }
        }
        this._account(active, rowEnd - rowStart);
      }
      this._progress(rowEnd, nRows);
      await this._checkpoint();
    }
  }

  /**
   * No store could be made (no memory, no disk): columns are answered by
   * scanning the matrix, one pass per batch of waiting genes.
   */
  async _becomeUnindexed() {
    this.phase = 'unindexed';
    if (this._requests.size > 0) await this._scanWhileRequested();
  }

  _scanWhileRequested() {
    this._scanning ??= (async () => {
      try {
        while (this._requests.size > 0) {
          if (this._options.layout === 'dense') {
            const slabEntries = this._options.slabEntries ?? (4 * 1024 * 1024);
            await this._denseScan(null, Math.max(1, Math.floor(slabEntries / Math.max(1, this.nCols))));
          } else {
            await this._sparseScan(null);
          }
        }
      } finally {
        this._scanning = null;
      }
    })();
    return this._scanning;
  }

  /**
   * Row slabs of the sparse matrix: rows `[rowStart, rowEnd)`, their entries
   * `[entryStart, entryEnd)`, and the validated pointers they index.
   */
  async *_rowSlabs() {
    const { nRows, nnz, readRowPointers } = this._options;
    const slabEntries = this._options.slabEntries ?? (4 * 1024 * 1024);
    const pointerSlab = Math.max(1, Math.min(nRows, 1 << 18));
    const label = this._label;
    let previousPointer = 0;
    for (let row = 0; row < nRows;) {
      const pointerEnd = Math.min(nRows, row + pointerSlab);
      const raw = await readRowPointers(row, pointerEnd + 1);
      if (raw.length !== pointerEnd + 1 - row) {
        throw new Error(`${label} indptr slab does not match its selection`);
      }
      const pointers = new Float64Array(raw.length);
      for (let index = 0; index < raw.length; index++) {
        const pointer = toCount(raw[index], `${label} indptr`);
        if (index === 0 && pointer !== previousPointer) {
          throw new Error(
            row === 0 ? `${label} indptr must start at zero` : `${label} indptr must be monotonic`
          );
        }
        if (index > 0 && pointer < pointers[index - 1]) {
          throw new Error(`${label} indptr must be monotonic`);
        }
        if (pointer > nnz) {
          throw new Error(`${label} indptr last value must equal the non-zero count (${nnz})`);
        }
        pointers[index] = pointer;
      }
      let local = 0;
      const span = pointerEnd - row;
      while (local < span) {
        let last = local + 1;
        while (last < span && pointers[last + 1] - pointers[local] <= slabEntries) last++;
        yield {
          rowStart: row + local,
          rowEnd: row + last,
          pointers,
          pointerOffset: local,
          entryStart: pointers[local],
          entryEnd: pointers[last],
        };
        local = last;
      }
      previousPointer = pointers[pointers.length - 1];
      row = pointerEnd;
    }
    if (previousPointer !== nnz) {
      throw new Error(`${label} indptr last value must equal the non-zero count (${nnz})`);
    }
  }

  /** Extract the active requests' entries from one slab. */
  _extract(active, slab, indices, values) {
    if (active === null) return;
    const { rowStart, rowEnd, pointers, pointerOffset, entryStart } = slab;
    const requests = [...active.values()];
    // A dense lookup (column -> waiting request) keeps the entry loop flat.
    this._lookup ??= new Int32Array(this.nCols).fill(-1);
    const lookup = this._lookup;
    requests.forEach((request, index) => { lookup[request.column] = index; });
    try {
      for (let row = rowStart; row < rowEnd; row++) {
        const local = pointerOffset + row - rowStart;
        const from = pointers[local] - entryStart;
        const to = pointers[local + 1] - entryStart;
        for (let entry = from; entry < to; entry++) {
          const index = lookup[indices[entry]];
          if (index >= 0) {
            const target = requests[index].values;
            target[row] = addFloat32(target[row], values[entry]);
          }
        }
      }
    } finally {
      for (const request of requests) lookup[request.column] = -1;
    }
    this._account(active, rowEnd - rowStart);
  }

  async _runSparse() {
    const { nRows, nCols, nnz, readIndices, readValues, storeFactory } = this._options;
    const label = this._label;
    const readSlabIndices = async slab => {
      const indices = await readIndices(slab.entryStart, slab.entryEnd);
      if (indices.length !== slab.entryEnd - slab.entryStart) {
        throw new Error(`${label} indices slab does not match its selection`);
      }
      return indices;
    };
    const readSlabValues = async slab => {
      const values = await readValues(slab.entryStart, slab.entryEnd);
      if (values.length !== slab.entryEnd - slab.entryStart) {
        throw new Error(`${label} payload slab does not match its selection`);
      }
      return values;
    };

    // Pass 1: entries per column. A gene asked for meanwhile is extracted
    // from the same slabs; values are read only while one is waiting. The
    // indices read here are kept for pass 2 when they fit
    // `retainIndicesBytes`, so pass 2 reads only the values.
    this.phase = 'counting';
    // A column holds at most one entry per row, so Uint32 counts suffice
    // (rows are a uint32 axis); the offsets themselves are Float64 (exact
    // to 2^53 entries).
    const counts = allocateTypedArray(Uint32Array, nCols, `${label} column counts`);
    const retained = nnz * 4 <= (this._options.retainIndicesBytes ?? 0) ? [] : null;
    for await (const slab of this._rowSlabs()) {
      const active = this._active();
      const indices = await readSlabIndices(slab);
      retained?.push(indices);
      const integral = indices instanceof Int32Array || indices instanceof Uint32Array ||
        indices instanceof Uint16Array || indices instanceof Uint8Array ||
        indices instanceof Int16Array || indices instanceof Int8Array;
      for (let index = 0; index < indices.length; index++) {
        const column = indices[index];
        if (!(column >= 0 && column < nCols) || (!integral && !Number.isInteger(column))) {
          throw new RangeError(
            `Sparse matrix column index ${column} at entry ${slab.entryStart + index} is outside its ` +
            `${nCols}-column shape`
          );
        }
        counts[column]++;
      }
      if (active !== null) this._extract(active, slab, indices, await readSlabValues(slab));
      this._progress(slab.entryEnd, 2 * nnz);
      await this._checkpoint();
    }
    const columnStart = allocateTypedArray(Float64Array, nCols + 1, `${label} column index`);
    for (let column = 0; column < nCols; column++) {
      columnStart[column + 1] = columnStart[column] + counts[column];
    }

    // Pass 2: every entry to its column; waiting genes complete from the
    // same slabs. Without any store, scanning repeats while genes wait.
    this.phase = 'indexing';
    await this._checkpoint();
    const store = await storeFactory.sparse(nRows, nCols, columnStart, label);
    this._filling = store;
    await this._checkpoint();
    if (store === null) {
      await this._becomeUnindexed();
      return;
    }
    this._retainedIndices = retained;
    await this._sparseScan(store);
    this._retainedIndices = null;
    store.finish(label);
    this._filling = null;
    this._store = store;
    this.phase = 'ready';
    this._resolveFromStore();
  }

  /** One pass over a sparse matrix: into `store` (or none), extracting requests. */
  async _sparseScan(store) {
    const { nCols, nnz, readIndices, readValues } = this._options;
    const label = this._label;
    const retained = store !== null ? this._retainedIndices : null;
    let slabNumber = 0;
    for await (const slab of this._rowSlabs()) {
      if (store === null && this._requests.size === 0) break;
      const active = this._active();
      const [indices, values] = await Promise.all([
        retained?.[slabNumber] ?? readIndices(slab.entryStart, slab.entryEnd),
        readValues(slab.entryStart, slab.entryEnd),
      ]);
      if (retained) retained[slabNumber] = null;
      slabNumber++;
      if (indices.length !== slab.entryEnd - slab.entryStart ||
          values.length !== slab.entryEnd - slab.entryStart) {
        throw new Error(`${label} payload slab does not match its selection`);
      }
      if (store !== null) store.writeSlab(slab, indices, values, label);
      this._extract(active, slab, indices, values);
      this._progress(nnz + slab.entryEnd, 2 * nnz);
      await this._checkpoint();
    }
  }
}
