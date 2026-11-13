import assert from 'node:assert/strict';
import test from 'node:test';

import { computeCorrelation } from '../assets/js/app/analysis/compute/operation-handlers.js';
import { pairwiseDistanceRows } from '../assets/js/app/analysis/compute/hierarchical-clustering.js';

const ramp = Float32Array.from({ length: 100 }, (_, index) => index);

for (const constant of [0.1, 23.4, 0]) {
  for (const method of ['pearson', 'spearman']) {
    test(`a constant ${constant} variable has no correlation (${method}): r and p undefined, said why`, () => {
      // SciPy: pearsonr / spearmanr of a constant input are NaN
      // (ConstantInputWarning); r = 0, p = 1 would read as evidence of none.
      for (const [xValues, yValues, which] of [
        [new Float32Array(100).fill(constant), ramp, 'x'],
        [ramp, new Float32Array(100).fill(constant), 'y'],
        [new Float32Array(100).fill(constant), new Float32Array(100).fill(constant), 'both'],
      ]) {
        const result = computeCorrelation({ xValues, yValues, method });
        assert.ok(Number.isNaN(result.r));
        assert.ok(Number.isNaN(result.rSquared));
        assert.ok(Number.isNaN(result.pValue));
        assert.equal(result.constant, which);
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
  assert.ok(Number.isNaN(result.r));
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
    // Condensed pairs (0,1), (0,2), (1,2).
    const distances = pairwiseDistanceRows(matrix, 3, nCols, 'correlation', 0, 2);
    for (const value of distances) assert.ok(Number.isFinite(value), String(value));
    assert.equal(distances[0], 1);
    assert.equal(distances[1], 1);
    assert.ok(Math.abs(distances[2]) < 1e-12);
  }
});

test('Spearman ranks values wider than float32 exactly whether or not a pair is missing', async () => {
  const { computeCorrelation: correlate } = await import('../assets/js/app/analysis/compute/operation-handlers.js');
  // Integers past 2^24 (a float64 count field) and a scrambled second field.
  const n = 2000;
  const x = Float64Array.from({ length: n }, (_, i) => 16777216 + i);
  const y = Float64Array.from({ length: n }, (_, i) => (i * 7919) % n);
  const withMissing = y.slice();
  withMissing[n - 1] = NaN;
  const missing = correlate({ xValues: x, yValues: withMissing, method: 'spearman' });
  const without = correlate({ xValues: x.slice(0, n - 1), yValues: y.slice(0, n - 1), method: 'spearman' });
  assert.equal(missing.r, without.r);
  assert.equal(missing.n, n - 1);
  // SciPy spearmanr on the 1,999 pairs: -0.009238792068707027.
  assert.ok(Math.abs(missing.r - -0.009238792068707027) < 1e-14, `r ${missing.r}`);
});
