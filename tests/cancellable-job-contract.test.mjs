/**
 * Cancellable jobs (`app/jobs/cancellable-job.js`) and the cancel path every
 * analysis takes: a cancel is never a failure, it stops the job's reads in
 * the AnnData reader worker and its tasks in the analysis workers, it keeps
 * nothing partial, and work other callers still wait for goes on for them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CancellableJob,
  JOB_READ_KINDS,
  SharedWork,
  awaitWithSignal,
  cancelledError,
  isCancellation,
  isJobRead,
} from '../assets/js/app/jobs/cancellable-job.js';
import { ABANDONED_TASK_GRACE_MS, WorkerPool } from '../assets/js/app/analysis/compute/worker-pool.js';
import { showReadProgress } from '../assets/js/app/read-progress-notifications.js';
import { DataLayer } from '../assets/js/app/analysis/data/data-layer.js';
import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';

const FIXTURE = new URL('./browser/fixtures/current-ui-smoke.h5ad', import.meta.url);

function fakeNotifications() {
  const calls = [];
  let nextId = 1;
  return {
    calls,
    progress(message, percent, options) {
      const id = `n${nextId++}`;
      calls.push(['progress', id, message, options]);
      return id;
    },
    updateProgress(id, percent, { message }) {
      calls.push(['update', id, message]);
    },
    complete(id, message) {
      calls.push(['complete', id, message]);
    },
    fail(id, message) {
      calls.push(['fail', id, message]);
    },
    dismiss(id) {
      calls.push(['dismiss', id]);
    },
    error(message) {
      calls.push(['error', message]);
    },
  };
}

function fakeLog() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    record(activity) {
      for (const listener of listeners) listener(activity);
    },
    get listeners() {
      return listeners.size;
    },
  };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a cancelled job aborts its signal with an AbortError and is never a failure', async () => {
  const notifications = fakeNotifications();
  let cancels = 0;
  const job = new CancellableJob({
    title: 'Differential expression',
    notifications,
    log: fakeLog(),
    notifyAfterMs: 0,
    onCancel: () => cancels++,
  });
  await wait(5);
  assert.equal(notifications.calls[0][0], 'progress', 'a running job shows one progress notification');
  assert.equal(typeof notifications.calls[0][3].onCancel, 'function', 'with Cancel');

  // Cancel from the notification.
  notifications.calls[0][3].onCancel();
  assert.equal(job.state, 'cancelled');
  assert.equal(job.signal.aborted, true);
  assert.equal(job.signal.reason.name, 'AbortError');
  assert.equal(isCancellation(job.signal.reason), true);
  assert.equal(cancels, 1);
  assert.deepEqual(notifications.calls.at(-1), ['dismiss', 'n1'], 'dismissed, not failed');

  // Ending it again changes nothing; a failure after a cancel is no failure.
  assert.equal(job.cancel(), false);
  job.fail(new Error('late'));
  job.succeed('late');
  assert.equal(job.state, 'cancelled');
  assert.equal(cancels, 1);
  assert.equal(notifications.calls.filter(call => call[0] === 'fail' || call[0] === 'error').length, 0);
});

test('a job failing with an AbortError is cancelled; a real failure says why once', async () => {
  const notifications = fakeNotifications();
  const aborted = new CancellableJob({ title: 'Correlation', notifications, log: fakeLog(), notifyAfterMs: Infinity });
  aborted.fail(cancelledError('Correlation'));
  assert.equal(aborted.state, 'cancelled');
  assert.deepEqual(notifications.calls, [], 'a cancel that never showed shows nothing');

  const failed = new CancellableJob({ title: 'Correlation', notifications, log: fakeLog(), notifyAfterMs: Infinity });
  failed.fail(new Error('No values'));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.message, 'No values');
  assert.deepEqual(notifications.calls, [['error', 'Correlation failed: No values']]);

  const shown = new CancellableJob({ title: 'Markers', notifications, log: fakeLog(), notifyAfterMs: 0 });
  await wait(5);
  shown.fail(new Error('Worker died'));
  assert.deepEqual(notifications.calls.at(-1), ['fail', 'n1', 'Markers failed: Worker died']);
});

test('a quick job shows no notification; a long one is updated and completed', async () => {
  const notifications = fakeNotifications();
  const quick = new CancellableJob({ title: 'Quick', notifications, log: fakeLog(), notifyAfterMs: 50 });
  quick.succeed();
  await wait(70);
  assert.deepEqual(notifications.calls, []);

  const long = new CancellableJob({ title: 'Signature', notifications, log: fakeLog(), notifyAfterMs: 0 });
  await wait(5);
  long.step('Reading genes').items(3, 10, 'genes');
  await wait(260);
  const update = notifications.calls.find(call => call[0] === 'update');
  assert.match(update[2], /^Signature: Reading genes: 3 of 10 genes/);
  long.succeed('Signature done');
  assert.deepEqual(notifications.calls.at(-1), ['complete', 'n1', 'Signature done']);
});

test('a job follows only its own reads, and the generic read notifications skip job reads', () => {
  const log = fakeLog();
  const job = new CancellableJob({
    title: 'Differential expression',
    readKind: 'analysis',
    notifications: fakeNotifications(),
    log,
    notifyAfterMs: Infinity,
  });
  const read = (id, owner, bytesFetched, status = 'running') => ({
    id, kind: 'analysis', owner, label: `${id} genes of X`, status, bytesFetched,
    bytesTotal: 1000, bytesPerSecond: null, remainingMs: null, startedAt: performance.now(), progress: null,
  });
  log.record(read(1, job.id, 400));
  log.record(read(2, 'job-other', 900));
  log.record({ ...read(3, job.id, 100), kind: 'genes' });
  assert.equal(job.readTotals().fetched, 400, 'another job\'s reads and view reads are not this job\'s');
  assert.match(job.describe(), /400 B of 1000 B \(40%\)/, 'one running read is described as it goes');
  job.items(2, 8, 'genes');
  assert.match(job.describe(), /2 of 8 genes, 400 B read/);
  job.cancel();
  assert.equal(log.listeners, 0, 'an ended job stops following the log');

  assert.deepEqual([...JOB_READ_KINDS].sort(), ['analysis', 'outliers']);
  assert.equal(isJobRead({ kind: 'analysis' }), true);
  assert.equal(isJobRead({ kind: 'genes' }), false);

  const generic = fakeLog();
  const shown = fakeNotifications();
  const stop = showReadProgress({ log: generic, notifications: shown });
  generic.record({ ...read(4, job.id, 10), elapsedMs: 5000, requests: 1 });
  generic.record({ ...read(5, null, 10), kind: 'genes', elapsedMs: 5000, requests: 1 });
  stop();
  assert.equal(shown.calls.length, 1, 'only the view read is shown generically');
  assert.match(shown.calls[0][2], /^Reading 5 genes of X/);
});

test('a job joining a gene load a view started adopts its reads: one notification for the run, the job\'s', async t => {
  const { getReadActivityLog } = await import('../assets/js/data/read-activity-log.js');
  const { createDataState } = await import('../assets/js/app/state/index.js');
  const log = getReadActivityLog();
  log.clear();
  t.after(() => log.clear());
  const generic = fakeNotifications();
  const stopShowing = showReadProgress({ log, notifications: generic });
  t.after(stopShowing);

  const state = createDataState({ viewer: {}, labelLayer: null });
  state.pointCount = 2;
  const descriptor = Object.freeze({ key: 'GENE_A', kind: 'continuous' });
  const field = { ...descriptor, loaded: false, _loadingPromise: null, _loadingSignal: null };
  state.varData = { fields: [field] };
  state._varFieldDescriptors = Object.freeze([descriptor]);
  let release;
  const loads = [];
  // The reader's report of the read a load makes, as the worker sends it.
  const report = (id, key, status, bytesFetched) => log.record({
    id, kind: 'genes', owner: null, keys: [key], label: 'gene 0 of X', status, bytesFetched,
    bytesTotal: 1000, bytesPerSecond: null, remainingMs: null, startedAt: performance.now(), elapsedMs: 5000,
    requests: 1, progress: null, detail: null,
  });
  state.setVarFieldLoader((_descriptor, options) => {
    loads.push(options);
    return new Promise(resolve => { release = resolve; });
  });

  // A view colours by the gene: its read is long, and shown as a read.
  const view = state.ensureVarFieldLoaded(0, { silent: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(loads.length, 1);
  assert.equal(loads[0].owner, null, 'the view started the load');
  assert.match(loads[0].key, /^field-load-\d+$/, 'the load names itself to its reads');
  report(9001, loads[0].key, 'running', 300);
  log.flush();
  assert.equal(generic.calls.filter(call => call[0] === 'progress').length, 1, 'shown as a read while no job waits for it');

  // A differential expression run needs the same gene and joins the load.
  const job = new CancellableJob({ title: 'Differential expression', readKind: 'analysis', notifications: fakeNotifications(), log, notifyAfterMs: Infinity });
  t.after(() => job.cancel());
  const joined = state.ensureVarFieldLoaded(0, { silent: true, owner: job.id });
  assert.equal(loads.length, 1, 'joined, not read again');
  log.flush();
  assert.deepEqual(generic.calls.at(-1), ['dismiss', 'n1'], 'the read\'s own notification goes');
  assert.equal(job.readTotals().fetched, 300, 'the job counts the read as its own');
  // The rest of the read is the job's alone.
  report(9001, loads[0].key, 'running', 700);
  report(9001, loads[0].key, 'done', 1000);
  log.flush();
  assert.equal(job.readTotals().fetched, 1000);
  assert.equal(generic.calls.length, 2, 'never shown as a read again');
  // A read of another load nobody joined is still shown.
  report(9002, 'field-load-other', 'running', 10);
  log.flush();
  assert.equal(generic.calls.at(-1)[0], 'progress');

  release({ values: new Float32Array([1, 2]) });
  assert.equal((await view).loaded, true);
  assert.equal(await joined, field);
});

test('awaitWithSignal lets one caller stop waiting while the work goes on', async () => {
  let finish;
  const work = new Promise(resolve => {
    finish = resolve;
  });
  const leaving = new AbortController();
  const left = awaitWithSignal(work, leaving.signal);
  const staying = awaitWithSignal(work, new AbortController().signal);
  leaving.abort(cancelledError('Reading'));
  await assert.rejects(left, error => error.name === 'AbortError');
  finish('values');
  assert.equal(await staying, 'values');
});

test('shared work goes on for the callers left and stops when none is', async () => {
  let started = 0;
  let workSignal = null;
  let finish;
  const shared = new SharedWork(signal => {
    started++;
    workSignal = signal;
    return new Promise(resolve => {
      finish = resolve;
    });
  });
  const a = new AbortController();
  const b = new AbortController();
  const first = shared.join(a.signal);
  const second = shared.join(b.signal);
  a.abort(cancelledError('A'));
  await assert.rejects(first, error => error.name === 'AbortError');
  assert.equal(workSignal.aborted, false, 'one caller left: the work goes on');
  finish('result');
  assert.equal(await second, 'result');
  assert.equal(started, 1);

  const alone = new SharedWork(signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const c = new AbortController();
  const only = alone.join(c.signal);
  c.abort(cancelledError('C'));
  await assert.rejects(only, error => error.name === 'AbortError');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(alone.abandoned, true, 'the last caller gone, the work stops');
});

// ---------------------------------------------------------------------------
// Analysis workers
// ---------------------------------------------------------------------------

/** A pool over fake workers that answer only when told to. */
function poolOverFakeWorkers(t, size = 2) {
  const originalWorker = globalThis.Worker;
  const created = [];
  class FakeWorker extends EventTarget {
    constructor() {
      super();
      this.posted = [];
      this.terminated = false;
      this.onmessage = null;
      created.push(this);
    }

    postMessage(message) {
      this.posted.push(message);
      if (message.type === 'INIT') {
        queueMicrotask(() => this.onmessage?.({ data: { type: 'INIT_ACK', workerId: message.payload.id } }));
      }
    }

    /** Answer the oldest unanswered task. */
    answer(result = { ok: true }) {
      const task = this.posted.find(message => message.requestId !== undefined && !message.answered);
      task.answered = true;
      this.onmessage?.({ data: { requestId: task.requestId, success: true, result } });
      return task;
    }

    terminate() {
      this.terminated = true;
    }
  }
  globalThis.Worker = FakeWorker;
  t.after(() => {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
  });
  const pool = new WorkerPool({ poolSize: size, defaultTimeout: 5_000 });
  t.after(() => pool.terminate());
  return { pool, created };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a cancelled queued task is never sent; the pool and other callers go on', async t => {
  const { pool, created } = poolOverFakeWorkers(t, 1);
  await pool.init();
  const run = new AbortController();
  const busy = pool.execute('COMPUTE_CORRELATION', { a: 1 }, { transfer: false });
  const queued = pool.execute('COMPUTE_CORRELATION', { a: 2 }, { transfer: false, signal: run.signal });
  const other = pool.execute('COMPUTE_CORRELATION', { a: 3 }, { transfer: false });
  await tick();
  run.abort(cancelledError('Differential expression'));
  await assert.rejects(queued, error => error.name === 'AbortError');
  created[0].answer({ value: 1 });
  assert.deepEqual(await busy, { value: 1 });
  await tick();
  const sent = created[0].answer({ value: 3 });
  assert.deepEqual(sent.payload, { a: 3 }, 'the cancelled task was skipped');
  assert.deepEqual(await other, { value: 3 });
  assert.equal(pool.isReady(), true);
  assert.equal(pool.getStats().replacedWorkers, 0);
});

