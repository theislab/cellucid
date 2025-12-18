/**
 * Quantization Worker Pool
 *
 * Provides a tiny worker pool dedicated to dequantization so that:
 * - decoding does not block the main thread
 * - multiple fields can be decoded in parallel (bounded concurrency)
 *
 * @module data/quantization-worker-pool
 */

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

class QuantizationWorkerPool {
  /**
   * @param {Object} [options]
   * @param {number} [options.poolSize]
   */
  constructor(options = {}) {
    const desired = Number.isFinite(options.poolSize) ? Math.floor(options.poolSize) : null;
    const hc = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 2;
    this.poolSize = Math.max(1, Math.min(desired || Math.max(1, Math.floor(hc / 2)), 4));

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
    const data = e?.data || {};
    const { requestId, success, result, error } = data;

    const pending = this._pending.get(requestId);
    if (pending) {
      this._pending.delete(requestId);
      if (success) pending.resolve(result);
      else pending.reject(new Error(error || 'Worker task failed'));
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
    const message = e?.message || 'Quantization worker error';
    console.warn('[QuantizationWorkerPool] Worker error:', message);

    // Reject any pending requests and queued work; fall back to main-thread decode.
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
        this._pending.set(requestId, { resolve, reject });
        worker.postMessage({ type, payload, requestId }, transferables);
      };

      const queued = { start, reject };
      if (this.states[workerIndex] === 'idle') queued.start();
      else this.queues[workerIndex].push(queued);
    });
  }

  /**
   * Dequantize quantized values into Float32Array in a worker.
   * Falls back to rejection if workers are unavailable.
   *
   * @param {DequantizeTask} task
   * @returns {Promise<Float32Array>}
   */
  async dequantizeToFloat32(task) {
    const { buffer, dtype, minValue, maxValue, bits } = task || {};
    if (!(buffer instanceof ArrayBuffer)) {
      throw new Error('dequantizeToFloat32: missing buffer');
    }
    const workerIndex = this._nextWorkerIndex();
    const result = await this._execute(
      workerIndex,
      'DEQUANTIZE_TO_F32',
      { buffer, dtype, minValue, maxValue, bits },
      [buffer]
    );

    const outBuffer = result?.buffer;
    if (!(outBuffer instanceof ArrayBuffer)) {
      throw new Error('dequantizeToFloat32: invalid worker result');
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
 * Convenience: Dequantize in worker when available.
 * @param {DequantizeTask} task
 * @returns {Promise<Float32Array|null>} Float32Array or null if worker unavailable
 */
export async function tryDequantizeToFloat32(task) {
  const pool = getQuantizationWorkerPool();
  await pool.init();
  if (!pool.workers || pool.workers.length === 0) return null;
  // IMPORTANT: this transfers the input ArrayBuffer; callers must not rely on fallback decode.
  return pool.dequantizeToFloat32(task);
}

export default {
  getQuantizationWorkerPool,
  tryDequantizeToFloat32
};
