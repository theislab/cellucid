/**
 * My datasets (`assets/js/app/library/my-datasets.js`, the words of
 * `assets/js/app/ui/modules/my-datasets/model.js`): what is kept of a
 * dataset opened in this browser (its identity, name, where it opens from in
 * its public form, its storage, cells, genes, the cells it was open with,
 * when it was first and last opened and how often), recorded by the page on
 * a publication (counted) and on a reading of other cells (only updating a
 * dataset listed); read back checked, most recent first; forgotten with its
 * file's handle, its saved states only when asked; kept in the page's memory
 * where the browser gives no IndexedDB; reopened with the subsample it was
 * chosen with, else as the tab opens datasets; and how the list describes
 * each one.
 *
 * The store is a stand-in with the key-value interface
 * (`utils/indexed-db-store.js`), and one IndexedDB factory that cannot be
 * opened; the real IndexedDB runs in `tests/browser/my-datasets.spec.mjs`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIBRARY_RECORD_VERSION, RECENT_DATASETS, createLibrary, forgetMyDatasets, nextRecord, openCellsOf, readRecord,
  recordDatasetOpened, reopenRequestOf, shownDatasetFacts,
} from '../assets/js/app/library/my-datasets.js';
import { indexedDbKeyValueStore } from '../assets/js/utils/indexed-db-store.js';
import {
  setNextCellSubsetRequest, takeCellSubsetRequest, resetCellSubsetRequests, withdrawNextCellSubsetRequest,
} from '../assets/js/data/cell-subset-policy.js';
import {
  KIND_LABELS, datasetKind, describeEntryFacts, describeListStatus, describeMenuItem, describeOpenCells, describeOrigin,
  describeRowMeta, describeSavedStateLine, keptOf, latestSavedState, matchesFilter, reopenWay, savedStatesOf,
} from '../assets/js/app/ui/modules/my-datasets/model.js';

const NOW = new Date(2026, 10, 3, 15, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A key-value store over a map (`KeyValueStore`); `failing()` makes its next calls throw. */
function mapStore() {
  const map = new Map();
  let fail = null;
  const guard = () => { if (fail !== null) throw fail; };
  return {
    map,
    failing(error = new Error('The storage refused.')) { fail = error; },
    get: async key => { guard(); return map.get(key); },
    put: async (key, value) => { guard(); map.set(key, structuredClone(value)); },
    delete: async key => { guard(); map.delete(key); },
    entries: async () => { guard(); return [...map].map(([key, value]) => ({ key, value })); },
  };
}

const BLOCKS = Object.freeze({ method: 'blocks', nObs: 10_000, k: 1_000, seed: 7, blockSize: 64 });

/** An AnnData source of the dataset shown: its storage and its cells. */
function annData({ storage = null, subset = null } = {}) {
  return { describeStorage: () => storage, getCellSubset: () => subset };
}

/**
 * A data source manager showing one dataset: `sourceType`, its dataset id
 * (its identity), metadata, the source's connection (`info`, `address`) and
 * path, and its AnnData source.
 */
function manager({ sourceType, id, name = 'Lung atlas', stats = { n_cells: 10_000, n_genes: 2_000 }, info = null, address = null, path = null, data = annData() }) {
  const active = {
    getConnectionInfo: () => info,
    ...(address === null ? {} : { getAddressLocator: () => address }),
    getPath: () => path,
  };
  return {
    activeSource: active,
    getCurrentSourceType: () => sourceType,
    getCurrentDatasetId: () => id,
    getCurrentIdentityId: () => id,
    getCurrentMetadata: () => (id === null ? null : { id, name, stats }),
    getSource: type => (type === sourceType ? { getAnnDataSource: datasetId => (datasetId === id ? data : null) } : null),
  };
}

const H5AD_STORAGE = Object.freeze({
  format: 'h5ad', zarrVersion: null, layout: 'file', remote: true, url: 'https://zenodo.org/records/1/files/lung.h5ad',
  name: 'lung.h5ad', bytes: 52_428_800, conversion: null, notes: [],
});

