/**
 * Decoding chunks on other cores.
 *
 * The format readers run in one worker thread; decompressing a chunk there
 * (Zstandard, LZ4 and Blosc in JavaScript, DEFLATE through the platform's
 * stream) holds that thread for as long as it takes, so a background pass
 * over a whole matrix would slow every other read behind it. This pool sends
 * a chunk's compressed bytes, with a description of how to decode them, to
 * one of a few decode workers, and gets the decoded bytes back.
 *
 * - **Tasks** are serialisable: a `kind` (`'zarr'`: a Zarr codec list and the
 *   size each codec must produce; `'hdf5'`: an HDF5 filter pipeline, the
 *   chunk's filter mask and its decoded size) and the compressed bytes. A
 *   task whose caller gives its bytes up (`owned`, a view spanning its whole
 *   buffer) has its buffer transferred, once its worker has answered a task;
 *   any other task's bytes are copied out of whatever buffer holds them and
 *   the copy is transferred. The decoded bytes are transferred back. The
 *   worker (`decode-worker.js`) rebuilds a description's decoders once and
 *   keeps them.
 * - **Small chunks travel together**: a chunk decoding to less than
 *   `POOL_MIN_BYTES` costs less to decode than one message to a worker, so
 *   the small chunks waiting at once go to a worker as one message (their
 *   bytes copied into one buffer) when together they are worth one; a small
 *   chunk alone is decoded in this thread.
 * - **Priority**: a `background` task (a gene index being built while no one
 *   waits for it) waits behind every other: a field chosen meanwhile is
 *   decoded first.
 * - **Errors** come back as their name, message and fields, and the caller
 *   rebuilds its own error classes from them (`revive`), so a damaged chunk
 *   fails with the same error and message wherever it was decoded.
 * - **Cancellation**: a read whose signal aborts stops waiting at once. A task
 *   not yet sent is dropped; one already in a worker finishes there and its
 *   result is discarded.
 * - **In this thread** every chunk is decoded when no worker can be made
 *   here: the global `Worker` constructor is missing (Node, a browser without
 *   nested workers), the pool's memory holds none, or a decode worker failed
 *   to start. A task a worker took and could not finish (the worker stopped)
 *   is decoded here from the caller's bytes; only a worker that has answered
 *   before is given bytes by transfer, and should it stop, those tasks fail.
 * - **Lifetime**: workers are made on the first chunk worth sending, or
 *   ahead of it when a store opens (`warmDecodePool()`), up to
 *   `navigator.hardwareConcurrency - 2` (a core each for the reader thread
 *   and the page) and to as many as the pool's memory holds (`memoryBytes`,
 *   at `DECODE_WORKER_BYTES` each), and terminated once none has had work
 *   for `IDLE_MS`, or at once when a store closes
 *   (`releaseIdleDecodeWorkers()`: a worker still decoding for another store
 *   is kept).
 *
 * The callers keep their own limits: how many chunks are decoded at once per
 * store, what a chunk may decode to, and what a read counts as decoded.
 *
 * The same workers take the reader thread's other work on what it has
 * decoded (`runOnDecodeWorker`): a function of a module that depends on
 * nothing else, called with arguments its caller gives up (transferred) and
 * a context a worker is sent once and keeps until it is released (a cell
 * subset's positions, for every run of genes kept in it). In this thread
 * when no worker can be made, or the work is too small to be worth a
 * message.
 *
 * @module formats/io/decode-pool
 */


import { onAbort } from './abort.js';
import { decodeWorkerScript } from '../../../workers/scripts.js';
import { startWorker } from '../../workers/worker-script.js';

/**
 * Smallest decoded chunk worth sending (a scheduling choice, measured): a
 * round trip to a worker costs about as much as decoding this many bytes in
 * this thread.
 */
export const POOL_MIN_BYTES = 32 * 1024;

