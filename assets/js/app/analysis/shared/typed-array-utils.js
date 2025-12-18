/**
 * Typed Array Utilities
 *
 * Small, dependency-free helpers for working with large numeric arrays efficiently.
 *
 * @module shared/typed-array-utils
 */

/**
 * Gather values from an array/typed-array at given indices into a Float32Array.
 *
 * This is intended for "gather" operations on large datasets (100K+ cells) where:
 * - allocating boxed JS numbers is expensive
 * - typed arrays can be transferred to Workers efficiently
 *
 * Out-of-range indices are filled with NaN.
 *
 * @param {ArrayLike<number>} source - Typically a Float32Array of length = pointCount
 * @param {ArrayLike<number>} indices - Cell indices to gather (Array or TypedArray)
 * @returns {Float32Array}
 */
export function gatherFloat32(source, indices) {
  const n = indices?.length || 0;
  const out = new Float32Array(n);
  if (!source || !Number.isFinite(source.length) || n === 0) return out;

  const len = source.length;
  for (let i = 0; i < n; i++) {
    const idx = indices[i];
    out[i] = idx >= 0 && idx < len ? source[idx] : NaN;
  }
  return out;
}

/**
 * Gather the complement of a sorted, unique exclude-index list into a Float32Array.
 *
 * This is useful for derived "rest-of" pages, avoiding a huge intermediate
 * index-array allocation (while still producing a contiguous typed array for compute).
 *
 * NOTE: This always returns a NEW typed array; do not pass `source` directly to
 * Worker-backed compute, as the buffer may be transferred/detached.
 *
 * @param {ArrayLike<number>} source - Typically a Float32Array of length = pointCount
 * @param {ArrayLike<number>} excludedSorted - Sorted, unique indices to exclude
 * @returns {Float32Array}
 */
export function gatherComplementFloat32(source, excludedSorted) {
  const total = source?.length || 0;
  const excludedCount = excludedSorted?.length || 0;

  const outLen = Math.max(0, total - excludedCount);
  const out = new Float32Array(outLen);
  if (!source || !Number.isFinite(total) || total === 0 || outLen === 0) return out;

  let write = 0;
  let excludePtr = 0;

  for (let i = 0; i < total; i++) {
    if (excludePtr < excludedCount && excludedSorted[excludePtr] === i) {
      excludePtr++;
      continue;
    }
    out[write++] = source[i];
  }

  return out;
}

export default {
  gatherFloat32,
  gatherComplementFloat32
};
