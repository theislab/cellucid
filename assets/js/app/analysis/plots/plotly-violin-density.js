/**
 * The kernel density a violin draws, computed exactly as the vendored Plotly
 * (2.27.0, violin `calc`, with the local `makeKDE` patch) computes it from raw
 * values, so that the analysis workers can sum it in parallel off the main
 * thread.
 *
 * Plotly's violin `calc` evaluates a Gaussian kernel density at a grid of
 * points spanning the data: one kernel term per value per grid point, about
 * 400 million for a million distinct values and a 2.4 s freeze. Every step is
 * mirrored here operation for operation — the box `calc` order statistics over
 * the same ascending order, the bandwidth (Silverman's rule as Plotly applies
 * it), the soft span and its range cleaning, the grid accumulation, and the
 * (patched, bit-identical-to-upstream) kernel sum — so every density value is
 * the same double. The vendored bundle carries a second local patch: `makeKDE`
 * returns these precomputed values for the grid points it is asked for, in
 * order, when the trace carries them and the bandwidth and sample size are the
 * ones Plotly computed itself; any other point (a hover) is summed as before.
 * tests/plotly-violin-kde-contract.test.mjs and
 * tests/browser/analysis-violin-kde-identity.spec.mjs hold it to that.
 *
 * @module plots/plotly-violin-density
 */

import { sortLikePlotly } from './plotly-box-statistics.js';

/** Plotly `FP_SAFE`: the range a linear axis is clamped to. */
const FP_SAFE = 1e-4 * Number.MAX_VALUE;

/** Plotly violin kernel: `1/Math.sqrt(2*Math.PI)*Math.exp(-.5*t*t)`. */
function kernel(t) {
  return 1 / Math.sqrt(2 * Math.PI) * Math.exp(-0.5 * t * t);
}

/** Plotly `Lib.interp`. */
function interp(sorted, fraction) {
  const n = fraction * sorted.length - 0.5;
  if (n < 0) return sorted[0];
  if (n > sorted.length - 1) return sorted[sorted.length - 1];
  const frac = n % 1;
  return frac * sorted[Math.ceil(n)] + (1 - frac) * sorted[Math.floor(n)];
}

/**
 * @typedef {Object} ViolinDensityPlan
 * @property {Float64Array} sorted - The values in the order Plotly's box calc sorts them
 * @property {number} bandwidth
 * @property {number} count - Grid points (0 when the violin is a single value)
 * @property {number} start - First grid point
 * @property {number} step - Grid spacing
 */

/**
 * The bandwidth and evaluation grid Plotly's violin `calc` derives from these
 * values (`spanmode: 'soft'`, no explicit bandwidth).
 *
 * @param {ArrayLike<number>} values - At least one finite number
 * @returns {ViolinDensityPlan}
 */
export function plotlyViolinPlan(values) {
  if (values.length === 0) {
    throw new RangeError('A violin density needs at least one value');
  }
  const sorted = sortLikePlotly(values);
  const n = sorted.length;
  const min = sorted[0];
  const max = sorted[n - 1];
  const spread = max - min;
  if (!spread) return { sorted, bandwidth: 0, count: 0, start: min, step: 0 };

  // Box calc mean (`Lib.mean`), then `Lib.stdev(vals, n - 1, mean)`.
  let sum = 0;
  for (let i = 0; i < n; i++) sum = sum + sorted[i];
  const mean = sum / n;
  let squares = 0;
  for (let i = 0; i < n; i++) squares = squares + Math.pow(sorted[i] - mean, 2);
  const stdev = Math.sqrt(squares / (n - 1 || n));
  const q1 = interp(sorted, 0.25);
  const q3 = interp(sorted, 0.75);
  const bandwidth = Math.max(
    1.059 * Math.min(stdev, (q3 - q1) / 1.349) * Math.pow(n, -0.2),
    spread / 100
  );

  // Soft span, cleaned as a linear axis range.
  const span = [min - 2 * bandwidth, max + 2 * bandwidth];
  for (let i = 0; i < 2; i++) {
    if (span[i] < -FP_SAFE) span[i] = -FP_SAFE;
    else if (span[i] > FP_SAFE) span[i] = FP_SAFE;
  }
  if (span[0] === span[1]) {
    const widen = Math.max(1, Math.abs(1e-6 * span[0]));
    span[0] -= widen;
    span[1] += widen;
  }
  const width = span[1] - span[0];
  const slots = Math.ceil(width / (bandwidth / 3));
  const step = width / slots;
  if (!Number.isFinite(step) || !Number.isFinite(slots)) {
    throw new RangeError('The violin span is not finite');
  }
  let count = 0;
  for (let t = span[0]; t < span[1] + step / 2; t += step) count++;
  return { sorted, bandwidth, count, start: span[0], step, end: span[1] };
}

