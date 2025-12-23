/**
 * Unified Compute Manager for Analysis Module
 *
 * Orchestrates computation across GPU, Worker, and CPU backends with automatic fallback.
 *
 * Fallback Priority (ALWAYS in this order, regardless of array size):
 * 1. GPU - Uses WebGL2 Transform Feedback for element-wise operations
 * 2. Worker - Uses Web Workers (pool) for parallel computation
 * 3. CPU - Main thread fallback when GPU and Workers unavailable
 *
 * IMPORTANT: GPU is always preferred when available, even for small arrays.
 * The overhead of GPU setup is negligible compared to the benefits of
 * consistent code paths and parallel execution.
 *
 * REFACTORED: Now uses operations.js for operation definitions (single source of truth).
 */

// Import operation definitions from the single source of truth
import { OperationType, GPU_CAPABLE_OPERATIONS } from './operations.js';
import { getMemoryMonitor } from '../shared/memory-monitor.js';
import { debug, debugWarn } from '../shared/debug-utils.js';

// Lazy imports to avoid circular dependencies
let gpuComputeModule = null;
let workerPoolModule = null;
let fallbackOpsModule = null;

// Singleton instance
let computeManagerInstance = null;

/**
 * Backend status enum
 */
export const BackendStatus = {
  UNKNOWN: 'unknown',
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
  FAILED: 'failed'
};

/**
 * ComputeManager class
 *
 * Provides unified API for all compute operations with automatic backend selection.
 */
export class ComputeManager {
  constructor() {
    this._gpuStatus = BackendStatus.UNKNOWN;
    this._workerStatus = BackendStatus.UNKNOWN;

    this._gpuBackend = null;
    this._workerBackend = null;

    this._initialized = false;
    this._initPromise = null;

    // Performance metrics
    this._metrics = {
      gpuExecutions: 0,
      workerExecutions: 0,
      cpuExecutions: 0,
      gpuFallbacks: 0,
      workerFallbacks: 0,
      totalExecutions: 0,
      totalTimeMs: 0
    };

    // Health check interval
    this._healthCheckInterval = null;
    this._workerRestartPromise = null;

    // Memory monitor integration for cleanup under memory pressure
    this._instanceId = `compute-manager-${Date.now()}`;
    this._memoryMonitor = getMemoryMonitor();
    this._memoryMonitor.registerCleanupHandler(this._instanceId, (reason) => {
      // Avoid recycling all workers on periodic maintenance cleanups to reduce churn.
      const keepAtLeastIdleWorkers = reason === 'periodic' ? 1 : 0;
      this._handleMemoryCleanup({ keepAtLeastIdleWorkers });
    });
  }

  /**
   * Handle memory cleanup triggered by MemoryMonitor
   * Releases GPU resources and terminates idle workers
   * @private
   */
  _handleMemoryCleanup(options = {}) {
    const { keepAtLeastIdleWorkers = 0 } = options;
    console.debug('[ComputeManager] Memory cleanup triggered');

    // Release GPU shader cache if available
    if (this._gpuBackend && this._gpuBackend.clearCache) {
      this._gpuBackend.clearCache();
    }

    // Terminate idle workers in the pool
    if (this._workerBackend && this._workerBackend.pruneIdleWorkers) {
      this._workerBackend.pruneIdleWorkers({ keepAtLeast: keepAtLeastIdleWorkers });
    }

    // Reset metrics to free any accumulated data
    this.resetMetrics();
  }

  /**
   * Best-effort cleanup for post-analysis memory recovery.
   *
   * Safe to call after large computations complete (when workers are typically idle).
   * Uses the same hooks as MemoryMonitor cleanup but avoids global notifications.
   *
   * @param {Object} [options]
   * @param {number} [options.keepAtLeastIdleWorkers=0] - Leave this many idle workers untouched
   */
  cleanupIdleResources(options = {}) {
    this._handleMemoryCleanup(options);
  }

