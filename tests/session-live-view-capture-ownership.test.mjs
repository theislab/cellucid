import assert from 'node:assert/strict';
import test from 'node:test';

import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createInMemoryDimensionManager } from '../assets/js/data/dimension-manager.js';
import {
  capture as captureCoreState
} from '../assets/js/app/session/contributors/core-state.js';

function cameraState() {
  return {
    navigationMode: 'orbit',
    orbit: { radius: 3, targetRadius: 3, theta: 0.5, phi: 1, target: [0, 0, 0] },
    freefly: { position: [1, 2, 3], yaw: 0.25, pitch: -0.1 }
  };
}

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
  state.obsData = {
    fields: [
      { key: 'leiden', kind: 'category', categories: ['a', 'b'], codes: new Uint16Array([0, 1]), loaded: true },
      { key: 'sample', kind: 'category', categories: ['x', 'y'], codes: new Uint16Array([0, 1]), loaded: true }
    ]
  };
  state.varData = { fields: [] };
  // One 3D representation, shown by every view.
  const dimensionManager = createInMemoryDimensionManager({
    positions: new Float32Array(6),
    dimension: 3
  });
  state.setDimensionManager(dimensionManager);
  state.publishDatasetMapping({
    mapping: {
      kind: 'export',
      embeddings: {
        enabled: [{ key: '3d', columns: null }],
        defaults: { '1d': null, '2d': null, '3d': { key: '3d', columns: null } }
      },
      geneNames: 'index',
      vectorFields: []
    },
    candidates: null,
    origin: 'default'
  });
  // Live view: coloured by leiden with category "a" hidden.
  state.activeFieldIndex = 0;
  state.activeFieldSource = 'obs';
  state.obsData.fields[0]._categoryVisible = { 0: false, 1: true };
  state._resetViewContexts();
  // Kept view: coloured by sample, no filters.
  state.createViewFromSource('live', 'snap_1');
  dimensionManager.copyViewLayout('live', 'snap_1');
  const snapshot = state.viewContexts.get('snap_1');
  snapshot.activeFieldIndex = 1;
  delete snapshot.obsData.fields[0]._categoryVisible;
  return state;
}

function captureWith(state, activeId) {
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  try {
    const [chunk] = captureCoreState({
      state,
      viewer: {
        getCamerasLocked: () => true,
        getCameraState: () => cameraState(),
        getViewLayout: () => ({ mode: 'grid', activeId, liveViewHidden: false }),
        getSnapshotViews: () => [{
          id: 'snap_1',
          label: 'sample',
          fieldKey: 'sample',
          fieldKind: 'category',
          meta: { filtersText: [] }
        }],
        getViewCameraState: () => cameraState()
      },
      sidebar: { querySelectorAll: () => [] }
    });
    return chunk.payload;
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

const LIVE_FIELD_STATE = {
  activeFields: { activeFieldKey: 'leiden', activeFieldSource: 'obs' },
  filters: {
    'obs:leiden': {
      kind: 'category',
      filterEnabled: null,
      visibility: [{ categoryName: 'a', visible: false }],
      colors: [],
      colormapId: null,
      outlierFilterEnabled: null,
      outlierThreshold: null
    }
  }
};

test('saving while a kept view is selected records the live view as the live view', () => {
  const liveSelected = captureWith(twoViewState(), 'live');
  const state = twoViewState();
  state.setActiveView('snap_1');
  const snapshotSelected = captureWith(state, 'snap_1');

  for (const payload of [liveSelected, snapshotSelected]) {
    assert.deepEqual(
      { activeFields: payload.activeFields, filters: payload.filters },
      LIVE_FIELD_STATE
    );
    assert.deepEqual(payload.multiview.snapshots[0].activeFields, {
      activeFieldKey: 'sample',
      activeFieldSource: 'obs'
    });
    assert.deepEqual(payload.multiview.snapshots[0].filters, {});
    // Each view records the representation it shows.
    assert.deepEqual(payload.liveEmbedding, { key: '3d', columns: null });
    assert.deepEqual(payload.multiview.snapshots[0].embedding, { key: '3d', columns: null });
  }
});

test('the selected kept view is captured from the state it is being edited in', () => {
  const state = twoViewState();
  state.setActiveView('snap_1');
  // An edit on the selected kept view lives in DataState until focus moves.
  state.obsData.fields[1]._categoryVisible = { 0: true, 1: false };
  const payload = captureWith(state, 'snap_1');
  assert.deepEqual(payload.multiview.snapshots[0].filters, {
    'obs:sample': {
      kind: 'category',
      filterEnabled: null,
      visibility: [{ categoryName: 'y', visible: false }],
      colors: [],
      colormapId: null,
      outlierFilterEnabled: null,
      outlierThreshold: null
    }
  });
  assert.deepEqual(payload.filters, LIVE_FIELD_STATE.filters);
});
