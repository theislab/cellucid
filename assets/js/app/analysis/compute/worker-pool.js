/**
 * Worker Pool for Analysis Module
 *
 * Owns one bounded set of module workers and one terminal lifecycle. A worker
 * transport failure (`error`, `messageerror`, a dispatch that cannot be
 * posted) invalidates the entire pool because transferred buffers and worker
 * execution state can no longer be proven complete.
 *
 * Nothing here is bounded by wall-clock time. An analysis task is one
 * synchronous call with no progress to measure, and how long it takes is the
 * device's and the data's (`UCELL_FINISH` at 10M cells on few cores): a bound
 * would only turn a slow success into a failure of every task of every
 * window. A task is stopped by its signal (Cancel, a newer run), and a
 * worker that does not come back from a cancelled task is replaced
 * (below).
 *
 * Cancelling is not a failure. A task whose `signal` aborts is rejected with
 * the signal's `AbortError` at once, wherever it is:
 *
 * - queued (or waiting for its dispatch turn), it is never sent;
 * - running, its worker finishes the task (every analysis task is one
 *   synchronous call, which no message can interrupt) and its result is
 *   dropped. A worker that has not come back `ABANDONED_TASK_GRACE_MS` after
 *   the cancel is terminated and replaced by a fresh one, so a cancelled
 *   long task never holds a thread; the replacement gets every state the
 *   pool's broadcasts asked it to keep (`retainAs`) before any other task,
 *   and what replacing cost is in `getStats()`.
 *
 * Other callers' tasks, and the pool, go on untouched.
 *
 * A terminal pool is never revived. It retires itself from the shared
 * `getWorkerPool()` slot the moment it closes, so the next owner that asks for
 * the shared pool receives a fresh one instead of the terminal error forever.
 *
 * Memory (`data/memory-budget.js`): the pool runs one worker per core less
 * two, and no more than the `analysis` share holds the per-cell state a run
 * copies to each worker for (its groups: `ANALYSIS_CONTEXT_BYTES_PER_CELL`
 * of the open cells a worker), decided when the pool is made. The state a
 * run keeps in the workers (`retainAs`) is counted in the `analysis` share
 * while it is kept (`WORKER_CONTEXTS_LABEL`), so a run's genes take what it
 * leaves. Workers that have had nothing to do (no task, no kept state) for
 * `WORKER_IDLE_MS` are ended (`workers/idle-retirement.js`); the next task
 * starts them again, with the same count.
 */

import { debug, debugError } from '../shared/debug-utils.js';
import { analysisWorkerCount } from '../shared/performance-config.js';
import { openCellCount, registerResidentHolder, residencyBudgetBytes } from '../../../data/memory-budget.js';
import { registerIdleWorkers } from '../../../workers/idle-retirement.js';
import { onAbort, abortReason, cancelled } from '../../../utils/abort.js';
import { requireClonedRecord, requireKeys } from '../../../utils/exact-record.js';
import { dataWorkerScript } from '../../../../workers/scripts.js';
import { startWorker } from '../../../workers/worker-script.js';
import { explainWorkerFailure, noteWorkerScript, workerFailureReason } from '../../../workers/worker-failure.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { fromWire } from '../../../utils/error-wire.js';

const POOL_OPTION_KEYS = new Set(['poolSize']);

/**
 * The most per-cell state any run copies to each analysis worker:
 * differential expression's two-group context, a group byte a cell
 * (`groupOfCell`) and the cell's position in its group (`positionInGroup`,
 * 4 bytes), `gene-statistics.js` `createTwoGroupContext`. Marker codes (1 to
 * 4 bytes) and a dot plot's cell groups (2 to 4) hold no more.
 */
export const ANALYSIS_CONTEXT_BYTES_PER_CELL = 5;

/** The ledger label of the state runs keep in the workers (`memory-budget.js`, `analysis` share). */
export const WORKER_CONTEXTS_LABEL = 'analysis worker contexts';

