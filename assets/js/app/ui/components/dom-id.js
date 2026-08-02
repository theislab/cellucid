/**
 * @fileoverview The one generator for DOM ids.
 *
 * A DOM id has to be unique within a document, and that is all. A counter gives
 * exactly that, by construction, and cannot collide however many are minted.
 *
 * Randomness was the wrong instrument for the job and it cost something real:
 * `crypto.randomUUID()` exists only in a secure context, so a generator built
 * on it fails over plain HTTP on a LAN address - which the Python package
 * supports deliberately through `--host 0.0.0.0`. The other generator this
 * replaces reached for `Date.now()` and `Math.random()` when `randomUUID` was
 * missing, which works but is a second answer to a question that should have
 * one.
 *
 * @module ui/components/dom-id
 */

let counter = 0;

/**
 * Mint a collision-free DOM id for `for` / `aria-labelledby` / `aria-controls`
 * wiring.
 *
 * @param {string} prefix - Must start with a letter and carry no whitespace,
 *   so the result can be used directly in a selector.
 * @returns {string}
 */
export function createDomId(prefix = 'id') {
  if (
    typeof prefix !== 'string'
    || prefix.length === 0
    || prefix !== prefix.trim()
    || !/^[A-Za-z][\w-]*$/.test(prefix)
  ) {
    throw new TypeError(
      'DOM id prefix must be a non-empty string starting with a letter and '
      + 'containing only letters, digits, underscores or hyphens'
    );
  }
  counter += 1;
  return `${prefix}-${counter.toString(36)}`;
}