/**
 * The memory one decode worker holds while it decodes, measured: Chromium on
 * an M1 Pro building the gene index of Suo (gzip CSR, 562k cells, 104 MB
 * stored) grew by 620 MB decoding in the reader thread and by 750, 790 and
 * 950 MB with 2, 4 and 8 decode workers, about 40 MB per worker (its heap,
 * the decompressor's buffers, chunks in flight). Node's worker threads hold
 * 60–110 MB each.
 */
export const DECODE_WORKER_BYTES = 40 * 1024 * 1024;

/** How long workers with nothing to do are kept (a scheduling choice): consecutive reads do not pay start-up again. */
const IDLE_MS = 10_000;

/** Tasks sent to one worker before its first result is back (a scheduling choice): the next is ready when one ends. */
const TASKS_PER_WORKER = 2;

/**
 * How many messages' worth of small chunks travel together (a scheduling
 * choice): one message then costs at most a quarter of the decoding it
 * carries, and a burst of small chunks still spreads over the workers.
 */
const BATCH_MESSAGES = 4;

/**
 * An error as data: what a worker sends back.
 *
 * @param {unknown} error
 * @returns {{name: string, message: string, feature?: string, offset?: number|null}}
 */
export function errorData(error) {
  if (error instanceof Error) {
    const data = { name: error.name, message: error.message };
    if (typeof error.feature === 'string') data.feature = error.feature;
    if (typeof error.offset === 'number' || error.offset === null) data.offset = error.offset;
    return data;
  }
  return { name: 'Error', message: String(error) };
}

/** A generic error carrying `data`'s name and message, for names a caller does not rebuild. */
export function genericError(data) {
  const error = new Error(data.message);
  error.name = data.name;
  return error;
}

function abortReason(signal) {
  return signal.reason ?? new DOMException('The read was aborted.', 'AbortError');
}

/**
 * Decode workers to run: a core each for all but the page and the reader
 * thread (four cores when the browser does not say), and no more than
 * `memoryBytes` holds at `DECODE_WORKER_BYTES` each.
 *
 * @param {number} memoryBytes
 * @returns {number}
 */
export function decodeWorkerCount(memoryBytes, environment = globalThis) {
  const cores = Number(environment?.navigator?.hardwareConcurrency) || 4;
  return Math.max(0, Math.min(Math.max(1, cores - 2), Math.floor(memoryBytes / DECODE_WORKER_BYTES)));
}

function defaultCreateWorker() {
  return startWorker(decodeWorkerScript(), { type: 'module', name: 'cellucid-decode' });
}

/** Whether `input` is a view over the whole of its buffer (it can be transferred as it is). */
function spansBuffer(input) {
  return input.byteOffset === 0 && input.byteLength === input.buffer.byteLength;
}

class DecodePool {
  /**
   * @param {{createWorker: () => Worker, size: number, idleMs: number, minBytes: number}} options
   */
  constructor({ createWorker, size, idleMs, minBytes }) {
    this.createWorker = createWorker;
    this.size = size;
    this.idleMs = idleMs;
    this.minBytes = minBytes;
    /** @type {Array<{worker: Worker, jobs: Map<number, Object|Object[]>, answered: boolean}>} */
    this.workers = [];
    /** Tasks waiting for a worker: foreground first, then background. */
    this.queues = [[], []];
    this.nextId = 1;
    this.idleTimer = null;
    this.pumpScheduled = false;
    this.smallTimer = null;
    /** Set once a worker could not be made or failed to start: every chunk is then decoded here. */
    this.noWorkers = false;
    /** Contexts of work tasks by key: what a worker is sent once, before its first task that names it. */
    this.contexts = new Map();
  }

  /** Keep `data` as the context `key` names, for the work tasks that name it. */
  retain(key, data) {
    this.contexts.set(key, data);
  }

  /** Let the context `key` go: workers that were sent it drop it. */
  release(key) {
    if (!this.contexts.delete(key)) return;
    for (const holder of this.workers) {
      if (!holder.contexts.delete(key)) continue;
      try {
        holder.worker.postMessage({ release: key });
      } catch {
        // A stopped worker holds nothing.
      }
    }
  }

