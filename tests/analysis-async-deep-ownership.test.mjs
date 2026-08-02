import assert from 'node:assert/strict';
import test from 'node:test';

import { DataLayer } from '../assets/js/app/analysis/data/data-layer.js';
import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';
import { createRestOfPageId } from '../assets/js/app/analysis/shared/page-derivation-utils.js';
import { PerformanceConfig } from '../assets/js/app/analysis/shared/performance-config.js';

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function pageData(pageId, values = [1, 2, 3]) {
  return {
    pageId,
    pageName: `Page ${pageId}`,
    values: Float32Array.from(values),
    cellIndices: Uint32Array.from(values, (_value, index) => index),
    cellCount: values.length,
  };
}

function analysisNotificationRecorder(id) {
  const terminal = [];
  return {
    notifications: {
      loading() {
        return id;
      },
      complete(notificationId) {
        terminal.push(['complete', notificationId]);
      },
      fail(notificationId) {
        terminal.push(['fail', notificationId]);
      },
      dismiss(notificationId) {
        terminal.push(['dismiss', notificationId]);
      },
    },
    terminal,
  };
}

test('correlation invalidation cleanup dismisses its gated inner notification synchronously and exactly once', async () => {
  const gate = deferred();
  const { notifications, terminal } = analysisNotificationRecorder('correlation-inner');
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    getDataForPages() {
      return gate.promise;
    },
  };
  analysis._computeManager = null;
  analysis._notifications = notifications;

  let current = true;
  let invalidationCleanup = null;
  const run = analysis.correlationAnalysis({
    varX: { type: 'continuous_obs', key: 'x' },
    varY: { type: 'continuous_obs', key: 'y' },
    pageIds: ['page-A'],
    isCurrent: () => current,
    registerInvalidationCleanup(cleanup) {
      invalidationCleanup = cleanup;
    },
  });

  await Promise.resolve();
  const registeredType = typeof invalidationCleanup;
  current = false;
  invalidationCleanup?.();
  invalidationCleanup?.();
  const terminalAtInvalidation = [...terminal];

  gate.resolve([pageData('page-A')]);
  const outcome = await run;

  assert.equal(registeredType, 'function');
  assert.deepEqual(
    terminalAtInvalidation,
    [['dismiss', 'correlation-inner']],
    'the request-local cleanup must synchronously dismiss the inner notification',
  );
  assert.equal(outcome, null);
  assert.deepEqual(
    terminal,
    [['dismiss', 'correlation-inner']],
    'cleanup and stale settlement must share one exact terminal owner',
  );
});

test('signature invalidation cleanup dismisses its gated inner notification synchronously and exactly once', async () => {
  const gate = deferred();
  const { notifications, terminal } = analysisNotificationRecorder('signature-inner');
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    getGeneExpressionSubset() {
      return gate.promise;
    },
    clearBulkGeneCache() {},
    performCacheCleanup() {},
  };
  analysis._computeManager = null;
  analysis._notifications = notifications;

  let current = true;
  let invalidationCleanup = null;
  const run = analysis.computeSignatureScore({
    genes: ['Gene A'],
    pageIds: ['page-A'],
    isCurrent: () => current,
    registerInvalidationCleanup(cleanup) {
      invalidationCleanup = cleanup;
    },
  });

  await Promise.resolve();
  const registeredType = typeof invalidationCleanup;
  current = false;
  invalidationCleanup?.();
  invalidationCleanup?.();
  const terminalAtInvalidation = [...terminal];

  gate.resolve({
    'Gene A': {
      'page-A': pageData('page-A'),
    },
  });
  const outcome = await run;

  assert.equal(registeredType, 'function');
  assert.deepEqual(
    terminalAtInvalidation,
    [['dismiss', 'signature-inner']],
    'the request-local cleanup must synchronously dismiss the inner notification',
  );
  assert.equal(outcome, null);
  assert.deepEqual(
    terminal,
    [['dismiss', 'signature-inner']],
    'cleanup and stale settlement must share one exact terminal owner',
  );
});

test('correlation snapshots variable records and page IDs before its first await', async () => {
  const gate = deferred();
  const requests = [];
  const { notifications } = analysisNotificationRecorder('correlation-snapshot');
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    getDataForPages(request) {
      requests.push(request);
      return gate.promise.then(() => {
        const values = request.variableKey === 'color'
          ? ['A', 'B', 'A']
          : [1, 2, 3];
        return [pageData(request.pageIds[0], values)];
      });
    },
  };
  analysis._computeManager = {
    async execute() {
      return {
        correlation: 1,
        pValue: 0,
        sampleSize: 3,
      };
    },
  };
  analysis._notifications = notifications;

  const varX = { type: 'continuous_obs', key: 'x' };
  const varY = { type: 'continuous_obs', key: 'y' };
  const colorBy = { type: 'categorical_obs', key: 'color' };
  const pageIds = ['page-original'];
  const run = analysis.correlationAnalysis({
    varX,
    varY,
    colorBy,
    pageIds,
    method: 'pearson',
  });

  varX.key = 'x-mutated';
  varY.key = 'y-mutated';
  colorBy.key = 'color-mutated';
  pageIds[0] = 'page-mutated';
  gate.resolve();

  const [result] = await run;

  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.notEqual(request.pageIds, pageIds);
    assert.deepEqual(request.pageIds, ['page-original']);
  }
  assert.equal(result.pageId, 'page-original');
  assert.equal(result.xVariable, 'x');
  assert.equal(result.yVariable, 'y');
  assert.equal(result.colorVariable, 'color');
});

