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
 * Over a link slower than a disk (`valuesOnDemand`; the reader decides from
 * the measured link), where every byte costs transfer time, a sparse matrix
 * is indexed by its structure only: pass 1 reads the column
 * indices alone, several slabs at once so the link stays full, and the entry
 * positions of every gene are kept with the row pointers that place them
 * (`MemorySparseStructure`); a gene's values are then fetched as the few
 * ranges its entries occupy. A gene asked for during pass 1 fetches only its
 * own entries' values from each slab, beside the pass. The values are
 * downloaded whole once the ranges already read and those the genes asked
 * for together would cost as much.
 *
 * @module data/sparse-column-index
 */

import { REMOTE_POLICY } from '../formats/io/byte-source.js';
import { recordAllocationFailure } from './memory-budget.js';

/**
 * How long one part of a background index's synchronous work runs before the
 * reader thread takes its other reads (a scheduling choice): a read someone
 * waits for crosses a few such waits, so a few milliseconds each keeps it
 * near its idle time while the yields cost a few percent of the build.
 */
const INDEX_SLICE_MS = 2;

/** Elements per segment: 2^27 (512 MiB of float32), under every engine's buffer maximum. */
export const SEGMENT_ELEMENTS = 2 ** 27;

/**
 * Allocate one typed array, reporting a refused allocation with the bytes it
 * needed and what it was for, and to the memory budgets
 * (`memory-budget.js`, `recordAllocationFailure`).
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
    // The memory budgets of this thread take the refusal as their signal.
    recordAllocationFailure(bytes);
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
  return Math.fround(current + value);
}

/**
 * @typedef {Object} SparseColumn
 * @property {number} length - Cells the column stands for
 * @property {Uint32Array} indices - Cells holding a value, strictly ascending
 * @property {Float32Array} values - Their values
 *
 * One gene's column as its non-zero entries: every cell not listed is zero.
 * The arrays each own their whole buffer, so they cross to another thread by
 * transfer. The values are those of the gene's dense column, bit for bit: a
 * duplicate coordinate is summed in stored order as the dense column sums it,
 * and an entry that is (or sums to) zero is left out, as it is from a dense
 * column read as entries (`compute/gene-statistics.js`).
 */

/**
 * A column's entries as a `SparseColumn`: `rows` non-decreasing (a repeated
 * row is a duplicate coordinate, summed in float32 in the order given),
 * `values` at their stored precision.
 *
 * @param {ArrayLike<number>} rows
 * @param {ArrayLike<number>} values
 * @param {number} count - Entries of `rows`/`values` to read
 * @param {number} length - Cells of the column
 * @returns {SparseColumn}
 */
export function sparseColumnOf(rows, values, count, length) {
  let indices = new Uint32Array(count);
  let sums = new Float32Array(count);
  let kept = 0;
  let entry = 0;
  while (entry < count) {
    const row = rows[entry];
    // Stored as float32 (rounded as `addFloat32(0, value)` rounds it); a
    // duplicate coordinate's entries summed in float32, in stored order.
    sums[kept] = values[entry];
    entry++;
    if (entry < count && rows[entry] === row) {
      let sum = sums[kept];
      while (entry < count && rows[entry] === row) {
        sum = addFloat32(sum, values[entry]);
        entry++;
      }
      sums[kept] = sum;
    }
    if (sums[kept] !== 0) {
      indices[kept] = row;
      kept++;
    }
  }
  if (kept < count) {
    indices = indices.slice(0, kept);
    sums = sums.slice(0, kept);
  }
  return { length, indices, values: sums };
}

/**
 * A dense column as a `SparseColumn`: its cells whose value is not zero (a
 * NaN is kept, a negative zero is zero).
 *
 * @param {Float32Array} dense
 * @returns {SparseColumn}
 */
export function sparseColumnOfDense(dense) {
  let count = 0;
  for (let row = 0; row < dense.length; row++) if (dense[row] !== 0) count++;
  const indices = new Uint32Array(count);
  const values = new Float32Array(count);
  let at = 0;
  for (let row = 0; row < dense.length; row++) {
    const value = dense[row];
    if (value !== 0) {
      indices[at] = row;
      values[at] = value;
      at++;
    }
  }
  return { length: dense.length, indices, values };
}