test('what is kept of a dataset: its identity, name, where it opens from (a link in its public form), storage, cells and genes', () => {
  const link = manager({
    sourceType: 'link',
    id: 'lung-atlas',
    info: { locator: 'zenodo:1', provider: 'zenodo' },
    // The read target carried a token: kept is only that it did.
    address: 'zenodo:1?token=secret',
    data: annData({ storage: H5AD_STORAGE, subset: { nObs: 10_000, kept: new Uint32Array(1_000), spec: BLOCKS, autoFit: null } }),
  });
  const facts = shownDatasetFacts(link);
  assert.deepEqual(facts, {
    id: 'lung-atlas',
    name: 'Lung atlas',
    source: { kind: 'link', locator: 'zenodo:1', dataset: 'lung-atlas' },
    link: { provider: 'zenodo', accessLeftOut: true },
    storage: { format: 'h5ad', zarrVersion: null, layout: 'file', remote: true, name: 'lung.h5ad', host: 'zenodo.org', bytes: 52_428_800 },
    cells: 10_000,
    genes: 2_000,
    openCells: { cells: 1_000, of: 10_000, spec: { ...BLOCKS }, fitted: false },
  });
  assert.equal(JSON.stringify(facts).includes('secret'), false, 'what grants access is never kept');
  // A link whose read target is its public form left nothing out.
  assert.equal(shownDatasetFacts(manager({ sourceType: 'link', id: 'x', info: { locator: 'https://a.test/x.h5ad', provider: 'url' }, address: 'https://a.test/x.h5ad' })).link.accessLeftOut, false);

  assert.deepEqual(shownDatasetFacts(manager({ sourceType: 'local-demo', id: 'suo' })).source, { kind: 'sample', dataset: 'suo' });
  assert.equal(shownDatasetFacts(manager({ sourceType: 'local-demo', id: 'suo' })).link, null);
  assert.deepEqual(
    shownDatasetFacts(manager({ sourceType: 'remote', id: 'served', info: { url: 'http://127.0.0.1:8765' } })).source,
    { kind: 'remote', url: 'http://127.0.0.1:8765', dataset: 'served' },
  );
  const local = shownDatasetFacts(manager({
    sourceType: 'local-user', id: 'h5ad_cells_1a2b', path: 'cells.h5ad',
    data: annData({ storage: { ...H5AD_STORAGE, remote: false, url: null, name: 'cells.h5ad' } }),
  }));
  assert.deepEqual(local.source, { kind: 'file', name: 'cells.h5ad', dataset: 'h5ad_cells_1a2b' });
  assert.equal(local.storage.host, null);
  // Every cell open: the file's cells, no subsample.
  assert.deepEqual(local.openCells, null, 'no cells known before a reading names them');

  // Not listed: a notebook's dataset (it names no source to open again), and nothing shown.
  assert.equal(shownDatasetFacts(manager({ sourceType: 'jupyter', id: 'host-1' })), null);
  assert.equal(shownDatasetFacts(manager({ sourceType: 'local-demo', id: null })), null);
  assert.equal(shownDatasetFacts(null), null);
  // A manager that throws is no dataset to list, never a failure of the page.
  assert.equal(shownDatasetFacts({ getCurrentIdentityId() { throw new Error('torn down'); } }), null);
});

