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
 * Uses operation-handlers.js so worker and explicitly selected CPU execution
 * share one scientific implementation.
 */

/* eslint-env worker */

// Import shared operation handlers and math utilities
// These are ES modules that work in both main thread and worker context
import { executeOperation } from './operation-handlers.js';
import { OperationType } from './operations.js';
import { mannWhitneyPValue, welchTTestFromMoments } from './math-utils.js';

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
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    throw new TypeError('MARKERS_SET_CONTEXT: payload must be an object');
  }
  const { codes, codeToGroupIndex, groupCount } = payload;

  if (!(codes instanceof Uint16Array) || codes.length === 0) {
    throw new TypeError(
      'MARKERS_SET_CONTEXT: codes must be a non-empty Uint16Array'
    );
  }
  if (
    !(codeToGroupIndex instanceof Int16Array) ||
    codeToGroupIndex.length === 0
  ) {
    throw new TypeError(
      'MARKERS_SET_CONTEXT: codeToGroupIndex must be a non-empty Int16Array'
    );
  }
  if (!Number.isSafeInteger(groupCount) || groupCount <= 0) {
    throw new RangeError(
      'MARKERS_SET_CONTEXT: groupCount must be a positive integer'
    );
  }
  for (let i = 0; i < codeToGroupIndex.length; i++) {
    const groupIndex = codeToGroupIndex[i];
    if (groupIndex < -1 || groupIndex >= groupCount) {
      throw new RangeError(
        `MARKERS_SET_CONTEXT: code ${i} maps outside groupCount`
      );
    }
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

  markerContext = {
    groupCount,
    cellGroupIndex,
    orderScratch: new Uint32Array(nCells)
  };

  return { ok: true, cells: nCells, groups: groupCount };
}

