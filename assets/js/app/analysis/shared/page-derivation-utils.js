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
 * @typedef {'rest_of'|'sample'} DerivedPageKind
 */

/**
 * Prefix for derived "rest of" pages (complement of a base page).
 * @type {string}
 */
const REST_OF_PAGE_PREFIX = 'restof__';

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
 * Prefix for derived "sample" pages: a page's cells among the first `m` of
 * the open cells' priority order (`data/cell-priority.js`), a uniform random
 * sample of them. A progressive analysis's first pass reads these
 * (`shared/progressive-cells.js`); they are never offered for selection.
 * @type {string}
 */
const SAMPLE_PAGE_PREFIX = 'sample__';
const SAMPLE_PAGE_PATTERN = /^sample__(\d+)__(.+)$/;

/**
 * The derived page of `basePageId`'s cells among the first `m` cells of the
 * priority order (`basePageId` may itself be derived: a rest-of page).
 * @param {string} basePageId
 * @param {number} m
 * @returns {string}
 */
export function createSamplePageId(basePageId, m) {
  if (!Number.isSafeInteger(m) || m < 0) throw new RangeError(`A sample page keeps a whole number of cells; got ${m}.`);
  if (typeof basePageId !== 'string' || basePageId.length === 0) throw new TypeError('A sample page needs its base page id.');
  return `${SAMPLE_PAGE_PREFIX}${m}__${basePageId}`;
}

/**
 * Check if a page ID is a derived "sample" page ID.
 * @param {string} pageId
 * @returns {boolean}
 */
export function isSamplePageId(pageId) {
  return typeof pageId === 'string' && SAMPLE_PAGE_PATTERN.test(pageId);
}

/**
 * The base page and sample size of a derived "sample" page ID, or null.
 * @param {string} pageId
 * @returns {{baseId: string, m: number}|null}
 */
export function parseSamplePageId(pageId) {
  if (typeof pageId !== 'string') return null;
  const match = SAMPLE_PAGE_PATTERN.exec(pageId);
  return match === null ? null : { baseId: match[2], m: Number(match[1]) };
}

/**
 * Whether a page ID is derived from another (rest-of or sample): it has no
 * version of its own, only its base page's.
 * @param {string} pageId
 * @returns {boolean}
 */
export function isDerivedPageId(pageId) {
  return isRestOfPageId(pageId) || isSamplePageId(pageId);
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

/**
 * The page IDs an analysis accepts as a selection.
 *
 * `AnalysisUIManager` holds one page selection shared by every analysis mode,
 * and every page selector offers the derived "Rest of X" pages alongside the
 * base ones — so a mode that derived a narrower domain of its own rejected a
 * page the shared selection had already accepted. Differential Expression and
 * Marker Genes own no page selector at all, so their validators fell back to
 * the base inventory and threw `page "restof__page_1" was not found` the moment
 * a rest-of page selected in another mode was handed to them on a mode switch.
 * There is one domain, and it is this function.
 *
 * @param {Array<{id: string, name: string}>} pages - The base page inventory.
 * @returns {Set<string>}
 */
export function selectablePageIdSet(pages) {
  return new Set(
    expandPagesWithDerived(pages, { includeRestOf: true }).map(page => page.id)
  );
}
