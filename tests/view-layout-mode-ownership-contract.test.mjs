/**
 * @fileoverview Selecting a view changes the focus, not the layout mode.
 *
 * `setActiveView` needs the viewer to focus a different view, and the viewer's
 * only entry point for that also takes a layout mode. It passed `'grid'`
 * unconditionally, which is an assertion about something it does not own.
 *
 * The restore path is where that shows: the multiview contributor sets the
 * saved layout mode and then activates the saved view, so a session saved in
 * `single` reached the viewer as a grid. It was corrected later, by a refresh
 * that pushes the mode from the control back down, which is why it was
 * survivable rather than visible - and why no test caught it. The round-trip
 * spec always saves in `grid`, because keeping a view forces that mode.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { viewContextCoreMethods } from
  '../assets/js/app/state/managers/view-context-core.js';

function viewContext(id) {
  return {
    id,
    obsData: null,
    varData: null,
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    activeFieldSource: null,
    dimensionLevel: 2,
    colorsArray: Uint8Array.from([1, 2, 3, 255]),
    categoryTransparency: Float32Array.from([1]),
    cellVisibilityMask: Float32Array.from([1]),
    outlierQuantilesArray: Float32Array.from([-1]),
    centroidPositions: new Float32Array(),
    centroidColors: new Uint8Array(),
    centroidOutliers: new Float32Array(),
    centroidLabels: [],
    filteredCount: { shown: 1, total: 1 }
  };
}

function makeState(initialMode) {
  const layoutCalls = [];
  const viewer = {
    getViewLayout: () => ({
      mode: viewer.mode,
      activeId: viewer.activeId,
      liveViewHidden: false
    }),
    setViewLayout(mode, activeId) {
      layoutCalls.push({ mode, activeId });
      viewer.mode = mode;
      viewer.activeId = activeId;
    },
    mode: initialMode,
    activeId: 'live'
  };

  const state = Object.assign(Object.create(viewContextCoreMethods), {
    activeViewId: 'live',
    pointCount: 1,
    cellVisibilityMask: Float32Array.from([1]),
    colorsArray: Uint8Array.from([1, 2, 3, 255]),
    categoryTransparency: Float32Array.from([1]),
    outlierQuantilesArray: Float32Array.from([-1]),
    centroidPositions: new Float32Array(),
    centroidColors: new Uint8Array(),
    centroidOutliers: new Float32Array(),
    centroidLabels: [],
    filteredCount: { shown: 1, total: 1 },
    activeDimensionLevel: 2,
    obsData: null,
    varData: null,
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    activeFieldSource: null,
    viewer,
    viewContexts: new Map([
      ['live', viewContext('live')],
      ['snap_1', viewContext('snap_1')]
    ]),
    clearActiveField() {},
    getAvailableDimensions: () => [2],
    getDimensionManager: () => ({
      getViewDimension: () => 2,
      setViewDimension() {}
    }),
    getFields: () => [],
    getVarFields: () => [],
    _cloneObsData: value => value,
    _cloneVarData: value => value,
    _notifyVisibilityChange() {},
    _notifyFieldChange() {},
    _applyOverlaysToFields() {},
    _pushCentroidsToViewer() {},
    _pushTransparencyToViewer() {},
    _pushColorsToViewer() {},
    _rebuildLabelLayerFromCentroids() {},
    getActiveField() {},
    _ensureActiveSelectionNotDeleted() {},
    _injectUserDefinedFields() {},
    computeGlobalVisibility() {},
    updateFilterSummary() {}
  });
  return { state, viewer, layoutCalls };
}

test('activating a view preserves a single-pane layout', () => {
  const { state, viewer, layoutCalls } = makeState('single');
  state.setActiveView('snap_1');

  assert.deepEqual(
    layoutCalls,
    [{ mode: 'single', activeId: 'snap_1' }],
    'the focus moves and the mode is left as the viewer had it'
  );
  assert.equal(
    viewer.mode,
    'single',
    'a session restored in single must not arrive at the viewer as a grid'
  );
});

test('activating a view preserves a grid layout', () => {
  const { state, viewer, layoutCalls } = makeState('grid');
  state.setActiveView('snap_1');

  assert.deepEqual(layoutCalls, [{ mode: 'grid', activeId: 'snap_1' }]);
  assert.equal(viewer.mode, 'grid');
});
