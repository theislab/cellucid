/**
 * @fileoverview Highlight Manager.
 *
 * Manages highlight pages, groups, and per-point highlight intensity arrays.
 *
 * @module state/managers/highlight-manager
 */

import { CellSet, copyCellList, isCellList, requireCellList } from '../../utils/cell-set.js';
import { BaseManager } from '../core/base-manager.js';
import { getPageColor } from '../../utils/page-colors.js';
import { highlightAccessorMethods } from './highlight-accessors.js';
import {
  MIN_VISIBLE_ALPHA_BYTE,
  POINT_VISIBILITY_THRESHOLD,
  requirePointTransparency,
} from '../../../rendering/alpha-visibility.js';
import { isCategoricalCodes } from '../../../data/categorical-storage-contract.js';
import { formatCountOf } from '../../../utils/format-units.js';

function requireFieldSource(source) {
  if (source !== 'obs' && source !== 'var') {
    throw new TypeError('Highlight field source must be exactly "obs" or "var".');
  }
  return source;
}

/**
 * Resolve the categorical field `(fieldIndex, source)` names in the owner's own
 * inventory. Only the legend's "highlight this category" path addresses a
 * field by index; selection gestures hold the field object of the pane they
 * landed in and go straight to `requireCategoryOfField`.
 */
function requireCategorySelection(owner, fieldIndex, categoryIndex, source) {
  requireFieldSource(source);
  if (!Number.isSafeInteger(fieldIndex) || fieldIndex < 0) {
    throw new TypeError(
      'Highlight category field index must be a non-negative safe integer.'
    );
  }
  const data = source === 'var' ? owner.varData : owner.obsData;
  if (
    data === null
    || typeof data !== 'object'
    || Array.isArray(data)
    || !Array.isArray(data.fields)
  ) {
    throw new TypeError(
      `Highlight category source "${source}" requires the current field inventory.`
    );
  }
  if (fieldIndex >= data.fields.length) {
    throw new RangeError('Highlight category field index is outside the field inventory.');
  }
  const field = data.fields[fieldIndex];
  return { field, categoryName: requireCategoryOfField(field, categoryIndex) };
}

/**
 * Validate one category of one categorical field object and return its name.
 *
 * @param {unknown} field
 * @param {unknown} categoryIndex
 * @returns {string|number|boolean}
 */
function requireCategoryOfField(field, categoryIndex) {
  if (
    field === null
    || typeof field !== 'object'
    || Array.isArray(field)
    || field.kind !== 'category'
  ) {
    throw new TypeError('Highlight category field must be categorical.');
  }
  if (!Array.isArray(field.categories)) {
    throw new TypeError('Highlight category field requires a category inventory.');
  }
  if (!Number.isSafeInteger(categoryIndex) || categoryIndex < 0) {
    throw new TypeError(
      'Highlight category index must be a non-negative safe integer.'
    );
  }
  if (categoryIndex >= field.categories.length) {
    throw new RangeError('Highlight category index is outside the category inventory.');
  }
  const categoryName = field.categories[categoryIndex];
  if (
    typeof categoryName !== 'string'
    && typeof categoryName !== 'boolean'
    && !(
      typeof categoryName === 'number'
      && Number.isFinite(categoryName)
    )
  ) {
    throw new TypeError(
      'Highlight category must be a string, finite number, or boolean.'
    );
  }
  return categoryName;
}

function requireCategoryFieldKey(field) {
  if (
    typeof field.key !== 'string'
    || field.key.length === 0
    || field.key !== field.key.trim()
  ) {
    throw new TypeError(
      'Highlight category field key must be a nonempty trimmed string.'
    );
  }
  return field.key;
}

function formatCategoryNameForGroupLabel(categoryName) {
  if (typeof categoryName === 'string') {
    if (
      categoryName.length === 0
      || categoryName !== categoryName.trim()
    ) {
      return JSON.stringify(categoryName);
    }
    return categoryName;
  }
  return String(categoryName);
}

function requireActiveHighlightGroups(owner) {
  if (!Array.isArray(owner.highlightPages)) {
    throw new TypeError('Highlight creation requires the current page inventory.');
  }
  if (
    typeof owner.activePageId !== 'string'
    || owner.activePageId.length === 0
    || owner.activePageId !== owner.activePageId.trim()
  ) {
    throw new TypeError('Highlight creation requires an exact active page id.');
  }
  const matchingPages = owner.highlightPages.filter(
    page => (
      page !== null
      && typeof page === 'object'
      && !Array.isArray(page)
      && page.id === owner.activePageId
    )
  );
  if (matchingPages.length !== 1) {
    throw new RangeError(
      'Highlight creation requires exactly one matching active page.'
    );
  }
  const groups = matchingPages[0].highlightedGroups;
  if (!Array.isArray(groups)) {
    throw new TypeError('Active highlight page requires a group inventory.');
  }
  return groups;
}

function requireCreatedCellIndices(cellIndices, pointCount) {
  requireCellList(cellIndices, pointCount, 'Category highlight cell indices');
  if (cellIndices.length === 0) {
    throw new RangeError(
      'Category highlight requires at least one currently visible cell.'
    );
  }
  return cellIndices;
}

