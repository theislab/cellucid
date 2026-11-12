/**
 * @fileoverview limma's linear models with empirical-Bayes moderated
 * variances (Smyth 2004, Stat Appl Genet Mol Biol 3:3; Law et al. 2014,
 * Genome Biol 15:R29), as pseudobulk differential expression fits them
 * (`stats/pseudobulk.js`).
 *
 * - `lmFit`: limma's `lmFit` (`lm.series`): each gene's least-squares fit
 *   on its observed samples (a NaN value is a missing one, as limma leaves
 *   out an NA), by Householder QR with R's `lm.fit` rank rule (a column
 *   whose remaining norm is under 1e-7 of its own is aliased and moved last,
 *   LINPACK `dqrdc2`); `Amean` is each gene's mean over its observed samples.
 *   One factorization serves every gene with the same observed samples.
 * - `eBayes`: limma's `eBayes(fit, trend = TRUE)` with `fitFDist`:
 *   `squeezeVar` with `fitFDist` estimates the prior degrees of freedom d0
 *   and the prior variance s0² from every gene's residual variance, s0² a
 *   natural cubic spline of `Amean` (limma-trend, the limma user's guide's
 *   pipeline for log-CPM: `splines::ns(Amean, df = 1 + (n >= 3) + (n >= 6)
 *   + (n >= 30), intercept = TRUE)`, its interior knots at quantiles of
 *   `Amean`, shoved inside as `ns` shoves a knot on a boundary); each
 *   gene's posterior variance `(d·s² + d0·s0²) / (d + d0)`, its moderated t
 *   `coefficient / stdev.unscaled / sqrt(s2.post)` on `min(d + d0, Σd)`
 *   degrees of freedom, and the two-sided p of R's `pt`.
 *
 * `fitFDist` is the estimator limma's `eBayes` itself takes whenever every
 * gene has the same residual degrees of freedom — the usual case, every
 * sample measured for every gene. When some genes have fewer (a sample with
 * too few measured cells of a gene, a modality that did not measure it),
 * limma ≥ 3.61 by default takes `fitFDistUnequalDF1`, whose trend is a
 * weighted `loessFit` (limma's C lowess); that is not replicated here, so
 * such fits keep `fitFDist` too (limma's estimator up to 3.60, which takes
 * unequal degrees of freedom as they are), as the reference script asks
 * `eBayes` to (`scripts/generate-pseudobulk-limma-reference.R`).
 *
 * limma's edge cases, as limma handles them: a gene with no residual
 * degrees of freedom has its variance taken as 0 and left out of the prior,
 * and is then moderated to s0² alone (d + d0 = d0 degrees of freedom); a
 * gene whose residual variance is 0 is kept, `fitFDist` lifting it to 1e-5
 * of the median; when the variances spread no more than chance (d0
 * infinite) every gene's variance is s0²; with fewer than three genes there
 * is no moderation. A coefficient that is not estimable (its column aliased
 * among the gene's observed samples) has no t.
 *
 * Every number is pinned to edgeR 4.10.7 / limma 3.68.5 (R 4.5.3) at 1e-6
 * in `tests/analysis-pseudobulk-limma.test.mjs`.
 *
 * @module analysis/stats/limma
 */

import { normalSurvival, gammaLn } from '../compute/math-utils.js';

// ============================================================================
// Means and order statistics as R computes them
// ============================================================================

/** R's `mean()`: the sum over n, then one correcting pass. */
export function rMean(values, count = values.length) {
  let s = 0;
  for (let i = 0; i < count; i++) s += values[i];
  s /= count;
  if (!Number.isFinite(s)) return s;
  let t = 0;
  for (let i = 0; i < count; i++) t += values[i] - s;
  return s + t / count;
}

/** R's `median()`. */
export function rMedian(values) {
  const sorted = Float64Array.from(values).sort();
  const n = sorted.length;
  if (n === 0) return NaN;
  const half = n >> 1;
  return n % 2 === 1 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
}

