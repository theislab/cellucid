/**
 * Every change of the open dataset's history reaches a host as one
 * `history_changed` event (`app/viewer-host/history-events.js`), in the
 * protocol's kinds, with where the history stands after it; the page's
 * history is followed when another dataset replaces it, and a conversation
 * kept with a tracker is not told.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createViewerHostHistoryEvents,
  historyChangeKind,
} from '../assets/js/app/viewer-host/history-events.js';
import { VIEWER_HISTORY_CHANGE_KINDS } from '../assets/js/data/viewer-protocol.js';

/** A history that tells its subscribers as `history.js` does: `{kind, ...detail}`. */
function fakeHistory(active) {
  const listeners = new Set();
  return {
    active,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    tell(kind, detail = {}) { for (const listener of [...listeners]) listener({ kind, ...detail }); },
    get listeners() { return listeners.size; },
  };
}

/** The page's current history (`history/current.js`), for one test. */
function currentHistory() {
  let history = null;
  const listeners = new Set();
  return {
    get: () => history,
    set(next) { history = next; for (const listener of [...listeners]) listener(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get listeners() { return listeners.size; },
  };
}

test('the history\'s change kinds are told in the protocol\'s, every other edit as edited, a conversation not at all', () => {
  assert.equal(historyChangeKind('step'), 'step');
  assert.equal(historyChangeKind('moved'), 'moved');
  assert.equal(historyChangeKind('tracker'), 'tracker');
  assert.equal(historyChangeKind('loaded'), 'loaded');
  for (const kind of ['renamed', 'deleted', 'journal', 'note', 'branch', 'bookmark']) assert.equal(historyChangeKind(kind), 'edited');
  assert.equal(historyChangeKind('chat'), null);
  for (const kind of ['step', 'moved', 'renamed', 'tracker', 'loaded']) assert.ok(VIEWER_HISTORY_CHANGE_KINDS.includes(historyChangeKind(kind)));
  assert.throws(() => historyChangeKind(''), /has a kind/);
});

test('each change is told with where the history stands, following the history the page shows', () => {
  const page = currentHistory();
  const told = [];
  const errors = [];
  const events = createViewerHostHistoryEvents({
    notify: change => { told.push(change); return true; },
    getCurrentHistory: page.get,
    subscribeCurrentHistory: page.subscribe,
    onError: error => errors.push(error),
  });
  const first = fakeHistory({ id: 't-1', headId: 's3', activeBranch: 'b0' });
  page.set(first);
  first.tell('step', { tracker: 't-1', step: 's3' });
  first.active.headId = 's2';
  first.tell('moved', { tracker: 't-1', head: 's2' });
  first.tell('renamed', { tracker: 't-1' });
  first.tell('chat', { tracker: 't-1', conversation: 'c1' });
  // Before the core names branches, the active branch is null.
  const second = fakeHistory({ id: 't-2', headId: 's0' });
  page.set(second);
  assert.equal(first.listeners, 0, 'the replaced history is no longer followed');
  first.tell('step', { tracker: 't-1', step: 's4' });
  second.tell('tracker', { tracker: 't-2' });
  second.tell('loaded', {});
  page.set(null);
  second.tell('step', { tracker: 't-2', step: 's1' });
  assert.deepEqual(told, [
    { kind: 'step', tracker: 't-1', head: 's3', step: 's3', branch: 'b0' },
    { kind: 'moved', tracker: 't-1', head: 's2', step: null, branch: 'b0' },
    { kind: 'edited', tracker: 't-1', head: 's2', step: null, branch: 'b0' },
    { kind: 'tracker', tracker: 't-2', head: 's0', step: null, branch: null },
    { kind: 'loaded', tracker: 't-2', head: 's0', step: null, branch: null },
  ]);
  assert.deepEqual(errors, []);
  events.stop();
  assert.equal(page.listeners, 0);
});

test('a change that could not be told is reported, and the next one is told', () => {
  const page = currentHistory();
  const errors = [];
  let fail = true;
  const told = [];
  const history = fakeHistory({ id: 't-1', headId: 's1', activeBranch: 'b0' });
  page.set(history);
  createViewerHostHistoryEvents({
    notify: change => { if (fail) throw new Error('closed'); told.push(change.kind); return true; },
    getCurrentHistory: page.get,
    subscribeCurrentHistory: page.subscribe,
    onError: error => errors.push(error.message),
  });
  history.tell('step', { step: 's1' });
  fail = false;
  history.tell('moved', {});
  assert.deepEqual(errors, ['closed']);
  assert.deepEqual(told, ['moved']);
  assert.throws(() => createViewerHostHistoryEvents({ notify: null }), /need notify/);
});
