/**
 * Shared Mathematical Utilities for Compute Module
 *
 * Centralizes all mathematical and statistical helper functions used by:
 * - fallback-operations.js
 * - data-worker.js
 * - operation-handlers.js
 *
 * This eliminates code duplication and ensures consistent implementations.
 */

// ============================================================================
// Basic Statistical Functions
// ============================================================================

/**
 * Calculate mean of an array.
 *
 * @param {number[]} arr - Array of numeric values
 * @returns {number} Mean value, or NaN if empty
 */
export function mean(arr) {
  if (!arr || arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Calculate variance of an array.
 *
 * @param {number[]} arr - Array of numeric values
 * @param {number} [ddof=0] - Delta degrees of freedom (0 for population, 1 for sample)
 * @returns {number} Variance, or NaN if insufficient data
 */
export function variance(arr, ddof = 0) {
  if (!arr || arr.length <= ddof) return NaN;
  const m = mean(arr);
  const sumSq = arr.reduce((a, b) => a + (b - m) ** 2, 0);
  return sumSq / (arr.length - ddof);
}

/**
 * Calculate standard deviation of an array.
 *
 * @param {number[]} arr - Array of numeric values
 * @param {number} [ddof=0] - Delta degrees of freedom (0 for population, 1 for sample)
 * @returns {number} Standard deviation
 */
export function std(arr, ddof = 0) {
  return Math.sqrt(variance(arr, ddof));
}

// ============================================================================
// Statistical Distribution Functions
// ============================================================================

/**
 * Normal CDF approximation using Abramowitz and Stegun method.
 * Accurate to about 7 decimal places.
 *
 * @param {number} z - Z-score value
 * @returns {number} Cumulative probability P(X <= z)
 */
export function normalCDF(z) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  z = Math.abs(z) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * z);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);

  return 0.5 * (1.0 + sign * y);
}

/**
 * T-distribution CDF approximation.
 * Uses normal approximation for df >= 30.
 *
 * @param {number} t - T-statistic value
 * @param {number} df - Degrees of freedom
 * @returns {number} Cumulative probability
 */
export function tCDF(t, df) {
  if (df <= 0) return NaN;
  if (df >= 30) return normalCDF(t); // Normal approximation for large df

  const x = df / (df + t * t);
  return 1 - 0.5 * incompleteBeta(x, df / 2, 0.5);
}

/**
 * Incomplete beta function approximation using continued fraction method.
 *
 * @param {number} x - Value in [0, 1]
 * @param {number} a - Shape parameter a
 * @param {number} b - Shape parameter b
 * @returns {number} Incomplete beta function value
 */
export function incompleteBeta(x, a, b) {
  if (x === 0) return 0;
  if (x === 1) return 1;

  if (x > (a + 1) / (a + b + 2)) {
    return 1 - incompleteBeta(1 - x, b, a);
  }

  const bt = Math.exp(
    gammaLn(a + b) - gammaLn(a) - gammaLn(b) +
    a * Math.log(x) + b * Math.log(1 - x)
  );

  // Continued fraction
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= 100; m++) {
    const m2 = 2 * m;

    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    h *= d * c;

    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;

    if (Math.abs(del - 1) < 1e-10) break;
  }

  return bt * h / a;
}

/**
 * Log gamma function using Lanczos approximation.
 * Accurate to about 15 decimal places.
 *
 * @param {number} z - Input value
 * @returns {number} Natural log of gamma(z)
 */
export function gammaLn(z) {
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7
  ];

  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - gammaLn(1 - z);
  }

  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) {
    x += c[i] / (z + i);
  }

  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Chi-squared CDF approximation using Wilson-Hilferty transformation.
 *
 * @param {number} x - Chi-squared statistic value
 * @param {number} df - Degrees of freedom
 * @returns {number} Cumulative probability
 */
export function chiSquaredCDF(x, df) {
  if (x <= 0) return 0;
  if (df <= 0) return NaN;

  // Wilson-Hilferty approximation
  const z = Math.pow(x / df, 1/3) - (1 - 2 / (9 * df));
  const denom = Math.sqrt(2 / (9 * df));
  return normalCDF(z / denom);
}

/**
 * Calculate chi-squared p-value (upper tail).
 *
 * @param {number} statistic - Chi-squared statistic value
 * @param {number} df - Degrees of freedom
 * @returns {number} P-value
 */
