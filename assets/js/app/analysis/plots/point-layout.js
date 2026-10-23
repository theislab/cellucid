/**
 * Where Plotly puts the points of a box or violin, and where they land in
 * plot pixels: the vendored Plotly 2.27.0 point loop (box `plotPoints`) and
 * axis conversion (`c2p`) operation for operation, so that the point layer
 * (point-layer.js) can lay points out in a worker.
 *
 * - Jitter: each point's spread is `sqrt(0.01 · span · (g − d) / (v_g − v_d +
 *   1e-9 · span))` over its ±5 neighbours in sorted order (outliers bounded by
 *   the fences unless every point is drawn), clamped to [0, 1] and scaled by
 *   `2 · jitter / max`; the offset is `spread · (pseudoRandom() − 0.5)`, with
 *   Plotly's `Lib.pseudoRandom` (69069 LCG from 2e9, reseeded for every trace,
 *   one draw per point in order; only box and violin points draw from it).
 * - Position: `pos + bPos + bdPos · (pointpos + offset)` on the position axis.
 * - Pixels: `l2p(v) = round2(_b + _m · v)` (`d3.round(·, 2)`), after `log10`
 *   on a log axis (no pixel for v ≤ 0).
 *
 * tests/browser/analysis-point-layer-identity.spec.mjs compares every position
 * and pixel with Plotly's own SVG points.
 *
 * @module plots/point-layout
 */

/**
 * Plotly's `Lib.pseudoRandom` from its seed, as a stateful generator.
 * @returns {() => number}
 */
export function plotlyPseudoRandom() {
  let state = 2e9;
  const next = () => {
    const previous = state;
    state = (69069 * state + 1) % 4294967296;
    return Math.abs(state - previous) < 429496729 ? next() : state / 4294967296;
  };
  return next;
}

/**
 * @typedef {Object} PointLayoutInput
 * @property {ArrayLike<number>} vals - Drawn values, ascending as Plotly sorts them
 * @property {number} min
 * @property {number} max
 * @property {number} q1
 * @property {number} q3
 * @property {number} lf - Lower fence
 * @property {number} uf - Upper fence
 * @property {number} pos - The box's position
 * @property {number} jitter
 * @property {number} pointpos
 * @property {number} bPos
 * @property {number} bdPos
 * @property {string} mode - 'all', 'outliers' or 'suspectedoutliers'
 * @property {number} drawsBefore - Points of earlier boxes of the same trace
 *   (each drew once from the trace's sequence when jittered)
 */

/**
 * The position-axis coordinate of every drawn point.
 * @param {PointLayoutInput} input
 * @returns {Float64Array}
 */
export function layoutPoints(input) {
  const { vals, min, max, q1, q3, lf, uf, pos, jitter, pointpos, bPos, bdPos, mode, drawsBefore } = input;
  const count = vals.length;
  const span = Math.max((max - min) / 10, q3 - q1);
  const eps = 1e-9 * span;
  const scale = 0.01 * span;
  const spread = new Float64Array(count);
  let largest = 0;
  let factor = 0;
  if (jitter) {
    if (span === 0) {
      largest = 1;
      spread.fill(1);
    } else {
      for (let i = 0; i < count; i++) {
        const d = Math.max(0, i - 5);
        let low = vals[d];
        const g = Math.min(count - 1, i + 5);
        let high = vals[g];
        if (mode !== 'all') {
          if (vals[i] < lf) high = Math.min(high, lf);
          else low = Math.max(low, uf);
        }
        let m = Math.sqrt(scale * (g - d) / (high - low + eps)) || 0;
        m = Math.max(0, Math.min(1, Math.abs(m)));
        spread[i] = m;
        largest = Math.max(m, largest);
      }
    }
    factor = 2 * jitter / (largest || 1);
  }
  const random = plotlyPseudoRandom();
  if (jitter) for (let i = 0; i < drawsBefore; i++) random();
  const positions = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const offset = jitter ? factor * spread[i] * (random() - 0.5) : 0;
    positions[i] = pos + bPos + bdPos * (pointpos + offset);
  }
  return positions;
}

/**
 * @typedef {{type: string, m: number, b: number}} AxisTransform
 */

/**
 * Plotly's `c2p` of one axis, for the axis types a box or violin is drawn on.
 * @param {AxisTransform} axis
 * @returns {(v: number) => number} NaN where Plotly has no pixel
 */
export function axisToPixels({ type, m, b }) {
  const round2 = v => Math.round(v * 100) / 100;
  if (type === 'log') {
    return v => (v > 0 ? round2(b + m * (Math.log(v) / Math.LN10)) : NaN);
  }
  if (type === 'linear' || type === 'category' || type === '-') {
    return v => (Number.isFinite(v) ? round2(b + m * v) : NaN);
  }
  throw new RangeError(`Points cannot be laid out on a ${type} axis`);
}
