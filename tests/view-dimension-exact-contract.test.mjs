import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DataStateViewMethods,
} from '../assets/js/app/state/managers/view-manager.js';
import {
  createDataState,
} from '../assets/js/app/state/core/data-state.js';

function createDimensionState({
  availableDimensions = [2, 3],
  activeDimensionLevel = 2,
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
  const livePositions = Float32Array.from([
    -0.5, -0.5, 0,
    0.5, 0.5, 0,
  ]);
  const snapshotPositions = Float32Array.from([
    -0.25, -0.25, 0,
    0.25, 0.25, 0,
  ]);
  const context = {
    id: 'live',
    dimensionLevel: activeDimensionLevel,
    centroidPositions: null,
    centroidColors: null,
    centroidOutliers: null,
    centroidLabels: [],
  };
  const state = Object.assign(
    Object.create(DataStateViewMethods.prototype),
    {
      activeDimensionLevel,
      activeViewId: 'live',
      centroidColors: null,
      centroidLabels: [],
      centroidOutliers: null,
      centroidPositions: null,
      dimensionManager: {
        getAvailableDimensions() {
          return [...availableDimensions];
        },
        getDefaultDimension() {
          return availableDimensions[0];
        },
        getPositions3D(level) {
          calls.loads.push(level);
          return positionsResult instanceof Error
            ? Promise.reject(positionsResult)
            : Promise.resolve(positionsResult);
        },
        hasDimension(level) {
          return availableDimensions.includes(level);
        },
        setViewDimension(viewId, level) {
          calls.managerPublications.push([viewId, level]);
        },
      },
      getFieldForView() {
        return null;
      },
      pointCount: 2,
      positionsArray: livePositions,
      viewer: {
        getViewPositions(viewId) {
          if (viewId !== 'snapshot-1') {
            throw new RangeError(`Unexpected snapshot view "${viewId}".`);
          }
          return snapshotPositions;
        },
        setViewDimension(viewId, level) {
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
      _notifyDimensionChange() {
        calls.notifications.push(this.activeDimensionLevel);
        if (notificationError !== null) {
          throw notificationError;
        }
      },
    },
  );
  return { calls, context, state };
}

test('a new DataState publishes one exact empty live view before UI bootstrap', () => {
  const state = createDataState({}, null);

  assert.equal(state.activeViewId, 'live');
  assert.equal(state.pointCount, 0);
  assert.ok(state.cellVisibilityMask instanceof Float32Array);
  assert.equal(state.cellVisibilityMask.length, 0);
  assert.deepEqual([...state.viewContexts.keys()], ['live']);
  assert.equal(state.viewContexts.get('live').id, 'live');
  assert.equal(state.setActiveView('live'), 'live');
  assert.throws(
    () => state.setActiveView('missing'),
    /does not exist/i,
  );
});

test('view dimension lookup requires one existing exact context', () => {
  const { context, state } = createDimensionState();

  assert.equal(state.getViewDimensionLevel('live'), 2);
  for (const viewId of ['', 'missing', 7, null]) {
    assert.throws(
      () => state.getViewDimensionLevel(viewId),
      /view id|does not exist/i,
    );
  }

  context.dimensionLevel = 4;
  assert.throws(
    () => state.getViewDimensionLevel('live'),
    /dimension.*1, 2, or 3/i,
  );
});

test('dimension rejection is explicit and atomic before any publication', async () => {
  const loadError = new Error('coordinate load failed');
  const { calls, context, state } = createDimensionState({
    positionsResult: loadError,
  });

  await assert.rejects(
    state.setDimensionLevel(4, { viewId: 'live' }),
    /exactly 1, 2, or 3/i,
  );
  await assert.rejects(
    state.setDimensionLevel(3, { viewId: 'missing' }),
    /does not exist/i,
  );
  await assert.rejects(
    state.setDimensionLevel(1, { viewId: 'live' }),
    /not available/i,
  );
  await assert.rejects(
    state.setDimensionLevel(3, { viewId: 'live', updateViewer: true }),
    /exactly one.*viewId/i,
  );
  await assert.rejects(
    state.setDimensionLevel(3, { viewId: 'live' }),
    loadError,
  );

  assert.equal(context.dimensionLevel, 2);
  assert.equal(state.activeDimensionLevel, 2);
  assert.deepEqual(calls.loads, [3]);
  assert.deepEqual(calls.managerPublications, []);
  assert.deepEqual(calls.positionPublications, []);
  assert.deepEqual(calls.viewerPublications, []);
  assert.deepEqual(calls.notifications, []);
});

test('successful dimension publication uses the one current viewer path', async () => {
  const nextPositions = Float32Array.from([
    -1, 0, 0,
    1, 0, 0,
  ]);
  const { calls, context, state } = createDimensionState({
    positionsResult: nextPositions,
  });

  await state.setDimensionLevel(3, { viewId: 'live' });

  assert.equal(context.dimensionLevel, 3);
  assert.equal(state.activeDimensionLevel, 3);
  assert.strictEqual(state.positionsArray, nextPositions);
  assert.deepEqual(calls.loads, [3]);
  assert.deepEqual(calls.managerPublications, [['live', 3]]);
  assert.deepEqual(calls.positionPublications, [{
    dimensionLevel: 3,
    positions: nextPositions,
    viewId: 'live',
  }]);
  assert.deepEqual(calls.viewerPublications, [['live', 3]]);
  assert.deepEqual(calls.notifications, [3]);
});

test('a failing dimension listener cannot roll back the generation it observed', async () => {
  const notificationError = new Error('dimension listener failed');
  const nextPositions = Float32Array.from([
    -1, 0, 0,
    1, 0, 0,
  ]);
  const { calls, context, state } = createDimensionState({
    notificationError,
    positionsResult: nextPositions,
  });

  await assert.rejects(
    state.setDimensionLevel(3, { viewId: 'live' }),
    notificationError,
  );

  assert.equal(context.dimensionLevel, 3);
  assert.equal(state.activeDimensionLevel, 3);
  assert.strictEqual(state.positionsArray, nextPositions);
  assert.deepEqual(calls.positionPublications, [{
    dimensionLevel: 3,
    positions: nextPositions,
    viewId: 'live',
  }]);
  assert.deepEqual(calls.managerPublications, [['live', 3]]);
  assert.deepEqual(calls.viewerPublications, [['live', 3]]);
  assert.deepEqual(calls.notifications, [3]);
});

test('snapshot positions publish under the requested dimension generation', async () => {
  const nextPositions = Float32Array.from([
    -1, -1, -1,
    1, 1, 1,
  ]);
  const { calls, state } = createDimensionState({
    positionsResult: nextPositions,
  });
  const snapshotContext = {
    id: 'snapshot-1',
    dimensionLevel: 2,
    centroidPositions: null,
    centroidColors: null,
    centroidOutliers: null,
    centroidLabels: [],
  };
  state.viewContexts.set('snapshot-1', snapshotContext);

  await state.setDimensionLevel(3, { viewId: 'snapshot-1' });

  assert.equal(snapshotContext.dimensionLevel, 3);
  assert.equal(state.activeDimensionLevel, 2);
  assert.deepEqual(calls.positionPublications, [{
    dimensionLevel: 3,
    positions: nextPositions,
    viewId: 'snapshot-1',
  }]);
  assert.deepEqual(calls.managerPublications, [['snapshot-1', 3]]);
  assert.deepEqual(calls.viewerPublications, [['snapshot-1', 3]]);
  assert.deepEqual(calls.notifications, []);
});

test('failed snapshot dimension publication restores positions under the prior generation', async () => {
  const failure = new Error('viewer dimension publication failed');
  const nextPositions = Float32Array.from([
    -1, -1, -1,
    1, 1, 1,
  ]);
  const { calls, state } = createDimensionState({
    positionsResult: nextPositions,
    viewerDimensionError: failure,
  });
  const snapshotContext = {
    id: 'snapshot-1',
    dimensionLevel: 2,
    centroidPositions: null,
    centroidColors: null,
    centroidOutliers: null,
    centroidLabels: [],
  };
  state.viewContexts.set('snapshot-1', snapshotContext);

  await assert.rejects(
    state.setDimensionLevel(3, { viewId: 'snapshot-1' }),
    failure,
  );

  assert.equal(snapshotContext.dimensionLevel, 2);
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