  /**
   * Initialize the compute manager and all backends
   * @returns {Promise<void>}
   */
  async init() {
    if (this._initialized) return;

    // Prevent concurrent initialization
    if (this._initPromise) {
      return this._initPromise;
    }

    this._initPromise = this._doInit();
    await this._initPromise;
    this._initPromise = null;
  }

  /**
   * Internal initialization logic
   * @private
   */
  async _doInit() {
    // Initialize GPU backend
    await this._initGPU();

    // Initialize Worker backend
    await this._initWorker();

    // Start health monitoring
    this._startHealthMonitoring();

    this._initialized = true;

    debug('ComputeManager', `Initialized - GPU: ${this._gpuStatus}, Worker: ${this._workerStatus}`);
  }

  /**
   * Initialize GPU backend
   * @private
   */
  async _initGPU() {
    try {
      if (!gpuComputeModule) {
        gpuComputeModule = await import('./gpu-compute.js');
      }

      const gpu = gpuComputeModule.getGPUCompute();
      await gpu.init();

      if (gpu._initialized) {
        this._gpuBackend = gpu;
        this._gpuStatus = BackendStatus.AVAILABLE;

        const info = gpu.getInfo();
        debug('ComputeManager', `GPU available: ${info.renderer}`);
      } else {
        this._gpuStatus = BackendStatus.UNAVAILABLE;
      }
    } catch (err) {
      debugWarn('ComputeManager', 'GPU initialization failed:', err.message);
      this._gpuStatus = BackendStatus.UNAVAILABLE;
    }
  }

