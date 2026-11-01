/**
 * @fileoverview Latent-space outlier quantiles of a categorical field: how far
 * each cell lies from its category's centre in a latent space (scVI, PCA),
 * as the share of its category at that distance or closer.
 *
 * One rule, bit for bit, wherever the quantiles come from: `prepare()` in
 * Python (`cellucid.prepare_data._outliers`) and `cellucid_prepare()` in R
 * store them in the file (`uns['cellucid']['outlierQuantiles']`), and the
 * reader worker computes them here for a file that stores none; all three
 * are checked against an independent numpy reference
 * (`scripts/generate-latent-outlier-conformance.py`). For each category
 * with at least `minPoints` cells, over the latent values as stored
 * (float32, widened exactly to float64),
 *
 * 1. the centroid is the column sums, accumulated cell by cell in cell order,
 *    divided by the cell count;
 * 2. a cell's distance is the square root of its squared differences from the
 *    centroid, accumulated column by column in column order;
 * 3. its quantile is the number of the category's cells at that distance or
 *    closer, divided by the cell count, both as float32.
 *
 * A cell whose latent row is not finite (NaN or an infinity in any column:
 * a latent space computed on some of the cells, a modality that did not
 * measure the cell) has no place in the latent space: it is left out as a
 * cell with a missing code is, adding nothing to its category's centroid or
 * size, and `minPoints` counts a category's placed cells. Every other cell (a
 * missing code, an unplaced cell, or a category under `minPoints`) is NaN.
 *
 * Both passes read the cells in order, so the latent space can arrive in row
 * slabs: `LatentOutlierQuantiles` takes the slabs of pass 1 (the centroids)
 * and then of pass 2 (the distances), and holds per cell only the distances
 * of the scored cells, never the latent space. The reader worker streams it
 * from the file this way (`latent-outliers-stream.js`), every field asked for
 * at once in the same passes; an array already in memory is one slab.
 *
 * `categorySizes` says whether a field can have quantiles at all (a category
 * of at least `minPoints` cells), from its codes alone, and
 * `storedQuantilesDefect` checks quantiles a file stores against the field's
 * codes, so quantiles written for other categories (the file's obs was
 * changed after it was prepared) are never applied.
 *
 * @module data/latent-outliers
 */

import { radixSort64, sortedAscending } from '../app/analysis/compute/math-utils.js';
import { formatCountOf } from '../utils/format-units.js';
import { allocateTypedArray } from './sparse-column-index.js';

