/**
 * Means and spreads keep their digits, checked against
 * exact rational references (Python `fractions`, the t and F to 50 digits):
 *
 * - The Detailed view's Welch t and one-way ANOVA subtract means less one
 *   pivot, so obs values far from zero but close to each other (1e8 apart
 *   by 1e-3) keep every digit; SciPy's `ttest_ind` loses 6e-5 of this t (its
 *   `f_oneway` shifts as we do and agrees).
 * - Differential expression's Welch t adds the zeros' terms of its sums of
 *   squares in one product, O(nnz), and matches the exact t.
 * - A constant gene (a non-dyadic value in every cell) has a spread of
 *   exactly 0, so a mean z-score reports it as constant, never as noise
 *   scaled up by 1e8.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { centredMoments, mean } from '../assets/js/app/analysis/compute/math-utils.js';
import { columnMoments, geneSampleOf, twoSampleDifferential } from '../assets/js/app/analysis/compute/gene-statistics.js';
import { oneWayANOVA, tTest } from '../assets/js/app/analysis/stats/statistical-tests.js';
import { momentsMean, momentsStd } from '../assets/js/app/analysis/shared/gene-moments-cache.js';

const close = (actual, expected, tolerance, label) => {
  const relative = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(relative <= tolerance, `${label}: ${actual} vs ${expected} (relative ${relative})`);
};

const A = Array.from({ length: 40 }, (_, i) => 1e8 + 0.001 * (i % 7));
const B = Array.from({ length: 30 }, (_, i) => 1e8 + 0.001 * (i % 5) + 0.0004);
const C = Array.from({ length: 25 }, (_, i) => 1e8 + 0.001 * (i % 3) + 0.0009);

test('Welch t and ANOVA F of offset obs values equal the exact rational references', () => {
  // Exact: 1.1591258458405267 (SciPy ttest_ind: 1.1591922089452238).
  close(tTest(A, B).statistic, 1.1591258458405267, 1e-13, 'Welch t');
  close(tTest(B, A).statistic, -1.1591258458405267, 1e-13, 'Welch t, swapped');
  // Exact and SciPy f_oneway: 3.180838703230936.
  close(oneWayANOVA([A, B, C]).statistic, 3.180838703230936, 1e-13, 'ANOVA F');
  // The means themselves: compensated sums, the pivot added back once.
  const moments = centredMoments(A, A[0]);
  close(moments.mean, A.reduce((total, value) => total + (value - 1e8), 0) / A.length + 1e8, 1e-15, 'pivoted mean');
  assert.equal(moments.mean, A[0] + moments.shifted);
});

test('differential expression Welch t over non-zero entries equals the exact t', () => {
  const a = new Float32Array(2059);
  for (let k = 1; k < 60; k++) a[2000 + k - 1] = 0.37 * k;
  const b = new Float32Array(1539);
  for (let k = 1; k < 40; k++) b[1500 + k - 1] = 0.41 * k;
  // Exact (and SciPy): 1.825249845068444.
  const result = twoSampleDifferential(geneSampleOf(a, 0), geneSampleOf(b, 1), 'ttest');
  close(result.statistic, 1.825249845068444, 1e-14, 'sparse t');
  assert.equal(result.meanA, mean(a));
});

test('a constant gene has no spread, exactly, and a constant group its value as mean', () => {
  for (const value of [0.1, 23.4, 1 / 3, 1e8 + 0.1]) {
    const dense = new Float64Array(10_000).fill(value);
    const moments = columnMoments(geneSampleOf(dense, 0));
    assert.equal(moments.m2, 0, `${value}: m2`);
    assert.equal(momentsStd(moments), 0, `${value}: SD`);
    assert.equal(momentsMean(moments), value, `${value}: mean`);
    assert.equal(centredMoments(dense).m2, 0, `${value}: dense m2`);
    assert.equal(mean(dense), value, `${value}: dense mean`);
  }
  // Two constant groups at one value: no difference (p = 1), not p = 0 from
  // means a bit apart.
  const one = twoSampleDifferential(geneSampleOf(new Float32Array(7).fill(0.1), 0), geneSampleOf(new Float32Array(1000).fill(0.1), 1), 'ttest');
  assert.equal(one.statistic, 0);
  assert.equal(one.pValue, 1);
  // All zeros: mean 0 (never -0), no spread.
  const zeros = columnMoments({ length: 5, indices: Uint32Array.of(1), values: Float32Array.of(-0) });
  assert.ok(Object.is(zeros.mean, 0));
  assert.equal(zeros.m2, 0);
});

test("markers' one-vs-rest Welch merges the rest from the other groups: a dominant group, a tight rest", async () => {
  const { createGroupingContext, groupMarkers } = await import('../assets/js/app/analysis/compute/gene-statistics.js');
  const { welchTTest } = await import('../assets/js/app/analysis/compute/math-utils.js');
  // 200,000 cells: group 0 wide around 6, groups 1 and 2 (60 cells) tight around 5.
  let seed = 7;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const n = 200_000;
  const values = new Float32Array(n);
  const groups = new Int16Array(n);
  for (let cell = 0; cell < n; cell++) {
    const tight = cell % 5000 === 0 ? 1 : cell % 5000 === 1 ? 2 : 0;
    groups[cell] = tight;
    values[cell] = tight === 0 ? 6 + 2 * (random() - 0.5) : 5 + 0.002 * (random() - 0.5) + 0.0001 * tight;
  }
  const sample = { length: n, indices: Uint32Array.from({ length: n }, (_, i) => i), values };
  const result = groupMarkers(sample, createGroupingContext(groups, 3), { method: 'ttest', minCells: 2, foldChange: { mode: 'stored' } });
  for (let g = 0; g < 3; g++) {
    const inGroup = [];
    const restOf = [];
    for (let cell = 0; cell < n; cell++) (groups[cell] === g ? inGroup : restOf).push(values[cell]);
    const direct = welchTTest(inGroup, restOf);
    // The score is stored as float32: the direct t rounded so; p within the incomplete beta's 1e-10.
    assert.equal(result.scores[g], Math.fround(direct.statistic), `group ${g} t`);
    const relative = Math.abs(result.pValues[g] - direct.pValue) / Math.max(direct.pValue, Number.MIN_VALUE);
    assert.ok(relative < 1e-9, `group ${g} p ${result.pValues[g]} vs ${direct.pValue}`);
  }
});
