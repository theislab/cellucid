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
 * budget, otherwise in the origin-private file system (OPFS, disk-backed)
 * when the site's storage quota has room for it, and if neither can hold it,
 * columns are answered by scanning: the reason goes out with the progress
 * and each scan is announced (`onUnindexedScan`), never a silent wait. How
 * a matrix will be indexed, and so what its first gene costs, is known before
 * anything is read (`sparseIndexPlan`, `createColumnStoreFactory().plan`).
 *
 * A build asked for by genes (not ahead of need) stops when every gene it
 * was for withdrew (`column(…, {signal})`) before any gene was served from
 * it: its reads are let go, those still queued never sent, what it kept is
 * released, and the next gene starts a new build. Once a gene was served
 * (at the end of pass 1), the build goes on whoever waits: its work is paid. A matrix
 * presented as a subsample's kept rows (`views/cell-subset.js`) is indexed
 * as the smaller matrix it is: over the kept rows only, reading only the
 * stored chunks that hold them.
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
 * own entries' values from each slab, beside the pass, or the slab's values
 * whole when its entries spread over the slab (a common gene), and that slab
 * is kept: no later gene reads it again. The values are downloaded whole
 * once the ranges already read and those the genes asked for together would
 * cost as much as the values no slab kept.
 *
 * @module data/sparse-column-index
 */

import { REMOTE_POLICY } from '../formats/io/byte-source.js';
import { roundTripBytesOf } from '../formats/io/link.js';
import { recordAllocationFailure, recordAllocationSuccess } from './memory-budget.js';
import { allocateLargeArray } from '../utils/large-arrays.js';
import { formatBytes, formatCountOf } from '../utils/format-units.js';
import { matchesChecksum } from '../formats/io/page-checks.js';
import { AnnDataFormatError } from './anndata/elements.js';
import { readWhole, requireHeld, writeAt } from '../formats/io/sync-access.js';
import { abortReason, cancelled, onAbort } from '../utils/abort.js';
import { measureOf } from '../utils/machine.js';
import { yieldToMacrotask } from '../utils/yield-macrotask.js';
import { promiseWithResolvers } from '../utils/promise-resolvers.js';

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
 * Allocate one typed array, larger than one `ArrayBuffer` where the engine
 * caps it (`allocateLargeArray`: a WebAssembly memory then), reporting a
 * refused allocation with the bytes it needed and what it was for, and to the
 * memory model (`memory-budget.js`, `recordAllocationFailure`); a granted one
 * is evidence the model hears of while a refusal lowers the allowance
 * (`recordAllocationSuccess`).
 *
 * @template T
 * @param {import('../utils/large-arrays.js').TypedArrayConstructor<T>} ArrayType
 * @param {number} length
 * @param {string} label
 * @returns {T}
 */
export function allocateTypedArray(ArrayType, length, label) {
  let array;
  try {
    array = allocateLargeArray(ArrayType, length);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const bytes = length * ArrayType.BYTES_PER_ELEMENT;
    // The memory model takes the refusal as its signal, in every thread.
    recordAllocationFailure(bytes);
    const failure = new RangeError(
      `${label} needs ${formatCountOf(bytes, 'byte')}, more memory than ` +
      'the browser could allocate.'
    );
    failure.code = 'TOO_LARGE';
    failure.bytes = bytes;
    throw failure;
  }
  recordAllocationSuccess(length * ArrayType.BYTES_PER_ELEMENT);
  return array;
}

/**
 * A copy of `values` (a typed array or an array of numbers) as an
 * `ArrayType` (`allocateTypedArray`): what `ArrayType.from(values)` makes, at
 * any size the page can hold.
 */
