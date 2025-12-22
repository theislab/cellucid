/**
 * Number Utilities (Finite-safe)
 *
 * Centralizes common numeric helpers that must be safe for very large arrays.
 * In particular, avoids `Math.min(...arr)` / `Math.max(...arr)` which can throw
 * `RangeError: too many arguments` for large datasets.
 *
 * This module provides:
 * - Finite number validation (isFiniteNumber)
 * - Basic statistics (mean, variance, std, median)
 * - Array filtering utilities
 * - Min/max computation for large arrays
 *
 * This is THE canonical source for number validation and basic statistics.
 * All code should import from this module for these utilities.
 *
 * @module shared/number-utils
 */

// Re-export core statistics from math-utils (the compute module's implementation)
// This provides a single, convenient import point for all statistics utilities
import {
  mean as mathMean,
  variance as mathVariance,
  std as mathStd
} from '../compute/math-utils.js';
import { isFiniteNumber } from '../../utils/number-utils.js';

export { isFiniteNumber };

// =============================================================================
// NUMBER VALIDATION
// =============================================================================

// Note: `isFiniteNumber` is imported from `app/utils/number-utils.js` to keep a
// single source of truth shared across the app and analysis layers.

// =============================================================================
// BASIC STATISTICS
// =============================================================================

/**
 * Calculate mean of an array.
 * Re-exported from compute/math-utils.js for convenience.
 *
 * @param {number[]} arr - Array of numeric values
 * @returns {number} Mean value, or NaN if empty
 */
export const mean = mathMean;

/**
 * Calculate variance of an array.
 * Re-exported from compute/math-utils.js for convenience.
 *
 * @param {number[]} arr - Array of numeric values
 * @param {number} [ddof=0] - Delta degrees of freedom (0 for population, 1 for sample)
 * @returns {number} Variance, or NaN if insufficient data
 */
export const variance = mathVariance;

/**
 * Calculate standard deviation of an array.
 * Re-exported from compute/math-utils.js for convenience.
 *
 * @param {number[]} arr - Array of numeric values
 * @param {number} [ddof=0] - Delta degrees of freedom (0 for population, 1 for sample)
 * @returns {number} Standard deviation
 */
export const std = mathStd;

/**
 * Calculate median of an array.
 * Handles both even and odd length arrays correctly.
 *
 * @param {number[]} arr - Array of numeric values (will not be mutated)
 * @returns {number} Median value, or NaN if empty
 *
 * @example
 * median([1, 2, 3, 4, 5])  // 3
 * median([1, 2, 3, 4])     // 2.5
 * median([])               // NaN
 */
export function median(arr) {
  if (!arr || arr.length === 0) return NaN;

  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);

  return n % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Compute basic statistics for an array of values.
 * Filters to finite numbers first, then computes all stats in a single pass where possible.
 *
 * @param {number[]} values - Array of values (can include NaN, null, etc.)
 * @returns {{ count: number, mean: number, median: number, std: number, min: number, max: number }}
 *
 * @example
 * computeStats([1, 2, 3, NaN, 4, 5])
 * // { count: 5, mean: 3, median: 3, std: 1.414..., min: 1, max: 5 }
 */
export function computeStats(values) {
  const valid = filterFiniteNumbers(values);
  const n = valid.length;

  if (n === 0) {
    return { count: 0, mean: NaN, median: NaN, std: NaN, min: NaN, max: NaN };
  }

  // Compute mean and variance in one pass
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < n; i++) {
    const v = valid[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const meanVal = sum / n;

  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    sumSq += (valid[i] - meanVal) ** 2;
  }
  const stdVal = Math.sqrt(sumSq / n);

  // For median, we need to sort
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const medianVal = n % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];

  return {
    count: n,
    mean: meanVal,
    median: medianVal,
    std: stdVal,
    min,
    max
  };
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
