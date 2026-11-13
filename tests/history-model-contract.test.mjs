/**
 * The history's records (`assets/js/app/history/model.js`): the exact fields
 * of a tracker, a branch, a group, a step (of each kind: root, action,
 * outside, squashed), a note, a turn and a journal entry, the rules a whole
 * tracker keeps (groups, the recording switch), what a session's scope says
 * it holds, the name rule, the constructors, the sentences, and the JSON
 * Schema document Python and R build their reading model from, which must
 * say what the validators check. No step holds a picture.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BY_ORIGINS, FIRST_BRANCH_ID, HISTORY_LANE_COUNT, HISTORY_RECORDS, HISTORY_SENTENCES, HistoryModelError,
  JOURNAL_OPS, OUTSIDE_CHANGE_TYPE, ROOT_STEP_ID, SQUASH_CAUSES, STEP_KINDS, STEP_STATUSES, createBranch, createBy,
  createGroup, createJournalEntry, createNote, createStep, createTracker, createTurn, defaultName, emptyPatch,
  historyModelDocument, idOf, laneOf, nameKey, nameProblem, normalizeName, recordFields, squashedLabel, suffixedName,
  validateHistory, validateRecord, validateSession, validateTracker,
} from '../assets/js/app/history/model.js';
import { ACTION_ORIGINS } from '../assets/js/app/actions/dispatcher.js';
import { ACTION_READ_INPUTS } from '../assets/js/app/actions/catalog.js';
import { DOMAIN_IDS } from '../assets/js/app/actions/domains.js';
import { OUTSIDE_CHANGE_TYPE as STEP_TEXT_OUTSIDE } from '../assets/js/app/history/exports/step-text.js';

const TRACKER_ID = 't-00000000-0000-4000-8000-000000000001';
const OTHER_ID = 't-00000000-0000-4000-8000-000000000002';
const hash = letter => letter.repeat(64);
const ROOT_VALUES = Object.fromEntries(DOMAIN_IDS.map((domain, index) => [domain, hash('0123456789abcdef'[index])]));
const DATASET = { id: 'pbmc', name: 'PBMC 3k', cellOrder: null };
const START = createBy({ origin: 'startup' });
const PERSON = createBy({ origin: 'user' });
const CLAUDE = createBy({ origin: 'agent', agent: 'Claude', model: 'claude-sonnet-4-6', turn: 'turn-1' });

const NOTHING_CARRIED = Object.freeze({ notes: Object.freeze([]), bookmarks: Object.freeze([]) });
const step = (tracker, id) => tracker.steps.find(s => s.id === id);
const branch = (tracker, id) => tracker.branches.find(b => b.id === id);

/** Add a step below `parent` on `branch`, as the history appends one. */
function add(tracker, { parent, branch, type = 'color.by', label = 'Colored by cell_type', by = PERSON, touches = ['active-field'], at = 10 }) {
  const id = idOf('step', tracker.nextStep++);
  const outside = type === OUTSIDE_CHANGE_TYPE;
  const step = createStep({
    id, parent, branch, kind: outside ? 'outside' : 'action', type, params: { field: { source: 'obs', key: 'cell_type' } },
    v: outside ? null : 1, code: outside ? null : 'color_by("cell_type")', label, by, at,
    touches, before: Object.fromEntries(touches.map(d => [d, hash('a')])), after: Object.fromEntries(touches.map(d => [d, hash('b')])),
    reads: { cells: hash('c') },
  });
  tracker.steps.find(s => s.id === parent).children.push(id);
  tracker.steps.push(step);
  const owner = tracker.branches.find(b => b.id === branch);
  if (owner !== undefined) owner.tip = id;
  return step;
}

/**
 * A tracker with every kind of record: three branches (one nested), an agent
 * turn with a summary, notes by a person and an agent, a bookmark, an outside
 * change, a journal entry and a purged one.
 */
function sample() {
  const tracker = createTracker({ id: TRACKER_ID, name: 'Tracker 1', dataset: DATASET, createdAt: 1, by: START, rootValues: ROOT_VALUES });
  add(tracker, { parent: 's0', branch: 'b0' });                                                         // s1
  add(tracker, { parent: 's1', branch: 'b0', type: 'filter.category.visibility', label: 'Hid alpha', by: CLAUDE, touches: ['filters'] }); // s2
  add(tracker, { parent: 's2', branch: 'b0', by: CLAUDE });                                             // s3
  const b1 = createBranch({ id: idOf('branch', tracker.nextBranch++), name: 'Without alpha', base: 's1', tip: 's1', createdAt: 20, by: PERSON });
  tracker.branches.push(b1);
  add(tracker, { parent: 's1', branch: 'b1', at: 20 });                                                 // s4
  add(tracker, { parent: 's4', branch: 'b1', at: 21 });                                                 // s5
  tracker.branches.push(createBranch({ id: idOf('branch', tracker.nextBranch++), name: 'Nested', base: 's4', tip: 's4', createdAt: 22, by: PERSON }));
  add(tracker, { parent: 's4', branch: 'b2', at: 22 });                                                 // s6
  add(tracker, {
    parent: 's3', branch: 'b0', type: OUTSIDE_CHANGE_TYPE, label: 'Changed outside the history',
    by: createBy({ origin: 'outside' }), touches: ['camera'],
  });                                                                                                   // s7
  tracker.headId = 's3';
  tracker.steps.find(s => s.id === 's3').bookmark = 'Before reclustering';
  tracker.turns.push(createTurn({ id: 'turn-1', by: CLAUDE, label: 'Hide alpha', startedAt: 11, branch: 'b0' }));
  tracker.notes.push(createNote({ id: idOf('note', tracker.nextNote++), text: 'T cell analysis', by: PERSON, at: 2 }));
  tracker.steps.find(s => s.id === 's2').notes.push(createNote({ id: idOf('note', tracker.nextNote++), text: 'Alpha are doublets.', by: CLAUDE, at: 12 }));
  b1.notes.push(createNote({ id: idOf('note', tracker.nextNote++), text: 'Try *without* alpha.', by: PERSON, at: 23 }));
  tracker.turns[0].notes.push(createNote({ id: idOf('note', tracker.nextNote++), text: 'Hid alpha.', by: CLAUDE, at: 13, fromReply: true }));
  // A group over the agent's whole turn (s2, s3), with a note.
  const group = createGroup({ id: idOf('group', tracker.nextGroup++), name: 'Alpha', createdAt: 14, by: PERSON });
  group.notes.push(createNote({ id: idOf('note', tracker.nextNote++), text: 'Alpha removed.', by: PERSON, at: 14 }));
  tracker.groups.push(group);
  for (const id of ['s2', 's3']) step(tracker, id).group = group.id;
  // A squashed step on the nested branch: what changed while recording was paused.
  const squashed = createStep({
    id: idOf('step', tracker.nextStep++), parent: 's6', branch: 'b2', kind: 'squashed',
    label: squashedLabel({ cause: 'paused', count: null, domains: ['Colors'] }), by: PERSON, at: 30, touches: ['colors'],
    before: { colors: hash('a') }, after: { colors: hash('b') },
    squashed: { cause: 'paused', count: null, by: [PERSON, createBy({ origin: 'host', host: 'python' })], carried: NOTHING_CARRIED },
  });
  step(tracker, 's6').children.push(squashed.id);
  tracker.steps.push(squashed);
  branch(tracker, 'b2').tip = squashed.id;
  const renamedBefore = { ...structuredClone(b1), name: 'Branch 1' };
  tracker.journal.push(createJournalEntry({
    id: idOf('journal', tracker.nextJournal++), op: 'branch.rename', at: 24, by: PERSON, label: 'Renamed branch "Branch 1" to "Without alpha"',
    before: { ...emptyPatch(), branches: [renamedBefore] }, after: { ...emptyPatch(), branches: [structuredClone(b1)] },
  }));
  tracker.journal.push({
    id: idOf('journal', tracker.nextJournal++), op: 'note.remove', at: 25, by: PERSON, label: 'Removed a note', before: null, after: null, purged: true,
  });
  return tracker;
}

