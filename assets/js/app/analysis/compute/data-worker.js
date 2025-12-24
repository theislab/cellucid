/**
 * Data Processing Web Worker
 *
 * Handles computationally intensive data operations off the main thread:
 * - Value extraction from large cell arrays
 * - Statistical computations
 * - Correlation analysis
 * - Data aggregation
 *
 * This prevents UI blocking when processing large single-cell datasets (100K+ cells)
 *
 * Worker Pool Support:
 * When used with WorkerPool, the worker receives an INIT message with its ID.
 * This enables coordinated parallel processing across multiple workers.
 *
 * REFACTORED: Now uses shared operation-handlers.js for all implementations.
 * This eliminates code duplication with fallback-operations.js.
 */

/* eslint-env worker */

// Import shared operation handlers and math utilities
// These are ES modules that work in both main thread and worker context
import { executeOperation } from './operation-handlers.js';
import { OperationType } from './operations.js';
import { normalCDF, tCDF } from './math-utils.js';

// ============================================================================
// Worker Pool State
// ============================================================================

let workerId = null;
let poolSize = 1;

// ============================================================================
// Marker Genes Panel (Genes Panel) Worker State
// ============================================================================

/**
 * Marker computation context stored per worker.
 * This avoids re-sending large per-cell categorical codes for every gene.
 *
 * @type {{
 *   groupCount: number,
 *   cellGroupIndex: Int16Array|null,
 *   orderScratch: Uint32Array|null
 * }|null}
 */
let markerContext = null;

function setMarkerContext(payload) {
  const { codes, codeToGroupIndex, groupCount, histBins } = payload || {};

  if (!codes || !codeToGroupIndex || !Number.isFinite(groupCount) || groupCount <= 0) {
    throw new Error('MARKERS_SET_CONTEXT: invalid payload');
  }

  // Build per-cell group index lookup (-1 for invalid/missing).
  const nCells = codes.length;
  const cellGroupIndex = new Int16Array(nCells);
  cellGroupIndex.fill(-1);

  const mapLen = codeToGroupIndex.length;
  for (let i = 0; i < nCells; i++) {
    const code = codes[i];
    if (code >= 0 && code < mapLen) {
      const gi = codeToGroupIndex[code];
      cellGroupIndex[i] = gi;
    }
  }

  const bins = Number.isFinite(histBins)
    ? Math.max(16, Math.min(1024, Math.floor(histBins)))
    : 128;

  markerContext = {
    groupCount,
    cellGroupIndex,
    orderScratch: new Uint32Array(nCells),
    histBins: bins,
    histTotal: new Uint32Array(bins),
    histByGroup: new Uint32Array(groupCount * bins)
  };

  return { ok: true, cells: nCells, groups: groupCount };
}

function welchTTestFromMoments(meanA, varA, nA, meanB, varB, nB) {
  if (nA < 2 || nB < 2) return { statistic: NaN, pValue: NaN, df: NaN };
  if (!Number.isFinite(meanA) || !Number.isFinite(meanB)) return { statistic: NaN, pValue: NaN, df: NaN };
  if (!Number.isFinite(varA) || !Number.isFinite(varB)) return { statistic: NaN, pValue: NaN, df: NaN };

  const se = Math.sqrt(varA / nA + varB / nB);
  if (se === 0) return { statistic: 0, pValue: 1, df: nA + nB - 2 };

  const t = (meanA - meanB) / se;
  const num = Math.pow(varA / nA + varB / nB, 2);
  const denom = Math.pow(varA / nA, 2) / (nA - 1) + Math.pow(varB / nB, 2) / (nB - 1);
  const df = denom > 0 ? (num / denom) : (nA + nB - 2);

  const pValue = 2 * (1 - tCDF(Math.abs(t), df));
  return { statistic: t, pValue, df };
}