test('a cancelled running task answers its caller at once and its late result is dropped', async t => {
  const { pool, created } = poolOverFakeWorkers(t, 1);
  await pool.init();
  const run = new AbortController();
  const running = pool.execute('COMPUTE_CORRELATION', { a: 1 }, { transfer: false, signal: run.signal });
  const next = pool.execute('COMPUTE_CORRELATION', { a: 2 }, { transfer: false });
  await tick();
  run.abort(cancelledError('Marker genes'));
  await assert.rejects(running, error => error.name === 'AbortError');
  // The worker comes back within its grace: it is kept and takes the next task.
  created[0].answer({ value: 'dropped' });
  await tick();
  created[0].answer({ value: 2 });
  assert.deepEqual(await next, { value: 2 });
  assert.equal(created.length, 1, 'no worker was replaced');
  assert.equal(pool.isReady(), true);
});

test('a cancelled task outliving its grace is cut short: its worker is replaced and kept state restored', async t => {
  const { pool, created } = poolOverFakeWorkers(t, 2);
  await pool.init();
  // State a run keeps in every worker, and a run that later releases its own.
  const markers = pool.broadcast('MARKERS_SET_CONTEXT', index => ({ worker: index }), { retainAs: 'markers' });
  await tick();
  created[0].answer();
  created[1].answer();
  await markers;
  const released = pool.broadcast('SET_TWO_GROUP_CONTEXT', () => ({ id: 'de-1' }), { retainAs: 'de-1' });
  await tick();
  created[0].answer();
  created[1].answer();
  await released;
  const cleared = pool.broadcast('CLEAR_TWO_GROUP_CONTEXT', () => ({ id: 'de-1' }), { releases: 'de-1' });
  await tick();
  created[0].answer();
  created[1].answer();
  await cleared;

  const run = new AbortController();
  const stuck = pool.executeOnWorker(0, 'COMPUTE_AGGLOMERATION', { a: 1 }, { transfer: false, signal: run.signal });
  const afterwards = pool.executeOnWorker(0, 'COMPUTE_CORRELATION', { a: 2 }, { transfer: false });
  const elsewhere = pool.executeOnWorker(1, 'COMPUTE_CORRELATION', { a: 3 }, { transfer: false });
  await tick();
  run.abort(cancelledError('Clustering'));
  await assert.rejects(stuck, error => error.name === 'AbortError');
  await wait(ABANDONED_TASK_GRACE_MS + 50);

  assert.equal(created[0].terminated, true, 'the worker still running the cancelled task is ended');
  assert.equal(created.length, 3, 'and replaced');
  const replacement = created[2];
  const restored = replacement.answer();
  assert.equal(restored.type, 'MARKERS_SET_CONTEXT', 'kept state first');
  assert.deepEqual(restored.payload, { worker: 0 });
  await tick();
  const next = replacement.answer({ value: 2 });
  assert.equal(next.type, 'COMPUTE_CORRELATION', 'released state is not restored; then the queue');
  assert.deepEqual(await afterwards, { value: 2 });
  created[1].answer({ value: 3 });
  assert.deepEqual(await elsewhere, { value: 3 }, 'the other worker never noticed');
  const stats = pool.getStats();
  assert.equal(stats.replacedWorkers, 1);
  assert.ok(stats.lastReplacementMs >= 0, 'what replacing cost is measured');
  assert.equal(pool.isReady(), true);
});