  /**
   * Initialize Worker backend
   * @private
   */
  async _initWorker() {
    try {
      if (!workerPoolModule) {
        workerPoolModule = await import('./worker-pool.js');
      }

      const pool = workerPoolModule.getWorkerPool();
      const ready = await pool.init();

      if (ready) {
        this._workerBackend = pool;
        this._workerStatus = BackendStatus.AVAILABLE;

        const stats = pool.getStats();
        debug('ComputeManager', `Worker pool available: ${stats.poolSize} workers`);
      } else {
        this._workerStatus = BackendStatus.UNAVAILABLE;
      }
    } catch (err) {
      debugWarn('ComputeManager', 'Worker initialization failed:', err.message);
      this._workerStatus = BackendStatus.UNAVAILABLE;
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

    // Check health every 30 seconds
    this._healthCheckInterval = setInterval(() => {
      void this._performHealthCheck().catch((err) => {
        debugWarn('ComputeManager', 'Health check failed:', err?.message || err);
      });
    }, 30000);
  }

  /**
   * Perform health check on all backends
   * @private
   */
  async _performHealthCheck() {
    if (this._workerRestartPromise) return;

    // Check worker health
    if (this._workerBackend) {
      const stats = this._workerBackend.getStats();

      // If workers seem stuck (many pending, none processing), restart them
      if (stats.pendingRequests > 10 && stats.busyWorkers === 0) {
        debugWarn('ComputeManager', 'Workers appear stuck, restarting...');
        try {
          this._workerBackend.terminate();
        } catch (err) {
          debugWarn('ComputeManager', 'Worker termination failed:', err?.message || err);
        }

        // Prevent new tasks from selecting the worker backend during restart.
        this._workerBackend = null;
        this._workerStatus = BackendStatus.UNAVAILABLE;

        this._workerRestartPromise = this._initWorker().finally(() => {
          this._workerRestartPromise = null;
        });
        await this._workerRestartPromise;
      }
    }

    // GPU doesn't need health checks as it's stateless
  }

  /**
   * Select the best backend for an operation
   *
   * Priority: GPU -> Worker -> CPU (regardless of array size)
   *
   * @param {string} operation - Operation type
   * @param {string} [preferredBackend] - Optional preferred backend
   * @returns {string} 'gpu' | 'worker' | 'cpu'
   */
  selectBackend(operation, preferredBackend = null) {
    // Respect explicit preference if backend is available
    if (preferredBackend === 'gpu' && this._gpuStatus === BackendStatus.AVAILABLE) {
      return 'gpu';
    }
    if (preferredBackend === 'worker' && this._workerStatus === BackendStatus.AVAILABLE) {
      return 'worker';
    }
    if (preferredBackend === 'cpu') {
      return 'cpu';
    }

    // Check if operation can use GPU
    const gpuCapable = GPU_CAPABLE_OPERATIONS.has(operation);

    // GPU first if available and operation supports it
    if (gpuCapable && this._gpuStatus === BackendStatus.AVAILABLE) {
      return 'gpu';
    }

    // Worker second if available
    if (this._workerStatus === BackendStatus.AVAILABLE) {
      return 'worker';
    }

    // CPU as final fallback
    return 'cpu';
  }

  /**
   * Execute an operation with automatic backend selection and fallback
   *
   * @param {string} operation - Operation type from OperationType enum
   * @param {Object} payload - Operation payload
   * @param {Object} [options] - Execution options
   * @param {string} [options.preferredBackend] - Force specific backend
   * @param {number} [options.timeout] - Timeout in ms
   * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
   * @param {boolean} [options.transfer] - Worker-only: whether to transfer ArrayBuffers (default true)
   * @returns {Promise<Object>} Operation result with metadata
   */
  async execute(operation, payload, options = {}) {
    // Initialize if needed
    if (!this._initialized) {
      await this.init();
    }

    const startTime = performance.now();
    const selectedBackend = this.selectBackend(operation, options.preferredBackend);

    let result;
    let actualBackend = selectedBackend;
    let fallbackUsed = false;

    try {
      result = await this._executeOnBackend(selectedBackend, operation, payload, options);
    } catch (primaryError) {
      // Attempt fallback
      debugWarn('ComputeManager', `${selectedBackend} execution failed for ${operation}:`, primaryError.message);

      if (selectedBackend === 'gpu') {
        // GPU failed -> try Worker
        this._metrics.gpuFallbacks++;

        if (this._workerStatus === BackendStatus.AVAILABLE) {
          try {
            result = await this._executeOnBackend('worker', operation, payload, options);
            actualBackend = 'worker';
            fallbackUsed = true;
          } catch (workerError) {
            // Worker also failed -> CPU
            debugWarn('ComputeManager', 'Worker fallback failed:', workerError.message);
            result = await this._executeOnBackend('cpu', operation, payload, options);
            actualBackend = 'cpu';
            fallbackUsed = true;
            this._metrics.workerFallbacks++;
          }
        } else {
          // No worker available -> CPU
          result = await this._executeOnBackend('cpu', operation, payload, options);
          actualBackend = 'cpu';
          fallbackUsed = true;
        }
      } else if (selectedBackend === 'worker') {
        // Worker failed -> CPU
        this._metrics.workerFallbacks++;
        result = await this._executeOnBackend('cpu', operation, payload, options);
        actualBackend = 'cpu';
        fallbackUsed = true;
      } else {
        // CPU failed -> no fallback possible
        throw primaryError;
      }
    }

    const elapsed = performance.now() - startTime;

    // Update metrics
    this._metrics.totalExecutions++;
    this._metrics.totalTimeMs += elapsed;

    switch (actualBackend) {
      case 'gpu':
        this._metrics.gpuExecutions++;
        break;
      case 'worker':
        this._metrics.workerExecutions++;
        break;
      case 'cpu':
        this._metrics.cpuExecutions++;
        break;
    }

    // Add execution metadata
    return {
      ...result,
      _compute: {
        operation,
        selectedBackend,
        actualBackend,
        fallbackUsed,
        elapsedMs: elapsed
      }
    };
  }

  /**
   * Execute on a specific backend
   * @private
   */
  async _executeOnBackend(backend, operation, payload, options) {
    switch (backend) {
      case 'gpu':
        return this._executeGPU(operation, payload);
      case 'worker':
        return this._executeWorker(operation, payload, options);
      case 'cpu':
        return this._executeCPU(operation, payload);
      default:
        throw new Error(`Unknown backend: ${backend}`);
    }
  }

  /**
   * Execute operation on GPU backend
   * @private
   */
  async _executeGPU(operation, payload) {
    if (!this._gpuBackend) {
      throw new Error('GPU backend not available');
    }

    const gpu = this._gpuBackend;
    const values = payload.values;

    // Ensure Float32Array for GPU operations
    const inputArray = values instanceof Float32Array
      ? values
      : new Float32Array(values);

    switch (operation) {
      case OperationType.LOG1P:
        return { values: gpu.log1pTransform(inputArray) };

      case OperationType.ZSCORE: {
        const stats = gpu.computeStatistics(inputArray);
        if (!Number.isFinite(stats.std) || stats.std === 0) {
          const values = new Float32Array(inputArray.length);
          for (let i = 0; i < inputArray.length; i++) {
            const x = inputArray[i];
            values[i] = x === x ? 0 : x;
          }
          return { values, mean: stats.mean, std: 0 };
        }
        return {
          values: gpu.zScoreNormalize(inputArray, stats.mean, stats.std),
          mean: stats.mean,
          std: stats.std
        };
      }

      case OperationType.MINMAX: {
        const stats = gpu.computeStatistics(inputArray);
        if (!Number.isFinite(stats.min) || !Number.isFinite(stats.max) || stats.min === stats.max) {
          const values = new Float32Array(inputArray.length);
          for (let i = 0; i < inputArray.length; i++) {
            const x = inputArray[i];
            values[i] = x === x ? 0 : x;
          }
          return { values, min: stats.min, max: stats.max };
        }
        return {
          values: gpu.minMaxNormalize(inputArray, stats.min, stats.max),
          min: stats.min,
          max: stats.max
        };
      }

      case OperationType.SCALE:
        return {
          values: gpu.scaleAndOffset(inputArray, payload.scale ?? 1, payload.offset ?? 0)
        };

      case OperationType.CLAMP:
        return {
          values: gpu.clamp(
            inputArray,
            Math.min(payload.min ?? 0, payload.max ?? 1),
            Math.max(payload.min ?? 0, payload.max ?? 1)
          )
        };

      case OperationType.COMPUTE_STATS:
        return gpu.computeFullStatistics(inputArray);

      case OperationType.COMPUTE_HISTOGRAM: {
        const stats = gpu.computeStatistics(inputArray);

        let min = Array.isArray(payload.range) && payload.range.length === 2 ? payload.range[0] : undefined;
        let max = Array.isArray(payload.range) && payload.range.length === 2 ? payload.range[1] : undefined;

        if (!Number.isFinite(min)) min = stats.min;
        if (!Number.isFinite(max)) max = stats.max;
        if (Number.isFinite(min) && Number.isFinite(max) && min > max) [min, max] = [max, min];

        const binSpec = payload.bins ?? payload.nbins ?? 20;
        let numBins;

        if (typeof binSpec === 'number' && Number.isFinite(binSpec)) {
          numBins = binSpec;
        } else if (binSpec === 'auto' || binSpec === 'sturges') {
          numBins = stats.count > 0 ? (Math.ceil(Math.log2(stats.count)) + 1) : 1;
        } else if (binSpec === 'fd') {
          if (stats.count < 2 || !Number.isFinite(stats.min) || !Number.isFinite(stats.max) || stats.min === stats.max) {
            numBins = 1;
          } else {
            const sorted = gpu.sortAndFilter(inputArray);
            const percentiles = gpu.computePercentiles(sorted, [25, 75]);
            const iqr = (percentiles[75] ?? 0) - (percentiles[25] ?? 0);
            const fdBinWidth = 2 * iqr * Math.pow(stats.count, -1/3);
            const span = (Number.isFinite(max) && Number.isFinite(min)) ? (max - min) : (stats.max - stats.min);
            numBins = fdBinWidth > 0 ? Math.ceil(span / fdBinWidth) : 1;
          }
        } else {
          numBins = 10;
        }

        numBins = Math.max(1, Math.min(numBins, 100));

        const histogram = gpu.computeHistogram(inputArray, numBins, min, max);
        const counts = Array.from(histogram.counts || []);
        const edges = histogram.edges ? Array.from(histogram.edges) : [];
        const binWidth = Number.isFinite(histogram.binWidth) ? histogram.binWidth : 0;
        const total = Number.isFinite(histogram.validCount) ? histogram.validCount : 0;
        const density = counts.map(c => (total > 0 && binWidth > 0 ? c / (total * binWidth) : 0));

        return { edges, counts, density, binWidth, total };
      }

      default:
        // Operation not supported by GPU, fall through to error
        throw new Error(`GPU does not support operation: ${operation}`);
    }
  }

  /**
   * Execute operation on Worker backend
   * @private
   */
  async _executeWorker(operation, payload, options = {}) {
    if (!this._workerBackend) {
      throw new Error('Worker backend not available');
    }

    const { timeout = 30000, signal = null, transfer } = options;

    return this._workerBackend.execute(operation, payload, { timeout, signal, transfer });
  }

  /**
   * Execute operation on CPU backend (main thread)
   * @private
   */
  async _executeCPU(operation, payload) {
    // Lazy load fallback operations
    if (!fallbackOpsModule) {
      fallbackOpsModule = await import('./fallback-operations.js');
    }

    return fallbackOpsModule.executeFallback(operation, payload);
  }

  /**
   * Execute multiple operations in batch
   *
   * @param {Array<{operation: string, payload: Object}>} tasks - Array of tasks
   * @param {Object} [options] - Batch options
   * @returns {Promise<Object[]>} Results array
   */
  async executeBatch(tasks, options = {}) {
    if (!this._initialized) {
      await this.init();
    }

    // Group tasks by optimal backend
    const gpuTasks = [];
    const workerTasks = [];
    const cpuTasks = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const backend = this.selectBackend(task.operation, options.preferredBackend);

      switch (backend) {
        case 'gpu':
          gpuTasks.push({ ...task, originalIndex: i });
          break;
        case 'worker':
          workerTasks.push({ ...task, originalIndex: i });
          break;
        default:
          cpuTasks.push({ ...task, originalIndex: i });
      }
    }

    // Execute in parallel by backend type
    const results = new Array(tasks.length);

    const executeGroup = async (group, executor) => {
      for (const task of group) {
        try {
          results[task.originalIndex] = await executor(task.operation, task.payload);
        } catch (err) {
          // Try fallback for failed tasks
          try {
            results[task.originalIndex] = await this._executeCPU(task.operation, task.payload);
          } catch (cpuErr) {
            results[task.originalIndex] = { error: cpuErr.message };
          }
        }
      }
    };

    await Promise.all([
      gpuTasks.length > 0 && executeGroup(gpuTasks, (op, pl) => this._executeGPU(op, pl)),
      workerTasks.length > 0 && this._workerBackend?.executeBatch(
        workerTasks.map(t => ({ type: t.operation, payload: t.payload })),
        options.timeout
      ).then(res => {
        res.forEach((r, i) => {
          results[workerTasks[i].originalIndex] = r;
        });
      }),
      cpuTasks.length > 0 && executeGroup(cpuTasks, (op, pl) => this._executeCPU(op, pl))
    ].filter(Boolean));

    return results;
  }