/**
 * Entries `[start, end)` of segmented `rows`/`values` arrays, as two arrays:
 * views when the range lies in one segment, else copies.
 */
function segmentedRange(rowSegments, valueSegments, start, end) {
  const segment = Math.floor(start / SEGMENT_ELEMENTS);
  const offset = start - segment * SEGMENT_ELEMENTS;
  if (offset + (end - start) <= rowSegments[segment].length) {
    return {
      rows: rowSegments[segment].subarray(offset, offset + end - start),
      values: valueSegments[segment].subarray(offset, offset + end - start),
    };
  }
  const rows = new Uint32Array(end - start);
  const values = new Float32Array(end - start);
  for (let entry = start; entry < end; entry++) {
    const at = Math.floor(entry / SEGMENT_ELEMENTS);
    rows[entry - start] = rowSegments[at][entry - at * SEGMENT_ELEMENTS];
    values[entry - start] = valueSegments[at][entry - at * SEGMENT_ELEMENTS];
  }
  return { rows, values };
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

  sparseColumn(column) {
    const start = this._columnStart[column];
    const end = this._columnStart[column + 1];
    const { rows, values } = segmentedRange(this._rows, this._values, start, end);
    return sparseColumnOf(rows, values, end - start, this.nRows);
  }

  dispose() {
    this._rows = [];
    this._values = [];
  }
}

/** Entries apart that one value read still covers (64 KiB of float32). */
const VALUE_RUN_GAP_ENTRIES = 16384;

/**
 * Read the values at sorted entry `positions` with `readValues(start, end)`,
 * one read per run of nearby positions, all at once, and hand each value to
 * `visit(index, value)` (`index` into `positions`).
 */
async function readValuesAt(positions, count, readValues, visit) {
  if (count === 0) return;
  const runs = [];
  let first = 0;
  for (let i = 1; i <= count; i++) {
    if (i === count || positions[i] - positions[i - 1] > VALUE_RUN_GAP_ENTRIES) {
      runs.push([first, i]);
      first = i;
    }
  }
  const blocks = await Promise.all(runs.map(([from, to]) =>
    readValues(positions[from], positions[to - 1] + 1)));
  runs.forEach(([from, to], run) => {
    const block = blocks[run];
    const base = positions[from];
    for (let i = from; i < to; i++) visit(i, block[positions[i] - base]);
  });
}

/**
 * The cost model that decides between reading genes' value ranges and
 * reading every value once, in bytes of transfer over the link as measured
 * (`formats/io/link.js`): a request costs a round trip (`roundTripBytes`,
 * bandwidth x latency), requests run `concurrency` at once, and value ranges
 * closer than the link's merge gap are fetched as one request. Value ranges
 * cost their stored (compressed) bytes, as the file holds them. The genes
 * asked for in the same task are weighed together: when their ranges would
 * cost more than every value, every value is read once (and every later gene
 * is then answered from memory). A choice of strategy, not a limit.
 *
 * Until the link is measured (or for an index given no link), it is a web
 * host's prior (`REMOTE_POLICY`), whose merge gap is a round trip's worth
 * shared by the requests in flight.
 *
 * @typedef {{mergeGapBytes: number, roundTripBytes: number|null, concurrency: number}} RequestCosts
 */
const PRIOR_COSTS = Object.freeze({
  mergeGapBytes: REMOTE_POLICY.mergeGapBytes,
  roundTripBytes: null,
  concurrency: REMOTE_POLICY.concurrency,
});

/** The bytes one round trip is worth on a link (`RequestCosts`). */
function roundTripBytesOf(costs) {
  return costs.roundTripBytes ?? costs.mergeGapBytes * costs.concurrency;
}

/** Entries per read when every value is read once, all reads asked at once. A scheduling choice. */
const WHOLE_VALUES_STEP = 1 << 20;

/**
 * What reading `count` sorted positions as runs costs, in bytes of transfer:
 * the stored bytes of the runs (each rounded up by about a chunk, as whole
 * chunks are read), and a round trip per wave of requests, counting runs
 * closer than the link's merge gap as one request, as the byte reader
 * fetches them.
 *
 * @param {Float64Array} positions
 * @param {number} count
 * @param {number} storedBytesPerEntry
 * @param {RequestCosts} costs
 */
