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
 *
 * Gene routes (`data/gene-delivery.js`, `analysis/data/gene-route.js`): the
 * genes an analysis run computes come from the AnnData reader worker over a
 * port of the run's route (`GENE_ROUTE_OPEN`), never through the page. A
 * task names its genes by their delivery (`payload.delivery`, `{route, id,
 * generation}`) instead of carrying them: the worker waits for the delivery
 * in its inbox and runs the task on what arrived (`columns`, `ranges` or
 * `block`). A delivery made for an older generation of this worker's port
 * (the pool replaced the worker it went to) never comes: the task answers
 * `{lost: true}` at once, and the run reads those genes again.
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
import { createUcellContext, ucellAddGenes, ucellFinish, ucellSetValues } from './ucell.js';

// ============================================================================
// Worker Pool State
// ============================================================================

let workerId = null;

// ============================================================================
// Gene Route Inbox
// ============================================================================

/**
 * The gene routes this worker holds, by id: the port, its generation, the
 * deliveries that arrived before their task and the tasks waiting for theirs.
 *
 * @type {Map<string, {generation: number, port: MessagePort, delivered: Map<number, Object>, waiting: Map<number, {resolve: Function, reject: Function}>}>}
 */
const geneRoutes = new Map();

function openGeneRoute(payload) {
  const { route, generation, port } = payload ?? {};
  if (typeof route !== 'string' || route.length === 0 || !Number.isSafeInteger(generation) || generation < 0 ||
      !(port instanceof MessagePort)) {
    throw new TypeError('GENE_ROUTE_OPEN: payload must be {route, generation, port}');
  }
  closeGeneRoute({ route });
  const inbox = { generation, port, delivered: new Map(), waiting: new Map() };
  port.onmessage = event => {
    const { id, generation: sentFor, ...data } = event.data;
    if (geneRoutes.get(route) !== inbox || sentFor !== inbox.generation) return;
    const waiter = inbox.waiting.get(id);
    if (waiter === undefined) {
      inbox.delivered.set(id, data);
    } else {
      inbox.waiting.delete(id);
      waiter.resolve(data);
    }
  };
  geneRoutes.set(route, inbox);
  return { route, generation };
}

function closeGeneRoute(payload) {
  const route = payload?.route;
  const inbox = geneRoutes.get(route);
  if (inbox === undefined) return { released: false };
  geneRoutes.delete(route);
  inbox.port.close();
  for (const { reject } of inbox.waiting.values()) {
    reject(new Error(`The gene route '${route}' was closed before its genes arrived`));
  }
  return { released: true };
}

/**
 * What delivery `{route, id, generation}` brought, once it arrives; null
 * when it was made for an older generation of this worker's port, so it
 * never will.
 *
 * @returns {Promise<Object|null>}
 */
function takeDelivery(delivery) {
  const { route, id, generation } = delivery ?? {};
  const inbox = geneRoutes.get(route);
  if (inbox === undefined) {
    return Promise.reject(new Error(`No gene route '${String(route)}' is open in this worker`));
  }
  if (generation !== inbox.generation) return Promise.resolve(null);
  const data = inbox.delivered.get(id);
  if (data !== undefined) {
    inbox.delivered.delete(id);
    return Promise.resolve(data);
  }
  return new Promise((resolve, reject) => inbox.waiting.set(id, { resolve, reject }));
}

// ============================================================================
// Marker Genes Panel (Genes Panel) Worker State
// ============================================================================

