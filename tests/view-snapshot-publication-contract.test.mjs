import assert from 'node:assert/strict';
import test from 'node:test';

import { viewContextCoreMethods } from
  '../assets/js/app/state/managers/view-context-core.js';
import { writableColors } from
  '../assets/js/app/state/managers/per-cell-array-ownership.js';
import {
  clearPublishedSnapshotViews,
  publishSnapshotView,
  retireSnapshotView,
} from '../assets/js/app/view-snapshot-publication.js';
import {
  restoreMultiview,
} from '../assets/js/app/state-serializer/multiview.js';

// Layouts are embedding ids, every one enabled. Each dimension's default is
// the embedding the identity's `defaults` names; X_tsne is a second 2D
// embedding a view shows when it is chosen for it.
const DEFAULT_LAYOUTS = Object.freeze({ 2: 'X_umap', 3: 'X_umap_3d' });
const LAYOUT_DIMENSIONS = Object.freeze({ X_tsne: 2, X_umap: 2, X_umap_3d: 3 });
const TSNE = Object.freeze({ key: 'X_tsne', columns: null });
const UMAP = Object.freeze({ key: 'X_umap', columns: null });
const UMAP_3D = Object.freeze({ key: 'X_umap_3d', columns: null });

function createOwners() {
  const dimensionManager = {
    dimensions: new Map([['live', 2]]),
    layouts: new Map([['live', 'X_umap']]),
    copyViewLayout(sourceViewId, targetViewId) {
      if (!this.dimensions.has(sourceViewId)) {
        throw new RangeError(`Unknown dimension source "${sourceViewId}".`);
      }
      this.dimensions.set(
        targetViewId,
        this.dimensions.get(sourceViewId)
      );
      this.layouts.set(targetViewId, this.layouts.get(sourceViewId));
    },
    getViewDimension(viewId) {
      if (!this.dimensions.has(viewId)) {
        throw new RangeError(`Unknown view dimension "${viewId}".`);
      }
      return this.dimensions.get(viewId);
    },
    getViewLayout(viewId) {
      this.getViewDimension(viewId);
      return this.layouts.get(viewId);
    },
    removeView(viewId) {
      this.dimensions.delete(viewId);
      this.layouts.delete(viewId);
    },
  };
  const state = Object.assign(
    Object.create(viewContextCoreMethods),
    {
      activeViewId: 'live',
      dimensionManager,
      pointCount: 2,
      viewContexts: new Map([[
        'live',
        {
          id: 'live',
          obsData: null,
          varData: null,
          activeFieldIndex: -1,
          activeVarFieldIndex: -1,
          activeFieldSource: null,
          followsDefault: true,
          colorsArray: Uint8Array.from([
            1, 2, 3, 255,
            4, 5, 6, 255,
          ]),
          categoryTransparency: Uint8Array.from([1, 1]),
          cellVisibilityMask: Uint8Array.from([1, 1]),
          centroidPositions: new Float32Array(),
          centroidColors: new Uint8Array(),
          centroidOutliers: new Float32Array(),
          centroidLabels: [],
          filteredCount: { shown: 2, total: 2 },
        },
      ]]),
      getDimensionManager() {
        return this.dimensionManager;
      },
      getViewDimensionLevel(viewId) {
        if (!this.dimensionManager.dimensions.has(viewId)) {
          throw new RangeError(`Unknown view dimension "${viewId}".`);
        }
        return this.dimensionManager.dimensions.get(viewId);
      },
      getViewLayoutKey(viewId) {
        return this.dimensionManager.getViewLayout(viewId);
      },
      setActiveView(viewId) {
        if (!this.viewContexts.has(viewId)) {
          throw new RangeError(`Unknown state view "${viewId}".`);
        }
        this.activeViewId = viewId;
        return viewId;
      },
    },
  );

  let nextId = 1;
  const snapshots = [];
  const viewerDimensions = new Map([['live', 2]]);
  const viewerLayouts = new Map([['live', 'X_umap']]);
  const viewer = {
    clearSnapshotViews() {
      snapshots.splice(0);
      for (const viewId of [...viewerDimensions.keys()]) {
        if (viewId !== 'live') {
          viewerDimensions.delete(viewId);
          viewerLayouts.delete(viewId);
        }
      }
    },
    createSnapshotView(config) {
      const id = `snap_${nextId}`;
      nextId += 1;
      snapshots.push({ id, label: config.label });
      viewerDimensions.set(id, config.dimensionLevel);
      // A kept view starts on its source view's layout.
      viewerLayouts.set(id, viewerLayouts.get(config.sourceViewId));
      return { id, label: config.label };
    },
    getSnapshotViews() {
      return snapshots.map(snapshot => ({ ...snapshot }));
    },
    getViewDimension(viewId) {
      if (!viewerDimensions.has(viewId)) {
        throw new RangeError(`Unknown viewer dimension "${viewId}".`);
      }
      return viewerDimensions.get(viewId);
    },
    getViewLayoutKey(viewId) {
      this.getViewDimension(viewId);
      return viewerLayouts.get(viewId);
    },
    removeSnapshotView(viewId) {
      const index = snapshots.findIndex(snapshot => snapshot.id === viewId);
      if (index < 0) {
        throw new RangeError(`Unknown viewer snapshot "${viewId}".`);
      }
      snapshots.splice(index, 1);
      viewerDimensions.delete(viewId);
      viewerLayouts.delete(viewId);
    },
    setViewEmbedding(viewId, { dimension, layoutKey }) {
      if (!viewerDimensions.has(viewId)) {
        throw new RangeError(`Unknown viewer dimension "${viewId}".`);
      }
      viewerDimensions.set(viewId, dimension);
      viewerLayouts.set(viewId, layoutKey);
    },
  };
  return { dimensionManager, snapshots, state, viewer };
}