test('the cells a dataset was open with: every cell, a chosen subsample, one the device fitted, a growth\'s target', () => {
  assert.equal(openCellsOf(null), null);
  assert.deepEqual(openCellsOf({ nObs: 500, kept: null, spec: null, autoFit: null }), { cells: 500, of: 500, spec: null, fitted: false });
  assert.deepEqual(openCellsOf({ nObs: 10_000, kept: new Uint32Array(1_000), spec: BLOCKS, autoFit: null }), { cells: 1_000, of: 10_000, spec: { ...BLOCKS }, fitted: false });
  assert.deepEqual(openCellsOf({ nObs: 10_000, kept: new Uint32Array(1_000), spec: BLOCKS, autoFit: { k: 1_000 } }).fitted, true);
  // A step of a share grown from few chunks is its share.
  assert.deepEqual(openCellsOf({ nObs: 10_000, kept: new Uint32Array(200), spec: { ...BLOCKS, k: 200 }, chunks: { target: 1_000 }, autoFit: null }).cells, 1_000);
  // A progressive opening is the cells it grows to.
  assert.deepEqual(
    openCellsOf({ nObs: 10_000, kept: new Uint32Array(100), spec: { ...BLOCKS, k: 100 }, growth: { final: { mode: 'kept', spec: BLOCKS, autoFit: null } } }),
    { cells: 1_000, of: 10_000, spec: { ...BLOCKS }, fitted: false },
  );
  assert.deepEqual(
    openCellsOf({ nObs: 10_000, kept: new Uint32Array(100), spec: { method: 'uniform', nObs: 10_000, k: 100, seed: 3 }, growth: { final: { mode: 'all' } } }),
    { cells: 10_000, of: 10_000, spec: null, fitted: false },
  );
  // A specification that is not one is every cell, never a guess.
  assert.deepEqual(openCellsOf({ nObs: 10, kept: new Uint32Array(2), spec: { method: 'blocks' }, autoFit: null }), { cells: 10, of: 10, spec: null, fitted: false });
});

test('opened again with the subsample chosen for it; every cell or a device fit opens as the tab opens datasets', () => {
  assert.equal(reopenRequestOf(null), null);
  assert.equal(reopenRequestOf({ cells: 10, of: 10, spec: null, fitted: false }), null);
  assert.equal(reopenRequestOf({ cells: 1_000, of: 10_000, spec: BLOCKS, fitted: true }), null);
  const request = reopenRequestOf({ cells: 1_000, of: 10_000, spec: BLOCKS, fitted: false });
  assert.deepEqual(request, { mode: 'subsample', method: 'blocks', k: 1_000, seed: 7, blockSize: 64, strict: false });
  assert.ok(Object.isFrozen(request));
  const spatial = { method: 'spatial', nObs: 100, k: 10, seed: 0, embedding: 'X_umap', columns: [0, 1], gridSize: 32 };
  assert.deepEqual(reopenRequestOf({ cells: 10, of: 100, spec: spatial, fitted: false }),
    { mode: 'subsample', method: 'spatial', k: 10, seed: 0, embedding: 'X_umap', columns: [0, 1], gridSize: 32, strict: false });

  // The next opening's request: taken by the opening, or withdrawn by its setter when none took it.
  resetCellSubsetRequests();
  const held = setNextCellSubsetRequest(request);
  withdrawNextCellSubsetRequest(held);
  assert.deepEqual(takeCellSubsetRequest(), { mode: 'auto' }, 'withdrawn: the tab\'s request again');
  const taken = setNextCellSubsetRequest(request);
  assert.equal(takeCellSubsetRequest(), taken);
  const newer = setNextCellSubsetRequest({ mode: 'all' });
  withdrawNextCellSubsetRequest(taken);
  assert.equal(takeCellSubsetRequest(), newer, 'a request set since stays');
  resetCellSubsetRequests();
});

const FACTS = Object.freeze({
  id: 'lung-atlas',
  name: 'Lung atlas',
  source: { kind: 'link', locator: 'zenodo:1', dataset: 'lung-atlas' },
  link: { provider: 'zenodo', accessLeftOut: false },
  storage: { format: 'h5ad', zarrVersion: null, layout: 'file', remote: true, name: 'lung.h5ad', host: 'zenodo.org', bytes: 1_024 },
  cells: 10_000,
  genes: 2_000,
  openCells: { cells: 10_000, of: 10_000, spec: null, fitted: false },
});

