/**
 * Gene columns of a cell-major matrix (CSR, or dense in row chunks) whose
 * rows are in **priority order** (`subsample-plan.js`, `ordered`: a
 * subsample's cells, or a priority-ordered file opened whole), indexed in
 * **segments**: rows `[b0, b1)`, `[b1, b2)`, … each its own gene index
 * (`openMatrixColumns` over the segment's rows), built one after another in
 * row order. The segments double: the first is about a thirty-second of the
 * rows (at least a slab of the index's work), each next one as large as all
 * before it.
 *
 * Why, and what it gives:
 *
 * - **Progressive genes.** A gene asked for while the index builds is
 *   answered segment by segment (`column(…, {onPartial})`): after each one,
 *   the gene's values on the rows indexed so far, NaN on the others (cells
 *   not read yet, shown as missing). The rows indexed so far are a prefix of
 *   priority order, so every partial answer is a sample of the open cells
 *   (`priorityOrder`: a uniform one, or whole blocks, a cluster sample).
 * - **Reuse across openings.** Another opening of the same store whose
 *   first `L` rows are the same rows (a larger or smaller subsample of the
 *   same method and seed: `priorityOrder` makes them nested) takes over the
 *   segments within `L` (`carriedSegments`; one straddling `L` is cut to
 *   it) and indexes only the rows after `L`: raising the subsample reads
 *   only the new cells, lowering it reads nothing.
 *
 * The parts share one memory budget: each segment's store is placed with
 * what the segments before it left of the `columnIndex` budget
 * (`withMemoryBudget`), so the parts together hold what one index would.
 *
 * Rows spread through the store (`rowsInterleaved`) are not indexed in
 * priority order: they are one segment in **store order**, answered in open
 * order through `fileOrderedAccess`, or, when their own pass is more work
 * than every cell's (`wholeIsCheaper`, weighed at the measured `PassRates`),
 * **every stored row's index restricted to them** (`restrictedAccess`;
 * `AnnDataReader._restrictsWhole`). Developer doc 23 (partial reading)
 * records why and what was measured.
 *
 * @module data/anndata/prefix-column-index
 */

import { isArrayNode, isGroup } from '../../formats/store.js';
import { attributeValue } from './elements.js';
import { readIntegers } from './values.js';
import { checkPointers } from './sparse.js';
import { gatheredArray, pointerArray } from './views/cell-subset.js';
import { viewGroup } from './views/view-nodes.js';
import { allocateTypedArray } from '../sparse-column-index.js';
import { formatCountOf } from '../../utils/format-units.js';
import { orderByKey, sortByKeyWithValues } from '../../utils/radix-order.js';
import { abortReason, onAbort, throwIfAborted } from '../../utils/abort.js';
import { measureOf } from '../../utils/machine.js';

/** Entries of one slab of the index's work (`RowMajorColumnIndex`'s default; a scheduling choice). */
const SLAB_ENTRIES = 1024 * 1024;

/** The first segment's share of the rows, at least (a scheduling choice: the first colors after about this much of the work). */
const FIRST_SEGMENT_SHARE = 1 / 32;

/**
 * Segment boundaries from row `from` to `nRows`: doubling from `from`,
 * each segment at least `firstRows`. Empty when `from >= nRows`.
 *
 * @param {number} from
 * @param {number} nRows
 * @param {number} firstRows
 * @returns {number[]} The ends of the segments after `from`, ascending, the last `nRows`
 */
export function segmentBounds(from, nRows, firstRows) {
  const ends = [];
  let at = from;
  while (at < nRows) {
    at = Math.min(nRows, Math.max(at + firstRows, 2 * at));
    ends.push(at);
  }
  return ends;
}

/** The first segment's rows for a matrix of `nRows` rows of about `entriesPerRow` stored values each. */
export function firstSegmentRows(nRows, entriesPerRow) {
  return Math.max(1, Math.ceil(nRows * FIRST_SEGMENT_SHARE), Math.ceil(SLAB_ENTRIES / Math.max(1, entriesPerRow)));
}

/**
 * The ends of the segments that read genes for open rows `[from, to)` after
 * the `from` read (a gene sample grown, `AnnDataReader.growGeneSample`):
 * doubling from `from`, as the first segments doubled, so the first adds as
 * many rows as are read -- the gene sample, sized to the gene-time target:
 * the first step takes about as long as the first gene did and each later
 * one twice the one before -- and at least one slab of the index's work.
 * Never a first step of a share of every row (a small sample growing by a
 * first step of that size takes minutes: measured, 23_decisions_partial_reading.md).
 */
export function growthSegmentBounds(from, to, entriesPerRow) {
  return segmentBounds(from, to, firstSegmentRows(from, entriesPerRow));
}

/** One run `[start, end)` as `Runs` (`views/cell-subset.js`). */
function oneRun(start, end) {
  return { count: 1, starts: Float64Array.of(start), ends: Float64Array.of(end), offsets: Float64Array.of(0, end - start) };
}

/**
 * Rows `[start, end)` of a cell-major matrix as a matrix of their own: a
 * CSR group's pointers rebased (`pointers`, its whole `indptr`), its
 * `indices` and `data` the rows' entry range; a dense array's rows.
 *
 * @param {Object} matrix
 * @param {number} start
 * @param {number} end
 * @param {Float64Array|null} pointers - A CSR matrix's row pointers
 * @returns {Object}
 */
