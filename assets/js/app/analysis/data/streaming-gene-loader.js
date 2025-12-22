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

/** Default configuration for streaming loader */
const DEFAULTS = {
  /** Maximum genes to buffer in memory */
  maxBufferSize: 100,
  /** Number of concurrent network requests */
  networkConcurrency: 6,
  /** Interval to check memory pressure (ms) */
  memoryCheckIntervalMs: 5000,
  /** Reduce buffer when under memory pressure */
  pressureBufferReduction: 0.5,
  /** Minimum buffer size even under pressure */
  minBufferSize: 10
};

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
   * @param {Function} [options.onGeneLoaded] - Callback when a gene is loaded
   * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
   */
  constructor(options) {
    const { dataLayer, config = {}, onProgress, onGeneLoaded, signal } = options;

    if (!dataLayer) {
      throw new Error('[StreamingGeneLoader] dataLayer is required');
    }

    /** @type {Object} DataLayer instance */
    this.dataLayer = dataLayer;

    /** @type {Function|null} Progress callback */
    this.onProgress = onProgress || null;

    /** @type {Function|null} Gene loaded callback */
    this.onGeneLoaded = onGeneLoaded || null;

    /** @type {AbortSignal|null} Abort signal */
    this.signal = signal || null;

    // Configuration (merge with performance config)
    const perfConfig = getPerformanceConfig();
    /** @type {number} Network concurrency */
    this._networkConcurrency = config.networkConcurrency || perfConfig.batch.networkConcurrency || DEFAULTS.networkConcurrency;
    /** @type {number} Memory budget in MB */
    this._memoryBudgetMB = config.memoryBudgetMB || perfConfig.memory.defaultBudgetMB;
    /** @type {number} Configured preload count */
    this._configuredPreloadCount = config.preloadCount || perfConfig.batch.defaultPreloadCount || DEFAULTS.maxBufferSize;
    /** @type {number} Max buffer size (will be recalculated based on memory budget) */
    this._maxBufferSize = this._configuredPreloadCount;
    /** @type {number} Estimated bytes per gene (updated during loading) */
    this._bytesPerGene = 0;
    /** @type {number} Total cells in dataset (for memory estimation) */
    this._totalCells = dataLayer?.state?.pointCount || 0;

    // Internal state
    /** @type {Map<string, Float32Array|null>} Loaded gene data buffer */
    this._buffer = new Map();
    /** @type {Set<string>} Currently loading genes */
    this._loadingGenes = new Set();
    /**
     * Genes that have been ensured-loaded in the DataLayer during this run.
     * Used to guarantee best-effort unloading on abort/error to avoid leaking
     * large var-field buffers across runs.
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
    /** @type {Map<string, Function[]>} Waiting resolvers for genes */
    this._waitingFor = new Map();

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
    if (!geneList || geneList.length === 0) {
      return;
    }

    // Increment run ID to invalidate any stale callbacks from previous runs
    this._runId++;
    const currentRunId = this._runId;

    // Initialize - full state reset
    this._stats.startTime = performance.now();
    this._stats.genesLoaded = 0;
    this._stats.genesFailed = 0;
    this._stats.bytesLoaded = 0;
    this._stats.endTime = null;
    this._aborted = false;
    this._buffer.clear();
    this._loadingGenes.clear();
    // Defensive: previous runs should clean this, but ensure we don't leak in edge cases.
    this._releaseAllLoadedGenes();
    this._loadedGenes.clear();
    this._loadQueue = [...geneList];

    // Calculate memory-aware buffer size
    this._recalculateBufferSize();
    this._effectiveBufferSize = this._maxBufferSize;

    // Clear any waiting resolvers from previous runs
    for (const resolvers of this._waitingFor.values()) {
      resolvers.forEach(resolve => resolve(null));
    }
    this._waitingFor.clear();

    // Unsubscribe from previous run's memory pressure listener if exists
    if (this._pressureUnsubscribe) {
      this._pressureUnsubscribe();
      this._pressureUnsubscribe = null;
    }

    // Subscribe to memory pressure
    this._pressureUnsubscribe = this._memoryMonitor.onMemoryPressure(this._handleMemoryPressure);

    debug('StreamingGeneLoader', `Starting run ${currentRunId}: ${geneList.length} genes, buffer=${this._maxBufferSize}, network=${this._networkConcurrency}`);

    // Set up abort listener
    if (this.signal) {
      this.signal.addEventListener('abort', () => this._abort(), { once: true });
    }

    try {
      // Start initial prefetch
      this._startPrefetch();

      // Process genes one by one
      for (let i = 0; i < geneList.length; i++) {
        if (this._aborted) {
          debug('StreamingGeneLoader', 'Aborted, stopping iteration');
          break;
        }

        const gene = geneList[i];

        // Wait for this gene to be loaded
        const values = await this._waitForGene(gene);

        if (values === null) {
          // Gene failed to load, skip it
          debugWarn('StreamingGeneLoader', `Skipping failed gene: ${gene}`);
          continue;
        }

        // Gather values for each group
        let valuesA, valuesB;

        if (groupA.isRestOf || groupA.excludedCellIndices) {
          valuesA = gatherComplementFloat32(values, groupA.excludedCellIndices || []);
        } else {
          valuesA = gatherFloat32(values, groupA.cellIndices || []);
        }

        if (groupB.isRestOf || groupB.excludedCellIndices) {
          valuesB = gatherComplementFloat32(values, groupB.excludedCellIndices || []);
        } else {
          valuesB = gatherFloat32(values, groupB.cellIndices || []);
        }

        // Remove from buffer to free memory
        this._buffer.delete(gene);

        // Unload gene from DataLayer to free memory (best-effort).
        this._releaseGene(gene);

        // Report progress
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

        // Continue prefetching
        this._startPrefetch();

        // Yield to event loop periodically
        if (i > 0 && i % 25 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    } finally {
      // Mark the run as stopped so in-flight loads don't repopulate buffers after cleanup.
      this._aborted = true;
      // Cleanup
      this._stats.endTime = performance.now();

      if (this._pressureUnsubscribe) {
        this._pressureUnsubscribe();
        this._pressureUnsubscribe = null;
      }

      // Notify any remaining waiters
      for (const resolvers of this._waitingFor.values()) {
        resolvers.forEach(resolve => resolve(null));
      }
      this._waitingFor.clear();

      // Clear any remaining buffered data
      this._buffer.clear();
      this._loadQueue = [];
      this._loadingGenes.clear();
      // Best-effort unload any genes that were loaded but not released (abort/errors/in-flight loads).
      this._releaseAllLoadedGenes();

      const duration = (this._stats.endTime - this._stats.startTime) / 1000;
      const genesPerSec = this._stats.genesLoaded / duration;
      debug('StreamingGeneLoader', `Run ${currentRunId} completed: ${this._stats.genesLoaded} loaded, ${this._stats.genesFailed} failed, ${duration.toFixed(1)}s (${genesPerSec.toFixed(1)} genes/s)`);
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
    if (!geneList || geneList.length === 0) {
      return;
    }

    // Increment run ID to invalidate any stale callbacks from previous runs
    this._runId++;
    const currentRunId = this._runId;

    // Initialize - full state reset
    this._stats.startTime = performance.now();
    this._stats.genesLoaded = 0;
    this._stats.genesFailed = 0;
    this._stats.bytesLoaded = 0;
    this._stats.endTime = null;
    this._aborted = false;
    this._buffer.clear();
    this._loadingGenes.clear();
    this._releaseAllLoadedGenes();
    this._loadedGenes.clear();
    this._loadQueue = [...geneList];

    // Calculate memory-aware buffer size
    this._recalculateBufferSize();
    this._effectiveBufferSize = this._maxBufferSize;

    // Clear any waiting resolvers from previous runs
    for (const resolvers of this._waitingFor.values()) {
      resolvers.forEach(resolve => resolve(null));
    }
    this._waitingFor.clear();

    // Unsubscribe from previous run's memory pressure listener if exists
    if (this._pressureUnsubscribe) {
      this._pressureUnsubscribe();
      this._pressureUnsubscribe = null;
    }

    // Subscribe to memory pressure
    this._pressureUnsubscribe = this._memoryMonitor.onMemoryPressure(this._handleMemoryPressure);

    debug('StreamingGeneLoader', `Starting raw run ${currentRunId}: ${geneList.length} genes, buffer=${this._maxBufferSize}, network=${this._networkConcurrency}`);

    // Set up abort listener
    if (this.signal) {
      this.signal.addEventListener('abort', () => this._abort(), { once: true });
    }

    try {
      // Start initial prefetch
      this._startPrefetch();

      for (let i = 0; i < geneList.length; i++) {
        if (this._aborted) {
          debug('StreamingGeneLoader', 'Aborted, stopping raw iteration');
          break;
        }

        const gene = geneList[i];
        const values = await this._waitForGene(gene);

        if (values === null) {
          debugWarn('StreamingGeneLoader', `Skipping failed gene: ${gene}`);
          continue;
        }

        // Remove from buffer to free memory
        this._buffer.delete(gene);

        // Unload gene from DataLayer to free memory (best-effort)
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

        // Continue prefetching
        this._startPrefetch();

        // Yield to event loop periodically
        if (i > 0 && i % 25 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    } finally {
      this._aborted = true;
      this._stats.endTime = performance.now();

      if (this._pressureUnsubscribe) {
        this._pressureUnsubscribe();
        this._pressureUnsubscribe = null;
      }

      for (const resolvers of this._waitingFor.values()) {
        resolvers.forEach(resolve => resolve(null));
      }
      this._waitingFor.clear();

      this._buffer.clear();
      this._loadQueue = [];
      this._loadingGenes.clear();
      this._releaseAllLoadedGenes();

      const duration = (this._stats.endTime - this._stats.startTime) / 1000;
      const genesPerSec = duration > 0 ? (this._stats.genesLoaded / duration) : 0;
      debug('StreamingGeneLoader', `Raw run ${currentRunId} completed: ${this._stats.genesLoaded} loaded, ${this._stats.genesFailed} failed, ${duration.toFixed(1)}s (${genesPerSec.toFixed(1)} genes/s)`);
    }
  }

  /**
   * Stream genes for multiple groups simultaneously
   *
   * Key optimization for marker discovery: download each gene ONCE,
   * extract values for ALL groups in a single pass. This is much more
   * efficient than calling streamGenes() multiple times.
   *
   * @param {string[]} geneList - List of gene names to process
   * @param {Object[]} groups - Array of group specifications
   * @param {string} groups[].groupId - Unique group identifier
   * @param {string} [groups[].groupName] - Display name for the group
   * @param {number[]|Uint32Array} [groups[].cellIndices] - Cell indices for explicit group
   * @param {number[]|Uint32Array} [groups[].excludedCellIndices] - Excluded indices for rest-of group
   * @param {boolean} [groups[].isRestOf=false] - Whether this is a rest-of group
   * @yields {{ gene: string, groupValues: Map<string, Float32Array>, index: number }}
   *
   * @example
   * const groups = [
   *   { groupId: 'cluster_0', cellIndices: [0, 1, 2, ...] },
   *   { groupId: 'cluster_1', cellIndices: [100, 101, ...] },
   *   { groupId: 'rest', excludedCellIndices: [0, 1, 2, 100, 101, ...], isRestOf: true }
   * ];
   *
   * for await (const { gene, groupValues, index } of loader.streamGenesMultiGroup(genes, groups)) {
   *   const cluster0Values = groupValues.get('cluster_0');
   *   const cluster1Values = groupValues.get('cluster_1');
   *   // Process all groups for this gene
   * }
   */
  async *streamGenesMultiGroup(geneList, groups) {
    if (!geneList || geneList.length === 0 || !groups || groups.length === 0) {
      return;
    }

    // Increment run ID to invalidate any stale callbacks from previous runs
    this._runId++;
    const currentRunId = this._runId;

    // Initialize - full state reset
    this._stats.startTime = performance.now();
    this._stats.genesLoaded = 0;
    this._stats.genesFailed = 0;
    this._stats.bytesLoaded = 0;
    this._stats.endTime = null;
    this._aborted = false;
    this._buffer.clear();
    this._loadingGenes.clear();
    this._releaseAllLoadedGenes();
    this._loadedGenes.clear();
    this._loadQueue = [...geneList];

    // Calculate memory-aware buffer size
    this._recalculateBufferSize();
    this._effectiveBufferSize = this._maxBufferSize;

    // Clear any waiting resolvers from previous runs
    for (const resolvers of this._waitingFor.values()) {
      resolvers.forEach(resolve => resolve(null));
    }
    this._waitingFor.clear();

    // Unsubscribe from previous run's memory pressure listener if exists
    if (this._pressureUnsubscribe) {
      this._pressureUnsubscribe();
      this._pressureUnsubscribe = null;
    }

    // Subscribe to memory pressure
    this._pressureUnsubscribe = this._memoryMonitor.onMemoryPressure(this._handleMemoryPressure);

    debug('StreamingGeneLoader', `Starting multi-group run ${currentRunId}: ${geneList.length} genes, ${groups.length} groups, buffer=${this._maxBufferSize}`);

    // Set up abort listener
    if (this.signal) {
      this.signal.addEventListener('abort', () => this._abort(), { once: true });
    }

    try {
      // Start initial prefetch
      this._startPrefetch();

      // Process genes one by one
      for (let i = 0; i < geneList.length; i++) {
        if (this._aborted) {
          debug('StreamingGeneLoader', 'Aborted, stopping multi-group iteration');
          break;
        }

        const gene = geneList[i];

        // Wait for this gene to be loaded
        const values = await this._waitForGene(gene);

        if (values === null) {
          // Gene failed to load, skip it
          debugWarn('StreamingGeneLoader', `Skipping failed gene: ${gene}`);
          continue;
        }

        // Gather values for ALL groups from the same gene data
        const groupValues = new Map();

        for (const group of groups) {
          let groupData;

          if (group.isRestOf || group.excludedCellIndices) {
            groupData = gatherComplementFloat32(values, group.excludedCellIndices || []);
          } else {
            groupData = gatherFloat32(values, group.cellIndices || []);
          }

          groupValues.set(group.groupId, groupData);
        }

        // Remove from buffer to free memory
        this._buffer.delete(gene);

        // Unload gene from DataLayer to free memory (best-effort)
        this._releaseGene(gene);

        // Report progress
        if (this.onProgress) {
          this.onProgress({
            loaded: i + 1,
            total: geneList.length,
            buffered: this._buffer.size,
            loading: this._loadingGenes.size,
            queued: this._loadQueue.length,
            groupCount: groups.length
          });
        }

        yield { gene, groupValues, index: i };

        // Continue prefetching
        this._startPrefetch();

        // Yield to event loop periodically
        if (i > 0 && i % 25 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    } finally {
      // Mark the run as stopped
      this._aborted = true;
      this._stats.endTime = performance.now();

      if (this._pressureUnsubscribe) {
        this._pressureUnsubscribe();
        this._pressureUnsubscribe = null;
      }

      // Notify any remaining waiters
      for (const resolvers of this._waitingFor.values()) {
        resolvers.forEach(resolve => resolve(null));
      }
      this._waitingFor.clear();

      // Clear any remaining buffered data
      this._buffer.clear();
      this._loadQueue = [];
      this._loadingGenes.clear();
      this._releaseAllLoadedGenes();

      const duration = (this._stats.endTime - this._stats.startTime) / 1000;
      const genesPerSec = this._stats.genesLoaded / duration;
      debug('StreamingGeneLoader', `Multi-group run ${currentRunId} completed: ${this._stats.genesLoaded} loaded, ${this._stats.genesFailed} failed, ${duration.toFixed(1)}s (${genesPerSec.toFixed(1)} genes/s)`);
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
    this._abort();
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

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
    const cellCount = this._totalCells || this.dataLayer?.state?.pointCount || 100000;
    const baseBytes = cellCount * 4;
    const overheadMultiplier = 6; // Conservative: raw + buffer + 2 gathers + worker copies
    const bytesPerGene = this._bytesPerGene > 0
      ? this._bytesPerGene
      : baseBytes * overheadMultiplier;

    const budgetBytes = this._memoryBudgetMB * 1024 * 1024;

    // Calculate max genes that fit in budget
    // Reserve 30% of budget for buffered gene data (keep 70% for compute + other app allocations)
    const bufferBudget = budgetBytes * 0.3;
    const maxByMemory = Math.max(DEFAULTS.minBufferSize, Math.floor(bufferBudget / bytesPerGene));

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
    const startingLoadCount = this._loadingGenes.size;

    while (
      this._loadQueue.length > 0 &&
      this._loadingGenes.size < this._networkConcurrency &&
      started < canPrefetch &&
      !this._aborted
    ) {
      const gene = this._loadQueue.shift();
      if (!this._buffer.has(gene) && !this._loadingGenes.has(gene)) {
        this._loadGene(gene);
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
   * Prune the prefetch buffer to the current effective size.
   *
   * Under memory pressure we drop buffered genes that haven't been consumed yet
   * (except genes that callers are actively waiting on).
   *
   * @private
   */
  _pruneBufferToEffectiveSize() {
    const targetSize = Math.max(DEFAULTS.minBufferSize, this._effectiveBufferSize);
    if (this._buffer.size <= targetSize) return;

    const protectedGenes = new Set(this._waitingFor.keys());

    for (const gene of this._buffer.keys()) {
      if (this._buffer.size <= targetSize) break;
      if (protectedGenes.has(gene)) continue;

      this._buffer.delete(gene);

      // Release dataset-level cached buffers for this gene (best-effort).
      try {
        this.dataLayer.unloadGeneExpression?.(gene, { preserveActive: true });
        this.dataLayer.invalidateVariable?.('gene_expression', gene);
      } catch (_err) {
        // Ignore pruning errors
      }
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
      const { values } = await this.dataLayer.ensureGeneExpressionLoaded(gene, { silent: true });
      // Track ownership of this loaded var-field so we can unload on abort/error.
      this._loadedGenes.add(gene);

      if (this._aborted) {
        // If we were aborted while a load was in-flight, ensure we do not leak this field.
        this._releaseGene(gene);
        // Still notify waiters so they don't hang.
        this._notifyWaiters(gene, null);
        return;
      }

      // Store in buffer (make a copy to allow dataLayer to manage its memory)
      // Note: ensureGeneExpressionLoaded returns a reference to the stored array
      // We don't copy here since gather operations will create new arrays anyway
      this._buffer.set(gene, values);

      this._stats.genesLoaded++;
      if (values?.byteLength) {
        this._stats.bytesLoaded += values.byteLength;

        // Update bytes per gene estimate and recalculate buffer size
        // Use running average for more accurate estimation
        // Multiply by 6 to account for: raw + buffer + gathers + worker copies
        const newBytesPerGene = values.byteLength * 6;
        if (this._bytesPerGene === 0) {
          this._bytesPerGene = newBytesPerGene;
        } else {
          // Weighted average: 80% current, 20% new (adapts to actual usage)
          this._bytesPerGene = Math.round(this._bytesPerGene * 0.8 + newBytesPerGene * 0.2);
        }

        // Recalculate buffer size periodically (every 10 genes)
        if (this._stats.genesLoaded % 10 === 0) {
          this._recalculateBufferSize();
          this._effectiveBufferSize = Math.min(this._effectiveBufferSize, this._maxBufferSize);
        }
      }

      if (this.onGeneLoaded) {
        this.onGeneLoaded({ gene, success: true });
      }

      // Notify anyone waiting for this gene
      this._notifyWaiters(gene, values);
    } catch (err) {
      debugWarn('StreamingGeneLoader', `Failed to load gene ${gene}:`, err.message);
      // Mark as failed (null) so waitForGene can skip it
      this._buffer.set(gene, null);
      this._stats.genesFailed++;

      if (this.onGeneLoaded) {
        this.onGeneLoaded({ gene, success: false, error: err.message });
      }

      // Notify waiters with null (failed)
      this._notifyWaiters(gene, null);
    } finally {
      this._loadingGenes.delete(gene);

      // Start next load if available
      if (!this._aborted) {
        this._startPrefetch();
      }
    }
  }

  /**
   * Notify all waiters for a gene
   * @param {string} gene - Gene name
   * @param {Float32Array|null} values - Loaded values or null if failed
   * @private
   */
  _notifyWaiters(gene, values) {
    const resolvers = this._waitingFor.get(gene);
    if (resolvers && resolvers.length > 0) {
      this._waitingFor.delete(gene);
      resolvers.forEach(resolve => resolve(values));
    }
  }

  /**
   * Wait for a gene to be loaded
   * @param {string} gene - Gene name
   * @param {number} [timeoutMs=60000] - Timeout in milliseconds
   * @returns {Promise<Float32Array|null>}
   * @private
   */
  async _waitForGene(gene, timeoutMs = 60000) {
    // Already loaded?
    if (this._buffer.has(gene)) {
      return this._buffer.get(gene);
    }

    // If aborted, return null immediately
    if (this._aborted) {
      return null;
    }

    // Make sure it's being loaded - always trigger prefetch
    if (!this._loadingGenes.has(gene) && !this._buffer.has(gene)) {
      // Add to front of queue for priority loading
      const queueIndex = this._loadQueue.indexOf(gene);
      if (queueIndex > 0) {
        // Already in queue but not at front - move it to front
        this._loadQueue.splice(queueIndex, 1);
        this._loadQueue.unshift(gene);
      } else if (queueIndex < 0) {
        // Not in queue - add to front
        this._loadQueue.unshift(gene);
      }
    }

    // Always try to start prefetch - it will no-op if at capacity
    this._startPrefetch();

    // If still not in buffer, wait with promise-based notification
    if (!this._buffer.has(gene)) {
      let resolver = null;
      const waitPromise = new Promise((resolve) => {
        resolver = resolve;
        // Register this resolver
        if (!this._waitingFor.has(gene)) {
          this._waitingFor.set(gene, []);
        }
        this._waitingFor.get(gene).push(resolve);
      });

      // Race against timeout and abort
      let timeoutId = null;
      const timeoutPromise = new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          debugWarn('StreamingGeneLoader', `Timeout waiting for gene: ${gene}`);
          resolve(null);
        }, timeoutMs);
      });

      // Wait for either gene to load, timeout, or abort
      const result = await Promise.race([waitPromise, timeoutPromise]);

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      // Clean up this resolver if it didn't get called
      const resolvers = this._waitingFor.get(gene);
      if (resolvers) {
        const idx = resolver ? resolvers.indexOf(resolver) : -1;
        if (idx >= 0) resolvers.splice(idx, 1);
        if (resolvers.length === 0) this._waitingFor.delete(gene);
      }

      // If we got a result from the promise, use it; otherwise check buffer
      if (result !== undefined) {
        return result;
      }
    }

    return this._buffer.get(gene) ?? null;
  }

  /**
   * Handle memory pressure events
   * @param {Object} event - Memory pressure event
   * @private
   */
  _handleMemoryPressure(event) {
    const { level } = event;

    if (level === 'critical') {
      // Aggressive reduction - cut buffer to minimum
      this._effectiveBufferSize = DEFAULTS.minBufferSize;
      debugWarn('StreamingGeneLoader', 'Critical memory pressure - reducing buffer to minimum');

      // Proactively drop prefetched genes to free memory immediately.
      this._pruneBufferToEffectiveSize();
    } else if (level === 'cleanup' || level === 'warning') {
      // Moderate reduction
      this._effectiveBufferSize = Math.max(
        DEFAULTS.minBufferSize,
        Math.floor(this._maxBufferSize * DEFAULTS.pressureBufferReduction)
      );
      this._pruneBufferToEffectiveSize();
      console.debug(`[StreamingGeneLoader] Memory pressure (${level}) - reducing buffer to ${this._effectiveBufferSize}`);
    } else {
      // Normal - restore full buffer size
      this._effectiveBufferSize = this._maxBufferSize;
    }
  }

  /**
   * Abort the loading operation
   * @private
   */
  _abort() {
    this._aborted = true;
    this._loadQueue = [];

    // Notify all waiters so they don't hang
    for (const [gene, resolvers] of this._waitingFor.entries()) {
      resolvers.forEach(resolve => resolve(null));
    }
    this._waitingFor.clear();

    // Proactively release any prefetched genes that haven't been consumed yet.
    // (Prevents large var-field arrays from remaining pinned in DataLayer/state after abort.)
    for (const gene of this._buffer.keys()) {
      this._releaseGene(gene);
    }
    this._buffer.clear();

    // Also best-effort release anything we loaded during this run.
    this._releaseAllLoadedGenes();

    console.debug('[StreamingGeneLoader] Aborted');
  }

  /**
   * Best-effort release of a single gene's var-field buffers from DataLayer/state.
   * @param {string} gene
   * @private
   */
  _releaseGene(gene) {
    if (!gene) return;

    try {
      const unloaded = this.dataLayer.unloadGeneExpression?.(gene, { preserveActive: true });
      this.dataLayer.invalidateVariable?.('gene_expression', gene);
      if (unloaded) {
        this._loadedGenes.delete(gene);
      }
    } catch (_err) {
      // Ignore release failures
    }
  }

  /**
   * Best-effort release of any genes ensured-loaded during this run.
   * @private
   */
  _releaseAllLoadedGenes() {
    if (!this._loadedGenes || this._loadedGenes.size === 0) return;

    const genes = Array.from(this._loadedGenes);
    for (const gene of genes) {
      this._releaseGene(gene);
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

// =============================================================================
// BATCH LOAD HELPER
// =============================================================================

/**
 * Load genes in batches with configurable parallelism
 *
 * Simpler alternative to streaming when you need all genes loaded
 * before processing begins.
 *
 * @param {Object} options
 * @param {Object} options.dataLayer - DataLayer instance
 * @param {string[]} options.geneList - Genes to load
 * @param {number} [options.batchSize=20] - Genes per batch
 * @param {number} [options.concurrency=6] - Parallel loads within batch
 * @param {Function} [options.onProgress] - Progress callback
 * @param {AbortSignal} [options.signal] - Abort signal
 * @returns {Promise<Map<string, Float32Array>>} Map of gene name to values
 */
export async function loadGenesBatch(options) {
  const {
    dataLayer,
    geneList,
    batchSize = 20,
    concurrency = 6,
    onProgress,
    signal
  } = options;

  const results = new Map();
  let loaded = 0;
  const total = geneList.length;

  for (let i = 0; i < geneList.length; i += batchSize) {
    if (signal?.aborted) break;

    const batch = geneList.slice(i, i + batchSize);

    // Load batch with concurrency limit
    const loadPromises = [];
    for (let j = 0; j < batch.length; j += concurrency) {
      const concurrent = batch.slice(j, j + concurrency);

      const concurrentResults = await Promise.all(
        concurrent.map(async (gene) => {
          try {
            const { values } = await dataLayer.ensureGeneExpressionLoaded(gene, { silent: true });
            return { gene, values, success: true };
          } catch (err) {
            return { gene, values: null, success: false, error: err.message };
          }
        })
      );

      for (const result of concurrentResults) {
        if (result.success) {
          results.set(result.gene, result.values);
        }
        loaded++;
      }

      if (onProgress) {
        onProgress({ loaded, total, batch: Math.floor(i / batchSize) + 1 });
      }
    }
  }

  return results;
}

export default StreamingGeneLoader;
