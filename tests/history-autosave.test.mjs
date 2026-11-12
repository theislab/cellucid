/**
 * The history kept in this browser (`assets/js/app/history/autosave.js`,
 * `autosave-store.js`, `dataset-history.js`), History v2 §3.6, §3.7, §3.15.1
 * and §6 test 6:
 *
 * - a write costs what changed: a step writes its records and the tracker's
 *   own, never the history again; a delete writes what it changed and
 *   removes what it removed; a message writes one record;
 * - cell sets are kept in the cell-set encoding, sub-values once (parts);
 * - a history is kept, and offered again, once it holds anything of the
 *   person's (a conversation without a step included), a paused draft too;
 * - one page writes a saved state: two tabs continuing one can never mix
 *   their steps (Web Locks first, the store's writer check always), in a
 *   deterministic order of events;
 * - any removal of saved states resumes an autosave paused for room;
 * - what is read back is exactly what was kept.
 *
 * The IndexedDB database is a stand-in with the same transaction interface
 * (`tests/helpers/memory-history-database.mjs`); the browser specs run the
 * real one in three engines.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHistoryStore, SAVED_STATE_SCHEMA } from '../assets/js/app/history/autosave-store.js';
import {
  createAutosave, keepAsSavedState, keepSavedStatesWhenSpaceIsLow, keepsContent, listSavedStates, openSavedState, removeSavedStates,
  renameSavedState, savedStateLockName, savedStatesStorage,
} from '../assets/js/app/history/autosave.js';
import { HEADER, recordsHistory, user } from './helpers/history-records.mjs';
import { manualSchedule, memoryDatabase, recorder, sharedLocks } from './helpers/memory-history-database.mjs';

function clock() {
  let t = 1_700_000_000_000;
  return () => (t += 1000);
}

async function tab({ database, locks = sharedLocks(), history = null, enabled = () => true, onQuotaExceeded = () => {} } = {}) {
  const store = createHistoryStore(database);
  const writes = manualSchedule();
  const live = history ?? await recordsHistory();
  const autosave = createAutosave({
    history: live, dataset: { id: 'demo', name: 'Demo' }, store, enabled, onQuotaExceeded,
    header: async () => HEADER, schedule: writes.schedule, now: clock(), locks,
  });
  await writes.run();
  return { history: live, store, autosave, writes, locks };
}

/** The records one transaction wrote, by store. */
function lastWrite(database) {
  const writes = database.log[database.log.length - 1];
  const out = {};
  for (const [name, key] of writes) (out[name] ??= []).push(key);
  return out;
}

/** What a saved state holds, as the history would load it (every value joined). */
async function readBack(store, id) {
  const source = await openSavedState(id, store);
  const eager = await source.readEager();
  const rest = await source.readRest();
  return { source, history: eager.history, values: new Map([...eager.values, ...rest.values]) };
}

test('a history that only opened is not kept; a step, a note or a conversation is', async () => {
  const database = memoryDatabase();
  const page = await tab({ database });
  assert.equal(keepsContent(page.history.trackers()), false);
  assert.equal(page.autosave.entryId, null, 'nothing written for a history that only opened');
  page.history.note('Why this dataset');
  await page.writes.run();
  assert.notEqual(page.autosave.entryId, null);
  const [state] = await listSavedStates(page.store);
  assert.equal(state.steps, 0);
});

test('a conversation that made no step is kept and offered to continue (bug hunt: lost on reload)', async () => {
  const database = memoryDatabase();
  const before = await tab({ database });
  before.history.chat('c1', [{ role: 'user', text: 'What is in this dataset?' }, { role: 'assistant', parts: [{ type: 'text', text: '1000 cells' }] }]);
  await before.writes.run();
  const [state] = await listSavedStates(before.store);
  assert.equal(state.chats, 1);
  assert.equal(state.steps, 0);

  const after = await tab({ database });
  const notifications = recorder();
  let continued = null;
  assert.equal(await after.autosave.offerContinue({ notifications, onContinue: saved => { continued = saved; } }), state.id);
  assert.match(notifications.shown[0].message, /Continue where you left off\? .*1 conversation/);
  notifications.shown[0].action.run();
  assert.equal(continued.id, state.id);
  const { history } = await readBack(after.store, state.id);
  assert.deepEqual(history.trackers[0].chats, before.history.snapshot().trackers[0].chats);
});