function createConfig(overrides = {}) {
  return {
    cameraState: { navigationMode: 'orbit' },
    centroidColors: Uint8Array.from([10, 20, 30, 255]),
    centroidPositions: Float32Array.from([0.25, -0.5, 0]),
    colors: Uint8Array.from([
      10, 11, 12, 255,
      20, 21, 22, 255,
    ]),
    dimensionLevel: 2,
    fieldKey: null,
    fieldKind: null,
    label: 'Exact snapshot',
    meta: { filtersText: [] },
    sourceViewId: 'live',
    transparency: Uint8Array.from([0, 1]),
    ...overrides,
  };
}

function cameraState(radius = 3) {
  return {
    navigationMode: 'orbit',
    orbit: {
      radius,
      targetRadius: radius,
      theta: 0.25,
      phi: 1,
      target: [0, 0, 0],
    },
    freefly: {
      position: [0, 0, radius],
      yaw: 0,
      pitch: 0,
    },
  };
}

function createRestoreOwners() {
  const owners = createOwners();
  const { state, viewer } = owners;
  const publishedConfigs = [];
  const embeddingSwitches = [];
  let camerasLocked = false;
  let activeCamera = cameraState();
  const viewCameras = new Map([['live', cameraState()]]);
  let layout = {
    mode: 'single',
    activeId: 'live',
    liveViewHidden: false,
  };
  const clearSnapshotViews = viewer.clearSnapshotViews;
  const createSnapshotView = viewer.createSnapshotView;
  const removeSnapshotView = viewer.removeSnapshotView;
  viewer.clearSnapshotViews = () => {
    clearSnapshotViews();
    for (const viewId of [...viewCameras.keys()]) {
      if (viewId !== 'live') viewCameras.delete(viewId);
    }
  };
  viewer.createSnapshotView = config => {
    publishedConfigs.push(config);
    const created = createSnapshotView(config);
    viewCameras.set(created.id, structuredClone(config.cameraState));
    return created;
  };
  viewer.removeSnapshotView = viewId => {
    removeSnapshotView(viewId);
    viewCameras.delete(viewId);
  };
  Object.assign(viewer, {
    getCamerasLocked() {
      return camerasLocked;
    },
    getViewCameraState(viewId) {
      const camera = viewCameras.get(viewId);
      if (camera === undefined) {
        throw new RangeError(`Unknown view camera "${viewId}".`);
      }
      return structuredClone(camera);
    },
    setCameraState(camera) {
      activeCamera = structuredClone(camera);
    },
    setCamerasLocked(value) {
      camerasLocked = value;
    },
    setLiveViewHidden(value) {
      layout.liveViewHidden = value;
    },
    setViewCameraState(viewId, camera) {
      viewCameras.set(viewId, structuredClone(camera));
    },
    setViewLayout(mode, activeId) {
      layout = { ...layout, mode, activeId };
    },
  });

  const colors = Uint8Array.from([
    21, 22, 23, 255,
    31, 32, 33, 255,
  ]);
  const transparency = Uint8Array.from([0, 1]);
  const centroids = Float32Array.from([0.5, -0.25, 0]);
  const centroidColors = Uint8Array.from([50, 60, 70, 255]);
  Object.assign(state, {
    captureCurrentContext() {
      return viewContextCoreMethods._cloneViewContext.call(
        this,
        this.viewContexts.get('live'),
        'live',
        { cloneArrays: true },
      );
    },
    clearActiveField() {},
    getActiveViewId() {
      return this.activeViewId;
    },
    getFields() {
      return [];
    },
    getSnapshotPayload() {
      return {
        centroidColors,
        centroidPositions: centroids,
        colors,
        dimensionLevel:
          this.dimensionManager.getViewDimension('live'),
        fieldKey: null,
        fieldKind: null,
        filtersText: [],
        label: 'All cells',
        transparency,
      };
    },
    getVarFields() {
      return [];
    },
    restoreContext(context) {
      const restored = viewContextCoreMethods._cloneViewContext.call(
        this,
        context,
        'live',
        { cloneArrays: true },
      );
      this.viewContexts.set('live', restored);
      this.activeViewId = 'live';
    },
    getViewEmbeddingRef(viewId) {
      return { key: this.dimensionManager.getViewLayout(viewId), columns: null };
    },
    viewFollowsDefault(viewId) {
      const context = this.viewContexts.get(viewId);
      if (context === undefined) {
        throw new RangeError(`Unknown state view "${viewId}".`);
      }
      return context.followsDefault === true;
    },
    // The session schema names what a view shows by its embedding reference;
    // this resolves it to the layout (an export embedding id) and follows the
    // dimension's default when it is that default.
    async restoreViewEmbedding(viewId, ref) {
      const layoutKey = ref.key;
      if (!Object.hasOwn(LAYOUT_DIMENSIONS, layoutKey)) {
        throw new RangeError(`This dataset has no embedding "${layoutKey}".`);
      }
      const dimension = LAYOUT_DIMENSIONS[layoutKey];
      await this.setViewRepresentation(viewId, layoutKey, {
        followsDefault: DEFAULT_LAYOUTS[dimension] === layoutKey,
      });
      return layoutKey;
    },
    // The one representation transaction: a layout, whose dimension is its own.
    async setViewRepresentation(viewId, layoutKey, { followsDefault }) {
      assert.equal(viewId, 'live');
      const dimension = LAYOUT_DIMENSIONS[layoutKey];
      if (dimension === undefined) {
        throw new RangeError(`Layout "${layoutKey}" is not registered.`);
      }
      embeddingSwitches.push({ layoutKey, followsDefault });
      this.viewContexts.get('live').followsDefault = followsDefault;
      this.dimensionManager.dimensions.set('live', dimension);
      this.dimensionManager.layouts.set('live', layoutKey);
      viewer.setViewEmbedding('live', { dimension, layoutKey });
      viewer.setViewCameraState('live', cameraState(10 + dimension));
    },
  });

  return {
    ...owners,
    embeddingSwitches,
    activeCamera: () => structuredClone(activeCamera),
    layout: () => ({ ...layout }),
    publishedConfigs,
    viewCamera: viewId =>
      structuredClone(viewCameras.get(viewId)),
  };
}