function rangedCost(positions, count, storedBytesPerEntry, costs) {
  const requestGapEntries = costs.mergeGapBytes / storedBytesPerEntry;
  let requests = 1;
  let span = 0;
  let first = 0;
  for (let i = 1; i <= count; i++) {
    if (i === count || positions[i] - positions[i - 1] > VALUE_RUN_GAP_ENTRIES) {
      span += positions[i - 1] - positions[first] + 1 + VALUE_RUN_GAP_ENTRIES;
      first = i;
    }
    if (i < count && positions[i] - positions[i - 1] > requestGapEntries) requests++;
  }
  return Math.ceil(requests / costs.concurrency) * roundTripBytesOf(costs) + span * storedBytesPerEntry;
}

/** Resolves on a later task, after every read asked for in this one. */
function nextTask() {
  return new Promise(resolve => (typeof setImmediate === 'function' ? setImmediate(resolve) : setTimeout(resolve, 0)));
}

/**
 * The row holding entry `position` of a row-major matrix with row
 * `pointers`, searching forward from `row` (galloping, then bisecting): the
 * entries of one column rise with their rows.
 */
function rowFrom(pointers, nRows, position, row) {
  let low = row + 1;
  let step = 1;
  let high = Math.min(nRows, low + step);
  while (pointers[high] <= position) {
    low = high;
    step *= 2;
    high = Math.min(nRows, low + step);
  }
  // pointers[low] <= position < pointers[high]: the last row starting at or before it.
  while (high - low > 1) {
    const middle = (low + high) >>> 1;
    if (pointers[middle] <= position) low = middle;
    else high = middle;
  }
  return low;
}

/**
 * The structure of a sparse column store in memory: the entry positions of
 * every column, without the values, which are read on demand
 * (`readValues(start, end)`), and the row pointers that place each entry in
 * its row. For a matrix read over a link slower than a disk: a gene fetches
 * only the ranges its entries occupy. Genes spread over much of the matrix (common
 * ones, or many at once) would fetch most values anyway, so they read them
 * all once (`_wholeValues`), and every later gene is answered from memory.
 */
class MemorySparseStructure {
  /**
   * @param {number} nRows
   * @param {number} nCols
   * @param {Float64Array} columnStart - Entries of column `c` are `columnStart[c]..columnStart[c+1]`
   * @param {Float64Array} rowPointers - The matrix's row pointers (`nRows + 1`)
   * @param {(start: number, end: number) => Promise<ArrayLike<number>>} readValues
   * @param {Promise<number|null>} storedValueBytes - Stored bytes of every value (null when unknown)
   * @param {() => RequestCosts} costs - What a request costs on the link now
   * @param {string} label
   */
  constructor(nRows, nCols, columnStart, rowPointers, readValues, storedValueBytes, costs, label) {
    const nnz = columnStart[nCols];
    this.nRows = nRows;
    this.nCols = nCols;
    this._nnz = nnz;
    this._label = label;
    this._columnStart = columnStart;
    this._rowPointers = rowPointers;
    this._readValues = readValues;
    this._costs = costs;
    // Unknown stored sizes count as float32.
    this._storedValueBytes = storedValueBytes.then(bytes => (bytes > 0 ? bytes : nnz * 4), () => nnz * 4);
    /** @type {{cost: number, wholeIsCheaper: Promise<boolean>}|null} Genes asked for in this task */
    this._batch = null;
    /** @type {Promise<Float32Array[]>|null} Every value, by entry position, once read */
    this._wholeValues = null;
    /** Bytes of value ranges read so far (`_wholeIsCheaper`). */
    this._rangedSpent = 0;
    this._next = allocateTypedArray(Float64Array, nCols, `${label} column cursor`);
    this._next.set(columnStart.subarray(0, nCols));
    // Entry positions: exact to 2^32 entries in 32 bits, beyond that in 64.
    const PositionArray = nnz <= 0xffffffff ? Uint32Array : Float64Array;
    this._positions = allocateSegments(PositionArray, nnz, `${label} entry positions`);
    this.kind = 'memory';
    this.bytes = columnStart.byteLength + rowPointers.byteLength + nnz * PositionArray.BYTES_PER_ELEMENT;
  }

