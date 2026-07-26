/**
 * Streaming Gene Loader
 *
 * Prefetches genes in batches while streaming them to consumers.
 * Implements a producer-consumer pattern with configurable buffer size
 * and network concurrency for optimal throughput.
 *
 * Key Features:
 * - Parallel network requests for gene loading
 * - Memory-bounded prefetch buffer
 * - Streaming iteration (yields genes as they become available)
 * - Automatic cleanup of processed genes
 * - Abort support for cancellation
 * - Memory pressure awareness
 *
 * @module data/streaming-gene-loader
 */

import { getPerformanceConfig } from '../shared/performance-config.js';
import { gatherFloat32, gatherComplementFloat32 } from '../shared/typed-array-utils.js';
import { getMemoryMonitor } from '../shared/memory-monitor.js';
import { debug, debugWarn } from '../shared/debug-utils.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Fixed streaming policy; configuration defaults live in PerformanceConfig. */
const STREAMING_POLICY = {
  /** Reduce buffer when under memory pressure */
  pressureBufferReduction: 0.5,
};

function requirePositiveInteger(value, owner) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${owner} must be a positive safe integer`);
  }
  return value;
}

function requirePositiveFinite(value, owner) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${owner} must be a positive finite number`);
  }
  return value;
}

function requireOptionalFunction(value, owner) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'function') {
    throw new TypeError(`${owner} must be a function when provided`);
  }
  return value;
}

function requireGeneList(geneList) {
  if (!Array.isArray(geneList)) {
    throw new TypeError('Streaming geneList must be an array');
  }
  const seen = new Set();
  for (const gene of geneList) {
    if (
      typeof gene !== 'string' ||
      gene.length === 0 ||
      gene !== gene.trim()
    ) {
      throw new TypeError('Every streamed gene must be one exact non-empty string');
    }
    if (seen.has(gene)) {
      throw new TypeError(`Streaming geneList contains duplicate gene "${gene}"`);
    }
    seen.add(gene);
  }
  return geneList;
}

function requireIndexCollection(indices, owner, valueCount, { sorted = false } = {}) {
  if (
    indices === null ||
    indices === undefined ||
    !Number.isSafeInteger(indices.length) ||
    indices.length < 0
  ) {
    throw new TypeError(`${owner} must be an array-like index collection`);
  }
  let previous = -1;
  const seen = sorted ? null : new Set();
  for (let index = 0; index < indices.length; index++) {
    const cellIndex = indices[index];
    if (
      !Number.isSafeInteger(cellIndex) ||
      cellIndex < 0 ||
      cellIndex >= valueCount
    ) {
      throw new RangeError(`${owner}[${index}] is outside the gene value range`);
    }
    if (sorted && cellIndex <= previous) {
      throw new TypeError(`${owner} must contain sorted unique cell indices`);
    }
    if (!sorted && seen.has(cellIndex)) {
      throw new TypeError(`${owner} must contain unique cell indices`);
    }
    seen?.add(cellIndex);
    previous = cellIndex;
  }
  return indices;
}

// =============================================================================
// STREAMING GENE LOADER CLASS
// =============================================================================

/**
 * Streaming Gene Loader
 *
 * Efficiently loads genes by prefetching batches in parallel while streaming
 * them to the consumer. Uses a bounded buffer to control memory usage.
 *
 * @example
 * const loader = new StreamingGeneLoader({
 *   dataLayer,
 *   config: { preloadCount: 100, networkConcurrency: 6 }
 * });
 *
 * for await (const { gene, valuesA, valuesB } of loader.streamGenes(genes, groupA, groupB)) {
 *   const result = await computeDifferential(valuesA, valuesB);
 *   results.push({ gene, ...result });
 * }
 */
