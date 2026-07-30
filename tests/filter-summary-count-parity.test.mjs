import assert from 'node:assert/strict';
import test from 'node:test';

import { FieldSummaryMethods } from '../assets/js/app/state/managers/field/summary.js';
import {
  MIN_VISIBLE_ALPHA_BYTE,
  POINT_VISIBILITY_THRESHOLD,
} from '../assets/js/rendering/alpha-visibility.js';

function nextFloat32(value, direction) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  const bits = view.getUint32(0, true);
  view.setUint32(0, bits + direction, true);
  return view.getFloat32(0, true);
}

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
  owner.categoryTransparency = new Float32Array([1, 1, 1]);
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

test('field summaries count exactly the Float32 values that encode to visible R8 bytes', () => {
  const byte3Alpha = POINT_VISIBILITY_THRESHOLD;
  const byte2Alpha = nextFloat32(byte3Alpha, -1);
  assert.equal(
    Math.round(byte2Alpha * 255),
    MIN_VISIBLE_ALPHA_BYTE - 1,
  );
  assert.equal(
    Math.round(byte3Alpha * 255),
    MIN_VISIBLE_ALPHA_BYTE,
  );

  const categoryTarget = {
    _categoryVisible: { 0: true, 1: true },
    _isDeleted: false,
    categories: ['R8 byte 2', 'R8 byte 3'],
    codes: new Uint8Array([0, 1]),
    key: 'alpha_boundary',
    kind: 'category',
  };
  const owner = createCountOwner([categoryTarget], 2);
  owner.categoryTransparency = Float32Array.from([
    byte2Alpha,
    byte3Alpha,
  ]);

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
