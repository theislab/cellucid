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
 * @module data/anndata/prefix-column-index
 */

import { isArrayNode, isGroup } from '../../formats/store.js';
import { attributeValue } from './elements.js';
import { readIntegers } from './values.js';
import { checkPointers } from './sparse.js';
import { gatheredArray, pointerArray } from './views/cell-subset.js';
import { viewGroup } from './views/view-nodes.js';
import { allocateTypedArray } from '../sparse-column-index.js';

/** Entries of one slab of the index's work (`RowMajorColumnIndex`'s default; a scheduling choice). */
const SLAB_ENTRIES = 1024 * 1024;

/** The first segment's share of the rows, at least (a scheduling choice: the first colours after about this much of the work). */
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
  /**
   * Each unbuilt segment's read of `gene`: all at once when their indexes
   * fit the memory budget together (`together`: their reads then go out
   * together and fill the link, instead of one segment's round trips after
   * another's; on a 150 ms link a 1 % subsample's first gene took 2 x its
   * floor one segment at a time), else each one when the one before it is
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
    column,
    sparseColumn,
    entryCount: gene => segments.reduce((sum, segment) => sum + segment.access.entryCount(gene), 0),
    readCost: genes => segments.reduce((sum, segment) => sum + segment.access.readCost(genes), 0),
    built: () => segments.every(built),
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