test('a record: first and last opened, how often; a reading of other cells updates a dataset listed and lists none', () => {
  assert.equal(nextRecord(null, FACTS, { at: NOW, counted: false }), null, 'only a dataset listed is updated');
  const first = nextRecord(null, FACTS, { at: NOW, counted: true });
  assert.deepEqual(first, { version: LIBRARY_RECORD_VERSION, ...FACTS, firstOpenedAt: NOW, lastOpenedAt: NOW, openCount: 1 });
  const again = nextRecord(first, FACTS, { at: NOW + HOUR, counted: true });
  assert.equal(again.firstOpenedAt, NOW);
  assert.equal(again.lastOpenedAt, NOW + HOUR);
  assert.equal(again.openCount, 2);
  const reread = nextRecord(again, { ...FACTS, openCells: { cells: 1_000, of: 10_000, spec: BLOCKS, fitted: false } }, { at: NOW + 2 * HOUR, counted: false });
  assert.equal(reread.lastOpenedAt, NOW + HOUR, 'not another opening');
  assert.equal(reread.openCount, 2);
  assert.deepEqual(reread.openCells.spec, BLOCKS);
  assert.deepEqual(nextRecord(reread, { ...FACTS, openCells: null }, { at: NOW, counted: true }).openCells.spec, BLOCKS, 'cells not known now keep what was recorded');
});

test('records are read back checked: another layout, a source that is not one, a key that is not its id, are not listed', () => {
  const record = nextRecord(null, FACTS, { at: NOW, counted: true });
  const read = readRecord('lung-atlas', record);
  assert.deepEqual(JSON.parse(JSON.stringify(read)), JSON.parse(JSON.stringify(record)));
  assert.ok(Object.isFrozen(read) && Object.isFrozen(read.source));
  assert.equal(readRecord('other', record), null);
  assert.equal(readRecord('lung-atlas', { ...record, version: LIBRARY_RECORD_VERSION + 1 }), null);
  assert.equal(readRecord('lung-atlas', { ...record, source: { kind: 'jupyter', dataset: 'x' } }), null);
  assert.equal(readRecord('lung-atlas', { ...record, source: null }), null);
  assert.equal(readRecord('lung-atlas', { ...record, cells: -1 }), null);
  assert.equal(readRecord('lung-atlas', { ...record, openCount: 1.5 }), null);
  assert.equal(readRecord('lung-atlas', { ...record, openCells: { cells: 1, of: 2, spec: { method: 'blocks' }, fitted: false } }), null);
  assert.equal(readRecord('lung-atlas', { ...record, link: { provider: 'zenodo' } }), null);
  assert.equal(readRecord('lung-atlas', null), null);
});

test('the list: recorded on a publication, most recently opened first, forgotten, heard; nothing throws', async () => {
  const store = mapStore();
  let clock = NOW;
  const library = createLibrary({ store, now: () => clock });
  assert.equal(library.lasting, true);
  let heard = 0;
  const stop = library.onChange(() => { heard++; });
  assert.deepEqual(await library.list(), []);
  await library.record(FACTS, { counted: true });
  clock += HOUR;
  await library.record({ ...FACTS, id: 'suo', name: 'Suo', source: { kind: 'sample', dataset: 'suo' }, link: null }, { counted: true });
  clock += HOUR;
  assert.equal(await library.record({ ...FACTS, id: 'never-opened' }, { counted: false }), null, 'a reading of other cells lists nothing');
  assert.deepEqual((await library.list()).map(entry => entry.id), ['suo', 'lung-atlas']);
  await library.record(FACTS, { counted: true });
  assert.deepEqual((await library.list()).map(entry => [entry.id, entry.openCount]), [['lung-atlas', 2], ['suo', 1]]);
  assert.equal(heard, 3);
  // A record another version wrote is not listed (and not taken for this one).
  store.map.set('older', { version: 0, id: 'older' });
  assert.deepEqual((await library.list()).map(entry => entry.id), ['lung-atlas', 'suo']);
  assert.equal(await library.forget(['suo', 'absent']), 1);
  assert.deepEqual((await library.list()).map(entry => entry.id), ['lung-atlas']);
  assert.equal(heard, 4);
  assert.equal(await library.forget(null), 2, 'every record, the unreadable one too');
  assert.deepEqual(await library.list(), []);
  assert.equal(heard, 5);
  stop();
  await library.record(FACTS, { counted: true });
  assert.equal(heard, 5, 'a listener stopped hears nothing');

  // A write the browser refuses once the store answered is that write's: nothing throws, the list stays.
  store.failing();
  assert.equal(await library.record({ ...FACTS, id: 'refused' }, { counted: true }), null);
  assert.deepEqual(await library.list(), []);
  assert.equal(await library.forget(['lung-atlas']), 0);
  assert.equal(library.lasting, true, 'the browser keeps the list; this write failed');
  // Writes run one at a time: two records of one dataset at once count both.
  const serial = createLibrary({ store: mapStore(), now: () => NOW });
  await Promise.all([serial.record(FACTS, { counted: true }), serial.record(FACTS, { counted: true })]);
  assert.equal((await serial.list())[0].openCount, 2);
  assert.equal(RECENT_DATASETS, 5);
});

