import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DataStateColorMethods,
} from '../assets/js/app/state/managers/color-manager.js';
import {
  DataStateFilterMethods,
} from '../assets/js/app/state/managers/filter-manager.js';
import {
  writableCellVisibilityMask,
  writableTransparency as writableTransparencyOf,
} from '../assets/js/app/state/managers/per-cell-array-ownership.js';
import {
  DataStateViewMethods,
} from '../assets/js/app/state/managers/view-manager.js';

/**
 * Cost contract for `computeGlobalVisibility`.
 *
 * Hiding eight cells out of ten million costs the same as hiding five million
 * because the apply path walks the whole dataset several times over. These
 * tests pin the traversal shape itself — how many times each dataset-length
 * array is read, and whether the unfiltered publication is one typed-array copy
 * or a per-element loop — so a later regression is a test failure rather than a
 * benchmark regression nobody runs.
 *
 * They count operations, never time, so they are unaffected by machine load.
 */

/** A Float32Array whose element reads are counted. Passes `instanceof`. */
function countingFloat32(values) {
  const target = Float32Array.from(values);
  const counter = { reads: 0 };
  const proxy = new Proxy(target, {
    get(object, property) {
      if (typeof property === 'string') {
        const index = Number(property);
        if (Number.isInteger(index) && index >= 0) counter.reads++;
      }
      // The typed array itself must stay the receiver: `length` and the other
      // %TypedArray% accessors reject a proxy receiver outright.
      const value = Reflect.get(object, property, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
  return { counter, proxy, target };
}

function continuousState({ mask, values, filter }) {
  const pointCount = mask.length;
  const counted = countingFloat32(values);
  const field = {
    key: 'score',
    kind: 'continuous',
    values: counted.proxy,
    _filterEnabled: true,
    _continuousStats: {
      min: Math.min(...values),
      max: Math.max(...values),
    },
    _continuousFilter: { min: filter.min, max: filter.max },
  };
  const state = Object.assign(Object.create(DataStateFilterMethods.prototype), {
    pointCount,
    obsData: { fields: [field] },
    varData: { fields: [] },
    activeFieldSource: null,
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    categoryTransparency: new Uint8Array(pointCount).fill(1),
    cellVisibilityMask: Uint8Array.from(mask),
    colorsArray: new Uint8Array(pointCount * 4).fill(255),
    _syncColorsAlpha: DataStateColorMethods.prototype._syncColorsAlpha,
    ensureContinuousMetadata:
      DataStateColorMethods.prototype.ensureContinuousMetadata,
    isOutlierFilterEnabledForActiveField: () => false,
    getCurrentOutlierThreshold: () => 1,
    _updateActiveCategoryCounts: () => false,
    _pushTransparencyToViewer() {},
    _pushCentroidsToViewer() {},
    _syncActiveContext() {},
    updateFilteredCount() {},
    updateFilterSummary() {},
    _notifyVisibilityChange() {},
  });
  return { counter: counted.counter, field, state };
}

test('filter predicates are not evaluated for cells the visibility mask already hides', () => {
  const values = [0, 1, 2, 3, 4, 5, 6, 7];
  const mask = [1, 0, 0, 1, 0, 0, 0, 1];
  const { counter, state } = continuousState({
    filter: { max: 6, min: 1 },
    mask,
    values,
  });
  const pointCount = values.length;
  const visible = mask.filter(entry => entry === 1).length;

  counter.reads = 0;
  state.computeGlobalVisibility();

  // `ensureContinuousMetadata` re-derives min/max over the whole field on every
  // filter change, which is one unavoidable full pass here. The filter
  // predicate itself must only look at cells the mask still admits.
  assert.equal(
    counter.reads,
    pointCount + visible,
    'the continuous predicate must read only unmasked cells',
  );
  assert.deepEqual(
    Array.from(state.categoryTransparency),
    [0, 0, 0, 1, 0, 0, 0, 0],
  );
});

/** A Uint8Array whose element reads are counted. Passes `instanceof`. */
function countingUint8(values) {
  const target = Uint8Array.from(values);
  const counter = { reads: 0 };
  const proxy = new Proxy(target, {
    get(object, property) {
      if (typeof property === 'string') {
        const index = Number(property);
        if (Number.isInteger(index) && index >= 0) counter.reads++;
      }
      const value = Reflect.get(object, property, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
  return { counter, proxy };
}

test('the unfiltered publication is one pass: visibility, packed alpha and the shown count', () => {
  const mask = [1, 0, 1, 1, 0, 1, 1, 1];
  const pointCount = mask.length;
  const counted = countingUint8(mask);
  const state = Object.assign(Object.create(DataStateFilterMethods.prototype), {
    pointCount,
    obsData: { fields: [] },
    varData: { fields: [] },
    activeFieldSource: null,
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    categoryTransparency: new Uint8Array(pointCount).fill(1),
    cellVisibilityMask: counted.proxy,
    colorsArray: new Uint8Array(pointCount * 4).fill(255),
    isOutlierFilterEnabledForActiveField: () => false,
    getCurrentOutlierThreshold: () => 1,
    _updateActiveCategoryCounts: () => false,
    _pushTransparencyToViewer() {},
    _pushCentroidsToViewer() {},
    _syncActiveContext() {},
    updateFilterSummary() {},
    _notifyVisibilityChange() {},
  });

  const nativeFill = Uint8Array.prototype.fill;
  const nativeSet = Uint8Array.prototype.set;
  const bulkWrites = [];
  Uint8Array.prototype.fill = function countingFill(...args) {
    bulkWrites.push(this);
    return nativeFill.apply(this, args);
  };
  Uint8Array.prototype.set = function countingSet(...args) {
    bulkWrites.push(this);
    return nativeSet.apply(this, args);
  };
  try {
    state.computeGlobalVisibility();
    // The first computation proves the mask binary (one read a cell) and
    // applies it (one more); a second one with the same inputs adopts the
    // first one's result and reads nothing.
    assert.equal(counted.counter.reads, 2 * pointCount);
    counted.counter.reads = 0;
    state.computeGlobalVisibility();
    assert.equal(counted.counter.reads, 0);
    // A mask handed out for writing is proven and applied again.
    assert.equal(writableCellVisibilityMask(state), counted.proxy);
    state.computeGlobalVisibility();
    assert.equal(counted.counter.reads, 2 * pointCount);
  } finally {
    Uint8Array.prototype.fill = nativeFill;
    Uint8Array.prototype.set = nativeSet;
  }

  assert.equal(bulkWrites.length, 0, 'no fill or copy runs beside the pass');
  assert.deepEqual(Array.from(state.categoryTransparency), mask);
  assert.deepEqual(
    Array.from(state.colorsArray).filter((_, i) => i % 4 === 3),
    mask.map(entry => entry * 255),
  );
  const shown = mask.filter(entry => entry === 1).length;
  assert.deepEqual(state.filteredCount, { shown, total: pointCount });
});

test('every mask and filter shape produces the identical published generation', () => {
  // An identity guard: it passes against the current implementation too. It
  // exists so a traversal change cannot alter a single published value.
  const pointCount = 24;
  const values = Array.from({ length: pointCount }, (_, index) => index);
  const maskShapes = {
    all: () => 1,
    contiguous: index => (index >= 6 && index < 12 ? 0 : 1),
    half: index => (index < pointCount / 2 ? 0 : 1),
    none: () => 0,
    one: index => (index === 5 ? 0 : 1),
    scatter: index => (index % 7 === 3 ? 0 : 1),
  };
  const filterShapes = {
    full: { max: pointCount - 1, min: 0 },
    narrow: { max: 12, min: 10 },
    upper: { max: pointCount - 1, min: 8 },
  };

  for (const [maskName, maskAt] of Object.entries(maskShapes)) {
    for (const [filterName, filter] of Object.entries(filterShapes)) {
      const mask = Array.from({ length: pointCount }, (_, i) => maskAt(i));
      const { state } = continuousState({ filter, mask, values });
      state.computeGlobalVisibility();

      const fullRange =
        filter.min === 0 && filter.max === pointCount - 1;
      const expected = mask.map((entry, index) => {
        if (entry === 0) return 0;
        if (fullRange) return 1;
        return values[index] >= filter.min && values[index] <= filter.max
          ? 1
          : 0;
      });
      assert.deepEqual(
        Array.from(state.categoryTransparency),
        expected,
        `${maskName}/${filterName} transparency`,
      );
      const expectedAlpha = expected.map(entry => entry * 255);
      assert.deepEqual(
        Array.from(state.colorsArray).filter((_, i) => i % 4 === 3),
        expectedAlpha,
        `${maskName}/${filterName} packed alpha`,
      );
    }
  }
});

test('a mask value that is neither zero nor one is still rejected before anything is published', () => {
  const mask = [1, 1, 2, 1];
  const { state } = continuousState({
    filter: { max: 3, min: 0 },
    mask,
    values: [0, 1, 2, 3],
  });
  const before = Array.from(state.categoryTransparency);
  assert.throws(
    () => state.computeGlobalVisibility(),
    /Cell visibility mask entry 2 must be exactly 0 or 1\./,
  );
  assert.deepEqual(
    Array.from(state.categoryTransparency),
    before,
    'a rejected mask must leave the published generation untouched',
  );
});

function categoryFilterState(pointCount, codes, hidden) {
  const field = {
    key: 'cluster',
    kind: 'category',
    categories: ['a', 'b', 'c'],
    codes: Uint8Array.from(codes),
    _categoryVisible: [true, true, true],
    _categoryFilterEnabled: true,
  };
  for (const index of hidden) field._categoryVisible[index] = false;
  const state = Object.assign(Object.create(DataStateFilterMethods.prototype), {
    pointCount,
    obsData: { fields: [field] },
    varData: { fields: [] },
    activeFieldSource: null,
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    activeViewId: 'live',
    viewContexts: new Map(),
    categoryTransparency: new Uint8Array(pointCount).fill(1),
    cellVisibilityMask: new Uint8Array(pointCount).fill(1),
    colorsArray: new Uint8Array(pointCount * 4).fill(255),
    isOutlierFilterEnabledForActiveField: () => false,
    getCurrentOutlierThreshold: () => 1,
    ensureCategoryMetadata() {},
    _updateActiveCategoryCounts: () => false,
    _pushTransparencyToViewer() {},
    _pushCentroidsToViewer() {},
    _pushColorsToViewer() {},
    _syncActiveContext() {},
    updateFilterSummary() {},
    _notifyVisibilityChange() {},
  });
  return { state, field };
}

test('a view with the same filters as a kept view adopts its visibility instead of recomputing it', () => {
  const codes = [0, 1, 2, 0, 1, 2, 0, 1];
  const pointCount = codes.length;
  const { state, field } = categoryFilterState(pointCount, codes, [1]);
  state.computeGlobalVisibility();
  const expected = Array.from(state.categoryTransparency);
  assert.deepEqual(expected, [1, 0, 1, 1, 0, 1, 1, 0]);

  // Keep the view: the kept context holds the live arrays, so the next write
  // on the live view goes to a copy.
  const kept = state.categoryTransparency;
  state.viewContexts.set('snap_1', { categoryTransparency: kept });
  state.categoryTransparency = new Uint8Array(pointCount).fill(1);
  state.colorsArray = new Uint8Array(pointCount * 4).fill(255);

  // The same filters reached by another route (a session view's replay
  // rebuilds the per-code tables): adopted from the kept view, by copy.
  field._categoryVisible = [true, false, true];
  state.computeGlobalVisibility();
  assert.notEqual(state.categoryTransparency, kept);
  assert.deepEqual(Array.from(state.categoryTransparency), expected);
  assert.deepEqual(
    Array.from(state.colorsArray).filter((_, i) => i % 4 === 3),
    expected.map(entry => entry * 255),
  );
  assert.deepEqual(state.filteredCount, { shown: 5, total: pointCount });

  // Different filters compute, and leave the kept view's array untouched.
  field._categoryVisible = [false, true, true];
  state.computeGlobalVisibility();
  assert.deepEqual(Array.from(state.categoryTransparency), [0, 1, 1, 0, 1, 1, 0, 1]);
  assert.deepEqual(Array.from(kept), expected);
});

test('a result is not adopted once its array was written again', () => {
  const codes = [0, 1, 2, 0];
  const { state, field } = categoryFilterState(codes.length, codes, [0]);
  state.computeGlobalVisibility();
  assert.deepEqual(Array.from(state.categoryTransparency), [0, 1, 1, 0]);
  // A recolour writes the array outside a visibility pass (through the
  // ownership module, as every writer does).
  state.categoryTransparency.fill(1);
  writableTransparencyOf(state);
  state.computeGlobalVisibility();
  assert.deepEqual(Array.from(state.categoryTransparency), [0, 1, 1, 0]);
  assert.equal(field._categoryVisible[0], false);
});

test('inside a batch the visibility pass runs once, at its end', () => {
  const codes = [0, 1, 2, 0];
  const { state, field } = categoryFilterState(codes.length, codes, []);
  let passes = 0;
  state._notifyVisibilityChange = () => { passes++; };
  Object.assign(state, {
    _batchDepth: 0,
    _batchMode: false,
    _batchDirty: { visibility: false, colors: false, affectedFields: new Set() },
    beginBatch: DataStateViewMethods.prototype.beginBatch,
    endBatch: DataStateViewMethods.prototype.endBatch,
  });
  state.beginBatch();
  state.computeGlobalVisibility();
  field._categoryVisible[2] = false;
  state.computeGlobalVisibility();
  assert.equal(passes, 0);
  state.endBatch();
  assert.equal(passes, 1);
  assert.deepEqual(Array.from(state.categoryTransparency), [1, 1, 0, 1]);
});
