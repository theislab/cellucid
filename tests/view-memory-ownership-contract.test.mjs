import assert from 'node:assert/strict';
import test from 'node:test';

import {
  requirePointTransparency,
} from '../assets/js/rendering/alpha-visibility.js';
import {
  markSnapshotPublishedColors,
  transparencyEpoch,
  writableCellVisibilityMask,
  writableColors,
  writableTransparency,
} from '../assets/js/app/state/managers/per-cell-array-ownership.js';
import {
  DataStateColorMethods,
} from '../assets/js/app/state/managers/color-manager.js';
import {
  DataStateFilterMethods,
} from '../assets/js/app/state/managers/filter-manager.js';
import {
  FieldSummaryMethods,
} from '../assets/js/app/state/managers/field/summary.js';
import {
  viewContextCoreMethods,
} from '../assets/js/app/state/managers/view-context-core.js';
import { residencyBudgetBytes } from '../assets/js/data/memory-budget.js';
import {
  releaseInactiveFieldsOverBudget,
  touchFieldResidency,
} from '../assets/js/app/state/managers/field/residency.js';

/**
 * Memory ownership contract for the per-cell view arrays.
 *
 * Point transparency is one byte a cell holding exactly 0 or 1; a kept view
 * shares the per-cell arrays of the view it was kept from until one of them
 * writes; a writer copies first, so no view observes another's write; loaded
 * field data is bounded in bytes. Each test pins the identities and values
 * that make those statements true.
 */

test('point transparency is exactly one byte a cell holding 0 or 1', () => {
  const ok = Uint8Array.from([0, 1, 1, 0]);
  assert.strictEqual(requirePointTransparency(ok, 4, 'T'), ok);
  assert.throws(
    () => requirePointTransparency(Float32Array.from([0, 1, 1, 0]), 4, 'T'),
    /T must be a Uint8Array with exactly 4 entries/
  );
  assert.throws(
    () => requirePointTransparency(Uint8Array.from([0, 1, 2, 0]), 4, 'T'),
    /T entry 2 must be exactly 0 or 1/
  );
  assert.throws(
    () => requirePointTransparency(Uint8Array.from([0, 1]), 4, 'T'),
    /exactly 4 entries/
  );
});

function twoViewState() {
  const colors = Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255]);
  const transparency = Uint8Array.from([1, 1]);
  const mask = Uint8Array.from([1, 1]);
  const live = {
    id: 'live',
    colorsArray: colors,
    categoryTransparency: transparency,
    cellVisibilityMask: mask,
  };
  const kept = { ...live, id: 'snap_1' };
  return {
    activeViewId: 'live',
    viewContexts: new Map([['live', live], ['snap_1', kept]]),
    colorsArray: colors,
    categoryTransparency: transparency,
    cellVisibilityMask: mask,
    kept,
  };
}

test('a write to a shared per-cell array copies it first and leaves the other view intact', () => {
  const state = twoViewState();
  const { kept } = state;

  const colors = writableColors(state);
  const transparency = writableTransparency(state);
  const mask = writableCellVisibilityMask(state);
  assert.notStrictEqual(colors, kept.colorsArray);
  assert.notStrictEqual(transparency, kept.categoryTransparency);
  assert.notStrictEqual(mask, kept.cellVisibilityMask);
  assert.deepEqual(Array.from(colors), Array.from(kept.colorsArray));

  colors.fill(9);
  transparency.fill(0);
  mask.fill(0);
  assert.deepEqual(Array.from(kept.colorsArray), [1, 2, 3, 255, 4, 5, 6, 255]);
  assert.deepEqual(Array.from(kept.categoryTransparency), [1, 1]);
  assert.deepEqual(Array.from(kept.cellVisibilityMask), [1, 1]);

  // Once the active view owns its arrays, later writes are in place.
  assert.strictEqual(writableColors(state), colors);
  assert.strictEqual(writableTransparency(state), transparency);
  assert.strictEqual(writableCellVisibilityMask(state), mask);
});

test('colors handed to a snapshot are frozen even when no other context holds them', () => {
  const colors = Uint8Array.from([1, 2, 3, 255]);
  const state = {
    activeViewId: 'snap_1',
    viewContexts: new Map([['snap_1', { id: 'snap_1', colorsArray: colors }]]),
    colorsArray: colors,
  };
  assert.strictEqual(writableColors(state), colors);
  markSnapshotPublishedColors(colors);
  const writable = writableColors(state);
  assert.notStrictEqual(writable, colors);
  assert.deepEqual(Array.from(writable), [1, 2, 3, 255]);
});