test('a browser that gives no IndexedDB, or one the page cannot open, keeps the list for this page only', async () => {
  const none = createLibrary({ store: indexedDbKeyValueStore('cellucid-library', 'datasets', undefined) });
  assert.equal(none.lasting, false);
  await none.record(FACTS, { counted: true });
  assert.deepEqual((await none.list()).map(entry => entry.id), ['lung-atlas']);

  // An IndexedDB that refuses this page (a private window of some browsers).
  const refusing = {
    open() {
      const request = {};
      queueMicrotask(() => { request.error = new DOMException('The operation is insecure.', 'SecurityError'); request.onerror?.(); });
      return request;
    },
  };
  const library = createLibrary({ store: indexedDbKeyValueStore('cellucid-library', 'datasets', refusing) });
  assert.equal(library.lasting, true, 'not known before it is asked');
  const originalWarn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    assert.deepEqual(await library.list(), []);
    assert.equal(library.lasting, false);
    await library.record(FACTS, { counted: true });
    assert.deepEqual((await library.list()).map(entry => entry.id), ['lung-atlas']);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warned.length, 1, 'said once, in the console');
});

test('recorded by the page from the dataset shown; a notebook\'s dataset is not', async () => {
  const library = createLibrary({ store: mapStore(), now: () => NOW });
  assert.equal(await recordDatasetOpened(manager({ sourceType: 'jupyter', id: 'host' }), { counted: true, library }), null);
  const record = await recordDatasetOpened(manager({ sourceType: 'local-demo', id: 'suo', name: 'Suo' }), { counted: true, library });
  assert.equal(record.name, 'Suo');
  assert.deepEqual((await library.list()).map(entry => entry.id), ['suo']);
});

test('forgotten: the record and its file\'s handle; its saved states only when asked', async () => {
  const library = createLibrary({ store: mapStore(), now: () => NOW });
  await library.record(FACTS, { counted: true });
  await library.record({ ...FACTS, id: 'cells', name: 'cells', source: { kind: 'file', name: 'cells.h5ad', dataset: 'cells' }, link: null }, { counted: true });
  const handles = [];
  const removed = [];
  const states = [
    { id: 's1', dataset: { id: 'cells' } },
    { id: 's2', dataset: { id: 'cells' } },
    { id: 's3', dataset: { id: 'lung-atlas' } },
  ];
  const options = {
    library,
    forgetHandles: async keys => { handles.push(keys); return keys === null ? 9 : keys.length; },
    listSaved: async () => states,
    removeSaved: async ids => { removed.push(ids); return ids.length; },
  };
  assert.deepEqual(await forgetMyDatasets(['cells'], options), { datasets: 1, handles: 1, savedStates: 0 });
  assert.deepEqual(handles, [['cells']]);
  assert.deepEqual(removed, [], 'saved states stay unless asked');
  assert.deepEqual(await forgetMyDatasets(['lung-atlas'], { ...options, savedStates: true }), { datasets: 1, handles: 0, savedStates: 1 });
  assert.deepEqual(removed, [['s3']]);
  assert.deepEqual(handles, [['cells']], 'a link has no handle to forget');
  // The whole list: every handle too, whatever dataset it was of.
  await library.record(FACTS, { counted: true });
  assert.deepEqual(await forgetMyDatasets(null, options), { datasets: 1, handles: 9, savedStates: 0 });
  assert.deepEqual(handles.at(-1), null);
});

