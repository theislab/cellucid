/**
 * The one transaction that changes what a view shows.
 *
 * A view shows one enabled representation (a layout); its dimension is that
 * layout's and is stored nowhere else. `setViewRepresentation` stages the
 * coordinates, publishes the renderer, the dimension manager and the viewer,
 * and restores all of them on failure; every view -- active or not --
 * announces a committed change with `view:representation-changed`. The public
 * entries (`setViewEmbedding`, `restoreViewEmbedding`,
 * `showDefaultRepresentation`, `cycleRepresentation`) only resolve which
 * layout and whether the view then follows its dimension's default.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DATASET_VIEW_LOAD_SUPERSEDED_CODE,
  DataStateViewMethods,
} from '../assets/js/app/state/managers/view-manager.js';
import {
  createDataState,
} from '../assets/js/app/state/core/data-state.js';

function createDeferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

/**
 * A layout registry reduced to what the transaction reads. `layouts` maps a
 * layout key to its dimension; `enabled` lists the representations a view may
 * show and `defaults` the default of each dimension. `getPositions` and
 * `setViewLayout` report the layout's dimension so assertions read as
 * dimension generations.
 */
function createLayoutManagerStub({
  layouts = { '2d': 2, '3d': 3, tsne: 2 },
  enabled = Object.keys(layouts),
  defaults = new Map([[2, '2d'], [3, '3d']]),
  loadPositions,
  publish = () => {},
  viewLayouts = new Map(),
}) {
  const dimensionOf = layoutKey => {
    if (!Object.hasOwn(layouts, layoutKey)) {
      throw new RangeError(`Layout "${layoutKey}" is not registered.`);
    }
    return layouts[layoutKey];
  };
  return {
    viewLayouts,
    enabled,
    getDefaultDimension() {
      return Math.max(...defaults.keys());
    },
    getDefaultLayout(level) {
      return defaults.get(level) ?? null;
    },
    getDefaultLayoutKey() {
      return defaults.get(Math.max(...defaults.keys()));
    },
    getEnabledLayoutKeys() {
      return Object.freeze([...this.enabled]);
    },
    getEnabledLayoutsForDimension(level) {
      return this.enabled
        .filter(layoutKey => dimensionOf(layoutKey) === level)
        .map(layoutKey => ({ layoutKey, dimension: level }));
    },
    getLayout(layoutKey) {
      return { layoutKey, dimension: dimensionOf(layoutKey), label: layoutKey };
    },
    getOpeningLayout(level) {
      return defaults.get(level)
        ?? this.getEnabledLayoutsForDimension(level)[0]?.layoutKey
        ?? null;
    },
    getPositions(layoutKey) {
      return loadPositions(dimensionOf(layoutKey), layoutKey);
    },
    getViewLayout(viewId) {
      if (!viewLayouts.has(viewId)) {
        throw new RangeError(`Layout state is not published for view "${viewId}".`);
      }
      return viewLayouts.get(viewId);
    },
    isEnabled(layoutKey) {
      return this.enabled.includes(layoutKey);
    },
    pinLayout() {
      return () => {};
    },
    resolveRepresentation(ref) {
      dimensionOf(ref.key);
      return ref.key;
    },
    setViewLayout(viewId, layoutKey) {
      publish(viewId, dimensionOf(layoutKey));
      viewLayouts.set(viewId, layoutKey);
    },
  };
}

function createRuntimeViewer() {
  const calls = {
    dimensionPublications: [],
    positionPublications: [],
    vectorPublications: [],
  };
  let disposed = false;
  const viewer = {
    hasVectorFieldForLayout() {
      return false;
    },
    isDisposed() {
      return disposed;
    },
    resetVectorFieldOverlay() {},
    setCentroidLabels() {},
    setCentroids() {},
    setData() {},
    setVectorFieldData(fieldId, layoutKey, data) {
      calls.vectorPublications.push({ data, fieldId, layoutKey });
    },
    setViewEmbedding(viewId, { dimension }) {
      calls.dimensionPublications.push([viewId, dimension]);
    },
    updatePositions(positions, level) {
      calls.positionPublications.push({ level, positions });
    },
  };
  return {
    calls,
    dispose() {
      disposed = true;
    },
    viewer,
  };
}

