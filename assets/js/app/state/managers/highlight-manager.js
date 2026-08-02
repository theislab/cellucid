/**
 * @fileoverview Highlight Manager.
 *
 * Manages highlight pages, groups, and per-point highlight intensity arrays.
 *
 * @module state/managers/highlight-manager
 */

import { BaseManager } from '../core/base-manager.js';
import { getPageColor } from '../../utils/page-colors.js';
import { highlightAccessorMethods } from './highlight-accessors.js';
import {
  MIN_VISIBLE_ALPHA_BYTE,
  POINT_VISIBILITY_THRESHOLD,
} from '../../../rendering/alpha-visibility.js';

function requireFieldSource(source) {
  if (source !== 'obs' && source !== 'var') {
    throw new TypeError('Highlight field source must be exactly "obs" or "var".');
  }
  return source;
}

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
  return { field, categoryName };
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
  if (!isHighlightIndexList(cellIndices)) {
    throw new TypeError(
      'Category highlight cell indices must be an Array or Uint32Array.'
    );
  }
  if (cellIndices.length === 0) {
    throw new RangeError(
      'Category highlight requires at least one currently visible cell.'
    );
  }
  const seen = new Set();
  for (const cellIndex of cellIndices) {
    if (
      !Number.isSafeInteger(cellIndex)
      || cellIndex < 0
      || cellIndex >= pointCount
      || seen.has(cellIndex)
    ) {
      throw new RangeError(
        'Category highlight cell indices must be unique and inside the current dataset.'
      );
    }
    seen.add(cellIndex);
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
    `${label} ${cellIndex} is outside the current dataset of ${pointCount} cells.`
  );
}