// ---------------------------------------------------------------- the words

function entry(overrides = {}) {
  return readRecord(overrides.id ?? FACTS.id, { ...nextRecord(null, FACTS, { at: NOW - 2 * HOUR, counted: true }), ...overrides });
}

const SAMPLE = () => entry({ id: 'suo', name: 'Suo', source: { kind: 'sample', dataset: 'suo' }, link: null });
const FILE = () => entry({
  id: 'cells', name: 'cells', source: { kind: 'file', name: 'cells.h5ad', dataset: 'cells' }, link: null,
  storage: { format: 'h5ad', zarrVersion: null, layout: 'file', remote: false, name: 'cells.h5ad', host: null, bytes: 2_048 },
});
const FOLDER = () => entry({
  id: 'atlas', name: 'atlas', source: { kind: 'file', name: 'atlas.zarr', dataset: 'atlas' }, link: null,
  storage: { format: 'zarr', zarrVersion: 3, layout: 'folder', remote: false, name: 'atlas.zarr', host: null, bytes: null },
});
const SERVER = () => entry({ id: 'served', name: 'Served', source: { kind: 'remote', url: 'http://127.0.0.1:8765', dataset: 'served' }, link: null, storage: null });

test('each dataset\'s kind, where it comes from, and how it opens again', () => {
  assert.deepEqual([entry(), SAMPLE(), FILE(), FOLDER(), SERVER()].map(datasetKind), ['link', 'sample', 'file', 'folder', 'server']);
  assert.deepEqual(Object.values(KIND_LABELS), ['Sample', 'Link', 'Server', 'File', 'Folder']);
  assert.equal(describeOrigin(entry()), 'Zenodo');
  assert.equal(describeOrigin(entry({ link: { provider: 'url', accessLeftOut: false } })), 'zenodo.org', 'a plain web address: its host');
  assert.equal(describeOrigin(entry({ link: { provider: 'url', accessLeftOut: false }, storage: null, source: { kind: 'link', locator: 'https://data.test/x.h5ad', dataset: 'lung-atlas' } })), 'data.test');
  assert.equal(describeOrigin(SERVER()), 'Server 127.0.0.1:8765');
  assert.equal(describeOrigin(FOLDER()), 'Folder');
  const kept = { handlesAvailable: true, handles: new Set(['cells']) };
  assert.equal(reopenWay(entry(), kept), 'click');
  assert.equal(reopenWay(FILE(), kept), 'ask');
  assert.equal(reopenWay(FOLDER(), kept), 'choose', 'its handle is not kept');
  assert.equal(reopenWay(FILE(), { handlesAvailable: false, handles: new Set(['cells']) }), 'choose', 'a browser that gives no handles');
});

const STATES = [
  { id: 'a', kind: 'autosave', name: null, dataset: { id: 'lung-atlas' }, steps: 12, trackers: [{ name: 'Main' }, { name: 'Clusters' }], updatedAt: NOW - HOUR, bytes: 1_048_576, openable: true },
  { id: 'n', kind: 'named', name: 'Figure 2', dataset: { id: 'lung-atlas' }, steps: 8, trackers: [{ name: 'Main' }], updatedAt: NOW - DAY, bytes: 524_288, openable: true },
  { id: 'o', kind: 'named', name: 'Old', dataset: { id: 'lung-atlas' }, steps: 1, trackers: [], updatedAt: NOW, bytes: 10, openable: false },
  { id: 'x', kind: 'autosave', name: null, dataset: { id: 'suo' }, steps: 3, trackers: [{ name: 'Main' }], updatedAt: NOW, bytes: 100, openable: true, current: true },
];