/**
 * Marker computation context stored per worker: each cell's group, every
 * group's size, which groups are tested, the reference (the rest or one
 * group), and the reusable tables of the marker kernel
 * (compute/gene-statistics.js). It avoids re-sending the per-cell categorical
 * codes for every gene. Set by MARKERS_SET_CONTEXT, released by
 * MARKERS_CLEAR_CONTEXT when the run ends however it ends.
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
 * Statistics of a batch of genes for every tested group of the marker
 * context against its reference (`groupMarkers`), packed gene-major: gene
 * `k`'s value for group `g` is at `k * groupCount + g`, `nAll` holds each
 * gene's measured grouped cells, and `moments` each gene's `sum, sumSq,
 * nonZero, n` over every cell (four numbers a gene).
 *
 * `columns` are the genes in every cell: dense Float32Arrays, or samples of
 * their non-zero entries `{length, indices, values}`. Either way the kernel
 * walks the non-zero entries only.
 *
 * Results carry the score (rank-sum z or Welch t, scanpy's `scores`) and
 * AUROC rather than U itself: Mann-Whitney U reaches n1*n2 (20,250,000 for
 * two sides of 4,500 cells), past what Float32 holds exactly, and no reader
 * needs it.
 */
function computeMarkerGenes(payload) {
  if (!markerContext?.cellGroupIndex) {
    throw new Error('MARKERS_COMPUTE_GENES: marker context not set');
  }

  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    throw new TypeError('MARKERS_COMPUTE_GENES: payload must be an object');
  }
  const {
    columns,
    method,
    minCells,
    pConvention,
    foldChange
  } = payload;

  if (!Array.isArray(columns) || columns.length === 0) {
    throw new TypeError('MARKERS_COMPUTE_GENES: columns must be a non-empty array');
  }
  for (const values of columns) {
    if (!(values instanceof Float32Array) && !isGeneSample(values)) {
      throw new TypeError(
        'MARKERS_COMPUTE_GENES: each column must be a Float32Array or a sample {length, indices, values}'
      );
    }
    if (values.length !== markerContext.cellGroupIndex.length) {
      throw new RangeError(
        'MARKERS_COMPUTE_GENES: column length must exactly match marker context'
      );
    }
  }
  if (!TEST_METHODS.includes(method)) {
    throw new RangeError(
      `MARKERS_COMPUTE_GENES: method must be one of ${TEST_METHODS.join(', ')}`
    );
  }
  if (!P_CONVENTIONS.includes(pConvention)) {
    throw new RangeError(
      `MARKERS_COMPUTE_GENES: pConvention must be one of ${P_CONVENTIONS.join(', ')}`
    );
  }
  if (
    foldChange === null ||
    typeof foldChange !== 'object' ||
    (foldChange.mode !== 'stored' && foldChange.mode !== 'log1p')
  ) {
    throw new TypeError('MARKERS_COMPUTE_GENES: foldChange must name a mode, stored or log1p');
  }
  if (!Number.isSafeInteger(minCells) || minCells <= 0) {
    throw new RangeError(
      'MARKERS_COMPUTE_GENES: minCells must be a positive integer'
    );
  }

  const genes = columns.length;
  const { groupCount } = markerContext;
  const packed = {
    genes,
    groupCount,
    pValues: new Float64Array(genes * groupCount),
    scores: new Float32Array(genes * groupCount),
    auroc: new Float32Array(genes * groupCount),
    log2FoldChange: new Float32Array(genes * groupCount),
    meanInGroup: new Float32Array(genes * groupCount),
    meanOutGroup: new Float32Array(genes * groupCount),
    percentInGroup: new Float32Array(genes * groupCount),
    percentOutGroup: new Float32Array(genes * groupCount),
    nIn: new Uint32Array(genes * groupCount),
    nOut: new Uint32Array(genes * groupCount),
    nAll: new Uint32Array(genes),
    moments: new Float64Array(genes * 4)
  };
  const options = {
    method,
    minCells,
    pConvention,
    foldChange: { pseudocount: LOG2_FOLD_CHANGE_PSEUDOCOUNT, ...foldChange }
  };
  for (let gene = 0; gene < genes; gene++) {
    const result = groupMarkers(geneSampleOf(columns[gene], 0), markerContext, options);
    const at = gene * groupCount;
    packed.pValues.set(result.pValues, at);
    packed.scores.set(result.scores, at);
    packed.auroc.set(result.auroc, at);
    packed.log2FoldChange.set(result.log2FoldChange, at);
    packed.meanInGroup.set(result.meanInGroup, at);
    packed.meanOutGroup.set(result.meanOutGroup, at);
    packed.percentInGroup.set(result.percentInGroup, at);
    packed.percentOutGroup.set(result.percentOutGroup, at);
    packed.nIn.set(result.nIn, at);
    packed.nOut.set(result.nOut, at);
    packed.nAll[gene] = result.nAll;
    const { sum, sumSq, nonZero, n } = result.column;
    packed.moments.set([sum, sumSq, nonZero, n], gene * 4);
  }
  return packed;
}