function multiviewSnapshot(overrides = {}) {
  const snapshot = {
    activeFields: {
      activeFieldKey: null,
      activeFieldSource: null,
    },
    cameraState: cameraState(),
    embedding: UMAP,
    fieldKey: null,
    fieldKind: null,
    filters: {},
    id: 'snap_9',
    label: 'All cells',
    meta: { filtersText: [] },
    ...overrides,
  };
  return {
    camerasLocked: false,
    layout: {
      activeId: snapshot.id,
      liveViewHidden: false,
      mode: 'grid',
    },
    liveCameraState: cameraState(),
    snapshots: [snapshot],
  };
}

test('snapshot publication installs exact renderer attributes in every owner', () => {
  const { dimensionManager, state, viewer } = createOwners();
  const config = createConfig();
  const created = publishSnapshotView({ state, viewer, config });
  const context = state.viewContexts.get(created.id);

  assert.deepEqual(viewer.getSnapshotViews(), [{
    id: created.id,
    label: config.label,
  }]);
  assert.equal(dimensionManager.dimensions.get(created.id), 2);
  // The kept view adopts the published point arrays instead of copying them:
  // colors are the array the viewer keeps, transparency is the source view's.
  assert.strictEqual(context.colorsArray, config.colors);
  assert.strictEqual(context.categoryTransparency, config.transparency);
  assert.deepEqual(
    Array.from(context.cellVisibilityMask),
    [1, 1],
    'combined transparency must not replace the independent filter mask',
  );
  assert.deepEqual(context.filteredCount, { shown: 1, total: 2 });
  assert.deepEqual(
    Array.from(context.centroidPositions),
    Array.from(config.centroidPositions),
  );
  assert.deepEqual(Array.from(context.centroidOutliers), [-1]);
  assert.deepEqual(context.centroidLabels, []);

  // Centroids are written in place, so they are the context's own copy.
  config.centroidPositions.fill(99);
  assert.deepEqual(Array.from(context.centroidPositions), [0.25, -0.5, 0]);

  // A snapshot's colors are frozen once published: the state writes a recolor
  // of that view into a new array, and the published one never changes.
  state.activeViewId = created.id;
  state.colorsArray = context.colorsArray;
  const writable = writableColors(state);
  assert.notStrictEqual(writable, config.colors);
  assert.deepEqual(Array.from(writable), Array.from(config.colors));
  writable.fill(99);
  assert.deepEqual(Array.from(config.colors), [
    10, 11, 12, 255,
    20, 21, 22, 255,
  ]);
  state.activeViewId = 'live';

  assert.deepEqual(
    retireSnapshotView({
      state,
      viewer,
      snapshotId: created.id,
    }),
    [],
  );
  assert.equal(state.viewContexts.has(created.id), false);
  assert.equal(dimensionManager.dimensions.has(created.id), false);
});

