/**
 * Analysis loads must not be serialised.
 *
 * Every field of a prepared export is its own HTTP request, so the number that
 * decides how long an analysis waits is not how many requests it makes but how
 * many of them it makes *in sequence*. Two loaders used to await each unit
 * before starting the next:
 *
 *  - `fetchBulkObsFields` awaited one observation field at a time. Quick
 *    Insights asks for four fields on first open, which the categorical
 *    outlier masks turn into six requests; measured in Chromium at 150 ms
 *    emulated latency that was six strictly serial round trips spanning
 *    2.07 s with never more than one request in flight.
 *  - `fetchBulkGeneExpression` ran fixed batches of ten with a macrotask
 *    barrier between them, so a 60-gene signature cost six sequential waves
 *    however fast the link was.
 *
 * These tests pin the shape rather than the clock: they count how many loads
 * are open at once, which is load-invariant and reproduces identically on a
 * busy machine.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DataLayer } from '../assets/js/app/analysis/data/data-layer.js';
import { PerformanceConfig } from '../assets/js/app/analysis/shared/performance-config.js';

/** A load gate that records peak concurrency and completion order. */
function concurrencyRecorder() {
  const record = { started: [], peak: 0, open: 0 };
  const pending = [];
  return {
    record,
    /** Register one started load; returns a promise the test releases. */
    enter(key) {
      record.started.push(key);
      record.open++;
      if (record.open > record.peak) record.peak = record.open;
      return new Promise(resolve => {
        pending.push(() => {
          record.open--;
          resolve();
        });
      });
    },
    /** Release every load registered so far. */
    releaseAll() {
      while (pending.length > 0) pending.shift()();
    },
    /** Release exactly `count` of the loads registered so far. */
    release(count) {
      for (let index = 0; index < count && pending.length > 0; index++) {
        pending.shift()();
      }
    },
    get waiting() {
      return pending.length;
    },
  };
}

