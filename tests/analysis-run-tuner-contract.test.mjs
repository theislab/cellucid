/**
 * An analysis run sizes itself (`analysis/shared/run-tuner.js`); nothing
 * about it is a setting. The rules, driven here with an injected clock:
 *
 * - a task takes the run's genes over sixteen tasks per worker, held so the
 *   compute in flight holds dense columns within half the budget; bytes and
 *   read times are per task (its genes);
 * - compute in flight is two tasks per worker, capped by half the memory
 *   budget over the bytes a gene carries;
 * - the read-ahead is the genes consumed while one is fetched plus the
 *   compute in flight, and buffered genes never hold more than 30 % of the
 *   budget (the memory gate holds even when the budget is tiny);
 * - once per window (≥ 250 ms and ≥ 32 genes): workers idle while reads are
 *   pending (read-bound) double the read-ahead, a doubling that did not
 *   raise the next window's throughput is undone and caps the run; a
 *   compute-bound run stays where the model puts it; a throughput fall
 *   halves it;
 * - memory pressure re-reads the budget and halves the read-ahead;
 * - `performance-config.js` holds no presets and no option lists: the worker
 *   count is all that is configured.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TASKS_PER_WORKER_OVER_A_RUN,
  TUNER_WINDOW_TASKS,
  TUNER_WINDOW_MS,
  createRunTuner,
  genesPerTaskFor,
} from '../assets/js/app/analysis/shared/run-tuner.js';
import * as performanceConfig from '../assets/js/app/analysis/shared/performance-config.js';

const GB = 2 ** 30;

function clock() {
  let t = 0;
  return { now: () => t, advance: ms => { t += ms; } };
}

/** A tuner with a measured gene (`bytes` as read, `readMs` per read). */
function tunerWith({ poolSize = 4, cellCount = 1000, budget = GB, bytes = 400, readMs = 10, link } = {}) {
  const time = clock();
  let budgetBytes = budget;
  const reads = { count: 0 };
  const tuner = createRunTuner({
    poolSize,
    cellCount,
    budgetBytes: () => { reads.count++; return budgetBytes; },
    link,
    now: time.now,
  });
  tuner.observeRead({ bytes, ms: readMs });
  return { tuner, time, reads, setBudget: value => { budgetBytes = value; } };
}

test('the window is the reader reporting floor and one full round of sixteen workers', () => {
  assert.equal(TUNER_WINDOW_MS, 250);
  assert.equal(TUNER_WINDOW_TASKS, 32);
});

test('a task takes the run\'s genes over sixteen tasks per worker, within half the budget of dense columns', () => {
  assert.equal(TASKS_PER_WORKER_OVER_A_RUN, 16);
  // 200 genes over 2 workers: 32 tasks of 7 genes (the last one fewer).
  assert.equal(genesPerTaskFor({ geneCount: 200, poolSize: 2, cellCount: 20_000, budgetBytes: GB }), 7);
  // A few genes: one a task.
  assert.equal(genesPerTaskFor({ geneCount: 20, poolSize: 8, cellCount: 1000, budgetBytes: GB }), 1);
  // A million cells: 4 MB dense columns, 16 tasks in flight within half a GB.
  assert.equal(genesPerTaskFor({ geneCount: 30_000, poolSize: 8, cellCount: 1_000_000, budgetBytes: GB }), 8);
  // Never below one, however small the budget.
  assert.equal(genesPerTaskFor({ geneCount: 30_000, poolSize: 8, cellCount: 1_000_000, budgetBytes: 1000 }), 1);

  // A task's bytes are its genes': compute in flight and the gate count tasks.
  const time = clock();
  const tuner = createRunTuner({ poolSize: 4, cellCount: 1000, genesPerTask: 5, budgetBytes: () => 100_000, now: time.now });
  tuner.observeRead({ bytes: 20_000, ms: 10, genes: 5 });
  assert.equal(tuner.genesPerTask(), 5);
  // Half of 100 kB over 5 genes of 4 kB: 2 tasks.
  assert.equal(tuner.computeInFlight(), 2);
  assert.equal(tuner.snapshot().bytesPerGene, 4000);
  assert.throws(() => createRunTuner({ poolSize: 2, cellCount: 10, genesPerTask: 0 }), RangeError);
});

