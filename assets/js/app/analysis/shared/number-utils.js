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
  std as mathStd,
  selectSorted
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
 * The two middle order statistics are selected without sorting through a
 * comparator (`selectSorted`): the same numbers a sorted copy holds there.
 *
 * @param {ArrayLike<number>} arr - Finite numeric values (will not be mutated)
 * @returns {number} Median value, or NaN if empty
 *
 * @example
 * median([1, 2, 3, 4, 5])  // 3
 * median([1, 2, 3, 4])     // 2.5
 * median([])               // NaN
 */
export function median(arr) {
  if (!arr || arr.length === 0) return NaN;

  const n = arr.length;
  const mid = Math.floor(n / 2);
  const [lower, upper] = selectSorted(arr, [n % 2 === 0 ? mid - 1 : mid, mid]);

  return n % 2 === 0
    ? (lower + upper) / 2
    : upper;
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
  const valid = finiteNumbers(values);
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

  // The median needs two positions of the ascending order, not the whole of it.
  // `finiteNumbers` has already removed every non-finite value, so
  // `selectSorted` resolves those positions exactly — by counting distinct
  // values when there are few, by sorting when there are many.
  const mid = Math.floor(n / 2);
  const [lower, upper] = selectSorted(valid, [mid > 0 ? mid - 1 : 0, mid]);
  const medianVal = n % 2 === 0
    ? (lower + upper) / 2
    : upper;

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

/** @type {WeakMap<object, ArrayLike<number>>} */
const finiteNumbersByValues = new WeakMap();

/**
 * The finite numbers of `values`, in order: `values` itself when every entry
 * is already a finite number, otherwise a copy of the finite entries (a
 * Float32Array for Float32 input, a Float64Array otherwise).
 *
 * Unlike `filterFiniteNumbers` this never boxes a page into a JavaScript number
 * array, and a caller reads the same numbers in the same order either way. A
 * page is scanned once: the answer is kept per values array, because page-data
 * arrays are never edited once published while a plot reads them for its
 * statistics, its traces and its layout on every redraw.
 *
 * @param {ArrayLike<any>} values
 * @returns {ArrayLike<number>}
 */
export function finiteNumbers(values) {
  if (!values) return new Float64Array(0);
  const cached = finiteNumbersByValues.get(values);
  if (cached !== undefined) return cached;
  let finiteCount = 0;
  for (let i = 0; i < values.length; i++) {
    if (isFiniteNumber(values[i])) finiteCount++;
  }
  let finite = values;
  if (finiteCount !== values.length) {
    finite = values instanceof Float32Array
      ? new Float32Array(finiteCount)
      : new Float64Array(finiteCount);
    let write = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (isFiniteNumber(v)) finite[write++] = v;
    }
  }
  finiteNumbersByValues.set(values, finite);
  if (finite !== values) finiteNumbersByValues.set(finite, finite);
  return finite;
}

/**
 * What `finiteNumbers(values)` returns, as computed elsewhere — by an analysis
 * worker that scanned a copy of `values` — so that this thread never scans it.
 *
 * @param {ArrayLike<number>} values
 * @param {number} finiteCount - How many entries of `values` are finite
 * @param {ArrayLike<number>|null} finite - The finite entries in order, or null
 *   when every entry is finite
 */
export function adoptFiniteNumbers(values, finiteCount, finite) {
  if (finiteCount === values.length) {
    finiteNumbersByValues.set(values, values);
    return;
  }
  if (finite === null || finite.length !== finiteCount) {
    throw new RangeError('Adopted finite values must hold exactly the finite count');
  }
  finiteNumbersByValues.set(values, finite);
  finiteNumbersByValues.set(finite, finite);
}

/**
 * The part of a worker result that lets the calling thread adopt the finite
 * values of a page the worker scanned.
 *
 * @param {ArrayLike<number>} values - The worker's copy of the page
 * @returns {{finiteCount: number, finite: ArrayLike<number>|null}}
 */
export function finiteNumbersReport(values) {
  const finite = finiteNumbers(values);
  return { finiteCount: finite.length, finite: finite === values ? null : finite };
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
