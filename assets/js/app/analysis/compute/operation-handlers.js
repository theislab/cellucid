/**
 * Shared Operation Handlers for Compute Module
 *
 * Contains the operation implementations used by:
 * - data-worker.js (Web Worker context)
 * - compute-manager.js (explicitly selected CPU context)
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
  tTwoSidedPValue,
  computeRanks,
  mannWhitneyU,
  welchTTest,
  filterNumeric,
  isValidNumber,
  log2FoldChangeOfMeans,
  pairedCentredMoments,
  pearsonCorrelation,
  pearsonFromCentredMoments,
  kernelDensityAt,
  selectSorted
} from './math-utils.js';
import { computeStats, finiteNumbers, finiteNumbersReport } from '../shared/number-utils.js';
import { runStatisticalTests } from '../stats/statistical-tests.js';
import { plotlyBoxSummary, plotlyViolinBox } from '../plots/plotly-box-statistics.js';
import { histogramSamples } from '../plots/plotly-histogram-bins.js';
import { densityCurveOrPlan } from '../plots/density-curve.js';
import {
  plotlyViolinDensitySlice,
  plotlyViolinPlan
} from '../plots/plotly-violin-density.js';

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

// ============================================================================
// Statistical Computation Operations
// ============================================================================

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

  // Centred two-pass moments over the finite pairs: one-pass sums cancel to a
  // negative variance for a constant non-dyadic variable (r = NaN) and lose
  // every digit under a large offset.
  const moments = pairedCentredMoments(xValues, yValues);
  const { n } = moments;

  if (n < 3) {
    return { r: NaN, pValue: NaN, n, method };
  }

  // Linear regression for trend line (y = slope*x + intercept). A constant X
  // has no defined slope; the flat line through mean(Y) is drawn instead.
  const slope = moments.sxx > 0 ? moments.sxy / moments.sxx : 0;
  const intercept = moments.meanY - slope * moments.meanX;

  let r;
  if (method === 'spearman') {
    // For Spearman we need ranks; avoid allocating per-pair objects.
    if (n === len) {
      // Fast path: all pairs valid, rank inputs directly.
      r = pearsonCorrelation(computeRanks(xValues), computeRanks(yValues));
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
      r = pearsonCorrelation(computeRanks(xValid), computeRanks(yValid));
    }
  } else {
    r = pearsonFromCentredMoments(moments);
  }
  if (!Number.isFinite(r)) {
    throw new RangeError('Correlation coefficient must be finite.');
  }

  // Two-sided p-value from the Student t distribution. |r| = 1 is a perfect
  // fit whose t is infinite and whose p-value is exactly 0.
  const rSquared = r * r;
  const denomT = 1 - rSquared;
  const pValue = denomT <= 0
    ? 0
    : tTwoSidedPValue(r * Math.sqrt((n - 2) / denomT), n - 2);

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

  let minimum = Infinity;
  for (let i = 0; i < valsA.length; i++) if (valsA[i] < minimum) minimum = valsA[i];
  for (let i = 0; i < valsB.length; i++) if (valsB[i] < minimum) minimum = valsB[i];
  const log2FoldChange = log2FoldChangeOfMeans(meanA, meanB, minimum);

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

/**
 * Evaluate a Gaussian kernel density at a slice of evaluation points.
 *
 * @param {Object} payload
 * @param {Float64Array} payload.support - Distinct values, or every value
 * @param {Float64Array} payload.weights - Multiplicity of each support value
 * @param {Float64Array} payload.xs - Evaluation points of this slice
 * @param {number} payload.bandwidth - Kernel bandwidth
 * @param {number} payload.count - Number of values the support stands for
 * @returns {{density: Float64Array}}
 */