/**
 * R's `quantile(x, probs, type = 7)` of values already sorted ascending.
 *
 * @param {Float64Array} sorted
 * @param {number} prob
 * @returns {number}
 */
export function rQuantile7(sorted, prob) {
  const n = sorted.length;
  const index = 1 + Math.max(n - 1, 0) * prob;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  const qs = sorted[lo - 1];
  if (!(index > lo && sorted[hi - 1] !== qs)) return qs;
  const h = index - lo;
  return (1 - h) * qs + h * sorted[hi - 1];
}

// ============================================================================
// Polygamma functions
// ============================================================================

// Bernoulli numbers B2..B16 for the asymptotic series.
const BERNOULLI = [1 / 6, -1 / 30, 1 / 42, -1 / 30, 5 / 66, -691 / 2730, 7 / 6, -3617 / 510];
const ASYMPTOTIC_FROM = 12;

/** ψ(x), x > 0. */
export function digamma(x) {
  if (!(x > 0)) return NaN;
  let shift = 0;
  while (x < ASYMPTOTIC_FROM) {
    shift -= 1 / x;
    x += 1;
  }
  const inverseSquare = 1 / (x * x);
  let series = 0;
  let power = inverseSquare;
  for (let k = 1; k <= BERNOULLI.length; k++) {
    series += BERNOULLI[k - 1] / (2 * k) * power;
    power *= inverseSquare;
  }
  return shift + Math.log(x) - 1 / (2 * x) - series;
}

/** ψ′(x), x > 0. */
export function trigamma(x) {
  if (!(x > 0)) return NaN;
  let shift = 0;
  while (x < ASYMPTOTIC_FROM) {
    shift += 1 / (x * x);
    x += 1;
  }
  const inverseSquare = 1 / (x * x);
  let series = 0;
  let power = inverseSquare / x;
  for (let k = 1; k <= BERNOULLI.length; k++) {
    series += BERNOULLI[k - 1] * power;
    power *= inverseSquare;
  }
  return shift + 1 / x + inverseSquare / 2 + series;
}

/** ψ″(x), x > 0 (R's `psigamma(x, deriv = 2)`). */
export function tetragamma(x) {
  if (!(x > 0)) return NaN;
  let shift = 0;
  while (x < ASYMPTOTIC_FROM) {
    shift -= 2 / (x * x * x);
    x += 1;
  }
  const inverseSquare = 1 / (x * x);
  let series = 0;
  let power = inverseSquare * inverseSquare;
  for (let k = 1; k <= BERNOULLI.length; k++) {
    series += (2 * k + 1) * BERNOULLI[k - 1] * power;
    power *= inverseSquare;
  }
  return shift - inverseSquare - inverseSquare / x - series;
}

/** limma's `logmdigamma`: log(x) − ψ(x) without the cancellation, x > 0. */
export function logmdigamma(x) {
  if (!(x > 0)) return NaN;
  if (x < 5) {
    return Math.log(x / (x + 5)) + logmdigamma(x + 5) + 1 / x + 1 / (x + 1) + 1 / (x + 2) + 1 / (x + 3) + 1 / (x + 4);
  }
  const y = 1 / (x * x);
  const tail = y * (-1 / 12 + y * (1 / 120 + y * (-1 / 252 + y * (1 / 240 + y * (-1 / 132 + y * (691 / 32760 + y * (-1 / 12 + (3617 * y) / 8160)))))));
  return 1 / (2 * x) - tail;
}

/** limma's `trigammaInverse`: the y with ψ′(y) = x, by its Newton steps. */
export function trigammaInverse(x) {
  if (Number.isNaN(x)) return NaN;
  if (x < 0) return NaN;
  if (x > 1e7) return 1 / Math.sqrt(x);
  if (x < 1e-6) return 1 / x;
  let y = 0.5 + 1 / x;
  for (let iteration = 1; ; iteration++) {
    const tri = trigamma(y);
    const dif = (tri * (1 - tri / x)) / tetragamma(y);
    y += dif;
    if (-dif / y < 1e-8 || iteration > 50) break;
  }
  return y;
}