  /**
   * Decode one chunk.
   *
   * @param {{kind: string, description: Object, input: Uint8Array, size: number,
   *          signal?: AbortSignal|null, owned?: boolean, background?: boolean,
   *          revive: (data: Object) => Error,
   *          inThread: () => (Uint8Array|Promise<Uint8Array>)}} task
   * @returns {Promise<Uint8Array>}
   */
  decode(task) {
    const signal = task.signal ?? null;
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.noWorkers) {
      const startedAt = performance.now();
      return Promise.resolve().then(task.inThread).then(value => {
        if (task.kind !== 'run' && value instanceof Uint8Array) noteDecoded(value.length, performance.now() - startedAt);
        return value;
      });
    }
    // Work too small to be worth a message is done here, never batched.
    if (task.kind === 'run' && task.size < this.minBytes) return Promise.resolve().then(task.inThread);
    return new Promise((resolve, reject) => {
      const job = { ...task, id: 0, resolve, reject, settled: false, holder: null, transferred: false, stopWaiting: null };
      // A job cancelled while queued is settled here and dropped when the
      // queue reaches it.
      if (signal !== null) job.stopWaiting = onAbort(signal, () => this.settle(job, null, abortReason(signal)));
      this.queues[task.background === true ? 1 : 0].push(job);
      if (task.size < this.minBytes) {
        // Small chunks arrive one read at a time: they wait for the next
        // task, so those of the reads completing meanwhile travel together.
        this.smallTimer ??= setTimeout(() => {
          this.smallTimer = null;
          this.pump();
        }, 0);
      } else if (!this.pumpScheduled) {
        // Chunks asked for in the same turn are queued before any is sent.
        this.pumpScheduled = true;
        queueMicrotask(() => {
          this.pumpScheduled = false;
          this.pump();
        });
      }
    });
  }

  settle(job, value, error) {
    if (job.settled) return;
    job.settled = true;
    job.stopWaiting?.();
    if (error === null && job.kind !== 'run' && job.startedAt !== undefined && value instanceof Uint8Array) {
      noteDecoded(value.length, performance.now() - job.startedAt);
    }
    if (error !== null) job.reject(error);
    else job.resolve(value);
  }

  /** Decode `job` in this thread (no worker can take it). */
  runHere(job) {
    if (job.settled) return;
    if (job.transferred) {
      this.settle(job, null, new Error('A decode worker stopped while decoding a chunk it was given; read it again.'));
      return;
    }
    job.startedAt ??= performance.now();
    Promise.resolve().then(job.inThread).then(
      value => this.settle(job, value, null),
      error => this.settle(job, null, error)
    );
  }

  /** The next waiting job, foreground first (cancelled ones dropped), or null. */
  peek() {
    for (const queue of this.queues) {
      while (queue.length > 0 && queue[0].settled) queue.shift();
      if (queue.length > 0) return queue;
    }
    return null;
  }

  /**
   * Take what goes to a worker next: one large job, or the small jobs waiting
   * at the head of the same queue, together up to a few messages' worth.
   * Small jobs that together are not worth a message are decoded here.
   */
  take(queue) {
    const first = queue.shift();
    if (first.size >= this.minBytes || first.kind === 'run') return first;
    const batch = [first];
    let bytes = first.size;
    while (queue.length > 0 && bytes < BATCH_MESSAGES * this.minBytes) {
      const next = queue[0];
      if (next.settled) {
        queue.shift();
        continue;
      }
      if (next.size >= this.minBytes || next.kind === 'run') break;
      batch.push(queue.shift());
      bytes += next.size;
    }
    if (bytes < this.minBytes) {
      for (const job of batch) this.runHere(job);
      return null;
    }
    return batch;
  }

  /** Send queued tasks to workers with room, making workers as needed. */
  pump() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    for (let queue = this.peek(); queue !== null; queue = this.peek()) {
      if (this.noWorkers) {
        for (const waiting of this.queues) for (const job of waiting.splice(0)) this.runHere(job);
        return;
      }
      // Small chunks not worth a message are decoded here, with no worker made.
      const next = this.take(queue);
      if (next === null) continue;
      let holder = null;
      for (const candidate of this.workers) {
        if (candidate.jobs.size < TASKS_PER_WORKER && (holder === null || candidate.jobs.size < holder.jobs.size)) holder = candidate;
      }
      if ((holder === null || holder.jobs.size > 0) && this.workers.length < this.size) {
        const made = this.spawn();
        if (made === null) {
          // None could be made: look again (with no more to make, or none at all).
          queue.unshift(...[next].flat());
          continue;
        }
        holder = made;
      }
      if (holder === null) {
        queue.unshift(...[next].flat());
        break;
      }
      if (Array.isArray(next)) this.sendBatch(holder, next);
      else this.send(holder, next);
    }
    this.scheduleIdle();
  }

  /** A new worker, or null (and no more attempts) when none can be made. */
  spawn() {
    let worker;
    try {
      worker = this.createWorker();
    } catch {
      // No more attempts: the workers there are stay; without any, chunks
      // are decoded here.
      this.size = this.workers.length;
      if (this.workers.length === 0) this.noWorkers = true;
      return null;
    }
    const holder = { worker, jobs: new Map(), answered: false, contexts: new Set() };
    worker.addEventListener('message', event => this.onResult(holder, event.data));
    worker.addEventListener('error', event => {
      event.preventDefault?.();
      this.onWorkerFailed(holder);
    });
    worker.addEventListener('messageerror', () => this.onWorkerFailed(holder));
    this.workers.push(holder);
    return holder;
  }

  /** Make every worker the pool may run now, ahead of the first chunk. */
  warm() {
    if (this.noWorkers) return;
    while (this.workers.length < this.size) {
      if (this.spawn() === null) return;
    }
    this.scheduleIdle();
  }

  send(holder, job) {
    if (job.settled) return;
    job.id = this.nextId++;
    job.holder = holder;
    job.startedAt = performance.now();
    holder.jobs.set(job.id, job);
    if (job.kind === 'run') {
      this.sendRun(holder, job);
      return;
    }
    // Bytes the caller gave up go as they are, to a worker that has proved
    // it runs; any others are copied: the caller's may be a view of a larger
    // buffer other chunks share, and a structured clone of a view would copy
    // all of it. The copy is transferred, never cloned.
    const transfer = job.owned === true && holder.answered && spansBuffer(job.input);
    const input = transfer ? job.input : job.input.slice();
    job.transferred = transfer;
    try {
      holder.worker.postMessage({ id: job.id, kind: job.kind, description: job.description, input }, [input.buffer]);
    } catch (error) {
      holder.jobs.delete(job.id);
      this.settle(job, null, error);
    }
  }

  /**
   * Send a work task: its context first when this worker has not had it,
   * its arguments' buffers transferred when the caller gave them up and the
   * worker has proved it runs (else copied, so the task can still be done
   * here should the worker stop).
   */
  sendRun(holder, job) {
    try {
      const key = job.context ?? null;
      if (key !== null && !holder.contexts.has(key)) {
        if (!this.contexts.has(key)) throw new Error(`The decode context '${key}' was released before its work was done.`);
        holder.worker.postMessage({ context: key, data: this.contexts.get(key) });
        holder.contexts.add(key);
      }
      const transfer = job.owned === true && holder.answered ? job.transfer ?? [] : [];
      job.transferred = transfer.length > 0;
      holder.worker.postMessage({ id: job.id, kind: 'run', module: job.module, name: job.name, args: job.args, context: key }, transfer);
    } catch (error) {
      holder.jobs.delete(job.id);
      this.settle(job, null, error);
    }
  }

  /** Send small jobs as one message, their bytes copied into one buffer. */
  sendBatch(holder, jobs) {
    const live = jobs.filter(job => !job.settled);
    if (live.length === 0) return;
    const id = this.nextId++;
    let total = 0;
    for (const job of live) total += job.input.length;
    const input = new Uint8Array(total);
    const items = [];
    let at = 0;
    for (const job of live) {
      job.id = id;
      job.holder = holder;
      job.startedAt = performance.now();
      input.set(job.input, at);
      items.push({ kind: job.kind, description: job.description, start: at, end: at + job.input.length });
      at += job.input.length;
    }
    holder.jobs.set(id, live);
    try {
      holder.worker.postMessage({ id, items, input }, [input.buffer]);
    } catch (error) {
      holder.jobs.delete(id);
      for (const job of live) this.settle(job, null, error);
    }
  }

  onResult(holder, message) {
    holder.answered = true;
    const job = holder.jobs.get(message?.id);
    if (job === undefined) return;
    holder.jobs.delete(message.id);
    if (Array.isArray(job)) {
      job.forEach((item, index) => {
        const result = message.results?.[index];
        if (result === undefined) this.runHere(item);
        else if (result.error !== undefined) this.settle(item, null, item.revive(result.error));
        else this.settle(item, result.output, null);
      });
    } else if (message.error !== undefined) {
      this.settle(job, null, job.revive(message.error));
    } else {
      this.settle(job, message.output, null);
    }
    this.pump();
  }

  /**
   * A worker stopped (it failed to load, or crashed): its tasks are decoded
   * here, from the caller's bytes. One that never answered means workers
   * cannot run here at all.
   */
  onWorkerFailed(holder) {
    const index = this.workers.indexOf(holder);
    if (index < 0) return;
    this.workers.splice(index, 1);
    try {
      holder.worker.terminate();
    } catch {
      // Already stopped.
    }
    if (!holder.answered) this.noWorkers = true;
    const jobs = [...holder.jobs.values()].flat();
    holder.jobs.clear();
    for (const job of jobs) this.runHere(job);
    this.pump();
  }

  scheduleIdle() {
    if (this.workers.length === 0 || this.idleTimer !== null) return;
    if (this.workers.some(holder => holder.jobs.size > 0)) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.releaseIdle();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  /** Terminate every worker with no task under way. */
  releaseIdle() {
    this.workers = this.workers.filter(holder => {
      if (holder.jobs.size > 0) return true;
      holder.worker.terminate();
      return false;
    });
  }

  /** Terminate every worker; tasks under way are decoded here instead. */
  terminate() {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const workers = this.workers;
    this.workers = [];
    for (const holder of workers) {
      holder.worker.terminate();
      for (const job of [...holder.jobs.values()].flat()) this.runHere(job);
      holder.jobs.clear();
    }
    for (const queue of this.queues) for (const job of queue.splice(0)) this.runHere(job);
  }

  stats() {
    return {
      workers: this.workers.length,
      running: this.workers.reduce((sum, holder) => sum + [...holder.jobs.values()].flat().length, 0),
      // Cancelled jobs stay in the queue until it reaches them; they do not wait.
      queued: this.queues.reduce((count, queue) => count + queue.reduce((n, job) => n + (job.settled ? 0 : 1), 0), 0),
      inThreadOnly: this.noWorkers,
      decodedBytesPerMs,
    };
  }
}

