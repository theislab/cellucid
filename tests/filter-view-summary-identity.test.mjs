import assert from 'node:assert/strict';
import test from 'node:test';

import { FieldSummaryMethods } from '../assets/js/app/state/managers/field/summary.js';
import { DataStateFilterMethods } from '../assets/js/app/state/managers/filter-manager.js';
import { viewContextCoreMethods } from '../assets/js/app/state/managers/view-context-core.js';

function countOwner(fields, transparency) {
  const owner = {
    pointCount: transparency.length,
    obsData: { fields },
    varData: { fields: [] },
    categoryTransparency: Uint8Array.from(transparency),
    activeFieldSource: 'obs',
    activeFieldIndex: 0,
    activeVarFieldIndex: -1,
    isOutlierFilterEnabledForActiveField() {
      return false;
    },
    getCurrentOutlierThreshold() {
      return 1;
    },
  };
  for (const key of ['computeCategoryCountsForField', 'getFilterCellCounts']) {
    owner[key] = FieldSummaryMethods.prototype[key];
  }
  return owner;
}

const CATEGORY_ROW = Object.freeze({
  id: 'obs-category-0',
  type: 'category',
  source: 'obs',
  fieldIndex: 0,
});

test('a category filter row keeps its available count after a view switch clone', () => {
  const cellType = {
    kind: 'category',
    key: 'cell_type',
    categories: ['A', 'B'],
    codes: new Uint8Array([0, 0, 0, 1, 1]),
    _categoryVisible: { 0: true, 1: false },
    _categoryFilterEnabled: true,
  };
  const owner = countOwner([cellType], [1, 1, 1, 0, 0]);
  cellType._categoryCounts = owner.computeCategoryCountsForField(cellType);
  assert.deepEqual(owner.getFilterCellCounts(CATEGORY_ROW), { available: 5, visible: 3 });

  const clone = viewContextCoreMethods._cloneFieldState(cellType);
  assert.deepEqual(clone._categoryCounts, cellType._categoryCounts);
  assert.notEqual(clone._categoryCounts.available, cellType._categoryCounts.available);
  owner.obsData = { fields: [clone] };
  assert.deepEqual(owner.getFilterCellCounts(CATEGORY_ROW), { available: 5, visible: 3 });
});

test('a non-active category filter row counts against the current filters', () => {
  const cellType = {
    kind: 'category',
    key: 'cell_type',
    categories: ['A', 'B'],
    codes: new Uint8Array([0, 0, 1, 1]),
    _categoryVisible: { 0: true, 1: false },
    _categoryFilterEnabled: true,
  };
  const score = {
    kind: 'continuous',
    key: 'score',
    values: new Float32Array([0, 1, 0, 1]),
    _continuousStats: { min: 0, max: 1 },
    _continuousFilter: { min: 0, max: 1 },
    _filterEnabled: true,
  };
  const owner = countOwner([cellType, score], [1, 1, 0, 0]);
  cellType._categoryCounts = owner.computeCategoryCountsForField(cellType);
  // Colour by `score` and narrow it: cell_type is no longer active, so its
  // cached counts are never refreshed.
  owner.activeFieldIndex = 1;
  score._continuousFilter = { min: 0.5, max: 1 };
  owner.categoryTransparency = Uint8Array.from([0, 1, 0, 0]);

  assert.deepEqual(owner.getFilterCellCounts(CATEGORY_ROW), { available: 2, visible: 1 });
});

function geneFilteredContext() {
  const gene = {
    kind: 'continuous',
    key: 'CD3E',
    values: new Float32Array([0, 1, 2]),
    _continuousStats: { min: 0, max: 2 },
    _continuousFilter: { min: 1, max: 2 },
    _filterEnabled: true,
  };
  const disabled = {
    kind: 'continuous',
    key: 'n_genes',
    values: new Float32Array([0, 1, 2]),
    _continuousStats: { min: 0, max: 2 },
    _continuousFilter: { min: 0, max: 1 },
    _filterEnabled: false,
  };
  return {
    activeFieldSource: 'var',
    activeVarFieldIndex: 0,
    activeFieldIndex: -1,
    obsData: { fields: [disabled] },
    varData: { fields: [gene] },
  };
}

test('a view lists the same restrictions whether or not it is focused', () => {
  const context = geneFilteredContext();
  const expected = ['CD3E: 1.00 – 2.00'];

  const unfocused = {
    activeViewId: 'live',
    viewContexts: new Map([['snap', context]]),
  };
  assert.deepEqual(
    FieldSummaryMethods.prototype.getFilterSummaryForView.call(unfocused, 'snap'),
    expected,
  );

  const focused = {
    ...context,
    activeViewId: 'snap',
    viewContexts: new Map(),
    getActiveFiltersStructured: DataStateFilterMethods.prototype.getActiveFiltersStructured,
  };
  assert.deepEqual(
    FieldSummaryMethods.prototype.getFilterSummaryForView.call(focused, 'snap'),
    expected,
  );
});