test('snapshot publication rolls back renderer, state, and dimension owners', () => {
  const { dimensionManager, snapshots, state, viewer } = createOwners();
  const failure = new Error('synthetic state attribute publication failure');
  state.applySnapshotConfigToView = () => {
    throw failure;
  };

  assert.throws(
    () => publishSnapshotView({
      state,
      viewer,
      config: createConfig(),
    }),
    error => error === failure,
  );
  assert.deepEqual(snapshots, []);
  assert.deepEqual([...state.viewContexts.keys()], ['live']);
  assert.deepEqual([...dimensionManager.dimensions.keys()], ['live']);
});

test('snapshot publication rejects a silent dimension-owner no-op', () => {
  const { dimensionManager, snapshots, state, viewer } = createOwners();
  dimensionManager.copyViewLayout = () => {};

  assert.throws(
    () => publishSnapshotView({
      state,
      viewer,
      config: createConfig(),
    }),
    /dimension/i,
  );
  assert.deepEqual(snapshots, []);
  assert.deepEqual([...state.viewContexts.keys()], ['live']);
  assert.deepEqual([...dimensionManager.dimensions.keys()], ['live']);
});

test('a kept view adopts its source layout, and owners that disagree on it roll back', () => {
  const { dimensionManager, snapshots, state, viewer } = createOwners();
  // The live view shows the second 2D embedding in every owner.
  dimensionManager.layouts.set('live', 'X_tsne');
  viewer.setViewEmbedding('live', { dimension: 2, layoutKey: 'X_tsne' });
  const created = publishSnapshotView({
    state,
    viewer,
    config: createConfig(),
  });
  assert.equal(dimensionManager.getViewLayout(created.id), 'X_tsne');
  assert.equal(viewer.getViewLayoutKey(created.id), 'X_tsne');

  // Same dimension, different layout: a dimension check alone would pass.
  viewer.setViewEmbedding('live', { dimension: 2, layoutKey: 'X_umap' });
  assert.throws(
    () => publishSnapshotView({
      state,
      viewer,
      config: createConfig({ label: 'Disagreeing' }),
    }),
    /disagree on the layout of snapshot/,
  );
  assert.deepEqual(snapshots.map(snapshot => snapshot.id), [created.id]);
  assert.deepEqual([...state.viewContexts.keys()], ['live', created.id]);
  assert.deepEqual([...dimensionManager.dimensions.keys()], ['live', created.id]);
});

