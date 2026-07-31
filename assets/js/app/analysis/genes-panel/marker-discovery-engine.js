/**
 * Marker Discovery Engine
 *
 * Discovers marker genes for multiple groups using streaming gene loading and
 * worker-backed multi-group statistics.
 *
 * Core performance properties (per GENES_PANEL_ROADMAP):
 * - Download each gene once (StreamingGeneLoader)
 * - Compute one-vs-rest stats for all groups in a single pass per gene
 * - Keep memory bounded while emitting progressive partial results
 *
 * Implementation highlights:
 * - Uses the existing WorkerPool + data-worker.js for multi-core computation.
 * - Broadcasts a per-worker categorical context once per run to avoid re-sending
 *   large per-cell code arrays for every gene.
 * - Maintains Top-N heaps per group for progressive UI.
 * - Computes Benjamini–Hochberg adjusted p-values per group at the end.
 *
 * @module genes-panel/marker-discovery-engine
 */

import { StreamingGeneLoader } from '../data/streaming-gene-loader.js';
import { getWorkerPool } from '../compute/worker-pool.js';
import { waitForAvailableSlot } from '../shared/concurrency-utils.js';
import { DEFAULTS, ERROR_MESSAGES, formatError, ANALYSIS_PHASES } from './constants.js';
import { benjaminiHochbergAdjusted } from '../stats/statistical-tests.js';
import { setOwnDataProperty } from '../../../utils/exact-record.js';

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Marker workers retain one module-global categorical context. A discovery run
 * therefore owns every worker from context broadcast until its final marker
 * task settles. The queue is module-scoped so separate engine instances cannot
 * overwrite each other's scientific context.
 */
let markerContextLeaseActive = false;
const markerContextLeaseWaiters = [];

function getAbortReason(signal) {
  return signal?.reason ??
    new DOMException('Marker discovery was aborted', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw getAbortReason(signal);
  }
}

/**
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<() => void>}
 */
async function acquireMarkerContextLease(signal) {
  throwIfAborted(signal);

  const createRelease = () => {
    let released = false;
    return () => {
      if (released) {
        throw new Error('Marker worker context lease was released more than once');
      }
      released = true;

      while (markerContextLeaseWaiters.length > 0) {
        const waiter = markerContextLeaseWaiters.shift();
        waiter.removeAbortListener();
        if (waiter.signal?.aborted) {
          waiter.reject(getAbortReason(waiter.signal));
          continue;
        }
        waiter.resolve(createRelease());
        return;
      }
      markerContextLeaseActive = false;
    };
  };

  let release;
  if (!markerContextLeaseActive) {
    markerContextLeaseActive = true;
    release = createRelease();
  } else {
    release = await new Promise((resolve, reject) => {
      const waiter = {
        signal,
        resolve,
        reject,
        removeAbortListener: () => {}
      };
      if (signal) {
        const handleAbort = () => {
          const index = markerContextLeaseWaiters.indexOf(waiter);
          if (index >= 0) {
            markerContextLeaseWaiters.splice(index, 1);
          }
          waiter.removeAbortListener();
          reject(getAbortReason(signal));
        };
        waiter.removeAbortListener = () => {
          signal.removeEventListener('abort', handleAbort);
        };
        signal.addEventListener('abort', handleAbort, { once: true });
      }
      markerContextLeaseWaiters.push(waiter);
    });
  }

  if (signal?.aborted) {
    release();
    throw getAbortReason(signal);
  }
  return release;
}

/**
 * Max-heap that keeps the "worst" element at the root, so we can evict it when
 * we exceed capacity.
 */
class TopNHeap {
  /**
   * @param {number} capacity
  * @param {(a: any, b: any) => boolean} isWorse - returns true if a is worse than b
  */
  constructor(capacity, isWorse) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError('TopNHeap capacity must be a positive integer');
    }
    if (typeof isWorse !== 'function') {
      throw new TypeError('TopNHeap isWorse must be a function');
    }
    this._cap = capacity;
    this._isWorse = isWorse;
    /** @type {any[]} */
    this._arr = [];
  }

  size() {
    return this._arr.length;
  }

  toArray() {
    return this._arr.slice();
  }

  peekWorst() {
    return this._arr.length > 0 ? this._arr[0] : null;
  }

  push(item) {
    const n = this._arr.length;
    if (n < this._cap) {
      this._arr.push(item);
      this._siftUp(n);
      return;
    }

    const worst = this._arr[0];
    // Replace worst only if the incoming item is better.
    if (this._isWorse(worst, item)) {
      this._arr[0] = item;
      this._siftDown(0);
    }
  }

  _siftUp(idx) {
    const arr = this._arr;
    const isWorse = this._isWorse;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (!isWorse(arr[idx], arr[parent])) break;
      const tmp = arr[idx];
      arr[idx] = arr[parent];
      arr[parent] = tmp;
      idx = parent;
    }
  }

  _siftDown(idx) {
    const arr = this._arr;
    const isWorse = this._isWorse;
    const n = arr.length;
    while (true) {
      const left = idx * 2 + 1;
      const right = left + 1;
      let worst = idx;

      if (left < n && isWorse(arr[left], arr[worst])) worst = left;
      if (right < n && isWorse(arr[right], arr[worst])) worst = right;

      if (worst === idx) break;
      const tmp = arr[idx];
      arr[idx] = arr[worst];
      arr[worst] = tmp;
      idx = worst;
    }
  }
}

