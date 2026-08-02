import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DataStateFilterMethods,
} from '../assets/js/app/state/managers/filter-manager.js';
import {
  DataStateColorMethods,
} from '../assets/js/app/state/managers/color-manager.js';

// A state carrying exactly what setCellVisibility touches. computeGlobalVisibility
// is recorded rather than executed so these tests observe argument handling only;
// the end-to-end path through the real computeGlobalVisibility is asserted
// separately at the bottom of this file.
function stubState(pointCount, maskValues = null) {
  const state = Object.assign(Object.create(DataStateFilterMethods.prototype), {
    pointCount,
    cellVisibilityMask: new Float32Array(pointCount).fill(1),
    recomputes: 0,
    computeGlobalVisibility() {
      this.recomputes++;
    },
  });
  if (maskValues !== null) state.cellVisibilityMask.set(maskValues);
  return state;
}

function liveState(pointCount) {
  return Object.assign(Object.create(DataStateFilterMethods.prototype), {
    pointCount,
    obsData: { fields: [] },
    varData: { fields: [] },
    activeFieldSource: null,
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    categoryTransparency: new Float32Array(pointCount).fill(1),
    cellVisibilityMask: new Float32Array(pointCount).fill(1),
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
}

test('cell visibility keeps rejecting every malformed boxed-array selection', () => {
  const state = stubState(8);

  assert.throws(
    () => state.setCellVisibility([0], 'yes'),
    /Cell visibility must be exactly true or false\./,
  );
  assert.throws(
    () => state.setCellVisibility([0], undefined),
    /Cell visibility must be exactly true or false\./,
  );

  const shortMask = stubState(8);
  shortMask.cellVisibilityMask = new Float32Array(4);
  assert.throws(
    () => shortMask.setCellVisibility([0], true),
    /Cell visibility requires a complete current dataset mask\./,
  );
  const wrongMask = stubState(8);
  wrongMask.cellVisibilityMask = new Array(8).fill(1);
  assert.throws(
    () => wrongMask.setCellVisibility([0], true),
    /Cell visibility requires a complete current dataset mask\./,
  );

  // Containers that are neither an array, a typed array, nor null.
  for (const container of [
    'abc',
    5,
    undefined,
    { length: 1, 0: 0 },
    new Set([0]),
    new Map(),
    new DataView(new ArrayBuffer(8)),
    { length: 1, 0: 0, BYTES_PER_ELEMENT: 4 },
  ]) {
    assert.throws(
      () => state.setCellVisibility(container, false),
      /Cell visibility indices must be an array, a typed array, or null\./,
      `container ${String(container)} must be rejected`,
    );
  }

  // Holes.
  const holed = [];
  holed.length = 2;
  holed[1] = 1;
  assert.throws(
    () => state.setCellVisibility(holed, false),
    /Cell visibility index 0 must be a non-negative integer\./,
  );

  // Non-integers, including values a Float64Array can also carry.
  for (const [bad, label] of [
    [1.5, 'fraction'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    ['0', 'numeric string'],
    [null, 'null'],
    [undefined, 'undefined'],
    [{}, 'object'],
    [1n, 'bigint'],
    [true, 'boolean'],
  ]) {
    assert.throws(
      () => state.setCellVisibility([bad], false),
      /Cell visibility index 0 must be a non-negative integer\./,
      `${label} must be rejected`,
    );
  }

  assert.throws(
    () => state.setCellVisibility([-1], false),
    /Cell visibility index 0 must be a non-negative integer\./,
  );
  assert.throws(
    () => state.setCellVisibility([0, 1, -3], false),
    /Cell visibility index 2 must be a non-negative integer\./,
  );

  assert.throws(
    () => state.setCellVisibility([8], false),
    /Cell visibility index 8 is outside the current point count\./,
  );
  assert.throws(
    () => state.setCellVisibility([0, 99], false),
    /Cell visibility index 99 is outside the current point count\./,
  );

  assert.throws(
    () => state.setCellVisibility([1, 1], false),
    /Cell visibility indices must not contain duplicates\./,
  );
  assert.throws(
    () => state.setCellVisibility([0, 3, 5, 3], false),
    /Cell visibility indices must not contain duplicates\./,
  );

  // Every rejection above left the mask untouched.
  assert.deepEqual(Array.from(state.cellVisibilityMask), [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(state.recomputes, 0);
});

test('cell visibility still refuses values inherited from Array.prototype', () => {
  // The Object.hasOwn guard exists for this: a hole whose read resolves to a
  // perfectly valid index through the prototype chain.
  const state = stubState(8);
  const holed = [];
  holed.length = 2;
  holed[1] = 1;
  Object.defineProperty(Array.prototype, 0, {
    value: 0,
    configurable: true,
    writable: true,
  });
  try {
    assert.equal(holed[0], 0, 'fixture must read a valid index through the prototype');
    assert.equal(Object.hasOwn(holed, 0), false);
    assert.throws(
      () => state.setCellVisibility(holed, false),
      /Cell visibility index 0 must be a non-negative integer\./,
    );
  } finally {
    delete Array.prototype[0];
  }
  assert.deepEqual(Array.from(state.cellVisibilityMask), [1, 1, 1, 1, 1, 1, 1, 1]);
});

test('cell visibility rejects the same malformed values inside typed arrays', () => {
  const state = stubState(8);

  for (const [indices, pattern, label] of [
    [Float64Array.from([1.5]), /index 0 must be a non-negative integer\./, 'fraction'],
    [Float64Array.from([Number.NaN]), /index 0 must be a non-negative integer\./, 'NaN'],
    [
      Float64Array.from([Number.POSITIVE_INFINITY]),
      /index 0 must be a non-negative integer\./,
      'Infinity',
    ],
    [Float32Array.from([2.5]), /index 0 must be a non-negative integer\./, 'float32 fraction'],
    [Int32Array.from([-1]), /index 0 must be a non-negative integer\./, 'negative int32'],
    [Int8Array.from([0, -2]), /index 1 must be a non-negative integer\./, 'negative int8'],
    [BigInt64Array.from([1n]), /index 0 must be a non-negative integer\./, 'bigint'],
    [BigUint64Array.from([1n]), /index 0 must be a non-negative integer\./, 'unsigned bigint'],
    [Uint32Array.from([8]), /index 8 is outside the current point count\./, 'out of range'],
    [
      Uint16Array.from([0, 4000]),
      /index 4000 is outside the current point count\./,
      'out of range uint16',
    ],
    [Uint32Array.from([1, 1]), /must not contain duplicates\./, 'duplicate'],
    [Uint8Array.from([0, 3, 5, 3]), /must not contain duplicates\./, 'late duplicate'],
  ]) {
    assert.throws(
      () => state.setCellVisibility(indices, false),
      pattern,
      `${label} must be rejected`,
    );
  }

  assert.deepEqual(Array.from(state.cellVisibilityMask), [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(state.recomputes, 0);
});

test('cell visibility keeps the original error precedence', () => {
  const state = stubState(8);
  // Duplicate reached before the negative -> duplicate wins.
  assert.throws(
    () => state.setCellVisibility([5, 5, -1], false),
    /Cell visibility indices must not contain duplicates\./,
  );
  // Negative reached first -> the per-element message wins.
  assert.throws(
    () => state.setCellVisibility([5, -1, 5], false),
    /Cell visibility index 1 must be a non-negative integer\./,
  );
  // Out of range reached before the duplicate.
  assert.throws(
    () => state.setCellVisibility([5, 99, 5], false),
    /Cell visibility index 99 is outside the current point count\./,
  );
  // Out of range reported by value; the per-element failures report position.
  assert.throws(
    () => state.setCellVisibility([0, 1, 2, 400], false),
    /Cell visibility index 400 is outside the current point count\./,
  );
});

test('cell visibility treats -0 and 0 as the same index in both container forms', () => {
  const boxed = stubState(4);
  assert.throws(
    () => boxed.setCellVisibility([-0, 0], false),
    /Cell visibility indices must not contain duplicates\./,
  );
  boxed.setCellVisibility([-0], false);
  assert.deepEqual(Array.from(boxed.cellVisibilityMask), [0, 1, 1, 1]);

  const typed = stubState(4);
  typed.setCellVisibility(Float64Array.from([-0]), false);
  assert.deepEqual(Array.from(typed.cellVisibilityMask), [0, 1, 1, 1]);
  assert.throws(
    () => typed.setCellVisibility(Float64Array.from([-0, 0]), false),
    /Cell visibility indices must not contain duplicates\./,
  );
});

test('cell visibility produces identical masks for boxed and typed selections', () => {
  const selections = [
    [],
    [0],
    [3, 1, 6],
    [7, 6, 5, 4, 3, 2, 1, 0],
    [2, 5],
  ];
  for (const selection of selections) {
    for (const TypedArray of [Uint8Array, Uint16Array, Uint32Array, Int32Array, Float64Array]) {
      for (const visible of [true, false]) {
        const boxed = stubState(8, [1, 0, 1, 0, 1, 1, 0, 1]);
        const typed = stubState(8, [1, 0, 1, 0, 1, 1, 0, 1]);
        boxed.setCellVisibility(selection, visible);
        typed.setCellVisibility(TypedArray.from(selection), visible);
        assert.deepEqual(
          Array.from(typed.cellVisibilityMask),
          Array.from(boxed.cellVisibilityMask),
          `${TypedArray.name} ${JSON.stringify(selection)} visible=${visible}`,
        );
        assert.equal(typed.recomputes, boxed.recomputes);
      }
    }
  }
});

test('cell visibility reaches indices at every edge of the mask', () => {
  // Exercises the low/high end of the selection range, including point counts
  // that are not a multiple of eight.
  for (const pointCount of [1, 7, 8, 9, 15, 16, 17, 1000, 1023]) {
    for (const pick of [
      [0],
      [pointCount - 1],
      [0, pointCount - 1],
      [pointCount - 2, pointCount - 1].filter(i => i >= 0),
      Array.from({ length: pointCount }, (_, i) => i),
    ]) {
      const unique = [...new Set(pick)];
      const boxed = stubState(pointCount);
      const typed = stubState(pointCount);
      boxed.setCellVisibility(unique, false);
      typed.setCellVisibility(Uint32Array.from(unique), false);
      const expected = new Array(pointCount).fill(1);
      for (const i of unique) expected[i] = 0;
      assert.deepEqual(
        Array.from(boxed.cellVisibilityMask),
        expected,
        `boxed pointCount=${pointCount} pick=${JSON.stringify(unique)}`,
      );
      assert.deepEqual(
        Array.from(typed.cellVisibilityMask),
        expected,
        `typed pointCount=${pointCount} pick=${JSON.stringify(unique)}`,
      );
    }
  }

  // An empty selection touches nothing at any dataset size.
  for (const pointCount of [0, 1, 8, 1000]) {
    const empty = stubState(pointCount);
    empty.setCellVisibility([], false);
    assert.deepEqual(Array.from(empty.cellVisibilityMask), new Array(pointCount).fill(1));
    empty.setCellVisibility(new Uint32Array(0), false);
    assert.deepEqual(Array.from(empty.cellVisibilityMask), new Array(pointCount).fill(1));
    assert.equal(empty.recomputes, 2);
  }
});

test('cell visibility still fills the whole mask for a null selection', () => {
  const hide = stubState(5, [1, 0, 1, 1, 0]);
  hide.setCellVisibility(null, false);
  assert.deepEqual(Array.from(hide.cellVisibilityMask), [0, 0, 0, 0, 0]);
  assert.equal(hide.recomputes, 1);

  const show = stubState(5, [1, 0, 1, 1, 0]);
  show.setCellVisibility(null, true);
  assert.deepEqual(Array.from(show.cellVisibilityMask), [1, 1, 1, 1, 1]);
});

test('cell visibility writes nothing when a later index fails validation', () => {
  for (const selection of [
    [0, 1, 99],
    [0, 1, -4],
    [0, 1, 1],
    [0, 1, 2.5],
  ]) {
    const boxed = stubState(8, [1, 1, 1, 1, 1, 1, 1, 1]);
    assert.throws(() => boxed.setCellVisibility(selection, false));
    assert.deepEqual(
      Array.from(boxed.cellVisibilityMask),
      [1, 1, 1, 1, 1, 1, 1, 1],
      `boxed ${JSON.stringify(selection)} must not partially apply`,
    );
    assert.equal(boxed.recomputes, 0);

    const typed = stubState(8, [1, 1, 1, 1, 1, 1, 1, 1]);
    assert.throws(() => typed.setCellVisibility(Float64Array.from(selection), false));
    assert.deepEqual(
      Array.from(typed.cellVisibilityMask),
      [1, 1, 1, 1, 1, 1, 1, 1],
      `typed ${JSON.stringify(selection)} must not partially apply`,
    );
    assert.equal(typed.recomputes, 0);
  }
});

test('cell visibility validates a selection larger than the Set entry ceiling', () => {
  // V8 caps Set at 2**24 entries, so a Set-based duplicate check cannot even
  // complete a selection this size - it throws "Set maximum size exceeded"
  // before reaching the mask.
  const pointCount = 2 ** 24 + 1;
  const state = stubState(pointCount);
  const selection = new Uint32Array(pointCount);
  for (let i = 0; i < pointCount; i++) selection[i] = i;

  state.setCellVisibility(selection, false);
  assert.equal(state.recomputes, 1);
  assert.equal(state.cellVisibilityMask[0], 0);
  assert.equal(state.cellVisibilityMask[1], 0);
  assert.equal(state.cellVisibilityMask[pointCount - 1], 0);
  assert.equal(state.cellVisibilityMask.indexOf(1), -1);

  // The same oversized selection still rejects a duplicate.
  selection[pointCount - 1] = 0;
  assert.throws(
    () => state.setCellVisibility(selection, true),
    /Cell visibility indices must not contain duplicates\./,
  );
  assert.equal(state.cellVisibilityMask.indexOf(1), -1, 'the failed call wrote nothing');
});

test('cell visibility allocates nothing proportional to the selection length', () => {
  const pointCount = 1_000_000;
  const state = stubState(pointCount);
  const selection = new Uint32Array(pointCount);
  for (let i = 0; i < pointCount; i++) selection[i] = i;
  const boxed = Array.from(selection);

  const NativeSet = globalThis.Set;
  let setsConstructed = 0;
  class CountingSet extends NativeSet {
    constructor(...args) {
      super(...args);
      setsConstructed++;
    }
  }
  const nativePush = Array.prototype.push;
  let pushes = 0;
  // eslint-disable-next-line no-extend-native
  Array.prototype.push = function countingPush(...args) {
    pushes++;
    return nativePush.apply(this, args);
  };
  globalThis.Set = CountingSet;

  let typedHeapDelta = 0;
  let boxedHeapDelta = 0;
  try {
    let before = process.memoryUsage().heapUsed;
    state.setCellVisibility(selection, false);
    typedHeapDelta = process.memoryUsage().heapUsed - before;

    before = process.memoryUsage().heapUsed;
    state.setCellVisibility(boxed, true);
    boxedHeapDelta = process.memoryUsage().heapUsed - before;
  } finally {
    globalThis.Set = NativeSet;
    // eslint-disable-next-line no-extend-native
    Array.prototype.push = nativePush;
  }

  // No hash set and no boxed accumulator: the old shape allocated one Set plus
  // one pushed-into array per call, i.e. 1_000_000 pushes each.
  assert.equal(setsConstructed, 0, 'no Set may be constructed');
  assert.equal(pushes, 0, 'no per-index push may occur');

  // Byte evidence: the only allocation is one Uint8Array of ceil(n/8) bytes.
  // The old shape grew the JS heap by tens of megabytes per call.
  const budget = 4 * 1024 * 1024;
  assert.ok(
    typedHeapDelta < budget,
    `typed-array call grew the heap by ${typedHeapDelta} bytes, expected < ${budget}`,
  );
  assert.ok(
    boxedHeapDelta < budget,
    `boxed-array call grew the heap by ${boxedHeapDelta} bytes, expected < ${budget}`,
  );

  assert.equal(state.cellVisibilityMask.indexOf(0), -1);
});

test('a typed-array selection flows through the real computeGlobalVisibility', () => {
  const boxed = liveState(6);
  const typed = liveState(6);

  boxed.setCellVisibility([1, 4], false);
  typed.setCellVisibility(Uint32Array.from([1, 4]), false);

  assert.deepEqual(Array.from(boxed.cellVisibilityMask), [1, 0, 1, 1, 0, 1]);
  assert.deepEqual(
    Array.from(typed.cellVisibilityMask),
    Array.from(boxed.cellVisibilityMask),
  );
  assert.deepEqual(Array.from(typed.categoryTransparency), [1, 0, 1, 1, 0, 1]);
  assert.deepEqual(
    Array.from(typed.categoryTransparency),
    Array.from(boxed.categoryTransparency),
  );
  assert.deepEqual(
    Array.from(typed.colorsArray),
    Array.from(boxed.colorsArray),
  );

  typed.setCellVisibility(Int32Array.from([1]), true);
  assert.deepEqual(Array.from(typed.cellVisibilityMask), [1, 1, 1, 1, 0, 1]);
  assert.deepEqual(Array.from(typed.categoryTransparency), [1, 1, 1, 1, 0, 1]);
});