  // ===========================================================================
  // High-level convenience methods
  // ===========================================================================

  /**
   * Compute statistics for values
   */
  async computeStats(values) {
    return this.execute(OperationType.COMPUTE_STATS, { values });
  }

  /**
   * Compute histogram
   */
  async computeHistogram(values, bins = 20, range = null) {
    return this.execute(OperationType.COMPUTE_HISTOGRAM, {
      values,
      bins,
      range
    });
  }

  /**
   * Compute correlation
   */
  async computeCorrelation(xValues, yValues, method = 'pearson', options = {}) {
    return this.execute(OperationType.COMPUTE_CORRELATION, { xValues, yValues, method }, options);
  }

  /**
   * Compute differential expression
   */
  async computeDifferential(groupAValues, groupBValues, method = 'wilcox') {
    return this.execute(OperationType.COMPUTE_DIFFERENTIAL, {
      groupAValues,
      groupBValues,
      method
    });
  }

  /**
   * Apply log1p transform
   */
  async log1pTransform(values) {
    return this.execute(OperationType.LOG1P, { values });
  }

  /**
   * Apply z-score normalization
   */
  async zscoreNormalize(values) {
    return this.execute(OperationType.ZSCORE, { values });
  }

  /**
   * Apply min-max normalization
   */
  async minmaxNormalize(values) {
    return this.execute(OperationType.MINMAX, { values });
  }

