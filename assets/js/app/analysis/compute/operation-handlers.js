/**
 * Shared Operation Handlers for Compute Module
 *
 * Contains all operation implementations used by:
 * - data-worker.js (Web Worker context)
 * - fallback-operations.js (CPU fallback on main thread)
 *
 * Each handler is a pure function that takes a payload and returns a result.
 * No side effects, no external state dependencies.
 *
 * IMPORTANT: This file is designed to work in both browser and worker contexts.
 * Do NOT import browser-specific APIs or modules that require DOM access.
 */

import { OperationType } from './operations.js';
import {
  mean,
  normalCDF,
  tCDF,
  computeRanks,
  mannWhitneyU,
  welchTTest,
  equalWidthBreaks,
  quantileBreaks,
  evaluateCondition,
  formatNumber,
  filterNumeric,
  isValidNumber,
  isMissing
} from './math-utils.js';

// ============================================================================
// Transform Operations (Worker/CPU implementations)
// ============================================================================

function toFloat32Array(values) {
  if (values instanceof Float32Array) return values;
  if (ArrayBuffer.isView(values)) return new Float32Array(values);
  return new Float32Array(values || []);
}

function filterNumericIfNeeded(values) {
  if (!values || values.length === 0) return values;

  // Fast path: avoid allocating a copy when inputs are already finite.
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      return filterNumeric(values);
    }
  }

  return values;
}

function computeMeanAndStd(values) {
  let count = 0;
  let mean = 0;
  let m2 = 0;

  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    if (!Number.isFinite(x)) continue;
    count++;
    const delta = x - mean;
    mean += delta / count;
    const delta2 = x - mean;
    m2 += delta * delta2;
  }

  if (count === 0) {
    return { mean: NaN, std: NaN, count: 0 };
  }

  const variance = count > 1 ? m2 / count : 0;
  return { mean, std: Math.sqrt(variance), count };
}

function computeMinAndMax(values) {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;

  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    if (!Number.isFinite(x)) continue;
    count++;
    if (x < min) min = x;
    if (x > max) max = x;
  }

  if (count === 0) {
    return { min: NaN, max: NaN, count: 0 };
  }

  return { min, max, count };
}

/**
 * Apply log(1+x) transform.
 * @param {Object} payload
 * @param {Array|TypedArray} payload.values
 * @returns {{values: Float32Array}}
 */
export function log1pTransform(payload) {
  const input = toFloat32Array(payload.values);
  const out = new Float32Array(input.length);

  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    out[i] = Number.isFinite(x) ? Math.log1p(x) : NaN;
  }

  return { values: out };
}

/**
 * Z-score normalization: (x - mean) / std
 * @param {Object} payload
 * @param {Array|TypedArray} payload.values
 * @param {number} [payload.mean]
 * @param {number} [payload.std]
 * @returns {{values: Float32Array, mean: number, std: number}}
 */
export function zscoreNormalize(payload) {
  const input = toFloat32Array(payload.values);
  const computed = computeMeanAndStd(input);
  const mean = Number.isFinite(payload.mean) ? payload.mean : computed.mean;
  const std = Number.isFinite(payload.std) ? payload.std : computed.std;

  const out = new Float32Array(input.length);

  // Preserve NaN positions; avoid division-by-zero explosions.
  if (!Number.isFinite(mean) || !Number.isFinite(std) || std === 0) {
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      out[i] = Number.isFinite(x) ? 0 : NaN;
    }
    return { values: out, mean, std: std === 0 ? 0 : std };
  }

  const invStd = 1 / std;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    out[i] = Number.isFinite(x) ? (x - mean) * invStd : NaN;
  }

  return { values: out, mean, std };
}

/**
 * Min-max normalization: (x - min) / (max - min)
 * @param {Object} payload
 * @param {Array|TypedArray} payload.values
 * @param {number} [payload.min]
 * @param {number} [payload.max]
 * @returns {{values: Float32Array, min: number, max: number}}
 */