// ============================================================================
// Student's t, as R's pt
// ============================================================================

/**
 * The regularized incomplete beta I_x(a, b) by its continued fraction
 * (modified Lentz), on the side where it converges; `complement` is 1 − x,
 * passed exactly.
 */
function regularizedBeta(x, complement, a, b) {
  if (x <= 0) return 0;
  if (complement <= 0) return 1;
  if (x > (a + 1) / (a + b + 2)) return 1 - regularizedBeta(complement, x, b, a);
  const front = Math.exp(gammaLn(a + b) - gammaLn(a) - gammaLn(b) + a * Math.log(x) + b * Math.log(complement)) / a;
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 100_000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return front * h;
}

/**
 * `2 * pt(-abs(t), df)`, as R computes `pt`: the incomplete beta for finite
 * df up to 4e5, the normal approximation R takes beyond (Abramowitz &
 * Stegun 26.7.8), the normal at infinite df.
 *
 * @param {number} t
 * @param {number} df
 * @returns {number}
 */
export function studentTwoSidedP(t, df) {
  if (Number.isNaN(t) || !(df > 0)) return NaN;
  const x = Math.abs(t);
  if (x === Infinity) return 0;
  if (df === Infinity) return 2 * normalSurvival(x);
  if (df > 4e5) {
    const value = 1 / (4 * df);
    return 2 * normalSurvival((x * (1 - value)) / Math.sqrt(1 + x * x * 2 * value));
  }
  // The upper tail of I(x²/(df + x²); ½, df/2), that is I(df/(df + x²); df/2, ½).
  const squared = x * x;
  return regularizedBeta(df / (df + squared), squared / (df + squared), df / 2, 0.5);
}

// ============================================================================
// Least squares by Householder QR (R's lm.fit)
// ============================================================================

/** R's `lm.fit` tolerance: a column whose remaining norm is under this share of its own is aliased. */
const QR_TOLERANCE = 1e-7;

/**
 * The QR factorization of an n × p matrix (row-major), R's `dqrdc2` rule:
 * columns in order, an aliased one moved last.
 *
 * @param {Float64Array} matrix - n × p, row-major (copied)
 * @param {number} n
 * @param {number} p
 * @returns {{n: number, p: number, rank: number, pivot: Int32Array, v: Float64Array[], beta: Float64Array, r: Float64Array}}
 *   `pivot[k]` the original column at position k; `v`/`beta` the
 *   Householder reflections (H = I − beta·v·vᵀ); `r` the p × p upper triangle
 */
