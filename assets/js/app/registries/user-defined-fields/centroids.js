/**
 * @fileoverview Centroid computation helpers for user-defined categoricals.
 *
 * Extracted from `UserDefinedFieldsRegistry` to keep the registry focused on
 * persistence + field definitions while keeping hot loops allocation-free.
 *
 * @module registries/user-defined-fields/centroids
 */

import {
  categoricalStorageForCodes
} from '../../../data/categorical-storage-contract.js';
import { isCategoricalCodes } from '../../../data/categorical-storage-contract.js';

function requireCategoryInventory(categories) {
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new TypeError('Centroid categories must be a non-empty array');
  }
  const seen = new Set();
  for (let categoryIndex = 0; categoryIndex < categories.length; categoryIndex++) {
    const category = categories[categoryIndex];
    const type = typeof category;
    if (
      (type !== 'string' && type !== 'number' && type !== 'boolean')
      || (type === 'number' && !Number.isFinite(category))
    ) {
      throw new TypeError(
        `Centroid category ${categoryIndex} must be a string, finite number, or boolean`
      );
    }
    if (seen.has(category)) {
      throw new TypeError(`Centroid category ${categoryIndex} is duplicated`);
    }
    seen.add(category);
  }
  return categories;
}

/**
 * Compute centroids for every registered layout whose normalized positions are
 * resident, keyed by layout.
 *
 * The positions are the ones the viewer draws, so every centroid is born in
 * normalized space and its layout is recorded in `normalizedLayouts`; nothing
 * downstream normalizes it again. Normalization is affine per axis
 * (`(p - center) * scale`), so the mean of normalized positions is the
 * normalized mean of the raw positions, up to Float32 rounding of the stored
 * coordinates. A layout that is not resident has no centroids yet; they are
 * computed from its positions when a view switches to it.
 *
 * Each entry is an array of `{ category, position, n_points }` with the
 * layout's dimension of coordinates, one for each category that holds at
 * least one cell (`computeCentroidsForDimension`).
 *
 * @param {Uint8Array|Uint16Array|Uint32Array} codes
 * @param {(string|number|boolean)[]} categories
 * @param {object} state - DataState (needs `dimensionManager` and `pointCount`)
 * @returns {{
 *   centroidsByLayout: Map<string, Array<{category: string|number|boolean, position: number[], n_points: number}>>,
 *   normalizedLayouts: Set<string>
 * }}
 */
export function computeAllLayoutCentroids(codes, categories, state) {
  if (!isCategoricalCodes(codes)) {
    throw new TypeError('Centroid category codes must be Uint8Array, Uint16Array or Uint32Array');
  }
  requireCategoryInventory(categories);
  const { missingValue: missingCode } = categoricalStorageForCodes(
    codes,
    'Centroid category'
  );
  for (let codeIndex = 0; codeIndex < codes.length; codeIndex++) {
    if (codes[codeIndex] >= categories.length && codes[codeIndex] !== missingCode) {
      throw new RangeError(`Centroid category code ${codeIndex} is outside the category inventory`);
    }
  }
  if (
    !state
    || typeof state !== 'object'
    || !Number.isSafeInteger(state.pointCount)
    || state.pointCount < 1
    || codes.length !== state.pointCount
  ) {
    throw new TypeError('Centroid computation requires exact current dataset state');
  }
  const dimensionManager = state.dimensionManager;
  if (
    !dimensionManager
    || typeof dimensionManager.getRegisteredLayouts !== 'function'
    || typeof dimensionManager.getResidentPositions !== 'function'
  ) {
    throw new TypeError('Centroid computation requires the current DimensionManager');
  }

  // Every representation whose positions are resident now gets its centroids
  // eagerly; any other is computed when a view first shows it
  // (field/overlay-internals.js).
  const centroidsByLayout = new Map();
  const normalizedLayouts = new Set();
  for (const { layoutKey, dimension: dim } of dimensionManager.getRegisteredLayouts()) {
    const positions = dimensionManager.getResidentPositions(layoutKey);
    if (positions === null) continue;
    centroidsByLayout.set(
      layoutKey,
      computeCentroidsForDimension(codes, categories, positions, dim)
    );
    normalizedLayouts.add(layoutKey);
  }

  return { centroidsByLayout, normalizedLayouts };
}

/**
 * Per-category sums of one layout's positions over cells `[from, to)`, one
 * loop per dimension, each adding its axes in cell order, so a pass split
 * into ranges makes exactly the Float64 additions of one whole pass. `v - v`
 * is 0 exactly for a finite `v` and NaN otherwise, which tests finiteness
 * without a call.
 */
function accumulateCentroids1(codes, positions, missingCode, numCategories, sums, counts, from, to) {
  for (let i = from; i < to; i++) {
    const cat = codes[i];
    if (cat === missingCode) continue;
    if (cat >= numCategories) return -(i + 1);
    const x = positions[i];
    if (x - x !== 0) return i + 1;
    sums[cat * 3] += x;
    counts[cat]++;
  }
  return 0;
}

function accumulateCentroids2(codes, positions, missingCode, numCategories, sums, counts, from, to) {
  for (let i = from, base = from * 2; i < to; i++, base += 2) {
    const cat = codes[i];
    if (cat === missingCode) continue;
    if (cat >= numCategories) return -(i + 1);
    const x = positions[base];
    const y = positions[base + 1];
    if (x - x !== 0 || y - y !== 0) return i + 1;
    const slot = cat * 3;
    sums[slot] += x;
    sums[slot + 1] += y;
    counts[cat]++;
  }
  return 0;
}

