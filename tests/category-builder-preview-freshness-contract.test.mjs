/**
 * The category builder's preview is the only account a user gets of the column
 * they are about to create, and it is derived entirely from the cells the
 * chosen highlight pages hold. Every state operation that can move a cell into
 * or out of a page must therefore reach the builder, or the preview describes a
 * selection that no longer exists while the Create button stays enabled.
 *
 * This runs the operations through the real highlight manager and records what
 * it actually emits, rather than reading the emit calls out of the source.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { EventEmitter } from '../assets/js/app/utils/event-emitter.js';
import {
  PREVIEW_INVALIDATING_EVENTS
} from '../assets/js/app/ui/category-builder.js';
import {
  highlightStateMethods
} from '../assets/js/app/state/managers/highlight-manager.js';

const POINTS = 8;

function makeHighlightState() {
  const state = Object.assign(
    Object.create(highlightStateMethods),
    new EventEmitter()
  );
  for (const name of Object.getOwnPropertyNames(EventEmitter.prototype)) {
    if (name === 'constructor') continue;
    state[name] = EventEmitter.prototype[name];
  }
  state.pointCount = POINTS;
  state.highlightPages = [];
  state.activePageId = null;
  state._highlightPageIdCounter = 0;
  state._highlightIdCounter = 0;
  state._recomputeHighlightArray = () => {};
  return state;
}

function recordEmitted(state, action) {
  const seen = [];
  const originalEmit = state.emit;
  state.emit = function emit(eventName, ...rest) {
    seen.push(eventName);
    return originalEmit.call(this, eventName, ...rest);
  };
  try {
    action();
  } finally {
    state.emit = originalEmit;
  }
  return seen;
}

test('every operation that changes a page\'s cells reaches the builder', () => {
  const listened = new Set(PREVIEW_INVALIDATING_EVENTS);

  const cases = [
    ['add a selection to a page', (state) => {
      state.addHighlightDirect({
        type: 'lasso',
        label: 'Lasso 1',
        cellIndices: Uint32Array.from([0, 1, 2])
      });
    }],
    ['disable a selection', (state) => {
      const group = state.getHighlightedGroups()[0];
      assert.equal(state.toggleHighlightEnabled(group.id, false), true);
    }],
    ['re-enable a selection', (state) => {
      const group = state.getHighlightedGroups()[0];
      assert.equal(state.toggleHighlightEnabled(group.id, true), true);
    }],
    ['remove a selection', (state) => {
      const group = state.getHighlightedGroups()[0];
      assert.equal(state.removeHighlightGroup(group.id), true);
    }],
    ['clear the page', (state) => {
      state.addHighlightDirect({
        type: 'lasso',
        label: 'Lasso 2',
        cellIndices: Uint32Array.from([3, 4])
      });
      assert.equal(state.clearAllHighlights(), 1);
    }],
    ['create a page', (state) => {
      state.createHighlightPage('Second');
    }],
    ['switch pages', (state) => {
      const target = state.highlightPages.at(-1);
      assert.equal(state.switchToPage(target.id), true);
    }],
    ['rename a page', (state) => {
      assert.equal(
        state.renameHighlightPage(state.activePageId, 'Renamed'),
        true
      );
    }],
    ['delete a page', (state) => {
      const doomed = state.highlightPages.at(-1);
      assert.equal(state.deleteHighlightPage(doomed.id), true);
    }]
  ];

  const state = makeHighlightState();
  state.createHighlightPage('Page 1');

  for (const [name, action] of cases) {
    const emitted = recordEmitted(state, () => action(state));
    assert.equal(
      emitted.some(eventName => listened.has(eventName)),
      true,
      `"${name}" emitted ${JSON.stringify(emitted)}, none of which the `
      + `category builder listens to (${PREVIEW_INVALIDATING_EVENTS.join(', ')})`
    );
  }
});

test('the builder unsubscribes from exactly what it subscribed to', () => {
  // A subscription list and a teardown list that drift apart leak a listener
  // that keeps re-rendering a destroyed panel.
  assert.equal(PREVIEW_INVALIDATING_EVENTS.length > 0, true);
  assert.equal(Object.isFrozen(PREVIEW_INVALIDATING_EVENTS), true);
  assert.equal(
    new Set(PREVIEW_INVALIDATING_EVENTS).size,
    PREVIEW_INVALIDATING_EVENTS.length,
    'a duplicated event name would subscribe twice and re-render twice'
  );
});
