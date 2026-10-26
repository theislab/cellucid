/**
 * @fileoverview Stream a run's genes to worker tasks: the one loop marker
 * discovery, differential expression, the gene-moments pass, the dot plot
 * and UCell share.
 *
 * Genes go to the workers in tasks of `tuner.genesPerTask()` genes
 * (`run-tuner.js`), read:
 *
 * - over the run's gene route (`analysis/data/gene-route.js`), when it has
 *   one: one read serves a task on each worker, the reader worker
 *   delivering each task's genes straight to the worker it runs on
 *   (`DataLayer.deliverGeneColumns`, `data/gene-delivery.js`), and this
 *   thread hears only their bytes. A task names its delivery; the genes'
 *   values never cross this thread. A gene only this thread holds (a
 *   user-defined copy) is read here and sent with its task.
 * - here (`DataLayer.readGeneColumn`), when the run has no route: a run
 *   computing on this thread, or a source whose reader is not a worker.
 *
 * As many tasks' genes are read ahead as the tuner says (`prefetchDepth`)
 * and as many tasks are in flight as it says (`computeInFlight`); each read
 * and each task report to it. A task whose worker the pool replaced before
 * its genes arrived answers `{lost: true}`, and its genes are read again.
 * The loop stops at the first failure or abort, and settles every read and
 * task it started before it returns or throws.
 *
 * @module analysis/shared/gene-stream-runner
 */

import { createRunTuner, genesPerTaskFor } from './run-tuner.js';
import { getMemoryMonitor } from './memory-monitor.js';
import { residencyBudgetBytes } from '../../../data/memory-budget.js';
import { formatCountOf } from '../../../utils/format-units.js';

/**
 * A run's tuner for a data layer, a worker pool size and the run's genes.
 *
 * @param {Object} dataLayer
 * @param {number} poolSize
 * @param {number} geneCount
 */
export function createRunTunerFor(dataLayer, poolSize, geneCount) {
  const cellCount = dataLayer.state.pointCount;
  return createRunTuner({
    poolSize,
    cellCount,
    genesPerTask: genesPerTaskFor({ geneCount, poolSize, cellCount, budgetBytes: residencyBudgetBytes('analysis') }),
    link: () => (typeof dataLayer.linkMeasurement === 'function' ? dataLayer.linkMeasurement() : null),
  });
}

/**
 * Timing options for one task: the tuner hears its run time.
 *
 * @param {ReturnType<typeof createRunTuner>} tuner
 */
export function taskTiming(tuner) {
  tuner.taskStarted();
  return ({ runMs }) => tuner.observeTask({ ms: runMs });
}

/**
 * What a task carries in its payload: its delivery, or its genes read here.
 *
 * @param {GeneTask} task
 * @returns {{delivery: Object}|{columns: Array}}
 */
export function taskGenes(task) {
  return task.delivery === null ? { columns: task.columns } : { delivery: task.delivery };
}

/**
 * @typedef {Object} GeneTask
 * @property {number[]} indices - The genes' positions in the run's list
 * @property {string[]} genes - The genes
 * @property {number|null} worker - The worker the genes were delivered to,
 *   null for genes read here (any worker) or delivered to every worker
 * @property {Object|null} delivery - What the task names its genes by
 *   (`{route, id, generation}`, or `{route, id, generations}` for a split
 *   delivery), null for genes read here
 * @property {Array|null} columns - The genes read here, each its own to
 *   transfer (a shared column is copied), null for delivered genes
 */

/** Bytes one column read here holds. */
function columnBytes(values) {
  return ArrayBuffer.isView(values) ? values.byteLength : values.indices.byteLength + values.values.byteLength;
}

/** A gene's values as a task may own them: a column a view shares is copied. */
function ownedColumn(values, owned) {
  if (owned) return values;
  return ArrayBuffer.isView(values)
    ? values.slice()
    : { length: values.length, indices: values.indices.slice(), values: values.values.slice() };
}

function isSparseColumn(values) {
  return values !== null
    && typeof values === 'object'
    && !ArrayBuffer.isView(values)
    && values.indices instanceof Uint32Array
    && values.values instanceof Float32Array
    && values.indices.length === values.values.length;
}

function requireGeneList(genes) {
  if (!Array.isArray(genes)) throw new TypeError('A gene stream needs an array of genes');
  const seen = new Set();
  for (const gene of genes) {
    if (typeof gene !== 'string' || gene.length === 0 || gene !== gene.trim()) {
      throw new TypeError('Every streamed gene must be one exact non-empty string');
    }
    if (seen.has(gene)) throw new TypeError(`A gene stream lists gene "${gene}" twice`);
    seen.add(gene);
  }
  return genes;
}

