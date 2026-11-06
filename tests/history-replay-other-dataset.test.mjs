/**
 * Replaying a history on another dataset (`assets/js/app/history/replay.js`,
 * `history.replay`): the steps of a saved history's main branch are applied
 * again by name, in a new tracker whose start names where they come from; every
 * step that does not match is kept there, flagged with the reason, and
 * reported; a step flagged where it was recorded is reported, not
 * dispatched; a change made outside the steps is skipped; a stop leaves the
 * steps applied before it and nothing half applied; the tracker in use
 * before keeps its steps. A session file is read whole and checked as a file,
 * never against the dataset shown.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { ActionRefused, createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { readReplayPlan, replayPlanOf, replayedFrom, summarizeReplay } from '../assets/js/app/history/replay.js';
import { openHistoryFile } from '../assets/js/app/session/history-file.js';
import { SAVE_DEFAULTS, writeSharedHistory } from '../assets/js/app/session/share-scope.js';
import { onAbort } from '../assets/js/utils/abort.js';
import { HEADER } from './helpers/history-fixtures.mjs';

const DEFINITIONS = [
  defineAction({
    type: 'color.by', title: 'Colour by', summary: 'Colour by a field.', group: 'Colours',
    params: { type: 'object', additionalProperties: false, required: ['field'], properties: { field: { type: 'string' } } },
    touches: ['colors'], reads: [], effect: 'view', describe: p => `Coloured by ${p.field}`, code: p => `color_by(${JSON.stringify(p.field)})`,
  }),
  defineAction({
    type: 'filter.hide', title: 'Hide a category', summary: 'Hide a category of a field.', group: 'Filters',
    params: {
      type: 'object', additionalProperties: false, required: ['field', 'category'],
      properties: { field: { type: 'string' }, category: { type: 'string' } },
    },
    touches: ['filters'], reads: [], effect: 'state', describe: p => `Hid ${p.category} of ${p.field}`, code: p => `hide(${JSON.stringify(p.category)})`,
  }),
  defineAction({
    type: 'filter.slow', title: 'Slow filter', summary: 'A filter that takes until it is stopped.', group: 'Filters',
    params: { type: 'object', additionalProperties: false, properties: {} },
    touches: ['filters'], reads: [], effect: 'state', describe: () => 'Filtered slowly', code: () => 'slow()',
  }),
];

/** One dataset's page: its fields with their categories, two domains, the three actions. */
function datasetPage({ id, name, fields }) {
  const state = { colors: { by: null }, filters: { hidden: [] } };
  const domains = createDomainRegistry();
  domains.provide('colors', { capture: () => ({ ...state.colors }), restore: value => { state.colors = { ...value }; } });
  domains.provide('filters', {
    capture: () => ({ hidden: [...state.filters.hidden] }),
    restore: value => { state.filters = { hidden: [...value.hidden] }; },
  });
  for (const missing of domains.missing()) domains.provide(missing, { capture: () => null, restore: () => {} });
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog(DEFINITIONS) });
  const calls = [];
  const fieldOf = key => {
    if (!Object.hasOwn(fields, key)) {
      throw new ActionRefused(`There is no field "${key}"; the fields are ${Object.keys(fields).map(k => `"${k}"`).join(', ')}.`, { code: 'no-target' });
    }
    return fields[key];
  };
  dispatcher.provide('color.by', ({ field }, { meta }) => {
    calls.push(['color.by', field, meta.origin]);
    fieldOf(field);
    state.colors = { by: field };
    return { field };
  });
  dispatcher.provide('filter.hide', ({ field, category }, { meta }) => {
    calls.push(['filter.hide', category, meta.origin]);
    // A half change first: a refusal after it must leave nothing behind.
    state.filters = { hidden: [...state.filters.hidden, `${field}:${category}`] };
    if (!fieldOf(field).includes(category)) {
      throw new ActionRefused(`There is no category "${category}" in ${field}; its categories are ${fieldOf(field).map(c => `"${c}"`).join(', ')}.`, { code: 'no-target' });
    }
    return { hidden: 1 };
  });
  let slowStarted = null;
  const slowStart = new Promise(resolve => { slowStarted = resolve; });
  dispatcher.provide('filter.slow', (_params, { signal }) => {
    state.filters = { hidden: [...state.filters.hidden, 'slow'] };
    slowStarted();
    return new Promise((_resolve, reject) => onAbort(signal, () => reject(signal.reason)));
  });
  let n = 0;
  let t = 1000;
  const history = createHistory({
    dispatcher, domains, dataset: { id, name, cellOrder: null }, newTrackerId: () => `t-00000000-0000-4000-8000-${String(++trackerNumber).padStart(12, '0')}`, now: () => ++t,
  });
  return { state, domains, dispatcher, history, calls, slowStart };
}

