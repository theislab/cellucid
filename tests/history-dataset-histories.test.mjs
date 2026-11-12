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
import { afterWelcome, holdStartupFor } from '../assets/js/utils/startup-sequence.js';
import { resetMemoryModel, workingSetBytes } from '../assets/js/data/memory-budget.js';
import { HEADER } from './helpers/history-records.mjs';
import { setup } from './helpers/history-fixtures.mjs';
import { memoryDatabase, recorder } from './helpers/memory-history-database.mjs';
import { until } from './helpers/settles.mjs';

const CHROME = { pressed: { 'highlight-mode': 'highlight-mode-lasso' } };

function histories() {
  const base = setup();
  const store = createHistoryStore(memoryDatabase());
  const api = createDatasetHistories({
    dispatcher: base.dispatcher, domains: base.domains, notifications: recorder(), header: async () => HEADER,
    loadSavedHistory: async () => {}, openSavedState: async () => ({ opened: true, problem: null, code: null }), store,
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
  await assert.rejects(api.savedStates.saveAs('x'), /^Error: No dataset is open\. A saved state is of a dataset's history: open its dataset first\.$/);
  await api.destroy();
});

test('a session load under way holds the offer to continue: made once it settled, and not at all when it loaded a history', async () => {
  // Found 2026-11-10: loading a session file of another dataset opened that dataset, which offered
  // "Continue where you left off?" in the middle of the load; the offer went once the session landed.
  const { api, dispatcher, store } = histories();
  const first = api.open({ id: 'demo', name: 'Demo' });
  await api.begin(first);
  await dispatcher.dispatch('color.by', { field: 'leiden' });
  await api.flush();
  // The tab that kept it is closed; a later page opens the same dataset.
  await api.destroy();
  const notifications = recorder();
  const base = setup();
  const later = createDatasetHistories({
    dispatcher: base.dispatcher, domains: base.domains, notifications, header: async () => HEADER,
    loadSavedHistory: async () => {}, openSavedState: async () => ({ opened: true, problem: null, code: null }), store,
    chrome: { capture: () => CHROME }, version: () => '0.9.7',
  });
  const continued = notice => /Continue where you left off/.test(notice.message ?? '');

  // A load that loads no history (refused, canceled): the offer comes once it settled.
  let settle;
  later.holdOffersUntil(new Promise(resolve => { settle = resolve; }));
  const second = later.open({ id: 'demo', name: 'Demo' });
  // The opening never waits for the load: the load waits for the opening it caused (a wait here deadlocked the app).
  const begun = later.begin(second);
  const returned = await Promise.race([begun.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 200))]);
  assert.equal(returned, true, 'begin returns while a session load holds the offer');
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(notifications.shown.filter(continued).length, 0, 'nothing offered while the load is under way');
  settle();
  await until(() => notifications.shown.filter(continued).length > 0, 'the offer once the load settled');
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(notifications.shown.filter(continued).length, 1, 'offered once it settled');

  // A load that puts a history in place: no offer.
  notifications.shown.length = 0;
  const saved = (await listSavedStates(store)).find(entry => entry.kind === 'autosave' && entry.steps > 0);
  let loadDone;
  later.holdOffersUntil(new Promise(resolve => { loadDone = resolve; }));
  const third = later.open({ id: 'demo', name: 'Demo' });
  const begun3 = later.begin(third);
  const source = await openSavedState(saved.id, store);
  const eager = await source.readEager();
  await third.load(eager.history, { values: eager.values, rest: () => source.readRest() });
  loadDone();
  await begun3;
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(notifications.shown.filter(continued).length, 0, 'the person chose the history shown');
  assert.throws(() => later.holdOffersUntil(null), /needs a promise/);
  await later.destroy();
});

test('the welcome comes first: "Continue where you left off?" is offered once it is closed, never on top of it (R9U-14)', async () => {
  const { api, dispatcher, store } = histories();
  const first = api.open({ id: 'demo', name: 'Demo' });
  await api.begin(first);
  await dispatcher.dispatch('color.by', { field: 'leiden' });
  await api.flush();
  await api.destroy();
  const notifications = recorder();
  const base = setup();
  const later = createDatasetHistories({
    dispatcher: base.dispatcher, domains: base.domains, notifications, header: async () => HEADER,
    loadSavedHistory: async () => {}, openSavedState: async () => ({ opened: true, problem: null, code: null }), store,
    chrome: { capture: () => CHROME }, version: () => '0.9.7',
  });
  const continued = notice => /Continue where you left off/.test(notice.message ?? '');
  let close;
  holdStartupFor(new Promise(resolve => { close = resolve; }));
  const second = later.open({ id: 'demo', name: 'Demo' });
  await later.begin(second);
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(notifications.shown.filter(continued).length, 0, 'nothing offered while the welcome is up');
  close();
  await until(() => notifications.shown.filter(continued).length > 0, 'the offer once the welcome closed');
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(notifications.shown.filter(continued).length, 1, 'offered once the welcome closed');
  // With no welcome up, nothing waits.
  assert.equal(await Promise.race([afterWelcome().then(() => 'now'), new Promise(resolve => setImmediate(() => resolve('later')))]), 'now');
  await later.destroy();
});