/**
 * True when `cellIndex` names a cell of a dataset of `pointCount` cells.
 *
 * Highlight membership is scientific data: it decides which cells are marked,
 * counted, exported and fed to differential expression. An index that does not
 * name a cell in the current dataset is a violated invariant somewhere
 * upstream, never something to quietly leave out of the result. Every writer
 * into a highlight group already bounds its indices by `pointCount` and throws
 * (`addHighlightDirect`, `addHighlightFromCategory`, the session restore
 * decoder), so a failure here means one of those bounds was bypassed and the
 * render, the count and the export would otherwise silently disagree.
 *
 * @param {unknown} cellIndex
 * @param {number} pointCount - Cells in the current dataset.
 * @returns {boolean}
 */
function isHighlightCellIndex(cellIndex, pointCount) {
  return (
    Number.isSafeInteger(cellIndex)
    && cellIndex >= 0
    && cellIndex < pointCount
  );
}

/**
 * Report an index that does not name a cell. Always throws.
 *
 * Kept apart from the membership loops so the message — and the label the
 * caller composes for it — is built only on the failing index, never once per
 * cell of an 800k-cell selection.
 *
 * @param {unknown} cellIndex
 * @param {number} pointCount - Cells in the current dataset.
 * @param {string} label - What produced the index.
 * @returns {never}
 */
function rejectHighlightCellIndex(cellIndex, pointCount, label) {
  if (!Number.isSafeInteger(cellIndex) || cellIndex < 0) {
    throw new RangeError(
      `${label} must be a non-negative safe integer, received ${String(cellIndex)}.`
    );
  }
  throw new RangeError(
    `${label} ${cellIndex} is outside the current dataset of ${formatCountOf(pointCount, 'cell')}.`
  );
}

/**
 * True when `value` can carry a list of highlighted cell indices: a
 * `Uint32Array`. A group holds a cell list (ascending, `requireCellList`) --
 * the category, range and direct writers below, the page combination and the
 * session decoder all produce one -- and the published highlight list is the
 * same type in first-seen order.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isHighlightIndexList(value) {
  return value instanceof Uint32Array;
}

/**
 * The cells `0 .. length` for which `keep(cell)` holds, as a cell list: one
 * pass into a scratch list, then a right-sized copy.
 *
 * @param {number} length
 * @param {(cell: number) => boolean} keep
 * @returns {Uint32Array}
 */
function cellListWhere(length, keep) {
  const scratch = new Uint32Array(length);
  let count = 0;
  for (let cell = 0; cell < length; cell++) {
    if (keep(cell)) scratch[count++] = cell;
  }
  return scratch.slice(0, count);
}

/**
 * Upper bound on how many cells a page's enabled groups can contribute.
 *
 * The sum of the enabled groups' index-list lengths: exact when the groups are
 * disjoint, and larger than the truth by exactly the number of cells claimed by
 * more than one group. Computing it walks the **groups**, never their cells, so
 * `collectEnabledPageCells` can size its output in advance without a counting
 * pass over the selection.
 *
 * The group-shape validation lives here as well as in the collector so that a
 * malformed inventory is rejected before any membership byte is written, and a
 * failed collection therefore cannot leave a shared scratch buffer dirty.
 *
 * @param {object|null} page - Highlight page, or null for "no page".
 * @param {string} label - Page description used in thrown messages.
 * @returns {number}
 */
function enabledPageCellCapacity(page, label) {
  if (page === null || page === undefined) return 0;
  const groups = page.highlightedGroups;
  if (!Array.isArray(groups)) {
    throw new TypeError(`${label} requires a group inventory.`);
  }
  let capacity = 0;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    if (group === null || typeof group !== 'object' || Array.isArray(group)) {
      throw new TypeError(`${label} group ${groupIndex} must be an object.`);
    }
    if (group.enabled === false) continue;
    const indices = group.cellIndices;
    if (indices === null || indices === undefined) continue;
    if (!isHighlightIndexList(indices)) {
      throw new TypeError(
        `${label} group "${group.id}" cellIndices must be a Uint32Array.`
      );
    }
    capacity += indices.length;
  }
  return capacity;
}

/**
 * Each page's last count, with the enabled cell lists and dataset size it
 * was counted for (`getHighlightedCellCountForPage`).
 * @type {WeakMap<object, {pointCount: number, lists: Uint32Array[], count: number}>}
 */
const pageCountCache = new WeakMap();

/** The cell lists of a page's enabled groups, in group order. */
function enabledPageCellLists(page) {
  const lists = [];
  for (const group of page.highlightedGroups) {
    if (group.enabled === false || group.cellIndices === null || group.cellIndices === undefined) continue;
    lists.push(group.cellIndices);
  }
  return lists;
}