test('signature snapshots genes and page IDs before its first await', async () => {
  const gate = deferred();
  const received = {};
  const { notifications } = analysisNotificationRecorder('signature-snapshot');
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    async getGeneExpressionSubset(genes, pageIds) {
      received.genes = genes;
      received.pageIds = pageIds;
      await gate.promise;
      return {
        'Gene A': { 'page-original': pageData('page-original', [1, 2, 3]) },
        'Gene B': { 'page-original': pageData('page-original', [3, 4, 5]) },
      };
    },
    clearBulkGeneCache() {},
    performCacheCleanup() {},
  };
  analysis._computeManager = null;
  analysis._notifications = notifications;

  const genes = ['Gene A', 'Gene B'];
  const pageIds = ['page-original'];
  const run = analysis.computeSignatureScore({
    genes,
    pageIds,
    method: 'mean',
  });

  genes[0] = 'Gene MUTATED';
  pageIds[0] = 'page-mutated';
  gate.resolve();

  const [result] = await run;

  assert.notEqual(received.genes, genes);
  assert.notEqual(received.pageIds, pageIds);
  assert.deepEqual(received.genes, ['Gene A', 'Gene B']);
  assert.deepEqual(received.pageIds, ['page-original']);
  assert.equal(result.pageId, 'page-original');
  assert.equal(result.genesUsed, 2);
});

function createDEMembershipProbe(indicesByPage) {
  const calls = {
    computeManager: 0,
    expressionRead: 0,
  };
  const computeProbe = new Error('compute manager reached');
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    state: { pointCount: 6 },
    getAvailableVariables() {
      return [{ key: 'Gene A', name: 'Gene A' }];
    },
    getPageInfo(pageId) {
      return { id: pageId, name: `Page ${pageId}` };
    },
    getCellIndicesForPage(pageId) {
      return indicesByPage[pageId];
    },
    async ensureGeneExpressionLoaded() {
      calls.expressionRead += 1;
      throw new Error('gene expression read reached');
    },
  };
  analysis._getComputeManager = async () => {
    calls.computeManager += 1;
    throw computeProbe;
  };
  analysis._notifications = {};
  return { analysis, calls, computeProbe };
}

test('DE rejects overlapping explicit memberships before gene expression or worker access', async () => {
  const { analysis, calls } = createDEMembershipProbe({
    'page-A': Uint32Array.of(0, 1, 2),
    'page-B': Uint32Array.of(2, 3, 4),
  });

  const error = await analysis.differentialExpression({
    pageA: 'page-A',
    pageB: 'page-B',
    geneList: ['Gene A'],
    method: 'wilcox',
    minCells: 2,
  }).then(
    () => null,
    failure => failure,
  );

  assert.ok(error instanceof Error);
  assert.match(error.message, /overlap|overlapping|disjoint/i);
  assert.equal(calls.expressionRead, 0);
  assert.equal(calls.computeManager, 0);
});

test('DE accepts an explicit page versus the exact rest-of that page', async () => {
  const pageA = 'page-A';
  const restOfA = createRestOfPageId(pageA);
  const { analysis, calls, computeProbe } = createDEMembershipProbe({
    [pageA]: Uint32Array.of(0, 1, 2),
  });

  await assert.rejects(
    analysis.differentialExpression({
      pageA,
      pageB: restOfA,
      geneList: ['Gene A'],
      method: 'wilcox',
      minCells: 2,
    }),
    error => error === computeProbe,
  );
  assert.equal(calls.expressionRead, 0);
  assert.equal(calls.computeManager, 1);
});

test('gene subset snapshots caller genes and pages across partial-cache awaits', async t => {
  const layer = new DataLayer({}, {
    enableNotifications: false,
    enablePrefetch: false,
    enableVersionTracking: false,
  });
  t.after(() => layer.destroy());

  layer._setBulkGeneCache('bulk_genes:page-A', {
    data: {
      'Gene A': {
        'page-A': pageData('page-A', [1]),
      },
    },
    timestamp: Date.now(),
    geneCount: 1,
  });

  const requests = [];
  const gates = [];
  layer.getDataForPages = request => {
    requests.push(request);
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  };

  const genes = ['Gene A', 'Gene B', 'Gene C'];
  const pageIds = ['page-A'];
  const run = layer.getGeneExpressionSubset(genes, pageIds);
  await waitFor(() => requests.length === 1, 'first partial-cache gene request');

  genes[2] = 'Gene MUTATED';
  pageIds[0] = 'page-mutated';
  gates[0].resolve([pageData('page-A', [2])]);
  await waitFor(() => requests.length === 2, 'second partial-cache gene request');
  gates[1].resolve([pageData('page-A', [3])]);

  const result = await run;

  assert.deepEqual(
    requests.map(request => request.variableKey),
    ['Gene B', 'Gene C'],
  );
  for (const request of requests) {
    assert.notEqual(request.pageIds, pageIds);
    assert.deepEqual(request.pageIds, ['page-A']);
  }
  assert.deepEqual(Object.keys(result), ['Gene A', 'Gene B', 'Gene C']);
});

