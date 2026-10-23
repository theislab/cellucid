/**
 * Restoring the live view's data state (`restoreContext`, which a multiview
 * session restore runs between snapshot replays) keeps whether the live view
 * follows its dimension's default. It used to rebuild the live context as a
 * fresh one, which claims to follow the default, so the session's mapping
 * commit then moved a live view that showed a representation it was turned
 * to (a 3-column array shown in 2D) to the 2D default.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { viewContextCoreMethods } from '../assets/js/app/state/managers/view-context-core.js';

function liveState(followsDefault) {
  const state = Object.assign(Object.create(null), viewContextCoreMethods, {
    pointCount: 3,
    obsData: { fields: [] },
    varData: { fields: [] },
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    activeFieldSource: null,
    colorsArray: new Uint8Array(12),
    categoryTransparency: new Uint8Array(3),
    cellVisibilityMask: null,
    centroidPositions: null,
    centroidColors: null,
    centroidLabels: [],
    filteredCount: { shown: 3, total: 3 },
    activeViewId: 'live',
    viewContexts: new Map(),
    _applyOverlaysToFields() {},
    _injectUserDefinedFields() {},
    _ensureActiveSelectionNotDeleted() {},
    _pushColorsToViewer() {},
    _pushTransparencyToViewer() {},
    _pushCentroidsToViewer() {},
    computeGlobalVisibility() {},
    updateFilterSummary() {},
  });
  const live = state._buildContextFromCurrent('live', { cloneArrays: false });
  live.followsDefault = followsDefault;
  state.viewContexts.set('live', live);
  state.viewContexts.set('snap_1', { ...live, id: 'snap_1', followsDefault: true });
  return state;
}

for (const followsDefault of [false, true]) {
  test(`restoring the live context keeps followsDefault ${followsDefault}`, () => {
    const state = liveState(followsDefault);
    // A captured context always claims to follow: it is data state only.
    const captured = state.captureCurrentContext();
    assert.equal(captured.followsDefault, true);
    state.restoreContext(captured);
    assert.equal(state.viewContexts.get('live').followsDefault, followsDefault);
    // Snapshots are kept as they were.
    assert.equal(state.viewContexts.get('snap_1').followsDefault, true);
    assert.equal(state.activeViewId, 'live');
  });
}
