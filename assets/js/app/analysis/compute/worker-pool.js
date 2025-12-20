/**
 * Worker Pool for Analysis Module
 *
 * Manages a pool of web workers for parallel computation.
 * Replaces single-threaded worker for improved performance on:
 * - Differential expression (parallelize across genes)
 * - Correlation matrices (parallelize pairwise computations)
 * - Large array statistics (chunk and combine)
 *
 * Features:
 * - Round-robin task distribution
 * - Automatic scaling based on hardware concurrency
 * - Request/response correlation via requestId
 * - Graceful fallback when workers unavailable
 * - Batch execution for related tasks
 */

import { executeFallback } from './fallback-operations.js';
import { filterFiniteNumbers } from '../shared/number-utils.js';
import { debug, debugWarn, debugError } from '../shared/debug-utils.js';

// Singleton instance
let poolInstance = null;

/**
 * WorkerPool class
 * Manages multiple web workers for parallel computation
 */
export class WorkerPool {
  /**
   * @param {Object} options
   * @param {number} [options.poolSize] - Number of workers (default: navigator.hardwareConcurrency or 4)
   * @param {number} [options.defaultTimeout] - Default timeout in ms (default: 30000)
   */
  constructor(options = {}) {
    this.poolSize = options.poolSize || Math.min(navigator.hardwareConcurrency || 4, 8);
    this.defaultTimeout = options.defaultTimeout || 30000;

    this.workers = [];
    this.workerStates = []; // 'idle' | 'busy'
    this.taskQueues = [];   // Per-worker task queues
    this.pendingRequests = new Map();
    this.requestIdCounter = 0;

    this.initialized = false;
    this.workersAvailable = typeof Worker !== 'undefined';

    // Round-robin counter for distribution
    this._nextWorkerIndex = 0;

    // Health monitoring
    this._healthCheckInterval = null;
    this._healthCheckIntervalMs = 30000; // Check every 30 seconds
    this._workerStuckThresholdMs = 60000; // Consider stuck after 60 seconds
    this._workerBusySince = []; // Track when each worker became busy

    // Bind methods
    this._handleMessage = this._handleMessage.bind(this);
    this._handleError = this._handleError.bind(this);
  }

  /**
   * Initialize the worker pool
   * @returns {Promise<boolean>} True if pool initialized successfully
   */
  async init() {
    if (this.initialized) return true;

    if (!this.workersAvailable) {
      debugWarn('WorkerPool', 'Web Workers not available, using main thread fallback');
      return false;
    }

    try {
      const workerPath = new URL('./data-worker.js', import.meta.url).href;

      for (let i = 0; i < this.poolSize; i++) {
        // Use { type: 'module' } since data-worker.js now uses ES module imports
        const worker = new Worker(workerPath, { type: 'module' });

        worker.onmessage = (e) => this._handleMessage(i, e);
        worker.onerror = (e) => this._handleError(i, e);

        // Initialize worker with its ID
        worker.postMessage({
          type: 'INIT',
          payload: { id: i, poolSize: this.poolSize }
        });

        this.workers.push(worker);
        this.workerStates.push('idle');
        this.taskQueues.push([]);
        this._workerBusySince.push(null);
      }

      this.initialized = true;
      debug('WorkerPool', `Initialized with ${this.poolSize} workers`);

      // Start health monitoring
      this._startHealthMonitoring();

      return true;

    } catch (error) {
      debugError('WorkerPool', 'Failed to initialize:', error);
      this.workersAvailable = false;
      return false;
    }
  }

  /**
   * Handle messages from workers
   */
  _handleMessage(workerIndex, event) {
    const { requestId, success, result, error } = event.data;

    // Handle init acknowledgment
    if (event.data.type === 'INIT_ACK') {
      return;
    }

    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      // Could be a result for an aborted request
      return;
    }

