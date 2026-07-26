/**
 * Unified Compute Manager for Analysis Module
 *
 * Chooses one declared, available backend before an operation starts. Worker
 * and CPU execution share operation-handlers.js, so changing the selected
 * backend does not change the scientific contract. An execution error is
 * returned unchanged to the caller.
 */

import {
  CPU_CAPABLE_OPERATIONS,
  GPU_CAPABLE_OPERATIONS,
  WORKER_CAPABLE_OPERATIONS,
  isValidOperation
} from './operations.js';
import { executeOperation } from './operation-handlers.js';
import { debug } from '../shared/debug-utils.js';

let workerPoolModule = null;
let computeManagerInstance = null;

const BACKENDS = new Set(['gpu', 'worker', 'cpu']);
const EXECUTION_OPTIONS = new Set(['backend', 'timeout', 'signal', 'transfer']);
const BATCH_TASK_KEYS = new Set(['operation', 'payload']);

function now() {
  if (
    globalThis.performance === null
    || typeof globalThis.performance !== 'object'
    || typeof globalThis.performance.now !== 'function'
  ) {
    throw new Error('Compute timing requires performance.now()');
  }
  const timestamp = globalThis.performance.now();
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error('performance.now() returned an invalid timestamp');
  }
  return timestamp;
}