export function minmaxNormalize(payload) {
  const input = toFloat32Array(payload.values);
  const computed = computeMinAndMax(input);
  const min = Number.isFinite(payload.min) ? payload.min : computed.min;
  const max = Number.isFinite(payload.max) ? payload.max : computed.max;

  const out = new Float32Array(input.length);
  const range = max - min;

  if (!Number.isFinite(min) || !Number.isFinite(max) || range === 0) {
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      out[i] = Number.isFinite(x) ? 0 : NaN;
    }
    return { values: out, min, max };
  }

  const invRange = 1 / range;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    out[i] = Number.isFinite(x) ? (x - min) * invRange : NaN;
  }

  return { values: out, min, max };
}

/**
 * Scale and offset: x * scale + offset
 * @param {Object} payload
 * @param {Array|TypedArray} payload.values
 * @param {number} [payload.scale=1]
 * @param {number} [payload.offset=0]
 * @returns {{values: Float32Array}}
 */
export function scaleTransform(payload) {
  const input = toFloat32Array(payload.values);
  const scale = Number.isFinite(payload.scale) ? payload.scale : 1;
  const offset = Number.isFinite(payload.offset) ? payload.offset : 0;

  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    out[i] = Number.isFinite(x) ? (x * scale + offset) : NaN;
  }

  return { values: out };
}

/**
 * Clamp values to [min, max]
 * @param {Object} payload
 * @param {Array|TypedArray} payload.values
 * @param {number} [payload.min=0]
 * @param {number} [payload.max=1]
 * @returns {{values: Float32Array}}
 */
export function clampTransform(payload) {
  const input = toFloat32Array(payload.values);
  const min = Number.isFinite(payload.min) ? payload.min : 0;
  const max = Number.isFinite(payload.max) ? payload.max : 1;

  const lower = Math.min(min, max);
  const upper = Math.max(min, max);

  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    if (!Number.isFinite(x)) {
      out[i] = NaN;
      continue;
    }
    out[i] = x < lower ? lower : (x > upper ? upper : x);
  }

  return { values: out };
}

// ============================================================================
// Value Extraction Operations
// ============================================================================

/**
 * Extract values for given cell indices from raw data.
 *
 * @param {Object} payload
 * @param {number[]} payload.cellIndices - Array of cell indices to extract
 * @param {Array} payload.rawValues - Raw data array
 * @param {string[]} [payload.categories] - Category names for categorical data
 * @param {boolean} [payload.isCategorical=false] - Whether data is categorical
 * @returns {{values: Array, validIndices: number[], validCount: number}}
 */
export function extractValues(payload) {
  const { cellIndices, rawValues, categories, isCategorical } = payload;

  const values = [];
  const validIndices = [];

  for (let i = 0; i < cellIndices.length; i++) {
    const idx = cellIndices[i];

    if (idx < 0 || idx >= rawValues.length) continue;

    let value = rawValues[idx];

    // Handle missing values
    if (isMissing(value)) {
      continue;
    }

    // Decode categorical values
    if (isCategorical && categories) {
      value = categories[value] ?? `Unknown (${value})`;
    }

    values.push(value);
    validIndices.push(idx);
  }

  return { values, validIndices, validCount: values.length };
}

/**
 * Batch extract values for multiple variables.
 *
 * @param {Object} payload
 * @param {number[]} payload.cellIndices - Array of cell indices
 * @param {Array<{key: string, rawValues: Array, categories?: string[], isCategorical?: boolean}>} payload.variables
 * @returns {Object} Object keyed by variable.key with extraction results
 */
export function batchExtract(payload) {
  const { cellIndices, variables } = payload;
  const results = {};

  for (const variable of variables) {
    results[variable.key] = extractValues({
      cellIndices,
      rawValues: variable.rawValues,
      categories: variable.categories,
      isCategorical: variable.isCategorical
    });
  }

  return results;
}

// ============================================================================
// Statistical Computation Operations
// ============================================================================

/**
 * Compute comprehensive statistics for numeric values.
 *
 * @param {Object} payload
 * @param {Array} payload.values - Array of values
 * @returns {Object} Statistics object with count, min, max, mean, median, std, q1, q3, iqr, sum, variance
 */
