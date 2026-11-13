/**
 * The history's actions (`assets/js/app/actions/definitions/history.js`):
 * every operation on the history is one catalog action, with the effect,
 * the confirmation and the parameters the history model fixes, so the State panel,
 * agents, Python and R take one path, and every one has a provider: the
 * history (`history.js`) or its persistence (`persistence-actions.js`). Also
 * the `reads` field every definition declares (`catalog.js`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTION_READ_INPUTS, catalogDocument, createActionCatalog, defineAction, isSteplessEffect,
} from '../assets/js/app/actions/catalog.js';
import { ActionRefused, createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { DOMAIN_IDS, createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { exampleOf, schemaProblem, withDefaults } from '../assets/js/app/actions/schema.js';
import { ACTION_DEFINITIONS } from '../assets/js/app/actions/definitions/index.js';
import {
  HISTORY_PAGE_STEPS, historyActions, shareScopeOf,
} from '../assets/js/app/actions/definitions/history.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { providePersistenceActions } from '../assets/js/app/history/persistence-actions.js';
import { provideAnnDataCopyAction } from '../assets/js/app/history/anndata-copy-save.js';
import {
  BY_ORIGINS, JOURNAL_OPS, REPLAY_OUTCOMES, SHARE_CONTENTS, SHARE_RESULTS, SQUASH_CAUSES, STEP_KINDS, recordFields,
} from '../assets/js/app/history/model.js';

/** Every history action: [effect, confirm]. The table of effects and confirmations, as frozen. */
const EXPECTED = Object.freeze({
  'history.get': ['read', null],
  'history.summary': ['read', null],
  'history.step': ['read', null],
  'history.diff': ['read', null],
  'history.stale': ['read', null],
  'history.search': ['read', null],
  'history.methods': ['read', null],
  'history.pseudocode': ['read', null],
  'history.saved.list': ['read', null],
  'history.undo': ['history', null],
  'history.redo': ['history', null],
  'history.jump': ['history', null],
  'history.branch.switch': ['history', null],
  'history.branch.create': ['history', null],
  'history.branch.cancel': ['history', null],
  'history.branch.rename': ['history', null],
  'history.branch.archive': ['history', null],
  'history.branch.set-main': ['history', null],
  'history.branch.lock': ['history', null],
  'history.branch.delete': ['history', 'deletes-saved'],
  'history.branch.without': ['history', null],
  'history.branch.apply': ['history', null],
  'history.verify': ['history', null],
  'history.step.delete': ['history', 'deletes-saved'],
  'history.step.revert': ['state', null],
  'history.squash': ['history', 'deletes-saved'],
  'history.clear': ['history', 'deletes-saved'],
  'history.recording.pause': ['history', 'pauses-recording'],
  'history.recording.resume': ['history', null],
  'history.group.create': ['history', null],
  'history.group.rename': ['history', null],
  'history.group.extend': ['history', null],
  'history.group.remove': ['history', null],
  'history.note.add': ['history', null],
  'history.note.edit': ['history', null],
  'history.note.remove': ['history', null],
  'history.bookmark.set': ['history', null],
  'history.tracker.start': ['history', null],
  'history.tracker.use': ['history', null],
  'history.tracker.rename': ['history', null],
  'history.tracker.remove': ['history', 'deletes-saved'],
  'history.turn.undo': ['history', null],
  'history.journal.undo': ['history', null],
  'history.journal.empty': ['history', 'deletes-saved'],
  'history.replay': ['history', null],
  'history.share': ['outside', 'writes-file'],
  'history.saved.delete': ['outside', 'deletes-saved'],
  // Load…'s Open: its dataset first, then its history (a whole-file download asked).
  'history.saved.open': ['dataset', 'large-download'],
  'history.save': ['outside', null],
  'history.anndata.save': ['outside', 'writes-file'],
  'history.report': ['outside', 'writes-file'],
  'history.tour.start': ['history', null],
  'history.tour.stop': ['history', null],
});

/**
 * The history actions its persistence provides (the texts, the saved states,
 * Share, Save; and the AnnData copy, `anndata-copy-save.js`); the history
 * provides every other but the panel's.
 */