function createDimensionManager({ deferredPositions = null } = {}) {
  const publications = [];
  const manager = createLayoutManagerStub({
    layouts: { '2d': 2, '3d': 3 },
    defaults: new Map([[2, '2d'], [3, '3d']]),
    loadPositions(level) {
      if (deferredPositions !== null && level === 3) {
        return deferredPositions.promise;
      }
      // Two cells, `level` components each.
      return Promise.resolve(new Float32Array(2 * level));
    },
    publish(viewId, level) {
      publications.push([viewId, level]);
    },
  });
  // The real registry opens on its identity's default dimension; these
  // scenes open in 2D.
  manager.getDefaultLayoutKey = () => '2d';
  manager.publications = publications;
  return manager;
}

function createDimensionState({
  positionsResult = Float32Array.from([
    -1, -1, 0,
    1, 1, 0,
  ]),
  notificationError = null,
  viewerDimensionError = null,
} = {}) {
  const calls = {
    loads: [],
    managerPublications: [],
    positionPublications: [],
    viewerPublications: [],
    notifications: [],
  };
  // Positions hold exactly the published dimension's components per cell:
  // these 2D views carry x and y only.
  const livePositions = Float32Array.from([
    -0.5, -0.5,
    0.5, 0.5,
  ]);
  const snapshotPositions = Float32Array.from([
    -0.25, -0.25,
    0.25, 0.25,
  ]);
  const context = {
    id: 'live',
    followsDefault: true,
    centroidPositions: null,
    centroidColors: null,
    centroidOutliers: null,
    centroidLabels: [],
  };
  const manager = createLayoutManagerStub({
    enabled: ['2d', '3d'],
    loadPositions(level, layoutKey) {
      calls.loads.push(layoutKey);
      return positionsResult instanceof Error
        ? Promise.reject(positionsResult)
        : Promise.resolve(positionsResult);
    },
    publish(viewId, level) {
      calls.managerPublications.push([viewId, level]);
    },
    viewLayouts: new Map([
      ['live', '2d'],
      ['snapshot-1', '2d'],
    ]),
  });
  const state = Object.assign(
    Object.create(DataStateViewMethods.prototype),
    {
      activeViewId: 'live',
      centroidColors: null,
      centroidLabels: [],
      centroidOutliers: null,
      centroidPositions: null,
      dimensionManager: manager,
      getFieldForView() {
        return null;
      },
      pointCount: 2,
      positionsArray: livePositions,
      positionsDimension: 2,
      viewer: {
        getViewPositions(viewId) {
          if (viewId !== 'snapshot-1') {
            throw new RangeError(`Unexpected snapshot view "${viewId}".`);
          }
          return snapshotPositions;
        },
        setViewEmbedding(viewId, { dimension: level }) {
          calls.viewerPublications.push([viewId, level]);
          if (level === 3 && viewerDimensionError !== null) {
            throw viewerDimensionError;
          }
        },
        setViewPositions(viewId, positions, dimensionLevel) {
          calls.positionPublications.push({
            dimensionLevel,
            positions,
            viewId,
          });
        },
        updatePositions(positions, dimensionLevel) {
          calls.positionPublications.push({
            dimensionLevel,
            positions,
            viewId: 'live',
          });
        },
      },
      viewContexts: new Map([['live', context]]),
      _dimensionChangeLock: null,
      emit(name, payload) {
        assert.equal(name, 'view:representation-changed');
        calls.notifications.push(payload);
        if (notificationError !== null) {
          throw notificationError;
        }
      },
    },
  );
  return { calls, context, manager, state };
}