export class StreamingGeneLoader {
  /**
   * Create a new StreamingGeneLoader
   *
   * @param {Object} options
   * @param {Object} options.dataLayer - DataLayer instance for loading genes
   * @param {Object} [options.config] - Configuration overrides
   * @param {number} [options.config.preloadCount] - Max genes to prefetch
   * @param {number} [options.config.networkConcurrency] - Parallel requests
   * @param {number} [options.config.memoryBudgetMB] - Memory budget
   * @param {Function} [options.onProgress] - Progress callback
   * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
  */
  constructor(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('[StreamingGeneLoader] options must be an object');
    }
    const {
      dataLayer,
      config = {},
      onProgress,
      signal,
    } = options;

    if (
      !dataLayer ||
      typeof dataLayer.ensureGeneExpressionLoaded !== 'function' ||
      typeof dataLayer.unloadGeneExpression !== 'function' ||
      typeof dataLayer.invalidateVariable !== 'function'
    ) {
      throw new TypeError(
        '[StreamingGeneLoader] dataLayer must implement exact gene load, unload, and invalidation methods'
      );
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new TypeError('[StreamingGeneLoader] config must be an object');
    }

    /** @type {Object} DataLayer instance */
    this.dataLayer = dataLayer;

    /** @type {Function|null} Progress callback */
    this.onProgress = requireOptionalFunction(onProgress, 'onProgress');

    /** @type {AbortSignal|null} Abort signal */
    this.signal = signal ?? null;
    if (
      this.signal !== null &&
      (
        typeof this.signal.aborted !== 'boolean' ||
        typeof this.signal.addEventListener !== 'function' ||
        typeof this.signal.removeEventListener !== 'function'
      )
    ) {
      throw new TypeError('signal must implement the AbortSignal contract');
    }

    // PerformanceConfig is the sole owner of omitted configuration values.
    const perfConfig = getPerformanceConfig();
    const networkConcurrency =
      config.networkConcurrency ?? perfConfig.batch.networkConcurrency;
    const memoryBudgetMB =
      config.memoryBudgetMB ?? perfConfig.memory.defaultBudgetMB;
    const preloadCount =
      config.preloadCount ?? perfConfig.batch.defaultPreloadCount;
    /** @type {number} Network concurrency */
    this._networkConcurrency = requirePositiveInteger(
      networkConcurrency,
      'networkConcurrency'
    );
    /** @type {number} Memory budget in MB */
    this._memoryBudgetMB = requirePositiveFinite(
      memoryBudgetMB,
      'memoryBudgetMB'
    );
    /** @type {number} Configured preload count */
    this._configuredPreloadCount = requirePositiveInteger(
      preloadCount,
      'preloadCount'
    );
    /** @type {number} Minimum pressure-limited buffer size */
    this._minimumBufferSize = requirePositiveInteger(
      perfConfig.batch.minPreloadCount,
      'PerformanceConfig.batch.minPreloadCount'
    );
    /** @type {number} Max buffer size (will be recalculated based on memory budget) */
    this._maxBufferSize = this._configuredPreloadCount;
    /** @type {number} Estimated bytes per gene (updated during loading) */
    this._bytesPerGene = 0;
    /** @type {number} Total cells in dataset (for memory estimation) */
    this._totalCells = requirePositiveInteger(
      dataLayer.state?.pointCount,
      'dataLayer.state.pointCount'
    );

    // Internal state
    /** @type {Map<string, Float32Array>} Loaded gene data buffer */
    this._buffer = new Map();
    /** @type {Map<string, unknown>} Exact failures from gene loading */
    this._failures = new Map();
    /** @type {Set<string>} Currently loading genes */
    this._loadingGenes = new Set();
    /** @type {Set<Promise<void>>} Exact load tasks owned by the current run */
    this._inFlightLoads = new Set();
    /**
     * Genes that have been ensured-loaded in the DataLayer during this run.
     * Used to guarantee unloading on abort/error to avoid retaining large
     * var-field buffers across runs.
     * @type {Set<string>}
     */
    this._loadedGenes = new Set();
    /** @type {string[]} Queue of genes to load */
    this._loadQueue = [];
    /** @type {boolean} Whether streaming has been aborted */
    this._aborted = false;
    /** @type {number} Current effective buffer size (may reduce under pressure) */
    this._effectiveBufferSize = this._maxBufferSize;
    /** @type {number} Unique run ID to detect stale callbacks */
    this._runId = 0;
    /** @type {Map<string, Array<{resolve:Function,reject:Function}>>} */
    this._waitingFor = new Map();
    /** @type {unknown|null} Exact reason for the current abort */
    this._abortReason = null;
    /** @type {boolean} Whether one public stream owns this loader */
    this._running = false;

