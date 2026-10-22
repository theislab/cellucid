/**
 * The vendored Plotly bundle carries two local patches, both in the violin
 * kernel density estimate (`makeKDE`, module 60168 of plotly.js 2.27.0). The
 * second reads the density at the grid points from a table the trace carries
 * (`_precomputedKDE`, summed on the analysis workers by
 * assets/js/app/analysis/plots/plotly-violin-density.js with the same
 * arithmetic), only when its bandwidth and sample size are Plotly's own and
 * only for the grid points in order; the last test pins it. The first is the
 * kernel sum itself. Upstream evaluates the
 * Gaussian kernel once per sample value for every density point — about 300
 * million `Math.exp` calls for a one-million-cell violin, a 3.7 s main-thread
 * freeze. When runs of equal values make up at least half the sample, the
 * patch evaluates it once per run and skips values 39 or more bandwidths away,
 * whose kernel `exp(-0.5 x^2) / sqrt(2 pi)` is exactly 0, while still adding
 * every term in the original order; other samples keep the upstream loop.
 *
 * The contract is bit-identity with upstream: every density value, compared
 * with `Object.is`, over the inputs Plotly hands it (sorted samples, which is
 * what violin `calc` and hover pass) and over inputs it never does (unsorted,
 * signed zeros, NaN, zero or infinite bandwidth), where the patch must fall
 * back to the plain ordered sum.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const BUNDLE = readFileSync(
  new URL('../assets/external/plotly.min.js', import.meta.url),
  'utf8'
);

/** plotly.js 2.27.0, src/traces/violin/helpers.js, as minified upstream. */
const UPSTREAM_MAKE_KDE =
  'e.makeKDE=function(t,e,r){var n=r.length,a=i,o=t.bandwidth,s=1/(n*o);'
  + 'return function(t){for(var e=0,i=0;i<n;i++)e+=a((t-r[i])/o);return s*e}}';
const UPSTREAM_KERNEL =
  'i=function(t){return 1/Math.sqrt(2*Math.PI)*Math.exp(-.5*t*t)}';

function vendoredMakeKdeSource() {
  const start = BUNDLE.indexOf('e.makeKDE=function(t,e,r){');
  assert.notEqual(start, -1, 'the bundle defines makeKDE');
  assert.equal(
    BUNDLE.indexOf('e.makeKDE=function(t,e,r){', start + 1),
    -1,
    'the bundle defines makeKDE exactly once'
  );
  // The original kernel sum is the makeKDE body's inner function `K`, which
  // ends the definition with its returned evaluator.
  const end = BUNDLE.indexOf('return s*e}}}', start);
  assert.notEqual(end, -1, 'the makeKDE definition is complete');
  // The kernel it closes over must still be upstream's.
  const moduleStart = BUNDLE.lastIndexOf('60168:function', start);
  assert.notEqual(moduleStart, -1, 'makeKDE lives in the violin helpers module');
  assert.ok(
    BUNDLE.slice(moduleStart, start).includes(UPSTREAM_KERNEL),
    'the violin kernel is the upstream Gaussian'
  );
  return BUNDLE.slice(start, end + 'return s*e}}}'.length);
}

function compile(source) {
  return new Function(`var ${UPSTREAM_KERNEL};var e={};${source};return e.makeKDE;`)();
}

const upstream = compile(UPSTREAM_MAKE_KDE);
const vendored = compile(vendoredMakeKdeSource());

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Upstream violin `calc` grid, widened far past the tails. */
function evaluationPoints(values, bandwidth, reach = 60) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of values) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  if (!Number.isFinite(lo)) return [0, 1, -1];
  lo -= reach * bandwidth;
  hi += reach * bandwidth;
  const count = Math.ceil((hi - lo) / (bandwidth / 3));
  const step = (hi - lo) / count;
  const points = [];
  for (let k = 0, at = lo; at < hi + step / 2; k++, at += step) points.push(at);
  return points;
}

function assertBitIdentical(values, bandwidth, label, points = null) {
  const reference = upstream({ bandwidth }, null, values);
  const patched = vendored({ bandwidth }, null, values);
  const at = points ?? evaluationPoints(values, bandwidth);
  let mismatches = 0;
  let first = null;
  for (const t of at) {
    const expected = reference(t);
    const actual = patched(t);
    if (!Object.is(expected, actual)) {
      mismatches++;
      first ??= { t, expected, actual };
    }
  }
  assert.equal(
    mismatches,
    0,
    `${label}: ${mismatches} of ${at.length} densities differ; first ${JSON.stringify(first)}`
  );
}

function quantizedSample(n, zeroFraction, random) {
  const values = new Array(n);
  for (let i = 0; i < n; i++) {
    values[i] = random() < zeroFraction
      ? 0
      : Math.fround(Math.round(random() * 254) * (3.7 / 254));
  }
  return values;
}

function normalSample(n, random) {
  const values = new Array(n);
  for (let i = 0; i < n; i++) {
    const u = Math.max(random(), 1e-12);
    values[i] = Math.fround(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random()));
  }
  return values;
}

