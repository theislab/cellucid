/**
 * Per-view state is captured view by view, by position (the live view
 * first, then each kept view): whichever view is focused, the live view's
 * value is the live view's, and the focused view's value is read from the
 * state it is being edited in (DataState's top level), not from its parked
 * view context (`app/state/domains/view-list.js` `viewOwner`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DataState } from '../assets/js/app/state/core/data-state.js';
import {
  createInMemoryAnnDataDimensionManager,
  inMemoryAnnDataMapping,
} from './helpers/in-memory-anndata.mjs';
import { createActiveFieldDomain } from '../assets/js/app/state/domains/active-field.js';
import { createFiltersDomain } from '../assets/js/app/state/domains/filters.js';
import { createViewsDomain } from '../assets/js/app/state/domains/views.js';
import { visibleOf } from './helpers/category-state.mjs';

const permissiveViewer = new Proxy({}, {
  get: (_target, property) => (
    property === 'getViewLayout'
      ? () => ({ mode: 'grid', activeId: 'live', liveViewHidden: false })
      : () => undefined
  )
});

function twoViewState() {
  const state = new DataState(permissiveViewer, null);
  state.pointCount = 2;
  state.cellVisibilityMask = new Uint8Array([1, 1]);
  state.categoryTransparency = new Uint8Array([1, 1]);
  state.colorsArray = new Uint8Array(8);
  state.obsData = {
    fields: [
      { key: 'leiden', kind: 'category', categories: ['a', 'b'], codes: new Uint16Array([0, 1]), loaded: true },
      { key: 'sample', kind: 'category', categories: ['x', 'y'], codes: new Uint16Array([0, 1]), loaded: true }
    ]
  };
  state.varData = { fields: [] };
  // One 3D representation, shown by every view.
  const dimensionManager = createInMemoryAnnDataDimensionManager({
    positions: new Float32Array(6),
    dimension: 3
  });
  state.setDimensionManager(dimensionManager);
  state.publishDatasetMapping({
    mapping: inMemoryAnnDataMapping(),
    candidates: null,
    origin: 'default'
  });
  // Live view: colored by leiden with category "a" hidden.
  state.activeFieldIndex = 0;
  state.activeFieldSource = 'obs';
  state.obsData.fields[0]._categoryVisible = visibleOf([false, true]);
  state._resetViewContexts();
  // Kept view: colored by sample, no filters.
  state.createViewFromSource('live', 'snap_1');
  dimensionManager.copyViewLayout('live', 'snap_1');
  const snapshot = state.viewContexts.get('snap_1');
  snapshot.activeFieldIndex = 1;
  delete snapshot.obsData.fields[0]._categoryVisible;
  return state;
}

/** The viewer as the domains read it: the live view and one kept view, `activeId` focused. */
function viewerWith(activeId) {
  return {
    getSnapshotViews: () => [{ id: 'snap_1' }],
    getViewLayout: () => ({ mode: 'grid', activeId, liveViewHidden: false }),
    getCamerasLocked: () => true,
    getCentroidFlags: () => ({ points: false, labels: false }),
    getViewName: () => null,
  };
}

function captureWith(state, activeId) {
  const viewer = viewerWith(activeId);
  const refreshUi = () => {};
  return {
    activeField: createActiveFieldDomain({ state, viewer, refreshUi }).capture(),
    filters: createFiltersDomain({ state, viewer, refreshUi }).capture(),
    views: createViewsDomain({ state, viewer, refreshUi }).capture(),
  };
}

const LEIDEN = { source: 'obs', key: 'leiden' };
const SAMPLE = { source: 'obs', key: 'sample' };
const LIVE_FILTERS = [{ field: LEIDEN, hidden: ['a'] }];

test('saving while a kept view is selected records the live view as the live view', () => {
  const liveSelected = captureWith(twoViewState(), 'live');
  const state = twoViewState();
  state.setActiveView('snap_1');
  const snapshotSelected = captureWith(state, 'snap_1');

  for (const [values, focus] of [[liveSelected, 0], [snapshotSelected, 1]]) {
    assert.deepEqual(values.activeField, { views: [LEIDEN, SAMPLE] });
    assert.deepEqual(values.filters, { views: [LIVE_FILTERS, []] });
    assert.equal(values.views.focus, focus);
    // Each view records the representation it shows.
    assert.deepEqual(
      values.views.views.map(view => view.embedding),
      [{ key: 'X_umap', columns: [0, 1, 2] }, { key: 'X_umap', columns: [0, 1, 2] }]
    );
  }
});

test('the selected kept view is captured from the state it is being edited in', () => {
  const state = twoViewState();
  state.setActiveView('snap_1');
  // An edit on the selected kept view lives in DataState until focus moves.
  state.obsData.fields[1]._categoryVisible = visibleOf([true, false]);
  const { filters } = captureWith(state, 'snap_1');
  assert.deepEqual(filters.views[1], [{ field: SAMPLE, hidden: ['y'] }]);
  assert.deepEqual(filters.views[0], LIVE_FILTERS);
});