    // Memory monitor integration
    /** @type {Object} Memory monitor instance */
    this._memoryMonitor = getMemoryMonitor();
    /** @type {Function|null} Memory pressure unsubscribe function */
    this._pressureUnsubscribe = null;

    // Statistics
    /** @type {Object} Loading statistics */
    this._stats = {
      genesLoaded: 0,
      genesFailed: 0,
      bytesLoaded: 0,
      startTime: null,
      endTime: null
    };

    // Bind methods for use as callbacks
    this._handleMemoryPressure = this._handleMemoryPressure.bind(this);
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Stream genes as an async iterator
   *
   * Prefetches genes in batches while yielding them one at a time.
   * Handles both explicit cell indices and "rest-of" complement groups.
   *
   * @param {string[]} geneList - List of gene names to process
   * @param {Object} groupA - Group A specification
   * @param {number[]|Uint32Array} [groupA.cellIndices] - Cell indices for explicit group
   * @param {number[]|Uint32Array} [groupA.excludedCellIndices] - Excluded indices for rest-of group
   * @param {boolean} [groupA.isRestOf=false] - Whether this is a rest-of group
   * @param {Object} groupB - Group B specification (same format as groupA)
   * @yields {{ gene: string, valuesA: Float32Array, valuesB: Float32Array, index: number }}
   *
   * @example
   * for await (const { gene, valuesA, valuesB, index } of loader.streamGenes(genes, groupA, groupB)) {
   *   // Process gene
   * }
  */
  async *streamGenes(geneList, groupA, groupB) {
    requireGeneList(geneList);
    if (geneList.length === 0) return;
    const currentRunId = this._beginRun(geneList, 'grouped');
    const abortSignal = this.signal;
    const abortHandler = abortSignal
      ? () => this._abort(abortSignal.reason)
      : null;
    if (abortSignal && abortHandler) {
      abortSignal.addEventListener('abort', abortHandler, { once: true });
      if (abortSignal.aborted) this._abort(abortSignal.reason);
    }

    let hasPrimaryError = false;
    let primaryError;
    try {
      this._startPrefetch();

      for (let i = 0; i < geneList.length; i++) {
        this._throwIfAborted();

        const gene = geneList[i];
        const values = await this._waitForGene(gene);
        const valuesA = this._gatherGroupValues(values, groupA, 'groupA');
        const valuesB = this._gatherGroupValues(values, groupB, 'groupB');

        this._buffer.delete(gene);
        this._releaseGene(gene);

        if (this.onProgress) {
          this.onProgress({
            loaded: i + 1,
            total: geneList.length,
            buffered: this._buffer.size,
            loading: this._loadingGenes.size,
            queued: this._loadQueue.length
          });
        }

        yield { gene, valuesA, valuesB, index: i };

        this._startPrefetch();

        if (i > 0 && i % 25 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    } catch (error) {
      hasPrimaryError = true;
      primaryError = error;
    } finally {
      let cleanupError;
      try {
        await this._finishRun(currentRunId, abortSignal, abortHandler, 'grouped');
      } catch (error) {
        cleanupError = error;
      }
      if (hasPrimaryError && cleanupError !== undefined) {
        throw new AggregateError(
          [primaryError, cleanupError],
          'Streaming gene analysis and cleanup both failed'
        );
      }
      if (hasPrimaryError) throw primaryError;
      if (cleanupError !== undefined) throw cleanupError;
    }
  }

  /**
   * Stream raw per-cell gene values (no group extraction).
   *
   * This is the lowest-level streaming primitive and is ideal when downstream
   * computation wants to operate on the full per-cell vector (e.g., multi-group
   * marker discovery in a worker) without allocating per-group extracted arrays.
   *
   * IMPORTANT:
   * - The yielded `values` array is backed by DataLayer's internal var-field buffer.
   * - Do NOT transfer its ArrayBuffer to a Worker (it would detach and break DataLayer).
   * - If you need to compute in a Worker, make a copy first: `new Float32Array(values)`.
   *
   * @param {string[]} geneList
   * @yields {{ gene: string, values: Float32Array, index: number }}
  */
  async *streamGenesRaw(geneList) {
    requireGeneList(geneList);
    if (geneList.length === 0) return;
    const currentRunId = this._beginRun(geneList, 'raw');
    const abortSignal = this.signal;
    const abortHandler = abortSignal
      ? () => this._abort(abortSignal.reason)
      : null;
    if (abortSignal && abortHandler) {
      abortSignal.addEventListener('abort', abortHandler, { once: true });
      if (abortSignal.aborted) this._abort(abortSignal.reason);
    }

    let hasPrimaryError = false;
    let primaryError;
    try {
      this._startPrefetch();

      for (let i = 0; i < geneList.length; i++) {
        this._throwIfAborted();

        const gene = geneList[i];
        const values = await this._waitForGene(gene);

        this._buffer.delete(gene);
        this._releaseGene(gene);

        if (this.onProgress) {
          this.onProgress({
            loaded: i + 1,
            total: geneList.length,
            buffered: this._buffer.size,
            loading: this._loadingGenes.size,
            queued: this._loadQueue.length
          });
        }

        yield { gene, values, index: i };

        this._startPrefetch();

        if (i > 0 && i % 25 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    } catch (error) {
      hasPrimaryError = true;
      primaryError = error;
    } finally {
      let cleanupError;
      try {
        await this._finishRun(currentRunId, abortSignal, abortHandler, 'raw');
      } catch (error) {
        cleanupError = error;
      }
      if (hasPrimaryError && cleanupError !== undefined) {
        throw new AggregateError(
          [primaryError, cleanupError],
          'Streaming gene analysis and cleanup both failed'
        );
      }
      if (hasPrimaryError) throw primaryError;
      if (cleanupError !== undefined) throw cleanupError;
    }
  }

  /**
   * Get loading statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    const duration = this._stats.endTime && this._stats.startTime
      ? this._stats.endTime - this._stats.startTime
      : (this._stats.startTime ? performance.now() - this._stats.startTime : 0);

    return {
      ...this._stats,
      durationMs: duration,
      durationFormatted: this._formatDuration(duration),
      genesPerSecond: duration > 0 ? (this._stats.genesLoaded / (duration / 1000)).toFixed(1) : null,
      bufferSize: this._buffer.size,
      loadingCount: this._loadingGenes.size,
      queuedCount: this._loadQueue.length
    };
  }

  /**
   * Abort the streaming operation
   */
  abort() {
    this._abort(new DOMException('Gene streaming was aborted', 'AbortError'));
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Establish sole ownership of one stream run.
   * @param {string[]} geneList
   * @param {'grouped'|'raw'} mode
   * @returns {number}
   * @private
   */
  _beginRun(geneList, mode) {
    if (this._running) {
      throw new Error('StreamingGeneLoader supports exactly one active stream');
    }
    if (
      this._waitingFor.size !== 0 ||
      this._inFlightLoads.size !== 0 ||
      this._pressureUnsubscribe !== null
    ) {
      throw new Error('StreamingGeneLoader retained unfinished state from a previous run');
    }
    this._releaseAllLoadedGenes();

    this._running = true;
    this._runId += 1;
    const currentRunId = this._runId;
    this._stats.startTime = performance.now();
    this._stats.genesLoaded = 0;
    this._stats.genesFailed = 0;
    this._stats.bytesLoaded = 0;
    this._stats.endTime = null;
    this._aborted = false;
    this._abortReason = null;
    this._buffer.clear();
    this._failures.clear();
    this._loadingGenes.clear();
    this._loadedGenes.clear();
    this._loadQueue = [...geneList];
    this._recalculateBufferSize();
    this._effectiveBufferSize = this._maxBufferSize;

    try {
      this._pressureUnsubscribe =
        this._memoryMonitor.onMemoryPressure(this._handleMemoryPressure);
      if (typeof this._pressureUnsubscribe !== 'function') {
        throw new TypeError(
          'MemoryMonitor.onMemoryPressure must return an unsubscribe function'
        );
      }
    } catch (error) {
      this._pressureUnsubscribe = null;
      this._running = false;
      throw error;
    }

    debug(
      'StreamingGeneLoader',
      `Starting ${mode} run ${currentRunId}: ${geneList.length} genes, ` +
        `buffer=${this._maxBufferSize}, network=${this._networkConcurrency}`
    );
    return currentRunId;
  }

  /**
   * Settle all work and release every resource owned by a run.
   * @param {number} currentRunId
   * @param {AbortSignal|null} abortSignal
   * @param {Function|null} abortHandler
   * @param {'grouped'|'raw'} mode
   * @returns {Promise<void>}
   * @private
   */
  async _finishRun(currentRunId, abortSignal, abortHandler, mode) {
    const errors = [];
    this._aborted = true;
    this._loadQueue = [];

    if (abortSignal && abortHandler) {
      try {
        abortSignal.removeEventListener('abort', abortHandler);
      } catch (error) {
        errors.push(error);
      }
    }

    const unsubscribe = this._pressureUnsubscribe;
    this._pressureUnsubscribe = null;
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch (error) {
        errors.push(error);
      }
    }

    this._rejectAllWaiters(
      this._abortReason ??
        new Error('Streaming gene run ended before a requested gene settled')
    );

    try {
      await Promise.all(this._inFlightLoads);
    } catch (error) {
      errors.push(error);
    }
    this._inFlightLoads.clear();

    this._buffer.clear();
    this._failures.clear();
    this._loadingGenes.clear();
    try {
      this._releaseAllLoadedGenes();
    } catch (error) {
      errors.push(error);
    }

    this._stats.endTime = performance.now();
    this._running = false;
    const duration = (this._stats.endTime - this._stats.startTime) / 1000;
    const genesPerSecond =
      duration > 0 ? this._stats.genesLoaded / duration : 0;
    debug(
      'StreamingGeneLoader',
      `${mode} run ${currentRunId} completed: ${this._stats.genesLoaded} loaded, ` +
        `${this._stats.genesFailed} failed, ${duration.toFixed(1)}s ` +
        `(${genesPerSecond.toFixed(1)} genes/s)`
    );

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `Streaming gene cleanup failed in ${errors.length} operations`
      );
    }
  }

  /**
   * @private
   */
  _throwIfAborted() {
    if (this._aborted) {
      throw this._abortReason ??
        new DOMException('Gene streaming was aborted', 'AbortError');
    }
  }

  /**
   * @param {Float32Array} values
   * @param {Object} group
   * @param {string} owner
   * @returns {Float32Array}
   * @private
   */
  _gatherGroupValues(values, group, owner) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      throw new TypeError(`${owner} must be a group specification object`);
    }
    if (typeof group.isRestOf !== 'boolean') {
      throw new TypeError(`${owner}.isRestOf must be exactly boolean`);
    }
    if (group.isRestOf) {
      if (group.cellIndices !== undefined) {
        throw new TypeError(
          `${owner} cannot define cellIndices when isRestOf is true`
        );
      }
      const excluded = requireIndexCollection(
        group.excludedCellIndices,
        `${owner}.excludedCellIndices`,
        values.length,
        { sorted: true }
      );
      return gatherComplementFloat32(values, excluded);
    }
    if (group.excludedCellIndices !== undefined) {
      throw new TypeError(
        `${owner} cannot define excludedCellIndices when isRestOf is false`
      );
    }
    const indices = requireIndexCollection(
      group.cellIndices,
      `${owner}.cellIndices`,
      values.length
    );
    return gatherFloat32(values, indices);
  }

