/**
 * @fileoverview Centroid computation helpers for user-defined categoricals.
 *
 * Extracted from `UserDefinedFieldsRegistry` to keep the registry focused on
 * persistence + field definitions while keeping hot loops allocation-free.
 *
 * @module registries/user-defined-fields/centroids
 */

/**
 * Compute per-dimension centroids for all available dimensions (up to 3D).
 *
 * The returned structure matches the registry's serialized format:
 * `{ "1": [...], "2": [...], "3": [...] }` where each entry is an array of
 * `{ category, position, n_points }`.
 *
 * @param {Uint8Array|Uint16Array} codes
 * @param {string[]} categories
 * @param {object} state - DataState (needs `dimensionManager`, `positionsArray`, `activeDimensionLevel`)
 * @returns {Record<string, Array<{category: string, position: number[], n_points: number}>>}
 */
export function computeAllDimensionCentroids(codes, categories, state) {
  const centroidsByDim = {};
  const dimensionManager = state?.dimensionManager;

  if (!dimensionManager) {
    const positions = state?.positionsArray;
    if (positions && positions.length) {
      centroidsByDim['3'] = computeCentroidsForDimension(codes, categories, positions, 3, { strideOverride: 3 });
    }
    return centroidsByDim;
  }

  const availableDims = dimensionManager.getAvailableDimensions?.() || [state?.activeDimensionLevel || 3];
  for (const dim of availableDims) {
    if (dim > 3) continue;
    const positions = dimensionManager.positionCache?.get?.(dim);
    if (!positions) continue;
    centroidsByDim[String(dim)] = computeCentroidsForDimension(codes, categories, positions, dim);
  }

  return centroidsByDim;
}

/**
 * Compute centroid objects for a single dimension.
 * @param {Uint8Array|Uint16Array} codes
 * @param {string[]} categories
 * @param {Float32Array} positions - raw positions with stride = dim (unless overridden)
 * @param {number} dim
 * @param {object} [options]
 * @param {number} [options.strideOverride]
 * @returns {Array<{category: string, position: number[], n_points: number}>}
 */
export function computeCentroidsForDimension(codes, categories, positions, dim, options = {}) {
  const numCategories = categories.length;
  const stride = options.strideOverride ?? dim;
  const pointCount = Math.min(codes.length, Math.floor(positions.length / stride));

  const sumsX = new Float64Array(numCategories);
  const sumsY = new Float64Array(numCategories);
  const sumsZ = new Float64Array(numCategories);
  const counts = new Uint32Array(numCategories);

  for (let i = 0; i < pointCount; i++) {
    const cat = codes[i];
    if (cat >= numCategories) continue;
    const base = i * stride;
    sumsX[cat] += positions[base] || 0;
    if (dim >= 2) sumsY[cat] += positions[base + 1] || 0;
    if (dim >= 3) sumsZ[cat] += positions[base + 2] || 0;
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
      category: String(categories[catIdx] ?? `Category ${catIdx + 1}`),
      position: pos,
      n_points: count
    });
  }
  return out;
}

