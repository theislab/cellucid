/**
 * Box plots that draw points hand Plotly precomputed statistics
 * (assets/js/app/analysis/plots/plotly-box-statistics.js). The browser spec
 * tests/browser/analysis-box-statistics-identity.spec.mjs proves the drawn box
 * is Plotly's own raw-value box; this file pins the arithmetic it relies on and
 * which boxes are allowed onto the precomputed path.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COINCIDENT_OUTLIER_COPIES,
  isPlotlyPrecomputable,
  plotlyBoxPoints,
  plotlyBoxStatistics,
  sortLikePlotly
} from '../assets/js/app/analysis/plots/plotly-box-statistics.js';
import { PlotFactory } from '../assets/js/app/analysis/plots/plot-factory.js';

/** Plotly 2.27.0 Lib.interp, Lib.findBin, Lib.mean, Lib.stdev and box calc, transcribed. */
function plotlyRawBox(values) {
  const C = values.map(v => ({ v })).sort((a, b) => a.v - b.v).map(p => p.v);
  const P = C.length;
  const interp = (t, e) => {
    e = e * t.length - 0.5;
    if (e < 0) return t[0];
    if (e > t.length - 1) return t[t.length - 1];
    const r = e % 1;
    return r * t[Math.ceil(e)] + (1 - r) * t[Math.floor(e)];
  };
  const findBin = (t, e, r) => {
    let h = 0, p = e.length, d = 0;
    const v = p > 1 ? (e[p - 1] - e[0]) / (p - 1) : 1;
    const o = v >= 0 ? (r ? (a, b) => a < b : (a, b) => a <= b) : (r ? (a, b) => a >= b : (a, b) => a > b);
    t += v * 1e-9 * (r ? -1 : 1) * (v >= 0 ? 1 : -1);
    while (h < p && d++ < 100) {
      const a = Math.floor((h + p) / 2);
      if (o(e[a], t)) h = a + 1; else p = a;
    }
    return h - 1;
  };
  const aggSum = (f, data) => { let r = 0; for (const x of data) r = f(+r, +x); return r; };
  const mean = aggSum((a, b) => a + b, C) / P;
  const sd = Math.sqrt(aggSum((a, b) => a + Math.pow(b - mean, 2), C) / P);
  const med = interp(C, 0.5);
  const q1 = interp(C, 0.25);
  const q3 = interp(C, 0.75);
  const lf = Math.min(q1, C[Math.min(findBin(2.5 * q1 - 1.5 * q3, C, true) + 1, P - 1)]);
  const uf = Math.max(q3, C[Math.max(findBin(2.5 * q3 - 1.5 * q1, C), 0)]);
  return { C, med, q1, q3, mean, sd, lf, uf, notch: 1.57 * (q3 - q1) / Math.sqrt(P) };
}

/** Each run of equal values cut to its first `COINCIDENT_OUTLIER_COPIES` copies. */
function cappedRuns(sortedValues) {
  const kept = [];
  let run = 0;
  for (let i = 0; i < sortedValues.length; i++) {
    run = i > 0 && sortedValues[i] === sortedValues[i - 1] ? run + 1 : 0;
    if (run < COINCIDENT_OUTLIER_COPIES) kept.push(sortedValues[i]);
  }
  return kept;
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

test('box statistics are bit-identical to Plotly raw-value box calc', () => {
  const random = lcg(41);
  const samples = [
    [5],
    [2, -7],
    Array.from({ length: 999 }, () => Math.fround(random() * 10 - 3)),
    Array.from({ length: 5000 }, () => (random() < 0.7 ? 0 : Math.fround(Math.round(random() * 254) / 37))),
    Array.from({ length: 3001 }, (_, i) => (i % 3 === 0 ? -0 : i % 3 === 1 ? 0 : random() - 0.5)),
    Array.from({ length: 400 }, () => Math.exp(random() * 20)),
  ];
  for (const values of samples) {
    const mine = plotlyBoxStatistics(values);
    const theirs = plotlyRawBox(values);
    assert.equal(mine.sorted.length, theirs.C.length);
    for (let i = 0; i < theirs.C.length; i++) {
      assert.ok(Object.is(mine.sorted[i], theirs.C[i]), `sorted[${i}]`);
    }
    for (const [key, expected] of [
      ['median', theirs.med], ['q1', theirs.q1], ['q3', theirs.q3], ['mean', theirs.mean],
      ['sd', theirs.sd], ['lowerfence', theirs.lf], ['upperfence', theirs.uf], ['notchspan', theirs.notch],
    ]) {
      assert.ok(Object.is(mine[key], expected), `${key}: ${mine[key]} vs ${expected}`);
    }
    const outliers = plotlyBoxPoints(mine, 'outliers');
    assert.deepEqual(Array.from(outliers), cappedRuns(theirs.C.filter(v => v < theirs.lf || v > theirs.uf)));
    assert.equal(plotlyBoxPoints(mine, 'all'), mine.sorted);
  }
});

test('signed zeros keep their input order, as a stable comparator sort leaves them', () => {
  const sorted = sortLikePlotly([0, -1, -0, 0, 2, -0]);
  assert.deepEqual(Array.from(sorted, v => Object.is(v, -0) ? '-0' : String(v)), ['-1', '0', '-0', '0', '-0', '2']);
});

test('only boxes Plotly precomputed mode draws identically take that path', () => {
  const pd = { pageName: 'P', values: Float32Array.from([0, 0, 1, 2, 3, 40, -30]) };
  const build = options => PlotFactory.buildDistributionTrace({ type: 'box', pd, color: '#123456', options });
  const outliers = build({ showPoints: 'outliers' });
  assert.ok(Array.isArray(outliers.q1));
  assert.deepEqual(outliers.x, ['P']);
  assert.deepEqual(Array.from(outliers.y[0]), [-30, 40]);
  const all = build({ showPoints: 'all' });
  assert.equal(all.y[0].length, 7);
  for (const options of [{ showPoints: 'none' }, { showPoints: 'outliers', notched: true }]) {
    const raw = build(options);
    assert.equal(raw.q1, undefined, JSON.stringify(options));
    assert.ok(Array.isArray(raw.y) && raw.y.length === 7, 'raw boxes get plain arrays of every value');
    assert.equal('x' in raw, false, 'a raw box has no per-value position array');
    assert.equal(raw.x0, 'P', 'a raw box is placed at its page name once');
  }
  const noOutliers = PlotFactory.buildDistributionTrace({
    type: 'box', pd: { pageName: 'Q', values: [1, 2, 3, 4] }, color: '#123456', options: { showPoints: 'outliers', orientation: 'horizontal' },
  });
  assert.ok(Array.isArray(noOutliers.q1));
  assert.equal('x' in noOutliers, false, 'a box with no points to draw sends no point row');
  assert.deepEqual(noOutliers.y, ['Q']);
  const violin = PlotFactory.buildDistributionTrace({ type: 'violin', pd, color: '#123456', options: {} });
  assert.equal(violin.q1, undefined);
  assert.equal(violin.y.length, 7);
  assert.equal(violin.x0, 'P');
  assert.equal('x' in violin, false);
  assert.ok(isPlotlyPrecomputable({ q1: 1, median: 1, q3: 1 }));
  assert.equal(isPlotlyPrecomputable({ q1: 1, median: 0.9999999999999999, q3: 2 }), false);
});