function sameLists(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * The one definition of "the cells of a highlight page".
 *
 * A page's cells are the union of the cell indices of its **enabled** groups,
 * deduplicated, in first-seen order. Every consumer inside this module derives
 * from this function so that the number the interface displays is by
 * construction the set the renderer paints — a page cannot be counted one way
 * and drawn another.
 *
 * `membership` doubles as the deduplication structure and as the highlight
 * intensity output: entries for the page's cells are set to 255 and every other
 * entry is left untouched, so the caller passes either the live highlight array
 * (active page) or a scratch buffer it clears afterwards (any other page).
 *
 * `cells` receives the index list itself. It is a `Uint32Array` rather than a
 * growable plain array because a selection can be the whole dataset: the caller
 * sizes it from `enabledPageCellCapacity` and this function fills a prefix of
 * it, so applying a highlight neither reallocates nor stores eight bytes for
 * every four-byte index.
 *
 * @param {object|null} page - Highlight page, or null for "no page".
 * @param {number} pointCount - Cells in the current dataset.
 * @param {Uint8Array} membership - Buffer of length `pointCount`, zeroed for
 *   every index this page could claim.
 * @param {string} label - Page description used in thrown messages.
 * @param {Uint32Array} cells - Output buffer, at least `outOffset +
 *   enabledPageCellCapacity(page)` entries long.
 * @param {number} outOffset - First entry of `cells` to write.
 * @returns {number} How many cells were written, unique and in first-seen order.
 */
function collectEnabledPageCells(
  page,
  pointCount,
  membership,
  label,
  cells,
  outOffset
) {
  if (!(membership instanceof Uint8Array) || membership.length !== pointCount) {
    // The bound proved against `pointCount` is the bound written into
    // `membership`. If they disagree, an in-bounds index would be dropped by a
    // silent out-of-range typed-array write -- the exact failure this function
    // exists to prevent.
    throw new TypeError(
      `${label} membership buffer must be a Uint8Array of ${formatCountOf(pointCount, 'entry', 'entries')}.`
    );
  }
  if (!(cells instanceof Uint32Array)) {
    throw new TypeError(`${label} cell buffer must be a Uint32Array.`);
  }
  if (page === null || page === undefined) return 0;
  const groups = page.highlightedGroups;
  if (!Array.isArray(groups)) {
    throw new TypeError(`${label} requires a group inventory.`);
  }
  const capacity = cells.length;
  let written = outOffset;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    if (group === null || typeof group !== 'object' || Array.isArray(group)) {
      throw new TypeError(`${label} group ${groupIndex} must be an object.`);
    }
    if (group.enabled === false) continue;
    const indices = group.cellIndices;
    if (indices === null || indices === undefined) continue;
    if (!isHighlightIndexList(indices)) {
      throw new TypeError(
        `${label} group "${group.id}" cellIndices must be a Uint32Array.`
      );
    }
    for (let i = 0; i < indices.length; i++) {
      const cellIndex = indices[i];
      if (!isHighlightCellIndex(cellIndex, pointCount)) {
        rejectHighlightCellIndex(
          cellIndex,
          pointCount,
          `${label} group "${group.id}" cell index`
        );
      }
      if (membership[cellIndex] === 0) {
        if (written >= capacity) {
          // An out-of-range typed-array write is silent. Refuse instead, so a
          // group inventory that grew between sizing and collecting can never
          // paint a cell the published index list omits.
          throw new RangeError(
            `${label} produced more cells than its ${capacity}-entry buffer holds.`
          );
        }
        membership[cellIndex] = 255;
        cells[written] = cellIndex;
        written++;
      }
    }
  }
  return written - outOffset;
}

/**
 * Full highlight intensity for every cell of a cell list. A cell list is
 * ascending, so each run of consecutive cells is one `fill` (a whole-dataset
 * selection is one), and a scattered list costs one comparison a cell more.
 */
function paintCellList(intensity, cells) {
  const length = cells.length;
  let start = 0;
  while (start < length) {
    let end = start + 1;
    while (end < length && cells[end] === cells[end - 1] + 1) end++;
    const first = cells[start];
    if (end - start === 1) intensity[first] = 255;
    else intensity.fill(255, first, first + (end - start));
    start = end;
  }
}

/**
 * The exactly-sized index list for a filled prefix of a collection buffer.
 *
 * Returns the buffer itself when every entry was used — the common case, since
 * groups usually claim disjoint cells — and a right-sized copy otherwise, so no
 * published index list keeps an oversized backing store alive.
 *
 * @param {Uint32Array} cells
 * @param {number} written
 * @returns {Uint32Array}
 */
function publishedHighlightIndices(cells, written) {
  return written === cells.length ? cells : cells.slice(0, written);
}

function requireSelectionTransparency(transparency, pointCount) {
  return requirePointTransparency(
    transparency,
    pointCount,
    'Highlight selection view transparency'
  );
}

