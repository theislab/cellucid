/**
 * @fileoverview Axis tick calculation utilities.
 *
 * Implements a "nice numbers" tick algorithm (1/2/5 × 10^n) so axis labels are
 * publication-friendly. Labels are written by the one number format
 * (`utils/format-units.js` `formatSignificant`; `axes-builder.js` `tickLabels`).
 *
 * @module ui/modules/figure-export/utils/tick-calculator
 */

/**
 * 10^exponent for a whole exponent, the double nearest it on every engine.
 * `Math.pow(10, -4)` is 9.999999999999999e-5 in V8 before Node 24, which made
 * a rough step of 5e-4 measure 5.000000000000001 of it and round up to 1e-3;
 * the decimal literal is parsed correctly rounded everywhere.
 *
 * @param {number} exponent
 * @returns {number}
 */
function powerOfTen(exponent) {
  return Number(`1e${exponent}`);
}

/**
 * Generate "nice" ticks for a numeric range.
 *
 * @param {number} min
 * @param {number} max
 * @param {number} [targetTicks=5]
 * @returns {{ ticks: number[]; niceMin: number; niceMax: number; step: number }}
 */
export function niceNumbers(min, max, targetTicks = 5) {
  const a = Number(min);
  const b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return { ticks: [0], niceMin: 0, niceMax: 0, step: 1 };
  }
  if (a === b) {
    const step = a === 0 ? 1 : powerOfTen(Math.floor(Math.log10(Math.abs(a))));
    return { ticks: [a], niceMin: a, niceMax: a, step };
  }

  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const range = hi - lo;
  const roughStep = range / Math.max(1, targetTicks);
  const magnitude = powerOfTen(Math.floor(Math.log10(Math.abs(roughStep))));
  const normalized = roughStep / magnitude;

  let niceStep;
  if (normalized <= 1) niceStep = 1 * magnitude;
  else if (normalized <= 2) niceStep = 2 * magnitude;
  else if (normalized <= 5) niceStep = 5 * magnitude;
  else niceStep = 10 * magnitude;

  const niceMin = Math.floor(lo / niceStep) * niceStep;
  const niceMax = Math.ceil(hi / niceStep) * niceStep;

  const ticks = [];
  // Guard against infinite loops for weird numeric edge cases.
  const maxIterations = 2048;
  let t = niceMin;
  for (let i = 0; i < maxIterations && t <= niceMax + niceStep * 0.5; i++) {
    ticks.push(+t.toFixed(12));
    t += niceStep;
  }

  return { ticks, niceMin, niceMax, step: niceStep };
}