  /**
   * Recalculate buffer size based on memory budget
   * @private
   */
  _recalculateBufferSize() {
    // Estimate bytes per gene: 4 bytes per cell (Float32)
    // Memory usage per gene includes:
    // - Raw data in state.varData.fields: cellCount × 4 bytes
    // - Buffer reference: cellCount × 4 bytes
    // - Gathered valuesA: ~cellCount × 4 bytes (subset)
    // - Gathered valuesB: ~cellCount × 4 bytes (subset)
    // - Worker thread copies: potentially 2x more
    // Conservative estimate: 6x base size
    const baseBytes = this._totalCells * 4;
    const overheadMultiplier = 6; // Conservative: raw + buffer + 2 gathers + worker copies
    const bytesPerGene = this._bytesPerGene > 0
      ? this._bytesPerGene
      : baseBytes * overheadMultiplier;

    const budgetBytes = this._memoryBudgetMB * 1024 * 1024;

    // Calculate max genes that fit in budget
    // Reserve 30% of budget for buffered gene data (keep 70% for compute + other app allocations)
    const bufferBudget = budgetBytes * 0.3;
    const maxByMemory = Math.max(
      this._minimumBufferSize,
      Math.floor(bufferBudget / bytesPerGene)
    );

    // Use the smaller of configured preload count and memory-limited count
    const oldBufferSize = this._maxBufferSize;
    this._maxBufferSize = Math.min(this._configuredPreloadCount, maxByMemory);

    if (this._maxBufferSize !== oldBufferSize) {
      debug('StreamingGeneLoader', `Buffer size adjusted: ${oldBufferSize} -> ${this._maxBufferSize} (budget: ${this._memoryBudgetMB}MB, ~${(bytesPerGene / 1024 / 1024).toFixed(2)}MB/gene)`);
    }
  }