function rejects(mutate, message) {
  const tracker = sample();
  mutate(tracker);
  assert.throws(() => validateTracker(tracker), error => {
    assert.ok(error instanceof HistoryModelError, `a HistoryModelError, not ${error}`);
    assert.equal(error.message, message);
    return true;
  });
}


import { plainSentence } from '../assets/js/app/actions/targets/names.js';

/** The history's sentences as a person reads them (an agent reads their names marked: `targets/names.js`). */
const SENTENCES = Object.fromEntries(Object.entries(HISTORY_SENTENCES).map(([key, say]) => [key, (...args) => plainSentence(say(...args))]));
const plainNameProblem = (...args) => {
  const problem = nameProblem(...args);
  return problem === null ? null : plainSentence(problem);
};

test('a tracker with every kind of record is valid, and stays valid through JSON', () => {
  const tracker = sample();
  assert.equal(validateTracker(tracker), tracker);
  assert.doesNotThrow(() => validateTracker(JSON.parse(JSON.stringify(tracker))));
  assert.doesNotThrow(() => validateHistory({ dataset: DATASET, activeTracker: TRACKER_ID, trackers: [tracker] }));
  assert.deepEqual(tracker.steps.map(s => s.id), ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'], 'steps in id order');
  assert.deepEqual(tracker.steps.map(s => s.kind), ['root', 'action', 'action', 'action', 'action', 'action', 'action', 'outside', 'squashed']);
  assert.ok(STEP_KINDS.every(kind => tracker.steps.some(s => s.kind === kind)), 'every kind of step');
  assert.ok(!recordFields('Step').includes('picture'), 'no step holds a picture (§3.15.7)');
});

test('a new tracker: root s0 on branch b0 "Main", shown, active and main, counters at the start', () => {
  const tracker = createTracker({ id: TRACKER_ID, name: 'Tracker 1', dataset: DATASET, createdAt: 5, by: START, rootValues: ROOT_VALUES });
  assert.deepEqual(Object.keys(tracker), recordFields('Tracker'));
  assert.equal(tracker.rootId, ROOT_STEP_ID);
  assert.equal(tracker.headId, ROOT_STEP_ID);
  assert.equal(tracker.activeBranch, FIRST_BRANCH_ID);
  assert.equal(tracker.mainBranch, FIRST_BRANCH_ID);
  assert.deepEqual(tracker.branches, [{
    id: 'b0', name: 'Main', base: null, tip: 's0', createdAt: 5, by: START, lane: 0, locked: false, archived: false, notes: [],
  }]);
  const [root] = tracker.steps;
  assert.deepEqual(Object.keys(root), recordFields('Step'));
  assert.equal(root.label, 'Opened');
  assert.deepEqual(root.after, ROOT_VALUES);
  assert.deepEqual([tracker.nextStep, tracker.nextBranch, tracker.nextGroup, tracker.nextNote, tracker.nextJournal], [1, 1, 0, 0, 0]);
  assert.equal(root.kind, 'root');
  assert.equal(root.v, null);
  assert.deepEqual([tracker.paused, tracker.groups], [null, []]);
  const paused = createTracker({ id: OTHER_ID, name: 'Tracker 2', dataset: DATASET, createdAt: 7, by: START, rootValues: ROOT_VALUES, recording: false });
  assert.deepEqual(paused.paused, { at: 7, by: [START], draft: null }, 'a tracker started with recording off is paused since it started, by whoever started it');
  assert.deepEqual(tracker.start, { kind: 'opened', from: null, report: null, mapping: null });
  const shown = createTracker({
    id: OTHER_ID, name: 'Tracker 2', dataset: DATASET, createdAt: 5, by: PERSON, rootValues: ROOT_VALUES,
    start: { kind: 'shown', from: null, report: null, mapping: null },
  });
  assert.equal(shown.steps[0].label, 'Started from the state shown');
  assert.equal(shown.steps[0].by, PERSON);
});

test('the tree rules, each refused with its sentence', () => {
  rejects(t => { step(t, 's1').children = ['s2']; }, 'tracker "t-00000000-0000-4000-8000-000000000001": step "s4" and its parent disagree');
  rejects(t => { step(t, 's6').branch = 'b1'; }, 'tracker "t-00000000-0000-4000-8000-000000000001": branch "b1" splits at step "s4"; a branch is one line');
  rejects(t => { branch(t, 'b1').tip = 's4'; }, 'tracker "t-00000000-0000-4000-8000-000000000001": branch "b1"\'s tip must be its last step ("s5")');
  rejects(t => { step(t, 's4').branch = 'b2'; }, 'tracker "t-00000000-0000-4000-8000-000000000001": branch "b1"\'s steps must form one line starting right after its fork step');
  rejects(t => { branch(t, 'b2').base = 's5'; }, 'tracker "t-00000000-0000-4000-8000-000000000001": branch "b2"\'s steps must form one line starting right after its fork step');
  rejects(t => { branch(t, 'b2').base = 's6'; }, 'tracker "t-00000000-0000-4000-8000-000000000001": branch "b2" forks from one of its own steps');
  rejects(t => { branch(t, 'b1').base = null; }, 'tracker "t-00000000-0000-4000-8000-000000000001" must have exactly one branch without a fork step (the one holding the root)');
  rejects(t => { t.branches.push(createBranch({ id: 'b3', name: 'Empty', base: 's3', tip: 's3', createdAt: 1, by: PERSON })); t.nextBranch = 4; },
    'tracker "t-00000000-0000-4000-8000-000000000001": branch "b3" has no step of its own');
  rejects(t => { branch(t, 'b2').name = 'without  ALPHA'; }, 'tracker.branches["b2"].name must be a name in its stored form (NFC, trimmed, single-spaced)');
  rejects(t => { branch(t, 'b2').name = 'without ALPHA'; },
    'tracker "t-00000000-0000-4000-8000-000000000001": branch "b1" and branch "b2" share the name "without ALPHA"');
  rejects(t => { branch(t, 'b2').name = 'B7'; },
    'tracker "t-00000000-0000-4000-8000-000000000001": A branch cannot be called "B7": that is the form of a branch id. Choose another name.');
  rejects(t => { step(t, 's5').bookmark = 'before Reclustering'; },
    'tracker "t-00000000-0000-4000-8000-000000000001": step "s3" and step "s5" share the name "before Reclustering"');
  rejects(t => { t.headId = 's5'; }, 'tracker "t-00000000-0000-4000-8000-000000000001"\'s head must be on its active branch\'s path');
  rejects(t => { t.activeBranch = 'b1'; branch(t, 'b1').archived = true; t.headId = 's1'; },
    'tracker "t-00000000-0000-4000-8000-000000000001"\'s active branch is archived, so the head must be on it');
  rejects(t => { branch(t, 'b0').archived = true; }, 'tracker "t-00000000-0000-4000-8000-000000000001"\'s main branch cannot be archived');
  rejects(t => { t.mainBranch = 'b9'; }, 'tracker "t-00000000-0000-4000-8000-000000000001"\'s main branch is not one of its branches');
  rejects(t => { t.nextStep = 6; }, 'tracker "t-00000000-0000-4000-8000-000000000001": step "s6" is numbered past nextStep');
  rejects(t => { t.steps.reverse(); }, 'tracker "t-00000000-0000-4000-8000-000000000001" lists its steps out of id order');
  rejects(t => { t.steps[0].by = PERSON; }, 'tracker "t-00000000-0000-4000-8000-000000000001"\'s root is by whoever started it (tracker.by)');
  rejects(t => { step(t, 's3').by = { ...CLAUDE, turn: 'turn-2' }; },
    'tracker "t-00000000-0000-4000-8000-000000000001": step "s3" belongs to the turn "turn-2", which it does not hold');
  rejects(t => { t.turns.push(createTurn({ id: 'turn-9', by: { ...CLAUDE, turn: 'turn-9' }, label: 'Nothing', startedAt: 1, branch: 'b0' })); },
    'tracker "t-00000000-0000-4000-8000-000000000001": turn "turn-9" has no step and did nothing outside the state');
  rejects(t => { t.turns[0].branch = 'b7'; }, 'tracker "t-00000000-0000-4000-8000-000000000001": turn "turn-1" acts on a branch the tracker does not hold');
  rejects(t => { step(t, 's5').notes.push({ ...t.notes[0] }); }, 'tracker "t-00000000-0000-4000-8000-000000000001" holds the note "n0" twice');
  rejects(t => { t.removed = { at: 30, by: PERSON }; },
    'tracker "t-00000000-0000-4000-8000-000000000001" is removed, so its journal must keep the removal (to restore it)');
  rejects(t => { t.journal.reverse(); }, 'tracker "t-00000000-0000-4000-8000-000000000001" lists its journal out of id order');
});

test('groups: consecutive steps of one branch, whole turns, one level, unique names', () => {
  const T = 'tracker "t-00000000-0000-4000-8000-000000000001"';
  rejects(t => { step(t, 's3').group = null; }, `${T}: a group cuts the run of turn "turn-1" between steps "s2" and "s3"; a group holds whole runs of a turn`);
  rejects(t => { step(t, 's2').group = null; }, `${T}: a group cuts the run of turn "turn-1" between steps "s2" and "s3"; a group holds whole runs of a turn`);
  // The turn acting again after someone else's step (s7, outside) starts a new run: the group need not take it.
  const resumed = sample();
  add(resumed, { parent: 's7', branch: 'b0', by: CLAUDE });
  assert.doesNotThrow(() => validateTracker(resumed));
  rejects(t => { step(t, 's4').group = 'g0'; }, `${T}: group "g0"'s steps must be consecutive steps of one branch`);
  rejects(t => {
    for (const id of ['s2', 's3']) step(t, id).group = null;
    for (const id of ['s4', 's6']) step(t, id).group = 'g0';
  }, `${T}: group "g0"'s steps must be consecutive steps of one branch`);
  rejects(t => { for (const id of ['s2', 's3']) step(t, id).group = null; }, `${T}: group "g0" has no step`);
  rejects(t => { step(t, 's5').group = 'g7'; }, `${T}: step "s5" is in the group "g7", which it does not hold`);
  rejects(t => { t.steps[0].group = 'g0'; }, 'tracker.steps["s0"] is the root and records no action');
  rejects(t => { t.nextGroup = 0; }, `${T}: group "g0" is numbered past nextGroup`);
  rejects(t => {
    t.groups.push(createGroup({ id: 'g1', name: 'alpha', createdAt: 1, by: PERSON }));
    t.nextGroup = 2;
    step(t, 's5').group = 'g1';
  }, `${T}: group "g0" and group "g1" share the name "alpha"`);
  rejects(t => { t.groups[0].name = 'G3'; }, `${T}: A group cannot be called "G3": that is the form of a group id. Choose another name.`);
  rejects(t => { t.groups[0].notes.push({ ...t.notes[0] }); }, `${T} holds the note "n0" twice`);
  // A group over steps 4 and 5 of "Without alpha" holds them, whatever forks inside.
  const tracker = sample();
  tracker.groups.push(createGroup({ id: 'g1', name: 'Without', createdAt: 1, by: PERSON }));
  tracker.nextGroup = 2;
  for (const id of ['s4', 's5']) step(tracker, id).group = 'g1';
  assert.doesNotThrow(() => validateTracker(tracker));
  // A group may hold a person's steps around a whole turn.
  step(tracker, 's1').group = 'g0';
  assert.doesNotThrow(() => validateTracker(tracker));
});

test('steps of each kind; the squashed step and the recording switch', () => {
  rejects(t => { step(t, 's1').kind = 'squashed'; }, 'tracker.steps["s1"] says what it stands for (squashed) exactly when it is squashed');
  rejects(t => { step(t, 's1').v = null; }, 'tracker.steps["s1"] records the version of its action\'s parameters (v)');
  rejects(t => { step(t, 's1').v = 0; }, 'tracker.steps["s1"].v must be a whole number from 1 or null');
  rejects(t => { step(t, 's7').v = 1; }, 'tracker.steps["s7"] records a parameters version (v) only for an action');
  rejects(t => { step(t, 's7').kind = 'action'; },
    'tracker.steps["s7"] is of kind "outside" exactly when it is a change made outside an action (history.outside-change)');
  rejects(t => { step(t, 's1').kind = 'root'; }, 'tracker.steps["s1"] is the root (kind "root") exactly when it has no parent');
  rejects(t => { t.steps[0].kind = 'action'; }, 'tracker.steps["s0"] is the root (kind "root") exactly when it has no parent');
  rejects(t => { step(t, 's8').type = 'color.by'; },
    'tracker.steps["s8"] is squashed and records no action of its own (type, params, code, coalesceKey and replayOf null)');
  rejects(t => { step(t, 's8').squashed.count = 3; },
    'tracker.steps["s8"].squashed counts the steps it replaced (count) exactly when they were recorded and shown (steps, clear)');
  rejects(t => { step(t, 's8').squashed.by = []; }, 'tracker.steps["s8"].squashed names who acted (by) exactly unless it is a shared state');
  rejects(t => { step(t, 's8').squashed.by = [PERSON, PERSON]; }, 'tracker.steps["s8"].squashed.by names one author twice');
  rejects(t => { step(t, 's8').squashed.cause = 'merged'; },
    `tracker.steps["s8"].squashed.cause must be one of ${SQUASH_CAUSES.map(c => `"${c}"`).join(', ')}`);
  rejects(t => { step(t, 's8').squashed = null; }, 'tracker.steps["s8"] says what it stands for (squashed) exactly when it is squashed');
  rejects(t => { t.paused = { at: 40, by: [], draft: null }; }, 'tracker.paused names who paused it (by)');
  rejects(t => { t.paused = { at: 40, by: [PERSON, PERSON], draft: null }; }, 'tracker.paused.by names one author twice');
  rejects(t => { t.paused = { at: 40, by: [PERSON], draft: { nowhere: hash('a') } }; }, 'tracker.paused.draft has an unknown field "nowhere"');
  rejects(t => { t.recording = false; }, 'tracker has an unknown field "recording"');
  const paused = sample();
  paused.paused = { at: 40, by: [PERSON, createBy({ origin: 'host', host: 'r' })], draft: { colors: hash('d'), camera: hash('e') } };
  assert.doesNotThrow(() => validateTracker(paused), 'a paused tracker keeps the draft of what differs, as values');
  paused.paused = { at: null, by: [PERSON], draft: null };
  assert.doesNotThrow(() => validateTracker(paused), 'a file shared without times keeps no time of the pause');
  rejects(t => { step(t, 's8').squashed.carried = { notes: [], bookmarks: ['Kept'] }; },
    'tracker.steps["s8"].squashed carries notes or bookmarks only for squashed steps (cause steps)');
  const squashedSteps = { cause: 'steps', count: 6, by: [CLAUDE], carried: NOTHING_CARRIED };
  assert.deepEqual(validateRecord('Squash', squashedSteps), squashedSteps);
  assert.throws(() => validateRecord('Squash', { cause: 'share', count: null, by: [PERSON], carried: NOTHING_CARRIED }),
    { message: 'squash names who acted (by) exactly unless it is a shared state' });
  assert.equal(squashedLabel({ cause: 'paused', count: null, domains: ['Colors', 'Filters', 'Camera'] }), 'While paused: Colors, Filters, Camera');
  assert.equal(squashedLabel({ cause: 'steps', count: 6, domains: ['Camera'] }), 'Merged 6 steps: Camera');
  assert.equal(squashedLabel({ cause: 'clear', count: 14, domains: ['Highlights'] }), 'Fresh start: Highlights');
  assert.equal(squashedLabel({ cause: 'share', count: null, domains: ['Highlights'] }), 'Shared state');
  assert.throws(() => squashedLabel({ cause: 'other', count: null, domains: [] }), HistoryModelError);
});

test('the record rules, each refused with its path', () => {
  rejects(t => { step(t, 's1').extra = 1; }, 'tracker.steps["s1"] has an unknown field "extra"');
  rejects(t => { delete step(t, 's1').reads; }, 'tracker.steps["s1"] lacks "reads"');
  rejects(t => { step(t, 's2').by = { ...CLAUDE, agent: null }; }, 'tracker.steps["s2"].by names an agent exactly when its origin is "agent"');
  rejects(t => { step(t, 's1').by = { ...PERSON, model: 'gpt' }; }, 'tracker.steps["s1"].by names a model only for an agent');
  rejects(t => { step(t, 's1').by = { ...PERSON, origin: 'host' }; }, 'tracker.steps["s1"].by names a host exactly when its origin is "host"');
  rejects(t => { step(t, 's1').by = { ...PERSON, turn: 'turn-1' }; }, 'tracker.steps["s1"].by belongs to a turn only for an agent or a host');
  rejects(t => { step(t, 's1').by = { ...PERSON, origin: 'robot' }; },
    `tracker.steps["s1"].by.origin must be one of ${BY_ORIGINS.map(o => `"${o}"`).join(', ')}`);
  rejects(t => { step(t, 's7').by = PERSON; },
    'tracker.steps["s7"] is by "outside" exactly when it is a change made outside an action (history.outside-change)');
  rejects(t => { step(t, 's1').touches = ['active-field', 'cells']; },
    'tracker.steps["s1"] lists its touched domains out of domain order');
  rejects(t => { step(t, 's1').after = { filters: hash('b') }; },
    'tracker.steps["s1"] must hold a value before and after for exactly the domains it touches');
  rejects(t => { step(t, 's1').after = { 'active-field': 'b' }; }, 'tracker.steps["s1"].after.active-field must be a value hash (64 lower-case hex digits)');
  rejects(t => { step(t, 's1').reads = { nowhere: hash('c') }; }, 'tracker.steps["s1"].reads has an unknown field "nowhere"');
  rejects(t => { step(t, 's1').status = 'unapplicable'; }, 'tracker.steps["s1"] no longer applies and must say why (reason)');
  rejects(t => { step(t, 's1').until = 1; }, 'tracker.steps["s1"] ends (until) before it starts (at)');
  rejects(t => { step(t, 's1').merged = 0; }, 'tracker.steps["s1"].merged must be a whole number from 1');
  rejects(t => { step(t, 's1').bookmark = ' Padded'; }, 'tracker.steps["s1"].bookmark must be a name in its stored form (NFC, trimmed, single-spaced) or null');
  rejects(t => { step(t, 's1').type = null; }, 'tracker.steps["s1"] names no action');
  rejects(t => { t.steps[0].type = 'color.by'; }, 'tracker.steps["s0"] is the root and records no action');
  rejects(t => { branch(t, 'b1').lane = HISTORY_LANE_COUNT; }, 'tracker.branches["b1"].lane must be a whole number from 0 to 7');
  rejects(t => { t.turns[0].by = { ...CLAUDE, turn: 'turn-3' }; }, 'tracker.turns["turn-1"].by.turn must be the turn\'s own id');
  rejects(t => { t.notes[0].fromReply = true; }, 'tracker.notes["n0"] is from an agent\'s reply only when an agent is its author');
  rejects(t => { t.journal[1].before = emptyPatch(); },
    'tracker.journal["j1"] keeps what it replaced and made (before, after) exactly until it is purged');
  rejects(t => { t.journal[0].after.tracker = { name: 'Tracker 1' }; },
    'tracker.journal["j0"] must replace the same tracker fields it puts back');
  rejects(t => { t.journal[0].op = 'branch.merge'; }, `tracker.journal["j0"].op must be one of ${JOURNAL_OPS.map(o => `"${o}"`).join(', ')}`);
  rejects(t => { t.start = { kind: 'replay', from: null, report: null, mapping: null }; },
    'tracker.start names where it comes from (from) exactly for a replay or an import');
  rejects(t => { t.id = 't-1'; }, 'tracker.id must be a tracker id like "t-0b7c6f0e-3c1a-4a52-9d1e-5f2b8c4a7e10"');
  rejects(t => { t.createdAt = Number.NaN; }, 'tracker.createdAt must be a time in milliseconds since 1970 or null');
});

/**
 * A squash in the middle of a branch with a fork at its last step: s1 → s2 →
 * s3 → s4 on Main, "Other" forking at s3 (s5). Squashing s2..s3 makes one
 * step with s3's id (the documented exception to ids never being reused):
 * s4 and s5 keep their parent, s2's note and both bookmarks are carried, and
 * the journal keeps the exact records it replaced.
 */
function squashedTracker({ squashAgain = false } = {}) {
  const tracker = createTracker({ id: TRACKER_ID, name: 'Tracker 1', dataset: DATASET, createdAt: 1, by: START, rootValues: ROOT_VALUES });
  for (const parent of ['s0', 's1', 's2', 's3']) add(tracker, { parent, branch: 'b0' });
  tracker.branches.push(createBranch({ id: idOf('branch', tracker.nextBranch++), name: 'Other', base: 's3', tip: 's3', createdAt: 2, by: PERSON }));
  add(tracker, { parent: 's3', branch: 'b1' });
  step(tracker, 's2').notes.push(createNote({ id: idOf('note', tracker.nextNote++), text: 'Kept.', by: PERSON, at: 3 }));
  step(tracker, 's2').bookmark = 'Two';
  step(tracker, 's3').bookmark = 'Three';
  const replaced = ['s1', 's2', 's3'].map(id => structuredClone(step(tracker, id)));
  const squashed = createStep({
    id: 's3', parent: 's1', branch: 'b0', kind: 'squashed', label: squashedLabel({ cause: 'steps', count: 2, domains: ['Active field'] }),
    by: PERSON, at: 4, touches: ['active-field'], before: { 'active-field': hash('a') }, after: { 'active-field': hash('b') },
    squashed: { cause: 'steps', count: 2, by: [PERSON], carried: { notes: ['n0'], bookmarks: ['Two', 'Three'] } },
    notes: step(tracker, 's2').notes,
  });
  squashed.children = ['s4', 's5'];
  step(tracker, 's1').children = ['s3'];
  tracker.steps = tracker.steps.filter(s => s.id !== 's2' && s.id !== 's3');
  tracker.steps.splice(2, 0, squashed);
  tracker.journal.push(createJournalEntry({
    id: idOf('journal', tracker.nextJournal++), op: 'squash', at: 4, by: PERSON, label: 'Merged 2 steps: Active field',
    before: { ...emptyPatch(), steps: replaced }, after: { ...emptyPatch(), steps: [structuredClone(step(tracker, 's1')), structuredClone(squashed)] },
  }));
  if (squashAgain) {
    // Squashed again with the step after it: the count adds up (2 + 1).
    const again = ['s1', 's3', 's4'].map(id => structuredClone(step(tracker, id)));
    const merged = structuredClone(squashed);
    Object.assign(merged, { id: 's4', children: [] });
    merged.squashed.count = 3;
    step(tracker, 's1').children = ['s4'];
    step(tracker, 's4').parent = 's1';
    tracker.steps = tracker.steps.filter(s => s.id !== 's3' && s.id !== 's4');
    tracker.steps.splice(2, 0, merged);
    // s5 forked at s3, which this squash would leave without its parent: it is moved off for this case.
    tracker.steps = tracker.steps.filter(s => s.id !== 's5');
    tracker.branches = tracker.branches.filter(b => b.id !== 'b1');
    tracker.branches[0].tip = 's4';
    tracker.journal.push(createJournalEntry({
      id: idOf('journal', tracker.nextJournal++), op: 'squash', at: 5, by: PERSON, label: 'Merged 3 steps: Active field',
      before: { ...emptyPatch(), steps: again }, after: { ...emptyPatch(), steps: [structuredClone(step(tracker, 's1')), structuredClone(merged)] },
    }));
  }
  return tracker;
}

test('a squash in mid-branch: the last step\'s id, the fork after it untouched, notes and bookmarks carried, counts adding up', () => {
  const tracker = squashedTracker();
  assert.equal(validateTracker(tracker), tracker);
  assert.deepEqual(tracker.steps.map(s => s.id), ['s0', 's1', 's3', 's4', 's5'], 's2 is gone; s3 now names the squashed step');
  assert.deepEqual([step(tracker, 's4').parent, step(tracker, 's5').parent, branch(tracker, 'b1').base], ['s3', 's3', 's3'], 'the fork at the range\'s end keeps its parent');
  assert.doesNotThrow(() => validateTracker(squashedTracker({ squashAgain: true })));
  const T = 'tracker.journal["j0"]';
  const entry = mutate => {
    const broken = squashedTracker();
    mutate(broken.journal[0]);
    assert.throws(() => validateTracker(broken), HistoryModelError);
    try { validateTracker(broken); } catch (error) { return error.message; }
    return null;
  };
  assert.equal(entry(e => { e.after.steps[1].squashed.count = 3; }), `${T}: its count adds up the steps it replaced (a squashed one counts its own)`);
  assert.equal(entry(e => { e.after.steps[1].id = 's2'; }), `${T}: the squashed step takes the id of the last step it replaced`);
  assert.equal(entry(e => { e.after.steps[1].squashed.carried.bookmarks = ['Three']; }), `${T}: the bookmarks of the steps it replaced are carried by the squashed step`);
  assert.equal(entry(e => { e.after.steps[1].children = ['s4']; }), `${T}: the squashed step keeps the first replaced step's parent and the last one's children`);
  assert.equal(entry(e => { e.before.steps[2].branch = 'b1'; }), `${T} replaces consecutive steps of one branch`);
  assert.equal(entry(e => { e.after.steps[1].group = 'g0'; }), `${T}: a squash inside a group keeps it, and one that covers whole groups leaves none`);
  // Carried bookmarks are bookmarks of the tracker: unique with every other.
  const clash = squashedTracker();
  step(clash, 's4').bookmark = 'two';
  assert.throws(() => validateTracker(clash), { message: 'tracker "t-00000000-0000-4000-8000-000000000001": step "s3" and step "s4" share the name "two"' });
  const lost = squashedTracker();
  step(lost, 's3').notes = [];
  assert.throws(() => validateTracker(lost), { message: 'tracker "t-00000000-0000-4000-8000-000000000001": step "s3" carries a note it does not hold' });
});

test('a squash whose range\'s parent is itself a squashed step: the step it made is the one with a new squash', () => {
  // s0 → s1 → s2 → s3 → s4; squash s1..s1 (s1 squashed, count 1), then s2..s4 (into s4, count 3), whose parent is s1.
  const tracker = createTracker({ id: TRACKER_ID, name: 'Tracker 1', dataset: DATASET, createdAt: 1, by: START, rootValues: ROOT_VALUES });
  for (const parent of ['s0', 's1', 's2', 's3']) add(tracker, { parent, branch: 'b0' });
  const squash = (from, to, count) => {
    const ids = tracker.steps.map(s => s.id);
    const range = ids.slice(ids.indexOf(from), ids.indexOf(to) + 1);
    const first = step(tracker, from);
    const last = step(tracker, to);
    const parent = step(tracker, first.parent);
    const before = [parent, ...range.map(id => step(tracker, id))].map(record => structuredClone(record));
    const made = createStep({
      id: to, parent: first.parent, branch: 'b0', kind: 'squashed', label: squashedLabel({ cause: 'steps', count, domains: ['Active field'] }),
      by: PERSON, at: first.at, touches: ['active-field'], before: { 'active-field': hash('a') }, after: { 'active-field': hash('b') },
      squashed: { cause: 'steps', count, by: [PERSON], carried: NOTHING_CARRIED },
    });
    made.children = [...last.children];
    parent.children = parent.children.map(child => (child === from ? to : child));
    tracker.steps = tracker.steps.filter(s => !range.includes(s.id) || s.id === to).map(s => (s.id === to ? made : s));
    tracker.journal.push(createJournalEntry({
      id: idOf('journal', tracker.nextJournal++), op: 'squash', at: 9, by: PERSON, label: made.label,
      before: { ...emptyPatch(), steps: before }, after: { ...emptyPatch(), steps: [structuredClone(parent), structuredClone(made)] },
    }));
  };
  squash('s1', 's1', 1);
  squash('s2', 's4', 3);
  tracker.branches[0].tip = 's4';
  assert.doesNotThrow(() => validateTracker(tracker));
  assert.deepEqual(tracker.steps.map(s => [s.id, s.kind]), [['s0', 'root'], ['s1', 'squashed'], ['s4', 'squashed']]);
  assert.equal(step(tracker, 's4').parent, 's1');
});

test('a group edit is journaled as which steps the group held (memberships), never its steps', () => {
  const tracker = sample();
  tracker.journal.push(createJournalEntry({
    id: idOf('journal', tracker.nextJournal++), op: 'group.extend', at: 30, by: PERSON, label: 'Extended the group "Alpha" to step 3',
    before: { ...emptyPatch(), memberships: [{ group: 'g0', from: 's2', to: 's2' }] },
    after: { ...emptyPatch(), memberships: [{ group: 'g0', from: 's2', to: 's3' }] },
  }));
  assert.doesNotThrow(() => validateTracker(tracker));
  const T = 'tracker.journal["j2"]';
  rejects(t => { t.journal.push({ ...structuredClone(tracker.journal[2]), after: { ...emptyPatch(), memberships: [{ group: 'g0', from: 's3', to: 's2' }] } }); t.nextJournal = 3; },
    `${T}.after.memberships[0] runs from a later step to an earlier one`);
  rejects(t => { t.journal.push({ ...structuredClone(tracker.journal[2]), after: { ...emptyPatch(), steps: [structuredClone(step(t, 's2'))] } }); t.nextJournal = 3; },
    `${T} records which steps a group held (memberships), never the steps`);
  rejects(t => { t.journal.push({ ...structuredClone(tracker.journal[2]), after: { ...emptyPatch(), memberships: [{ group: 'g0', from: 's2', to: 's3' }, { group: 'g0', from: 's2', to: 's2' }] } }); t.nextJournal = 3; },
    `${T}.after.memberships names one group twice`);
});

test('a history and a session file keep their trackers\' rules', () => {
  const one = sample();
  const two = { ...sample(), id: OTHER_ID, name: 'tracker  1' };
  assert.throws(() => validateHistory({ dataset: DATASET, activeTracker: TRACKER_ID, trackers: [one, two] }),
    { message: 'history.trackers["t-00000000-0000-4000-8000-000000000002"].name must be a name in its stored form (NFC, trimmed, single-spaced)' });
  two.name = 'TRACKER 1';
  assert.throws(() => validateHistory({ dataset: DATASET, activeTracker: TRACKER_ID, trackers: [one, two] }), {
    message: 'history: tracker "t-00000000-0000-4000-8000-000000000001" and tracker "t-00000000-0000-4000-8000-000000000002" share the name "TRACKER 1"',
  });
  // A removed tracker keeps its name aside: a new one may take it.
  two.removed = { at: 30, by: PERSON };
  two.journal.push(createJournalEntry({
    id: idOf('journal', two.nextJournal++), op: 'tracker.remove', at: 30, by: PERSON, label: 'Removed the tracker "TRACKER 1"',
    before: { ...emptyPatch(), tracker: { removed: null } }, after: { ...emptyPatch(), tracker: { removed: { at: 30, by: PERSON } } },
  }));
  assert.doesNotThrow(() => validateHistory({ dataset: DATASET, activeTracker: TRACKER_ID, trackers: [one, two] }));
  assert.throws(() => validateHistory({ dataset: DATASET, activeTracker: OTHER_ID, trackers: [one, two] }), {
    message: 'history\'s active tracker cannot be removed',
  });
  assert.throws(() => validateHistory({ dataset: DATASET, activeTracker: TRACKER_ID, trackers: [one, sample()] }), {
    message: 'history holds the tracker "t-00000000-0000-4000-8000-000000000001" twice',
  });

  const session = {
    createdAt: '2026-11-04T10:00:00.000Z',
    app: { version: '0.9.7', catalog: hash('d') },
    actions: [{ type: 'color.by', version: 1, params: hash('e') }, { type: 'filter.category.visibility', version: 1, params: hash('f') }],
    scope: {
      trackers: [TRACKER_ID], branches: [{ tracker: TRACKER_ID, branches: ['b0', 'b1', 'b2'] }], content: 'history', results: 'include',
      notes: true, chats: false, journal: true, times: 'exact', source: 'full',
    },
    datasetFingerprint: { datasetId: 'pbmc' }, source: null, requires: { obs: ['cell_type'], var: [] }, cells: null, genes: null,
    activeTracker: TRACKER_ID, trackers: [sample()],
  };
  assert.equal(validateSession(session), session);
  assert.throws(() => validateSession({ ...session, scope: { ...session.scope, trackers: [] } }), {
    message: 'session.scope must name exactly the trackers it holds, in order',
  });
  assert.throws(() => validateSession({ ...session, scope: { ...session.scope, branches: [{ tracker: TRACKER_ID, branches: ['b5'] }] } }), {
    message: 'session.scope names a branch the tracker "t-00000000-0000-4000-8000-000000000001" does not hold',
  });
  assert.throws(() => validateSession({ ...session, actions: [...session.actions].reverse() }), {
    message: 'session.actions must be sorted by type then version, each pair once',
  });
  assert.throws(() => validateSession({ ...session, actions: session.actions.slice(1) }), {
    message: 'session.actions must stamp exactly each action and version its steps use',
  });
  assert.throws(() => validateSession({ ...session, actions: [...session.actions, { type: 'zoom.set', version: 1, params: null }] }), {
    message: 'session.actions must stamp exactly each action and version its steps use',
  });
  // One stamp per version present: a step recorded with an earlier version of an action is stamped beside the current one.
  const mixed = sample();
  step(mixed, 's4').v = 2;
  assert.doesNotThrow(() => validateSession({
    ...session, trackers: [mixed],
    actions: [{ type: 'color.by', version: 1, params: null }, { type: 'color.by', version: 2, params: hash('e') }, { type: 'filter.category.visibility', version: 1, params: hash('f') }],
  }));
  const drafted = sample();
  drafted.paused = { at: 40, by: [PERSON], draft: { colors: hash('d') } };
  assert.throws(() => validateSession({ ...session, trackers: [drafted] }), {
    message: `session: tracker "${TRACKER_ID}" keeps a paused draft; a file squashes it into a step first`,
  });
  assert.throws(() => validateSession({ ...session, scope: { ...session.scope, times: 'hours' } }), {
    message: 'session.scope.times must be one of "exact", "dates", "none"',
  });
  // What the scope leaves out, the file does not hold.
  assert.throws(() => validateSession({ ...session, scope: { ...session.scope, journal: false } }), {
    message: `session: tracker "${TRACKER_ID}" holds Recently deleted, which its scope leaves out (journal)`,
  });
  assert.throws(() => validateSession({ ...session, scope: { ...session.scope, notes: false } }), {
    message: `session: tracker "${TRACKER_ID}" holds notes or bookmarks its scope leaves out (notes)`,
  });
  const chatty = { ...sample(), chats: [['conv-1', { messages: [] }]] };
  assert.throws(() => validateSession({ ...session, trackers: [chatty] }), {
    message: `session: tracker "${TRACKER_ID}" holds conversations its scope leaves out (chats)`,
  });
  assert.throws(() => validateSession({ ...session, scope: { ...session.scope, content: 'steps' } }), {
    message: 'session.scope of steps only holds no results (results is recompute)',
  });
  assert.throws(() => validateSession({ ...session, scope: { ...session.scope, content: 'state' } }), {
    message: 'session.scope of a state holds one tracker of one branch',
  });

  // Current state only: one tracker of one branch, the root and the shared state, nothing else.
  const state = createTracker({ id: TRACKER_ID, name: 'Tracker 1', dataset: DATASET, createdAt: null, by: PERSON, rootValues: ROOT_VALUES });
  const shared = createStep({
    id: idOf('step', state.nextStep++), parent: 's0', branch: 'b0', kind: 'squashed', label: 'Shared state', by: PERSON, at: null,
    touches: ['filters'], before: { filters: ROOT_VALUES.filters }, after: { filters: hash('f') },
    squashed: { cause: 'share', count: null, by: [], carried: NOTHING_CARRIED },
  });
  state.steps[0].children.push(shared.id);
  state.steps.push(shared);
  state.branches[0].tip = shared.id;
  state.headId = shared.id;
  const stateSession = {
    ...session, actions: [], trackers: [state],
    scope: {
      trackers: [TRACKER_ID], branches: [{ tracker: TRACKER_ID, branches: ['b0'] }], content: 'state', results: 'include',
      notes: false, chats: false, journal: false, times: 'none', source: 'name',
    },
  };
  assert.equal(validateSession(stateSession), stateSession);
  state.headId = 's0';
  assert.throws(() => validateSession(stateSession), {
    message: 'session.scope of a state holds the root and one squashed step (cause share), shown',
  });
  state.headId = shared.id;
  // Privacy: a state names nobody.
  state.steps[1].by = createBy({ origin: 'agent', agent: 'Claude' });
  assert.throws(() => validateSession(stateSession), {
    message: 'session.scope of a state names nobody: every by is the person or the opening, with no agent, model, notebook, name or turn',
  });
  state.steps[1].by = PERSON;
  state.groups.push(createGroup({ id: 'g0', name: 'G', createdAt: null, by: PERSON }));
  state.nextGroup = 1;
  shared.group = 'g0';
  assert.throws(() => validateSession(stateSession), { message: 'session.scope of a state holds no turn, group, note, journal or conversation' });
});

test('names: stored form, key, what is refused, defaults and suffixes', () => {
  assert.equal(normalizeName('  Without  alpha\t'), 'Without alpha');
  assert.equal(normalizeName('Café\nnoir'), 'Café noir');
  assert.equal(normalizeName('﻿ 　'), '');
  assert.equal(nameKey('Without  ALPHA'), nameKey('without alpha'));
  assert.notEqual(nameKey('Without alpha'), nameKey('Without-alpha'));
  assert.equal(plainNameProblem('branch', ' \t '), 'A branch needs a name.');
  assert.equal(plainNameProblem('tracker', 'a\u0001b'), 'A tracker name cannot hold control characters.');
  assert.equal(plainNameProblem('branch', 'b2'), 'A branch cannot be called "b2": that is the form of a branch id. Choose another name.');
  assert.equal(plainNameProblem('branch', 'B12'), 'A branch cannot be called "B12": that is the form of a branch id. Choose another name.');
  assert.equal(plainNameProblem('branch', 'B2 cells'), null);
  assert.equal(plainNameProblem('branch', 'b02'), null, 'not an id: ids have no leading zero');
  assert.equal(plainNameProblem('bookmark', 'b2'), null, 'a bookmark is never named in place of an id');
  assert.equal(plainNameProblem('group', 'g2'), 'A group cannot be called "g2": that is the form of a group id. Choose another name.');
  assert.equal(plainNameProblem('group', 'QC'), null);
  assert.equal(plainNameProblem('tracker', 'T-cells'), null);
  assert.equal(plainNameProblem('tracker', TRACKER_ID.toUpperCase()),
    `A tracker cannot be called "${TRACKER_ID.toUpperCase()}": that is the form of a tracker id. Choose another name.`);
  assert.throws(() => plainNameProblem('step', 'x'), /There is no kind of name "step"/);
  assert.equal(defaultName('Branch', 3, ['Branch 3', 'branch  4']), 'Branch 5');
  assert.equal(defaultName('Tracker', 2, []), 'Tracker 2');
  assert.equal(suffixedName('Tracker 1', 'shared', ['Tracker 2']), 'Tracker 1');
  assert.equal(suffixedName('Tracker 1', 'shared', ['tracker 1']), 'Tracker 1 (shared)');
  assert.equal(suffixedName('X', 'restored', ['X', 'x (restored)', 'X (restored 2)']), 'X (restored 3)');
});

test('the sentences the history\'s refusals say', () => {
  assert.equal(SENTENCES.nameTaken({ kind: 'branch', name: 'Without alpha', where: 'from step 2' }),
    'A branch is already called "Without alpha" (from step 2); choose another name.');
  assert.equal(SENTENCES.nameTaken({ kind: 'tracker', name: 'Tracker 1' }), 'A tracker is already called "Tracker 1"; choose another name.');
  assert.equal(SENTENCES.bookmarkTaken({ name: 'Before', step: 's12' }), 'Step 12 is already bookmarked "Before"; choose another name.');
  assert.equal(SENTENCES.mainBranch(), 'Make another branch main first.');
  assert.equal(SENTENCES.locked({ name: 'Main' }), '"Main" is locked; unlock it first.');
  assert.equal(SENTENCES.lockedStarted({ name: 'Main', started: 'Branch 5' }), '"Main" is locked; your change started "Branch 5".');
  assert.equal(SENTENCES.pending({ name: 'Without alpha', step: 's12' }), 'Next change starts "Without alpha" from step 12.');
  assert.equal(SENTENCES.moved({ name: 'X' }), 'The person is now on branch "X". Ask before continuing there, or call history_branch_switch.');
  assert.equal(SENTENCES.notAuthor(), 'Notes are edited by their author; add a reply note instead.');
  assert.equal(SENTENCES.notRevertible({ domains: ['Filters'] }), 'Later steps also change Filters; use Branch without this step.');
  assert.equal(SENTENCES.noBranch({ ref: 'Q', names: ['Main', 'Without alpha', 'Nested'] }),
    'There is no branch "Q"; the branches are "Main", "Without alpha" and "Nested".');
  assert.equal(SENTENCES.noStep({ step: 's9', tracker: 'Tracker 1' }),
    'There is no step "s9" in the tracker "Tracker 1"; history_get lists its steps.');
  assert.equal(SENTENCES.noTurn({ turn: 'turn-2', tracker: 'Tracker 1', then: 'nothing to undo' }),
    'The tracker "Tracker 1" has no record of the turn "turn-2": a turn is recorded with its first step, so one that only read or changed nothing has nothing to undo; history_summary lists the turns it has.');
  assert.equal(SENTENCES.noGroup({ ref: 'QC', names: [] }), 'There is no group "QC"; the tracker has no group.');
  assert.equal(SENTENCES.noGroup({ ref: 'Q', names: ['QC', 'Clustering'] }), 'There is no group "Q"; the groups are "QC" and "Clustering".');
  assert.equal(SENTENCES.notConsecutive({ from: 's4', to: 's9' }),
    'Steps 4 to 9 are not consecutive steps of one branch; group or squash a run of one branch\'s own steps.');
  assert.equal(SENTENCES.splitsTurn({ label: 'Find markers', from: 's3', to: 's7' }),
    'That would split the turn "Find markers"; a group holds whole turns: steps 3 to 7.');
  assert.equal(SENTENCES.inGroup({ step: 's5', name: 'QC' }), 'Step 5 is in the group "QC" already; extend it, or ungroup it first.');
  assert.equal(SENTENCES.forksInside({ names: ['Without alpha'], upTo: 's14' }),
    'The branch "Without alpha" starts inside: group instead, or squash up to step 14.');
  assert.equal(SENTENCES.forksInside({ names: ['A', 'B'], upTo: null }), '2 branches start inside ("A" and "B"): group instead.');
  assert.equal(SENTENCES.notOwnSteps(), 'An agent squashes only its own turn\'s steps; ask the person to squash the others.');
});

test('constructors refuse what the rules refuse', () => {
  assert.throws(() => createBy({ origin: 'agent' }), { message: 'by names an agent exactly when its origin is "agent"' });
  assert.throws(() => createBy({ origin: 'host', host: 'julia' }), { message: 'by.host must be one of "python", "r" or null' });
  assert.deepEqual(createBy({ origin: 'host', host: 'r', turn: 'qc' }), { origin: 'host', agent: null, model: null, host: 'r', person: null, turn: 'qc' });
  assert.throws(() => createNote({ id: 'n0', text: 'x', by: PERSON, at: 1, fromReply: true }), { message: 'note is from an agent\'s reply only when an agent is its author' });
  assert.throws(() => createNote({ id: 'n0', text: '', by: PERSON, at: 1 }), { message: 'note.text must be a non-empty text' });
  assert.throws(() => createStep({ id: 's1', parent: null }), { message: 'A step made by an action has a parent; createTracker makes the root' });
  assert.throws(() => createBranch({ id: 'b1', name: 'Main ', base: 's0', tip: 's1', createdAt: 1, by: PERSON }), /branch\.name must be a name/);
  assert.equal(createBranch({ id: 'b9', name: 'x', base: 's0', tip: 's1', createdAt: 1, by: PERSON }).lane, 1);
  assert.equal(laneOf('b16'), 0);
  assert.throws(() => createTurn({ id: 'turn-2', by: PERSON, label: 'x', startedAt: 1, branch: 'b0' }), { message: 'turn is an agent\'s or a notebook\'s' });
  assert.throws(() => createJournalEntry({ id: 'j0', op: 'branch.rename', at: 1, by: PERSON, label: 'x', before: null, after: null }),
    { message: 'journalEntry keeps what it replaced and made (before, after) exactly until it is purged' });
  assert.throws(() => idOf('turn', 1), /An id is a step, branch, group, note or journal number/);
  assert.equal(idOf('group', 3), 'g3');
  assert.deepEqual(createGroup({ id: 'g0', name: 'QC', createdAt: 1, by: PERSON }), { id: 'g0', name: 'QC', createdAt: 1, by: PERSON, notes: [] });
  assert.throws(() => createGroup({ id: 'g0', name: ' QC', createdAt: 1, by: PERSON }), /group\.name must be a name/);
  assert.throws(() => createStep({ id: 's1', parent: 's0', branch: 'b0', type: 'color.by', params: {}, label: 'x', by: PERSON, at: 1, touches: [], before: {}, after: {} }),
    { message: 'step records the version of its action\'s parameters (v)' });
  assert.throws(() => createTracker({
    id: TRACKER_ID, name: 'R', dataset: DATASET, createdAt: 1, by: createBy({ origin: 'replay' }), rootValues: ROOT_VALUES,
    start: { kind: 'import', from: { dataset: { id: null, name: null }, tracker: { id: OTHER_ID, name: 'T' }, branch: null, step: null, file: null, saved: null }, report: null, mapping: null },
  }), { message: 'tracker.start of an import names its file' });
  const replayed = createTracker({
    id: TRACKER_ID, name: 'Replay of PBMC', dataset: DATASET, createdAt: 1, by: createBy({ origin: 'replay' }), rootValues: ROOT_VALUES,
    start: {
      kind: 'replay',
      from: { dataset: { id: 'other', name: 'Other' }, tracker: { id: OTHER_ID, name: 'Tracker 1' }, branch: { id: 'b0', name: 'Main' }, step: 's4', file: null, saved: 'state-1' },
      report: [{ source: 's1', label: 'Hid alpha', outcome: 'unmatched', step: null, reason: 'There is no category "alpha".', missing: { kind: 'category', name: 'alpha', field: 'leiden' } }],
      mapping: { fields: [], categories: [{ field: 'cell_type', from: 'T cells', to: 'CD4 T' }], genes: [] },
    },
  });
  assert.equal(replayed.steps[0].label, 'Started a replay');
});

test('the shared vocabulary has one source', () => {
  assert.deepEqual(BY_ORIGINS, [...ACTION_ORIGINS, 'outside']);
  assert.deepEqual(STEP_STATUSES, ['applied', 'unapplicable']);
  assert.equal(STEP_TEXT_OUTSIDE, OUTSIDE_CHANGE_TYPE, 'step-text says the model\'s outside-change type');
  assert.deepEqual(recordFields('Reads'), ACTION_READ_INPUTS, 'a step records exactly what an action may declare it reads');
  assert.deepEqual(recordFields('DomainValues'), DOMAIN_IDS);
});

/**
 * A checker of the JSON Schema subset the document uses, so the document and
 * the validators are held to say the same.
 */
function schemaAccepts(document, schema, value) {
  if (schema.$ref !== undefined) return schemaAccepts(document, document.$defs[schema.$ref.slice('#/$defs/'.length)], value);
  if (schema.anyOf !== undefined) return schema.anyOf.some(sub => schemaAccepts(document, sub, value));
  if (schema.enum !== undefined) return schema.enum.includes(value);
  const types = schema.type === undefined ? null : [schema.type].flat();
  if (types === null) return true;
  const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) && types.includes('integer') ? 'integer' : typeof v);
  if (!types.includes(typeOf(value))) return false;
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) return false;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (schema.prefixItems !== undefined) {
      return value.length === schema.prefixItems.length && schema.prefixItems.every((sub, i) => schemaAccepts(document, sub, value[i]));
    }
    return value.every(item => schemaAccepts(document, schema.items, item));
  }
  if (value !== null && typeof value === 'object' && schema.properties !== undefined) {
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) return false;
    if ((schema.required ?? []).some(key => !Object.hasOwn(value, key))) return false;
    return Object.entries(value).every(([key, item]) => schemaAccepts(document, schema.properties[key], item));
  }
  return true;
}

