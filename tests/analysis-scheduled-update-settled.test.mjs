/**
 * An analysis's debounced update (`_scheduleUpdate`: Quick and Detailed
 * after a page or a field is chosen) is its work from the moment it is
 * scheduled: `whenSettled` (what a step and an agent's action wait for)
 * waits for it through its delay and its run, so what it changes belongs to
 * the change that scheduled it, never to a later one. A newer schedule
 * replaces it, and one that never runs (replaced, destroyed) waits for
 * nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { BaseAnalysisUI } from '../assets/js/app/analysis/ui/base-analysis-ui.js';

function analysis() {
  const ui = Object.create(BaseAnalysisUI.prototype);
  let intent = 0;
  Object.assign(ui, {
    _isDestroyed: false,
    _updateTimer: null,
    _notifications: { error() {} },
    runs: [],
    _beginAnalysisIntent: () => ++intent,
    _isCurrentAnalysisIntent: id => id === intent,
  });
  ui._runAnalysisIfValid = id => new Promise(resolve => setTimeout(() => { ui.runs.push(id); resolve(); }, 5));
  return ui;
}

test('whenSettled waits for an update still in its delay, then for its run', async () => {
  const ui = analysis();
  ui._scheduleUpdate(20);
  await ui.whenSettled();
  assert.deepEqual(ui.runs, [1], 'the scheduled update ran before whenSettled resolved');
});

test('a newer schedule replaces the waiting one; whenSettled waits for the newer one only', async () => {
  const ui = analysis();
  ui._scheduleUpdate(20);
  ui._scheduleUpdate(20);
  await ui.whenSettled();
  assert.deepEqual(ui.runs, [2]);
  assert.equal(ui._interactiveTasks.size, 0, 'nothing is left waiting');
});
