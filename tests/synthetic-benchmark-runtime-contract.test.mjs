import assert from 'node:assert/strict';
import test from 'node:test';

import { createDataState } from '../assets/js/app/state/index.js';
import {
  createInMemoryDimensionManager
} from '../assets/js/data/dimension-manager.js';

function createViewer({ rejectPositions = null } = {}) {
  const calls = [];
  return {
    calls,
    clearSnapshotViews() {
      calls.push(['clearSnapshotViews']);
    },
    // The seeded scene shows the 3D layout of the previous dataset.
    getViewLayoutKey(viewId) {
      assert.equal(viewId, 'live');
      return '3d';
    },
    resetVectorFieldOverlay() {
      calls.push(['resetVectorFieldOverlay']);
    },
    setCentroidLabels(labels, viewId) {
      calls.push(['setCentroidLabels', labels, viewId]);
    },
    setCentroids(payload) {
      calls.push(['setCentroids', payload]);
    },
    setData(payload) {
      calls.push(['setData', payload]);
      if (payload.positions === rejectPositions) {
        throw new Error('renderer rejected candidate');
      }
    },
    setLiveViewLabel(label) {
      calls.push(['setLiveViewLabel', label]);
    },
    updateHighlight(highlights, indices) {
      calls.push(['updateHighlight', highlights, indices]);
    }
  };
}

function createLabelLayer() {
  return {
    querySelectorAll() {
      return [];
    }
  };
}

function seedState(viewer) {
  const state = createDataState({
    viewer,
    labelLayer: createLabelLayer()
  });
  state.pointCount = 2;
  state.positionsArray = new Float32Array([0, 0, 0, 1, 1, 1]);
  state.positionsDimension = 3;
  state.colorsArray = new Uint8Array([
    1, 2, 3, 255,
    4, 5, 6, 255
  ]);
  state.categoryTransparency = new Uint8Array([1, 0]);
  state.cellVisibilityMask = new Uint8Array([1, 0]);
  state.highlightArray = new Uint8Array([255, 0]);
  state.highlightPages = [{
    id: 'page_1',
    name: 'Old',
    highlightedGroups: [{
      id: 'highlight_1',
      type: 'indices',
      label: 'Old selection',
      enabled: true,
      cellIndices: [0],
      cellCount: 1
    }]
  }];
  state.activePageId = 'page_1';
  state.activeFieldIndex = 0;
  state.activeFieldSource = 'obs';
  state.obsData = {
    fields: [{
      key: 'old',
      kind: 'continuous',
      values: new Float32Array([1, 2])
    }]
  };
  state.filteredCount = { shown: 1, total: 2 };
  state._resetViewContexts();
  return state;
}

function createCandidate(pointCount = 5, dimensionLevel = 3) {
  // Exactly `dimensionLevel` position components per point.
  const positions = new Float32Array(pointCount * dimensionLevel);
  const colors = new Uint8Array(pointCount * 4);
  for (let index = 0; index < pointCount; index += 1) {
    for (let axis = 0; axis < dimensionLevel; axis += 1) {
      positions[index * dimensionLevel + axis] = index / (pointCount + axis);
    }
    colors[index * 4] = index;
    colors[index * 4 + 1] = 100;
    colors[index * 4 + 2] = 200;
    colors[index * 4 + 3] = 255;
  }
  const dimensionManager = createInMemoryDimensionManager({
    positions,
    dimension: dimensionLevel
  });
  return {
    colors,
    dimensionLevel,
    dimensionManager,
    positions
  };
}

test('in-memory dimensions publish one exact cached coordinate generation', async () => {
  const candidate = createCandidate(4, 2);
  assert.deepEqual(
    candidate.dimensionManager.getAvailableDimensions(),
    [2]
  );
  assert.equal(candidate.dimensionManager.getDefaultDimension(), 2);
  assert.equal(
    await candidate.dimensionManager.getPositions('2d'),
    candidate.positions
  );
  // Its one layout is enabled and is its dimension's default.
  assert.deepEqual(candidate.dimensionManager.getEnabledLayoutKeys(), ['2d']);
  assert.equal(candidate.dimensionManager.getDefaultLayout(2), '2d');
  assert.equal(candidate.dimensionManager.getDefaultLayoutKey(), '2d');
  assert.equal(candidate.dimensionManager.getViewLayout('live'), '2d');
  assert.equal(candidate.dimensionManager.getLayout('2d').path, null);
  await assert.rejects(
    candidate.dimensionManager.loadLayout('2d'),
    /exist only in memory/
  );

  assert.throws(
    () => createInMemoryDimensionManager({
      positions: new Float32Array([0, Number.NaN, 0, 0]),
      dimension: 2
    }),
    /position 1 must be finite/
  );
  assert.throws(
    () => createInMemoryDimensionManager({
      positions: new Float32Array(6 + 1),
      dimension: 2
    }),
    /2 values per cell/
  );
  assert.throws(
    () => createInMemoryDimensionManager({
      positions: candidate.positions,
      dimension: '2'
    }),
    /must be exactly 1, 2, or 3/
  );
});