export function rowRangeMatrix(matrix, start, end, pointers) {
  if (isArrayNode(matrix)) return gatheredArray(matrix, oneRun(start, end), { mergeGapBytes: () => 0 });
  const base = pointers[start];
  const entries = oneRun(base, pointers[end]);
  const rebased = allocateTypedArray(Float64Array, end - start + 1, 'Row pointers');
  for (let i = 0; i <= end - start; i++) rebased[i] = pointers[start + i] - base;
  const shape = attributeValue(matrix, 'shape');
  const children = new Map(matrix.keys().map(key => [key, () => {
    const node = matrix.get(key);
    if (key === 'indptr') return pointerArray(node.path, rebased);
    if ((key === 'indices' || key === 'data') && isArrayNode(node)) return gatheredArray(node, entries, { mergeGapBytes: () => 0 });
    return node;
  }]));
  return viewGroup({
    path: matrix.path,
    attrs: { ...matrix.attrs, shape: [end - start, Number(shape[1])] },
    real: matrix,
    ownAttributes: ['shape'],
    children,
  });
}

/** A CSR matrix's row pointers, exact, read whole. */
export async function readRowPointers(matrix, readOptions = {}) {
  const indptr = matrix.get('indptr');
  const raw = await readIntegers(indptr, 0, indptr.shape[0], `${matrix.path} indptr`, readOptions);
  let pointers = raw;
  if (!(raw instanceof Float64Array)) {
    pointers = allocateTypedArray(Float64Array, raw.length, `${matrix.path} indptr`);
    for (let i = 0; i < raw.length; i++) pointers[i] = Number(raw[i]);
  }
  return checkPointers(pointers, matrix.get('indices').shape[0], matrix.path);
}

/** Stored values per row of a cell-major matrix, about. */
export function entriesPerRow(matrix, nRows) {
  if (isArrayNode(matrix)) return matrix.shape[1] ?? 1;
  return isGroup(matrix) && nRows > 0 ? matrix.get('indices').shape[0] / nRows : 1;
}

/**
 * A segment's access with its first `rows` rows only (a segment carried into
 * an opening whose shared prefix ends inside it).
 */
function cutAccess(access, rows) {
  return {
    ...access,
    column: async (gene, options) => (await access.column(gene, options)).slice(0, rows),
    sparseColumn: async (gene, options) => {
      const column = await access.sparseColumn(gene, options);
      let count = 0;
      while (count < column.indices.length && column.indices[count] < rows) count++;
      return { length: rows, indices: column.indices.slice(0, count), values: column.values.slice(0, count) };
    },
  };
}

/**
 * Whether the first `rows` open rows of an opening whose open row `i` is
 * stored row `fileRows[i]` lie so spread through the store that its
 * segments would each read most of its chunks (a uniform, stratified or
 * spatial share of a file in its own order: every stored chunk holds
 * cells of every segment), so the index of them is built by one scan in
 * store order instead (`fileOrderedAccess`): each stored chunk read and
 * decoded once. Segments in priority order are kept where they lie apart
 * (whole blocks, a priority-ordered file's prefix): the first segment's
 * rows then lie in a fraction of the chunks, and its genes come first.
 * `rowsPerChunk`: about how many stored rows one chunk of the matrix's
 * entries holds; `firstRows`: the first segment's rows.
 *
 * @param {Uint32Array} fileRows
 * @param {number} rows
 * @param {number} firstRows
 * @param {number} rowsPerChunk
 * @param {number} nFile - Rows of the store
 * @returns {boolean}
 */
export function rowsInterleaved(fileRows, rows, firstRows, rowsPerChunk, nFile) {
  if (!(rowsPerChunk > 0) || firstRows >= rows) return false;
  const nChunks = Math.ceil(nFile / rowsPerChunk) + 1;
  const chunks = allocateTypedArray(Uint8Array, nChunks, 'Stored chunks reached');
  let ascending = true;
  let inFirst = 0;
  let inAll = 0;
  for (let i = 0; i < rows; i++) {
    const row = fileRows[i];
    if (i > 0 && row < fileRows[i - 1]) ascending = false;
    // Out of order, the first segment reaching half of every chunk there
    // is answers it: the rest reach no more chunks than there are.
    if (i === firstRows && !ascending && 2 * inFirst >= nChunks) return true;
    const chunk = Math.floor(row / rowsPerChunk);
    if (chunks[chunk] === 0) {
      chunks[chunk] = 1;
      inAll++;
      if (i < firstRows) inFirst++;
    }
  }
  // Rows in store order are their own scan; otherwise interleaved when the
  // first segment alone already reaches half of the chunks of them all.
  return !ascending && 2 * inFirst >= inAll;
}