const PERSISTENCE = Object.freeze(['history.methods', 'history.pseudocode', 'history.saved.list', 'history.saved.delete', 'history.share', 'history.save', 'history.anndata.save']);
/** The history actions the State panel provides (`ui/modules/state/index.js`: the tour and the report, made by its own code). */
const PANEL = Object.freeze(['history.report', 'history.tour.start', 'history.tour.stop']);
/** The history action the dataset opening provides (`ui/modules/dataset-open-action.js`: its download gate and opening). */
const DATASET_OPENING = Object.freeze(['history.saved.open']);
/**
 * The actions asked about by their implementation once it knows what it does
 * (a report as text writes no file; a saved state's dataset downloaded whole only when its host serves no parts).
 */
const ASKED_BY_HANDLER = Object.freeze(['history.report', 'history.saved.open']);

test('every operation on the history is one action, with the effect and the confirmation the history model fixes', () => {
  const catalog = createActionCatalog(ACTION_DEFINITIONS);
  const history = catalog.list().filter(definition => definition.type.startsWith('history.'));
  assert.deepEqual(history.map(d => d.type).sort(), Object.keys(EXPECTED).sort());
  assert.deepEqual(historyActions.map(d => d.type).sort(), Object.keys(EXPECTED).sort(), 'all defined in definitions/history.js');
  for (const definition of history) {
    const [effect, confirm] = EXPECTED[definition.type];
    assert.equal(definition.effect, effect, `${definition.type} effect`);
    assert.equal(definition.confirm, confirm, `${definition.type} confirm`);
    assert.equal(definition.confirmAt, ASKED_BY_HANDLER.includes(definition.type) ? 'handler' : 'start', `${definition.type} asks when it is known what it does`);
    assert.equal(definition.group, 'History', definition.type);
    if (definition.type === 'history.step.revert') {
      assert.deepEqual(definition.touches, DOMAIN_IDS, 'a revert may put back any domain; the recorder keeps those that changed');
      assert.equal(definition.result, null);
    } else {
      assert.deepEqual(definition.touches, [], `${definition.type} records no step`);
      assert.notEqual(definition.result, null, `${definition.type} says what it answers`);
    }
    const example = exampleOf(definition.params);
    assert.equal(schemaProblem(definition.params, example), null, `${definition.type} example`);
    if (definition.result !== null) assert.equal(definition.result.type, 'object', `${definition.type} answers a record`);
  }
});

test('the journal keeps exactly the edits of the history, each by its action\'s type', () => {
  const catalog = createActionCatalog(ACTION_DEFINITIONS);
  // A tracker loaded beside the others from a file (Load, `session-serializer.js`) is journaled with no action of
  // the history: `load`, undone by removing the tracker (`history.journal.undo`).
  assert.equal(catalog.has('history.load'), false);
  for (const op of JOURNAL_OPS.filter(each => each !== 'load')) {
    const definition = catalog.get(`history.${op}`);
    assert.equal(definition.effect, 'history', `${op} is an edit of the history, not a state step`);
  }
  const reads = Object.entries(EXPECTED).filter(([, [effect]]) => effect === 'read').map(([type]) => type.slice('history.'.length));
  assert.deepEqual(JOURNAL_OPS.filter(op => reads.includes(op)), [], 'a read edits nothing');
  const deletes = Object.entries(EXPECTED).filter(([, [, confirm]]) => confirm === 'deletes-saved').map(([type]) => type);
  assert.deepEqual(Object.entries(EXPECTED).filter(([, [, confirm]]) => confirm === 'pauses-recording').map(([type]) => type), ['history.recording.pause'],
    'pausing is asked of an agent (its changes cannot be undone on their own meanwhile); resuming never');
  assert.deepEqual(deletes.sort(), [
    'history.branch.delete', 'history.clear', 'history.journal.empty', 'history.saved.delete', 'history.squash', 'history.step.delete', 'history.tracker.remove',
  ]);
});

