/**
 * Page Derivation Utilities (Wildcards)
 *
 * Centralizes derived/"wildcard" page ID formats and helpers so:
 * - UI components can render derived options consistently
 * - DataLayer can resolve derived page IDs to cell indices
 * - Cache keys remain stable (derived IDs must avoid ':' and ',')
 *
 * @module shared/page-derivation-utils
 */

// NOTE: Cache keys in DataLayer use ':' and ',' as separators.
// Derived page IDs MUST NOT include these characters.

/**
 * @typedef {'rest_of'} DerivedPageKind
 */

/**
 * Prefix for derived "rest of" pages (complement of a base page).
 * @type {string}
 */
export const REST_OF_PAGE_PREFIX = 'restof__';

/**
 * Create a derived "rest of" page ID from a base page ID.
 * @param {string} basePageId
 * @returns {string}
 */
export function createRestOfPageId(basePageId) {
  return `${REST_OF_PAGE_PREFIX}${String(basePageId || '')}`;
}

/**
 * Check if a page ID is a derived "rest of" page ID.
 * @param {string} pageId
 * @returns {boolean}
 */
export function isRestOfPageId(pageId) {
  return typeof pageId === 'string' && pageId.startsWith(REST_OF_PAGE_PREFIX) && pageId.length > REST_OF_PAGE_PREFIX.length;
}

/**
 * Get base page ID for a "rest of" derived page ID.
 * @param {string} restOfPageId
 * @returns {string|null}
 */
export function getBasePageIdFromRestOf(restOfPageId) {
  if (!isRestOfPageId(restOfPageId)) return null;
  return restOfPageId.slice(REST_OF_PAGE_PREFIX.length);
}

/**
 * Human-readable label for a rest-of page given a base page name.
 * @param {string} basePageName
 * @returns {string}
 */
export function getRestOfPageName(basePageName) {
  const base = String(basePageName || '').trim();
  return base ? `Rest of ${base}` : 'Rest of page';
}

/**
 * Expand a list of base pages into a list including derived wildcard pages.
 *
 * The returned objects are safe for UI usage:
 * - base pages are returned as-is
 * - derived pages are new objects with:
 *   - id: derived ID
 *   - name: derived display name
 *   - _derived: metadata for internal logic
 *
 * @param {Array<{id: string, name: string}>} pages
 * @param {Object} [options]
 * @param {boolean} [options.includeRestOf=true]
 * @returns {Array<{id: string, name: string, _derived?: {kind: DerivedPageKind, baseId: string}}>}
 */
export function expandPagesWithDerived(pages, options = {}) {
  const { includeRestOf = true } = options;
  const basePages = Array.isArray(pages) ? pages : [];
  if (!includeRestOf || basePages.length === 0) return basePages.slice();

  const expanded = [];
  for (const page of basePages) {
    if (!page || !page.id) continue;
    expanded.push(page);

    const restId = createRestOfPageId(page.id);
    expanded.push({
      id: restId,
      name: getRestOfPageName(page.name || page.id),
      _derived: { kind: 'rest_of', baseId: page.id }
    });
  }

  return expanded;
}

export default {
  REST_OF_PAGE_PREFIX,
  createRestOfPageId,
  isRestOfPageId,
  getBasePageIdFromRestOf,
  getRestOfPageName,
  expandPagesWithDerived
};

