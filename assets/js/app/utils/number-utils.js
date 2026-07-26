/**
 * @fileoverview Number Utilities - finite-safe helpers and range operations.
 *
 * This module is the canonical import surface for number helpers across the
 * browser-side codebase (app + analysis). Keep it dependency-free so it can be
 * safely imported from any layer without creating circular dependencies.
 *
 * @module utils/number-utils
 */

/**
 * Check if value is a finite number (not NaN, not Infinity).
 * @param {*} value
 * @returns {boolean}
 */
export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Clamp a value between min and max (inclusive).
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Round to a fixed number of decimal places.
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
export function roundTo(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

const EXACT_DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Parse one exact finite decimal string and require the declared closed range.
 *
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {string} label
 * @returns {number}
 */
export function parseFiniteNumberInRange(value, min, max, label) {
  if (
    typeof label !== 'string'
    || label.length === 0
    || label !== label.trim()
  ) {
    throw new TypeError('Numeric input label must be exact non-empty text.');
  }
  if (!isFiniteNumber(min) || !isFiniteNumber(max) || min > max) {
    throw new TypeError(`${label} range must contain exact finite ordered bounds.`);
  }
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || !EXACT_DECIMAL_PATTERN.test(value)
  ) {
    throw new TypeError(`${label} must be one exact finite decimal string.`);
  }
  const parsed = Number(value);
  if (!isFiniteNumber(parsed)) {
    throw new TypeError(`${label} must be one exact finite decimal string.`);
  }
  if (parsed < min || parsed > max) {
    throw new RangeError(`${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

/**
 * Linear interpolation between a and b.
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Map a value from one range to another.
 * @param {number} value
 * @param {number} inMin
 * @param {number} inMax
 * @param {number} outMin
 * @param {number} outMax
 * @returns {number}
 */
export function mapRange(value, inMin, inMax, outMin, outMax) {
  const denom = inMax - inMin;
  if (denom === 0) return outMin;
  return ((value - inMin) / denom) * (outMax - outMin) + outMin;
}
