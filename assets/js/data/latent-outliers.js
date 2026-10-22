/**
 * @fileoverview Latent-space outlier quantiles of a categorical field: how far
 * each cell lies from its category's centre in a latent space (scVI, PCA),
 * as the share of its category at that distance or closer.
 *
 * The rule is `cellucid.prepare_data._centroids._compute_latent_space_quantiles`,
 * which `prepare()` and `cellucid serve` run, bit for bit: for each category
 * with at least `minPoints` cells, over the latent values as stored (float32,
 * widened exactly to float64),
 *
 * 1. the centroid is the column sums, accumulated cell by cell in cell order,
 *    divided by the cell count;
 * 2. a cell's distance is the square root of its squared differences from the
 *    centroid, accumulated column by column in column order;
 * 3. its quantile is the number of the category's cells at that distance or
 *    closer, divided by the cell count, both as float32.
 *
 * Every other cell (a missing code, or a category under `minPoints`) is NaN.
 *
 * Both passes read the cells in order, so the latent space can arrive in row
 * slabs: `LatentOutlierQuantiles` takes the slabs of pass 1 (the centroids)
 * and then of pass 2 (the distances), and holds per cell only the distances
 * of the scored cells, never the latent space. The direct AnnData reader
 * streams it from the file this way in its worker; an array already in
 * memory is one slab.
 *
 * @module data/latent-outliers
 */

import { radixSort64 } from '../app/analysis/compute/math-utils.js';

function requireLatentTask({ latent, width }) {
  if (!(latent instanceof Float32Array)) {
    throw new TypeError('A latent space must be a Float32Array.');
  }
  if (!Number.isSafeInteger(width) || width < 1) {
    throw new TypeError('A latent space must be at least one column wide.');
  }
  if (latent.length % width !== 0) {
    throw new RangeError('A latent space must hold whole cells.');
  }
  return latent.length / width;
}