let trackerNumber = 0;

const A_FIELDS = { cell_type: ['alpha', 'beta', 'gamma'], score: [] };
const B_FIELDS = { cell_type: ['gamma', 'zz-1'], score: [] };

/** Dataset A's recorded history: colour, hide beta, hide gamma, a change made outside, colour by a gene A has. */
async function recordedOnA() {
  const a = datasetPage({ id: 'dataset-a', name: 'Dataset A', fields: { ...A_FIELDS, CD3E: [] } });
  await a.history.startTracker({ name: 'Annotation' });
  await a.dispatcher.dispatch('color.by', { field: 'cell_type' });
  await a.dispatcher.dispatch('filter.hide', { field: 'cell_type', category: 'beta' });
  await a.dispatcher.dispatch('filter.hide', { field: 'cell_type', category: 'gamma' });
  a.state.colors = { by: 'drawn by hand' };
  await a.history.reconcile();
  await a.dispatcher.dispatch('color.by', { field: 'CD3E' });
  return a;
}

/** Dataset B open, with its own tracker and one step of its own. */
async function openB() {
  const b = datasetPage({ id: 'dataset-b', name: 'Dataset B', fields: B_FIELDS });
  await b.history.startTracker({ name: 'Mine' });
  await b.dispatcher.dispatch('color.by', { field: 'score' });
  return b;
}

test('a saved history\'s plan is its main branch (or one named), root left out, linked to its tracker', async () => {
  const a = await recordedOnA();
  const tip = a.history.active.headId;
  const trackerId = a.history.active.id;
  // Another branch: undone, then another step. The plan follows main, whatever is shown.
  await a.history.undo();
  await a.dispatcher.dispatch('color.by', { field: 'score' });
  const plan = replayPlanOf(a.history.snapshot());
  assert.deepEqual(plan.steps.map(step => step.label), [
    'Coloured by cell_type', 'Hid beta of cell_type', 'Hid gamma of cell_type', 'Changed outside the history', 'Coloured by CD3E',
  ]);
  assert.deepEqual(plan.from, {
    dataset: { id: 'dataset-a', name: 'Dataset A' },
    tracker: { id: trackerId, name: 'Annotation' },
    branch: { id: 'b0', name: 'Main' },
    step: tip, file: null, saved: null,
  });
  const other = replayPlanOf(a.history.snapshot(), { branch: 'Branch 1' });
  assert.equal(other.steps.at(-1).label, 'Coloured by score');
  assert.throws(() => replayPlanOf(a.history.snapshot(), { branch: 'Nope' }), /has no branch "Nope"; its branches are "Main", "Branch 1"/);
  assert.equal(plan.name, 'Replay of Dataset A');
  assert.throws(() => replayPlanOf({ activeTracker: 'nope', trackers: [] }), /active tracker it does not hold/);
});

