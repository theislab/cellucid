/**
 * Quantization Worker Pool
 *
 * Provides a tiny worker pool dedicated to dequantization so that:
 * - decoding does not block the main thread
 * - multiple fields can be decoded in parallel (bounded concurrency)
 *
 * @module data/quantization-worker-pool
 */

import {
  decodedCodeByteLength,
  validateQuantizationTask,
} from './quantization-contract.js';

export const QUANTIZATION_BACKEND = Object.freeze({
  MAIN_THREAD: 'main-thread',
  WORKER: 'worker',
});

/**
 * @typedef {'uint8'|'uint16'} QuantizedDType
 *
 * @typedef {{
 *   buffer: ArrayBuffer,
 *   gzipOutputBytes: number|null,
 *   dtype: QuantizedDType,
 *   minValue: number,
 *   maxValue: number,
 *   bits: 8|16
 * }} DequantizeTask
 */

function validateWorkerResponse(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new Error('Quantization worker response must be an object');
  }
  if (typeof value.success !== 'boolean') {
    throw new Error(
      'Quantization worker response success must be a boolean'
    );
  }
  const expectedKeys = value.success
    ? ['requestId', 'success', 'result']
    : ['requestId', 'success', 'error'];
  const expected = new Set(expectedKeys);
  if (
    expectedKeys.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !expected.has(key))
  ) {
    throw new Error(
      `Quantization worker ${value.success ? 'success' : 'error'} response ` +
      `requires exactly ${expectedKeys.join(', ')}`
    );
  }
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) {
    throw new Error(
      'Quantization worker response requestId must be a non-empty string'
    );
  }
  if (value.success) {
    if (
      value.result === null ||
      typeof value.result !== 'object' ||
      Array.isArray(value.result) ||
      Object.keys(value.result).length !== 1 ||
      !Object.hasOwn(value.result, 'buffer') ||
      !(value.result.buffer instanceof ArrayBuffer)
    ) {
      throw new Error(
        'Quantization worker success result requires exactly one ArrayBuffer'
      );
    }
  } else if (typeof value.error !== 'string' || value.error.length === 0) {
    throw new Error(
      'Quantization worker error response requires a non-empty error string'
    );
  }
  return value;
}

export class QuantizationWorkerPool {
  /**
   * @param {Object} [options]
   * @param {number} [options.poolSize]
   */
  constructor(options = {}) {
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some(key => key !== 'poolSize')
    ) {
      throw new TypeError(
        'Quantization worker-pool options may contain only poolSize'
      );
    }
    if (
      Object.hasOwn(options, 'poolSize') &&
      (
        !Number.isSafeInteger(options.poolSize) ||
        options.poolSize < 1 ||
        options.poolSize > 4
      )
    ) {
      throw new RangeError(
        'Quantization worker-pool poolSize must be an integer from 1 to 4'
      );
    }
    const hardwareConcurrency =
      typeof navigator !== 'undefined'
        ? navigator.hardwareConcurrency
        : 2;
    const detectedPoolSize = (
      Number.isSafeInteger(hardwareConcurrency) &&
      hardwareConcurrency > 0
    )
      ? Math.max(1, Math.min(Math.floor(hardwareConcurrency / 2), 4))
      : 2;
    this.poolSize = Object.hasOwn(options, 'poolSize')
      ? options.poolSize
      : detectedPoolSize;

    /**
     * One slot per worker. A slot whose worker failed holds `null` until its
     * next request spawns the replacement, so a worker script that cannot load
     * fails each request once instead of respawning in a loop.
     * @type {(Worker|null)[]}
     */
    this.workers = [];
    /** @type {('idle'|'busy')[]} */
    this.states = [];
    /** @type {Array<Array<{ start: () => void, reject: Function }>>} */
    this.queues = [];
    /** @type {(string|null)[]} Request each slot is running. */
    this._inFlight = [];