/**
 * How fast one chunk is decoded, in decoded bytes per millisecond from the
 * moment it is handed to a worker (or begun in this thread) to its result:
 * an exponential moving average over chunks (weight 1/8 for the newest, as
 * a smoothed round trip is kept in `link.js`), null until a chunk is
 * decoded. A measure for whoever tunes work to the machine, never a limit.
 * @type {number|null}
 */
let decodedBytesPerMs = null;

function noteDecoded(bytes, ms) {
  if (!(ms > 0) || bytes <= 0) return;
  const rate = bytes / ms;
  decodedBytesPerMs = decodedBytesPerMs === null ? rate : 0.875 * decodedBytesPerMs + 0.125 * rate;
}

/** @type {DecodePool|null} */
let pool = null;
let settings = {};

function sharedPool() {
  if (pool === null) {
    const createWorker = 'createWorker' in settings
      ? settings.createWorker
      : (typeof globalThis.Worker === 'function' ? defaultCreateWorker : null);
    pool = new DecodePool({
      createWorker,
      size: settings.size ?? decodeWorkerCount(settings.memoryBytes ?? Infinity),
      idleMs: settings.idleMs ?? IDLE_MS,
      minBytes: settings.minBytes ?? POOL_MIN_BYTES,
    });
    if (createWorker === null || pool.size === 0) pool.noWorkers = true;
  }
  return pool;
}

