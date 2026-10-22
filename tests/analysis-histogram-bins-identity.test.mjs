/**
 * A histogram hands Plotly a few representative values per bin with summed
 * weights instead of every value (assets/js/app/analysis/plots/plotly-histogram-bins.js).
 * tests/browser/analysis-histogram-bins-identity.spec.mjs draws both in the
 * real engine; this file pins, against Plotly 2.27.0's histogram `calc`
 * transcribed, every per-bin quantity the drawn histogram depends on: which
 * bin each value lands in, the count per bin, the total, the smallest
 * distances from a value to its bin's edges, whether every bin holds a single
 * repeated value, and each bin's first value.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { plotlyHistogramSample } from '../assets/js/app/analysis/plots/plotly-histogram-bins.js';
import histogramDefinition from '../assets/js/app/analysis/plots/types/histogram.js';

/** Plotly `Lib.findBin` for `{start, size}` bins, and histogram calc's per-bin bookkeeping. */
function plotlyBinning(xs, weights, bins, binCount) {
  const counts = new Array(binCount).fill(0);
  const firstIndex = new Array(binCount).fill(-1);
  let total = 0;
  let uniform = true;
  let leftGap = Infinity;
  let rightGap = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const value = xs[i];
    const bin = Math.floor((value - bins.start) / bins.size + 1e-9);
    if (bin < 0 || bin >= binCount) continue;
    const weight = weights === null ? 1 : weights[i];
    counts[bin] += weight;
    total += weight;
    if (firstIndex[bin] === -1) firstIndex[bin] = i;
    else if (value !== xs[firstIndex[bin]]) uniform = false;
    const lower = bins.start + bin * bins.size;
    const upper = bins.start + (bin + 1) * bins.size;
    leftGap = Math.min(leftGap, value - lower);
    rightGap = Math.min(rightGap, upper - value);
  }
  const firsts = firstIndex.map(index => (index === -1 ? null : xs[index]));
  return { counts, total, uniform, leftGap, rightGap, firsts };
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function fixtures() {
  const random = lcg(5);
  return {
    quantized: Float32Array.from({ length: 50000 }, () => (
      random() < 0.7 ? 0 : Math.fround(Math.round(random() * 254) * (3.1 / 254))
    )),
    continuous: Float32Array.from({ length: 40000 }, () => Math.fround(random() * 9 - 4)),
    // Every bin holds one repeated value: hover labels read the bin's value.
    levels: Float32Array.from({ length: 30000 }, () => Math.floor(random() * 6)),
    signedZeros: Float64Array.from({ length: 9000 }, (_, i) => (
      i % 3 === 0 ? -0 : i % 3 === 1 ? 0 : (i % 7) / 3
    )),
    edges: Float64Array.from({ length: 2001 }, (_, i) => i / 100),
  };
}

test('representatives bin exactly like every raw value', () => {
  for (const [name, values] of Object.entries(fixtures())) {
    for (const binCount of [5, 20, 37, 100]) {
      let min = Infinity;
      let max = -Infinity;
      for (const value of values) {
        if (value < min) min = value;
        if (value > max) max = value;
      }
      const bins = { start: min, size: (max - min) / binCount };
      const raw = plotlyBinning(values, null, bins, binCount);
      const sample = plotlyHistogramSample(values, bins);
      assert.ok(sample.x.length <= 3 * (binCount + 1), `${name}: at most three values per bin`);
      const drawn = plotlyBinning(sample.x, sample.y, bins, binCount);
      const label = `${name} ${binCount} bins`;
      assert.deepEqual(drawn.counts, raw.counts, `${label} counts`);
      assert.equal(drawn.total, raw.total, `${label} total`);
      assert.equal(drawn.uniform, raw.uniform, `${label} single-value bins`);
      assert.ok(Object.is(drawn.leftGap, raw.leftGap), `${label} left gap`);
      assert.ok(Object.is(drawn.rightGap, raw.rightGap), `${label} right gap`);
      for (let bin = 0; bin < binCount; bin++) {
        assert.ok(Object.is(drawn.firsts[bin], raw.firsts[bin]), `${label} bin ${bin} first value`);
      }
    }
  }
});

test('the histogram trace carries the sample with summed weights', () => {
  const values = Float32Array.from({ length: 1000 }, (_, i) => (i % 10) / 2);
  const pageData = [{
    pageId: 'p', pageName: 'P', values, cellCount: values.length,
    variableInfo: { key: 'G', name: 'G', kind: 'continuous' },
  }];
  const [trace] = histogramDefinition.buildTraces(pageData, histogramDefinition.defaultOptions, null);
  assert.equal(trace.histfunc, 'sum');
  assert.equal(trace.x.length, trace.y.length);
  assert.ok(trace.x.length <= 3 * 20);
  let total = 0;
  for (const weight of trace.y) total += weight;
  assert.equal(total, values.length);

  // A constant page has no bin width; Plotly bins its raw values itself.
  const constant = [{ ...pageData[0], values: new Float32Array(50).fill(2) }];
  const [raw] = histogramDefinition.buildTraces(constant, histogramDefinition.defaultOptions, null);
  assert.equal(raw.histfunc, undefined);
  assert.equal(raw.x.length, 50);
});
