/**
 * @fileoverview Whether two domain values are the same state: the equality
 * the value pool's content hash gives (`app/history/value-pool.js`), without
 * hashing: plain data compared by content with keys in any order (a key
 * holding `undefined` is absent), typed arrays by type and elements, numbers
 * as `Object.is` (NaN equals NaN, -0 differs from 0). A restore uses it to
 * leave what already matches alone.
 *
 * @module app/state/domains/same-value
 */

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.constructor !== b.constructor || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  const keysA = Object.keys(a).filter(key => a[key] !== undefined);
  const keysB = Object.keys(b).filter(key => b[key] !== undefined);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) if (!Object.hasOwn(b, key) || !sameValue(a[key], b[key])) return false;
  return true;
}
