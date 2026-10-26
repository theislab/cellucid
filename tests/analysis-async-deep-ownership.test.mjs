import assert from 'node:assert/strict';
import test from 'node:test';

import { DataLayer } from '../assets/js/app/analysis/data/data-layer.js';
import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';
import { CancellableJob } from '../assets/js/app/jobs/cancellable-job.js';

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

/** A job as an analysis UI starts one, without a notification center or log. */
function quietJob(title) {
  return new CancellableJob({
    title,
    readKind: 'analysis',
    notifyAfterMs: Infinity,
    notifications: { error() {}, dismiss() {} },
    log: { subscribe: () => () => {} },
  });
}

/** A read that stops when its signal aborts, as the data layer's do. */
function readUntilAborted(signal, reads) {
  reads.push(signal);
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('a cancelled correlation job stops its reads and the run publishes nothing', async () => {
  const reads = [];
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    getDataForPages(options) {
      return readUntilAborted(options.signal, reads);
    },
  };
  analysis._computeManager = null;

  let current = true;
  const job = quietJob('Correlation');
  const run = analysis.correlationAnalysis({
    varX: { type: 'continuous_obs', key: 'x' },
    varY: { type: 'continuous_obs', key: 'y' },
    pageIds: ['page-A'],
    job,
    isCurrent: () => current,
    registerInvalidationCleanup() {},
  });

  await waitFor(() => reads.length === 2, 'both variables to be read');
  assert.ok(reads.every(signal => signal === job.signal), 'the reads are the job\'s');
  assert.equal(job.stepText, 'Reading the variables');
  current = false;
  job.cancel();
  assert.equal(await run, null, 'a cancelled run settles as nothing, never as a failure');
  assert.equal(job.state, 'cancelled');
});

test('a cancelled signature job stops its gene reads and the run publishes nothing', async () => {
  const reads = [];
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    state: { pointCount: 3 },
    readGeneColumns(genes, options) {
      assert.deepEqual(genes, ['Gene A']);
      assert.equal(options.owner, job.id, 'the reads are owned by the job');
      return readUntilAborted(options.signal, reads);
    },
    getPageCells(pageIds) {
      return pageIds.map(pageId => ({ pageId, pageName: pageId, cellIndices: Uint32Array.of(0, 1, 2) }));
    },
    performCacheCleanup() {},
  };
  analysis._computeManager = null;

  let current = true;
  const job = quietJob('Gene signature score');
  const run = analysis.computeSignatureScore({
    geneSets: [{ name: 'S', genes: ['Gene A'] }],
    pageIds: ['page-A'],
    job,
    isCurrent: () => current,
    registerInvalidationCleanup() {},
  });

  await waitFor(() => reads.length === 1, 'the genes to be read');
  assert.equal(reads[0], job.signal);
  current = false;
  job.cancel();
  assert.equal(await run, null);
});

test('correlation snapshots variable records and page IDs before its first await', async () => {
  const gate = deferred();
  const requests = [];
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
    async init() {},
    async execute() {
      return {
        correlation: 1,
        pValue: 0,
        sampleSize: 3,
      };
    },
  };

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
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    state: { pointCount: 3 },
    async readGeneColumns(genes) {
      received.genes = genes;
      await gate.promise;
      return [Float32Array.of(1, 2, 3), Float32Array.of(3, 4, 5)];
    },
    getPageCells(pageIds) {
      received.pageIds = pageIds;
      return pageIds.map(pageId => ({ pageId, pageName: pageId, cellIndices: Uint32Array.of(0, 1, 2) }));
    },
    performCacheCleanup() {},
  };
  analysis._computeManager = null;

  const genes = ['Gene A', 'Gene B'];
  const pageIds = ['page-original'];
  const geneSets = [{ name: 'S', genes }];
  const run = analysis.computeSignatureScore({
    geneSets,
    pageIds,
    method: 'mean',
  });

  genes[0] = 'Gene MUTATED';
  geneSets[0].name = 'MUTATED';
  pageIds[0] = 'page-mutated';
  gate.resolve();

  const { sets: [set] } = await run;
  const [result] = set.pages;
  assert.equal(set.name, 'S');

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
    resolveExpressionMatrix: () => ({ matrix: 'X', read: null, label: 'Mapped (X)' }),
    async getGeneKeys() { return this.getAvailableVariables('gene_expression').map(gene => gene.key); },
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

test('DE rejects overlapping explicit memberships before gene expression or worker access', async () => {
  const { analysis, calls } = createDEMembershipProbe({
    'page-A': Uint32Array.of(0, 1, 2),
    'page-B': Uint32Array.of(2, 3, 4),
  });

  const error = await analysis.differentialExpression({
    groupA: { name: 'A', cells: Uint32Array.of(0, 1, 2) },
    groupB: { name: 'B', cells: Uint32Array.of(2, 3, 4) },
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

test('DE accepts a group versus its exact complement', async () => {
  const { analysis, calls, computeProbe } = createDEMembershipProbe({});

  await assert.rejects(
    analysis.differentialExpression({
      groupA: { name: 'A', cells: Uint32Array.of(0, 1, 2) },
      groupB: { name: 'Rest of A', cells: Uint32Array.of(3, 4, 5) },
      geneList: ['Gene A'],
      method: 'wilcox',
      minCells: 2,
    }),
    error => error === computeProbe,
  );
  assert.equal(calls.expressionRead, 0);
  assert.equal(calls.computeManager, 1);
});