export function householderQr(matrix, n, p) {
  // Column-major working copy.
  const columns = Array.from({ length: p }, (_, j) => {
    const column = new Float64Array(n);
    for (let i = 0; i < n; i++) column[i] = matrix[i * p + j];
    return column;
  });
  const order = Array.from({ length: p }, (_, j) => j);
  const originalNorm = columns.map(column => {
    let squares = 0;
    for (let i = 0; i < n; i++) squares += column[i] * column[i];
    return Math.sqrt(squares) || 1;
  });
  const v = [];
  const beta = [];
  let k = 0;
  let last = p;
  while (k < Math.min(n, last)) {
    // The column's norm below the rows already reflected.
    const column = columns[k];
    let norm = 0;
    for (let i = k; i < n; i++) norm += column[i] * column[i];
    norm = Math.sqrt(norm);
    if (norm < originalNorm[k] * QR_TOLERANCE) {
      // Aliased: moved to the end, the others shifted left.
      columns.push(columns.splice(k, 1)[0]);
      order.push(order.splice(k, 1)[0]);
      originalNorm.push(originalNorm.splice(k, 1)[0]);
      last -= 1;
      continue;
    }
    if (k === n - 1) {
      // The last row: nothing below the diagonal to reflect.
      v.push(null);
      beta.push(0);
      k += 1;
      continue;
    }
    const alpha = column[k] >= 0 ? -norm : norm;
    const reflector = new Float64Array(n);
    for (let i = k; i < n; i++) reflector[i] = column[i];
    reflector[k] -= alpha;
    let vv = 0;
    for (let i = k; i < n; i++) vv += reflector[i] * reflector[i];
    const b = vv === 0 ? 0 : 2 / vv;
    for (let j = k; j < p; j++) {
      const target = columns[j];
      let dot = 0;
      for (let i = k; i < n; i++) dot += reflector[i] * target[i];
      const scale = b * dot;
      for (let i = k; i < n; i++) target[i] -= scale * reflector[i];
    }
    v.push(reflector);
    beta.push(b);
    k += 1;
  }
  const rank = k;
  const r = new Float64Array(p * p);
  for (let j = 0; j < p; j++) {
    for (let i = 0; i <= Math.min(j, n - 1); i++) r[i * p + j] = columns[j][i];
  }
  return { n, p, rank, pivot: Int32Array.from(order), v, beta: Float64Array.from(beta), r };
}

/** Qᵀy in place (the "effects" of R's lm.fit). */
export function applyQt(qr, y) {
  for (let k = 0; k < qr.v.length; k++) {
    const reflector = qr.v[k];
    if (reflector === null || qr.beta[k] === 0) continue;
    let dot = 0;
    for (let i = k; i < qr.n; i++) dot += reflector[i] * y[i];
    const scale = qr.beta[k] * dot;
    for (let i = k; i < qr.n; i++) y[i] -= scale * reflector[i];
  }
  return y;
}

/** R⁻¹ of the leading rank × rank triangle, row-major. */
function inverseUpperTriangle(qr) {
  const { rank, p, r } = qr;
  const inverse = new Float64Array(rank * rank);
  for (let j = 0; j < rank; j++) {
    inverse[j * rank + j] = 1 / r[j * p + j];
    for (let i = j - 1; i >= 0; i--) {
      let s = 0;
      for (let k = i + 1; k <= j; k++) s += r[i * p + k] * inverse[k * rank + j];
      inverse[i * rank + j] = -s / r[i * p + i];
    }
  }
  return inverse;
}

/**
 * A design's fit of one coefficient: the row of R⁻¹ that gives it from the
 * effects, and its unscaled standard deviation (√ of its diagonal entry of
 * (XᵀX)⁻¹, limma's `stdev.unscaled`), or null when it is aliased.
 */
function coefficientSolver(qr, coefficient) {
  const position = Array.prototype.indexOf.call(qr.pivot, coefficient);
  if (position < 0 || position >= qr.rank) return { qr, row: null, stdevUnscaled: NaN };
  const inverse = inverseUpperTriangle(qr);
  const row = new Float64Array(qr.rank);
  let squares = 0;
  for (let k = 0; k < qr.rank; k++) {
    row[k] = inverse[position * qr.rank + k];
    squares += row[k] * row[k];
  }
  return { qr, row, stdevUnscaled: Math.sqrt(squares) };
}

/**
 * limma's `lmFit` of one coefficient over every gene (`lm.series`).
 *
 * @param {Float64Array} values - genes × samples, gene-major; NaN: not observed
 * @param {number} geneCount
 * @param {number} sampleCount
 * @param {Float64Array} design - samples × columns, row-major
 * @param {number} columnCount
 * @param {number} coefficient - The column whose coefficient is wanted
 * @returns {{coefficient: Float64Array, stdevUnscaled: Float64Array, sigma: Float64Array, dfResidual: Float64Array, Amean: Float64Array, observed: Int32Array}}
 *   per gene; `observed` the samples it was fit on (0: none, all NaN)
 */
