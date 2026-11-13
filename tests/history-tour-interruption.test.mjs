/**
 * The guided tour and the person (or an agent) acting while it plays. The
 * tour moves the history's head step by step and, at its end,
 * jumps back to the step shown before it began. Anyone else's step, move or
 * edit while it plays must not be overwritten by the tour's next jump (the
 * person's coloring would vanish from view, kept on a branch nobody was told
 * of), and the tour's return must not jump away from it again. So the tour
 * ends at once when someone else changes the history, and does not return: the
 * person moved on. What changes nothing shown (a note, a bookmark) leaves it
 * playing.
 *
 * Driven with plain-object stand-ins for the document and the tracker view;
 * no timer is waited on (the tour is interrupted inside its first hold).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTour } from '../assets/js/app/ui/modules/state/tour.js';

// The progress bar's style is set only on real elements (`StyleManager`): these stand-ins are not.
globalThis.HTMLElement ??= class HTMLElement {};

function fakeElement() {
  return {
    children: [], dataset: {}, style: { setProperty() {} }, hidden: false, disabled: false, textContent: '', innerHTML: '',
    setAttribute() {}, append(...nodes) { this.children.push(...nodes); }, remove() { this.removed = true; }, focus() {},
    addEventListener() {}, classList: { add() {}, remove() {} },
  };
}

function fakeDocument() {
  return { createElement: () => fakeElement(), body: fakeElement(), addEventListener() {} };
}

/** A tracker view of a straight path s0 → s1 → s2 → s3, head at s3, and a history whose events the test sends. */
function fakeHistory() {
  const steps = new Map();
  for (let i = 0; i < 4; i++) {
    steps.set(`s${i}`, {
      id: `s${i}`, parent: i === 0 ? null : `s${i - 1}`, label: `Step ${i}`, by: { origin: 'user' }, type: 'a.set',
      kind: i === 0 ? 'start' : 'action', touches: ['filters'], notes: [], group: null, status: 'ok',
    });
  }
  const tracker = {
    id: 't1', name: 'Tracker', headId: 's3', activeBranch: 'b0',
    step: id => steps.get(id), branch: () => ({ id: 'b0', name: 'Main' }), group: () => null,
  };
  const listeners = new Set();
  const jumps = [];
  return {
    tracker,
    steps,
    jumps,
    emit: event => { for (const listener of [...listeners]) listener(event); },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    jump: async stepId => {
      jumps.push(stepId);
      tracker.headId = stepId;
      for (const listener of [...listeners]) listener({ kind: 'moved', tracker: 't1', head: stepId });
    },
  };
}

for (const [what, act] of [
  ['makes a step', h => {
    h.steps.set('p1', { id: 'p1', parent: h.tracker.headId, label: 'Colored by CD3E', by: { origin: 'user' }, type: 'color.by', kind: 'action', touches: ['colors'], notes: [], group: null, status: 'ok' });
    h.tracker.headId = 'p1';
    h.emit({ kind: 'step', tracker: 't1', step: 'p1', steps: ['p1'] });
  }],
  ['moves the history (an agent\'s undo)', h => {
    h.tracker.headId = 's2';
    h.emit({ kind: 'moved', tracker: 't1', head: 's2' });
  }],
  ['edits the history (a step deleted)', h => {
    h.emit({ kind: 'edited', tracker: 't1', op: 'step.delete', steps: [], removed: ['s2'] });
  }],
]) {
  test(`someone who ${what} while the tour plays ends it where they are; the tour does not jump back`, async () => {
    const h = fakeHistory();
    const tour = createTour({ ownerDocument: fakeDocument(), view: () => h.tracker, jump: h.jump, camera: null, subscribe: h.subscribe });
    let started;
    const playing = new Promise(resolve => { started = resolve; });
    const run = tour.play({ onStart: started });
    await playing;
    // The tour shows its first step and holds it; the person acts then.
    while (h.jumps.length === 0) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.jumps, ['s0']);
    act(h);
    await run;
    assert.equal(tour.playing, false, 'the tour ended');
    assert.deepEqual(h.jumps, ['s0'], 'no later step shown, no return to where the tour began');
  });
}

test('a note added while the tour plays (the turn\'s note at its end) leaves it playing', async () => {
  const h = fakeHistory();
  const tour = createTour({ ownerDocument: fakeDocument(), view: () => h.tracker, jump: h.jump, camera: null, subscribe: h.subscribe });
  const run = tour.play();
  while (h.jumps.length === 0) await new Promise(resolve => setImmediate(resolve));
  h.emit({ kind: 'edited', tracker: 't1', op: 'note.add', steps: [], removed: [] });
  assert.equal(tour.playing, true);
  await tour.stop();
  await run;
  assert.deepEqual(h.jumps, ['s0', 's3']);
});

test('the tour\'s own moves do not end it, and Stop returns to the step shown before', async () => {
  const h = fakeHistory();
  const tour = createTour({ ownerDocument: fakeDocument(), view: () => h.tracker, jump: h.jump, camera: null, subscribe: h.subscribe });
  const run = tour.play();
  while (h.jumps.length === 0) await new Promise(resolve => setImmediate(resolve));
  assert.equal(tour.playing, true, 'its own first jump did not end it');
  assert.equal(await tour.stop(), true);
  await run;
  assert.deepEqual(h.jumps, ['s0', 's3'], 'back at the step shown before');
});

test('an event that moves nothing while the tour\'s own jump is under way (an agent\'s chat kept as its turn ends) leaves it playing', async () => {
  const h = fakeHistory();
  const ownJump = h.jump;
  // The history tells of the chat kept with it before the jump has moved the head (else
  // an agent's history_tour_start would end the tour it had just started).
  const jump = async stepId => {
    h.emit({ kind: 'chat', tracker: 't1', conversation: 'c1' });
    await ownJump(stepId);
  };
  const tour = createTour({ ownerDocument: fakeDocument(), view: () => h.tracker, jump, camera: null, subscribe: h.subscribe });
  const run = tour.play();
  while (h.jumps.length === 0) await new Promise(resolve => setImmediate(resolve));
  assert.equal(tour.playing, true, 'still playing after its first jump');
  assert.equal(await tour.stop(), true);
  await run;
  assert.deepEqual(h.jumps, ['s0', 's3'], 'back at the step shown before');
});
