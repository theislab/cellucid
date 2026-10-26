import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeCentroidsForDimension,
  computeCentroidsForDimensionInSlices,
} from '../assets/js/app/registries/user-defined-fields/centroids.js';
import { DataStateColorMethods } from '../assets/js/app/state/managers/color-manager.js';
import { DataStateFilterMethods } from '../assets/js/app/state/managers/filter-manager.js';
import { FieldSummaryMethods, prepareCategoryTotals } from '../assets/js/app/state/managers/field/summary.js';
import {
  createShownCellVisibilityMask,
  writableCellVisibilityMask,
} from '../assets/js/app/state/managers/per-cell-array-ownership.js';

/**
 * Activating a category field of a large dataset does its dataset-length
 * work (centroids for the shown layout, per-category totals) ahead, in
 * slices, and the visible counts of an unfiltered or self-filtered field are
 * read from the totals. Each result must be the one the single pass gives.
 */

function lcg(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

function dataset(n, categoryCount, Codes, missing, seed) {
  const random = lcg(seed);
  const codes = new Codes(n);
  for (let i = 0; i < n; i++) codes[i] = random() < 0.02 ? missing : Math.floor(random() * categoryCount);
  const categories = Array.from({ length: categoryCount }, (_, k) => `c${k}`);
  return { codes, categories, random };
}

const immediately = () => new Promise(resolve => setImmediate(resolve));

test('centroids computed in slices are the single pass, in every dimension and code width', async () => {
  // More cells than one look at the clock covers, so the pass yields.
  const n = 600_000;
  for (const [Codes, missing] of [[Uint8Array, 0xff], [Uint16Array, 0xffff], [Uint32Array, 0xffffffff]]) {
    for (const dim of [1, 2, 3]) {
      const { codes, categories, random } = dataset(n, 13, Codes, missing, dim * 7 + Codes.BYTES_PER_ELEMENT);
      const positions = new Float32Array(n * dim);
      for (let i = 0; i < positions.length; i++) positions[i] = random() * 2 - 1;
      let yields = 0;
      const sliced = await computeCentroidsForDimensionInSlices(codes, categories, positions, dim, {
        sliceMs: 0,
        yieldToMacrotask: () => { yields++; return immediately(); },
      });
      assert.ok(yields > 0, 'the pass yielded');
      assert.deepEqual(sliced, computeCentroidsForDimension(codes, categories, positions, dim));
    }
  }
});

test('a sliced centroid pass refuses what the single pass refuses, with its message', async () => {
  const categories = ['a', 'b'];
  const options = { sliceMs: 0, yieldToMacrotask: immediately };
  const badCode = Uint8Array.from([0, 1, 7, 0]);
  const positions = new Float32Array(8);
  assert.throws(() => computeCentroidsForDimension(badCode, categories, positions, 2), /code 2 is outside/);
  await assert.rejects(computeCentroidsForDimensionInSlices(badCode, categories, positions, 2, options), /code 2 is outside/);
  const nan = new Float32Array(8);
  nan[5] = Number.NaN;
  const codes = Uint8Array.from([0, 1, 0, 1]);
  assert.throws(() => computeCentroidsForDimension(codes, categories, nan, 2), /position 2, axis 1 must be finite/);
  await assert.rejects(computeCentroidsForDimensionInSlices(codes, categories, nan, 2, options), /position 2, axis 1 must be finite/);
  const aborted = AbortSignal.abort(new Error('stopped'));
  const many = new Uint8Array(600_000);
  await assert.rejects(
    computeCentroidsForDimensionInSlices(many, categories, new Float32Array(600_000), 1, { ...options, signal: aborted }),
    /stopped/
  );
});

function countState(n, field) {
  const methods = [DataStateFilterMethods, FieldSummaryMethods, DataStateColorMethods];
  const state = {};
  for (const Methods of methods) {
    for (const name of Object.getOwnPropertyNames(Methods.prototype)) {
      if (name !== 'constructor') state[name] = Methods.prototype[name];
    }
  }
  return Object.assign(state, {
    pointCount: n,
    obsData: { fields: [field] },
    varData: { fields: [] },
    activeFieldSource: 'obs',
    activeFieldIndex: 0,
    activeVarFieldIndex: -1,
    activeViewId: 'live',
    viewContexts: new Map(),
    categoryTransparency: new Uint8Array(n).fill(1),
    cellVisibilityMask: createShownCellVisibilityMask(n),
    colorsArray: new Uint8Array(n * 4).fill(255),
    isOutlierFilterEnabledForActiveField: () => false,
    getCurrentOutlierThreshold: () => 1,
    getActiveField() { return field; },
    _applyCategoryCountsToCentroids: () => false,
    _pushTransparencyToViewer() {},
    _pushCentroidsToViewer() {},
    _pushColorsToViewer() {},
    _syncActiveContext() {},
    updateFilterSummary() {},
    _notifyVisibilityChange() {},
  });
}

function tally(codes, alpha, categoryCount) {
  const total = new Array(categoryCount).fill(0);
  const visible = new Array(categoryCount).fill(0);
  for (let i = 0; i < codes.length; i++) {
    if (codes[i] >= categoryCount) continue;
    total[codes[i]]++;
    visible[codes[i]] += alpha[i];
  }
  return { total, visible };
}

test('category counts read from the totals equal a count of the cells, filtered or not', async () => {
  const n = 5_000;
  for (const [Codes, missing] of [[Uint8Array, 0xff], [Uint16Array, 0xffff], [Uint32Array, 0xffffffff]]) {
    const { codes, categories } = dataset(n, 6, Codes, missing, Codes.BYTES_PER_ELEMENT);
    const field = {
      key: 'cluster',
      kind: 'category',
      categories,
      codes,
      _categoryVisible: Object.fromEntries(categories.map((_, k) => [k, true])),
      _categoryFilterEnabled: true,
      _categoryColors: categories.map(() => [0.5, 0.5, 0.5]),
    };
    const state = countState(n, field);
    await prepareCategoryTotals(codes, categories.length, { sliceMs: 0, yieldToMacrotask: immediately });
    for (const hidden of [[], [2], [0, 5], [1, 2, 3, 4]]) {
      field._categoryVisible = Object.fromEntries(categories.map((_, k) => [k, !hidden.includes(k)]));
      state.computeGlobalVisibility();
      // The visibility itself, cell by cell (the mask shows every cell).
      for (let i = 0; i < n; i++) {
        const want = codes[i] >= categories.length || !hidden.includes(codes[i]) ? 1 : 0;
        if (state.categoryTransparency[i] !== want || state.colorsArray[i * 4 + 3] !== want * 255) {
          assert.fail(`${Codes.name} cell ${i}: visibility ${state.categoryTransparency[i]}, expected ${want}`);
        }
      }
      const counts = state.computeCategoryCountsForField(field);
      const expected = tally(codes, state.categoryTransparency, categories.length);
      assert.deepEqual(counts.total, expected.total, `${Codes.name} totals, hidden ${hidden}`);
      assert.deepEqual(counts.visible, expected.visible, `${Codes.name} visible, hidden ${hidden}`);
    }
    // A mask that hides cells: the counts come from the cells again.
    const mask = writableCellVisibilityMask(state);
    for (let i = 0; i < n; i += 3) mask[i] = 0;
    field._categoryVisible = Object.fromEntries(categories.map((_, k) => [k, k !== 1]));
    state.computeGlobalVisibility();
    const counts = state.computeCategoryCountsForField(field);
    assert.deepEqual(counts.visible, tally(codes, state.categoryTransparency, categories.length).visible);
  }
});

test('the activation preparation keeps the centroids and totals the activation computes', async () => {
  const n = 300_000;
  const { codes, categories, random } = dataset(n, 9, Uint8Array, 0xff, 11);
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < positions.length; i++) positions[i] = random();
  const makeField = () => ({
    key: 'cluster',
    kind: 'category',
    categories,
    codes,
    centroidsByLayout: new Map(),
    _normalizedLayouts: new Set(),
  });
  const field = makeField();
  const state = Object.assign(Object.create(DataStateColorMethods.prototype), {
    pointCount: n,
    activeViewId: 'live',
    _datasetGeneration: 4,
    getViewLayoutKey: () => 'umap',
    dimensionManager: {
      getLayout: () => ({ dimension: 3 }),
      getResidentPositions: () => positions,
    },
  });
  await state.prepareCategoryFieldActivation(field);
  assert.deepEqual(field.centroidsByLayout.get('umap'), computeCentroidsForDimension(codes, categories, positions, 3));
  assert.ok(field._normalizedLayouts.has('umap'));

  // A dataset replaced while the slices ran keeps nothing.
  const other = makeField();
  const pending = state.prepareCategoryFieldActivation(other);
  state._datasetGeneration = 5;
  await pending;
  assert.equal(other.centroidsByLayout.size, 0);
});