  /**
   * Start prefetching genes up to buffer limit
   * @private
   */
  _startPrefetch() {
    // Calculate how many more we can prefetch
    const currentLoad = this._buffer.size + this._loadingGenes.size;
    const canPrefetch = Math.max(0, this._effectiveBufferSize - currentLoad);

    // Start new loads up to network concurrency limit
    let started = 0;

    while (
      this._loadQueue.length > 0 &&
      this._loadingGenes.size < this._networkConcurrency &&
      started < canPrefetch &&
      !this._aborted
    ) {
      const gene = this._loadQueue.shift();
      if (
        !this._buffer.has(gene) &&
        !this._failures.has(gene) &&
        !this._loadingGenes.has(gene)
      ) {
        const loadTask = this._loadGene(gene);
        this._inFlightLoads.add(loadTask);
        void loadTask.then(
          () => {
            this._inFlightLoads.delete(loadTask);
          },
          error => {
            this._inFlightLoads.delete(loadTask);
            this._stats.genesFailed++;
            this._failures.set(gene, error);
            this._rejectGeneWaiters(gene, error);
          }
        );
        started++;
      }
    }

    // Log periodically to help diagnose performance issues
    if (this._stats.genesLoaded > 0 && this._stats.genesLoaded % 100 === 0) {
      const elapsed = (performance.now() - this._stats.startTime) / 1000;
      const rate = this._stats.genesLoaded / elapsed;
      debug('StreamingGeneLoader', `Progress: ${this._stats.genesLoaded} loaded (${rate.toFixed(1)}/s), loading=${this._loadingGenes.size}, buffered=${this._buffer.size}, queued=${this._loadQueue.length}`);
    }
  }

