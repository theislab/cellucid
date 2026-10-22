import assert from 'node:assert/strict';
import test from 'node:test';

import { DataStateColorMethods } from '../assets/js/app/state/managers/color-manager.js';
import { viewContextCoreMethods } from '../assets/js/app/state/managers/view-context-core.js';
import { viewContextViewerSyncMethods } from '../assets/js/app/state/managers/view-context-viewer-sync.js';

const NORM_TRANSFORM = Object.freeze({ center: [5, 5, 0], scale: 0.1 });

// The one registered 2D layout: the embedding "X_umap", whose id keys the
// manifest's centroids for it.
const DIMENSION_MANAGER = Object.freeze({
  getLayout: () => ({ layoutKey: 'X_umap', dimension: 2 }),
  getNormTransform: () => NORM_TRANSFORM,
  getSlotLayout: dimension => (dimension === 2 ? 'X_umap' : null),
  hasLayout: layoutKey => layoutKey === 'X_umap',
});

function manifest() {
  return {
    fields: [{
      key: 'group',
      kind: 'category',
      categories: ['a', 'b'],
      // compact_v2 `centroidsByEmbedding`, keyed by embedding id.
      centroidsByEmbedding: {
        X_umap: [
          { category: 'a', position: [15, 15], n_points: 3 },
          { category: 'b', position: [-5, 5], n_points: 2 },
        ],
      },
    }],
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

test('a view kept before a field is first coloured does not renormalize its centroids', () => {
  const state = publishedScene(manifest());
  const liveField = state.obsData.fields[0];
  // "Keep view" before the field has ever been used for colouring: the
  // snapshot context is a clone of the live inventory.
  const snapshotField = viewContextCoreMethods._cloneObsData(state.obsData).fields[0];

  assertClose(buildFor('live', liveField), NORMALIZED);
  // Selecting the snapshot clones its context field again before colouring.
  assertClose(
    buildFor('snap_1', viewContextCoreMethods._cloneFieldState(snapshotField)),
    NORMALIZED,
  );
  // The live view rebuilding afterwards still sees the same geometry.
  assertClose(
    buildFor('live', viewContextCoreMethods._cloneFieldState(liveField)),
    NORMALIZED,
  );
});

test('scene publication normalizes its own centroid copy, not the dataset manifest', () => {
  const obs = manifest();
  const state = publishedScene(obs);
  assertClose(buildFor('live', state.obsData.fields[0]), NORMALIZED);
  assert.deepEqual(obs.fields[0].centroidsByEmbedding.X_umap[0].position, [15, 15]);

  // Publishing the same generation again starts from raw coordinates.
  const republished = publishedScene(obs);
  assertClose(buildFor('live', republished.obsData.fields[0]), NORMALIZED);
});

test('scene publication owns centroids by layout and drops embeddings no layout shows', () => {
  const obs = manifest();
  obs.fields[0].centroidsByEmbedding.X_unregistered = [
    { category: 'a', position: [0, 0], n_points: 3 },
  ];
  const state = publishedScene(obs);
  const field = state.obsData.fields[0];
  assert.equal(Object.hasOwn(field, 'centroidsByEmbedding'), false);
  assert.ok(field.centroidsByLayout instanceof Map);
  assert.deepEqual([...field.centroidsByLayout.keys()], ['X_umap']);
  assert.notStrictEqual(
    field.centroidsByLayout.get('X_umap'),
    obs.fields[0].centroidsByEmbedding.X_umap,
    'the published scene holds its own copy'
  );
});