export function lmFit(values, geneCount, sampleCount, design, columnCount, coefficient) {
  if (values.length !== geneCount * sampleCount) throw new RangeError('lmFit values are genes × samples');
  if (design.length !== sampleCount * columnCount) throw new RangeError('lmFit design is samples × columns');
  const out = {
    coefficient: new Float64Array(geneCount).fill(NaN),
    stdevUnscaled: new Float64Array(geneCount).fill(NaN),
    sigma: new Float64Array(geneCount).fill(NaN),
    dfResidual: new Float64Array(geneCount),
    Amean: new Float64Array(geneCount).fill(NaN),
    observed: new Int32Array(geneCount)
  };
  /** @type {Map<string, Object>} One factorization per set of observed samples. */
  const solvers = new Map();
  const rows = new Int32Array(sampleCount);
  const y = new Float64Array(sampleCount);
  for (let gene = 0; gene < geneCount; gene++) {
    const base = gene * sampleCount;
    let n = 0;
    let sum = 0;
    let key = '';
    for (let s = 0; s < sampleCount; s++) {
      const value = values[base + s];
      if (Number.isFinite(value)) {
        rows[n++] = s;
        sum += value;
        key += `${s},`;
      }
    }
    out.observed[gene] = n;
    if (n === 0) continue;
    out.Amean[gene] = sum / n;
    let solver = solvers.get(key);
    if (solver === undefined) {
      const x = new Float64Array(n * columnCount);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < columnCount; j++) x[i * columnCount + j] = design[rows[i] * columnCount + j];
      }
      solver = coefficientSolver(householderQr(x, n, columnCount), coefficient);
      solvers.set(key, solver);
    }
    const effects = y.subarray(0, n);
    for (let i = 0; i < n; i++) effects[i] = values[base + rows[i]];
    applyQt(solver.qr, effects);
    const rank = solver.qr.rank;
    const df = n - rank;
    out.dfResidual[gene] = df;
    if (df > 0) {
      let squares = 0;
      for (let i = rank; i < n; i++) squares += effects[i] * effects[i];
      out.sigma[gene] = Math.sqrt(squares / df);
    }
    if (solver.row !== null) {
      let estimate = 0;
      for (let k = 0; k < rank; k++) estimate += solver.row[k] * effects[k];
      out.coefficient[gene] = estimate;
      out.stdevUnscaled[gene] = solver.stdevUnscaled;
    }
  }
  return out;
}

// ============================================================================
// Natural cubic splines (splines::ns)
// ============================================================================

/**
 * The values (or a derivative) at `x` of the B-splines of order `order` on
 * `knots`, as `splines::splineDesign` (x at the last knot: from the left).
 */
function bsplineRow(knots, x, order, derivative) {
  const count = knots.length - order;
  const right = knots[count];
  // The interval [knots[i], knots[i + 1]) holding x.
  let interval = -1;
  for (let i = order - 1; i < count; i++) {
    if (knots[i] < knots[i + 1] && knots[i] <= x && (x < knots[i + 1] || (x === right && knots[i + 1] === right))) interval = i;
  }
  const memo = new Map();
  const basis = (i, k, d) => {
    const key = `${i},${k},${d}`;
    if (memo.has(key)) return memo.get(key);
    let value;
    if (k === 1) {
      value = d > 0 ? 0 : (i === interval ? 1 : 0);
    } else if (d > 0) {
      const left = knots[i + k - 1] - knots[i];
      const rightSpan = knots[i + k] - knots[i + 1];
      value = (k - 1) * ((left > 0 ? basis(i, k - 1, d - 1) / left : 0) - (rightSpan > 0 ? basis(i + 1, k - 1, d - 1) / rightSpan : 0));
    } else {
      const left = knots[i + k - 1] - knots[i];
      const rightSpan = knots[i + k] - knots[i + 1];
      value = (left > 0 ? ((x - knots[i]) / left) * basis(i, k - 1, 0) : 0) +
        (rightSpan > 0 ? ((knots[i + k] - x) / rightSpan) * basis(i + 1, k - 1, 0) : 0);
    }
    memo.set(key, value);
    return value;
  };
  const row = new Float64Array(count);
  for (let i = 0; i < count; i++) row[i] = basis(i, order, derivative);
  return row;
}