function snapshotContext() {
  return {
    id: 'snapshot-1',
    followsDefault: true,
    centroidPositions: null,
    centroidColors: null,
    centroidOutliers: null,
    centroidLabels: [],
  };
}

test('a new DataState publishes one exact empty live view before UI bootstrap', () => {
  const state = createDataState({}, null);

  assert.equal(state.activeViewId, 'live');
  assert.equal(state.pointCount, 0);
  assert.ok(state.cellVisibilityMask instanceof Uint8Array);
  assert.equal(state.cellVisibilityMask.length, 0);
  assert.deepEqual([...state.viewContexts.keys()], ['live']);
  assert.equal(state.viewContexts.get('live').id, 'live');
  assert.equal(state.viewContexts.get('live').followsDefault, true);
  assert.equal(Object.hasOwn(state, 'activeDimensionLevel'), false);
  assert.equal(Object.hasOwn(state, 'activeEmbeddingOverride'), false);
  assert.equal(state.setActiveView('live'), 'live');
  assert.throws(
    () => state.setActiveView('missing'),
    /does not exist/i,
  );
});

test('a view\'s dimension is derived from the representation it shows', () => {
  const { context, manager, state } = createDimensionState();

  assert.equal(state.getViewDimensionLevel('live'), 2);
  assert.equal(state.getDimensionLevel(), 2);
  for (const viewId of ['', 'missing', 7, null]) {
    assert.throws(
      () => state.getViewDimensionLevel(viewId),
      /view id|does not exist/i,
    );
  }
  // A context is never a second owner of the dimension.
  assert.equal(Object.hasOwn(context, 'dimensionLevel'), false);
  manager.viewLayouts.set('live', '3d');
  assert.equal(state.getViewDimensionLevel('live'), 3);
  assert.equal(state.getDimensionLevel(), 3);

  // A registry reporting a dimension outside 1..3 is refused, not coerced.
  manager.getLayout = layoutKey => ({ layoutKey, dimension: 4 });
  assert.throws(
    () => state.getViewDimensionLevel('live'),
    /dimension.*1, 2, or 3/i,
  );
});

test('representation rejection is explicit and atomic before any publication', async () => {
  const loadError = new Error('coordinate load failed');
  const { calls, context, manager, state } = createDimensionState({
    positionsResult: loadError,
  });

  await assert.rejects(
    state.setViewRepresentation('live', '3d', {}),
    /exactly one boolean "followsDefault"/i,
  );
  await assert.rejects(
    state.setViewRepresentation('live', '3d', { followsDefault: 'yes' }),
    /exactly one boolean "followsDefault"/i,
  );
  await assert.rejects(
    state.setViewRepresentation('live', '3d', { followsDefault: true, viewId: 'live' }),
    /exactly one boolean "followsDefault"/i,
  );
  await assert.rejects(
    state.setViewRepresentation('missing', '3d', { followsDefault: true }),
    /does not exist/i,
  );
  await assert.rejects(
    state.setViewRepresentation('live', '1d', { followsDefault: true }),
    /not registered/i,
  );
  // A registered layout the mapping does not enable is not shown.
  await assert.rejects(
    state.setViewRepresentation('live', 'tsne', { followsDefault: false }),
    /tsne is not enabled for this dataset/i,
  );
  await assert.rejects(
    state.showDefaultRepresentation('live', 1),
    /No 1D representation is enabled/i,
  );
  await assert.rejects(
    state.showDefaultRepresentation('live', 4),
    /exactly 1, 2, or 3/i,
  );
  await assert.rejects(
    state.setViewRepresentation('live', '3d', { followsDefault: true }),
    loadError,
  );

  assert.equal(manager.getViewLayout('live'), '2d');
  assert.equal(context.followsDefault, true);
  assert.equal(state.getDimensionLevel(), 2);
  assert.deepEqual(calls.loads, ['3d']);
  assert.deepEqual(calls.managerPublications, []);
  assert.deepEqual(calls.positionPublications, []);
  assert.deepEqual(calls.viewerPublications, []);
  assert.deepEqual(calls.notifications, []);
});