test('a write costs what changed: a step writes its own records, never the history again', async () => {
  const database = memoryDatabase();
  const page = await tab({ database });
  for (let i = 1; i <= 30; i++) {
    await page.history.step({ colors: { by: `field ${i}` } });
    await page.writes.run();
  }
  const written = lastWrite(database);
  // The step and its parent, the tracker's own record, the new value, the saved state's record.
  assert.equal(written.steps.length, 2);
  assert.equal(written.trackers.length, 1);
  assert.equal(written.values.length, 1);
  assert.equal(written.entries.length, 1);
  assert.equal(written.arrays, undefined, 'arrays already kept are not written again');
  const { history, values } = await readBack(page.store, page.autosave.entryId);
  assert.deepEqual(history, page.history.snapshot());
  assert.equal(values.size, new Set(page.history.snapshot().trackers[0].steps.flatMap(step => [...Object.values(step.before), ...Object.values(step.after)])).size);
});

test('a deleted step is removed and what the delete changed rewritten; nothing else', async () => {
  const database = memoryDatabase();
  const page = await tab({ database });
  for (let i = 1; i <= 5; i++) await page.history.step({ colors: { by: `field ${i}` } });
  await page.writes.run();
  page.history.deleteHead();
  await page.writes.run();
  const written = lastWrite(database);
  assert.deepEqual(written.steps.map(key => key[2]), ['s4']);
  assert.equal(database.stores.get('steps').size, 5, 'the root and four steps');
  const { history } = await readBack(page.store, page.autosave.entryId);
  assert.deepEqual(history, page.history.snapshot());
});

test('a message added to a conversation writes that message only', async () => {
  const database = memoryDatabase();
  const page = await tab({ database });
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `message ${i}` }));
  page.history.chat('c1', messages);
  await page.writes.run();
  page.history.chat('c1', [...messages, { role: 'user', text: 'one more' }]);
  await page.writes.run();
  const written = lastWrite(database);
  assert.deepEqual(written.messages, [[page.autosave.entryId, page.history.active.id, 'c1', 40]]);
  assert.equal(written.chats.length, 1);
  // A conversation cut short drops what follows.
  page.history.chat('c1', messages.slice(0, 3));
  await page.writes.run();
  const { history } = await readBack(page.store, page.autosave.entryId);
  assert.deepEqual(history.trackers[0].chats[0][1].messages, messages.slice(0, 3));
});

test('a million-cell brush is kept in the cell-set encoding; a sub-value two values share, once', async () => {
  const database = memoryDatabase();
  const page = await tab({ database });
  const cells = Uint32Array.from({ length: 1_000_000 }, (_, i) => i).filter(i => i % 1000 !== 7);
  const genes = Array.from({ length: 2000 }, (_, i) => `GENE${i}`);
  await page.history.step({ highlights: { groups: [{ label: 'All but a few', cells }] }, analysis: { genes, run: 1 } });
  await page.history.step({ analysis: { genes, run: 2 } });
  await page.writes.run();
  const arrays = [...database.stores.get('arrays').values()];
  const brush = arrays.find(record => record.encoding === 'cell-set');
  assert.ok(brush !== undefined && brush.data.byteLength < 20_000, `kept in ${brush?.data.byteLength} bytes, raw ${cells.byteLength}`);
  assert.equal(database.stores.get('parts').size, 1, 'the gene names, once');
  const { values } = await readBack(page.store, page.autosave.entryId);
  const kept = [...values.values()].find(value => value?.groups?.[0]?.label === 'All but a few');
  assert.deepEqual(kept.groups[0].cells, cells);
});

