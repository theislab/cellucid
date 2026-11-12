/**
 * Decoding chunks on other cores.
 *
 * The format readers run in one worker thread; decompressing a chunk there
 * (Zstandard, LZ4 and Blosc in WebAssembly or JavaScript, DEFLATE through the
 * platform's stream or fflate, whichever `decoder-choice.js` chose) holds
 * that thread for as long as it takes, so a background pass
 * over a whole matrix would slow every other read behind it. This pool sends
 * a chunk's compressed bytes, with a description of how to decode them, to
 * one of a few decode workers, and gets the decoded bytes back.
 *
 * - **Tasks** are serializable: a `kind` (`'zarr'`: a Zarr codec list and the
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
 * - **Which decoder**: a family with more than one decoder (DEFLATE: the
 *   platform's stream or fflate; Zstandard, LZ4, Blosc: WebAssembly or
 *   JavaScript) is decoded with the one that gave the pool the most bytes
 *   per millisecond with every worker decoding (`decoder-choice.js`), the
 *   engine's prior until that is known: each message names its decoder.
 *   The decoders are measured only while the pool has no other work: the
 *   pool keeps copies of a few chunks of each key not yet decided (one per
 *   worker), and sends them, one message a worker at a time, phase by
 *   phase, once no chunk of a read has waited or been decoded for
 *   `EXPLORE_AFTER_IDLE_MS`; a read's chunk then waits for one measuring
 *   message at most. Chunks that only
 *   travel together (smaller than `POOL_MIN_BYTES`) are not kept: their
 *   keys stay with the prior. The decisions are
 *   kept in this browser (`decoder-memory.js`): a later visit measures
 *   nothing it decided before.
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
 * - **Lifetime**: workers are made as chunks worth sending queue for them
 *   (one is made ahead of the first when a store opens: `warmDecodePool()`),
 *   up to
 *   `navigator.hardwareConcurrency - 2` (a core each for the reader thread
 *   and the page) and to as many as the pool's memory holds (`memoryBytes`,
 *   at `DECODE_WORKER_BYTES` each, the budget as it is when one may be
 *   made), and terminated once none has had work for `WORKER_IDLE_MS` (the
 *   app's one worker lifetime rule, `workers/idle-retirement.js`), when the
 *   memory model trims the decode-worker share (`trimDecodeWorkers`), or at
 *   once when a store closes
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


import { onAbort, abortReason } from '../../utils/abort.js';
import { decodeWorkerScript } from '../../../workers/scripts.js';
import { startWorker } from '../../workers/worker-script.js';
import { WORKER_IDLE_MS } from '../../workers/idle-retirement.js';
import { fromWire } from '../../utils/error-wire.js';
import { reportedCores } from '../../utils/machine.js';
import { DecoderProbe, adoptDecidedDecoders, choiceKey, fixDecoders, forgetDecidedDecoders } from './decoder-choice.js';
import { decoderMemoryStore, decoderMemoryVersion, keepDecoderDecisions, recallDecoderDecisions } from './decoder-memory.js';

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


/**
 * How long the pool has had no chunk of a read to decode before it measures
 * decoders (a scheduling choice): a read's chunks come in waves, from
 * microseconds to a few hundred milliseconds apart on a link, and a
 * measuring message between two waves delays the next one; a second with
 * none is a person looking at the result, not a read under way.
 */
export const EXPLORE_AFTER_IDLE_MS = 1000;

/** Tasks sent to one worker before its first result is back (a scheduling choice): the next is ready when one ends. */
const TASKS_PER_WORKER = 2;

/**
 * How many messages' worth of small chunks travel together (a scheduling
 * choice): one message then costs at most a quarter of the decoding it
 * carries, and a burst of small chunks still spreads over the workers.
 */
const BATCH_MESSAGES = 4;


/**
 * Decode workers to run: a core each for all but the page and the reader
 * thread (four cores when the browser does not say), and no more than
 * `memoryBytes` holds at `DECODE_WORKER_BYTES` each.
 *
 * @param {number} memoryBytes
 * @returns {number}
 */