// ---------------------------------------------------------------------------
// AnnData reader worker
// ---------------------------------------------------------------------------

test('an analysis read carries its job as owner, reads of two jobs are separate, and one job\'s cancel spares the other', async t => {
  const { createInProcessAnnDataReaderWorker } = await import('./helpers/anndata-reader-in-process.mjs');
  const { AnnDataReaderClient, setAnnDataReaderWorkerFactory } = await import('../assets/js/data/anndata-reader-client.js');
  const { getReadActivityLog } = await import('../assets/js/data/read-activity-log.js');
  let worker = null;
  setAnnDataReaderWorkerFactory(() => {
    worker = createInProcessAnnDataReaderWorker();
    return worker;
  });
  const client = new AnnDataReaderClient();
  t.after(() => {
    client.close();
    setAnnDataReaderWorkerFactory(() => createInProcessAnnDataReaderWorker());
  });
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  await client.open({ file: new File([bytes], 'x.h5ad') });
  const log = getReadActivityLog();
  const seen = [];
  const unsubscribe = log.subscribe(activity => {
    if (activity.status !== 'running') seen.push(activity);
  });
  t.after(unsubscribe);
  const sent = () => worker.messages.filter(message => message.method === 'getMatrixColumnsSparse');

  const expected = await client.getMatrixColumnSparse('X', 4);
  const before = sent().length;
  const a = new AbortController();
  const b = new AbortController();
  // Job A is cancelled the moment its request reaches the reader worker.
  const post = worker.postMessage;
  worker.postMessage = (message, transfer) => {
    post(message, transfer);
    if (message.method === 'getMatrixColumnsSparse' && message.args.at(-1) === 'job-a') {
      a.abort(cancelledError('Job A'));
    }
  };
  const fromA = client.getMatrixColumnSparse('X', 4, { signal: a.signal, owner: 'job-a' });
  const fromB = client.getMatrixColumnSparse('X', 4, { signal: b.signal, owner: 'job-b' });
  const fromA2 = client.getMatrixColumnSparse('X', 5, { signal: a.signal, owner: 'job-a' });
  await assert.rejects(fromA, error => error.name === 'AbortError');
  await assert.rejects(fromA2, error => error.name === 'AbortError');
  const column = await fromB;
  assert.deepEqual(Array.from(column.values), Array.from(expected.values), 'job B still gets its gene');
  const requests = sent().slice(before);
  assert.deepEqual(requests.map(message => message.args.at(-1)).sort(), ['job-a', 'job-b'], 'one request per job');

  log.flush();
  const own = seen.filter(activity => activity.owner === 'job-b');
  assert.equal(own.length, 1);
  assert.equal(own[0].kind, 'analysis', 'an analysis read is a job read');
  assert.equal(own[0].status, 'done');
  const cancelled = seen.filter(activity => activity.owner === 'job-a');
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].status, 'cancelled', 'the cancelled job\'s read stopped in the worker');
  assert.ok(worker.messages.some(message => message.cancel !== undefined), 'the worker was told to stop');

  // A view's gene read names the shared loads it serves, so a job joining
  // one of them later adopts it.
  const [first, second] = await Promise.all([
    client.getMatrixColumn('X', 1, { key: 'field-load-a' }),
    client.getMatrixColumn('X', 2, { key: 'field-load-b' }),
  ]);
  assert.ok(first instanceof Float32Array && second instanceof Float32Array);
  log.flush();
  const batch = seen.filter(activity => activity.keys?.includes('field-load-a'));
  assert.equal(batch.length, 1, 'one request for both genes');
  assert.deepEqual([...batch[0].keys].sort(), ['field-load-a', 'field-load-b']);
  assert.equal(batch[0].kind, 'genes');
  assert.deepEqual(batch[0].adoptedBy, []);
});