/**
 * Column access over rows in store order (`access`, an index of a matrix
 * whose row `i` is open row `viewRows[i]`), answering in open order: a
 * column scattered back to open rows, a sparse column's cells mapped and
 * put in ascending order. The index's own scan then reads the store in
 * order, each chunk once, whatever order the rows are open in.
 *
 * @param {import('./matrix-access.js').MatrixColumns} access
 * @param {Uint32Array} viewRows - Open row of each of the access's rows (a permutation of `[0, n)`)
 * @param {{note: (entries: number, ms: number) => void}|null} [placing] - Hears
 *   each sparse gene's placement: the entries it placed and its time
 *   (`PassRates.placing('own')`)
 * @returns {import('./matrix-access.js').MatrixColumns}
 */
export function fileOrderedAccess(access, viewRows, placing = null) {
  const n = viewRows.length;
  let inRuns;
  /** The runs `viewRows` opens (`runsOfOpenRows`), found once; null when they are about as many as rows. */
  const openRuns = () => {
    if (inRuns === undefined) inRuns = runsOfOpenRows(viewRows);
    return inRuns;
  };
  return {
    ...access,
    column: async (gene, options) => {
      const stored = await access.column(gene, options);
      const out = allocateTypedArray(Float32Array, n, 'Gene column');
      for (let i = 0; i < n; i++) out[viewRows[i]] = stored[i];
      return out;
    },
    sparseColumn: async (gene, options) => {
      const stored = await access.sparseColumn(gene, options);
      const began = performance.now();
      // Rows a `blocks` order opens in runs (fewer than the gene's entries):
      // placed run by run, no lookup scattered through memory, no sort.
      const runs = openRuns();
      let placed;
      if (runs !== null && runs.count < stored.indices.length) {
        placed = { length: n, ...entriesByRun(stored, runs, 0, n) };
      } else {
        const indices = allocateTypedArray(Uint32Array, stored.indices.length, 'Gene column cells');
        const values = allocateTypedArray(Float32Array, stored.indices.length, 'Gene column values');
        for (let e = 0; e < indices.length; e++) {
          indices[e] = viewRows[stored.indices[e]];
          values[e] = stored.values[e];
        }
        // Sorted where they are, each value with its cell.
        sortByKeyWithValues(indices, values);
        placed = { length: n, indices, values };
      }
      placing?.note(stored.indices.length, performance.now() - began);
      return placed;
    },
  };
}

/**
 * What the work of a gene index pass costs on one source, as measured
 * while passes run (carried to every opening of the same store): `index`,
 * the index's own work per entry it indexes (`RowMajorColumnIndex`
 * `onWork`: its parts, the structure filled); `view`, the work a subsample
 * view does of its own per entry a pass over it indexes (`view`, the
 * `ViewMeter` its matrices are made with: their kept rows' pointers, the
 * rows put in file order, the entries gathered out of decoded chunks, the
 * kept values counted). What weighs a share's pass in store order against
 * every stored row's pass restricted to it (`wholeIsCheaper`); no rate is
 * assumed before one is measured.
 */
export class PassRates {
  constructor() {
    this._index = { entries: 0, ms: 0 };
    this._view = { entries: 0, ms: 0 };
    this._place = { whole: { entries: 0, ms: 0 }, own: { entries: 0, ms: 0 } };
    /** @type {import('./views/cell-subset.js').ViewMeter} */
    this.view = Object.freeze({ note: ms => { this._view.ms += ms; } });
  }

  /**
   * What hears a sparse gene's placement in open order, per entry it walks:
   * `'whole'`, every stored row's entries restricted to a share's rows
   * (`restrictedAccess`); `'own'`, a share's own entries in store order
   * (`fileOrderedAccess`).
   *
   * @param {'whole'|'own'} kind
   * @returns {{note: (entries: number, ms: number) => void}}
   */
  placing(kind) {
    const rate = this._place[kind];
    if (rate === undefined) throw new TypeError(`Unknown placement '${String(kind)}'`);
    return Object.freeze({
      note: (entries, ms) => {
        if (!(entries > 0) || !(ms >= 0)) return;
        rate.entries += entries;
        rate.ms += ms;
      },
    });
  }

  /**
   * A pass built an index (`onWork`): `entries` indexed in `ms` of its own
   * work; `overView`, over a subsample view's rows (the view's work since
   * is per entry of it).
   */
  noteIndex({ entries, ms }, { overView = false } = {}) {
    this._index.entries += entries;
    this._index.ms += ms;
    if (overView) this._view.entries += entries;
  }

  /**
   * Milliseconds per entry of the index's own work (`index`), the view's
   * (`view`), or a gene's placement in open order (`placeWhole`, per entry of
   * every stored row's; `placeOwn`, per entry of the share's), or null before
   * measured.
   */
  msPerEntry(kind) {
    const rate = kind === 'index' ? this._index
      : kind === 'view' ? this._view
        : kind === 'placeWhole' ? this._place.whole
          : kind === 'placeOwn' ? this._place.own
            : null;
    if (rate === null) throw new TypeError(`Unknown pass rate '${String(kind)}'`);
    // The machine's `indexPassMs` (`utils/machine.js`): held, each rate is
    // the held one, and not measured where the hold names none.
    const held = measureOf('indexPassMs', () => undefined);
    if (held !== undefined) return held?.[kind] ?? null;
    return rate.entries > 0 && rate.ms > 0 ? rate.ms / rate.entries : null;
  }
}

