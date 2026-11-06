/**
 * History v2 §3.15.1: paused. "Discard and go" discards the paused changes
 * for good (leaving the tracker and coming back never brings them back);
 * resuming a paused tracker not in use (a reload kept its draft) keeps its
 * draft as one squashed step against its own head.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { historyProblem, makePage } from './history-fake-page.mjs';
import { valuesAt } from '../assets/js/app/history/tree.js';

test('discarding while paused, then leaving the tracker and coming back: the change stays discarded', async () => {
  const { page, history, act, step } = await makePage();
  await step('a.set', { v: 1 });
  const first = history.active.id;
  await act('history.tracker.start', { start: 'shown', name: 'Second' });
  await act('history.tracker.use', { tracker: first });
  await act('history.recording.pause');
  await act('a.set', { v: 9 });
  history.setPausedChoice('discard');
  await act('history.tracker.use', { tracker: 'Second' });
  assert.equal(history.allTrackers().find(tracker => tracker.id === first).paused.draft, null);
  await act('history.tracker.use', { tracker: first });
  assert.equal(page.state.a, 1);
  assert.equal(historyProblem(history), null);
});

test('resuming a paused tracker not in use keeps its draft as one squashed step on its own head', async () => {
  const { history, act, step } = await makePage();
  await step('a.set', { v: 1 });
  const first = history.active.id;
  await act('history.recording.pause');
  await act('a.set', { v: 9 });
  const snapshot = history.snapshot();
  // Reload with the first tracker paused (its draft kept) and another in use.
  const second = await history.startTracker({ start: 'shown', name: 'Second' });
  snapshot.trackers.push(...history.snapshot().trackers.filter(tracker => tracker.id === second.id));
  snapshot.activeTracker = second.id;
  const values = new Map(history.pool.hashes().map(hash => [hash, history.pool.get(hash)]));
  await history.load(snapshot, { values });
  assert.notEqual(history.allTrackers().find(tracker => tracker.id === first).paused.draft, null);
  const resumed = await act('history.recording.resume', { tracker: first });
  assert.notEqual(resumed.squashed, null);
  const tracker = history.allTrackers().find(each => each.id === first);
  assert.equal(tracker.paused, null);
  const made = tracker.steps.get(resumed.squashed);
  assert.equal(made.squashed.cause, 'paused');
  assert.equal(history.pool.get(valuesAt(tracker, made.id).filters), 9);
  assert.equal(history.pool.get(made.before.filters), 1, 'against its own head');
  assert.equal(history.active.id, second.id, 'the tracker in use stays in use');
  assert.equal(historyProblem(history), null);
});
