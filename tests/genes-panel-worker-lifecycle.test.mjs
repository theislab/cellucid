/**
 * Marker discovery's worker lifecycle: every task runs under the run's
 * signal, the grouping context a worker keeps is re-sent to a replaced one,
 * one run owns the workers' context at a time, an abort publishes nothing,
 * a worker failure reaches the caller as itself, and the controller's cache
 * is keyed by everything that changes a run's statistics.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { getWorkerPool } from '../assets/js/app/analysis/compute/worker-pool.js';
import { computeCategoryGroupingDigest } from '../assets/js/app/analysis/data/data-layer.js';
import { MarkerCache } from '../assets/js/app/analysis/genes-panel/marker-cache.js';
import { MarkerDiscoveryEngine } from '../assets/js/app/analysis/genes-panel/marker-discovery-engine.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve));
}

async function withPatchedWorkerPool(overrides, callback) {
  const pool = getWorkerPool();
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, Object.getOwnPropertyDescriptor(pool, key));
    Object.defineProperty(pool, key, { configurable: true, writable: true, value });
  }
  try {
    return await callback(pool);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor === undefined) delete pool[key];
      else Object.defineProperty(pool, key, descriptor);
    }
  }
}

function readyPool({ broadcast, execute }) {
  return {
    async init() { return true; },
    isReady() { return true; },
    getStats() { return { poolSize: 1 }; },
    broadcast,
    execute,
  };
}

function createDiscovery(gene = 'GENE') {
  const values = Float32Array.from([1, 2, 3, 4]);
  const dataLayer = {
    state: { pointCount: values.length },
    getAvailableVariables: () => [{ key: gene }],
    async readGeneColumn(requested, options) {
      assert.equal(requested, gene);
      assert.equal(options.priority, 'bulk');
      assert.ok(options.signal instanceof AbortSignal);
      return { fieldIndex: 0, values, owned: true };
    },
  };
  const engine = new MarkerDiscoveryEngine({ dataLayer });
  const options = {
    grouping: {
      codes: Uint8Array.of(0, 0, 1, 1),
      codeToGroupIndex: Int32Array.of(0, 1),
      groupCount: 2,
      tested: Uint8Array.of(1, 1),
      reference: -1,
      scope: null,
    },
    genes: [gene],
    method: 'ttest',
    pConvention: 'exact',
    correction: 'bh',
    foldChange: { mode: 'stored', base: null },
    minCellsPerSide: 2,
  };
  return { engine, options };
}

/** One task's packed statistics (`MARKERS_COMPUTE_GENES`): one gene, two groups. */
function workerResult() {
  return {
    genes: 1,
    groupCount: 2,
    pValues: Float64Array.of(0.01, 0.01),
    scores: Float32Array.of(-3, 3),
    auroc: Float32Array.of(NaN, NaN),
    log2FoldChange: Float32Array.of(-1, 1),
    meanInGroup: Float32Array.of(1.5, 3.5),
    meanOutGroup: Float32Array.of(3.5, 1.5),
    percentInGroup: Float32Array.of(100, 100),
    percentOutGroup: Float32Array.of(100, 100),
    nIn: Uint32Array.of(2, 2),
    nOut: Uint32Array.of(2, 2),
    nAll: Uint32Array.of(4),
    moments: Float64Array.of(10, 30, 4, 4),
  };
}

test('every marker task runs under the run\'s signal; the context is retained for replaced workers', async () => {
  const { engine, options } = createDiscovery();
  const broadcasts = [];
  const executions = [];
  const signal = new AbortController().signal;
  await withPatchedWorkerPool(readyPool({
    async broadcast(type, payloadFor, execution) {
      broadcasts.push({ type, payload: payloadFor(0), execution });
      return [{ ok: true }];
    },
    async execute(type, payload, execution) {
      executions.push({ type, payload, execution });
      return workerResult();
    },
  }), async () => {
    const stats = await engine.discoverMarkers({ ...options, signal });
    assert.equal(stats.genesTestedByGroup[0], 1);
    assert.ok(Number.isFinite(stats.adjustedPValuesByGroup[0][0]));
  });
  // The context is set, and released when the run ends.
  assert.equal(broadcasts.length, 2);
  assert.equal(broadcasts[0].type, 'MARKERS_SET_CONTEXT');
  assert.equal(broadcasts[1].type, 'MARKERS_CLEAR_CONTEXT');
  assert.equal(broadcasts[1].execution.releases, 'markers');
  assert.equal(broadcasts[1].execution.signal, undefined, 'the release is not cancelled with the run');
  assert.equal(broadcasts[0].execution.retainAs, 'markers');
  assert.equal(broadcasts[0].execution.signal, signal);
  assert.deepEqual(Object.keys(broadcasts[0].payload).sort(), ['codeToGroupIndex', 'codes', 'groupCount', 'reference', 'tested']);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].type, 'MARKERS_COMPUTE_GENES');
  assert.equal(executions[0].payload.columns.length, 1, 'a dataset without a gene route sends its genes with the task');
  assert.equal(executions[0].execution.signal, signal);
  assert.equal(typeof executions[0].execution.onTiming, 'function', 'the run tuner hears each task');
});