    /** @type {Map<string, { resolve: Function, reject: Function, workerIndex: number }>} */
    this._pending = new Map();
    this._counter = 0;
    this._rr = 0;

    this._initialized = false;
    this._available = typeof Worker !== 'undefined';
  }

  async init() {
    if (this._initialized) return this._available;
    if (!this._available) return false;

    for (let i = 0; i < this.poolSize; i++) {
      this.states.push('idle');
      this.queues.push([]);
      this._inFlight.push(null);
      this.workers.push(null);
      this._spawnWorker(i);
    }

    this._initialized = true;
    return true;
  }

  /**
   * @param {number} workerIndex
   * @returns {Worker}
   * @private
   */
  _spawnWorker(workerIndex) {
    const workerPath = new URL('./quantization-worker.js', import.meta.url).href;
    const worker = new Worker(workerPath, { type: 'module' });
    worker.onmessage = (e) => this._handleMessage(workerIndex, e, worker);
    worker.onerror = (e) => this._handleError(workerIndex, e, worker);
    this.workers[workerIndex] = worker;
    return worker;
  }

  /**
   * @param {number} workerIndex
   * @param {MessageEvent} e
   * @param {Worker} [worker] Sender; messages from a replaced worker are stale.
   * @private
   */
  _handleMessage(workerIndex, e, worker = this.workers[workerIndex]) {
    if (worker == null || this.workers[workerIndex] !== worker) return;
    let data;
    try {
      data = validateWorkerResponse(e?.data);
      const pending = this._pending.get(data.requestId);
      if (
        !pending ||
        pending.workerIndex !== workerIndex ||
        this._inFlight[workerIndex] !== data.requestId
      ) {
        throw new Error(
          `Quantization worker returned unknown requestId "${data.requestId}"`
        );
      }
      this._pending.delete(data.requestId);
      if (data.success) {
        pending.resolve(data.result);
      } else {
        pending.reject(new Error(data.error));
      }
    } catch (error) {
      this._handleError(workerIndex, {
        message: error instanceof Error
          ? error.message
          : 'Quantization worker response validation failed',
      }, worker);
      return;
    }

    this._startNext(workerIndex);
  }

  /**
   * Fail the one request the worker was running, retire that worker, and let
   * the slot's queued requests continue on a replacement.
   *
   * @param {number} workerIndex
   * @param {ErrorEvent|{ message: string }} e
   * @param {Worker} [worker] Failing worker; errors from a replaced worker are stale.
   * @private
   */
  _handleError(workerIndex, e, worker = this.workers[workerIndex]) {
    if (worker == null || this.workers[workerIndex] !== worker) return;
    // The failure is reported through the owning request, not as an
    // uncaught page error.
    if (typeof e?.preventDefault === 'function') e.preventDefault();
    const message = (
      typeof e?.message === 'string' &&
      e.message.length > 0
    )
      ? e.message
      : 'Quantization worker emitted an invalid error event';
    console.warn('[QuantizationWorkerPool] Worker error:', message);

    try {
      worker.terminate();
    } catch (_err) {
      // A worker that cannot be terminated is already gone.
    }
    this.workers[workerIndex] = null;

    const requestId = this._inFlight[workerIndex];
    const pending = requestId === null ? null : this._pending.get(requestId);
    if (pending) {
      this._pending.delete(requestId);
      pending.reject(new Error(message));
    }
    this._startNext(workerIndex);
  }

  /**
   * @param {number} workerIndex
   * @private
   */
  _startNext(workerIndex) {
    this.states[workerIndex] = 'idle';
    this._inFlight[workerIndex] = null;
    const next = this.queues[workerIndex].shift();
    if (next) next.start();
  }

  _nextWorkerIndex() {
    let best = 0;
    let bestLoad = Infinity;
    for (let offset = 0; offset < this.poolSize; offset++) {
      const index = (this._rr + offset) % this.poolSize;
      const load = (this.states[index] === 'busy' ? 1 : 0) + this.queues[index].length;
      if (load < bestLoad) {
        best = index;
        bestLoad = load;
        if (load === 0) break;
      }
    }
    this._rr = (best + 1) % this.poolSize;
    return best;
  }

  /**
   * @param {number} workerIndex
   * @param {string} type
   * @param {Object} payload
   * @param {Transferable[]} transferables
   * @returns {Promise<any>}
   * @private
   */
  async _execute(workerIndex, type, payload, transferables) {
    await this.init();
    if (!this._available) {
      throw new Error('Quantization workers unavailable');
    }
    const requestId = `qdec-${Date.now()}-${this._counter++}`;

    return new Promise((resolve, reject) => {
      const start = () => {
        this.states[workerIndex] = 'busy';
        this._inFlight[workerIndex] = requestId;
        this._pending.set(requestId, {
          resolve,
          reject,
          workerIndex,
        });
        try {
          const worker = this.workers[workerIndex] ??
            this._spawnWorker(workerIndex);
          worker.postMessage({ type, payload, requestId }, transferables);
        } catch (error) {
          this._pending.delete(requestId);
          reject(error);
          this._startNext(workerIndex);
        }
      };

      const queued = { start, reject };
      if (this.states[workerIndex] === 'idle') queued.start();
      else this.queues[workerIndex].push(queued);
    });
  }

  /**
   * Decode one quantized payload transfer (inflating it first when it is
   * gzip) into a Float32Array in a worker.
   *
   * @param {DequantizeTask} task
   * @returns {Promise<Float32Array>}
   */
  async dequantizeToFloat32(task) {
    validateQuantizationTask(task, 'Quantization worker-pool task');
    const { buffer, gzipOutputBytes, dtype, minValue, maxValue, bits } = task;
    const expectedOutputBytes =
      (decodedCodeByteLength(task) / (bits / 8)) *
      Float32Array.BYTES_PER_ELEMENT;
    const workerIndex = this._nextWorkerIndex();
    const result = await this._execute(
      workerIndex,
      'DEQUANTIZE_TO_F32',
      { buffer, gzipOutputBytes, dtype, minValue, maxValue, bits },
      [buffer]
    );

    const outBuffer = (
      result !== null &&
      typeof result === 'object' &&
      Object.hasOwn(result, 'buffer')
    )
      ? result.buffer
      : null;
    if (!(outBuffer instanceof ArrayBuffer)) {
      throw new Error('dequantizeToFloat32: invalid worker result');
    }
    if (outBuffer.byteLength !== expectedOutputBytes) {
      throw new Error(
        'dequantizeToFloat32: worker result length does not match the input'
      );
    }
    return new Float32Array(outBuffer);
  }
}

let _pool = null;

/**
 * @returns {QuantizationWorkerPool}
 */
function getQuantizationWorkerPool() {
  if (!_pool) _pool = new QuantizationWorkerPool();
  return _pool;
}

/**
 * Select one supported quantization backend before payload acquisition.
 * A runtime failure after worker selection remains a worker failure.
 *
 * @returns {Promise<'main-thread'|'worker'>}
 */
export async function selectQuantizationBackend() {
  if (typeof Worker === 'undefined') {
    return QUANTIZATION_BACKEND.MAIN_THREAD;
  }

  const pool = getQuantizationWorkerPool();
  const available = await pool.init();
  if (!available) {
    throw new Error('Quantization workers unavailable');
  }
  return QUANTIZATION_BACKEND.WORKER;
}

/**
 * Execute one task on the already selected worker backend.
 *
 * @param {DequantizeTask} task
 * @returns {Promise<Float32Array>}
 */
export async function dequantizeToFloat32InWorker(task) {
  validateQuantizationTask(task, 'Quantization worker-pool task');
  const pool = getQuantizationWorkerPool();
  return pool.dequantizeToFloat32(task);
}