test('a paused draft is kept with its values and offered back', async () => {
  const database = memoryDatabase();
  const before = await tab({ database });
  await before.history.step({ colors: { by: 'leiden' } });
  await before.history.pause({ colors: { by: 'while paused' }, filters: { only: 'T cells' } });
  await before.writes.run();
  const [state] = await listSavedStates(before.store);
  assert.equal(state.paused, true);
  const after = await tab({ database });
  const notifications = recorder();
  await after.autosave.offerContinue({ notifications, onContinue: () => {} });
  assert.match(notifications.shown[0].message, /changes made while paused/);
  assert.match(notifications.shown[0].message, /come back as one step/);
  const { history, values } = await readBack(after.store, state.id);
  const draft = history.trackers[0].paused.draft;
  assert.equal(values.get(draft.colors).by, 'while paused');
  assert.equal(values.get(draft.filters).only, 'T cells');
});

test('two tabs continuing one saved state: the second opens a copy (Web Locks)', async () => {
  const database = memoryDatabase();
  const locks = sharedLocks();
  const origin = await tab({ database, locks });
  for (let i = 1; i <= 3; i++) await origin.history.step({ colors: { by: `field ${i}` } });
  await origin.writes.run();
  const saved = { id: origin.autosave.entryId, createdAt: 0 };
  await origin.autosave.retire();
  assert.equal(locks.held.size, 0, 'a retired page lets its saved state go');

  const a = await tab({ database, locks });
  const b = await tab({ database, locks });
  const load = page => async () => {
    const { history, values } = await readBack(page.store, saved.id);
    for (const [hash, value] of values) page.history.pool.adopt(hash, value);
    page.history.load(history.trackers);
  };
  assert.equal(await a.autosave.continueFrom(saved, load(a)), true);
  assert.ok(locks.held.has(savedStateLockName(saved.id)));
  // B is told before it continues, and opens a copy.
  const notifications = recorder();
  await b.autosave.offerContinue({ notifications, onContinue: () => {} });
  assert.match(notifications.shown[0].message, /open in another tab/);
  assert.equal(notifications.shown[0].action.label, 'Open a copy here');
  assert.equal(await b.autosave.continueFrom(saved, load(b)), false);
  await a.history.step({ colors: { by: 'A' } });
  await b.history.step({ colors: { by: 'B' } });
  await a.writes.run();
  await b.writes.run();
  assert.equal(a.autosave.entryId, saved.id);
  assert.notEqual(b.autosave.entryId, saved.id);
  assert.deepEqual((await readBack(a.store, saved.id)).history, a.history.snapshot());
  assert.deepEqual((await readBack(b.store, b.autosave.entryId)).history, b.history.snapshot());
});

test('two tabs continuing one saved state without Web Locks never mix their steps (bug hunt P1)', async () => {
  const database = memoryDatabase();
  const noLocks = null;
  const origin = await tab({ database, locks: noLocks });
  for (let i = 1; i <= 3; i++) await origin.history.step({ colors: { by: `field ${i}` } });
  await origin.writes.run();
  const saved = { id: origin.autosave.entryId, createdAt: 0 };
  await origin.autosave.retire();
  const a = await tab({ database, locks: noLocks });
  const b = await tab({ database, locks: noLocks });
  const load = page => async () => {
    const { history, values } = await readBack(page.store, saved.id);
    for (const [hash, value] of values) page.history.pool.adopt(hash, value);
    page.history.load(history.trackers);
  };
  // The order of events is the test's: A continues and writes, B continues, A writes again, B writes.
  assert.equal(await a.autosave.continueFrom(saved, load(a)), true);
  await a.history.step({ colors: { by: 'A1' } });
  await a.writes.run();
  assert.equal(await b.autosave.continueFrom(saved, load(b)), true);
  await b.writes.run();
  await a.history.step({ colors: { by: 'A2' } });
  await a.writes.run();
  await b.history.step({ colors: { by: 'B1' } });
  await b.writes.run();
  await a.writes.run();
  // B took the saved state over whole; A keeps its own history as a copy. Each holds exactly its own steps.
  assert.equal(b.autosave.entryId, saved.id);
  assert.notEqual(a.autosave.entryId, saved.id);
  assert.deepEqual((await readBack(b.store, saved.id)).history, b.history.snapshot());
  assert.deepEqual((await readBack(a.store, a.autosave.entryId)).history, a.history.snapshot());
});

