import assert from 'node:assert/strict';
import test from 'node:test';

import { FieldLoadingMethods } from '../assets/js/app/state/managers/field/loading.js';

function createContext(source, target = new Float32Array([0.25, 0.5, 0.75])) {
  const field = { outlierQuantiles: source };
  let syncCount = 0;
  return {
    context: {
      pointCount: source.length,
      obsData: { fields: [field] },
      activeFieldSource: 'obs',
      outlierQuantilesArray: target,
      getActiveField() {
        return field;
      },
      _syncActiveContext() {
        syncCount += 1;
      },
    },
    getSyncCount() {
      return syncCount;
    },
    target,
  };
}

test('active outlier quantiles accept only the exact -1 sentinel or [0, 1]', () => {
  const valid = createContext(Float32Array.from([-1, 0, 1]));

  FieldLoadingMethods.prototype.updateOutlierQuantiles.call(valid.context);

  assert.deepEqual([...valid.target], [-1, 0, 1]);
  assert.equal(valid.getSyncCount(), 1);
});

test('a fractional negative outlier quantile is rejected before state mutation', () => {
  const invalid = createContext(Float32Array.from([-1, -0.5, 1]));
  const before = [...invalid.target];

  assert.throws(
    () => FieldLoadingMethods.prototype.updateOutlierQuantiles.call(invalid.context),
    /quantile 1 must be -1 or a finite value from 0 through 1/,
  );

  assert.deepEqual([...invalid.target], before);
  assert.equal(invalid.getSyncCount(), 0);
});
