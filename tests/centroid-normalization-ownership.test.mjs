import assert from 'node:assert/strict';
import test from 'node:test';

import { DataStateColorMethods } from '../assets/js/app/state/managers/color-manager.js';
import { viewContextCoreMethods } from '../assets/js/app/state/managers/view-context-core.js';
import { viewContextViewerSyncMethods } from '../assets/js/app/state/managers/view-context-viewer-sync.js';

const NORM_TRANSFORM = Object.freeze({ center: [5, 5, 0], scale: 0.1 });

// Three cells of the one registered 2D layout "X_umap", in normalized
// coordinates: category a holds cells 0 and 1, category b cell 2.
const POSITIONS = Float32Array.from([1, 1, 1, 1, -1, 0]);
const DIMENSION_MANAGER = Object.freeze({
  getLayout: () => ({ layoutKey: 'X_umap', dimension: 2 }),
  getNormTransform: () => NORM_TRANSFORM,
  getSlotLayout: dimension => (dimension === 2 ? 'X_umap' : null),
  hasLayout: layoutKey => layoutKey === 'X_umap',
  getResidentPositions: () => POSITIONS,
});

function obsFieldList() {
  return {
    fields: [
      { key: 'group', kind: 'category', categories: ['a', 'b'] },
      { key: 'score', kind: 'continuous' },
    ],
  };
}

function publishedScene(obs) {
  const state = {
    _fieldDataCache: new Map(),
    _varFieldDataCache: new Map(),
    _renameRegistry: { clear() {} },
    _deleteRegistry: { clear() {} },
    _userDefinedFields: { clear() {} },
    _notifyHighlightPageChange() {},
    _resetViewContexts() {},
    // DataState's (`outlier-quantiles.js`): the replaced dataset's jobs stop.
    retireOutlierJobs() {},
    activeDimensionLevel: 2,
    clearCentroids() {},
    dimensionManager: DIMENSION_MANAGER,
    getViewLayoutKey: () => 'X_umap',
    viewer: {
      resetVectorFieldOverlay() {},
      setCentroidLabels() {},
      setCentroids() {},
      setData() {},
    },
  };
  viewContextViewerSyncMethods.initScene.call(state, new Float32Array(6), obs);
  return state;
}

function buildFor(viewId, field) {
  const viewState = {
    activeViewId: viewId,
    activeDimensionLevel: 2,
    pointCount: 3,
    labelLayer: null,
    dimensionManager: DIMENSION_MANAGER,
    ensureCategoryMetadata(target) {
      target._categoryColors = target.categories.map(() => [1, 0, 0]);
    },
    computeCategoryCountsForField: () => null,
    viewer: { setCentroidLabels() {} },
  };
  DataStateColorMethods.prototype.buildCentroidsForField.call(
    viewState,
    field,
    { viewId, layoutKey: 'X_umap' },
  );
  return Array.from(viewState.centroidPositions);
}

function assertClose(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(
      Math.abs(value - expected[index]) < 1e-6,
      `coordinate ${index}: ${value} !== ${expected[index]}`,
    );
  });
}

const NORMALIZED = [1, 1, 0, -1, 0, 0];

function loaded(field) {
  field.codes = Uint8Array.from([0, 0, 1]);
  field.loaded = true;
  return field;
}

test('scene publication gives each categorical field one centroid cache, computed in the browser', () => {
  const obs = obsFieldList();
  const state = publishedScene(obs);
  const [group, score] = state.obsData.fields;
  assert.ok(group.centroidsByLayout instanceof Map);
  assert.equal(group.centroidsByLayout.size, 0, 'no centroid is listed by the field list');
  assert.equal(Object.hasOwn(score, 'centroidsByLayout'), false);
  assertClose(buildFor('live', loaded(group)), NORMALIZED);
  assert.deepEqual([...group.centroidsByLayout.keys()], ['X_umap']);
  assert.equal(Object.hasOwn(obs.fields[0], 'centroidsByLayout'), false, 'the field list is not written to');
});

test('a view kept before a field is first coloured shares its centroids, computed once', () => {
  const state = publishedScene(obsFieldList());
  const liveField = loaded(state.obsData.fields[0]);
  // "Keep view" before the field has ever been used for colouring: the
  // snapshot context is a clone of the live inventory.
  const snapshotField = viewContextCoreMethods._cloneObsData(state.obsData).fields[0];

  assertClose(buildFor('live', liveField), NORMALIZED);
  const computed = liveField.centroidsByLayout.get('X_umap');
  // Selecting the snapshot clones its context field again before colouring.
  assertClose(
    buildFor('snap_1', viewContextCoreMethods._cloneFieldState(snapshotField)),
    NORMALIZED,
  );
  assert.strictEqual(snapshotField.centroidsByLayout.get('X_umap'), computed);
  // The live view rebuilding afterwards still sees the same geometry.
  assertClose(
    buildFor('live', viewContextCoreMethods._cloneFieldState(liveField)),
    NORMALIZED,
  );
});