test('partial viewer clearing reconciles only identities actually retired', () => {
  const { dimensionManager, snapshots, state, viewer } = createOwners();
  const first = publishSnapshotView({
    state,
    viewer,
    config: createConfig({ label: 'First' }),
  });
  const second = publishSnapshotView({
    state,
    viewer,
    config: createConfig({ label: 'Second' }),
  });
  const failure = new Error('synthetic partial viewer clear failure');
  viewer.clearSnapshotViews = () => {
    snapshots.splice(0, 1);
    throw failure;
  };

  assert.throws(
    () => clearPublishedSnapshotViews({ state, viewer }),
    error => error === failure,
  );
  assert.equal(state.viewContexts.has(first.id), false);
  assert.equal(dimensionManager.dimensions.has(first.id), false);
  assert.equal(state.viewContexts.has(second.id), true);
  assert.equal(dimensionManager.dimensions.has(second.id), true);
  assert.deepEqual(viewer.getSnapshotViews(), [{
    id: second.id,
    label: 'Second',
  }]);
});

test('throwing viewer retirement still reconciles an identity already detached', () => {
  const { dimensionManager, snapshots, state, viewer } = createOwners();
  const created = publishSnapshotView({
    state,
    viewer,
    config: createConfig(),
  });
  const failure = new Error('synthetic post-detachment retirement failure');
  viewer.removeSnapshotView = viewId => {
    const index = snapshots.findIndex(snapshot => snapshot.id === viewId);
    assert.notEqual(index, -1);
    snapshots.splice(index, 1);
    throw failure;
  };

  assert.throws(
    () => retireSnapshotView({
      state,
      viewer,
      snapshotId: created.id,
    }),
    error => error === failure,
  );
  assert.deepEqual(snapshots, []);
  assert.equal(state.viewContexts.has(created.id), false);
  assert.equal(dimensionManager.dimensions.has(created.id), false);
});

for (const failureMode of ['before detach', 'after detach']) {
  test(`dimension-owner ${failureMode} failure cannot block context retirement`, () => {
    const { dimensionManager, state, viewer } = createOwners();
    const created = publishSnapshotView({
      state,
      viewer,
      config: createConfig(),
    });
    const failure = new Error(
      `synthetic dimension ${failureMode} failure`
    );
    const removeDimension =
      dimensionManager.removeView.bind(dimensionManager);
    let rejected = false;
    dimensionManager.removeView = viewId => {
      if (!rejected) {
        rejected = true;
        if (failureMode === 'after detach') {
          removeDimension(viewId);
        }
        throw failure;
      }
      removeDimension(viewId);
    };

    assert.throws(
      () => retireSnapshotView({
        state,
        viewer,
        snapshotId: created.id,
      }),
      error => (
        error instanceof AggregateError &&
        error.errors.includes(failure)
      ),
    );
    assert.deepEqual(viewer.getSnapshotViews(), []);
    assert.equal(state.viewContexts.has(created.id), false);
    assert.equal(dimensionManager.dimensions.has(created.id), false);
  });
}

test('unknown post-clear inventory preserves state owners and both failures', () => {
  const { dimensionManager, state, viewer } = createOwners();
  const first = publishSnapshotView({
    state,
    viewer,
    config: createConfig({ label: 'First' }),
  });
  const second = publishSnapshotView({
    state,
    viewer,
    config: createConfig({ label: 'Second' }),
  });
  const clearingFailure = new Error('synthetic viewer clear failure');
  const inventoryFailure = new Error('synthetic post-clear inventory failure');
  let inventoryReads = 0;
  const getSnapshotViews = viewer.getSnapshotViews;
  viewer.clearSnapshotViews = () => {
    throw clearingFailure;
  };
  viewer.getSnapshotViews = () => {
    inventoryReads++;
    if (inventoryReads === 1) return getSnapshotViews();
    throw inventoryFailure;
  };

  assert.throws(
    () => clearPublishedSnapshotViews({ state, viewer }),
    error => (
      error instanceof AggregateError &&
      error.errors[0] === clearingFailure &&
      error.errors[1] === inventoryFailure
    ),
  );
  assert.equal(state.viewContexts.has(first.id), true);
  assert.equal(state.viewContexts.has(second.id), true);
  assert.equal(dimensionManager.dimensions.has(first.id), true);
  assert.equal(dimensionManager.dimensions.has(second.id), true);
});

test('complete snapshot clearing retires contexts and dimension mappings', () => {
  const { dimensionManager, state, viewer } = createOwners();
  publishSnapshotView({
    state,
    viewer,
    config: createConfig({ label: 'First' }),
  });
  publishSnapshotView({
    state,
    viewer,
    config: createConfig({ label: 'Second' }),
  });

  assert.deepEqual(
    clearPublishedSnapshotViews({ state, viewer }),
    [],
  );
  assert.deepEqual([...state.viewContexts.keys()], ['live']);
  assert.deepEqual([...dimensionManager.dimensions.keys()], ['live']);
});

