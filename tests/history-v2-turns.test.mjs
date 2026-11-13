/**
 * An agent's turn. Undoing only its own steps when the
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

test('the next message tells the agent what changed since its last turn: its turn undone (all since, or only its steps), the person\'s steps', async () => {
  const { historySeen, historySinceSentence } = await import('../assets/js/app/agent/history-link.js');
  const { plainSentence } = await import('../assets/js/app/actions/targets/names.js');
  const { history, act, step } = await makePage();
  const own = new Set(['turn-1']);
  const say = seen => {
    const sentence = historySinceSentence(history.active, seen, own);
    return sentence === null ? null : plainSentence(sentence);
  };
  await step('a.set', { v: 2 }, AGENT);
  await step('b.inc', {}, AGENT);
  const seen = historySeen(history.active);
  assert.equal(say(seen), null, 'nothing changed since');
  // The person acts between turns.
  await step('cam.set', { v: 4 });
  assert.equal(say(seen), 'Since your last turn the history changed: The person\'s step "cam 4" is now in effect. Rely on the state as it is now, not on what your earlier replies said.');
  // Undo turn, only the agent's steps: they go to Recently deleted, the person's step stays.
  await act('history.turn.undo', { turn: 'turn-1', only_own: true });
  const sentence = say(seen);
  assert.match(sentence, /^Since your last turn the history changed: Your steps "a = 2", "b \+ 1" were removed \(to Recently deleted, no longer in effect\); The person's step "cam 4" is now in effect\./);
  assert.ok(!/<cellucid-data>/.test(sentence) && /<cellucid-data>"a = 2"<\/cellucid-data>/.test(historySinceSentence(history.active, seen, own)), 'labels are marked as data');
});

test('a step the person takes while the agent\'s turn runs is told with the next message, as taken during that turn', async () => {
  const { historySeen, historySinceSentence } = await import('../assets/js/app/agent/history-link.js');
  const { plainSentence } = await import('../assets/js/app/actions/targets/names.js');
  const { history, step } = await makePage();
  const own = new Set(['turn-1']);
  // The turn starts: the tracker's next step number then.
  const from = history.active.nextStep;
  await step('a.set', { v: 2 }, AGENT);
  // The person colors mid-turn, between the agent's steps.
  await step('cam.set', { v: 4 });
  await step('b.inc', {}, AGENT);
  // The turn ends: what the agent saw is its own steps and what was in effect before it began.
  const seen = historySeen(history.active, { from, ownTurns: own });
  assert.equal(plainSentence(historySinceSentence(history.active, seen, own)),
    'Since your last turn the history changed: The person\'s step "cam 4" was taken while your last turn ran and is in effect. Rely on the state as it is now, not on what your earlier replies said.');
  // Without a turn start (another tracker shown then), the snapshot is the steps in effect, as before.
  assert.equal(historySinceSentence(history.active, historySeen(history.active), own), null);
});

test('Undo turn back to before the turn: its steps are undone, kept for redo; a run of one label is said once with its count', async () => {
  const { historySeen, historySinceSentence } = await import('../assets/js/app/agent/history-link.js');
  const { plainSentence } = await import('../assets/js/app/actions/targets/names.js');
  const { history, act, step } = await makePage();
  const own = new Set(['turn-1']);
  await step('a.set', { v: 2 }, AGENT);
  const seen = historySeen(history.active);
  await act('history.turn.undo', { turn: 'turn-1' });
  assert.equal(plainSentence(historySinceSentence(history.active, seen, own)),
    'Since your last turn the history changed: Your step "a = 2" was undone (kept for redo, no longer in effect). Rely on the state as it is now, not on what your earlier replies said.');
  // The person goes on from there: a new branch, the agent's step kept on Main.
  for (let n = 0; n < 3; n++) await step('b.inc');
  await step('a.set', { v: 5 });
  const sentence = plainSentence(historySinceSentence(history.active, seen, own));
  assert.match(sentence, /the branch shown is now "Branch 1" \(it was "Main"\); Your step "a = 2" stays on the branch "Main", not in effect on the branch shown; The person's steps "b \+ 1" \(3 times\), "a = 5" are now in effect\./);
  await step('cam.set', { v: 1 });
  await step('cam.set', { v: 2 });
  assert.match(plainSentence(historySinceSentence(history.active, historySeen(history.active), own) ?? 'none'), /^none$/);
  assert.equal(historySinceSentence(history.active, null, own), null);
});

test('another history shown since the last turn is said: which tracker, where it came from, its steps in effect, and the conversation left behind', async () => {
  const { historySeen, historySinceSentence, isHistorySeen } = await import('../assets/js/app/agent/history-link.js');
  const { plainSentence } = await import('../assets/js/app/actions/targets/names.js');
  const { history, step } = await makePage();
  const own = new Set(['turn-1']);
  await step('a.set', { v: 2 }, AGENT);
  const seen = historySeen(history.active, { ownTurns: own, conversation: 'chat-1' });
  assert.ok(isHistorySeen(seen) && isHistorySeen(JSON.parse(JSON.stringify(seen))), 'the record reads back as plain data');
  assert.equal(seen.name, history.active.name);
  assert.deepEqual(seen.dataset, { id: 'd1', name: 'Demo' });
  // The person starts another tracker and acts there: the history shown is another one.
  const first = history.active.name;
  await history.startTracker({ start: 'shown', name: 'Second look' });
  assert.equal(plainSentence(historySinceSentence(history.active, seen, own)),
    'Since your last turn the person changed what is shown: the history shown is now "Second look" (it was '
    + `"${first}"); no step is in effect there yet. Read this history before relying on it; it is not the one your earlier replies spoke of.`);
  for (let n = 0; n < 6; n++) await step('b.inc');
  await step('a.set', { v: 7 }, { origin: 'agent', agent: 'ChatGPT', turn: 'g-1' });
  // As a session file loaded beside would show it (start: import), and in a conversation other than the last turn's.
  const loaded = { ...history.active, start: { kind: 'import', from: { file: 'colleague.cellucid-session' } } };
  const sentence = plainSentence(historySinceSentence(loaded, seen, own, { conversation: 'chat-2' }));
  assert.equal(sentence,
    'Since your last turn the person changed what is shown: the history shown is now "Second look", loaded from the session file '
    + `"colleague.cellucid-session" (it was "${first}"); 7 steps are in effect there (by the person 6, ChatGPT 1); `
    + 'the latest 5: "b + 1" (4 times), "a = 7"; this conversation is not the one of your last turn: that one stays with '
    + `"${first}". Read this history before relying on it; it is not the one your earlier replies spoke of.`);
  // The same conversation: nothing said of it; a malformed record is no record.
  assert.ok(!/this conversation/.test(historySinceSentence(loaded, seen, own, { conversation: 'chat-1' })));
  for (const broken of [{ ...seen, steps: 'many' }, { ...seen, extra: 1 }, { ...seen, dataset: null }, { ...seen, next: -1 }, null]) {
    assert.equal(isHistorySeen(broken), false, JSON.stringify(broken));
  }
});

test('a branch switch is said as one, not as an undo: the agent\'s steps stay on their branch; a step taken on the branch left is named', async () => {
  const { historySeen, historySinceSentence } = await import('../assets/js/app/agent/history-link.js');
  const { plainSentence } = await import('../assets/js/app/actions/targets/names.js');
  const { history, act, step } = await makePage();
  const own = new Set(['turn-1']);
  const root = history.active.headId;
  await step('a.set', { v: 2 }, AGENT);
  await step('b.inc', {}, AGENT);
  const seen = historySeen(history.active);
  // The person takes a step on Main, then starts another branch from the opening and stays there.
  await step('cam.set', { v: 4 });
  await history.jump(root);
  await step('a.set', { v: 9 });
  const shown = history.active.branches.get(history.active.activeBranch).name;
  const sentence = plainSentence(historySinceSentence(history.active, seen, own));
  assert.ok(!/undone/.test(sentence), sentence);
  assert.match(sentence, new RegExp(`the branch shown is now "${shown}" \\(it was "Main"\\)`));
  assert.match(sentence, /Your steps "a = 2", "b \+ 1" stay on the branch "Main", not in effect on the branch shown/);
  assert.match(sentence, /The person's step "a = 9" is now in effect/);
  assert.match(sentence, /The person's step "cam 4" was taken on the branch "Main", not the one shown/);
  // Back on Main: the agent's steps are in effect again, the person's camera step too.
  await act('history.branch.switch', { branch: 'Main' });
  const back = plainSentence(historySinceSentence(history.active, seen, own));
  assert.match(back, /The person's step "cam 4" is now in effect/);
  assert.ok(!/Your/.test(back), back);
});
