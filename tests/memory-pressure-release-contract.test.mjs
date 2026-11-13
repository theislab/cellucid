/**
 * What every cache gives back, and when (the memory model,
 * `data/memory-budget.js`): each is a holder of one share, counted where it
 * is held and trimmed there, without stopping or failing work.
 *
 * - The adapter's cached copies (obs payloads, coordinates, the neighbor
 *   graph) share one `adapterCache` budget; a continuous column handed to
 *   its caller is not kept as well (one owner); a graph a view draws is
 *   working set, never a cached copy, and never evicted.
 * - The reader's gene indexes and the row pointers they are built from
 *   count in `columnIndex`, and go with them (and with `clearCache`).
 * - Trimmed, nothing in flight is invalidated: a read finishes and is
 *   delivered; pinned coordinates stay.
 * - A refusal's release is said once, naming what went (`app/page-memory.js`).
 * - Invalidating a dataset's caches (another source shown, the dataset
 *   closed) stops its reads in flight as cancellations, never failures.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import {
  memoryReport,
  recordAllocationFailure,
  registerResidentHolder,
  releaseResidentMemory,
  resetMemoryModel,
  setWorkingSet,
  typedArrayBytes,
} from '../assets/js/data/memory-budget.js';
import { initPageMemory } from '../assets/js/app/page-memory.js';
import { createByteRangeCache } from '../assets/js/data/byte-range-cache.js';
import { isCancellation } from '../assets/js/utils/abort.js';

/** An adapter with nothing behind it but its caches and in-flight registries. */
function bareAdapter(budget = 1n << 40n) {
  const adapter = Object.create(BaseAnnDataAdapter.prototype);
  Object.assign(adapter, {
    _closed: false,
    _lifecycleGeneration: 0,
    _cacheBudgetBytes: budget,
    _embeddingInFlight: new Map(),
    _obsFieldDataInFlight: new Map(),
    _vectorFieldInFlight: new Map(),
    _connectivityInFlight: new Map(),
    _geneExpressionInFlight: new Map(),
    _latentOutlierInFlight: new Map(),
    _geneNamesByRoute: new Map(),
    _embeddingCache: new Map(),
    _vectorFieldCache: new Map(),
    _obsFieldDataCache: new Map(),
    _obsFieldDataCacheBytes: 0n,
    _connectivityCache: new Map(),
    _embeddingInfo: new Map(),
    _vectorInfo: new Map(),
    _coordinateCacheLru: new Map(),
    _coordinateBufferRefs: new Map(),
    _coordinateCachePins: new Map(),
    _coordinateCacheBytes: 0n,
    _unregisterResidentHolder: () => {},
  });
  return adapter;
}

test.beforeEach(() => resetMemoryModel());
test.after(() => resetMemoryModel());

