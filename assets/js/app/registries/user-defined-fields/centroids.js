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
 * layout's dimension of coordinates.
 *
 * @param {Uint8Array|Uint16Array} codes
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
 * Compute centroid objects for a single dimension.
 * @param {Uint8Array|Uint16Array} codes
 * @param {(string|number|boolean)[]} categories
 * @param {Float32Array} positions - one layout's normalized positions, stride = dim
 * @param {number} dim
 * @returns {Array<{category: string|number|boolean, position: number[], n_points: number}>}
 */
export function computeCentroidsForDimension(codes, categories, positions, dim) {
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
  const pointCount = codes.length;

  const sumsX = new Float64Array(numCategories);
  const sumsY = new Float64Array(numCategories);
  const sumsZ = new Float64Array(numCategories);
  const counts = new Uint32Array(numCategories);

  // One loop per dimension, each adding its axes in cell order (so every sum
  // is the same Float64 sequence of additions). `v - v` is 0 exactly for a
  // finite `v` and NaN otherwise, which tests finiteness without a call.
  const rejectPosition = (cell) => {
    for (let axis = 0; axis < dim; axis++) {
      if (!Number.isFinite(positions[cell * dim + axis])) {
        throw new TypeError(`Centroid position ${cell}, axis ${axis} must be finite`);
      }
    }
  };
  const rejectCode = (cell) => {
    throw new RangeError(`Centroid category code ${cell} is outside the category inventory`);
  };
  if (dim === 1) {
    for (let i = 0; i < pointCount; i++) {
      const cat = codes[i];
      if (cat === missingCode) continue;
      if (cat >= numCategories) rejectCode(i);
      const x = positions[i];
      if (x - x !== 0) rejectPosition(i);
      sumsX[cat] += x;
      counts[cat]++;
    }
  } else if (dim === 2) {
    for (let i = 0, base = 0; i < pointCount; i++, base += 2) {
      const cat = codes[i];
      if (cat === missingCode) continue;
      if (cat >= numCategories) rejectCode(i);
      const x = positions[base];
      const y = positions[base + 1];
      if (x - x !== 0 || y - y !== 0) rejectPosition(i);
      sumsX[cat] += x;
      sumsY[cat] += y;
      counts[cat]++;
    }
  } else {
    for (let i = 0, base = 0; i < pointCount; i++, base += 3) {
      const cat = codes[i];
      if (cat === missingCode) continue;
      if (cat >= numCategories) rejectCode(i);
      const x = positions[base];
      const y = positions[base + 1];
      const z = positions[base + 2];
      if (x - x !== 0 || y - y !== 0 || z - z !== 0) rejectPosition(i);
      sumsX[cat] += x;
      sumsY[cat] += y;
      sumsZ[cat] += z;
      counts[cat]++;
    }
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
