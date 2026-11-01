/**
 * Removing a highlight page or group can be undone (audit F-9): the removal
 * happens at once, and Undo puts back the very page or group -- its cell
 * lists, its place, its id -- unless the open cells changed since (its
 * lists would name other cells), its page is gone, or its id is taken.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { EventEmitter } from '../assets/js/app/utils/event-emitter.js';
import { highlightStateMethods } from '../assets/js/app/state/managers/highlight-manager.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { removeWithUndo } from '../assets/js/app/ui/modules/highlight/undo-removal.js';

function makeHighlightState() {
  const state = Object.assign(Object.create(highlightStateMethods), new EventEmitter());
  for (const name of Object.getOwnPropertyNames(EventEmitter.prototype)) {
    if (name !== 'constructor') state[name] = EventEmitter.prototype[name];
  }
  state.pointCount = 8;
  state.cellIdentity = createCellIdentity({ nObs: 8 });
  state.highlightPages = [];
  state.activePageId = null;
  state._highlightPageIdCounter = 0;
  state._highlightIdCounter = 0;
  state._recomputeHighlightArray = () => {};
  return state;
}

test('a deleted page comes back where it was, active again, with its groups', () => {
  const state = makeHighlightState();
  const first = state.createHighlightPage('One');
  const second = state.createHighlightPage('Two');
  state.createHighlightPage('Three');
  state.switchToPage(second.id);
  const group = state.addHighlightDirect({ type: 'lasso', label: 'Lasso', cellIndices: Uint32Array.of(1, 2) });
  const record = state.highlightPageRecord(second.id);
  assert.equal(state.deleteHighlightPage(second.id), true);
  assert.equal(state.activePageId, first.id);
  assert.equal(state.restoreHighlightPage(record), true);
  assert.deepEqual(state.highlightPages.map(page => page.name), ['One', 'Two', 'Three']);
  assert.equal(state.activePageId, second.id);
  assert.equal(state.getHighlightedGroups()[0], group);
  assert.equal(state.restoreHighlightPage(record), false, 'its id is there again');
});

test('a removed group comes back in its place; not after the open cells changed', () => {
  const state = makeHighlightState();
  state.createHighlightPage('One');
  const a = state.addHighlightDirect({ type: 'lasso', label: 'A', cellIndices: Uint32Array.of(1) });
  const b = state.addHighlightDirect({ type: 'lasso', label: 'B', cellIndices: Uint32Array.of(2) });
  const record = state.highlightGroupRecord(a.id);
  const before = state.getHighlightedGroups();
  assert.equal(state.removeHighlightGroup(a.id), true);
  assert.equal(state.restoreHighlightGroup(record), true);
  assert.deepEqual(state.getHighlightedGroups().map(group => group.id), [a.id, b.id]);
  assert.notEqual(state.getHighlightedGroups(), before, 'a new list: page memberships see the change');

  const again = state.highlightGroupRecord(b.id);
  state.removeHighlightGroup(b.id);
  state.cellIdentity = createCellIdentity({ nObs: 10, kept: Uint32Array.of(0, 1, 2, 3, 4, 5, 6, 7) });
  assert.equal(state.restoreHighlightGroup(again), false);
  assert.deepEqual(state.getHighlightedGroups().map(group => group.id), [a.id]);
});

test('the notification offers Undo, and says when it can no longer put it back', () => {
  const notifications = getNotificationCenter();
  const shown = [];
  const warned = [];
  const { show, warning } = notifications;
  notifications.show = notice => shown.push(notice);
  notifications.warning = message => warned.push(message);
  try {
    let present = true;
    assert.equal(removeWithUndo({ record: {}, remove: () => { present = false; return true; }, restore: () => false, removed: 'Page "Two"' }), true);
    assert.equal(present, false);
    assert.equal(shown[0].message, 'Page "Two" removed.');
    assert.equal(shown[0].action.label, 'Undo');
    shown[0].action.run();
    assert.deepEqual(warned, ['Page "Two" could not be put back: the open cells or the pages changed since.']);
    assert.equal(removeWithUndo({ record: null, remove: () => true, restore: () => true, removed: 'x' }), false, 'nothing to remove');
  } finally {
    notifications.show = show;
    notifications.warning = warning;
  }
});