test('a write is the history at one moment: a step taken while it is written waits for the next (bug hunt: a page closed mid-write)', async () => {
  const database = memoryDatabase();
  const store = createHistoryStore(database);
  let gated = false;
  let open = null;
  const gate = new Promise(resolve => { open = resolve; });
  let reached = null;
  const atGate = new Promise(resolve => { reached = resolve; });
  // The write's records are taken, then it waits at the gate as a slow transaction would.
  const slow = { ...store, write: async batch => { if (gated) { reached(); await gate; } return store.write(batch); } };
  const writes = manualSchedule();
  const history = await recordsHistory();
  const autosave = createAutosave({
    history, dataset: { id: 'demo', name: 'Demo' }, store: slow, header: async () => HEADER, schedule: writes.schedule,
    now: clock(), locks: sharedLocks(),
  });
  for (let i = 1; i <= 3; i++) await history.step({ colors: { by: `field ${i}` } });
  await writes.run();
  gated = true;
  await history.step({ colors: { by: 'written' } });
  const writing = writes.start();
  await atGate;
  const atWrite = structuredClone(history.snapshot());
  // Taken while that write waits: its parent gains a child in place.
  await history.step({ colors: { by: 'after' } });
  open();
  await writing;
  // The page is closed before the next write: what is kept is the history as the write took it, whole.
  const { history: kept } = await readBack(store, autosave.entryId);
  assert.deepEqual(kept, atWrite);
});

test('any removal of saved states resumes an autosave paused for room (bug hunt P8)', async () => {
  const database = memoryDatabase();
  let said = 0;
  const page = await tab({ database, onQuotaExceeded: () => { said++; } });
  await page.history.step({ colors: { by: 'leiden' } });
  await page.writes.run();
  const other = await tab({ database });
  other.history.note('Another');
  await other.writes.run();
  database.failPuts('QuotaExceededError');
  await page.history.step({ colors: { by: 'louvain' } });
  await page.writes.run();
  assert.equal(page.autosave.paused, true);
  assert.equal(said, 1);
  database.failPuts(null);
  // Removed through the one removal path (as the Stored dialog and My datasets do).
  assert.equal(await removeSavedStates([other.autosave.entryId], page.store), 1);
  assert.equal(page.autosave.paused, false);
  await page.writes.run();
  assert.deepEqual((await readBack(page.store, page.autosave.entryId)).history, page.history.snapshot());
});

test('a saved state removed while it is written is written again whole, as a new one', async () => {
  const database = memoryDatabase();
  const page = await tab({ database });
  await page.history.step({ colors: { by: 'leiden' } });
  await page.writes.run();
  const first = page.autosave.entryId;
  await removeSavedStates([first], page.store);
  await page.history.step({ colors: { by: 'louvain' } });
  await page.writes.run();
  await page.writes.run();
  assert.notEqual(page.autosave.entryId, first);
  assert.deepEqual((await readBack(page.store, page.autosave.entryId)).history, page.history.snapshot());
  assert.equal(database.stores.get('steps').size, 3, 'nothing of the removed state stays');
});