/**
 * Decode one chunk on a decode worker, or in this thread (see the module
 * notes for when).
 *
 * @param {Object} task
 * @param {'zarr'|'hdf5'} task.kind
 * @param {Object} task.description - Serialisable: how to decode (see decode-worker.js)
 * @param {Uint8Array} task.input - The compressed bytes (never changed; transferred only when `owned`)
 * @param {number} task.size - The decoded size, or the best estimate of it
 * @param {AbortSignal|null} [task.signal]
 * @param {boolean} [task.owned] - The caller gives the bytes up: a view over
 *   its whole buffer may be transferred instead of copied
 * @param {boolean} [task.background] - Waits behind every other task
 *   (a pass no one is waiting for)
 * @param {(data: {name: string, message: string}) => Error} task.revive - The caller's error from a worker's error data
 * @param {() => (Uint8Array|Promise<Uint8Array>)} task.inThread - The same decoding, in this thread
 * @returns {Promise<Uint8Array>}
 */
export function decodeChunkBytes(task) {
  return sharedPool().decode(task);
}

/**
 * Run `name` of `module` on a decode worker: `fn(args, context)`, where
 * `context` is the data `retainDecodeContext(task.context, data)` kept. The
 * module must depend on nothing a worker cannot load (no DOM, no app state).
 * The result's typed arrays come back transferred.
 *
 * @param {Object} task
 * @param {string} task.module - The module's URL
 * @param {string} task.name - The function it exports
 * @param {Object} task.args - Serialisable arguments
 * @param {ArrayBuffer[]} [task.transfer] - Buffers of `args` the caller gives up
 * @param {string|null} [task.context] - A key of `retainDecodeContext`
 * @param {number} task.size - The bytes of work, as a decoded chunk's size: less than a message is worth is done here
 * @param {AbortSignal|null} [task.signal]
 * @param {boolean} [task.background]
 * @param {(data: {name: string, message: string}) => Error} [task.revive]
 * @param {() => (Object|Promise<Object>)} task.inThread - The same call, in this thread
 * @returns {Promise<Object>}
 */