test('replaying on another dataset: a new tracker linked to the original, every step by name, what did not match kept and reported', async () => {
  const a = await recordedOnA();
  const b = await openB();
  const before = b.history.snapshot().trackers[0];
  const shownBefore = { colors: { ...b.state.colors }, filters: { hidden: [...b.state.filters.hidden] } };
  const seen = [];
  const { tracker, report } = await b.history.replay(replayPlanOf(a.history.snapshot()), {
    onStep: (entry, index, total) => seen.push([entry.outcome, index, total]),
  });

  // A new tracker, in use, linked to A's; B's own tracker is as it was.
  assert.equal(b.history.trackers().length, 2);
  const tree = b.history.active;
  assert.equal(tree.id, tracker);
  assert.equal(tree.name, 'Replay of Dataset A');
  assert.deepEqual(tree.start.from, {
    dataset: { id: 'dataset-a', name: 'Dataset A' }, tracker: { id: a.history.active.id, name: 'Annotation' },
    branch: { id: 'b0', name: 'Main' }, step: a.history.active.headId, file: null, saved: null,
  });
  assert.equal(tree.start.kind, 'replay');
  assert.deepEqual(tree.start.report, report, 'the tracker keeps its report');
  const mine = b.history.trackers().find(t => t.name === 'Mine');
  assert.deepEqual(b.history.snapshot().trackers.find(t => t.id === mine.id), before);

  // Every step by name, origin replay; the outside change never dispatched.
  assert.deepEqual(b.calls.slice(1), [
    ['color.by', 'cell_type', 'replay'], ['filter.hide', 'beta', 'replay'], ['filter.hide', 'gamma', 'replay'], ['color.by', 'CD3E', 'replay'],
  ]);
  assert.deepEqual(report.map(entry => [entry.label, entry.outcome, entry.reason]), [
    ['Coloured by cell_type', 'applied', null],
    ['Hid beta of cell_type', 'unmatched', 'There is no category "beta" in cell_type; its categories are "gamma", "zz-1".'],
    ['Hid gamma of cell_type', 'applied', null],
    ['Changed outside the history', 'skipped', 'A change made outside the recorded steps names no action to apply again on another dataset.'],
    ['Coloured by CD3E', 'unmatched', 'There is no field "CD3E"; the fields are "cell_type", "score".'],
  ]);
  assert.deepEqual(seen, [['applied', 0, 5], ['unmatched', 1, 5], ['applied', 2, 5], ['skipped', 3, 5], ['unmatched', 4, 5]]);

  // What matched is applied; the refused step left nothing behind.
  assert.deepEqual(b.state.colors, { by: 'cell_type' });
  assert.deepEqual(b.state.filters, { hidden: ['cell_type:gamma'] });

  // The new tracker holds every replayed step, the unmatched ones flagged with the reason and no change.
  const steps = [...tree.steps.values()].slice(1);
  assert.deepEqual(steps.map(step => [step.label, step.by.origin, step.status, step.reason, step.touches]), [
    ['Coloured by cell_type', 'replay', 'applied', null, ['colors']],
    ['Hid beta of cell_type', 'replay', 'unapplicable', report[1].reason, []],
    ['Hid gamma of cell_type', 'replay', 'applied', null, ['filters']],
    ['Coloured by CD3E', 'replay', 'unapplicable', report[4].reason, []],
  ]);
  assert.deepEqual(report.map(entry => entry.step), [steps[0].id, steps[1].id, steps[2].id, null, steps[3].id]);
  // Each replayed step names the step it was made from.
  assert.deepEqual(steps.map(step => step.replayOf.step), [report[0].source, report[1].source, report[2].source, report[4].source]);
  assert.deepEqual(replayedFrom(tree), {
    dataset: 'Dataset A', tracker: 'Annotation', replayed: 4,
    unmatched: [{ id: steps[1].id, label: 'Hid beta of cell_type', note: report[1].reason }, { id: steps[3].id, label: 'Coloured by CD3E', note: report[4].reason }],
  });
  assert.equal(replayedFrom(b.history.trackers().find(t => t.name === 'Mine')), null);
  assert.deepEqual(summarizeReplay(report), {
    total: 5, applied: 2, unchanged: 0, unmatched: 2, skipped: 1, stopped: 0,
    text: 'Replayed 5 steps: 2 applied; 2 steps did not match; 1 change made outside the steps was skipped.', tone: 'warning',
  });

  // Undo walks back step by step to the state the replay started on.
  assert.equal(await b.history.undo(), true);
  assert.deepEqual(b.state.filters, { hidden: ['cell_type:gamma'] }, 'undoing a flagged step changes nothing');
  assert.equal(await b.history.undo(), true);
  assert.deepEqual(b.state.filters, { hidden: [] });
  await b.history.undo();
  await b.history.undo();
  assert.deepEqual(b.state.colors, shownBefore.colors);
  assert.equal(await b.history.undo(), false);

  // The tracker used before shows its own state again, untouched.
  await b.history.redo();
  await b.history.useTracker(mine.id);
  assert.deepEqual(b.state.colors, { by: 'score' });
  assert.deepEqual(b.history.snapshot().trackers.find(t => t.id === mine.id), before);
});