export function computeStats(payload) {
  const { values } = payload;

  // Filter to valid numbers
  const numericValues = filterNumeric(values);

  if (numericValues.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      median: null,
      std: null,
      q1: null,
      q3: null,
      iqr: null,
      sum: null,
      variance: null
    };
  }

  // Sort for percentile calculations
  const sorted = [...numericValues].sort((a, b) => a - b);
  const n = sorted.length;

  // Basic stats
  const min = sorted[0];
  const max = sorted[n - 1];
  const sum = numericValues.reduce((a, b) => a + b, 0);
  const mean = sum / n;

  // Variance and standard deviation
  const squaredDiffs = numericValues.map(v => Math.pow(v - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(variance);

  // Percentiles
  const q1Idx = Math.floor(n * 0.25);
  const medianIdx = Math.floor(n * 0.5);
  const q3Idx = Math.floor(n * 0.75);

  const q1 = sorted[q1Idx];
  const median = n % 2 === 0
    ? (sorted[medianIdx - 1] + sorted[medianIdx]) / 2
    : sorted[medianIdx];
  const q3 = sorted[q3Idx];
  const iqr = q3 - q1;

  return {
    count: n,
    min,
    max,
    mean,
    median,
    std,
    q1,
    q3,
    iqr,
    sum,
    variance
  };
}

/**
 * Compute correlation coefficients (Pearson or Spearman).
 *
 * @param {Object} payload
 * @param {number[]} payload.xValues - X values
 * @param {number[]} payload.yValues - Y values
 * @param {string} [payload.method='pearson'] - 'pearson' or 'spearman'
 * @returns {Object} Correlation result with r, rSquared, pValue, n, method, slope, intercept
 */
export function computeCorrelation(payload) {
  const { xValues, yValues, method = 'pearson' } = payload;

  const len = Math.min(xValues?.length || 0, yValues?.length || 0);
  if (len === 0) {
    return { r: NaN, pValue: NaN, n: 0, method };
  }

  // Single pass: compute sums on finite pairs (enables Pearson + linear regression without allocations).
  let n = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;

  for (let i = 0; i < len; i++) {
    const x = xValues[i];
    const y = yValues[i];
    if (!isValidNumber(x) || !isValidNumber(y)) continue;

    n++;
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumYY += y * y;
    sumXY += x * y;
  }

  if (n < 3) {
    return { r: NaN, pValue: NaN, n, method };
  }

  // Linear regression for trend line (y = slope*x + intercept).
  const denomSlope = n * sumXX - sumX * sumX;
  const slope = denomSlope === 0 ? 0 : (n * sumXY - sumX * sumY) / denomSlope;
  const intercept = (sumY - slope * sumX) / n;

  // Correlation coefficient.
  const computePearsonFromArrays = (xs, ys) => {
    const m = Math.min(xs.length, ys.length);
    if (m < 2) return 0;

    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;

    for (let i = 0; i < m; i++) {
      const x = xs[i];
      const y = ys[i];
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
    }

    const numerator = m * sxy - sx * sy;
    const denom = Math.sqrt((m * sxx - sx * sx) * (m * syy - sy * sy));
    return denom === 0 ? 0 : numerator / denom;
  };

  let r;
  if (method === 'spearman') {
    // For Spearman we need ranks; avoid allocating per-pair objects.
    if (n === len) {
      // Fast path: all pairs valid, rank inputs directly.
      const xRanks = computeRanks(xValues);
      const yRanks = computeRanks(yValues);
      r = computePearsonFromArrays(xRanks, yRanks);
    } else {
      // Compact to valid-only arrays, then rank.
      const xValid = new Float32Array(n);
      const yValid = new Float32Array(n);
      let k = 0;
      for (let i = 0; i < len; i++) {
        const x = xValues[i];
        const y = yValues[i];
        if (!isValidNumber(x) || !isValidNumber(y)) continue;
        xValid[k] = x;
        yValid[k] = y;
        k++;
      }
      const xRanks = computeRanks(xValid);
      const yRanks = computeRanks(yValid);
      r = computePearsonFromArrays(xRanks, yRanks);
    }
  } else {
    const numerator = n * sumXY - sumX * sumY;
    const denom = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));
    r = denom === 0 ? 0 : numerator / denom;
  }

  // Compute p-value using t-distribution approximation.
  const rSquared = r * r;
  const denomT = 1 - rSquared;
  const t = denomT <= 0 ? (r >= 0 ? Infinity : -Infinity) : r * Math.sqrt((n - 2) / denomT);
  const pValue = Number.isFinite(t)
    ? 2 * (1 - tCDF(Math.abs(t), n - 2))
    : 0;

  return {
    r,
    rSquared,
    pValue,
    n,
    method,
    slope,
    intercept
  };
}

