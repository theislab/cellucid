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
} = {}) {
  const calls = {
    loads: [],
    managerPublications: [],
    positionPublications: [],
    viewerPublications: [],
    notifications: [],
  };
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
      positionsArray: Float32Array.from([
        -0.5, -0.5, 0,
        0.5, 0.5, 0,
      ]),
      viewer: {
        setViewDimension(viewId, level) {
          calls.viewerPublications.push([viewId, level]);
        },
        updatePositions(positions) {
          calls.positionPublications.push(positions);
        },
      },
      viewContexts: new Map([['live', context]]),
      _dimensionChangeLock: null,
      _notifyDimensionChange() {
        calls.notifications.push(this.activeDimensionLevel);
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
  assert.deepEqual(calls.positionPublications, [nextPositions]);
  assert.deepEqual(calls.viewerPublications, [['live', 3]]);
  assert.deepEqual(calls.notifications, [3]);
});