test('a step flagged where it was recorded is reported and kept flagged, not dispatched', async () => {
  const a = await recordedOnA();
  const saved = a.history.snapshot();
  const step = saved.trackers[0].steps.find(s => s.label === 'Hid gamma of cell_type');
  step.status = 'unapplicable';
  step.reason = 'There is no field "cell_type".';
  const b = await openB();
  const { report } = await b.history.replay(replayPlanOf(saved));
  const entry = report.find(e => e.label === 'Hid gamma of cell_type');
  assert.equal(entry.outcome, 'unmatched');
  assert.equal(entry.reason, 'It did not apply where it was recorded either: There is no field "cell_type".');
  assert.equal(b.calls.filter(([type, category]) => type === 'filter.hide' && category === 'gamma').length, 0);
  assert.equal(b.history.active.steps.get(entry.step).status, 'unapplicable');
  assert.deepEqual(b.state.filters, { hidden: [] });
});

test('a step that changes nothing here is reported unchanged and is no step', async () => {
  const a = await recordedOnA();
  const b = await openB();
  await b.dispatcher.dispatch('color.by', { field: 'cell_type' });
  const plan = replayPlanOf(a.history.snapshot());
  const { report } = await b.history.replay({ ...plan, steps: plan.steps.slice(0, 1) });
  assert.deepEqual(report.map(entry => [entry.outcome, entry.step]), [['unchanged', null]]);
  assert.equal(b.history.active.steps.size, 1);
});

test('a stopped replay keeps the steps applied before the stop, and the step stopped inside changes nothing', async () => {
  const a = datasetPage({ id: 'dataset-a', name: 'Dataset A', fields: A_FIELDS });
  await a.history.startTracker({ name: 'Slow' });
  await a.dispatcher.dispatch('color.by', { field: 'cell_type' });
  // A step recorded as a slow filter would be: the saved history only names it.
  const saved = a.history.snapshot();
  const tracker = saved.trackers[0];
  const head = tracker.steps.find(s => s.id === tracker.headId);
  const slow = { ...head, id: 's9', parent: head.id, children: [], type: 'filter.slow', params: {}, label: 'Filtered slowly', touches: [], before: {}, after: {} };
  const after = { ...slow, id: 's10', parent: 's9', type: 'filter.hide', params: { field: 'cell_type', category: 'gamma' }, label: 'Hid gamma of cell_type' };
  slow.children = ['s10'];
  head.children = ['s9'];
  tracker.steps.push(slow, after);
  tracker.headId = 's10';
  tracker.branches[0].tip = 's10';
  tracker.nextStep = 11;

  const b = await openB();
  const controller = new AbortController();
  const replaying = b.history.replay(replayPlanOf(saved), { signal: controller.signal });
  await b.slowStart;
  assert.deepEqual(b.state.filters, { hidden: ['slow'] }, 'the slow step is under way');
  controller.abort(new DOMException('Stopped by the person', 'AbortError'));
  const { report } = await replaying;
  assert.deepEqual(report.map(entry => entry.outcome), ['applied', 'stopped', 'stopped']);
  assert.deepEqual(b.state.filters, { hidden: [] }, 'nothing of the stopped step is left');
  assert.deepEqual(b.state.colors, { by: 'cell_type' });
  assert.deepEqual([...b.history.active.steps.values()].slice(1).map(step => step.label), ['Coloured by cell_type']);
  assert.equal(summarizeReplay(report).text, 'Replay stopped: 1 of 3 steps applied.');
  assert.equal(b.calls.some(([type]) => type === 'filter.hide'), false, 'nothing after the stop is dispatched');
});