// ---------------------------------------------------------------------------
// Analysis data: no partial cache entries
// ---------------------------------------------------------------------------

function pageDataLayer(t) {
  const layer = new DataLayer({}, {
    enableNotifications: false,
    enablePrefetch: false,
    enableVersionTracking: false,
  });
  t.after(() => layer.destroy());
  layer.refreshPageVersions = () => {};
  layer._getCacheKey = () => 'score:page-1';
  const fetches = [];
  layer._fetchDataForPages = (_options, _generation, signal) => new Promise((resolve, reject) => {
    fetches.push({ signal, resolve });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  return { layer, fetches };
}

const pageRequest = signal => ({ type: 'continuous_obs', variableKey: 'score', pageIds: ['page-1'], signal });

test('a page-data request goes on for the caller left and is cached once complete', async t => {
  const { layer, fetches } = pageDataLayer(t);
  const a = new AbortController();
  const fromA = layer.getDataForPages(pageRequest(a.signal));
  const fromB = layer.getDataForPages(pageRequest(new AbortController().signal));
  assert.equal(fetches.length, 1, 'asked twice, read once');
  a.abort(cancelledError('Correlation'));
  await assert.rejects(fromA, error => error.name === 'AbortError');
  assert.equal(fetches[0].signal.aborted, false, 'the other caller still waits');
  fetches[0].resolve(['page data']);
  assert.deepEqual(await fromB, ['page data']);
  assert.deepEqual(layer._dataCache.get('score:page-1'), ['page data']);
});

test('a page-data request every caller cancelled is stopped and never cached', async t => {
  const { layer, fetches } = pageDataLayer(t);
  const a = new AbortController();
  const only = layer.getDataForPages(pageRequest(a.signal));
  a.abort(cancelledError('Detailed analysis'));
  await assert.rejects(only, error => error.name === 'AbortError');
  await tick();
  assert.equal(fetches[0].signal.aborted, true, 'nobody waits: its read stops');
  assert.equal(layer._dataCache.has('score:page-1'), false, 'nothing partial is cached');
  assert.equal(layer._pendingRequests.has('score:page-1'), false);

  // Asked again, it is read again rather than joined to the stopped one.
  const again = layer.getDataForPages(pageRequest(null));
  assert.equal(fetches.length, 2);
  fetches[1].resolve(['fresh']);
  assert.deepEqual(await again, ['fresh']);
});

// ---------------------------------------------------------------------------
// Differential expression under its job
// ---------------------------------------------------------------------------

function differentialHarness({ execute }) {
  const reads = [];
  const tasks = [];
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    state: { pointCount: 6 },
    resolveExpressionMatrix: () => ({ matrix: 'X', read: null, label: 'Mapped (X)' }),
    async getGeneKeys() { return this.getAvailableVariables('gene_expression').map(gene => gene.key); },
    getAvailableVariables() {
      return ['Gene A', 'Gene B', 'Gene C'].map(key => ({ key, name: key }));
    },
    async readGeneColumn(gene, options) {
      reads.push({ gene, ...options });
      return { fieldIndex: 0, values: Float32Array.of(1, 2, 3, 4, 5, 6), owned: true };
    },
    performCacheCleanup() {
      return { cleaned: 0, remaining: 0 };
    },
  };
  analysis._getComputeManager = async () => ({
    selectBackend() {
      return 'cpu';
    },
    async broadcast(_operation, _payloadFor, options) {
      tasks.push(['broadcast', options]);
      return [{ sizeA: 3, sizeB: 3 }];
    },
    execute(operation, payload, options) {
      tasks.push(['execute', options]);
      return execute(options);
    },
  });
  return { analysis, reads, tasks };
}

/** One task's results (`COMPUTE_DIFFERENTIAL_OF_COLUMNS`): one gene a task here, each number its entry. */
const deResult = {
  meanA: [2], meanB: [5], pctA: [100], pctB: [100], log2FoldChange: [-1], pValue: [0.25],
  statistic: [3], score: [1], auroc: [0.5], nA: [3], nB: [3], method: 'wilcox'
};
const deOptions = {
  groupA: { name: 'Page page-A', cells: Uint32Array.of(0, 1, 2) },
  groupB: { name: 'Page page-B', cells: Uint32Array.of(3, 4, 5) },
  geneList: ['Gene A', 'Gene B', 'Gene C'],
  minCells: 2,
};

test('differential expression tells its job the cost and every gene, and runs under its signal', async () => {
  const { analysis, reads, tasks } = differentialHarness({ execute: async () => deResult });
  const job = new CancellableJob({ title: 'Differential expression', notifications: fakeNotifications(), log: fakeLog(), notifyAfterMs: Infinity });
  const counts = [];
  const original = job.items.bind(job);
  job.items = (done, total, unit) => {
    counts.push([done, total, unit]);
    return original(done, total, unit);
  };
  const result = await analysis.differentialExpression({ ...deOptions, job });
  assert.equal(result.results.length, 3);
  assert.match(job.plan, /^3 genes in Page page-A \(3 cells\) vs Page page-B \(3 cells\)$/);
  assert.deepEqual(counts[0], [0, 3, 'genes']);
  assert.deepEqual(counts.at(-1), [3, 3, 'genes']);
  assert.ok(reads.every(read => read.owner === job.id), 'every gene read is the job\'s');
  assert.ok(tasks.filter(([kind]) => kind === 'execute').every(([, options]) => options.signal === job.signal), 'every task is cancelled with the job');
  job.succeed();
});

test('a cancelled differential expression job stops its tasks and publishes nothing', async () => {
  let started;
  const taskStarted = new Promise(resolve => {
    started = resolve;
  });
  const { analysis } = differentialHarness({
    execute: options => {
      started();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
  });
  let current = true;
  const job = new CancellableJob({
    title: 'Differential expression',
    notifications: fakeNotifications(),
    log: fakeLog(),
    notifyAfterMs: Infinity,
    onCancel: () => {
      current = false;
    },
  });
  const run = analysis.differentialExpression({
    ...deOptions,
    job,
    isCurrent: () => current,
    registerInvalidationCleanup() {},
  });
  await taskStarted;
  job.cancel();
  assert.equal(await run, null, 'nothing is published, and nothing fails');
  assert.equal(job.state, 'cancelled');
});