export function runOnDecodeWorker(task) {
  return sharedPool().decode({
    ...task,
    kind: 'run',
    owned: (task.transfer?.length ?? 0) > 0,
    revive: task.revive ?? genericError,
  });
}

/** Keep `data` for the decode workers' work tasks that name `key` (`runOnDecodeWorker`). */
export function retainDecodeContext(key, data) {
  sharedPool().retain(key, data);
}

/** Let the context `key` go, here and on every worker that was sent it. */
export function releaseDecodeContext(key) {
  pool?.release(key);
}

/** Make the decode workers ahead of the first chunk (a store opening): their start-up is off the first read. */
export function warmDecodePool() {
  sharedPool().warm();
}

/** Terminate decode workers with nothing to do (a store's `close()` calls this). */
export function releaseIdleDecodeWorkers() {
  pool?.releaseIdle();
}

/**
 * Workers, tasks under way and tasks waiting, for diagnostics and tests, and
 * how fast chunks decode (`decodedBytesPerMs`, null until one has).
 */
export function decodePoolStats() {
  return pool === null ? { workers: 0, running: 0, queued: 0, inThreadOnly: false, decodedBytesPerMs } : pool.stats();
}

/**
 * Replace the shared pool's settings: the memory its workers may hold
 * (`memoryBytes`, which sizes the pool; the app gives its decode-worker
 * budget), or for tests and benchmarks a worker factory over
 * `node:worker_threads`, a pool size, a threshold. The current pool's
 * workers are terminated; the next chunk makes a new pool.
 *
 * @param {{createWorker?: (() => Worker)|null, size?: number, memoryBytes?: number, idleMs?: number, minBytes?: number}} [options]
 */
export function configureDecodePool(options = {}) {
  pool?.terminate();
  pool = null;
  settings = { ...options };
}