  /**
   * Extract values for cell indices
   */
  async extractValues(cellIndices, rawValues, options = {}) {
    return this.execute(OperationType.EXTRACT_VALUES, {
      cellIndices,
      rawValues,
      categories: options.categories,
      isCategorical: options.isCategorical || false
    });
  }

  /**
   * Aggregate categorical values
   */
  async aggregateCategories(values, normalize = false) {
    return this.execute(OperationType.AGGREGATE_CATEGORIES, { values, normalize });
  }

  // ===========================================================================
  // Status and lifecycle
  // ===========================================================================

  /**
   * Get backend status
   */
  getStatus() {
    return {
      initialized: this._initialized,
      gpu: {
        status: this._gpuStatus,
        info: this._gpuBackend?.getInfo?.() || null
      },
      worker: {
        status: this._workerStatus,
        stats: this._workerBackend?.getStats?.() || null
      }
    };
  }

  /**
   * Get execution metrics
   */
  getMetrics() {
    return { ...this._metrics };
  }

  /**
   * Reset execution metrics
   */
  resetMetrics() {
    this._metrics = {
      gpuExecutions: 0,
      workerExecutions: 0,
      cpuExecutions: 0,
      gpuFallbacks: 0,
      workerFallbacks: 0,
      totalExecutions: 0,
      totalTimeMs: 0
    };
  }

