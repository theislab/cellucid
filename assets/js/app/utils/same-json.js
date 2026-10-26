/**
 * @fileoverview Whether two JSON-shaped values are the same value.
 *
 * Compared by their JSON text, so key order counts: the records compared
 * here (data mappings, their groups, session parts) are built by one code
 * path each, which writes their keys in one order.
 *
 * @module utils/same-json
 */

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