function accumulateCentroids3(codes, positions, missingCode, numCategories, sums, counts, from, to) {
  for (let i = from, base = from * 3; i < to; i++, base += 3) {
    const cat = codes[i];
    if (cat === missingCode) continue;
    if (cat >= numCategories) return -(i + 1);
    const x = positions[base];
    const y = positions[base + 1];
    const z = positions[base + 2];
    if (x - x !== 0 || y - y !== 0 || z - z !== 0) return i + 1;
    const slot = cat * 3;
    sums[slot] += x;
    sums[slot + 1] += y;
    sums[slot + 2] += z;
    counts[cat]++;
  }
  return 0;
}

const ACCUMULATORS = [null, accumulateCentroids1, accumulateCentroids2, accumulateCentroids3];

/**
 * The centroid pass of one layout as ranges of cells: `add(from, to)` for
 * consecutive ranges covering `[0, codes.length)` in order, then `finish()`.
 * Whole or in ranges, the sums are the same additions in the same order.
 */
function centroidAccumulator(codes, categories, positions, dim) {
  if (!isCategoricalCodes(codes)) {
    throw new TypeError('Centroid category codes must be Uint8Array, Uint16Array or Uint32Array');
  }
  requireCategoryInventory(categories);
  if (!Number.isSafeInteger(dim) || dim < 1 || dim > 3) {
    throw new TypeError('Centroid dimension must be an integer from 1 through 3');
  }
  if (!(positions instanceof Float32Array) || positions.length !== codes.length * dim) {
    throw new TypeError('Centroid positions must be an exact dataset-length Float32Array');
  }
  const numCategories = categories.length;
  const { missingValue: missingCode } = categoricalStorageForCodes(
    codes,
    'Centroid category'
  );
  // Interleaved x, y, z sums a category: one cache line holds a category's
  // three sums.
  const sums = new Float64Array(numCategories * 3);
  const counts = new Uint32Array(numCategories);
  const accumulate = ACCUMULATORS[dim];
  return {
    pointCount: codes.length,
    add(from, to) {
      const failed = accumulate(codes, positions, missingCode, numCategories, sums, counts, from, to);
      if (failed < 0) {
        throw new RangeError(`Centroid category code ${-failed - 1} is outside the category inventory`);
      }
      if (failed > 0) {
        const cell = failed - 1;
        for (let axis = 0; axis < dim; axis++) {
          if (!Number.isFinite(positions[cell * dim + axis])) {
            throw new TypeError(`Centroid position ${cell}, axis ${axis} must be finite`);
          }
        }
      }
    },
    finish() {
      const out = [];
      for (let catIdx = 0; catIdx < numCategories; catIdx++) {
        const count = counts[catIdx];
        // A category no cell holds has no centre, so it has no centroid.
        if (count === 0) continue;
        const slot = catIdx * 3;
        const x = sums[slot] / count;
        const y = sums[slot + 1] / count;
        const z = sums[slot + 2] / count;
        const pos = dim === 1 ? [x] : dim === 2 ? [x, y] : [x, y, z];
        out.push({
          category: categories[catIdx],
          position: pos,
          n_points: count
        });
      }
      return out;
    },
  };
}

/**
 * Compute centroid objects for a single dimension: one for each category that
 * holds at least one cell (`n_points >= 1`), in category-inventory order. A
 * category no cell holds has no centroid, so the list is as long as the
 * categories present, not the inventory, and its `i`-th entry is not the
 * `i`-th category: a consumer finds a centroid's category by its `category`.
 * @param {Uint8Array|Uint16Array|Uint32Array} codes
 * @param {(string|number|boolean)[]} categories
 * @param {Float32Array} positions - one layout's normalized positions, stride = dim
 * @param {number} dim
 * @returns {Array<{category: string|number|boolean, position: number[], n_points: number}>}
 */
export function computeCentroidsForDimension(codes, categories, positions, dim) {
  const accumulator = centroidAccumulator(codes, categories, positions, dim);
  accumulator.add(0, accumulator.pointCount);
  return accumulator.finish();
}

/** Cells summed between two looks at the clock (a scheduling choice). */
const CENTROID_CELLS_PER_CHECK = 1 << 18;

/**
 * `computeCentroidsForDimension` in slices of about `sliceMs` of main-thread
 * time, yielding a macrotask between them, so a dataset of any size never
 * holds the main thread for one long task. The result is identical: the
 * same additions in the same cell order.
 *
 * @param {Uint8Array|Uint16Array|Uint32Array} codes
 * @param {(string|number|boolean)[]} categories
 * @param {Float32Array} positions
 * @param {number} dim
 * @param {{signal?: AbortSignal|null, sliceMs: number, yieldToMacrotask: () => Promise<void>}} options
 * @returns {Promise<Array<{category: string|number|boolean, position: number[], n_points: number}>>}
 */
export async function computeCentroidsForDimensionInSlices(
  codes,
  categories,
  positions,
  dim,
  { signal = null, sliceMs, yieldToMacrotask }
) {
  const accumulator = centroidAccumulator(codes, categories, positions, dim);
  const total = accumulator.pointCount;
  let from = 0;
  while (from < total) {
    const deadline = performance.now() + sliceMs;
    do {
      const to = Math.min(total, from + CENTROID_CELLS_PER_CHECK);
      accumulator.add(from, to);
      from = to;
    } while (from < total && performance.now() < deadline);
    if (from < total) {
      await yieldToMacrotask();
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException('The centroid pass was aborted.', 'AbortError');
      }
    }
  }
  return accumulator.finish();
}