test('every transparency write moves the transparency epoch', () => {
  const state = twoViewState();
  const before = transparencyEpoch(state);
  writableTransparency(state);
  writableTransparency(state);
  assert.equal(transparencyEpoch(state), before + 2);
});

test('filtering the live view leaves a kept view sharing its transparency untouched', () => {
  const codes = Uint8Array.from([0, 1, 0, 1]);
  const field = {
    key: 'group',
    kind: 'category',
    categories: ['a', 'b'],
    codes,
    _categoryColors: [[1, 0, 0], [0, 1, 0]],
    _categoryVisible: { 0: true, 1: false },
    _categoryFilterEnabled: true,
  };
  const transparency = new Uint8Array(4).fill(1);
  const mask = new Uint8Array(4).fill(1);
  const colors = new Uint8Array(16).fill(255);
  const kept = {
    id: 'snap_1',
    colorsArray: colors,
    categoryTransparency: transparency,
    cellVisibilityMask: mask,
  };
  let pushes = 0;
  const state = Object.assign(Object.create(DataStateFilterMethods.prototype), {
    pointCount: 4,
    activeViewId: 'live',
    viewContexts: new Map([['live', { id: 'live' }], ['snap_1', kept]]),
    obsData: { fields: [field] },
    varData: { fields: [] },
    activeFieldSource: null,
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    categoryTransparency: transparency,
    cellVisibilityMask: mask,
    colorsArray: colors,
    ensureCategoryMetadata: DataStateColorMethods.prototype.ensureCategoryMetadata,
    _syncColorsAlpha: DataStateColorMethods.prototype._syncColorsAlpha,
    isOutlierFilterEnabledForActiveField: () => false,
    _updateActiveCategoryCounts: () => false,
    _pushColorsToViewer() { pushes += 1; },
    _pushTransparencyToViewer() {},
    _pushCentroidsToViewer() {},
    _syncActiveContext() {},
    updateFilteredCount() {},
    updateFilterSummary() {},
    _notifyVisibilityChange() {},
  });

  state.computeGlobalVisibility();

  assert.deepEqual(Array.from(state.categoryTransparency), [1, 0, 1, 0]);
  assert.notStrictEqual(state.categoryTransparency, transparency);
  assert.deepEqual(Array.from(kept.categoryTransparency), [1, 1, 1, 1]);
  // The alpha bytes of the shared colors moved to a live copy, which the live
  // viewer is handed because it holds the state's colors by reference.
  assert.notStrictEqual(state.colorsArray, colors);
  assert.deepEqual(Array.from(colors), new Array(16).fill(255));
  assert.equal(state.colorsArray[7], 0);
  assert.equal(pushes, 1);
  // The kept view also still shares the untouched mask.
  assert.strictEqual(state.cellVisibilityMask, kept.cellVisibilityMask);
});

test('a kept view context shares per-cell arrays and copies only centroids', () => {
  const source = {
    id: 'live',
    obsData: null,
    varData: null,
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    activeFieldSource: null,
    dimensionLevel: 2,
    colorsArray: new Uint8Array(8),
    categoryTransparency: new Uint8Array(2),
    cellVisibilityMask: new Uint8Array(2),
    centroidPositions: new Float32Array(3),
    centroidColors: new Uint8Array(4),
    centroidLabels: [],
    filteredCount: { shown: 2, total: 2 },
  };
  const state = Object.assign(Object.create(viewContextCoreMethods), {
    pointCount: 2,
  });
  const ctx = state._cloneViewContext(source, 'snap_1');
  assert.strictEqual(ctx.colorsArray, source.colorsArray);
  assert.strictEqual(ctx.categoryTransparency, source.categoryTransparency);
  assert.strictEqual(ctx.cellVisibilityMask, source.cellVisibilityMask);
  assert.notStrictEqual(ctx.centroidPositions, source.centroidPositions);
  assert.notStrictEqual(ctx.centroidColors, source.centroidColors);
  assert.equal(Object.hasOwn(ctx, 'outlierQuantilesArray'), false);
});

function countingState() {
  const codes = Uint8Array.from([0, 1, 1, 255]);
  const field = {
    key: 'group',
    kind: 'category',
    categories: ['a', 'b'],
    codes,
    _categoryVisible: { 0: true, 1: true },
  };
  const state = Object.assign(Object.create(FieldSummaryMethods.prototype), {
    pointCount: 4,
    activeViewId: 'live',
    obsData: { fields: [field] },
    varData: { fields: [] },
    activeFieldSource: 'obs',
    activeFieldIndex: 0,
    activeVarFieldIndex: -1,
    categoryTransparency: Uint8Array.from([1, 1, 0, 1]),
    isOutlierFilterEnabledForActiveField: () => false,
  });
  return { field, state };
}

