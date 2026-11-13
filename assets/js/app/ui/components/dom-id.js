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

/**
 * The separator a minted id, and only a minted id, holds: `<prefix>--<n>`.
 * No id written by hand in the page or the sources holds it, and no prefix
 * does (`tests/dom-id-owner-contract.test.mjs`), so an id holding it was minted on
 * this page, or made from one (`<minted>-trigger`, `<scope>-method`): it
 * names nothing on another page. Recognized by its form, nothing is kept per
 * id minted.
 */
export const MINTED_ID_SEPARATOR = '--';

let counter = 0;

/**
 * Mint a collision-free DOM id for `for` / `aria-labelledby` / `aria-controls`
 * wiring.
 *
 * @param {string} prefix - Must start with a letter and carry no whitespace,
 *   so the result can be used directly in a selector; it holds no `--` and
 *   does not end in `-` (the separator is the minted id's own).
 * @returns {string}
 */
export function createDomId(prefix = 'id') {
  if (
    typeof prefix !== 'string'
    || prefix.length === 0
    || prefix !== prefix.trim()
    || !/^[A-Za-z][\w-]*$/.test(prefix)
    || prefix.includes(MINTED_ID_SEPARATOR)
    || prefix.endsWith('-')
  ) {
    throw new TypeError(
      'DOM id prefix must be a non-empty string starting with a letter and '
      + 'containing only letters, digits, underscores or single hyphens, '
      + 'not ending in a hyphen'
    );
  }
  counter += 1;
  return `${prefix}${MINTED_ID_SEPARATOR}${counter.toString(36)}`;
}

/**
 * Whether `id` was minted by `createDomId` on this page, or made from such an
 * id: whether it holds the minted separator.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isGeneratedDomId(id) {
  return typeof id === 'string' && id.includes(MINTED_ID_SEPARATOR);
}