export const highlightStateMethods = {
  // --- Cell Highlighting/Selection API ---------------------------------------

  _notifyHighlightChange() {
    this.emit('highlight:changed');
  },

  // --- Highlight Page Management ---

  _notifyHighlightPageChange() {
    this.emit('page:changed');
  },

  _getActivePage() {
    if (!this.activePageId) return null;
    return this.highlightPages.find((p) => p.id === this.activePageId) || null;
  },

  // Convenience alias: highlighted groups for the active page.
  get highlightedGroups() {
    const page = this._getActivePage();
    return page ? page.highlightedGroups : [];
  },

  // Set highlighted groups for the active page.
  set highlightedGroups(groups) {
    const page = this._getActivePage();
    if (page) {
      page.highlightedGroups = groups;
    }
  },

  getHighlightPages() {
    return this.highlightPages;
  },

  getActivePageId() {
    return this.activePageId;
  },

  getActivePage() {
    return this._getActivePage();
  },

  /**
   * Membership scratch buffer for counting a page that is not the active one.
   *
   * Every entry is zero on entry and on exit; callers clear exactly the
   * indices they set, so the buffer never carries a previous page's cells.
   * @returns {Uint8Array}
   */
  _borrowHighlightMembershipScratch() {
    if (
      !(this._highlightMembershipScratch instanceof Uint8Array)
      || this._highlightMembershipScratch.length !== this.pointCount
    ) {
      this._highlightMembershipScratch = new Uint8Array(this.pointCount);
    }
    return this._highlightMembershipScratch;
  },

  /**
   * Get the unique highlighted cell count for a page (enabled groups only).
   *
   * Used by both the Highlighted Cells UI and analysis selectors. Derived from
   * `collectEnabledPageCells`, the same function that paints the highlight
   * array, so this number is by construction the size of the set the renderer
   * draws for that page. An out-of-dataset index throws here exactly as it
   * throws during painting, instead of being counted here and dropped there.
   *
   * @param {string} pageId - Id of an existing page; an unknown id counts zero.
   * @returns {number}
   */
  getHighlightedCellCountForPage(pageId) {
    const page = this.highlightPages.find((p) => p.id === pageId);
    if (!page) return 0;

    const label = `Highlight page "${pageId}"`;
    const capacity = enabledPageCellCapacity(page, label);
    // A page with no enabled cells counts zero without a dataset-length
    // deduplication buffer: every page starts empty, and the page list is
    // counted as soon as a dataset loads.
    if (capacity === 0) return 0;
    // The page list counts every page on each highlight and page change (a
    // colour drag included), and a count is a pass over every enabled cell
    // of the page: it is kept while the page has the same enabled cell
    // lists. A list is never written in place (each change publishes a new
    // one), so the same lists are the same cells.
    const lists = enabledPageCellLists(page);
    // One enabled list is its own union: a cell list holds each of its
    // cells once (strictly ascending), so it counts its length.
    if (lists.length === 1 && isCellList(lists[0], this.pointCount)) {
      return lists[0].length;
    }
    const known = pageCountCache.get(page);
    if (known !== undefined && known.pointCount === this.pointCount && sameLists(known.lists, lists)) {
      return known.count;
    }
    const cells = new Uint32Array(capacity);
    const membership = this._borrowHighlightMembershipScratch();
    let written;
    try {
      written = collectEnabledPageCells(
        page,
        this.pointCount,
        membership,
        label,
        cells,
        0
      );
    } catch (error) {
      // The buffer holds a partial page. Retire it rather than hand a dirty
      // deduplication structure to the next count.
      this._highlightMembershipScratch = null;
      throw error;
    }
    for (let i = 0; i < written; i++) membership[cells[i]] = 0;
    pageCountCache.set(page, { pointCount: this.pointCount, lists, count: written });
    return written;
  },

  createHighlightPage(name = null) {
    const id = `page_${++this._highlightPageIdCounter}`;
    const pageName = name || `Page ${this.highlightPages.length + 1}`;
    const page = {
      id,
      name: pageName,
      color: getPageColor(this.highlightPages.length),
      highlightedGroups: []
    };
    this.highlightPages.push(page);

    // If this is the first page, make it active
    if (this.highlightPages.length === 1) {
      this.activePageId = id;
    }

    this._notifyHighlightPageChange();
    return page;
  },

  switchToPage(pageId) {
    const page = this.highlightPages.find((p) => p.id === pageId);
    if (!page) return false;

    if (this.activePageId === pageId) return true;

    this.activePageId = pageId;
    this._recomputeHighlightArray();
    this._notifyHighlightChange();
    this._notifyHighlightPageChange();
    return true;
  },

  deleteHighlightPage(pageId) {
    const idx = this.highlightPages.findIndex((p) => p.id === pageId);
    if (idx === -1) return false;

    // Don't allow deleting the last page
    if (this.highlightPages.length <= 1) return false;

    this.highlightPages.splice(idx, 1);

    // If we deleted the active page, switch to another
    if (this.activePageId === pageId) {
      this.activePageId = this.highlightPages[0].id;
      this._recomputeHighlightArray();
      this._notifyHighlightChange();
    }

    this._notifyHighlightPageChange();
    return true;
  },

  renameHighlightPage(pageId, newName) {
    const page = this.highlightPages.find((p) => p.id === pageId);
    if (!page) return false;
    page.name = newName;
    this._notifyHighlightPageChange();
    return true;
  },

  /**
   * Set a persistent color for a highlight page.
   * This is used across the app (Highlighted Cells tabs + analysis UI).
   *
   * @param {string} pageId
   * @param {string} color - Hex color (#RRGGBB)
   * @returns {boolean}
   */
  setHighlightPageColor(pageId, color) {
    const page = this.highlightPages.find((p) => p.id === pageId);
    if (!page) return false;

    const next = String(color ?? '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(next)) {
      console.warn('[State] Invalid page color:', color);
      return false;
    }

    page.color = next;
    this._notifyHighlightPageChange();
    return true;
  },

  /**
   * Get the current color for a page (falls back to the default palette).
   * @param {string} pageId
   * @returns {string}
   */
  getHighlightPageColor(pageId) {
    const page = this.highlightPages.find((p) => p.id === pageId);
    if (page?.color) return page.color;
    const idx = this.highlightPages.findIndex((p) => p.id === pageId);
    return getPageColor(idx >= 0 ? idx : 0);
  },

  /**
   * Combine two highlight pages using intersection or union
   * @param {string} pageId1 - First page ID
   * @param {string} pageId2 - Second page ID
   * @param {'intersection' | 'union'} operation - The set operation to perform
   * @returns {Object|null} The newly created page, or null if failed
   */
  combineHighlightPages(pageId1, pageId2, operation) {
    const page1 = this.highlightPages.find((p) => p.id === pageId1);
    const page2 = this.highlightPages.find((p) => p.id === pageId2);
    if (!page1 || !page2) return null;

    // Both pages are read through the one definition of a page's cells, so a
    // combination can never include a cell a source page does not render. The
    // borrowed membership bytes double as the set: no structure scales with
    // anything but the point count, which keeps a whole-dataset combination
    // exact and linear.
    const membership = this._borrowHighlightMembershipScratch();
    const label1 = `Highlight page "${page1.id}"`;
    const label2 = `Highlight page "${page2.id}"`;
    const capacity1 = enabledPageCellCapacity(page1, label1);
    const capacity2 = enabledPageCellCapacity(page2, label2);
    const collectInto = (page, label, cells, offset) => {
      try {
        return collectEnabledPageCells(
          page,
          this.pointCount,
          membership,
          label,
          cells,
          offset
        );
      } catch (error) {
        // The buffer holds a partial page. Retire it rather than hand a dirty
        // deduplication structure to the next reader.
        this._highlightMembershipScratch = null;
        throw error;
      }
    };
    const clearMarks = (cells, count) => {
      for (let i = 0; i < count; i++) membership[cells[i]] = 0;
    };

    // Each page's cells as a set, then word-wise algebra: the result is a
    // cell list (ascending), like every other group's.
    const pageCells = (page, label, capacity) => {
      const cells = new Uint32Array(capacity);
      const written = collectInto(page, label, cells, 0);
      clearMarks(cells, written);
      const set = new CellSet(this.pointCount);
      const words = set.words;
      for (let i = 0; i < written; i++) {
        words[cells[i] >>> 5] |= 1 << (cells[i] & 31);
      }
      set.size = written;
      return set;
    };
    const combined = pageCells(page1, label1, capacity1);
    const other = pageCells(page2, label2, capacity2);
    let operationSymbol;
    if (operation === 'intersection') {
      combined.intersectWith(other);
      operationSymbol = '∩';
    } else {
      combined.unionWith(other);
      operationSymbol = '∪';
    }
    const resultIndices = combined.toUint32Array();

    // Create the new page with derived name
    const newName = `${page1.name} ${operationSymbol} ${page2.name}`;
    const newPage = this.createHighlightPage(newName);

    // Add a single combined group if there are results
    if (resultIndices.length > 0) {
      const groupId = `highlight_${++this._highlightIdCounter}`;
      const group = {
        id: groupId,
        type: 'combined',
        label: `${operation === 'intersection' ? 'Intersection' : 'Union'} of ${page1.name} & ${page2.name}`,
        cellIndices: resultIndices,
        cellCount: resultIndices.length,
        enabled: true
      };
      newPage.highlightedGroups.push(group);
    }

    this._notifyHighlightPageChange();
    return newPage;
  },

  // Ensure at least one page exists.
  ensureHighlightPage() {
    if (this.highlightPages.length === 0) {
      this.createHighlightPage('Page 1');
    }
  },

  _ensureHighlightArray() {
    if (!this.highlightArray || this.highlightArray.length !== this.pointCount) {
      this.highlightArray = new Uint8Array(this.pointCount);
    }
  },

  /**
   * Repaint the highlight array from the active page's enabled groups.
   *
   * The painted set is `collectEnabledPageCells` applied to the active page —
   * the same function `getHighlightedCellCountForPage` counts — so the count
   * the interface shows for the active page equals the set published here.
   */
  _recomputeHighlightArray() {
    this._ensureHighlightArray();
    this._invalidateHighlightCountCache(); // Invalidate cached counts
    this.highlightArray.fill(0);

    // Collect all highlighted indices as we go (avoids O(n) scan in renderer)
    const page = this._getActivePage();
    const label = 'Active highlight page';
    const capacity = enabledPageCellCapacity(page, label);
    const lists = page === null || page === undefined ? [] : enabledPageCellLists(page);
    let allHighlightedIndices;
    if (lists.length === 1 && isCellList(lists[0], this.pointCount)) {
      // One enabled cell list is the page's cells, each once and in its own
      // order (the order `collectEnabledPageCells` would publish): it is
      // painted and published as it is, never written in place.
      allHighlightedIndices = lists[0];
      paintCellList(this.highlightArray, allHighlightedIndices);
    } else {
      const cells = new Uint32Array(capacity);
      const written = collectEnabledPageCells(
        page,
        this.pointCount,
        this.highlightArray,
        label,
        cells,
        0
      );
      allHighlightedIndices = publishedHighlightIndices(cells, written);
    }

    this._highlightedCellIndices = allHighlightedIndices;
    this._pushHighlightToViewer(allHighlightedIndices);
  },

  _pushHighlightToViewer(highlightedIndices = null) {
    if (this.viewer && typeof this.viewer.updateHighlight === 'function') {
      this.viewer.updateHighlight(this.highlightArray, highlightedIndices);
    }
  },

  /**
   * Cells of one category of `field` that are visible in one view.
   *
   * Keyed by the field object rather than an index into this state's own
   * inventory: a selection gesture resolves the field of the pane it landed
   * in (`getFieldForView`), which is not the focused view's field when the
   * pane is not focused.
   *
   * @param {object} field - Categorical field metadata with loaded codes.
   * @param {number} categoryIndex - Category index to match.
   * @param {Uint8Array} viewTransparency - Exact per-view transparency array
   *   of the view the cells must be visible in.
   * @returns {Uint32Array} Cell list of the visible cells whose code is
   *   `categoryIndex`.
   */
  getCellIndicesForCategory(field, categoryIndex, viewTransparency) {
    requireCategoryOfField(field, categoryIndex);
    const codes = field.codes;
    if (
      !isCategoricalCodes(codes)
      || codes.length !== this.pointCount
    ) {
      throw new TypeError('Highlight category codes must match the current point count.');
    }
    const transparency = requireSelectionTransparency(viewTransparency, this.pointCount);
    // Only cells visible in the target view (not filtered out there).
    return cellListWhere(codes.length, i => (
      codes[i] === categoryIndex
      && transparency[i] >= POINT_VISIBILITY_THRESHOLD
    ));
  },

  /**
   * Cells of a continuous `field` whose value lies in `[minVal, maxVal]` and
   * that are visible in one view. Keyed by the field object for the same
   * reason as `getCellIndicesForCategory`.
   *
   * @param {object} field - Continuous field metadata with loaded values.
   * @param {number} minVal - Minimum value for range
   * @param {number} maxVal - Maximum value for range
   * @param {Uint8Array} viewTransparency - Exact per-view transparency array
   *   of the view the cells must be visible in.
   * @returns {Uint32Array} Cell list of the visible cells within the range.
   */
  getCellIndicesForRange(field, minVal, maxVal, viewTransparency) {
    if (
      !Number.isFinite(minVal)
      || !Number.isFinite(maxVal)
      || minVal > maxVal
    ) {
      throw new RangeError('Highlight range must contain ordered finite bounds.');
    }
    if (
      field === null
      || typeof field !== 'object'
      || Array.isArray(field)
      || field.kind !== 'continuous'
    ) {
      throw new TypeError('Highlight range field must be continuous.');
    }
    const values = field.values;
    if (
      (!(values instanceof Float32Array) && !(values instanceof Float64Array))
      || values.length !== this.pointCount
    ) {
      throw new TypeError('Highlight continuous values must match the current point count.');
    }
    const transparency = requireSelectionTransparency(viewTransparency, this.pointCount);
    // Only cells visible in the target view (not filtered out there).
    return cellListWhere(values.length, i => {
      const v = values[i];
      return (
        !Number.isNaN(v) && v >= minVal && v <= maxVal
        && transparency[i] >= POINT_VISIBILITY_THRESHOLD
      );
    });
  },

  // Clear preview highlight (restore to only permanent highlights).
  clearPreviewHighlight() {
    this._recomputeHighlightArray();
  },

  /**
   * Publish an in-progress selection on top of the active page's highlights.
   *
   * The published set is the active page's cells (`collectEnabledPageCells`,
   * the one definition) united with `cellIndices`. The caller owns the whole
   * meaning of `cellIndices`: a tool building a multi-step selection must pass
   * the combined result of its accumulated candidates and the pointer's
   * current hits, because this method has no way to tell an addition from a
   * subtraction and will union whatever it is handed.
   *
   * @param {Uint32Array} cellIndices - Cell list of the in-progress
   *   selection (ascending; every index names a cell of the current dataset).
   */
  setPreviewHighlightFromIndices(cellIndices) {
    if (!(cellIndices instanceof Uint32Array)) {
      throw new TypeError(
        'Preview highlight cell indices must be a cell list (Uint32Array).'
      );
    }
    if (cellIndices.length === 0) {
      this.clearPreviewHighlight();
      return;
    }

    this._ensureHighlightArray();
    // Start with existing permanent highlights
    this.highlightArray.fill(0);

    // Collect all highlighted indices (avoids O(n) scan in renderer). The page
    // cells and the preview cells share one buffer, so the union is built in a
    // single pass with no intermediate array.
    const page = this._getActivePage();
    const label = 'Active highlight page';
    const previewCount = cellIndices.length;
    const capacity = enabledPageCellCapacity(page, label) + previewCount;
    const cells = new Uint32Array(capacity);
    let written = collectEnabledPageCells(
      page,
      this.pointCount,
      this.highlightArray,
      label,
      cells,
      0
    );

    // Add preview highlights on top. The cell-list contract is checked in the
    // same pass: ascending (so unique) and inside the dataset.
    const pointCount = this.pointCount;
    const highlightArray = this.highlightArray;
    let previous = -1;
    for (let i = 0; i < previewCount; i++) {
      const idx = cellIndices[i];
      if (idx >= pointCount || idx <= previous) {
        throw new RangeError(
          `Preview highlight cell list must be ascending and inside the current dataset of ${formatCountOf(pointCount, 'cell')}.`
        );
      }
      previous = idx;
      if (highlightArray[idx] === 0) {
        if (written >= capacity) {
          // The same refusal the collector makes: an out-of-range typed-array
          // write is silent, and a painted cell missing from the published list
          // is exactly the disagreement this module exists to prevent.
          throw new RangeError(
            `Preview highlight produced more cells than its ${capacity}-entry buffer holds.`
          );
        }
        highlightArray[idx] = 255;
        cells[written] = idx;
        written++;
      }
    }
    const allHighlightedIndices = publishedHighlightIndices(cells, written);
    this._highlightedCellIndices = allHighlightedIndices;
    this._invalidateHighlightCountCache();
    this._pushHighlightToViewer(allHighlightedIndices);
  },

  // Add a highlighted group from a categorical selection.
  addHighlightFromCategory(fieldIndex, categoryIndex, source) {
    const { field, categoryName } = requireCategorySelection(
      this,
      fieldIndex,
      categoryIndex,
      source
    );
    const fieldKey = requireCategoryFieldKey(field);
    if (typeof this.getCellIndicesForCategory !== 'function') {
      throw new TypeError(
        'Category highlight state must expose getCellIndicesForCategory().'
      );
    }
    if (typeof this._recomputeHighlightArray !== 'function') {
      throw new TypeError(
        'Category highlight state must expose _recomputeHighlightArray().'
      );
    }
    if (typeof this._notifyHighlightChange !== 'function') {
      throw new TypeError(
        'Category highlight state must expose _notifyHighlightChange().'
      );
    }
    if (
      !Number.isSafeInteger(this.pointCount)
      || this.pointCount < 1
    ) {
      throw new TypeError(
        'Category highlight state requires a positive safe-integer point count.'
      );
    }
    if (
      !Number.isSafeInteger(this._highlightIdCounter)
      || this._highlightIdCounter < 0
      || this._highlightIdCounter === Number.MAX_SAFE_INTEGER
    ) {
      throw new TypeError(
        'Category highlight state requires a current highlight id counter.'
      );
    }
    const targetGroups = requireActiveHighlightGroups(this);
    const cellIndices = requireCreatedCellIndices(
      this.getCellIndicesForCategory(
        field,
        categoryIndex,
        this.categoryTransparency
      ),
      this.pointCount
    );
    const nextIdCounter = this._highlightIdCounter + 1;
    const id = `highlight_${nextIdCounter}`;
    const group = {
      id,
      type: 'category',
      label: `${fieldKey}: ${formatCategoryNameForGroupLabel(categoryName)}`,
      enabled: true,
      fieldKey,
      fieldIndex,
      fieldSource: source,
      categoryIndex,
      categoryName,
      cellIndices,
      cellCount: cellIndices.length
    };

    targetGroups.push(group);
    this._highlightIdCounter = nextIdCounter;
    this._recomputeHighlightArray();
    this._notifyHighlightChange();
    return group;
  },

  // Add a highlighted group from a continuous range selection.
  addHighlightFromRange(fieldIndex, minVal, maxVal, source = 'obs') {
    const field = source === 'var'
      ? this.varData?.fields?.[fieldIndex]
      : this.obsData?.fields?.[fieldIndex];
    if (!field || field.kind !== 'continuous') return null;

    const cellIndices = this.getCellIndicesForRange(
      field,
      minVal,
      maxVal,
      this.categoryTransparency
    );
    if (cellIndices.length === 0) return null;

    const id = `highlight_${++this._highlightIdCounter}`;
    const formatVal = (v) => {
      if (Math.abs(v) >= 1000 || (Math.abs(v) > 0 && Math.abs(v) < 0.01)) {
        return v.toExponential(2);
      }
      return v.toFixed(2);
    };
    const group = {
      id,
      type: 'range',
      label: `${field.key}: ${formatVal(minVal)} – ${formatVal(maxVal)}`,
      enabled: true,
      fieldKey: field.key,
      fieldIndex,
      fieldSource: source,
      rangeMin: minVal,
      rangeMax: maxVal,
      cellIndices,
      cellCount: cellIndices.length
    };

    // The active page's own list: the `highlightedGroups` getter answers a
    // fresh empty array when no page is active, and a group pushed there
    // would be reported as created and kept nowhere.
    requireActiveHighlightGroups(this).push(group);
    this._recomputeHighlightArray();
    this._notifyHighlightChange();
    return group;
  },

  // Add a highlight group directly with pre-computed cell indices.
  addHighlightDirect(groupData) {
    if (
      groupData === null
      || typeof groupData !== 'object'
      || Array.isArray(groupData)
      || Object.keys(groupData).sort().join(',') !== 'cellIndices,label,type'
    ) {
      throw new TypeError(
        'Direct highlight input must contain exactly cellIndices, label, and type.'
      );
    }
    if (
      groupData.type !== 'annotation'
      && groupData.type !== 'combined'
      && groupData.type !== 'knn'
      && groupData.type !== 'lasso'
      && groupData.type !== 'proximity'
    ) {
      throw new TypeError('Direct highlight type is unsupported.');
    }
    if (
      typeof groupData.label !== 'string'
      || groupData.label.length === 0
      || groupData.label !== groupData.label.trim()
    ) {
      throw new TypeError('Direct highlight label must be a nonempty trimmed string.');
    }
    requireCellList(
      groupData.cellIndices,
      this.pointCount,
      'Direct highlight cellIndices'
    );
    if (groupData.cellIndices.length === 0) {
      throw new TypeError('Direct highlight cellIndices must not be empty.');
    }
    // The group owns its own storage: a copy of the caller's cell list.
    const cellIndices = copyCellList(groupData.cellIndices);
    const cellCount = cellIndices.length;

    const id = `highlight_${++this._highlightIdCounter}`;
    const group = {
      id,
      type: groupData.type,
      label: groupData.label,
      enabled: true,
      cellIndices,
      cellCount,
    };

    requireActiveHighlightGroups(this).push(group);
    this._recomputeHighlightArray();
    this._notifyHighlightChange();
    return group;
  },

  removeHighlightGroup(groupId) {
    const idx = this.highlightedGroups.findIndex((g) => g.id === groupId);
    if (idx === -1) return false;
    this.highlightedGroups.splice(idx, 1);
    this._recomputeHighlightArray();
    this._notifyHighlightChange();
    return true;
  },

  toggleHighlightEnabled(groupId, enabled) {
    const group = this.highlightedGroups.find((g) => g.id === groupId);
    if (!group) return false;
    group.enabled = enabled;
    this._recomputeHighlightArray();
    this._notifyHighlightChange();
    return true;
  },

  /**
   * Remove every highlight group from the active page; other pages keep
   * theirs. The Clear button of the active page's group list, and the
   * dataset-replacement paths in `main.js` (straight after `initScene`, which
   * left one empty page), clear this.
   *
   * @returns {number} Groups removed from the active page.
   */
  clearActivePageHighlights() {
    const page = this._getActivePage();
    if (page === null) {
      // No page inventory at all means no highlights exist; removing none of
      // them is the truthful outcome. A named-but-missing active page is a
      // violated invariant and is not treated as "nothing to do".
      if (this.highlightPages.length !== 0) {
        throw new RangeError(
          `Active highlight page "${this.activePageId}" was not found.`
        );
      }
      return 0;
    }
    if (!Array.isArray(page.highlightedGroups)) {
      throw new TypeError('Active highlight page requires a group inventory.');
    }
    const removed = page.highlightedGroups.length;
    page.highlightedGroups = [];
    this._recomputeHighlightArray();
    this._notifyHighlightChange();
    return removed;
  },

  /**
   * Remove every highlight group from every page (the pages stay). The
   * notebook's `clear_highlights()` ("Clear all cell highlights in the
   * viewer") clears this.
   *
   * @returns {number} Groups removed.
   */
  clearHighlightsOnAllPages() {
    let removed = 0;
    for (const page of this.highlightPages) {
      if (!Array.isArray(page?.highlightedGroups)) {
        throw new TypeError(`Highlight page "${page?.id}" requires a group inventory.`);
      }
      removed += page.highlightedGroups.length;
      page.highlightedGroups = [];
    }
    this._recomputeHighlightArray();
    this._notifyHighlightChange();
    return removed;
  },

  getHighlightedGroups() {
    return this.highlightedGroups;
  },

  /**
   * Find a highlight group that was created from a specific category.
   * @param {number} fieldIndex - The field index
   * @param {number} categoryIndex - The category index within the field
   * @param {string} [source='obs'] - The field source ('obs' or 'var')
   * @returns {object|null} The matching highlight group, or null if not found
   */
  findHighlightGroupByCategory(fieldIndex, categoryIndex, source = 'obs') {
    return this.highlightedGroups.find(
      (g) =>
        g.type === 'category' &&
        g.fieldIndex === fieldIndex &&
        g.categoryIndex === categoryIndex &&
        g.fieldSource === source
    ) || null;
  },

  getHighlightedCellCount() {
    // Returns count of highlighted cells that are currently visible (cached)
    if (!this.highlightArray) return 0;
    let highlightedIndices = this._highlightedCellIndices;
    if (!isHighlightIndexList(highlightedIndices)) {
      // Nothing published the list yet: derive it from the intensity bytes.
      const intensity = this.highlightArray;
      highlightedIndices = cellListWhere(
        intensity.length,
        i => intensity[i] >= MIN_VISIBLE_ALPHA_BYTE
      );
      this._highlightedCellIndices = highlightedIndices;
    }
    if (highlightedIndices.length === 0) {
      this._cachedHighlightCount = 0;
      this._cachedTotalHighlightCount = 0;
      this._cachedHighlightLodMembership = null;
      return 0;
    }

    const viewId = this.getActiveViewId();
    const dimensionLevel = this.getViewDimensionLevel(viewId);
    const lodMembership = this.viewer.getCurrentLodMembership(
      viewId,
      dimensionLevel
    );

    if (
      this._cachedHighlightCount !== null &&
      this._cachedHighlightLodMembership === lodMembership
    ) {
      return this._cachedHighlightCount;
    }

    const admissionLevels =
      lodMembership?.admissionLevels ?? null;
    const lodLevel = lodMembership?.lodLevel ?? -1;
    let count = 0;
    for (let cursor = 0; cursor < highlightedIndices.length; cursor++) {
      const index = highlightedIndices[cursor];
      const visibleByAlpha =
        !this.categoryTransparency ||
        this.categoryTransparency[index] >=
          POINT_VISIBILITY_THRESHOLD;
      const visibleByLod =
        admissionLevels === null ||
        admissionLevels[index] <= lodLevel;
      if (visibleByAlpha && visibleByLod) count++;
    }
    this._cachedHighlightCount = count;
    this._cachedHighlightLodMembership = lodMembership;
    return count;
  },

  getTotalHighlightedCellCount() {
    // Returns total count of all highlighted cells, including filtered-out ones (cached)
    if (!this.highlightArray) return 0;
    if (this._cachedTotalHighlightCount !== null) return this._cachedTotalHighlightCount;
    if (!isHighlightIndexList(this._highlightedCellIndices)) {
      // Nothing published the list yet: derive it from the intensity bytes.
      const intensity = this.highlightArray;
      this._highlightedCellIndices = cellListWhere(
        intensity.length,
        i => intensity[i] >= MIN_VISIBLE_ALPHA_BYTE
      );
    }
    const count = this._highlightedCellIndices.length;
    this._cachedTotalHighlightCount = count;
    return count;
  },

  // Invalidate highlight count caches (call when highlight array or visibility changes).
  _invalidateHighlightCountCache(visibleOnly = false) {
    this._cachedHighlightCount = null;
    this._cachedHighlightLodMembership = null;
    if (!visibleOnly) this._cachedTotalHighlightCount = null;
  },
};

Object.assign(highlightStateMethods, highlightAccessorMethods);

export class HighlightManager extends BaseManager {
  constructor(coordinator) {
    super(coordinator);
  }
}
