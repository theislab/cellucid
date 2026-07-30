import assert from 'node:assert/strict';
import test from 'node:test';

import { viewContextCoreMethods } from
  '../assets/js/app/state/managers/view-context-core.js';
import {
  clearPublishedSnapshotViews,
  publishSnapshotView,
  retireSnapshotView,
} from '../assets/js/app/view-snapshot-publication.js';
import {
  restoreMultiview,
} from '../assets/js/app/state-serializer/multiview.js';

function createOwners() {
  const dimensionManager = {
    dimensions: new Map([['live', 2]]),
    copyViewDimension(sourceViewId, targetViewId) {
      if (!this.dimensions.has(sourceViewId)) {
        throw new RangeError(`Unknown dimension source "${sourceViewId}".`);
      }
      this.dimensions.set(
        targetViewId,
        this.dimensions.get(sourceViewId)
      );
    },
    getViewDimension(viewId) {
      if (!this.dimensions.has(viewId)) {
        throw new RangeError(`Unknown view dimension "${viewId}".`);
      }
      return this.dimensions.get(viewId);
    },
    removeView(viewId) {
      this.dimensions.delete(viewId);
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
          dimensionLevel: 2,
          colorsArray: Uint8Array.from([
            1, 2, 3, 255,
            4, 5, 6, 255,
          ]),
          categoryTransparency: Float32Array.from([1, 1]),
          cellVisibilityMask: Float32Array.from([1, 1]),
          outlierQuantilesArray: Float32Array.from([-1, -1]),
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
  const viewer = {
    clearSnapshotViews() {
      snapshots.splice(0);
      for (const viewId of [...viewerDimensions.keys()]) {
        if (viewId !== 'live') viewerDimensions.delete(viewId);
      }
    },
    createSnapshotView(config) {
      const id = `snap_${nextId}`;
      nextId += 1;
      snapshots.push({ id, label: config.label });
      viewerDimensions.set(id, config.dimensionLevel);
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
    removeSnapshotView(viewId) {
      const index = snapshots.findIndex(snapshot => snapshot.id === viewId);
      if (index < 0) {
        throw new RangeError(`Unknown viewer snapshot "${viewId}".`);
      }
      snapshots.splice(index, 1);
      viewerDimensions.delete(viewId);
    },
    setViewDimension(viewId, level) {
      if (!viewerDimensions.has(viewId)) {
        throw new RangeError(`Unknown viewer dimension "${viewId}".`);
      }
      viewerDimensions.set(viewId, level);
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
    transparency: Float32Array.from([0, 0.75]),
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
  const transparency = Float32Array.from([0.25, 1]);
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
    async setDimensionLevel(level, { viewId }) {
      assert.equal(viewId, 'live');
      const live = this.viewContexts.get('live');
      live.dimensionLevel = level;
      this.dimensionManager.dimensions.set('live', level);
      viewer.setViewDimension('live', level);
      viewer.setViewCameraState('live', cameraState(10 + level));
    },
  });

  return {
    ...owners,
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
    dimensionLevel: 2,
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
  assert.deepEqual(Array.from(context.colorsArray), Array.from(config.colors));
  assert.notStrictEqual(context.colorsArray, config.colors);
  assert.deepEqual(
    Array.from(context.categoryTransparency),
    Array.from(config.transparency),
  );
  assert.notStrictEqual(
    context.categoryTransparency,
    config.transparency,
  );
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

  config.colors.fill(99);
  config.transparency.fill(0);
  config.centroidPositions.fill(99);
  assert.deepEqual(Array.from(context.colorsArray), [
    10, 11, 12, 255,
    20, 21, 22, 255,
  ]);
  assert.deepEqual(Array.from(context.categoryTransparency), [0, 0.75]);
  assert.deepEqual(Array.from(context.centroidPositions), [0.25, -0.5, 0]);

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
  dimensionManager.copyViewDimension = () => {};

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
    [0.25, 1],
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
    dimensionLevel: 3,
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

test('final multiview failure rolls back every snapshot and the saved live camera', async () => {
  const {
    dimensionManager,
    snapshots,
    state,
    viewer,
  } = createRestoreOwners();
  const saved = multiviewSnapshot({
    cameraState: cameraState(7),
    dimensionLevel: 3,
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
  assert.deepEqual(
    viewer.getViewCameraState('live'),
    saved.liveCameraState,
  );
});