/**
 * True when `value` can carry a list of highlighted cell indices.
 *
 * Both shapes are current: a session restore decodes a `Uint32Array`
 * (`session/contributors/highlights-meta.js`), while a category or range
 * selection still produces a plain array. Every reader of a highlight index
 * list accepts both, so this predicate is the single place that says so.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isHighlightIndexList(value) {
  return Array.isArray(value) || value instanceof Uint32Array;
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
        `${label} group "${group.id}" cellIndices must be an Array or Uint32Array.`
      );
    }
    capacity += indices.length;
  }
  return capacity;
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
      `${label} membership buffer must be a Uint8Array of ${pointCount} entries.`
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
        `${label} group "${group.id}" cellIndices must be an Array or Uint32Array.`
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
  if (
    !(transparency instanceof Float32Array)
    || transparency.length !== pointCount
  ) {
    throw new TypeError(
      'Highlight selection requires the complete Float32Array transparency for its view.'
    );
  }
  for (let index = 0; index < transparency.length; index++) {
    if (
      !Number.isFinite(transparency[index])
      || transparency[index] < 0
      || transparency[index] > 1
    ) {
      throw new RangeError(
        `Highlight view transparency ${index} must be from 0 through 1.`
      );
    }
  }
  return transparency;
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
    const cells = new Uint32Array(enabledPageCellCapacity(page, label));
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

    // Collect all highlighted cell indices from each page, using the one
    // definition of a page's cells so a combination can never include a cell
    // the source page does not render.
    const membership = this._borrowHighlightMembershipScratch();
    const collect = (page) => {
      const label = `Highlight page "${page.id}"`;
      const cells = new Uint32Array(enabledPageCellCapacity(page, label));
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
        this._highlightMembershipScratch = null;
        throw error;
      }
      for (let i = 0; i < written; i++) membership[cells[i]] = 0;
      return new Set(cells.subarray(0, written));
    };

    const set1 = collect(page1);
    const set2 = collect(page2);

    let resultIndices;
    let operationSymbol;
    if (operation === 'intersection') {
      // Cells that are in BOTH pages
      resultIndices = [...set1].filter((idx) => set2.has(idx));
      operationSymbol = '∩';
    } else {
      // Union: cells that are in EITHER page
      resultIndices = [...new Set([...set1, ...set2])];
      operationSymbol = '∪';
    }

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
    const cells = new Uint32Array(enabledPageCellCapacity(page, label));
    const written = collectEnabledPageCells(
      page,
      this.pointCount,
      this.highlightArray,
      label,
      cells,
      0
    );
    const allHighlightedIndices = publishedHighlightIndices(cells, written);

    this._highlightedCellIndices = allHighlightedIndices;
    this._pushHighlightToViewer(allHighlightedIndices);
  },

  _pushHighlightToViewer(highlightedIndices = null) {
    if (this.viewer && typeof this.viewer.updateHighlight === 'function') {
      this.viewer.updateHighlight(this.highlightArray, highlightedIndices);
    }
  },

  /**
   * Get cell indices for a categorical selection.
   * Only includes cells that are currently visible (pass all active filters).
   * @param {number} fieldIndex - Field index in obs/var data
   * @param {number} categoryIndex - Category index to match
   * @param {string} source - Data source ('obs' or 'var')
   * @param {Float32Array} viewTransparency - Exact per-view transparency array.
   * @returns {number[]} Array of cell indices matching the category and passing filters
   */
  getCellIndicesForCategory(fieldIndex, categoryIndex, source, viewTransparency) {
    const { field } = requireCategorySelection(
      this,
      fieldIndex,
      categoryIndex,
      source
    );
    const codes = field.codes;
    if (
      (!(codes instanceof Uint8Array) && !(codes instanceof Uint16Array))
      || codes.length !== this.pointCount
    ) {
      throw new TypeError('Highlight category codes must match the current point count.');
    }
    const indices = [];
    const transparency = requireSelectionTransparency(viewTransparency, this.pointCount);
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] === categoryIndex) {
        // Only include cells that are currently visible (not filtered out in the target view)
        if (transparency[i] >= POINT_VISIBILITY_THRESHOLD) {
          indices.push(i);
        }
      }
    }
    return indices;
  },

  /**
   * Get cell indices for a continuous range selection.
   * Only includes cells that are currently visible (pass all active filters).
   * @param {number} fieldIndex - Field index in obs/var data
   * @param {number} minVal - Minimum value for range
   * @param {number} maxVal - Maximum value for range
   * @param {string} source - Data source ('obs' or 'var')
   * @param {Float32Array} viewTransparency - Exact per-view transparency array.
   * @returns {number[]} Array of cell indices within range and passing filters
   */
  getCellIndicesForRange(fieldIndex, minVal, maxVal, source, viewTransparency) {
    requireFieldSource(source);
    if (
      !Number.isFinite(minVal)
      || !Number.isFinite(maxVal)
      || minVal > maxVal
    ) {
      throw new RangeError('Highlight range must contain ordered finite bounds.');
    }
    const field = source === 'var'
      ? this.varData?.fields?.[fieldIndex]
      : this.obsData?.fields?.[fieldIndex];
    if (!field || field.kind !== 'continuous') {
      throw new RangeError('Highlight continuous field was not found.');
    }
    const values = field.values;
    if (
      (!(values instanceof Float32Array) && !(values instanceof Float64Array))
      || values.length !== this.pointCount
    ) {
      throw new TypeError('Highlight continuous values must match the current point count.');
    }
    const indices = [];
    const transparency = requireSelectionTransparency(viewTransparency, this.pointCount);
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v !== null && !Number.isNaN(v) && v >= minVal && v <= maxVal) {
        // Only include cells that are currently visible (not filtered out in the target view)
        if (transparency[i] >= POINT_VISIBILITY_THRESHOLD) {
          indices.push(i);
        }
      }
    }
    return indices;
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
   * @param {number[]|Uint32Array} cellIndices - Cells of the in-progress
   *   selection. Every index must name a cell in the current dataset.
   */
  setPreviewHighlightFromIndices(cellIndices) {
    if (!cellIndices || cellIndices.length === 0) {
      this.clearPreviewHighlight();
      return;
    }
    if (!isHighlightIndexList(cellIndices)) {
      throw new TypeError(
        'Preview highlight cell indices must be an Array or Uint32Array.'
      );
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

    // Add preview highlights on top
    const pointCount = this.pointCount;
    const highlightArray = this.highlightArray;
    for (let i = 0; i < previewCount; i++) {
      const idx = cellIndices[i];
      if (!isHighlightCellIndex(idx, pointCount)) {
        rejectHighlightCellIndex(
          idx,
          pointCount,
          'Preview highlight cell index'
        );
      }
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
        fieldIndex,
        categoryIndex,
        source,
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
      fieldIndex,
      minVal,
      maxVal,
      source,
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

    this.highlightedGroups.push(group);
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
    if (
      !isHighlightIndexList(groupData.cellIndices)
      || groupData.cellIndices.length === 0
    ) {
      throw new TypeError(
        'Direct highlight cellIndices must be a nonempty Array or Uint32Array.'
      );
    }
    // One pass validates and copies. The group owns its own storage — the
    // caller's array is a lasso/KNN scratch that keeps changing — and a
    // Uint32Array is that storage, so a whole-dataset selection costs four
    // bytes per cell instead of eight and is never visited twice on the way in.
    const sourceIndices = groupData.cellIndices;
    const cellCount = sourceIndices.length;
    const cellIndices = new Uint32Array(cellCount);
    for (let i = 0; i < cellCount; i++) {
      const cellIndex = sourceIndices[i];
      if (
        !Number.isSafeInteger(cellIndex)
        || cellIndex < 0
        || cellIndex >= this.pointCount
      ) {
        throw new RangeError('Direct highlight cell index is outside the current dataset.');
      }
      cellIndices[i] = cellIndex;
    }

    const id = `highlight_${++this._highlightIdCounter}`;
    const group = {
      id,
      type: groupData.type,
      label: groupData.label,
      enabled: true,
      cellIndices,
      cellCount,
    };

    this.highlightedGroups.push(group);
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
   * Remove every highlight group from the **active page only**.
   *
   * Pages other than the active one keep their groups. The name predates the
   * page system and overstates the scope; it is documented rather than
   * corrected here because the rename spans call sites owned elsewhere
   * (`main.js`, `jupyter-command-handler.js`, the highlight UI modules), and a
   * partial rename would not build. Two of the three callers want exactly this
   * scope: the "Clear" button sits in the active page's group list, and the
   * dataset-replacement paths in `main.js` run it straight after `initScene`,
   * which has already reset `highlightPages` to a single empty page.
   *
   * The third, the Jupyter `clearHighlights` command, does not: the Python
   * `viewer.clear_highlights()` docstring promises "Clear all cell highlights
   * in the viewer", which this does not deliver once a second page exists.
   *
   * @returns {number} Groups removed from the active page.
   */
  clearAllHighlights() {
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
      // Upgrade an already-live state or a minimal test fixture exactly once.
      highlightedIndices = [];
      for (let i = 0; i < this.highlightArray.length; i++) {
        if (this.highlightArray[i] >= MIN_VISIBLE_ALPHA_BYTE) {
          highlightedIndices.push(i);
        }
      }
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
      this._highlightedCellIndices = [];
      for (let i = 0; i < this.highlightArray.length; i++) {
        if (this.highlightArray[i] >= MIN_VISIBLE_ALPHA_BYTE) {
          this._highlightedCellIndices.push(i);
        }
      }
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
