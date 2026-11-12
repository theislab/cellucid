/**
 * History v2's core on fake domains (`assets/js/app/history/`): the recording
 * switch and the detail switches (§3.15.1, §3.15.5), groups, squash and
 * "clear, keep the state" (§3.15.2), branches as objects and their delete
 * (§3.3.3), Recently deleted (§3.3.9), notes and bookmarks, turns and their
 * binding (§3.3.10), provenance (§3.4), search, the paged read and the
 * summary, replay with versions and a name mapping, branch without a step,
 * applying a branch here, verify, revert, and loading beside (§3.3.7).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { ActionRefused, createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { historyActions } from '../assets/js/app/actions/definitions/history.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { validateHistory } from '../assets/js/app/history/model.js';
import { mappingWith, mapParams, replayPlanOf } from '../assets/js/app/history/replay.js';
import { pathTo, valuesAt } from '../assets/js/app/history/tree.js';
import { CATEGORY_FIELD, CATEGORY_LABEL } from '../assets/js/app/actions/definitions/params.js';
import { schemaProblem } from '../assets/js/app/actions/schema.js';
import { plainSentence } from '../assets/js/app/actions/targets/names.js';

const KEYS = { filters: 'a', colors: 'b', analysis: 'c', camera: 'cam', layout: 'theme' };

function fakePage() {
  const state = { a: 0, b: 0, c: 0, cam: 0, theme: 'light' };
  const domains = createDomainRegistry();
  for (const [id, key] of Object.entries(KEYS)) {
    domains.provide(id, { capture: () => state[key], restore: value => { state[key] = value; }, describe: (x, y) => [`${x} → ${y}`] });
  }
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  return { state, domains };
}

const number = { type: 'object', additionalProperties: false, required: ['v'], properties: { v: { type: 'integer' } } };
const none = { type: 'object', additionalProperties: false, properties: {} };
const definitions = [
  defineAction({ type: 'a.set', title: 'Set a', summary: 'Set a.', group: 'T', params: number, touches: ['filters'], reads: [], effect: 'state', describe: p => `a = ${p.v}`, code: p => `a(${p.v})` }),
  defineAction({ type: 'b.inc', title: 'Increment b', summary: 'b + 1.', group: 'T', params: none, touches: ['colors'], reads: [], effect: 'view', describe: () => 'b + 1', code: () => 'inc_b()' }),
  defineAction({ type: 'c.derive', title: 'Derive c', summary: 'c from a and b.', group: 'T', params: none, touches: ['analysis'], reads: ['filters', 'colors'], effect: 'state', describe: () => 'c = 10a + b', code: () => 'derive()' }),
  defineAction({ type: 'cam.set', title: 'Camera', summary: 'Camera.', group: 'T', params: number, touches: ['camera'], reads: [], effect: 'view', coalesce: () => 'cam', describe: p => `cam ${p.v}`, code: p => `cam(${p.v})` }),
  defineAction({
    type: 'a.add', title: 'Add to a', summary: 'a + by.', group: 'T', version: 2, upgrade: { 1: params => ({ by: params.amount }) },
    params: { type: 'object', additionalProperties: false, required: ['by'], properties: { by: { type: 'integer' } } },
    touches: ['filters'], reads: [], effect: 'state', describe: p => `a + ${p.by}`, code: p => `add(${p.by})`,
  }),
  defineAction({
    type: 'cells.set', title: 'Set cells', summary: 'Keep the first n cells.', group: 'T', params: { type: 'object', additionalProperties: false, required: ['n'], properties: { n: { type: 'integer' } } },
    touches: ['filters'], reads: [], effect: 'state', describe: p => `${p.n} cells`, code: p => `cells(${p.n})`,
  }),
  defineAction({
    type: 'pick.category', title: 'Pick a category', summary: 'Pick one.', group: 'T',
    params: { type: 'object', additionalProperties: false, required: ['field', 'category'], properties: { field: CATEGORY_FIELD, category: CATEGORY_LABEL } },
    touches: ['colors'], reads: [], effect: 'state', describe: p => `Picked "${p.category}" of ${p.field.key}`, code: () => 'pick()',
  }),
];

/** `pick.category` on a page whose fields hold `categories` (field key → labels), refusing a name it lacks as the shared resolvers do. */
function providePick(dispatcher, page, categories) {
  dispatcher.provide('pick.category', ({ field, category }) => {
    if (!Object.hasOwn(categories, field.key)) throw new ActionRefused(`There is no field "${field.key}".`, { code: 'no-such-field', missing: { kind: 'field', name: field.key, field: null } });
    if (!categories[field.key].includes(category)) {
      throw new ActionRefused(`There is no category "${category}" in ${field.key}.`, { code: 'no-such-category', missing: { kind: 'category', name: category, field: field.key } });
    }
    page.state.b = categories[field.key].indexOf(category) + 1;
  });
}