test('dataset reset invalidates a partial-cache gene subset instead of returning mixed generations', async t => {
  const layer = new DataLayer({}, {
    enableNotifications: false,
    enablePrefetch: false,
    enableVersionTracking: false,
  });
  t.after(() => layer.destroy());

  layer._setBulkGeneCache('bulk_genes:page-A', {
    data: {
      'Gene A': {
        'page-A': pageData('page-A', [1]),
      },
    },
    timestamp: Date.now(),
    geneCount: 1,
  });

  const gate = deferred();
  layer.getDataForPages = () => gate.promise;

  const run = layer.getGeneExpressionSubset(
    ['Gene A', 'Gene B'],
    ['page-A'],
  );
  layer.resetForDatasetReload();
  gate.resolve([pageData('page-A', [2])]);

  await assert.rejects(
    run,
    error => (
      error?.code === 'ANALYSIS_DATA_REQUEST_INVALIDATED' &&
      /invalidated|dataset lifecycle/i.test(error.message)
    ),
  );
});

test('cooperative bulk-gene invalidation stops every later request and dismisses its data notification once', async t => {
  const layer = new DataLayer({}, {
    enableNotifications: false,
    enablePrefetch: false,
    enableVersionTracking: false,
  });
  t.after(() => layer.destroy());

  const firstBatchGate = deferred();
  const startedGenes = [];
  const progress = [];
  const terminal = [];
  let current = true;
  let invalidationCleanup = null;

  layer._notifications = {
    show() {
      return 'bulk-cooperative';
    },
    updateProgress() {},
    complete(id) {
      terminal.push(['complete', id]);
    },
    fail(id) {
      terminal.push(['fail', id]);
    },
    dismiss(id) {
      terminal.push(['dismiss', id]);
    },
  };
  layer.refreshPageVersions = () => {};
  layer.getAvailableVariables = () => Array.from(
    { length: 21 },
    (_unused, index) => ({ key: `Gene ${String(index + 1).padStart(2, '0')}` }),
  );
  layer.getDataForPages = async request => {
    startedGenes.push(request.variableKey);
    await firstBatchGate.promise;
    return [pageData('page-A', [1])];
  };

  const run = layer.fetchBulkGeneExpression({
    pageIds: ['page-A'],
    geneList: layer.getAvailableVariables().map(gene => gene.key),
    onProgress(value) {
      progress.push(value);
    },
    isCurrent: () => current,
    registerInvalidationCleanup(cleanup) {
      invalidationCleanup = cleanup;
    },
  });

  // The loader keeps a sliding window of `networkConcurrency` requests in
  // flight rather than issuing fixed batches, so the invariant under test is
  // not "the second batch never starts" — it is that *no further request* is
  // issued once cooperative ownership is lost, whatever the window size is.
  const window = PerformanceConfig.batch.networkConcurrency;
  await waitFor(
    () => startedGenes.length >= window,
    'the bulk-gene concurrency window to fill',
  );
  current = false;
  invalidationCleanup?.();
  invalidationCleanup?.();
  const terminalAtInvalidation = [...terminal];
  const startedAtInvalidation = [...startedGenes];
  firstBatchGate.resolve();

  const outcome = await run.then(
    value => ({ value }),
    error => ({ error }),
  );

  assert.equal(typeof invalidationCleanup, 'function');
  assert.deepEqual(
    terminalAtInvalidation,
    [['dismiss', 'bulk-cooperative']],
    'invalidation must dismiss the visible data notification synchronously',
  );
  assert.deepEqual(
    startedGenes,
    startedAtInvalidation,
    'no further gene request may start after cooperative ownership is lost',
  );
  assert.equal(
    startedGenes.length,
    window,
    'the loader must never exceed its configured concurrency window',
  );
  assert.deepEqual(
    startedGenes,
    Array.from(
      { length: window },
      (_unused, index) => `Gene ${String(index + 1).padStart(2, '0')}`,
    ),
    'the window must be filled in requested order',
  );
  assert.equal(outcome.error?.code, 'ANALYSIS_DATA_REQUEST_INVALIDATED');
  assert.deepEqual(terminal, [['dismiss', 'bulk-cooperative']]);
  assert.deepEqual(progress, [0]);
});
