/**
 * @fileoverview A value as text without edge whitespace: the one way
 * community annotation reads a label, a name or an id that may be missing
 * (`null`/`undefined` read as empty text).
 *
 * @module utils/clean-string
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
export function toCleanString(value) {
  return String(value ?? '').trim();
}