test('an unchanged category-count question is answered once per visibility generation', () => {
  const { field, state } = countingState();
  const first = state.computeCategoryCountsForField(field);
  assert.deepEqual(first.total, [1, 2]);
  assert.deepEqual(first.visible, [1, 1]);
  assert.strictEqual(state.computeCategoryCountsForField(field), first);

  // A transparency write is a new generation.
  writableTransparency(state)[2] = 1;
  const second = state.computeCategoryCountsForField(field);
  assert.notStrictEqual(second, first);
  assert.deepEqual(second.visible, [1, 2]);

  // So is a filter on another field that changes what is available.
  const other = {
    key: 'score',
    kind: 'continuous',
    values: Float32Array.from([0, 1, 2, 3]),
    _filterEnabled: true,
    _continuousStats: { min: 0, max: 3 },
    _continuousFilter: { min: 1, max: 3 },
  };
  state.obsData.fields.push(other);
  const third = state.computeCategoryCountsForField(field);
  assert.notStrictEqual(third, second);
  assert.deepEqual(third.available, [0, 2]);
  assert.strictEqual(state.computeCategoryCountsForField(field), third);
  other._continuousFilter.min = 0;
  const fourth = state.computeCategoryCountsForField(field);
  assert.notStrictEqual(fourth, third);
  assert.deepEqual(fourth.available, [1, 2]);
});

function residencyState(budgetFields) {
  const bytes = 8;
  const make = (key, extra = {}) => ({
    key,
    kind: 'continuous',
    loaded: true,
    values: new Float32Array(bytes / 4),
    ...extra,
  });
  const fields = budgetFields.map(([key, extra]) => make(key, extra));
  const state = {
    activeViewId: 'live',
    activeFieldSource: 'obs',
    activeFieldIndex: 0,
    activeVarFieldIndex: -1,
    obsData: { fields },
    varData: { fields: [] },
    _fieldDataCache: new Map(),
    _varFieldDataCache: new Map(),
  };
  const kept = {
    id: 'snap_1',
    activeFieldSource: null,
    obsData: { fields: fields.map(field => ({ ...field })) },
    varData: { fields: [] },
  };
  state.viewContexts = new Map([['live', { id: 'live' }], ['snap_1', kept]]);
  for (const field of fields) {
    state._fieldDataCache.set(field.key, { values: field.values });
    touchFieldResidency(state, 'obs', field.key);
  }
  return { fields, kept, state };
}

test('inactive field data is released least recently used first beyond its byte budget', () => {
  const { fields, kept, state } = residencyState([
    ['active'],
    ['oldest'],
    ['filtered', {
      _continuousStats: { min: 0, max: 1 },
      _continuousFilter: { min: 0.5, max: 1 },
      _filterEnabled: false,
    }],
    ['middle'],
    ['newest'],
  ]);
  // Re-touch "middle" so "newest" becomes the older of the two remaining.
  touchFieldResidency(state, 'obs', 'middle');

  // Budget for one inactive 8-byte field.
  const released = releaseInactiveFieldsOverBudget(state, 8);
  assert.equal(released, 16);
  const resident = key => state._fieldDataCache.has(key);
  assert.equal(resident('active'), true, 'the active field is always resident');
  assert.equal(resident('filtered'), true, 'a field with filter state is always resident');
  assert.equal(resident('oldest'), false);
  assert.equal(resident('newest'), false);
  assert.equal(resident('middle'), true, 'the most recently used inactive field stays');

  const byKey = Object.fromEntries(fields.map(field => [field.key, field]));
  assert.equal(byKey.oldest.loaded, false);
  assert.equal(Object.hasOwn(byKey.oldest, 'values'), false);
  const keptOldest = kept.obsData.fields.find(field => field.key === 'oldest');
  assert.equal(keptOldest.loaded, false, 'every view releases the same field');
  assert.equal(Object.hasOwn(keptOldest, 'values'), false);
  assert.ok(byKey.middle.values instanceof Float32Array);
});

test('the inactive-field budget is a share of the reported device memory, and only a policy', () => {
  // 512 MiB where the browser reports 8 GiB or nothing (the long-standing value).
  assert.equal(residencyBudgetBytes('inactiveFields', { navigator: { deviceMemory: 8 } }), 512 * 1024 * 1024);
  assert.equal(residencyBudgetBytes('inactiveFields', {}), 512 * 1024 * 1024);
  assert.equal(residencyBudgetBytes('inactiveFields', { navigator: { deviceMemory: 4 } }), 256 * 1024 * 1024);
});