/**
 * Compute differential expression statistics between two groups.
 *
 * @param {Object} payload
 * @param {number[]} payload.groupAValues - Values for group A
 * @param {number[]} payload.groupBValues - Values for group B
 * @param {string} [payload.method='wilcox'] - 'wilcox' (Mann-Whitney U) or 'ttest' (Welch's t-test)
 * @returns {Object} Differential expression result
 */
export function computeDifferential(payload) {
  const { groupAValues, groupBValues, method = 'wilcox' } = payload;

  const valsA = filterNumericIfNeeded(groupAValues);
  const valsB = filterNumericIfNeeded(groupBValues);

  if (valsA.length < 2 || valsB.length < 2) {
    return {
      meanA: NaN,
      meanB: NaN,
      log2FoldChange: NaN,
      pValue: NaN,
      statistic: NaN,
      nA: valsA.length,
      nB: valsB.length
    };
  }

  // Calculate means using centralized utility
  const meanA = mean(valsA);
  const meanB = mean(valsB);

  // Log2 fold change (with pseudocount to avoid log(0))
  const pseudocount = 0.01;
  const log2FoldChange = Math.log2((meanA + pseudocount) / (meanB + pseudocount));

  // Statistical test
  let testResult;
  if (method === 'wilcox') {
    testResult = mannWhitneyU(valsA, valsB);
  } else {
    testResult = welchTTest(valsA, valsB);
  }

  return {
    meanA,
    meanB,
    log2FoldChange,
    pValue: testResult.pValue,
    statistic: testResult.statistic,
    nA: valsA.length,
    nB: valsB.length,
    method
  };
}

// ============================================================================
// Aggregation Operations
// ============================================================================

/**
 * Count category occurrences efficiently.
 *
 * @param {Object} payload
 * @param {Array} payload.values - Array of categorical values
 * @param {boolean} [payload.normalize=false] - Whether to compute percentages
 * @returns {Object} Aggregation result with categories, counts, total, and optionally percentages
 */
export function aggregateCategories(payload) {
  const { values, normalize = false } = payload;

  const counts = new Map();
  let total = 0;

  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
    total++;
  }

  // Convert to sorted array (by count descending)
  const entries = Array.from(counts.entries());
  entries.sort((a, b) => b[1] - a[1]);

  if (normalize && total > 0) {
    return {
      categories: entries.map(e => e[0]),
      counts: entries.map(e => e[1]),
      percentages: entries.map(e => (e[1] / total) * 100),
      total
    };
  }

  return {
    categories: entries.map(e => e[0]),
    counts: entries.map(e => e[1]),
    total
  };
}

/**
 * Bin continuous values into categories.
 *
 * @param {Object} payload
 * @param {Array} payload.values - Array of numeric values
 * @param {string} [payload.method='equal_width'] - 'equal_width', 'quantile', or 'custom'
 * @param {number} [payload.binCount=10] - Number of bins
 * @param {number[]} [payload.customBreaks] - Custom break points (for method='custom')
 * @returns {Object} Binning result with bins, breaks, labels
 */
export function binValues(payload) {
  const { values, method = 'equal_width', binCount = 10, customBreaks = null } = payload;

  const numericValues = filterNumeric(values);

  if (numericValues.length === 0) {
    return {
      bins: values.map(() => 'No data'),
      breaks: [],
      labels: []
    };
  }

  let breaks;

  if (method === 'custom' && customBreaks) {
    breaks = [...customBreaks].sort((a, b) => a - b);
  } else if (method === 'quantile') {
    breaks = quantileBreaks(numericValues, binCount);
  } else {
    breaks = equalWidthBreaks(numericValues, binCount);
  }

  // Generate labels
  const labels = [];
  for (let i = 0; i < breaks.length - 1; i++) {
    labels.push(`${formatNumber(breaks[i])}-${formatNumber(breaks[i + 1])}`);
  }

  // Bin each value
  const bins = values.map(v => {
    if (!isValidNumber(v)) {
      return 'Missing';
    }
    for (let i = 0; i < breaks.length - 1; i++) {
      const isLast = i === breaks.length - 2;
      if (v >= breaks[i] && (isLast ? v <= breaks[i + 1] : v < breaks[i + 1])) {
        return labels[i];
      }
    }
    return labels[labels.length - 1];
  });

  return { bins, breaks, labels };
}

