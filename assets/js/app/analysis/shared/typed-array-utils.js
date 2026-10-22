/**
 * Typed Array Utilities
 *
 * Small, dependency-free helpers for working with large numeric arrays efficiently.
 *
 * @module shared/typed-array-utils
 */

/**
 * The cells a group selects, as a Uint32Array of source positions in output
 * order — a "gather plan".
 *
 * A comparison gathers the same cells out of every gene of a run, so the plan
 * is built once per run and every per-gene gather is then one tight typed
 * loop. Gathering straight from a generic index array (or walking a sorted
 * exclusion list to build a complement) cost several times more per cell, and
 * at 500,000 cells it was most of a differential-expression run's main-thread
 * time.
 *
 * @param {ArrayLike<number>} indices - Validated cell indices, in output order
 * @returns {Uint32Array}
 */
export function indexGatherPlan(indices) {
  return Uint32Array.from(indices);
}

/**
 * Gather plan for every position in `[0, total)` that is not in a sorted,
 * unique exclusion list — a derived "rest-of" group — in ascending order.
 *
 * @param {ArrayLike<number>} excludedSorted - Sorted, unique, validated indices
 * @param {number} total - Number of positions
 * @returns {Uint32Array}
 */
export function complementGatherPlan(excludedSorted, total) {
  const excludedCount = excludedSorted.length;
  const plan = new Uint32Array(Math.max(0, total - excludedCount));
  let write = 0;
  let excludePtr = 0;
  for (let i = 0; i < total; i++) {
    if (excludePtr < excludedCount && excludedSorted[excludePtr] === i) {
      excludePtr++;
      continue;
    }
    plan[write++] = i;
  }
  return plan;
}

/**
 * Gather `source[plan[i]]` into a new Float32Array.
 *
 * Every plan entry must be a position inside `source`; plans are validated
 * against the cell count when they are built.
 *
 * @param {ArrayLike<number>} source - Typically a Float32Array of length = pointCount
 * @param {Uint32Array} plan
 * @returns {Float32Array}
 */
export function gatherFloat32(source, plan) {
  const out = new Float32Array(plan.length);
  for (let i = 0; i < plan.length; i++) out[i] = source[plan[i]];
  return out;
}