test('parameters name branches and trackers by name or id, steps, notes and entries by id', () => {
  const catalog = createActionCatalog(ACTION_DEFINITIONS);
  const ok = (type, params) => assert.equal(schemaProblem(catalog.get(type).params, params), null, `${type} ${JSON.stringify(params)}`);
  const no = (type, params) => assert.notEqual(schemaProblem(catalog.get(type).params, params), null, `${type} ${JSON.stringify(params)}`);
  ok('history.branch.rename', { branch: 'b2', name: 'Without alpha' });
  ok('history.branch.rename', { branch: 'Without alpha', name: 'Alpha gone', tracker: 'Tracker 2' });
  no('history.branch.rename', { branch: '', name: 'x' });
  no('history.branch.rename', { branch: 'b2' });
  ok('history.step.delete', { step: 's12' });
  no('history.step.delete', { step: 'S12' });
  no('history.step.delete', { step: 's012' });
  no('history.step.delete', { step: 's1', tracker: 'Tracker 1' });
  ok('history.note.edit', { note: 'n4', text: 'Edited.' });
  no('history.note.edit', { note: 'note 4', text: 'Edited.' });
  ok('history.journal.undo', { entry: 'j2', tracker: 't-00000000-0000-4000-8000-000000000001' });
  no('history.journal.undo', { entry: 'j-2' });
  ok('history.journal.empty', {});
  for (const target of [{ step: 's3' }, { step: 's3', tracker: 'Tracker 2' }, { branch: 'Main' }, { turn: 'turn-1' }, { tracker: 'Tracker 1' }]) {
    ok('history.note.add', { target, text: 'A note.' });
  }
  no('history.note.add', { target: {}, text: 'A note.' });
  no('history.note.add', { target: { step: 's3', branch: 'Main' }, text: 'A note.' });
  no('history.note.add', { target: { step: 's3' }, text: '' });
  ok('history.bookmark.set', { step: 's3', name: null });
  no('history.bookmark.set', { step: 's3', name: '' });
  ok('history.diff', { a: { step: 's1' }, b: { step: 's1', tracker: 'Tracker 2' } });
  ok('history.replay', {
    saved: 'state-1', branch: 'Main',
    mapping: { fields: [{ from: 'leiden', to: 'louvain' }], categories: [{ field: 'cell_type', from: 'T cells', to: 'CD4 T' }], genes: [] },
  });
  no('history.replay', { saved: 'state-1', mapping: { fields: [] } });
  ok('history.search', { text: 'alpha', by: 'agent', kind: 'state', domain: 'filters', has_note: true, bookmarked: false, flagged: true });
  no('history.search', { by: 'claude' });
  // Groups, squash, clear, the recording switch, what a share or a save holds.
  ok('history.group.create', { from: 's4', to: 's9', name: 'QC' });
  no('history.group.create', { from: 's4', to: 's9' });
  ok('history.group.rename', { group: 'g1', name: 'Clustering' });
  ok('history.group.rename', { group: 'QC', name: 'Clustering', tracker: 'Tracker 2' });
  ok('history.group.extend', { group: 'QC', to: 's12' });
  ok('history.group.remove', { group: 'QC' });
  ok('history.note.add', { target: { group: 'QC' }, text: 'A note.' });
  ok('history.squash', { from: 's4', to: 's9' });
  no('history.squash', { first: 's4', last: 's9' });
  ok('history.clear', { keep_state: true });
  no('history.clear', {});
  ok('history.recording.pause', {});
  ok('history.recording.resume', { tracker: 'Tracker 1' });
  no('history.recording.pause', { on: false });
  ok('history.get', { limit: 50, cursor: 's200', all_branches: true });
  no('history.get', { limit: 0 });
  ok('history.search', { step_kind: 'squashed' });
  no('history.search', { step_kind: 'merged' });
  ok('history.share', { include: [{ tracker: 'Tracker 1', branches: ['Main', 'Without alpha'] }], content: 'state', results: 'recompute', times: 'none' });
  no('history.share', { include: [] });
  no('history.share', { content: 'everything' });
  ok('history.save', { name: 'Before reclustering', content: 'steps', results: 'recompute' });
  assert.deepEqual(withDefaults(catalog.get('history.share').params, {}),
    { content: 'history', results: 'include', notes: true, chats: false, journal: false, source: 'full' },
    'a share holds the history with its results and notes by default; times follow the content');
  assert.deepEqual(withDefaults(catalog.get('history.save').params, {}), { content: 'history', results: 'include' });
  assert.deepEqual(withDefaults(catalog.get('history.get').params, {}), { all_branches: false, limit: HISTORY_PAGE_STEPS });
  // What a share writes, one rule for every surface: steps only never hold results; a state names nobody and keeps no notes or times unless asked.
  assert.deepEqual(shareScopeOf(withDefaults(catalog.get('history.share').params, {})),
    { content: 'history', results: 'include', notes: true, chats: false, journal: false, times: 'exact', source: 'full' });
  assert.deepEqual(shareScopeOf({ content: 'steps', results: 'include' }).results, 'recompute');
  assert.deepEqual(shareScopeOf({ content: 'state', notes: true, chats: true, journal: true }),
    { content: 'state', results: 'include', notes: false, chats: false, journal: false, times: 'none', source: 'full' });
  assert.equal(shareScopeOf({ content: 'state', times: 'dates' }).times, 'dates');
  for (const type of ['history.share', 'history.save']) {
    assert.deepEqual(catalog.get(type).params.properties.content.enum, SHARE_CONTENTS, type);
    assert.deepEqual(catalog.get(type).params.properties.results.enum, SHARE_RESULTS, type);
  }
  assert.deepEqual(withDefaults(catalog.get('history.tracker.start').params, {}), { start: 'opened' });
  assert.deepEqual(withDefaults(catalog.get('history.branch.delete').params, { branch: 'X' }), { branch: 'X', with_sub_branches: false });
  assert.deepEqual(withDefaults(catalog.get('history.turn.undo').params, { turn: 't' }), { turn: 't', only_own: false });
  assert.deepEqual(withDefaults(catalog.get('history.note.add').params, { target: { step: 's1' }, text: 'x' }), { target: { step: 's1' }, text: 'x', from_reply: false });
});