// ============================================================================
// Filtering Operations
// ============================================================================

/**
 * Filter cells based on conditions.
 *
 * @param {Object} payload
 * @param {number[]} payload.cellIndices - Array of cell indices to filter
 * @param {Array<{field: string, operator: string, value: *, logic?: string}>} payload.conditions
 * @param {Object} payload.fieldsData - Object mapping field names to data arrays
 * @returns {Object} Filter result with filtered indices, originalCount, filteredCount
 */
export function filterCells(payload) {
  const { cellIndices, conditions, fieldsData } = payload;

  const originalCount = Array.isArray(cellIndices) ? cellIndices.length : 0;
  if (!Array.isArray(cellIndices) || originalCount === 0) {
    return { filtered: [], originalCount, filteredCount: 0 };
  }

  const enabledConditions = (conditions || []).filter(c => c && c.enabled !== false);
  if (enabledConditions.length === 0) {
    return { filtered: [...cellIndices], originalCount, filteredCount: originalCount };
  }

  const normalizedConditions = enabledConditions.map((condition, index) => ({
    ...condition,
    id: condition.id ?? String(index),
    logic: String(condition.logic || 'AND').toUpperCase(),
    negate: !!condition.negate
  }));

  // Pre-compute percentile thresholds for top/bottom percent operators.
  const thresholds = new Map();
  for (let i = 0; i < normalizedConditions.length; i++) {
    const condition = normalizedConditions[i];
    const operator = condition.operator;
    if (operator !== 'top_percent' && operator !== 'bottom_percent') continue;

    const fieldValues = fieldsData?.[condition.field];
    if (!fieldValues) continue;

    const percent = Number(condition.value);
    if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) continue;

    const validValues = filterNumeric(Array.from(fieldValues));
    if (validValues.length === 0) continue;

    validValues.sort((a, b) => a - b);
    const percentile = percent / 100;

    if (operator === 'top_percent') {
      const idx = Math.floor(validValues.length * (1 - percentile));
      thresholds.set(`${condition.id}_threshold`, {
        value: validValues[Math.min(idx, validValues.length - 1)],
        type: 'gte'
      });
    } else {
      const idx = Math.floor(validValues.length * percentile);
      thresholds.set(`${condition.id}_threshold`, {
        value: validValues[Math.max(0, idx - 1)],
        type: 'lte'
      });
    }
  }

  const filtered = [];

  for (let i = 0; i < cellIndices.length; i++) {
    const cellIdx = cellIndices[i];
    let result = false;

    for (let c = 0; c < normalizedConditions.length; c++) {
      const condition = normalizedConditions[c];
      const fieldValues = fieldsData?.[condition.field];
      const value = fieldValues ? fieldValues[cellIdx] : undefined;

      let pass = fieldValues ? evaluateCondition(value, condition, thresholds) : false;
      if (condition.negate) pass = !pass;

      if (c === 0) {
        result = pass;
        continue;
      }

      if (condition.logic === 'OR') {
        result = result || pass;
      } else {
        result = result && pass;
      }
    }

    if (result) filtered.push(cellIdx);
  }

  return { filtered, originalCount, filteredCount: filtered.length };
}

// ============================================================================
// Distribution Operations
// ============================================================================

/**
 * Compute kernel density estimation.
 *
 * @param {Object} payload
 * @param {number[]} payload.values - Array of numeric values
 * @param {number} [payload.points=100] - Number of density points to compute
 * @returns {Object} Density result with x, y arrays, bandwidth, n
 */