/**
 * `splines::ns(x, df, intercept = TRUE)`: its knots (interior at the
 * quantiles of `x`, shoved inside off a boundary as `ns` shoves them) and a
 * function giving a row of its basis at any point (linear beyond the
 * boundary knots, as `predict` on it extends). The basis spans the same
 * space as R's; a fit on it has R's fitted values.
 *
 * @param {Float64Array} x
 * @param {number} df
 * @returns {{knots: number[], boundary: [number, number], row: (point: number) => Float64Array}}
 */
export function naturalSplineBasis(x, df) {
  const sorted = Float64Array.from(x).sort();
  const boundary = [sorted[0], sorted[sorted.length - 1]];
  const interiorCount = Math.max(df - 2, 0);
  const knots = [];
  const by = 1 / (interiorCount + 1);
  for (let i = 1; i <= interiorCount; i++) knots.push(rQuantile7(sorted, i * by));
  if (knots.length > 0) {
    const [low, high] = boundary;
    if (knots.includes(low)) {
      if (knots.every(knot => knot === low)) throw new RangeError('All interior knots of the trend match its left boundary (more than two thirds of the genes share the lowest mean)');
      const shift = (Math.min(...knots.filter(knot => knot > low)) - low) / 8;
      for (let i = 0; i < knots.length; i++) if (knots[i] === low) knots[i] += shift;
    }
    if (knots.includes(high)) {
      if (knots.every(knot => knot === high)) throw new RangeError('All interior knots of the trend match its right boundary');
      const shift = (high - Math.max(...knots.filter(knot => knot < high))) / 8;
      for (let i = 0; i < knots.length; i++) if (knots[i] === high) knots[i] -= shift;
    }
  }
  const allKnots = [boundary[0], boundary[0], boundary[0], boundary[0], ...knots, boundary[1], boundary[1], boundary[1], boundary[1]].sort((a, b) => a - b);
  const width = allKnots.length - 4;
  // The second derivative at both boundaries is 0: the basis is the
  // B-splines times the null space of those two constraints (Householder
  // of the constraints' transpose, its columns past the first two, as `ns`).
  const constraints = [bsplineRow(allKnots, boundary[0], 4, 2), bsplineRow(allKnots, boundary[1], 4, 2)];
  const transposed = new Float64Array(width * 2);
  for (let i = 0; i < width; i++) {
    transposed[i * 2] = constraints[0][i];
    transposed[i * 2 + 1] = constraints[1][i];
  }
  const constraintQr = householderQr(transposed, width, 2);
  const project = bspline => applyQt(constraintQr, bspline).slice(2);
  const row = point => {
    if (point < boundary[0] || point > boundary[1]) {
      const pivot = point < boundary[0] ? boundary[0] : boundary[1];
      const value = bsplineRow(allKnots, pivot, 4, 0);
      const slope = bsplineRow(allKnots, pivot, 4, 1);
      for (let i = 0; i < width; i++) value[i] += (point - pivot) * slope[i];
      return project(value);
    }
    return project(bsplineRow(allKnots, point, 4, 0));
  };
  return { knots, boundary, row };
}

// ============================================================================
// Empirical Bayes
// ============================================================================

/**
 * limma's `fitFDist`: the scale and second degrees of freedom of the scaled
 * F distribution the variances follow, the scale a natural-spline trend of
 * `covariate` when given.
 *
 * @param {Float64Array} x - Variances
 * @param {Float64Array} df1 - Their degrees of freedom
 * @param {Float64Array|null} covariate
 * @returns {{scale: Float64Array|number, df2: number, splineDf: number}}
 */