/** Drain microtasks *and* timers, so a scheduler that yields still advances. */
async function settle(times = 12) {
  for (let index = 0; index < times; index++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

function pageOnlyLayer() {
  const layer = Object.create(DataLayer.prototype);
  layer.state = {};
  layer._datasetGeneration = 0;
  layer._cacheGeneration = 0;
  layer._fieldLoadLifecycle = new AbortController();
  layer._destroyed = false;
  layer._notifications = null;
  layer._pageVersions = null;
  layer._pageIndexSnapshots = new Map();
  layer.getCellIndicesForPage = () => Uint32Array.of(0);
  layer.getPages = () => [{ id: 'page-1', name: 'Page 1' }];
  return layer;
}

test('observation fields are requested together, not one after another', async () => {
  const gate = concurrencyRecorder();
  const layer = pageOnlyLayer();
  const fieldKeys = ['a', 'b', 'c', 'd', 'e', 'f'];
  layer.getAvailableVariables = type => (
    type === 'continuous_obs' ? fieldKeys.map(key => ({ key })) : []
  );
  layer.ensureObsFieldLoaded = async fieldKey => {
    await gate.enter(fieldKey);
    return { fieldIndex: 0, kind: 'continuous', values: Float32Array.of(1) };
  };

  const run = layer.fetchBulkObsFields({
    pageIds: ['page-1'],
    obsFields: fieldKeys,
    subsetPages: false,
    includeCategoricalValues: false,
  });

  // Nothing has been released yet, so anything still serial would show one
  // open load; the whole set must be open instead.
  await settle();
  assert.equal(
    gate.record.peak,
    fieldKeys.length,
    'every requested observation field must be in flight at once',
  );

  gate.releaseAll();
  const result = await run;

  assert.deepEqual(
    Object.keys(result.fields),
    fieldKeys,
    'fields must be published in requested order, not completion order',
  );
  assert.equal(result.stats.fieldsLoaded, fieldKeys.length);
});

test('observation field loading never exceeds the configured concurrency', async () => {
  const gate = concurrencyRecorder();
  const layer = pageOnlyLayer();
  const window = PerformanceConfig.batch.networkConcurrency;
  const fieldKeys = Array.from(
    { length: window * 2 + 3 },
    (_unused, index) => `field-${index}`,
  );
  layer.getAvailableVariables = type => (
    type === 'continuous_obs' ? fieldKeys.map(key => ({ key })) : []
  );
  layer.ensureObsFieldLoaded = async fieldKey => {
    await gate.enter(fieldKey);
    return { fieldIndex: 0, kind: 'continuous', values: Float32Array.of(1) };
  };

  const run = layer.fetchBulkObsFields({
    pageIds: ['page-1'],
    obsFields: fieldKeys,
    subsetPages: false,
    includeCategoricalValues: false,
  });

  await settle();
  assert.equal(
    gate.record.peak,
    window,
    'the loader must fill its window and then stop',
  );

  // Draining the window must let the rest through without a barrier.
  while (gate.waiting > 0) {
    gate.releaseAll();
    await settle();
  }
  const result = await run;
  assert.deepEqual(Object.keys(result.fields), fieldKeys);
});

test('bulk gene loading keeps a full window in flight instead of fixed batches', async () => {
  const gate = concurrencyRecorder();
  const layer = pageOnlyLayer();
  const window = PerformanceConfig.batch.networkConcurrency;
  const geneKeys = Array.from(
    { length: window + 3 },
    (_unused, index) => `Gene ${String(index).padStart(3, '0')}`,
  );
  layer.refreshPageVersions = () => {};
  layer._getBulkGeneCacheKey = () => 'bulk';
  layer._getBulkGeneCache = () => null;
  layer._setBulkGeneCache = () => {};
  layer._bulkGeneCacheReplacementOwner = null;
  layer._bulkGeneCacheGeneration = 0;
  layer.getAvailableVariables = () => geneKeys.map(key => ({ key }));
  layer.getDataForPages = async request => {
    await gate.enter(request.variableKey);
    return [{
      pageId: 'page-1',
      pageName: 'Page 1',
      values: Float32Array.of(1),
      cellIndices: Uint32Array.of(0),
      cellCount: 1,
    }];
  };

  const run = layer.fetchBulkGeneExpression({
    pageIds: ['page-1'],
    geneList: geneKeys,
  });

  await settle();
  assert.equal(
    gate.record.peak,
    window,
    'the gene loader must fill its concurrency window',
  );

  // The distinguishing property: a batch loader cannot start gene 11 until the
  // whole batch of ten has finished, whereas a sliding window admits one more
  // as soon as one finishes. Releasing exactly one load must admit exactly one
  // further gene.
  gate.release(1);
  await settle();
  assert.equal(
    gate.record.started.length,
    window + 1,
    'one completed load must admit exactly one more, with no batch barrier',
  );

  for (let attempt = 0; attempt < 20 && gate.waiting > 0; attempt++) {
    gate.releaseAll();
    await settle(2);
  }
  const result = await run;
  assert.deepEqual(
    Object.keys(result),
    geneKeys,
    'genes must be published in requested order, not completion order',
  );
});

test('a partial bulk-gene cache fetches its misses together', async () => {
  const gate = concurrencyRecorder();
  const layer = pageOnlyLayer();
  const cachedGenes = ['Gene A', 'Gene B'];
  const missingGenes = ['Gene C', 'Gene D', 'Gene E', 'Gene F'];
  const cachedPages = { 'page-1': { values: Float32Array.of(9), cellCount: 1 } };

  layer.refreshPageVersions = () => {};
  layer._bulkGeneCacheMaxAge = 60_000;
  layer._getBulkGeneCacheKey = () => 'bulk';
  layer._getBulkGeneCache = () => ({
    data: Object.fromEntries(cachedGenes.map(gene => [gene, cachedPages])),
    timestamp: Date.now(),
  });
  layer.getDataForPages = async request => {
    await gate.enter(request.variableKey);
    return [{
      pageId: 'page-1',
      pageName: 'Page 1',
      values: Float32Array.of(1),
      cellIndices: Uint32Array.of(0),
      cellCount: 1,
    }];
  };

  const run = layer.getGeneExpressionSubset(
    [...cachedGenes, ...missingGenes],
    ['page-1'],
  );

  await settle();
  assert.equal(
    gate.record.peak,
    missingGenes.length,
    'every gene the cache is missing must be requested at once',
  );
  assert.deepEqual(gate.record.started, missingGenes);

  gate.releaseAll();
  const result = await run;
  assert.deepEqual(
    Object.keys(result),
    [...cachedGenes, ...missingGenes],
    'the merged result must follow the requested gene order',
  );
  for (const gene of cachedGenes) {
    assert.equal(result[gene], cachedPages, `${gene} must come from the cache`);
  }
});

test('a page fetch reads the exact membership its cache key was built from', async () => {
  // The digest that becomes the cache key and the values that go under it used
  // to be two separate traversals with an `await` between them, so a
  // membership change in that window was cached under a version it no longer
  // matched. They now share one snapshot.
  const layer = Object.create(DataLayer.prototype);
  let membership = [0, 1];
  layer.state = {
    obsData: {
      fields: [{
        kind: 'continuous',
        loaded: false,
        values: Float32Array.of(10, 20, 30),
      }],
    },
    async ensureFieldLoaded() {
      // The membership changes while the field download is in flight.
      membership = [0, 1, 2];
      layer.state.obsData.fields[0].loaded = true;
    },
  };
  layer._datasetGeneration = 0;
  layer._cacheGeneration = 0;
  layer._fieldLoadLifecycle = new AbortController();
  layer._destroyed = false;
  layer._notifications = null;
  layer._pageVersions = new Map();
  layer._pageIndexSnapshots = new Map();
  layer._dataCache = null;
  layer._pendingRequests = null;
  layer.getPages = () => [{ id: 'page-1', name: 'Page 1' }];
  layer.getPageInfo = () => ({ id: 'page-1', name: 'Page 1' });
  layer.getCellIndicesForPage = () => [...membership];
  layer.getVariableInfo = () => ({
    key: 'score',
    kind: 'continuous',
    _fieldIndex: 0,
  });

  const versionAtRequest = layer._updatePageVersion('page-1');
  const [pageData] = await layer._fetchDataForPages({
    type: 'continuous_obs',
    variableKey: 'score',
    pageIds: ['page-1'],
  });

  assert.equal(layer._pageVersions.get('page-1'), versionAtRequest);
  assert.deepEqual(
    Array.from(pageData.cellIndices),
    [0, 1],
    'the fetch must project the membership the recorded version describes',
  );
  assert.deepEqual(Array.from(pageData.values), [10, 20]);
  assert.equal(pageData.cellCount, 2);
});
