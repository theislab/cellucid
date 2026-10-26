/**
 * @fileoverview The one place interface numbers are turned into text.
 *
 * Every count, readout and unit the sidebar, its floating panels and the
 * analysis windows print goes through these functions, so the same quantity
 * reads the same way everywhere (see "Wording and numbers" in
 * `assets/css/README.md`):
 *
 * - Exact counts, and a count with its noun ("1 cell", "1,200 cells"), are
 *   `formatCount` and `formatCountOf` in `utils/format-units.js`, which every
 *   layer can import.
 * - Compact counts use an upper-case K / M / B suffix with at most one
 *   decimal ("950", "1.5K", "15K", "2.5M").
 * - Units follow the number after a space ("1.00 u/s", "8.0 s"), except the
 *   multiplication sign and the percent sign, which attach ("3.0×", "60%").
 *   The multiplier is always U+00D7, never the letter x.
 *
 * @module ui/components/display-format
 */

function requireFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function requireDigits(digits) {
  if (!Number.isInteger(digits) || digits < 0 || digits > 6) {
    throw new RangeError('Display digits must be an integer from 0 to 6');
  }
  return digits;
}

/**
 * A compact count for tight readouts and badges: `"950"`, `"1.5K"`, `"15K"`,
 * `"2.5M"`, `"1.2B"`. One decimal is kept while it is significant.
 *
 * @param {number} value
 * @returns {string}
 */
export function formatCompactCount(value) {
  const number = requireFinite(value, 'Compact count');
  const sign = number < 0 ? '-' : '';
  const magnitude = Math.abs(number);
  for (const [scale, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (magnitude >= scale) {
      const scaled = magnitude / scale;
      const text = scaled >= 100 ? Math.round(scaled).toString()
        : scaled.toFixed(1).replace(/\.0$/, '');
      return `${sign}${text}${suffix}`;
    }
  }
  return `${sign}${Math.round(magnitude)}`;
}

/**
 * A fixed-precision decimal readout: `formatDecimal(0.5, 2)` → `"0.50"`.
 *
 * @param {number} value
 * @param {number} digits
 * @returns {string}
 */
export function formatDecimal(value, digits) {
  return requireFinite(value, 'Decimal').toFixed(requireDigits(digits));
}

/**
 * A multiplier: `formatMultiplier(3, 1)` → `"3.0×"`.
 *
 * @param {number} value
 * @param {number} digits
 * @returns {string}
 */
export function formatMultiplier(value, digits) {
  return `${formatDecimal(value, digits)}×`;
}

/**
 * A percentage from a 0..100 value: `formatPercent(60)` → `"60%"`.
 *
 * @param {number} value
 * @param {number} [digits=0]
 * @returns {string}
 */
export function formatPercent(value, digits = 0) {
  return `${formatDecimal(value, digits)}%`;
}

/**
 * A quantity with a spaced unit: `formatWithUnit(8, 1, 's')` → `"8.0 s"`.
 *
 * @param {number} value
 * @param {number} digits
 * @param {string} unit
 * @returns {string}
 */
export function formatWithUnit(value, digits, unit) {
  if (typeof unit !== 'string' || unit.length === 0 || unit.trim() !== unit) {
    throw new TypeError('A display unit must be exact non-empty text');
  }
  return `${formatDecimal(value, digits)} ${unit}`;
}
