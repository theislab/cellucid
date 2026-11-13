/**
 * An agent's or a notebook's turn can start another tracker. The new tracker's
 * opening is recorded with the turn of the meta, but the tracker holds no
 * record of that turn, so the model would refuse the whole tracker ("step
 * "s0" belongs to the turn …, which it does not hold") and
 * `history_tracker_start` would fail for every agent. The opening is
 * no step of a turn: it says who started it; the turn's next step in the new
 * tracker makes the turn's record there.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { historyProblem, makePage } from './history-fake-page.mjs';

for (const [who, meta] of [
  ['an agent', { origin: 'agent', agent: 'Claude', model: 'claude-opus-5-5', turn: 'turn-1', turnLabel: 'Look again' }],
  ['a notebook', { origin: 'host', host: 'python', turn: 'cell-3', turnLabel: 'Cell 3' }],
]) {
  test(`${who} starts another tracker in its turn; its next step there belongs to the turn`, async () => {
    const { history, act, step } = await makePage();
    await step('a.set', { v: 1 }, meta);
    const started = await act('history.tracker.start', { name: 'Second look' }, meta);
    assert.equal(history.active.name, 'Second look');
    assert.equal(started.tracker.name, 'Second look');
    const root = history.active.steps.get(history.active.rootId);
    assert.equal(root.by.origin, meta.origin);
    assert.equal(root.by.turn, null);
    const next = await step('b.inc', {}, meta);
    assert.equal(history.active.steps.get(next.id).by.turn, meta.turn);
    assert.equal(history.active.turns.get(meta.turn)?.id, meta.turn);
    assert.equal(historyProblem(history), null);
  });
}
