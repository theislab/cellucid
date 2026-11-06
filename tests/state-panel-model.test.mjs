/**
 * What the State panel says of a history (`assets/js/app/ui/modules/state/model.js`)
 * and how it reads the undo keys (`keyboard.js`): how long ago, who acted
 * (the agent's model), a graph row's words and accessible name, the status
 * line, the tour plan, a flagged step's flag, comparing two branches, and
 * the keys a text field keeps. The graph's rows are `state-graph-layout.test.mjs`'s.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authorOf, describeRow, flagOf, formatAgo, isCameraStep, modelName, runLabel, statusWords, tourPlan,
} from '../assets/js/app/ui/modules/state/model.js';
import { historyKeyOf } from '../assets/js/app/ui/modules/state/keyboard.js';
import { commandKey, undoKeys } from '../assets/js/app/ui/modules/state/shared.js';
import { createBranchComparison } from '../assets/js/app/ui/modules/state/compare.js';
import { createTrackerView } from '../assets/js/app/ui/modules/state/history-source.js';
import { layoutGraph } from '../assets/js/app/ui/modules/state/graph-layout.js';
import { trackerBuilder } from './helpers/history-v2-builder.mjs';

const by = (origin, extra = {}) => ({ origin, agent: null, model: null, host: null, person: null, turn: null, ...extra });

test('how long ago: now, minutes, hours, days, then the date', () => {
  const now = Date.UTC(2026, 10, 3, 12);
  assert.deepEqual(formatAgo(now - 10_000, now), { short: 'now', long: 'just now' });
  assert.deepEqual(formatAgo(now - 60_000, now), { short: '1 min', long: '1 minute ago' });
  assert.deepEqual(formatAgo(now - 25 * 60_000, now), { short: '25 min', long: '25 minutes ago' });
  assert.deepEqual(formatAgo(now - 3 * 3_600_000, now), { short: '3 h', long: '3 hours ago' });
  assert.deepEqual(formatAgo(now - 86_400_000, now), { short: '1 d', long: '1 day ago' });
  const old = formatAgo(Date.UTC(2026, 0, 15, 12), now, 'en-GB');
  assert.deepEqual(old, { short: '15 Jan', long: 'on 15 January 2026' });
  assert.deepEqual(formatAgo(now + 5000, now), { short: 'now', long: 'just now' }, 'a clock ahead is now');
});

test('tour plan: the opening first, camera steps fly unless motion is reduced, flags in the caption', () => {
  const steps = [
    { id: 's0', parent: null, kind: 'root', type: null, label: 'Opened', by: by('startup'), touches: [], status: 'applied', notes: [], group: null },
    { id: 's1', parent: 's0', kind: 'action', type: 'color.by', label: 'Colored by leiden', by: by('user'), touches: ['active-field'], status: 'applied', notes: [{ text: 'The clusters.' }], group: 'g0' },
    { id: 's2', parent: 's1', kind: 'action', type: 'camera.set', label: 'Moved the camera', by: by('agent', { agent: 'Claude', model: 'claude-sonnet-4-6', turn: 't' }), touches: ['camera'], status: 'applied', notes: [], group: 'g0' },
    { id: 's3', parent: 's2', kind: 'action', type: 'category.rename', label: 'Renamed T', by: by('user'), touches: ['field-overlays'], status: 'unapplicable', notes: [], group: null },
  ];
  assert.equal(isCameraStep(steps[2]), true);
  assert.equal(isCameraStep(steps[1]), false);
  const plan = tourPlan(steps, { holdMs: 2000, flyMs: 1000, groupName: id => (id === 'g0' ? 'QC' : null) });
  assert.deepEqual(plan.map(p => [p.stepId, p.number, p.caption, p.note, p.chapter, p.by, p.fly, p.flyMs, p.holdMs]), [
    ['s0', 0, 'Opened', null, null, null, false, 0, 2000],
    ['s1', 1, 'Colored by leiden', 'The clusters.', 'QC', null, false, 0, 2000],
    ['s2', 2, 'Moved the camera', null, null, 'Claude · Sonnet 4.6', true, 1000, 2000],
    ['s3', 3, 'Renamed T (no longer applies)', null, null, null, false, 0, 2000],
  ]);
  assert.equal(tourPlan(steps, { reducedMotion: true }).some(p => p.fly), false);
  assert.throws(() => tourPlan(steps, { holdMs: -1 }), /milliseconds/);
});

test('undo keys: Ctrl or Command with Z; Shift redoes; Ctrl+Y redoes off a Mac; Alt or both modifiers are not it', () => {
  const press = (key, extra = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra });
  for (const apple of [false, true]) {
    assert.equal(historyKeyOf(press('z', { ctrlKey: true }), apple), 'undo');
    assert.equal(historyKeyOf(press('z', { metaKey: true }), apple), 'undo');
    assert.equal(historyKeyOf(press('Z', { ctrlKey: true, shiftKey: true }), apple), 'redo');
    assert.equal(historyKeyOf(press('z', { metaKey: true, shiftKey: true }), apple), 'redo');
    assert.equal(historyKeyOf(press('z', { ctrlKey: true, metaKey: true }), apple), null);
    assert.equal(historyKeyOf(press('z', { ctrlKey: true, altKey: true }), apple), null);
    assert.equal(historyKeyOf(press('z'), apple), null);
    assert.equal(historyKeyOf(press('a', { ctrlKey: true }), apple), null);
    assert.equal(historyKeyOf(press('y', { metaKey: true }), apple), null);
  }
  assert.equal(historyKeyOf(press('y', { ctrlKey: true }), false), 'redo');
  assert.equal(historyKeyOf(press('y', { ctrlKey: true }), true), null);
  assert.deepEqual(undoKeys({ platform: 'MacIntel' }), { undo: '⌘Z', redo: '⇧⌘Z' });
  assert.deepEqual(undoKeys({ platform: 'Win32' }), { undo: 'Ctrl+Z', redo: 'Ctrl+Shift+Z' });
  assert.equal(commandKey('B', { shift: true }, { platform: 'MacIntel' }), '⇧⌘B');
  assert.equal(commandKey('G', {}, { platform: 'Linux x86_64' }), 'Ctrl+G');
});

test('comparing two branches is the views\' own actions: a kept view per branch by name, then side by side', async () => {
  const dispatched = [];
  let kept = 1;
  const compare = createBranchComparison({
    dispatch: async (type, params) => {
      dispatched.push([type, params]);
      return { outcome: type === 'view.keep' ? { view: `View ${++kept}` } : { layout: params.layout }, step: null };
    },
  });
  const history = { active: { steps: [], branches: [{ id: 'b0', name: 'Main' }, { id: 'b1', name: 'Idea' }], headId: 's0' } };
  assert.deepEqual(await compare(history, 'b0', 'b1'), ['View 2', 'View 3']);
  assert.deepEqual(dispatched, [
    ['view.keep', { branch: 'Main' }],
    ['view.keep', { branch: 'Idea' }],
    ['view.layout.set', { layout: 'grid' }],
  ]);
  // A refusal (a branch made a field the state shown lacks) stops the comparison and is the person's to read.
  const refusing = createBranchComparison({ dispatch: async () => { throw new Error('There is no field "x"'); } });
  await assert.rejects(refusing(history, 'b0', 'b1'), /There is no field "x"/);
  await assert.rejects(compare(history, 'b0', 'b9'), /no branch "b9"/);
  assert.throws(() => createBranchComparison({}), /needs the action dispatcher/);
});

test('a flagged step says why: a replayed step that did not match here, or one that no longer applies', () => {
  assert.equal(flagOf({ status: 'applied', by: by('replay'), touches: [], reason: null }), null);
  assert.deepEqual(flagOf({ status: 'unapplicable', by: by('replay'), touches: [], reason: 'There is no category "beta" in cell_type.' }), {
    text: 'Did not match here: There is no category "beta" in cell_type.', phrase: 'did not match here',
  });
  // A replayed step that applied, flagged later by a delete, no longer applies.
  assert.deepEqual(flagOf({ status: 'unapplicable', by: by('replay'), touches: ['filters'], reason: 'There is no field "x".' }), {
    text: 'No longer applies: There is no field "x".', phrase: 'no longer applies',
  });
  assert.deepEqual(flagOf({ status: 'unapplicable', by: by('user'), touches: ['filters'], reason: null }), {
    text: 'No longer applies: It could not be applied again.', phrase: 'no longer applies',
  });
});

test('who acted: the person has no badge; an agent is named with its model as people say it', () => {
  assert.equal(modelName('claude-sonnet-4-6'), 'Sonnet 4.6');
  assert.equal(modelName('claude-opus-4-1-20250805'), 'Opus 4.1');
  assert.equal(modelName('claude-haiku-4'), 'Haiku 4');
  assert.equal(modelName('gpt-5-mini'), 'gpt-5-mini');
  assert.equal(modelName(null), null);
  assert.deepEqual(authorOf(by('user')), { key: 'person', name: 'You', badge: null, phrase: null });
  assert.deepEqual(authorOf(by('agent', { agent: 'Claude', model: 'claude-sonnet-4-6' })), {
    key: 'claude', name: 'Claude', badge: 'Claude · Sonnet 4.6', phrase: 'by Claude (Sonnet 4.6)',
  });
  assert.equal(authorOf(by('host', { host: 'python' })).badge, 'Python');
  assert.equal(authorOf(by('outside')).name, 'Not recorded');
});

test('a row\'s accessible name says the step, its branch, who, when, and what starts there', () => {
  const now = Date.UTC(2026, 10, 4, 12);
  const b = trackerBuilder({ at: now - 10 * 60_000 });
  const fork = b.step('Hid alpha of cell_type');
  b.step('Kept going');
  b.jump(fork);
  b.as({ origin: 'agent', agent: 'Claude', model: 'claude-sonnet-4-6', turn: 't1' }, 'Markers');
  const mine = b.step('Ran DE');
  b.note(mine, 'Matches the paper.');
  b.rename('b1', 'Without alpha');
  const view = createTrackerView(b.build());
  const layout = layoutGraph(view, { effectOf: () => 'state' });
  const row = layout.rows.find(each => each.kind === 'step' && each.step.label === 'Hid alpha of cell_type');
  assert.equal(describeRow(row, { view, now }).name,
    'Step 1 of Main, Hid alpha of cell_type, 9 minutes ago, branch “Without alpha” starts here');
  const de = layout.rows.find(each => each.kind === 'step' && each.step.label === 'Ran DE');
  assert.equal(describeRow(de, { view, now }).name,
    'Step 3 of Without alpha, Ran DE, by Claude (Sonnet 4.6), 7 minutes ago, shown, has a note');
  const stub = layout.rows.find(each => each.kind === 'fork');
  assert.equal(describeRow(stub, { view, now }).name, 'The rest of branch “Main”, 1 step, last change 8 minutes ago, main, collapsed');
  const turn = layout.rows.find(each => each.kind === 'turn');
  assert.equal(describeRow(turn, { view, now }).name, 'Claude\'s turn “Markers”, 1 step, at step 3');
  assert.equal(runLabel({ filtered: false, categories: [{ name: 'Camera', count: 6 }, { name: 'Layout', count: 1 }], off: true }), 'Camera ×6 · Layout · not recorded now');
});

test('a collapsed group holding the head says where it is among its steps ("at 4 of 7")', () => {
  const now = Date.UTC(2026, 10, 4, 12);
  const b = trackerBuilder({ at: now - 10 * 60_000 });
  const ids = [];
  for (let n = 1; n <= 7; n++) ids.push(b.step(`Step ${n}`));
  b.group(ids[0], ids[6], 'QC');
  b.jump(ids[3]);
  const view = createTrackerView(b.build());
  const group = layoutGraph(view, { effectOf: () => 'state' }).rows.find(each => each.kind === 'group');
  const words = describeRow(group, { view, now });
  assert.equal(words.meta, 'at 4 of 7');
  assert.match(words.name, /^Group “QC”, 7 steps, at 4 of 7, /);
  // The head past the group: the group says its size.
  b.jump(ids[6]);
  b.step('After');
  const after = createTrackerView(b.build());
  assert.equal(describeRow(layoutGraph(after, { effectOf: () => 'state' }).rows.find(each => each.kind === 'group'), { view: after, now }).meta, '7 steps');
});

test('the status line: steps, the step shown and undone ones, a search\'s count, stale results, paused', () => {
  const now = Date.UTC(2026, 10, 4, 12);
  assert.deepEqual(statusWords({ steps: 14, undone: 0, matches: null, stale: 2, recording: true, pausedAt: null, now }), { text: '14 steps', stale: '⚠ 2 stale' });
  assert.deepEqual(statusWords({ steps: 14, undone: 5, matches: null, stale: 0, recording: true, pausedAt: null, now }), { text: '14 steps · 5 undone', stale: null });
  assert.deepEqual(statusWords({ steps: 214, undone: 0, matches: 8, stale: 0, recording: true, pausedAt: null, now }), { text: '8 of 214 steps', stale: null });
  assert.match(statusWords({ steps: 3, undone: 0, matches: null, stale: 0, recording: false, pausedAt: now - 60_000, now }).text, /^since \S/);
});

test('a text field keeps its own undo; a slider, a checkbox and a select do not (they have none)', async () => {
  const { hasOwnUndo } = await import('../assets/js/app/ui/modules/state/keyboard.js');
  const input = type => ({ tagName: 'INPUT', getAttribute: name => (name === 'type' ? type : null) });
  assert.equal(hasOwnUndo(null), false);
  assert.equal(hasOwnUndo({ tagName: 'TEXTAREA' }), true);
  assert.equal(hasOwnUndo({ tagName: 'DIV', isContentEditable: true }), true);
  for (const type of ['text', 'search', 'number', null]) assert.equal(hasOwnUndo(input(type)), true, `${type} input`);
  for (const type of ['range', 'checkbox', 'radio', 'color', 'button']) assert.equal(hasOwnUndo(input(type)), false, `${type} input`);
  assert.equal(hasOwnUndo({ tagName: 'SELECT' }), false);
});

test('memory: the warning shows while what is drawn passes the allowance, and names the largest parts', async () => {
  const { historyOverBudget, memoryPartWords, memoryWords } = await import('../assets/js/app/ui/modules/state/memory-dialog.js');
  assert.equal(historyOverBudget({ historyBytes: 10, workingSetBytes: 101, allowanceBytes: 100 }), true);
  assert.equal(historyOverBudget({ historyBytes: 10, workingSetBytes: 100, allowanceBytes: 100 }), false, 'at the allowance is within it');
  assert.equal(historyOverBudget({ historyBytes: 0, workingSetBytes: 200, allowanceBytes: 100 }), false, 'a history holding nothing is not the cause');
  const context = { domainName: id => ({ highlights: 'Highlights', analysis: 'Analyses' })[id] ?? id, trackerName: () => 'Tracker 2', shownTracker: 't-a' };
  const parts = [
    { kind: 'step', tracker: 't-a', step: 's40', domain: 'analysis', label: 'Ran DE', bytes: 22 * 1024 * 1024 },
    { kind: 'step', tracker: 't-a', step: 's31', domain: 'highlights', label: 'Brushed', bytes: 8 * 1024 * 1024 },
    { kind: 'deleted', tracker: 't-b', step: null, domain: null, label: 'Deleted “Brushed”', bytes: 1024 },
  ];
  assert.equal(memoryPartWords(parts[1], context), 'Highlights at step 31');
  assert.equal(memoryPartWords(parts[2], context), 'Recently deleted: Deleted “Brushed” (Tracker 2)');
  assert.equal(memoryPartWords({ kind: 'paused', tracker: 't-a', step: null, domain: null, label: '' }, context), 'Changes made while paused');
  const words = memoryWords({ total: 31 * 1024 * 1024, parts }, context);
  assert.match(words.chip, /^⚠ 31(\.0)? MB$/);
  assert.match(words.sentence, /^The history keeps 31(\.0)? MB, more than this device has room for now\. Largest: Analyses at step 40: 22(\.0)? MB; Highlights at step 31: 8(\.0)? MB\.$/);
});
