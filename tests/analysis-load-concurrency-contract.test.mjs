/**
 * Analysis loads must not be serialised.
 *
 * Every field or gene read can be its own request, so the number that decides
 * how long an analysis waits is not how many requests it makes but how many of
 * them it makes *in sequence*. Two loaders used to await each unit before
 * starting the next:
 *
 *  - `fetchBulkObsFields` awaited one observation field at a time. Quick
 *    Insights asks for four fields on first open, which the categorical
 *    outlier masks turn into six requests; measured in Chromium at 150 ms
 *    emulated latency that was six strictly serial round trips spanning
 *    2.07 s with never more than one request in flight.
 *  - gene loading for a signature ran fixed batches of ten with a macrotask
 *    barrier between them, so a 60-gene signature cost six sequential waves
 *    however fast the link was. `readGeneColumns` asks for every gene at
 *    once; the reader's fetch scheduler paces the requests.
 *
 * These tests pin the shape rather than the clock: they count how many loads
 * are open at once, which is load-invariant and reproduces identically on a
 * busy machine.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DataLayer } from '../assets/js/app/analysis/data/data-layer.js';

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

test('every gene column is asked for at once and published in requested order', async () => {
  const gate = concurrencyRecorder();
  const layer = pageOnlyLayer();
  const geneKeys = Array.from(
    { length: 23 },
    (_unused, index) => `Gene ${String(index).padStart(3, '0')}`,
  );
  layer.readGeneColumn = async geneKey => {
    await gate.enter(geneKey);
    return { fieldIndex: 0, values: Float32Array.of(geneKeys.indexOf(geneKey)), owned: true };
  };

  const run = layer.readGeneColumns(geneKeys);

  await settle();
  assert.equal(
    gate.record.peak,
    geneKeys.length,
    'no gene waits on another gene; the reader paces the requests',
  );

  while (gate.waiting > 0) {
    gate.releaseAll();
    await settle(2);
  }
  const columns = await run;
  assert.deepEqual(
    columns.map(column => column[0]),
    geneKeys.map((_key, index) => index),
    'columns must be published in requested order, not completion order',
  );
});

test('an invalidated gene-column read aborts the reads in flight', async () => {
  const layer = pageOnlyLayer();
  const signals = [];
  layer.readGeneColumn = (_geneKey, { signal }) => new Promise((_resolve, reject) => {
    signals.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  let current = true;
  let invalidate = null;
  const run = layer.readGeneColumns(['A', 'B'], {
    isCurrent: () => current,
    registerInvalidationCleanup: cleanup => { invalidate = cleanup; },
  });
  await settle();
  assert.equal(signals.length, 2);
  current = false;
  invalidate();
  await assert.rejects(run, error => error.code === 'ANALYSIS_DATA_REQUEST_INVALIDATED');
  assert.ok(signals.every(signal => signal.aborted));
});

test('a page fetch reads the exact membership its cache key was built from', async () => {
  // The digest that becomes the cache key and the values that go under it used
  // to be two separate traversals with an `await` between them, so a
  // membership change in that window was cached under a version it no longer
  // matched. They now share one snapshot.
  const layer = Object.create(DataLayer.prototype);
  const page = {
    id: 'page-1',
    name: 'Page 1',
    highlightedGroups: [{ id: 'group-1', enabled: true, cellIndices: [0, 1] }],
  };
  layer.state = {
    pointCount: 3,
    obsData: {
      fields: [{
        kind: 'continuous',
        loaded: false,
        values: Float32Array.of(10, 20, 30),
      }],
    },
    async ensureFieldLoaded() {
      // The membership changes while the field download is in flight.
      page.highlightedGroups[0].cellIndices = [0, 1, 2];
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
  layer._pageMemberships = new Map();
  layer._dataCache = null;
  layer._pendingRequests = null;
  layer.getPages = () => [page];
  layer.getPageInfo = () => ({ id: 'page-1', name: 'Page 1' });
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
