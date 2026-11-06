/**
 * History v2 §3.3.10: an agent's turn. Undoing only its own steps when the
 * person's steps came between (A, P1, B, P2) applies each dependant once and
 * leaves every step's before-values its parent's; an agent's own move
 * carries its turn along, so its next change is not refused as `moved`; an
 * agent's unnamed "Branch here" is named after it and its change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { beforeInvariantBreaks, historyProblem, makePage } from './history-fake-page.mjs';
import { stepOf, valuesAt } from '../assets/js/app/history/tree.js';

const AGENT = Object.freeze({ origin: 'agent', agent: 'Claude', turn: 'turn-1' });

test('undoing only an agent\'s steps with the person\'s steps after each applies each dependant once, exactly', async () => {
  const { page, history, dispatcher, act, step } = await makePage();
  let derives = 0;
  dispatcher.subscribe(event => { if (event.kind === 'start' && event.type === 'c.derive') derives++; });
  await step('a.set', { v: 2 }, AGENT); // A
  await step('c.derive'); // P1: c = 20
  await step('b.inc', {}, AGENT); // B: b = 1
  await step('c.derive'); // P2: c = 21
  derives = 0;
  const result = await act('history.turn.undo', { turn: 'turn-1', only_own: true });
  assert.equal(result.removed, 2);
  assert.deepEqual([page.state.a, page.state.b, page.state.c], [0, 0, 0]);
  assert.equal(derives, 2, 'P1 and P2 applied again once each');
  const tracker = history.active;
  assert.deepEqual(beforeInvariantBreaks(tracker), []);
  const parent = stepOf(tracker, tracker.headId).parent;
  await history.undo();
  const shown = history.shownHashes();
  const expected = valuesAt(tracker, parent);
  assert.deepEqual(Object.keys(expected).filter(domain => expected[domain] !== shown[domain]), []);
  assert.equal(historyProblem(history), null);
});

test('an agent\'s own jump to another branch carries its turn: its next change is not refused', async () => {
  const { history, act, step } = await makePage();
  const s1 = await step('a.set', { v: 1 });
  await step('a.set', { v: 2 });
  await history.jump(s1.id);
  const other = await step('b.inc');
  await history.jump('s2');
  const agent = { origin: 'agent', agent: 'Claude', turn: 'turn-9' };
  await step('cam.set', { v: 3 }, agent);
  await act('history.jump', { step: other.id }, agent);
  const made = await step('a.set', { v: 4 }, agent);
  assert.ok(made !== null);
  assert.equal(history.active.turns.get('turn-9').branch, history.active.steps.get(made.id).branch);
  // The person's move during the turn still binds it.
  await history.jump('s2');
  const refused = await step('a.set', { v: 5 }, agent).catch(error => error);
  assert.equal(refused.code, 'moved');
});

for (const move of ['undo', 'redo', 'branch.switch']) {
  test(`an agent's own ${move} carries its turn`, async () => {
    const { history, act, step } = await makePage();
    const s1 = await step('a.set', { v: 1 });
    await step('a.set', { v: 2 });
    await history.jump(s1.id);
    await step('b.inc');
    const agent = { origin: 'agent', agent: 'Claude', turn: 'turn-7' };
    if (move === 'redo') {
      await step('b.inc', {}, agent);
      await history.jump(s1.id);
      await act('history.branch.switch', { branch: 'b0' }, agent);
      await act('history.undo', {}, agent);
      await act('history.redo', {}, agent);
    } else if (move === 'undo') {
      await step('b.inc', {}, agent);
      await act('history.undo', {}, agent);
      await act('history.undo', {}, agent);
    } else {
      await step('b.inc', {}, agent);
      await act('history.branch.switch', { branch: 'b0' }, agent);
    }
    const made = await step('cam.set', { v: 9 }, agent);
    assert.ok(made !== null, 'not refused');
    assert.equal(historyProblem(history), null);
  });
}

test('an agent\'s unnamed "Branch here" is named after it and its next change', async () => {
  const { history, act, step } = await makePage();
  const s1 = await step('a.set', { v: 1 });
  await step('a.set', { v: 2 });
  const agent = { origin: 'agent', agent: 'Claude', turn: 'turn-3' };
  const created = await act('history.branch.create', { step: s1.id }, agent);
  assert.equal(created.pending, 'Claude: …');
  const made = await step('b.inc', {}, agent);
  const tracker = history.active;
  assert.equal(tracker.branches.get(tracker.steps.get(made.id).branch).name, 'Claude: b + 1');
  // The person's unnamed one takes the next "Branch n"; a cancel says what it forgot.
  await act('history.branch.create', { step: s1.id }, agent);
  assert.deepEqual(await act('history.branch.cancel'), { cancelled: 'Claude: …' });
  const mine = await act('history.branch.create', { step: s1.id });
  assert.match(mine.pending, /^Branch \d+$/);
});

test('another agent\'s step starting a branch is no move of the person\'s: the turn goes on there', async () => {
  const { history, act, step } = await makePage();
  const desktop = { origin: 'agent', agent: 'Claude', turn: 'turn-desktop' };
  const chat = { origin: 'agent', agent: 'Claude', turn: 'turn-chat' };
  await step('a.set', { v: 1 }, chat);
  await step('b.inc', {}, desktop);
  // The person undoes the desktop's turn: it goes on from where its undo left it.
  await act('history.turn.undo', { turn: 'turn-desktop' });
  // The chat's next change starts a branch (the undone step is still its branch's tip).
  const branching = await step('cam.set', { v: 2 }, { ...chat, turn: 'turn-chat-2' });
  assert.notEqual(history.active.steps.get(branching.id).branch, 'b0');
  const goesOn = await step('a.set', { v: 3 }, desktop);
  assert.ok(goesOn !== null, 'not refused as moved');
  assert.equal(history.active.steps.get(goesOn.id).parent, branching.id);
});

test('what a turn does outside the state (a vote published) stays in its record; Undo turn says it stays', async () => {
  const { defineAction } = await import('../assets/js/app/actions/catalog.js');
  const { undoAgentTurn } = await import('../assets/js/app/agent/history-link.js');
  const { createAgentActivity } = await import('../assets/js/app/agent/presence/activity.js');
  const { activityTextOf } = await import('../assets/js/app/agent/presence/index.js');
  const vote = defineAction({
    type: 'demo.vote', title: 'Vote', summary: 'x', group: 'Demo',
    params: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' } } },
    reads: [], effect: 'outside', confirm: 'publishes',
    acts: { one: 'vote published', other: 'votes published', when: (params, outcome) => outcome?.published !== false },
    describe: (params, outcome, quote = { bare: String }) => `Voted ${quote.bare?.(params.label) ?? params.label} up`, code: () => 'x',
  });
  const { history, dispatcher, step } = await makePage({ extra: [vote], provide: d => d.provide('demo.vote', ({ label }) => ({ published: label !== 'same' })) });
  dispatcher.setConfirmer(async () => true);
  const outside = [];
  const activity = createAgentActivity({ outsideOf: (type, params, outcome) => (type === 'demo.vote' && outcome?.published !== false ? { one: 'vote published', other: 'votes published' } : null) });
  dispatcher.subscribe(event => activity.onDispatch(event));
  // A turn that only published: its record holds the act, with no step.
  await dispatcher.dispatch('demo.vote', { label: 'T cell' }, { origin: 'agent', agent: 'Claude', turn: 'turn-v' });
  const only = history.active.turns.get('turn-v');
  assert.deepEqual(only.outside.map(act => [act.type, act.label]), [['demo.vote', 'Voted T cell up']]);
  assert.equal(historyProblem(history), null, 'a turn of acts outside the state alone is a valid record');
  // A vote that changed nothing published nothing: not kept.
  await dispatcher.dispatch('demo.vote', { label: 'same' }, { origin: 'agent', agent: 'Claude', turn: 'turn-v' });
  assert.equal(history.active.turns.get('turn-v').outside.length, 1);
  // A turn of steps and a vote: Undo turn takes the steps back and says the vote stays.
  await step('a.set', { v: 2 }, AGENT);
  await dispatcher.dispatch('demo.vote', { label: 'B cell' }, AGENT);
  await step('b.inc', {}, AGENT);
  const line = activity.lines().find(each => each.turn === 'turn-1');
  assert.deepEqual(line.outside, [{ one: 'vote published', other: 'votes published', count: 1 }]);
  outside.push(...line.outside);
  const told = [];
  const catalog = { has: type => type === 'demo.vote', get: () => vote };
  const result = await undoAgentTurn(history, 'turn-1', { tell: note => told.push(note), catalog });
  assert.equal(result.undone, true);
  assert.equal(result.how, 'end');
  assert.deepEqual(result.outside, [{ one: 'vote published', other: 'votes published', count: 1 }]);
  assert.deepEqual(told.map(note => note.text), ["Undid Claude's 2 steps; 1 vote published stays: Undo cannot take it back."]);
  assert.equal(history.active.turns.get('turn-1').outside.length, 1, 'the record keeps the vote after the undo');
  assert.equal(typeof activityTextOf, 'function');
  assert.equal(activityTextOf({ ...line, state: 'undone' }), "Claude's turn is undone · 1 vote published, not undoable");
  assert.equal(historyProblem(history), null);
});