  writeSlab(slab, indices, label) {
    const { rowStart, rowEnd, pointers, pointerOffset, entryStart } = slab;
    const next = this._next;
    const end = this._columnStart;
    const nCols = this.nCols;
    const single = this._positions.length === 1 ? this._positions[0] : null;
    // A slab's rows hold one run of entries.
    const to = pointers[pointerOffset + rowEnd - rowStart] - entryStart;
    for (let entry = pointers[pointerOffset] - entryStart; entry < to; entry++) {
      const column = indices[entry];
      if (!(column >= 0 && column < nCols) || next[column] >= end[column + 1]) {
        throw new Error(`${label} changed while it was read; reopen the file`);
      }
      const destination = next[column]++;
      if (single !== null) {
        single[destination] = entryStart + entry;
      } else {
        const segment = Math.floor(destination / SEGMENT_ELEMENTS);
        this._positions[segment][destination - segment * SEGMENT_ELEMENTS] = entryStart + entry;
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

  async column(column) {
    const result = new Float32Array(this.nRows);
    const { rows, values, count } = await this._entries(column);
    for (let i = 0; i < count; i++) result[rows[i]] = addFloat32(result[rows[i]], values[i]);
    return result;
  }

  async sparseColumn(column) {
    const { rows, values, count } = await this._entries(column);
    return sparseColumnOf(rows, values, count, this.nRows);
  }

  /**
   * One column's entries: their rows (ascending) and values (as stored),
   * read from memory when every value is, else as the ranges they occupy.
   * @private
   */
  async _entries(column) {
    const start = this._columnStart[column];
    const count = this._columnStart[column + 1] - start;
    if (count === 0) return { rows: new Uint32Array(0), values: new Float64Array(0), count };
    const rows = new Uint32Array(count);
    const values = new Float64Array(count);
    const positions = new Float64Array(count);
    const pointers = this._rowPointers;
    let row = 0;
    for (let i = 0; i < count; i++) {
      const at = start + i;
      const segment = Math.floor(at / SEGMENT_ELEMENTS);
      const position = this._positions[segment][at - segment * SEGMENT_ELEMENTS];
      positions[i] = position;
      if (pointers[row + 1] <= position) row = rowFrom(pointers, this.nRows, position, row);
      rows[i] = row;
    }
    if (this._wholeValues === null && await this._wholeIsCheaper(positions, count) && this._wholeValues === null) {
      this._wholeValues = this._readWholeValues();
      this._wholeValues.catch(() => { this._wholeValues = null; });
    }
    if (this._wholeValues !== null) {
      const segments = await this._wholeValues;
      for (let i = 0; i < count; i++) {
        const segment = Math.floor(positions[i] / SEGMENT_ELEMENTS);
        values[i] = segments[segment][positions[i] - segment * SEGMENT_ELEMENTS];
      }
      return { rows, values, count };
    }
    await readValuesAt(positions, count, this._readValues, (i, value) => {
      values[i] = value;
    });
    return { rows, values, count };
  }

  /**
   * Whether every value read once costs less than the ranges of this gene
   * and of every other gene asked for in the same task. @private
   */
  async _wholeIsCheaper(positions, count) {
    const storedValueBytes = await this._storedValueBytes;
    const costs = this._costs();
    const cost = rangedCost(positions, count, storedValueBytes / this._nnz, costs);
    if (this._batch === null) {
      const batch = { cost: 0, wholeIsCheaper: null };
      batch.wholeIsCheaper = nextTask().then(() => {
        if (this._batch === batch) this._batch = null;
        // Ranges already read count too (rent until renting has cost what
        // buying does): once they and this task's together would pay for
        // every value, every value is read, and every later gene reads
        // nothing. At most twice the cheaper choice in hindsight. At a tie
        // every value wins.
        const whole = batch.cost + this._rangedSpent >= storedValueBytes + roundTripBytesOf(costs);
        if (!whole) this._rangedSpent += batch.cost;
        return whole;
      });
      this._batch = batch;
    }
    this._batch.cost += cost;
    return this._batch.wholeIsCheaper;
  }

  /** Every value, in entry order, read once in steps asked for at once. @private */
  async _readWholeValues() {
    const segments = allocateSegments(Float32Array, this._nnz, `${this._label} values`);
    const reads = [];
    for (let start = 0; start < this._nnz; start += WHOLE_VALUES_STEP) {
      const end = Math.min(this._nnz, start + WHOLE_VALUES_STEP);
      reads.push(this._readValues(start, end).then(values => {
        let at = start;
        let from = 0;
        while (from < values.length) {
          const segment = Math.floor(at / SEGMENT_ELEMENTS);
          const offset = at - segment * SEGMENT_ELEMENTS;
          const count = Math.min(values.length - from, SEGMENT_ELEMENTS - offset);
          segments[segment].set(values.subarray(from, from + count), offset);
          from += count;
          at += count;
        }
      }));
    }
    await Promise.all(reads);
    this.bytes += this._nnz * 4;
    return segments;
  }

  dispose() {
    this._positions = [];
    this._rowPointers = null;
    this._wholeValues = null;
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

  sparseColumn(column) {
    return sparseColumnOfDense(this.column(column));
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

  sparseColumn(column) {
    const start = this._columnStart[column];
    const count = this._columnStart[column + 1] - start;
    const rows = new Uint32Array(count);
    const values = new Float32Array(count);
    if (count > 0) {
      this._handles.rows.read(rows, { at: start * 4 });
      this._handles.values.read(values, { at: start * 4 });
    }
    return sparseColumnOf(rows, values, count, this.nRows);
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

  sparseColumn(column) {
    return sparseColumnOfDense(this.column(column));
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
 * The items of `items`, each with `fetch(item)` resolved, fetching the next
 * item's data before the current one is handed out: reading and decoding the
 * next slab overlaps with processing this one. A read-ahead of one slab keeps
 * at most two slabs resident; `depth` slabs ahead keep `depth + 1`.
 *
 * @template T, D
 * @param {AsyncIterable<T>|Iterable<T>} items
 * @param {(item: T) => Promise<D>} fetch
 * @param {number} [depth] - Items fetched ahead of the one handed out
 * @returns {AsyncGenerator<{item: T, data: D}>}
 */
async function* withReadAhead(items, fetch, depth = 1) {
  const iterator = (items[Symbol.asyncIterator] ?? items[Symbol.iterator]).call(items);
  const pull = async () => {
    const { value, done } = await iterator.next();
    if (done) return null;
    const data = Promise.resolve().then(() => fetch(value));
    data.catch(() => {});
    return { item: value, data };
  };
  const ahead = [];
  let exhausted = false;
  const fill = async count => {
    while (!exhausted && ahead.length < count) {
      const next = await pull();
      if (next === null) exhausted = true;
      else ahead.push(next);
    }
  };
  await fill(1);
  while (ahead.length > 0) {
    const current = ahead.shift();
    await fill(depth);
    yield { item: current.item, data: await current.data };
  }
}

function* denseSlabs(nRows, rowsPerSlab) {
  for (let rowStart = 0; rowStart < nRows; rowStart += rowsPerSlab) {
    yield { rowStart, rowEnd: Math.min(nRows, rowStart + rowsPerSlab) };
  }
}

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
   * Every reader returns a promise of the values read from the store.
   * @param {(start: number, end: number) => Promise<ArrayLike<number|bigint>>} [options.readRowPointers]
   * @param {(start: number, end: number) => Promise<ArrayLike<number|bigint>>} [options.readIndices]
   * @param {(start: number, end: number) => Promise<Float32Array>} [options.readValues]
   * @param {(rowStart: number, rowEnd: number) => Promise<Float32Array>} [options.readRows] - Dense only
   * @param {Object} options.storeFactory - `createColumnStoreFactory`
   * @param {boolean} [options.valuesOnDemand] - Sparse only: index the structure
   *   and read each gene's values as it is asked for (a matrix read over a
   *   link slower than a disk); the indices are kept within
   *   `retainIndicesBytes` to build it
   * @param {() => Promise<number|null>} [options.valuesStoredBytes] - With
   *   `valuesOnDemand`: the stored (compressed) bytes of every value, which
   *   weigh reading genes' value ranges against reading every value once
   * @param {(() => RequestCosts|null)|null} [options.link] - With
   *   `valuesOnDemand`: what a request costs on the link now (a `LinkMeter`
   *   snapshot), for that weighing and for how many slabs are read at once
   * @param {number} [options.slabEntries] - Entries per step (a scheduling choice)
   * @param {(waited: boolean) => Promise<void>} [options.yieldControl] - Called between
   *   parts of the work, with whether a read waits for the index
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
    this._retainedValues = null;
    /** @type {Float64Array|null} Where each column's entries start, once counted */
    this._columnStart = null;
    /** Share of the build done (its progress). */
    this._done = 0;
    /** Entries one part of a slab's work handles (`_sliced`), from its measured rate. */
    this._sliceEntries = 1 << 16;
    this.phase = 'idle';
  }

  /** Whether a sparse matrix's values stay in the file until a gene needs them. */
  get valuesOnDemand() {
    return this._options.valuesOnDemand === true;
  }

  /** What a request costs on the link now (`PRIOR_COSTS` until it is measured). @private */
  _costs() {
    const link = this._options.link?.() ?? null;
    if (link === null || !link.measured) return PRIOR_COSTS;
    // Requests that really run at once: an HTTP/1.1 host runs six of the
    // many dispatched to it until it is shown to multiplex.
    return { mergeGapBytes: link.mergeGapBytes, roundTripBytes: link.roundTripBytes, concurrency: link.shapingConcurrency ?? link.concurrency };
  }

  /**
   * Slabs of indices read ahead over a slower link: enough that their bytes
   * fill one round trip (the bandwidth-delay product), at most as many as
   * background requests run at once. @private
   */
  _slabsAhead() {
    const link = this._options.link?.() ?? null;
    const slabBytes = (this._options.slabEntries ?? (1024 * 1024)) * 4;
    const running = link?.backgroundConcurrency ?? link?.concurrency ?? PRIOR_COSTS.concurrency;
    const filling = link?.measured && link.roundTripBytes !== null
      ? Math.ceil(link.roundTripBytes / slabBytes) + 1
      : running;
    return Math.max(1, Math.min(running, filling));
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
   * One column as its non-zero entries (`SparseColumn`): from the store once
   * it is built, else extracted from the passes under way as `column` is.
   *
   * @param {number} column
   * @returns {Promise<SparseColumn>}
   */
  sparseColumn(column) {
    if (this.phase === 'ready' && this._failure === null &&
        Number.isSafeInteger(column) && column >= 0 && column < this.nCols) {
      return Promise.resolve(this._store.sparseColumn(column));
    }
    return this.column(column).then(sparseColumnOfDense);
  }

  /**
   * The stored entries of `column` once pass 1 has counted them (a sparse
   * matrix), else null: what reading it from the index costs.
   *
   * @param {number} column
   * @returns {number|null}
   */
  entryCount(column) {
    const start = this._columnStart;
    return start === null ? null : start[column + 1] - start[column];
  }

  /** Bytes the built store holds in memory (null until it is built; 0 on disk). */
  get storeBytes() {
    return this.phase === 'ready' ? (this._store.kind === 'memory' ? this._store.bytes : 0) : null;
  }

  /** The share of the build still to do, 0 once it is built. */
  get remaining() {
    if (this.phase === 'ready') return 0;
    return 1 - this._done;
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
    this._done = total > 0 ? done / total : 1;
    this._options.onProgress?.({
      kind: 'transpose',
      label: this._label,
      phase: this.phase,
      done,
      total,
    });
  }

  async _checkpoint() {
    // Whether a read waits for this index (it then goes on whatever else runs).
    await this._options.yieldControl?.(this._requests.size > 0);
    if (this._disposed) {
      throw new Error(`${this._label} was released; the request was superseded`);
    }
  }

  /**
   * Run `work` over a slab's rows in parts of about `INDEX_SLICE_MS` each,
   * yielding between parts, so a read someone waits for (a field, an
   * embedding) is served within a part of the index's work, not a whole
   * slab. The part size follows the measured rate of the work. @private
   */
  async _sliced(slab, work) {
    const { rowStart, rowEnd, pointers, pointerOffset } = slab;
    let row = rowStart;
    while (row < rowEnd) {
      const target = pointers[pointerOffset + row - rowStart] + this._sliceEntries;
      let end = row + 1;
      while (end < rowEnd && pointers[pointerOffset + end - rowStart] < target) end++;
      const started = performance.now();
      work({ ...slab, rowStart: row, rowEnd: end, pointerOffset: pointerOffset + row - rowStart });
      const entries = pointers[pointerOffset + end - rowStart] - pointers[pointerOffset + row - rowStart];
      const elapsed = performance.now() - started;
      if (entries > 0 && elapsed > 0) {
        this._sliceEntries = Math.max(1, Math.round(entries * INDEX_SLICE_MS / elapsed));
      }
      row = end;
      if (row < rowEnd) await this._checkpoint();
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
    const slabEntries = this._options.slabEntries ?? (1024 * 1024);
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
    const slabs = withReadAhead(denseSlabs(nRows, rowsPerSlab), slab => readRows(slab.rowStart, slab.rowEnd));
    for await (const { item: { rowStart, rowEnd }, data: block } of slabs) {
      if (store === null && this._requests.size === 0) break;
      const active = this._active();
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
            const slabEntries = this._options.slabEntries ?? (1024 * 1024);
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
    const slabEntries = this._options.slabEntries ?? (1024 * 1024);
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

  /**
   * Extract the active requests' entries from one slab, reading only the
   * values of their entries (`valuesOnDemand`).
   */
  async _extractOnDemand(active, slab, indices) {
    const { rowStart, rowEnd, pointers, pointerOffset, entryStart } = slab;
    const requests = [...active.values()];
    this._lookup ??= new Int32Array(this.nCols).fill(-1);
    const lookup = this._lookup;
    requests.forEach((request, index) => { lookup[request.column] = index; });
    let count = 0;
    let positions = new Float64Array(64);
    let rows = new Uint32Array(64);
    let owners = new Int32Array(64);
    const grow = (array, Type) => {
      const next = new Type(array.length * 2);
      next.set(array);
      return next;
    };
    try {
      for (let row = rowStart; row < rowEnd; row++) {
        const local = pointerOffset + row - rowStart;
        const from = pointers[local] - entryStart;
        const to = pointers[local + 1] - entryStart;
        for (let entry = from; entry < to; entry++) {
          const owner = lookup[indices[entry]];
          if (owner < 0) continue;
          if (count === positions.length) {
            positions = grow(positions, Float64Array);
            rows = grow(rows, Uint32Array);
            owners = grow(owners, Int32Array);
          }
          positions[count] = entryStart + entry;
          rows[count] = row;
          owners[count] = owner;
          count++;
        }
      }
    } finally {
      for (const request of requests) lookup[request.column] = -1;
    }
    await readValuesAt(positions, count, this._options.readValues, (i, value) => {
      const target = requests[owners[i]].values;
      target[rows[i]] = addFloat32(target[rows[i]], value);
    });
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
    // Kept indices are narrowed to the smallest type holding a column (a
    // matrix of up to 65,536 genes keeps 2 bytes an entry, not 4).
    const KeptIndex = nCols <= 0x100 ? Uint8Array : (nCols <= 0x10000 ? Uint16Array : Uint32Array);
    // What pass 1 keeps for pass 2 shares the index budget with the store
    // pass 2 fills (8 bytes an entry): together they never exceed it.
    const onDemandStructure = this._options.valuesOnDemand === true;
    const keepBudget = Math.max(0, (this._options.retainIndicesBytes ?? 0) -
      (onDemandStructure ? 0 : nnz * 8 + nCols * 16));
    const retained = nnz * KeptIndex.BYTES_PER_ELEMENT <= keepBudget ? [] : null;
    // Values read in this pass for a waiting gene are kept for pass 2 too
    // (float32, as the store holds them) within the same budget, so no slab
    // is decoded twice.
    const keptValues = [];
    let keptBytes = retained === null ? 0 : nnz * KeptIndex.BYTES_PER_ELEMENT;
    let slabNumber = -1;
    const onDemand = this._options.valuesOnDemand === true;
    // The slabs whose indices are kept, to place them in the structure, and
    // the row pointers that place each entry in its row.
    const slabs = onDemand && retained !== null ? [] : null;
    const rowPointers = slabs === null ? null : allocateTypedArray(Float64Array, nRows + 1, `${label} row pointers`);
    // Over a link slower than a disk, slabs are read as many at once as
    // requests run, so the link stays full; a waiting gene's values are
    // fetched beside them, without holding up the next slab.
    const extractions = [];
    let extractionFailure = null;
    // As many slabs ahead as fill the link's bandwidth-delay product (one
    // round trip's worth of bytes), and no more than background reads run.
    const slabsAhead = onDemand ? this._slabsAhead() : 1;
    for await (const { item: slab, data: indices } of withReadAhead(this._rowSlabs(), readSlabIndices, slabsAhead)) {
      if (extractionFailure !== null) throw extractionFailure;
      slabNumber++;
      const active = this._active();
      const integral = indices instanceof Int32Array || indices instanceof Uint32Array ||
        indices instanceof Uint16Array || indices instanceof Uint8Array ||
        indices instanceof Int16Array || indices instanceof Int8Array;
      await this._sliced(slab, part => {
        const from = part.pointers[part.pointerOffset] - part.entryStart;
        const to = part.pointers[part.pointerOffset + part.rowEnd - part.rowStart] - part.entryStart;
        for (let index = from; index < to; index++) {
          const column = indices[index];
          if (!(column >= 0 && column < nCols) || (!integral && !Number.isInteger(column))) {
            throw new RangeError(
              `Sparse matrix column index ${column} at entry ${slab.entryStart + index} is outside its ` +
              `${nCols}-column shape`
            );
          }
          counts[column]++;
        }
      });
      if (retained !== null) retained.push(indices instanceof KeptIndex ? indices : KeptIndex.from(indices));
      if (slabs !== null) {
        slabs.push(slab);
        for (let row = slab.rowStart; row <= slab.rowEnd; row++) {
          rowPointers[row] = slab.pointers[slab.pointerOffset + row - slab.rowStart];
        }
      }
      if (active !== null) {
        if (onDemand) {
          const extraction = this._extractOnDemand(active, slab, indices);
          extraction.catch(error => { extractionFailure ??= error; });
          extractions.push(extraction);
        } else {
          const values = await readSlabValues(slab);
          this._extract(active, slab, indices, values);
          if (keptBytes + values.length * 4 <= keepBudget) {
            keptValues[slabNumber] = values instanceof Float32Array ? values : Float32Array.from(values);
            keptBytes += values.length * 4;
          }
        }
      }
      this._progress(slab.entryEnd, onDemand ? nnz : 2 * nnz);
      await this._checkpoint();
    }
    await Promise.all(extractions);
    const columnStart = allocateTypedArray(Float64Array, nCols + 1, `${label} column index`);
    for (let column = 0; column < nCols; column++) {
      columnStart[column + 1] = columnStart[column] + counts[column];
    }
    this._columnStart = columnStart;

    // Over a link slower than a disk, with every slab's indices kept: the structure is
    // built from them here, and values are read per gene from now on.
    if (slabs !== null) {
      this.phase = 'indexing';
      const storedValueBytes = Promise.resolve().then(() => this._options.valuesStoredBytes?.() ?? null);
      storedValueBytes.catch(() => {});
      const structure = new MemorySparseStructure(nRows, nCols, columnStart, rowPointers, readValues, storedValueBytes, () => this._costs(), label);
      this._filling = structure;
      slabs.forEach((slab, index) => {
        structure.writeSlab(slab, retained[index], label);
        retained[index] = null;
      });
      structure.finish(label);
      this._filling = null;
      this._store = structure;
      this.phase = 'ready';
      this._resolveFromStore();
      return;
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
    this._retainedValues = keptValues;
    await this._sparseScan(store);
    this._retainedIndices = null;
    this._retainedValues = null;
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
    const retainedValues = store !== null ? this._retainedValues : null;
    let slabNumber = 0;
    const slabs = withReadAhead(this._rowSlabs(), slab => {
      const number = slabNumber++;
      const kept = retained?.[number] ?? null;
      if (retained) retained[number] = null;
      const keptValues = retainedValues?.[number] ?? null;
      if (keptValues !== null) retainedValues[number] = null;
      return Promise.all([
        kept ?? readIndices(slab.entryStart, slab.entryEnd),
        keptValues ?? readValues(slab.entryStart, slab.entryEnd),
      ]);
    });
    for await (const { item: slab, data: [indices, values] } of slabs) {
      if (store === null && this._requests.size === 0) break;
      const active = this._active();
      if (indices.length !== slab.entryEnd - slab.entryStart ||
          values.length !== slab.entryEnd - slab.entryStart) {
        throw new Error(`${label} payload slab does not match its selection`);
      }
      await this._sliced(slab, part => {
        if (store !== null) store.writeSlab(part, indices, values, label);
        this._extract(active, part, indices, values);
      });
      this._progress(nnz + slab.entryEnd, 2 * nnz);
      await this._checkpoint();
    }
  }
}
