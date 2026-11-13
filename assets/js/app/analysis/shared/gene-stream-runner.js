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
 * A run over some cells only (`cells`: differential expression of two
 * groups) reads each task's genes in those cells, as a block
 * (`DataLayer.deliverGeneCellSubset` over the route, `readGeneCellSubset`
 * here; `data/gene-delivery.js` `block`). Such a read costs its cells
 * whatever its genes (sent to the reader and checked; read by cell, a CSR
 * matrix's rows, every row it touches decoded), so a read takes as many
 * tasks as the memory gate has room for (`bufferedTasks`) and starts only
 * once half the gate is free (`roomToRead`): the cells are read as few
 * times as memory allows, never with more genes than it holds.
 *
 * As many tasks' genes are read ahead as the tuner says (`prefetchDepth`)
 * and as many tasks are in flight as it says (`computeInFlight`); each read
 * and each task report to it. What the genes read and not yet computed hold
 * (in the reader, on their way, in the workers) is counted in the `analysis`
 * share while the run goes (`GENES_IN_FLIGHT_LABEL`). A task whose worker
 * the pool replaced before its genes arrived answers `{lost: true}`, and its
 * genes are read again. The loop stops at the first failure or abort, and
 * settles every read and task it started before it returns or throws.
 *
 * @module analysis/shared/gene-stream-runner
 */

import { createRunTuner, genesPerTaskFor } from './run-tuner.js';
import { noteMemoryChanged, onMemoryChange, registerResidentHolder } from '../../../data/memory-budget.js';
import { CELL_SUBSET_ENTRY_BYTES, subsetRun } from '../../../data/gene-delivery.js';
import { analysisRunBudgetBytes } from '../compute/worker-pool.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { throwIfAborted, abortReason, cancelled, onAbort } from '../../../utils/abort.js';
import { promiseWithResolvers } from '../../../utils/promise-resolvers.js';

/** The ledger label of a run's genes read and not yet computed (`memory-budget.js`, `analysis` share). */
export const GENES_IN_FLIGHT_LABEL = 'analysis genes in flight';

/**
 * A run's tuner for a data layer, a worker pool size and the run's genes:
 * read whole (every open cell), or in `cells` only (a cell subset's blocks,
 * `runGeneStream`'s `cells`).
 *
 * @param {Object} dataLayer
 * @param {number} poolSize
 * @param {number} geneCount
 * @param {{cells?: ArrayLike<number>|null, budgetBytes?: () => number}} [options] -
 *   `budgetBytes`: what the run's genes may take, read again when it shrinks
 *   (default `analysisRunBudgetBytes`; a run that keeps per-cell state of
 *   its own passes what that state leaves)
 */
export function createRunTunerFor(dataLayer, poolSize, geneCount, { cells = null, budgetBytes = analysisRunBudgetBytes } = {}) {
  const cellCount = cells === null ? dataLayer.state.pointCount : Math.max(1, cells.length);
  const bytesPerCell = cells === null ? undefined : CELL_SUBSET_ENTRY_BYTES;
  return createRunTuner({
    poolSize,
    cellCount,
    bytesPerCell,
    genesPerTask: genesPerTaskFor({ geneCount, poolSize, cellCount, bytesPerCell, budgetBytes: budgetBytes() }),
    geneCount,
    budgetBytes,
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
 * What a task carries in its payload: its delivery, or its genes read here
 * (whole columns, or a cell subset's block). Genes read here are in the
 * run's values already (`runGeneStream`'s `values`); delivered genes come as
 * stored and the task names the run's values (`transform`,
 * `compute/task-values.js` `taskTransform`), which the thread it runs on puts
 * them in.
 *
 * @param {GeneTask} task
 * @param {{scale: string|null, log1p: boolean}|null} [transform] - The run's
 *   (`taskTransform`); null for a run on the values as stored
 * @returns {{delivery: Object, transform?: Object}|{columns: Array}|{block: Object}}
 */
export function taskGenes(task, transform = null) {
  if (task.delivery !== null) return transform === null ? { delivery: task.delivery } : { delivery: task.delivery, transform };
  return task.block === null ? { columns: task.columns } : { block: task.block };
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
 * @property {Array|null} columns - The genes read here whole, each its own
 *   to transfer (a shared column is copied), null otherwise
 * @property {Object|null} block - The genes read here in the run's cells
 *   (`{pointers, positions, values}`, `gene-delivery.js` `subsetRun`), its
 *   own to transfer, null otherwise
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
 * @param {Uint32Array|null} [options.cells] - Read each task's genes in
 *   these cells only (distinct cell positions; the block's positions index
 *   them), each read as many tasks as the memory gate has room for; null:
 *   each gene's every cell. Every gene must then be read from the source
 *   (`DataLayer.isGeneDeliverable`).
 * @param {string} [options.matrix='mapped'] - The expression matrix read
 * @param {import('../compute/task-values.js').RunValues|null} [options.values] - The
 *   values the genes read here are given in (`DataLayer.runValues`; null: as
 *   stored); the matrix's now when omitted. Delivered genes come as stored:
 *   `dispatch` names the run's values (`taskGenes(task, transform)`)
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
  cells = null,
  matrix = 'mapped',
  values: runValues = undefined,
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
  if (cells !== null && (!(cells instanceof Uint32Array) || split !== null)) {
    throw new TypeError('A gene stream over some cells names them as a Uint32Array, and is not split');
  }
  const pointCount = dataLayer.state.pointCount;
  // Genes per task as the tuner sizes them now: from each gene's densest
  // form until a read is measured, then from the genes' bytes as read; one
  // read's tasks are split at the size it started with.
  const perTask = () => tuner.genesPerTask();

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
  const reads = new AbortController();
  const ready = [];
  const readsInFlight = new Set();
  /** Tasks whose genes are being read. */
  let tasksBeingRead = 0;
  const tasksInFlight = new Set();
  let failure = null;
  let stopped = false;

  // Tasks read ahead: as the tuner says; over some cells, as many as the
  // memory gate holds (a read by cell decodes its rows whatever its genes).
  const readAhead = () => (cells === null ? tuner.prefetchDepth() : tuner.bufferedTasks());
  // One read of delivered genes serves a task on each worker (each task's
  // genes go to its own worker); a split read, every worker's part of one; a
  // read here, one task. A read over some cells takes every task the gate
  // has room for (`roomToRead`: half the gate at least).
  const tasksPerRead = here => {
    if (cells !== null) return Math.max(1, readAhead() - tasksBeingRead - ready.length);
    return here || route === null || split !== null ? 1 : route.workerCount;
  };
  const nextReadGenes = () => {
    if (readAgain.length > 0) return { indices: readAgain.splice(0, perTask() * tasksPerRead(false)), local: false };
    if (deliveredHead < delivered.length) {
      const indices = delivered.slice(deliveredHead, deliveredHead + perTask() * tasksPerRead(false));
      deliveredHead += indices.length;
      return { indices, local: false };
    }
    if (localHead < local.length) {
      const indices = local.slice(localHead, localHead + perTask() * tasksPerRead(true));
      localHead += indices.length;
      return { indices, local: true };
    }
    return null;
  };
  const genesLeftToRead = () => readAgain.length > 0 || deliveredHead < delivered.length || localHead < local.length;
  // A read over some cells costs its cells whatever its genes (sent to the
  // reader, checked, gathered): it starts once half the gate is free -- the
  // other half's genes computed meanwhile -- or every task left fits. Started
  // as each task left the gate, a differential expression of two large
  // groups would make a read of every task, each paying its cells' cost
  // (measured: 37_decisions_analysis.md).
  const tasksLeftToRead = () => Math.ceil((readAgain.length + (delivered.length - deliveredHead) + (local.length - localHead)) / perTask());
  const roomToRead = () => {
    const room = readAhead() - tasksBeingRead - ready.length;
    if (cells === null) return room > 0;
    return room > 0 && room >= Math.min(Math.ceil(readAhead() / 2), tasksLeftToRead());
  };
  // A read over some cells tells the source the genes the run has still to
  // read, its own included: the source prices its routes over the run (the
  // gene index built once, or the cells' rows read once and kept), never
  // decoding the cells' rows again a read (`AnnDataReader.getMatrixCellSubset`).
  const runGenesFrom = indices => indices.length + readAgain.length + (delivered.length - deliveredHead) + (local.length - localHead);

  // What the run's genes read and not yet computed hold, wherever they are
  // (the reader, on their way, a worker's inbox, a task): counted in the
  // `analysis` share while the run goes. In use, so never trimmed; the tuner
  // holds them to the share.
  const stopCounting = registerResidentHolder('analysis', {
    label: GENES_IN_FLIGHT_LABEL,
    bytes: () => (tasksBeingRead + ready.length + tasksInFlight.size) * tuner.taskBytes(),
    trim: () => null,
  });

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
    reads.abort(signal?.aborted ? abortReason(signal) : cancelled('superseded', 'Gene streaming was stopped.'));
    wake();
  };
  const stopListening = [onAbort(signal, stopReads), onAbort(stop, stopReads)];
  // The run's budget shrank (`memory-budget.js`): the tuner reads it again
  // and holds less in flight.
  let runBudget = analysisRunBudgetBytes();
  const unsubscribe = onMemoryChange(() => {
    const now = analysisRunBudgetBytes();
    if (now < runBudget) tuner.onPressure();
    runBudget = now;
  });

  /** A cell subset's block of `indices`' genes, read here: a task of each `perTask` of them. */
  const readSubsetHere = async (indices, perTask) => {
    const keys = indices.map(index => genes[index]);
    const block = await dataLayer.readGeneCellSubset(keys, cells, { signal: reads.signal, owner, matrix, values: runValues, runGenes: runGenesFrom(indices) });
    if (block === null) {
      throw new TypeError(`This dataset cannot read ${formatCountOf(keys.length, 'gene')} in some cells`);
    }
    const tasks = [];
    for (let first = 0; first < indices.length; first += perTask) {
      const last = Math.min(indices.length, first + perTask);
      tasks.push({
        indices: indices.slice(first, last),
        genes: keys.slice(first, last),
        worker: null,
        delivery: null,
        columns: null,
        block: subsetRun(block, first, last),
      });
    }
    return { tasks, bytes: block.cellIndex.byteLength + block.values.byteLength };
  };

  const readHere = async (indices, perTask) => {
    if (cells !== null) return readSubsetHere(indices, perTask);
    const columns = await Promise.all(indices.map(async index => {
      const { values, owned } = await dataLayer.readGeneColumn(genes[index], {
        priority,
        signal: reads.signal,
        owner,
        matrix,
        values: runValues,
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
      tasks: [{ indices, genes: indices.map(index => genes[index]), worker: null, delivery: null, columns: columns.map(column => column.values), block: null }],
      bytes: columns.reduce((sum, column) => sum + column.bytes, 0),
    };
  };

  const deliver = async (indices, perTask) => {
    const keys = indices.map(index => genes[index]);
    if (split !== null) {
      const id = route.nextDeliveryId();
      const generations = route.generations();
      const { bytes } = await dataLayer.deliverGeneColumns(keys, {
        route: route.id, id, split, generations,
      }, { priority, signal: reads.signal, owner, matrix });
      return {
        tasks: [{ indices, genes: keys, worker: null, delivery: { route: route.id, id, generations }, columns: null, block: null }],
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
      // Whole columns: each gene's bytes; a cell subset: the block's.
      const { bytes } = cells === null
        ? await dataLayer.deliverGeneColumns(keys, { route: route.id, runs }, { priority, signal: reads.signal, owner, matrix })
        : await dataLayer.deliverGeneCellSubset(keys, cells, { route: route.id, runs }, { signal: reads.signal, owner, matrix, runGenes: runGenesFrom(indices) });
      return {
        tasks: runs.map(({ id, worker, generation, first, last }) => ({
          indices: indices.slice(first, last),
          genes: keys.slice(first, last),
          worker,
          delivery: { route: route.id, id, generation },
          columns: null,
          block: null,
        })),
        bytes: Array.isArray(bytes) ? bytes.reduce((sum, value) => sum + value, 0) : bytes,
      };
    } catch (error) {
      for (const { worker, first, last } of runs) route.settle(worker, last - first);
      throw error;
    }
  };

  const startRead = ({ indices, local: here }) => {
    const readStart = performance.now();
    const perTask = tuner.genesPerTask();
    const taskCount = here && cells === null ? 1 : Math.ceil(indices.length / perTask);
    tasksBeingRead += taskCount;
    let read;
    read = (here ? readHere(indices, perTask) : deliver(indices, perTask)).then(
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
      noteMemoryChanged();
      wake();
    });
    readsInFlight.add(read);
    noteMemoryChanged();
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
      while (genesLeftToRead() && roomToRead()) {
        startRead(nextReadGenes());
      }
      tuner.setReadsPending(readsInFlight.size);
      while (ready.length > 0 && tasksInFlight.size < tuner.computeInFlight() && !ended()) {
        startTask(ready.shift());
      }
      if (readsInFlight.size === 0 && ready.length === 0 && tasksInFlight.size === 0 && !genesLeftToRead()) break;
      const wake = promiseWithResolvers();
      wakeUp = wake.resolve;
      await wake.promise;
    }
  } finally {
    reads.abort(signal?.aborted ? abortReason(signal) : cancelled('superseded', 'The gene streaming run ended.'));
    for (const stopListeningTo of stopListening) stopListeningTo();
    await Promise.all([...readsInFlight]);
    for (const task of ready) {
      if (task.worker !== null) route.settle(task.worker, task.indices.length);
    }
    ready.length = 0;
    await Promise.all([...tasksInFlight]);
    unsubscribe();
    stopCounting();
    noteMemoryChanged();
  }
  throwIfAborted(signal);
  if (failure !== null) throw failure;
  return !stopped && !stop?.aborted && isCurrent();
}

/**
 * Visit `genes` here, whole columns (`DataLayer.readGeneColumns`), in the
 * run's order: the pass of an analysis that computes on this thread over
 * many genes (signature scores). The genes are read a batch at a time, each
 * as many as the run's buffered genes may hold (the tuner's memory gate,
 * `bufferedTasks`, at the bytes a gene measured; until one is measured, its
 * densest form over every open cell), and the batch is counted in the
 * `analysis` share while it is held (`GENES_IN_FLIGHT_LABEL`). A gene's
 * column is let go once visited.
 *
 * @param {object} options
 * @param {Object} options.dataLayer
 * @param {string[]} options.genes - Distinct gene keys (of `matrix`)
 * @param {(gene: string, column: Float32Array|{length: number, indices: Uint32Array, values: Float32Array}, index: number) => (boolean|void|Promise<boolean|void>)} options.visit -
 *   Takes each gene in turn (read only: a dense column may be a view's);
 *   false stops the pass
 * @param {string} [options.matrix='mapped']
 * @param {import('../compute/task-values.js').RunValues|null} [options.values] - The
 *   values the genes are given in (`DataLayer.runValues`); the matrix's now when omitted
 * @param {string|null} [options.owner] - The job the reads are for
 * @param {AbortSignal|null} [options.signal]
 * @param {() => boolean} [options.isCurrent]
 * @param {(cleanup: () => void) => void} [options.registerInvalidationCleanup]
 * @returns {Promise<boolean>} False when the pass stopped (the request is no
 *   longer current, or `visit` said so)
 */
export async function visitGeneColumnsHere({
  dataLayer,
  genes,
  visit,
  matrix = 'mapped',
  values = undefined,
  owner = null,
  signal = null,
  isCurrent = () => true,
  registerInvalidationCleanup,
}) {
  requireGeneList(genes);
  if (typeof visit !== 'function') throw new TypeError('A gene pass visits each gene with a function');
  if (genes.length === 0) return isCurrent();
  const tuner = createRunTunerFor(dataLayer, 1, genes.length);
  let held = 0;
  const stopCounting = registerResidentHolder('analysis', {
    label: GENES_IN_FLIGHT_LABEL,
    bytes: () => held,
    trim: () => null,
  });
  try {
    for (let first = 0; first < genes.length;) {
      if (!isCurrent()) return false;
      const batch = genes.slice(first, first + Math.max(1, tuner.bufferedTasks() * tuner.genesPerTask()));
      const readStart = performance.now();
      const columns = await dataLayer.readGeneColumns(batch, { isCurrent, registerInvalidationCleanup, signal, owner, matrix, values });
      held = columns.reduce((sum, column) => sum + columnBytes(column), 0);
      noteMemoryChanged();
      tuner.observeRead({ bytes: held, ms: performance.now() - readStart, genes: batch.length });
      for (let k = 0; k < batch.length; k++) {
        if ((await visit(batch[k], columns[k], first + k)) === false || !isCurrent()) return false;
        held -= columnBytes(columns[k]);
        columns[k] = null;
      }
      first += batch.length;
    }
    return isCurrent();
  } finally {
    stopCounting();
    noteMemoryChanged();
  }
}