/**
 * Whether open rows holding `keptEntries` of a matrix's `allEntries`
 * stored entries, spread through the store, are indexed and answered for
 * less work by the pass every cell makes, over every stored row, restricted
 * to them (`restrictedAccess`) than by their own pass in store order
 * (`fileOrderedAccess`, over their view). Asked only when both read the same
 * stored bytes (the rows lie in every chunk), so decoding costs the same.
 * Weighed per entry (`rates`: `PassRates`, measured on this source) over an
 * index built and each of its genes answered once, in open order: the whole
 * indexes every entry and places every stored row's entries of a gene (each
 * tested, those of open rows looked up and sorted: `placeWhole`); the
 * share's pass indexes its own entries, its view gathers them (`view`), and
 * a gene places its own (`placeOwn`). A rate not measured yet counts as its
 * counterpart's (the index's as the view's, one placement as the other);
 * neither measured, as many operations an entry as the index's, so a share
 * keeping at least two thirds of the entries reads every stored row's. A
 * gene's placement over every stored row's index is the whole's entries,
 * twice the share's (measured: 23_decisions_partial_reading.md).
 *
 * @param {{keptEntries: number, allEntries: number, rates: PassRates|null}} options
 * @returns {boolean}
 */
export function wholeIsCheaper({ keptEntries, allEntries, rates }) {
  const index = rates?.msPerEntry('index') ?? null;
  const view = rates?.msPerEntry('view') ?? null;
  const indexMs = index ?? view ?? 1;
  const viewMs = view ?? index ?? 1;
  const wholePlace = rates?.msPerEntry('placeWhole') ?? null;
  const ownPlace = rates?.msPerEntry('placeOwn') ?? null;
  const placeWholeMs = wholePlace ?? ownPlace ?? indexMs;
  const placeOwnMs = ownPlace ?? wholePlace ?? indexMs;
  return allEntries * (indexMs + placeWholeMs) <= keptEntries * (indexMs + viewMs + placeOwnMs);
}

/**
 * Entries `indices`/`values` of a gene over stored rows placed on their open
 * rows of `out` (`openRows`: a table of each stored row's, or a lookup; less
 * `start`, kept within `out`), those of rows not open skipped by their bit
 * (`openBits`, `openRowBits`) before any lookup. Loops of their own, typed
 * by their arguments.
 */
function placeEntries(indices, values, openRows, openBits, start, out) {
  const n = out.length;
  if (openRows instanceof Int32Array) {
    for (let e = 0; e < indices.length; e++) {
      const row = indices[e];
      if ((openBits[row >>> 5] & (1 << (row & 31))) === 0) continue;
      const at = openRows[row] - start;
      if (at >= 0 && at < n) out[at] = values[e];
    }
    return;
  }
  for (let e = 0; e < indices.length; e++) {
    const row = indices[e];
    if ((openBits[row >>> 5] & (1 << (row & 31))) === 0) continue;
    const at = openRows(row) - start;
    if (at >= 0 && at < n) out[at] = values[e];
  }
}

/**
 * A bit for each of `nStored` stored rows, set for the rows `fileRows` opens
 * (an eighth of a byte a stored row: 1.25 MB at 10M, held in a core's cache
 * where the open rows' table, 40 MB, is not). A gene's entries over every
 * stored row are tested against it, and only those of open rows looked up:
 * at a 50% uniform share half the lookups, each a cache miss, are not made.
 *
 * @param {Uint32Array} fileRows
 * @param {number} nStored
 * @returns {Uint32Array}
 */
function openRowBits(fileRows, nStored) {
  const bits = allocateTypedArray(Uint32Array, Math.ceil(nStored / 32), 'Open stored rows');
  for (let i = 0; i < fileRows.length; i++) {
    const row = fileRows[i];
    bits[row >>> 5] |= 1 << (row & 31);
  }
  return bits;
}

/** A column of every stored row's values that are not zero placed on their open rows of `out` (as `placeEntries`). */
function placeValues(whole, openRows, start, out) {
  const n = out.length;
  if (openRows instanceof Int32Array) {
    for (let row = 0; row < whole.length; row++) {
      const value = whole[row];
      if (value === 0) continue;
      const at = openRows[row] - start;
      if (at >= 0 && at < n) out[at] = value;
    }
    return;
  }
  for (let row = 0; row < whole.length; row++) {
    const value = whole[row];
    if (value === 0) continue;
    const at = openRows(row) - start;
    if (at >= 0 && at < n) out[at] = value;
  }
}

/** Of entries over stored rows (`indices`, `values`), those on open rows `[start, start + n)`: their open row less `start` into `mapped`, their value into `kept`; how many. A row not open is skipped by its bit (`openBits`) before any lookup. */
function mappedEntries(indices, values, openRows, openBits, start, n, mapped, kept) {
  let count = 0;
  if (openRows instanceof Int32Array) {
    for (let e = 0; e < indices.length; e++) {
      const row = indices[e];
      if ((openBits[row >>> 5] & (1 << (row & 31))) === 0) continue;
      const at = openRows[row] - start;
      if (at >= 0 && at < n) {
        mapped[count] = at;
        kept[count++] = values[e];
      }
    }
    return count;
  }
  for (let e = 0; e < indices.length; e++) {
    const row = indices[e];
    if ((openBits[row >>> 5] & (1 << (row & 31))) === 0) continue;
    const at = openRows(row) - start;
    if (at >= 0 && at < n) {
      mapped[count] = at;
      kept[count++] = values[e];
    }
  }
  return count;
}