export function computeDensity(payload) {
  const { values, points = 100 } = payload;

  const numericValues = filterNumeric(values);
  const n = numericValues.length;

  if (points < 2) {
    return { x: [], y: [], bandwidth: 0, n };
  }

  if (n < 2) {
    return { x: [], y: [], bandwidth: 0, n };
  }

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = numericValues[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = numericValues.reduce((a, b) => a + b, 0) / n;

  // Scott's rule for bandwidth
  const std = Math.sqrt(
    numericValues.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / n
  );
  const bandwidth = 1.06 * std * Math.pow(n, -0.2);

  if (bandwidth === 0 || !isFinite(bandwidth)) {
    return { x: [], y: [], bandwidth: 0, n };
  }

  // Generate density points
  const step = (max - min) / (points - 1);
  const x = [];
  const y = [];

  for (let i = 0; i < points; i++) {
    const xi = min + step * i;
    x.push(xi);

    // Kernel density at this point
    let density = 0;
    for (let j = 0; j < n; j++) {
      const u = (xi - numericValues[j]) / bandwidth;
      density += Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI);
    }
    y.push(density / (n * bandwidth));
  }

  return { x, y, bandwidth, n };
}

/**
 * Compute histogram with optimized binning.
 *
 * @param {Object} payload
 * @param {number[]} payload.values - Array of numeric values
 * @param {string|number} [payload.bins='auto'] - 'auto', 'sturges', 'fd', or number of bins
 * @param {[number, number]} [payload.range] - Optional [min, max] range
 * @returns {Object} Histogram result with edges, counts, density, binWidth, total
 */
