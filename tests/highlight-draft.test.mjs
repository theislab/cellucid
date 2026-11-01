/**
 * A draft of unsaved highlights survives a reload (audit UX-12): kept per
 * dataset after each change (cells as original positions), offered -- never
 * applied by itself -- when the same dataset opens again with no highlight,
 * restored on its notification's Restore, on another subsample too (cells
 * not open are left out and counted). Storage failures only mean no draft.
 * Highlights a session file holds (saved or restored) are no unsaved draft:
 * nothing is offered for them after a reload, until they change.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { EventEmitter } from '../assets/js/app/utils/event-emitter.js';
import { highlightStateMethods } from '../assets/js/app/state/managers/highlight-manager.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import {
  createHighlightDraft, listHighlightDrafts, onHighlightDraftsChange, removeHighlightDrafts,
} from '../assets/js/app/highlight-draft.js';

function makeState(identity) {
  const state = Object.assign(Object.create(highlightStateMethods), new EventEmitter());
  for (const name of Object.getOwnPropertyNames(EventEmitter.prototype)) {
    if (name !== 'constructor') state[name] = EventEmitter.prototype[name];
  }
  state.pointCount = identity.n;
  state.cellIdentity = identity;
  state.highlightPages = [];
  state.activePageId = null;
  state._highlightPageIdCounter = 0;
  state._highlightIdCounter = 0;
  state._recomputeHighlightArray = () => {};
  state.createHighlightPage('Page 1');
  return state;
}

function mapStore() {
  const map = new Map();
  return {
    map,
    get: async key => map.get(key),
    put: async (key, value) => { map.set(key, structuredClone(value)); },
    delete: async key => { map.delete(key); },
    entries: async () => [...map].map(([key, value]) => ({ key, value })),
  };
}

function recorder() {
  const shown = [];
  return { shown, show: notice => shown.push(notice), info: message => shown.push({ message }) };
}

const manual = () => ({ schedule: () => 1, cancel: () => {} });

test('a reload offers the highlights back, and Restore puts them on their pages', async () => {
  const store = mapStore();
  const before = makeState(createCellIdentity({ nObs: 10 }));
  const first = createHighlightDraft({ state: before, notifications: recorder(), datasetKey: () => 'atlas', store, ...manual() });
  before.addHighlightDirect({ type: 'lasso', label: 'T cells', cellIndices: Uint32Array.of(1, 2, 3) });
  const second = before.createHighlightPage('Tumour');
  before.switchToPage(second.id);
  const knn = before.addHighlightDirect({ type: 'knn', label: 'Neighbours', cellIndices: Uint32Array.of(7, 8) });
  before.toggleHighlightEnabled(knn.id, false);
  await first.flush();
  assert.ok(store.map.has('atlas'));
  first.dispose();

  // The page reloaded: the same dataset, nothing highlighted yet.
  const notifications = recorder();
  const after = makeState(createCellIdentity({ nObs: 10 }));
  const draft = createHighlightDraft({ state: after, notifications, datasetKey: () => 'atlas', store, ...manual() });
  await draft.datasetOpened();
  assert.equal(notifications.shown.length, 1);
  assert.match(notifications.shown[0].message, /^2 highlights from .* on this dataset were not saved in a session\.$/);
  assert.equal(after.getHighlightPages()[0].highlightedGroups.length, 0, 'never restored by itself');
  notifications.shown[0].action.run();
  const pages = after.getHighlightPages();
  assert.deepEqual(pages.map(page => page.name), ['Page 1', 'Tumour']);
  assert.deepEqual(Array.from(pages[0].highlightedGroups[0].cellIndices), [1, 2, 3]);
  assert.equal(pages[0].highlightedGroups[0].label, 'T cells');
  assert.equal(pages[1].highlightedGroups[0].type, 'knn');
  assert.equal(pages[1].highlightedGroups[0].enabled, false);
  assert.equal(after.activePageId, pages[1].id, 'the page that was shown');
});

test('on another subsample the open cells come back and the rest are counted', async () => {
  const store = mapStore();
  const whole = makeState(createCellIdentity({ nObs: 10 }));
  const keeper = createHighlightDraft({ state: whole, notifications: recorder(), datasetKey: () => 'atlas', store, ...manual() });
  whole.addHighlightDirect({ type: 'lasso', label: 'Lasso', cellIndices: Uint32Array.of(2, 5, 9) });
  await keeper.flush();
  // Original positions 1, 2, 5 and 7 are open: 5 is open cell 2, 2 open cell 1.
  const notifications = recorder();
  const subsample = makeState(createCellIdentity({ nObs: 10, kept: Uint32Array.of(1, 2, 5, 7) }));
  const draft = createHighlightDraft({ state: subsample, notifications, datasetKey: () => 'atlas', store, ...manual() });
  await draft.datasetOpened();
  notifications.shown[0].action.run();
  assert.deepEqual(Array.from(subsample.getHighlightedGroups()[0].cellIndices), [1, 2]);
  assert.equal(notifications.shown[1].message, 'Left out 1 cell of the restored highlights: not open now.');
});

test('nothing is offered for another dataset, with highlights already made, or without storage', async () => {
  const store = mapStore();
  const state = makeState(createCellIdentity({ nObs: 10 }));
  const keeper = createHighlightDraft({ state, notifications: recorder(), datasetKey: () => 'atlas', store, ...manual() });
  state.addHighlightDirect({ type: 'lasso', label: 'Lasso', cellIndices: Uint32Array.of(2) });
  await keeper.flush();
  const other = recorder();
  await createHighlightDraft({ state: makeState(createCellIdentity({ nObs: 10 })), notifications: other, datasetKey: () => 'pbmc', store, ...manual() }).datasetOpened();
  assert.equal(other.shown.length, 0);
  const busy = recorder();
  await createHighlightDraft({ state, notifications: busy, datasetKey: () => 'atlas', store, ...manual() }).datasetOpened();
  assert.equal(busy.shown.length, 0, 'the highlights shown are the newer work');
  const none = recorder();
  await createHighlightDraft({ state: makeState(createCellIdentity({ nObs: 10 })), notifications: none, datasetKey: () => 'atlas', store: null, ...manual() }).datasetOpened();
  assert.equal(none.shown.length, 0);
  // Every highlight removed: the draft goes too.
  state.removeHighlightGroup(state.getHighlightedGroups()[0].id);
  await keeper.flush();
  assert.equal(store.map.has('atlas'), false);
  const failing = { get: async () => { throw new Error('quota'); }, put: async () => { throw new Error('quota'); }, delete: async () => {} };
  const quiet = createHighlightDraft({ state, notifications: recorder(), datasetKey: () => 'atlas', store: failing, ...manual() });
  state.addHighlightDirect({ type: 'lasso', label: 'Lasso', cellIndices: Uint32Array.of(3) });
  await quiet.flush();
  await quiet.datasetOpened();
});

test('highlights saved in a session or restored from one are not offered as unsaved; a change after is', async () => {
  const store = mapStore();
  const state = makeState(createCellIdentity({ nObs: 10 }));
  const draft = createHighlightDraft({ state, notifications: recorder(), datasetKey: () => 'atlas', store, ...manual() });
  state.addHighlightDirect({ type: 'lasso', label: 'T cells', cellIndices: Uint32Array.of(1, 2, 3) });
  await draft.flush();
  assert.ok(store.map.has('atlas'));

  // One highlight, said in the singular.
  const one = recorder();
  await createHighlightDraft({ state: makeState(createCellIdentity({ nObs: 10 })), notifications: one, datasetKey: () => 'atlas', store, ...manual() }).datasetOpened();
  assert.match(one.shown[0].message, /^1 highlight from .* on this dataset was not saved in a session\.$/);

  // Saved in a session: the draft goes, and a reload offers nothing.
  const saved = draft.sessionSaving();
  await saved();
  assert.equal(store.map.has('atlas'), false);
  // A write of the same highlights (a late change event) keeps none.
  state.emit('highlight:changed');
  await draft.flush();
  assert.equal(store.map.has('atlas'), false);
  const reloaded = recorder();
  await createHighlightDraft({ state: makeState(createCellIdentity({ nObs: 10 })), notifications: reloaded, datasetKey: () => 'atlas', store, ...manual() }).datasetOpened();
  assert.equal(reloaded.shown.length, 0);

  // A change after the save is unsaved again.
  state.addHighlightDirect({ type: 'lasso', label: 'B cells', cellIndices: Uint32Array.of(4) });
  await draft.flush();
  assert.equal(store.map.get('atlas').pages[0].groups.length, 2);

  // A change while the session is being saved is not in it: the draft stays.
  const during = draft.sessionSaving();
  state.addHighlightDirect({ type: 'lasso', label: 'NK cells', cellIndices: Uint32Array.of(5) });
  await during();
  await draft.flush();
  assert.equal(store.map.get('atlas').pages[0].groups.length, 3);

  // Restored from a session file: those highlights are the file's.
  await draft.sessionRestored();
  assert.equal(store.map.has('atlas'), false);
  state.emit('highlight:changed');
  await draft.flush();
  assert.equal(store.map.has('atlas'), false);
  state.toggleHighlightEnabled(state.getHighlightedGroups()[0].id, false);
  await draft.flush();
  assert.ok(store.map.has('atlas'), 'a switch turned off since is unsaved work');
  draft.dispose();

  // A draft offered as the dataset opened for a session load is withdrawn
  // once the session is restored: the work shown is the session's.
  const shown = [];
  const dismissed = [];
  const loading = makeState(createCellIdentity({ nObs: 10 }));
  const offered = createHighlightDraft({
    state: loading, store, datasetKey: () => 'atlas', ...manual(),
    notifications: { show: notice => { shown.push(notice); return 'offer-1'; }, dismiss: id => dismissed.push(id), info() {} },
  });
  await offered.datasetOpened();
  assert.equal(shown.length, 1);
  await offered.sessionRestored();
  assert.deepEqual(dismissed, ['offer-1']);
});

test('the Stored dialog lists every draft by its dataset\'s name, and removes the ones chosen; each change is heard', async () => {
  const store = mapStore();
  let heard = 0;
  const stop = onHighlightDraftsChange(() => { heard++; });
  const atlas = makeState(createCellIdentity({ nObs: 10 }));
  const atlasDraft = createHighlightDraft({ state: atlas, notifications: recorder(), datasetKey: () => 'atlas', datasetName: () => 'Lung atlas', store, ...manual() });
  atlas.addHighlightDirect({ type: 'lasso', label: 'T cells', cellIndices: Uint32Array.of(1, 2, 3) });
  atlas.addHighlightDirect({ type: 'lasso', label: 'B cells', cellIndices: Uint32Array.of(4) });
  await atlasDraft.flush();
  assert.equal(heard, 1, 'a draft written is heard');
  const pbmc = makeState(createCellIdentity({ nObs: 10 }));
  const pbmcDraft = createHighlightDraft({ state: pbmc, notifications: recorder(), datasetKey: () => 'pbmc', store, ...manual() });
  pbmc.addHighlightDirect({ type: 'lasso', label: 'Monocytes', cellIndices: Uint32Array.of(7) });
  await pbmcDraft.flush();
  store.map.set('other', { version: 0 });

  const listed = await listHighlightDrafts(store);
  assert.deepEqual(listed.map(draft => [draft.key, draft.name, draft.highlights]).sort(), [['atlas', 'Lung atlas', 2], ['pbmc', null, 1]], 'a record of another layout is not a draft');
  for (const draft of listed) {
    assert.ok(draft.bytes > 0);
    assert.ok(draft.savedAt > 0);
  }
  assert.equal(await removeHighlightDrafts(['pbmc'], store), 1);
  assert.equal(heard, 3, 'a removal is heard');
  assert.deepEqual((await listHighlightDrafts(store)).map(draft => draft.key), ['atlas']);
  assert.equal(await removeHighlightDrafts(null, store), 2, 'every record goes, the stale one too');
  assert.deepEqual(await listHighlightDrafts(store), []);
  assert.deepEqual(await listHighlightDrafts(null), [], 'no IndexedDB: nothing listed');
  assert.equal(await removeHighlightDrafts(null, null), 0);
  const failing = { entries: async () => { throw new Error('blocked'); }, delete: async () => { throw new Error('blocked'); } };
  assert.deepEqual(await listHighlightDrafts(failing), [], 'storage that fails lists nothing');
  assert.equal(await removeHighlightDrafts(['atlas'], failing), 0);
  stop();
  atlasDraft.dispose();
  pbmcDraft.dispose();
});
