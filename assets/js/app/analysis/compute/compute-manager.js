/**
 * Unified Compute Manager for Analysis Module
 *
 * Chooses one declared, available backend before an operation starts. Worker
 * and CPU execution share operation-handlers.js, so changing the selected
 * backend does not change the scientific contract. An execution error is
 * returned unchanged to the caller.
 *
 * Every operation takes a `signal`: aborting it rejects the operation with
 * an `AbortError` at once and stops its work (`worker-pool.js`); it is not
 * a failure and never retires the pool.
 *
 * A terminal worker pool (crash or timeout) fails the
 * operations it owned and is then retired: `getStatus()` keeps reporting the
 * failure, and the next `init()` or `execute()` discovers a fresh pool rather
 * than rejecting every later worker operation until the page reloads.
 */

import {
  CPU_CAPABLE_OPERATIONS,
  WORKER_CAPABLE_OPERATIONS,
  isValidOperation
} from './operations.js';
import { executeOperation } from './operation-handlers.js';
import { debug } from '../shared/debug-utils.js';
// A cancelled operation never starts.
import { throwIfAborted } from '../../jobs/cancellable-job.js';
import { requireClonedRecord, requireKeys } from '../../../utils/exact-record.js';
import { formatCountOf } from '../../../utils/format-units.js';

let workerPoolModule = null;
let computeManagerInstance = null;