  /**
   * Load a single gene
   * @param {string} gene - Gene name
   * @private
   */
  async _loadGene(gene) {
    if (this._aborted) return;

    this._loadingGenes.add(gene);

    try {
      const result = await this.dataLayer.ensureGeneExpressionLoaded(
        gene,
        { silent: true }
      );
      const values = result?.values;
      this._loadedGenes.add(gene);
      if (!(values instanceof Float32Array)) {
        throw new TypeError(
          `Gene "${gene}" must load as one Float32Array`
        );
      }
      if (values.length !== this._totalCells) {
        throw new RangeError(
          `Gene "${gene}" has ${values.length} values; expected ${this._totalCells}`
        );
      }

      if (this._aborted) {
        return;
      }

      this._buffer.set(gene, values);
      this._stats.genesLoaded++;
      this._stats.bytesLoaded += values.byteLength;

      // The running estimate controls capacity only; it never changes data.
      const newBytesPerGene = values.byteLength * 6;
      this._bytesPerGene = this._bytesPerGene === 0
        ? newBytesPerGene
        : Math.round(this._bytesPerGene * 0.8 + newBytesPerGene * 0.2);
      if (this._stats.genesLoaded % 10 === 0) {
        this._recalculateBufferSize();
        this._effectiveBufferSize = Math.min(
          this._effectiveBufferSize,
          this._maxBufferSize
        );
      }

      this._resolveGeneWaiters(gene, values);
    } catch (error) {
      this._stats.genesFailed++;
      this._failures.set(gene, error);
      debugWarn('StreamingGeneLoader', `Failed to load gene ${gene}:`, error);
      this._rejectGeneWaiters(gene, error);
    } finally {
      this._loadingGenes.delete(gene);

      if (!this._aborted) {
        this._startPrefetch();
      }
    }
  }

