/**
 * Quantization Worker Pool
 *
 * Provides a tiny worker pool dedicated to dequantization so that:
 * - decoding does not block the main thread
 * - multiple fields can be decoded in parallel (bounded concurrency)
 *
 * @module data/quantization-worker-pool
 */

import { validateQuantizationTask } from './quantization-contract.js';

export const QUANTIZATION_BACKEND = Object.freeze({
  MAIN_THREAD: 'main-thread',
  WORKER: 'worker',
});

/**
 * @typedef {'uint8'|'uint16'} QuantizedDType
 *
 * @typedef {{
 *   buffer: ArrayBuffer,
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

    /** @type {Worker[]} */
    this.workers = [];
    /** @type {('idle'|'busy')[]} */
    this.states = [];
    /** @type {Array<Array<{ start: () => void, reject: Function }>>} */
    this.queues = [];

    /** @type {Map<string, { resolve: Function, reject: Function }>} */
    this._pending = new Map();
    this._counter = 0;
    this._rr = 0;

    this._initialized = false;
    this._available = typeof Worker !== 'undefined';
  }

  async init() {
    if (this._initialized) return this._available;
    if (!this._available) return false;

    const workerPath = new URL('./quantization-worker.js', import.meta.url).href;

    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(workerPath, { type: 'module' });
      worker.onmessage = (e) => this._handleMessage(i, e);
      worker.onerror = (e) => this._handleError(i, e);
      this.workers.push(worker);
      this.states.push('idle');
      this.queues.push([]);
    }

    this._initialized = true;
    return true;
  }

  /**
   * @param {number} workerIndex
   * @param {MessageEvent} e
   * @private
   */
  _handleMessage(workerIndex, e) {
    let data;
    try {
      data = validateWorkerResponse(e?.data);
      const pending = this._pending.get(data.requestId);
      if (!pending || pending.workerIndex !== workerIndex) {
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
      });
      return;
    }

    if (!this._available || this.workers.length === 0) {
      // Pool was disabled (e.g., worker error); ignore late messages.
      return;
    }

    this.states[workerIndex] = 'idle';
    const queue = this.queues[workerIndex];
    const next = queue ? queue.shift() : null;
    if (next) next.start();
  }

  /**
   * @param {number} workerIndex
   * @param {ErrorEvent} e
   * @private
   */
  _handleError(workerIndex, e) {
    const message = (
      typeof e?.message === 'string' &&
      e.message.length > 0
    )
      ? e.message
      : 'Quantization worker emitted an invalid error event';
    console.warn('[QuantizationWorkerPool] Worker error:', message);

    // Reject every request owned by the failed worker backend.
    for (const pending of this._pending.values()) {
      try {
        pending.reject(new Error(message));
      } catch (_err) {
        // ignore
      }
    }
    this._pending.clear();

    for (const queue of this.queues) {
      for (const item of queue) {
        try {
          item.reject(new Error(message));
        } catch (_err) {
          // ignore
        }
      }
      queue.length = 0;
    }

    for (const worker of this.workers) {
      try {
        worker.terminate();
      } catch (_err) {
        // ignore
      }
    }

    this.workers.length = 0;
    this.states.length = 0;
    this.queues.length = 0;
    this._available = false;
    this._initialized = true;
  }

  _nextWorkerIndex() {
    const idx = this._rr;
    this._rr = (this._rr + 1) % this.poolSize;
    return idx;
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
    if (!this._available || this.workers.length === 0) {
      throw new Error('Quantization workers unavailable');
    }
    const requestId = `qdec-${Date.now()}-${this._counter++}`;

    return new Promise((resolve, reject) => {
      const start = () => {
        const worker = this.workers[workerIndex];
        if (!worker) {
          reject(new Error('Quantization worker unavailable'));
          return;
        }
        this.states[workerIndex] = 'busy';
        this._pending.set(requestId, {
          resolve,
          reject,
          workerIndex,
        });
        worker.postMessage({ type, payload, requestId }, transferables);
      };

      const queued = { start, reject };
      if (this.states[workerIndex] === 'idle') queued.start();
      else this.queues[workerIndex].push(queued);
    });
  }

  /**
   * Dequantize quantized values into Float32Array in a worker.
   *
   * @param {DequantizeTask} task
   * @returns {Promise<Float32Array>}
   */
  async dequantizeToFloat32(task) {
    validateQuantizationTask(task, 'Quantization worker-pool task');
    const { buffer, dtype, minValue, maxValue, bits } = task;
    const expectedOutputBytes =
      (buffer.byteLength / (bits / 8)) *
      Float32Array.BYTES_PER_ELEMENT;
    const workerIndex = this._nextWorkerIndex();
    const result = await this._execute(
      workerIndex,
      'DEQUANTIZE_TO_F32',
      { buffer, dtype, minValue, maxValue, bits },
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
export function getQuantizationWorkerPool() {
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
  if (!available || !pool.workers || pool.workers.length === 0) {
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
