/**
 * @fileoverview Gene deliveries: the genes an analysis reads, sent by the
 * AnnData reader worker straight to the analysis worker that computes them,
 * so their values never cross the page's thread.
 *
 * An analysis run opens a gene route (`app/analysis/data/gene-route.js`):
 * one `MessageChannel` per analysis worker, the reader holding one port of
 * each and the worker the other. A delivery request (`deliverColumns`,
 * `deliverCellSubset` in `anndata-reader-worker.js`) reads genes and posts
 * them, transferred, to the workers it names; the page hears only how many
 * bytes went. A worker task then names its delivery instead of carrying the
 * values (`compute/data-worker.js` takes it from the worker's inbox).
 *
 * Every port of a route has a generation. A worker the pool replaced (a
 * cancelled task outlived its grace, `worker-pool.js`) gets a new port, one
 * generation on; a delivery made for an older generation is dropped, and the
 * task naming it answers `lost`, so the run reads those genes again.
 *
 * What a delivery holds:
 * - `columns`: each gene's non-zero entries (`SparseColumn`,
 *   `{length, indices, values}`), each run of a read's genes (one task's) to
 *   its worker;
 * - `ranges`: each gene's entries in one contiguous range of cells,
 *   `{pointers, cells, values}` with cells counted from the range's start,
 *   one range to each worker (UCell, `compute/ucell.js`);
 * - `block`: a run of genes of a cell subset, `{pointers, positions,
 *   values}` with positions into the subset, each run to its worker
 *   (differential expression of two groups read by cell).
 *
 * @module data/gene-delivery
 */

import { allocateTypedArray } from './sparse-column-index.js';