test('its saved states, the one Continue opens, and what is stored of it', () => {
  assert.deepEqual(savedStatesOf(entry(), STATES).map(state => state.id), ['o', 'a', 'n']);
  assert.equal(latestSavedState(entry(), STATES).id, 'a', 'the newest one this version can open');
  assert.equal(latestSavedState(SAMPLE(), STATES), null, 'the history shown now is not one to continue into');
  assert.equal(describeSavedStateLine(STATES[0], NOW), 'Autosave · 12 steps · 2 trackers (Main, Clusters) · changed 1 hour ago · 1.0 MB');
  assert.equal(describeSavedStateLine(STATES[1], NOW), '"Figure 2" · 8 steps · saved 1 day ago · 512 KB');
  assert.equal(describeSavedStateLine(STATES[2], NOW), '"Old" · 1 step · saved just now · 10 B · kept by another version');
  assert.equal(describeSavedStateLine(STATES[3], NOW), 'Autosave · 3 steps · changed just now · 100 B · the history shown now');
  const items = [
    { name: 'lung.h5ad', host: 'zenodo.org', bytes: 3_000, kind: 'parts' },
    { name: 'lung.h5ad', host: 'zenodo.org', bytes: 1_000, kind: 'gene-index' },
    { name: 'lung.h5ad', host: 'other.org', bytes: 9_000, kind: 'parts' },
    { name: 'cells.h5ad', host: null, bytes: 5, kind: 'converted' },
  ];
  assert.deepEqual(keptOf(entry(), items), { bytes: 4_000, items: 2 });
  assert.deepEqual(keptOf(FILE(), items), { bytes: 5, items: 1 });
  assert.equal(keptOf(SERVER(), items), null);
  assert.equal(keptOf(SAMPLE(), []), null);
});

test('a menu item: its name, where it comes from and when; the one open now; one to choose again', () => {
  assert.deepEqual(describeMenuItem(entry(), { now: NOW, current: false, way: 'click' }), {
    label: 'Lung atlas',
    hint: 'Link · Zenodo · 2 hours ago',
    title: 'Open Lung atlas again (last opened 2 hours ago).',
  });
  assert.equal(describeMenuItem(entry(), { now: NOW, current: true, way: 'click' }).hint, 'Link · Zenodo · open now');
  assert.equal(describeMenuItem(SERVER(), { now: NOW, current: false, way: 'click' }).hint, 'Server · 127.0.0.1:8765 · 2 hours ago');
  assert.equal(describeMenuItem(SAMPLE(), { now: NOW, current: false, way: 'click' }).hint, 'Sample · 2 hours ago');
  assert.deepEqual(describeMenuItem(FILE(), { now: NOW, current: false, way: 'choose' }), {
    label: 'cells',
    hint: 'File · choose it again',
    title: 'Choose cells again: this browser does not let a page reopen a file by itself.',
  });
});

