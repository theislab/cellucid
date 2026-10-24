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
  P_CONVENTIONS,
  TEST_METHODS,
  createGroupingContext,
  geneSampleOf,
  groupMarkers,
  isGeneSample
} from './gene-statistics.js';
import {
  isCategoricalCodes,
  missingCategoryCode
} from '../../../data/categorical-storage-contract.js';
import { createUcellContext, ucellAddGenes, ucellFinish } from './ucell.js';

// ============================================================================
// Worker Pool State
// ============================================================================

let workerId = null;

// ============================================================================
// Marker Genes Panel (Genes Panel) Worker State
// ============================================================================

/**
 * Marker computation context stored per worker: each cell's group, every
 * group's size, which groups are tested, the reference (the rest or one
 * group), and the reusable tables of the marker kernel
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
  const { codes, codeToGroupIndex, groupCount, tested, reference } = payload;
  if (!(tested instanceof Uint8Array) || tested.length !== groupCount) {
    throw new TypeError('MARKERS_SET_CONTEXT: tested must be a Uint8Array of one flag per group');
  }
  if (!Number.isSafeInteger(reference) || reference < -1 || reference >= groupCount) {
    throw new RangeError('MARKERS_SET_CONTEXT: reference must be -1 or a group index');
  }

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

  markerContext = createGroupingContext(cellGroupIndex, groupCount, { tested, reference });

  return { ok: true, cells: nCells, groups: groupCount };
}

/**
 * Statistics of one gene for every tested group of the marker context
 * against its reference (`groupMarkers`).
 *
 * `values` is the gene in every cell: a dense Float32Array, or the sample of
 * its non-zero entries `{length, indices, values}`. Either way the kernel
 * walks the non-zero entries only.
 *
 * Results carry the score (rank-sum z or Welch t, scanpy's `scores`) and
 * AUROC rather than U itself: Mann-Whitney U reaches n1*n2 (20,250,000 for
 * two sides of 4,500 cells), past what Float32 holds exactly, and no reader
 * needs it.
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
    pConvention,
    foldChange
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
  if (!TEST_METHODS.includes(method)) {
    throw new RangeError(
      `MARKERS_COMPUTE_GENE: method must be one of ${TEST_METHODS.join(', ')}`
    );
  }
  if (!P_CONVENTIONS.includes(pConvention)) {
    throw new RangeError(
      `MARKERS_COMPUTE_GENE: pConvention must be one of ${P_CONVENTIONS.join(', ')}`
    );
  }
  if (
    foldChange === null ||
    typeof foldChange !== 'object' ||
    (foldChange.mode !== 'stored' && foldChange.mode !== 'log1p')
  ) {
    throw new TypeError('MARKERS_COMPUTE_GENE: foldChange must name a mode, stored or log1p');
  }
  if (!Number.isSafeInteger(minCells) || minCells <= 0) {
    throw new RangeError(
      'MARKERS_COMPUTE_GENE: minCells must be a positive integer'
    );
  }

  return groupMarkers(geneSampleOf(values, 0), markerContext, {
    method,
    minCells,
    pConvention,
    foldChange: { pseudocount: LOG2_FOLD_CHANGE_PSEUDOCOUNT, ...foldChange }
  });
}

// ============================================================================
// UCell (gene signature) Worker State
// ============================================================================

/**
 * The range of cells this worker scores for a UCell run (compute/ucell.js):
 * set by UCELL_SET_CONTEXT, fed by UCELL_ADD_GENES, released by UCELL_FINISH.
 * @type {ReturnType<typeof createUcellContext>|null}
 */
let ucellContext = null;

function requireUcellContext(type) {
  if (ucellContext === null) throw new Error(`${type}: no UCell context is held`);
  return ucellContext;
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

    if (type === 'UCELL_SET_CONTEXT') {
      ucellContext = createUcellContext(payload);
      self.postMessage({ requestId, success: true, result: { cells: ucellContext.cellCount } });
      return;
    }

    if (type === 'UCELL_ADD_GENES') {
      ucellAddGenes(requireUcellContext(type), payload);
      self.postMessage({ requestId, success: true, result: { added: payload.pointers.length - 1 } });
      return;
    }

    if (type === 'UCELL_FINISH') {
      const scores = ucellFinish(requireUcellContext(type));
      ucellContext = null;
      const result = { scores };
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
