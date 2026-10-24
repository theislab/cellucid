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
  tTwoSidedPValue,
  computeRanks,
  isValidNumber,
  pairedCentredMoments,
  pearsonCorrelation,
  pearsonFromCentredMoments,
  kernelDensityAt,
  selectSorted
} from './math-utils.js';
import {
  createTwoGroupContext,
  geneSampleOf,
  splitTwoGroups,
  twoSampleDifferential
} from './gene-statistics.js';
import { computeStats, finiteNumbers, finiteNumbersReport } from '../shared/number-utils.js';
import { runStatisticalTests } from '../stats/statistical-tests.js';
import { plotlyBoxSummary, plotlyViolinBox } from '../plots/plotly-box-statistics.js';
import { histogramSamples } from '../plots/plotly-histogram-bins.js';
import { densityCurveOrPlan } from '../plots/density-curve.js';
import {
  agglomerate,
  dendrogramLeafOrder,
  pairwiseDistanceRows
} from './hierarchical-clustering.js';
import { markerStatisticsCSV, perCellCSVRows } from './csv-export.js';
import {
  plotlyViolinDensitySlice,
  plotlyViolinPlan
} from '../plots/plotly-violin-density.js';

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
 * Each group is its values (a numeric array) or the sample of its non-zero
 * entries `{length, indices, values}` (see compute/gene-statistics.js); both
 * give the same numbers. Non-finite values are missing and left out.
 *
 * @param {Object} payload
 * @param {ArrayLike<number>|import('./gene-statistics.js').GeneSample} payload.groupAValues
 * @param {ArrayLike<number>|import('./gene-statistics.js').GeneSample} payload.groupBValues
 * @param {string} [payload.method='wilcox'] - 'wilcox' (Mann-Whitney U) or 'ttest' (Welch's t-test)
 * @returns {Object} Differential expression result
 */
export function computeDifferential(payload) {
  const { groupAValues, groupBValues, method = 'wilcox' } = payload;
  return twoSampleDifferential(
    geneSampleOf(groupAValues, 0),
    geneSampleOf(groupBValues, 1),
    method,
    differentialOptions(payload)
  );
}

/** The test conventions a differential payload names (defaults as `twoSampleDifferential`). */
function differentialOptions(payload) {
  const options = {};
  if (payload.pConvention !== undefined) options.pConvention = payload.pConvention;
  if (payload.foldChange !== undefined) options.foldChange = payload.foldChange;
  return options;
}

/**
 * The two groups of differential expression runs read by gene column, held
 * here by run so a gene is sent as its column alone: no thread gathers the
 * groups' values out of it, and the groups cross to this thread once per run.
 *
 * @type {Map<string, ReturnType<typeof createTwoGroupContext>>}
 */
const twoGroupContexts = new Map();

function requireContextId(contextId) {
  if (typeof contextId !== 'string' || contextId.length === 0) {
    throw new TypeError('Two-group context id must be a non-empty string');
  }
  return contextId;
}

/**
 * Hold the two groups of one run.
 *
 * @param {{contextId: string, groupOfCell: Uint8Array}} payload - 1 for a cell
 *   of group A, 2 for group B, 0 for neither
 * @returns {{sizeA: number, sizeB: number}}
 */
export function setTwoGroupContext(payload) {
  const contextId = requireContextId(payload.contextId);
  if (twoGroupContexts.has(contextId)) {
    throw new Error(`Two-group context "${contextId}" is already held`);
  }
  const context = createTwoGroupContext(payload.groupOfCell);
  twoGroupContexts.set(contextId, context);
  return { sizeA: context.sizeA, sizeB: context.sizeB };
}

/**
 * Differential expression of one gene column between the held groups: the
 * numbers `computeDifferential` gives for the two groups' values in ascending
 * cell order.
 *
 * @param {{contextId: string, values: Float32Array|import('./gene-statistics.js').GeneSample, method: string, pConvention?: string, foldChange?: object}} payload
 */
export function computeDifferentialOfColumn(payload) {
  const contextId = requireContextId(payload.contextId);
  const context = twoGroupContexts.get(contextId);
  if (context === undefined) {
    throw new Error(`Two-group context "${contextId}" is not held`);
  }
  const { sampleA, sampleB } = splitTwoGroups(payload.values, context);
  return twoSampleDifferential(sampleA, sampleB, payload.method, differentialOptions(payload));
}

/**
 * Differential expression of a run of genes read in the cells of two groups
 * (`StreamingGeneLoader.readCellSubset`): each gene's non-zero entries over
 * the union of the groups' cells, ascending, and each union position's group.
 * Each gene gives the numbers `computeDifferential` gives for its two groups'
 * values in ascending cell order; a worker takes a whole run of genes in one
 * message.
 *
 * @param {{groupOfPosition: Uint8Array, pointers: Float64Array, positions: Uint32Array, values: Float32Array, method: string, pConvention?: string, foldChange?: object}} payload
 *   `pointers` (one more than the genes, from 0) delimit each gene's entries
 *   in `positions` (into the union) and `values`
 * @returns {{meanA: Float64Array, meanB: Float64Array, pctA: Float64Array, pctB: Float64Array, log2FoldChange: Float64Array, pValue: Float64Array, statistic: Float64Array, score: Float64Array, auroc: Float64Array, nA: Uint32Array, nB: Uint32Array, method: string}}
 */
export function computeDifferentialOfSubset(payload) {
  const { groupOfPosition, pointers, positions, values, method } = payload;
  if (!(pointers instanceof Float64Array) || pointers.length < 1 || pointers[0] !== 0) {
    throw new TypeError('Subset pointers must be a Float64Array starting at 0');
  }
  if (!(positions instanceof Uint32Array) || !(values instanceof Float32Array) ||
      positions.length !== values.length || pointers[pointers.length - 1] !== values.length) {
    throw new TypeError('Subset entries must be matching Uint32Array positions and Float32Array values');
  }
  const context = createTwoGroupContext(groupOfPosition);
  const genes = pointers.length - 1;
  const options = differentialOptions(payload);
  const out = {
    meanA: new Float64Array(genes),
    meanB: new Float64Array(genes),
    pctA: new Float64Array(genes),
    pctB: new Float64Array(genes),
    log2FoldChange: new Float64Array(genes),
    pValue: new Float64Array(genes),
    statistic: new Float64Array(genes),
    score: new Float64Array(genes),
    auroc: new Float64Array(genes),
    nA: new Uint32Array(genes),
    nB: new Uint32Array(genes),
    method
  };
  for (let gene = 0; gene < genes; gene++) {
    const from = pointers[gene];
    const to = pointers[gene + 1];
    const { sampleA, sampleB } = splitTwoGroups({
      length: context.length,
      indices: positions.subarray(from, to),
      values: values.subarray(from, to)
    }, context);
    const result = twoSampleDifferential(sampleA, sampleB, method, options);
    out.meanA[gene] = result.meanA;
    out.meanB[gene] = result.meanB;
    out.pctA[gene] = result.pctA;
    out.pctB[gene] = result.pctB;
    out.log2FoldChange[gene] = result.log2FoldChange;
    out.pValue[gene] = result.pValue;
    out.statistic[gene] = result.statistic;
    out.score[gene] = result.score;
    out.auroc[gene] = result.auroc;
    out.nA[gene] = result.nA;
    out.nB[gene] = result.nB;
  }
  return out;
}

/**
 * Release the groups of a run.
 *
 * @param {{contextId: string}} payload
 * @returns {{released: boolean}}
 */
export function clearTwoGroupContext(payload) {
  return { released: twoGroupContexts.delete(requireContextId(payload.contextId)) };
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

/**
 * One block of rows of a clustering's condensed distance matrix
 * (compute/hierarchical-clustering.js).
 *
 * @param {{values: ArrayLike<number>, nItems: number, nFeatures: number, metric: string, rowFrom: number, rowTo: number}} payload
 * @returns {{distances: Float64Array}}
 */
export function computePairwiseDistances(payload) {
  const { values, nItems, nFeatures, metric, rowFrom, rowTo } = payload;
  return { distances: pairwiseDistanceRows(values, nItems, nFeatures, metric, rowFrom, rowTo) };
}

/**
 * The merges and leaf order of a clustering from its condensed distance
 * blocks (compute/hierarchical-clustering.js).
 *
 * @param {{blocks: Float64Array[], ranges: Array<[number, number]>, nItems: number, linkage: string}} payload
 * @returns {{left: Int32Array, right: Int32Array, height: Float64Array, order: Int32Array}}
 */
export function computeAgglomeration(payload) {
  const { blocks, ranges, nItems, linkage } = payload;
  const { left, right, height } = agglomerate(blocks, ranges, nItems, linkage);
  return { left, right, height, order: dendrogramLeafOrder(left, right, nItems) };
}

/**
 * The data lines of a per-cell CSV for a range of rows
 * (compute/csv-export.js `perCellCSVRows`).
 *
 * @param {{layout: 'page-data'|'signature-scores', pages: Object[]}|{layout: 'marker-statistics', markers: Object}} payload
 * @returns {{rows: Blob}}
 */
export function computeCsvExport(payload) {
  const { layout, pages } = payload;
  if (layout === 'marker-statistics') return { rows: markerStatisticsCSV(payload.markers) };
  return { rows: perCellCSVRows(layout, pages) };
}

/**
 * One gene column's moments over every cell (`shared/gene-moments-cache.js`):
 * the sum and the sum of squares of its finite values, its non-zero finite
 * values and its finite values (`n`).
 *
 * @param {{values: Float32Array|import('./gene-statistics.js').GeneSample}} payload
 * @returns {{sum: number, sumSq: number, nonZero: number, n: number}}
 */
export function computeGeneMoments(payload) {
  const sample = geneSampleOf(payload.values, 0);
  let sum = 0;
  let sumSq = 0;
  let nonZero = 0;
  let nonFinite = 0;
  const { values } = sample;
  for (let k = 0; k < values.length; k++) {
    const value = values[k];
    if (!Number.isFinite(value)) {
      nonFinite++;
      continue;
    }
    if (value === 0) continue;
    nonZero++;
    sum += value;
    sumSq += value * value;
  }
  return { sum, sumSq, nonZero, n: sample.length - nonFinite };
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
    case OperationType.SET_TWO_GROUP_CONTEXT:
      return setTwoGroupContext(payload);
    case OperationType.COMPUTE_DIFFERENTIAL_OF_COLUMN:
      return computeDifferentialOfColumn(payload);
    case OperationType.CLEAR_TWO_GROUP_CONTEXT:
      return clearTwoGroupContext(payload);
    case OperationType.COMPUTE_DIFFERENTIAL_OF_SUBSET:
      return computeDifferentialOfSubset(payload);
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
    case OperationType.COMPUTE_PAIRWISE_DISTANCES:
      return computePairwiseDistances(payload);
    case OperationType.COMPUTE_AGGLOMERATION:
      return computeAgglomeration(payload);
    case OperationType.COMPUTE_CSV_EXPORT:
      return computeCsvExport(payload);
    case OperationType.COMPUTE_GENE_MOMENTS:
      return computeGeneMoments(payload);
    // --- composition and dot plot ---
    case OperationType.COMPOSITION_COUNTS:
      return compositionCounts(payload);
    case OperationType.GROUP_SUMMARY_SET_CONTEXT:
      return setGroupSummaryContext(payload);
    case OperationType.GROUP_SUMMARY_COMPUTE_GENES:
      return computeGroupSummaryOfGenes(payload);
    case OperationType.GROUP_SUMMARY_CLEAR_CONTEXT:
      return clearGroupSummaryContext(payload);
    default:
      throw new Error(`Unknown operation type: ${operationType}`);
  }
}

// --- composition and dot plot ---
// Cell counts per type and unit (compute/composition-counts.js), and the
// per-group expression summaries of a dot plot
// (compute/group-expression-summary.js). A dot plot's groups are held per
// run, keyed by its id, so its genes cross with no per-cell payload; a
// worker pool re-sends them to a replaced worker (`retainAs`).

import { compositionCounts } from './composition-counts.js';
import {
  createGroupSummaryContext,
  summarizeGenesByGroup
} from './group-expression-summary.js';

/** @type {Map<string, ReturnType<typeof createGroupSummaryContext>>} */
const groupSummaryContexts = new Map();

function requireGroupSummaryId(contextId) {
  if (typeof contextId !== 'string' || contextId.length === 0) {
    throw new TypeError('Group summary context id must be a non-empty string');
  }
  return contextId;
}

/**
 * Hold the groups of one dot plot run. Setting an id again replaces it (a
 * replaced worker is sent its retained state).
 *
 * @param {{contextId: string, cellGroup: Int16Array|Int32Array, groupCount: number}} payload
 * @returns {{groups: number, cells: number}}
 */
export function setGroupSummaryContext(payload) {
  const contextId = requireGroupSummaryId(payload?.contextId);
  const context = createGroupSummaryContext(payload.cellGroup, payload.groupCount);
  groupSummaryContexts.set(contextId, context);
  return { groups: context.groupCount, cells: context.cellGroup.length };
}

/**
 * Summarise a run of genes over the held groups.
 *
 * @param {{contextId: string, genes: Array<Float32Array|{length: number, indices: Uint32Array, values: Float32Array}>, cutoff: number, bins: number}} payload
 */
export function computeGroupSummaryOfGenes(payload) {
  const contextId = requireGroupSummaryId(payload?.contextId);
  const context = groupSummaryContexts.get(contextId);
  if (context === undefined) throw new Error(`Group summary context "${contextId}" is not held`);
  return summarizeGenesByGroup(context, payload.genes, payload.cutoff, payload.bins);
}

/**
 * Release the groups of a run.
 *
 * @param {{contextId: string}} payload
 * @returns {{released: boolean}}
 */
export function clearGroupSummaryContext(payload) {
  return { released: groupSummaryContexts.delete(requireGroupSummaryId(payload?.contextId)) };
}
