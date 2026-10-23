import assert from 'node:assert/strict';
import test from 'node:test';

import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';
import { createRestOfPageId } from '../assets/js/app/analysis/shared/page-derivation-utils.js';
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
        pageA: 'page-A',
        pageB: 'page-B',
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
        genes: ['Gene A'],
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

function createDEBoundaryProbe(indicesByPage, pointCount = 6) {
  const calls = {
    computeManager: 0,
    expressionRead: 0,
  };
  const computeProbe = new Error('compute manager reached');
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    state: { pointCount },
    getAvailableVariables() {
      return [{ key: 'Gene A', name: 'Gene A' }];
    },
    getPageInfo(pageId) {
      return { id: pageId, name: `Page ${pageId}` };
    },
    getCellIndicesForPage(pageId) {
      return indicesByPage[pageId];
    },
    // A local source: nothing is downloaded ahead.
    async prefetchGenePayload() {
      return null;
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
      pageA: 'page-A',
      pageB: 'page-B',
      geneList: ['Gene A'],
      minCells: 1,
    }),
    /minCells.*at least 2/i,
  );
  assert.equal(dataAccesses, 0);
});

test('DE rejects an undersized group before compute initialization or gene loading', async () => {
  const { analysis, calls } = createDEBoundaryProbe({
    'page-A': Uint32Array.of(0),
    'page-B': Uint32Array.of(2, 3, 4),
  });

  await assert.rejects(
    analysis.differentialExpression({
      pageA: 'page-A',
      pageB: 'page-B',
      geneList: ['Gene A'],
      minCells: 2,
    }),
    /at least 2 cells per group.*received 1 and 3/i,
  );
  assert.equal(calls.computeManager, 0);
  assert.equal(calls.expressionRead, 0);
});

const explicitA = 'page-explicit-A';
const explicitB = 'page-explicit-B';
const baseA = 'page-base-A';
const baseB = 'page-base-B';
const restA = createRestOfPageId(baseA);
const restB = createRestOfPageId(baseB);

for (const overlapCase of [
  {
    label: 'explicit versus explicit',
    pageA: explicitA,
    pageB: explicitB,
    memberships: {
      [explicitA]: Uint32Array.of(0, 1, 2),
      [explicitB]: Uint32Array.of(2, 3, 4),
    },
  },
  {
    label: 'explicit versus rest-of',
    pageA: explicitA,
    pageB: restB,
    memberships: {
      [explicitA]: Uint32Array.of(0, 1),
      [baseB]: Uint32Array.of(0, 2, 3),
    },
  },
  {
    label: 'rest-of versus explicit',
    pageA: restA,
    pageB: explicitB,
    memberships: {
      [baseA]: Uint32Array.of(0, 2, 3),
      [explicitB]: Uint32Array.of(1, 4),
    },
  },
  {
    label: 'rest-of versus rest-of',
    pageA: restA,
    pageB: restB,
    memberships: {
      [baseA]: Uint32Array.of(0, 1, 2),
      [baseB]: Uint32Array.of(2, 3, 4),
    },
  },
]) {
  test(`DE rejects overlapping ${overlapCase.label} membership exactly`, async () => {
    const { analysis, calls } = createDEBoundaryProbe(
      overlapCase.memberships,
    );

    await assert.rejects(
      analysis.differentialExpression({
        pageA: overlapCase.pageA,
        pageB: overlapCase.pageB,
        geneList: ['Gene A'],
        minCells: 2,
      }),
      /groups must be disjoint.*overlap/i,
    );
    assert.equal(calls.computeManager, 0);
    assert.equal(calls.expressionRead, 0);
  });
}