test('successful representation publication uses the one current viewer path', async () => {
  const nextPositions = Float32Array.from([
    -1, 0, 0,
    1, 0, 0,
  ]);
  const { calls, context, manager, state } = createDimensionState({
    positionsResult: nextPositions,
  });

  assert.equal(await state.showDefaultRepresentation('live', 3), '3d');

  assert.equal(manager.getViewLayout('live'), '3d');
  assert.equal(state.getDimensionLevel(), 3);
  assert.equal(state.positionsDimension, 3);
  assert.equal(context.followsDefault, true);
  assert.strictEqual(state.positionsArray, nextPositions);
  assert.deepEqual(calls.loads, ['3d']);
  assert.deepEqual(calls.managerPublications, [['live', 3]]);
  assert.deepEqual(calls.positionPublications, [{
    dimensionLevel: 3,
    positions: nextPositions,
    viewId: 'live',
  }]);
  assert.deepEqual(calls.viewerPublications, [['live', 3]]);
  assert.deepEqual(calls.notifications, [
    { viewId: 'live', layoutKey: '3d', dimension: 3, previousLayoutKey: '2d' },
  ]);
});

test('whether a view follows its default is decided by the entry, never guessed', async () => {
  const { context, state } = createDimensionState({
    positionsResult: Float32Array.from([-1, 0, 0, 1, 0, 0]),
  });

  // An explicit reference is a choice the view keeps, even the default's.
  await state.setViewEmbedding('live', { key: '3d', columns: null });
  assert.equal(context.followsDefault, false);
  // Naming what the view shows changes only the intent.
  await state.setViewEmbedding('live', { key: '3d', columns: null });
  assert.equal(context.followsDefault, false);
  // A session records what a view showed: the default's view follows it again.
  await state.restoreViewEmbedding('live', { key: '3d', columns: null });
  assert.equal(context.followsDefault, true);
  await state.setViewRepresentation('live', '3d', { followsDefault: false });
  assert.equal(context.followsDefault, false);
  assert.equal(state.viewFollowsDefault('live'), false);
  assert.throws(() => state.viewFollowsDefault('missing'), /does not exist/);
});

test('a failing representation listener cannot roll back the generation it observed', async () => {
  const notificationError = new Error('representation listener failed');
  const nextPositions = Float32Array.from([
    -1, 0, 0,
    1, 0, 0,
  ]);
  const { calls, manager, state } = createDimensionState({
    notificationError,
    positionsResult: nextPositions,
  });

  await assert.rejects(
    state.setViewRepresentation('live', '3d', { followsDefault: true }),
    notificationError,
  );

  assert.equal(manager.getViewLayout('live'), '3d');
  assert.equal(state.getDimensionLevel(), 3);
  assert.strictEqual(state.positionsArray, nextPositions);
  assert.deepEqual(calls.positionPublications, [{
    dimensionLevel: 3,
    positions: nextPositions,
    viewId: 'live',
  }]);
  assert.deepEqual(calls.managerPublications, [['live', 3]]);
  assert.deepEqual(calls.viewerPublications, [['live', 3]]);
  assert.equal(calls.notifications.length, 1);
  assert.equal(state._dimensionChangeLock, null, 'the transaction lock is released');
});