export function fitFDist(x, df1, covariate = null) {
  const n = x.length;
  if (n === 0) return { scale: NaN, df2: NaN, splineDf: 0 };
  if (n === 1) return { scale: x[0], df2: 0, splineDf: 0 };
  const ok = new Uint8Array(n);
  let nok = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(df1[i]) && df1[i] > 1e-15 && Number.isFinite(x[i]) && x[i] > -1e-15) {
      ok[i] = 1;
      nok += 1;
    }
  }
  if (nok === 0) throw new RangeError('No gene has a residual variance to estimate the prior from');
  const okX = new Float64Array(nok);
  const okDf = new Float64Array(nok);
  const okCovariate = covariate === null ? null : new Float64Array(nok);
  for (let i = 0, k = 0; i < n; i++) {
    if (!ok[i]) continue;
    okX[k] = x[i];
    okDf[k] = df1[i];
    if (okCovariate !== null) okCovariate[k] = covariate[i];
    k += 1;
  }
  if (nok === 1) return { scale: okX[0], df2: 0, splineDf: 0 };
  let splineDf = 1;
  if (covariate !== null) {
    splineDf = 1 + (nok >= 3) + (nok >= 6) + (nok >= 30);
    splineDf = Math.min(splineDf, new Set(okCovariate).size);
    if (splineDf < 2) {
      const flat = fitFDist(okX, okDf, null);
      return { scale: new Float64Array(n).fill(flat.scale), df2: flat.df2, splineDf: 1 };
    }
  }
  for (let i = 0; i < nok; i++) okX[i] = Math.max(okX[i], 0);
  let m = rMedian(okX);
  if (m === 0) m = 1;
  const e = new Float64Array(nok);
  for (let i = 0; i < nok; i++) {
    okX[i] = Math.max(okX[i], 1e-5 * m);
    e[i] = Math.log(okX[i]) + logmdigamma(okDf[i] / 2);
  }
  let emean;
  let evar;
  if (covariate === null) {
    emean = rMean(e);
    let squares = 0;
    for (let i = 0; i < nok; i++) squares += (e[i] - emean) ** 2;
    evar = squares / (nok - 1);
  } else {
    const spline = naturalSplineBasis(okCovariate, splineDf);
    // The basis at every gene: the fit's rows (the ok genes), and the trend
    // at the others (`predict` on the basis).
    const rows = new Float64Array(n * splineDf);
    for (let i = 0; i < n; i++) rows.set(spline.row(covariate[i]), i * splineDf);
    const design = new Float64Array(nok * splineDf);
    for (let i = 0, k = 0; i < n; i++) {
      if (ok[i]) design.set(rows.subarray(i * splineDf, (i + 1) * splineDf), (k++) * splineDf);
    }
    const qr = householderQr(design, nok, splineDf);
    const effects = applyQt(qr, Float64Array.from(e));
    const residualSquares = new Float64Array(nok - qr.rank);
    for (let i = qr.rank; i < nok; i++) residualSquares[i - qr.rank] = effects[i] ** 2;
    evar = rMean(residualSquares);
    // The coefficients (aliased columns 0), then the trend at every gene.
    const inverse = inverseUpperTriangle(qr);
    const coefficients = new Float64Array(splineDf);
    for (let row = 0; row < qr.rank; row++) {
      let s = 0;
      for (let k = row; k < qr.rank; k++) s += inverse[row * qr.rank + k] * effects[k];
      coefficients[qr.pivot[row]] = s;
    }
    emean = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < splineDf; j++) s += rows[i * splineDf + j] * coefficients[j];
      emean[i] = s;
    }
  }
  const trigammas = Float64Array.from(okDf, df => trigamma(df / 2));
  evar -= rMean(trigammas);
  if (evar > 0) {
    const df2 = 2 * trigammaInverse(evar);
    const shift = logmdigamma(df2 / 2);
    const scale = covariate === null ? Math.exp(emean - shift) : emean.map(value => Math.exp(value - shift));
    return { scale, df2, splineDf };
  }
  return {
    scale: covariate === null ? rMean(okX) : emean.map(value => Math.exp(value)),
    df2: Infinity,
    splineDf
  };
}

