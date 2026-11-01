/**
 * @fileoverview How a gene-streaming analysis run sizes itself: how many
 * genes each worker task takes, how many tasks' genes it reads ahead, how
 * many tasks it hands the workers at once, and how much memory it may hold.
 * Nothing here is a setting; every number is derived from what the device
 * and the run report, and changes while the run goes.
 *
 * Inputs:
 * - the worker pool's size (one worker per core, less two:
 *   `performance-config.js` `analysisWorkerCount`);
 * - the analysis memory budget: the `analysis` share (`data/memory-budget.js`)
 *   less the per-cell state the run keeps in every worker
 *   (`compute/worker-pool.js` `analysisRunBudgetBytes`), read at the start
 *   and again whenever the share shrinks (`onPressure`: a refused
 *   allocation halves the allowance; a larger working set or another page
 *   leaves less), so the run shrinks at once;
 * - each read of a task's genes: their bytes as read (sparse entries, not
 *   cells × 4) and how long it took;
 * - each worker task: how long it ran;
 * - the link as the reader measured it (round trip and throughput), when the
 *   reader reports one (`linkMeasurement`); a local file reports a zero round
 *   trip and its decode rate.
 *
 * Rules:
 * - **Genes per task** (`genesPerTask`): sixteen tasks per worker over the
 *   run's genes, as many as even out uneven genes and the last tasks, and no
 *   more than lets the compute in flight hold the genes within half the
 *   budget: until a read is measured a gene holds its densest form,
 *   `bytesPerCell` bytes a cell read (a dense float32 column, 4; a cell
 *   subset's block, a position and a value a cell, 8), then its bytes as
 *   read (a sparse gene's entries: tens of times fewer). Sized again as each
 *   read is measured and when the budget shrinks (a run that names its
 *   `geneCount`). A task's genes are read together and computed in one
 *   message, so the page's work per gene shrinks with them: held at the
 *   densest form, a 10M-cell differential expression of two groups (1.9M
 *   cells) went one gene a task, 30,000 tasks and page messages where the
 *   pushed tree sent 128.
 * - **Compute in flight** = two tasks per worker (one running, one queued,
 *   so no worker waits for a message round trip), capped by half the budget
 *   over the measured bytes a task carries.
 * - **Read-ahead** (in tasks) = the tasks consumed while one task's genes
 *   are fetched, `ceil(consumeRate × (latency + bytesPerTask / bytesPerMs))`,
 *   plus the tasks in flight in the workers; consumeRate = workers / task
 *   time. Until the first measurements arrive it is twice the compute in
 *   flight. It is held to what 30 % of the budget buffers at the measured
 *   bytes per task (`bufferedTasks`, the memory gate).
 * - **Adaptation**, once per window of max(250 ms, 32 tasks): 250 ms is the
 *   rate floor the reader's activity reporting uses, 32 tasks one full round
 *   of two tasks on each of sixteen workers. When workers sat idle more than
 *   a tenth of the window while reads were pending, the run is read-bound
 *   and the read-ahead doubles (to the memory gate). A doubling that does
 *   not raise the next window's throughput beyond the measured spread is
 *   undone and becomes the run's ceiling: past it, more reads in flight only
 *   queue in the reader. When the throughput of a window falls below the
 *   previous one by more than their measured spread, or memory pressure is
 *   reported, it halves (to the compute in flight).
 *
 * The tuner never decides network parallelism: the reader's fetch scheduler
 * holds a run's reads to what the link carries (`backgroundConcurrency`).
 *
 * `snapshot()` is what a result records (`metadata.tuning`) and the debug
 * log prints; it never reaches the interface.
 *
 * @module analysis/shared/run-tuner
 */

import { analysisRunBudgetBytes } from '../compute/worker-pool.js';
import { loadedRoundTripMs } from '../../../formats/io/link.js';

