import assert from 'node:assert/strict';
import test from 'node:test';

import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';
import { getDataSourceManager } from '../assets/js/data/data-source-manager.js';

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
  for (let attempt = 0; attempt < 100; attempt++) {
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

for (const ownershipCase of [
  {
    label: 'correlation',
    invoke(analysis) {
      return analysis.correlationAnalysis({
        varX: { type: 'continuous_obs', key: 'x' },
        varY: { type: 'continuous_obs', key: 'y' },
        pageIds: ['page-A'],
        isCurrent: () => true,
      });
    },
  },
  {
    label: 'differential expression',
    invoke(analysis) {
      return analysis.differentialExpression({
        groupA: { name: 'A', cells: Uint32Array.of(0, 1, 2) },
        groupB: { name: 'B', cells: Uint32Array.of(3, 4, 5) },
        geneList: ['Gene A'],
        minCells: 2,
        isCurrent: () => true,
      });
    },
  },
  {
    label: 'signature scoring',
    invoke(analysis) {
      return analysis.computeSignatureScore({
        geneSets: [{ name: 'S', genes: ['Gene A'] }],
        pageIds: ['page-A'],
        isCurrent: () => true,
      });
    },
  },
]) {
  test(`${ownershipCase.label} requires invalidation registration with isCurrent`, async () => {
    let dataAccesses = 0;
    const analysis = Object.create(MultiVariableAnalysis.prototype);
    analysis.dataLayer = new Proxy(
      { state: { pointCount: 6 } },
      {
        get(target, property, receiver) {
          if (Reflect.has(target, property)) {
            return Reflect.get(target, property, receiver);
          }
          return () => {
            dataAccesses += 1;
            throw new Error('request ownership validation reached data access');
          };
        },
      },
    );

    await assert.rejects(
      ownershipCase.invoke(analysis),
      /requires registerInvalidationCleanup with isCurrent/i,
    );
    assert.equal(dataAccesses, 0);
  });
}

function createDEBoundaryProbe(pointCount = 6) {
  const calls = {
    computeManager: 0,
    expressionRead: 0,
  };
  const computeProbe = new Error('compute manager reached');
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    state: { pointCount },
    resolveExpressionMatrix: () => ({ matrix: 'X', read: null, label: 'Mapped (X)' }),
    async getGeneKeys() { return this.getAvailableVariables('gene_expression').map(gene => gene.key); },
    getAvailableVariables() {
      return [{ key: 'Gene A', name: 'Gene A' }];
    },
    async readGeneColumn() {
      calls.expressionRead += 1;
      throw new Error('gene expression read reached');
    },
  };
  analysis._getComputeManager = async () => {
    calls.computeManager += 1;
    throw computeProbe;
  };
  return { analysis, calls, computeProbe };
}

test('DE rejects minCells below the backend minimum before data or compute access', async () => {
  let dataAccesses = 0;
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = new Proxy(
    { state: { pointCount: 6 } },
    {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) {
          return Reflect.get(target, property, receiver);
        }
        return () => {
          dataAccesses += 1;
          throw new Error('invalid minCells reached data access');
        };
      },
    },
  );

  await assert.rejects(
    analysis.differentialExpression({
      groupA: { name: 'A', cells: Uint32Array.of(0, 1, 2) },
      groupB: { name: 'B', cells: Uint32Array.of(3, 4, 5) },
      geneList: ['Gene A'],
      minCells: 1,
    }),
    /minCells.*at least 2/i,
  );
  assert.equal(dataAccesses, 0);
});

test('DE rejects a group of fewer than 2 cells before compute initialization or gene loading', async () => {
  const { analysis, calls } = createDEBoundaryProbe();
  await assert.rejects(
    analysis.differentialExpression({
      groupA: { name: 'A', cells: Uint32Array.of(0) },
      groupB: { name: 'B', cells: Uint32Array.of(2, 3, 4) },
      geneList: ['Gene A'],
      minCells: 2,
    }),
    /at least 2 cells in each group/i,
  );
  assert.equal(calls.computeManager, 0);
  assert.equal(calls.expressionRead, 0);
});

test('DE rejects overlapping groups exactly, before any read', async () => {
  const { analysis, calls } = createDEBoundaryProbe();
  await assert.rejects(
    analysis.differentialExpression({
      groupA: { name: 'A', cells: Uint32Array.of(0, 1, 2) },
      groupB: { name: 'B', cells: Uint32Array.of(2, 3, 4) },
      geneList: ['Gene A'],
      minCells: 2,
    }),
    /groups must be disjoint.*overlap/i,
  );
  assert.equal(calls.computeManager, 0);
  assert.equal(calls.expressionRead, 0);
});