export function copyTypedArray(ArrayType, values, label) {
  const out = allocateTypedArray(ArrayType, values.length, label);
  out.set(values);
  return out;
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
  let indices = allocateTypedArray(Uint32Array, count, 'Gene column cells');
  let sums = allocateTypedArray(Float32Array, count, 'Gene column values');
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
    const keptIndices = allocateTypedArray(Uint32Array, kept, 'Gene column cells');
    const keptSums = allocateTypedArray(Float32Array, kept, 'Gene column values');
    keptIndices.set(indices.subarray(0, kept));
    keptSums.set(sums.subarray(0, kept));
    indices = keptIndices;
    sums = keptSums;
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
  const indices = allocateTypedArray(Uint32Array, count, 'Gene column cells');
  const values = allocateTypedArray(Float32Array, count, 'Gene column values');
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
  // An empty range of a store with no entries has no segment to view.
  if (end === start) return { rows: new Uint32Array(0), values: new Float32Array(0) };
  const segment = Math.floor(start / SEGMENT_ELEMENTS);
  const offset = start - segment * SEGMENT_ELEMENTS;
  if (offset + (end - start) <= rowSegments[segment].length) {
    return {
      rows: rowSegments[segment].subarray(offset, offset + end - start),
      values: valueSegments[segment].subarray(offset, offset + end - start),
    };
  }
  const rows = allocateTypedArray(Uint32Array, end - start, 'Gene column cells');
  const values = allocateTypedArray(Float32Array, end - start, 'Gene column values');
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
    const result = allocateTypedArray(Float32Array, this.nRows, 'Gene column');
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

  /** What a gene index kept in this browser holds of this store (`KeptParts`). */
  keptParts() {
    return keptPartsOf('sparse', this, [
      keptArray('columnStart', [this._columnStart]),
      keptArray('rows', this._rows),
      keptArray('values', this._values),
    ]);
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
 * bandwidth x latency), requests run `shapingConcurrency` at once, and value ranges
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
 * @typedef {{mergeGapBytes: number, roundTripBytes: number|null, shapingConcurrency: number}} RequestCosts
 */
const PRIOR_COSTS = Object.freeze({
  mergeGapBytes: REMOTE_POLICY.mergeGapBytes,
  roundTripBytes: null,
  shapingConcurrency: REMOTE_POLICY.concurrency,
});

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
  return Math.ceil(requests / costs.shapingConcurrency) * roundTripBytesOf(costs) + span * storedBytesPerEntry;
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
 * The structure of a sparse column store: the entry positions of every
 * column, without the values, which are read on demand
 * (`readValues(start, end)`), and the row pointers that place each entry in
 * its row. For a matrix read over a link slower than a disk: a gene fetches
 * only the ranges its entries occupy. Genes spread over much of the matrix (common
 * ones, or many at once) would fetch most values anyway, so they read them
 * all once (`_wholeValues`), and every later gene is answered from memory.
 *
 * Where the positions are is the subclass's: in memory, written by the
 * index's pass (`MemorySparseStructure`), or in a gene index kept in this
 * browser from an earlier opening (`KeptSparseStructure`: held in memory
 * once read whole, else read in runs of genes asked for together).
 */
class SparseStructure {
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
    /** @type {Promise<Array<{start: number, end: number, values: Float32Array}>>|null} Every value, by entry range, once read */
    this._wholeValues = null;
    /** Bytes of value ranges read so far (`_wholeIsCheaper`). */
    this._rangedSpent = 0;
    /** @type {Array<{start: number, end: number, values: Float32Array}>} Values the pass read whole, by entry range, ascending */
    this._kept = [];
    this._keptEntries = 0;
    /**
     * Every value, by entry range (ascending, covering every entry), once
     * all are held: bought with the first gene (`adopt`) or read whole
     * since (`_readWholeValues`). A structure that holds them is kept with
     * them (`keptParts`), so a later opening reads none again.
     * @type {Array<{start: number, end: number, values: Float32Array}>|null}
     */
    this._valueRanges = null;
    /** Told once every value is held after the structure was built (`_readWholeValues`): it may be kept again, with them. */
    this.onValuesHeld = null;
    this.bytes = columnStart.byteLength + rowPointers.byteLength;
  }

  /**
   * The entry positions of entries `[start, start + count)` of the column
   * order, ascending within a column: every entry of column `_column` (a
   * kept copy checks each column's piece whole). @abstract
   * @returns {Promise<Float64Array>|Float64Array}
   */
  _positionsOf(_start, _count, _column) {
    throw new Error('A sparse structure says where its positions are.');
  }

  /**
   * What the indexing pass already read for genes asked for during it: the
   * slabs whose values it read whole (kept, and never read again), and the
   * bytes of the ranges it read (rent already paid, `_wholeIsCheaper`).
   * When the kept slabs hold every value, every gene is answered from
   * memory from now on.
   *
   * @param {Array<{start: number, end: number, values: Float32Array}>} kept
   * @param {number} spentBytes
   */
  adopt(kept, spentBytes) {
    this._kept = [...kept].sort((a, b) => a.start - b.start);
    this._keptEntries = this._kept.reduce((sum, range) => sum + range.end - range.start, 0);
    this._rangedSpent += spentBytes;
    this.bytes += this._keptEntries * 4;
    if (this._keptEntries === this._nnz && this._nnz > 0) {
      // Every value bought with the first gene: held now, kept with the structure.
      this._valueRanges = this._kept;
      this._wholeValues = this._readWholeValues();
      this._wholeValues.catch(() => { this._wholeValues = null; });
    }
  }

  /** Values `start..end`, from a slab kept whole when one holds them, else read. @private */
  _readValuesKept(start, end) {
    const kept = this._kept;
    let low = 0;
    let high = kept.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (kept[middle].end <= start) low = middle + 1;
      else high = middle;
    }
    const range = kept[low];
    if (range !== undefined && range.start <= start && end <= range.end) {
      return Promise.resolve(range.values.subarray(start - range.start, end - range.start));
    }
    return this._readValues(start, end);
  }

  async column(column) {
    const result = allocateTypedArray(Float32Array, this.nRows, 'Gene column');
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
    const stored = this._columnStart[column + 1] - start;
    if (stored === 0) return { rows: new Uint32Array(0), values: new Float64Array(0), count: 0 };
    const positions = await this._positionsOf(start, stored, column);
    const count = positions.length;
    const rows = allocateTypedArray(Uint32Array, count, 'Gene column cells');
    const values = allocateTypedArray(Float64Array, count, 'Gene column values');
    const pointers = this._rowPointers;
    let row = 0;
    for (let i = 0; i < count; i++) {
      const position = positions[i];
      if (pointers[row + 1] <= position) row = rowFrom(pointers, this.nRows, position, row);
      rows[i] = row;
    }
    if (this._wholeValues === null && await this._wholeIsCheaper(positions, count) && this._wholeValues === null) {
      this._wholeValues = this._readWholeValues();
      this._wholeValues.catch(() => { this._wholeValues = null; });
    }
    if (this._wholeValues !== null) {
      const ranges = await this._wholeValues;
      // Positions ascend: one walk through the ranges.
      let r = 0;
      for (let i = 0; i < count; i++) {
        while (ranges[r].end <= positions[i]) r++;
        values[i] = ranges[r].values[positions[i] - ranges[r].start];
      }
      return { rows, values, count };
    }
    await readValuesAt(positions, count, (from, to) => this._readValuesKept(from, to), (i, value) => {
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
    // Buying reads only the values no slab kept.
    const toBuy = storedValueBytes * (this._nnz - this._keptEntries) / this._nnz;
    if (this._batch === null) {
      const batch = { cost: 0, wholeIsCheaper: null };
      batch.wholeIsCheaper = yieldToMacrotask().then(() => {
        if (this._batch === batch) this._batch = null;
        // Ranges already read count too (rent until renting has cost what
        // buying does): once they and this task's together would pay for
        // every value, every value is read, and every later gene reads
        // nothing. At most twice the cheaper choice in hindsight. At a tie
        // every value wins.
        const whole = batch.cost + this._rangedSpent >= toBuy + roundTripBytesOf(costs);
        if (!whole) this._rangedSpent += batch.cost;
        return whole;
      });
      this._batch = batch;
    }
    this._batch.cost += cost;
    return this._batch.wholeIsCheaper;
  }

  /**
   * Every value, in entry order, as ranges `{start, end, values}` that
   * cover every entry: the slabs the pass kept, as they are (nothing is
   * copied), and the rest read once in steps asked for at once. @private
   */
  async _readWholeValues() {
    const ranges = [];
    const reads = [];
    let next = 0;
    const readGap = (from, to) => {
      for (let start = from; start < to; start += WHOLE_VALUES_STEP) {
        const end = Math.min(to, start + WHOLE_VALUES_STEP);
        const range = { start, end, values: null };
        ranges.push(range);
        reads.push(this._readValues(start, end).then(read => {
          range.values = read instanceof Float32Array ? read : copyTypedArray(Float32Array, read, 'Gene column values');
        }));
      }
    };
    for (const range of this._kept) {
      readGap(next, range.start);
      ranges.push(range);
      next = range.end;
    }
    readGap(next, this._nnz);
    await Promise.all(reads);
    this.bytes += (this._nnz - this._keptEntries) * 4;
    this._kept = [];
    const heldBefore = this._valueRanges !== null;
    this._valueRanges = ranges;
    // Read whole after the structure was built (and kept without them).
    if (!heldBefore) this.onValuesHeld?.();
    return ranges;
  }

  dispose() {
    this._rowPointers = null;
    this._wholeValues = null;
    this._valueRanges = null;
    this.onValuesHeld = null;
  }
}

/** The structure of a sparse column store, its positions in memory, written by the index's pass. */
class MemorySparseStructure extends SparseStructure {
  constructor(nRows, nCols, columnStart, rowPointers, readValues, storedValueBytes, costs, label) {
    super(nRows, nCols, columnStart, rowPointers, readValues, storedValueBytes, costs, label);
    const nnz = this._nnz;
    this._next = allocateTypedArray(Float64Array, nCols, `${label} column cursor`);
    this._next.set(columnStart.subarray(0, nCols));
    // Entry positions: exact to 2^32 entries in 32 bits, beyond that in 64.
    const PositionArray = nnz <= 0xffffffff ? Uint32Array : Float64Array;
    this._positions = allocateSegments(PositionArray, nnz, `${label} entry positions`);
    this.kind = 'memory';
    this.bytes += nnz * PositionArray.BYTES_PER_ELEMENT;
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

  _positionsOf(start, count) {
    const positions = allocateTypedArray(Float64Array, count, 'Gene column entry positions');
    for (let i = 0; i < count; i++) {
      const at = start + i;
      const segment = Math.floor(at / SEGMENT_ELEMENTS);
      positions[i] = this._positions[segment][at - segment * SEGMENT_ELEMENTS];
    }
    return positions;
  }

  /**
   * What is kept of it for a later opening: its entry positions alone
   * (`structure`: a gene's values are read from the file then), or, once
   * every value is held (`_valueRanges`), each gene's rows and values
   * (`sparse`), so a later opening reads a gene from the kept copy alone
   * and downloads none of what was bought. The rows and values are made a
   * piece at a time as they are written, in the column order of the
   * positions: no second copy of the store is held.
   */
  keptParts() {
    const ranges = this._valueRanges;
    if (ranges === null) {
      return keptPartsOf('structure', this, [
        keptArray('columnStart', [this._columnStart]),
        keptArray('positions', this._positions),
      ]);
    }
    const nnz = this._nnz;
    const nRows = this.nRows;
    const columnStart = this._columnStart;
    const pointers = this._rowPointers;
    const positionAt = at => {
      const segment = Math.floor(at / SEGMENT_ELEMENTS);
      return this._positions[segment][at - segment * SEGMENT_ELEMENTS];
    };
    // Entries `[at, at + count)` of the column order, each mapped by
    // `map(position, column, restart)`; a column's positions ascend, so its
    // walk goes forward from where it began (`restart` at a column's first).
    const pieces = function* pieces(map, ArrayType) {
      const perPiece = KEPT_PIECE_BYTES / ArrayType.BYTES_PER_ELEMENT;
      let column = 0;
      for (let at = 0; at < nnz; at += perPiece) {
        const count = Math.min(perPiece, nnz - at);
        const out = allocateTypedArray(ArrayType, count, 'A kept gene index piece');
        for (let i = 0; i < count; i++) {
          const entry = at + i;
          let restart = false;
          while (columnStart[column + 1] <= entry) {
            column++;
            restart = true;
          }
          out[i] = map(positionAt(entry), entry === columnStart[column] || restart || i === 0);
        }
        yield new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
      }
    };
    let row = 0;
    const rowOf = (position, restart) => {
      if (restart) row = pointers[1] > position ? 0 : rowFrom(pointers, nRows, position, 0);
      else if (pointers[row + 1] <= position) row = rowFrom(pointers, nRows, position, row);
      return row;
    };
    let r = 0;
    const valueOf = (position, restart) => {
      if (restart) {
        let low = 0;
        let high = ranges.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (ranges[middle].end <= position) low = middle + 1;
          else high = middle;
        }
        r = low;
      }
      while (ranges[r].end <= position) r++;
      return ranges[r].values[position - ranges[r].start];
    };
    return keptPartsOf('sparse', this, [
      keptArray('columnStart', [columnStart]),
      { name: 'rows', type: 'u32', length: nnz, pieces: () => pieces(rowOf, Uint32Array) },
      { name: 'values', type: 'f32', length: nnz, pieces: () => pieces(valueOf, Float32Array) },
    ]);
  }

  dispose() {
    super.dispose();
    this._positions = [];
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
    const result = allocateTypedArray(Float32Array, this.nRows, 'Gene column');
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

  keptParts() {
    return keptPartsOf('dense', this, [keptArray('values', this._values)]);
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
    this._groupStart = allocateTypedArray(Uint32Array, groups + 1, `${label} group starts`);
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
    // Sized as asked, or refused as the disk being full (`formats/io/sync-access.js`).
    requireHeld(handles.rows, nnz * 4);
    requireHeld(handles.values, nnz * 4);
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
    const counts = allocateTypedArray(Uint32Array, width + 1, 'Gene group column counts');
    for (let i = 0; i < buffer.length; i++) counts[buffer.columns[i] - first + 1]++;
    for (let c = 0; c < width; c++) counts[c + 1] += counts[c];
    const cursor = counts.slice(0, width);
    const rows = allocateTypedArray(Uint32Array, buffer.length, 'Gene group cells');
    const values = allocateTypedArray(Float32Array, buffer.length, 'Gene group values');
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
      writeAt(this._handles.rows, rows.subarray(start, end), position);
      writeAt(this._handles.values, values.subarray(start, end), position);
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
    const result = allocateTypedArray(Float32Array, this.nRows, 'Gene column');
    if (count === 0) return result;
    const rows = allocateTypedArray(Uint32Array, count, 'Gene column cells');
    const values = allocateTypedArray(Float32Array, count, 'Gene column values');
    readWhole(this._handles.rows, rows, start * 4);
    readWhole(this._handles.values, values, start * 4);
    for (let index = 0; index < count; index++) {
      result[rows[index]] = addFloat32(result[rows[index]], values[index]);
    }
    return result;
  }

  sparseColumn(column) {
    const start = this._columnStart[column];
    const count = this._columnStart[column + 1] - start;
    const rows = allocateTypedArray(Uint32Array, count, 'Gene column cells');
    const values = allocateTypedArray(Float32Array, count, 'Gene column values');
    if (count > 0) {
      readWhole(this._handles.rows, rows, start * 4);
      readWhole(this._handles.values, values, start * 4);
    }
    return sparseColumnOf(rows, values, count, this.nRows);
  }

  keptParts() {
    const nnz = this._columnStart[this.nCols];
    return keptPartsOf('sparse', this, [
      keptArray('columnStart', [this._columnStart]),
      keptFile('rows', this._handles.rows, nnz * 4),
      keptFile('values', this._handles.values, nnz * 4),
    ]);
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
    // Sized as asked, or refused as the disk being full (`formats/io/sync-access.js`).
    requireHeld(this._handle, nRows * nCols * 4);
    this.kind = 'disk';
    this.bytes = 0;
  }

  writeRows(rowStart, rowEnd, block) {
    const nCols = this.nCols;
    const height = rowEnd - rowStart;
    const run = allocateTypedArray(Float32Array, height, 'Gene column run');
    for (let column = 0; column < nCols; column++) {
      for (let row = 0; row < height; row++) run[row] = block[row * nCols + column];
      writeAt(this._handle, run, (column * this.nRows + rowStart) * 4);
    }
  }

  finish() {
    this._handle.flush();
  }

  column(column) {
    const result = allocateTypedArray(Float32Array, this.nRows, 'Gene column');
    readWhole(this._handle, result, column * this.nRows * 4);
    return result;
  }

  sparseColumn(column) {
    return sparseColumnOfDense(this.column(column));
  }

  keptParts() {
    return keptPartsOf('dense', this, [keptFile('values', this._handle, this.nRows * this.nCols * 4)]);
  }

  dispose() {
    try { this._handle.close(); } catch { /* already closed */ }
    this._handles.release?.();
  }
}

// ---------------------------------------------------------------------------
// Gene indexes kept in this browser (`anndata/kept-column-index.js`)
// ---------------------------------------------------------------------------

/** Bytes one piece of a kept array is written in (a scheduling choice: the reader thread takes other work between pieces). */
const KEPT_PIECE_BYTES = 16 * 1024 * 1024;

/**
 * @typedef {Object} KeptArray
 * @property {string} name - `columnStart`, `positions`, `rows` or `values`
 * @property {'f64'|'u32'|'f32'} type
 * @property {number} length - Elements
 * @property {() => Iterable<Uint8Array>} pieces - Its bytes, in order, a piece at a time
 *
 * @typedef {Object} KeptParts
 * @property {'structure'|'sparse'|'dense'} layout - Entry positions to read
 *   values from the file (`structure`), or the entries' rows and values
 *   (`sparse`), or every value (`dense`)
 * @property {number} nRows
 * @property {number} nCols
 * @property {number} nnz - Stored entries (`nRows * nCols` for `dense`)
 * @property {Float64Array|null} columnStart - Where each gene's entries
 *   start (`sparse`, `structure`): every per-gene array is stored a gene
 *   after another, each gene's piece checksummed apart
 * @property {KeptArray[]} arrays
 *
 * What a built column store keeps in this browser for a later opening of
 * the same rows of the same file (`keptParts()` of every store): its arrays,
 * little-endian as every engine holds them, each a piece at a time so a
 * store held on disk is never read into memory whole.
 */

const KEPT_TYPES = Object.freeze({ f64: Float64Array, u32: Uint32Array, f32: Float32Array });

function keptTypeOf(array) {
  if (array instanceof Float64Array) return 'f64';
  if (array instanceof Uint32Array) return 'u32';
  if (array instanceof Float32Array) return 'f32';
  throw new TypeError('A kept gene index holds float64, uint32 or float32 arrays.');
}

/** One array of a store in memory (its segments, one after another) as a `KeptArray`. */
function keptArray(name, segments) {
  return {
    name,
    type: keptTypeOf(segments[0] ?? new Float32Array(0)),
    length: segments.reduce((sum, segment) => sum + segment.length, 0),
    *pieces() {
      for (const segment of segments) {
        const bytes = new Uint8Array(segment.buffer, segment.byteOffset, segment.byteLength);
        for (let at = 0; at < bytes.length; at += KEPT_PIECE_BYTES) yield bytes.subarray(at, Math.min(bytes.length, at + KEPT_PIECE_BYTES));
      }
    },
  };
}

/** One float32 or uint32 file of a store on disk (a synchronous access handle) as a `KeptArray`. */
function keptFile(name, handle, byteLength) {
  return {
    name,
    type: name === 'rows' ? 'u32' : 'f32',
    length: byteLength / 4,
    *pieces() {
      for (let at = 0; at < byteLength; at += KEPT_PIECE_BYTES) {
        const piece = new Uint8Array(Math.min(KEPT_PIECE_BYTES, byteLength - at));
        yield readWhole(handle, piece, at);
      }
    },
  };
}

function keptPartsOf(layout, store, arrays) {
  return {
    layout,
    nRows: store.nRows,
    nCols: store.nCols,
    nnz: layout === 'dense' ? store.nRows * store.nCols : store._columnStart[store.nCols],
    columnStart: layout === 'dense' ? null : store._columnStart,
    arrays,
  };
}

/**
 * The error a kept gene index fails a read with when what it holds is not
 * what its manifest and the file say (damaged on disk): the index is let go
 * and built again (`RowMajorColumnIndex`), and the kept copy removed.
 */
function keptDamage(label, what) {
  const error = new Error(`The gene index of ${label} kept in this browser is damaged (${what}); it is built again.`);
  error.code = 'KEPT_INDEX_DAMAGED';
  return error;
}

/** Elements `[start, start + count)` of one kept per-gene array, as its type (not checked: `checkedPiece`). */
async function readKeptElements(kept, name, start, count) {
  const { type, read } = kept.arrays[name];
  const Type = KEPT_TYPES[type];
  if (count === 0) return new Type(0);
  const bytes = await read(start * Type.BYTES_PER_ELEMENT, count * Type.BYTES_PER_ELEMENT);
  if (bytes.length !== count * Type.BYTES_PER_ELEMENT) throw keptDamage(kept.label, `${name} is short`);
  if (bytes.byteOffset % Type.BYTES_PER_ELEMENT === 0) return new Type(bytes.buffer, bytes.byteOffset, count);
  const aligned = copyTypedArray(Uint8Array, bytes, `The kept ${name}`);
  return new Type(aligned.buffer, aligned.byteOffset, count);
}

/**
 * Gene `column`'s piece of one kept per-gene array, checked against the
 * CRC-32 written when it was kept (`KeptStore.checks`), so a damaged piece
 * is never served.
 */
function checkedPiece(kept, name, column, piece) {
  if (!matchesChecksum(new Uint8Array(piece.buffer, piece.byteOffset, piece.byteLength), kept.checks[name][column])) {
    throw keptDamage(kept.label, `the ${name} of gene ${column} do not match their checksum`);
  }
  return piece;
}

/**
 * Bytes between two pieces of a kept copy that one read still covers: a
 * read of the origin-private file system costs about a millisecond before
 * its first byte, in which a disk delivers about a mebibyte (measured:
 * 23_decisions_partial_reading.md). A scheduling choice, measured.
 */
const KEPT_READ_GAP_BYTES = 1 << 20;

/**
 * What reading kept copies whole has cost in this thread: what a kept copy
 * is priced at against building its index again (`keptReadMs`). Only reads
 * of at least a piece (`KEPT_PIECE_BYTES`) count, where the time before the
 * first byte is a small part of the read.
 */
const keptLoads = { bytes: 0, ms: 0 };

/**
 * What reading `bytes` of a kept copy is priced at, in ms, from the reads
 * measured in this thread; null until one is. The rate is the machine's
 * `keptReadBytesPerMs` (`utils/machine.js`): held, it is the held rate
 * (null: none measured, so a kept copy is read).
 */
function keptReadMs(bytes) {
  const held = measureOf('keptReadBytesPerMs', () => undefined);
  if (held !== undefined) return held === null ? null : bytes / held;
  return keptLoads.ms > 0 ? bytes * keptLoads.ms / keptLoads.bytes : null;
}

/**
 * The reads of one kept copy's per-gene arrays (`positions`, `rows`,
 * `values`), each gene's piece checked the first time it is served
 * (`checkedPiece`):
 *
 * - held whole once loaded (`prepare`): one read of each array, made when
 *   the first gene is asked for (or the index is wanted ahead of need) and
 *   the memory kept for gene indexes holds it, as it would hold the index
 *   built again; every gene from then on is a copy out of memory, exactly
 *   as from an index built in this opening. Counted in the index's `bytes`
 *   (the memory model's gene-index share) from the moment it is read;
 * - until then, and when that memory does not hold it (it stands for a
 *   store on disk then), the pieces asked for in one task are read
 *   together, one read per run of pieces less than `KEPT_READ_GAP_BYTES`
 *   apart: an analysis asks for its genes many at once, so it reads the
 *   copy in long sequential ranges, never a read per gene (measured:
 *   23_decisions_partial_reading.md).
 */
class KeptReads {
  /**
   * @param {KeptStore} kept
   * @param {string[]} names - The per-gene arrays a gene reads
   * @param {{fits: (bytes: number) => boolean, onHeld: (bytes: number) => void}} memory - `fits`: whether
   *   the memory kept for gene indexes holds `bytes` more now; `onHeld`: told the bytes it holds change by
   */
  constructor(kept, names, { fits, onHeld }) {
    this._kept = kept;
    this._names = names;
    this._fits = fits;
    this._onHeld = onHeld;
    /** @type {Record<string, ArrayBufferView>} The arrays held whole, once loaded, by name */
    this._held = {};
    /** @type {Record<string, Uint8Array>} The genes whose held piece was checked, by array */
    this._checked = {};
    /** @type {Array<Object>|null} Pieces asked for in this task */
    this._pending = null;
    /** @type {Promise<void>|null} */
    this._load = null;
    this._decided = false;
    this._disposed = false;
    /** Bytes held in memory (being read or read). */
    this.heldBytes = 0;
    /** Bytes of the per-gene arrays, whole. */
    this.bytes = names.reduce((sum, name) => sum + kept.nnz * KEPT_TYPES[kept.arrays[name].type].BYTES_PER_ELEMENT, 0);
  }

  /** Read the arrays whole when the memory for gene indexes holds them (once; idempotent). */
  prepare() {
    if (this._decided || this._disposed) return;
    this._decided = true;
    if (this.bytes === 0 || !this._fits(this.bytes)) return;
    this._hold(this.bytes);
    const started = performance.now();
    this._load = Promise.all(this._names.map(name => readKeptElements(this._kept, name, 0, this._kept.nnz))).then(arrays => {
      if (this._disposed) return;
      if (this.bytes >= KEPT_PIECE_BYTES) {
        keptLoads.bytes += this.bytes;
        keptLoads.ms += performance.now() - started;
      }
      const checked = this._names.map(() => allocateTypedArray(Uint8Array, this._kept.nCols, 'Kept gene index checked genes'));
      this._names.forEach((name, i) => {
        this._held[name] = arrays[i];
        this._checked[name] = checked[i];
      });
    }).catch(() => {
      // Refused (memory) or failed (a short copy): genes are read in runs,
      // and a damaged piece is found by the gene that reads it.
      if (!this._disposed) this._hold(-this.heldBytes);
    });
  }

  /**
   * Gene `column`'s piece of array `name`, elements `[start, start + count)`
   * (every element of the gene), checked.
   * @returns {Promise<ArrayBufferView>}
   */
  piece(name, column, start, count) {
    let held;
    try {
      held = this.held(name, column, start, count);
    } catch (error) {
      return Promise.reject(error);
    }
    if (held !== null) return Promise.resolve(held);
    return new Promise((resolve, reject) => {
      if (this._pending === null) {
        this._pending = [];
        yieldToMacrotask().then(() => this._readPending());
      }
      this._pending.push({ name, column, start, count, resolve, reject });
    });
  }

  /**
   * Gene `column`'s piece of array `name` from the arrays held whole, checked
   * (throws when damaged), or null while they are not held: what an index
   * built in the opening answers at once, answered at once.
   * @returns {ArrayBufferView|null}
   */
  held(name, column, start, count) {
    const held = this._held[name];
    if (held === undefined) {
      if (count === 0) return new KEPT_TYPES[this._kept.arrays[name].type](0);
      this.prepare();
      return null;
    }
    const piece = held.subarray(start, start + count);
    if (count === 0) return piece;
    const checked = this._checked[name];
    if (checked[column] === 0) {
      checkedPiece(this._kept, name, column, piece);
      checked[column] = 1;
    }
    return piece;
  }

  /** The pieces asked for in one task: one read per run of them, by array. @private */
  _readPending() {
    const pending = this._pending;
    this._pending = null;
    pending.sort((a, b) => (a.name === b.name ? a.start - b.start : (a.name < b.name ? -1 : 1)));
    for (let first = 0; first < pending.length;) {
      const { name, start } = pending[first];
      const gap = KEPT_READ_GAP_BYTES / KEPT_TYPES[this._kept.arrays[name].type].BYTES_PER_ELEMENT;
      let end = start + pending[first].count;
      let last = first + 1;
      while (last < pending.length && pending[last].name === name && pending[last].start <= end + gap) {
        end = Math.max(end, pending[last].start + pending[last].count);
        last++;
      }
      const run = pending.slice(first, last);
      readKeptElements(this._kept, name, start, end - start).then(elements => {
        for (const item of run) {
          try {
            item.resolve(checkedPiece(this._kept, name, item.column, elements.subarray(item.start - start, item.start - start + item.count)));
          } catch (error) {
            item.reject(error);
          }
        }
      }, error => {
        for (const item of run) item.reject(error);
      });
      first = last;
    }
  }

  /** @private */
  _hold(bytes) {
    this.heldBytes += bytes;
    this._onHeld(bytes);
  }

  dispose() {
    this._disposed = true;
    this._held = {};
    this._checked = {};
    this.heldBytes = 0;
  }
}

/**
 * @typedef {Object} KeptStore
 * @property {'structure'|'sparse'|'dense'} layout
 * @property {number} nRows - The rows it was built over (an opening may use its first rows only)
 * @property {number} nCols
 * @property {number} nnz
 * @property {Float64Array|null} columnStart - Read at once (`sparse`, `structure`)
 * @property {Float64Array|null} rowPointers - The row pointers of the rows the
 *   opening keeps, checked against the file's (`sparse`, `structure`)
 * @property {Record<string, {type: string, read: (offset: number, length: number) => Promise<Uint8Array>}>} arrays
 * @property {Record<string, Uint32Array>} checks - The CRC-32 of each gene's
 *   piece of every per-gene array (`positions`, `rows`, `values`), by name
 * @property {string} label
 * @property {() => void} release - Let the kept copy go (the lock this reader holds on it)
 * @property {() => void} discard - Remove the kept copy (it is damaged)
 */

/**
 * The structure of a sparse column store kept in this browser: the column
 * starts and row pointers in memory, each gene's entry positions from the
 * kept copy (`KeptReads`: held whole once read when memory holds them, as
 * the structure built by the pass holds them), its values from the file as
 * that structure reads them. Over its first `nRows` rows only when the
 * opening keeps fewer rows than it was built over (its entries are then the
 * first `entries` of the file's: rows are stored in order).
 */
class KeptSparseStructure extends SparseStructure {
  constructor(kept, { nRows, rowPointers, readValues, storedValueBytes, costs, label, fits }) {
    super(nRows, kept.nCols, kept.columnStart, rowPointers, readValues, storedValueBytes, costs, label);
    this._keptCopy = kept;
    this._reads = new KeptReads(kept, ['positions'], { fits, onHeld: bytes => { this.bytes += bytes; } });
    // The entries of the rows open: a prefix of every column's.
    this._nnz = rowPointers[nRows];
    this._storedValueBytes = storedValueBytes.then(bytes => (bytes > 0 ? bytes : this._nnz * 4), () => this._nnz * 4);
    this.kind = 'kept';
  }

  /** Bytes of the kept copy a gene reads from (`keptReadMs`). */
  get keptBytes() {
    return this._reads.bytes;
  }

  /** Hold the kept copy in memory when it fits (`KeptReads`). */
  prepare() {
    this._reads.prepare();
  }

  async _positionsOf(start, count, column) {
    const read = await this._reads.piece('positions', column, start, count);
    const limit = this._nnz;
    const positions = allocateTypedArray(Float64Array, count, 'Gene column entry positions');
    let open = 0;
    for (let i = 0; i < count; i++) {
      const position = read[i];
      if (!(position >= (i === 0 ? 0 : positions[i - 1] + 1)) || position >= this._keptCopy.nnz) {
        throw keptDamage(this._label, 'an entry position is out of order');
      }
      positions[i] = position;
      if (position < limit) open = i + 1;
    }
    return open === count ? positions : positions.subarray(0, open);
  }

  dispose() {
    super.dispose();
    this._reads.dispose();
    this._keptCopy?.release();
    this._keptCopy = null;
  }
}

/** A sparse column store kept in this browser: each gene's rows and values from the kept copy (`KeptReads`). */
class KeptSparseStore {
  constructor(kept, { nRows, fits }) {
    this.nRows = nRows;
    this.nCols = kept.nCols;
    this._kept = kept;
    this._columnStart = kept.columnStart;
    this.kind = 'kept';
    // The kept copy's column starts, and its row pointers where it holds
    // them in memory (a structure kept with them: a row each).
    this.bytes = kept.columnStart.byteLength + (ArrayBuffer.isView(kept.rowPointers) ? kept.rowPointers.byteLength : 0);
    this._reads = new KeptReads(kept, ['rows', 'values'], { fits, onHeld: bytes => { this.bytes += bytes; } });
  }

  /** Bytes of the kept copy a gene reads from (`keptReadMs`). */
  get keptBytes() {
    return this._reads.bytes;
  }

  /** Hold the kept copy in memory when it fits (`KeptReads`). */
  prepare() {
    this._reads.prepare();
  }

  /**
   * One column's entries on the rows open, checked: at once from the copy
   * held whole (its rows checked once), else a promise of them. @private
   */
  _entries(column) {
    const start = this._columnStart[column];
    const count = this._columnStart[column + 1] - start;
    const rows = this._reads.held('rows', column, start, count);
    const values = rows === null ? null : this._reads.held('values', column, start, count);
    if (values !== null) {
      // Held: what the rows open are is found once (they never change).
      this._openCounts ??= allocateTypedArray(Float64Array, this.nCols, 'Kept gene index open entries').fill(-1);
      if (this._openCounts[column] < 0) this._openCounts[column] = this._open(rows, count);
      return { rows, values, count: this._openCounts[column] };
    }
    return Promise.all([
      this._reads.piece('rows', column, start, count),
      this._reads.piece('values', column, start, count),
    ]).then(([read, readValues]) => ({ rows: read, values: readValues, count: this._open(read, count) }));
  }

  /** How many of a gene's entries lie on the rows open, its rows checked. @private */
  _open(rows, count) {
    let open = 0;
    for (let i = 0; i < count; i++) {
      if (!(rows[i] < this._kept.nRows) || (i > 0 && rows[i] < rows[i - 1])) throw keptDamage(this._kept.label, 'a row is out of order');
      if (rows[i] < this.nRows) open = i + 1;
    }
    return open;
  }

  column(column) {
    const dense = ({ rows, values, count }) => {
      const result = allocateTypedArray(Float32Array, this.nRows, 'Gene column');
      for (let i = 0; i < count; i++) result[rows[i]] = addFloat32(result[rows[i]], values[i]);
      return result;
    };
    const entries = this._entries(column);
    return entries instanceof Promise ? entries.then(dense) : dense(entries);
  }

  sparseColumn(column) {
    const sparse = ({ rows, values, count }) => sparseColumnOf(rows, values, count, this.nRows);
    const entries = this._entries(column);
    return entries instanceof Promise ? entries.then(sparse) : sparse(entries);
  }

  dispose() {
    this._reads.dispose();
    this._kept?.release();
    this._kept = null;
  }
}

/** A dense column store kept in this browser: each gene's values on the rows open, from the kept copy (`KeptReads`). */
class KeptDenseStore {
  constructor(kept, { nRows, fits }) {
    this.nRows = nRows;
    this.nCols = kept.nCols;
    this._kept = kept;
    this.kind = 'kept';
    this.bytes = 0;
    this._reads = new KeptReads(kept, ['values'], { fits, onHeld: bytes => { this.bytes += bytes; } });
  }

  /** Bytes of the kept copy a gene reads from (`keptReadMs`). */
  get keptBytes() {
    return this._reads.bytes;
  }

  /** Hold the kept copy in memory when it fits (`KeptReads`). */
  prepare() {
    this._reads.prepare();
  }

  column(column) {
    // The gene's whole piece (checked), the open rows kept of it: a copy
    // out of the copy held whole, at once; else read, and copied unless the
    // piece owns its buffer (one read with other genes' pieces is shared).
    const start = column * this._kept.nRows;
    const held = this._reads.held('values', column, start, this._kept.nRows);
    if (held !== null) return held.slice(0, this.nRows);
    return this._reads.piece('values', column, start, this._kept.nRows).then(values =>
      (values.byteOffset === 0 && values.length === this.nRows && values.length === values.buffer.byteLength / 4 ? values : values.slice(0, this.nRows)));
  }

  sparseColumn(column) {
    const dense = this.column(column);
    return dense instanceof Promise ? dense.then(sparseColumnOfDense) : sparseColumnOfDense(dense);
  }

  dispose() {
    this._reads.dispose();
    this._kept?.release();
    this._kept = null;
  }
}

/**
 * The store an index starts from when its gene index is kept in this
 * browser (`RowMajorColumnIndex`, `kept`), over the opening's first `nRows`
 * rows of those it was built over.
 *
 * @param {KeptStore} kept
 * @param {{nRows: number, rowPointers?: Float64Array|null, readValues?: Function, storedValueBytes?: Promise<number|null>,
 *   costs?: () => RequestCosts, label: string, fits: (bytes: number) => boolean}} context - `rowPointers`: the open
 *   rows' (a structure); `fits`: whether the memory kept for gene indexes holds `bytes` more now (`KeptReads`)
 */
function openKeptStore(kept, context) {
  if (kept.layout === 'structure') return new KeptSparseStructure(kept, context);
  if (kept.layout === 'sparse') return new KeptSparseStore(kept, context);
  return new KeptDenseStore(kept, context);
}

/**
 * Whether an error is the disk refusing to grow a file (the origin's storage
 * quota, or a full disk).
 */
function isDiskFull(error) {
  return error?.name === 'QuotaExceededError' || /quota|no space/i.test(error?.message ?? '');
}

/**
 * Where a column store is kept: in memory when it fits `memoryBudgetBytes`,
 * on disk when `openDiskFiles` can provide files and the disk has room for
 * it, in memory regardless when the disk cannot, and nowhere when nothing can
 * hold it. Then `store` is null and `refusal` says why, in words a person
 * reads (`… needs 32 GB: more than …`): columns are answered by scanning,
 * and the person is told so.
 *
 * @param {Object} options
 * @param {number} options.memoryBudgetBytes - A residency policy, not a limit
 * @param {((names: string[]) => Promise<Object|null>)|null} [options.openDiskFiles]
 *   Synchronous access handles by name, or null when there is no disk.
 * @param {((needed: number, options: {makeRoom: boolean}) => Promise<number|null>)|null} [options.diskFreeBytes] - The
 *   bytes this origin may still store (its quota less its usage) for a
 *   store of `needed` bytes, counting what it may free for it (removed
 *   with `makeRoom`, as the store is placed), or null when the browser does
 *   not say.
 */
export function createColumnStoreFactory({ memoryBudgetBytes, openDiskFiles = null, diskFreeBytes = null }) {
  const inMemory = create => {
    try {
      return { store: create(), failure: null };
    } catch (error) {
      if (error?.code !== 'TOO_LARGE') throw error;
      return { store: null, failure: error };
    }
  };
  /** Where `bytes` would be kept, without making anything: what `place` will do (`makeRoom`: as it does). */
  const plan = async (bytes, { makeRoom = false } = {}) => {
    if (bytes <= memoryBudgetBytes) return { kind: 'memory', refusal: null };
    if (openDiskFiles === null) {
      return { kind: null, refusal: refusalOf(bytes, 'this browser gives this page no disk storage') };
    }
    const free = diskFreeBytes === null ? null : await diskFreeBytes(bytes, { makeRoom }).catch(() => null);
    if (free !== null && free < bytes) {
      return {
        kind: null,
        refusal: refusalOf(bytes, `${formatBytes(free)} of disk storage is left to this site`),
      };
    }
    return { kind: 'disk', refusal: null };
  };
  const refusalOf = (bytes, disk) =>
    `the gene index needs ${formatBytes(bytes)}: more than the ${formatBytes(memoryBudgetBytes)} ` +
    `of memory this browser keeps for it, and ${disk}`;
  /**
   * Make a store of `bytes` with `create` (memory) or `createDisk(files)`.
   * @returns {Promise<{store: Object|null, refusal: string|null}>}
   */
  const place = async (bytes, names, create, createDisk) => {
    const planned = await plan(bytes, { makeRoom: true });
    if (planned.kind === 'memory') {
      const { store } = inMemory(create);
      if (store !== null) return { store, refusal: null };
    }
    // Over the budget (or refused by the browser within it): the disk.
    let disk = planned.refusal;
    if (disk === null) {
      const files = openDiskFiles === null ? null : await openDiskFiles(names);
      if (files === null) {
        disk = refusalOf(bytes, 'the browser could not open disk storage for it');
      } else {
        try {
          return { store: createDisk(files), refusal: null };
        } catch (error) {
          for (const name of names) {
            try { files[name].close(); } catch { /* already closed */ }
          }
          files.release?.();
          if (!isDiskFull(error)) throw error;
          disk = refusalOf(bytes, `the disk refused it (${error.message})`);
        }
      }
    }
    // No disk either: memory regardless, when the browser allows it.
    const { store, failure } = inMemory(create);
    if (store !== null) return { store, refusal: null };
    return { store: null, refusal: `${disk}; ${failure.message}` };
  };
  return {
    plan,
    /** The memory a store may take before it goes to disk. */
    memoryBudgetBytes,
    /**
     * The same placement with `bytes` of memory: an index built in parts
     * (`anndata/prefix-column-index.js`) gives each part what the parts
     * before it left.
     */
    withMemoryBudget: bytes => createColumnStoreFactory({ memoryBudgetBytes: bytes, openDiskFiles, diskFreeBytes }),
    sparse(nRows, nCols, columnStart, label) {
      const bytes = columnStart[nCols] * 8 + nCols * 16;
      return place(
        bytes,
        ['rows', 'values'],
        () => new MemorySparseStore(nRows, nCols, columnStart, label),
        files => new DiskSparseStore(nRows, nCols, columnStart, files, label)
      );
    },
    dense(nRows, nCols, label) {
      return place(
        nRows * nCols * 4,
        ['values'],
        () => new MemoryDenseStore(nRows, nCols, label),
        files => new DiskDenseStore(nRows, nCols, files)
      );
    },
  };
}

// ---------------------------------------------------------------------------
// The background index
// ---------------------------------------------------------------------------

/**
 * The items of `items`, each with `load(item)` resolved, fetching the next
 * item's data before the current one is handed out: reading and decoding the
 * next slab overlaps with processing this one. A read-ahead of one slab keeps
 * at most two slabs resident; `depth` slabs ahead keep `depth + 1`.
 *
 * @template T, D
 * @param {AsyncIterable<T>|Iterable<T>} items
 * @param {(item: T) => Promise<D>} load
 * @param {number} [depth] - Items fetched ahead of the one handed out
 * @returns {AsyncGenerator<{item: T, data: D}>}
 */
async function* withReadAhead(items, load, depth = 1) {
  const iterator = (items[Symbol.asyncIterator] ?? items[Symbol.iterator]).call(items);
  const pull = async () => {
    const { value, done } = await iterator.next();
    if (done) return null;
    const data = Promise.resolve().then(() => load(value));
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

/** The error a build stops with when no gene waits for it any more. */
function stoppedError(label) {
  const stopped = cancelled('superseded', `Indexing ${label} stopped: no gene waits for it any more`);
  stopped.indexStopped = true;
  return stopped;
}

/**
 * How a sparse row-major matrix is indexed (`RowMajorColumnIndex`), decided
 * before anything is read, so its cost can be told before the first gene:
 *
 * - pass 1 reads every row pointer and column index (and every value too
 *   when values are not read on demand, while a gene waits);
 * - the indices pass 1 reads are kept for what follows when they fit
 *   `retainIndicesBytes` (beside the store pass 2 fills, read ahead); kept
 *   indices are narrowed to the smallest type holding a column (a matrix of
 *   up to 65,536 genes keeps 2 bytes an entry, not 4); read ahead, the values
 *   a waiting gene made pass 1 read are kept too when every value fits beside
 *   them (`keepsValues`);
 * - over a link slower than a disk (`valuesOnDemand`) with the indices kept,
 *   the index is their structure (`MemorySparseStructure`, `structureBytes`
 *   resident: a position per entry and the row pointers) and there is no
 *   second pass; when the values are stored in chunks read whole
 *   (`valuesInWholeChunks`: compressed or filtered) and every value fits
 *   beside the kept indices (`buysValues`), a gene that waits makes the pass
 *   read every slab's values beside its indices, in the same round trip, and
 *   they are kept: the first gene was priced with them (`subsample-plan.js`
 *   `firstGeneReadCost`), and each later gene would otherwise read the
 *   chunks its entries lie in, a round trip or more each (measured:
 *   23_decisions_partial_reading.md);
 * - otherwise pass 2 reads the row pointers again, the indices unless kept,
 *   and the values unless kept, into a column store of `storeBytes`
 *   (`createColumnStoreFactory` places it: memory, disk, or nowhere).
 *
 * @param {{nnz: number, nCols: number, nRows?: number, valuesOnDemand: boolean, retainIndicesBytes: number, valuesInWholeChunks?: boolean}} matrix
 * @returns {{passes: 1|2, keepsIndices: boolean, keepsValues: boolean, buysValues: boolean, KeptIndex: Function, keepBudget: number, storeBytes: number, structureBytes: number}}
 */
export function sparseIndexPlan({ nnz, nCols, nRows = 0, valuesOnDemand, retainIndicesBytes, valuesInWholeChunks = false }) {
  const KeptIndex = nCols <= 0x100 ? Uint8Array : (nCols <= 0x10000 ? Uint16Array : Uint32Array);
  const storeBytes = nnz * 8 + nCols * 16;
  // What pass 1 keeps for pass 2 shares the index budget with the store
  // pass 2 fills (8 bytes an entry): together they never exceed it.
  const keepBudget = Math.max(0, retainIndicesBytes - (valuesOnDemand ? 0 : storeBytes));
  const keepsIndices = nnz * KeptIndex.BYTES_PER_ELEMENT <= keepBudget;
  return {
    passes: valuesOnDemand && keepsIndices ? 1 : 2,
    keepsIndices,
    KeptIndex,
    keepBudget,
    keepsValues: !valuesOnDemand && keepsIndices && nnz * (KeptIndex.BYTES_PER_ELEMENT + 4) <= keepBudget,
    buysValues: valuesOnDemand && valuesInWholeChunks && keepsIndices && nnz * (KeptIndex.BYTES_PER_ELEMENT + 4) <= keepBudget,
    storeBytes,
    structureBytes: nnz * (nnz <= 0xffffffff ? 4 : 8) + (nRows + 1 + nCols + 1) * 8,
  };
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
   * Every reader returns a promise of the values read from the store; the
   * index's own reads get `{signal}`, which aborts when the build stops (a
   * read already sent is let go; one still queued is never sent).
   * @param {(start: number, end: number, options?: {signal?: AbortSignal|null}) => Promise<ArrayLike<number|bigint>>} [options.readRowPointers]
   * @param {(start: number, end: number, options?: {signal?: AbortSignal|null}) => Promise<ArrayLike<number|bigint>>} [options.readIndices]
   * @param {(start: number, end: number, options?: {signal?: AbortSignal|null}) => Promise<Float32Array>} [options.readValues]
   * @param {(rowStart: number, rowEnd: number, options?: {signal?: AbortSignal|null}) => Promise<Float32Array>} [options.readRows] - Dense only
   * @param {Object} options.storeFactory - `createColumnStoreFactory`
   * @param {boolean} [options.valuesOnDemand] - Sparse only: index the structure
   *   and read each gene's values as it is asked for (a matrix read over a
   *   link slower than a disk); the indices are kept within
   *   `retainIndicesBytes` to build it
   * @param {boolean} [options.valuesInWholeChunks] - With `valuesOnDemand`:
   *   the values are stored in chunks read whole (compressed or filtered), so
   *   a waiting gene's pass reads them all beside the indices when they fit
   *   (`sparseIndexPlan` `buysValues`)
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
   * @param {(reads: {indices: Array<[number, number]>, values: Array<[number, number]>}) => void} [options.onSecondPass] -
   *   Called as pass 2 starts, with the entry ranges of the indices and values
   *   it reads (the row pointers are read whole)
   * @param {(work: {entries: number, ms: number}) => void} [options.onWork] -
   *   Called once a pass builds the index, with the entries it indexed and
   *   the milliseconds of its own work (its parts, the structure filled, a
   *   dense slab placed: not the reads it waited for)
   * @param {(build: Promise<void>) => void} [options.onBuild] - Called as each
   *   build starts (the first, and one started again after a stop), with its
   *   promise
   * @param {(reason: string) => ((error: Error|null) => void)|null} [options.onUnindexedScan] -
   *   Called as each scan of a matrix that has no index starts (nothing could
   *   hold it: `reason` says why), so the scan is shown as the read it is;
   *   returns what to call when the scan ends
   * @param {KeptStore|null} [options.kept] - The index of these rows kept in
   *   this browser from an earlier opening (`anndata/kept-column-index.js`):
   *   the index is built from the start, and nothing is read but genes. When
   *   a read finds it damaged, it is removed (`discard`) and the index is
   *   built as if nothing were kept (and `onBuilt` told, so it is kept
   *   again).
   * @param {(store: Object) => void} [options.onBuilt] -
   *   Called once the index is built by a pass (not one started from `kept`,
   *   until that is found damaged), with its store, whose `keptParts()` it
   *   may keep for a later opening; and again with the same store once a
   *   structure built without its values holds every value (a later gene
   *   read them whole): what it keeps then holds the values too
   * @param {(() => number|null)|null} [options.rebuildMs] - What building the
   *   index by a pass is priced at now, in ms (null: not priced): a kept
   *   index whose reading is priced higher (`keptReadMs`, measured in this
   *   thread) is let go at its first gene and the index built instead (and
   *   not kept again: the kept copy stays for a later opening to price)
   * @param {string} [options.label]
   */
  constructor(options) {
    this._options = options;
    this.nRows = options.nRows;
    this.nCols = options.nCols;
    this._label = options.label ?? 'Matrix';
    /**
     * What holds the built index: a store of this run, or one kept from an earlier one.
     * @type {MemorySparseStore|MemorySparseStructure|MemoryDenseStore|DiskSparseStore|DiskDenseStore|KeptSparseStructure|KeptSparseStore|KeptDenseStore|null}
     */
    this._store = null;
    this._requests = new Map();
    this._build = null;
    this._disposed = false;
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
    /** Milliseconds of the build's own work so far (`onWork`): its parts, the structure filled, a dense slab placed. */
    this._workMs = 0;
    /** Whether the index was asked for ahead of need (`start({ahead: true})`): it is then built whoever waits. */
    this._ahead = false;
    /** Set when the last gene waiting for a build asked for on demand withdrew: the build stops. */
    this._stopping = false;
    /** The stop that waits one round trip for another gene (`_withdraw`). */
    this._stopTimer = null;
    /** @type {AbortController|null} The current build's reads */
    this._abort = null;
    /** Whether a gene was served from the current build: it then never stops. */
    this._served = false;
    /** Why no store could hold the index, once that is known (`phase` `unindexed`). */
    this.unindexedReason = null;
    this.phase = 'idle';
    /** Whether a store built here is told to `onBuilt` (not one built because its kept copy costs more to read). */
    this._keepsBuilt = true;
    /** Whether a kept index was priced against building it (`_keptReady`). */
    this._keptPriced = false;
    const kept = options.kept ?? null;
    if (kept !== null) {
      this._store = openKeptStore(kept, {
        nRows: this.nRows,
        rowPointers: kept.rowPointers,
        readValues: options.readValues,
        storedValueBytes: Promise.resolve().then(() => options.valuesStoredBytes?.() ?? null),
        costs: () => this._costs(),
        label: this._label,
        // Held whole when it fits what a store built here would be placed in memory within.
        fits: bytes => bytes <= (options.storeFactory?.memoryBudgetBytes ?? 0),
      });
      this._store._storedValueBytes?.catch?.(() => {});
      this._columnStart = kept.columnStart;
      this._keptCopy = kept;
      this.phase = 'ready';
      // Built: `start` has nothing to do.
      this._build = Promise.resolve();
    }
  }

  /**
   * Read one column from the built store; a kept index found damaged is
   * let go and removed, and the column is read as from an index never kept
   * (the next build). @private
   */
  _fromStore(read, column, options) {
    const store = this._store;
    return Promise.resolve().then(() => store[read](column)).catch(error => {
      if (error?.code !== 'KEPT_INDEX_DAMAGED' || this._store !== store) throw error;
      console.warn(`[RowMajorColumnIndex] ${error.message}`);
      this._keptCopy?.discard();
      this._letGoKept();
      return read === 'column' ? this.column(column, options) : this.sparseColumn(column, options);
    });
  }

  /** Let go of the kept index this index started from: the next gene builds it. @private */
  _letGoKept() {
    this._keptCopy = null;
    this._store.dispose();
    this._store = null;
    this._columnStart = null;
    this._build = null;
    this.phase = 'idle';
  }

  /**
   * Whether the index is built, a kept one priced first, at its first gene
   * (or when it is wanted ahead of need): reading it is priced at the rate
   * kept copies were read in this thread (`keptReadMs`), building it at
   * `rebuildMs`. One priced higher is let go and the index built instead,
   * not kept again (the kept copy stays: a later opening prices it again);
   * one priced lower, or not priced, is read. @private
   */
  _keptReady() {
    if (this.phase === 'ready' && this._store?.kind === 'kept' && !this._keptPriced) {
      this._keptPriced = true;
      const keptMs = keptReadMs(this._store.keptBytes);
      const rebuildMs = this._options.rebuildMs?.() ?? null;
      if (keptMs !== null && rebuildMs !== null && keptMs > rebuildMs) {
        this._letGoKept();
        this._keepsBuilt = false;
      }
    }
    return this.phase === 'ready';
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
    return { mergeGapBytes: link.mergeGapBytes, roundTripBytes: link.roundTripBytes, shapingConcurrency: link.shapingConcurrency ?? link.concurrency };
  }

  /**
   * Slabs of indices read ahead over a slower link: enough that their bytes
   * fill one round trip (the bandwidth-delay product), at most as many as
   * background requests run at once. @private
   */
  _slabsAhead() {
    const link = this._options.link?.() ?? null;
    const slabBytes = (this._options.slabEntries ?? (1024 * 1024)) * 4;
    const running = link?.backgroundConcurrency ?? link?.concurrency ?? PRIOR_COSTS.shapingConcurrency;
    const filling = link?.measured && link.roundTripBytes !== null
      ? Math.ceil(link.roundTripBytes / slabBytes) + 1
      : running;
    return Math.max(1, Math.min(running, filling));
  }

  /** Where the finished store lives (`memory`, `disk`), or null. */
  get storeKind() {
    return this._store?.kind ?? null;
  }

  /**
   * Start building in the background (idempotent); resolves when built.
   * `ahead`: the index is wanted ahead of need (`prepareMatrix`), and is
   * built whoever waits; otherwise the build is for the genes asked for, and
   * stops when the last of them withdraws (`column(…, {signal})`): a person
   * who cancels the only gene a slow scan was for stops its transfer. A
   * stopped build goes on at the next gene from where it stopped: the slabs
   * pass 1 counted are kept (`_pass1`), never read again. A failed one
   * starts over.
   */
  start({ ahead = false } = {}) {
    if (ahead) {
      this._ahead = true;
      // A kept index wanted ahead of need is read whole now, as one built would be.
      if (this._keptReady() && this._store?.kind === 'kept') this._store.prepare();
    }
    if (this._build === null) {
      this._abort = new AbortController();
      const build = this._run().catch(error => {
        if (this._build === build && (error?.indexStopped === true || this._stopping)) {
          this._reset({ keepPass: true });
          // A gene asked for while the build stopped starts the next one.
          if (this._requests.size > 0 && !this._disposed) this.start();
          throw stoppedError(this._label);
        }
        // The genes waiting for this build fail with it; the next gene asked
        // for starts a new build, so a read that failed once (a dropped
        // connection, a host that stopped answering for a while) is made
        // again then, never answered by this failure.
        if (this._build === build) this._reset();
        for (const request of this._requests.values()) request.reject(error);
        this._requests.clear();
        throw error;
      });
      this._build = build;
      // A background failure reaches callers through their requests.
      this._build.catch(() => {});
      this._options.onBuild?.(build);
    }
    return this._build;
  }

  /** The options of the index's own reads: the current build's signal. @private */
  _reads() {
    return { signal: this._abort?.signal ?? null };
  }

  /**
   * Forget a stopped or failed build: the next gene starts a new one, from
   * where pass 1 stopped when `keepPass` (a build stopped because nobody
   * waited any more: what it counted is sound), else from the start (a
   * failure: what it counted may be what failed). @private
   */
  _reset({ keepPass = false } = {}) {
    this._releaseBuildState();
    if (!keepPass) this._releasePass();
    this._filling?.dispose();
    this._filling = null;
    this._build = null;
    this._abort = null;
    this._stopping = false;
    this._served = false;
    this._columnStart = null;
    // A pass kept goes on from where it is (its share counts as done).
    const pass = this._pass1 ?? null;
    const nnz = this._options.nnz ?? 0;
    this._done = pass === null || nnz === 0 ? 0 : pass.nextEntry / (pass.slabs !== null ? nnz : 2 * nnz);
    this.phase = 'idle';
  }

  /**
   * Let go of what pass 2 holds of pass 1 (the indices and values pass 1
   * kept for it): a build that stopped or failed keeps none of it. @private
   */
  _releaseBuildState() {
    this._retainedIndices = null;
    this._retainedValues = null;
  }

  /** Let go of pass 1's counted slabs (`_pass1`) and the values it read whole for waiting genes. @private */
  _releasePass() {
    this._pass1 = null;
    this._besideKept = [];
    this._besideSpent = 0;
  }

  /**
   * One waiting gene withdrew (its caller's signal aborted): it stops being
   * extracted once nobody else waits for it, and a build no one waits for any
   * more, not asked for ahead, stops. @private
   */
  _withdraw(request) {
    request.waiters--;
    if (request.waiters > 0 || this._requests.get(request.column) !== request) return;
    this._requests.delete(request.column);
    // A build asked for on demand, or a scan of a matrix with no index,
    // stops: its reads stop now, those queued are never sent. Only while
    // nothing was served from it: once a gene was (at the end of pass 1),
    // the work it paid for is the index's, and the build goes on.
    if (this._requests.size === 0 && this._stoppable()) {
      // Not at once: one round trip of the link later (none for a local
      // file). A gene asked for instead of the one withdrawn (a person picks
      // another) reaches the index within it and joins the pass under way,
      // its reads in flight kept; stopping saves only what the link moves
      // after that, and stopping at once would have cost the next gene those
      // reads again.
      clearTimeout(this._stopTimer);
      const graceMs = this._options.link?.()?.latencyMs ?? 0;
      const stop = () => {
        this._stopTimer = null;
        if (this._requests.size > 0 || !this._stoppable()) return;
        this._stopping = true;
        this._abort?.abort(stoppedError(this._label));
      };
      if (graceMs > 0) this._stopTimer = setTimeout(stop, graceMs);
      else stop();
    }
    this._releaseIfRetired();
  }

  /** Whether a build or scan stops when nobody waits for it (see `_withdraw`). @private */
  _stoppable() {
    const building = !this._ahead && this._build !== null && this.phase === 'counting' && !this._served;
    const scanning = this.phase === 'unindexed' && this._scanning !== null;
    return building || scanning;
  }

  /**
   * One column as a dense float32 vector. `signal` withdraws this caller:
   * its promise rejects with the abort reason, and when it was the last
   * caller waiting for the index, a build asked for on demand stops.
   *
   * @param {number} column
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Float32Array>}
   */
  column(column, { signal = null } = {}) {
    if (!Number.isSafeInteger(column) || column < 0 || column >= this.nCols) {
      return Promise.reject(new RangeError(`Column index ${column} is out of bounds`));
    }
    if (this._keptReady()) {
      return this._fromStore('column', column, { signal });
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const restartScan = this.phase === 'unindexed';
    let request = this._requests.get(column);
    if (request === undefined) {
      const { promise, resolve, reject } = promiseWithResolvers();
      request = {
        column,
        promise,
        resolve,
        reject,
        values: allocateTypedArray(Float32Array, this.nRows, 'Gene column'),
        rowsSeen: 0,
        waiters: 0,
      };
      this._requests.set(column, request);
    }
    request.waiters++;
    // A gene asked for while a stop waits its grace keeps the pass going.
    clearTimeout(this._stopTimer);
    this._stopTimer = null;
    if (restartScan) this._scanForRequests();
    else this.start();
    if (signal === null) return request.promise;
    const entry = request;
    return new Promise((resolve, reject) => {
      const stopWaiting = onAbort(signal, () => {
        this._withdraw(entry);
        reject(abortReason(signal));
      });
      entry.promise.then(
        values => {
          stopWaiting();
          resolve(values);
        },
        error => {
          stopWaiting();
          reject(error);
        }
      );
    });
  }

  /**
   * One column as its non-zero entries (`SparseColumn`): from the store once
   * it is built, else extracted from the passes under way as `column` is.
   *
   * @param {number} column
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<SparseColumn>}
   */
  sparseColumn(column, options = {}) {
    if (Number.isSafeInteger(column) && column >= 0 && column < this.nCols && this._keptReady()) {
      return this._fromStore('sparseColumn', column, options);
    }
    return this.column(column, options).then(sparseColumnOfDense);
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

  /** Bytes the built store holds in memory (null until it is built; 0 on disk; a kept one's column starts and row pointers). */
  get storeBytes() {
    return this.phase === 'ready' ? (this._store.kind === 'disk' ? 0 : this._store.bytes) : null;
  }

  /** Whether the index was kept in this browser from an earlier opening (not built by a pass here). */
  get kept() {
    return this.phase === 'ready' && this._store?.kind === 'kept';
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
    clearTimeout(this._stopTimer);
    this._stopTimer = null;
    this._store?.dispose();
    this._store = null;
    this._releasePass();
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
    if (this._stopping) throw stoppedError(this._label);
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
      this._workMs += elapsed;
      if (entries > 0 && elapsed > 0) {
        this._sliceEntries = Math.max(1, Math.round(entries * INDEX_SLICE_MS / elapsed));
      }
      row = end;
      if (row < rowEnd) await this._checkpoint();
    }
  }

  /**
   * The requests waiting at this slab boundary, by column. A stopping build
   * serves none: a gene asked for meanwhile is served whole by the next.
   */
  _active() {
    return this._requests.size === 0 || this._stopping ? null : new Map(this._requests);
  }

  /** Count the rows one slab gave each active request; resolve complete ones. */
  _account(active, rows) {
    if (active === null) return;
    for (const request of active.values()) {
      request.rowsSeen += rows;
      if (request.rowsSeen >= this.nRows && this._requests.get(request.column) === request) {
        this._requests.delete(request.column);
        this._served = true;
        request.resolve(request.values);
      }
    }
    this._releaseIfRetired();
  }

  _resolveFromStore() {
    // The build's own work, per entry indexed (what a share weighs a pass by: `onWork`).
    const entries = this._options.layout === 'dense' ? this.nRows * this.nCols : this._options.nnz;
    if (entries > 0 && this._workMs > 0) this._options.onWork?.({ entries, ms: this._workMs });
    this._workMs = 0;
    if (this._requests.size > 0) this._served = true;
    for (const request of this._requests.values()) {
      request.resolve(this._store.column(request.column));
    }
    this._requests.clear();
    this._releaseIfRetired();
    // A store built here (never one kept) may be kept for a later opening.
    if (!this._disposed && this._keepsBuilt) this._options.onBuilt?.(this._store);
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
    const { store, refusal } = await storeFactory.dense(nRows, nCols, this._label);
    this._filling = store;
    await this._checkpoint();
    if (store === null) {
      await this._becomeUnindexed(refusal);
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
    const slabs = withReadAhead(denseSlabs(nRows, rowsPerSlab), slab => readRows(slab.rowStart, slab.rowEnd, this._reads()));
    for await (const { item: { rowStart, rowEnd }, data: block } of slabs) {
      if (store === null && this._requests.size === 0) break;
      const active = this._active();
      if (block.length !== (rowEnd - rowStart) * nCols) {
        throw new Error(`${this._label} row slab does not match its selection`);
      }
      const placing = performance.now();
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
      this._workMs += performance.now() - placing;
      this._progress(rowEnd, nRows);
      await this._checkpoint();
    }
  }

  /**
   * No store could be made (`reason`: what it needs and why nothing could
   * hold it): columns are answered by scanning the matrix, one pass per batch
   * of waiting genes. Never silently: the phase and the reason go out with
   * the progress, and each scan is announced (`onUnindexedScan`).
   *
   * @param {string} reason
   */
  async _becomeUnindexed(reason) {
    this.unindexedReason = reason;
    this.phase = 'unindexed';
    this._options.onProgress?.({ kind: 'transpose', label: this._label, phase: 'unindexed', reason, done: 0, total: 0 });
    if (this._requests.size > 0) this._scanForRequests();
  }

  /** Scan for the genes waiting; a scan's failure reaches them. @private */
  _scanForRequests() {
    this._scanWhileRequested().catch(error => {
      for (const request of this._requests.values()) request.reject(error);
      this._requests.clear();
    });
  }

  /**
   * Scan the matrix while genes wait: each pass is announced as the read it
   * is, and stops (its reads let go) once every gene it was for withdrew; a
   * gene asked for meanwhile is served whole by the next pass.
   */
  _scanWhileRequested() {
    this._scanning ??= (async () => {
      try {
        while (this._requests.size > 0) {
          this._stopping = false;
          this._abort = new AbortController();
          const ended = this._options.onUnindexedScan?.(this.unindexedReason) ?? (() => {});
          try {
            if (this._options.layout === 'dense') {
              const slabEntries = this._options.slabEntries ?? (1024 * 1024);
              await this._denseScan(null, Math.max(1, Math.floor(slabEntries / Math.max(1, this.nCols))));
            } else {
              await this._sparseScan(null);
            }
          } catch (error) {
            ended(error);
            if (this._stopping || error?.indexStopped === true) continue;
            throw error;
          }
          ended(null);
        }
      } finally {
        this._scanning = null;
        this._stopping = false;
      }
    })();
    return this._scanning;
  }

  /**
   * Row slabs of the sparse matrix: rows `[rowStart, rowEnd)`, their entries
   * `[entryStart, entryEnd)`, and the validated pointers they index.
   */
  async *_rowSlabs(fromRow = 0, fromEntry = 0) {
    const { nRows, nnz, readRowPointers } = this._options;
    const slabEntries = this._options.slabEntries ?? (1024 * 1024);
    const pointerSlab = Math.max(1, Math.min(nRows, 1 << 18));
    const label = this._label;
    let previousPointer = fromEntry;
    for (let row = fromRow; row < nRows;) {
      // Pointer windows end at multiples of `pointerSlab` whatever row they
      // start at, so slabs from a slab boundary (a pass going on where it
      // stopped) are the slabs a pass from row 0 makes: pass 2 finds each
      // slab of pass 1 by its number.
      const pointerEnd = Math.min(nRows, (Math.floor(row / pointerSlab) + 1) * pointerSlab);
      const raw = await readRowPointers(row, pointerEnd + 1, this._reads());
      if (raw.length !== pointerEnd + 1 - row) {
        throw new Error(`${label} indptr slab does not match its selection`);
      }
      const pointers = allocateTypedArray(Float64Array, raw.length, `${label} indptr`);
      for (let index = 0; index < raw.length; index++) {
        const pointer = toCount(raw[index], `${label} indptr`);
        if (index === 0 && pointer !== previousPointer) {
          throw new AnnDataFormatError(
            row === 0 ? `${label} indptr must start at zero` : (row === fromRow ? `${label} changed while it was read; reopen the file` : `${label} indptr must be monotonic`)
          );
        }
        if (index > 0 && pointer < pointers[index - 1]) {
          throw new AnnDataFormatError(`${label} indptr must be monotonic`);
        }
        if (pointer > nnz) {
          throw new AnnDataFormatError(`${label} indptr ${pointer} at row ${row + index} is past its ${formatCountOf(nnz, 'stored value')}`);
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
      throw new AnnDataFormatError(`${label} indptr last value must equal the non-zero count (${nnz})`);
    }
  }

  /** Extract the active requests' entries from one slab. */
  _extract(active, slab, indices, values) {
    if (active === null) return;
    const { rowStart, rowEnd, pointers, pointerOffset, entryStart } = slab;
    const requests = [...active.values()];
    // A dense lookup (column -> waiting request) keeps the entry loop flat.
    this._lookup ??= allocateTypedArray(Int32Array, this.nCols, 'Gene lookup').fill(-1);
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
    this._lookup ??= allocateTypedArray(Int32Array, this.nCols, 'Gene lookup').fill(-1);
    const lookup = this._lookup;
    requests.forEach((request, index) => { lookup[request.column] = index; });
    let count = 0;
    let positions = new Float64Array(64);
    let rows = new Uint32Array(64);
    let owners = new Int32Array(64);
    const grow = (array, Type) => {
      const next = allocateTypedArray(Type, array.length * 2, `${this._label} entries`);
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
    const visit = (i, value) => {
      const target = requests[owners[i]].values;
      target[rows[i]] = addFloat32(target[rows[i]], value);
    };
    // The waiting genes' ranges weighed against the slab's values whole (the
    // structure's cost model): genes spread over the slab read it whole, and
    // the slab is kept, so no later gene reads it again.
    const slabEntries = slab.entryEnd - entryStart;
    const perEntry = await this._storedBytesPerEntry();
    const cost = count === 0 ? 0 : rangedCost(positions, count, perEntry, this._costs());
    const beside = this._beside?.get(entryStart) ?? null;
    this._beside?.delete(entryStart);
    if (beside !== null || (count > 0 && cost >= slabEntries * perEntry)) {
      const read = await (beside ?? this._options.readValues(entryStart, slab.entryEnd, this._reads()));
      if (read.length !== slabEntries) throw new Error(`${this._label} payload slab does not match its selection`);
      const values = read instanceof Float32Array ? read : copyTypedArray(Float32Array, read, `${this._label} values`);
      this._besideKept.push({ start: entryStart, end: slab.entryEnd, values });
      for (let i = 0; i < count; i++) visit(i, values[positions[i] - entryStart]);
    } else {
      this._besideSpent += cost;
      await readValuesAt(positions, count, (from, to) => this._options.readValues(from, to, this._reads()), visit);
    }
    this._account(active, rowEnd - rowStart);
  }

  /**
   * Whether a slab's values are read beside its indices, not after them: a
   * gene is waiting (its values are wanted from this slab), values are read
   * on demand (a link slower than a disk), and the slab's values whole cost
   * no more bytes than one round trip of the link moves -- the round trip
   * they save: a 1% subsample's first gene would read pointers, indices, then
   * values, three round trips where two do. Only a round trip at the pass's end is saved: a slab's waiting
   * values asked for after its indices arrive while the slabs after it are
   * read, so a slab is read with its values only when the indices still to
   * read after it take less than a round trip (counted at the values' stored
   * bytes an entry); read with every slab's values, a first gene over every
   * cell reads more bytes than it needs (measured:
   * 23_decisions_partial_reading.md). Values stored
   * in chunks read whole are read beside every slab when the plan buys them
   * (`sparseIndexPlan` `buysValues`): the first gene was priced with them,
   * and no later gene then reads one. @private
   */
  _valuesBeside(slab) {
    if (this._options.valuesOnDemand !== true || this._active() === null) return false;
    // Every value bought with the first gene (`sparseIndexPlan` `buysValues`).
    if (this._pass1?.plan.buysValues === true) return true;
    const roundTripBytes = this._costs().roundTripBytes ?? 0;
    // Float32 until the stored size is known (a promise is no number: weighing it read every slab as too large).
    const perEntry = this._perEntryBytes ?? 4;
    const after = Math.max(0, this._options.nnz - slab.entryEnd);
    return (slab.entryEnd - slab.entryStart) * perEntry <= roundTripBytes && after * perEntry < roundTripBytes;
  }

  /** Stored bytes of one value (`valuesStoredBytes` over the entries; float32 when unknown). @private */
  _storedBytesPerEntry() {
    this._perEntry ??= Promise.resolve()
      .then(() => this._options.valuesStoredBytes?.() ?? null)
      .then(bytes => (bytes > 0 ? bytes / this._options.nnz : 4), () => 4)
      .then(perEntry => {
        // Known from now on without waiting (`_valuesBeside` weighs a slab as its read is asked for).
        this._perEntryBytes = perEntry;
        return perEntry;
      });
    return this._perEntry;
  }

  /**
   * Pass 1's state from its first slab: the column counts, the plan, what
   * it keeps of each slab (indices, values a waiting gene made it read, the
   * slab and its row pointers for the structure), and the row and entry it
   * goes on from. Values read whole for waiting genes (`_besideKept`) are
   * the pass's too. @private
   */
  _newPass1() {
    const { nRows, nCols, nnz } = this._options;
    const label = this._label;
    const plan = sparseIndexPlan({
      nnz,
      nCols,
      valuesOnDemand: this._options.valuesOnDemand === true,
      retainIndicesBytes: this._options.retainIndicesBytes ?? 0,
      valuesInWholeChunks: this._options.valuesInWholeChunks === true,
    });
    const retained = plan.keepsIndices ? [] : null;
    // The slabs whose indices are kept, to place them in the structure, and
    // the row pointers that place each entry in its row.
    const slabs = this._options.valuesOnDemand === true && retained !== null ? [] : null;
    this._besideKept = [];
    this._besideSpent = 0;
    return {
      // A column holds at most one entry per row, so Uint32 counts suffice
      // (rows are a uint32 axis); the offsets themselves are Float64 (exact
      // to 2^53 entries).
      counts: allocateTypedArray(Uint32Array, nCols, `${label} column counts`),
      plan,
      retained,
      // Values read in this pass for a waiting gene are kept for pass 2 too
      // (float32, as the store holds them) when every value fits the budget
      // beside the kept indices (`plan.keepsValues`), so no slab is decoded
      // twice; the slabs' entry ranges are recorded, so what pass 2 reads is
      // known exactly before it starts (`onSecondPass`).
      keptValues: [],
      slabEntryStarts: [],
      slabs,
      rowPointers: slabs === null ? null : allocateTypedArray(Float64Array, nRows + 1, `${label} row pointers`),
      nextRow: 0,
      nextEntry: 0,
    };
  }

  async _runSparse() {
    const { nRows, nCols, nnz, readIndices, readValues, storeFactory } = this._options;
    const label = this._label;
    // A slab whose values are read beside its indices (`_valuesBeside`): a
    // gene waits, and its values whole cost no more than the round trip
    // reading them after the indices would.
    this._beside = new Map();
    const readSlabIndices = async slab => {
      if (this._valuesBeside(slab)) {
        const values = readValues(slab.entryStart, slab.entryEnd, this._reads());
        values.catch(() => {});
        this._beside.set(slab.entryStart, values);
      }
      const indices = await readIndices(slab.entryStart, slab.entryEnd, this._reads());
      if (indices.length !== slab.entryEnd - slab.entryStart) {
        throw new Error(`${label} indices slab does not match its selection`);
      }
      return indices;
    };
    const readSlabValues = async slab => {
      const values = await readValues(slab.entryStart, slab.entryEnd, this._reads());
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
    const onDemand = this._options.valuesOnDemand === true;
    // What pass 1 has counted so far, slab by whole slab (`_pass1`): a build
    // that stopped (every gene it was for withdrew) keeps it, and the next
    // build goes on from the first slab not counted, so a gene asked for
    // after a cancelled one, or instead of it, never reads a counted slab
    // again.
    const pass = this._pass1 ??= this._newPass1();
    const { counts, plan, retained, keptValues, slabEntryStarts, slabs, rowPointers } = pass;
    const KeptIndex = plan.KeptIndex;
    // Over a link slower than a disk, slabs are read as many at once as
    // requests run, so the link stays full; a waiting gene's values are
    // fetched beside them, without holding up the next slab.
    const extractions = [];
    let extractionFailure = null;
    // As many slabs ahead as fill the link's bandwidth-delay product (one
    // round trip's worth of bytes), and no more than background reads run.
    const slabsAhead = onDemand ? this._slabsAhead() : 1;
    for await (const { item: slab, data: indices } of withReadAhead(this._rowSlabs(pass.nextRow, pass.nextEntry), readSlabIndices, slabsAhead)) {
      if (extractionFailure !== null) throw extractionFailure;
      const active = this._active();
      const integral = indices instanceof Int32Array || indices instanceof Uint32Array ||
        indices instanceof Uint16Array || indices instanceof Uint8Array ||
        indices instanceof Int16Array || indices instanceof Int8Array;
      // The entries counted of this slab: a stop between its parts takes
      // them back, so what the pass keeps is whole slabs only.
      let counted = 0;
      try {
        await this._sliced(slab, part => {
          const from = part.pointers[part.pointerOffset] - part.entryStart;
          const to = part.pointers[part.pointerOffset + part.rowEnd - part.rowStart] - part.entryStart;
          for (let index = from; index < to; index++) {
            const column = indices[index];
            if (!(column >= 0 && column < nCols) || (!integral && !Number.isInteger(column))) {
              throw new AnnDataFormatError(
                `Sparse matrix column index ${column} at entry ${slab.entryStart + index} is outside its ` +
                `${nCols}-column shape`
              );
            }
            counts[column]++;
          }
          counted = to;
        });
      } catch (error) {
        const from = slab.pointers[slab.pointerOffset] - slab.entryStart;
        for (let index = from; index < counted; index++) counts[indices[index]]--;
        throw error;
      }
      const slabNumber = slabEntryStarts.length;
      slabEntryStarts.push(slab.entryStart);
      if (retained !== null) retained.push(indices instanceof KeptIndex ? indices : KeptIndex.from(indices));
      if (slabs !== null) {
        slabs.push(slab);
        for (let row = slab.rowStart; row <= slab.rowEnd; row++) {
          rowPointers[row] = slab.pointers[slab.pointerOffset + row - slab.rowStart];
        }
      }
      pass.nextRow = slab.rowEnd;
      pass.nextEntry = slab.entryEnd;
      if (active !== null) {
        if (onDemand) {
          const extraction = this._extractOnDemand(active, slab, indices);
          extraction.catch(error => { extractionFailure ??= error; });
          extractions.push(extraction);
        } else {
          const values = await readSlabValues(slab);
          const extracting = performance.now();
          this._extract(active, slab, indices, values);
          this._workMs += performance.now() - extracting;
          if (plan.keepsValues) {
            keptValues[slabNumber] = values instanceof Float32Array ? values : copyTypedArray(Float32Array, values, `${this._label} values`);
          }
        }
      }
      // One pass when the structure is built from the indices kept here,
      // else a second pass follows (the store is filled from the matrix).
      this._progress(slab.entryEnd, slabs !== null ? nnz : 2 * nnz);
      await this._checkpoint();
    }
    await Promise.all(extractions);
    // Pass 1 is whole: what follows starts from its counts.
    this._pass1 = null;
    // Values read beside a slab no gene waited for in the end are let go.
    this._beside.clear();
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
      const filling = performance.now();
      slabs.forEach((slab, index) => {
        structure.writeSlab(slab, retained[index], label);
        retained[index] = null;
      });
      structure.finish(label);
      this._workMs += performance.now() - filling;
      structure.adopt(this._besideKept, this._besideSpent);
      this._besideKept = [];
      // Values read whole by a later gene: the structure is kept again, with them.
      structure.onValuesHeld = () => {
        if (!this._disposed && this._keepsBuilt && this._store === structure) this._options.onBuilt?.(structure);
      };
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
    const { store, refusal } = await storeFactory.sparse(nRows, nCols, columnStart, label);
    this._filling = store;
    await this._checkpoint();
    if (store === null) {
      await this._becomeUnindexed(refusal);
      return;
    }
    this._retainedIndices = retained;
    this._retainedValues = keptValues;
    // What pass 2 reads, exactly: the row pointers, the indices unless pass 1
    // kept them, and the values of every slab whose values it did not keep.
    const valueRanges = [];
    for (let slab = 0; slab < slabEntryStarts.length; slab++) {
      if (keptValues[slab] !== undefined) continue;
      const start = slabEntryStarts[slab];
      const end = slab + 1 < slabEntryStarts.length ? slabEntryStarts[slab + 1] : nnz;
      if (end === start) continue;
      const last = valueRanges.at(-1);
      if (last !== undefined && last[1] === start) last[1] = end;
      else valueRanges.push([start, end]);
    }
    this._options.onSecondPass?.({ indices: retained === null && nnz > 0 ? [[0, nnz]] : [], values: valueRanges });
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
    const { nnz, readIndices, readValues } = this._options;
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
        kept ?? readIndices(slab.entryStart, slab.entryEnd, this._reads()),
        keptValues ?? readValues(slab.entryStart, slab.entryEnd, this._reads()),
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
