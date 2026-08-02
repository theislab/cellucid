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
 * Compute per-dimension centroids for all available dimensions (up to 3D).
 *
 * The returned structure matches the registry's serialized format:
 * `{ "1": [...], "2": [...], "3": [...] }` where each entry is an array of
 * `{ category, position, n_points }`.
 *
 * @param {Uint8Array|Uint16Array} codes
 * @param {(string|number|boolean)[]} categories
 * @param {object} state - DataState (needs `dimensionManager`, `positionsArray`, `activeDimensionLevel`)
 * @returns {Record<string, Array<{category: string|number|boolean, position: number[], n_points: number}>>}
 */
export function computeAllDimensionCentroids(codes, categories, state) {
  if (!(codes instanceof Uint8Array) && !(codes instanceof Uint16Array)) {
    throw new TypeError('Centroid category codes must be Uint8Array or Uint16Array');
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
    || typeof dimensionManager.getAvailableDimensions !== 'function'
    || !(dimensionManager.positionCache instanceof Map)
  ) {
    throw new TypeError('Centroid computation requires the current DimensionManager');
  }
  const availableDims = dimensionManager.getAvailableDimensions();
  if (!Array.isArray(availableDims) || availableDims.length === 0) {
    throw new TypeError('Centroid computation requires available dimensions');
  }
  const seenDimensions = new Set();
  for (const dim of availableDims) {
    if (!Number.isSafeInteger(dim) || dim < 1 || dim > 3 || seenDimensions.has(dim)) {
      throw new TypeError('Available centroid dimensions must be unique integers from 1 through 3');
    }
    seenDimensions.add(dim);
  }

  const centroidsByDim = {};
  for (const dim of availableDims) {
    if (!dimensionManager.positionCache.has(dim)) continue;
    const positions = dimensionManager.positionCache.get(dim);
    centroidsByDim[String(dim)] = computeCentroidsForDimension(codes, categories, positions, dim);
  }

  return centroidsByDim;
}

/**
 * Compute centroid objects for a single dimension.
 * @param {Uint8Array|Uint16Array} codes
 * @param {(string|number|boolean)[]} categories
 * @param {Float32Array} positions - raw positions with stride = dim (unless overridden)
 * @param {number} dim
 * @returns {Array<{category: string|number|boolean, position: number[], n_points: number}>}
 */
export function computeCentroidsForDimension(codes, categories, positions, dim) {
  if (!(codes instanceof Uint8Array) && !(codes instanceof Uint16Array)) {
    throw new TypeError('Centroid category codes must be Uint8Array or Uint16Array');
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
  const pointCount = codes.length;

  const sumsX = new Float64Array(numCategories);
  const sumsY = new Float64Array(numCategories);
  const sumsZ = new Float64Array(numCategories);
  const counts = new Uint32Array(numCategories);

  for (let i = 0; i < pointCount; i++) {
    const cat = codes[i];
    if (cat === missingCode) continue;
    if (cat >= numCategories) {
      throw new RangeError(`Centroid category code ${i} is outside the category inventory`);
    }
    const base = i * dim;
    for (let axis = 0; axis < dim; axis++) {
      if (!Number.isFinite(positions[base + axis])) {
        throw new TypeError(`Centroid position ${i}, axis ${axis} must be finite`);
      }
    }
    sumsX[cat] += positions[base];
    if (dim >= 2) sumsY[cat] += positions[base + 1];
    if (dim >= 3) sumsZ[cat] += positions[base + 2];
    counts[cat]++;
  }

  const out = [];
  for (let catIdx = 0; catIdx < numCategories; catIdx++) {
    const count = counts[catIdx];
    const x = count ? sumsX[catIdx] / count : 0;
    const y = count ? sumsY[catIdx] / count : 0;
    const z = count ? sumsZ[catIdx] / count : 0;
    const pos = dim === 1 ? [x] : dim === 2 ? [x, y] : [x, y, z];
    out.push({
      category: categories[catIdx],
      position: pos,
      n_points: count
    });
  }
  return out;
}