/** Whether the latent row of `width` values at `start` is finite in every column: a placed cell. */
export function placedRow(rows, start, width) {
  for (let column = start; column < start + width; column++) {
    const value = rows[column];
    if (!(value > -Infinity && value < Infinity)) return false;
  }
  return true;
}

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
  const atMost = allocateTypedArray(Int32Array, n, 'Distance ranks');
  if (n < RADIX_RANK_MIN_CELLS) {
    const sorted = Float64Array.from(distances).sort();
    for (let k = 0; k < n; k++) atMost[k] = countAtMost(sorted, distances[k]);
    return atMost;
  }
  // Distances are non-negative, so their IEEE-754 bits order them as unsigned
  // 64-bit integers; NaN is given the largest key, as the sort puts it last.
  const words = new Uint32Array(distances.buffer, distances.byteOffset, 2 * n);
  const lo = allocateTypedArray(Uint32Array, n, 'Distance sort keys');
  const hi = allocateTypedArray(Uint32Array, n, 'Distance sort keys');
  const indices = allocateTypedArray(Uint32Array, n, 'Distance order');
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
    const counts = allocateTypedArray(Int32Array, nCategories + 1, 'Category sizes');
    for (let cell = 0; cell < nCells; cell++) {
      const code = codes[cell];
      if (code >= 0 && code < nCategories) counts[code + 1] += 1;
    }
    for (let code = 0; code < nCategories; code++) counts[code + 1] += counts[code];
    const members = allocateTypedArray(Int32Array, counts[nCategories], 'Category members');
    const next = counts.slice(0, nCategories);
    for (let cell = 0; cell < nCells; cell++) {
      const code = codes[cell];
      if (code >= 0 && code < nCategories) members[next[code]++] = cell;
    }
    // Scored by their codes until pass 1 finds the cells the latent space
    // does not place: a category of fewer placed cells is then let go.
    const scored = allocateTypedArray(Uint8Array, nCategories, 'Scored categories');
    let anyScored = false;
    for (let code = 0; code < nCategories; code++) {
      if (counts[code + 1] - counts[code] >= minPoints) {
        scored[code] = 1;
        anyScored = true;
      }
    }
    this._minPoints = minPoints;
    this._unplaced = anyScored ? allocateTypedArray(Int32Array, nCategories, 'Unplaced cells per category') : null;
    this._counts = counts;
    this._members = members;
    this._next = next;
    this._scored = scored;
    /** Whether any category is scored, so the latent space must be read. */
    this.needsLatent = anyScored;
    this._centroids = anyScored ? allocateTypedArray(Float64Array, nCategories * width, 'Category centroids') : null;
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
    const { width, _codes: codes, _nCategories: nCategories, _scored: scored, _centroids: centroids, _unplaced: unplaced } = this;
    for (let local = 0; local < nRows; local++) {
      const code = codes[rowStart + local];
      if (!(code >= 0 && code < nCategories) || scored[code] === 0) continue;
      const base = code * width;
      const row = local * width;
      if (!placedRow(rows, row, width)) {
        unplaced[code] += 1;
        continue;
      }
      for (let column = 0; column < width; column++) centroids[base + column] += rows[row + column];
    }
  }

  /** End pass 1: divide the column sums by the placed cell counts. */
  finishCentroids() {
    if (this._phase !== 'centroids' || this._row !== this.nCells) {
      throw new Error('The centroid pass must read every cell once before it ends.');
    }
    const { width, _counts: counts, _scored: scored, _centroids: centroids, _unplaced: unplaced } = this;
    for (let code = 0; code < this._nCategories; code++) {
      if (scored[code] === 0) continue;
      const n = counts[code + 1] - counts[code] - unplaced[code];
      if (n < this._minPoints) {
        scored[code] = 0;
        continue;
      }
      const base = code * width;
      for (let column = 0; column < width; column++) centroids[base + column] /= n;
    }
    // Every scored cell's distance, at its place among its category's members.
    this._distances = allocateTypedArray(Float64Array, this._members.length, 'Centroid distances');
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
      if (!placedRow(rows, row, width)) {
        // Ranked after every distance, and given none (`finish`).
        distances[k] = Number.NaN;
        continue;
      }
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
    const quantiles = allocateTypedArray(Float32Array, this.nCells, 'Outlier quantiles').fill(Number.NaN);
    if (this._phase === 'done') return quantiles;
    if (this._phase !== 'distances' || this._row !== this.nCells) {
      throw new Error('The distance pass must read every cell once before the quantiles.');
    }
    const { _counts: counts, _members: members, _scored: scored, _distances: distances, _unplaced: unplaced } = this;
    for (let code = 0; code < this._nCategories; code++) {
      if (scored[code] === 0) continue;
      const start = counts[code];
      const n = counts[code + 1] - start;
      // Over the placed cells; an unplaced cell's NaN distance ranks none.
      const count = Math.fround(n - unplaced[code]);
      const atMost = countsAtMost(distances.subarray(start, start + n));
      for (let k = 0; k < n; k++) {
        if (distances[start + k] !== distances[start + k]) continue;
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

/**
 * The cell count of every category of a field, and what the rule makes of
 * them: how many categories have at least `minPoints` cells (only their cells
 * get quantiles) and the largest category.
 *
 * @param {ArrayLike<number>} codes - A code outside `[0, nCategories)` is a missing category
 * @param {number} nCategories
 * @param {number} minPoints
 * @returns {{counts: Int32Array, scored: number, largest: number}}
 */
export function categorySizes(codes, nCategories, minPoints) {
  requireCodesTask({ codes, nCategories, minPoints }, codes?.length);
  const counts = allocateTypedArray(Int32Array, nCategories, 'Category sizes');
  for (let cell = 0; cell < codes.length; cell++) {
    const code = codes[cell];
    if (code >= 0 && code < nCategories) counts[code] += 1;
  }
  let scored = 0;
  let largest = 0;
  for (let code = 0; code < nCategories; code++) {
    if (counts[code] >= minPoints) scored += 1;
    if (counts[code] > largest) largest = counts[code];
  }
  return { counts, scored, largest };
}

/**
 * Why quantiles a file stores cannot be this field's, or null when they can.
 * Whatever the latent space, the rule's quantiles of a category of `n`
 * placed cells are ranks over `n`: each is `r / n` (as float32,
 * `rankShare`) for a whole `r` from 1 to `n`, and exactly `r` of those cells
 * have a rank of at most `r` (ties share the larger rank). Above 2^24 cells
 * float32 no longer tells neighbouring ranks apart, so a quantile names a
 * range of ranks, not one; the check is therefore by ranges, exact at every
 * size: sorted, the cells holding each distinct quantile `q` end at a count
 * `c` (the cells with a quantile of at most `q`), and `c` must be a rank
 * that gives `q` (`rankShare(c, n) === q`) — the largest rank among them is
 * `c` itself whatever the ties, and every rank in a quantile's range gives
 * it. Every other cell (a missing code, a
 * category under `minPoints`, a cell the latent space does not place) is
 * NaN; which of a category's cells the latent space places is not known
 * from the codes, so a category's cells with a quantile are its placed
 * cells, at least `minPoints` of them. Quantiles written for other
 * categories or other cells — the file's obs changed after it was prepared
 * — fail this, so they are computed instead.
 *
 * A subsample (`nOriginal` cells in the file, `codes.length` open) holds the
 * stored quantiles of its cells, gathered: they describe the whole dataset,
 * ranks over each category's placed cells in the file, which the open cells
 * do not count. What the open cells can show is checked: every value is
 * `r / n` for one whole category size `n` (at least its open cells with a
 * quantile and `minPoints`, at most the file's cells the other open cells
 * leave), no more open cells rank at most `r` than `r`, and the sizes fit
 * in the file.
 *
 * @param {Float32Array} quantiles - As stored, NaN where none
 * @param {ArrayLike<number>} codes
 * @param {number} nCategories
 * @param {number} minPoints
 * @param {{nOriginal?: number}} [options] - The file's cell count when a subsample is open
 * @returns {string|null}
 */
export function storedQuantilesDefect(quantiles, codes, nCategories, minPoints, { nOriginal = codes.length } = {}) {
  if (!(quantiles instanceof Float32Array)) return 'they are not float32 values';
  if (quantiles.length !== codes.length) {
    return `they hold ${formatCountOf(quantiles.length, 'value')} for ${formatCountOf(codes.length, 'cell')}`;
  }
  if (!Number.isSafeInteger(nOriginal) || nOriginal < codes.length) {
    throw new RangeError(`A file's cell count must be a whole number of at least the open ${formatCountOf(codes.length, 'cell')}.`);
  }
  if (nOriginal > codes.length) return subsampleQuantilesDefect(quantiles, codes, nCategories, minPoints, nOriginal);
  const { counts } = categorySizes(codes, nCategories, minPoints);
  // Each scored category's placed cells: those with a quantile.
  const placed = allocateTypedArray(Int32Array, nCategories, 'Placed cells per category');
  for (let cell = 0; cell < codes.length; cell++) {
    const code = codes[cell];
    const quantile = quantiles[cell];
    if (quantile !== quantile) continue;
    if (!(code >= 0 && code < nCategories && counts[code] >= minPoints)) return `cell ${cell} has a quantile, and its category has none`;
    placed[code] += 1;
  }
  for (let code = 0; code < nCategories; code++) {
    if (placed[code] > 0 && placed[code] < minPoints) {
      return `category ${code} has quantiles for ${formatCountOf(placed[code], 'cell')}, fewer than ${minPoints}`;
    }
  }
  // Each scored category's quantiles, one category after another, then
  // sorted: the cells holding each distinct quantile end at a count that
  // must be a rank giving it (see above).
  const offsets = allocateTypedArray(Float64Array, nCategories + 1, 'Category quantile offsets');
  for (let code = 0; code < nCategories; code++) offsets[code + 1] = offsets[code] + placed[code];
  const grouped = allocateTypedArray(Float32Array, offsets[nCategories], 'Quantiles by category');
  const filled = offsets.slice(0, nCategories);
  for (let cell = 0; cell < codes.length; cell++) {
    const quantile = quantiles[cell];
    if (quantile === quantile) grouped[filled[codes[cell]]++] = quantile;
  }
  for (let code = 0; code < nCategories; code++) {
    const n = placed[code];
    if (n === 0) continue;
    const sorted = sortedAscending(grouped.subarray(offsets[code], offsets[code + 1]));
    for (let k = 0; k < n; k++) {
      const quantile = sorted[k];
      if (k + 1 < n && sorted[k + 1] === quantile) continue;
      if (rankShare(k + 1, n) !== quantile) {
        return `category ${code} does not rank its ${formatCountOf(n, 'cell')}: ${formatCountOf(k + 1, 'cell')} at or below ${quantile}`;
      }
    }
  }
  return null;
}

/** Quantile `r / n` as the rule writes it (float32). */
export function rankShare(rank, n) {
  return Math.fround(Math.fround(rank) / Math.fround(n));
}

/**
 * The largest rank over `n` cells that gives `quantile` (`rankShare`), or 0
 * when none does. `rankShare` never decreases with the rank and is within a
 * few float32 roundings of `rank / n`, so the walk from `round(q · n)` is a
 * few steps (one below 2^24 cells, where each quantile names one rank).
 *
 * @param {number} quantile
 * @param {number} n
 * @returns {number}
 */
export function largestRankOf(quantile, n) {
  if (!(quantile > 0 && quantile <= 1)) return 0;
  let rank = Math.min(n, Math.max(1, Math.round(quantile * n)));
  while (rank > 1 && rankShare(rank, n) > quantile) rank -= 1;
  while (rank < n && rankShare(rank + 1, n) <= quantile) rank += 1;
  return rankShare(rank, n) === quantile ? rank : 0;
}

/**
 * Whether every open cell of one category (`cells`, their quantiles) is a
 * rank over `n` cells, no more of them ranking at most `r` than `r`: each
 * cell is given the largest rank its quantile names (`largestRankOf`), which
 * holds whenever any choice in the ranges does.
 */
function ranksOver(n, cells, quantiles, ranks) {
  for (let i = 0; i < cells.length; i++) {
    const rank = largestRankOf(quantiles[cells[i]], n);
    if (rank === 0) return false;
    ranks[i] = rank;
  }
  const sorted = ranks.subarray(0, cells.length).sort();
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] < i + 1) return false;
  }
  return true;
}

