/**
 * A stopped action's rollback puts back only what the action itself changed,
 * never the person's own act made meanwhile: a Marker
 * genes run in a floating window, the window's × pressed while it ran; the ×
 * closes the window (an observed change of `analysis`), the closing stops
 * the run, and the run's rollback must not put the whole `analysis` domain
 * back — the window would open again and no "Closed" step be kept. A person's
 * act is its
 * own step and stands through the rollback; work the action set off (a
 * change observed without `person`) is still the action's and goes with it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { defineAction } from '../assets/js/app/actions/catalog.js';
import { deferred, makePage, NONE } from './history-fake-page.mjs';

const extra = [
  defineAction({ type: 'w.run', title: 'Run', summary: 'A long run.', group: 'T', params: NONE, touches: ['analysis'], reads: [], effect: 'state', describe: () => 'Ran', code: () => 'run()' }),
  defineAction({ type: 'w.close', title: 'Close', summary: 'Close the window.', group: 'T', params: NONE, touches: ['analysis'], reads: [], effect: 'layout', describe: () => 'Closed the window', code: () => 'close()' }),
];

async function pageWithRun() {
  const gate = deferred();
  const started = deferred();
  const page = await makePage({
    extra,
    provide: (dispatcher, fake) => {
      dispatcher.provide('w.run', async () => {
        fake.state.c = 'running';
        started.resolve();
        await gate.promise;
        // Its window closed under it: the run is stopped.
        throw new Error('Marker genes was canceled before it finished; nothing was kept.');
      });
    },
  });
  page.page.state.c = 'window open';
  await page.history.reconcile?.();
  return { ...page, gate, started };
}

const labels = history => [...history.active.steps.values()].map(step => step.label);

test('a person closes the window while its run runs: the close stands through the run\'s rollback, as its own step', async () => {
  const { page, dispatcher, history, gate, started } = await pageWithRun();
  const before = labels(history);
  const run = dispatcher.dispatch('w.run', {});
  await started.promise;
  // The ×: the window closes (the person's act), observed as such.
  page.state.c = 'closed';
  const closed = dispatcher.recordObserved('w.close', {}, {}, null, { person: true });
  gate.resolve();
  await assert.rejects(run, /canceled before it finished/);
  await closed;
  assert.equal(page.state.c, 'closed', 'the rollback left the person\'s close');
  assert.deepEqual(labels(history), [...before, 'Closed the window']);
  // Undo takes the close back to what was shown before it.
  await history.undo();
  assert.notEqual(page.state.c, 'closed');
});

test('work the action set off (observed without person) is still the action\'s: its rollback takes it back', async () => {
  const { page, dispatcher, history, gate, started } = await pageWithRun();
  const before = labels(history);
  const shownBefore = page.state.c;
  const run = dispatcher.dispatch('w.run', {});
  await started.promise;
  page.state.c = 'redrawn';
  const observed = dispatcher.recordObserved('w.close', {});
  gate.resolve();
  await assert.rejects(run);
  assert.equal(await observed, null, 'joined to the running action');
  assert.equal(page.state.c, shownBefore, 'put back whole');
  assert.deepEqual(labels(history), before);
});