/** The reader's activity reporting rate floor (ms): one window at least. */
export const TUNER_WINDOW_MS = 250;
/** One full round of two tasks on each of sixteen workers. */
export const TUNER_WINDOW_TASKS = 32;
/** Tasks per worker over a run's genes: as many as even out uneven genes and the last tasks. */
export const TASKS_PER_WORKER_OVER_A_RUN = 16;
/** Share of the analysis budget buffered genes may hold. */
const BUFFER_SHARE = 0.3;
/** Share of the analysis budget tasks in flight may carry. */
const COMPUTE_SHARE = 0.5;
/** Tasks per worker: one running, one waiting. */
const TASKS_PER_WORKER = 2;
/** Weight of the newest sample in each moving average. */
const EMA_WEIGHT = 0.2;

function ema(previous, sample) {
  return previous === null ? sample : previous * (1 - EMA_WEIGHT) + sample * EMA_WEIGHT;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

/** Bytes a gene read as a dense float32 column holds a cell. */
const DENSE_COLUMN_BYTES_PER_CELL = 4;

/**
 * The genes each task of a run takes: the run's genes over sixteen tasks per
 * worker, held so that the compute in flight (two tasks per worker) fits
 * half the budget, at `bytesPerGene` a gene (as read), else the genes'
 * densest form.
 *
 * @param {object} options
 * @param {number} options.geneCount - The run's genes
 * @param {number} options.poolSize - Analysis workers
 * @param {number} options.cellCount - Cells each gene is read in
 * @param {number} options.budgetBytes - The analysis memory budget
 * @param {number} [options.bytesPerCell] - What a gene holds a cell read, at
 *   most (a dense column's 4; a cell subset's block, 8)
 * @param {number|null} [options.bytesPerGene] - What a gene holds as read
 *   (measured), or null: its densest form, `cellCount × bytesPerCell`
 * @returns {number}
 */
export function genesPerTaskFor({ geneCount, poolSize, cellCount, budgetBytes, bytesPerCell = DENSE_COLUMN_BYTES_PER_CELL, bytesPerGene = null }) {
  positiveInteger(geneCount, 'A run\'s geneCount');
  positiveInteger(poolSize, 'A run\'s poolSize');
  positiveInteger(cellCount, 'A run\'s cellCount');
  positiveInteger(bytesPerCell, 'A run\'s bytesPerCell');
  const even = Math.ceil(geneCount / (poolSize * TASKS_PER_WORKER_OVER_A_RUN));
  const perGene = bytesPerGene !== null && bytesPerGene > 0 ? bytesPerGene : cellCount * bytesPerCell;
  const byMemory = Math.floor((budgetBytes * COMPUTE_SHARE) / (poolSize * TASKS_PER_WORKER * perGene));
  return Math.max(1, Math.min(even, byMemory));
}

/**
 * @param {object} options
 * @param {number} options.poolSize - Analysis workers
 * @param {number} options.cellCount - Cells each gene is read in
 * @param {number} [options.bytesPerCell] - What a gene holds a cell read
 *   until a read is measured (as `genesPerTaskFor`)
 * @param {number} [options.genesPerTask=1] - Genes each task takes (`genesPerTaskFor`)
 *   until a read is measured; fixed when the run names no `geneCount`
 * @param {number|null} [options.geneCount] - The run's genes: genes per task
 *   are sized again (`genesPerTaskFor`) at each measured read and each
 *   shrink of the budget
 * @param {() => number} [options.budgetBytes] - The analysis memory budget,
 *   read again when it shrinks (default: `analysisRunBudgetBytes`)
 * @param {() => ({latencyMs: number, bytesPerMs: number}|null)} [options.link] -
 *   The reader's latest link measurement, or null before one
 * @param {() => number} [options.now] - Clock (ms)
 */
export function createRunTuner({
  poolSize,
  cellCount,
  bytesPerCell = DENSE_COLUMN_BYTES_PER_CELL,
  genesPerTask: firstGenesPerTask = 1,
  geneCount = null,
  budgetBytes = analysisRunBudgetBytes,
  link = () => null,
  now = () => performance.now(),
}) {
  positiveInteger(poolSize, 'Tuner poolSize');
  positiveInteger(cellCount, 'Tuner cellCount');
  positiveInteger(bytesPerCell, 'Tuner bytesPerCell');
  positiveInteger(firstGenesPerTask, 'Tuner genesPerTask');
  if (geneCount !== null) positiveInteger(geneCount, 'Tuner geneCount');
  if (typeof budgetBytes !== 'function' || typeof link !== 'function' || typeof now !== 'function') {
    throw new TypeError('Tuner budgetBytes, link and now must be functions');
  }

  let budget = budgetBytes();
  let bytesPerGene = null;
  let genesPerTask = firstGenesPerTask;
  /** Genes per task at the budget and the genes' bytes as read (a run that names its `geneCount`). */
  const resize = () => {
    if (geneCount === null || bytesPerGene === null) return;
    genesPerTask = genesPerTaskFor({ geneCount, poolSize, cellCount, budgetBytes: budget, bytesPerCell, bytesPerGene });
  };
  let readMs = null;
  let taskMs = null;
  let readAhead = null;
  let tasksRunning = 0;
  let readsPending = 0;
  let pressureHalvings = 0;
  const adjustments = [];

  // The current window.
  let windowStart = now();
  let windowTasks = 0;
  /** Worker-milliseconds without a task in the current window. */
  let idleWorkerMs = 0;
  let lastEventAt = windowStart;
  let previousRate = null;
  let rateSpread = 0;

  const measuredLink = () => {
    const measurement = link();
    if (measurement === null || measurement === undefined) return null;
    const { latencyMs, bytesPerMs } = measurement;
    if (!Number.isFinite(latencyMs) || latencyMs < 0 || !Number.isFinite(bytesPerMs) || bytesPerMs <= 0) return null;
    return measurement;
  };

  /** Bytes one task in flight costs: its genes as measured, else their densest form. */
  const taskBytes = () => (bytesPerGene ?? cellCount * bytesPerCell) * genesPerTask;

  const computeInFlight = () => {
    const byMemory = Math.floor((budget * COMPUTE_SHARE) / taskBytes());
    return Math.max(1, Math.min(poolSize * TASKS_PER_WORKER, byMemory));
  };

  const memoryGate = () => Math.max(1, Math.floor((budget * BUFFER_SHARE) / taskBytes()));

  /** The read-ahead the measurements call for, before adaptation. */
  const modelledReadAhead = () => {
    const inFlight = computeInFlight();
    if (taskMs === null || taskMs <= 0) return inFlight * 2;
    const consumePerMs = poolSize / taskMs;
    const measured = measuredLink();
    let fetchMs;
    // A request under load takes longer than the shortest seen (`loadedRoundTripMs`).
    if (measured !== null) fetchMs = loadedRoundTripMs(measured) + taskBytes() / measured.bytesPerMs;
    else fetchMs = readMs ?? 0;
    return Math.ceil(consumePerMs * fetchMs) + inFlight;
  };

  /**
   * At least the compute in flight, so no worker waits on the buffer, unless
   * the memory gate is lower: buffered genes never hold more than their share
   * of the budget.
   */
  const clampReadAhead = value => Math.min(memoryGate(), Math.max(computeInFlight(), Math.round(value)));

  const note = (reason, from, to) => {
    if (from === to) return;
    adjustments.push({ atMs: Math.round(now() - startedAt), reason, from, to });
  };

  const startedAt = now();

  /**
   * The last doubling, kept until the next window shows whether it paid:
   * `{from, rate}`, the read-ahead and the rate before it.
   */
  let lastGrowth = null;
  /** A read-ahead that did not raise the rate: the run grows no further. */
  let ceiling = Infinity;

  const closeWindow = () => {
    const at = now();
    const elapsed = at - windowStart;
    if (elapsed < TUNER_WINDOW_MS || windowTasks < TUNER_WINDOW_TASKS) return;
    const rate = windowTasks / elapsed;
    const base = readAhead ?? clampReadAhead(modelledReadAhead());
    let next = Math.min(ceiling, Math.max(base, clampReadAhead(modelledReadAhead())));
    const idleShare = idleWorkerMs / (elapsed * poolSize);
    const growth = lastGrowth;
    lastGrowth = null;
    if (growth !== null && rate <= growth.rate + rateSpread) {
      // More reads ahead did not make the run faster (the reader, not the
      // read-ahead, sets the pace): back to where it was, and no higher.
      ceiling = growth.from;
      next = clampReadAhead(growth.from);
      note('no gain', base, next);
    } else if (idleShare > 0.1 && readsPending > 0 && next < ceiling) {
      const grown = Math.min(ceiling, clampReadAhead(next * 2));
      if (grown > next) lastGrowth = { from: next, rate };
      note('read-bound', base, grown);
      next = grown;
    } else if (previousRate !== null && rate < previousRate - rateSpread) {
      next = clampReadAhead(base / 2);
      note('throughput fell', base, next);
    }
    if (previousRate !== null) rateSpread = ema(rateSpread === 0 ? null : rateSpread, Math.abs(rate - previousRate));
    previousRate = rate;
    readAhead = next;
    windowStart = at;
    windowTasks = 0;
    idleWorkerMs = 0;
  };

  /** Count the idle workers since the last task event, before the count changes. */
  const accountIdle = () => {
    const at = now();
    idleWorkerMs += Math.max(0, poolSize - tasksRunning) * (at - lastEventAt);
    lastEventAt = at;
  };

  return {
    /** The genes each task takes now (sized again as reads are measured: `geneCount`). */
    genesPerTask: () => genesPerTask,
    /** Tasks' genes to read ahead of the consumer. */
    prefetchDepth() {
      if (readAhead === null) return clampReadAhead(modelledReadAhead());
      return clampReadAhead(readAhead);
    },
    /** Worker tasks to keep in flight. */
    computeInFlight,
    /**
     * Tasks whose genes may be read and not yet computed (being read, or
     * waiting for a worker) within the buffered genes' share of the budget:
     * the memory gate the read-ahead is held to. A read whose cost does not
     * shrink with its genes (a cell subset read by cell) fills it.
     */
    bufferedTasks: () => memoryGate(),
    /** Bytes one task's genes hold: as measured, else their densest form. */
    taskBytes,
    /** The analysis memory budget as last read. */
    memoryBudgetBytes: () => budget,
    /** A task's genes were read (`genes` of them): their bytes as read and how long the read took. */
    observeRead({ bytes, ms, genes = 1 }) {
      if (Number.isFinite(bytes) && bytes > 0 && Number.isSafeInteger(genes) && genes > 0) {
        bytesPerGene = ema(bytesPerGene, bytes / genes);
        resize();
      }
      if (Number.isFinite(ms) && ms >= 0) readMs = ema(readMs, ms);
    },
    /** Reads issued and not yet arrived (a read-bound run has some). */
    setReadsPending(count) {
      readsPending = count;
    },
    /** A worker task started. */
    taskStarted() {
      accountIdle();
      tasksRunning++;
    },
    /** A worker task ended after `ms`. */
    observeTask({ ms }) {
      accountIdle();
      tasksRunning = Math.max(0, tasksRunning - 1);
      if (Number.isFinite(ms) && ms >= 0) taskMs = ema(taskMs, ms);
      windowTasks++;
      closeWindow();
    },
    /** The budget shrank (a refused allocation, a larger working set, another page): it is read again and the read-ahead halves. */
    onPressure() {
      budget = budgetBytes();
      resize();
      pressureHalvings++;
      const from = readAhead ?? clampReadAhead(modelledReadAhead());
      readAhead = clampReadAhead(from / 2);
      note('memory pressure', from, readAhead);
    },
    /** What the run measured and decided, for its result and the debug log. */
    snapshot() {
      const measured = measuredLink();
      return {
        poolSize,
        genesPerTask,
        computeInFlight: computeInFlight(),
        prefetchDepth: this.prefetchDepth(),
        memoryBudgetMB: Math.round(budget / 2 ** 20),
        bytesPerGene: bytesPerGene === null ? null : Math.round(bytesPerGene),
        readMs: readMs === null ? null : +readMs.toFixed(2),
        taskMs: taskMs === null ? null : +taskMs.toFixed(2),
        link: measured === null ? null : {
          latencyMs: measured.latencyMs,
          bytesPerMs: Math.round(measured.bytesPerMs),
          protocol: measured.protocol ?? null,
        },
        pressureHalvings,
        adjustments: adjustments.slice(-16),
      };
    },
  };
}