/** `storedQuantilesDefect` for the open cells of a subsample. */
function subsampleQuantilesDefect(quantiles, codes, nCategories, minPoints, nOriginal) {
  // Each category's open cells with a quantile (its placed cells); every
  // other open cell (no category, a category not scored, a cell the latent
  // space does not place) is a file cell outside every ranked category.
  const counts = allocateTypedArray(Int32Array, nCategories, 'Category sizes');
  let unscoredCells = 0;
  for (let cell = 0; cell < codes.length; cell++) {
    const code = codes[cell];
    const quantile = quantiles[cell];
    if (quantile !== quantile) {
      unscoredCells += 1;
      continue;
    }
    if (!(code >= 0 && code < nCategories)) return `cell ${cell} has a quantile, and no category`;
    if (!(quantile > 0 && quantile <= 1)) return `cell ${cell} has a quantile outside (0, 1]`;
    counts[code] += 1;
  }
  // Each category's open cells with a quantile, one after another.
  const offsets = allocateTypedArray(Int32Array, nCategories + 1, 'Category offsets');
  for (let code = 0; code < nCategories; code++) offsets[code + 1] = offsets[code] + counts[code];
  const members = allocateTypedArray(Int32Array, codes.length, 'Category members');
  const filled = offsets.slice(0, nCategories);
  for (let cell = 0; cell < codes.length; cell++) {
    const code = codes[cell];
    if (quantiles[cell] === quantiles[cell]) members[filled[code]++] = cell;
  }
  const ranks = allocateTypedArray(Int32Array, codes.length, 'Quantile ranks');
  // The file's cells the categories found so far take, and the open cells
  // of every other category.
  let taken = 0;
  for (let code = 0; code < nCategories; code++) {
    if (counts[code] === 0) continue;
    const cells = members.subarray(offsets[code], offsets[code + 1]);
    const low = Math.max(counts[code], minPoints);
    const high = nOriginal - (codes.length - counts[code]);
    let smallest = 1;
    for (const cell of cells) smallest = Math.min(smallest, quantiles[cell]);
    // The smallest open quantile is r / n, rounded to float32, for some rank
    // r >= 1: each r names the sizes within float32's roundings of r / q
    // (r, n and their quotient each rounded once: within 2^-22 of it),
    // tried from the smallest up.
    let size = null;
    for (let rank = 1; size === null; rank++) {
      const near = rank / smallest;
      const slack = Math.ceil(near * 2 ** -22) + 1;
      if (Math.floor(near) - slack > high) break;
      for (let n = Math.max(low, Math.floor(near) - slack); n <= Math.min(high, Math.ceil(near) + slack); n++) {
        if (ranksOver(n, cells, quantiles, ranks)) {
          size = n;
          break;
        }
      }
    }
    if (size === null) return `category ${code} has no share of one category size in the file`;
    taken += size;
  }
  if (taken + unscoredCells > nOriginal) {
    return `its categories take more than the file's ${formatCountOf(nOriginal, 'cell')}`;
  }
  return null;
}