test('the document describes every record the validators check, field for field', () => {
  const document = historyModelDocument();
  assert.equal(document.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(Object.keys(document.$defs), [...HISTORY_RECORDS]);
  for (const name of HISTORY_RECORDS) {
    const def = document.$defs[name];
    assert.deepEqual(Object.keys(def.properties), recordFields(name), name);
    assert.equal(def.additionalProperties, false, name);
    assert.ok(def.required.every(key => recordFields(name).includes(key)), name);
    assert.equal(typeof def.description, 'string', name);
    for (const [key, property] of Object.entries(def.properties)) assert.equal(typeof property.description, 'string', `${name}.${key}`);
  }
  assert.deepEqual(document.$defs.Reads.required, [], 'every read input is optional');
  assert.deepEqual(document['x-journalOps'], JOURNAL_OPS);
  assert.deepEqual(document['x-domains'], DOMAIN_IDS);
  for (const pattern of Object.values(document['x-ids'])) {
    assert.doesNotMatch(pattern, /\\d|\\s|\(\?<|\(\?=/, 'patterns read the same in JavaScript, Python and R');
  }
  assert.deepEqual(JSON.parse(JSON.stringify(document)), document, 'plain JSON');

  const tracker = JSON.parse(JSON.stringify(sample()));
  assert.ok(schemaAccepts(document, { $ref: '#/$defs/Tracker' }, tracker), 'the schema accepts what the validators accept');
  const history = { dataset: DATASET, activeTracker: TRACKER_ID, trackers: [tracker] };
  assert.ok(schemaAccepts(document, { $ref: '#/$defs/History' }, history));
  for (const [mutate, what] of [
    [t => { t.steps[1].by.origin = 'robot'; }, 'an unknown origin'],
    [t => { t.steps[1].extra = 1; }, 'an unknown field'],
    [t => { delete t.steps[1].reads; }, 'a missing field'],
    [t => { t.branches[1].lane = 8; }, 'a lane out of range'],
    [t => { t.id = 't-1'; }, 'a malformed tracker id'],
    [t => { t.steps[1].before = { nowhere: hash('a') }; }, 'an unknown domain'],
    [t => { t.steps[1].kind = 'merged'; }, 'an unknown step kind'],
    [t => { t.steps[1].picture = null; }, 'a picture'],
    [t => { t.groups[0].id = 'group 0'; }, 'a malformed group id'],
  ]) {
    const broken = JSON.parse(JSON.stringify(tracker));
    mutate(broken);
    assert.equal(schemaAccepts(document, { $ref: '#/$defs/Tracker' }, broken), false, `the schema refuses ${what}`);
    assert.throws(() => validateTracker(broken), HistoryModelError, `the validators refuse ${what}`);
  }
  assert.throws(() => validateRecord('Nothing', {}), { message: 'There is no history record "Nothing"' });
});
