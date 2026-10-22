import assert from 'node:assert/strict';
import test from 'node:test';

import { DataStateColorMethods } from '../assets/js/app/state/managers/color-manager.js';
import { DataStateFilterMethods } from '../assets/js/app/state/managers/filter-manager.js';
import { DataStateViewMethods } from '../assets/js/app/state/managers/view-manager.js';

const POINT_COUNT = 4;

function createState() {
  const active = {
    kind: 'category',
    key: 'leiden',
    categories: ['x', 'y'],
    codes: new Uint8Array([0, 0, 1, 1]),
    _categoryColors: [[1, 0, 0], [0, 1, 0]],
    _categoryVisible: { 0: true, 1: true },
    _categoryFilterEnabled: true,
  };
  const other = {
    kind: 'category',
    key: 'cell_type',
    categories: ['A', 'B'],
    codes: new Uint8Array([0, 1, 0, 1]),
    _categoryColors: [[0, 0, 1], [1, 1, 0]],
    _categoryVisible: { 0: true, 1: false },
    _categoryFilterEnabled: true,
  };
  const pushes = [];
  const state = {
    pointCount: POINT_COUNT,
    obsData: { fields: [active, other] },
    varData: { fields: [] },
    activeFieldSource: 'obs',
    activeFieldIndex: 0,
    activeVarFieldIndex: -1,
    _batchMode: false,
    _batchDepth: 0,
    _batchDirty: { visibility: false, colors: false, affectedFields: new Set() },
    colorsArray: new Uint8Array(POINT_COUNT * 4),
    categoryTransparency: new Uint8Array(POINT_COUNT).fill(1),
    cellVisibilityMask: new Uint8Array(POINT_COUNT).fill(1),
    getActiveField() {
      return this.obsData.fields[this.activeFieldIndex];
    },
    _pushColorsToViewer() {
      pushes.push(Array.from(this.colorsArray));
    },
    _pushTransparencyToViewer() {},
    _pushCentroidsToViewer() {},
    _syncActiveContext() {},
    updateFilteredCount() {},
    _pushActiveViewLabelToViewer() {},
    _notifyVisibilityChange() {},
  };
  for (const prototype of [
    DataStateFilterMethods.prototype,
    DataStateColorMethods.prototype,
  ]) {
    for (const key of Object.getOwnPropertyNames(prototype)) {
      if (key !== 'constructor') state[key] = prototype[key];
    }
  }
  state.beginBatch = DataStateViewMethods.prototype.beginBatch;
  state.endBatch = DataStateViewMethods.prototype.endBatch;
  state._updateActiveCategoryCounts = () => false;
  state.updateColorsCategorical(active);
  state.computeGlobalVisibility();
  return { state, other, pushes };
}

function rgbPerCell(state) {
  return [0, 1, 2, 3].map((index) => (
    Array.from(state.colorsArray.slice(index * 4, index * 4 + 3))
  ));
}

const ACTIVE_RGB = [[255, 0, 0], [255, 0, 0], [0, 255, 0], [0, 255, 0]];

test('removing a filter on a non-active field keeps the active field palette', () => {
  const { state, other } = createState();
  assert.deepEqual(rgbPerCell(state), ACTIVE_RGB);

  state.removeFilter('obs-category-1');

  assert.equal(other._categoryVisible[1], true);
  assert.deepEqual(rgbPerCell(state), ACTIVE_RGB);
});

test('batched visibility and colour edits of a non-active field never repaint the canvas', () => {
  const { state, other } = createState();

  state.beginBatch();
  state.setVisibilityForCategory(other, 0, false);
  state.setColorForCategory(other, 1, [0.5, 0.5, 0.5]);
  state.endBatch();

  assert.deepEqual(rgbPerCell(state), ACTIVE_RGB);
  state.setColorForCategory(other, 0, [0, 0, 0]);
  assert.deepEqual(rgbPerCell(state), ACTIVE_RGB);
});

test('editing the active field still repaints it', () => {
  const { state } = createState();
  state.setColorForCategory(state.getActiveField(), 1, [0, 0, 1]);
  assert.deepEqual(
    rgbPerCell(state),
    [[255, 0, 0], [255, 0, 0], [0, 0, 255], [0, 0, 255]],
  );
});