function requireCodesTask({ codes, nCategories, minPoints }, nCells) {
  if (typeof codes?.length !== 'number' || codes instanceof DataView || codes.length !== nCells) {
    throw new TypeError(`Category codes must be one integer per cell (${nCells}).`);
  }
  if (!Number.isSafeInteger(nCategories) || nCategories < 0) {
    throw new TypeError('A category count must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(minPoints) || minPoints < 1) {
    throw new TypeError('The fewest cells a category needs must be a positive integer.');
  }
}

/**
 * The index of the first value in `sorted` greater than `value`: the number
 * of values at most `value` (numpy's `searchsorted(..., side="right")`).
 */
function countAtMost(sorted, value) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Categories of at least this many cells are ranked by radix ordering; below
 * it, the browser's own sort and one binary search per cell are quicker.
 */
const RADIX_RANK_MIN_CELLS = 16_384;

/**
 * For every distance of one category, the number of the category's distances
 * at most it.
 *
 * @param {Float64Array} distances - The category's distances, in member order
 * @returns {Int32Array} The counts, in member order
 */
function countsAtMost(distances) {
  const n = distances.length;
  const atMost = new Int32Array(n);
  if (n < RADIX_RANK_MIN_CELLS) {
    const sorted = Float64Array.from(distances).sort();
    for (let k = 0; k < n; k++) atMost[k] = countAtMost(sorted, distances[k]);
    return atMost;
  }
  // Distances are non-negative, so their IEEE-754 bits order them as unsigned
  // 64-bit integers; NaN is given the largest key, as the sort puts it last.
  const words = new Uint32Array(distances.buffer, distances.byteOffset, 2 * n);
  const lo = new Uint32Array(n);
  const hi = new Uint32Array(n);
  const indices = new Uint32Array(n);
  for (let k = 0; k < n; k++) {
    indices[k] = k;
    if (distances[k] !== distances[k]) {
      lo[k] = 0xffffffff;
      hi[k] = 0xffffffff;
    } else {
      lo[k] = words[2 * k];
      hi[k] = words[2 * k + 1];
    }
  }
  const order = radixSort64(lo, hi, indices).payload;
  let first = 0;
  while (first < n) {
    const distance = distances[order[first]];
    if (distance !== distance) {
      // NaN is at most nothing, and nothing is at most NaN.
      atMost[order[first]] = 0;
      first += 1;
      continue;
    }
    let last = first;
    while (last + 1 < n && distances[order[last + 1]] === distance) last += 1;
    for (let k = first; k <= last; k++) atMost[order[k]] = last + 1;
    first = last + 1;
  }
  return atMost;
}

/**
 * The outlier quantiles of one categorical field, from a latent space read in
 * row slabs over two passes (see the module rule).
 *
 * The rule's arithmetic and its order are kept whatever the slab boundaries:
 * pass 1 accumulates every category's column sums cell by cell in cell order,
 * and pass 2 sums each cell's squared distance over its own row, column by
 * column. A large category's distances are then ranked by a linear-time radix
 * ordering, a run of equal distances sharing the count of the run's end.
 *
 * Usage: `addCentroidRows` for every slab in row order, `finishCentroids()`,
 * `addDistanceRows` for every slab in row order, `finish()`. When
 * `needsLatent` is false no category is scored and `finish()` may be called
 * at once.
 */
export class LatentOutlierQuantiles {
  /**
   * @param {{
   *   nCells: number,
   *   width: number,
   *   codes: ArrayLike<number>,
   *   nCategories: number,
   *   minPoints: number
   * }} task - A code outside `[0, nCategories)` is a missing category.
   */
  constructor({ nCells, width, codes, nCategories, minPoints }) {
    if (!Number.isSafeInteger(nCells) || nCells < 0) {
      throw new TypeError('A latent space must have a non-negative whole number of cells.');
    }
    if (!Number.isSafeInteger(width) || width < 1) {
      throw new TypeError('A latent space must be at least one column wide.');
    }
    requireCodesTask({ codes, nCategories, minPoints }, nCells);
    this.nCells = nCells;
    this.width = width;
    this._codes = codes;
    this._nCategories = nCategories;

    // The cells of each category, in cell order.
    const counts = new Int32Array(nCategories + 1);
    for (let cell = 0; cell < nCells; cell++) {
      const code = codes[cell];
      if (code >= 0 && code < nCategories) counts[code + 1] += 1;
    }
    for (let code = 0; code < nCategories; code++) counts[code + 1] += counts[code];
    const members = new Int32Array(counts[nCategories]);
    const next = counts.slice(0, nCategories);
    for (let cell = 0; cell < nCells; cell++) {
      const code = codes[cell];
      if (code >= 0 && code < nCategories) members[next[code]++] = cell;
    }
    const scored = new Uint8Array(nCategories);
    let anyScored = false;
    for (let code = 0; code < nCategories; code++) {
      if (counts[code + 1] - counts[code] >= minPoints) {
        scored[code] = 1;
        anyScored = true;
      }
    }
    this._counts = counts;
    this._members = members;
    this._next = next;
    this._scored = scored;
    /** Whether any category is scored, so the latent space must be read. */
    this.needsLatent = anyScored;
    this._centroids = anyScored ? new Float64Array(nCategories * width) : null;
    this._distances = null;
    this._phase = anyScored ? 'centroids' : 'done';
    this._row = 0;
  }

  _requireSlab(rows, rowStart, phase) {
    if (this._phase !== phase) {
      throw new Error(`Latent rows for the ${phase} pass arrived during the ${this._phase} pass.`);
    }
    if (rowStart !== this._row) {
      throw new RangeError(`Latent rows must arrive in order: expected row ${this._row}, got ${rowStart}.`);
    }
    const nRows = rows.length / this.width;
    if (!Number.isInteger(nRows) || rowStart + nRows > this.nCells) {
      throw new RangeError('A latent slab must hold whole cells within the latent space.');
    }
    this._row = rowStart + nRows;
    return nRows;
  }

  /**
   * Pass 1: add one slab of rows to the centroid sums.
   *
   * @param {Float32Array} rows - Row-major, `width` values a cell
   * @param {number} rowStart - The first row's cell
   */
  addCentroidRows(rows, rowStart) {
    const nRows = this._requireSlab(rows, rowStart, 'centroids');
    const { width, _codes: codes, _nCategories: nCategories, _scored: scored, _centroids: centroids } = this;
    for (let local = 0; local < nRows; local++) {
      const code = codes[rowStart + local];
      if (!(code >= 0 && code < nCategories) || scored[code] === 0) continue;
      const base = code * width;
      const row = local * width;
      for (let column = 0; column < width; column++) centroids[base + column] += rows[row + column];
    }
  }

  /** End pass 1: divide the column sums by the cell counts. */
  finishCentroids() {
    if (this._phase !== 'centroids' || this._row !== this.nCells) {
      throw new Error('The centroid pass must read every cell once before it ends.');
    }
    const { width, _counts: counts, _scored: scored, _centroids: centroids } = this;
    for (let code = 0; code < this._nCategories; code++) {
      if (scored[code] === 0) continue;
      const n = counts[code + 1] - counts[code];
      const base = code * width;
      for (let column = 0; column < width; column++) centroids[base + column] /= n;
    }
    // Every scored cell's distance, at its place among its category's members.
    this._distances = new Float64Array(this._members.length);
    this._next.set(counts.subarray(0, this._nCategories));
    this._phase = 'distances';
    this._row = 0;
  }

  /**
   * Pass 2: the distance of every scored cell of one slab of rows.
   *
   * @param {Float32Array} rows - Row-major, `width` values a cell
   * @param {number} rowStart - The first row's cell
   */
  addDistanceRows(rows, rowStart) {
    const nRows = this._requireSlab(rows, rowStart, 'distances');
    const {
      width, _codes: codes, _nCategories: nCategories, _scored: scored,
      _centroids: centroids, _next: next, _distances: distances,
    } = this;
    for (let local = 0; local < nRows; local++) {
      const code = codes[rowStart + local];
      if (!(code >= 0 && code < nCategories)) continue;
      const k = next[code]++;
      if (scored[code] === 0) continue;
      const base = code * width;
      const row = local * width;
      let squared = 0;
      for (let column = 0; column < width; column++) {
        const difference = rows[row + column] - centroids[base + column];
        squared += difference * difference;
      }
      distances[k] = Math.sqrt(squared);
    }
  }

  /**
   * Rank every scored category's distances.
   *
   * @returns {Float32Array} One quantile a cell; NaN where it has none.
   */
  finish() {
    const quantiles = new Float32Array(this.nCells).fill(Number.NaN);
    if (this._phase === 'done') return quantiles;
    if (this._phase !== 'distances' || this._row !== this.nCells) {
      throw new Error('The distance pass must read every cell once before the quantiles.');
    }
    const { _counts: counts, _members: members, _scored: scored, _distances: distances } = this;
    for (let code = 0; code < this._nCategories; code++) {
      if (scored[code] === 0) continue;
      const start = counts[code];
      const n = counts[code + 1] - start;
      const count = Math.fround(n);
      const atMost = countsAtMost(distances.subarray(start, start + n));
      for (let k = 0; k < n; k++) {
        quantiles[members[start + k]] = Math.fround(Math.fround(atMost[k]) / count);
      }
    }
    this._phase = 'done';
    this._distances = null;
    this._centroids = null;
    return quantiles;
  }
}

/**
 * Compute the outlier quantile of every cell of a latent space held in memory
 * (see the module rule): the whole array is the one slab of each pass.
 *
 * @param {{
 *   latent: Float32Array,
 *   width: number,
 *   codes: ArrayLike<number>,
 *   nCategories: number,
 *   minPoints: number
 * }} task - `latent` is row-major, `width` values a cell; a code outside
 *   `[0, nCategories)` is a missing category.
 * @returns {Float32Array}
 */
export function computeLatentOutlierQuantiles(task) {
  const nCells = requireLatentTask(task);
  const { latent, width, codes, nCategories, minPoints } = task;
  const outliers = new LatentOutlierQuantiles({ nCells, width, codes, nCategories, minPoints });
  if (outliers.needsLatent) {
    outliers.addCentroidRows(latent, 0);
    outliers.finishCentroids();
    outliers.addDistanceRows(latent, 0);
  }
  return outliers.finish();
}
