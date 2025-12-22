/**
 * @fileoverview Axis tick calculation utilities.
 *
 * Implements a "nice numbers" tick algorithm (1/2/5 × 10^n) so axis labels are
 * publication-friendly.
 *
 * @module ui/modules/figure-export/utils/tick-calculator
 */

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
    const step = a === 0 ? 1 : Math.pow(10, Math.floor(Math.log10(Math.abs(a))));
    return { ticks: [a], niceMin: a, niceMax: a, step };
  }

  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const range = hi - lo;
  const roughStep = range / Math.max(1, targetTicks);
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(roughStep))));
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

/**
 * Format a tick label in a compact, journal-friendly way.
 *
 * @param {number} value
 * @returns {string}
 */
export function formatTick(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (abs >= 10000 || (abs > 0 && abs < 0.01)) {
    const exp = Math.floor(Math.log10(abs));
    const mantissa = abs / Math.pow(10, exp);
    const m = mantissa < 10 ? mantissa.toFixed(1).replace(/\\.0$/, '') : Math.round(mantissa);
    return `${sign}${m}e${exp}`;
  }

  if (abs >= 100) return sign + abs.toFixed(0);
  if (abs >= 10) return sign + abs.toFixed(1);
  return sign + abs.toFixed(2);
}