/**
 * Of a gene's entries over rows (`whole`, rows ascending), those on open
 * rows `[start, start + n)`, in open order, through runs of rows open one
 * after another (`runs`: rows `rowStarts[r]` to `rowEnds[r]` open from
 * `openStarts[r]`; `byRow`, the runs by row; `byOpen`, by open row): each
 * entry's run met walking runs and entries both by row, the entries
 * counted by run, then placed run by run in open order (within a run, rows
 * ascend in both). Exactly the entries and order a lookup of each row and a
 * sort give, with no lookup scattered through memory and no sort.
 */
function entriesByRun(whole, runs, start, n) {
  const { count, rowStarts, rowEnds, openStarts, byRow, byOpen } = runs;
  const rows = whole.indices;
  const placed = allocateTypedArray(Uint32Array, count, 'Gene column runs');
  // Counted by run, then placed by run: two walks of the entries and the
  // runs by row, each entry's run met as the walk reaches it.
  let k = 0;
  let kept = 0;
  for (let e = 0; e < rows.length; e++) {
    const row = rows[e];
    while (k < count && rowEnds[byRow[k]] <= row) k++;
    if (k === count) break;
    const r = byRow[k];
    const at = openStarts[r] + (row - rowStarts[r]) - start;
    if (rowStarts[r] <= row && at >= 0 && at < n) {
      placed[r]++;
      kept++;
    }
  }
  let sum = 0;
  for (let o = 0; o < count; o++) {
    const r = byOpen[o];
    const entries = placed[r];
    placed[r] = sum;
    sum += entries;
  }
  const indices = allocateTypedArray(Uint32Array, kept, 'Gene column cells');
  const values = allocateTypedArray(Float32Array, kept, 'Gene column values');
  k = 0;
  for (let e = 0; e < rows.length; e++) {
    const row = rows[e];
    while (k < count && rowEnds[byRow[k]] <= row) k++;
    if (k === count) break;
    const r = byRow[k];
    const at = openStarts[r] + (row - rowStarts[r]) - start;
    if (rowStarts[r] <= row && at >= 0 && at < n) {
      const to = placed[r]++;
      indices[to] = at;
      values[to] = whole.values[e];
    }
  }
  return { indices, values };
}

/** `0, 1, …, count − 1`. */
function identityOrder(count) {
  const order = allocateTypedArray(Uint32Array, count, 'Run order');
  for (let r = 0; r < count; r++) order[r] = r;
  return order;
}

/**
 * The runs of rows `viewRows` opens one after another (row `i` at open row
 * `viewRows[i]`: `viewRows[i + 1] = viewRows[i] + 1` within a run), as
 * `entriesByRun` takes them; null when they would hold more than the
 * lookup they replace (`viewRows`, 4 bytes a row; a run holds 12): rows
 * spread through the store, a run of a row or two each.
 */
function runsOfOpenRows(viewRows) {
  const n = viewRows.length;
  let count = n > 0 ? 1 : 0;
  for (let i = 1; i < n; i++) if (viewRows[i] !== viewRows[i - 1] + 1) count++;
  if (3 * count > n) return null;
  const rowStarts = allocateTypedArray(Uint32Array, count, 'Open runs');
  const rowEnds = allocateTypedArray(Uint32Array, count, 'Open runs');
  const openStarts = allocateTypedArray(Uint32Array, count, 'Open runs');
  let r = -1;
  for (let i = 0; i < n; i++) {
    if (i === 0 || viewRows[i] !== viewRows[i - 1] + 1) {
      r++;
      rowStarts[r] = i;
      openStarts[r] = viewRows[i];
    }
    rowEnds[r] = i + 1;
  }
  return { count, rowStarts, rowEnds, openStarts, byRow: identityOrder(count), byOpen: orderByKey(openStarts) };
}


/**
 * Column access over open rows `[start, start + fileRows.length)` from the
 * index of every stored row (`access`, as every cell's opening builds it:
 * `AnnDataReader._restrictsWhole`): each value of a gene that is not zero
 * placed on its open row (`positions`, the open cells' lookup), from its
 * entries once the index is built, else from the column its pass fills; a
 * sparse column's cells then put in ascending order. Never a walk of the
 * open rows, nor a column of every stored row once built. Values bit for
 * bit those of the rows' own index.
 *
 * @param {import('./matrix-access.js').MatrixColumns} access - Every stored row's
 * @param {Uint32Array} fileRows - Stored row of each open row of the segment
 * @param {() => {table: Int32Array|null, get: (row: number) => number}} positions - The open row of each
 *   stored row (-1 not open: `CellRows` `positions`), made when a gene is first placed
 * @param {number} start - The segment's first open row
 * @param {(() => {count: number, starts: ArrayLike<number>, ends: ArrayLike<number>, offsets: ArrayLike<number>})|null} [runs] -
 *   The open rows' runs of stored rows, in open order (`CellRows` `runs`),
 *   made when a gene is first placed; given when every stored row is open
 *   (their order is then a few runs, a `blocks` order's blocks)
 * @param {{note: (entries: number, ms: number) => void}|null} [placing] - Hears
 *   each sparse gene's placement: every stored row's entries it walked and
 *   its time (`PassRates.placing('whole')`)
 * @returns {import('./matrix-access.js').MatrixColumns}
 */