/**
 * @param {object} options
 * @param {Object} options.dataLayer
 * @param {string[]} options.genes - Distinct gene keys (of `matrix`)
 * @param {ReturnType<typeof createRunTuner>} options.tuner
 * @param {import('../data/gene-route.js').GeneRoute|null} options.route -
 *   The run's gene route, or null to read the genes here
 * @param {Uint32Array|null} [options.split] - Deliver each task's genes to
 *   every worker of the route, each the range of cells `split[w]` to
 *   `split[w + 1]` (`data/gene-delivery.js` `ranges`); null: each task's
 *   genes go to one worker
 * @param {string} [options.matrix='mapped'] - The expression matrix read
 * @param {string|null} [options.owner] - The job the reads are for
 * @param {'normal'|'bulk'} [options.priority='bulk'] - The reads' priority
 *   (`data/fetch-scheduler.js`): one of a long run's, or work the user
 *   started and watches (a dot plot's few genes)
 * @param {(task: GeneTask, onTiming: Function) => Promise<unknown>} options.dispatch -
 *   Start the task (on `task.worker` when it is not null, its genes as
 *   `taskGenes(task)`), passing `onTiming` to its execution options
 * @param {(task: GeneTask, result: unknown) => void} options.onResult
 * @param {AbortSignal|null} [options.signal]
 * @param {() => boolean} [options.isCurrent] - False stops the run (it then
 *   returns false)
 * @param {AbortSignal|null} [options.stop] - Stops the run as `isCurrent`
 *   turning false does, its reads at once (the request was invalidated)
 * @returns {Promise<boolean>} True when every gene was done
 */