const BACKENDS = new Set(['worker', 'cpu']);
const EXECUTION_OPTIONS = new Set(['backend', 'timeout', 'signal', 'transfer', 'onTiming', 'worker']);
const BROADCAST_OPTIONS = new Set([...EXECUTION_OPTIONS, 'retainAs', 'releases']);

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
    this._workerStatus = BackendStatus.UNKNOWN;

    this._workerBackend = null;
    this._workerFailure = null;

    this._initialized = false;
    this._initPromise = null;
  }

  /**
   * Initialize declared external backends.
   *
   * Backend initialization is capability discovery, not operation execution.
   * An unavailable worker is recorded before any scientific operation begins.
   */
  async init() {
    this._retireTerminalWorker();
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
    await this._initWorker();
    this._initialized = true;

    debug('ComputeManager', `Initialized - Worker: ${this._workerStatus}`);
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
        `Worker pool available: ${formatCountOf(pool.getStats().poolSize, 'worker')}`
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

  /**
   * Retire a worker backend that has closed for good, wherever that happened
   * (this manager, marker discovery, or an explicit terminate). Its failure
   * stays visible in `getStatus()` until the next discovery replaces it.
   */
  _retireTerminalWorker() {
    const backend = this._workerBackend;
    if (backend === null || !backend.isTerminal()) return;
    const failure = backend.getTerminalFailure();
    this._workerBackend = null;
    this._workerStatus = BackendStatus.FAILED;
    this._workerFailure = failure instanceof Error
      ? failure
      : new Error('Analysis worker pool was terminated');
    this._initialized = false;
  }

  _validateExecutionOptions(options, allowed = EXECUTION_OPTIONS) {
    requireClonedRecord(options, 'Execution options');
    requireKeys(options, [], allowed, 'Execution options');
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
    if (
      Object.hasOwn(options, 'onTiming')
      && typeof options.onTiming !== 'function'
    ) {
      throw new TypeError('Compute onTiming must be a function');
    }
    if (
      Object.hasOwn(options, 'worker')
      && (!Number.isSafeInteger(options.worker) || options.worker < 0)
    ) {
      throw new TypeError('Compute worker must be a non-negative safe integer');
    }
  }

  _assertBackendSupported(backend, operation) {
    const capabilitySet = backend === 'worker'
      ? WORKER_CAPABLE_OPERATIONS
      : CPU_CAPABLE_OPERATIONS;

    if (!capabilitySet.has(operation)) {
      throw new Error(`${backend} backend does not support operation: ${operation}`);
    }
  }

  _assertBackendAvailable(backend) {
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
   * @param {'worker'|'cpu'|null} [requestedBackend]
   * @returns {'worker'|'cpu'}
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
   * Execute an operation exactly once on its preselected backend. `worker`
   * runs it on that analysis worker: a task whose genes were delivered there
   * over a gene route (`analysis/data/gene-route.js`).
   */
  async execute(operation, payload, options = {}) {
    this._validateExecutionOptions(options);
    await this.init();

    const backend = this.selectBackend(operation, options.backend);
    if (options.worker !== undefined && backend !== 'worker') {
      throw new Error(`A task for analysis worker ${options.worker} runs on the worker backend, not ${backend}`);
    }
    const startedAt = now();
    const result = await this._executeOnBackend(backend, operation, payload, options);
    const elapsedMs = now() - startedAt;
    requireClonedRecord(result, `Compute result for ${operation}`);

    return {
      ...result,
      _compute: {
        operation,
        backend,
        elapsedMs
      }
    };
  }

  /**
   * Run an operation once on every compute thread of the selected backend —
   * each analysis worker, or this thread for the CPU backend — for state an
   * operation holds there (a run's groups) before the run's per-gene work.
   *
   * @param {string} operation
   * @param {(threadIndex: number) => Object} payloadFor - A payload per thread
   *   (each is transferred, so each must own its buffers)
   * `retainAs` / `releases` name state a worker keeps for later tasks, which
   * a worker replaced after a cancelled task gets again (`WorkerPool.broadcast`).
   *
   * @param {{backend?: 'worker'|'cpu', timeout?: number, signal?: AbortSignal|null, retainAs?: string, releases?: string}} [options]
   * @returns {Promise<Object[]>} One result per thread
   */
  async broadcast(operation, payloadFor, options = {}) {
    this._validateExecutionOptions(options, BROADCAST_OPTIONS);
    if (typeof payloadFor !== 'function') {
      throw new TypeError('Broadcast payloads must come from a function of the thread index');
    }
    await this.init();
    const backend = this.selectBackend(operation, options.backend);
    if (backend === 'cpu') {
      throwIfAborted(options.signal);
      return [executeOperation(operation, payloadFor(0))];
    }
    const pool = this._workerBackend;
    if (!pool) throw new Error('Web Worker backend is unavailable');
    const { timeout = 30000, signal = null, retainAs, releases } = options;
    const kept = {};
    if (retainAs !== undefined) kept.retainAs = retainAs;
    if (releases !== undefined) kept.releases = releases;
    try {
      return await pool.broadcast(operation, payloadFor, { timeout, signal, ...kept });
    } finally {
      this._retireTerminalWorker();
    }
  }

  async _executeOnBackend(backend, operation, payload, options) {
    switch (backend) {
      case 'worker':
        return this._executeWorker(operation, payload, options);
      case 'cpu': {
        throwIfAborted(options.signal);
        const startedAt = now();
        const result = await this._executeCPU(operation, payload);
        options.onTiming?.({ queueMs: 0, runMs: now() - startedAt });
        return result;
      }
      default:
        throw new Error(`Unknown compute backend: ${backend}`);
    }
  }

  async _executeWorker(operation, payload, options = {}) {
    const backend = this._workerBackend;
    if (!backend) {
      throw new Error('Web Worker backend is unavailable');
    }

    const { timeout = 30000, signal = null, transfer, onTiming, worker } = options;
    const workerOptions = { timeout, signal };
    if (transfer !== undefined) workerOptions.transfer = transfer;
    if (onTiming !== undefined) workerOptions.onTiming = onTiming;
    try {
      return worker === undefined
        ? await backend.execute(operation, payload, workerOptions)
        : await backend.executeOnWorker(worker, operation, payload, workerOptions);
    } finally {
      this._retireTerminalWorker();
    }
  }

  /**
   * The worker pool behind the worker backend, for a run that opens a gene
   * route to its workers; null when the worker backend is unavailable.
   *
   * @returns {import('./worker-pool.js').WorkerPool|null}
   */
  workerPool() {
    return this._workerStatus === BackendStatus.AVAILABLE ? this._workerBackend : null;
  }

  async _executeCPU(operation, payload) {
    return executeOperation(operation, payload);
  }

  getStatus() {
    return {
      initialized: this._initialized,
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

  terminate() {
    if (this._workerBackend !== null) {
      this._workerBackend.terminate();
    }
    this._workerBackend = null;
    this._workerFailure = null;
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