test('what they answer says the model\'s vocabulary', () => {
  const catalog = createActionCatalog(ACTION_DEFINITIONS);
  const step = catalog.get('history.step').result;
  assert.deepEqual(step.properties.by.properties.origin.enum, BY_ORIGINS);
  const snake = name => name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  assert.deepEqual(Object.keys(step.properties.by.properties), recordFields('By'));
  assert.deepEqual(Object.keys(step.properties.notes.items.properties), recordFields('Note').map(snake));
  assert.deepEqual(catalog.get('history.replay').result.properties.report.items.properties.outcome.enum, REPLAY_OUTCOMES);
  assert.deepEqual(step.properties.kind.enum, STEP_KINDS);
  assert.ok(!Object.hasOwn(step.properties, 'picture'), 'no step holds a picture (§3.15.7)');
  const squashed = step.properties.squashed.oneOf[0];
  assert.deepEqual(squashed.properties.cause.enum, SQUASH_CAUSES);
  assert.deepEqual(Object.keys(squashed.properties), recordFields('Squash'));
  assert.deepEqual(catalog.get('history.get').result.properties.steps.items.properties.kind.enum, STEP_KINDS);
  for (const key of ['kind', 'squash', 'v', 'group']) assert.ok(catalog.get('history.get').result.properties.steps.items.required.includes(key), `history.get steps carry ${key}`);
  assert.deepEqual(catalog.get('history.get').result.properties.steps.items.properties.squash.enum, [...SQUASH_CAUSES, null]);
  for (const key of ['total', 'next']) assert.ok(catalog.get('history.get').result.required.includes(key), `history.get pages: ${key}`);
  for (const key of ['groups', 'recording']) assert.ok(catalog.get('history.summary').result.required.includes(key), `history.summary says ${key}`);
  assert.deepEqual(Object.keys(catalog.get('history.replay').result.properties.report.items.properties), recordFields('ReplayEntry'));
});