export function chiSquaredPValue(statistic, df) {
  return 1 - chiSquaredCDF(statistic, df);
}

/**
 * F-distribution p-value approximation using incomplete beta function.
 *
 * @param {number} f - F-statistic value
 * @param {number} df1 - Numerator degrees of freedom
 * @param {number} df2 - Denominator degrees of freedom
 * @returns {number} P-value (upper tail)
 */
export function fDistributionPValue(f, df1, df2) {
  if (f <= 0) return 1;
  // Using beta function approximation
  const x = df2 / (df2 + df1 * f);
  return incompleteBeta(x, df2 / 2, df1 / 2);
}

// ============================================================================
// Correlation Functions
// ============================================================================

/**
 * Compute Pearson correlation coefficient.
 *
 * @param {Array<{x: number, y: number}>} pairs - Array of {x, y} pairs
 * @returns {number} Pearson correlation coefficient (-1 to 1)
 */
export function computePearsonR(pairs) {
  const n = pairs.length;
  if (n < 2) return 0;

  const sumX = pairs.reduce((s, p) => s + p.x, 0);
  const sumY = pairs.reduce((s, p) => s + p.y, 0);
  const sumXY = pairs.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = pairs.reduce((s, p) => s + p.x * p.x, 0);
  const sumY2 = pairs.reduce((s, p) => s + p.y * p.y, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt(
    (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY)
  );

  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Compute Spearman rank correlation coefficient.
 *
 * @param {Array<{x: number, y: number}>} pairs - Array of {x, y} pairs
 * @returns {number} Spearman correlation coefficient (-1 to 1)
 */
export function computeSpearmanR(pairs) {
  // Convert to ranks
  const xRanks = computeRanks(pairs.map(p => p.x));
  const yRanks = computeRanks(pairs.map(p => p.y));

  // Compute Pearson on ranks
  const rankedPairs = xRanks.map((xr, i) => ({ x: xr, y: yRanks[i] }));
  return computePearsonR(rankedPairs);
}

/**
 * Compute ranks with proper handling of ties (average rank method).
 *
 * @param {number[]} values - Array of values to rank
 * @returns {number[]} Array of ranks (1-based, fractional for ties)
 */
export function computeRanks(values) {
  const n = values.length;
  if (n === 0) return [];

  // Sort an index array so we don't allocate per-element objects.
  const order = new Array(n);
  for (let i = 0; i < n; i++) order[i] = i;

  order.sort((a, b) => {
    const va = values[a];
    const vb = values[b];
    if (va === vb) return 0;
    return va < vb ? -1 : 1;
  });

  const ranks = new Array(n);
  let i = 0;

  while (i < n) {
    let j = i + 1;
    const v = values[order[i]];

    // Find ties (values that are equal).
    while (j < n && values[order[j]] === v) {
      j++;
    }

    // Assign average rank to all tied values (1-based ranks).
    const avgRank = (i + j + 1) / 2;
    for (let k = i; k < j; k++) {
      ranks[order[k]] = avgRank;
    }

    i = j;
  }

  return ranks;
}

/**
 * Compute simple linear regression (y = slope * x + intercept).
 *
 * @param {Array<{x: number, y: number}>} pairs - Array of {x, y} pairs
 * @returns {{slope: number, intercept: number}} Regression coefficients
 */
export function linearRegression(pairs) {
  const n = pairs.length;
  if (n < 2) return { slope: 0, intercept: pairs[0]?.y || 0 };

  const sumX = pairs.reduce((s, p) => s + p.x, 0);
  const sumY = pairs.reduce((s, p) => s + p.y, 0);
  const sumXY = pairs.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = pairs.reduce((s, p) => s + p.x * p.x, 0);

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  return { slope, intercept };
}

// ============================================================================
// Statistical Tests
// ============================================================================

/**
 * Mann-Whitney U test (Wilcoxon rank-sum test).
 * Non-parametric test for comparing two independent samples.
 *
 * @param {number[]} group1 - First group of values
 * @param {number[]} group2 - Second group of values
 * @returns {{statistic: number, pValue: number}} Test statistic and p-value
 */
export function mannWhitneyU(group1, group2) {
  const n1 = group1.length;
  const n2 = group2.length;

  if (n1 === 0 || n2 === 0) {
    return { statistic: NaN, pValue: NaN };
  }

  // Combine and rank (TypedArray-safe; avoids `.map()` which behaves differently on TypedArrays).
  // Sort an index array so we don't allocate per-element objects.
  const n = n1 + n2;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;

  const valueAt = (idx) => (idx < n1 ? group1[idx] : group2[idx - n1]);

  order.sort((a, b) => valueAt(a) - valueAt(b));

  // Rank-sum for group 1 with tie handling (no separate ranks[] allocation).
  let R1 = 0;
  let i = 0;
  while (i < n) {
    let j = i + 1;
    const v = valueAt(order[i]);
    while (j < n && valueAt(order[j]) === v) j++;

    const avgRank = (i + j + 1) / 2; // ranks are 1-based
    for (let k = i; k < j; k++) {
      if (order[k] < n1) R1 += avgRank;
    }
    i = j;
  }

  const U1 = R1 - (n1 * (n1 + 1)) / 2;
  const U2 = n1 * n2 - U1;
  const U = Math.min(U1, U2);

  // Normal approximation for p-value
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  const z = sigma > 0 ? (U - mu) / sigma : 0;
  const pValue = 2 * (1 - normalCDF(Math.abs(z)));

  return { statistic: U, pValue };
}

/**
 * Welch's t-test.
 * Parametric test for comparing two independent samples with unequal variances.
 *
 * @param {number[]} group1 - First group of values
 * @param {number[]} group2 - Second group of values
 * @returns {{statistic: number, pValue: number, df: number}} Test statistic, p-value, and degrees of freedom
 */
export function welchTTest(group1, group2) {
  const n1 = group1.length;
  const n2 = group2.length;

  if (n1 < 2 || n2 < 2) {
    return { statistic: NaN, pValue: NaN, df: NaN };
  }

  const m1 = group1.reduce((a, b) => a + b, 0) / n1;
  const m2 = group2.reduce((a, b) => a + b, 0) / n2;

  const v1 = group1.reduce((a, b) => a + Math.pow(b - m1, 2), 0) / (n1 - 1);
  const v2 = group2.reduce((a, b) => a + Math.pow(b - m2, 2), 0) / (n2 - 1);

  const se = Math.sqrt(v1 / n1 + v2 / n2);
  if (se === 0) return { statistic: 0, pValue: 1, df: n1 + n2 - 2 };

  const t = (m1 - m2) / se;

  // Welch-Satterthwaite degrees of freedom
  const num = Math.pow(v1 / n1 + v2 / n2, 2);
  const denom = Math.pow(v1 / n1, 2) / (n1 - 1) + Math.pow(v2 / n2, 2) / (n2 - 1);
  const df = num / denom;

  const pValue = 2 * (1 - tCDF(Math.abs(t), df));

  return { statistic: t, pValue, df };
}

// ============================================================================
// Binning Functions
// ============================================================================

/**
 * Calculate equal-width bin breaks.
 *
 * @param {number[]} values - Array of numeric values
 * @param {number} count - Number of bins
 * @returns {number[]} Array of bin break points
 */
export function equalWidthBreaks(values, count) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const step = (max - min) / count;

  const breaks = [];
  for (let i = 0; i <= count; i++) {
    breaks.push(min + step * i);
  }
  return breaks;
}

/**
 * Calculate quantile-based bin breaks.
 *
 * @param {number[]} values - Array of numeric values
 * @param {number} count - Number of bins
 * @returns {number[]} Array of bin break points
 */
export function quantileBreaks(values, count) {
  const sorted = [...values].sort((a, b) => a - b);
  const breaks = [sorted[0]];

  for (let i = 1; i < count; i++) {
    const idx = Math.floor((i / count) * sorted.length);
    breaks.push(sorted[idx]);
  }
  breaks.push(sorted[sorted.length - 1]);

  return breaks;
}

// ============================================================================
// Condition Evaluation
// ============================================================================

/**
 * Supported filter operators
 */
export const FilterOperator = {
  EQUALS: 'equals',
  NOT_EQUALS: 'not_equals',
  GREATER_THAN: 'greater_than',
  LESS_THAN: 'less_than',
  GREATER_EQUAL: 'greater_equal',
  LESS_EQUAL: 'less_equal',
  BETWEEN: 'between',
  IN: 'in',
  NOT_IN: 'not_in',
  CONTAINS: 'contains',
  STARTS_WITH: 'starts_with',
  ENDS_WITH: 'ends_with',
  IS_NULL: 'is_null',
  IS_NOT_NULL: 'is_not_null',
  TOP_PERCENT: 'top_percent',
  BOTTOM_PERCENT: 'bottom_percent'
};

/**
 * Evaluate a filter condition against a value.
 *
 * @param {*} value - Value to test
 * @param {{operator: string, value: *}} condition - Condition to evaluate
 * @returns {boolean} Whether the condition passes
 */
export function evaluateCondition(value, condition, thresholds = null) {
  const { operator } = condition;
  const target = condition.value;

  switch (operator) {
    case FilterOperator.EQUALS:
    case 'equals':
      return value === target;
    case FilterOperator.NOT_EQUALS:
    case 'not_equals':
      return value !== target;
    case FilterOperator.GREATER_THAN:
    case 'greater_than':
      return value > target;
    case FilterOperator.LESS_THAN:
    case 'less_than':
      return value < target;
    case FilterOperator.GREATER_EQUAL:
    case 'greater_equal':
      return value >= target;
    case FilterOperator.LESS_EQUAL:
    case 'less_equal':
      return value <= target;
    case FilterOperator.BETWEEN:
    case 'between':
      return value >= target[0] && value <= target[1];
    case FilterOperator.IN:
    case 'in':
      return Array.isArray(target) && target.includes(value);
    case FilterOperator.NOT_IN:
    case 'not_in':
      return Array.isArray(target) && !target.includes(value);
    case FilterOperator.CONTAINS:
    case 'contains':
      return String(value).toLowerCase().includes(String(target).toLowerCase());
    case FilterOperator.STARTS_WITH:
    case 'starts_with':
      return String(value).toLowerCase().startsWith(String(target).toLowerCase());
    case FilterOperator.ENDS_WITH:
    case 'ends_with':
      return String(value).toLowerCase().endsWith(String(target).toLowerCase());
    case FilterOperator.IS_NULL:
    case 'is_null':
      return value === null || value === undefined || value === '' || (typeof value === 'number' && !Number.isFinite(value));
    case FilterOperator.IS_NOT_NULL:
    case 'is_not_null':
      return value !== null && value !== undefined && value !== '' && !(typeof value === 'number' && !Number.isFinite(value));
    case FilterOperator.TOP_PERCENT:
    case 'top_percent':
    case FilterOperator.BOTTOM_PERCENT:
    case 'bottom_percent': {
      const threshold = thresholds?.get?.(`${condition.id}_threshold`);
      if (!threshold) return false;
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      return threshold.type === 'gte' ? value >= threshold.value : value <= threshold.value;
    }
    default:
      return false;
  }
}

// ============================================================================
// Formatting Functions (re-exported from shared/formatting.js)
// ============================================================================

// NOTE: These are re-exported from the centralized formatting module for
// backward compatibility. New code should import from '../shared/formatting.js'
import { formatNumber, formatPValue } from '../shared/formatting.js';
export { formatNumber, formatPValue };

// ============================================================================
// Value Filtering Utilities
// ============================================================================

/**
 * Filter array to only valid numeric values (excludes NaN, null, undefined).
 *
 * @param {Array} values - Array of values
 * @returns {number[]} Array of valid numeric values
 */
export function filterNumeric(values) {
  return values.filter(v => typeof v === 'number' && Number.isFinite(v));
}

/**
 * Check if a value is a valid number (not NaN, not null, not undefined).
 *
 * @param {*} value - Value to check
 * @returns {boolean} True if value is a valid number
 */
export function isValidNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Check if a value is missing (null, undefined, or NaN).
 *
 * @param {*} value - Value to check
 * @returns {boolean} True if value is missing
 */
export function isMissing(value) {
  return value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value));
}

// ============================================================================
// Default Export
// ============================================================================

export default {
  // Basic statistics
  mean,
  variance,
  std,

  // Distribution functions
  normalCDF,
  tCDF,
  incompleteBeta,
  gammaLn,
  chiSquaredCDF,
  chiSquaredPValue,
  fDistributionPValue,

  // Correlation functions
  computePearsonR,
  computeSpearmanR,
  computeRanks,
  linearRegression,

  // Statistical tests
  mannWhitneyU,
  welchTTest,

  // Binning functions
  equalWidthBreaks,
  quantileBreaks,

  // Condition evaluation
  FilterOperator,
  evaluateCondition,

  // Formatting
  formatNumber,
  formatPValue,

  // Value utilities
  filterNumeric,
  isValidNumber,
  isMissing
};