test('the adapter\'s cached copies share one budget, trim without invalidating, and keep pinned coordinates and work in flight', async () => {
  const adapter = bareAdapter();
  adapter._cacheObsFieldData('cluster', { values: new Float32Array(10) });
  adapter._cacheObsFieldData('score', { values: new Float32Array(10) });
  adapter._retainCoordinateCacheEntry({ cacheKey: 'e1', kind: 'embedding', embeddingId: 'X_umap', value: new Float32Array(20), label: 'X_umap' });
  adapter._retainCoordinateCacheEntry({ cacheKey: 'e2', kind: 'embedding', embeddingId: 'X_pca', value: new Float32Array(20), label: 'X_pca' });
  const unpin = adapter._pinCoordinateCacheKey('e2');
  const graph = Object.freeze({ nEdges: 3, records: new Uint8Array(36), neighbors: new Uint32Array(6) });
  adapter._connectivityCache.set('connectivities', graph);
  assert.equal(adapter._cachedBytes(), 80n + 160n + 60n, 'every kind counted against one budget');

  // A read in flight across the release finishes and is delivered.
  let finish;
  const read = adapter._coalesceInFlight(adapter._geneExpressionInFlight, 'CD3E', 0, () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  const released = adapter.releaseCachedCopies();
  assert.deepEqual(released, ['cached copies of 2 fields', 'cached copies of 1 embedding', 'a cached copy of the neighbor graph']);
  assert.equal(adapter._obsFieldDataCache.size, 0);
  assert.equal(adapter._obsFieldDataCacheBytes, 0n);
  assert.deepEqual([...adapter._coordinateCacheLru.keys()], ['e2'], 'the pinned embedding stays');
  assert.equal(adapter._embeddingCache.get('X_pca')?.length, 20);
  assert.equal(adapter._lifecycleGeneration, 0, 'nothing is invalidated');
  finish('values');
  assert.equal(await read, 'values');
  unpin();
});

test('a neighbour graph a view draws is working set: not counted as a cached copy, never evicted; let go, it is a cached copy again', () => {
  const adapter = bareAdapter(100n);
  const graph = Object.freeze({ nEdges: 3, records: new Uint8Array(400), neighbors: new Uint32Array(100) });
  adapter._connectivityCache.set('connectivities', graph);
  setWorkingSet('graph', typedArrayBytes(graph), graph);
  assert.equal(adapter._cachedGraphBytes(), 0n);
  assert.deepEqual(adapter._trimCaches(0n), [], 'drawn: never evicted');
  assert.equal(adapter._connectivityCache.size, 1);
  // Edges off and the k-NN tool left: no longer drawn.
  setWorkingSet('graph', 0);
  assert.equal(adapter._cachedGraphBytes(), 800n);
  // Kept within the one budget with every other cached copy.
  adapter._retainConnectivity('connectivities', graph);
  assert.equal(adapter._connectivityCache.size, 0, 'larger than the whole budget: not kept');
});

test('a reader\'s gene indexes and the CSR row pointers they are built from count in one share, and go with them', () => {
  const reader = Object.create(AnnDataReader.prototype);
  let retired = 0;
  const columns = bytes => ({ residentBytes: () => bytes, built: () => true, retire: () => { retired++; } });
  Object.assign(reader, {
    _generation: 0,
    _cache: new Map(),
    _decodedChunks: null,
    _carried: new Map(),
    _matrices: new Map([['X', { element: 'X', columns: columns(1000), load: null }], ['raw/X', { element: 'raw/X', columns: columns(500), load: null }]]),
    _indptrs: new Map([['/X', new Float64Array(101)]]),
    // A gene sample's first stored pointers (`_storedRowPointers`).
    _indptrPrefixes: new Map([['/raw/X', new Float64Array(11)]]),
    _knownRowPointers: new Map(),
    _keptRuns: new Map(),
    _storeOrdered: new Map(),
    _restricted: new Map(),
    _releaseRows() {},
  });
  assert.equal(reader.residentBytes(), 1000 + 500 + 808 + 88);
  // Trimmed: the row pointers first (one array to read again), then the
  // indexes least recently read first; the one read last stays above 0.
  assert.deepEqual(reader.trimResident(1500), ['row pointers']);
  assert.equal(reader.residentBytes(), 1500);
  assert.deepEqual(reader.trimResident(600), ['a gene index']);
  assert.deepEqual([...reader._matrices.keys()], ['raw/X']);
  assert.deepEqual(reader.trimResident(0), ['a gene index']);
  assert.equal(retired, 2);
  // `clearCache` drops the row pointers with the indexes.
  reader._indptrs.set('/layers/counts', new Float64Array(11));
  reader._indptrPrefixes.set('/X', new Float64Array(5));
  reader.clearCache();
  assert.equal(reader._indptrs.size, 0);
  assert.equal(reader._indptrPrefixes.size, 0);
  assert.equal(reader.residentBytes(), 0);
});

test('the page\'s fetched ranges follow their share as it changes, and are trimmed least recently used first', () => {
  let budget = 300;
  const ranges = createByteRangeCache({ budgetBytes: () => budget });
  ranges.keep('a', 0, new Uint8Array(100));
  ranges.keep('a', 200, new Uint8Array(100));
  ranges.keep('b', 0, new Uint8Array(100));
  assert.equal(ranges.stats().bytes, 300);
  budget = 150;
  ranges.keep('b', 500, new Uint8Array(100));
  assert.equal(ranges.stats().bytes, 100, 'kept within the share as it is now');
  assert.equal(ranges.trim(0), 'fetched bytes of remote files');
  assert.equal(ranges.stats().bytes, 0);
  assert.equal(ranges.trim(0), null);
});

test('a refused allocation says once, in one notice, what every cache let go', () => {
  const shown = [];
  const notifications = {
    present: new Set(),
    hasNotification(id) { return this.present.has(id); },
    show(notice) { this.present.add(notice.id); shown.push(notice); },
  };
  const documentOwner = new EventTarget();
  documentOwner.visibilityState = 'visible';
  const stop = initPageMemory({ notifications, documentOwner, windowOwner: new EventTarget() });
  const kept = [1, 2, 3];
  registerResidentHolder('analysisPages', {
    label: 'page values',
    bytes: () => kept.length * 2 ** 30,
    trim: budget => {
      if (kept.length * 2 ** 30 <= budget) return null;
      kept.length = 0;
      return 'values read for analysis pages';
    },
  });
  recordAllocationFailure(2 ** 20);
  assert.equal(shown.length, 1);
  assert.equal(
    shown[0].message,
    'Memory was running short, so Cellucid let go of values read for analysis pages. They are read again when needed.'
  );
  stop();
});

test('a hidden page gives back every cache but the gene index; a frozen one, the gene index too', () => {
  const documentOwner = new EventTarget();
  const windowOwner = new EventTarget();
  documentOwner.visibilityState = 'visible';
  const stop = initPageMemory({ notifications: { hasNotification: () => false, show() {} }, documentOwner, windowOwner });
  const kept = { adapterCache: 1, columnIndex: 1, undoHistory: 1 };
  for (const share of Object.keys(kept)) {
    registerResidentHolder(share, {
      label: share,
      bytes: () => kept[share],
      trim: budget => { if (kept[share] > budget) kept[share] = 0; return null; },
    });
  }
  documentOwner.visibilityState = 'hidden';
  documentOwner.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(kept, { adapterCache: 0, columnIndex: 1, undoHistory: 1 });
  documentOwner.dispatchEvent(new Event('freeze'));
  assert.deepEqual(kept, { adapterCache: 0, columnIndex: 0, undoHistory: 1 }, 'the person\'s undo steps stay');
  stop();
  assert.equal(memoryReport().instances, 1);
});

test('clearing a dataset\'s caches stops its reads in flight as cancellations', async () => {
  const adapter = bareAdapter();
  let workSignal = null;
  const read = adapter._coalesceInFlight(adapter._obsFieldDataInFlight, 'cluster', 0, signal => {
    workSignal = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  });
  await Promise.resolve();
  await Promise.resolve();
  adapter.clearCaches();
  assert.equal(workSignal.aborted, true, 'the read stops at once instead of downloading for nobody');
  const error = await read.then(() => null, caught => caught);
  assert.ok(isCancellation(error), `a cancellation, not a failure: ${error}`);
  // A read that ignores its signal is told the same when it returns.
  assert.throws(() => adapter._assertLifecycleGeneration(0), error => isCancellation(error));
});

test('a reader read outlived by its generation is a cancellation', () => {
  const reader = Object.create(AnnDataReader.prototype);
  reader._closed = false;
  reader._generation = 2;
  reader._format = { file: 'H5AD' };
  assert.throws(() => reader._assertGeneration(1, 'loading gene column 3 of X'), error => (
    isCancellation(error) && /the request was superseded/.test(error.message)
  ));
});

test('the read cache release levels reach every holder registered on the page', () => {
  let trimmedTo = null;
  registerResidentHolder('latentHold', { label: 'latent', bytes: () => 10, trim: budget => { trimmedTo = budget; return null; } });
  releaseResidentMemory('caches', 'hidden');
  assert.equal(trimmedTo, 0);
});

test('the state\'s open cells are the working set; its inactive field data and unshown layouts are counted and trimmed', async () => {
  const { createDataState } = await import('../assets/js/app/state/index.js');
  const state = createDataState({ viewer: {}, labelLayer: null });
  const holders = memoryReport().holders;
  assert.ok(holders >= 2, 'inactive fields and unshown layouts are holders');
  state.pointCount = 1000;
  assert.equal(memoryReport().workingSet.cells, 1000 * 77, 'what is drawn: 77 bytes a cell');
  // An inactive field's arrays are counted, and trimmed to nothing.
  const values = new Float32Array(1000);
  state.obsData = { fields: [{ key: 'score', kind: 'continuous', loaded: true, values }] };
  state._fieldDataCache.set('score', { values });
  state.activeFieldSource = 'obs';
  state.activeFieldIndex = -1;
  assert.equal(memoryReport().shares.inactiveFields.heldBytes, 4000);
  releaseResidentMemory('caches', 'hidden');
  assert.equal(memoryReport().shares.inactiveFields.heldBytes, 0);
  assert.equal(state.obsData.fields[0].loaded, false, 'loaded again when shown');
  state.pointCount = 0;
  assert.equal(memoryReport().workingSetBytes, 0);
});
