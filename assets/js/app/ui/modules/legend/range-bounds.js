/**
 * @fileoverview The bounds of a continuous field's range filter (the
 * legend's Visible range): a slider for the feel and a number box for the
 * exact value, one per bound.
 *
 * A typed bound is applied exactly as typed (`parseBound`: a decimal point
 * or comma, in the data range). A slider moves in `SLIDER_STEPS` steps, in
 * value units on a linear color scale and in log units on a log one (zeros
 * and negatives at its first step), and the bound it sets is the shortest
 * decimal that tells its step from the next (`createRangeScale`), so what the
 * box shows is what is applied, and a bound like "≥ 1,500 counts" can be set
 * on a 500–100,000 range. The track's ends are the data's minimum and
 * maximum exactly. A box shows its bound in as many figures as it holds
 * (`boundText`), the exact value in its title.
 *
 * @module ui/modules/legend/range-bounds
 */

import { BOUND_FIGURES, formatSignificant, parseDecimalText } from '../../../../utils/format-units.js';

/** Steps of a range slider's track: a thousandth of it. */
export const SLIDER_STEPS = 1000;

/**
 * The shortest decimal within the slider's resolution at `value`: enough
 * significant figures that `step` (the value distance one slider step
 * spans there) is told apart.
 */
function snap(value, step) {
  if (value === 0 || !(step > 0)) return value;
  const figures = Math.ceil(Math.log10(Math.abs(value) / step)) + 1;
  return Number(value.toPrecision(Math.min(17, Math.max(1, figures))));
}

/**
 * How a range slider's positions map onto a field's values.
 *
 * @param {{min: number, max: number, positiveMin?: number|null, log?: boolean}} range -
 *   The data's minimum and maximum; with `log` (the color scale is
 *   logarithmic) and a smallest positive value below the maximum, positions
 *   after the first are log-spaced from it to the maximum
 * @returns {{log: boolean, valueAt: (position: number) => number, positionOf: (value: number, side?: 'min'|'max') => number}}
 *   `positionOf` of a constant field's one value is the track's start for
 *   the minimum and its end for the maximum
 */
export function createRangeScale({ min, max, positiveMin = null, log = false }) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    throw new RangeError('A range slider needs a finite minimum at most its maximum');
  }
  const logScale = log === true && Number.isFinite(positiveMin) && positiveMin > 0 && positiveMin < max;
  if (!logScale) {
    const span = max - min;
    const step = span / SLIDER_STEPS;
    return {
      log: false,
      valueAt(position) {
        if (position <= 0 || span === 0) return min;
        if (position >= SLIDER_STEPS) return max;
        return Math.min(max, Math.max(min, snap(min + (position / SLIDER_STEPS) * span, step)));
      },
      positionOf(value, side = 'min') {
        if (span === 0) return side === 'max' ? SLIDER_STEPS : 0;
        return Math.min(SLIDER_STEPS, Math.max(0, Math.round(((value - min) / span) * SLIDER_STEPS)));
      }
    };
  }
  // The first step holds every value up to the smallest positive one (the
  // zeros of counts); the rest are log-spaced up to the maximum.
  const low = Math.log10(positiveMin);
  const decades = Math.log10(max) - low;
  const logSteps = SLIDER_STEPS - 1;
  return {
    log: true,
    valueAt(position) {
      if (position <= 0) return min;
      if (position >= SLIDER_STEPS) return max;
      const exponent = low + ((position - 1) / logSteps) * decades;
      const value = 10 ** exponent;
      // One step multiplies the value by 10^(decades / logSteps).
      const step = value * (10 ** (decades / logSteps) - 1);
      return Math.min(max, Math.max(positiveMin, snap(value, step)));
    },
    positionOf(value) {
      if (value < positiveMin) return 0;
      return Math.min(SLIDER_STEPS, Math.max(1, 1 + Math.round(((Math.log10(value) - low) / decades) * logSteps)));
    }
  };
}

/**
 * A bound typed in a number box, exactly as typed (a decimal point or comma,
 * `parseDecimalText`), clamped to the data range; null when the text is not a
 * number.
 *
 * @param {string} text
 * @param {{min: number, max: number}} range
 * @returns {number|null}
 */
export function parseBound(text, { min, max }) {
  const value = parseDecimalText(text);
  if (!Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

/**
 * The characters a bound's number box shows whole (`.slider-number`: 7ch).
 */
export const BOUND_TEXT_CHARS = 7;

/**
 * How a number box writes a bound: its shortest round-trip decimal when that
 * fits the box (`BOUND_TEXT_CHARS`; a slider's bound is short by
 * construction), else as many significant figures as fit ("5.65685" of
 * 5.656854249492381, "1.23e-7", "1.23e11"; `formatSignificant`), so the box never cuts its number. The box's
 * title holds the exact value; a bound typed in the box is applied as typed.
 *
 * @param {number} value
 * @returns {string}
 */
export function boundText(value) {
  const exact = String(value);
  if (exact.length <= BOUND_TEXT_CHARS) return exact;
  // The figures of the filter list's bound (`formatBound`), as many as fit.
  for (let figures = BOUND_FIGURES; figures > 1; figures--) {
    const text = formatSignificant(value, figures);
    if (text.length <= BOUND_TEXT_CHARS) return text;
  }
  return formatSignificant(value, 1);
}