export async function runGeneStream({
  dataLayer,
  genes,
  tuner,
  route,
  split = null,
  matrix = 'mapped',
  owner = null,
  priority = 'bulk',
  dispatch,
  onResult,
  signal = null,
  isCurrent = () => true,
  stop = null,
}) {
  requireGeneList(genes);
  if (route === undefined) throw new TypeError('A gene stream names its route, or null to read its genes here');
  if (split !== null && route === null) throw new TypeError('A split gene stream delivers over a route');
  const pointCount = dataLayer.state.pointCount;
  const perTask = tuner.genesPerTask();

  // Genes to read, in the run's order: those delivered over the route, then
  // those read here; genes of a lost task are read again first.
  const delivered = [];
  const local = [];
  for (let index = 0; index < genes.length; index++) {
    if (route !== null && dataLayer.isGeneDeliverable(genes[index], matrix)) delivered.push(index);
    else local.push(index);
  }
  let deliveredHead = 0;
  let localHead = 0;
  const readAgain = [];
  // One read of delivered genes serves a task on each worker (each task's
  // genes go to its own worker); a split read, every worker's part of one.
  const tasksPerRead = route === null || split !== null ? 1 : route.workerCount;
  const nextReadGenes = () => {
    if (readAgain.length > 0) return { indices: readAgain.splice(0, perTask * tasksPerRead), local: false };
    if (deliveredHead < delivered.length) {
      const indices = delivered.slice(deliveredHead, deliveredHead + perTask * tasksPerRead);
      deliveredHead += indices.length;
      return { indices, local: false };
    }
    if (localHead < local.length) {
      const indices = local.slice(localHead, localHead + perTask);
      localHead += indices.length;
      return { indices, local: true };
    }
    return null;
  };
  const genesLeftToRead = () => readAgain.length > 0 || deliveredHead < delivered.length || localHead < local.length;

  const reads = new AbortController();
  const ready = [];
  const readsInFlight = new Set();
  /** Tasks whose genes are being read. */
  let tasksBeingRead = 0;
  const tasksInFlight = new Set();
  let failure = null;
  let stopped = false;

  let wakeUp = null;
  const wake = () => {
    const resolve = wakeUp;
    wakeUp = null;
    resolve?.();
  };
  const fail = error => {
    if (failure === null) failure = error;
    wake();
  };
  const stopReads = () => {
    reads.abort(signal?.reason ?? new DOMException('Gene streaming was aborted', 'AbortError'));
    wake();
  };
  signal?.addEventListener('abort', stopReads, { once: true });
  stop?.addEventListener('abort', stopReads, { once: true });
  const unsubscribe = getMemoryMonitor().onMemoryPressure(event => {
    const level = event?.level;
    if (level === 'critical' || level === 'cleanup' || level === 'warning') tuner.onPressure();
    else if (level !== 'normal' && level !== 'unknown') fail(new TypeError(`Unknown memory pressure level: ${String(level)}`));
  });
  if (typeof unsubscribe !== 'function') {
    signal?.removeEventListener('abort', stopReads);
    stop?.removeEventListener('abort', stopReads);
    throw new TypeError('MemoryMonitor.onMemoryPressure must return an unsubscribe function');
  }

  const readHere = async indices => {
    const columns = await Promise.all(indices.map(async index => {
      const { values, owned } = await dataLayer.readGeneColumn(genes[index], {
        priority,
        signal: reads.signal,
        owner,
        matrix,
      });
      if (!isSparseColumn(values) && !(values instanceof Float32Array)) {
        throw new TypeError(`Gene "${genes[index]}" must read as one Float32Array or its non-zero entries`);
      }
      if (values.length !== pointCount) {
        throw new RangeError(`Gene "${genes[index]}" has ${formatCountOf(values.length, 'value')}; expected ${pointCount}`);
      }
      return { values: ownedColumn(values, owned === true), bytes: owned === true ? columnBytes(values) : 0 };
    }));
    return {
      tasks: [{ indices, genes: indices.map(index => genes[index]), worker: null, delivery: null, columns: columns.map(column => column.values) }],
      bytes: columns.reduce((sum, column) => sum + column.bytes, 0),
    };
  };

  const deliver = async indices => {
    const keys = indices.map(index => genes[index]);
    if (split !== null) {
      const id = route.nextDeliveryId();
      const generations = route.generations();
      const { bytes } = await dataLayer.deliverGeneColumns(keys, {
        route: route.id, id, split, generations,
      }, { priority, signal: reads.signal, owner, matrix });
      return {
        tasks: [{ indices, genes: keys, worker: null, delivery: { route: route.id, id, generations }, columns: null }],
        bytes: bytes.reduce((sum, value) => sum + value, 0),
      };
    }
    // Each task's genes, a run of the read, to the worker with the fewest
    // genes outstanding.
    const runs = [];
    for (let first = 0; first < indices.length; first += perTask) {
      const last = Math.min(indices.length, first + perTask);
      const worker = route.assign(last - first);
      runs.push({ id: route.nextDeliveryId(), worker, generation: route.generation(worker), first, last });
    }
    try {
      const { bytes } = await dataLayer.deliverGeneColumns(keys, { route: route.id, runs },
        { priority, signal: reads.signal, owner, matrix });
      return {
        tasks: runs.map(({ id, worker, generation, first, last }) => ({
          indices: indices.slice(first, last),
          genes: keys.slice(first, last),
          worker,
          delivery: { route: route.id, id, generation },
          columns: null,
        })),
        bytes: bytes.reduce((sum, value) => sum + value, 0),
      };
    } catch (error) {
      for (const { worker, first, last } of runs) route.settle(worker, last - first);
      throw error;
    }
  };

  const startRead = ({ indices, local: here }) => {
    const readStart = performance.now();
    const taskCount = here ? 1 : Math.ceil(indices.length / perTask);
    tasksBeingRead += taskCount;
    let read;
    read = (here ? readHere(indices) : deliver(indices)).then(
      ({ tasks, bytes }) => {
        tuner.observeRead({ bytes, ms: performance.now() - readStart, genes: indices.length });
        if (reads.signal.aborted || failure !== null) {
          for (const task of tasks) if (task.worker !== null) route.settle(task.worker, task.indices.length);
          return;
        }
        ready.push(...tasks);
      },
      error => {
        if (!reads.signal.aborted) fail(error);
      }
    ).finally(() => {
      tasksBeingRead -= taskCount;
      readsInFlight.delete(read);
      wake();
    });
    readsInFlight.add(read);
  };

  // A run stopped (or no longer current) dispatches nothing more, not even a
  // task already handed to the loop.
  const ended = () => failure !== null || signal?.aborted || stop?.aborted || !isCurrent();
  const NOT_SENT = Symbol('not sent');
  const startTask = task => {
    let running;
    running = Promise.resolve()
      .then(() => (ended() ? NOT_SENT : dispatch(task, taskTiming(tuner))))
      .then(result => {
        if (task.worker !== null) route.settle(task.worker, task.indices.length);
        if (result === NOT_SENT) return;
        if (result !== null && typeof result === 'object' && result.lost === true) {
          // Its worker was replaced before its genes arrived: read them again.
          readAgain.push(...task.indices);
          return;
        }
        if (!signal?.aborted && isCurrent()) onResult(task, result);
      }, error => {
        if (task.worker !== null) route.settle(task.worker, task.indices.length);
        throw error;
      })
      .catch(fail)
      .finally(() => {
        tasksInFlight.delete(running);
        wake();
      });
    tasksInFlight.add(running);
  };

  try {
    for (;;) {
      if (failure !== null || signal?.aborted) break;
      if (!isCurrent() || stop?.aborted) {
        stopped = true;
        break;
      }
      while (tasksBeingRead + ready.length < tuner.prefetchDepth() && genesLeftToRead()) {
        startRead(nextReadGenes());
      }
      tuner.setReadsPending(readsInFlight.size);
      while (ready.length > 0 && tasksInFlight.size < tuner.computeInFlight() && !ended()) {
        startTask(ready.shift());
      }
      if (readsInFlight.size === 0 && ready.length === 0 && tasksInFlight.size === 0 && !genesLeftToRead()) break;
      await new Promise(resolve => {
        wakeUp = resolve;
      });
    }
  } finally {
    reads.abort(signal?.reason ?? new DOMException('Gene streaming run ended', 'AbortError'));
    signal?.removeEventListener('abort', stopReads);
    stop?.removeEventListener('abort', stopReads);
    await Promise.all([...readsInFlight]);
    for (const task of ready) {
      if (task.worker !== null) route.settle(task.worker, task.indices.length);
    }
    ready.length = 0;
    await Promise.all([...tasksInFlight]);
    unsubscribe();
  }
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  if (failure !== null) throw failure;
  return !stopped && !stop?.aborted && isCurrent();
}
