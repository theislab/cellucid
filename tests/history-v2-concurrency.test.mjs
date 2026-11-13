/**
 * The history's exclusive operations against everything
 * else that writes it. A move or an edit runs alone: actions wait at the
 * gate, an edit of the history (squash, group, rename, note, bookmark) waits
 * for the operation running, and a change observed meanwhile (a camera drag
 * settling while a delete applies its dependants again) is recorded after
 * it, against what is shown then. Every interleaving ends in a valid
 * history whose steps' before-values are their parents' values.
 *
 * No timers: each test holds an operation open with a promise and learns it
 * is reached from the operation itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { beforeInvariantBreaks, deferred, historyProblem, makePage, slowGate } from './history-fake-page.mjs';
import { valuesAt } from '../assets/js/app/history/tree.js';

for (const cancel of [false, true]) {
  test(`a change observed while a delete applies its dependants again is recorded after it (${cancel ? 'cancelled' : 'completed'})`, async () => {
    const slow = slowGate();
    const { page, history, dispatcher, step } = await makePage({ slow });
    const s1 = await step('a.set', { v: 1 });
    await step('c.derive');
    slow.arm();
    const controller = new AbortController();
    const deleting = history.deleteStep(s1.id, { signal: controller.signal }).catch(error => error);
    await slow.entered;
    // The person drags the camera while the analysis runs again; it settles and is observed.
    page.state.cam = 7;
    const observed = dispatcher.recordObserved('cam.set', { v: 7 });
    if (cancel) controller.abort(new Error('Cancel'));
    slow.release();
    const out = await deleting;
    const made = await observed;
    assert.equal(out instanceof Error, cancel);
    assert.ok(made !== null, 'the drag is a step');
    const tracker = history.active;
    assert.equal(tracker.headId, made.id, 'recorded at the head, after the delete');
    assert.equal(history.pool.get(valuesAt(tracker, made.id).camera), 7);
    assert.equal(page.state.cam, 7);
    assert.equal(historyProblem(history), null);
    assert.deepEqual(beforeInvariantBreaks(tracker), []);
  });

  test(`a squash asked for while a delete runs waits for it (${cancel ? 'cancelled' : 'completed'})`, async () => {
    const slow = slowGate();
    const { history, act, step } = await makePage({ slow });
    const s1 = await step('a.set', { v: 1 });
    const s2 = await step('b.inc');
    const s3 = await step('b.inc');
    await step('c.derive');
    slow.arm();
    const controller = new AbortController();
    const deleting = history.deleteStep(s1.id, { signal: controller.signal }).catch(error => error);
    await slow.entered;
    // An agent (or the panel) squashes two steps meanwhile: it waits for the delete.
    let squashed = false;
    const squash = act('history.squash', { from: s2.id, to: s3.id }).then(result => { squashed = true; return result; });
    if (cancel) controller.abort(new Error('Cancel'));
    assert.equal(squashed, false);
    slow.release();
    const out = await deleting;
    assert.equal(out instanceof Error, cancel);
    const made = await squash;
    const tracker = history.active;
    assert.equal(tracker.steps.get(made.step).kind, 'squashed');
    assert.deepEqual(tracker.journal.map(entry => entry.op), cancel ? ['squash'] : ['step.delete', 'squash']);
    assert.equal(historyProblem(history), null);
    assert.deepEqual(beforeInvariantBreaks(tracker), []);
  });
}

test('every journaled edit waits for the exclusive operation running', async () => {
  const slow = slowGate();
  const { history, act, step } = await makePage({ slow });
  const s1 = await step('a.set', { v: 1 });
  const s2 = await step('b.inc');
  await step('c.derive');
  slow.arm();
  const deleting = history.deleteStep(s1.id);
  await slow.entered;
  const order = [];
  const edits = [
    act('history.branch.rename', { branch: 'b0', name: 'Trunk' }),
    act('history.group.create', { from: s2.id, to: s2.id, name: 'QC' }),
    act('history.note.add', { target: { step: s2.id }, text: 'checked' }),
    act('history.bookmark.set', { step: s2.id, name: 'Mark' }),
    act('history.tracker.rename', { tracker: history.active.id, name: 'Mine' }),
  ].map((promise, index) => promise.then(() => order.push(index)));
  slow.release();
  await deleting.then(() => order.push('delete'));
  await Promise.all(edits);
  assert.deepEqual(order, ['delete', 0, 1, 2, 3, 4]);
  assert.equal(historyProblem(history), null);
});

test('a queued move never runs while an action the gate let through is still applying', async () => {
  const log = [];
  const { history, dispatcher, step } = await makePage();
  await step('a.set', { v: 1 });
  await step('b.inc');
  const held = deferred();
  const settling = deferred();
  let first = true;
  dispatcher.addSettler(async () => {
    if (!first) return;
    first = false;
    settling.resolve();
    await held.promise;
  });
  history.subscribe(event => { if (event.kind === 'moved') log.push(`moved ${event.head}`); });
  dispatcher.subscribe(event => { if (event.type === 'a.set' && (event.kind === 'start' || event.kind === 'done')) log.push(`a.set ${event.kind}`); });
  const move1 = history.jump('s1');
  await settling.promise;
  const action = dispatcher.dispatch('a.set', { v: 5 });
  const move2 = history.undo();
  held.resolve();
  await Promise.all([move1, action, move2]);
  const start = log.indexOf('a.set start');
  const done = log.indexOf('a.set done');
  assert.deepEqual(log.filter((entry, index) => entry.startsWith('moved') && index > start && index < done), []);
  const tracker = history.active;
  assert.deepEqual(history.shownHashes(), { ...history.shownHashes(), ...valuesAt(tracker, tracker.headId) });
  assert.equal(historyProblem(history), null);
});

test('an action queued while "Branch here" runs starts the named branch', async () => {
  const { history, dispatcher, act, step } = await makePage();
  const s1 = await step('a.set', { v: 1 });
  await step('a.set', { v: 2 });
  const held = deferred();
  const settling = deferred();
  let first = true;
  dispatcher.addSettler(async () => {
    if (!first) return;
    first = false;
    settling.resolve();
    await held.promise;
  });
  const creating = act('history.branch.create', { step: s1.id, name: 'Idea' });
  await settling.promise;
  const queued = dispatcher.dispatch('b.inc', {});
  held.resolve();
  await Promise.all([creating, queued]);
  const tracker = history.active;
  assert.equal(tracker.branches.get(tracker.steps.get(tracker.headId).branch).name, 'Idea');
});