test('a row of All…: one line under its name, and the facts behind it', () => {
  assert.equal(describeRowMeta(entry(), savedStatesOf(entry(), STATES)), 'h5ad file · 10,000 cells · 2,000 genes · 3 saved states');
  assert.equal(describeRowMeta(SERVER(), []), '10,000 cells · 2,000 genes');
  assert.equal(describeOpenCells(entry()), 'Every cell (10,000)');
  const sub = entry({ openCells: { cells: 1_000, of: 10_000, spec: BLOCKS, fitted: false } });
  assert.equal(describeOpenCells(sub), '1,000 of 10,000 (blocks of 64, seed 7)');
  assert.equal(describeOpenCells(entry({ openCells: { cells: 1_000, of: 10_000, spec: BLOCKS, fitted: true } })), '1,000 of 10,000 (blocks of 64, seed 7, fitted to this device)');

  const facts = rows => Object.fromEntries(rows.map(row => [row.label, row]));
  const link = facts(describeEntryFacts(sub, { saved: savedStatesOf(sub, STATES), kept: { bytes: 4_000, items: 2 }, way: 'click', now: NOW }));
  assert.deepEqual(Object.keys(link), ['Source', 'Address', 'Opens', 'Format', 'Size', 'Cells', 'Genes', 'Last opened', 'First opened', 'Saved states', 'Stored']);
  assert.equal(link.Source.value, 'Link · Zenodo');
  assert.equal(link.Address.value, 'zenodo:1');
  assert.equal(link.Opens.value, 'With one click');
  assert.equal(link.Format.value, 'AnnData, h5ad file');
  assert.equal(link.Size.value, '1.0 KB');
  assert.match(link.Cells.title, /same method, size and seed/);
  assert.match(link['Last opened'].value, /\(1 time in all\)$/);
  assert.deepEqual(link['Saved states'].lines, savedStatesOf(sub, STATES).map(state => describeSavedStateLine(state, NOW)));
  assert.match(link['Saved states'].title, /State › Session, Load…/);
  assert.equal(link.Stored.value, '3.9 KB (2 items)');
  assert.match(link.Stored.title, /Session › Open data › Stored › Manage…/);
  const access = facts(describeEntryFacts(entry({ link: { provider: 'zenodo', accessLeftOut: true } }), { saved: [], kept: null, way: 'click', now: NOW }));
  assert.equal(access.Opens.value, 'With one click, while the link grants access');
  assert.match(access.Opens.title, /paste the whole link again/);
  assert.equal(access['Saved states'].value, 'None yet');
  assert.equal(access.Stored, undefined, 'nothing stored, no row');

  const file = facts(describeEntryFacts(FILE(), { saved: [], kept: null, way: 'ask', now: NOW }));
  assert.equal(file.Source.value, 'File on this computer');
  assert.equal(file.Name.value, 'cells.h5ad');
  assert.match(file.Opens.value, /^With one click; the browser may ask to read it first$/);
  const folder = facts(describeEntryFacts(FOLDER(), { saved: [], kept: null, way: 'choose', now: NOW }));
  assert.equal(folder.Opens.value, 'Choose it again with Folder… in Session › Open data');
  assert.equal(folder.Format.value, 'AnnData, Zarr v3 folder');
  assert.equal(folder.Size, undefined);
  const server = facts(describeEntryFacts(SERVER(), { saved: [], kept: null, way: 'click', now: NOW }));
  assert.equal(server.Source.value, 'Cellucid server');
  assert.equal(server.Opens.value, 'With one click, while the server runs');
  assert.equal(server.Format, undefined);
  assert.equal(facts(describeEntryFacts(SAMPLE(), { saved: [], kept: null, way: 'click', now: NOW })).Source.value, 'Sample dataset');
});

test('the filter: every word typed, in its name or its file\'s, whatever the case; the status line', () => {
  assert.equal(matchesFilter(entry(), ''), true);
  assert.equal(matchesFilter(entry(), 'lung'), true);
  assert.equal(matchesFilter(entry(), 'ATLAS lung'), true);
  assert.equal(matchesFilter(entry(), 'lung.h5ad'), true, 'its file\'s name');
  assert.equal(matchesFilter(entry(), 'lung kidney'), false);
  assert.equal(matchesFilter(FILE(), 'cells.h5'), true);
  assert.equal(describeListStatus({ total: 0, shown: 0, query: '', withSaved: 0 }), '');
  assert.equal(describeListStatus({ total: 7, shown: 7, query: '', withSaved: 0 }), '7 datasets, most recently opened first.');
  assert.equal(describeListStatus({ total: 7, shown: 7, query: ' ', withSaved: 3 }), '7 datasets, 3 with saved states, most recently opened first.');
  assert.equal(describeListStatus({ total: 7, shown: 2, query: 'lung', withSaved: 3 }), '2 of 7 datasets match "lung".');
  assert.equal(describeListStatus({ total: 1, shown: 0, query: 'x', withSaved: 0 }), 'No dataset matches "x".');
});