  /**
   * Resolve all waiters for a gene.
   * @param {string} gene - Gene name
   * @param {Float32Array} values
   * @private
   */
  _resolveGeneWaiters(gene, values) {
    const waiters = this._waitingFor.get(gene);
    if (waiters && waiters.length > 0) {
      this._waitingFor.delete(gene);
      waiters.forEach(({ resolve }) => resolve(values));
    }
  }

  /**
   * Reject all waiters for one gene with the exact failure.
   * @param {string} gene
   * @param {unknown} error
   * @private
   */
  _rejectGeneWaiters(gene, error) {
    const waiters = this._waitingFor.get(gene);
    if (waiters && waiters.length > 0) {
      this._waitingFor.delete(gene);
      waiters.forEach(({ reject }) => reject(error));
    }
  }

  /**
   * Reject every outstanding waiter.
   * @param {unknown} error
   * @private
   */
  _rejectAllWaiters(error) {
    for (const [gene] of this._waitingFor) {
      this._rejectGeneWaiters(gene, error);
    }
  }

  /**
   * Wait for a gene to be loaded.
   * @param {string} gene - Gene name
   * @returns {Promise<Float32Array>}
   * @private
   */
  async _waitForGene(gene) {
    if (this._buffer.has(gene)) {
      return this._buffer.get(gene);
    }
    if (this._failures.has(gene)) {
      throw this._failures.get(gene);
    }
    this._throwIfAborted();

    if (
      !this._loadingGenes.has(gene) &&
      !this._loadQueue.includes(gene)
    ) {
      throw new Error(
        `Gene "${gene}" is not owned by the active streaming run`
      );
    }

    this._startPrefetch();
    if (this._buffer.has(gene)) return this._buffer.get(gene);
    if (this._failures.has(gene)) throw this._failures.get(gene);
    this._throwIfAborted();

    return new Promise((resolve, reject) => {
      if (!this._waitingFor.has(gene)) {
        this._waitingFor.set(gene, []);
      }
      this._waitingFor.get(gene).push({ resolve, reject });
    });
  }