test('a replay is refused before any tracker starts, and a replay with nothing to name is refused', async () => {
  const b = datasetPage({ id: 'dataset-b', name: 'Dataset B', fields: B_FIELDS });
  const from = {
    dataset: { id: 'a', name: 'A' }, tracker: { id: 't-00000000-0000-4000-8000-999999999999', name: 'T' },
    branch: { id: 'b0', name: 'Main' }, step: 's0', file: null, saved: null,
  };
  const plan = { steps: [], from, name: 'Replay of A' };
  await assert.rejects(b.history.replay(plan), /no tracker yet/);
  await b.history.startTracker();
  assert.throws(() => b.history.replay({ ...plan, from: null }), /names the tracker its steps come from/);
  assert.throws(() => b.history.replay({ ...plan, steps: null }), /names the steps/);
  const { report } = await b.history.replay(plan);
  assert.deepEqual(report, []);
  assert.equal(summarizeReplay(report).text, 'Replayed: the history has no steps.');
  assert.equal(b.history.active.start.from.tracker.name, 'T');
});

test('a person\'s action waits until the replay ends, so it never lands between replayed steps', async () => {
  const a = await recordedOnA();
  const b = await openB();
  const replaying = b.history.replay(replayPlanOf(a.history.snapshot()));
  const mine = b.dispatcher.dispatch('color.by', { field: 'score' });
  await Promise.all([replaying, mine]);
  const labels = [...b.history.active.steps.values()].slice(1).map(step => step.label);
  assert.equal(labels.at(-1), 'Coloured by score');
  assert.deepEqual(labels.slice(0, -1), ['Coloured by cell_type', 'Hid beta of cell_type', 'Hid gamma of cell_type', 'Coloured by CD3E']);
});

test('a session file of another dataset is read whole, checked as a file, and replayed by name; nothing of its values is put back', async () => {
  const a = await recordedOnA();
  const { blob } = await writeSharedHistory({
    snapshot: a.history.snapshot(), shown: a.history.shownHashes(), valueOf: hash => a.history.pool.get(hash),
    choice: SAVE_DEFAULTS, header: HEADER, catalog: a.dispatcher.catalog, version: '0.9.6',
    newTrackerId: () => 't-00000000-0000-4000-8000-0000000000ff', now: Date.parse(HEADER.createdAt),
  });
  const b = await openB();
  const file = await openHistoryFile(blob, { signal: null, onProgress: null });
  const plan = await readReplayPlan(file);
  const { report } = await b.history.replay(plan);
  assert.deepEqual(report.map(entry => entry.outcome), ['applied', 'unmatched', 'applied', 'skipped', 'unmatched']);
  assert.deepEqual(b.state.colors, { by: 'cell_type' });
  // The colour A's outside change left is A's own value: B never holds it.
  const outside = a.history.snapshot().trackers[0].steps.find(step => step.label === 'Changed outside the history');
  assert.equal(b.history.pool.has(outside.after.colors), false);

  // A damaged file is refused before anything is replayed.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  bytes[bytes.length - 5] ^= 0xff;
  const trackersBefore = b.history.trackers().length;
  await assert.rejects(async () => readReplayPlan(await openHistoryFile(new Blob([bytes]), { signal: null, onProgress: null })));
  assert.equal(b.history.trackers().length, trackersBefore);
});

test('reading a plan cancels its source on a failure and on a stop', async () => {
  const cancelled = [];
  const source = failAt => ({
    readEager: async () => {
      if (failAt === 'eager') throw new Error('eager failed');
      return {
        history: {
          activeTracker: 't', trackers: [{
            id: 't', name: 'T', dataset: null, rootId: 's0', headId: 's0', mainBranch: 'b0',
            branches: [{ id: 'b0', name: 'Main', base: null, tip: 's0' }],
            steps: [{ id: 's0', parent: null, kind: 'root', type: null, label: 'Opened' }],
          }],
        },
      };
    },
    readRest: async () => {
      if (failAt === 'rest') throw new Error('rest failed');
      return { values: new Map(), chats: [], journals: [], params: [] };
    },
    cancel: async reason => { cancelled.push(reason?.message ?? String(reason)); },
  });
  await assert.rejects(readReplayPlan(source('eager')), /eager failed/);
  await assert.rejects(readReplayPlan(source('rest')), /rest failed/);
  const controller = new AbortController();
  controller.abort(new Error('stopped'));
  await assert.rejects(readReplayPlan(source(null), { signal: controller.signal }), /stopped/);
  assert.deepEqual(cancelled, ['eager failed', 'rest failed', 'stopped']);
  const plan = await readReplayPlan(source(null));
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.name, 'Replay of T');
});
