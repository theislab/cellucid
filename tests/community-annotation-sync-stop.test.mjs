/**
 * A stopped Pull or Publish reads as a cancellation wherever it is caught
 * (`community-annotation/sync-stop.js`): a stop that was a plain `Error`
 * with a code would be said as "Pull failed" on the person's Cancel, and
 * every catch that classifies errors (`isCancellation`) would miss it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindSyncOwner,
  createSyncStop,
  isStoppedForFailure,
  stoppedSyncOutcome,
  syncFailureOf,
} from '../assets/js/app/ui/modules/community-annotation/sync-stop.js';
import { cancellationKind, cancelled, isCancellation, throwIfAborted } from '../assets/js/utils/abort.js';

function card() {
  const calls = [];
  return {
    calls,
    complete: (id, words) => calls.push(['complete', id, words]),
    fail: (id, words) => calls.push(['fail', id, words]),
    dismiss: id => calls.push(['dismiss', id]),
  };
}

function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

test('the person\'s Cancel stops the sync as a cancellation, said on its card in its own words', () => {
  const stop = createSyncStop();
  const controller = stop.begin();
  assert.equal(stop.running, true);
  stop.stop(cancelled('user', 'Pull canceled; what it read is kept for the next Pull.'));
  const thrown = thrownBy(() => throwIfAborted(controller.signal));
  assert.equal(isCancellation(thrown), true);
  assert.equal(cancellationKind(thrown), 'user');
  // A request the stop aborted fails with the platform's own error: the catch reads the stop instead.
  const read = syncFailureOf(new DOMException('The operation was aborted.', 'AbortError'), controller);
  assert.equal(read, thrown);
  assert.equal(isStoppedForFailure(read, controller), false);
  const notifications = card();
  assert.deepEqual(stoppedSyncOutcome(read, notifications, 'card-1'), {
    status: 'cancelled',
    kind: 'user',
    words: 'Pull canceled; what it read is kept for the next Pull.',
  });
  assert.deepEqual(notifications.calls, [['complete', 'card-1', 'Pull canceled; what it read is kept for the next Pull.']]);
  stop.end(controller);
  assert.equal(stop.running, false);
});

test('a stop that belongs to someone else withdraws the card: whoever stopped it says why', () => {
  const stop = createSyncStop();
  const controller = stop.begin();
  stop.stop(cancelled('closed', 'Annotation moved to another tab.'));
  // The first reason stands.
  stop.stop(cancelled('user', 'Too late.'));
  const read = syncFailureOf(new TypeError('a step failed after the stop'), controller);
  assert.equal(cancellationKind(read), 'closed');
  const notifications = card();
  assert.equal(stoppedSyncOutcome(read, notifications, 'card-2').kind, 'closed');
  assert.deepEqual(notifications.calls, [['dismiss', 'card-2']]);
  // A quiet sync has no card.
  assert.deepEqual(stoppedSyncOutcome(read, card(), null).status, 'cancelled');
});

test('a Publish stopped after GitHub accepted part of it says so on its card, whoever stopped it', () => {
  const stop = createSyncStop();
  const controller = stop.begin();
  stop.stop(cancelled('closed', 'Annotation repo disconnected.'));
  const read = syncFailureOf(new TypeError('a step failed after the stop'), controller);
  // The publish catch puts what GitHub already accepted before the stop's words.
  const words = 'Publication was only partially completed. GitHub already accepted or confirmed unchanged: '
    + 'annotations/users/a.json. …\nAnnotation repo disconnected.';
  const notifications = card();
  assert.deepEqual(stoppedSyncOutcome(read, notifications, 'card-3', words), { status: 'cancelled', kind: 'closed', words });
  assert.deepEqual(notifications.calls, [['fail', 'card-3', words]]);
  // Nothing published before the stop: the stop's words alone, the card withdrawn.
  const nothing = card();
  stoppedSyncOutcome(read, nothing, 'card-4', read.message);
  assert.deepEqual(nothing.calls, [['dismiss', 'card-4']]);
});

test('a stop for a failure (the connection lost) is said as that failure, not as a cancellation', () => {
  const stop = createSyncStop();
  const controller = stop.begin();
  const lost = new Error('Network connection was lost.');
  stop.stop(lost);
  const read = syncFailureOf(new DOMException('aborted', 'AbortError'), controller);
  assert.equal(read, lost);
  assert.equal(isCancellation(read), false);
  assert.equal(isStoppedForFailure(read, controller), true);
});

test('an operation GitHub may have applied keeps its own error; nothing stopped keeps the error thrown', () => {
  const stop = createSyncStop();
  const controller = stop.begin();
  const failure = new Error('HTTP 500');
  assert.equal(syncFailureOf(failure, controller), failure);
  stop.stop(cancelled('user', 'Canceled.'));
  const unknown = Object.assign(new Error('the connection dropped after the request was sent'), { operation: { outcome: 'unknown' } });
  assert.equal(syncFailureOf(unknown, controller), unknown);
});

test('a newer sync supersedes one still under way; stopping none does nothing; a stop says why', () => {
  const stop = createSyncStop();
  stop.stop(cancelled('closed', 'Nothing runs.'));
  const first = stop.begin();
  const second = stop.begin();
  assert.equal(cancellationKind(first.signal.reason), 'superseded');
  assert.equal(second.signal.aborted, false);
  assert.throws(() => stop.stop('a string'), TypeError);
  assert.throws(() => stop.stop(new Error('')), TypeError);
  // Ending an older controller does not forget the newer one.
  stop.end(first);
  assert.equal(stop.running, true);
});

test('the caller\'s signal or the context stops the sync with its own reason, any reason made an error', () => {
  const controller = new AbortController();
  const caller = new AbortController();
  bindSyncOwner(controller, caller.signal);
  caller.abort('not an error');
  assert.equal(isCancellation(controller.signal.reason), true);
  assert.throws(() => bindSyncOwner(new AbortController(), { aborted: false, addEventListener() {}, removeEventListener() {} }), /must be an AbortSignal/);
});