  /**
   * Check if GPU is available
   */
  isGPUAvailable() {
    return this._gpuStatus === BackendStatus.AVAILABLE;
  }

  /**
   * Check if Workers are available
   */
  isWorkerAvailable() {
    return this._workerStatus === BackendStatus.AVAILABLE;
  }

  /**
   * Terminate all backends and clean up
   */
  terminate() {
    // Unregister memory cleanup handler
    if (this._memoryMonitor && this._instanceId) {
      this._memoryMonitor.unregisterCleanupHandler(this._instanceId);
      this._memoryMonitor = null;
    }

    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }

    if (this._workerBackend) {
      this._workerBackend.terminate();
      this._workerBackend = null;
    }

    if (this._gpuBackend) {
      this._gpuBackend.dispose();
      this._gpuBackend = null;
    }

    this._gpuStatus = BackendStatus.UNKNOWN;
    this._workerStatus = BackendStatus.UNKNOWN;
    this._initialized = false;

    // Clear singleton
    if (computeManagerInstance === this) {
      computeManagerInstance = null;
    }

    console.debug('[ComputeManager] Terminated');
  }
}

/**
 * Get the singleton ComputeManager instance
 * @returns {ComputeManager}
 */
export function getComputeManager() {
  if (!computeManagerInstance) {
    computeManagerInstance = new ComputeManager();
  }
  return computeManagerInstance;
}

/**
 * Create a new ComputeManager instance (for testing or isolation)
 * @returns {ComputeManager}
 */
export function createComputeManager() {
  return new ComputeManager();
}

/**
 * Initialize the singleton and return it
 * @returns {Promise<ComputeManager>}
 */
export async function initComputeManager() {
  const manager = getComputeManager();
  await manager.init();
  return manager;
}

export default ComputeManager;
