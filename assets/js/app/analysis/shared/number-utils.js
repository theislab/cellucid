/**
 * Number Utilities (Finite-safe)
 *
 * Centralizes common numeric helpers that must be safe for very large arrays.
 * In particular, avoids `Math.min(...arr)` / `Math.max(...arr)` which can throw
 * `RangeError: too many arguments` for large datasets.
 *
 * This module is intentionally dependency-free so it can be used across:
 * - core/
 * - plots/
 * - ui/
 * - shared/
 *
 * @module shared/number-utils
 */

/**
 * Check whether a value is a finite number (excludes NaN and ±Infinity).
 * @param {*} value
 * @returns {boolean}
 */
export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Filter a list/typed-array to finite numbers.
 * Uses an explicit loop for speed and to support TypedArrays.
 *
 * @param {ArrayLike<any>|any[]} values
 * @returns {number[]}
 */
export function filterFiniteNumbers(values) {
  const out = [];
  if (!values) return out;

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (isFiniteNumber(v)) out.push(v);
  }

  return out;
}

/**
 * Compute finite min/max in a single pass (NaN/±Infinity ignored).
 * Returns NaN min/max when no finite values are found.
 *
 * @param {ArrayLike<any>|any[]} values
 * @returns {{min: number, max: number, count: number}}
 */
export function getFiniteMinMax(values) {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;

  if (!values) return { min: NaN, max: NaN, count: 0 };

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isFiniteNumber(v)) continue;
    count++;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  if (count === 0) return { min: NaN, max: NaN, count: 0 };
  return { min, max, count };
}

