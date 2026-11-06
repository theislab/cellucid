/**
 * The dataset's history from its opening to its replacement
 * (`assets/js/app/history/dataset-history.js`), over the real history and a
 * stand-in IndexedDB: begun after its starting view, kept in this browser
 * with the page chrome outside the history, named saves of each content
 * (the whole history, the current state only, the steps only) kept beside
 * the autosave and read back, History settings fed to the history, retired
 * before another dataset; its values count in memory.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHistoryStore } from '../assets/js/app/history/autosave-store.js';
import { listSavedStates, openSavedState } from '../assets/js/app/history/autosave.js';
import { createDatasetHistories } from '../assets/js/app/history/dataset-history.js';
import { resetMemoryModel, workingSetBytes } from '../assets/js/data/memory-budget.js';
import { HEADER } from './helpers/history-records.mjs';
import { setup } from './helpers/history-fixtures.mjs';
import { memoryDatabase, recorder } from './helpers/memory-history-database.mjs';

const CHROME = { pressed: { 'highlight-mode': 'highlight-mode-lasso' } };

function histories() {
  const base = setup();
  const store = createHistoryStore(memoryDatabase());
  const api = createDatasetHistories({
    dispatcher: base.dispatcher, domains: base.domains, notifications: recorder(), header: async () => HEADER,
    loadSavedHistory: async () => {}, openSavedState: async () => true, store,
    chrome: { capture: () => CHROME }, version: () => '0.9.7',
  });
  return { ...base, api, store };
}

test('named saves of each content are kept beside the autosave, with the page chrome and what wrote them', async () => {
  resetMemoryModel();
  const { api, dispatcher, store } = histories();
  const history = api.open({ id: 'demo', name: 'Demo' });
  await history.showValues({ colors: { by: 'starting view', scale: new Float64Array(2) } });
  await api.begin(history);
  assert.equal(history.active.steps.size, 1);
  await dispatcher.dispatch('highlight.cells', { label: 'T', cells: Uint32Array.from({ length: 1000 }, (_, i) => i) });
  await dispatcher.dispatch('color.by', { field: 'leiden' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(workingSetBytes() >= 4000, `the pool's cells count: ${workingSetBytes()}`);
  const whole = await api.savedStates.saveAs('Whole');
  const state = await api.savedStates.saveAs('State', { content: 'state' });
  const steps = await api.savedStates.saveAs(null, { content: 'steps' });
  assert.deepEqual([whole.content, state.content, steps.content], ['history', 'state', 'steps']);
  assert.match(steps.name, /^Demo /);
  const listed = await listSavedStates(store);
  assert.deepEqual(listed.filter(entry => entry.kind === 'named').map(entry => [entry.name, entry.content]).sort(),
    [['State', 'state'], ['Whole', 'history'], [steps.name, 'steps']].sort());
  for (const saved of [whole, state, steps]) {
    const source = await openSavedState(saved.id, store);
    assert.deepEqual(source.chrome, CHROME);
    assert.equal(source.stamps.app.version, '0.9.7');
    assert.equal(source.content, saved.content);
    const eager = await source.readEager();
    if (saved.content === 'state') assert.equal(eager.history.trackers[0].steps.length, 2);
    if (saved.content === 'history') assert.equal(eager.history.trackers[0].steps.length, 3);
  }
  await api.flush();
  const autosave = (await listSavedStates(store)).find(entry => entry.kind === 'autosave');
  assert.deepEqual((await openSavedState(autosave.id, store)).chrome, CHROME);
  await api.destroy();
  assert.equal(workingSetBytes(), 0);
  resetMemoryModel();
});

test('a save needs a dataset open', async () => {
  const { api } = histories();
  await assert.rejects(api.savedStates.saveAs('x'), /Open a dataset first/);
  await api.destroy();
});