test('DE runs complementary groups, a group under the minimum flagged low n', async () => {
  const { analysis, calls, computeProbe } = createDEBoundaryProbe();
  await assert.rejects(
    analysis.differentialExpression({
      groupA: { name: 'A', cells: Uint32Array.of(0, 1, 2) },
      groupB: { name: 'B', cells: Uint32Array.of(3, 4, 5) },
      geneList: ['Gene A'],
      minCells: 10,
    }),
    error => error === computeProbe,
  );
  assert.equal(calls.computeManager, 1);
  assert.equal(calls.expressionRead, 0);
});

function validDEResult(overrides = {}) {
  return {
    meanA: 2,
    meanB: 5,
    log2FoldChange: -1,
    pValue: 0.25,
    statistic: 3,
    nA: 3,
    nB: 3,
    method: 'wilcox',
    ...overrides,
  };
}

function createDEExecutionHarness(computeResult, genes = ['Gene A']) {
  const calls = {
    compute: 0,
    expressionReads: [],
    cleanup: 0,
  };
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    state: { pointCount: 6 },
    resolveExpressionMatrix: () => ({ matrix: 'X', read: null, label: 'Mapped (X)' }),
    async getGeneKeys() { return this.getAvailableVariables('gene_expression').map(gene => gene.key); },
    getAvailableVariables() {
      return genes.map(key => ({ key, name: key }));
    },
    async readGeneColumn(gene) {
      calls.expressionReads.push(gene);
      return {
        fieldIndex: 0,
        values: Float32Array.of(1, 2, 3, 4, 5, 6),
        owned: true,
      };
    },
    performCacheCleanup() {
      calls.cleanup += 1;
      return { cleaned: 0, remaining: 0 };
    },
  };
  analysis._getComputeManager = async () => ({
    selectBackend() {
      return 'cpu';
    },
    // The run's two groups are held once on the compute thread.
    async broadcast() {
      return [{ sizeA: 3, sizeB: 3 }];
    },
    async execute() {
      calls.compute += 1;
      return computeResult;
    },
  });
  return { analysis, calls };
}

for (const malformedCase of [
  {
    label: 'a null result',
    result: null,
    error: /invalid sample counts/i,
  },
  {
    label: 'negative p-value',
    result: validDEResult({ pValue: -0.01 }),
    error: /invalid statistics/i,
  },
  {
    label: 'p-value above one',
    result: validDEResult({ pValue: 1.01 }),
    error: /invalid statistics/i,
  },
  {
    label: 'noninteger sample count',
    result: validDEResult({ nA: 2.5 }),
    error: /invalid sample counts/i,
  },
  {
    label: 'negative sample count',
    result: validDEResult({ nA: -1 }),
    error: /invalid sample counts/i,
  },
  {
    label: 'sample count larger than its dispatched group',
    result: validDEResult({ nB: 4 }),
    error: /invalid sample counts/i,
  },
]) {
  test(`DE rejects qualified backend output with ${malformedCase.label}`, async () => {
    const { analysis, calls } = createDEExecutionHarness(
      malformedCase.result,
    );

    await assert.rejects(
      analysis.differentialExpression({
        groupA: { name: 'A', cells: Uint32Array.of(0, 1, 2) },
        groupB: { name: 'B', cells: Uint32Array.of(3, 4, 5) },
        geneList: ['Gene A'],
        minCells: 2,
      }),
      malformedCase.error,
    );
    assert.deepEqual(calls.expressionReads, ['Gene A']);
    assert.equal(calls.compute, 1);
    assert.equal(calls.cleanup, 1);
  });
}

test('successful DE performs only expiry cleanup after heavy compute', async t => {
  const manager = getDataSourceManager();
  const previousSource = manager.activeSource;
  let sourceClears = 0;
  manager.activeSource = {
    clearCaches() {
      sourceClears += 1;
    },
  };
  t.after(() => {
    manager.activeSource = previousSource;
  });

  const { analysis, calls } = createDEExecutionHarness(validDEResult());
  const result = await analysis.differentialExpression({
    groupA: { name: 'A', cells: Uint32Array.of(0, 1, 2) },
    groupB: { name: 'B', cells: Uint32Array.of(3, 4, 5) },
    geneList: ['Gene A'],
    minCells: 2,
  });

  assert.equal(result.results.length, 1);
  assert.equal(calls.cleanup, 1);
  assert.equal(sourceClears, 0);
});