test('an aborted run publishes nothing and rejects with its reason', async () => {
  const { engine, options } = createDiscovery();
  const controller = new AbortController();
  const reason = new DOMException('stop', 'AbortError');
  const started = deferred();
  const broadcasts = [];
  await withPatchedWorkerPool(readyPool({
    async broadcast(type, _payloadFor, execution) {
      broadcasts.push({ type, execution });
      return [{ ok: true }];
    },
    execute(_type, _payload, execution) {
      started.resolve();
      return new Promise((_resolve, reject) => {
        execution.signal.addEventListener('abort', () => reject(execution.signal.reason), { once: true });
      });
    },
  }), async () => {
    const run = engine.discoverMarkers({ ...options, signal: controller.signal });
    await started.promise;
    controller.abort(reason);
    await assert.rejects(run, error => error === reason);
  });
  // The workers' groups (one entry a cell) do not outlive the cancelled run,
  // and the pool stops replaying them to replaced workers.
  assert.deepEqual(
    broadcasts.map(({ type, execution }) => [type, execution.retainAs ?? execution.releases]),
    [['MARKERS_SET_CONTEXT', 'markers'], ['MARKERS_CLEAR_CONTEXT', 'markers']]
  );
});

test('a worker failure reaches the caller as itself', async () => {
  const { engine, options } = createDiscovery();
  const failure = new Error('worker exploded');
  await withPatchedWorkerPool(readyPool({
    async broadcast() { return [{ ok: true }]; },
    async execute() { throw failure; },
  }), async () => {
    await assert.rejects(engine.discoverMarkers(options), error => error === failure);
  });
});

test('one run owns the workers\' marker context at a time', async () => {
  const first = createDiscovery('FIRST');
  const second = createDiscovery('SECOND');
  const gate = deferred();
  const order = [];
  await withPatchedWorkerPool(readyPool({
    async broadcast(type, payloadFor) {
      order.push(type === 'MARKERS_SET_CONTEXT' ? `context:${payloadFor(0).codes.length}` : 'release');
      return [{ ok: true }];
    },
    async execute(_type, payload) {
      order.push('task');
      if (order.filter(item => item === 'task').length === 1) await gate.promise;
      return workerResult();
    },
  }), async () => {
    const one = first.engine.discoverMarkers(first.options);
    const two = second.engine.discoverMarkers(second.options);
    await nextTurn();
    assert.deepEqual(order, ['context:4', 'task'], 'the second run waits for the first');
    gate.resolve();
    await Promise.all([one, two]);
    assert.deepEqual(order, ['context:4', 'task', 'release', 'context:4', 'task', 'release']);
  });
});

test('an aborted context waiter leaves the queue at once', async () => {
  const first = createDiscovery('FIRST');
  const waiting = createDiscovery('WAITING');
  const gate = deferred();
  await withPatchedWorkerPool(readyPool({
    async broadcast() { return [{ ok: true }]; },
    async execute() {
      await gate.promise;
      return workerResult();
    },
  }), async () => {
    const running = first.engine.discoverMarkers(first.options);
    await nextTurn();
    const controller = new AbortController();
    const queued = waiting.engine.discoverMarkers({ ...waiting.options, signal: controller.signal });
    const reason = new DOMException('no longer wanted', 'AbortError');
    controller.abort(reason);
    await assert.rejects(queued, error => error === reason);
    gate.resolve();
    await running;
  });
});