/** A page whose domains are constants: enough for the history to start and provide its actions. */
function page() {
  const domains = createDomainRegistry();
  for (const id of domains.missing()) domains.provide(id, { capture: () => ({ id }), restore: () => {} });
  const catalog = createActionCatalog(ACTION_DEFINITIONS);
  const dispatcher = createActionDispatcher({ catalog });
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'd', name: 'D', cellOrder: null }, newTrackerId: () => 't-00000000-0000-4000-8000-000000000001',
  });
  return { dispatcher, history };
}

test('every history action has its provider: the history, or its persistence for what writes it down or reads it out', () => {
  const { dispatcher, history } = page();
  assert.deepEqual(Object.keys(EXPECTED).filter(type => !dispatcher.provided(type)).sort(), [...PERSISTENCE, ...PANEL, ...DATASET_OPENING].sort(),
    'the history provides every history action but its persistence\'s, the panel\'s and the dataset opening\'s');
  const stop = providePersistenceActions({
    dispatcher, histories: { current: () => history, savedStates: { list: async () => [] } }, serializer: null,
    datasetFacts: () => ({}), citation: async () => null, download: () => {},
  });
  const stopCopy = provideAnnDataCopyAction({
    dispatcher, histories: { current: () => history }, serializer: null, state: null, adapter: () => null,
    datasetFacts: () => ({}), createSpool: async () => null, download: () => {}, notifications: { warning: () => {} },
  });
  assert.deepEqual(dispatcher.unprovided().filter(type => type.startsWith('history.')).sort(), [...PANEL, ...DATASET_OPENING].sort(),
    'the panel provides the tour and the report on a page (tests/browser/agent-person-features.spec.mjs); the dataset opening, history.saved.open (tests/dataset-open-action.test.mjs)');
  stopCopy();
  stop();
  history.destroy();
});

test('reads: the inputs a step\'s result depends on, declared on the definition', () => {
  assert.deepEqual(ACTION_READ_INPUTS, [...DOMAIN_IDS, 'history']);
  const base = {
    type: 'test.run', title: 'Run', summary: 'Run it.', group: 'Test',
    params: { type: 'object', additionalProperties: false, properties: {} },
    touches: ['analysis'], effect: 'state', describe: () => 'Ran', code: () => 'run()',
  };
  assert.throws(() => defineAction(base), { message: 'Action "test.run" reads must list distinct inputs (empty when it reads none)' });
  assert.deepEqual(defineAction({ ...base, reads: [] }).reads, []);
  const declared = defineAction({ ...base, reads: ['cells', 'highlights', 'history'] });
  assert.deepEqual(declared.reads, ['cells', 'highlights', 'history']);
  assert.ok(Object.isFrozen(declared.reads));
  assert.throws(() => defineAction({ ...base, reads: ['cells', 'cells'] }), { message: 'Action "test.run" reads must list distinct inputs (empty when it reads none)' });
  assert.throws(() => defineAction({ ...base, reads: 'cells' }), { message: 'Action "test.run" reads must list distinct inputs (empty when it reads none)' });
  assert.throws(() => defineAction({ ...base, reads: ['nowhere'] }), { message: 'Action "test.run" reads unknown input "nowhere"' });
  const read = { ...base, type: 'test.read', touches: [], effect: 'read', result: { type: 'object', additionalProperties: false, properties: {} } };
  assert.deepEqual(defineAction({ ...read, reads: [] }).reads, []);
  assert.throws(() => defineAction({ ...read, reads: ['cells'] }), {
    message: 'Action "test.read" records no step, so it records no inputs (reads is empty)',
  });
  const document = catalogDocument(createActionCatalog([defineAction({ ...base, reads: [] }), defineAction({ ...base, type: 'test.other', reads: ['cells'] })]));
  assert.deepEqual(document.actions.map(action => [action.type, action.reads]), [['test.other', ['cells']], ['test.run', []]]);
  for (const definition of createActionCatalog(ACTION_DEFINITIONS).list()) {
    if (isSteplessEffect(definition.effect)) assert.deepEqual(definition.reads, [], definition.type);
  }
});
