/**
 * Compare two owned figure-export legend models by value.
 *
 * Legend snapshots are acyclic combinations of finite numbers, strings,
 * booleans, null, arrays, byte arrays (a categorical's colors and
 * visibility), and plain objects. Object property order is not
 * scientifically meaningful, while array order is.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function areLegendModelsSemanticallyEqual(left, right) {
  const pending = [[left, right]];

  while (pending.length > 0) {
    const [a, b] = pending.pop();
    if (a === b) continue;
    if (
      a === null ||
      b === null ||
      typeof a !== 'object' ||
      typeof b !== 'object'
    ) {
      return false;
    }

    // A categorical's colors and visibility: bytes (`utils/category-state.js`).
    const aIsBytes = a instanceof Uint8Array;
    if (aIsBytes !== (b instanceof Uint8Array)) return false;
    if (aIsBytes) {
      if (a.length !== b.length) return false;
      for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
      continue;
    }

    const aIsArray = Array.isArray(a);
    if (aIsArray !== Array.isArray(b)) return false;
    if (aIsArray) {
      if (a.length !== b.length) return false;
      for (let index = 0; index < a.length; index++) {
        pending.push([a[index], b[index]]);
      }
      continue;
    }

    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      pending.push([a[key], b[key]]);
    }
  }

  return true;
}