test('the marker cache is keyed by the run\'s parameters and its load', () => {
  const cache = new MarkerCache({ identity: { key: 'load-1' }, budgetBytes: () => 2 ** 30 });
  const grouping = computeCategoryGroupingDigest(Uint8Array.of(0, 1, 1));
  const params = { field: 'cell_type', grouping, method: 'wilcox', reference: -1 };
  const stats = { pValuesByGroup: [Float64Array.of(0.1)] };
  cache.set(params, stats);
  assert.equal(cache.get(params), stats);
  assert.equal(cache.get({ ...params, method: 'ttest' }), null, 'another test is another entry');
  assert.equal(cache.get({ ...params, grouping: computeCategoryGroupingDigest(Uint8Array.of(1, 1, 1)) }), null,
    'another grouping of the same field is another entry');
  cache.setIdentity({ key: 'load-2' });
  assert.equal(cache.get(params), null, 'another load starts empty');
});

test('the marker cache holds a share of the analysis budget, dropping the oldest', () => {
  let budget = 4 * 8 * 4; // four entries of 8 bytes at a quarter share
  const cache = new MarkerCache({ identity: { key: 'load' }, budgetBytes: () => budget });
  for (let i = 0; i < 6; i++) cache.set({ i }, { lane: new Float64Array(1) });
  assert.equal(cache.getStats().entries, 4);
  assert.equal(cache.get({ i: 0 }), null);
  assert.notEqual(cache.get({ i: 5 }), null);
  budget = 8 * 4; // a refused allocation halved the allowance, twice
  cache.set({ i: 6 }, { lane: new Float64Array(1) });
  assert.equal(cache.getStats().entries, 1, 'the next store reads the budget again');
  cache.trim();
  assert.equal(cache.getStats().entries, 1);
});

test('over a gene route a marker task names its delivery and runs on the worker it went to', async () => {
  const values = Float32Array.from([1, 2, 3, 4]);
  const routeCalls = [];
  const delivered = [];
  const dataLayer = {
    state: { pointCount: values.length },
    deliversGenes: () => true,
    isGeneDeliverable: () => true,
    async openGeneRoute(id, ports) {
      routeCalls.push(['open', id, ports.length]);
      assert.ok(ports.every(port => port instanceof MessagePort));
    },
    async closeGeneRoute(id) { routeCalls.push(['close', id]); },
    async deliverGeneColumns(genes, delivery, options) {
      delivered.push({ genes, delivery, options });
      return { bytes: genes.map(() => 32) };
    },
    async readGeneColumn() { throw new Error('a delivered gene is never read here'); },
  };
  const engine = new MarkerDiscoveryEngine({ dataLayer });
  const { options } = createDiscovery();
  const broadcasts = [];
  const onWorker = [];
  const closed = deferred();
  await withPatchedWorkerPool({
    async init() { return true; },
    isReady() { return true; },
    getStats() { return { poolSize: 2 }; },
    async broadcast(type, payloadFor, execution) {
      const payloads = [payloadFor(0), payloadFor(1)];
      broadcasts.push({ type, payloads, execution });
      if (type === 'GENE_ROUTE_CLOSE') closed.resolve();
      return payloads.map(() => ({ ok: true }));
    },
    async execute() { throw new Error('a delivered task runs on its worker'); },
    async executeOnWorker(worker, type, payload, execution) {
      onWorker.push({ worker, type, payload, execution });
      return workerResult();
    },
  }, async () => {
    const stats = await engine.discoverMarkers({ ...options, readOwner: 'job-7' });
    assert.equal(stats.genesTestedByGroup[0], 1);
    await closed.promise;
  });
  const open = broadcasts.find(entry => entry.type === 'GENE_ROUTE_OPEN');
  assert.ok(open.payloads.every(payload => payload.port instanceof MessagePort && payload.generation === 0));
  assert.equal(open.execution.retainAs, open.payloads[0].route, 'a replaced worker gets a port again');
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].genes, ['GENE']);
  assert.equal(delivered[0].options.owner, 'job-7');
  assert.equal(delivered[0].delivery.route, open.payloads[0].route);
  assert.equal(onWorker.length, 1);
  assert.equal(onWorker[0].type, 'MARKERS_COMPUTE_GENES');
  const [run] = delivered[0].delivery.runs;
  assert.equal(onWorker[0].worker, run.worker);
  assert.deepEqual(onWorker[0].payload.delivery, { route: delivered[0].delivery.route, id: run.id, generation: 0 });
  assert.equal(onWorker[0].payload.columns, undefined, 'the task carries no values');
  const close = broadcasts.find(entry => entry.type === 'GENE_ROUTE_CLOSE');
  assert.equal(close.execution.releases, open.payloads[0].route);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(routeCalls.map(call => call[0]), ['open', 'close']);
  for (const payload of open.payloads) payload.port.close();
});