test('compute in flight is two tasks per worker, capped by half the budget', () => {
  assert.equal(tunerWith({ poolSize: 6 }).tuner.computeInFlight(), 12);
  // Half of 100 kB over 10 kB a gene: 5 tasks, fewer than 2 × 4 workers.
  assert.equal(tunerWith({ budget: 100_000, bytes: 10_000 }).tuner.computeInFlight(), 5);
  // Never below one, however small the budget.
  assert.equal(tunerWith({ budget: 1000, bytes: 10_000 }).tuner.computeInFlight(), 1);
  // Before a read is measured a gene costs a dense column.
  const unmeasured = createRunTuner({ poolSize: 4, cellCount: 25_000, budgetBytes: () => 1_000_000 });
  assert.equal(unmeasured.computeInFlight(), 5);
});

test('the read-ahead is the genes consumed while one is fetched, plus the compute in flight', () => {
  const { tuner, time } = tunerWith({ readMs: 10 });
  // No task measured yet: twice the compute in flight.
  assert.equal(tuner.prefetchDepth(), 16);
  tuner.taskStarted();
  time.advance(1);
  tuner.observeTask({ ms: 1 });
  // 4 workers / 1 ms × 10 ms fetch + 8 in flight.
  assert.equal(tuner.prefetchDepth(), 48);

  // A measured link replaces the read time: latency + bytes / throughput.
  const linked = tunerWith({ readMs: 10, link: () => ({ latencyMs: 20, bytesPerMs: 40 }) });
  linked.tuner.taskStarted();
  linked.tuner.observeTask({ ms: 1 });
  assert.equal(linked.tuner.prefetchDepth(), Math.ceil(4 * (20 + 400 / 40)) + 8);
});

test('the memory gate holds: buffered genes never pass 30 % of the budget', () => {
  for (const [budget, bytes, poolSize] of [
    [1_000_000, 10_000, 4],
    [100_000, 10_000, 4],     // compute in flight (5) above the gate (3)
    [200 * 2 ** 20, 20 * 2 ** 20, 16],
    [GB, 400, 8],
  ]) {
    const { tuner, time } = tunerWith({ budget, bytes, poolSize, readMs: 100_000 });
    tuner.taskStarted();
    tuner.observeTask({ ms: 1 });
    // Read-bound windows try to double it again and again.
    tuner.setReadsPending(5);
    for (let gene = 0; gene < 200; gene++) {
      time.advance(20);
      tuner.taskStarted();
      tuner.observeTask({ ms: 1 });
    }
    const depth = tuner.prefetchDepth();
    assert.ok(depth >= 1);
    assert.ok(
      depth === 1 || depth * bytes <= budget * 0.3,
      `${budget} B budget, ${bytes} B genes: read-ahead ${depth} holds ${depth * bytes} B`,
    );
  }
});

/** Feed `genes` tasks with workers idle `idleMs` before each one. */
function readBoundGenes(tuner, time, genes, idleMs) {
  for (let gene = 0; gene < genes; gene++) {
    time.advance(idleMs);
    tuner.taskStarted();
    time.advance(1);
    tuner.observeTask({ ms: 1 });
  }
}

test('a read-bound window doubles the read-ahead', () => {
  const { tuner, time } = tunerWith({ readMs: 10 });
  tuner.taskStarted();
  tuner.observeTask({ ms: 1 });
  const before = tuner.prefetchDepth();
  assert.equal(before, 48);
  tuner.setReadsPending(3);
  // 32 genes 11 ms apart: one 352 ms window with the workers mostly idle.
  readBoundGenes(tuner, time, TUNER_WINDOW_TASKS, 10);
  assert.equal(tuner.prefetchDepth(), before * 2);
  const adjustment = tuner.snapshot().adjustments.at(-1);
  assert.deepEqual([adjustment.reason, adjustment.from, adjustment.to], ['read-bound', before, before * 2]);
});