test('synthetic benchmark publication replaces every count-coupled state owner', () => {
  const viewer = createViewer();
  const state = seedState(viewer);
  const candidate = createCandidate(5, 2);

  const publication = state.initSyntheticScene(candidate);

  assert.deepEqual(publication, {
    dimensionLevel: 2,
    pointCount: 5
  });
  assert.equal(state.pointCount, 5);
  assert.equal(state.positionsArray, candidate.positions);
  assert.equal(state.positionsArray.length, 10);
  assert.equal(state.positionsDimension, 2);
  assert.equal(state.colorsArray, candidate.colors);
  assert.equal(state.dimensionManager, candidate.dimensionManager);
  // The active dimension is the dimension of the representation it shows.
  assert.equal(state.getDimensionLevel(), 2);
  assert.equal(Object.hasOwn(state, 'activeDimensionLevel'), false);
  assert.deepEqual(state.obsData, { fields: [] });
  assert.equal(state.varData, null);
  assert.equal(state.fieldLoader, null);
  assert.equal(state.varFieldLoader, null);
  assert.equal(state.vectorFieldManager, null);
  assert.equal(state.activeFieldIndex, -1);
  assert.equal(state.activeVarFieldIndex, -1);
  assert.equal(state.activeFieldSource, null);
  assert.equal(state.categoryTransparency.length, 5);
  assert.deepEqual([...state.categoryTransparency], [1, 1, 1, 1, 1]);
  assert.equal(state.cellVisibilityMask.length, 5);
  assert.deepEqual([...state.cellVisibilityMask], [1, 1, 1, 1, 1]);
  assert.equal(Object.hasOwn(state, 'outlierQuantilesArray'), false);
  assert.equal(state.highlightArray.length, 5);
  assert.deepEqual([...state.highlightArray], [0, 0, 0, 0, 0]);
  assert.equal(state.highlightPages.length, 1);
  assert.deepEqual(state.highlightPages[0].highlightedGroups, []);
  assert.equal(state.activePageId, state.highlightPages[0].id);
  assert.deepEqual(state.filteredCount, { shown: 5, total: 5 });
  assert.equal(state.viewContexts.size, 1);
  assert.equal(state.activeViewId, 'live');

  const rendererPublication = viewer.calls.find(
    ([name, payload]) =>
      name === 'setData' && payload.positions === candidate.positions
  );
  assert.ok(rendererPublication);
  assert.equal(rendererPublication[1].colors, candidate.colors);
  assert.equal(rendererPublication[1].transparency.length, 5);
  assert.equal(rendererPublication[1].dimensionLevel, 2);
  assert.equal(rendererPublication[1].layoutKey, '2d');
  const highlightPublication = viewer.calls.find(
    ([name, payload]) =>
      name === 'updateHighlight' && payload === state.highlightArray
  );
  assert.ok(highlightPublication);
  assert.equal(highlightPublication[1].length, 5);
});

test('rejected synthetic staging leaves the previous complete state untouched', () => {
  const viewer = createViewer();
  const state = seedState(viewer);
  const candidate = createCandidate(5, 3);
  const previous = {
    pointCount: state.pointCount,
    positions: state.positionsArray,
    colors: state.colorsArray,
    transparency: state.categoryTransparency,
    visibility: state.cellVisibilityMask,
    highlights: state.highlightArray,
    obsData: state.obsData
  };
  candidate.colors = new Uint8Array(4);

  assert.throws(
    () => state.initSyntheticScene(candidate),
    /dataset-length Uint8 RGBA/
  );
  assert.equal(state.pointCount, previous.pointCount);
  assert.equal(state.positionsArray, previous.positions);
  assert.equal(state.colorsArray, previous.colors);
  assert.equal(state.categoryTransparency, previous.transparency);
  assert.equal(state.cellVisibilityMask, previous.visibility);
  assert.equal(state.highlightArray, previous.highlights);
  assert.equal(state.obsData, previous.obsData);
  assert.equal(viewer.calls.length, 0);
});

test('renderer rejection restores the previous payload without publishing state', () => {
  const candidate = createCandidate(5, 3);
  const viewer = createViewer({ rejectPositions: candidate.positions });
  const state = seedState(viewer);
  const previous = {
    pointCount: state.pointCount,
    positions: state.positionsArray,
    colors: state.colorsArray,
    transparency: state.categoryTransparency,
    visibility: state.cellVisibilityMask,
    highlights: state.highlightArray,
    obsData: state.obsData
  };

  assert.throws(
    () => state.initSyntheticScene(candidate),
    /renderer rejected candidate/
  );
  assert.equal(state.pointCount, previous.pointCount);
  assert.equal(state.positionsArray, previous.positions);
  assert.equal(state.colorsArray, previous.colors);
  assert.equal(state.categoryTransparency, previous.transparency);
  assert.equal(state.cellVisibilityMask, previous.visibility);
  assert.equal(state.highlightArray, previous.highlights);
  assert.equal(state.obsData, previous.obsData);

  const setDataCalls = viewer.calls.filter(([name]) => name === 'setData');
  assert.equal(setDataCalls.length, 2);
  assert.equal(setDataCalls[0][1].positions, candidate.positions);
  assert.equal(setDataCalls[1][1].positions, previous.positions);
  assert.equal(setDataCalls[1][1].layoutKey, '3d');
});
