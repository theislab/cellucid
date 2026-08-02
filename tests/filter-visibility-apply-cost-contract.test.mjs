import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DataStateColorMethods,
} from '../assets/js/app/state/managers/color-manager.js';
import {
  DataStateFilterMethods,
} from '../assets/js/app/state/managers/filter-manager.js';

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
    categoryTransparency: new Float32Array(pointCount).fill(1),
    cellVisibilityMask: Float32Array.from(mask),
    colorsArray: new Uint8Array(pointCount * 4).fill(255),
    outlierQuantilesArray: new Float32Array(pointCount).fill(-1),
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

test('the unfiltered publication copies the mask instead of filling and then re-walking it', () => {
  const mask = [1, 0, 1, 1, 0, 1, 1, 1];
  const pointCount = mask.length;
  const state = Object.assign(Object.create(DataStateFilterMethods.prototype), {
    pointCount,
    obsData: { fields: [] },
    varData: { fields: [] },
    activeFieldSource: null,
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    categoryTransparency: new Float32Array(pointCount).fill(1),
    cellVisibilityMask: Float32Array.from(mask),
    colorsArray: new Uint8Array(pointCount * 4).fill(255),
    outlierQuantilesArray: new Float32Array(pointCount).fill(-1),
    _syncColorsAlpha: DataStateColorMethods.prototype._syncColorsAlpha,
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

  const nativeFill = Float32Array.prototype.fill;
  const nativeSet = Float32Array.prototype.set;
  const fills = [];
  const sets = [];
  Float32Array.prototype.fill = function countingFill(...args) {
    fills.push({ args, target: this });
    return nativeFill.apply(this, args);
  };
  Float32Array.prototype.set = function countingSet(...args) {
    sets.push({ args, target: this });
    return nativeSet.apply(this, args);
  };
  try {
    state.computeGlobalVisibility();
  } finally {
    Float32Array.prototype.fill = nativeFill;
    Float32Array.prototype.set = nativeSet;
  }

  const transparencyFills = fills.filter(
    entry => entry.target === state.categoryTransparency,
  );
  const transparencyCopies = sets.filter(
    entry => entry.target === state.categoryTransparency,
  );
  assert.equal(
    transparencyFills.length,
    0,
    'the unfiltered path must not fill the whole array and then re-walk it',
  );
  assert.equal(transparencyCopies.length, 1);
  assert.equal(transparencyCopies[0].args.length, 1);
  assert.strictEqual(
    transparencyCopies[0].args[0],
    state.cellVisibilityMask,
    'the copy source must be exactly the cell visibility mask',
  );
  assert.deepEqual(Array.from(state.categoryTransparency), mask);
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
  const mask = [1, 1, 0.5, 1];
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