test('a doubling that does not raise the throughput is undone and caps the run', () => {
  const { tuner, time } = tunerWith({ readMs: 10 });
  tuner.taskStarted();
  tuner.observeTask({ ms: 1 });
  const before = tuner.prefetchDepth();
  tuner.setReadsPending(3);
  // Read-bound, so it doubles; the next window is just as slow (the reader
  // sets the pace), so the doubling is undone ...
  readBoundGenes(tuner, time, TUNER_WINDOW_TASKS, 10);
  assert.equal(tuner.prefetchDepth(), before * 2);
  readBoundGenes(tuner, time, TUNER_WINDOW_TASKS, 10);
  assert.equal(tuner.prefetchDepth(), before);
  assert.equal(tuner.snapshot().adjustments.at(-1).reason, 'no gain');
  // ... and however read-bound later windows are, it grows no further.
  readBoundGenes(tuner, time, TUNER_WINDOW_TASKS * 4, 10);
  assert.equal(tuner.prefetchDepth(), before);
});

test('a doubling that raises the throughput is kept and the run grows on', () => {
  const { tuner, time } = tunerWith({ readMs: 10 });
  tuner.taskStarted();
  tuner.observeTask({ ms: 1 });
  const before = tuner.prefetchDepth();
  tuner.setReadsPending(3);
  readBoundGenes(tuner, time, TUNER_WINDOW_TASKS, 10);
  // Twice as fast after the doubling, and still read-bound: doubles again.
  readBoundGenes(tuner, time, TUNER_WINDOW_TASKS * 2, 4);
  assert.equal(tuner.prefetchDepth(), before * 4);
});

test('idle workers with no read pending are not read-bound', () => {
  const { tuner, time } = tunerWith({ readMs: 10 });
  // Windows of exactly equal throughput (no warm-up task in the first).
  readBoundGenes(tuner, time, 1, 10);
  const before = tuner.prefetchDepth();
  tuner.setReadsPending(0);
  readBoundGenes(tuner, time, TUNER_WINDOW_TASKS * 3 - 1, 10);
  assert.equal(tuner.prefetchDepth(), before);
  assert.deepEqual(tuner.snapshot().adjustments, []);
});

/** Keep every worker busy: one task ends and the next starts every `stepMs`. */
function busyGenes(tuner, time, genes, stepMs, taskMs) {
  for (let gene = 0; gene < genes; gene++) {
    time.advance(stepMs);
    tuner.observeTask({ ms: taskMs });
    tuner.taskStarted();
  }
}

function busyTuner(readMs) {
  const setup = tunerWith({ readMs });
  for (let worker = 0; worker < 4; worker++) setup.tuner.taskStarted();
  return setup;
}

test('a compute-bound run stays where the model puts it', () => {
  const { tuner, time } = busyTuner(5);
  busyGenes(tuner, time, 1, 10, 40);
  const modelled = tuner.prefetchDepth();
  // 4 workers / 40 ms × 5 ms + 8 in flight.
  assert.equal(modelled, Math.ceil((4 / 40) * 5) + 8);
  const depths = [];
  for (let window = 0; window < 5; window++) {
    busyGenes(tuner, time, TUNER_WINDOW_TASKS, 10, 40);
    depths.push(tuner.prefetchDepth());
  }
  assert.deepEqual(depths, depths.map(() => modelled));
  assert.deepEqual(tuner.snapshot().adjustments, []);
});