export function computeKernelDensity(payload) {
  const { support, weights, xs, bandwidth, count } = payload;
  if (!(support instanceof Float64Array) && !(support instanceof Float32Array)) {
    throw new TypeError('Kernel density support must be a Float64Array or Float32Array');
  }
  if (weights !== null && !(weights instanceof Float64Array)) {
    throw new TypeError('Kernel density weights must be a Float64Array or null (unit weights)');
  }
  if (!(xs instanceof Float64Array)) {
    throw new TypeError('Kernel density xs must be a Float64Array');
  }
  if (weights !== null && weights.length !== support.length) {
    throw new RangeError('Kernel density weights must align with the support');
  }
  if (!(bandwidth > 0) || !Number.isFinite(bandwidth)) {
    throw new RangeError('Kernel density bandwidth must be a positive finite number');
  }
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new RangeError('Kernel density count must be a positive safe integer');
  }
  return { density: kernelDensityAt(support, weights, xs, bandwidth, count) };
}

/**
 * Box-plot statistics of a page's finite values and the points the box draws,
 * exactly as `plotlyBoxStatistics` and `plotlyBoxPoints` compute them (null
 * for a page with no finite value), with the finite values for the caller to
 * adopt.
 *
 * @param {Object} payload
 * @param {Float32Array|Float64Array} payload.values - A page's values
 * @param {'outliers'|'all'} payload.points - Which points the box draws
 * @returns {{summary: Object|null, finiteCount: number, finite: ArrayLike<number>|null}}
 */
export function computeBoxStatistics(payload) {
  const { values, points } = payload;
  if (!(values instanceof Float32Array) && !(values instanceof Float64Array)) {
    throw new TypeError('Box statistics values must be a Float32Array or Float64Array');
  }
  if (points !== 'outliers' && points !== 'all') {
    throw new RangeError('Box statistics points must be "outliers" or "all"');
  }
  const report = finiteNumbersReport(values);
  if (report.finiteCount === 0) return { summary: null, ...report };
  return { summary: plotlyBoxSummary(finiteNumbers(values), points), ...report };
}

/**
 * A slice of the kernel density grid a violin draws, with the bandwidth and
 * grid size Plotly computes for the values (see plotly-violin-density.js).
 *
 * @param {Object} payload
 * @param {Float32Array|Float64Array} payload.values - A page's values (non-finite ones are left out)
 * @param {number} payload.from - First grid point of the slice
 * @param {number} payload.to - One past the last grid point of the slice
 * @param {boolean} payload.includeSorted - Also return the values in Plotly's
 *   order and the calcdata entry Plotly's box calc builds from them
 *   (`plotlyViolinBox`)
 * @returns {{bandwidth: number, count: number, t: Float64Array, v: Float64Array, sorted?: Float64Array}}
 */
export function computeViolinDensity(payload) {
  const { values, from, to, includeSorted } = payload;
  if (!(values instanceof Float32Array) && !(values instanceof Float64Array)) {
    throw new TypeError('Violin density values must be a Float32Array or Float64Array');
  }
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) {
    throw new RangeError('Violin density slice bounds must be ordered non-negative integers');
  }
  if (typeof includeSorted !== 'boolean') {
    throw new TypeError('Violin density includeSorted must be exactly boolean');
  }
  const finite = finiteNumbers(values);
  if (finite.length === 0) {
    return { bandwidth: 0, count: 0, t: new Float64Array(0), v: new Float64Array(0), empty: true };
  }
  const plan = plotlyViolinPlan(finite);
  const { t, v } = plotlyViolinDensitySlice(plan, from, to);
  const result = { bandwidth: plan.bandwidth, count: plan.count, t, v };
  if (includeSorted) {
    Object.assign(
      result,
      { sorted: plan.sorted, box: plotlyViolinBox(plan.sorted, 'outliers') },
      finiteNumbersReport(values)
    );
  }
  return result;
}

function requireTypedValues(values, label) {
  if (!ArrayBuffer.isView(values) || values instanceof DataView) {
    throw new TypeError(`${label} values must be a typed array`);
  }
  return values;
}

/**
 * `computeStats` of one page's values (non-finite values excluded).
 *
 * @param {{values: ArrayLike<number>}} payload
 */
export function computeSummaryStatistics(payload) {
  return computeStats(requireTypedValues(payload.values, 'Summary statistics'));
}