test('multiview same-dimension restore publishes every exact snapshot owner', async () => {
  const {
    dimensionManager,
    publishedConfigs,
    state,
    viewer,
  } = createRestoreOwners();
  const saved = multiviewSnapshot();

  await restoreMultiview({
    state,
    viewer,
    async restoreActiveFields() {},
    async restoreFilters() {},
    pushViewerState() {},
  }, saved);

  assert.deepEqual(viewer.getSnapshotViews(), [{
    id: 'snap_1',
    label: 'All cells',
  }]);
  assert.equal(dimensionManager.getViewDimension('snap_1'), 2);
  assert.equal(dimensionManager.getViewLayout('snap_1'), 'X_umap');
  assert.equal(viewer.getViewLayoutKey('snap_1'), 'X_umap');
  assert.equal(state.getViewDimensionLevel('snap_1'), 2);
  assert.equal(state.activeViewId, 'snap_1');
  assert.equal(publishedConfigs.length, 1);
  assert.equal(publishedConfigs[0].dimensionLevel, 2);
  assert.deepEqual(
    Array.from(state.viewContexts.get('snap_1').colorsArray),
    [21, 22, 23, 255, 31, 32, 33, 255],
  );
  assert.deepEqual(
    Array.from(state.viewContexts.get('snap_1').categoryTransparency),
    [0, 1],
  );
});

test('multiview restore rolls back the whole graph after a later publication fails', async () => {
  const {
    dimensionManager,
    snapshots,
    state,
    viewer,
  } = createRestoreOwners();
  const saved = multiviewSnapshot();
  saved.snapshots.push({
    ...saved.snapshots[0],
    activeFields: { ...saved.snapshots[0].activeFields },
    cameraState: cameraState(8),
    filters: {},
    id: 'snap_10',
    meta: { filtersText: [] },
  });
  saved.layout.activeId = 'snap_10';

  const publicationFailure =
    new Error('second restored snapshot publication failed');
  const applySnapshotConfigToView =
    state.applySnapshotConfigToView;
  state.applySnapshotConfigToView = function(viewId, config) {
    applySnapshotConfigToView.call(this, viewId, config);
    if (viewId === 'snap_2') throw publicationFailure;
  };

  await assert.rejects(
    restoreMultiview({
      state,
      viewer,
      async restoreActiveFields() {},
      async restoreFilters() {},
      pushViewerState() {},
    }, saved),
    error => error === publicationFailure,
  );
  assert.deepEqual(snapshots, []);
  assert.deepEqual([...state.viewContexts.keys()], ['live']);
  assert.deepEqual([...dimensionManager.dimensions.keys()], ['live']);
  assert.equal(state.activeViewId, 'live');
  assert.equal(dimensionManager.getViewDimension('live'), 2);
  assert.equal(viewer.getViewDimension('live'), 2);
  assert.deepEqual(
    viewer.getViewCameraState('live'),
    saved.liveCameraState,
  );
});

test('multiview restore replays every snapshot on its own embedding and returns the live view to its own', async () => {
  const {
    dimensionManager,
    embeddingSwitches,
    publishedConfigs,
    state,
    viewer,
  } = createRestoreOwners();
  // The live view itself shows the second 2D embedding, chosen for it, when
  // restore begins.
  await state.setViewRepresentation('live', 'X_tsne', { followsDefault: false });
  embeddingSwitches.length = 0;

  const saved = multiviewSnapshot({ embedding: TSNE });
  saved.snapshots.push(
    {
      ...saved.snapshots[0],
      activeFields: { ...saved.snapshots[0].activeFields },
      embedding: UMAP,
      id: 'snap_10',
      meta: { filtersText: [] },
    },
    {
      ...saved.snapshots[0],
      activeFields: { ...saved.snapshots[0].activeFields },
      embedding: UMAP_3D,
      id: 'snap_11',
      meta: { filtersText: [] },
    },
  );

  await restoreMultiview({
    state,
    viewer,
    async restoreActiveFields() {},
    async restoreFilters() {},
    pushViewerState() {},
  }, saved);

  // Each kept view shows the layout its record names, in every owner, and
  // follows its dimension's default exactly when it shows that default.
  assert.deepEqual(
    ['snap_1', 'snap_2', 'snap_3'].map(viewId => [
      dimensionManager.getViewLayout(viewId),
      viewer.getViewLayoutKey(viewId),
      state.viewContexts.get(viewId).followsDefault,
    ]),
    [
      ['X_tsne', 'X_tsne', false],
      ['X_umap', 'X_umap', true],
      ['X_umap_3d', 'X_umap_3d', true],
    ],
  );
  assert.deepEqual(
    publishedConfigs.map(config => config.dimensionLevel),
    [2, 2, 3],
  );
  // The live view returns to the embedding chosen for it, not to the 2D
  // default.
  assert.equal(dimensionManager.getViewLayout('live'), 'X_tsne');
  assert.equal(viewer.getViewLayoutKey('live'), 'X_tsne');
  assert.equal(state.viewContexts.get('live').followsDefault, false);
  // Every switch went through the one representation transaction.
  assert.deepEqual(
    embeddingSwitches.map(entry => entry.layoutKey),
    [
      'X_tsne', 'X_tsne',
      'X_tsne', 'X_umap',
      'X_tsne', 'X_umap_3d',
      'X_tsne',
    ],
  );
});