export function computeHistogram(payload) {
  const { values, bins, nbins, range = null, min: minArg, max: maxArg } = payload;
  const binSpec = bins ?? nbins ?? 'auto';

  const numericValues = filterNumeric(values);

  if (numericValues.length === 0) {
    return { edges: [], counts: [], density: [], binWidth: 0, total: 0 };
  }

  let min;
  let max;

  if (Array.isArray(range) && range.length === 2 && Number.isFinite(range[0]) && Number.isFinite(range[1])) {
    min = range[0];
    max = range[1];
  } else if (Number.isFinite(minArg) && Number.isFinite(maxArg)) {
    min = minArg;
    max = maxArg;
  } else {
    min = Infinity;
    max = -Infinity;
    for (let i = 0; i < numericValues.length; i++) {
      const v = numericValues[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { edges: [], counts: [], density: [], binWidth: 0, total: 0 };
  }

  // Normalize range direction
  if (min > max) [min, max] = [max, min];

  // Determine number of bins
  let numBins;
  if (binSpec === 'auto' || binSpec === 'sturges') {
    // Sturges' rule
    numBins = Math.ceil(Math.log2(numericValues.length)) + 1;
  } else if (binSpec === 'fd') {
    // Freedman-Diaconis rule
    const sorted = [...numericValues].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    const binWidth = 2 * iqr * Math.pow(numericValues.length, -1/3);
    numBins = binWidth > 0 ? Math.ceil((max - min) / binWidth) : 1;
  } else {
    numBins = typeof binSpec === 'number' ? binSpec : 10;
  }

  numBins = Math.max(1, Math.min(numBins, 100)); // Clamp

  const binWidth = (max - min) / numBins;
  if (!Number.isFinite(binWidth) || binWidth <= 0) {
    const total = numericValues.length;
    return {
      edges: [min, max],
      counts: [total],
      density: [0],
      binWidth: 0,
      total
    };
  }

  const edges = [];
  const counts = new Array(numBins).fill(0);

  for (let i = 0; i <= numBins; i++) {
    edges.push(min + i * binWidth);
  }

  // Count values in each bin
  let validCount = 0;
  for (const v of numericValues) {
    if (v < min || v > max) continue;
    let binIdx = Math.floor((v - min) / binWidth);
    if (binIdx === numBins) binIdx = numBins - 1; // Include max value
    counts[binIdx]++;
    validCount++;
  }

  // Compute density
  const total = validCount;
  const density = counts.map(c => (total > 0 ? c / (total * binWidth) : 0));

  return {
    edges,
    counts,
    density,
    binWidth,
    total
  };
}

/**
 * Compare distributions from multiple groups.
 *
 * @param {Object} payload
 * @param {Array<{id: string, name: string, values: number[]}>} payload.groups - Groups to compare
 * @param {boolean} [payload.normalize=true] - Whether to normalize histograms
 * @returns {Object} Comparison result with groups array, shared range, bins
 */
export function compareDistributions(payload) {
  const { groups, normalize = true } = payload;

  const results = [];
  let globalMin = Infinity;
  let globalMax = -Infinity;

  // First pass: compute stats and find global range
  for (const group of groups) {
    const numericValues = filterNumeric(group.values);

    if (numericValues.length === 0) {
      results.push({
        id: group.id,
        name: group.name,
        n: 0,
        stats: null,
        histogram: null,
        density: null
      });
      continue;
    }

    const stats = computeStats({ values: numericValues });
    globalMin = Math.min(globalMin, stats.min);
    globalMax = Math.max(globalMax, stats.max);

    results.push({
      id: group.id,
      name: group.name,
      n: numericValues.length,
      stats,
      values: numericValues
    });
  }

  // Second pass: compute aligned histograms and densities
  const sharedRange = [globalMin, globalMax];
  const numBins = 30;

  for (const result of results) {
    if (result.n === 0) continue;

    result.histogram = computeHistogram({
      values: result.values,
      bins: numBins,
      range: sharedRange
    });

    result.density = computeDensity({
      values: result.values,
      points: 50
    });

    // Normalize if requested
    if (normalize && result.histogram) {
      let maxCount = 0;
      for (let i = 0; i < result.histogram.counts.length; i++) {
        const c = result.histogram.counts[i];
        if (c > maxCount) maxCount = c;
      }
      if (maxCount > 0) {
        result.histogram.normalizedCounts = result.histogram.counts.map(c => c / maxCount);
      }
    }

    // Clean up values to reduce memory
    delete result.values;
  }

  return {
    groups: results,
    range: sharedRange,
    bins: numBins
  };
}

// ============================================================================
// Unified Operation Router
// ============================================================================

/**
 * Execute an operation by type.
 * Central router for all compute operations.
 *
 * @param {string} operationType - Operation type from OperationType enum
 * @param {Object} payload - Operation-specific payload
 * @returns {*} Operation result
 * @throws {Error} If operation type is unknown
 */
export function executeOperation(operationType, payload) {
  switch (operationType) {
    // Transforms
    case OperationType.LOG1P:
      return log1pTransform(payload);
    case OperationType.ZSCORE:
      return zscoreNormalize(payload);
    case OperationType.MINMAX:
      return minmaxNormalize(payload);
    case OperationType.SCALE:
      return scaleTransform(payload);
    case OperationType.CLAMP:
      return clampTransform(payload);

    // Extraction
    case OperationType.EXTRACT_VALUES:
      return extractValues(payload);
    case OperationType.BATCH_EXTRACT:
      return batchExtract(payload);

    // Statistics
    case OperationType.COMPUTE_STATS:
      return computeStats(payload);
    case OperationType.COMPUTE_CORRELATION:
      return computeCorrelation(payload);
    case OperationType.COMPUTE_DIFFERENTIAL:
      return computeDifferential(payload);

    // Aggregation
    case OperationType.AGGREGATE_CATEGORIES:
      return aggregateCategories(payload);
    case OperationType.BIN_VALUES:
      return binValues(payload);

    // Filtering
    case OperationType.FILTER_CELLS:
      return filterCells(payload);

    // Distribution
    case OperationType.COMPUTE_DENSITY:
      return computeDensity(payload);
    case OperationType.COMPUTE_HISTOGRAM:
      return computeHistogram(payload);
    case OperationType.COMPARE_DISTRIBUTIONS:
      return compareDistributions(payload);

    default:
      throw new Error(`Unknown operation type: ${operationType}`);
  }
}

// ============================================================================
// Default Export
// ============================================================================

export default {
  // Transforms
  log1pTransform,
  zscoreNormalize,
  minmaxNormalize,
  scaleTransform,
  clampTransform,

  // Extraction
  extractValues,
  batchExtract,

  // Statistics
  computeStats,
  computeCorrelation,
  computeDifferential,

  // Aggregation
  aggregateCategories,
  binValues,

  // Filtering
  filterCells,

  // Distribution
  computeDensity,
  computeHistogram,
  compareDistributions,

  // Router
  executeOperation
};