/**
 * `runStatisticalTests` of continuous pages.
 *
 * @param {{pages: Array<{pageName: string, values: ArrayLike<number>}>, dataType: string}} payload
 * @returns {{results: Object[]}}
 */
export function computeStatisticalTests(payload) {
  const { pages, dataType } = payload;
  if (!Array.isArray(pages)) {
    throw new TypeError('Statistical tests need an array of pages');
  }
  for (const page of pages) requireTypedValues(page.values, 'Statistical test');
  return { results: runStatisticalTests(pages, dataType) };
}

/**
 * `selectSorted` of finite values: the values at given positions of their
 * ascending order.
 *
 * @param {{values: ArrayLike<number>, positions: number[]}} payload
 * @returns {{selected: number[]}}
 */
export function computeOrderStatistics(payload) {
  const values = requireTypedValues(payload.values, 'Order statistics');
  const { positions } = payload;
  if (!Array.isArray(positions) || positions.some(p => !Number.isSafeInteger(p) || p < 0 || p >= values.length)) {
    throw new RangeError('Order statistic positions must lie within the values');
  }
  return { selected: selectSorted(values, positions) };
}

/**
 * `histogramSamples` of a histogram's pages.
 *
 * @param {{pages: ArrayLike<number>[], nbins: number}} payload
 */
export function computeHistogramSamples(payload) {
  const { pages, nbins } = payload;
  if (!Array.isArray(pages)) throw new TypeError('Histogram samples need an array of pages');
  for (const values of pages) requireTypedValues(values, 'Histogram');
  if (!Number.isSafeInteger(nbins) || nbins <= 0) {
    throw new RangeError('Histogram bin count must be a positive integer');
  }
  return { ...histogramSamples(pages, nbins), finite: pages.map(finiteNumbersReport) };
}

/**
 * `densityCurveOrPlan` of one page.
 *
 * @param {{values: ArrayLike<number>, bandwidthMult: number, maxKernelTerms: number}} payload
 */
export function computeDensityPlan(payload) {
  const { values, bandwidthMult, maxKernelTerms } = payload;
  requireTypedValues(values, 'Density');
  if (!(bandwidthMult > 0) || !Number.isFinite(bandwidthMult)) {
    throw new RangeError('Density bandwidth multiplier must be a positive finite number');
  }
  if (!Number.isSafeInteger(maxKernelTerms) || maxKernelTerms <= 0) {
    throw new RangeError('Density kernel-term bound must be a positive integer');
  }
  return {
    ...densityCurveOrPlan(values, bandwidthMult, maxKernelTerms),
    ...finiteNumbersReport(values)
  };
}

// ============================================================================
// Unified Operation Router
// ============================================================================

/**
 * Execute an operation by type.
 *
 * @param {string} operationType - Operation type from OperationType enum
 * @param {Object} payload - Operation-specific payload
 * @returns {Object} Operation result
 * @throws {Error} If operation type is unknown
 */
export function executeOperation(operationType, payload) {
  switch (operationType) {
    case OperationType.COMPUTE_CORRELATION:
      return computeCorrelation(payload);
    case OperationType.COMPUTE_DIFFERENTIAL:
      return computeDifferential(payload);
    case OperationType.COMPUTE_KERNEL_DENSITY:
      return computeKernelDensity(payload);
    case OperationType.COMPUTE_BOX_STATISTICS:
      return computeBoxStatistics(payload);
    case OperationType.COMPUTE_VIOLIN_DENSITY:
      return computeViolinDensity(payload);
    case OperationType.COMPUTE_SUMMARY_STATISTICS:
      return computeSummaryStatistics(payload);
    case OperationType.COMPUTE_STATISTICAL_TESTS:
      return computeStatisticalTests(payload);
    case OperationType.COMPUTE_ORDER_STATISTICS:
      return computeOrderStatistics(payload);
    case OperationType.COMPUTE_HISTOGRAM_SAMPLES:
      return computeHistogramSamples(payload);
    case OperationType.COMPUTE_DENSITY_PLAN:
      return computeDensityPlan(payload);
    default:
      throw new Error(`Unknown operation type: ${operationType}`);
  }
}
