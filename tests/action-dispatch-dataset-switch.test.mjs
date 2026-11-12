/**
 * An action still running when another dataset opens ends with the history
 * that began recording it (bug hunt R9W-3). Opening another dataset retires
 * the shown dataset's history (`dataset-history.js` `retire`: destroyed) and
 * the new dataset's history takes the dispatcher's recorder. The running
 * action's token belongs to the retired one: it is never put back through,
 * nor recorded in, the new dataset's history.
 *
 * Before the fix the dispatcher told whichever recorder was current: a
 * markers run on Garcia stopped by opening Pancreas ended with "The history
 * has no value c7be2ab0cc2b" (Pancreas's history trying to put back
 * Garcia's values), and a change that finished after the switch was merged
 * into the new history's view of the state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { deferred, makePage, NUMBER, fakePage, trackerId } from './history-fake-page.mjs';
import { defineAction } from '../assets/js/app/actions/catalog.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { cancelled, isCancellation } from '../assets/js/utils/abort.js';

const AGENT = Object.freeze({ origin: 'agent', agent: 'Claude', turn: 'turn-1' });
const SLOW_SET = defineAction({
  type: 'slow.set', title: 'Slow set', summary: 'Sets a, then waits.', group: 'T', params: NUMBER,
  touches: ['filters'], reads: [], effect: 'state', describe: p => `a = ${p.v}`, code: p => `slow(${p.v})`,
});

/** A page whose dataset is replaced while `slow.set` runs: the first history destroyed, a second one recording. */
async function switchWhileRunning() {
  const hold = deferred();
  const entered = deferred();
  const made = await makePage({
    extra: [SLOW_SET],
    provide: (dispatcher, page) => {
      dispatcher.provide('slow.set', async ({ v }) => {
        page.state.a = v;
        entered.resolve();
        await hold.promise;
        return { a: v };
      });
    },
  });
  const running = made.dispatcher.dispatch('slow.set', { v: 9 }, AGENT);
  await entered.promise;
  // Another dataset opens: its history is retired, the new dataset shown and its history begun.
  made.history.destroy();
  made.page.state.a = 42;
  const next = createHistory({
    dispatcher: made.dispatcher, domains: made.page.domains, dataset: { id: 'd2', name: 'Other', cellOrder: null },
    newTrackerId: () => trackerId(1000), now: () => Date.now(),
  });
  return { ...made, running, hold, next };
}

test('an action stopped by a dataset switch ends as its cancellation; the new dataset is not put back to the old one', async () => {
  const { page, dispatcher, running, hold, next } = await switchWhileRunning();
  const reason = cancelled('superseded', 'Another dataset was opened.');
  assert.equal(dispatcher.stop({ turn: AGENT.turn }, reason), 1);
  hold.resolve();
  await assert.rejects(running, error => error === reason && isCancellation(error));
  assert.equal(page.state.a, 42, 'the new dataset\'s state stays');
  // Its first tracker starts once the dataset's starting view is shown (`beginShownDatasetHistory`).
  await next.startTracker();
  const steps = next.active.steps.size;
  assert.equal(next.active.headId, [...next.active.steps.keys()][0], 'nothing recorded before it');
  // The history of the new dataset is free: the next action records there.
  const after = await dispatcher.dispatch('a.set', { v: 7 });
  assert.equal(after.step?.type, 'a.set');
  assert.equal(next.active.steps.size, steps + 1);
  await dispatcher.idle();
});

test('an action that ends after a dataset switch records nothing in the new dataset\'s history', async () => {
  const { page, dispatcher, running, hold, next } = await switchWhileRunning();
  hold.resolve();
  const result = await running;
  assert.equal(result.step, null, 'no step');
  await next.startTracker();
  assert.equal(next.active.steps.size, 1, 'the new tracker holds its start only');
  const head = next.active.headId;
  assert.equal(page.state.a, 42, 'the new dataset\'s state stays');
  const after = await dispatcher.dispatch('a.set', { v: 3 });
  assert.equal(after.step?.parent, head, 'the next step follows the new history\'s own head');
  await dispatcher.idle();
});