test('a window whose throughput falls halves the read-ahead', () => {
  const { tuner, time } = busyTuner(100);
  busyGenes(tuner, time, 1, 10, 40);
  const modelled = tuner.prefetchDepth();
  // 4 / 40 × 100 + 8 = 18, so its half (9) stays above the compute in flight (8).
  assert.equal(modelled, 18);
  // Two windows at one rate, then one at a third of it.
  busyGenes(tuner, time, TUNER_WINDOW_TASKS, 10, 40);
  busyGenes(tuner, time, TUNER_WINDOW_TASKS, 10, 40);
  assert.equal(tuner.prefetchDepth(), modelled);
  busyGenes(tuner, time, TUNER_WINDOW_TASKS, 30, 40);
  assert.equal(tuner.prefetchDepth(), Math.round(modelled / 2));
  const adjustment = tuner.snapshot().adjustments.at(-1);
  assert.deepEqual([adjustment.reason, adjustment.from, adjustment.to], ['throughput fell', 18, 9]);
});

test('memory pressure re-reads the budget and halves the read-ahead', () => {
  const { tuner, time, reads, setBudget } = busyTuner(100);
  busyGenes(tuner, time, 1, 10, 40);
  assert.equal(tuner.prefetchDepth(), 18);
  const readsBefore = reads.count;
  setBudget(GB / 2);
  tuner.onPressure();
  assert.equal(reads.count, readsBefore + 1, 'the budget is read again');
  assert.equal(tuner.memoryBudgetBytes(), GB / 2);
  assert.equal(tuner.prefetchDepth(), 9);
  assert.equal(tuner.snapshot().pressureHalvings, 1);
  assert.equal(tuner.snapshot().adjustments.at(-1).reason, 'memory pressure');

  // Halving stops at the compute in flight.
  tuner.onPressure();
  tuner.onPressure();
  assert.equal(tuner.prefetchDepth(), tuner.computeInFlight());

  // A refused allocation halves the budget: the gate follows it at once.
  setBudget(40_000);
  tuner.onPressure();
  const depth = tuner.prefetchDepth();
  assert.ok(depth * 400 <= 40_000 * 0.3, `read-ahead ${depth} within the halved budget`);
});

test('the snapshot records what the run measured and decided', () => {
  const { tuner } = tunerWith({ readMs: 10, link: () => ({ latencyMs: 12, bytesPerMs: 900.4, protocol: 'h2' }) });
  tuner.taskStarted();
  tuner.observeTask({ ms: 2 });
  const snapshot = tuner.snapshot();
  assert.deepEqual(Object.keys(snapshot), [
    'poolSize', 'genesPerTask', 'computeInFlight', 'prefetchDepth', 'memoryBudgetMB', 'bytesPerGene',
    'readMs', 'taskMs', 'link', 'pressureHalvings', 'adjustments',
  ]);
  assert.equal(snapshot.bytesPerGene, 400);
  assert.equal(snapshot.taskMs, 2);
  assert.deepEqual(snapshot.link, { latencyMs: 12, bytesPerMs: 900, protocol: 'h2' });
  assert.equal(snapshot.memoryBudgetMB, 1024);
});

test('the tuner refuses inputs it cannot size a run from', () => {
  assert.throws(() => createRunTuner({ poolSize: 0, cellCount: 10 }), RangeError);
  assert.throws(() => createRunTuner({ poolSize: 2, cellCount: 1.5 }), RangeError);
  assert.throws(() => createRunTuner({ poolSize: 2, cellCount: 10, now: 5 }), TypeError);
  // An unusable link measurement is ignored, not trusted.
  const { tuner } = tunerWith({ readMs: 10, link: () => ({ latencyMs: -1, bytesPerMs: 0 }) });
  tuner.taskStarted();
  tuner.observeTask({ ms: 1 });
  assert.equal(tuner.prefetchDepth(), 48);
  assert.equal(tuner.snapshot().link, null);
});

test('performance-config.js configures the worker count and nothing else', () => {
  assert.deepEqual(Object.keys(performanceConfig).sort(), ['analysisWorkerCount']);
  const { analysisWorkerCount } = performanceConfig;
  assert.equal(analysisWorkerCount({ navigator: { hardwareConcurrency: 10 } }), 8);
  assert.equal(analysisWorkerCount({ navigator: { hardwareConcurrency: 2 } }), 1);
  assert.equal(analysisWorkerCount({ navigator: {} }), 2);
  assert.equal(analysisWorkerCount({}), 2);
});
