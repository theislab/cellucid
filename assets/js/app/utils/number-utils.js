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
 * Clamp a 0-100 number and normalize to a 0-1 fraction.
 * @param {number} value
 * @param {number} [defaultValue=50]
 * @returns {number}
 */
export function clampNormalized(value, defaultValue = 50) {
  const v = isFiniteNumber(value) ? value : defaultValue;
  return clamp(v, 0, 100) / 100;
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

/**
 * Parse a number-like value with fallback.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
export function parseNumberOr(value, fallback) {
  const parsed = parseFloat(value);
  return isFiniteNumber(parsed) ? parsed : fallback;
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