const ascending = values => [...values].sort((a, b) => a - b);

test('the vendored violin KDE is patched, not upstream', () => {
  assert.equal(BUNDLE.includes(UPSTREAM_MAKE_KDE), false);
});

test('sorted quantized expression densities are bit-identical to upstream', () => {
  const random = lcg(11);
  for (const zeroFraction of [0, 0.5, 0.9]) {
    const values = ascending(quantizedSample(30_000, zeroFraction, random));
    for (const bandwidth of [0.01, 0.08, 0.6]) {
      assertBitIdentical(values, bandwidth, `quantized z=${zeroFraction} bw=${bandwidth}`);
    }
  }
});

test('sorted continuous densities are bit-identical to upstream, tails included', () => {
  const random = lcg(23);
  const values = ascending(normalSample(30_000, random));
  for (const bandwidth of [0.02, 0.3, 5]) {
    assertBitIdentical(values, bandwidth, `continuous bw=${bandwidth}`);
  }
  // A bandwidth far below the spacing leaves most values outside every window.
  assertBitIdentical(ascending(normalSample(1_500, random)), 2e-3, 'continuous bw=2e-3');
});

test('tie-heavy continuous samples take the run path and match upstream', () => {
  const random = lcg(31);
  const values = normalSample(20_000, random).map((v, i) => (i % 5 < 3 ? 0 : Math.abs(v)));
  values[0] = 30;
  assertBitIdentical(ascending(values), 0.05, 'zero-inflated continuous');
  assertBitIdentical(ascending(values), 0.02, 'zero-inflated continuous, narrow');
});

test('unsorted samples fall back to the plain ordered sum', () => {
  const random = lcg(5);
  assertBitIdentical(quantizedSample(10_000, 0.6, random), 0.05, 'unsorted quantized');
  assertBitIdentical(normalSample(10_000, random), 0.05, 'unsorted continuous');
});

test('edge samples match upstream exactly', () => {
  assertBitIdentical([5], 0.1, 'single value');
  assertBitIdentical([-0, 0, 0, -0, 1, 1, 2], 0.3, 'signed zeros');
  assertBitIdentical([-1e300, 0, 1e300], 1, 'extreme magnitudes', [-1e300, 0, 1e300, 1]);
  assertBitIdentical([0, 1, NaN, 2], 0.3, 'NaN member', [-1, 0, 0.5, 1, 2, 3]);
  assertBitIdentical([1, 1, 1], 0, 'zero bandwidth', [0, 1, 2]);
  assertBitIdentical([1, 2, 3], Infinity, 'infinite bandwidth', [0, 1, 2]);
  assertBitIdentical([], 0.5, 'empty sample', [0, 1]);
});

test('precomputed grid densities are read back in order, and only when they match', async () => {
  const { plotlyViolinPlan, plotlyViolinDensitySlice, plotlyViolinKernelDensity } = await import(
    '../assets/js/app/analysis/plots/plotly-violin-density.js'
  );
  const random = lcg(47);
  const values = quantizedSample(8_000, 0.6, random).concat(normalSample(3_000, random));
  const plan = plotlyViolinPlan(values);
  const { t, v } = plotlyViolinDensitySlice(plan, 0, plan.count);
  const sorted = Array.from(plan.sorted);
  const reference = upstream({ bandwidth: plan.bandwidth }, null, sorted);
  // The transcribed kernel sum is the vendored one, bit for bit, at every point.
  const transcribed = plotlyViolinKernelDensity(plan.sorted, plan.bandwidth);
  for (let k = 0; k < t.length; k++) {
    assert.ok(Object.is(v[k], reference(t[k])), `grid point ${k}`);
    assert.ok(Object.is(transcribed(t[k] + 0.013), reference(t[k] + 0.013)), `off-grid point ${k}`);
  }

  const table = { bandwidth: plan.bandwidth, count: sorted.length, t, v: new Float64Array(v.length).fill(-1) };
  const trace = { _input: { _precomputedKDE: table } };
  const fromTable = vendored({ bandwidth: plan.bandwidth }, trace, sorted);
  for (let k = 0; k < t.length; k++) {
    assert.equal(fromTable(t[k]), -1, `grid point ${k} is read from the table`);
  }
  // A point that is not the next grid point is summed.
  const offGrid = vendored({ bandwidth: plan.bandwidth }, trace, sorted);
  assert.ok(Object.is(offGrid(t[3]), reference(t[3])));
  // A table for another bandwidth or another sample size is never read.
  for (const mismatch of [
    vendored({ bandwidth: plan.bandwidth * 1.5 }, trace, sorted),
    vendored({ bandwidth: plan.bandwidth }, trace, sorted.slice(1)),
  ]) {
    assert.notEqual(mismatch(t[0]), -1);
  }
});

test('the patched bundle is still a valid script', () => {
  assert.doesNotThrow(() => new Function(BUNDLE));
});