for (const disjointCase of [
  {
    label: 'a page and its own rest-of',
    pageA: baseA,
    pageB: restA,
    memberships: {
      [baseA]: Uint32Array.of(0, 1, 2),
    },
  },
  {
    label: 'an explicit subset of a rest-of exclusion',
    pageA: explicitA,
    pageB: restB,
    memberships: {
      [explicitA]: Uint32Array.of(0, 1),
      [baseB]: Uint32Array.of(0, 1, 2, 3),
    },
  },
  {
    label: 'complementary rest-of groups',
    pageA: restA,
    pageB: restB,
    memberships: {
      [baseA]: Uint32Array.of(0, 1, 2),
      [baseB]: Uint32Array.of(3, 4, 5),
    },
  },
]) {
  test(`DE preserves disjoint ${disjointCase.label}`, async () => {
    const { analysis, calls, computeProbe } = createDEBoundaryProbe(
      disjointCase.memberships,
    );

    await assert.rejects(
      analysis.differentialExpression({
        pageA: disjointCase.pageA,
        pageB: disjointCase.pageB,
        geneList: ['Gene A'],
        minCells: 2,
      }),
      error => error === computeProbe,
    );
    assert.equal(calls.computeManager, 1);
    assert.equal(calls.expressionRead, 0);
  });
}

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
    getAvailableVariables() {
      return genes.map(key => ({ key, name: key }));
    },
    getPageInfo(pageId) {
      return { id: pageId, name: `Page ${pageId}` };
    },
    getCellIndicesForPage(pageId) {
      return pageId === 'page-A'
        ? Uint32Array.of(0, 1, 2)
        : Uint32Array.of(3, 4, 5);
    },
    // A local source: nothing is downloaded ahead.
    async prefetchGenePayload() {
      return null;
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
    label: 'nonfinite meanA',
    result: validDEResult({ meanA: NaN }),
    error: /invalid statistics/i,
  },
  {
    label: 'nonfinite meanB',
    result: validDEResult({ meanB: Infinity }),
    error: /invalid statistics/i,
  },
  {
    label: 'nonfinite fold change',
    result: validDEResult({ log2FoldChange: NaN }),
    error: /invalid statistics/i,
  },
  {
    label: 'nonfinite test statistic',
    result: validDEResult({ statistic: -Infinity }),
    error: /invalid statistics/i,
  },
  {
    label: 'a missing test statistic',
    result: validDEResult({ statistic: undefined }),
    error: /invalid statistics/i,
  },
  {
    label: 'nonfinite p-value',
    result: validDEResult({ pValue: NaN }),
    error: /invalid statistics/i,
  },
  {
    label: 'wrong method',
    result: validDEResult({ method: 'ttest' }),
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
        pageA: 'page-A',
        pageB: 'page-B',
        geneList: ['Gene A'],
        minCells: 2,
        parallelism: 1,
        batchConfig: {
          preloadCount: 1,
          memoryBudgetMB: 1,
          networkConcurrency: 1,
        },
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
    pageA: 'page-A',
    pageB: 'page-B',
    geneList: ['Gene A'],
    minCells: 2,
    parallelism: 1,
    batchConfig: {
      preloadCount: 1,
      memoryBudgetMB: 1,
      networkConcurrency: 1,
    },
  });

  assert.equal(result.results.length, 1);
  assert.equal(calls.cleanup, 1);
  assert.equal(sourceClears, 0);
});

test('DE invalidation aborts streaming, starts no later gene, drains compute, and suppresses publication', async t => {
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
    getAvailableVariables() {
      return ['Gene A', 'Gene B', 'Gene C'].map(key => ({ key, name: key }));
    },
    getPageInfo(pageId) {
      return { id: pageId, name: `Page ${pageId}` };
    },
    getCellIndicesForPage(pageId) {
      return pageId === 'page-A'
        ? Uint32Array.of(0, 1, 2)
        : Uint32Array.of(3, 4, 5);
    },
    // A local source: nothing is downloaded ahead.
    async prefetchGenePayload() {
      return null;
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
    pageA: 'page-A',
    pageB: 'page-B',
    geneList: ['Gene A', 'Gene B', 'Gene C'],
    minCells: 2,
    parallelism: 1,
    batchConfig: {
      preloadCount: 1,
      memoryBudgetMB: 1,
      networkConcurrency: 1,
    },
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
  assert.deepEqual(startedGenes, ['Gene A']);
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
    genes: ['Gene A'],
    pageIds: ['page-A'],
  });
  assert.equal(currentResult.length, 1);

  const staleGate = deferred();
  gates.push(staleGate);
  let current = true;
  let invalidate = null;
  const staleRun = analysis.computeSignatureScore({
    genes: ['Gene A'],
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