/**
 * The patched `makeKDE` of the vendored bundle, transcribed: a kernel sum over
 * ascending values that evaluates the kernel once per run of equal values and
 * skips runs 39 or more bandwidths away, whose kernel is exactly 0, when runs
 * are at most half the sample; otherwise the plain ordered sum.
 *
 * @param {Float64Array} sorted
 * @param {number} bandwidth
 * @returns {(t: number) => number}
 */
export function plotlyViolinKernelDensity(sorted, bandwidth) {
  const n = sorted.length;
  const scale = 1 / (n * bandwidth);
  let runs = 0;
  for (let j = 0, k; j < n; j = k) {
    const v = sorted[j];
    for (k = j + 1; k < n && sorted[k] === v;) k++;
    runs++;
  }
  if (2 * runs > n) {
    return t => {
      let e = 0;
      for (let i = 0; i < n; i++) e += kernel((t - sorted[i]) / bandwidth);
      return scale * e;
    };
  }
  let windowed = bandwidth > 0 && bandwidth < Infinity;
  const runValues = new Float64Array(runs);
  const runCounts = new Float64Array(runs);
  runs = 0;
  for (let j = 0, k; j < n; j = k) {
    const v = sorted[j];
    for (k = j + 1; k < n && sorted[k] === v;) k++;
    if (runs > 0 && !(v > runValues[runs - 1])) windowed = false;
    runValues[runs] = v;
    runCounts[runs++] = k - j;
  }
  return t => {
    let e = 0;
    let l = 0;
    let h = runs;
    if (windowed) {
      for (let m = runs; l < m;) {
        const x = (l + m) >> 1;
        if ((t - runValues[x]) / bandwidth < 39) m = x;
        else l = x + 1;
      }
      let x = l;
      for (let m = runs; x < m;) {
        const y = (x + m) >> 1;
        if ((t - runValues[y]) / bandwidth > -39) x = y + 1;
        else m = y;
      }
      h = x;
    }
    for (; l < h; l++) {
      const term = kernel((t - runValues[l]) / bandwidth);
      if (term !== 0) for (let y = runCounts[l]; y > 0; y--) e += term;
    }
    return scale * e;
  };
}

/**
 * Grid points `from … to - 1` of a plan and the density at each, accumulated
 * exactly as Plotly's violin `calc` steps through its grid.
 *
 * @param {ViolinDensityPlan} plan
 * @param {number} from
 * @param {number} to
 * @returns {{t: Float64Array, v: Float64Array}}
 */
export function plotlyViolinDensitySlice(plan, from, to) {
  const end = Math.min(to, plan.count);
  const size = Math.max(0, end - from);
  const t = new Float64Array(size);
  const v = new Float64Array(size);
  if (size === 0) return { t, v };
  const density = plotlyViolinKernelDensity(plan.sorted, plan.bandwidth);
  let point = plan.start;
  for (let k = 0; k < end; k++, point += plan.step) {
    if (k >= from) {
      t[k - from] = point;
      v[k - from] = density(point);
    }
  }
  return { t, v };
}