function requirePlainRecord(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

/**
 * Backend status enum.
 */
export const BackendStatus = {
  UNKNOWN: 'unknown',
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
  FAILED: 'failed'
};

/**
 * Unified analysis operation orchestrator.
 */
export class ComputeManager {
  constructor() {
    // GPU utility implementations are not selected until an operation has a
    // parity-verified GPU contract in operations.js.
    this._gpuStatus = BackendStatus.UNAVAILABLE;
    this._workerStatus = BackendStatus.UNKNOWN;

    this._gpuBackend = null;
    this._workerBackend = null;
    this._workerFailure = null;

    this._initialized = false;
    this._initPromise = null;

    this._metrics = this._newMetrics();
  }

  _newMetrics() {
    return {
      gpuExecutions: 0,
      workerExecutions: 0,
      cpuExecutions: 0,
      totalExecutions: 0,
      totalTimeMs: 0
    };
  }

  /**
   * Initialize declared external backends.
   *
   * Backend initialization is capability discovery, not operation execution.
   * An unavailable worker is recorded before any scientific operation begins.
   */
  async init() {
    if (this._workerStatus === BackendStatus.FAILED) {
      if (!(this._workerFailure instanceof Error)) {
        throw new Error('Failed worker backend requires one terminal Error');
      }
      throw this._workerFailure;
    }
    if (this._initialized) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._doInit();
    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  async _doInit() {
    this._gpuStatus = GPU_CAPABLE_OPERATIONS.size > 0
      ? BackendStatus.UNKNOWN
      : BackendStatus.UNAVAILABLE;

    await this._initWorker();
    this._initialized = true;

    debug(
      'ComputeManager',
      `Initialized - GPU: ${this._gpuStatus}, Worker: ${this._workerStatus}`
    );
  }

  async _initWorker() {
    this._workerFailure = null;
    if (typeof globalThis.Worker !== 'function') {
      this._workerBackend = null;
      this._workerStatus = BackendStatus.UNAVAILABLE;
      return;
    }

    let pool = null;
    try {
      if (!workerPoolModule) {
        workerPoolModule = await import('./worker-pool.js');
      }

      pool = workerPoolModule.getWorkerPool();
      this._workerBackend = pool;
      await pool.init();
      if (!pool.isReady()) {
        throw new Error('Analysis worker pool did not enter its ready state');
      }

      this._workerBackend = pool;
      this._workerStatus = BackendStatus.AVAILABLE;
      debug(
        'ComputeManager',
        `Worker pool available: ${pool.getStats().poolSize} workers`
      );
    } catch (error) {
      const failure = error instanceof Error
        ? error
        : new TypeError('Worker initialization failed with a non-Error value');
      this._workerBackend = pool;
      this._workerStatus = BackendStatus.FAILED;
      this._workerFailure = failure;
      throw failure;
    }
  }

  _validateExecutionOptions(options) {
    requirePlainRecord(options, 'Execution options');

    for (const key of Object.keys(options)) {
      if (!EXECUTION_OPTIONS.has(key)) {
        throw new Error(`Unknown execution option: ${key}`);
      }
    }
    if (Object.hasOwn(options, 'backend') && !BACKENDS.has(options.backend)) {
      throw new TypeError(`Unknown compute backend: ${options.backend}`);
    }
    if (
      Object.hasOwn(options, 'timeout')
      && (!Number.isSafeInteger(options.timeout) || options.timeout <= 0)
    ) {
      throw new TypeError('Compute timeout must be a positive safe integer');
    }
    if (
      Object.hasOwn(options, 'signal')
      && options.signal !== null
      && !(options.signal instanceof AbortSignal)
    ) {
      throw new TypeError('Compute signal must be an AbortSignal or null');
    }
    if (
      Object.hasOwn(options, 'transfer')
      && typeof options.transfer !== 'boolean'
    ) {
      throw new TypeError('Compute transfer must be exactly boolean');
    }
  }

  _assertBackendSupported(backend, operation) {
    const capabilitySet = backend === 'gpu'
      ? GPU_CAPABLE_OPERATIONS
      : backend === 'worker'
        ? WORKER_CAPABLE_OPERATIONS
        : CPU_CAPABLE_OPERATIONS;

    if (!capabilitySet.has(operation)) {
      throw new Error(`${backend} backend does not support operation: ${operation}`);
    }
  }

  _assertBackendAvailable(backend) {
    if (backend === 'gpu' && (
      this._gpuStatus !== BackendStatus.AVAILABLE || !this._gpuBackend
    )) {
      throw new Error('GPU backend is unavailable');
    }

    if (backend === 'worker' && (
      this._workerStatus !== BackendStatus.AVAILABLE || !this._workerBackend
    )) {
      if (this._workerStatus === BackendStatus.FAILED) {
        throw this._workerFailure;
      }
      throw new Error('Web Worker backend is unavailable');
    }
  }

  /**
   * Select one backend from declared operation support and probed availability.
   *
   * @param {string} operation
   * @param {'gpu'|'worker'|'cpu'|null} [requestedBackend]
   * @returns {'gpu'|'worker'|'cpu'}
   */
  selectBackend(operation, requestedBackend = null) {
    if (!isValidOperation(operation)) {
      throw new Error(`Unknown compute operation: ${operation}`);
    }

    if (requestedBackend !== null && requestedBackend !== undefined) {
      if (!BACKENDS.has(requestedBackend)) {
        throw new Error(`Unknown compute backend: ${requestedBackend}`);
      }
      this._assertBackendSupported(requestedBackend, operation);
      this._assertBackendAvailable(requestedBackend);
      return requestedBackend;
    }

    if (
      GPU_CAPABLE_OPERATIONS.has(operation) &&
      this._gpuStatus === BackendStatus.AVAILABLE &&
      this._gpuBackend
    ) {
      return 'gpu';
    }

    if (
      WORKER_CAPABLE_OPERATIONS.has(operation) &&
      this._workerStatus === BackendStatus.AVAILABLE &&
      this._workerBackend
    ) {
      return 'worker';
    }

    if (
      WORKER_CAPABLE_OPERATIONS.has(operation)
      && this._workerStatus === BackendStatus.FAILED
    ) {
      throw this._workerFailure;
    }

    if (CPU_CAPABLE_OPERATIONS.has(operation)) {
      return 'cpu';
    }

    throw new Error(`No available backend supports operation: ${operation}`);
  }

  /**
   * Execute an operation exactly once on its preselected backend.
   */
  async execute(operation, payload, options = {}) {
    this._validateExecutionOptions(options);
    if (!this._initialized) {
      await this.init();
    }

    const backend = this.selectBackend(operation, options.backend);
    const startedAt = now();
    const result = await this._executeOnBackend(backend, operation, payload, options);
    const elapsedMs = now() - startedAt;
    requirePlainRecord(result, `Compute result for ${operation}`);

    this._metrics.totalExecutions++;
    this._metrics.totalTimeMs += elapsedMs;
    this._metrics[`${backend}Executions`]++;

    return {
      ...result,
      _compute: {
        operation,
        backend,
        elapsedMs
      }
    };
  }

  async _executeOnBackend(backend, operation, payload, options) {
    switch (backend) {
      case 'gpu':
        return this._executeGPU(operation, payload);
      case 'worker':
        return this._executeWorker(operation, payload, options);
      case 'cpu':
        return this._executeCPU(operation, payload);
      default:
        throw new Error(`Unknown compute backend: ${backend}`);
    }
  }

  async _executeGPU(operation) {
    throw new Error(`No parity-verified GPU implementation for operation: ${operation}`);
  }

  async _executeWorker(operation, payload, options = {}) {
    const backend = this._workerBackend;
    if (!backend) {
      throw new Error('Web Worker backend is unavailable');
    }

    const { timeout = 30000, signal = null, transfer } = options;
    const workerOptions = { timeout, signal };
    if (transfer !== undefined) workerOptions.transfer = transfer;
    try {
      return await backend.execute(operation, payload, workerOptions);
    } catch (error) {
      const terminalFailure = backend.getTerminalFailure();
      if (terminalFailure !== null) {
        this._workerStatus = BackendStatus.FAILED;
        this._workerFailure = terminalFailure;
      }
      throw error;
    }
  }

  async _executeCPU(operation, payload) {
    return executeOperation(operation, payload);
  }

  /**
   * Execute independent tasks and preserve each failure.
   */
  async executeBatch(tasks, options = {}) {
    if (!Array.isArray(tasks)) {
      throw new TypeError('Compute batch tasks must be an array');
    }

    return Promise.all(tasks.map((task) => {
      requirePlainRecord(task, 'Each compute batch task');
      for (const key of Object.keys(task)) {
        if (!BATCH_TASK_KEYS.has(key)) {
          throw new TypeError(`Unknown compute batch task key: ${key}`);
        }
      }
      if (!Object.hasOwn(task, 'operation') || !Object.hasOwn(task, 'payload')) {
        throw new TypeError(
          'Each compute batch task requires operation and payload'
        );
      }
      return this.execute(task.operation, task.payload, options);
    }));
  }

  getStatus() {
    let gpuInfo = null;
    if (this._gpuBackend !== null) {
      if (typeof this._gpuBackend.getInfo !== 'function') {
        throw new TypeError('GPU backend must implement getInfo()');
      }
      gpuInfo = this._gpuBackend.getInfo();
    }
    return {
      initialized: this._initialized,
      gpu: {
        status: this._gpuStatus,
        info: gpuInfo
      },
      worker: {
        status: this._workerStatus,
        stats: this._workerBackend === null
          ? null
          : this._workerBackend.getStats(),
        failure: this._workerFailure === null
          ? null
          : this._workerFailure.message
      }
    };
  }

  getMetrics() {
    return { ...this._metrics };
  }

  resetMetrics() {
    this._metrics = this._newMetrics();
  }

  isGPUAvailable() {
    return this._gpuStatus === BackendStatus.AVAILABLE;
  }

  isWorkerAvailable() {
    return this._workerStatus === BackendStatus.AVAILABLE;
  }

  terminate() {
    if (this._workerBackend !== null) {
      this._workerBackend.terminate();
    }
    this._workerBackend = null;
    this._workerFailure = null;
    if (this._gpuBackend !== null) {
      this._gpuBackend.dispose();
    }
    this._gpuBackend = null;

    this._gpuStatus = BackendStatus.UNAVAILABLE;
    this._workerStatus = BackendStatus.UNKNOWN;
    this._initialized = false;

    if (computeManagerInstance === this) {
      computeManagerInstance = null;
    }
  }
}

/**
 * Get the singleton ComputeManager instance.
 */
export function getComputeManager() {
  if (!computeManagerInstance) {
    computeManagerInstance = new ComputeManager();
  }
  return computeManagerInstance;
}

export default ComputeManager;