test('snapshot positions publish under the requested representation, and the snapshot announces it', async () => {
  const nextPositions = Float32Array.from([
    -1, -1, -1,
    1, 1, 1,
  ]);
  const { calls, manager, state } = createDimensionState({
    positionsResult: nextPositions,
  });
  const context = snapshotContext();
  state.viewContexts.set('snapshot-1', context);

  await state.setViewRepresentation('snapshot-1', '3d', { followsDefault: false });

  assert.equal(manager.getViewLayout('snapshot-1'), '3d');
  assert.equal(state.getViewDimensionLevel('snapshot-1'), 3);
  assert.equal(context.followsDefault, false);
  assert.equal(state.getDimensionLevel(), 2, 'the active view is untouched');
  assert.deepEqual(calls.positionPublications, [{
    dimensionLevel: 3,
    positions: nextPositions,
    viewId: 'snapshot-1',
  }]);
  assert.deepEqual(calls.managerPublications, [['snapshot-1', 3]]);
  assert.deepEqual(calls.viewerPublications, [['snapshot-1', 3]]);
  assert.deepEqual(calls.notifications, [
    { viewId: 'snapshot-1', layoutKey: '3d', dimension: 3, previousLayoutKey: '2d' },
  ]);
});

test('failed snapshot representation publication restores every owner to the prior one', async () => {
  const failure = new Error('viewer dimension publication failed');
  const nextPositions = Float32Array.from([
    -1, -1, -1,
    1, 1, 1,
  ]);
  const { calls, manager, state } = createDimensionState({
    positionsResult: nextPositions,
    viewerDimensionError: failure,
  });
  const context = snapshotContext();
  state.viewContexts.set('snapshot-1', context);

  await assert.rejects(
    state.setViewRepresentation('snapshot-1', '3d', { followsDefault: false }),
    failure,
  );

  assert.equal(manager.getViewLayout('snapshot-1'), '2d');
  assert.equal(state.getViewDimensionLevel('snapshot-1'), 2);
  assert.equal(context.followsDefault, true, 'the intent rolls back with the layout');
  assert.deepEqual(
    calls.positionPublications.map(
      ({ dimensionLevel, viewId }) => ({ dimensionLevel, viewId }),
    ),
    [
      { dimensionLevel: 3, viewId: 'snapshot-1' },
      { dimensionLevel: 2, viewId: 'snapshot-1' },
    ],
  );
  assert.deepEqual(calls.managerPublications, [
    ['snapshot-1', 3],
    ['snapshot-1', 2],
  ]);
  assert.deepEqual(calls.viewerPublications, [
    ['snapshot-1', 3],
    ['snapshot-1', 2],
  ]);
  assert.deepEqual(calls.notifications, []);
});

test('real DataState rejects deferred coordinates after dataset-owner replacement', async () => {
  const runtime = createRuntimeViewer();
  const deferredPositions = createDeferred();
  const priorManager = createDimensionManager({ deferredPositions });
  const state = createDataState({
    viewer: runtime.viewer,
    labelLayer: null,
  });
  state.setDimensionManager(priorManager);
  const priorPositions = Float32Array.from([
    -1, -1,
    1, 1,
  ]);
  state.initScene(priorPositions, { fields: [] });

  const representationChange = state.showDefaultRepresentation('live', 3);
  const replacementManager = createDimensionManager();
  const replacementPositions = Float32Array.from([
    -0.25, -0.25,
    0.25, 0.25,
  ]);
  state.setDimensionManager(replacementManager);
  state.initScene(replacementPositions, { fields: [] });

  deferredPositions.resolve(Float32Array.from([
    -2, -2, -2,
    2, 2, 2,
  ]));
  await assert.rejects(
    representationChange,
    error => error?.code === DATASET_VIEW_LOAD_SUPERSEDED_CODE,
  );
  assert.strictEqual(state.dimensionManager, replacementManager);
  assert.strictEqual(state.positionsArray, replacementPositions);
  assert.equal(state.pointCount, 2);
  assert.deepEqual(runtime.calls.positionPublications, []);
  assert.deepEqual(runtime.calls.dimensionPublications, []);
  assert.equal(
    priorManager.publications.some(
      ([viewId, level]) => viewId === 'live' && level === 3
    ),
    false,
  );
});