/**
 * Workers to run: one per core less two (`analysisWorkerCount`), and no more
 * than `memoryBytes` holds a run's per-cell state for `cells` open cells in
 * each (at least one).
 *
 * @param {{memoryBytes: number, cells: number, environment?: Object}} options
 * @returns {number}
 */
export function analysisPoolSize({ memoryBytes, cells, environment = globalThis }) {
  const cores = analysisWorkerCount(environment);
  const perWorker = cells * ANALYSIS_CONTEXT_BYTES_PER_CELL;
  if (perWorker === 0) return cores;
  return Math.max(1, Math.min(cores, Math.floor(memoryBytes / perWorker)));
}

/**
 * How long a worker running a cancelled task may take to come back before it
 * is terminated and replaced. Every analysis task is one synchronous call; a
 * gene's statistics take milliseconds, so only a long monolithic task (a run
 * of genes, a clustering pass) is ever cut short this way.
 */
export const ABANDONED_TASK_GRACE_MS = 250;

/**
 * Payload bytes this thread copies into workers within one task. A payload
 * that is not transferred is structured-cloned by `postMessage`, at about
 * 9 GB/s: the density plot of a ten-million-cell page hands each of eight
 * workers its support and weights, about 1 GB in one task (114 ms) when every
 * slice is dispatched at once. Past this budget the next dispatch waits for a
 * task of its own, so no task copies much more than this (about 10 ms).
 */
export const DISPATCH_CLONE_BYTES_PER_TASK = 96 * 1024 * 1024;

/**
 * Bytes `postMessage` copies for a payload sent without transfer: the typed
 * arrays it holds (each buffer once).
 * @param {unknown} value
 * @returns {number}
 */
function clonedPayloadBytes(value) {
  let bytes = 0;
  const seenBuffers = new Set();
  const seenObjects = new Set();
  const scan = candidate => {
    if (candidate === null || typeof candidate !== 'object') return;
    if (ArrayBuffer.isView(candidate) || candidate instanceof ArrayBuffer) {
      const buffer = candidate instanceof ArrayBuffer ? candidate : candidate.buffer;
      if (!seenBuffers.has(buffer)) {
        seenBuffers.add(buffer);
        bytes += candidate.byteLength;
      }
      return;
    }
    if (seenObjects.has(candidate)) return;
    seenObjects.add(candidate);
    for (const item of Array.isArray(candidate) ? candidate : Object.values(candidate)) {
      scan(item);
    }
  };
  scan(value);
  return bytes;
}
/** Whether `value` is a `MessagePort` (a gene route's end), which moves rather than clones. */
function isMessagePort(value) {
  return typeof MessagePort === 'function' && value instanceof MessagePort;
}

const EXECUTION_OPTION_KEYS = new Set(['signal', 'transfer', 'onTiming']);
const BROADCAST_OPTION_KEYS = new Set([...EXECUTION_OPTION_KEYS, 'retainAs', 'releases', 'heldBytes']);

let poolInstance = null;

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

function validateExecutionOptions(options, allowedKeys = EXECUTION_OPTION_KEYS) {
  requireClonedRecord(options, 'Worker execution options');
  requireKeys(options, [], allowedKeys, 'Worker execution options');

  const signal = options.signal === undefined ? null : options.signal;
  if (signal !== null && !(signal instanceof AbortSignal)) {
    throw new TypeError('Worker execution signal must be an AbortSignal or null');
  }
  const transfer = options.transfer === undefined ? true : options.transfer;
  if (typeof transfer !== 'boolean') {
    throw new TypeError('Worker execution transfer must be exactly boolean');
  }
  const onTiming = options.onTiming === undefined ? null : options.onTiming;
  if (onTiming !== null && typeof onTiming !== 'function') {
    throw new TypeError('Worker execution onTiming must be a function');
  }
  return { signal, transfer, onTiming };
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
    detail = workerFailureReason(error);
  }
  return new Error(`Analysis worker ${workerIndex} failed: ${detail}`);
}

