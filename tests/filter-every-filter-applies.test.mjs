/**
 * Every filter keeps applying until it is removed, whatever the view is
 * coloured by (owner decision 2026-10-28, audit F-6): a gene's range filter
 * and a categorical field's outlier filter hide cells exactly as an obs
 * range or category filter does, after the view is coloured by another
 * field. The Active filters list (and figure provenance, which reads it)
 * shows each, the visibility pass applies each, the counts read the same
 * filters, and residency keeps their arrays.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DataStateFilterMethods, collectViewFilters } from '../assets/js/app/state/managers/filter-manager.js';
import { DataStateColorMethods } from '../assets/js/app/state/managers/color-manager.js';
import { FieldSummaryMethods } from '../assets/js/app/state/managers/field/summary.js';
import { visibleOf } from './helpers/category-state.mjs';

const N = 8;

function liveState() {
  const cluster = {
    kind: 'category',
    key: 'cluster',
    categories: ['a', 'b'],
    codes: Uint8Array.of(0, 0, 0, 0, 1, 1, 1, 1),
    _categoryVisible: visibleOf([true, true]),
    _categoryFilterEnabled: true,
    // Cells 3 and 7 are the outliers of their categories.
    outlierQuantiles: Float32Array.of(0.1, 0.2, 0.3, 0.95, 0.1, 0.2, 0.3, 0.99),
    _outlierThreshold: 0.9,
    _outlierFilterEnabled: true,
  };
  const score = {
    kind: 'continuous',
    key: 'score',
    values: Float32Array.of(0, 1, 2, 3, 4, 5, 6, 7),
  };
  const gene = {
    kind: 'continuous',
    key: 'CD3E',
    values: Float32Array.of(0, 2, 0, 2, 0, 2, 0, 2),
    _continuousStats: { min: 0, max: 2 },
    _continuousFilter: { min: 1, max: 2 },
    _filterEnabled: true,
  };
  const state = Object.assign(Object.create(DataStateFilterMethods.prototype), {
    pointCount: N,
    obsData: { fields: [cluster, score] },
    varData: { fields: [{ kind: 'continuous', key: 'MS4A1' }, gene] },
    // Coloured by the continuous obs field: neither the gene nor the
    // categorical field with the outlier filter is coloured.
    activeFieldSource: 'obs',
    activeFieldIndex: 1,
    activeVarFieldIndex: -1,
    categoryTransparency: new Uint8Array(N).fill(1),
    cellVisibilityMask: new Uint8Array(N).fill(1),
    colorsArray: new Uint8Array(N * 4).fill(255),
    ensureCategoryMetadata() {},
    getActiveField() {
      return this.obsData.fields[this.activeFieldIndex];
    },
    ensureContinuousMetadata(field) {
      return { stats: field._continuousStats, filter: field._continuousFilter };
    },
    _updateActiveCategoryCounts: () => false,
    _pushTransparencyToViewer() {},
    _pushCentroidsToViewer() {},
    _syncActiveContext() {},
    updateFilteredCount() {},
    updateFilterSummary() {},
    _notifyVisibilityChange() {},
  });
  for (const key of Object.getOwnPropertyNames(FieldSummaryMethods.prototype)) {
    if (key !== 'constructor' && key !== 'updateFilteredCount') state[key] = FieldSummaryMethods.prototype[key];
  }
  return { state, cluster, gene };
}

test('a gene range filter and an outlier filter apply whatever is coloured', () => {
  const { state, cluster, gene } = liveState();
  state.computeGlobalVisibility();
  // Gene keeps odd cells (value 2); the outlier filter drops cells 3 and 7.
  assert.deepEqual(Array.from(state.categoryTransparency), [0, 1, 0, 0, 0, 1, 0, 0]);
  assert.deepEqual(state.filteredCount, { shown: 2, total: N });
  // Visibility is the transparency alone: the colors stay opaque.
  for (let i = 0; i < N; i++) assert.equal(state.colorsArray[i * 4 + 3], 255);

  // Disabled, each stops hiding; listed still.
  gene._filterEnabled = false;
  state.computeGlobalVisibility();
  assert.deepEqual(Array.from(state.categoryTransparency), [1, 1, 1, 0, 1, 1, 1, 0]);
  cluster._outlierFilterEnabled = false;
  state.computeGlobalVisibility();
  assert.deepEqual(Array.from(state.categoryTransparency), [1, 1, 1, 1, 1, 1, 1, 1]);
});

test('the filter list shows every gene and outlier filter, not only the coloured field\'s', () => {
  const { state, gene } = liveState();
  const rows = collectViewFilters(state);
  assert.deepEqual(rows.map(row => row.id), ['obs-outlier-0', 'var-continuous-1']);
  assert.deepEqual(rows.map(row => row.text), ['cluster: outlier ≤ 90%', 'CD3E: 1 – 2']);
  gene._filterEnabled = false;
  assert.equal(collectViewFilters(state)[1].text, 'CD3E: 1 – 2 (disabled)');
  // Removing one through the list removes it, wherever the view is coloured.
  state.removeFilter('var-continuous-1');
  assert.deepEqual(gene._continuousFilter, { min: 0, max: 2 });
  assert.deepEqual(collectViewFilters(state).map(row => row.id), ['obs-outlier-0']);
  state.removeFilter('obs-outlier-0');
  assert.deepEqual(collectViewFilters(state), []);
  assert.deepEqual(Array.from(state.categoryTransparency), [1, 1, 1, 1, 1, 1, 1, 1]);
});

test('the counts read the same filters as the visibility pass', () => {
  const { state, cluster } = liveState();
  state.computeGlobalVisibility();
  // "Available" for the cluster legend: every other filter (the gene and its
  // own outlier filter), not its own category visibility.
  const counts = state.computeCategoryCountsForField(cluster);
  assert.deepEqual(counts.available, [1, 1]);
  assert.deepEqual(counts.visible, [1, 1]);
  const continuous = state._computeCountsForContinuous(state.obsData.fields[1], 'obs', { ignoreSelfFilter: true });
  assert.deepEqual(continuous, { available: 2, visible: 2 });
});

test('cells without a category are counted, and hidden or shown like a category (K-06)', () => {
  for (const Codes of [Uint8Array, Uint32Array]) {
    const { state, cluster, gene } = liveState();
    gene._continuousFilter = { min: 0, max: 2 };
    cluster._outlierThreshold = 1;
    const missing = Codes === Uint8Array ? 0xff : 0xffffffff;
    cluster.codes = Codes.of(0, missing, 0, 1, missing, 1, 1, 0);
    state.computeGlobalVisibility();
    let counts = state.computeCategoryCountsForField(cluster);
    assert.deepEqual(counts.missing, { total: 2, available: 2, visible: 2 }, Codes.name);
    assert.equal(counts.visibleTotal, 8, 'every cell shown, those without a category too');
    state.setMissingCategoryVisibility(cluster, false);
    assert.deepEqual(Array.from(state.categoryTransparency), [1, 0, 1, 1, 0, 1, 1, 1], Codes.name);
    counts = state.computeCategoryCountsForField(cluster);
    assert.deepEqual(counts.missing, { total: 2, available: 2, visible: 0 });
    assert.deepEqual(collectViewFilters(state).map(row => row.text), ['cluster: hiding Missing']);
    state.removeFilter('obs-category-0');
    assert.deepEqual(Array.from(state.categoryTransparency), [1, 1, 1, 1, 1, 1, 1, 1]);
  }
});