test('real DataState rejects deferred coordinates after terminal viewer disposal', async () => {
  const runtime = createRuntimeViewer();
  const deferredPositions = createDeferred();
  const manager = createDimensionManager({ deferredPositions });
  const state = createDataState({
    viewer: runtime.viewer,
    labelLayer: null,
  });
  state.setDimensionManager(manager);
  state.initScene(new Float32Array(4), { fields: [] });

  const representationChange = state.showDefaultRepresentation('live', 3);
  runtime.dispose();
  deferredPositions.resolve(new Float32Array(6));

  await assert.rejects(
    representationChange,
    error => error?.code === DATASET_VIEW_LOAD_SUPERSEDED_CODE,
  );
  assert.deepEqual(runtime.calls.positionPublications, []);
  assert.deepEqual(runtime.calls.dimensionPublications, []);
  assert.equal(state.getViewDimensionLevel('live'), 2);
});

test('real DataState rejects deferred vectors after manager and dataset replacement', async () => {
  const runtime = createRuntimeViewer();
  const dimensionManager = createDimensionManager();
  const state = createDataState({
    viewer: runtime.viewer,
    labelLayer: null,
  });
  state.setDimensionManager(dimensionManager);
  state.initScene(new Float32Array(4), { fields: [] });

  const deferredField = createDeferred();
  const disposed = [];
  const priorVectorManager = {
    getAvailableFields() {
      return [{
        id: 'velocity',
        label: 'Velocity',
      }];
    },
    getDefaultFieldId() {
      return 'velocity';
    },
    hasAny() {
      return true;
    },
    hasField(fieldId) {
      return fieldId === 'velocity';
    },
    hasFieldLayout(fieldId, layoutKey) {
      return fieldId === 'velocity' && layoutKey === '2d';
    },
    loadField() {
      return deferredField.promise;
    },
    dispose() {
      disposed.push('prior');
    },
  };
  const replacementVectorManager = {
    ...priorVectorManager,
    loadField() {
      throw new Error('Replacement vector manager was not requested.');
    },
  };
  state.setVectorFieldManager(priorVectorManager);
  // A field is loaded for one representation, named by its layout.
  const vectorLoad = state.ensureVectorField(
    'velocity',
    '2d',
    { silent: true },
  );

  state.initScene(new Float32Array(4), { fields: [] });
  state.setVectorFieldManager(replacementVectorManager);
  deferredField.resolve(Float32Array.from([
    1, 0,
    0, 1,
  ]));

  await assert.rejects(
    vectorLoad,
    error => error?.code === DATASET_VIEW_LOAD_SUPERSEDED_CODE,
  );
  assert.strictEqual(
    state.getVectorFieldManager(),
    replacementVectorManager,
  );
  assert.deepEqual(disposed, ['prior'], 'the replaced manager is retired');
  assert.deepEqual(runtime.calls.vectorPublications, []);
});

test('a vector field is refused for a representation it is not bound to', async () => {
  const runtime = createRuntimeViewer();
  const state = createDataState({ viewer: runtime.viewer, labelLayer: null });
  state.setDimensionManager(createDimensionManager());
  state.initScene(new Float32Array(4), { fields: [] });
  state.setVectorFieldManager({
    getAvailableFields: () => [{
      id: 'velocity',
      label: 'Velocity',
    }],
    getDefaultFieldId: () => 'velocity',
    hasAny: () => true,
    hasField: fieldId => fieldId === 'velocity',
    hasFieldLayout: (fieldId, layoutKey) => layoutKey === '2d',
    loadField() {
      throw new Error('An unbound representation must not load.');
    },
    dispose() {},
  });
  await assert.rejects(
    state.ensureVectorField('velocity', '3d', { silent: true }),
    /no data bound to 3d/,
  );
  await assert.rejects(
    state.ensureVectorField('velocity', 'missing', { silent: true }),
    /not registered/,
  );
  assert.deepEqual(runtime.calls.vectorPublications, []);
});