test('a snapshot naming an embedding this dataset does not have rolls back', async () => {
  const {
    dimensionManager,
    snapshots,
    state,
    viewer,
  } = createRestoreOwners();
  const saved = multiviewSnapshot({
    embedding: { key: 'X_phate', columns: null },
  });

  await assert.rejects(
    restoreMultiview({
      state,
      viewer,
      async restoreActiveFields() {},
      async restoreFilters() {},
      pushViewerState() {},
    }, saved),
    /no embedding "X_phate"/,
  );
  assert.deepEqual(snapshots, []);
  assert.deepEqual([...state.viewContexts.keys()], ['live']);
  assert.equal(dimensionManager.getViewLayout('live'), 'X_umap');
  assert.equal(viewer.getViewLayoutKey('live'), 'X_umap');
  assert.equal(state.viewContexts.get('live').followsDefault, true);
});

test('a replay whose owner silently shows another embedding is refused and rolled back', async () => {
  const {
    dimensionManager,
    snapshots,
    state,
    viewer,
  } = createRestoreOwners();
  // An owner that shows the dimension's default whatever embedding it is
  // given: the dimension is right, the geometry is not.
  const restoreViewEmbedding = state.restoreViewEmbedding;
  state.restoreViewEmbedding = function(viewId, ref) {
    return restoreViewEmbedding.call(this, viewId, {
      key: DEFAULT_LAYOUTS[LAYOUT_DIMENSIONS[ref.key]],
      columns: null,
    });
  };

  await assert.rejects(
    restoreMultiview({
      state,
      viewer,
      async restoreActiveFields() {},
      async restoreFilters() {},
      pushViewerState() {},
    }, multiviewSnapshot({ embedding: TSNE })),
    /Replayed snapshot "snap_9" did not restore its exact embedding/,
  );
  assert.deepEqual(snapshots, []);
  assert.deepEqual([...state.viewContexts.keys()], ['live']);
  assert.equal(dimensionManager.getViewLayout('live'), 'X_umap');
});

test('mixed-dimension restore reapplies distinct unlocked live and snapshot cameras', async () => {
  const {
    activeCamera,
    dimensionManager,
    state,
    viewCamera,
    viewer,
  } = createRestoreOwners();
  const saved = multiviewSnapshot({
    cameraState: cameraState(7),
    embedding: UMAP_3D,
  });
  saved.liveCameraState = cameraState(4);

  await restoreMultiview({
    state,
    viewer,
    async restoreActiveFields() {},
    async restoreFilters() {},
    pushViewerState() {},
  }, saved);

  assert.equal(dimensionManager.getViewDimension('live'), 2);
  assert.equal(dimensionManager.getViewDimension('snap_1'), 3);
  assert.deepEqual(viewCamera('live'), cameraState(4));
  assert.deepEqual(viewCamera('snap_1'), cameraState(7));
  assert.deepEqual(activeCamera(), cameraState(7));
});