test('a named save stays as it was made; renamed and removed with what only it held', async () => {
  const database = memoryDatabase();
  const page = await tab({ database });
  await page.history.step({ colors: { by: 'leiden' } });
  await page.writes.run();
  const snapshot = page.history.snapshot();
  const { id: named, steps } = await keepAsSavedState({
    history: snapshot, valueOf: hash => page.history.pool.get(hash), content: 'history', header: HEADER,
    dataset: { id: 'demo', name: 'Demo' }, name: 'Figure 2', createdAt: 1, updatedAt: 1,
  }, page.store);
  assert.equal(steps, 1);
  await page.history.step({ colors: { by: 'louvain' } });
  await page.writes.run();
  const states = await listSavedStates(page.store);
  assert.deepEqual(states.map(state => [state.kind, state.name, state.steps, state.content]).sort(), [['autosave', null, 2, 'history'], ['named', 'Figure 2', 1, 'history']]);
  assert.equal(await renameSavedState(named, 'Fig. 2', page.store), true);
  assert.equal((await listSavedStates(page.store)).find(state => state.id === named).name, 'Fig. 2');
  assert.equal(await removeSavedStates([page.autosave.entryId], page.store), 1);
  // The named save's values stay; the louvain color only the autosave held goes.
  const values = [...database.stores.get('values').values()].map(record => record.skeleton.by);
  assert.ok(values.includes('leiden') && !values.includes('louvain'));
  const { source, history } = await readBack(page.store, named);
  assert.equal(history.trackers[0].steps.length, 2);
  assert.equal(source.content, 'history');
});

test('switched off, nothing is written; a saved state of another layout is listed, never opened', async () => {
  const database = memoryDatabase();
  let on = false;
  const page = await tab({ database, enabled: () => on });
  await page.history.step({ colors: { by: 'leiden' } });
  await page.writes.run();
  assert.equal(page.autosave.entryId, null);
  on = true;
  page.autosave.resume();
  await page.writes.run();
  assert.notEqual(page.autosave.entryId, null);
  await page.store.update(page.autosave.entryId, entry => ({ ...entry, schema: SAVED_STATE_SCHEMA - 1 }));
  const [state] = await listSavedStates(page.store);
  assert.equal(state.openable, false);
  await assert.rejects(openSavedState(state.id, page.store), /another version of Cellucid/);
  assert.deepEqual(await listSavedStates(null), []);
});

test('the browser\'s figures and its promise to keep the storage, asked on demand only', async () => {
  const storage = { estimate: async () => ({ usage: 10, quota: 100 }), persisted: async () => false, persist: async () => true };
  assert.deepEqual(await savedStatesStorage({ storage }), { usage: 10, quota: 100, persisted: false });
  assert.equal(await keepSavedStatesWhenSpaceIsLow({ storage }), true);
  assert.equal(await savedStatesStorage({}), null);
  assert.equal(await keepSavedStatesWhenSpaceIsLow({}), false);
});

test('a retired autosave writes what changed with its own header, then lets its saved state go', async () => {
  const database = memoryDatabase();
  const locks = sharedLocks();
  const page = await tab({ database, locks });
  await page.history.step({ colors: { by: 'leiden' } }, { by: user });
  await page.writes.run();
  await page.history.step({ colors: { by: 'last' } });
  await page.autosave.retire();
  assert.equal(locks.held.size, 0);
  const { history } = await readBack(page.store, page.autosave.entryId);
  assert.equal(history.trackers[0].steps.length, 3);
});

/** An autosave over `store` written when the test says (independent review of H2). */
async function autosaveOver(store) {
  const writes = manualSchedule();
  const history = await recordsHistory();
  const autosave = createAutosave({
    history, dataset: { id: 'demo', name: 'Demo' }, store, header: async () => HEADER, schedule: writes.schedule,
    now: clock(), locks: sharedLocks(),
  });
  return { history, autosave, writes };
}

test('a value collected by a removal elsewhere, then shown again, is written again: the saved state still opens (review B1)', async () => {
  const store = createHistoryStore(memoryDatabase());
  const { history, autosave, writes } = await autosaveOver(store);
  await writes.run();
  await history.step({ colors: { by: 'leiden' } });
  await history.step({ colors: { by: 'louvain' } });
  await writes.run();
  history.deleteHead();
  history.deleteHead();
  await history.step({ colors: { by: 'other' } });
  await writes.run();
  // Any removal of saved states (the Stored dialog, another tab) collects what no saved state names now.
  const other = await keepAsSavedState({
    history: history.snapshot(), valueOf: hash => history.pool.get(hash), header: HEADER, dataset: { id: 'x', name: 'X' },
    name: 'old', createdAt: 1, updatedAt: 1,
  }, store);
  await removeSavedStates([other.id], store);
  // The collected value is shown again: the write that left it out as held is refused and the state written whole.
  await history.step({ colors: { by: 'leiden' } });
  await writes.run();
  await writes.run();
  const { history: kept } = await readBack(store, autosave.entryId);
  assert.deepEqual(kept, history.snapshot());
});