export function restrictedAccess(access, fileRows, positions, start, runs = null, placing = null) {
  const n = fileRows.length;
  let lookup = null;
  /** The open row (less `start`) of each stored row: a table, or a lookup (`KeptPositions`). */
  const openRows = () => {
    lookup ??= positions();
    return lookup.table ?? (row => lookup.get(row));
  };
  let bits = null;
  /** The segment's open rows' bits over the `nStored` stored rows (`openRowBits`), made once. */
  const openBits = nStored => {
    bits ??= openRowBits(fileRows, nStored);
    return bits;
  };
  let byStoredRow = null;
  /** The open rows' runs (`runs`, in open order) by stored row, as `entriesByRun` takes them, made once; null without them. */
  const storedRuns = () => {
    if (runs === null) return null;
    if (byStoredRow === null) {
      const { count, starts, ends, offsets } = runs();
      const firsts = allocateTypedArray(Uint32Array, count, 'Open runs by stored row');
      for (let r = 0; r < count; r++) firsts[r] = starts[r];
      byStoredRow = { count, rowStarts: starts, rowEnds: ends, openStarts: offsets, byRow: orderByKey(firsts), byOpen: identityOrder(count) };
    }
    return byStoredRow;
  };
  // Whether a gene was answered by the pass: every pass row is seen then.
  let answered = false;
  /**
   * A gene asked for once one was answered by the pass while the index is
   * still built is answered as the build ends, as every cell's is (it saw
   * no pass from its first row): it waits for the build, then reads its
   * entries alone.
   */
  const built = async (options = {}) => {
    if (access.built?.() === true || !answered || access.building?.() !== true) return;
    const signal = options.signal ?? null;
    throwIfAborted(signal);
    let stop = () => {};
    try {
      await Promise.race([
        Promise.resolve(access.prepare?.()).catch(() => {}),
        new Promise((_resolve, reject) => { stop = onAbort(signal, () => reject(abortReason(signal))); }),
      ]);
    } finally {
      stop();
    }
  };
  return {
    ...access,
    column: async (gene, options) => {
      await built(options);
      const out = allocateTypedArray(Float32Array, n, 'Gene column');
      if (access.built?.() === true) {
        // Its entries alone, each placed on its open row.
        const entries = await access.sparseColumn(gene, options);
        placeEntries(entries.indices, entries.values, openRows(), openBits(entries.length), start, out);
        return out;
      }
      // Answered by the pass (the column of every stored row it fills): a
      // walk in stored order, each value that is not zero placed (a zero is
      // the column's own; the pass never leaves a negative zero).
      placeValues(await access.column(gene, options), openRows(), start, out);
      answered = true;
      return out;
    },
    sparseColumn: async (gene, options) => {
      await built(options);
      const whole = await access.sparseColumn(gene, options);
      const began = performance.now();
      const placed = placedEntries(whole);
      placing?.note(whole.indices.length, performance.now() - began);
      return placed;
    },
  };

  /** A gene's entries over every stored row (`whole`) placed in open order. */
  function placedEntries(whole) {
    // Fewer runs than entries (every cell open in a `blocks` order: a run
    // a block): each entry's run found walking both in stored order, the
    // entries put in open order run by run, with no lookup of a row
    // scattered through memory and no sort (measured:
    // 23_decisions_partial_reading.md).
    const inRuns = storedRuns();
    if (inRuns !== null && inRuns.count < whole.indices.length) return { length: n, ...entriesByRun(whole, inRuns, start, n) };
    const mapped = allocateTypedArray(Uint32Array, whole.indices.length, 'Gene column cells');
    const kept = allocateTypedArray(Float32Array, whole.indices.length, 'Gene column values');
    const count = mappedEntries(whole.indices, whole.values, openRows(), openBits(whole.length), start, n, mapped, kept);
    // Sorted where they are, each value with its cell.
    sortByKeyWithValues(mapped.subarray(0, count), kept.subarray(0, count));
    return count === mapped.length
      ? { length: n, indices: mapped, values: kept }
      : { length: n, indices: mapped.slice(0, count), values: kept.slice(0, count) };
  }
}

/**
 * @typedef {Object} Segment
 * @property {number} start - Its first row
 * @property {number} rows - Its rows
 * @property {import('./matrix-access.js').MatrixColumns} access
 * @property {number} [residentBytes] - What its index holds once built, about
 *   (`columnIndexResidentBytes`): whether unbuilt segments fit the budget together
 */

/**
 * The segments of `columns` (a `segmentedColumns`) within its first `rows`
 * rows, for an opening that shares them: those wholly within, and one cut to
 * end at `rows`; the others are let go.
 *
 * @param {Object} columns
 * @param {number} rows
 * @returns {Segment[]}
 */