function requireStateKey(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

/**
 * Manages analysis module workers.
 */
export class WorkerPool {
  /**
   * @param {Object} [options]
   * @param {number} [options.poolSize] - Positive worker count; by default
   *   one per core less the page's and the reader worker's, as many as the
   *   `analysis` share holds a run's per-cell state for (`analysisPoolSize`).
   */
  constructor(options = {}) {
    requireClonedRecord(options, 'WorkerPool options');
    requireKeys(options, [], POOL_OPTION_KEYS, 'WorkerPool options');

    this.poolSize = options.poolSize === undefined
      ? analysisPoolSize({ memoryBytes: residencyBudgetBytes('analysis'), cells: openCellCount() })
      : requirePositiveSafeInteger(options.poolSize, 'WorkerPool poolSize');

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
    // Dispatch pacing (DISPATCH_CLONE_BYTES_PER_TASK): bytes cloned in the
    // current task, dispatches waiting for a task of their own, and the
    // channel whose messages start those tasks.
    this._clonedThisTask = 0;
    this._pacedDispatches = [];
    this._pacingChannel = null;
    this._pacingScheduled = false;
    // State broadcasts asked workers to keep (`retainAs`), by key in the
    // order set: a worker replaced after a cancel gets them again.
    this._retainedStates = new Map();
    // Workers replaced after a cancelled task outlived its grace, and what
    // replacing cost (terminate to ready, kept state restored).
    this._replacements = { count: 0, lastMs: null, totalMs: 0 };
    /**
     * Per operation type: tasks answered, and moving averages of the time a
     * task waited for a worker and the time it ran (ms). A run's tuner reads
     * a task's own times through `onTiming` (shared/run-tuner.js).
     * @type {Map<string, {count: number, queueMs: number, runMs: number}>}
     */
    this._taskTiming = new Map();

    this._handleMessage = this._handleMessage.bind(this);
    this._handleError = this._handleError.bind(this);

    // The state runs keep in the workers, counted while it is kept; it is in
    // use, so the memory model never trims it.
    this._stopCounting = registerResidentHolder('analysis', {
      label: WORKER_CONTEXTS_LABEL,
      bytes: () => this.keptStateBytes(),
      trim: () => null,
    });
    // Workers with nothing to do end after a while, and start again with the
    // next task (`workers/idle-retirement.js`).
    this._idleWorkers = registerIdleWorkers(() => this._retireIdleWorkers());
  }

  /** What the state runs keep in the workers holds, every worker's copy counted. */
  keptStateBytes() {
    let bytes = 0;
    for (const retained of this._retainedStates.values()) bytes += retained.bytes;
    return bytes;
  }

  /** Nothing to do: no task pending or queued, no state kept for a run. @private */
  _isIdle() {
    return this._lifecycle === 'ready' &&
      this.pendingRequests.size === 0 &&
      this._retainedStates.size === 0 &&
      this._pacedDispatches.length === 0 &&
      this.taskQueues.every(queue => queue.every(task => task.state === 'settled'));
  }

  /**
   * End the workers while the pool has nothing to do; the pool goes back to
   * its first state and starts them again (the same count) for the next task.
   * @private
   */
  _retireIdleWorkers() {
    if (!this._isIdle()) return;
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.workerStates = [];
    this.taskQueues = [];
    this.initialized = false;
    this._lifecycle = 'new';
    this._pacingChannel?.port1.close();
    this._pacingChannel = null;
    debug('WorkerPool', 'Ended idle workers');
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

  /**
   * Start the worker of slot `index` and send it INIT; resolves at its
   * acknowledgement. Messages of a worker that no longer holds its slot (one
   * replaced after a cancel) are ignored.
   * @param {number} index
   * @returns {Promise<boolean>}
   * @private
   */
  _spawnWorker(index) {
    const worker = noteWorkerScript(startWorker(dataWorkerScript(), { type: 'module' }), dataWorkerScript());
    worker.onmessage = event => {
      if (this.workers[index] === worker) this._handleMessage(index, event);
    };
    // The pool fails saying why the worker failed, once that is found
    // (`explainWorkerFailure`: for a script that did not load the browser
    // says nothing). A task posted to it meanwhile fails with the pool.
    worker.onerror = event => {
      if (this.workers[index] !== worker) return;
      void explainWorkerFailure(worker, event).then(reason => {
        if (this.workers[index] === worker) this._handleError(index, { message: reason });
      });
    };
    worker.onmessageerror = error => {
      if (this.workers[index] === worker) this._fail(toWorkerFailure(index, error));
    };

    this.workers[index] = worker;
    this.workerStates[index] = 'starting';
    this.taskQueues[index] ??= [];

    // Answered by the worker's INIT acknowledgement; a script that does not
    // load fails it through `error` (no deadline: a slow load is not one).
    const acknowledgement = new Promise((resolve, reject) => {
      this._initializationAcks.set(index, { resolve, reject });
    });

    worker.postMessage({
      type: 'INIT',
      payload: { id: index }
    });
    return acknowledgement;
  }

  async _initializeWorkers() {
    const acknowledgements = [];
    try {
      for (let index = 0; index < this.poolSize; index++) {
        // One worker per task: each module worker's construction runs on
        // the page's thread, so a pool built in one loop holds it for the
        // sum of them.
        if (index > 0) await new Promise(resolve => setTimeout(resolve, 0));
        if (this._lifecycle !== 'initializing') throw this._terminalError;
        acknowledgements.push(this._spawnWorker(index));
      }

      await Promise.all(acknowledgements);
      if (this._lifecycle !== 'initializing') {
        throw this._terminalError;
      }

      this.initialized = true;
      this._lifecycle = 'ready';
      debug('WorkerPool', `Initialized with ${formatCountOf(this.poolSize, 'worker')}`);
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

  /**
   * Wait until the workers are ready: started now when the pool is new (its
   * first task, or the first after its idle workers ended), or the start
   * under way joined -- a task asked while another started them waits for
   * the same start (`init`). Only a failed or terminated pool refuses, with
   * the error that ended it.
   * @private
   */
  async _ensureReady() {
    if (this._lifecycle === 'new' || this._lifecycle === 'initializing') {
      await this.init();
    }
    if (this._lifecycle !== 'ready') {
      throw this._terminalError ?? new Error(`The analysis worker pool is ${this._lifecycle}, not ready`);
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
    if (
      (this._lifecycle !== 'initializing' && this._lifecycle !== 'ready')
      || pending === undefined
    ) {
      this._fail(
        new Error(
          `Analysis worker ${workerIndex} returned an unexpected INIT acknowledgement`
        )
      );
      return;
    }

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
    if (this._lifecycle !== 'ready' || this.workerStates[workerIndex] === 'starting') {
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
        && (data.error === null || typeof data.error !== 'object' || typeof data.error.message !== 'string')
      )
    ) {
      this._fail(
        new TypeError(
          `Analysis worker ${workerIndex} returned an invalid response record`
        )
      );
      return;
    }

    clearTimeout(pending.graceTimer);
    this.pendingRequests.delete(data.requestId);
    this.workerStates[workerIndex] = 'idle';

    this._recordTiming(pending.task);
    // A cancelled task's caller was answered at the cancel: its result is
    // dropped, and the worker takes the next task.
    if (!pending.abandoned) {
      if (data.success) {
        pending.task.resolve(data.result);
      } else {
        // Its class, kind and words as the worker raised it: a refused
        // allocation stays a RangeError (`utils/error-wire.js`).
        pending.task.reject(fromWire(data.error));
      }
    }
    this._processQueue(workerIndex);
    // Checked once the caller's continuation ran (it may queue the next task).
    queueMicrotask(() => {
      if (this._isIdle()) this._idleWorkers.idle();
    });
  }

  /** Record how long an answered task waited and ran. @private */
  _recordTiming(task) {
    if (!(task.startedAt > 0)) return;
    const done = performance.now();
    const queueMs = task.startedAt - task.createdAt;
    const runMs = done - task.startedAt;
    const timing = this._taskTiming.get(task.type);
    if (timing === undefined) {
      this._taskTiming.set(task.type, { count: 1, queueMs, runMs });
    } else {
      timing.count++;
      timing.queueMs = timing.queueMs * 0.8 + queueMs * 0.2;
      timing.runMs = timing.runMs * 0.8 + runMs * 0.2;
    }
    if (typeof task.onTiming === 'function') {
      try {
        task.onTiming({ queueMs, runMs });
      } catch (error) {
        queueMicrotask(() => { throw error; });
      }
    }
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
    if (poolInstance === this) poolInstance = null;
    this._stopCounting();
    this._idleWorkers.dispose();

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
      pending.reject(terminalError);
    }
    this._initializationAcks.clear();

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.graceTimer);
      pending.task.reject(terminalError);
    }
    this.pendingRequests.clear();
    this._retainedStates.clear();

    for (const queue of this.taskQueues) {
      for (const task of queue) {
        task.reject(terminalError);
      }
      queue.length = 0;
    }
    for (const { task } of this._pacedDispatches) task.reject(terminalError);
    this._pacedDispatches = [];
    this._pacingChannel?.port1.close();
    this._pacingChannel = null;

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
    // A cancelled task stays queued until its turn and is skipped then.
    while (queue.length > 0 && queue[0].state === 'settled') queue.shift();
    if (queue.length === 0) return;
    this._dispatchToWorker(workerIndex, queue.shift());
  }

  /**
   * Dispatch a task to an idle worker, in a later task when this one has
   * already cloned its budget of payload bytes.
   */
  _dispatchToWorker(workerIndex, task) {
    const bytes = task.transfer ? 0 : clonedPayloadBytes(task.payload);
    if (
      bytes > 0 &&
      this._clonedThisTask > 0 &&
      this._clonedThisTask + bytes > DISPATCH_CLONE_BYTES_PER_TASK
    ) {
      // The worker is reserved for this task until its turn comes.
      this.workerStates[workerIndex] = 'busy';
      task.state = 'paced';
      this._pacedDispatches.push({ workerIndex, task, bytes });
      this._schedulePacing();
      return;
    }
    if (bytes > 0) {
      this._clonedThisTask += bytes;
      this._schedulePacing();
    }
    this._postToWorker(workerIndex, task);
  }

  /** Start a new task that resets the clone budget and posts paced dispatches. */
  _schedulePacing() {
    if (this._pacingScheduled) return;
    this._pacingScheduled = true;
    if (this._pacingChannel === null) {
      this._pacingChannel = new MessageChannel();
      this._pacingChannel.port1.onmessage = () => this._runPacedDispatches();
    }
    // Node keeps a process alive while a port is referenced: exactly while a
    // pacing task is pending (a browser has no such notion).
    this._pacingChannel.port1.ref?.();
    this._pacingChannel.port2.postMessage(null);
  }

  _runPacedDispatches() {
    this._pacingScheduled = false;
    this._clonedThisTask = 0;
    while (this._pacedDispatches.length > 0) {
      const { bytes } = this._pacedDispatches[0];
      if (
        this._clonedThisTask > 0 &&
        this._clonedThisTask + bytes > DISPATCH_CLONE_BYTES_PER_TASK
      ) {
        break;
      }
      const { workerIndex, task } = this._pacedDispatches.shift();
      if (this._lifecycle !== 'ready') {
        task.reject(this._terminalError ?? cancelled('closed', 'The analysis workers were closed before the task ran.'));
        continue;
      }
      if (task.state === 'settled') {
        // Cancelled while waiting for its turn: the reserved worker is free.
        this.workerStates[workerIndex] = 'idle';
        queueMicrotask(() => this._processQueue(workerIndex));
        continue;
      }
      this._clonedThisTask += bytes;
      this._postToWorker(workerIndex, task);
    }
    if (this._pacedDispatches.length > 0 || this._clonedThisTask > 0) {
      this._schedulePacing();
    } else {
      this._pacingChannel?.port1.unref?.();
    }
  }

  _postToWorker(workerIndex, task) {
    const {
      type,
      payload,
      requestId,
      signal,
      transfer
    } = task;

    if (task.state === 'settled' || signal?.aborted) {
      // A paced dispatch reserved the worker; it is free again.
      this.workerStates[workerIndex] = 'idle';
      task.reject(abortReason(signal));
      queueMicrotask(() => this._processQueue(workerIndex));
      return;
    }

    task.state = 'running';
    task.startedAt = performance.now();
    this.workerStates[workerIndex] = 'busy';
    this.pendingRequests.set(requestId, {
      task,
      workerIndex,
      type,
      abandoned: false,
      graceTimer: undefined
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
      if (candidate instanceof ArrayBuffer || isMessagePort(candidate)) {
        // A gene route's port (`analysis/data/gene-route.js`) moves too.
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

  /**
   * One task record: settled once, by its worker's answer, a failure of the
   * pool or its signal (the task is then skipped wherever it waits, or
   * abandoned if it runs: module overview).
   * @private
   */
  _createTask(type, payload, execution, resolve, reject) {
    const task = {
      type,
      payload,
      requestId: this._generateRequestId(),
      signal: execution.signal,
      transfer: execution.transfer,
      onTiming: execution.onTiming ?? null,
      createdAt: performance.now(),
      startedAt: 0,
      state: 'queued',
      stopWaiting: () => {},
      resolve: null,
      reject: null
    };
    const settle = (deliver, value) => {
      if (task.state === 'settled') return;
      task.state = 'settled';
      task.stopWaiting();
      deliver(value);
    };
    task.resolve = value => settle(resolve, value);
    task.reject = error => settle(reject, error);
    // One listener per signal however many tasks share it (a run's genes).
    task.stopWaiting = onAbort(execution.signal, () => this._cancelTask(task));
    return task;
  }

  /**
   * A task's signal aborted: its caller is answered now. A queued task is
   * skipped at its turn; a running one is abandoned, and its worker is
   * replaced if it does not come back within `ABANDONED_TASK_GRACE_MS`.
   * @private
   */
  _cancelTask(task) {
    if (task.state === 'settled') return;
    const wasRunning = task.state === 'running';
    const wasPaced = task.state === 'paced';
    task.reject(abortReason(task.signal));
    if (wasPaced) {
      // The worker reserved for its turn is free at once.
      const at = this._pacedDispatches.findIndex(entry => entry.task === task);
      if (at >= 0) {
        const [{ workerIndex }] = this._pacedDispatches.splice(at, 1);
        this.workerStates[workerIndex] = 'idle';
        this._processQueue(workerIndex);
      }
      return;
    }
    if (!wasRunning) return;
    const pending = this.pendingRequests.get(task.requestId);
    if (pending === undefined || pending.abandoned) return;
    pending.abandoned = true;
    pending.graceTimer = setTimeout(
      () => this._replaceWorker(pending),
      ABANDONED_TASK_GRACE_MS
    );
  }

  /**
   * Terminate the worker still running an abandoned task and start a fresh
   * one in its slot. The new worker first gets the state the pool keeps
   * (`retainAs`), then the slot's queued tasks; what replacing cost is kept.
   * @param {Object} pending - The abandoned request
   * @private
   */
  _replaceWorker(pending) {
    if (
      this._lifecycle !== 'ready'
      || this.pendingRequests.get(pending.task.requestId) !== pending
    ) {
      return;
    }
    const index = pending.workerIndex;
    this.pendingRequests.delete(pending.task.requestId);
    const startedAt = performance.now();
    const worker = this.workers[index];
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    try {
      worker.terminate();
    } catch (error) {
      this._fail(toWorkerFailure(index, error));
      return;
    }
    this._spawnWorker(index).then(
      () => {
        if (this._lifecycle !== 'ready') return;
        const restore = [];
        for (const { type, payloadFor } of this._retainedStates.values()) {
          restore.push(this._createTask(
            type,
            requireClonedRecord(payloadFor(index), `Retained ${type} payload`),
            { signal: null, transfer: true },
            () => {},
            error => {
              this._fail(new Error(
                `Analysis worker ${index} could not restore ${type}: ${error.message}`
              ));
            }
          ));
        }
        // Kept state goes first; the last restore marks the cost.
        const last = restore.at(-1) ?? null;
        const recordCost = () => {
          const ms = performance.now() - startedAt;
          this._replacements.count += 1;
          this._replacements.lastMs = ms;
          this._replacements.totalMs += ms;
          debug('WorkerPool', `Replaced worker ${index} after a cancelled task in ${ms.toFixed(1)} ms`);
        };
        if (last === null) {
          recordCost();
        } else {
          const settleLast = last.resolve;
          last.resolve = value => {
            recordCost();
            settleLast(value);
          };
        }
        this.taskQueues[index].unshift(...restore);
        this.workerStates[index] = 'idle';
        this._processQueue(index);
      },
      () => {
        // The pool failed meanwhile; its terminal error says why.
      }
    );
  }

  async execute(type, payload, options = {}) {
    requireTaskType(type);
    requireClonedRecord(payload, 'Worker task payload');
    const execution = validateExecutionOptions(options);
    await this._ensureReady();

    if (execution.signal?.aborted) {
      throw abortReason(execution.signal);
    }
    return new Promise((resolve, reject) => {
      const task = this._createTask(type, payload, execution, resolve, reject);
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
    requireClonedRecord(payload, 'Worker task payload');
    const execution = validateExecutionOptions(options);
    await this._ensureReady();

    if (workerIndex >= this.workers.length) {
      throw new RangeError(`workerIndex ${workerIndex} is outside the worker pool`);
    }
    if (execution.signal?.aborted) {
      throw abortReason(execution.signal);
    }

    return new Promise((resolve, reject) => {
      const task = this._createTask(type, payload, execution, resolve, reject);
      if (this.workerStates[workerIndex] === 'idle') {
        this._dispatchToWorker(workerIndex, task);
      } else {
        this.taskQueues[workerIndex].push(task);
      }
    });
  }

  /**
   * Run one task on every worker (each its own payload).
   *
   * `retainAs` names state the task sets in each worker (a run's groups)
   * that a replaced worker must get again: the pool keeps how to make it
   * (`payloads` must then be a function) until a broadcast `releases` that
   * name, or the broadcast that set it fails or is cancelled.
   *
   * @param {string} type
   * @param {Object[]|((workerIndex: number) => Object)} payloads
   * @param {{signal?: AbortSignal|null, transfer?: boolean, retainAs?: string, releases?: string, heldBytes?: number}} [options] -
   *   `heldBytes`: what each worker holds for the retained state, when it
   *   builds more than its payload (default: the payload's bytes)
   * @returns {Promise<Object[]>} One result per worker
   */
  async broadcast(type, payloads, options = {}) {
    requireTaskType(type);
    if (typeof payloads !== 'function' && !Array.isArray(payloads)) {
      throw new TypeError('Worker broadcast payloads must be an array or function');
    }
    validateExecutionOptions(options, BROADCAST_OPTION_KEYS);
    const { retainAs, releases, heldBytes, ...execution } = options;
    if (retainAs !== undefined) {
      requireStateKey(retainAs, 'Worker broadcast retainAs');
      if (typeof payloads !== 'function') {
        throw new TypeError('Retained worker state must come from a payload function');
      }
    }
    if (heldBytes !== undefined && (retainAs === undefined || !Number.isSafeInteger(heldBytes) || heldBytes < 0)) {
      throw new TypeError('Worker broadcast heldBytes counts retained state: a non-negative integer, with retainAs');
    }
    if (releases !== undefined) requireStateKey(releases, 'Worker broadcast releases');
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
      requireClonedRecord(payload, `Worker broadcast payload ${index}`);
      exactPayloads.push(payload);
    }

    if (releases !== undefined) this._retainedStates.delete(releases);
    let retained = null;
    if (retainAs !== undefined) {
      // Each worker keeps its copy, and what it builds from it (`heldBytes`,
      // when the caller knows it: a two-group context's positions): counted
      // once a worker.
      retained = {
        type,
        payloadFor: payloads,
        bytes: heldBytes !== undefined
          ? heldBytes * exactPayloads.length
          : exactPayloads.reduce((sum, payload) => sum + clonedPayloadBytes(payload), 0),
      };
      // Set again, it moves to the end: replay keeps the order set.
      this._retainedStates.delete(retainAs);
      this._retainedStates.set(retainAs, retained);
    }

    const tasks = [];
    for (let index = 0; index < exactPayloads.length; index++) {
      tasks.push(
        this.executeOnWorker(index, type, exactPayloads[index], execution)
          .then(result => ({ index, result }))
      );
    }
    try {
      const results = await Promise.all(tasks);
      results.sort((left, right) => left.index - right.index);
      return results.map(entry => entry.result);
    } catch (error) {
      if (retained !== null && this._retainedStates.get(retainAs) === retained) {
        this._retainedStates.delete(retainAs);
      }
      throw error;
    }
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
      queuedTasks: this.taskQueues.reduce(
        (sum, queue) => sum + queue.filter(task => task.state !== 'settled').length,
        0
      ),
      replacedWorkers: this._replacements.count,
      lastReplacementMs: this._replacements.lastMs,
      taskTiming: Object.fromEntries(
        [...this._taskTiming].map(([type, timing]) => [type, {
          count: timing.count,
          queueMs: +timing.queueMs.toFixed(2),
          runMs: +timing.runMs.toFixed(2)
        }])
      )
    };
  }

  terminate() {
    if (this._lifecycle !== 'failed' && this._lifecycle !== 'terminated') {
      this._close('terminated', new Error('Worker pool terminated'));
    }
  }

  isReady() {
    return this._lifecycle === 'ready'
      && this.initialized
      && this.workers.length === this.poolSize;
  }

  getTerminalFailure() {
    return this._lifecycle === 'failed' ? this._terminalError : null;
  }

  /**
   * Whether this pool has closed for good (failed or terminated).
   * @returns {boolean}
   */
  isTerminal() {
    return this._lifecycle === 'failed' || this._lifecycle === 'terminated';
  }
}

/**
 * What a run's genes may take of the `analysis` share (`memory-budget.js`):
 * what the state runs keep in the workers leaves of it.
 *
 * @returns {number}
 */
export function analysisRunBudgetBytes() {
  const kept = poolInstance === null ? 0 : poolInstance.keptStateBytes();
  return Math.max(0, residencyBudgetBytes('analysis') - kept);
}

export function getWorkerPool(options) {
  if (poolInstance === null) {
    poolInstance = new WorkerPool(options);
  } else if (options !== undefined) {
    throw new Error('WorkerPool singleton options are accepted only at creation');
  }
  return poolInstance;
}