// ============================================================================
// UCell (gene signature) Worker State
// ============================================================================

/**
 * The range of cells this worker scores for a UCell run (compute/ucell.js):
 * set by UCELL_SET_CONTEXT, fed by UCELL_ADD_GENES, released by UCELL_FINISH
 * or, when the run stops before it finishes, by UCELL_CLEAR.
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

/**
 * Run one task on its payload (its delivered genes already in it) and give
 * its result.
 *
 * @param {string} type
 * @param {Object} payload
 * @returns {Object}
 */
function runTask(type, payload) {
  switch (type) {
    case 'GENE_ROUTE_OPEN':
      return openGeneRoute(payload);
    case 'GENE_ROUTE_CLOSE':
      return closeGeneRoute(payload);
    // Genes Panel (marker genes) specialized operations (stateful per worker)
    case 'MARKERS_SET_CONTEXT':
      return setMarkerContext(payload);
    case 'MARKERS_CLEAR_CONTEXT': {
      const released = markerContext !== null;
      markerContext = null;
      return { released };
    }
    case 'MARKERS_COMPUTE_GENES':
      return computeMarkerGenes(payload);
    case 'UCELL_SET_CONTEXT': {
      const { cellCount, setGeneCount, geneCount, sets, maxRank, slots = null, ranges = null, inline = null } = payload;
      // The set genes' entries in this worker's cells: those delivered over
      // the run's route, and those only the page holds (user-defined copies).
      const parts = [];
      if (ranges !== null) parts.push({ slots, ranges });
      if (inline !== null) parts.push(inline);
      ucellContext = createUcellContext({
        cellCount,
        setValues: ucellSetValues(cellCount, setGeneCount, parts),
        setGeneCount,
        geneCount,
        sets,
        maxRank
      });
      return { cells: ucellContext.cellCount };
    }
    case 'UCELL_ADD_GENES':
      ucellAddGenes(requireUcellContext(type), payload.ranges);
      return { added: payload.ranges.pointers.length - 1 };
    case 'UCELL_CLEAR': {
      const released = ucellContext !== null;
      ucellContext = null;
      return { released };
    }
    case 'UCELL_FINISH': {
      const scores = ucellFinish(requireUcellContext(type));
      ucellContext = null;
      return { scores };
    }
    default:
      // Use the shared operation handler
      return executeOperation(type, payload);
  }
}

/** Post the outcome of `run` as the answer to request `requestId`. */
function answer(requestId, run) {
  let result;
  try {
    result = run();
  } catch (error) {
    self.postMessage({ requestId, success: false, error: error.message });
    return;
  }
  self.postMessage({ requestId, success: true, result }, resultBuffers(result));
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

  if (payload !== null && typeof payload === 'object' && payload.delivery !== undefined) {
    // The task's genes come over its run's route: it runs once they are
    // here, or answers `lost` when they went to the worker this one replaced.
    const { delivery, ...rest } = payload;
    takeDelivery(delivery).then(
      delivered => answer(requestId, () => (delivered === null ? { lost: true } : runTask(type, { ...rest, ...delivered }))),
      error => self.postMessage({ requestId, success: false, error: error.message })
    );
    return;
  }
  answer(requestId, () => runTask(type, payload));
};

// ============================================================================
// Error Handler
// ============================================================================

self.onerror = function(error) {
  console.error('[DataWorker] Unhandled error:', error);
};
