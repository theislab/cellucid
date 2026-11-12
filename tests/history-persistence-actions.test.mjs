/**
 * The history's actions that write it down or read it out
 * (`assets/js/app/history/persistence-actions.js`), dispatched as the State
 * panel, an agent, Python and R dispatch them: the methods (with Cellucid's
 * citation) and the pseudocode of a branch, the saved states listed, Share
 * (a session file of what the parameters chose, downloaded) and Save (a
 * named saved state of this browser, with what it holds).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createActionCatalog } from '../assets/js/app/actions/catalog.js';
import { ActionRefused, createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { ACTION_DEFINITIONS } from '../assets/js/app/actions/definitions/index.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { providePersistenceActions } from '../assets/js/app/history/persistence-actions.js';
import { writeSharedHistory } from '../assets/js/app/session/share-scope.js';
import { readHistoryFile } from '../assets/js/app/session/history-file.js';
import { HEADER } from './helpers/history-records.mjs';

const CITATION = 'Inecik, K. (2026). Cellucid. Journal. https://doi.org/10.0/x';

async function page() {
  const domains = createDomainRegistry();
  const shown = { colors: { by: 'cell_type' } };
  for (const id of domains.missing()) {
    domains.provide(id, { capture: () => shown[id] ?? { id }, restore: value => { shown[id] = value; } });
  }
  const catalog = createActionCatalog(ACTION_DEFINITIONS);
  const dispatcher = createActionDispatcher({ catalog });
  let n = 0;
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'demo', name: 'Demo', cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  const downloads = [];
  const saves = [];
  const removed = [];
  const serializer = {
    writeShare: ({ choice }) => writeSharedHistory({
      snapshot: history.snapshot(), shown: history.shownHashes(), valueOf: hash => history.pool.get(hash), choice, header: HEADER,
      catalog, version: '0.9.7', newTrackerId: () => 't-00000000-0000-4000-8000-0000000000ff', now: 1,
    }),
  };
  const marked = [];
  const histories = {
    current: () => history,
    // The whole history written down is no longer unkept (`dataset-history.js` `markSaved`).
    markSaved: () => marked.push(history.active?.id ?? null),
    savedStates: {
      list: async () => [
        { id: 'a', kind: 'autosave', name: null, dataset: { id: 'demo', name: 'Demo' }, createdAt: 1, updatedAt: 2, steps: 3, trackers: [{ id: 't', name: 'T', steps: 3 }], bytes: 10, openable: true },
        { id: 'b', kind: 'named', name: 'Other', dataset: { id: 'other', name: 'Other' }, createdAt: 1, updatedAt: 1, steps: 1, trackers: [], bytes: 5, openable: false },
      ],
      saveAs: async (name, options) => { saves.push({ name, options }); return { id: 's1', name: name ?? 'Demo now', content: options.content, bytes: 7, steps: 2 }; },
      remove: async id => { removed.push(id); return 1; },
    },
  };
  const stop = providePersistenceActions({
    dispatcher, histories, serializer, datasetFacts: () => ({ name: 'Demo', id: 'demo', cells: 1000, genes: 5 }),
    citation: async () => CITATION, download: (blob, file) => downloads.push({ blob, file }), version: () => '0.9.7',
  });
  return { dispatcher, history, downloads, saves, removed, stop, shown, marked };
}

test('before the history starts each is refused as unavailable', async () => {
  const { dispatcher, history, stop } = await page();
  await assert.rejects(dispatcher.dispatch('history.methods', {}), error => error instanceof ActionRefused && error.code === 'unavailable');
  stop();
  history.destroy();
});

test('methods and pseudocode of a branch, main when left out, the methods naming Cellucid\'s citation', async () => {
  const { dispatcher, history, stop } = await page();
  await history.startTracker();
  const methods = (await dispatcher.dispatch('history.methods', {})).outcome;
  assert.deepEqual(methods.tracker, { id: history.active.id, name: history.active.name });
  assert.deepEqual(methods.branch, { id: 'b0', name: 'Main' });
  assert.match(methods.text, /Cellucid \(version 0\.9\.7\)/);
  assert.ok(methods.text.includes(CITATION.replace(/\.$/, '')), methods.text);
  const pseudocode = (await dispatcher.dispatch('history.pseudocode', { branch: 'main' })).outcome;
  assert.equal(pseudocode.branch.id, 'b0');
  assert.match(pseudocode.text, /^# Cellucid 0\.9\.7/);
  await assert.rejects(dispatcher.dispatch('history.methods', { branch: 'Nowhere' }), /There is no branch "Nowhere"/);
  stop();
  history.destroy();
});

test('the saved states listed, each saying whether it is of the dataset shown', async () => {
  const { dispatcher, history, stop } = await page();
  await history.startTracker();
  const { saved } = (await dispatcher.dispatch('history.saved.list', {})).outcome;
  assert.deepEqual(saved.map(state => [state.id, state.this_dataset, state.openable]), [['a', true, true], ['b', false, false]]);
  stop();
  history.destroy();
});

test('a saved state deleted by its id, through the one way saved states are removed; an unknown id names the ids there are', async () => {
  const { dispatcher, history, removed, stop } = await page();
  await history.startTracker();
  const deleted = (await dispatcher.dispatch('history.saved.delete', { saved: 'b' })).outcome;
  assert.deepEqual(deleted, { saved: 'b', name: 'Other', dataset: 'Other', steps: 1 });
  assert.deepEqual(removed, ['b']);
  await assert.rejects(
    dispatcher.dispatch('history.saved.delete', { saved: 'zz' }),
    error => error instanceof ActionRefused && error.code === 'no-target' && /the saved states are "a", "b"/.test(error.message),
  );
  assert.deepEqual(removed, ['b'], 'nothing removed for an unknown id');
  stop();
  history.destroy();
});

test('Share writes what its parameters chose and downloads it; Save keeps it in this browser', async () => {
  const { dispatcher, history, downloads, saves, stop, marked } = await page();
  await history.startTracker();
  const shared = (await dispatcher.dispatch('history.share', { content: 'state', file: 'mine.cellucid-session' })).outcome;
  assert.equal(shared.content, 'state');
  assert.equal(shared.file, 'mine.cellucid-session');
  assert.equal(shared.steps, 1);
  assert.equal(downloads[0].file, 'mine.cellucid-session');
  assert.equal(downloads[0].blob.size, shared.bytes);
  assert.deepEqual(marked, [], 'a state written down leaves the history unkept');
  const read = await readHistoryFile(downloads[0].blob);
  assert.equal(read.manifest.scope.content, 'state');
  assert.equal(read.manifest.scope.times, 'none');
  const whole = (await dispatcher.dispatch('history.share', { include: [{ tracker: history.active.name, branches: ['Main'] }] })).outcome;
  assert.equal(whole.content, 'history');
  assert.equal(downloads[1].file, 'Demo.cellucid-session');
  // Only the whole history written down marks it kept; a state alone leaves its steps unkept.
  assert.deepEqual(marked, [history.active.id]);
  assert.deepEqual(whole.trackers, [{ id: history.active.id, name: history.active.name }]);
  const kept = (await dispatcher.dispatch('history.save', { name: 'Before reclustering', content: 'steps' })).outcome;
  assert.deepEqual(kept, { saved: 's1', name: 'Before reclustering', content: 'steps', bytes: 7, steps: 2 });
  assert.deepEqual(saves[0], { name: 'Before reclustering', options: { content: 'steps', results: 'recompute' } });
  await dispatcher.dispatch('history.save', {});
  assert.deepEqual(saves[1], { name: null, options: { content: 'history', results: 'include' } });
  stop();
  history.destroy();
});
