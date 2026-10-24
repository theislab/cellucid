/**
 * @fileoverview How a gene-streaming analysis run sizes itself: how many
 * genes it reads ahead, how many it hands the workers at once, and how much
 * memory it may hold. Nothing here is a setting; every number is derived
 * from what the device and the run report, and changes while the run goes.
 *
 * Inputs:
 * - the worker pool's size (one worker per core, less two:
 *   `performance-config.js` `analysisWorkerCount`);
 * - the analysis memory budget (`data/memory-budget.js`
 *   `residencyBudgetBytes('analysis')`), read at the start and again on
 *   every memory-pressure event, so a refused allocation (which halves the
 *   allowance) or pressure shrinks the run at once;
 * - each gene read: its bytes as read (sparse entries, not cells × 4) and
 *   how long it took;
 * - each worker task: how long it ran;
 * - the link as the reader measured it (round trip and throughput), when the
 *   reader reports one (`linkMeasurement`); a local file reports a zero round
 *   trip and its decode rate.
 *
 * Rules:
 * - **Compute in flight** = two tasks per worker (one running, one queued,
 *   so no worker waits for a message round trip), capped by half the budget
 *   over the measured bytes a task carries.
 * - **Read-ahead** = the genes consumed while one gene is fetched,
 *   `ceil(consumeRate × (latency + bytesPerGene / bytesPerMs))`, plus the
 *   genes in flight in the workers; consumeRate = workers / task time. Until
 *   the first measurements arrive it is twice the compute in flight. It is
 *   held to what 30 % of the budget buffers at the measured bytes per gene.
 * - **Adaptation**, once per window of max(250 ms, 32 genes): 250 ms is the
 *   rate floor the reader's activity reporting uses, 32 genes one full round
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

import { residencyBudgetBytes } from '../../../data/memory-budget.js';

/** The reader's activity reporting rate floor (ms): one window at least. */
export const TUNER_WINDOW_MS = 250;
/** One full round of two tasks on each of sixteen workers. */
export const TUNER_WINDOW_GENES = 32;
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

/**
 * @param {object} options
 * @param {number} options.poolSize - Analysis workers
 * @param {number} options.cellCount - Cells per gene column
 * @param {() => number} [options.budgetBytes] - The analysis memory budget,
 *   read again on pressure (default: `residencyBudgetBytes('analysis')`)
 * @param {() => ({latencyMs: number, bytesPerMs: number}|null)} [options.link] -
 *   The reader's latest link measurement, or null before one
 * @param {() => number} [options.now] - Clock (ms)
 */
export function createRunTuner({
  poolSize,
  cellCount,
  budgetBytes = () => residencyBudgetBytes('analysis'),
  link = () => null,
  now = () => performance.now(),
}) {
  positiveInteger(poolSize, 'Tuner poolSize');
  positiveInteger(cellCount, 'Tuner cellCount');
  if (typeof budgetBytes !== 'function' || typeof link !== 'function' || typeof now !== 'function') {
    throw new TypeError('Tuner budgetBytes, link and now must be functions');
  }

  let budget = budgetBytes();
  let bytesPerGene = null;
  let readMs = null;
  let taskMs = null;
  let readAhead = null;
  let tasksRunning = 0;
  let readsPending = 0;
  let pressureHalvings = 0;
  const adjustments = [];

  // The current window.
  let windowStart = now();
  let windowGenes = 0;
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

  /** Bytes one gene in flight costs: measured, else a dense column. */
  const geneBytes = () => bytesPerGene ?? cellCount * 4;

  const computeInFlight = () => {
    const byMemory = Math.floor((budget * COMPUTE_SHARE) / geneBytes());
    return Math.max(1, Math.min(poolSize * TASKS_PER_WORKER, byMemory));
  };

  const memoryGate = () => Math.max(1, Math.floor((budget * BUFFER_SHARE) / geneBytes()));

  /** The read-ahead the measurements call for, before adaptation. */
  const modelledReadAhead = () => {
    const inFlight = computeInFlight();
    if (taskMs === null || taskMs <= 0) return inFlight * 2;
    const consumePerMs = poolSize / taskMs;
    const measured = measuredLink();
    let fetchMs;
    if (measured !== null) fetchMs = measured.latencyMs + geneBytes() / measured.bytesPerMs;
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
    if (elapsed < TUNER_WINDOW_MS || windowGenes < TUNER_WINDOW_GENES) return;
    const rate = windowGenes / elapsed;
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
    windowGenes = 0;
    idleWorkerMs = 0;
  };

  /** Count the idle workers since the last task event, before the count changes. */
  const accountIdle = () => {
    const at = now();
    idleWorkerMs += Math.max(0, poolSize - tasksRunning) * (at - lastEventAt);
    lastEventAt = at;
  };

  return {
    /** Genes to read ahead of the consumer. */
    prefetchDepth() {
      if (readAhead === null) return clampReadAhead(modelledReadAhead());
      return clampReadAhead(readAhead);
    },
    /** Worker tasks to keep in flight. */
    computeInFlight,
    /** The analysis memory budget as last read. */
    memoryBudgetBytes: () => budget,
    /** A gene was read: its bytes as read and how long the read took. */
    observeRead({ bytes, ms }) {
      if (Number.isFinite(bytes) && bytes > 0) bytesPerGene = ema(bytesPerGene, bytes);
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
      windowGenes++;
      closeWindow();
    },
    /** Memory pressure, or a refused allocation: the budget is read again and the read-ahead halves. */
    onPressure() {
      budget = budgetBytes();
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
