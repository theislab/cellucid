/**
 * @fileoverview The Cellucid release version the page names, in one place:
 * `<meta name="cellucid-version">` (`index.html`, its `CELLUCID_VERSION`
 * marker), the release line the web app shares with the Python and R
 * packages. What wrote a session file (`app/session/app-stamp.js`), a library
 * file, a chat export and the agent relay's hello all say this version.
 *
 * @module utils/page-version
 */

/**
 * The version the page names, or null where it names none (a test page, a
 * worker).
 *
 * @param {Document|null|undefined} [documentOwner]
 * @returns {string|null}
 */
export function pageVersion(documentOwner = globalThis.document) {
  const content = documentOwner?.querySelector?.('meta[name="cellucid-version"]')?.getAttribute('content') ?? null;
  return typeof content === 'string' && content.length > 0 ? content : null;
}