export function decodeWorkerCount(memoryBytes, environment = globalThis) {
  const cores = reportedCores(environment) ?? 4;
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
   * @param {{createWorker: () => Worker, size: number|(() => number), idleMs: number, minBytes: number,
   *   memory: import('../../utils/indexed-db-store.js').KeyValueStore|null}} options -
   *   `size`: the workers the pool may run, or a function read whenever it
   *   may make one (its memory budget, which changes); `memory`: where the
   *   decoder decisions are kept (`decoder-memory.js`), null for nowhere
   */
  constructor({ createWorker, size, idleMs, minBytes, memory }) {
    this.createWorker = createWorker;
    this._size = typeof size === 'function' ? size : () => size;
    /** No more workers than this once one could not be made. */
    this._made = Infinity;
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
    /** Copies of chunks of each key not yet decided, what its decoders are measured on (by key). */
    this.samples = new Map();
    /** When a read's chunk was last sent or answered, and the timer that measures once the pool has been idle since. */
    this.lastReadAt = -Infinity;
    this.exploreTimer = null;
    /** Where decisions are kept, under which version, and the writes in turn. */
    this.memory = memory;
    this.memoryVersion = memory === null ? null : decoderMemoryVersion();
    this.keeping = Promise.resolve();
    /** Which decoder each message of a family with several goes with, and what each measured. */
    this.probe = new DecoderProbe(() => this.size, {
      onDecided: (key, decoder) => {
        this.samples.delete(key);
        if (this.memory === null) return;
        this.keeping = this.keeping.then(() => keepDecoderDecisions(this.memory, this.memoryVersion, { [key]: decoder }));
      },
    });
    /** The decisions of earlier visits being read: nothing is measured until they are. */
    this.recalling = memory === null ? null : recallDecoderDecisions(memory, this.memoryVersion).then(decisions => {
      adoptDecidedDecoders(decisions);
      for (const key of [...this.samples.keys()]) if (!this.probe.undecided(key)) this.samples.delete(key);
      this.recalling = null;
      this.pump();
    });
  }

  /** The workers the pool may run now. */
  get size() {
    return Math.min(this._made, this._size());
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
      // A job canceled while queued is settled here and dropped when the
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

  /** The next waiting job, foreground first (canceled ones dropped), or null. */
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
      // No worker can be made, or the pool's memory holds none now.
      if (this.noWorkers || (this.workers.length === 0 && this.size === 0)) {
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
    this.explore();
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
      this._made = this.workers.length;
      if (this.workers.length === 0) this.noWorkers = true;
      return null;
    }
    const holder = { worker, jobs: new Map(), answered: false, contexts: new Set(), lastAnswered: null };
    worker.addEventListener('message', event => this.onResult(holder, event.data));
    worker.addEventListener('error', event => {
      event.preventDefault?.();
      this.onWorkerFailed(holder);
    });
    worker.addEventListener('messageerror', () => this.onWorkerFailed(holder));
    this.workers.push(holder);
    return holder;
  }

  /**
   * Make one worker ahead of the first chunk (its start is then not on the
   * first chunk's path); the others are made as chunks queue for them
   * (`pump`). A worker is a JavaScript engine of its own: warming every one
   * the pool may run held six of them from opening on, for a file whose
   * chunks one decodes. @private
   */
  warm() {
    if (this.noWorkers || this.workers.length > 0 || this.size === 0) return;
    if (this.spawn() === null) return;
    this.scheduleIdle();
  }

  send(holder, job) {
    if (job.settled) return;
    // A read's message: the measuring phase under way is not one decoder's any more.
    this.probe.disturbed();
    this.lastReadAt = performance.now();
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
    const { choices, check } = this.choose([job]);
    this.keepSample(job);
    try {
      holder.worker.postMessage({ id: job.id, kind: job.kind, description: job.description, input, choices, check }, [input.buffer]);
    } catch (error) {
      holder.jobs.delete(job.id);
      this.settle(job, null, error);
    }
  }

  /**
   * Keep a copy of `job`'s chunk to measure its key's decoders on, while
   * the key is not decided and holds fewer copies than the pool has
   * workers.
   */
  keepSample(job) {
    const key = job.choice?.key;
    if (key === undefined || !this.probe.undecided(key)) return;
    const samples = this.samples.get(key) ?? [];
    if (samples.length >= Math.max(1, this.size)) return;
    samples.push({ kind: job.kind, description: job.description, input: job.input.slice() });
    this.samples.set(key, samples);
  }

  /**
   * Measure decoders while the pool has nothing else to do: with no chunk
   * of a read waiting or being decoded, each worker without a message
   * (making them up to the pool's size) is sent one copy of a kept chunk
   * with the decoder of the probe's phase (`DecoderProbe#explore`).
   */
  explore() {
    if (this.recalling !== null || this.noWorkers || this.samples.size === 0 || this.peek() !== null) return;
    for (const holder of this.workers) {
      for (const job of holder.jobs.values()) if (!job.explore) return;
    }
    const wait = this.lastReadAt + EXPLORE_AFTER_IDLE_MS - performance.now();
    if (wait > 0) {
      // Not idle long enough: looked at again when it may be.
      this.exploreTimer ??= setTimeout(() => {
        this.exploreTimer = null;
        this.pump();
      }, wait);
      this.exploreTimer.unref?.();
      return;
    }
    for (;;) {
      let holder = this.workers.find(candidate => candidate.jobs.size === 0) ?? null;
      if (holder === null && this.workers.length < this.size) holder = this.spawn();
      if (holder === null) return;
      const choice = this.probe.explore(this.samples.keys());
      if (choice === null) return;
      const samples = this.samples.get(choice.key);
      const sample = samples[(choice.phase.sent - 1) % samples.length];
      const id = this.nextId++;
      const job = { id, explore: true, sample, choice, holder, startedAt: performance.now() };
      holder.jobs.set(id, job);
      const input = sample.input.slice();
      try {
        holder.worker.postMessage({
          id, kind: sample.kind, description: sample.description, input, choices: { [choice.key]: choice.decoder }, check: choice.check,
        }, [input.buffer]);
      } catch {
        holder.jobs.delete(id);
        this.probe.disturbed();
        return;
      }
    }
  }

  /** A measuring message answered: an error drops its copy (the phase is measured again on the others). */
  explored(job, message) {
    if (message.error === undefined) return;
    const samples = (this.samples.get(job.choice.key) ?? []).filter(sample => sample !== job.sample);
    if (samples.length > 0) this.samples.set(job.choice.key, samples);
    else this.samples.delete(job.choice.key);
    this.probe.disturbed();
  }

  /**
   * The decoders a message of `jobs` goes with (`choices`, by key), and
   * whether its worker checks one chunk against the reference (`check`):
   * one assignment per key the message holds, each job keeping its own
   * (`job.choice`, with the probe phase it counts in).
   */
  choose(jobs) {
    let choices = null;
    let check = false;
    const assigned = new Map();
    for (const job of jobs) {
      if (typeof job.family !== 'string') continue;
      const key = choiceKey(job.family, job.size);
      if (!assigned.has(key)) assigned.set(key, this.probe.assign(job.family, job.size));
      const choice = assigned.get(key);
      if (choice === null) continue;
      choices ??= {};
      choices[choice.key] = choice.decoder;
      check ||= choice.check;
      job.choice = choice;
    }
    return { choices, check };
  }

  /**
   * Send a work task: its context first when this worker has not had it,
   * its arguments' buffers transferred when the caller gave them up and the
   * worker has proved it runs (else copied, so the task can still be done
   * here should the worker stop).
   */
  sendRun(holder, job) {
    this.probe.disturbed();
    this.lastReadAt = performance.now();
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
    this.probe.disturbed();
    this.lastReadAt = performance.now();
    const { choices, check } = this.choose(live);
    try {
      holder.worker.postMessage({ id, items, input, choices, check }, [input.buffer]);
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
    // A measuring message that failed voids its phase before it is counted.
    if (job.explore === true) this.explored(job, message);
    else this.lastReadAt = performance.now();
    this.measured(holder, job, message);
    if (job.explore === true) {
      // Measured only: its bytes go nowhere.
    } else if (Array.isArray(job)) {
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
   * A message answered: its worker's busy time for it (from when it was
   * sent, or from the worker's previous answer while it was still busy, to
   * now), shared among the probe phases it counted in by their bytes, and
   * any decoder its worker found wrong.
   */
  measured(holder, job, message) {
    const now = performance.now();
    const jobs = [job].flat();
    const busy = now - Math.max(jobs[0].startedAt ?? now, holder.lastAnswered ?? -Infinity);
    holder.lastAnswered = now;
    for (const key of message.dropped ?? []) {
      const decoder = jobs.find(item => item.choice?.key === key)?.choice.decoder;
      if (decoder !== undefined) this.probe.drop(key, decoder);
    }
    const outputs = Array.isArray(job) ? (message.results ?? []).map(result => result.output) : [message.output];
    const phases = new Map();
    let total = 0;
    jobs.forEach((item, index) => {
      const bytes = outputs[index]?.length ?? 0;
      total += bytes;
      const phase = item.choice?.phase;
      if (phase === null || phase === undefined) return;
      phases.set(phase, (phases.get(phase) ?? 0) + bytes);
    });
    for (const [phase, bytes] of phases) this.probe.answered(phase, bytes, total > 0 ? busy * bytes / total : busy / phases.size);
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
    const jobs = [...holder.jobs.values()].flat().filter(job => job.explore !== true);
    holder.jobs.clear();
    this.probe.disturbed();
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

  /**
   * Terminate every worker with no task of a read under way (one measuring
   * decoders only is let go, its phase measured again later), beyond the
   * first `keep`.
   */
  releaseIdle(keep = 0) {
    let kept = 0;
    this.workers = this.workers.filter(holder => {
      if ([...holder.jobs.values()].some(job => job.explore !== true) || kept < keep) {
        kept++;
        return true;
      }
      if (holder.jobs.size > 0) this.probe.disturbed();
      holder.worker.terminate();
      return false;
    });
  }

  /** Terminate every worker; tasks under way are decoded here instead. */
  terminate() {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.exploreTimer !== null) clearTimeout(this.exploreTimer);
    this.exploreTimer = null;
    const workers = this.workers;
    this.workers = [];
    for (const holder of workers) {
      holder.worker.terminate();
      for (const job of [...holder.jobs.values()].flat()) if (job.explore !== true) this.runHere(job);
      holder.jobs.clear();
    }
    for (const queue of this.queues) for (const job of queue.splice(0)) this.runHere(job);
  }

  stats() {
    return {
      workers: this.workers.length,
      // Chunks decoded at once: the workers the pool may run (one, this
      // thread, without workers).
      size: this.noWorkers ? 1 : this.size,
      running: this.workers.reduce((sum, holder) => sum + [...holder.jobs.values()].flat().filter(job => job.explore !== true).length, 0),
      // Canceled jobs stay in the queue until it reaches them; they do not wait.
      queued: this.queues.reduce((count, queue) => count + queue.reduce((n, job) => n + (job.settled ? 0 : 1), 0), 0),
      inThreadOnly: this.noWorkers,
      decodedBytesPerMs,
      // What each family's decoders measured, and which was kept (by key).
      decoders: this.probe.summary(),
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
    const memoryBytes = settings.memoryBytes ?? Infinity;
    pool = new DecodePool({
      createWorker,
      size: settings.size ?? (() => decodeWorkerCount(typeof memoryBytes === 'function' ? memoryBytes() : memoryBytes)),
      idleMs: settings.idleMs ?? WORKER_IDLE_MS,
      minBytes: settings.minBytes ?? POOL_MIN_BYTES,
      // A benchmark's fixed decoders measure nothing, and keep nothing.
      memory: 'memory' in settings ? settings.memory : (settings.decoders === undefined ? decoderMemoryStore() : null),
    });
    if (createWorker === null) pool.noWorkers = true;
  }
  return pool;
}

/**
 * Decode one chunk on a decode worker, or in this thread (see the module
 * notes for when).
 *
 * @param {Object} task
 * @param {'zarr'|'hdf5'} task.kind
 * @param {Object} task.description - Serializable: how to decode (see decode-worker.js)
 * @param {Uint8Array} task.input - The compressed bytes (never changed; transferred only when `owned`)
 * @param {number} task.size - The decoded size, or the best estimate of it
 * @param {AbortSignal|null} [task.signal]
 * @param {boolean} [task.owned] - The caller gives the bytes up: a view over
 *   its whole buffer may be transferred instead of copied
 * @param {boolean} [task.background] - Waits behind every other task
 *   (a pass no one is waiting for)
 * @param {string|null} [task.family] - The codec family that decompresses it
 *   (`'deflate'`, `'zstd'`, …): a family with several decoders is decoded
 *   with the one measured fastest (`decoder-choice.js`)
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
 * @param {Object} task.args - Serializable arguments
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
    revive: task.revive ?? (data => fromWire(data)),
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

/**
 * Terminate decode workers with nothing to do (a store's `close()` calls
 * this), and let the copies of chunks kept to measure decoders on go with
 * the store they came from.
 */
export function releaseIdleDecodeWorkers() {
  pool?.samples.clear();
  pool?.releaseIdle();
}

/** The memory the decode workers hold now, at `DECODE_WORKER_BYTES` each. */
export function decodeWorkersHeldBytes() {
  return (pool?.workers.length ?? 0) * DECODE_WORKER_BYTES;
}

/**
 * Keep no more decode workers than `memoryBytes` holds: the idle ones
 * beyond it are terminated (a worker decoding finishes first).
 *
 * @param {number} memoryBytes
 * @returns {string|null} What was let go, in words
 */
export function trimDecodeWorkers(memoryBytes) {
  if (pool === null) return null;
  const before = pool.workers.length;
  pool.releaseIdle(Math.floor(memoryBytes / DECODE_WORKER_BYTES));
  const ended = before - pool.workers.length;
  return ended > 0 ? `${ended === 1 ? 'an idle decode worker' : `${ended} idle decode workers`}` : null;
}

/**
 * Workers, tasks under way and tasks waiting, for diagnostics and tests, and
 * how fast chunks decode (`decodedBytesPerMs`, null until one has) and how
 * many at once (`size`; 0 before the pool is made).
 */
export function decodePoolStats() {
  return pool === null ? { workers: 0, size: 0, running: 0, queued: 0, inThreadOnly: false, decodedBytesPerMs, decoders: {} } : pool.stats();
}

/**
 * Replace the shared pool's settings: the memory its workers may hold
 * (`memoryBytes`, which sizes the pool: a number, or a function read
 * whenever a worker may be made -- the app gives its decode-worker budget,
 * which changes), or for tests and benchmarks a worker factory over
 * `node:worker_threads`, a pool size, a threshold. The current pool's
 * workers are terminated; the next chunk makes a new pool, and how fast
 * chunks decode is measured again.
 *
 * `decoders` (by family: `{deflate: 'fflate'}`) decodes every chunk of a family with
 * one decoder, the probe not run for it: how a benchmark measures each decoder in the pool.
 * `memory` is where decoder decisions are kept across visits (`decoder-memory.js`;
 * this browser's IndexedDB by default, null for nowhere: tests, benchmarks).
 *
 * @param {{createWorker?: (() => Worker)|null, size?: number, memoryBytes?: number|(() => number), idleMs?: number, minBytes?: number,
 *   decoders?: Object<string, string>, memory?: import('../../utils/indexed-db-store.js').KeyValueStore|null}} [options]
 */
export function configureDecodePool(options = {}) {
  pool?.terminate();
  pool = null;
  settings = { ...options };
  // Other workers: their decoders are measured afresh (or set, for a benchmark).
  forgetDecidedDecoders();
  fixDecoders(options.decoders ?? {});
  // Its workers are others: how fast they decode is measured afresh.
  decodedBytesPerMs = null;
}