test('final multiview failure rolls back every snapshot and returns the live camera it found', async () => {
  const {
    dimensionManager,
    snapshots,
    state,
    viewer,
  } = createRestoreOwners();
  const saved = multiviewSnapshot({
    cameraState: cameraState(7),
    embedding: UMAP_3D,
  });
  saved.liveCameraState = cameraState(4);
  const layoutFailure =
    new Error('synthetic final live-view visibility failure');
  viewer.setLiveViewHidden = () => {
    throw layoutFailure;
  };

  await assert.rejects(
    restoreMultiview({
      state,
      viewer,
      async restoreActiveFields() {},
      async restoreFilters() {},
      pushViewerState() {},
    }, saved),
    error => error === layoutFailure,
  );

  assert.deepEqual(snapshots, []);
  assert.deepEqual([...state.viewContexts.keys()], ['live']);
  assert.deepEqual([...dimensionManager.dimensions.keys()], ['live']);
  assert.equal(state.activeViewId, 'live');
  assert.equal(state.getViewDimensionLevel('live'), 2);
  assert.equal(dimensionManager.getViewDimension('live'), 2);
  assert.equal(viewer.getViewDimension('live'), 2);
  // The graph rollback restores the pose this restore started from, which
  // the viewer reported and so can reach, not the saved one it was replaying.
  assert.deepEqual(
    viewer.getViewCameraState('live'),
    cameraState(),
  );
  assert.equal(viewer.getCamerasLocked(), false);
});

/**
 * A viewer that reports the free-fly half of an orbit camera the way the real
 * one does: derived from the orbit half with its own `Math.sin`/`Math.atan2`/
 * `Math.asin`, whose last bits ECMAScript leaves to the engine. The published
 * He and Kanemaru sample views were saved in WebKit, whose derived pitch is
 * `-0.16539816339745403`; Chromium and Firefox derive `-0.16539816339745406`.
 */
function deriveFreeflyLikeAnotherEngine(camera) {
  const derived = structuredClone(camera);
  if (derived.navigationMode !== 'free') {
    derived.freefly.pitch = derived.freefly.pitch === 0
      ? Number.MIN_VALUE
      : derived.freefly.pitch * (1 + Number.EPSILON);
    derived.freefly.position = derived.freefly.position.map(
      value => value + Number.EPSILON
    );
  }
  return derived;
}

test('a live camera saved by another engine restores: derived free-fly bits are not compared', async () => {
  const {
    snapshots,
    state,
    viewer,
  } = createRestoreOwners();
  const setViewCameraState = viewer.setViewCameraState;
  viewer.setViewCameraState = (viewId, camera) =>
    setViewCameraState(viewId, deriveFreeflyLikeAnotherEngine(camera));
  const saved = multiviewSnapshot({
    cameraState: cameraState(7),
    embedding: UMAP_3D,
  });
  saved.liveCameraState = cameraState(4);
  saved.liveCameraState.freefly.pitch = -0.16539816339745403;

  await restoreMultiview({
    state,
    viewer,
    async restoreActiveFields() {},
    async restoreFilters() {},
    pushViewerState() {},
  }, saved);

  assert.deepEqual(snapshots.map(snapshot => snapshot.id), ['snap_1']);
  assert.equal(state.activeViewId, 'snap_1');
  assert.deepEqual(
    viewer.getViewCameraState('live').orbit,
    saved.liveCameraState.orbit,
  );
});

test('a live camera the viewer cannot hold fails once and rolls back completely', async () => {
  const {
    dimensionManager,
    snapshots,
    state,
    viewer,
  } = createRestoreOwners();
  // A viewer that clamps the orbit radius cannot reproduce this saved pose.
  const setViewCameraState = viewer.setViewCameraState;
  viewer.setViewCameraState = (viewId, camera) => {
    const held = structuredClone(camera);
    held.orbit.radius = Math.min(held.orbit.radius, 50);
    held.orbit.targetRadius = Math.min(held.orbit.targetRadius, 50);
    setViewCameraState(viewId, held);
  };
  const saved = multiviewSnapshot();
  saved.liveCameraState = cameraState(80);

  let failure = null;
  await assert.rejects(
    restoreMultiview({
      state,
      viewer,
      async restoreActiveFields() {},
      async restoreFilters() {},
      pushViewerState() {},
    }, saved),
    error => {
      failure = error;
      return true;
    },
  );
  // The replay failure itself, not "rollback was incomplete": the rollback
  // no longer re-asserts the very pose that was just proven unreachable.
  assert.ok(!(failure instanceof AggregateError), String(failure));
  assert.match(failure.message, /did not preserve the exact saved live camera/);
  assert.deepEqual(snapshots, []);
  assert.deepEqual([...state.viewContexts.keys()], ['live']);
  assert.deepEqual([...dimensionManager.dimensions.keys()], ['live']);
  assert.equal(state.activeViewId, 'live');
  assert.deepEqual(viewer.getViewCameraState('live'), cameraState());
});