export function carriedSegments(columns, rows) {
  const kept = [];
  for (const segment of columns.segments) {
    if (segment.start >= rows) {
      (segment.access.retire ?? segment.access.dispose)?.();
      continue;
    }
    const end = segment.start + segment.rows;
    kept.push(end <= rows ? segment : { start: segment.start, rows: rows - segment.start, access: cutAccess(segment.access, rows - segment.start) });
  }
  return kept;
}

/**
 * Column access over consecutive segments of rows (`MatrixColumns`, as
 * `openMatrixColumns` gives), with the segments themselves (`segments`).
 *
 * The segments cover the first `readRows()` rows: every row, or the gene
 * sample of an opening whose genes are read for its first open cells only
 * (`subsample-plan.js`, `genes`). A row past them has no value: NaN in a
 * column, and no entry in a sparse column, which a caller reads only on
 * rows below `readRows()` (an entry left out there is a zero; past it, a
 * row not read). `extend(more)` appends segments for rows after them, and
 * `trimTo(rows)` lets the unbuilt ones past `rows` go (a gene sample grown,
 * or a growth stopped part way).
 *
 * `column(gene, {onPartial})`: segments already built are read at once,
 * the others one after another in row order (each read starts its index);
 * before waiting for one, `onPartial(values, rows)` is called with the
 * gene on the rows answered so far and NaN on the rest (a copy the caller
 * owns). `prepare()` builds the segments one after another.
 *
 * @param {{nRows: number, segments: Segment[], together?: (segments: Segment[]) => boolean}} options
 *   `together`: whether the indexes of these unbuilt segments fit the memory
 *   budget at once (their builds then run together)
 */
export function segmentedColumns({ nRows, segments, together = () => false }) {
  const built = segment => segment.access.built?.() === true;
  const readRows = () => (segments.length === 0 ? 0 : segments.at(-1).start + segments.at(-1).rows);
  /**
   * Each unbuilt segment's read of `gene`: all at once when their indexes
   * fit the memory budget together (`together`: their reads then go out
   * together and fill the link, instead of one segment's round trips after
   * another's: measured, 23_decisions_partial_reading.md), else each one when the one before it is
   * done. Answered in row order either way.
   */
  const unbuiltReads = (unbuilt, read) => {
    if (unbuilt.length < 2 || !together(unbuilt)) return unbuilt.map(segment => () => read(segment));
    const started = unbuilt.map(segment => read(segment));
    started.forEach(promise => promise.catch(() => {}));
    return started.map(promise => () => promise);
  };
  const column = async (gene, options = {}) => {
    const { onPartial = null, ...readOptions } = options;
    const out = allocateTypedArray(Float32Array, nRows, 'Gene column');
    let answered = 0;
    let first = 0;
    // The built prefix of segments, read together.
    while (first < segments.length && built(segments[first])) first++;
    const parts = await Promise.all(segments.slice(0, first).map(segment => segment.access.column(gene, readOptions)));
    parts.forEach((part, s) => out.set(part.subarray(0, segments[s].rows), segments[s].start));
    if (first > 0) answered = segments[first - 1].start + segments[first - 1].rows;
    const reads = unbuiltReads(segments.slice(first), segment => segment.access.column(gene, readOptions));
    for (let s = first; s < segments.length; s++) {
      const segment = segments[s];
      if (onPartial !== null && answered > 0) {
        const partial = out.slice();
        partial.fill(Number.NaN, answered);
        onPartial(partial, answered);
      }
      const part = await reads[s - first]();
      out.set(part.subarray(0, segment.rows), segment.start);
      answered = segment.start + segment.rows;
    }
    // Rows past the segments were not read: no value, never a zero.
    if (answered < nRows) out.fill(Number.NaN, answered);
    return out;
  };
  const sparseColumn = async (gene, options = {}) => {
    const { onPartial: _onPartial, ...readOptions } = options;
    let first = 0;
    while (first < segments.length && built(segments[first])) first++;
    const parts = await Promise.all(segments.slice(0, first).map(segment => segment.access.sparseColumn(gene, readOptions)));
    for (const read of unbuiltReads(segments.slice(first), segment => segment.access.sparseColumn(gene, readOptions))) parts.push(await read());
    let count = 0;
    parts.forEach((part, s) => {
      for (let e = 0; e < part.indices.length && part.indices[e] < segments[s].rows; e++) count++;
    });
    const indices = allocateTypedArray(Uint32Array, count, 'Gene column cells');
    const values = allocateTypedArray(Float32Array, count, 'Gene column values');
    let at = 0;
    parts.forEach((part, s) => {
      const { start, rows } = segments[s];
      for (let e = 0; e < part.indices.length && part.indices[e] < rows; e++) {
        indices[at] = start + part.indices[e];
        values[at++] = part.values[e];
      }
    });
    return { length: nRows, indices, values };
  };
  let preparing = null;
  return {
    segments,
    readRows,
    extend(more) {
      for (const segment of more) {
        if (segment.start !== readRows()) throw new RangeError(`A segment of rows from ${segment.start} does not follow the ${formatCountOf(readRows(), 'row')} indexed.`);
        segments.push(segment);
      }
      preparing = null;
    },
    trimTo(rows) {
      while (segments.length > 0 && segments.at(-1).start >= rows && !built(segments.at(-1))) {
        const segment = segments.pop();
        (segment.access.retire ?? segment.access.dispose)?.();
      }
      preparing = null;
    },
    column,
    sparseColumn,
    entryCount: gene => segments.reduce((sum, segment) => sum + segment.access.entryCount(gene), 0),
    readCost: genes => segments.reduce((sum, segment) => sum + segment.access.readCost(genes), 0),
    passCost: () => segments.reduce((sum, segment) => sum + (segment.access.passCost?.() ?? 0), 0),
    built: () => segments.every(built),
    building: () => segments.some(segment => segment.access.building?.() === true),
    residentBytes: () => segments.reduce((sum, segment) => sum + (segment.access.residentBytes?.() ?? 0), 0),
    prepare() {
      preparing ??= (async () => {
        for (const segment of segments) await segment.access.prepare?.();
      })();
      preparing.catch(() => { preparing = null; });
      return preparing;
    },
    retire: () => segments.forEach(segment => (segment.access.retire ?? segment.access.dispose)?.()),
    dispose: () => segments.forEach(segment => segment.access.dispose?.()),
  };
}

