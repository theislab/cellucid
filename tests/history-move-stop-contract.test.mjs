/**
 * The history's own actions are stopped as every other action is. A move or an
 * edit of the history runs alone (`exclusive`): it waits
 * for the actions running, then runs. An agent's `history.undo` (or jump,
 * branch switch, group, …) stopped by the person while it waits for its turn
 * does not run once its turn comes, and a move stopped while it puts a
 * state back does not go on to the end. So:
 *
 * - stopped while it waits, it never runs (the head and the state stay);
 * - stopped while its restore runs, what was shown comes back and the head
 *   stays;
 * - every exclusive task of `history/actions.js` is given its dispatch's
 *   signal (checked on the source: an action added later keeps the rule).
 *
 * No timers: work is held open by promises the test releases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { deferred, makePage, NUMBER } from './history-fake-page.mjs';
import { defineAction } from '../assets/js/app/actions/catalog.js';
import { cancelled } from '../assets/js/utils/abort.js';

const AGENT = Object.freeze({ origin: 'agent', agent: 'Claude', turn: 'turn-stop' });
const STOP = () => cancelled('user', 'The person stopped Claude.');

const HELD = defineAction({
  type: 'held.set', title: 'Held set', summary: 'Sets b, then waits.', group: 'T', params: NUMBER,
  touches: ['colors'], reads: [], effect: 'state', describe: p => `b = ${p.v}`, code: p => `held(${p.v})`,
});

/** A page with steps a1, a2 (filters) and an action of the person's held open on `colors`. */
async function busyPage() {
  const hold = deferred();
  const entered = deferred();
  const made = await makePage({
    extra: [HELD],
    provide: (dispatcher, page) => dispatcher.provide('held.set', async ({ v }) => {
      page.state.b = v;
      entered.resolve();
      await hold.promise;
    }),
  });
  const s1 = await made.step('a.set', { v: 1 });
  const s2 = await made.step('a.set', { v: 2 });
  return { ...made, hold, entered: entered.promise, s1, s2 };
}

/** Each history action an agent may send while the person's action runs, with what it would change. */
const QUEUED = [
  ['history.undo', () => ({})],
  ['history.redo', () => ({})],
  ['history.jump', ({ s1 }) => ({ step: s1.id })],
  ['history.branch.create', ({ s1 }) => ({ step: s1.id, name: 'Idea' })],
  ['history.group.create', ({ s1, s2 }) => ({ from: s1.id, to: s2.id, name: 'QC' })],
  ['history.bookmark.set', ({ s1 }) => ({ step: s1.id, name: 'Mark' })],
  ['history.tracker.rename', ({ history }) => ({ tracker: history.active.id, name: 'Mine' })],
];

for (const [type, paramsOf] of QUEUED) {
  test(`${type} stopped while it waits for the actions running never runs`, async () => {
    const page = await busyPage();
    const { history, dispatcher, hold, entered } = page;
    if (type === 'history.redo') await dispatcher.dispatch('history.undo', {});
    const running = dispatcher.dispatch('held.set', { v: 5 });
    await entered;
    const snapshot = JSON.stringify(history.snapshot());
    const state = { ...page.page.state, b: 0 };
    const queued = dispatcher.dispatch(type, paramsOf(page), AGENT);
    // It waits behind the person's action (the history runs its moves and edits alone).
    await new Promise(resolve => setImmediate(resolve));
    const reason = STOP();
    assert.equal(dispatcher.stop({ turn: AGENT.turn }, reason), 1);
    await assert.rejects(queued, error => error === reason);
    hold.resolve();
    await running;
    await history.idle();
    const after = history.snapshot();
    // The person's action made its step; nothing of the stopped one happened.
    const steps = JSON.parse(snapshot).trackers[0].steps?.length;
    if (steps !== undefined) assert.equal(after.trackers[0].steps.length, steps + 1);
    assert.equal(page.page.state.a, state.a, 'the state the stopped action would have moved stays');
    assert.equal(after.trackers[0].journal?.length ?? 0, JSON.parse(snapshot).trackers[0].journal?.length ?? 0, 'no edit was journaled');
  });
}

test('a jump stopped while it puts a state back leaves what was shown and the head where they were', async () => {
  const { page, history, dispatcher, s1, s2 } = await busyPage();
  const owner = page.domains.owner('filters');
  const restore = owner.restore;
  const inside = deferred();
  const release = deferred();
  let holding = true;
  owner.restore = async value => {
    restore(value);
    if (!holding) return;
    holding = false;
    inside.resolve();
    await release.promise;
  };
  const jumping = dispatcher.dispatch('history.jump', { step: s1.id }, AGENT);
  await inside.promise;
  assert.equal(page.state.a, 1, 'the restore began');
  const reason = STOP();
  dispatcher.stop({ turn: AGENT.turn }, reason);
  release.resolve();
  await assert.rejects(jumping, error => error === reason);
  assert.equal(history.active.headId, s2.id, 'the head stays');
  assert.equal(page.state.a, 2, 'what was shown came back');
  owner.restore = restore;
});