function computeGeneMarkers(payload) {
  if (!markerContext?.cellGroupIndex) {
    throw new Error('MARKERS_COMPUTE_GENE: marker context not set');
  }

  const {
    values,
    method = 'wilcox',
    minCells = 10,
    pseudocount = 0.01
  } = payload || {};

  if (!values || !Number.isFinite(values.length)) {
    throw new Error('MARKERS_COMPUTE_GENE: invalid values');
  }

  const groupCount = markerContext.groupCount;
  const cellGroupIndex = markerContext.cellGroupIndex;

  const useExactWilcox = method === 'wilcox' && cellGroupIndex.length <= 5000;
  const useApproxWilcox = method === 'wilcox' && !useExactWilcox;

  // Per-group accumulators
  const nIn = new Uint32Array(groupCount);
  const sumIn = new Float64Array(groupCount);
  const sumSqIn = new Float64Array(groupCount);
  const exprIn = new Uint32Array(groupCount);

  // Totals over valid (non-missing category) cells
  let nAll = 0;
  let sumAll = 0;
  let sumSqAll = 0;
  let exprAll = 0;

  // Wilcoxon:
  // - exact: sort valid indices (small datasets only)
  // - approx: histogram-based U statistic (large datasets)
  const orderScratch = useExactWilcox ? markerContext.orderScratch : null;
  let validCount = 0;

  const histBins = useApproxWilcox ? markerContext.histBins : 0;
  const histTotal = useApproxWilcox ? markerContext.histTotal : null;
  const histByGroup = useApproxWilcox ? markerContext.histByGroup : null;
  if (useApproxWilcox && histTotal && histByGroup) {
    histTotal.fill(0);
    histByGroup.fill(0);
  }

  const len = Math.min(values.length, cellGroupIndex.length);
  for (let i = 0; i < len; i++) {
    const gi = cellGroupIndex[i];
    if (gi < 0) continue;

    const v = values[i];
    if (!Number.isFinite(v)) continue;

    nAll++;
    sumAll += v;
    sumSqAll += v * v;
    if (v > 0) exprAll++;

    nIn[gi]++;
    sumIn[gi] += v;
    sumSqIn[gi] += v * v;
    if (v > 0) exprIn[gi]++;

    if (useExactWilcox && orderScratch) {
      orderScratch[validCount++] = i;
    }

    if (useApproxWilcox && histTotal && histByGroup) {
      const vv = v > 0 ? v : 0;
      const lv = Math.log1p(vv);
      const MAX_LOG = 6; // log1p scale cap for binning
      const scaled = lv >= MAX_LOG ? 1 : (lv / MAX_LOG);
      const bin = Math.min(histBins - 1, Math.max(0, Math.floor(scaled * (histBins - 1))));

      histTotal[bin]++;
      histByGroup[gi * histBins + bin]++;
    }
  }

  // Output arrays per group (same order as groups)
  const pValues = new Float32Array(groupCount);
  const statistics = new Float32Array(groupCount);
  const log2FoldChange = new Float32Array(groupCount);
  const meanInGroup = new Float32Array(groupCount);
  const meanOutGroup = new Float32Array(groupCount);
  const percentInGroup = new Float32Array(groupCount);
  const percentOutGroup = new Float32Array(groupCount);
  const nOut = new Uint32Array(groupCount);

  pValues.fill(NaN);
  statistics.fill(NaN);
  log2FoldChange.fill(NaN);
  meanInGroup.fill(NaN);
  meanOutGroup.fill(NaN);
  percentInGroup.fill(0);
  percentOutGroup.fill(0);

  if (nAll < 2) {
    return {
      nAll,
      pValues,
      statistics,
      log2FoldChange,
      meanInGroup,
      meanOutGroup,
      percentInGroup,
      percentOutGroup,
      nIn,
      nOut
    };
  }

  // Means and percent-expressing for each group vs rest
  for (let g = 0; g < groupCount; g++) {
    const nA = nIn[g];
    if (nA === 0) continue;

    const nB = nAll - nA;
    nOut[g] = nB;

    const meanA = nA > 0 ? (sumIn[g] / nA) : NaN;
    const sumB = sumAll - sumIn[g];
    const meanB = nB > 0 ? (sumB / nB) : NaN;

    meanInGroup[g] = Number.isFinite(meanA) ? meanA : NaN;
    meanOutGroup[g] = Number.isFinite(meanB) ? meanB : NaN;

    log2FoldChange[g] = (Number.isFinite(meanA) && Number.isFinite(meanB))
      ? Math.log2((meanA + pseudocount) / (meanB + pseudocount))
      : NaN;

    percentInGroup[g] = nA > 0 ? (exprIn[g] / nA) * 100 : 0;
    const exprB = exprAll - exprIn[g];
    percentOutGroup[g] = nB > 0 ? (exprB / nB) * 100 : 0;
  }

  // p-values/statistics
  if (method === 'ttest') {
    for (let g = 0; g < groupCount; g++) {
      const nA = nIn[g];
      const nB = nAll - nA;
      if (nA < Math.max(2, minCells) || nB < Math.max(2, minCells)) continue;

      const meanA = sumIn[g] / nA;
      const meanB = (sumAll - sumIn[g]) / nB;

      const varA = nA > 1 ? (sumSqIn[g] - (sumIn[g] * sumIn[g]) / nA) / (nA - 1) : NaN;
      const sumSqB = sumSqAll - sumSqIn[g];
      const sumB = sumAll - sumIn[g];
      const varB = nB > 1 ? (sumSqB - (sumB * sumB) / nB) / (nB - 1) : NaN;

      const test = welchTTestFromMoments(meanA, varA, nA, meanB, varB, nB);
      pValues[g] = Number.isFinite(test.pValue) ? test.pValue : NaN;
      statistics[g] = Number.isFinite(test.statistic) ? test.statistic : NaN;
    }

    return {
      nAll,
      pValues,
      statistics,
      log2FoldChange,
      meanInGroup,
      meanOutGroup,
      percentInGroup,
      percentOutGroup,
      nIn,
      nOut
    };
  }

  // Wilcoxon (Mann-Whitney U) with a single rank pass for all groups.
  // Uses the same normal-approximation strategy as math-utils.mannWhitneyU().
  // For large datasets we use an approximate histogram-based U to avoid per-gene sorting.
  const rankSum = useExactWilcox ? new Float64Array(groupCount) : null;
  if (rankSum) rankSum.fill(0);

  if (useExactWilcox) {
    const order = markerContext.orderScratch.subarray(0, validCount);
    order.sort((a, b) => values[a] - values[b]);

    let i = 0;
    while (i < validCount) {
      let j = i + 1;
      const v = values[order[i]];
      while (j < validCount && values[order[j]] === v) j++;

      const avgRank = (i + j + 1) / 2; // 1-based
      for (let k = i; k < j; k++) {
        const idx = order[k];
        const gi = cellGroupIndex[idx];
        if (gi >= 0) rankSum[gi] += avgRank;
      }

      i = j;
    }
  }

  for (let g = 0; g < groupCount; g++) {
    const nA = nIn[g];
    const nB = nAll - nA;
    if (nA < Math.max(2, minCells) || nB < Math.max(2, minCells)) continue;

    let U;

    if (useExactWilcox) {
      const R1 = rankSum[g];
      const U1 = R1 - (nA * (nA + 1)) / 2;
      const U2 = nA * nB - U1;
      U = Math.min(U1, U2);
    } else {
      // Approximate U using histogram bins (counts of pairwise comparisons).
      // U1 = sum_{bin} countA(bin) * (countB(bins<bin) + 0.5*countB(bin))
      const bins = markerContext.histBins;
      const total = markerContext.histTotal;
      const byGroup = markerContext.histByGroup;

      let cumTotalBelow = 0;
      let cumGroupBelow = 0;
      let U1 = 0;

      const base = g * bins;
      for (let b = 0; b < bins; b++) {
        const aAt = byGroup[base + b];
        const totAt = total[b];
        const bAt = totAt - aAt; // rest-of at this bin

        const bBelow = cumTotalBelow - cumGroupBelow;
        U1 += aAt * (bBelow + 0.5 * bAt);

        cumTotalBelow += totAt;
        cumGroupBelow += aAt;
      }

      const U2 = nA * nB - U1;
      U = Math.min(U1, U2);
    }

    const mu = (nA * nB) / 2;
    const sigma = Math.sqrt((nA * nB * (nA + nB + 1)) / 12);
    const z = sigma > 0 ? (U - mu) / sigma : 0;
    const p = 2 * (1 - normalCDF(Math.abs(z)));

    statistics[g] = Number.isFinite(U) ? U : NaN;
    pValues[g] = Number.isFinite(p) ? p : NaN;
  }

  return {
    nAll,
    pValues,
    statistics,
    log2FoldChange,
    meanInGroup,
    meanOutGroup,
    percentInGroup,
    percentOutGroup,
    nIn,
    nOut
  };
}

