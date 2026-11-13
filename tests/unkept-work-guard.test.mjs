/**
 * Work on the dataset shown that this browser is not keeping is never lost
 * without a question (with Autosave off, opening another dataset, a reload
 * or a closed tab would drop every step without a word).
 *
 * - `DatasetHistories.unkept()` says what would be lost: steps made since the
 *   last save while the autosave is not keeping them (off, no storage, no
 *   room); nothing while it keeps them, after a whole-history save, or with
 *   only the opening step.
 * - The guard (`app/unkept-work-guard.js`) asks the person (Save…, Open
 *   anyway, Cancel), or, for an agent's opening, the agent's consent path;
 *   declined, the change ends as a cancellation. `beforeunload` asks only
 *   while work is unkept.
 * - Every path that replaces the dataset passes the one guard
 *   (`app/main.js`), the agent's openings ask with the kind
 *   `replaces-unkept`, and saving a whole session file counts as saved.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { createHistoryStore } from '../assets/js/app/history/autosave-store.js';
import { createDatasetHistories, workStepsOf } from '../assets/js/app/history/dataset-history.js';
import { setHistorySetting } from '../assets/js/app/history/history-settings.js';
import { createUnkeptWorkGuard, setAgentReplacementAsk, unkeptWorkSentence } from '../assets/js/app/unkept-work-guard.js';
import { createActionDispatcher, ActionRefused } from '../assets/js/app/actions/dispatcher.js';
import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { isCancellation } from '../assets/js/utils/abort.js';
import { plainSentence } from '../assets/js/app/actions/targets/names.js';
import { HEADER } from './helpers/history-records.mjs';
import { setup } from './helpers/history-fixtures.mjs';
import { memoryDatabase, recorder } from './helpers/memory-history-database.mjs';

const source = file => readFileSync(new URL(`../assets/js/${file}`, import.meta.url), 'utf8');

function memoryStorage() {
  const items = new Map();
  return { getItem: key => items.get(key) ?? null, setItem: (key, value) => { items.set(key, String(value)); }, removeItem: key => { items.delete(key); } };
}

async function shownHistory(store) {
  const base = setup();
  const api = createDatasetHistories({
    dispatcher: base.dispatcher, domains: base.domains, notifications: recorder(), header: async () => HEADER,
    loadSavedHistory: async () => {}, openSavedState: async () => ({ opened: true, problem: null, code: null }), store,
    version: () => '0.9.8',
  });
  const history = api.open({ id: 'pancreas', name: 'Pancreas' });
  await api.begin(history);
  return { ...base, api, history };
}

test('unkept(): steps made while the autosave keeps nothing; none while it keeps them, after a whole save, or with only the opening', async t => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  t.after(() => { globalThis.localStorage = previous; });

  // Autosave on, a store: kept.
  const kept = await shownHistory(createHistoryStore(memoryDatabase()));
  await kept.dispatcher.dispatch('color.by', { field: 'leiden' });
  assert.equal(kept.api.unkept(), null);
  await kept.api.destroy();

  // Autosave off.
  setHistorySetting('autosave', false);
  const off = await shownHistory(createHistoryStore(memoryDatabase()));
  assert.equal(off.api.unkept(), null, 'only the opening: nothing to lose');
  await off.dispatcher.dispatch('color.by', { field: 'leiden' });
  await off.dispatcher.dispatch('color.by', { field: 'louvain' });
  assert.deepEqual(off.api.unkept(), { dataset: 'Pancreas', steps: 2, why: 'off' });
  // A whole-history save in this browser keeps them; a later step is unkept again.
  await off.api.savedStates.saveAs('Before more');
  assert.equal(off.api.unkept(), null);
  await off.dispatcher.dispatch('color.by', { field: 'cell_type' });
  assert.equal(off.api.unkept()?.why, 'off');
  // The current state only is not the history.
  await off.api.savedStates.saveAs('State', { content: 'state' });
  assert.notEqual(off.api.unkept(), null);
  // A session file written of the whole history (`history.share`): saved.
  off.api.markSaved();
  assert.equal(off.api.unkept(), null);
  await off.api.destroy();
  setHistorySetting('autosave', true);

  // A browser that keeps nothing for the site (no IndexedDB).
  const none = await shownHistory(null);
  await none.dispatcher.dispatch('color.by', { field: 'leiden' });
  assert.equal(none.api.unkept()?.why, 'unavailable');
  await none.api.destroy();
  assert.equal(none.api.unkept(), null, 'no dataset shown');
});

test('the person is asked: Open anyway goes on, Cancel and Save… keep the dataset shown', async () => {
  const work = { dataset: 'Pancreas', steps: 4, why: 'off' };
  assert.equal(plainSentence(unkeptWorkSentence(work)), 'The 4 steps on "Pancreas" are not kept: Autosave in this browser is off.');
  assert.equal(plainSentence(unkeptWorkSentence({ dataset: null, steps: 1, why: 'unavailable' })), 'The step is not kept: this browser keeps nothing for this site.');
  const asked = [];
  let saved = 0;
  let answer = 'open';
  let unkept = work;
  const guard = createUnkeptWorkGuard({
    unkept: () => unkept,
    ask: async question => { asked.push(question); return answer; },
    save: () => { saved += 1; },
  });
  await guard.confirmReplacement({ to: 'Garcia' });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].message, 'The 4 steps on "Pancreas" are not kept: Autosave in this browser is off. Opening "Garcia" replaces it.');
  answer = 'cancel';
  await assert.rejects(guard.confirmReplacement({ to: 'Garcia' }), isCancellation);
  answer = 'save';
  await assert.rejects(guard.confirmReplacement({ closing: true }), isCancellation);
  assert.equal(saved, 1, 'Save… opens the Save file dialog');
  assert.match(asked.at(-1).message, /Closing the dataset replaces it\.$/);
  // Nothing unkept: nobody is asked.
  unkept = null;
  await guard.confirmReplacement({ to: null });
  assert.equal(asked.length, 3);
});

test('an agent\'s opening asks through its consent path, never the page dialog', async () => {
  const sentences = [];
  let allow = true;
  const remove = setAgentReplacementAsk(() => async text => {
    sentences.push(text);
    if (!allow) throw new ActionRefused('The person declined.', { code: 'declined' });
  });
  try {
    assert.throws(() => setAgentReplacementAsk(() => null), /set already/);
    const guard = createUnkeptWorkGuard({
      unkept: () => ({ dataset: 'Pancreas', steps: 1, why: 'room' }),
      ask: async () => assert.fail('the page dialog is not shown for an agent'),
      save: () => assert.fail('nothing is saved for an agent'),
    });
    await guard.confirmReplacement({ to: 'He' });
    assert.deepEqual(sentences.map(plainSentence), ['Opening "He" replaces the dataset shown. The step on "Pancreas" is not kept: this browser has no room left to keep it.']);
    allow = false;
    await assert.rejects(guard.confirmReplacement({ to: 'He' }), isCancellation);
  } finally {
    remove();
  }
});

test('leaving the page asks only while work is unkept', () => {
  let unkept = null;
  const guard = createUnkeptWorkGuard({ unkept: () => unkept, ask: async () => 'open', save: () => {} });
  const event = () => ({ prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } });
  const quiet = event();
  guard.onBeforeUnload(quiet);
  assert.equal(quiet.prevented, false);
  unkept = { dataset: null, steps: 3, why: 'off' };
  const asking = event();
  guard.onBeforeUnload(asking);
  assert.equal(asking.prevented, true);
  assert.equal(asking.returnValue, '');
});

test('the dispatcher asks an agent with the kind replaces-unkept, only for an action that replaces the dataset', async () => {
  const OPEN = defineAction({
    type: 't.open', title: 'Open', summary: 'Opens a dataset.', group: 'T',
    params: { type: 'object', additionalProperties: false, properties: {} },
    reads: [], effect: 'dataset', confirm: 'large-download', confirmAt: 'handler', describe: () => 'open', code: () => 'open()',
  });
  const SET = defineAction({
    type: 't.set', title: 'Set', summary: 'Sets.', group: 'T',
    params: { type: 'object', additionalProperties: false, properties: {} },
    touches: ['filters'], reads: [], effect: 'state', describe: () => 'set', code: () => 'set()',
  });
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([OPEN, SET]) });
  const asked = [];
  // The change itself is allowed at its start; what is lost is asked of its own kind.
  dispatcher.setConfirmer(async ({ confirm, detail, stage }) => {
    if (stage === 'start') return true;
    asked.push([confirm, detail]);
    return false;
  });
  dispatcher.provide('t.open', async (_params, { confirmReplacing }) => { await confirmReplacing('The 2 steps are not kept.'); });
  dispatcher.provide('t.set', async (_params, { confirmReplacing }) => { await confirmReplacing('x'); });
  const AGENT = { origin: 'agent', agent: 'Claude' };
  await assert.rejects(dispatcher.dispatch('t.open', {}, AGENT), error => error.code === 'declined');
  assert.deepEqual(asked, [['replaces-unkept', 'The 2 steps are not kept.']]);
  await assert.rejects(dispatcher.dispatch('t.set', {}, AGENT), /does not replace the dataset shown/);
  // The person's own opening is asked in the page, not here.
  await dispatcher.dispatch('t.open', {});
  assert.equal(asked.length, 1);
});

test('every path that replaces the dataset passes the one guard; the page asks before it is left', () => {
  const main = source('app/main.js');
  // Every opening (sample, My datasets, file, link, server, catalog, session of another dataset,
  // dataset.open) is a reload in place; None clears; the benchmark replaces it too.
  const changes = source('app/dataset/reload.js');
  assert.match(changes, /if \(!isStartupLoad && loadMethod !== DATA_LOAD_METHODS\.SUBSAMPLE\) \{\s*step\('Asking before the dataset shown is replaced'\);\s*await confirmDatasetReplacement\(reloadTransaction, \{ to: datasetName \}\);/);
  assert.match(changes, /async function clearActiveDatasetInPlace\(reloadTransaction\) \{\s*requireDatasetChangeTransaction\(reloadTransaction\);\s*reloadTransaction\.assertCurrent\(\);\s*await confirmDatasetReplacement\(reloadTransaction, \{ closing: true \}\);/);
  assert.match(source('app/ui/modules/benchmark/benchmark-controls.js'), /const syntheticTransaction = datasetReloadCoordinator\.begin\(\);\s*try \{\s*try \{\s*await confirmDatasetReplacement\(syntheticTransaction, \{\}\);/);
  assert.match(main, /window\.addEventListener\('beforeunload', warnBeforeLeavingUnkeptWork\);/);
  assert.match(main, /window\.removeEventListener\('beforeunload', warnBeforeLeavingUnkeptWork\);/);
  const open = source('app/ui/modules/dataset-open-action.js');
  assert.match(open, /setAgentReplacementAsk\(/);
  assert.match(open, /await owner\.confirmReplacing\(text\);/);
  assert.match(source('app/history/persistence-actions.js'), /if \(shared\.scope\.content === 'history'\) histories\.markSaved\(\);/);
  assert.match(source('app/actions/dispatcher.js'), /kind: 'replaces-unkept'/);
  // Kept by the person (Cancel here, or the opening's Cancel), a choice says no "newer selection".
  assert.doesNotMatch(source('app/ui/modules/dataset-controls.js'), /A newer dataset selection is now active/);
});

test('a step that only arranged the page (layout alone) is no work to lose; any other step is', () => {
  const step = (id, parent, after) => [id, { id, parent, after }];
  const tracker = { steps: new Map([
    step('s0', null, { layout: 'h0', colors: 'h1' }),
    step('s1', 's0', { layout: 'h2' }),
    step('s2', 's1', { colors: 'h3' }),
    step('s3', 's2', { layout: 'h4', analysis: 'h5' }),
  ]) };
  assert.equal(workStepsOf(tracker), 2);
  assert.equal(workStepsOf({ steps: new Map([step('s0', null, {}), step('s1', 's0', { layout: 'h' })]) }), 0);
});