// =============================================================================
// MARKER DISCOVERY ENGINE
// =============================================================================

export class MarkerDiscoveryEngine {
  /**
   * @param {Object} options
   * @param {Object} options.dataLayer - DataLayer instance for gene loading
  * @param {Object} [options.config]
  */
  constructor(options) {
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options)
    ) {
      throw new TypeError(
        '[MarkerDiscoveryEngine] options must be an object'
      );
    }
    const { dataLayer, config = {} } = options;

    if (
      dataLayer === null ||
      typeof dataLayer !== 'object'
    ) {
      throw new TypeError(
        '[MarkerDiscoveryEngine] dataLayer must be an object'
      );
    }
    if (
      config === null ||
      typeof config !== 'object' ||
      Array.isArray(config)
    ) {
      throw new TypeError(
        '[MarkerDiscoveryEngine] config must be an object'
      );
    }

    this.dataLayer = dataLayer;

    this._config = {
      minCells: config.minCells ?? DEFAULTS.minCells,
      pValueThreshold: config.pValueThreshold ?? DEFAULTS.pValueThreshold,
      foldChangeThreshold: config.foldChangeThreshold ?? DEFAULTS.foldChangeThreshold,
      useAdjustedPValue: config.useAdjustedPValue ?? DEFAULTS.useAdjustedPValue,
      progressInterval: config.progressInterval ?? DEFAULTS.progressInterval,
      batchSize: config.batchSize ?? DEFAULTS.batchSize,
      networkConcurrency: config.networkConcurrency ?? DEFAULTS.networkConcurrency,
      memoryBudgetMB: config.memoryBudgetMB ?? DEFAULTS.memoryBudgetMB
    };
    if (!Number.isSafeInteger(this._config.minCells) || this._config.minCells <= 0) {
      throw new RangeError(
        '[MarkerDiscoveryEngine] minCells must be a positive integer'
      );
    }
    if (
      !Number.isFinite(this._config.pValueThreshold) ||
      this._config.pValueThreshold <= 0 ||
      this._config.pValueThreshold > 1
    ) {
      throw new RangeError(
        '[MarkerDiscoveryEngine] pValueThreshold must be in (0, 1]'
      );
    }
    if (
      !Number.isFinite(this._config.foldChangeThreshold) ||
      this._config.foldChangeThreshold < 0
    ) {
      throw new RangeError(
        '[MarkerDiscoveryEngine] foldChangeThreshold must be non-negative'
      );
    }
    if (typeof this._config.useAdjustedPValue !== 'boolean') {
      throw new TypeError(
        '[MarkerDiscoveryEngine] useAdjustedPValue must be boolean'
      );
    }
    for (const key of ['progressInterval', 'batchSize', 'networkConcurrency']) {
      if (!Number.isSafeInteger(this._config[key]) || this._config[key] <= 0) {
        throw new RangeError(
          `[MarkerDiscoveryEngine] ${key} must be a positive integer`
        );
      }
    }
    if (
      !Number.isFinite(this._config.memoryBudgetMB) ||
      this._config.memoryBudgetMB <= 0
    ) {
      throw new RangeError(
        '[MarkerDiscoveryEngine] memoryBudgetMB must be positive and finite'
      );
    }
  }

  /**
   * Discover marker genes for all groups in a categorical field.
   *
   * @param {Object} options
   * @param {string} options.obsCategory
   * @param {Object[]} options.groups
   * @param {string} options.groups[].groupId
   * @param {string} [options.groups[].groupName]
   * @param {number} options.groups[].groupCode - Integer code (index into obs categories)
   * @param {number[]|Uint32Array} options.groups[].cellIndices
   * @param {number} [options.groups[].cellCount]
   * @param {string} [options.groups[].color]
   * @param {Uint16Array} options.obsCodes - Per-cell category codes for obsCategory
   * @param {string[]} [options.geneList] - Gene keys (null = all genes)
   * @param {'wilcox'|'ttest'} [options.method='wilcox']
   * @param {number} [options.topNPerGroup=10]
   * @param {number} [options.minCells=10]
   * @param {number} [options.pValueThreshold=0.05]
   * @param {number} [options.foldChangeThreshold=1.0]
   * @param {boolean} [options.useAdjustedPValue=true]
   * @param {number|'auto'} [options.parallelism='auto']
   * @param {Object} [options.batchConfig]
   * @param {Function} [options.onProgress]
   * @param {Function} [options.onPartialResults]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<MarkersByCategory>}
   */
  async discoverMarkers(options) {
    const startTime = performance.now();

    if (
      typeof this.dataLayer.getAvailableVariables !== 'function' ||
      typeof this.dataLayer.ensureGeneExpressionLoaded !== 'function' ||
      typeof this.dataLayer.unloadGeneExpression !== 'function' ||
      typeof this.dataLayer.invalidateVariable !== 'function'
    ) {
      throw new TypeError(
        '[MarkerDiscoveryEngine] dataLayer must implement the exact gene data contract'
      );
    }
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options)
    ) {
      throw new TypeError(
        '[MarkerDiscoveryEngine] discovery options must be an object'
      );
    }
    const {
      obsCategory,
      groups: requestedGroups,
      obsCodes: requestedObsCodes,
      geneList = null,
      method = DEFAULTS.method,
      topNPerGroup = DEFAULTS.topNPerGroup,
      minCells = this._config.minCells,
      pValueThreshold = this._config.pValueThreshold,
      foldChangeThreshold = this._config.foldChangeThreshold,
      useAdjustedPValue = this._config.useAdjustedPValue,
      parallelism = 'auto',
      batchConfig = {},
      onProgress,
      onPartialResults,
      signal
    } = options;

    if (
      typeof obsCategory !== 'string' ||
      obsCategory.length === 0 ||
      obsCategory !== obsCategory.trim()
    ) {
      throw new TypeError(
        '[MarkerDiscoveryEngine] obsCategory must be a non-empty string'
      );
    }
    if (method !== 'wilcox' && method !== 'ttest') {
      throw new RangeError(
        '[MarkerDiscoveryEngine] method must be wilcox or ttest'
      );
    }
    if (!Number.isSafeInteger(minCells) || minCells <= 0) {
      throw new RangeError(
        '[MarkerDiscoveryEngine] minCells must be a positive integer'
      );
    }
    // The rule the worker actually applies: a group is tested for a gene only
    // when it and the rest each hold this many cells with a measured value. Two
    // is the floor because neither Welch nor a rank test says anything about a
    // single observation. It is published with the result so the panel can name
    // the reason a gene went untested instead of guessing at `minCells`.
    const minCellsPerSide = Math.max(2, minCells);
    if (
      !Number.isFinite(pValueThreshold) ||
      pValueThreshold <= 0 ||
      pValueThreshold > 1
    ) {
      throw new RangeError(
        '[MarkerDiscoveryEngine] pValueThreshold must be in (0, 1]'
      );
    }
    if (
      !Number.isFinite(foldChangeThreshold) ||
      foldChangeThreshold < 0
    ) {
      throw new RangeError(
        '[MarkerDiscoveryEngine] foldChangeThreshold must be non-negative'
      );
    }
    if (typeof useAdjustedPValue !== 'boolean') {
      throw new TypeError(
        '[MarkerDiscoveryEngine] useAdjustedPValue must be boolean'
      );
    }
    if (
      topNPerGroup !== 'all' &&
      (!Number.isSafeInteger(topNPerGroup) || topNPerGroup <= 0)
    ) {
      throw new RangeError(
        '[MarkerDiscoveryEngine] topNPerGroup must be all or a positive integer'
      );
    }
    if (
      parallelism !== 'auto' &&
      (!Number.isSafeInteger(parallelism) || parallelism <= 0)
    ) {
      throw new RangeError(
        '[MarkerDiscoveryEngine] parallelism must be auto or a positive integer'
      );
    }
    if (
      batchConfig === null ||
      typeof batchConfig !== 'object' ||
      Array.isArray(batchConfig)
    ) {
      throw new TypeError(
        '[MarkerDiscoveryEngine] batchConfig must be an object'
      );
    }
    const preloadCount =
      batchConfig.preloadCount ?? this._config.batchSize;
    const networkConcurrency =
      batchConfig.networkConcurrency ?? this._config.networkConcurrency;
    for (const [name, value] of [
      ['preloadCount', preloadCount],
      ['networkConcurrency', networkConcurrency],
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(
          `[MarkerDiscoveryEngine] ${name} must be a positive integer`
        );
      }
    }
    const memoryBudgetMB =
      batchConfig.memoryBudgetMB ?? this._config.memoryBudgetMB;
    if (!Number.isFinite(memoryBudgetMB) || memoryBudgetMB <= 0) {
      throw new RangeError(
        '[MarkerDiscoveryEngine] memoryBudgetMB must be positive and finite'
      );
    }
    for (const [name, callback] of [
      ['onProgress', onProgress],
      ['onPartialResults', onPartialResults],
    ]) {
      if (callback !== undefined && typeof callback !== 'function') {
        throw new TypeError(
          `[MarkerDiscoveryEngine] ${name} must be a function when provided`
        );
      }
    }
    if (
      signal !== undefined &&
      (
        signal === null ||
        typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function'
      )
    ) {
      throw new TypeError(
        '[MarkerDiscoveryEngine] signal must implement AbortSignal'
      );
    }
    if (signal?.aborted) {
      throw signal.reason;
    }
    this._validateGroups(requestedGroups, minCells);
    if (!(requestedObsCodes instanceof Uint16Array) || requestedObsCodes.length === 0) {
      throw new TypeError(
        '[MarkerDiscoveryEngine] obsCodes must be a non-empty Uint16Array'
      );
    }
    const pointCount = this.dataLayer.state?.pointCount;
    if (!Number.isSafeInteger(pointCount) || pointCount <= 0) {
      throw new RangeError(
        '[MarkerDiscoveryEngine] exact positive dataset pointCount is required'
      );
    }
    if (requestedObsCodes.length !== pointCount) {
      throw new RangeError(
        '[MarkerDiscoveryEngine] obsCodes length must exactly match pointCount'
      );
    }
    const groups = requestedGroups.map(group => ({
      groupId: group.groupId,
      groupName: group.groupName,
      groupCode: group.groupCode,
      cellIndices: group.cellIndices,
      cellCount: group.cellCount,
      color: group.color
    }));
    const obsCodes = new Uint16Array(requestedObsCodes);
    const groupByCode = new Map(
      groups.map(group => [group.groupCode, group])
    );
    const countsByCode = new Map(
      groups.map(group => [group.groupCode, 0])
    );
    for (let cellIndex = 0; cellIndex < obsCodes.length; cellIndex++) {
      const code = obsCodes[cellIndex];
      if (code === 65535) continue;
      if (!groupByCode.has(code)) {
        throw new Error(
          `[MarkerDiscoveryEngine] obs code ${code} has no exact group owner`
        );
      }
      countsByCode.set(code, countsByCode.get(code) + 1);
    }
    for (const group of groups) {
      if (countsByCode.get(group.groupCode) !== group.cellCount) {
        throw new RangeError(
          `Group "${group.groupId}" cellCount does not match obsCodes`
        );
      }
      for (const cellIndex of group.cellIndices) {
        if (obsCodes[cellIndex] !== group.groupCode) {
          throw new RangeError(
            `Group "${group.groupId}" cell index ${cellIndex} does not match groupCode`
          );
        }
      }
    }

    const availableVariables =
      this.dataLayer.getAvailableVariables('gene_expression');
    if (!Array.isArray(availableVariables) || availableVariables.length === 0) {
      throw new Error('No gene expression variables available for analysis.');
    }
    const availableGenes = availableVariables.map((variable, index) => {
      if (
        variable === null ||
        typeof variable !== 'object' ||
        typeof variable.key !== 'string' ||
        variable.key.length === 0 ||
        variable.key !== variable.key.trim()
      ) {
        throw new TypeError(
          `Gene inventory entry ${index} must own a non-empty key`
        );
      }
      return variable.key;
    });
    if (new Set(availableGenes).size !== availableGenes.length) {
      throw new Error('Gene inventory contains duplicate keys');
    }

    let allGenes;
    if (geneList === null) {
      allGenes = availableGenes;
    } else {
      if (
        !Array.isArray(geneList) ||
        geneList.length === 0 ||
        geneList.some(
          gene =>
            typeof gene !== 'string' ||
            gene.length === 0 ||
            gene !== gene.trim()
        ) ||
        new Set(geneList).size !== geneList.length
      ) {
        throw new TypeError(
          '[MarkerDiscoveryEngine] geneList must be null or unique non-empty strings'
        );
      }
      const availableGeneSet = new Set(availableGenes);
      for (const gene of geneList) {
        if (!availableGeneSet.has(gene)) {
          throw new Error(
            `[MarkerDiscoveryEngine] requested gene not found: ${gene}`
          );
        }
      }
      allGenes = [...geneList];
    }

    const groupCount = groups.length;
    const geneCount = allGenes.length;
    if (
      topNPerGroup !== 'all' &&
      topNPerGroup > geneCount
    ) {
      throw new RangeError(
        '[MarkerDiscoveryEngine] topNPerGroup cannot exceed geneCount'
      );
    }

    const releaseMarkerContext = await acquireMarkerContextLease(signal);
    try {
    // Worker pool (shared singleton used by ComputeManager too).
    const pool = getWorkerPool();
    await pool.init();
    throwIfAborted(signal);
    if (!pool.isReady()) {
      throw new Error('Marker discovery requires Web Workers');
    }
    if (typeof pool.getStats !== 'function') {
      throw new TypeError(
        'Marker discovery worker pool must expose getStats()'
      );
    }
    const poolStats = pool.getStats();
    if (
      poolStats === null ||
      typeof poolStats !== 'object' ||
      !Number.isSafeInteger(poolStats.poolSize) ||
      poolStats.poolSize <= 0
    ) {
      throw new TypeError(
        'Marker discovery requires an exact positive worker pool size'
      );
    }
    const poolSize = poolStats.poolSize;

    // Build a code->groupIndex map (sized to max groupCode + 1).
    let mapLen = 0;
    for (const g of groups) {
      mapLen = Math.max(mapLen, g.groupCode + 1);
    }
    const codeToGroupIndex = new Int16Array(mapLen);
    codeToGroupIndex.fill(-1);
    for (let i = 0; i < groups.length; i++) {
      const code = groups[i].groupCode;
      codeToGroupIndex[code] = i;
    }

    // Broadcast marker context to workers (once per run).
    // Each worker needs its own backing buffers (transfer detaches).
    await pool.broadcast(
      'MARKERS_SET_CONTEXT',
      (/* workerIndex */) => ({
        codes: new Uint16Array(obsCodes),
        codeToGroupIndex: new Int16Array(codeToGroupIndex),
        groupCount
      }),
      { timeout: 30000 }
    );
    throwIfAborted(signal);

    // Prepare per-group p-value storage for BH correction.
    const pValuesByGroup = Array.from({ length: groupCount }, () => {
      const arr = new Float64Array(geneCount);
      arr.fill(NaN);
      return arr;
    });

    // Store full per-gene stats so UI can re-threshold without recomputing.
    const log2FCByGroup = Array.from({ length: groupCount }, () => {
      const arr = new Float32Array(geneCount);
      arr.fill(NaN);
      return arr;
    });

    const effectiveTopNPerGroup = topNPerGroup === 'all'
      ? geneCount
      : topNPerGroup;

    // Per-group Top-N heaps for progressive results.
    const heaps = Array.from({ length: groupCount }, () => {
      // "Worst" = higher p-value; tie-break: smaller |log2FC| is worse.
      const isWorse = (a, b) => {
        const pa = a.pValue;
        const pb = b.pValue;
        if (pa !== pb) return pa > pb;
        const fa = Math.abs(a.log2FoldChange);
        const fb = Math.abs(b.log2FoldChange);
        return fa < fb;
      };
      return new TopNHeap(effectiveTopNPerGroup, isWorse);
    });

    const effectiveBatchConfig = {
      preloadCount,
      networkConcurrency,
      memoryBudgetMB
    };

    // Choose bounded concurrency for worker compute.
    const requestedParallelism = parallelism === 'auto'
      ? poolSize
      : parallelism;
    if (requestedParallelism > poolSize) {
      throw new RangeError(
        `Requested marker parallelism ${requestedParallelism} exceeds worker pool size ${poolSize}`
      );
    }

    const totalCells = obsCodes.length;
    const bytesPerGene = totalCells * 4 * (method === 'wilcox' ? 2 : 1); // values + (wilcox) order scratch in worker
    const budgetBytes = effectiveBatchConfig.memoryBudgetMB * 1024 * 1024;
    const maxByMemory = Math.floor(budgetBytes / bytesPerGene);
    if (maxByMemory < 1) {
      throw new RangeError(
        `Marker memory budget ${effectiveBatchConfig.memoryBudgetMB} MB cannot hold one gene working set`
      );
    }
    const maxInFlight = Math.min(requestedParallelism, maxByMemory);

    // Stream raw genes (prefetch + memory-aware unloading).
    const loader = new StreamingGeneLoader({
      dataLayer: this.dataLayer,
      config: {
        preloadCount: effectiveBatchConfig.preloadCount,
        networkConcurrency: effectiveBatchConfig.networkConcurrency,
        memoryBudgetMB: effectiveBatchConfig.memoryBudgetMB
      },
      signal
    });

    let completedGenes = 0;
    let lastPartialEmit = 0;
    const inFlight = new Set();
    const executionErrors = [];

    const reportProgress = () => {
      if (signal?.aborted || !onProgress) return;
      onProgress({
        phase: ANALYSIS_PHASES.DISCOVERY,
        progress: Math.round((completedGenes / geneCount) * 100),
        loaded: completedGenes,
        total: geneCount,
        message: `Analyzing genes (${completedGenes.toLocaleString()}/${geneCount.toLocaleString()})`
      });
    };

    reportProgress();

    const maybeEmitPartial = () => {
      if (signal?.aborted || !onPartialResults) return;
      if (completedGenes - lastPartialEmit < this._config.progressInterval) return;
      lastPartialEmit = completedGenes;

      const partialGroups = this._buildMarkersFromHeaps({
        groups,
        heaps,
        adjustedByGroup: null,
        pValueThreshold,
        foldChangeThreshold,
        useAdjustedPValue: false
      });

      onPartialResults({
        markers: {
          obsCategory,
          method,
          minCellsPerSide,
          computedAt: Date.now(),
          computeDuration: performance.now() - startTime,
          geneCount,
          groups: partialGroups
        },
        genesProcessed: completedGenes,
        totalGenes: geneCount,
        isComplete: false
      });
    };

    let streamFailure;
    try {
      for await (
        const { gene, values, index: geneIndex } of
        loader.streamGenesRaw(allGenes)
      ) {
        throwIfAborted(signal);
        await waitForAvailableSlot(inFlight, maxInFlight);
        throwIfAborted(signal);
        if (executionErrors.length === 1) throw executionErrors[0];
        if (executionErrors.length > 1) {
          throw new AggregateError(
            [...executionErrors],
            `${executionErrors.length} marker worker operations failed`
          );
        }

        // Copy now (bounded by maxInFlight) so DataLayer-owned buffers are
        // never transferred or retained by worker execution.
        const valuesCopyForWorker = new Float32Array(values);

        let task;
        task = (async () => {
          try {
            const res = await pool.execute(
              'MARKERS_COMPUTE_GENE',
              { values: valuesCopyForWorker, method, minCells },
              {
                timeout: 120000,
                transfer: true
              }
            );

            if (signal?.aborted) return;
            this._ingestGeneResult({
              gene,
              geneIndex,
              groups,
              pValuesByGroup,
              log2FCByGroup,
              heaps,
              result: res
            });
            completedGenes++;
            reportProgress();
            maybeEmitPartial();
          } catch (error) {
            executionErrors.push(error);
          }
        })().finally(() => inFlight.delete(task));

        inFlight.add(task);
      }
    } catch (error) {
      streamFailure = error;
    }

    const remainingFailures = [];
    await Promise.all(
      [...inFlight].map(task =>
        task.catch(error => {
          remainingFailures.push(error);
        })
      )
    );
    const failures = [];
    const appendFailure = failure => {
      if (!failures.includes(failure)) failures.push(failure);
    };
    if (streamFailure !== undefined) appendFailure(streamFailure);
    for (const failure of executionErrors) appendFailure(failure);
    for (const failure of remainingFailures) appendFailure(failure);
    if (signal?.aborted) {
      const abortReason = getAbortReason(signal);
      const nonAbortFailures = failures.filter(
        failure => failure !== abortReason
      );
      if (nonAbortFailures.length === 1) throw nonAbortFailures[0];
      if (nonAbortFailures.length > 1) {
        throw new AggregateError(
          nonAbortFailures,
          `${nonAbortFailures.length} marker cleanup operations failed after cancellation`
        );
      }
      throw abortReason;
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `${failures.length} marker streaming or worker operations failed`
      );
    }

    // Benjamini-Hochberg per group. Each group is its own family: it is one
    // one-vs-rest comparison run across every gene in the panel. Genes that
    // could not be tested for that group carry NaN and are excluded from the
    // denominator `m` — an untested gene is not a gene with p = 1, and counting
    // it would deflate every adjusted value in the group. The counts travel with
    // the group so the panel can report the denominator it actually used.
    const correctionByGroup = pValuesByGroup.map(
      (arr) => benjaminiHochbergAdjusted(arr)
    );
    const adjustedByGroup = correctionByGroup.map(
      (correction) => correction.adjustedPValues
    );

    // Final groups output
    const finalGroups = this._buildMarkersFromHeaps({
      groups,
      heaps,
      adjustedByGroup,
      correctionByGroup,
      pValueThreshold,
      foldChangeThreshold,
      useAdjustedPValue
    });

    const duration = performance.now() - startTime;

    if (!signal?.aborted && onPartialResults) {
      onPartialResults({
        markers: {
          obsCategory,
          method,
          minCellsPerSide,
          computedAt: Date.now(),
          computeDuration: duration,
          geneCount,
          groups: finalGroups
        },
        genesProcessed: completedGenes,
        totalGenes: geneCount,
        isComplete: true
      });
    }
    throwIfAborted(signal);

    return {
      obsCategory,
      method,
      minCellsPerSide,
      computedAt: Date.now(),
      computeDuration: duration,
      geneCount,
      groups: finalGroups,
      stats: {
        genes: allGenes,
        groupIds: groups.map(g => g.groupId),
        pValuesByGroup,
        adjustedPValuesByGroup: adjustedByGroup,
        log2FoldChangeByGroup: log2FCByGroup
      }
    };
    } finally {
      releaseMarkerContext();
    }
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  _validateGroups(groups, minCells) {
    if (!Array.isArray(groups)) {
      throw new TypeError('[MarkerDiscoveryEngine] groups must be an array');
    }
    if (groups.length < 2) {
      throw new Error(
        formatError(ERROR_MESSAGES.TOO_FEW_GROUPS, { n: groups.length })
      );
    }
    if (groups.length > 32767) {
      throw new RangeError(
        '[MarkerDiscoveryEngine] group count exceeds the Int16 worker contract'
      );
    }

    const pointCount = this.dataLayer.state?.pointCount;
    if (!Number.isSafeInteger(pointCount) || pointCount <= 0) {
      throw new RangeError(
        '[MarkerDiscoveryEngine] exact positive dataset pointCount is required'
      );
    }
    const groupIds = new Set();
    const groupCodes = new Set();
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];
      if (
        group === null ||
        typeof group !== 'object' ||
        Array.isArray(group)
      ) {
        throw new TypeError(
          `[MarkerDiscoveryEngine] group ${groupIndex} must be an object`
        );
      }
      if (
        typeof group.groupId !== 'string' ||
        group.groupId.length === 0 ||
        group.groupId !== group.groupId.trim()
      ) {
        throw new TypeError(
          `[MarkerDiscoveryEngine] group ${groupIndex} must own a non-empty groupId`
        );
      }
      if (groupIds.has(group.groupId)) {
        throw new Error(
          `[MarkerDiscoveryEngine] duplicate groupId "${group.groupId}"`
        );
      }
      groupIds.add(group.groupId);
      if (
        (
          typeof group.groupName !== 'string' &&
          typeof group.groupName !== 'number' &&
          typeof group.groupName !== 'boolean'
        ) ||
        (
          typeof group.groupName === 'string' &&
          (
            group.groupName.length === 0 ||
            group.groupName !== group.groupName.trim()
          )
        ) ||
        (
          typeof group.groupName === 'number' &&
          !Number.isFinite(group.groupName)
        )
      ) {
        throw new TypeError(
          `Group "${group.groupId}" must own an exact primitive groupName`
        );
      }
      if (
        !Number.isSafeInteger(group.groupCode) ||
        group.groupCode < 0 ||
        group.groupCode >= 65535
      ) {
        throw new RangeError(
          `Group "${group.groupId}" groupCode must be an integer from 0 through 65534`
        );
      }
      if (groupCodes.has(group.groupCode)) {
        throw new Error(
          `[MarkerDiscoveryEngine] duplicate groupCode ${group.groupCode}`
        );
      }
      groupCodes.add(group.groupCode);
      if (!(group.cellIndices instanceof Uint32Array)) {
        throw new TypeError(
          `Group "${group.groupId}" cellIndices must be a Uint32Array`
        );
      }
      let previousIndex = -1;
      for (const cellIndex of group.cellIndices) {
        if (cellIndex >= pointCount) {
          throw new RangeError(
            `Group "${group.groupId}" cell index ${cellIndex} exceeds pointCount`
          );
        }
        if (cellIndex <= previousIndex) {
          throw new RangeError(
            `Group "${group.groupId}" cellIndices must be sorted and unique`
          );
        }
        previousIndex = cellIndex;
      }
      if (
        !Number.isSafeInteger(group.cellCount) ||
        group.cellCount !== group.cellIndices.length
      ) {
        throw new RangeError(
          `Group "${group.groupId}" cellCount must exactly match cellIndices length`
        );
      }
      if (typeof group.color !== 'string' || group.color.length === 0) {
        throw new TypeError(
          `Group "${group.groupId}" color must be a non-empty string`
        );
      }
      if (group.cellCount < minCells) {
        throw new Error(formatError(ERROR_MESSAGES.TOO_FEW_CELLS, {
          name: group.groupName,
          n: group.cellCount,
          min: minCells
        }));
      }
    }
  }

  _ingestGeneResult({ gene, geneIndex, groups, pValuesByGroup, log2FCByGroup, heaps, result }) {
    if (
      typeof gene !== 'string' ||
      gene.length === 0 ||
      !Number.isSafeInteger(geneIndex) ||
      geneIndex < 0
    ) {
      throw new TypeError('Marker gene identity and index must be exact');
    }
    if (
      result === null ||
      typeof result !== 'object' ||
      Array.isArray(result)
    ) {
      throw new TypeError(
        `Marker worker returned an invalid result for "${gene}"`
      );
    }
    const {
      nAll,
      pValues,
      log2FoldChange,
      meanInGroup,
      meanOutGroup,
      percentInGroup,
      percentOutGroup,
      nIn,
      nOut
    } = result;
    const groupCount = groups.length;
    const requiredArrays = [
      ['pValues', pValues, Float64Array],
      ['log2FoldChange', log2FoldChange, Float32Array],
      ['meanInGroup', meanInGroup, Float32Array],
      ['meanOutGroup', meanOutGroup, Float32Array],
      ['percentInGroup', percentInGroup, Float32Array],
      ['percentOutGroup', percentOutGroup, Float32Array],
      ['nIn', nIn, Uint32Array],
      ['nOut', nOut, Uint32Array],
    ];
    for (const [name, values, ArrayType] of requiredArrays) {
      if (!(values instanceof ArrayType) || values.length !== groupCount) {
        throw new TypeError(
          `Marker worker ${name} for "${gene}" must be a ${ArrayType.name} with one value per group`
        );
      }
    }
    // `nAll` counts the cells that carry a measured value for this gene. It can
    // be zero: a gene that is missing in every grouped cell was still read, and
    // it is untested rather than malformed.
    if (!Number.isSafeInteger(nAll) || nAll < 0) {
      throw new RangeError(
        `Marker worker nAll for "${gene}" must be a non-negative integer`
      );
    }
    if (
      geneIndex >= pValuesByGroup[0].length ||
      geneIndex >= log2FCByGroup[0].length
    ) {
      throw new RangeError(
        `Marker gene index ${geneIndex} is outside result storage`
      );
    }

    for (let g = 0; g < groups.length; g++) {
      const p = pValues[g];
      const fc = log2FoldChange[g];

      // NaN is the worker's word for "this group could not be tested for this
      // gene": fewer than max(2, minCells) of its cells - or of the rest -
      // carried a measured value, so no comparison was run. That is a property
      // of the data, not a backend defect, and it is the state the min-cell rule
      // in data-worker.js exists to produce. A finite probability outside [0, 1]
      // is still a defect.
      const tested = !Number.isNaN(p);
      if (tested && (!Number.isFinite(p) || p < 0 || p > 1)) {
        throw new RangeError(
          `Marker worker p-value for "${gene}" group "${groups[g].groupId}" must be finite and between 0 and 1`
        );
      }
      if (
        !Number.isFinite(percentInGroup[g]) ||
        !Number.isFinite(percentOutGroup[g]) ||
        percentInGroup[g] < 0 ||
        percentInGroup[g] > 100 ||
        percentOutGroup[g] < 0 ||
        percentOutGroup[g] > 100 ||
        nIn[g] + nOut[g] !== nAll
      ) {
        throw new RangeError(
          `Marker worker returned malformed statistics for "${gene}" group "${groups[g].groupId}"`
        );
      }
      // A tested group compared at least two measured cells against at least two
      // others, so its means and its fold change exist. Requiring them only for
      // tested groups keeps the check strict where it can be.
      if (
        tested &&
        (
          !Number.isFinite(fc) ||
          !Number.isFinite(meanInGroup[g]) ||
          !Number.isFinite(meanOutGroup[g])
        )
      ) {
        throw new RangeError(
          `Marker worker returned a tested group without a fold change for "${gene}" group "${groups[g].groupId}"`
        );
      }
      pValuesByGroup[g][geneIndex] = p;
      log2FCByGroup[g][geneIndex] = fc;

      // An untested gene has no rank, so it never competes for a Top-N slot.
      if (!tested) continue;

      heaps[g].push({
        gene,
        geneIndex,
        groupId: groups[g].groupId,
        pValue: p,
        adjustedPValue: null,
        log2FoldChange: fc,
        meanInGroup: meanInGroup[g],
        meanOutGroup: meanOutGroup[g],
        percentInGroup: percentInGroup[g],
        percentOutGroup: percentOutGroup[g],
        nIn: nIn[g],
        nOut: nOut[g]
      });
    }
  }

  _buildMarkersFromHeaps({ groups, heaps, adjustedByGroup, correctionByGroup = null, pValueThreshold, foldChangeThreshold, useAdjustedPValue }) {
    const out = {};
    if (correctionByGroup !== null && !Array.isArray(correctionByGroup)) {
      throw new TypeError(
        'Marker correction counts must be one record per group'
      );
    }

    for (let g = 0; g < groups.length; g++) {
      const group = groups[g];
      const items = heaps[g].toArray();

      for (const item of items) {
        if (adjustedByGroup !== null) {
          if (
            !Array.isArray(adjustedByGroup) ||
            !(adjustedByGroup[g] instanceof Float64Array)
          ) {
            throw new TypeError(
              'Adjusted marker p-values must contain one Float64Array per group'
            );
          }
          const adj = adjustedByGroup[g][item.geneIndex];
          if (!Number.isFinite(adj) || adj < 0 || adj > 1) {
            throw new RangeError(
              `Adjusted marker p-value is invalid for "${item.gene}"`
            );
          }
          item.adjustedPValue = adj;
        }
      }
      if (useAdjustedPValue && adjustedByGroup === null) {
        throw new Error(
          'Adjusted marker filtering requires adjusted p-values'
        );
      }

      // The significance threshold is inclusive: a gene is significant when
      // p <= threshold. That is the rule the Benjamini-Hochberg step-up itself
      // uses (reject the k largest ranks with p(k) <= k*alpha/m, so an adjusted
      // value of exactly alpha is a rejection), and `benjaminiHochberg` reports
      // `significant` on the same comparison. An exact test on discrete data
      // reaches the boundary exactly - Fisher and the exact Mann-Whitney both
      // produce 0.05 on small tables - so the two conventions did not merely
      // differ in principle.
      const pKey = useAdjustedPValue ? 'adjustedPValue' : 'pValue';
      const filtered = items.filter((m) => {
        const p = m[pKey];
        if (!Number.isFinite(p)) return false;
        if (p > pValueThreshold) return false;
        return Math.abs(m.log2FoldChange) >= foldChangeThreshold;
      });

      filtered.sort((a, b) => {
        const pa = useAdjustedPValue ? a.adjustedPValue : a.pValue;
        const pb = useAdjustedPValue ? b.adjustedPValue : b.pValue;
        if (pa !== pb) return pa - pb;
        const effectOrder =
          Math.abs(b.log2FoldChange) - Math.abs(a.log2FoldChange);
        if (effectOrder !== 0) return effectOrder;
        if (a.geneIndex !== b.geneIndex) return a.geneIndex - b.geneIndex;
        return a.gene.localeCompare(b.gene);
      });

      const markers = filtered.map((m, i) => ({
        gene: m.gene,
        groupId: group.groupId,
        rank: i + 1,
        pValue: m.pValue,
        adjustedPValue: m.adjustedPValue,
        log2FoldChange: m.log2FoldChange,
        meanInGroup: m.meanInGroup,
        meanOutGroup: m.meanOutGroup,
        percentInGroup: m.percentInGroup,
        percentOutGroup: m.percentOutGroup
      }));

      // `genesTested` is the Benjamini-Hochberg denominator this group's
      // adjusted p-values were divided by, and `genesUntestable` is the rest of
      // the panel: genes this group could not be compared on because too few of
      // its cells - or too few of the others - carried a measured value. They
      // are reported separately so the FDR can be reconstructed, and so a group
      // that produced no markers can say whether that was an answer or a
      // shortage of data. A partial emission has not corrected anything yet, so
      // it declares neither.
      const correction = correctionByGroup === null
        ? null
        : correctionByGroup[g];
      if (
        correction !== null &&
        (
          correction === undefined ||
          !Number.isSafeInteger(correction.testedCount) ||
          !Number.isSafeInteger(correction.untestableCount)
        )
      ) {
        throw new TypeError(
          `Marker correction counts are missing for group "${group.groupId}"`
        );
      }

      setOwnDataProperty(out, group.groupId, {
        groupId: group.groupId,
        groupName: group.groupName,
        cellCount: group.cellCount,
        color: group.color,
        genesTested: correction === null ? null : correction.testedCount,
        genesUntestable: correction === null ? null : correction.untestableCount,
        markers
      });
    }

    return out;
  }

}

export function createMarkerDiscoveryEngine(options) {
  return new MarkerDiscoveryEngine(options);
}

export default MarkerDiscoveryEngine;