function trackerId(n) {
  return `t-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

let trackers = 0;

async function makePage({ offDomains = () => [] } = {}) {
  const page = fakePage();
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([...definitions, ...historyActions]) });
  dispatcher.provide('a.set', ({ v }) => { page.state.a = v; });
  dispatcher.provide('a.add', ({ by }) => { page.state.a += by; });
  dispatcher.provide('b.inc', () => { page.state.b += 1; });
  dispatcher.provide('c.derive', () => { page.state.c = page.state.a * 10 + page.state.b; });
  dispatcher.provide('cam.set', ({ v }) => { page.state.cam = v; });
  let t = 0;
  const history = createHistory({
    dispatcher, domains: page.domains, dataset: { id: 'd1', name: 'Demo', cellOrder: null },
    newTrackerId: () => trackerId(++trackers), now: () => ++t * 1000, offDomains,
  });
  await history.startTracker();
  // Every history action answers exactly as its catalog result says.
  const act = async (type, params = {}, meta = {}) => {
    const { outcome } = await dispatcher.dispatch(type, params, meta);
    const result = dispatcher.catalog.get(type).result;
    if (result) assert.equal(schemaProblem(result, JSON.parse(JSON.stringify(outcome))), null, `${type} answers its result schema`);
    return outcome;
  };
  const step = async (type, params = {}, meta = {}) => (await dispatcher.dispatch(type, params, meta)).step;
  return { page, dispatcher, history, act, step };
}

function valid(history) {
  return validateHistory(history.snapshot());
}

// ---------------------------------------------------------------------------
// Recording switch (§3.15.1)

test('paused: changes apply without a step; resuming adds one squashed step for what differs, by everyone who acted', async () => {
  const { page, history, act, step } = await makePage();
  await step('a.set', { v: 1 });
  await act('history.recording.pause');
  await act('a.set', { v: 5 });
  await act('b.inc', {}, { origin: 'host', host: 'python' });
  assert.equal(page.state.a, 5, 'a change while paused still applies');
  assert.equal(history.active.steps.size, 2, 'and makes no step');
  assert.deepEqual(history.pausedChanges().domains.sort(), ['colors', 'filters']);
  assert.ok(history.active.paused.draft !== null, 'the draft is kept on the tracker (the autosave writes it)');
  const resumed = await act('history.recording.resume');
  const squashed = history.active.steps.get(resumed.squashed);
  assert.equal(squashed.kind, 'squashed');
  assert.equal(squashed.squashed.cause, 'paused');
  assert.equal(squashed.label, 'While paused: Filters, Colors');
  assert.deepEqual(squashed.squashed.by.map(by => by.origin), ['user', 'host'], 'every origin that acted');
  assert.equal(history.active.paused, null);
  valid(history);
  // It restores exactly, and undo treats it as one step.
  await history.undo();
  assert.deepEqual([page.state.a, page.state.b], [1, 0]);
  await history.redo();
  assert.deepEqual([page.state.a, page.state.b], [5, 1]);
});

test('paused: no change, or a change put back, makes no step on resume', async () => {
  const { history, act } = await makePage();
  await act('history.recording.pause');
  assert.equal((await act('history.recording.resume')).squashed, null);
  await act('history.recording.pause');
  await act('a.set', { v: 3 });
  await act('a.set', { v: 0 });
  assert.equal(history.pausedChanges(), null, 'equal values differ in nothing');
  assert.equal((await act('history.recording.resume')).squashed, null);
  assert.equal(history.active.steps.size, 1);
});

test('paused: a move keeps the changes as one step first, or discards them, as the person chose', async () => {
  const { page, history, act, step } = await makePage();
  await step('a.set', { v: 1 });
  await step('a.set', { v: 2 });
  await act('history.recording.pause');
  await act('b.inc');
  // Keep (the default): one squashed step first, then undo takes it back.
  await history.undo();
  assert.equal(history.active.steps.size, 4);
  assert.equal(page.state.b, 0, 'the kept changes were undone as their own step');
  assert.equal(page.state.a, 2);
  await history.redo();
  // Discard: the move throws the changes away.
  await act('b.inc');
  history.setPausedChoice('discard');
  await history.undo();
  assert.deepEqual([page.state.a, page.state.b], [2, 0], 'the discarded change is gone; undo went to the squashed step\'s parent');
  assert.equal(history.active.steps.size, 4, 'no step for what was discarded');
  valid(history);
  // settlePaused (Save, Share, a load first) squashes what is pending.
  await act('b.inc');
  const id = await history.settlePaused({ origin: 'session' });
  assert.equal(history.active.steps.get(id).squashed.cause, 'paused');
});

test('detail switches: an off domain is not recorded, not moved by the history, and still captured', async () => {
  let off = ['camera'];
  const { page, history, act, step } = await makePage({ offDomains: () => off });
  await act('cam.set', { v: 3 });
  assert.equal(history.active.steps.size, 1, 'a camera move alone makes no step');
  const color = await step('b.inc');
  assert.equal(history.active.steps.get(color.id).after.camera !== undefined, true, 'a step still captures the camera where it differs');
  await act('cam.set', { v: 7 });
  await history.undo();
  assert.equal(page.state.cam, 7, 'undo leaves the camera as it is');
  assert.equal(page.state.b, 0);
  await history.reconcile();
  assert.equal(history.active.steps.size, 2, 'a camera change is never a change "outside the history"');
  off = [];
  await history.redo();
  await act('cam.set', { v: 9 });
  assert.equal(history.active.steps.size, 3, 'switched on, it records from the next change, with no squashed step');
  valid(history);
});

test('a gesture brought back to where it began leaves no step: no Undo that does nothing', async () => {
  // Found 2026-11-10 on Suo: the outlier filter moved 100 → 99 → 100 in one
  // drag left "Showed every outlier of cell_type" (touching nothing) in the
  // history; Undo then changed nothing on screen.
  const { page, history, act, step } = await makePage();
  const before = await step('a.set', { v: 1 });
  await act('cam.set', { v: 5 });
  const gesture = history.active.headId;
  assert.notEqual(gesture, before.id);
  await act('cam.set', { v: 6 });
  await act('cam.set', { v: 0 });
  assert.equal(page.state.cam, 0);
  assert.equal(history.active.steps.has(gesture), false, 'the gesture that changed nothing is no step');
  assert.equal(history.active.headId, before.id);
  assert.equal(history.active.journal.length, 0, 'and nobody deleted it: Recently deleted holds nothing');
  valid(history);
  // The gesture going on afterwards is a step of its own.
  const again = await step('cam.set', { v: 4 });
  assert.equal(again.label, 'cam 4');
  assert.equal(history.active.headId, again.id);
  // Undo goes back to the step before, as if the round trip never happened.
  await history.undo();
  assert.equal(page.state.cam, 0);
  assert.equal(page.state.a, 1);
  valid(history);
});

// ---------------------------------------------------------------------------
// Groups, squash, clear (§3.15.2)

test('groups: a named run of whole steps, renamed, extended and removed, each undoable exactly', async () => {
  const { history, act, step } = await makePage();
  const s1 = await step('a.set', { v: 1 });
  const s2 = await step('b.inc');
  const s3 = await step('c.derive');
  const made = await act('history.group.create', { from: s1.id, to: s2.id, name: 'QC' });
  assert.equal(made.steps, 2);
  await assert.rejects(act('history.group.create', { from: s2.id, to: s3.id, name: 'Other' }), error => error.code === 'in-group');
  await assert.rejects(act('history.group.create', { from: s3.id, to: s3.id, name: 'qc' }), error => error.code === 'name-taken');
  await act('history.group.extend', { group: 'QC', to: s3.id });
  assert.equal(history.active.steps.get(s3.id).group, made.group.id);
  const entry = history.active.journal.at(-1);
  assert.equal(entry.before.steps.length + entry.after.steps.length, 0, 'a group edit records memberships, never steps');
  await act('history.journal.undo', { entry: entry.id });
  assert.equal(history.active.steps.get(s3.id).group, null);
  await act('history.group.remove', { group: made.group.id });
  assert.equal(history.active.groups.size, 0);
  valid(history);
});

test('a group holds whole turns: a run that splits one is refused, naming the run widened', async () => {
  const { act, step } = await makePage();
  const agent = { origin: 'agent', agent: 'Claude', turn: 'turn-1', turnLabel: 'Tidy' };
  const s1 = await step('a.set', { v: 1 }, agent);
  await step('b.inc', {}, agent);
  await assert.rejects(act('history.group.create', { from: s1.id, to: s1.id, name: 'Half' }),
    error => error.code === 'splits-turn' && /"Tidy".*steps 1 to 2/.test(error.message));
});

// L21-8 (agent-loop lane, live sweep): a turn's step after its group joins the group by itself; extending the
// group to that step was refused "Steps 2 to 4 are not consecutive steps of one branch", which they were.
test('extending a group to a step it holds already (a turn\'s later step joins its group) says so, not "not consecutive"', async () => {
  const { act, step } = await makePage();
  const agent = { origin: 'agent', agent: 'Claude', turn: 'turn-1', turnLabel: 'Tidy' };
  const s1 = await step('a.set', { v: 1 }, agent);
  const s2 = await step('b.inc', {}, agent);
  await act('history.group.create', { from: s1.id, to: s2.id, name: 'QC' });
  const s3 = await step('a.set', { v: 2 }, agent);
  await assert.rejects(act('history.group.extend', { group: 'QC', to: s3.id }),
    error => error.code === 'already-in-group' && /^Step 3 is in the group .*QC.* already: a turn's later steps join its group; extend it to a step after it\.$/.test(error.message));
  // Its last step and a step before it are the same answer; a step of another branch is still not consecutive.
  await assert.rejects(act('history.group.extend', { group: 'QC', to: s1.id }), error => error.code === 'already-in-group');
});

test('squash: one step from the first one\'s state to the last one\'s, with the last id; notes and bookmarks carried', async () => {
  const { page, history, act, step } = await makePage();
  const s1 = await step('a.set', { v: 1 });
  const s2 = await step('b.inc');
  const s3 = await step('b.inc');
  const after = await step('c.derive');
  await act('history.note.add', { target: { step: s2.id }, text: 'Checked.' });
  await act('history.bookmark.set', { step: s1.id, name: 'Start' });
  const result = await act('history.squash', { from: s1.id, to: s3.id });
  assert.equal(result.step, s3.id, 'the squashed step takes the last id');
  const squashed = history.active.steps.get(s3.id);
  assert.equal(squashed.parent, history.active.rootId);
  assert.deepEqual(squashed.children, [after.id], 'the steps after it keep their parent');
  assert.equal(squashed.squashed.count, 3);
  assert.deepEqual(squashed.squashed.carried.bookmarks, ['Start']);
  assert.equal(squashed.notes[0].text, 'Checked.');
  assert.equal(history.active.steps.has(s1.id), false);
  const read = await act('history.step', { step: s3.id });
  assert.deepEqual(read.squashed.carried.bookmarks, ['Start']);
  assert.deepEqual((await act('history.summary')).bookmarks, [{ name: 'Start', step: s3.id }], 'a carried bookmark shows the squashed step');
  await act('history.diff', { a: { step: history.active.rootId }, b: { step: s3.id } });
  await act('history.get', { all_branches: true });
  // Jumping to a carried bookmark shows the squashed step.
  await act('history.jump', { bookmark: 'start' });
  assert.equal(history.active.headId, s3.id);
  assert.deepEqual([page.state.a, page.state.b], [1, 2]);
  valid(history);
  // Undone from Recently deleted, exactly.
  await act('history.journal.undo', { entry: result.journal });
  assert.equal(history.active.steps.get(s1.id).bookmark, 'Start');
  valid(history);
});

test('squash refuses a run another branch starts inside, naming it and how far a squash may go', async () => {
  const { history, act, step } = await makePage();
  const s1 = await step('a.set', { v: 1 });
  const s2 = await step('b.inc');
  const s3 = await step('b.inc');
  await history.jump(s1.id);
  await step('a.set', { v: 9 });
  await assert.rejects(act('history.squash', { from: s1.id, to: s3.id }),
    error => error.code === 'forks-inside' && /"Branch 1" starts inside: group instead, or squash up to step 1/.test(error.message));
  void s2;
});

test('clear, keep the state: a branch "Fresh start" with one squashed step from the dataset as opened; every branch stays', async () => {
  const { page, history, act, step } = await makePage();
  await step('a.set', { v: 4 });
  await step('b.inc');
  const result = await act('history.clear', { keep_state: true });
  assert.equal(result.branch.name, 'Fresh start');
  const head = history.active.steps.get(history.active.headId);
  assert.equal(head.parent, history.active.rootId);
  assert.equal(head.squashed.cause, 'clear');
  assert.deepEqual([page.state.a, page.state.b], [4, 1]);
  assert.equal(history.active.branches.size, 2);
  await act('history.journal.undo', { entry: result.journal });
  assert.equal(history.active.branches.size, 1);
  valid(history);
});

// ---------------------------------------------------------------------------
// Branches and Recently deleted (§3.3.3, §3.3.9)

test('deleting a branch: only its own steps after the last fork go; the shared ones join the branch forking there', async () => {
  const { page, history, act, step } = await makePage();
  await step('a.set', { v: 1 });
  const x1 = await step('b.inc');
  const x2 = await step('b.inc');
  await act('history.branch.rename', { branch: 'b0', name: 'Main' });
  // Branch X from s1, with its own steps x… and a child branch at its second step.
  await history.jump(x1.parent);
  const xa = await step('a.set', { v: 7 });
  const xb = await step('a.set', { v: 8 });
  const xc = await step('a.set', { v: 9 });
  const x = history.active.steps.get(xa.id).branch;
  await act('history.branch.rename', { branch: x, name: 'X' });
  await history.jump(xb.id);
  await step('b.inc');
  const child = history.active.activeBranch;
  await act('history.branch.switch', { branch: 'X' });
  const plan = history.branchDeletePlan('X');
  assert.deepEqual([plan.steps, plan.absorbed_by?.id], [1, child]);
  const result = await act('history.branch.delete', { branch: 'X' });
  assert.equal(result.steps, 1);
  assert.equal(history.active.steps.has(xc.id), false);
  assert.equal(history.active.steps.get(xa.id).branch, child, 'the shared steps join the branch forking there');
  assert.equal(history.active.headId, xb.id, 'you are shown the last step left on your path');
  assert.equal(page.state.a, 8);
  valid(history);
  await assert.rejects(act('history.branch.delete', { branch: 'Main' }), error => error.code === 'main-branch');
  // Restored from Recently deleted, exactly.
  await act('history.journal.undo', { entry: result.journal });
  assert.equal(history.active.steps.get(xc.id).branch, x);
  valid(history);
  void x2;
});

test('a name clash is refused naming the other; an agent\'s branch is named after it', async () => {
  const { history, act, step } = await makePage();
  await step('a.set', { v: 1 });
  await history.undo();
  await step('a.set', { v: 2 }, { origin: 'agent', agent: 'Claude', turn: 'turn-9' });
  assert.equal(history.active.branches.get(history.active.activeBranch).name, 'Claude: a = 2');
  await assert.rejects(act('history.branch.rename', { branch: 'Main', name: '  CLAUDE:  a = 2 ' }), error => error.code === 'name-taken');
  await assert.rejects(act('history.branch.rename', { branch: 'Main', name: 'b7' }), error => error.code === 'name-invalid');
});

test('Branch here: the next change starts the named branch, even from a tip; any move forgets it', async () => {
  const { history, act, step } = await makePage();
  const s1 = await step('a.set', { v: 1 });
  await act('history.branch.create', { step: s1.id, name: 'Idea' });
  assert.equal(history.pending().name, 'Idea');
  await step('b.inc');
  assert.equal(history.active.branches.get(history.active.activeBranch).name, 'Idea');
  await act('history.branch.create', { step: s1.id });
  await history.undo();
  assert.equal(history.pending(), null);
});

test('a locked branch takes no new step: a change at its tip starts another', async () => {
  const { history, act, step } = await makePage();
  await step('a.set', { v: 1 });
  await act('history.branch.lock', { branch: 'Main', locked: true });
  await step('a.set', { v: 2 });
  assert.notEqual(history.active.activeBranch, 'b0');
  await assert.rejects(act('history.branch.rename', { branch: 'Main', name: 'Other' }), error => error.code === 'locked');
});

// ---------------------------------------------------------------------------
// Notes, turns (§3.3.10, §3.13)

test('notes: authored and undoable; an agent edits only its own', async () => {
  const { history, act, step } = await makePage();
  const s1 = await step('a.set', { v: 1 });
  const mine = await act('history.note.add', { target: { step: s1.id }, text: 'Mine.' });
  const agent = { origin: 'agent', agent: 'Claude', turn: 'turn-2' };
  await assert.rejects(act('history.note.edit', { note: mine.note, text: 'Changed.' }, agent), error => error.code === 'not-author');
  const theirs = await act('history.note.add', { target: { tracker: history.active.id }, text: 'Abstract.' }, agent);
  await act('history.note.edit', { note: theirs.note, text: 'Abstract, edited.' }, agent);
  await act('history.note.remove', { note: theirs.note });
  assert.equal(history.active.notes.length, 0, 'the person removes any note');
  await act('history.journal.undo', { entry: history.active.journal.at(-1).id });
  assert.equal(history.active.notes[0].text, 'Abstract, edited.');
  valid(history);
});

test('the summary gives every note on the tracker, a branch, a group and a turn in full: a received session\'s account is readable (L25-9)', async () => {
  const { history, act, step } = await makePage();
  const meta = { origin: 'agent', agent: 'Claude', turn: 'turn-9', turnLabel: 'Compare the tips' };
  const s1 = await step('a.set', { v: 1 }, meta);
  await act('history.note.add', { target: { turn: 'turn-9' }, text: 'Ran the tip comparison.' }, meta);
  await act('history.note.add', { target: { turn: 'turn-9' }, text: 'Raw counts.' }, meta);
  await act('history.note.add', { target: { branch: 'Main' }, text: 'Confound: early tip = 2 female donors.' }, meta);
  await act('history.note.add', { target: { tracker: history.active.id }, text: 'Fetal lung, tip progenitors.' });
  const summary = await act('history.summary');
  assert.deepEqual(summary.notes.map(note => note.text), ['Fetal lung, tip progenitors.']);
  assert.deepEqual(summary.branches.find(branch => branch.name === 'Main').notes.map(note => [note.text, note.by.agent]), [['Confound: early tip = 2 female donors.', 'Claude']]);
  const turn = summary.turns.find(each => each.id === 'turn-9');
  assert.deepEqual(turn.notes.map(note => note.text), ['Ran the tip comparison.', 'Raw counts.'], 'the first is its summary');
  // Each note is named by its id, as history_note_edit and history_note_remove take it.
  const branchNote = summary.branches[0].notes[0].id;
  await act('history.note.edit', { note: branchNote, text: 'Confound: early tip = 2 female donors, age 5-6.' }, meta);
  assert.equal((await act('history.summary')).branches[0].notes[0].text, 'Confound: early tip = 2 female donors, age 5-6.');
  assert.equal(s1.branch, summary.branches[0].id);
  valid(history);
});

test('turns: a record with the agent, model, conversation and message; the person moving branch refuses the agent (moved)', async () => {
  const { history, dispatcher, act, step } = await makePage();
  const meta = { origin: 'agent', agent: 'Claude', model: 'claude-sonnet-4-6', turn: 'turn-3', turnLabel: 'Color the cells', conversation: 'chat-1', message: 'turn-3' };
  await step('a.set', { v: 1 }, meta);
  const turn = history.active.turns.get('turn-3');
  assert.deepEqual([turn.label, turn.by.model, turn.conversation, turn.message], ['Color the cells', 'claude-sonnet-4-6', 'chat-1', 'turn-3']);
  assert.equal(history.active.steps.get(history.active.headId).by.model, 'claude-sonnet-4-6');
  // The person makes another branch and stays there: the agent's next change is refused.
  await history.undo();
  await step('b.inc');
  await assert.rejects(dispatcher.dispatch('a.set', { v: 2 }, meta), error => error instanceof ActionRefused && error.code === 'moved');
  // The agent's own switch carries its turn on.
  await act('history.branch.switch', { branch: 'Main' }, meta);
  await step('a.set', { v: 3 }, meta);
  assert.equal(history.active.turns.get('turn-3').branch, 'b0');
});

test('undo a turn others interleaved with: only its own steps go (to Recently deleted), the others are applied again', async () => {
  const { page, history, act, step } = await makePage();
  const agent = { origin: 'agent', agent: 'Claude', turn: 'turn-4' };
  await step('a.set', { v: 2 }, agent);
  await step('b.inc');
  await step('c.derive', {}, agent);
  const plan = history.turnUndoPlan('turn-4');
  assert.deepEqual([plan.contiguous, plan.own.length, plan.since], [false, 2, 3]);
  const result = await act('history.turn.undo', { turn: 'turn-4', only_own: true });
  assert.equal(result.removed, 2);
  assert.deepEqual([page.state.a, page.state.b, page.state.c], [0, 1, 0]);
  assert.equal(history.active.journal.at(-1).op, 'turn.undo');
  await act('history.journal.undo', { entry: result.journal });
  assert.deepEqual([page.state.a, page.state.b, page.state.c], [2, 1, 21]);
  valid(history);
});

test('a change that makes no step says why (unrecorded): it was so already, a merge put back, a domain not recorded, recording paused, no history yet', async () => {
  let off = [];
  const { dispatcher, history, act } = await makePage({ offDomains: () => off });
  const agent = { origin: 'agent', agent: 'Claude', turn: 'turn-8' };
  const made = await dispatcher.dispatch('a.set', { v: 4 }, agent);
  assert.equal(made.unrecorded, null, 'a step was made');
  assert.deepEqual([(await dispatcher.dispatch('a.set', { v: 4 }, agent)).step, (await dispatcher.dispatch('a.set', { v: 4 }, agent)).unrecorded], [null, 'unchanged']);
  // A merged gesture brought back where it began: its step is taken out.
  await dispatcher.dispatch('cam.set', { v: 2 }, agent);
  assert.equal((await dispatcher.dispatch('cam.set', { v: 0 }, agent)).unrecorded, 'retracted');
  off = ['camera'];
  assert.equal((await dispatcher.dispatch('cam.set', { v: 9 }, agent)).unrecorded, 'off');
  off = [];
  await act('history.recording.pause');
  assert.equal((await dispatcher.dispatch('a.set', { v: 5 }, agent)).unrecorded, 'paused');
  await act('history.recording.resume');
  // A read is no change: nothing to say.
  assert.equal((await dispatcher.dispatch('history.summary', {}, agent)).unrecorded, null);
  history.destroy();
  assert.equal((await dispatcher.dispatch('a.set', { v: 6 }, agent)).unrecorded, 'no-history');
});

test('a turn that made no step (it only read, or changed nothing) has no record: undoing it or noting it says so', async () => {
  const { history, act, step } = await makePage();
  const agent = { origin: 'agent', agent: 'Claude', turn: 'turn-6' };
  await step('a.set', { v: 1 }, { origin: 'agent', agent: 'Claude', turn: 'turn-5' });
  // The same value again: nothing changed, so no step and no record of turn-6.
  await step('a.set', { v: 1 }, agent);
  assert.equal(history.active.turns.has('turn-6'), false);
  const head = history.active.headId;
  const sentence = 'The tracker "Tracker 1" has no record of the turn "turn-6": a turn is recorded with its first step, so one that only read or changed nothing has nothing to undo; history_summary lists the turns it has.';
  await assert.rejects(act('history.turn.undo', { turn: 'turn-6' }, agent), error => error instanceof ActionRefused && error.code === 'no-target' && plainSentence(error.message) === sentence);
  await assert.rejects(history.undoTurn('turn-6'), error => error.code === 'no-target' && plainSentence(error.message) === sentence);
  await assert.rejects(act('history.note.add', { target: { turn: 'turn-6' }, text: 'Why.' }, agent),
    error => error.code === 'no-target' && /has no record of the turn "turn-6".*has no record to hold a note/.test(plainSentence(error.message)));
  assert.equal(history.active.headId, head, 'nothing moved');
  valid(history);
});

// ---------------------------------------------------------------------------
// Provenance, search, reads

test('stale: a result whose inputs changed since, with the step that made it stale', async () => {
  const { history, act, step } = await makePage();
  await step('a.set', { v: 1 });
  const derived = await step('c.derive');
  assert.deepEqual(derived.reads.filters !== undefined && derived.reads.colors !== undefined, true, 'a step records what it read');
  const cause = await step('b.inc');
  const { stale } = await act('history.stale');
  assert.deepEqual(stale.map(entry => [entry.step, entry.cause?.step]), [[derived.id, cause.id]]);
  assert.match(stale[0].reasons[0], /Colors changed at step 3 \("b \+ 1"\)\./);
  await step('c.derive');
  assert.deepEqual((await act('history.stale')).stale, [], 'computed again: not stale');
});

test('search: words in labels, notes and parameters, and filters by who and kind', async () => {
  const { history, act, step } = await makePage();
  const s1 = await step('a.set', { v: 42 });
  await step('b.inc', {}, { origin: 'agent', agent: 'Claude', turn: 'turn-5' });
  await act('history.note.add', { target: { step: s1.id }, text: 'Before the reclustering.' });
  assert.deepEqual((await act('history.search', { text: 'reclustering' })).steps, [s1.id]);
  assert.deepEqual((await act('history.search', { text: '42' })).steps, [s1.id]);
  assert.equal((await act('history.search', { by: 'agent' })).steps.length, 1);
  assert.equal((await act('history.search', { kind: 'view' })).steps.length, 1);
  assert.deepEqual((await act('history.search', { step_kind: 'root' })).steps, [history.active.rootId]);
  assert.equal((await act('history.search', { has_note: true })).total, history.active.steps.size);
});

test('history.get pages the path to the step shown under the connector limit; history.summary has no steps', async () => {
  const { act, step } = await makePage();
  for (let i = 0; i < 450; i++) await step('a.set', { v: i % 2 === 0 ? 1 : 2 });
  const first = await act('history.get', { limit: 200 });
  assert.equal(first.steps.length, 200);
  assert.equal(first.total, 451);
  const second = await act('history.get', { limit: 200, cursor: first.next });
  assert.equal(first.next, first.steps.at(-1).id, 'the cursor is the page\'s last step');
  assert.equal(second.steps[0].parent, first.next, 'the next page starts right after it');
  await assert.rejects(act('history.get', { cursor: 's99999' }), error => error.code === 'no-target');
  const last = await act('history.get', { limit: 200, cursor: second.next });
  assert.equal(last.next, null);
  assert.ok(JSON.stringify(first).length < 150_000);
  const summary = await act('history.summary');
  assert.equal(summary.steps, 451);
  assert.ok(JSON.stringify(summary).length < 2_000);
});

// ---------------------------------------------------------------------------
// Replay, versions, mapping; branch without a step, apply here, verify, revert

test('replay upgrades parameters recorded with an older version, and flags one from a newer Cellucid', async () => {
  const source = await makePage();
  await source.step('a.add', { by: 3 });
  const saved = source.history.snapshot();
  const [tracker] = saved.trackers;
  const added = tracker.steps.find(each => each.type === 'a.add');
  Object.assign(added, { v: 1, params: { amount: 3 } });
  const newer = { ...added, id: `s${tracker.nextStep}`, parent: added.id, children: [], v: 9, params: { by: 1 }, touches: [], before: {}, after: {} };
  added.children = [newer.id];
  tracker.steps.push(newer);
  tracker.branches[0].tip = newer.id;
  tracker.nextStep += 1;
  const target = await makePage();
  const { report } = await target.history.replay(replayPlanOf(saved));
  assert.deepEqual(report.map(entry => entry.outcome), ['applied', 'unmatched']);
  assert.equal(target.page.state.a, 3, 'the version 1 parameters were brought to version 2');
  assert.match(report[1].reason, /recorded with a newer Cellucid/);
});

test('a name mapping puts the names used here in place of the recorded ones', () => {
  const definition = {
    params: {
      type: 'object', properties: {
        field: CATEGORY_FIELD, category: CATEGORY_LABEL,
        list: { type: 'array', items: { type: 'object', properties: { label: { ...CATEGORY_LABEL, description: 'x' } } } },
      },
    },
  };
  const mapped = mapParams(definition, {
    field: { source: 'obs', key: 'cell_type' }, category: 'T cells', list: [{ label: 'B cells' }],
  }, {
    fields: [{ from: 'cell_type', to: 'celltype' }], genes: [],
    categories: [{ field: 'cell_type', from: 'T cells', to: 'CD4 T' }, { field: 'cell_type', from: 'B cells', to: 'B' }],
  });
  assert.deepEqual(mapped, { field: { source: 'obs', key: 'celltype' }, category: 'CD4 T', list: [{ label: 'B' }] });
});

test('the name mapping reaches every field, gene and category label the catalogue names, nullable ones too', async () => {
  const { getActionCatalog } = await import('../assets/js/app/actions/index.js');
  const catalog = getActionCatalog();
  const mapping = { fields: [], categories: [{ field: 'cell_type', from: 'gamma', to: 'delta' }], genes: [{ from: 'CD3E', to: 'CD3D' }] };
  assert.deepEqual(mapParams(catalog.get('color.by'), { field: { source: 'var', key: 'CD3E' } }, mapping), { field: { source: 'var', key: 'CD3D' } });
  assert.deepEqual(mapParams(catalog.get('color.by'), { field: null }, mapping), { field: null });
  assert.deepEqual(mapParams(catalog.get('highlight.category'), { field: { source: 'obs', key: 'cell_type' }, categories: ['gamma'] }, mapping),
    { field: { source: 'obs', key: 'cell_type' }, categories: ['delta'] });
});

test('Use instead: a name that did not match is mapped, and the steps replay again with it', async () => {
  const source = await makePage();
  providePick(source.dispatcher, source.page, { cell_type: ['T cells', 'B cells'] });
  await source.step('pick.category', { field: { source: 'obs', key: 'cell_type' }, category: 'T cells' });
  await source.step('a.set', { v: 4 });
  const plan = replayPlanOf(source.history.snapshot());
  const target = await makePage();
  providePick(target.dispatcher, target.page, { celltype: ['CD4 T', 'B'] });
  const first = await target.history.replay(plan);
  assert.deepEqual(first.report.map(entry => entry.outcome), ['unmatched', 'applied']);
  assert.deepEqual(first.report[0].missing, { kind: 'field', name: 'cell_type', field: null }, 'the report names what is missing here');
  // The field is chosen: the next replay then misses the category, named in the field as it is here.
  const fieldOnly = mappingWith(target.history.active.start.mapping, [{ missing: first.report[0].missing, to: 'celltype' }]);
  assert.deepEqual(fieldOnly, { fields: [{ from: 'cell_type', to: 'celltype' }], categories: [], genes: [] });
  const second = await target.history.replay({ ...plan, mapping: fieldOnly });
  assert.deepEqual(second.report[0].missing, { kind: 'category', name: 'T cells', field: 'celltype' });
  assert.deepEqual(target.history.active.start.mapping, fieldOnly, 'the replayed tracker keeps its mapping');
  // The category is chosen too: it is named by its field's recorded key, as the mapping names it.
  const both = mappingWith(target.history.active.start.mapping, [{ missing: second.report[0].missing, to: 'CD4 T' }]);
  assert.deepEqual(both.categories, [{ field: 'cell_type', from: 'T cells', to: 'CD4 T' }]);
  const third = await target.history.replay({ ...plan, mapping: both });
  // (a = 4 is already shown from the earlier replays: it changes nothing here.)
  assert.deepEqual(third.report.map(entry => entry.outcome), ['applied', 'unchanged']);
  assert.equal(target.page.state.b, 1, 'the step applied with the names used here');
  const replayed = target.history.active.steps.get(third.report[0].step);
  assert.deepEqual(replayed.params, { field: { source: 'obs', key: 'celltype' }, category: 'CD4 T' });
  // A name the mapping already put in, missing again, is mapped from the recorded one.
  assert.deepEqual(mappingWith(both, [{ missing: { kind: 'category', name: 'CD4 T', field: 'celltype' }, to: 'B' }]).categories,
    [{ field: 'cell_type', from: 'T cells', to: 'B' }]);
  assert.deepEqual(mappingWith(both, [{ missing: { kind: 'gene', name: 'CD3E', field: null }, to: 'Cd3e' }, { missing: { kind: 'gene', name: 'X', field: null }, to: '' }]).genes,
    [{ from: 'CD3E', to: 'Cd3e' }], 'an empty choice is no choice');
  valid(target.history);
});

test('where the memory goes: each part that holds typed arrays, largest first, each buffer once, summing to the pool', async () => {
  const { page, dispatcher, history, act, step } = await makePage();
  dispatcher.provide('cells.set', ({ n }) => { page.state.a = { cells: Uint32Array.from({ length: n }, (_value, index) => index) }; });
  const big = await step('cells.set', { n: 1000 });
  const small = await step('cells.set', { n: 250 });
  await step('b.inc');
  let memory = history.memoryParts();
  assert.equal(memory.total, history.pool.byteLength());
  assert.equal(memory.total, 5000);
  assert.deepEqual(memory.parts.map(part => [part.kind, part.step, part.domain, part.bytes]), [
    ['step', big.id, 'filters', 4000],
    ['step', small.id, 'filters', 1000],
  ]);
  // The same cells again are one value: nothing more is held.
  await step('cells.set', { n: 1000 });
  assert.equal(history.memoryParts().total, 5000);
  // A deleted step's value is held by Recently deleted until it is emptied.
  await act('history.step.delete', { step: small.id });
  memory = history.memoryParts();
  const kept = memory.parts.find(part => part.kind === 'deleted');
  assert.equal(kept.bytes, 1000);
  assert.match(kept.label, /Deleted/);
  assert.equal(memory.parts.reduce((sum, part) => sum + part.bytes, 0), memory.total);
  await act('history.journal.empty');
  memory = history.memoryParts();
  assert.deepEqual(memory.parts.map(part => [part.kind, part.bytes]), [['step', 4000]]);
  assert.equal(memory.total, 4000);
});

test('branch without a step, apply a branch here, verify, revert', async () => {
  const { page, history, act, step } = await makePage();
  const s1 = await step('a.set', { v: 1 });
  const s2 = await step('b.inc');
  await step('c.derive');
  const without = await act('history.branch.without', { step: s1.id });
  assert.equal(without.branch.name, 'Without "a = 1"');
  assert.deepEqual([page.state.a, page.state.b, page.state.c], [0, 1, 1]);
  const verified = await act('history.verify', { branch: 'Main' });
  assert.equal(verified.reproduced, true);
  assert.equal(verified.scratch, null);
  assert.equal(history.trackers().length, 1, 'the scratch tracker is gone');
  await act('history.branch.switch', { branch: 'Main' });
  const reverted = history.active.headId;
  await act('history.step.revert', { step: reverted });
  assert.equal(page.state.c, 0, 'the step\'s before-values are put back, as a new step');
  assert.equal(history.active.steps.get(history.active.headId).parent, reverted);
  // A later step changed the same part: revert is refused, saying what to do instead.
  const b1 = await step('b.inc');
  await step('b.inc');
  await assert.rejects(act('history.step.revert', { step: b1.id }),
    error => error.code === 'not-revertible' && /Later steps also change Colors; use Branch without this step/.test(error.message));
  void s2;
  const applied = await act('history.branch.apply', { branch: without.branch.id });
  assert.ok(applied.branch !== null);
  valid(history);
});

test('a session file\'s trackers load beside the person\'s, each saying it was loaded; a taken id is issued again', async () => {
  const source = await makePage();
  await source.step('a.set', { v: 7 });
  const saved = source.history.snapshot();
  const values = new Map(source.history.pool.hashes().map(hash => [hash, source.history.pool.get(hash)]));
  const target = await makePage();
  await target.step('b.inc');
  // The same file loaded twice.
  const first = await target.history.importTrackers(saved, { file: 'shared.cellucid-session', values });
  const second = await target.history.importTrackers(saved, { file: 'shared.cellucid-session', values });
  assert.equal(target.history.trackers().length, 3);
  assert.notEqual(first.tracker.id, second.tracker.id);
  assert.equal(second.tracker.name, 'Tracker 1 (shared 2)');
  assert.equal(target.history.active.start.kind, 'import');
  assert.equal(target.history.active.start.from.file, 'shared.cellucid-session');
  assert.equal(target.page.state.a, 7);
  valid(target.history);
});

test('loading beside a taken id: the conversations and Recently deleted read behind the head follow the re-issued id', async () => {
  const source = await makePage();
  await source.step('a.set', { v: 7 });
  source.history.setChat(source.history.active.id, 'c1', { schema: 1, id: 'c1', messages: [{ role: 'user', text: 'Hello' }] });
  const whole = source.history.snapshot();
  const values = new Map(source.history.pool.hashes().map(hash => [hash, source.history.pool.get(hash)]));
  // As a session file gives it: the head first, its conversations behind it (`readRest`).
  const eager = { ...whole, trackers: whole.trackers.map(record => ({ ...record, chats: [] })) };
  const fileId = whole.activeTracker;
  const rest = async () => ({ values: [], chats: [{ tracker: fileId, conversation: 'c1', transcript: whole.trackers[0].chats[0][1] }], journals: [], params: [] });
  const target = await makePage();
  await target.history.importTrackers(eager, { file: 'shared.cellucid-session', values, rest });
  // The same file again: its tracker id is taken now, so it is issued again, and what came behind follows it.
  const again = await target.history.importTrackers(eager, { file: 'shared.cellucid-session', values, rest });
  assert.notEqual(again.tracker.id, fileId);
  assert.deepEqual(target.history.chatsOf(again.tracker.id).map(([id]) => id), ['c1']);
  valid(target.history);
});

test('a load is journaled: undoing it removes the loaded tracker to Recently deleted, from where it comes back (review S5)', async () => {
  const source = await makePage();
  await source.step('a.set', { v: 7 });
  const saved = source.history.snapshot();
  const values = new Map(source.history.pool.hashes().map(hash => [hash, source.history.pool.get(hash)]));
  const target = await makePage();
  await target.step('b.inc');
  const own = target.history.active.id;
  const loaded = await target.history.importTrackers(saved, { file: 'shared.cellucid-session', values });
  const [added] = loaded.trackers;
  const entry = target.history.active.journal.find(each => each.id === added.journal);
  assert.equal(entry.op, 'load');
  assert.equal(entry.label, `Loaded "${added.name}" from shared.cellucid-session`);
  valid(target.history);
  // Undo the load: the person's own tracker is shown again, the loaded one is in Recently deleted.
  const undone = await target.act('history.journal.undo', { tracker: added.id, entry: added.journal });
  assert.equal(target.history.active.id, own);
  assert.equal(target.history.trackers().some(tracker => tracker.id === added.id), false);
  const removed = target.history.allTrackers().find(tracker => tracker.id === added.id);
  assert.equal(removed.journal.find(each => each.id === undone.journal).op, 'tracker.remove');
  valid(target.history);
  // Undone twice: it is in Recently deleted already.
  await assert.rejects(target.act('history.journal.undo', { tracker: added.id, entry: added.journal }), /in Recently deleted already/);
  // Restored from Recently deleted, as any removed tracker.
  await target.act('history.journal.undo', { tracker: added.id, entry: undone.journal });
  assert.equal(target.history.trackers().some(tracker => tracker.id === added.id), true);
  valid(target.history);
});

test('a tracker is removed to Recently deleted and restored from it', async () => {
  const { history, act } = await makePage();
  const first = history.active.id;
  await act('history.tracker.start', { start: 'opened' });
  const removed = await act('history.tracker.remove', { tracker: first });
  assert.equal(history.trackers().length, 1);
  await act('history.journal.undo', { entry: removed.journal, tracker: first });
  assert.equal(history.trackers().length, 2);
  valid(history);
  assert.equal(valuesAt(history.active, history.active.headId).filters !== undefined, true);
  void pathTo;
});

test('loading beside: a replayed tracker keeps its start, and every reference to a re-issued id follows it', async () => {
  const source = await makePage();
  await source.step('a.set', { v: 2 });
  const plan = replayPlanOf(source.history.snapshot());
  await source.history.replay({ ...plan, name: 'Mine again' });
  const saved = source.history.snapshot();
  const values = new Map(source.history.pool.hashes().map(hash => [hash, source.history.pool.get(hash)]));
  // Loaded into the same page: both ids are taken, so both are issued again.
  const before = source.history.trackers().map(tracker => tracker.id);
  await source.history.importTrackers(saved, { file: 'again.cellucid-session', values });
  const added = source.history.trackers().filter(tracker => !before.includes(tracker.id));
  assert.equal(added.length, 2);
  const replayed = added.find(tracker => tracker.start.kind === 'replay');
  const original = added.find(tracker => tracker.start.kind === 'import');
  assert.equal(replayed.start.from.tracker.id, original.id, 'the link follows the re-issued id');
  for (const step of replayed.steps.values()) if (step.replayOf !== null) assert.equal(step.replayOf.tracker, original.id);
  assert.equal(original.start.from.file, 'again.cellucid-session');
  valid(source.history);
});

test('a re-issued tracker id is free of the history\'s trackers and of the file\'s', async () => {
  const page = fakePage();
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([...definitions, ...historyActions]) });
  dispatcher.provide('a.set', ({ v }) => { page.state.a = v; });
  // Counter ids: the page holds 1, the file holds 1 and 2, so 1 issued again must not become 2.
  let n = 0;
  const history = createHistory({
    dispatcher, domains: page.domains, dataset: { id: 'd1', name: 'Demo', cellOrder: null }, newTrackerId: () => trackerId(++n),
  });
  await history.startTracker();
  const source = await makePage();
  const saved = source.history.snapshot();
  const [first] = saved.trackers;
  const second = { ...structuredClone(first), id: trackerId(2), name: 'Other' };
  saved.trackers = [{ ...first, id: trackerId(1) }, second];
  saved.activeTracker = trackerId(1);
  const values = new Map(source.history.pool.hashes().map(hash => [hash, source.history.pool.get(hash)]));
  const result = await history.importTrackers(saved, { file: 'clash.cellucid-session', values });
  const ids = history.trackers().map(tracker => tracker.id);
  assert.equal(new Set(ids).size, 3);
  assert.ok(!['t-00000000-0000-4000-8000-000000000001', 't-00000000-0000-4000-8000-000000000002'].includes(result.tracker.id));
  valid(history);
});

test('history.get reads another tracker, the path to a branch\'s tip, the steps since a time, and the fields asked for', async () => {
  const { history, act, step } = await makePage();
  const s1 = await step('a.set', { v: 1 });
  await act('history.note.add', { target: { step: s1.id }, text: 'first' });
  await act('history.bookmark.set', { step: s1.id, name: 'Start' });
  const s2 = await step('a.set', { v: 2 });
  await history.jump(s1.id);
  const s3 = await step('b.inc');
  const other = history.active.steps.get(s3.id).branch;
  // The path to Main's tip, while the other branch is shown.
  const main = await act('history.get', { branch: 'Main' });
  assert.deepEqual(main.steps.map(row => row.id), ['s0', s1.id, s2.id]);
  assert.deepEqual(main.steps.map(row => row.shown), [true, true, false]);
  const since = history.active.steps.get(s2.id).at;
  assert.deepEqual((await act('history.get', { all_branches: true, since })).steps.map(row => row.id), [s2.id, s3.id]);
  const withFields = await act('history.get', { fields: ['params', 'notes', 'bookmark'] });
  const row = withFields.steps.find(each => each.id === s1.id);
  assert.deepEqual(row.notes.map(note => note.text), ['first']);
  assert.equal(row.bookmark, 'Start');
  assert.ok(row.params.length > 0 && row.params.every(fact => typeof fact.value === 'string'));
  assert.equal('params' in (await act('history.get', {})).steps[1], false, 'nothing added unless asked');
  await assert.rejects(act('history.get', { branch: other, all_branches: true }), error => error.code === 'no-target');
  // Another tracker by name.
  await act('history.tracker.start', { start: 'opened', name: 'Second' });
  const first = await act('history.get', { tracker: 'Tracker 1' });
  assert.equal(first.tracker.name, 'Tracker 1');
  assert.equal(first.head, s3.id);
});
