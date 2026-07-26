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
  if (
    !Array.isArray(cellIndices)
    && !(cellIndices instanceof Uint32Array)
  ) {
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
   * Get the unique highlighted cell count for a page (enabled groups only).
   * Used by both the Highlighted Cells UI and analysis selectors.
   * @param {string} pageId
   * @returns {number}
   */
  getHighlightedCellCountForPage(pageId) {
    const page = this.highlightPages.find((p) => p.id === pageId);
    if (!page) return 0;

    const indices = new Set();
    for (const group of (page.highlightedGroups || [])) {
      if (!group || group.enabled === false) continue;
      const cells = group.cellIndices || [];
      for (let i = 0; i < cells.length; i++) indices.add(cells[i]);
    }
    return indices.size;
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

    // Collect all highlighted cell indices from each page
    const getCellSet = (page) => {
      const cellSet = new Set();
      for (const group of page.highlightedGroups) {
        if (group.enabled === false) continue;
        if (group.cellIndices) {
          for (const idx of group.cellIndices) {
            cellSet.add(idx);
          }
        }
      }
      return cellSet;
    };

    const set1 = getCellSet(page1);
    const set2 = getCellSet(page2);

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

  _recomputeHighlightArray() {
    this._ensureHighlightArray();
    this._invalidateHighlightCountCache(); // Invalidate cached counts
    this.highlightArray.fill(0);

    // Collect all highlighted indices as we go (avoids O(n) scan in renderer)
    const allHighlightedIndices = [];

    for (const group of this.highlightedGroups) {
      // Skip disabled groups
      if (group.enabled === false) continue;
      const indices = group.cellIndices;
      if (!indices) continue;
      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i];
        if (idx >= 0 && idx < this.pointCount) {
          // Only add if not already highlighted (avoid duplicates)
          if (this.highlightArray[idx] === 0) {
            this.highlightArray[idx] = 255;
            allHighlightedIndices.push(idx);
          }
        }
      }
    }

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
        if (transparency[i] > 0) {
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
        if (transparency[i] > 0) {
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

  // Set a preview highlight from an array of cell indices (used for lasso preview).
  setPreviewHighlightFromIndices(cellIndices) {
    if (!cellIndices || cellIndices.length === 0) {
      this.clearPreviewHighlight();
      return;
    }

    this._ensureHighlightArray();
    // Start with existing permanent highlights
    this.highlightArray.fill(0);

    // Collect all highlighted indices (avoids O(n) scan in renderer)
    const allHighlightedIndices = [];

    for (const group of this.highlightedGroups) {
      if (group.enabled === false) continue;
      const indices = group.cellIndices;
      if (!indices) continue;
      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i];
        if (idx >= 0 && idx < this.pointCount && this.highlightArray[idx] === 0) {
          this.highlightArray[idx] = 255;
          allHighlightedIndices.push(idx);
        }
      }
    }
    // Add preview highlights on top
    for (let i = 0; i < cellIndices.length; i++) {
      const idx = cellIndices[i];
      if (idx >= 0 && idx < this.pointCount && this.highlightArray[idx] === 0) {
        this.highlightArray[idx] = 255;
        allHighlightedIndices.push(idx);
      }
    }
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
      (
        !Array.isArray(groupData.cellIndices)
        && !(groupData.cellIndices instanceof Uint32Array)
      )
      || groupData.cellIndices.length === 0
    ) {
      throw new TypeError(
        'Direct highlight cellIndices must be a nonempty Array or Uint32Array.'
      );
    }
    for (const cellIndex of groupData.cellIndices) {
      if (
        !Number.isSafeInteger(cellIndex)
        || cellIndex < 0
        || cellIndex >= this.pointCount
      ) {
        throw new RangeError('Direct highlight cell index is outside the current dataset.');
      }
    }

    const id = `highlight_${++this._highlightIdCounter}`;
    const group = {
      id,
      type: groupData.type,
      label: groupData.label,
      enabled: true,
      cellIndices: Array.isArray(groupData.cellIndices)
        ? [...groupData.cellIndices]
        : Array.from(groupData.cellIndices),
      cellCount: groupData.cellIndices.length,
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

  clearAllHighlights() {
    this.highlightedGroups = [];
    this._recomputeHighlightArray();
    this._notifyHighlightChange();
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
    const viewId = this.getActiveViewId();
    const dimensionLevel = this.getViewDimensionLevel(viewId);
    const lodVisibility = this.viewer.getLodVisibilityArray(
      viewId,
      dimensionLevel
    );
    const lodLevel = this.viewer.getCurrentLODLevel(viewId);
    const lodSignature = lodVisibility ? (lodLevel ?? -1) : -1;

    if (this._cachedHighlightCount !== null && this._cachedHighlightLodLevel === lodSignature) {
      return this._cachedHighlightCount;
    }

    let count = 0;
    for (let i = 0; i < this.highlightArray.length; i++) {
      if (this.highlightArray[i] > 0) {
        // Only count if visible (no transparency = visible, or transparency > 0)
        const visibleByAlpha = !this.categoryTransparency || this.categoryTransparency[i] > 0;
        const visibleByLod = !lodVisibility || lodVisibility[i] > 0;
        const isVisible = visibleByAlpha && visibleByLod;
        if (isVisible) count++;
      }
    }
    this._cachedHighlightCount = count;
    this._cachedHighlightLodLevel = lodSignature;
    return count;
  },

  getTotalHighlightedCellCount() {
    // Returns total count of all highlighted cells, including filtered-out ones (cached)
    if (!this.highlightArray) return 0;
    if (this._cachedTotalHighlightCount !== null) return this._cachedTotalHighlightCount;
    let count = 0;
    for (let i = 0; i < this.highlightArray.length; i++) {
      if (this.highlightArray[i] > 0) count++;
    }
    this._cachedTotalHighlightCount = count;
    return count;
  },

  // Invalidate highlight count caches (call when highlight array or visibility changes).
  _invalidateHighlightCountCache(visibleOnly = false) {
    this._cachedHighlightCount = null;
    this._cachedHighlightLodLevel = null;
    if (!visibleOnly) this._cachedTotalHighlightCount = null;
  },
};

Object.assign(highlightStateMethods, highlightAccessorMethods);

export class HighlightManager extends BaseManager {
  constructor(coordinator) {
    super(coordinator);
  }
}
