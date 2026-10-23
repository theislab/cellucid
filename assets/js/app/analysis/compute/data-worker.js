/**
 * Data Processing Web Worker
 *
 * Handles computationally intensive data operations off the main thread:
 * - Correlation analysis
 * - Differential expression statistics
 * - Marker gene statistics for the genes panel
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

// Import shared operation handlers and kernels
// These are ES modules that work in both main thread and worker context
import { executeOperation } from './operation-handlers.js';
import { LOG2_FOLD_CHANGE_PSEUDOCOUNT } from './math-utils.js';
import {
  createGroupingContext,
  geneSampleOf,
  isGeneSample,
  oneVsRestMarkers
} from './gene-statistics.js';
import {
  isCategoricalCodes,
  missingCategoryCode
} from '../../../data/categorical-storage-contract.js';

// ============================================================================
// Worker Pool State
// ============================================================================

let workerId = null;

// ============================================================================
// Marker Genes Panel (Genes Panel) Worker State
// ============================================================================

/**
 * Marker computation context stored per worker: each cell's group, every
 * group's size, and the reusable tables of the one-vs-rest kernel
 * (compute/gene-statistics.js). It avoids re-sending the per-cell categorical
 * codes for every gene.
 *
 * @type {ReturnType<typeof createGroupingContext>|null}
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

  if (!isCategoricalCodes(codes) || codes.length === 0) {
    throw new TypeError(
      'MARKERS_SET_CONTEXT: codes must be non-empty categorical codes'
    );
  }
  if (
    !(codeToGroupIndex instanceof Int32Array) ||
    codeToGroupIndex.length === 0
  ) {
    throw new TypeError(
      'MARKERS_SET_CONTEXT: codeToGroupIndex must be a non-empty Int32Array'
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

  // Build per-cell group index lookup (-1 for invalid/missing). It is two
  // bytes per cell while the group indices fit, four past 32,767 groups.
  const nCells = codes.length;
  const cellGroupIndex = groupCount <= 0x7fff
    ? new Int16Array(nCells)
    : new Int32Array(nCells);
  cellGroupIndex.fill(-1);

  const missingCode = missingCategoryCode(codes);
  const mapLen = codeToGroupIndex.length;
  for (let i = 0; i < nCells; i++) {
    const code = codes[i];
    if (code !== missingCode && code < mapLen) {
      const gi = codeToGroupIndex[code];
      cellGroupIndex[i] = gi;
    }
  }

  markerContext = createGroupingContext(cellGroupIndex, groupCount);

  return { ok: true, cells: nCells, groups: groupCount };
}

/**
 * One-vs-rest statistics of one gene for every group of the marker context.
 *
 * `values` is the gene in every cell: a dense Float32Array, or the sample of
 * its non-zero entries `{length, indices, values}`. Either way the kernel
 * walks the non-zero entries only.
 *
 * The test statistic itself is deliberately not among the results. Marker
 * discovery reports probabilities, fold changes and expression fractions;
 * nothing on the way to the panel, the heatmap, the volcano or the cache ever
 * read a U or a t, and Mann-Whitney U reaches n1*n2 (20,250,000 for two sides
 * of 4,500 cells), past what Float32 holds exactly.
 */
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
    pseudocount = LOG2_FOLD_CHANGE_PSEUDOCOUNT
  } = payload;

  if (!(values instanceof Float32Array) && !isGeneSample(values)) {
    throw new TypeError(
      'MARKERS_COMPUTE_GENE: values must be a Float32Array or a sample {length, indices, values}'
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

  return oneVsRestMarkers(geneSampleOf(values, 0), markerContext, {
    method,
    minCells,
    pseudocount
  });
}

// ============================================================================
// Message Handler
// ============================================================================

/**
 * The buffers of a result's typed arrays. Every result array is created for
 * the one request it answers and kept by nothing here, so it is moved to the
 * calling thread rather than copied.
 *
 * @param {Object} result
 * @returns {ArrayBuffer[]}
 */
function resultBuffers(result) {
  const buffers = [];
  const collect = (value, depth) => {
    if (ArrayBuffer.isView(value)) {
      if (value.buffer instanceof ArrayBuffer && !buffers.includes(value.buffer)) {
        buffers.push(value.buffer);
      }
      return;
    }
    if (depth === 0 || value === null || typeof value !== 'object') return;
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      collect(item, depth - 1);
    }
  };
  collect(result, 3);
  return buffers;
}

self.onmessage = function(e) {
  const { type, payload, requestId } = e.data;

  // Handle INIT message from worker pool
  if (type === 'INIT') {
    if (
      payload === null ||
      typeof payload !== 'object' ||
      !Number.isSafeInteger(payload.id) ||
      payload.id < 0
    ) {
      throw new TypeError('DataWorker INIT requires an exact non-negative id');
    }
    workerId = payload.id;
    self.postMessage({ type: 'INIT_ACK', workerId });
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
      self.postMessage({ requestId, success: true, result }, resultBuffers(result));
      return;
    }

    // Use the shared operation handler
    const result = executeOperation(type, payload);

    self.postMessage({ requestId, success: true, result }, resultBuffers(result));

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