test('DE invalidation aborts streaming, dispatches no later gene, drains compute, and suppresses publication', async t => {
  const manager = getDataSourceManager();
  const previousSource = manager.activeSource;
  const computeGate = deferred();
  const computeStarted = deferred();
  const progress = [];
  const startedGenes = [];
  let cleanup = null;
  let current = true;
  let progressCountAtInvalidation = null;
  let cleanupCalls = 0;
  let sourceClearCalls = 0;
  let executeCalls = 0;
  let runSettled = false;
  manager.activeSource = {
    clearCaches() {
      sourceClearCalls += 1;
    },
  };
  t.after(() => {
    manager.activeSource = previousSource;
  });

  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    state: { pointCount: 6 },
    resolveExpressionMatrix: () => ({ matrix: 'X', read: null, label: 'Mapped (X)' }),
    async getGeneKeys() { return this.getAvailableVariables('gene_expression').map(gene => gene.key); },
    getAvailableVariables() {
      return ['Gene A', 'Gene B', 'Gene C'].map(key => ({ key, name: key }));
    },
    async readGeneColumn(gene) {
      startedGenes.push(gene);
      return {
        fieldIndex: 0,
        values: Float32Array.of(1, 2, 3, 4, 5, 6),
        owned: true,
      };
    },
    performCacheCleanup() {
      cleanupCalls += 1;
      return { cleaned: 0, remaining: 0 };
    },
  };
  analysis._getComputeManager = async () => ({
    selectBackend() {
      return 'cpu';
    },
    // The run's two groups are held once on the compute thread.
    async broadcast() {
      return [{ sizeA: 3, sizeB: 3 }];
    },
    execute() {
      executeCalls += 1;
      assert.equal(executeCalls, 1, 'invalidation must prevent later dispatch');
      current = false;
      assert.equal(typeof cleanup, 'function');
      cleanup();
      progressCountAtInvalidation = progress.length;
      computeStarted.resolve();
      return computeGate.promise;
    },
  });

  const run = analysis.differentialExpression({
    groupA: { name: 'A', cells: Uint32Array.of(0, 1, 2) },
    groupB: { name: 'B', cells: Uint32Array.of(3, 4, 5) },
    geneList: ['Gene A', 'Gene B', 'Gene C'],
    minCells: 2,
    onProgress(update) {
      progress.push(update);
    },
    isCurrent: () => current,
    registerInvalidationCleanup(registeredCleanup) {
      cleanup = registeredCleanup;
    },
  });
  void run.then(
    () => {
      runSettled = true;
    },
    () => {
      runSettled = true;
    },
  );

  await computeStarted.promise;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    runSettled,
    false,
    'the stale request must drain its already-dispatched compute task',
  );

  computeGate.resolve(validDEResult());
  const outcome = await run;

  assert.equal(outcome, null);
  assert.equal(runSettled, true);
  // Genes read ahead (the run's tuner) are dropped, never tested.
  assert.equal(startedGenes[0], 'Gene A');
  assert.equal(executeCalls, 1);
  assert.equal(progress.length, progressCountAtInvalidation);
  assert.equal(cleanupCalls, 1);
  assert.equal(sourceClearCalls, 0);
});

test('current and stale signature completion perform expiry cleanup without global cache clearing', async t => {
  const manager = getDataSourceManager();
  const previousSource = manager.activeSource;
  let sourceClears = 0;
  manager.activeSource = {
    clearCaches() {
      sourceClears += 1;
    },
  };
  t.after(() => {
    manager.activeSource = previousSource;
  });

  let expiryCleanups = 0;
  const gates = [];
  const dataLayer = {
    state: { pointCount: 3 },
    readGeneColumns(_genes) {
      if (gates.length === 0) {
        return Promise.resolve([Float32Array.of(1, 2, 3)]);
      }
      return gates.shift().promise;
    },
    getPageCells(pageIds) {
      return pageIds.map(pageId => ({ pageId, pageName: pageId, cellIndices: Uint32Array.of(0, 1, 2) }));
    },
    performCacheCleanup() {
      expiryCleanups += 1;
      return { cleaned: 0, remaining: 0 };
    },
  };
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = dataLayer;

  const currentResult = await analysis.computeSignatureScore({
    geneSets: [{ name: 'S', genes: ['Gene A'] }],
    pageIds: ['page-A'],
  });
  assert.equal(currentResult.sets[0].pages.length, 1);

  const staleGate = deferred();
  gates.push(staleGate);
  let current = true;
  let invalidate = null;
  const staleRun = analysis.computeSignatureScore({
    geneSets: [{ name: 'S', genes: ['Gene A'] }],
    pageIds: ['page-A'],
    isCurrent: () => current,
    registerInvalidationCleanup(cleanup) {
      invalidate = cleanup;
    },
  });
  await waitFor(() => gates.length === 0, 'the stale run to read its genes');
  current = false;
  staleGate.resolve([Float32Array.of(1, 2, 3)]);
  assert.equal(await staleRun, null);

  assert.equal(expiryCleanups, 2);
  assert.equal(sourceClears, 0);
  assert.equal(invalidate, null, 'the run keeps no notification of its own to clean up');
});