function requireName(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireIndex(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return value;
}

/**
 * Where a column delivery goes, checked: each run of its genes to its worker
 * (`{route, runs}`, as `requireRunDelivery`), or one range of cells of every
 * gene to each worker (`{route, id, split, generations}`, `split` the
 * ranges' bounds, one more than the workers).
 *
 * @param {Object} delivery
 * @param {number} geneCount
 * @returns {Object}
 */
export function requireColumnDelivery(delivery, geneCount) {
  if (delivery === null || typeof delivery !== 'object') {
    throw new TypeError('A gene delivery names its route and where it goes.');
  }
  if (delivery.split === undefined) return requireRunDelivery(delivery, geneCount);
  requireName(delivery.route, 'A gene delivery route');
  requireIndex(delivery.id, 'A gene delivery id');
  const { split, generations } = delivery;
  if (!(split instanceof Uint32Array) || split.length < 2 || !Array.isArray(generations) || generations.length !== split.length - 1) {
    throw new TypeError('A split gene delivery names one range of cells and one port generation per worker.');
  }
  for (let range = 1; range < split.length; range++) {
    if (split[range] < split[range - 1]) throw new RangeError('A split gene delivery\'s ranges must ascend.');
  }
  generations.forEach((generation, worker) => requireIndex(generation, `Worker ${worker}'s port generation`));
  return delivery;
}

/**
 * Where the runs of a delivery go, checked: `{route, runs: [{id, worker,
 * generation, first, last}]}`, the runs covering its genes in order (each
 * run one task's genes).
 *
 * @param {Object} delivery
 * @param {number} geneCount
 * @returns {Object}
 */
export function requireRunDelivery(delivery, geneCount) {
  if (delivery === null || typeof delivery !== 'object' || !Array.isArray(delivery.runs) || delivery.runs.length === 0) {
    throw new TypeError('A gene delivery names its route and its runs of genes.');
  }
  requireName(delivery.route, 'A gene delivery route');
  let next = 0;
  for (const run of delivery.runs) {
    requireIndex(run.id, 'A gene delivery id');
    requireIndex(run.worker, 'A gene delivery worker');
    requireIndex(run.generation, 'A gene delivery port generation');
    if (run.first !== next || !Number.isSafeInteger(run.last) || run.last <= run.first) {
      throw new RangeError('A gene delivery\'s runs must cover its genes in order.');
    }
    next = run.last;
  }
  if (next !== geneCount) throw new RangeError('A gene delivery\'s runs must cover its genes in order.');
  return delivery;
}

/** The first entry of ascending `indices` at or past `cell`. */
export function lowerBoundOf(indices, cell) {
  let lo = 0;
  let hi = indices.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (indices[mid] < cell) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A gene's values as its non-zero entries (`SparseColumn`): a dense column's
 * non-zero values (NaN included) with their cells, a sparse one as it is.
 *
 * @param {Float32Array|{length: number, indices: Uint32Array, values: Float32Array}} column
 * @returns {{length: number, indices: Uint32Array, values: Float32Array}}
 */
export function sparseEntriesOf(column) {
  if (!ArrayBuffer.isView(column)) return column;
  let count = 0;
  for (let cell = 0; cell < column.length; cell++) if (column[cell] !== 0) count++;
  const indices = allocateTypedArray(Uint32Array, count, 'Gene column cells');
  const values = allocateTypedArray(Float32Array, count, 'Gene column values');
  let at = 0;
  for (let cell = 0; cell < column.length; cell++) {
    if (column[cell] !== 0) {
      indices[at] = cell;
      values[at] = column[cell];
      at++;
    }
  }
  return { length: column.length, indices, values };
}

/**
 * Some genes' entries in each of contiguous ranges of cells: range `w` holds
 * cells `bounds[w]` to `bounds[w + 1]`, renumbered from `bounds[w]`; gene
 * `g`'s entries are `pointers[g]` to `pointers[g + 1]` of the range.
 *
 * @param {ReadonlyArray<{indices: Uint32Array, values: Float32Array}>} columns -
 *   Each gene's non-zero entries, ascending
 * @param {ArrayLike<number>} bounds
 * @returns {Array<{pointers: Uint32Array, cells: Uint32Array, values: Float32Array}>}
 */
export function splitColumnsByCellRanges(columns, bounds) {
  const ranges = bounds.length - 1;
  const genes = columns.length;
  const starts = allocateTypedArray(Uint32Array, genes * (ranges + 1), 'Gene delivery range starts');
  const sizes = allocateTypedArray(Float64Array, ranges, 'Gene delivery range sizes');
  for (let gene = 0; gene < genes; gene++) {
    const { indices } = columns[gene];
    for (let range = 0; range <= ranges; range++) {
      starts[gene * (ranges + 1) + range] = lowerBoundOf(indices, bounds[range]);
    }
    for (let range = 0; range < ranges; range++) {
      sizes[range] += starts[gene * (ranges + 1) + range + 1] - starts[gene * (ranges + 1) + range];
    }
  }
  return Array.from({ length: ranges }, (_, range) => {
    const pointers = allocateTypedArray(Uint32Array, genes + 1, 'Gene delivery pointers');
    const cells = allocateTypedArray(Uint32Array, sizes[range], 'Gene delivery cells');
    const values = allocateTypedArray(Float32Array, sizes[range], 'Gene delivery values');
    const from = bounds[range];
    let at = 0;
    for (let gene = 0; gene < genes; gene++) {
      const { indices, values: entries } = columns[gene];
      const first = starts[gene * (ranges + 1) + range];
      const last = starts[gene * (ranges + 1) + range + 1];
      for (let k = first; k < last; k++) {
        cells[at] = indices[k] - from;
        values[at] = entries[k];
        at++;
      }
      pointers[gene + 1] = at;
    }
    return { pointers, cells, values };
  });
}

/**
 * Genes `first` to `last` of a cell-subset block (`pointers`, `cellIndex`,
 * `values`, as `AnnDataReader.getMatrixCellSubset` reads it), as a block of
 * their own whose arrays own their buffers: `pointers` from 0, `positions`
 * into the subset's cells.
 *
 * @param {{pointers: Float64Array, cellIndex: Int32Array, values: Float32Array}} block
 * @param {number} first
 * @param {number} last
 * @returns {{pointers: Float64Array, positions: Uint32Array, values: Float32Array}}
 */
export function subsetRun(block, first, last) {
  const { pointers, cellIndex, values } = block;
  const from = pointers[first];
  const to = pointers[last];
  const runPointers = allocateTypedArray(Float64Array, last - first + 1, 'Cell subset gene pointers');
  for (let gene = 0; gene <= last - first; gene++) runPointers[gene] = pointers[first + gene] - from;
  const positions = allocateTypedArray(Uint32Array, to - from, 'Cell subset positions');
  for (let k = from; k < to; k++) positions[k - from] = cellIndex[k];
  const runValues = allocateTypedArray(Float32Array, to - from, 'Cell subset values');
  runValues.set(values.subarray(from, to));
  return { pointers: runPointers, positions, values: runValues };
}