/**
 * A store factory whose memory budget, each time a store is placed, is what
 * `used()` leaves of `base`'s: the segments of one index share it.
 *
 * @param {Object} base - `createColumnStoreFactory`
 * @param {() => number} used
 */
export function sharedBudgetFactory(base, used) {
  const now = () => base.withMemoryBudget(Math.max(0, base.memoryBudgetBytes - used()));
  return {
    get memoryBudgetBytes() { return Math.max(0, base.memoryBudgetBytes - used()); },
    withMemoryBudget: bytes => base.withMemoryBudget(bytes),
    plan: bytes => now().plan(bytes),
    sparse: (...args) => now().sparse(...args),
    dense: (...args) => now().dense(...args),
  };
}

/**
 * One read activity for the index pass of every unbuilt segment, as a gene
 * waits for all of them: what it reads is the whole gene's (the rows of
 * every open cell not indexed yet), so its bytes, progress and time left are
 * the whole gene's, never one segment's (a segment's own time left would
 * be followed by a twice larger one, and the next, so the gene would look
 * endless).
 *
 * `create(label)` makes the activity (null when nothing reports); `bytesFrom(row)`
 * resolves the stored bytes the passes read from `row` to the last row read
 * (`nRows`: a count, or a function giving it now -- the end of a gene
 * sample, which grows).
 * Returns `onIndexStart` for the segment at `start` of `rows` rows (as
 * `openMatrixColumns` takes it): the first build of a run of segments starts
 * the activity and expects the bytes from its row on; each segment's
 * progress counts as its share of those rows; the activity ends when the
 * last segment is built, or with the first build that stops or fails (the
 * next build starts a new one with what is left). A rescan (an index no
 * store could hold) is its own activity, from `createRescan`.
 *
 * @param {{nRows: number|(() => number), create: (label: string|null) => Object|null,
 *   createRescan: (label: string|null, rescan: string) => Object|null, bytesFrom: (row: number) => Promise<number|null>}} options
 * @returns {(start: number, rows: number) => (label: string|null, options?: {rescan?: string|null}) => Object|null}
 */
export function wholeGeneIndexActivity({ nRows: rowsRead, create, createRescan, bytesFrom }) {
  let current = null;
  return (start, rows) => (label, { rescan = null } = {}) => {
    if (rescan !== null) return createRescan(label, rescan);
    const nRows = typeof rowsRead === 'function' ? rowsRead() : rowsRead;
    if (current === null || current.activity.status !== 'running') {
      const activity = create(label);
      if (activity === null) return null;
      current = { activity, from: start, shares: new Map() };
      bytesFrom(start).then(bytes => { if (bytes > 0) activity.expect(bytes); }, () => {});
    }
    const run = current;
    const { activity } = run;
    const total = nRows - run.from;
    const progress = (done, of) => {
      // Segments built together may report after the last one ended the activity.
      if (activity.status !== 'running') return;
      run.shares.set(start, of > 0 ? Math.min(1, done / of) : 0);
      let rowsDone = 0;
      for (const [segmentStart, share] of run.shares) {
        rowsDone += share * (segmentStart === start ? rows : run.rowsOf.get(segmentStart) ?? 0);
      }
      activity.progress(Math.round(rowsDone), total);
    };
    (run.rowsOf ??= new Map()).set(start, rows);
    if (start + rows >= nRows) run.lastRows = rows;
    return new Proxy(activity, {
      get(target, property) {
        // The whole was expected as the activity started; a segment's own expectation is part of it.
        if (property === 'expect') return () => {};
        if (property === 'progress') return progress;
        if (property === 'finish') {
          return (error = null) => {
            if (error !== null) {
              target.finish(error);
              return;
            }
            progress(1, 1);
            // Ended once the segment holding the last row and every other of the run are built (built together, any may end last).
            if (run.rowsOf.has(nRows - run.lastRows) && [...run.shares.values()].every(share => share >= 1) && run.rowsOf.size === run.shares.size) target.finish();
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, property, value) {
        target[property] = value;
        return true;
      },
    });
  };
}
