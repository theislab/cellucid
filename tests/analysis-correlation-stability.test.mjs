import assert from 'node:assert/strict';
import test from 'node:test';

import { computeCorrelation } from '../assets/js/app/analysis/compute/operation-handlers.js';
import { computeDistanceMatrix } from '../assets/js/app/analysis/shared/matrix-utils.js';

const ramp = Float32Array.from({ length: 100 }, (_, index) => index);

for (const constant of [0.1, 23.4, 0]) {
  for (const method of ['pearson', 'spearman']) {
    test(`a constant ${constant} variable is uncorrelated (${method}): r = 0, p = 1`, () => {
      for (const [xValues, yValues] of [
        [new Float32Array(100).fill(constant), ramp],
        [ramp, new Float32Array(100).fill(constant)],
      ]) {
        const result = computeCorrelation({ xValues, yValues, method });
        assert.equal(result.r, 0);
        assert.equal(result.rSquared, 0);
        assert.equal(result.pValue, 1);
        assert.equal(result.n, 100);
      }
    });
  }
}

test('a constant X gives a flat trend line through the mean of Y, not a slope from round-off', () => {
  const yValues = Float32Array.from({ length: 1000 }, (_, index) => Math.sin(index) * 7);
  const result = computeCorrelation({
    xValues: new Float32Array(1000).fill(23.4),
    yValues,
    method: 'pearson',
  });
  let sumY = 0;
  for (const y of yValues) sumY += y;
  assert.equal(result.r, 0);
  assert.equal(result.slope, 0);
  assert.ok(Math.abs(result.intercept - sumY / 1000) < 1e-9);
});

test('large offsets do not cancel the Pearson coefficient', () => {
  const xValues = Float64Array.from({ length: 50 }, (_, index) => 1e8 + index);
  const yValues = Float64Array.from({ length: 50 }, (_, index) => 1e8 + 2 * index);
  const result = computeCorrelation({ xValues, yValues, method: 'pearson' });
  assert.ok(Math.abs(result.r - 1) < 1e-12, `r = ${result.r}`);
  assert.ok(Math.abs(result.slope - 2) < 1e-9, `slope = ${result.slope}`);
});

test('the Pearson coefficient stays within [-1, 1] for exactly collinear data', () => {
  const xValues = Float32Array.from({ length: 37 }, (_, index) => 0.1 * index + 0.3);
  const yValues = Float32Array.from(xValues, value => -3 * value);
  const result = computeCorrelation({ xValues, yValues, method: 'pearson' });
  assert.ok(result.r >= -1 && result.r <= 1, `r = ${result.r}`);
  assert.ok(Math.abs(result.r + 1) < 1e-6);
  assert.ok(result.pValue < 1e-30, `p = ${result.pValue}`);
});

test('correlation distance treats a constant row as uncorrelated, never NaN', () => {
  const nCols = 100;
  for (const constant of [0.1, 23.4]) {
    const matrix = new Float32Array(3 * nCols);
    for (let column = 0; column < nCols; column++) {
      matrix[column] = constant;
      matrix[nCols + column] = Math.sin(column);
      matrix[2 * nCols + column] = 2 * Math.sin(column) + 1;
    }
    const distances = computeDistanceMatrix(matrix, 3, nCols, 'correlation');
    for (const value of distances) assert.ok(Number.isFinite(value), String(value));
    assert.equal(distances[1], 1);
    assert.equal(distances[2], 1);
    assert.ok(Math.abs(distances[5]) < 1e-6);
  }
});