test('opening a named saved state keeps the work the page had in its own saved state (review B2)', async () => {
  const store = createHistoryStore(memoryDatabase());
  const { history, autosave, writes } = await autosaveOver(store);
  await history.step({ colors: { by: 'named' } });
  const named = await keepAsSavedState({
    history: history.snapshot(), valueOf: hash => history.pool.get(hash), header: HEADER, dataset: { id: 'demo', name: 'Demo' },
    name: 'Figure 1', createdAt: 1, updatedAt: 1,
  }, store);
  for (let i = 0; i < 5; i++) await history.step({ colors: { by: `work ${i}` } });
  await writes.run();
  const own = autosave.entryId;
  const { history: opened } = await readBack(store, named.id);
  history.load(opened.trackers);
  await writes.run();
  const states = await listSavedStates(store);
  assert.equal(states.find(state => state.id === own)?.steps, 6, 'the six steps the page had are kept where they were');
  assert.notEqual(autosave.entryId, own, 'what was opened is kept as a saved state of its own');
  assert.equal(states.find(state => state.id === autosave.entryId)?.steps, 1);
});

test('a saved state\'s size is what a walk of all of it counts, after steps are added and removed (review S3, §6 test 6)', async () => {
  const store = createHistoryStore(memoryDatabase());
  const { history, autosave, writes } = await autosaveOver(store);
  const walked = async () => (await keepAsSavedState({
    history: history.snapshot(), valueOf: hash => history.pool.get(hash), header: HEADER, dataset: { id: 'demo', name: 'Demo' },
    name: 'walk', createdAt: 1, updatedAt: 1,
  }, createHistoryStore(memoryDatabase()))).bytes;
  const size = async () => (await listSavedStates(store)).find(state => state.id === autosave.entryId).bytes;
  for (let i = 0; i < 6; i++) {
    await history.step({ colors: { by: `field ${i}`, pad: 'x'.repeat(2000) } });
    await writes.run();
    assert.equal(await size(), await walked(), `after step ${i + 1}`);
  }
  for (let i = 0; i < 5; i++) {
    history.deleteHead();
    await writes.run();
    assert.equal(await size(), await walked(), `after ${i + 1} removed`);
  }
  // A value shown again after its step was removed counts again.
  await history.step({ colors: { by: 'field 3', pad: 'x'.repeat(2000) } });
  await writes.run();
  assert.equal(await size(), await walked());
});

test('a saved state continued in another tab is never written over by a whole write here (review: owner on whole writes)', async () => {
  const database = memoryDatabase();
  const origin = await tab({ database, locks: null });
  await origin.history.step({ colors: { by: 'first' } });
  await origin.writes.run();
  const saved = { id: origin.autosave.entryId, createdAt: 0 };
  await origin.autosave.retire();
  const a = await tab({ database, locks: null });
  const b = await tab({ database, locks: null });
  const load = page => async () => {
    const { history, values } = await readBack(page.store, saved.id);
    for (const [hash, value] of values) page.history.pool.adopt(hash, value);
    page.history.load(history.trackers);
  };
  assert.equal(await a.autosave.continueFrom(saved, load(a)), true);
  await a.history.step({ colors: { by: 'A1' } });
  await a.writes.run();
  assert.equal(await b.autosave.continueFrom(saved, load(b)), true);
  await b.history.step({ colors: { by: 'B1' } });
  await b.writes.run();
  // A writes everything again (switched on again, room made): B's saved state stays B's.
  a.autosave.resume();
  await a.writes.run();
  await a.writes.run();
  assert.deepEqual((await readBack(b.store, saved.id)).history, b.history.snapshot());
  assert.notEqual(a.autosave.entryId, saved.id);
  assert.deepEqual((await readBack(a.store, a.autosave.entryId)).history, a.history.snapshot());
});
