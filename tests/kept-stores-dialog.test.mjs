/**
 * The Stored dialog's words (`app/ui/modules/kept-stores-dialog.js`): kept
 * items grouped by dataset (its file's name and host), each row what it is,
 * its size, when it was last used, whether an open tab uses it (then it
 * cannot be chosen) and what it spares; the connection speeds remembered per
 * host as one row; My datasets as one row (each of its datasets is listed in
 * its own dialog, never here); the Stored row's summary; where it is kept, as the
 * browser says it; and what a removal did.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeKeptItem,
  describeKeptKind,
  describeSavedState,
  describeMyDatasets,
  describeDecoderDecisions,
  describeRememberedHosts,
  describeRemoval,
  groupKeptItems,
} from '../assets/js/app/ui/modules/kept-stores-dialog.js';
import { initKeptStoresLine, summarizeKeptStores } from '../assets/js/app/ui/modules/kept-stores-line.js';

const NOW = new Date(2026, 9, 28, 15, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

const item = overrides => ({
  id: 'converted:00',
  kind: 'converted',
  file: '00',
  name: 'pbmc.rds',
  host: null,
  matrix: null,
  order: null,
  bytes: 3_145_728,
  used: NOW - 60_000,
  held: 'none',
  ...overrides,
});

test('a kept item says what it is, its size, when last used, whether a tab uses it and what it spares', () => {
  // When, in the words of every list of the app (`state/model.js` `formatAgo`, one implementation).
  assert.deepEqual(describeKeptItem(item({}), NOW), {
    name: 'Converted copy',
    size: '3.0 MB',
    meta: 'used 1 minute ago',
    removable: true,
  });
  assert.deepEqual(describeKeptItem(item({ kind: 'download', held: 'other-tab', used: NOW - 3 * DAY }), NOW), {
    name: 'Whole download',
    size: '3.0 MB',
    meta: 'used 3 days ago · in use by another tab',
    removable: false,
  });
  const index = item({ kind: 'gene-index', matrix: 'X', order: { order: 'priority', nObs: 10, method: 'blocks', seed: 0, blockSize: 19 }, held: 'this-tab', used: NOW - DAY });
  assert.deepEqual(describeKeptItem(index, NOW), { name: 'Gene index (X, blocks of 19, seed 0)', size: '3.0 MB', meta: 'used 1 day ago · in use by this tab', removable: false });
  assert.equal(describeKeptItem(item({ used: 0 }), NOW).meta, 'not used yet');
  assert.equal(describeKeptKind(item({ kind: 'gene-index', matrix: 'layers/counts', order: { order: 'file' } })), 'Gene index (layers/counts, every cell)');
  assert.equal(describeKeptKind(item({ kind: 'gene-index' })), 'Gene index');
  // A kind that knows what it spares the next opening says it.
  assert.deepEqual(describeKeptItem(item({ kind: 'parts', saves: 524_288_000, used: 0 }), NOW), { name: 'Downloaded parts', size: '3.0 MB', meta: 'saves 500 MB next open', removable: true });
  assert.equal(describeKeptKind(item({ kind: 'future' })), 'Kept future', 'the list is open to other kinds');
});

test('kept items are grouped by dataset: its name and host, its kinds in order, most recently used first', () => {
  const groups = groupKeptItems([
    item({ id: 'converted:a', file: 'f1', name: 'pbmc.rds', bytes: 100, used: NOW - DAY }),
    item({ id: 'gene-index:b', kind: 'gene-index', file: 'f2', name: 'hlca.h5ad', host: 'cellxgene.cziscience.com', bytes: 300, used: NOW }),
    item({ id: 'parts:c', kind: 'parts', file: 'f2', name: 'hlca.h5ad', host: 'cellxgene.cziscience.com', bytes: 200, used: NOW - 2 * DAY }),
    item({ id: 'download:d', kind: 'download', file: 'f1', name: null, bytes: 50, used: NOW - 5 * DAY }),
  ]);
  assert.deepEqual(groups.map(group => [group.name, group.host, group.bytes, group.items.map(entry => entry.kind)]), [
    ['hlca.h5ad', 'cellxgene.cziscience.com', 500, ['parts', 'gene-index']],
    ['pbmc.rds', 'this computer', 150, ['converted', 'download']],
  ]);
  assert.equal(groupKeptItems([item({ name: null })])[0].name, 'Unnamed file');
});

test('a saved state is a row of its dataset: its size, what it is, how many steps, when saved', () => {
  // An autosave by its latest step, as Load… and My datasets name it (L10-10: eight read
  // "History kept in this browser · saved today" alike).
  const state = { id: 'a', kind: 'autosave', name: null, lastStep: 'Colored by gene SOX9', dataset: { id: 'atlas', name: 'Lung atlas' }, steps: 3, bytes: 2048, updatedAt: NOW - 2 * 60 * 60 * 1000, openable: true };
  assert.deepEqual(describeSavedState(state, NOW), {
    name: 'Lung atlas',
    size: '2.0 KB',
    meta: 'Autosave at “Colored by gene SOX9” · 3 steps · changed 2 hours ago',
  });
  assert.equal(describeSavedState({ ...state, lastStep: null }, NOW).meta, 'Autosave · 3 steps · changed 2 hours ago');
  const named = { ...state, kind: 'named', name: 'Before clustering', dataset: { id: 'x', name: null }, steps: 1, updatedAt: 0 };
  assert.equal(describeSavedState(named, NOW).name, 'Unnamed dataset');
  assert.equal(describeSavedState(named, NOW).meta, '"Before clustering" · 1 step');
  assert.equal(describeSavedState({ ...named, openable: false }, NOW).meta, '"Before clustering" · 1 step · kept by another version');
});

test('My datasets is one row: how many datasets it lists, and the files to reopen among them; none while it holds nothing', () => {
  assert.deepEqual(describeMyDatasets(7, 2), { name: 'My datasets', facts: '7 datasets opened in this browser · 2 files to reopen' });
  assert.deepEqual(describeMyDatasets(1), { name: 'My datasets', facts: '1 dataset opened in this browser' });
  assert.equal(describeMyDatasets(1, 1).facts, '1 dataset opened in this browser · 1 file to reopen');
  // A handle kept without its dataset listed (the list forgotten elsewhere) is still offered to forget.
  assert.equal(describeMyDatasets(0, 1).facts, '0 datasets opened in this browser · 1 file to reopen');
  assert.equal(describeMyDatasets(0, 0), null);
});

test('what a removal did', () => {
  assert.equal(describeRemoval({ removed: 2, held: 0 }), 'Removed 2 items.');
  assert.equal(describeRemoval({ removed: 1, held: 1 }), 'Removed 1 item. 1 item in use by an open tab stays until that tab closes.');
  assert.equal(describeRemoval({ removed: 0, held: 2 }), '2 items in use by an open tab stay until that tab closes.');
  assert.equal(describeRemoval({ removed: 0, held: 0 }), 'Nothing was removed.');
  assert.equal(describeRemoval({ removed: 2, held: 0, hosts: 3 }), 'Removed 2 items. Forgot the connection speeds of 3 hosts.');
  assert.equal(describeRemoval({ removed: 0, held: 0, hosts: 1 }), 'Forgot the connection speeds of 1 host.');
  assert.equal(describeRemoval({ removed: 0, held: 0, hosts: 1, decoders: 4 }), 'Forgot the connection speeds of 1 host. Forgot the decoder choices.');
  assert.equal(describeRemoval({ removed: 1, held: 0, datasets: 3 }), 'Removed 1 item. Forgot 3 datasets of My datasets.');
  assert.equal(describeRemoval({ removed: 0, held: 0, datasets: 1 }), 'Forgot 1 dataset of My datasets.');
});

test('the decoder choices kept are one row, none while nothing is kept', () => {
  assert.equal(describeDecoderDecisions(0), null);
  const row = describeDecoderDecisions(3);
  assert.equal(row.name, 'Decoder choices measured (3 chunk sizes)');
  assert.equal(describeDecoderDecisions(1).name, 'Decoder choices measured (1 chunk size)');
  assert.match(row.title, /No dataset is kept/);
});

test('the connection speeds remembered per host are one row: the hosts, each one\'s figures as its tooltip', () => {
  assert.equal(describeRememberedHosts([]), null, 'no row while none is remembered');
  const row = describeRememberedHosts([
    { origin: 'https://datasets.cellxgene.cziscience.com', latencyMs: 244, bytesPerMs: 1_572.864, at: NOW },
    { origin: 'http://127.0.0.1:8765', latencyMs: 2, bytesPerMs: 104_857.6, at: NOW - DAY },
  ]);
  assert.deepEqual(row, {
    name: 'Connection speeds remembered (2 hosts)',
    facts: 'datasets.cellxgene.cziscience.com, 127.0.0.1:8765',
    title: 'datasets.cellxgene.cziscience.com: 244 ms round trip, 1.5 MB/s\n127.0.0.1:8765: 2 ms round trip, 100 MB/s',
  });
  assert.equal(describeRememberedHosts([{ origin: 'https://a.test', latencyMs: 10, bytesPerMs: 1, at: 0 }]).name, 'Connection speeds remembered (1 host)');
});

test('the Stored row: the datasets kept and their bytes; with none, the hosts remembered; a window without storage says so', async () => {
  const items = [
    item({ id: 'parts:a', kind: 'parts', file: 'f1', bytes: 400 * 1_048_576 }),
    item({ id: 'gene-index:b', kind: 'gene-index', file: 'f1', bytes: 100 * 1_048_576 }),
    item({ id: 'converted:c', file: 'f2', bytes: 40 * 1_048_576 }),
  ];
  // One line beside Manage… at the narrowest panel; the whole of it in its title.
  const said = (...args) => { const { text, title } = summarizeKeptStores(...args); return [text, title]; };
  assert.deepEqual(said(items), ['2 datasets · 540 MB kept', '2 datasets · 540 MB kept']);
  // The other kinds are named in the title, not counted on the line (found 2026-11-10: "· 28 more"
  // said nothing and, at 30 characters, ran under Manage…).
  assert.deepEqual(said(items, 3), ['2 datasets · 540 MB kept', '2 datasets · 540 MB · 3 connection speeds']);
  assert.deepEqual(said([], 1), ['1 connection speed', '1 connection speed']);
  assert.deepEqual(said(items, 1, 2), ['2 datasets · 540 MB kept', '2 datasets · 540 MB · 2 saved states · 1 connection speed']);
  assert.deepEqual(said([], 0, 1), ['1 saved state', '1 saved state']);
  assert.deepEqual(said([], 2, 1), ['3 items', '1 saved state · 2 connection speeds']);
  assert.deepEqual(said([], 0), ['', '']);
  // Never longer than the row holds beside Manage… (the longest wording, with every count large).
  assert.ok(said(items, 99, 99)[0].length <= 26, said(items, 99, 99)[0]);

  const dom = () => {
    const listeners = new Map();
    return {
      root: { hidden: true },
      text: { textContent: '' },
      manage: { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: () => {} },
      listeners,
    };
  };
  const opening = { subscribe: () => () => {} };
  const changes = () => () => {};
  const remembered = [{ origin: 'https://a.test', latencyMs: 10, bytesPerMs: 1, at: 0 }];
  const available = { available: true };

  const kept = dom();
  const keptLine = initKeptStoresLine(kept, { opening, changes, list: async () => items, place: async () => available, hosts: () => remembered });
  await keptLine.refresh();
  assert.equal(kept.text.textContent, '2 datasets · 540 MB kept', 'one line beside Manage… (`white-space: nowrap`)');
  assert.equal(kept.text.title, '2 datasets · 540 MB · 1 connection speed');
  assert.equal(kept.root.hidden, false);

  const speeds = dom();
  await initKeptStoresLine(speeds, { opening, changes, list: async () => [], place: async () => available, hosts: () => remembered }).refresh();
  assert.equal(speeds.text.textContent, '1 connection speed');
  assert.equal(speeds.root.hidden, false);

  const none = dom();
  await initKeptStoresLine(none, { opening, changes, list: async () => [], place: async () => available, hosts: () => [] }).refresh();
  assert.equal(none.root.hidden, true, 'hidden while nothing is kept');

  // A window without storage says so first, even with speeds remembered for this visit.
  const bare = dom();
  await initKeptStoresLine(bare, { opening, changes, list: async () => [], place: async () => ({ available: false }), hosts: () => remembered }).refresh();
  assert.equal(bare.text.textContent, 'Kept for this tab only');
  assert.equal(bare.root.hidden, false);
  let opened = null;
  initKeptStoresLine(bare, { opening, changes, list: async () => [], place: async () => ({ available: false }), hosts: () => [], onManage: opener => { opened = opener; } });
  bare.listeners.get('click')();
  assert.equal(opened, bare.manage, 'Manage… opens the dialog from its button');
});

test('where it is kept, as the browser says it: its private storage for this site, its figures, and whether it keeps it', async () => {
  const { keptStoragePlace, keepKeptStoresWhenSpaceIsLow } = await import('../assets/js/data/anndata/transcode/space.js');
  const { whereFacts } = await import('../assets/js/app/ui/modules/kept-stores-dialog.js');
  let asked = 0;
  const storage = {
    getDirectory: async () => ({ getDirectoryHandle: async () => ({}) }),
    estimate: async () => ({ usage: 1_288_490_188, quota: 64 * 2 ** 30 }),
    persisted: async () => false,
    persist: async () => { asked++; return true; },
  };
  const environment = { navigator: { storage }, location: { origin: 'https://www.cellucid.com' } };
  const place = await keptStoragePlace(environment);
  assert.deepEqual(place, {
    origin: 'https://www.cellucid.com',
    available: true,
    estimate: { usage: 1_288_490_188, quota: 64 * 2 ** 30 },
    persisted: false,
    canPersist: true,
  });
  assert.equal(asked, 0, 'never asked to keep it unless the person asks');
  const rows = Object.fromEntries(whereFacts(place).map(row => [row.label, row]));
  assert.equal(rows.Place.value, "this browser's private storage for www.cellucid.com");
  assert.match(rows.Place.title, /^The storage of https:\/\/www\.cellucid\.com in this browser \(its private file system, IndexedDB and localStorage\), inside this browser profile and managed by the browser: not a folder you can open/);
  assert.equal(rows.Holds.value, 'files, saved states, My datasets, connection speeds');
  assert.match(rows.Holds.title, /the saved states of histories, My datasets and the decoder choices in its IndexedDB/);
  // The handles of files to reopen are named only where the browser gives them.
  const withHandles = Object.fromEntries(whereFacts(place, { handles: true }).map(row => [row.label, row]));
  assert.equal(withHandles.Holds.value, 'files, saved states, My datasets, connection speeds');
  assert.match(withHandles.Holds.title, /the saved states of histories, My datasets with the browser's handles of files to reopen and the decoder choices in its IndexedDB/);
  assert.equal(rows['Removed by'].value, "this dialog, or the browser's Clear site data");
  assert.equal(rows.Space.value, "1.2 GB used · 63 GB free (browser's figures)");
  assert.match(rows.Space.title, /The browser's own estimate for this whole site/);
  assert.equal(rows['Kept when space is low'].value, 'no, the browser may clear it');
  // Asked on the person's click: what the browser answers is shown.
  assert.equal(await keepKeptStoresWhenSpaceIsLow(environment), true);
  assert.equal(asked, 1);
  assert.equal(whereFacts(place, { asked: true }).at(-1).value, 'yes');
  assert.equal(whereFacts(place, { asked: false }).at(-1).value, 'no (the browser declined)');
  assert.equal(whereFacts({ ...place, persisted: true }).at(-1).value, 'yes');
  assert.equal(whereFacts({ ...place, persisted: null }).at(-1).value, 'not said by the browser');
  // A browser whose estimate or persisted() throws says nothing of them; never asked for persist().
  const failing = await keptStoragePlace({ navigator: { storage: { ...storage, estimate: async () => { throw new Error('no'); }, persisted: async () => { throw new Error('no'); } } }, location: { origin: 'null' } });
  assert.deepEqual([failing.origin, failing.estimate, failing.persisted, failing.canPersist], [null, null, null, true]);
  assert.equal(asked, 1, 'listing the place never asks');
  assert.equal(Object.fromEntries(whereFacts(failing).map(row => [row.label, row.value])).Place, "this browser's private storage for this site");
  assert.equal(whereFacts({ ...place, estimate: null }).some(row => row.label === 'Space'), false, 'no figures, no row');

  // A window that gives the site no storage (a private window; found by asking, not by the browser's name).
  for (const bare of [
    { navigator: {}, location: { origin: 'https://www.cellucid.com' } },
    { navigator: { storage: { ...storage, getDirectory: async () => { throw new DOMException('denied', 'SecurityError'); } } } },
  ]) {
    const none = await keptStoragePlace(bare);
    assert.equal(none.available, false);
    assert.equal(none.canPersist, false);
    assert.deepEqual(whereFacts(none).map(row => [row.label, row.value]), [['Place', 'This browser window keeps data only until the tab closes']]);
  }
  assert.equal(await keepKeptStoresWhenSpaceIsLow({ navigator: {} }), false);
  assert.equal(await keepKeptStoresWhenSpaceIsLow({ navigator: { storage: { persist: async () => { throw new Error('refused'); } } } }), false);
});