test('a saved state is listed with its latest step, which tells autosaves apart in Load…', async () => {
  // Found 2026-11-10: Load… listed nine rows all reading "Autosave [Auto]".
  const { api, dispatcher, store } = histories();
  const history = api.open({ id: 'demo', name: 'Demo' });
  await api.begin(history);
  await dispatcher.dispatch('highlight.cells', { label: 'T', cells: Uint32Array.of(1, 2) });
  await dispatcher.dispatch('color.by', { field: 'leiden' });
  await api.flush();
  const latest = [...history.active.steps.values()].at(-1).label;
  const autosave = (await listSavedStates(store)).find(entry => entry.kind === 'autosave');
  assert.equal(autosave.lastStep, latest);
  assert.match(latest, /leiden/);
  await api.destroy();
});

test('a starting view puts back what its keepShown leaves, read from what is shown before it', async () => {
  resetMemoryModel();
  const { api } = histories();
  const history = api.open({ id: 'demo', name: 'Demo' });
  const seen = [];
  await history.showValues({ colors: { by: 'starting view', scale: new Float64Array(2) } }, (values, shownOf) => {
    seen.push(shownOf('colors').by);
    return { colors: { ...values.colors, by: 'kept as shown' } };
  });
  await api.begin(history);
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0], 'starting view', 'read before the starting view is shown');
  assert.equal(history.shownValue('colors').by, 'kept as shown');
});

test('Continue on a saved state kept by an earlier version restores every part it can and keeps that saved state as it was (F155)', async () => {
  // Live pass 6: an autosave kept minutes before a rename of a domain's value (F149) failed whole on
  // Continue, and the views and the conversation went with the one part this version could not read.
  const { api, dispatcher, store } = histories();
  const first = api.open({ id: 'demo', name: 'Demo' });
  await api.begin(first);
  await dispatcher.dispatch('highlight.cells', { label: 'T', cells: Uint32Array.of(1, 2, 3) });
  await dispatcher.dispatch('color.by', { field: 'leiden' });
  first.setChat(first.active.id, 'c-1', { messages: [{ role: 'user', text: 'Which cluster is CD8?' }] });
  await api.flush();
  await api.destroy();
  const kept = (await listSavedStates(store)).find(entry => entry.kind === 'autosave' && entry.steps > 0);
  const keptSteps = kept.steps;

  // This version: the colors' owner reads another shape, as the Expression values' owner after the rename.
  const base = setup();
  const colorsOwner = base.domains.owner('colors');
  const refusing = {
    ...colorsOwner,
    restore: value => {
      if (value.by === 'leiden') throw new TypeError('The colors to restore is exactly {field, scale}');
      return colorsOwner.restore(value);
    },
  };
  const domains = { ...base.domains, owner: id => (id === 'colors' ? refusing : base.domains.owner(id)), has: id => base.domains.has(id) };
  const results = [];
  let later;
  later = createDatasetHistories({
    dispatcher: base.dispatcher, domains, notifications: recorder(), header: async () => HEADER,
    loadSavedHistory: async open => {
      const source = await open();
      const eager = await source.readEager();
      results.push(await later.current().load(eager.history, { values: eager.values, rest: () => source.readRest() }));
    },
    openSavedState: async () => ({ opened: true, problem: null, code: null }), store,
    chrome: { capture: () => CHROME }, version: () => '0.9.8',
  });
  const shown = later.open({ id: 'demo', name: 'Demo' });
  await later.begin(shown);
  await later.loadSaved(await openSavedState(kept.id, store));
  assert.deepEqual(results[0].unrestored.map(part => part.domain), ['colors']);
  assert.equal(base.state.highlights.groups.length, 1, 'the highlights are restored');
  assert.equal(base.state.colors.by, 'cell_type', 'the part not read is left as shown');
  assert.deepEqual(shown.chatsOf(shown.active.id).map(([id]) => id), ['c-1'], 'the conversation is kept');
  // The listing counts steps after the root: the root, its steps, and the gap as a step of its own.
  assert.equal(shown.active.steps.size, 1 + keptSteps + 1, 'its steps, and the gap as a step of its own');
  await later.flush();
  // The saved state continued is not written into: it keeps every part as it was; the history goes on beside it.
  const after = await listSavedStates(store);
  assert.equal(after.find(entry => entry.id === kept.id).steps, keptSteps);
  assert.ok(after.some(entry => entry.kind === 'autosave' && entry.id !== kept.id && entry.steps === keptSteps + 1));
  await later.destroy();
});