function computeGeneMarkers(payload) {
  if (!markerContext?.cellGroupIndex) {
    throw new Error('MARKERS_COMPUTE_GENE: marker context not set');
  }

  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    throw new TypeError('MARKERS_COMPUTE_GENE: payload must be an object');
  }
  const {
    values,
    method,
    minCells,
    pseudocount = 0.01
  } = payload;

  if (!(values instanceof Float32Array)) {
    throw new TypeError(
      'MARKERS_COMPUTE_GENE: values must be a Float32Array'
    );
  }
  if (values.length !== markerContext.cellGroupIndex.length) {
    throw new RangeError(
      'MARKERS_COMPUTE_GENE: values length must exactly match marker context'
    );
  }
  if (method !== 'wilcox' && method !== 'ttest') {
    throw new RangeError(
      'MARKERS_COMPUTE_GENE: method must be wilcox or ttest'
    );
  }
  if (!Number.isSafeInteger(minCells) || minCells <= 0) {
    throw new RangeError(
      'MARKERS_COMPUTE_GENE: minCells must be a positive integer'
    );
  }
  if (!Number.isFinite(pseudocount) || pseudocount <= 0) {
    throw new RangeError(
      'MARKERS_COMPUTE_GENE: pseudocount must be a positive finite number'
    );
  }

  const groupCount = markerContext.groupCount;
  const cellGroupIndex = markerContext.cellGroupIndex;

  // Per-group accumulators
  const nIn = new Uint32Array(groupCount);
  const runningMeanIn = new Float64Array(groupCount);
  const runningM2In = new Float64Array(groupCount);
  const exprIn = new Uint32Array(groupCount);

  // Totals over valid (non-missing category) cells
  let nAll = 0;
  let runningMeanAll = 0;
  let runningM2All = 0;
  let exprAll = 0;

  // Wilcoxon owns one exact rank representation. Quantized data normally has
  // low value cardinality, so exact per-value counts avoid a full cell sort.
  // High-cardinality inputs use the same exact ranks through index sorting.
  const orderScratch = method === 'wilcox'
    ? markerContext.orderScratch
    : null;
  const MAX_EXACT_COUNTED_VALUES = 4096;
  let countsByValue = method === 'wilcox' ? new Map() : null;
  let validCount = 0;

  for (let i = 0; i < values.length; i++) {
    const gi = cellGroupIndex[i];
    if (gi < 0) continue;

    const v = values[i];
    if (!Number.isFinite(v)) continue;

    nAll++;
    const totalDelta = v - runningMeanAll;
    runningMeanAll += totalDelta / nAll;
    runningM2All += totalDelta * (v - runningMeanAll);
    if (v > 0) exprAll++;

    nIn[gi]++;
    const groupDelta = v - runningMeanIn[gi];
    runningMeanIn[gi] += groupDelta / nIn[gi];
    runningM2In[gi] += groupDelta * (v - runningMeanIn[gi]);
    if (v > 0) exprIn[gi]++;

    if (orderScratch) {
      orderScratch[validCount++] = i;
      if (countsByValue !== null) {
        let entry = countsByValue.get(v);
        if (entry === undefined) {
          if (countsByValue.size >= MAX_EXACT_COUNTED_VALUES) {
            countsByValue = null;
          } else {
            entry = {
              total: 0,
              byGroup: new Uint32Array(groupCount)
            };
            countsByValue.set(v, entry);
          }
        }
        if (entry !== undefined) {
          entry.total++;
          entry.byGroup[gi]++;
        }
      }
    }
  }

  // Output arrays per group (same order as groups).
  //
  // The test statistic itself is deliberately not among them. Marker discovery
  // reports probabilities, fold changes and expression fractions; nothing on the
  // way to the panel, the heatmap, the volcano or the cache ever read a U or a
  // t. Carrying one only invited a silent precision loss: Mann-Whitney U reaches
  // n1*n2, which is 20,250,000 for two sides of 4,500 cells, and every odd
  // integer above 2^24 is unrepresentable in Float32.
  const pValues = new Float64Array(groupCount);
  const log2FoldChange = new Float32Array(groupCount);
  const meanInGroup = new Float32Array(groupCount);
  const meanOutGroup = new Float32Array(groupCount);
  const percentInGroup = new Float32Array(groupCount);
  const percentOutGroup = new Float32Array(groupCount);
  const nOut = new Uint32Array(groupCount);

  pValues.fill(NaN);
  log2FoldChange.fill(NaN);
  meanInGroup.fill(NaN);
  meanOutGroup.fill(NaN);
  percentInGroup.fill(0);
  percentOutGroup.fill(0);

  // `nIn[g] + nOut[g] === nAll` is an identity over the cells that carry a
  // measured value for this gene, and it holds whether or not the group can be
  // tested. It is established for every group before any early return, so a gene
  // that no group could be tested on still describes how the sample was split.
  for (let g = 0; g < groupCount; g++) {
    nOut[g] = nAll - nIn[g];
  }

  if (nAll < 2) {
    return {
      nAll,
      pValues,
      log2FoldChange,
      meanInGroup,
      meanOutGroup,
      percentInGroup,
      percentOutGroup,
      nIn,
      nOut
    };
  }

  // Means and percent-expressing for each group vs rest. A group with no
  // measured cell for this gene has no mean and no fold change; those stay NaN.
  for (let g = 0; g < groupCount; g++) {
    const nA = nIn[g];
    if (nA === 0) continue;

    const nB = nOut[g];
    const meanA = nA > 0 ? runningMeanIn[g] : NaN;
    const meanB = nB > 0
      ? (runningMeanAll * nAll - meanA * nA) / nB
      : NaN;

    meanInGroup[g] = Number.isFinite(meanA) ? meanA : NaN;
    meanOutGroup[g] = Number.isFinite(meanB) ? meanB : NaN;

    log2FoldChange[g] = (Number.isFinite(meanA) && Number.isFinite(meanB))
      ? Math.log2((meanA + pseudocount) / (meanB + pseudocount))
      : NaN;

    percentInGroup[g] = nA > 0 ? (exprIn[g] / nA) * 100 : 0;
    const exprB = exprAll - exprIn[g];
    percentOutGroup[g] = nB > 0 ? (exprB / nB) * 100 : 0;
  }

  // p-values
  if (method === 'ttest') {
    for (let g = 0; g < groupCount; g++) {
      const nA = nIn[g];
      const nB = nAll - nA;
      if (nA < Math.max(2, minCells) || nB < Math.max(2, minCells)) continue;

      const meanA = runningMeanIn[g];
      const meanB = (runningMeanAll * nAll - meanA * nA) / nB;
      const meanDifference = meanA - meanB;
      const betweenM2 = meanDifference ** 2 * nA * nB / nAll;
      let restM2 = runningM2All - runningM2In[g] - betweenM2;
      const m2Scale = Math.max(
        1,
        Math.abs(runningM2All),
        Math.abs(runningM2In[g]),
        Math.abs(betweenM2)
      );
      if (restM2 < 0 && restM2 >= -32 * Number.EPSILON * m2Scale) {
        restM2 = 0;
      }

      const varA = runningM2In[g] / (nA - 1);
      const varB = restM2 / (nB - 1);

      const test = welchTTestFromMoments(meanA, varA, nA, meanB, varB, nB);
      pValues[g] = Number.isFinite(test.pValue) ? test.pValue : NaN;
    }

    return {
      nAll,
      pValues,
      log2FoldChange,
      meanInGroup,
      meanOutGroup,
      percentInGroup,
      percentOutGroup,
      nIn,
      nOut
    };
  }

  // Wilcoxon (Mann-Whitney U) with one exact rank pass for all groups.
  const rankSum = new Float64Array(groupCount);
  let wilcoxTieTerm = 0;

  if (countsByValue !== null) {
    const sortedValues = [...countsByValue.keys()].sort((a, b) => a - b);
    let valuesBelow = 0;
    for (const value of sortedValues) {
      const entry = countsByValue.get(value);
      const tieCount = entry.total;
      if (tieCount > 1) {
        wilcoxTieTerm += tieCount ** 3 - tieCount;
      }
      const averageRank = valuesBelow + (tieCount + 1) / 2;
      for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
        rankSum[groupIndex] +=
          entry.byGroup[groupIndex] * averageRank;
      }
      valuesBelow += tieCount;
    }
  } else {
    const order = markerContext.orderScratch.subarray(0, validCount);
    order.sort((a, b) => values[a] - values[b]);

    let i = 0;
    while (i < validCount) {
      let j = i + 1;
      const v = values[order[i]];
      while (j < validCount && values[order[j]] === v) j++;

      const tieCount = j - i;
      if (tieCount > 1) {
        wilcoxTieTerm += tieCount ** 3 - tieCount;
      }

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

    const R1 = rankSum[g];
    const U1 = R1 - (nA * (nA + 1)) / 2;
    const U2 = nA * nB - U1;
    const U = Math.min(U1, U2);

    const { pValue: p } = mannWhitneyPValue(nA, nB, U, {
      tieTerm: wilcoxTieTerm,
      allowExact: true
    });

    pValues[g] = Number.isFinite(p) ? p : NaN;
  }

  return {
    nAll,
    pValues,
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
    if (
      payload === null ||
      typeof payload !== 'object' ||
      !Number.isSafeInteger(payload.id) ||
      payload.id < 0 ||
      !Number.isSafeInteger(payload.poolSize) ||
      payload.poolSize <= 0
    ) {
      throw new TypeError(
        'DataWorker INIT requires exact non-negative id and positive poolSize'
      );
    }
    workerId = payload.id;
    poolSize = payload.poolSize;
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
