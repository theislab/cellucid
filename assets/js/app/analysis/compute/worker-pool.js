/**
 * Worker Pool for Analysis Module
 *
 * Owns one bounded set of module workers and one terminal lifecycle. A worker
 * transport failure, running-task timeout, or running-task abort invalidates
 * the entire pool because transferred buffers and worker execution state can
 * no longer be proven complete.
 */

import { debug, debugError } from '../shared/debug-utils.js';

const POOL_OPTION_KEYS = new Set(['poolSize', 'defaultTimeout']);
const EXECUTION_OPTION_KEYS = new Set(['timeout', 'signal', 'transfer']);

let poolInstance = null;

function requireRecord(value, label) {
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

function requireExactKeys(record, allowedKeys, label) {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${label} contains unknown key "${key}"`);
    }
  }
}

function requirePositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireTaskType(type) {
  if (typeof type !== 'string' || type.length === 0 || type !== type.trim()) {
    throw new TypeError('Worker task type must be a non-empty trimmed string');
  }
  return type;
}

function validateExecutionOptions(options, defaultTimeout) {
  requireRecord(options, 'Worker execution options');
  requireExactKeys(options, EXECUTION_OPTION_KEYS, 'Worker execution options');

  const timeout = options.timeout === undefined
    ? defaultTimeout
    : requirePositiveSafeInteger(options.timeout, 'Worker request timeout');
  const signal = options.signal === undefined ? null : options.signal;
  if (signal !== null && !(signal instanceof AbortSignal)) {
    throw new TypeError('Worker execution signal must be an AbortSignal or null');
  }
  const transfer = options.transfer === undefined ? true : options.transfer;
  if (typeof transfer !== 'boolean') {
    throw new TypeError('Worker execution transfer must be exactly boolean');
  }
  return { timeout, signal, transfer };
}

function toWorkerFailure(workerIndex, error) {
  let detail;
  if (error instanceof Error) {
    detail = error.message;
  } else if (
    error !== null
    && typeof error === 'object'
    && typeof error.message === 'string'
    && error.message.length > 0
  ) {
    detail = error.message;
  } else {
    detail = 'worker emitted an invalid error event';
  }
  return new Error(`Analysis worker ${workerIndex} failed: ${detail}`);
}

function createAbortError() {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Manages analysis module workers.
 */
export class WorkerPool {
  /**
   * @param {Object} [options]
   * @param {number} [options.poolSize] - Positive worker count.
   * @param {number} [options.defaultTimeout=30000] - Positive request bound in ms.
   */
  constructor(options = {}) {
    requireRecord(options, 'WorkerPool options');
    requireExactKeys(options, POOL_OPTION_KEYS, 'WorkerPool options');

    const hardwareConcurrency = globalThis.navigator?.hardwareConcurrency;
    const detectedPoolSize = hardwareConcurrency === undefined
      ? 4
      : Math.min(
          requirePositiveSafeInteger(
            hardwareConcurrency,
            'navigator.hardwareConcurrency'
          ),
          8
        );

    this.poolSize = options.poolSize === undefined
      ? detectedPoolSize
      : requirePositiveSafeInteger(options.poolSize, 'WorkerPool poolSize');
    this.defaultTimeout = options.defaultTimeout === undefined
      ? 30_000
      : requirePositiveSafeInteger(
          options.defaultTimeout,
          'WorkerPool defaultTimeout'
        );

    this.workers = [];
    this.workerStates = [];
    this.taskQueues = [];
    this.pendingRequests = new Map();
    this.requestIdCounter = 0;

    this.initialized = false;
    this.workersAvailable = typeof globalThis.Worker === 'function';
    this._lifecycle = 'new';
    this._terminalError = null;
    this._initPromise = null;
    this._initializationAcks = new Map();
    this._nextWorkerIndex = 0;

    this._handleMessage = this._handleMessage.bind(this);
    this._handleError = this._handleError.bind(this);
  }

  /**
   * Construct every worker and wait for its exact INIT acknowledgement.
   * @returns {Promise<boolean>}
   */
  async init() {
    if (this._lifecycle === 'ready') return true;
    if (this._lifecycle === 'initializing') return this._initPromise;
    if (this._lifecycle === 'failed' || this._lifecycle === 'terminated') {
      throw this._terminalError;
    }
    if (!this.workersAvailable) {
      const failure = this._fail(new Error('Web Workers are unavailable'));
      throw failure;
    }

    this._lifecycle = 'initializing';
    this._initPromise = this._initializeWorkers();
    try {
      return await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  async _initializeWorkers() {
    const acknowledgements = [];
    try {
      const workerPath = new URL('./data-worker.js', import.meta.url).href;
      for (let index = 0; index < this.poolSize; index++) {
        const worker = new globalThis.Worker(workerPath, { type: 'module' });
        worker.onmessage = event => this._handleMessage(index, event);
        worker.onerror = error => this._handleError(index, error);
        worker.onmessageerror = error => {
          this._fail(toWorkerFailure(index, error));
        };

        this.workers.push(worker);
        this.workerStates.push('starting');
        this.taskQueues.push([]);

        const acknowledgement = new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            this._fail(
              new Error(
                `Analysis worker ${index} initialization timed out after ` +
                `${this.defaultTimeout}ms`
              )
            );
          }, this.defaultTimeout);
          this._initializationAcks.set(index, {
            resolve,
            reject,
            timeoutId
          });
        });
        acknowledgements.push(acknowledgement);

        worker.postMessage({
          type: 'INIT',
          payload: { id: index, poolSize: this.poolSize }
        });
      }

      await Promise.all(acknowledgements);
      if (this._lifecycle !== 'initializing') {
        throw this._terminalError;
      }

      this.initialized = true;
      this._lifecycle = 'ready';
      debug('WorkerPool', `Initialized with ${this.poolSize} workers`);
      return true;
    } catch (error) {
      const failure = this._terminalError ?? (
        error instanceof Error
          ? error
          : new TypeError('WorkerPool initialization failed with a non-Error value')
      );
      throw this._fail(failure);
    }
  }

  async _ensureReady() {
    if (this._lifecycle === 'new') {
      await this.init();
    }
    if (this._lifecycle !== 'ready') {
      throw this._terminalError;
    }
  }

  _handleInitializationAck(workerIndex, data) {
    const keys = Object.keys(data).sort();
    if (
      keys.length !== 2
      || keys[0] !== 'type'
      || keys[1] !== 'workerId'
      || data.type !== 'INIT_ACK'
      || data.workerId !== workerIndex
    ) {
      this._fail(
        new TypeError(
          `Analysis worker ${workerIndex} returned an invalid INIT acknowledgement`
        )
      );
      return;
    }

    const pending = this._initializationAcks.get(workerIndex);
    if (this._lifecycle !== 'initializing' || pending === undefined) {
      this._fail(
        new Error(
          `Analysis worker ${workerIndex} returned an unexpected INIT acknowledgement`
        )
      );
      return;
    }

    clearTimeout(pending.timeoutId);
    this._initializationAcks.delete(workerIndex);
    this.workerStates[workerIndex] = 'idle';
    pending.resolve(true);
  }

  _handleMessage(workerIndex, event) {
    if (this._lifecycle === 'failed' || this._lifecycle === 'terminated') {
      return;
    }
    const data = event?.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      this._fail(
        new TypeError(`Analysis worker ${workerIndex} returned a non-object message`)
      );
      return;
    }

    if (data.type === 'INIT_ACK') {
      this._handleInitializationAck(workerIndex, data);
      return;
    }
    if (this._lifecycle !== 'ready') {
      this._fail(
        new Error(`Analysis worker ${workerIndex} returned work before initialization`)
      );
      return;
    }

    if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
      this._fail(
        new TypeError(`Analysis worker ${workerIndex} response requires requestId`)
      );
      return;
    }
    const pending = this.pendingRequests.get(data.requestId);
    if (pending === undefined || pending.workerIndex !== workerIndex) {
      this._fail(
        new Error(
          `Analysis worker ${workerIndex} returned unknown request ` +
          `"${data.requestId}"`
        )
      );
      return;
    }

    const expectedKeys = data.success === true
      ? ['requestId', 'result', 'success']
      : ['error', 'requestId', 'success'];
    const actualKeys = Object.keys(data).sort();
    if (
      typeof data.success !== 'boolean'
      || actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])
      || (
        data.success === false
        && (typeof data.error !== 'string' || data.error.length === 0)
      )
    ) {
      this._fail(
        new TypeError(
          `Analysis worker ${workerIndex} returned an invalid response record`
        )
      );
      return;
    }

    clearTimeout(pending.timeoutId);
    if (pending.signal !== null && pending.abortHandler !== null) {
      pending.signal.removeEventListener('abort', pending.abortHandler);
    }
    this.pendingRequests.delete(data.requestId);
    this.workerStates[workerIndex] = 'idle';

    if (data.success) {
      pending.resolve(data.result);
    } else {
      pending.reject(new Error(data.error));
    }
    this._processQueue(workerIndex);
  }

  _handleError(workerIndex, error) {
    const failure = this._fail(toWorkerFailure(workerIndex, error));
    debugError('WorkerPool', failure.message);
  }

  _close(lifecycle, primaryError) {
    if (this._lifecycle === 'failed' || this._lifecycle === 'terminated') {
      return this._terminalError;
    }
    if (!(primaryError instanceof Error)) {
      throw new TypeError('WorkerPool terminal state requires an Error');
    }

    this._lifecycle = lifecycle;
    this.initialized = false;
    this._terminalError = primaryError;

    const cleanupErrors = [];
    for (const worker of this.workers) {
      try {
        worker.terminate();
      } catch (error) {
        cleanupErrors.push(
          error instanceof Error
            ? error
            : new TypeError('Analysis worker termination failed with a non-Error value')
        );
      }
    }
    const terminalError = cleanupErrors.length === 0
      ? primaryError
      : new AggregateError(
          [primaryError, ...cleanupErrors],
          'WorkerPool termination encountered multiple failures'
        );
    this._terminalError = terminalError;

    for (const pending of this._initializationAcks.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(terminalError);
    }
    this._initializationAcks.clear();

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeoutId);
      if (pending.signal !== null && pending.abortHandler !== null) {
        pending.signal.removeEventListener('abort', pending.abortHandler);
      }
      pending.reject(terminalError);
    }
    this.pendingRequests.clear();

    for (const queue of this.taskQueues) {
      for (const task of queue) {
        task.reject(terminalError);
      }
      queue.length = 0;
    }

    this.workers = [];
    this.workerStates = [];
    this.taskQueues = [];
    return terminalError;
  }

  _fail(error) {
    return this._close('failed', error);
  }

  _processQueue(workerIndex) {
    if (
      this._lifecycle !== 'ready'
      || this.workerStates[workerIndex] !== 'idle'
    ) {
      return;
    }
    const queue = this.taskQueues[workerIndex];
    if (queue.length === 0) return;
    this._dispatchToWorker(workerIndex, queue.shift());
  }

  _dispatchToWorker(workerIndex, task) {
    const {
      type,
      payload,
      requestId,
      resolve,
      reject,
      timeout,
      signal,
      transfer
    } = task;

    if (signal?.aborted) {
      reject(createAbortError());
      queueMicrotask(() => this._processQueue(workerIndex));
      return;
    }

    this.workerStates[workerIndex] = 'busy';
    const timeoutId = setTimeout(() => {
      this._fail(
        new Error(`Worker request timed out after ${timeout}ms`)
      );
    }, timeout);

    let abortHandler = null;
    if (signal !== null) {
      abortHandler = () => {
        this._fail(createAbortError());
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    this.pendingRequests.set(requestId, {
      resolve,
      reject,
      timeoutId,
      workerIndex,
      type,
      signal,
      abortHandler
    });

    try {
      const transferables = transfer ? this._collectTransferables(payload) : [];
      this.workers[workerIndex].postMessage(
        { type, payload, requestId },
        transferables
      );
    } catch (error) {
      const detail = error instanceof Error
        ? error
        : new TypeError('Worker dispatch failed with a non-Error value');
      this._fail(
        new Error(`Analysis worker ${workerIndex} dispatch failed: ${detail.message}`)
      );
    }
  }

  _collectTransferables(value) {
    const transferables = [];
    const seenBuffers = new Set();
    const seenObjects = new Set();

    const scan = candidate => {
      if (candidate === null || candidate === undefined) return;
      if (candidate instanceof ArrayBuffer) {
        if (!seenBuffers.has(candidate)) {
          seenBuffers.add(candidate);
          transferables.push(candidate);
        }
        return;
      }
      if (ArrayBuffer.isView(candidate)) {
        if (
          candidate.buffer instanceof ArrayBuffer
          && !seenBuffers.has(candidate.buffer)
        ) {
          seenBuffers.add(candidate.buffer);
          transferables.push(candidate.buffer);
        }
        return;
      }
      if (typeof candidate !== 'object' || seenObjects.has(candidate)) return;
      seenObjects.add(candidate);
      if (Array.isArray(candidate)) {
        for (const item of candidate) scan(item);
        return;
      }
      for (const item of Object.values(candidate)) scan(item);
    };

    scan(value);
    return transferables;
  }

  _getNextWorkerIndex() {
    const index = this._nextWorkerIndex;
    this._nextWorkerIndex = (this._nextWorkerIndex + 1) % this.poolSize;
    return index;
  }

  _findIdleWorker() {
    for (let index = 0; index < this.poolSize; index++) {
      if (this.workerStates[index] === 'idle') return index;
    }
    return -1;
  }

  _generateRequestId() {
    return `pool-${++this.requestIdCounter}`;
  }

  async execute(type, payload, options = {}) {
    requireTaskType(type);
    requireRecord(payload, 'Worker task payload');
    const execution = validateExecutionOptions(options, this.defaultTimeout);
    await this._ensureReady();

    if (execution.signal?.aborted) {
      throw createAbortError();
    }
    const requestId = this._generateRequestId();
    return new Promise((resolve, reject) => {
      const task = {
        type,
        payload,
        requestId,
        resolve,
        reject,
        ...execution
      };
      const idleIndex = this._findIdleWorker();
      if (idleIndex >= 0) {
        this._dispatchToWorker(idleIndex, task);
      } else {
        this.taskQueues[this._getNextWorkerIndex()].push(task);
      }
    });
  }

  async executeOnWorker(workerIndex, type, payload, options = {}) {
    if (!Number.isSafeInteger(workerIndex) || workerIndex < 0) {
      throw new TypeError('workerIndex must be a non-negative safe integer');
    }
    requireTaskType(type);
    requireRecord(payload, 'Worker task payload');
    const execution = validateExecutionOptions(options, this.defaultTimeout);
    await this._ensureReady();

    if (workerIndex >= this.workers.length) {
      throw new RangeError(`workerIndex ${workerIndex} is outside the worker pool`);
    }
    if (execution.signal?.aborted) {
      throw createAbortError();
    }

    const requestId = this._generateRequestId();
    return new Promise((resolve, reject) => {
      const task = {
        type,
        payload,
        requestId,
        resolve,
        reject,
        ...execution
      };
      if (this.workerStates[workerIndex] === 'idle') {
        this._dispatchToWorker(workerIndex, task);
      } else {
        this.taskQueues[workerIndex].push(task);
      }
    });
  }

  async broadcast(type, payloads, options = {}) {
    requireTaskType(type);
    if (typeof payloads !== 'function' && !Array.isArray(payloads)) {
      throw new TypeError('Worker broadcast payloads must be an array or function');
    }
    validateExecutionOptions(options, this.defaultTimeout);
    await this._ensureReady();
    if (Array.isArray(payloads) && payloads.length !== this.workers.length) {
      throw new RangeError(
        'Worker broadcast payload array must contain exactly one payload per worker'
      );
    }

    const exactPayloads = [];
    for (let index = 0; index < this.workers.length; index++) {
      const payload = typeof payloads === 'function'
        ? payloads(index)
        : payloads[index];
      requireRecord(payload, `Worker broadcast payload ${index}`);
      exactPayloads.push(payload);
    }

    const tasks = [];
    for (let index = 0; index < exactPayloads.length; index++) {
      tasks.push(
        this.executeOnWorker(index, type, exactPayloads[index], options)
          .then(result => ({ index, result }))
      );
    }
    const results = await Promise.all(tasks);
    results.sort((left, right) => left.index - right.index);
    return results.map(entry => entry.result);
  }

  async executeBatch(tasks, timeout = this.defaultTimeout) {
    if (!Array.isArray(tasks)) {
      throw new TypeError('Worker batch tasks must be an array');
    }
    requirePositiveSafeInteger(timeout, 'Worker batch timeout');
    const exactTasks = tasks.map((task, index) => {
      requireRecord(task, `Worker batch task ${index}`);
      requireExactKeys(
        task,
        new Set(['type', 'payload']),
        `Worker batch task ${index}`
      );
      requireTaskType(task.type);
      requireRecord(task.payload, `Worker batch task ${index} payload`);
      return task;
    });
    return Promise.all(
      exactTasks.map(task => this.execute(task.type, task.payload, { timeout }))
    );
  }

  getStats() {
    const busyWorkers = this.workerStates.filter(state => state === 'busy').length;
    return {
      poolSize: this.poolSize,
      state: this._lifecycle,
      failure: this._lifecycle === 'failed'
        ? this._terminalError.message
        : null,
      busyWorkers,
      idleWorkers: this.workerStates.filter(state => state === 'idle').length,
      pendingRequests: this.pendingRequests.size,
      queuedTasks: this.taskQueues.reduce((sum, queue) => sum + queue.length, 0)
    };
  }

  terminate() {
    if (this._lifecycle !== 'failed' && this._lifecycle !== 'terminated') {
      this._close('terminated', new Error('Worker pool terminated'));
    }
    if (poolInstance === this) poolInstance = null;
  }

  isReady() {
    return this._lifecycle === 'ready'
      && this.initialized
      && this.workers.length === this.poolSize;
  }

  getTerminalFailure() {
    return this._lifecycle === 'failed' ? this._terminalError : null;
  }

  getPendingCount() {
    return this.pendingRequests.size;
  }
}

export function getWorkerPool(options) {
  if (poolInstance === null) {
    poolInstance = new WorkerPool(options);
  } else if (options !== undefined) {
    throw new Error('WorkerPool singleton options are accepted only at creation');
  }
  return poolInstance;
}

export function createWorkerPool(options) {
  return new WorkerPool(options);
}

export default WorkerPool;