    // Clear timeout
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }

    // Remove abort handler if present
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener('abort', pending.abortHandler);
    }

    // Update worker state
    this.workerStates[workerIndex] = 'idle';
    this._workerBusySince[workerIndex] = null;

    // Resolve or reject the promise
    if (success) {
      pending.resolve(result);
    } else {
      pending.reject(new Error(error || 'Unknown worker error'));
    }

    this.pendingRequests.delete(requestId);

    // Process next task in queue for this worker
    this._processQueue(workerIndex);
  }

  /**
   * Handle worker errors
   */
  _handleError(workerIndex, error) {
    debugError('WorkerPool', `Worker ${workerIndex} error:`, error);

    // Mark worker as idle (it crashed but we'll try to reuse)
    this.workerStates[workerIndex] = 'idle';
    this._workerBusySince[workerIndex] = null;

    // Reject any pending requests assigned to this worker
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.workerIndex === workerIndex) {
        if (pending.timeoutId) {
          clearTimeout(pending.timeoutId);
        }
        pending.reject(new Error('Worker crashed: ' + (error.message || 'Unknown error')));
        this.pendingRequests.delete(requestId);
      }
    }

    // Try to restart the worker
    this._restartWorker(workerIndex);
  }

  /**
   * Restart a crashed worker
   */
  async _restartWorker(index) {
    try {
      if (this.workers[index]) {
        this.workers[index].terminate();
      }

      const workerPath = new URL('./data-worker.js', import.meta.url).href;
      // Use { type: 'module' } since data-worker.js now uses ES module imports
      const worker = new Worker(workerPath, { type: 'module' });

      worker.onmessage = (e) => this._handleMessage(index, e);
      worker.onerror = (e) => this._handleError(index, e);

      worker.postMessage({
        type: 'INIT',
        payload: { id: index, poolSize: this.poolSize }
      });

      this.workers[index] = worker;
      this.workerStates[index] = 'idle';
      this._workerBusySince[index] = null;

      debug('WorkerPool', `Worker ${index} restarted`);

      // Process any queued tasks
      this._processQueue(index);

    } catch (err) {
      debugError('WorkerPool', `Failed to restart worker ${index}:`, err);
    }
  }

  /**
   * Start periodic health monitoring
   * @private
   */
  _startHealthMonitoring() {
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
    }

    this._healthCheckInterval = setInterval(() => {
      this._performHealthCheck();
    }, this._healthCheckIntervalMs);
  }

  /**
   * Stop health monitoring
   * @private
   */
  _stopHealthMonitoring() {
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }
  }

  /**
   * Perform health check on all workers
   * Detects and restarts stuck workers
   * @private
   */
  _performHealthCheck() {
    const now = performance.now();
    let healthIssues = 0;

    for (let i = 0; i < this.poolSize; i++) {
      // Check for stuck workers (busy for too long)
      if (this.workerStates[i] === 'busy' && this._workerBusySince[i]) {
        const busyDuration = now - this._workerBusySince[i];

        if (busyDuration > this._workerStuckThresholdMs) {
          debugWarn('WorkerPool', `Worker ${i} appears stuck (busy for ${Math.round(busyDuration / 1000)}s), restarting...`);
          healthIssues++;

          // Cancel pending requests for this worker
          for (const [requestId, pending] of this.pendingRequests) {
            if (pending.workerIndex === i) {
              if (pending.timeoutId) {
                clearTimeout(pending.timeoutId);
              }
              pending.reject(new Error('Worker was stuck and restarted'));
              this.pendingRequests.delete(requestId);
            }
          }

          // Restart the worker
          this._restartWorker(i);
        }
      }

      // Check for accumulated queued tasks (indicates potential problem)
      if (this.taskQueues[i].length > 50) {
        debugWarn('WorkerPool', `Worker ${i} has ${this.taskQueues[i].length} queued tasks`);
        healthIssues++;
      }
    }

    // Check for orphaned pending requests (requests with no valid worker)
    const orphanedRequests = [];
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.workerIndex >= this.workers.length || !this.workers[pending.workerIndex]) {
        orphanedRequests.push(requestId);
      }
    }

    for (const requestId of orphanedRequests) {
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        if (pending.timeoutId) {
          clearTimeout(pending.timeoutId);
        }
        pending.reject(new Error('Worker no longer available'));
        this.pendingRequests.delete(requestId);
      }
    }

    if (orphanedRequests.length > 0) {
      debugWarn('WorkerPool', `Cleaned up ${orphanedRequests.length} orphaned requests`);
    }

    if (healthIssues > 0) {
      debugWarn('WorkerPool', `Health check found ${healthIssues} issue(s)`);
    }
  }

  /**
   * Get worker health status
   * @returns {Object} Health information for all workers
   */
  getHealthStatus() {
    const now = performance.now();
    const workers = [];

    for (let i = 0; i < this.poolSize; i++) {
      const busySince = this._workerBusySince[i];
      workers.push({
        index: i,
        state: this.workerStates[i],
        busyDurationMs: busySince ? Math.round(now - busySince) : 0,
        queuedTasks: this.taskQueues[i].length,
        isStuck: busySince && (now - busySince) > this._workerStuckThresholdMs
      });
    }

    return {
      poolSize: this.poolSize,
      initialized: this.initialized,
      totalPending: this.pendingRequests.size,
      healthCheckIntervalMs: this._healthCheckIntervalMs,
      stuckThresholdMs: this._workerStuckThresholdMs,
      workers
    };
  }

  /**
   * Process queued tasks for a worker
   */
  _processQueue(workerIndex) {
    if (this.workerStates[workerIndex] !== 'idle') return;

    const queue = this.taskQueues[workerIndex];
    if (queue.length === 0) return;

    const task = queue.shift();
    this._dispatchToWorker(workerIndex, task);
  }

  /**
   * Dispatch task to a specific worker
   */
  _dispatchToWorker(workerIndex, task) {
    const { type, payload, requestId, resolve, reject, timeout, signal, transfer } = task;

    // Check if already aborted
    if (signal?.aborted) {
      reject(new DOMException('Request aborted', 'AbortError'));
      return;
    }

    this.workerStates[workerIndex] = 'busy';
    this._workerBusySince[workerIndex] = performance.now();

    // Set up timeout
    const timeoutId = setTimeout(() => {
      this.pendingRequests.delete(requestId);
      this.workerStates[workerIndex] = 'idle';
      this._workerBusySince[workerIndex] = null;
      reject(new Error(`Worker request timed out after ${timeout}ms`));
      this._processQueue(workerIndex);
    }, timeout);

    // Set up abort handler
    let abortHandler = null;
    if (signal) {
      abortHandler = () => {
        if (this.pendingRequests.has(requestId)) {
          clearTimeout(timeoutId);
          this.pendingRequests.delete(requestId);
          this.workerStates[workerIndex] = 'idle';
          this._workerBusySince[workerIndex] = null;
          reject(new DOMException('Request aborted', 'AbortError'));
          this._processQueue(workerIndex);
        }
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    // Store pending request
    this.pendingRequests.set(requestId, {
      resolve,
      reject,
      timeoutId,
      workerIndex,
      type,
      signal,
      abortHandler,
      startTime: performance.now()
    });

    // Collect transferables from payload
    const transferables = transfer !== false ? this._collectTransferables(payload) : [];

    // Send to worker with transferables
    this.workers[workerIndex].postMessage({ type, payload, requestId }, transferables);
  }

  /**
   * Collect ArrayBuffers from payload for transfer
   * @param {Object} obj - Object to scan
   * @returns {ArrayBuffer[]} Transferable ArrayBuffers
   */
  _collectTransferables(obj) {
    const transferables = [];

    const scan = (value) => {
      if (!value) return;

      if (value instanceof ArrayBuffer) {
        transferables.push(value);
      } else if (ArrayBuffer.isView(value) && value.buffer) {
        transferables.push(value.buffer);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          scan(item);
        }
      } else if (typeof value === 'object') {
        for (const key in value) {
          scan(value[key]);
        }
      }
    };

    scan(obj);
    return transferables;
  }

  /**
   * Get next worker index using round-robin
   */
  _getNextWorkerIndex() {
    const index = this._nextWorkerIndex;
    this._nextWorkerIndex = (this._nextWorkerIndex + 1) % this.poolSize;
    return index;
  }

  /**
   * Find an idle worker or return -1
   */
  _findIdleWorker() {
    for (let i = 0; i < this.poolSize; i++) {
      if (this.workerStates[i] === 'idle') {
        return i;
      }
    }
    return -1;
  }

  /**
   * Generate unique request ID
   */
  _generateRequestId() {
    return `pool-${++this.requestIdCounter}-${Date.now()}`;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Execute a single task on an available worker
   * @param {string} type - Operation type
   * @param {Object} payload - Operation payload
   * @param {Object|number} [options] - Options or timeout
   * @param {number} [options.timeout] - Timeout in ms
   * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
   * @param {boolean} [options.transfer=true] - Use transferables for ArrayBuffers
   * @returns {Promise<any>}
   */
  async execute(type, payload, options = {}) {
    // Handle legacy signature: execute(type, payload, timeout)
    const opts = typeof options === 'number'
      ? { timeout: options }
      : options;

    const {
      timeout = this.defaultTimeout,
      signal = null,
      transfer = true
    } = opts;

    // Initialize if needed
    if (!this.initialized) {
      await this.init();
    }

    // Fallback if workers unavailable
    if (!this.workersAvailable || this.workers.length === 0) {
      return this._fallbackExecute(type, payload);
    }

    // Check if already aborted
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Request aborted', 'AbortError'));
    }

    const requestId = this._generateRequestId();

    return new Promise((resolve, reject) => {
      const task = { type, payload, requestId, resolve, reject, timeout, signal, transfer };

      // Try to find an idle worker first
      const idleIndex = this._findIdleWorker();

      if (idleIndex >= 0) {
        // Dispatch immediately
        this._dispatchToWorker(idleIndex, task);
      } else {
        // All workers busy, queue to least-loaded worker
        const targetIndex = this._getNextWorkerIndex();
        this.taskQueues[targetIndex].push(task);
      }
    });
  }

  /**
   * Execute multiple tasks in parallel across workers
   * @param {Array<{type: string, payload: Object}>} tasks - Array of tasks
   * @param {number} [timeout] - Timeout per task in ms
   * @returns {Promise<any[]>} Results in same order as tasks
   */
  async executeBatch(tasks, timeout = this.defaultTimeout) {
    if (!this.initialized) {
      await this.init();
    }

    if (tasks.length === 0) return [];

    // Execute all tasks in parallel
    const promises = tasks.map((task, index) =>
      this.execute(task.type, task.payload, timeout)
        .then(result => ({ index, result, error: null }))
        .catch(error => ({ index, result: null, error }))
    );

    const results = await Promise.all(promises);

    // Sort by original index and extract results
    results.sort((a, b) => a.index - b.index);

    // Check for errors
    const errors = results.filter(r => r.error);
    if (errors.length > 0) {
      debugWarn('WorkerPool', `${errors.length}/${tasks.length} tasks failed`);
    }

    return results.map(r => {
      if (r.error) throw r.error;
      return r.result;
    });
  }

  /**
   * Distribute array processing across workers
   * Each worker processes a chunk, results are combined
   * @param {string} type - Operation type
   * @param {TypedArray|Array} array - Array to process
   * @param {Object} [options] - Additional options
   * @returns {Promise<Object>} Combined result
   */
  async distributeByChunks(type, array, options = {}) {
    if (!this.initialized) {
      await this.init();
    }

    const chunkSize = Math.ceil(array.length / this.poolSize);
    const tasks = [];

    for (let i = 0; i < this.poolSize; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, array.length);

      if (start >= array.length) break;

      // Slice the array for this chunk
      const chunk = array.slice(start, end);

      tasks.push({
        type,
        payload: {
          values: Array.from(chunk), // Convert to regular array for postMessage
          chunkIndex: i,
          chunkStart: start,
          chunkEnd: end,
          ...options
        }
      });
    }

    // Execute all chunks in parallel
    const chunkResults = await this.executeBatch(tasks);

    // Combine results based on operation type
    return this._combineChunkResults(type, chunkResults);
  }

  /**
   * Combine chunk results based on operation type
   */
  _combineChunkResults(type, chunkResults) {
    switch (type) {
      case 'COMPUTE_STATS': {
        // Combine statistics from chunks
        let totalCount = 0;
        let totalSum = 0;
        let totalSumSq = 0;
        let globalMin = Infinity;
        let globalMax = -Infinity;
        const allValues = [];

        for (const result of chunkResults) {
          if (!result) continue;
          totalCount += result.count || 0;
          totalSum += result.sum || 0;
          totalSumSq += (result.variance || 0) * (result.count || 0) + Math.pow(result.mean || 0, 2) * (result.count || 0);
          if (result.min < globalMin) globalMin = result.min;
          if (result.max > globalMax) globalMax = result.max;
        }

        const mean = totalCount > 0 ? totalSum / totalCount : 0;
        const variance = totalCount > 0 ? (totalSumSq / totalCount) - (mean * mean) : 0;

        return {
          count: totalCount,
          min: globalMin === Infinity ? null : globalMin,
          max: globalMax === -Infinity ? null : globalMax,
          mean,
          std: Math.sqrt(Math.max(0, variance)),
          sum: totalSum
        };
      }

      case 'COMPUTE_HISTOGRAM': {
        // Combine histogram counts
        if (chunkResults.length === 0) return { edges: [], counts: [] };

        const first = chunkResults[0];
        const combinedCounts = new Array(first.counts.length).fill(0);

        for (const result of chunkResults) {
          for (let i = 0; i < result.counts.length; i++) {
            combinedCounts[i] += result.counts[i];
          }
        }

        return {
          edges: first.edges,
          counts: combinedCounts,
          binWidth: first.binWidth,
          total: combinedCounts.reduce((a, b) => a + b, 0)
        };
      }

      default:
        // For operations that don't need combining, return first result
        return chunkResults[0];
    }
  }

  /**
   * Fallback execution on main thread.
   * Uses the shared fallback-operations module for all operation types.
   */
  _fallbackExecute(type, payload) {
    debugWarn('WorkerPool', 'Executing on main thread (workers unavailable):', type);

    return new Promise((resolve, reject) => {
      try {
        const result = executeFallback(type, payload);
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  }

  // =========================================================================
  // High-level API methods (mirror WorkerManager for compatibility)
  // =========================================================================

  async extractValues(cellIndices, rawValues, options = {}) {
    return this.execute('EXTRACT_VALUES', {
      cellIndices,
      rawValues,
      categories: options.categories,
      isCategorical: options.isCategorical || false
    });
  }

  async computeStats(values) {
    // Always distribute across workers for parallelism - no array size threshold
    // Even small arrays benefit from consistent code paths and parallel execution
    if (values.length > 1000 && this.poolSize > 1) {
      return this.distributeByChunks('COMPUTE_STATS', values);
    }
    return this.execute('COMPUTE_STATS', { values });
  }

  async computeCorrelation(xValues, yValues, method = 'pearson') {
    return this.execute('COMPUTE_CORRELATION', { xValues, yValues, method });
  }

  async computeDifferential(groupAValues, groupBValues, method = 'wilcox') {
    return this.execute('COMPUTE_DIFFERENTIAL', {
      groupAValues,
      groupBValues,
      method
    });
  }

  async aggregateCategories(values, normalize = false) {
    return this.execute('AGGREGATE_CATEGORIES', { values, normalize });
  }

  async binValues(values, options = {}) {
    return this.execute('BIN_VALUES', {
      values,
      method: options.method || 'equal_width',
      binCount: options.binCount || 10,
      customBreaks: options.customBreaks
    });
  }

  async batchExtract(cellIndices, variables) {
    return this.execute('BATCH_EXTRACT', { cellIndices, variables });
  }

  /**
   * Compute differential expression for multiple genes in parallel
   * @param {Object} options
   * @param {Object} geneData - { geneName: { pageA: { values }, pageB: { values } } }
   * @param {string} pageA - First page ID
   * @param {string} pageB - Second page ID
   * @param {string} method - 'wilcox' or 'ttest'
   * @returns {Promise<Object[]>} Results for each gene
   */
  async computeDifferentialBatch(options) {
    const { geneData, pageA, pageB, method = 'wilcox' } = options;
    const geneNames = Object.keys(geneData);

    const tasks = geneNames.map(gene => {
      const dataA = geneData[gene]?.[pageA]?.values || [];
      const dataB = geneData[gene]?.[pageB]?.values || [];

      return {
        type: 'COMPUTE_DIFFERENTIAL',
        payload: {
          groupAValues: filterFiniteNumbers(dataA),
          groupBValues: filterFiniteNumbers(dataB),
          method,
          gene
        }
      };
    });

    try {
      const results = await this.executeBatch(tasks);
      return geneNames.map((gene, i) => ({
        gene,
        ...results[i]
      }));
    } catch (error) {
      // Return partial results if some failed
      return geneNames.map(gene => ({
        gene,
        error: error.message,
        pValue: NaN,
        log2FoldChange: NaN
      }));
    }
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Restart idle workers to reclaim memory.
   *
   * Rationale:
   * - Large analyses can temporarily grow worker heaps / ArrayBuffer usage.
   * - Browsers may delay GC in workers; recycling is the most reliable way to
   *   release memory back to the OS.
   *
   * This method is designed to be safe for MemoryMonitor-triggered cleanup:
   * it only touches workers that are currently marked as idle.
   *
   * @param {Object} [options]
   * @param {number} [options.keepAtLeast=0] - Leave this many idle workers untouched
   * @param {number} [options.maxToRecycle=Infinity] - Upper bound on restarts
   * @returns {{recycled: number, kept: number, considered: number}}
   */
  pruneIdleWorkers(options = {}) {
    const {
      keepAtLeast = 0,
      maxToRecycle = Infinity
    } = options;

    if (!this.initialized || !this.workersAvailable || this.workers.length === 0) {
      return { recycled: 0, kept: 0, considered: 0 };
    }

    const idleIndices = [];
    for (let i = 0; i < this.poolSize; i++) {
      if (this.workerStates[i] === 'idle') {
        idleIndices.push(i);
      }
    }

    const considered = idleIndices.length;
    const keepCount = Math.max(0, Math.min(considered, Math.floor(keepAtLeast)));
    const maxRecycle = Number.isFinite(maxToRecycle) ? Math.max(0, Math.floor(maxToRecycle)) : considered;
    const toRecycle = Math.max(0, Math.min(considered - keepCount, maxRecycle));

    for (let i = 0; i < toRecycle; i++) {
      const idx = idleIndices[i];
      // Fire-and-forget restart (async). Safe because worker is idle.
      void this._restartWorker(idx);
    }

    if (toRecycle > 0) {
      debug('WorkerPool', `Recycled ${toRecycle}/${considered} idle worker(s) to reclaim memory`);
    }

    return {
      recycled: toRecycle,
      kept: considered - toRecycle,
      considered
    };
  }

  /**
   * Get pool statistics
   */
  getStats() {
    const busy = this.workerStates.filter(s => s === 'busy').length;
    const queuedTasks = this.taskQueues.reduce((sum, q) => sum + q.length, 0);

    return {
      poolSize: this.poolSize,
      initialized: this.initialized,
      busyWorkers: busy,
      idleWorkers: this.poolSize - busy,
      pendingRequests: this.pendingRequests.size,
      queuedTasks
    };
  }

  /**
   * Terminate all workers and clean up
   */
  terminate() {
    // Stop health monitoring
    this._stopHealthMonitoring();

    // Reject all pending requests
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      pending.reject(new Error('Worker pool terminated'));
    }
    this.pendingRequests.clear();

    // Clear queues
    for (const queue of this.taskQueues) {
      queue.length = 0;
    }

    // Terminate workers
    for (const worker of this.workers) {
      if (worker) {
        worker.terminate();
      }
    }

    this.workers = [];
    this.workerStates = [];
    this.taskQueues = [];
    this._workerBusySince = [];
    this.initialized = false;

    // Clear singleton
    if (poolInstance === this) {
      poolInstance = null;
    }
  }

  /**
   * Check if pool is ready
   */
  isReady() {
    return this.initialized && this.workers.length > 0;
  }

  /**
   * Get pending request count
   */
  getPendingCount() {
    return this.pendingRequests.size;
  }
}

/**
 * Get the singleton WorkerPool instance
 * @param {Object} [options] - Pool options (only used on first call)
 * @returns {WorkerPool}
 */
export function getWorkerPool(options) {
  if (!poolInstance) {
    poolInstance = new WorkerPool(options);
  }
  return poolInstance;
}

/**
 * Create a new WorkerPool instance (for testing or isolation)
 * @param {Object} [options] - Pool options
 * @returns {WorkerPool}
 */
export function createWorkerPool(options) {
  return new WorkerPool(options);
}

export default WorkerPool;
