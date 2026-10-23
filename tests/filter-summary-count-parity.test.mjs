import assert from 'node:assert/strict';
import test from 'node:test';

import { FieldSummaryMethods } from '../assets/js/app/state/managers/field/summary.js';

function continuousField({
  deleted = false,
  filter = [0, 1],
  key,
  values
}) {
  return {
    _continuousFilter: { max: filter[1], min: filter[0] },
    _continuousStats: { max: 1, min: 0 },
    _filterEnabled: true,
    _isDeleted: deleted,
    key,
    kind: 'continuous',
    values: new Float32Array(values)
  };
}

function createCountOwner(fields, pointCount = 3) {
  return {
    activeFieldSource: 'obs',
    activeVarFieldIndex: -1,
    isOutlierFilterEnabledForActiveField() {
      return false;
    },
    obsData: { fields },
    pointCount,
    varData: { fields: [] }
  };
}

test('snapshot summaries and continuous counts use the exact renderer filter boundary', () => {
  const nearBoundaryFilter = continuousField({
    filter: [0.0000005, 1],
    key: 'near_boundary',
    values: [0, 0.5, 1]
  });
  const target = continuousField({
    key: 'target',
    values: [0, 0.5, 1]
  });
  const owner = createCountOwner([nearBoundaryFilter, target]);
  owner.activeViewId = 'live';
  owner.viewContexts = new Map([
    ['snapshot', {
      activeFieldIndex: 1,
      activeFieldSource: 'obs',
      activeVarFieldIndex: -1,
      obsData: owner.obsData,
      varData: owner.varData
    }]
  ]);

  assert.deepEqual(
    FieldSummaryMethods.prototype.getFilterSummaryForView.call(
      owner,
      'snapshot'
    ),
    ['near_boundary: 0.00 – 1.00']
  );
  assert.deepEqual(
    FieldSummaryMethods.prototype._computeCountsForContinuous.call(
      owner,
      target,
      'obs',
      { ignoreSelfFilter: true }
    ),
    { available: 2, visible: 2 }
  );
});

test('deleted observation filters cannot reduce continuous or categorical counts', () => {
  const deletedFilter = continuousField({
    deleted: true,
    filter: [0.5, 1],
    key: 'deleted_filter',
    values: [0, 0.5, 1]
  });
  const continuousTarget = continuousField({
    key: 'continuous_target',
    values: [0, 0.5, 1]
  });
  const owner = createCountOwner([deletedFilter, continuousTarget]);

  assert.deepEqual(
    FieldSummaryMethods.prototype._computeCountsForContinuous.call(
      owner,
      continuousTarget,
      'obs',
      { ignoreSelfFilter: true }
    ),
    { available: 3, visible: 3 }
  );

  const categoryTarget = {
    _categoryVisible: { 0: true, 1: true },
    _isDeleted: false,
    categories: ['A', 'B'],
    codes: new Uint8Array([0, 0, 1]),
    key: 'category_target',
    kind: 'category'
  };
  owner.obsData.fields = [deletedFilter, categoryTarget];
  owner.categoryTransparency = new Uint8Array([1, 1, 1]);
  owner.activeFieldIndex = 1;

  assert.deepEqual(
    FieldSummaryMethods.prototype.computeCategoryCountsForField.call(
      owner,
      categoryTarget
    ),
    {
      available: [2, 1],
      availableTotal: 3,
      total: [2, 1],
      visible: [2, 1],
      visibleTotal: 3
    }
  );
});

test('field summaries count the cells whose one-byte transparency is 1', () => {
  const categoryTarget = {
    _categoryVisible: { 0: true, 1: true },
    _isDeleted: false,
    categories: ['hidden cell', 'shown cell'],
    codes: new Uint8Array([0, 1]),
    key: 'alpha_boundary',
    kind: 'category',
  };
  const owner = createCountOwner([categoryTarget], 2);
  owner.categoryTransparency = Uint8Array.from([0, 1]);

  FieldSummaryMethods.prototype.updateFilteredCount.call(owner);
  assert.deepEqual(owner.filteredCount, { shown: 1, total: 2 });
  assert.deepEqual(
    FieldSummaryMethods.prototype.computeCategoryCountsForField.call(
      owner,
      categoryTarget,
    ),
    {
      available: [1, 1],
      availableTotal: 2,
      total: [1, 1],
      visible: [0, 1],
      visibleTotal: 1,
    },
  );
});

test('category counts match the per-cell rule for every code width and the missing code', () => {
  for (const [Codes, missing] of [
    [Uint8Array, 0xff],
    [Uint16Array, 0xffff],
    [Uint32Array, 0xffffffff],
  ]) {
    const pointCount = 997;
    const categoryCount = 7;
    const codes = new Codes(pointCount);
    const alpha = new Uint8Array(pointCount);
    for (let cell = 0; cell < pointCount; cell++) {
      codes[cell] = cell % 11 === 10 ? missing : (cell * 7919) % categoryCount;
      alpha[cell] = (cell * 31) % 5 === 0 ? 0 : 1;
    }
    const field = {
      _categoryVisible: Object.fromEntries(
        Array.from({ length: categoryCount }, (_, code) => [code, true])
      ),
      categories: Array.from({ length: categoryCount }, (_, code) => `c${code}`),
      codes,
      key: `codes_${Codes.name}`,
      kind: 'category',
    };
    const owner = createCountOwner([field], pointCount);
    owner.categoryTransparency = alpha;
    const total = new Array(categoryCount).fill(0);
    const visible = new Array(categoryCount).fill(0);
    for (let cell = 0; cell < pointCount; cell++) {
      if (codes[cell] === missing) continue;
      total[codes[cell]]++;
      visible[codes[cell]] += alpha[cell];
    }
    const counts = FieldSummaryMethods.prototype.computeCategoryCountsForField.call(
      owner,
      field,
    );
    assert.deepEqual(counts.total, total, Codes.name);
    assert.deepEqual(counts.available, total, Codes.name);
    assert.deepEqual(counts.visible, visible, Codes.name);
    assert.equal(counts.visibleTotal, visible.reduce((a, b) => a + b, 0));
  }
});