  /**
   * Handle memory pressure events
   * @param {Object} event - Memory pressure event
   * @private
   */
  _handleMemoryPressure(event) {
    const level = event?.level;
    const pressureFloor = Math.min(
      this._minimumBufferSize,
      this._maxBufferSize
    );

    if (level === 'critical') {
      this._effectiveBufferSize = pressureFloor;
      debugWarn('StreamingGeneLoader', 'Critical memory pressure - reducing buffer to minimum');
    } else if (level === 'cleanup' || level === 'warning') {
      this._effectiveBufferSize = Math.max(
        pressureFloor,
        Math.floor(
          this._maxBufferSize * STREAMING_POLICY.pressureBufferReduction
        )
      );
      console.debug(`[StreamingGeneLoader] Memory pressure (${level}) - reducing buffer to ${this._effectiveBufferSize}`);
    } else if (level === 'normal' || level === 'unknown') {
      this._effectiveBufferSize = this._maxBufferSize;
    } else {
      throw new TypeError(`Unknown memory pressure level: ${String(level)}`);
    }
  }

  /**
   * Abort the loading operation
   * @private
   */
  _abort(reason) {
    const exactReason = reason === undefined
      ? new DOMException('Gene streaming was aborted', 'AbortError')
      : reason;
    this._aborted = true;
    this._abortReason = exactReason;
    this._loadQueue = [];
    this._rejectAllWaiters(exactReason);
    this._buffer.clear();
    console.debug('[StreamingGeneLoader] Aborted');
  }

  /**
   * Release one gene's var-field buffers from DataLayer/state.
   * @param {string} gene
   * @returns {boolean}
   * @private
   */
  _releaseGene(gene) {
    if (
      typeof gene !== 'string' ||
      gene.length === 0 ||
      gene !== gene.trim()
    ) {
      throw new TypeError('Released gene must be one exact non-empty string');
    }
    const errors = [];
    let unloaded = false;
    try {
      unloaded = this.dataLayer.unloadGeneExpression(
        gene,
        { preserveActive: true }
      );
      if (typeof unloaded !== 'boolean') {
        throw new TypeError(
          'DataLayer.unloadGeneExpression must return exactly boolean'
        );
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      this.dataLayer.invalidateVariable('gene_expression', gene);
    } catch (error) {
      errors.push(error);
    }
    this._loadedGenes.delete(gene);

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `Gene "${gene}" release failed in ${errors.length} operations`
      );
    }
    return unloaded;
  }

  /**
   * Release every gene ensured-loaded during this run.
   * @private
   */
  _releaseAllLoadedGenes() {
    if (!(this._loadedGenes instanceof Set)) {
      throw new TypeError('Loaded-gene ownership must be a Set');
    }
    if (this._loadedGenes.size === 0) return;

    const genes = Array.from(this._loadedGenes);
    const errors = [];
    for (const gene of genes) {
      try {
        this._releaseGene(gene);
      } catch (error) {
        errors.push(error);
      }
    }
    this._loadedGenes.clear();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `Releasing streamed genes failed in ${errors.length} operations`
      );
    }
  }

  /**
   * Format duration in human-readable form
   * @param {number} ms - Duration in milliseconds
   * @returns {string}
   * @private
   */
  _formatDuration(ms) {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs}s`;
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a StreamingGeneLoader instance
 *
 * @param {Object} options - Same options as StreamingGeneLoader constructor
 * @returns {StreamingGeneLoader}
 *
 * @example
 * const loader = createStreamingGeneLoader({
 *   dataLayer,
 *   config: { preloadCount: 100 },
 *   onProgress: (p) => console.log(`${p.loaded}/${p.total}`)
 * });
 */
export function createStreamingGeneLoader(options) {
  return new StreamingGeneLoader(options);
}

export default StreamingGeneLoader;