/**
 * limma's `squeezeVar(var, df, covariate)` with `fitFDist`.
 *
 * @param {Float64Array} variance - Residual variances (NaN with no df)
 * @param {Float64Array} df - Residual degrees of freedom
 * @param {Float64Array|null} covariate - The trend's covariate (Amean), or null
 * @returns {{dfPrior: number, varPrior: Float64Array, varPost: Float64Array, splineDf: number}}
 */
export function squeezeVar(variance, df, covariate = null) {
  const n = variance.length;
  if (n === 0) throw new RangeError('No variances to moderate');
  if (n < 3) return { dfPrior: 0, varPrior: Float64Array.from(variance), varPost: Float64Array.from(variance), splineDf: 0 };
  const v = Float64Array.from(variance);
  for (let i = 0; i < n; i++) if (df[i] === 0) v[i] = 0;
  const fit = fitFDist(v, df, covariate);
  const dfPrior = fit.df2;
  if (Number.isNaN(dfPrior)) throw new RangeError('Could not estimate the prior degrees of freedom');
  const varPrior = typeof fit.scale === 'number' ? new Float64Array(n).fill(fit.scale) : fit.scale;
  const varPost = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    varPost[i] = dfPrior === Infinity ? varPrior[i] : (df[i] * v[i] + dfPrior * varPrior[i]) / (df[i] + dfPrior);
  }
  return { dfPrior, varPrior, varPost, splineDf: fit.splineDf };
}

/**
 * limma's `eBayes(fit, trend)` of one coefficient, with `fitFDist`.
 *
 * @param {{coefficient: Float64Array, stdevUnscaled: Float64Array, sigma: Float64Array, dfResidual: Float64Array, Amean: Float64Array}} fit - `lmFit`
 * @param {{trend?: boolean}} [options]
 * @returns {{t: Float64Array, pValue: Float64Array, dfTotal: Float64Array, s2Post: Float64Array, s2Prior: Float64Array, dfPrior: number, dfPooled: number, splineDf: number}}
 */
export function eBayes(fit, { trend = true } = {}) {
  const n = fit.sigma.length;
  let maxDf = 0;
  let anyFinite = false;
  let dfPooled = 0;
  for (let i = 0; i < n; i++) {
    maxDf = Math.max(maxDf, fit.dfResidual[i]);
    dfPooled += fit.dfResidual[i];
    if (Number.isFinite(fit.sigma[i])) anyFinite = true;
  }
  if (maxDf === 0) throw new RangeError('No residual degrees of freedom in the linear model fits');
  if (!anyFinite) throw new RangeError('No finite residual standard deviations');
  const variance = fit.sigma.map(sigma => sigma * sigma);
  const squeezed = squeezeVar(variance, fit.dfResidual, trend ? fit.Amean : null);
  const t = new Float64Array(n);
  const pValue = new Float64Array(n);
  const dfTotal = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = fit.coefficient[i] / fit.stdevUnscaled[i] / Math.sqrt(squeezed.varPost[i]);
    dfTotal[i] = Math.min(fit.dfResidual[i] + squeezed.dfPrior, dfPooled);
    pValue[i] = studentTwoSidedP(t[i], dfTotal[i]);
  }
  return {
    t,
    pValue,
    dfTotal,
    s2Post: squeezed.varPost,
    s2Prior: squeezed.varPrior,
    dfPrior: squeezed.dfPrior,
    dfPooled,
    splineDf: squeezed.splineDf
  };
}