// ============================================================================
// Message Handler
// ============================================================================

self.onmessage = function(e) {
  const { type, payload, requestId } = e.data;

  // Handle INIT message from worker pool
  if (type === 'INIT') {
    workerId = payload.id;
    poolSize = payload.poolSize || 1;
    self.postMessage({ type: 'INIT_ACK', workerId });
    return;
  }

  // Handle GET_WORKER_INFO special case
  if (type === 'GET_WORKER_INFO') {
    self.postMessage({
      requestId,
      success: true,
      result: { workerId, poolSize }
    });
    return;
  }

  try {
    // Genes Panel (marker genes) specialized operations (stateful per worker)
    if (type === 'MARKERS_SET_CONTEXT') {
      const result = setMarkerContext(payload);
      self.postMessage({ requestId, success: true, result });
      return;
    }

    if (type === 'MARKERS_COMPUTE_GENE') {
      const result = computeGeneMarkers(payload);
      self.postMessage({ requestId, success: true, result });
      return;
    }

    // Use the shared operation handler
    const result = executeOperation(type, payload);

    self.postMessage({ requestId, success: true, result });

  } catch (error) {
    self.postMessage({
      requestId,
      success: false,
      error: error.message
    });
  }
};

// ============================================================================
// Error Handler
// ============================================================================

self.onerror = function(error) {
  console.error('[DataWorker] Unhandled error:', error);
};

// ============================================================================
// Export for testing (optional)
// ============================================================================

// Make OperationType available for direct worker testing
export { OperationType };
