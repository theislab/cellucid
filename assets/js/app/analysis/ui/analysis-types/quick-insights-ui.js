/**
 * Quick Insights Module
 *
 * Provides immediate, automatic analysis for the active highlight page.
 * - Auto-generates insights without requiring configuration
 * - Shows key statistics and distributions for the active page
 * - Supports "Dynamic" mode (follows active page) or manual page selection
 * - Page selector in collapsible section at bottom (closed by default)
 *
 * Performance Optimizations:
 * - Uses exact typed-array statistics without JavaScript object expansion
 * - Caches computed metrics for recently accessed fields
 *
 * Extends BaseAnalysisUI for consistent lifecycle and shared utilities.
 */

import { BaseAnalysisUI } from '../base-analysis-ui.js';

// Import statistical functions from centralized module
// Import debug utilities for production-safe logging
import { debug, debugWarn } from '../../shared/debug-utils.js';

import { createMultiSelectDropdown } from '../components/multi-select-dropdown.js';
import { MAX_CATEGORICAL_CATEGORIES } from '../../../../data/categorical-storage-contract.js';
import { createDisclosureHeader } from '../../shared/dom-utils.js';
import { PageSelectorComponent, PAGE_MODE } from '../shared/page-selector.js';

/**
 * Quick Insights Panel
 * Automatically shows useful insights for the active highlight page
 */
export class QuickInsights extends BaseAnalysisUI {
  /**
   * Get page requirements for quick insights
   * @static
   * @returns {{ minPages: number, maxPages: number|null, description: string }}
   */
  static getRequirements() {
    return {
      minPages: 1,
      maxPages: null,
      description: 'Select at least 1 page'
    };
  }

  /**
   * @param {Object} options
   * @param {Object} options.dataLayer - Enhanced data layer instance
   * @param {HTMLElement} options.container - Container element
   */
  constructor(options) {
    super(options);

    // Container from options (can be overridden in init())
    this._container = options.container;

    // QuickInsights-specific state
    this._cache = new Map();
    this._abortController = null;

    // Debounce timer for page changes
    this._debounceTimer = null;

    // Request ID to track current computation (prevents stale renders)
    this._currentRequestId = 0;

    // UI instance ID (used to avoid DOM id collisions)
    this._uiId = `quick-insights-${Math.random().toString(36).slice(2, 9)}`;

    // User-selected obs fields to show (persist across active page switches)
    /** @type {string[]} */
    this._selectedCategoricalObsKeys = [];
    /** @type {string[]} */
    this._selectedContinuousObsKeys = [];

    /** @type {boolean} */
    this._hasUserSelectedCategoricalObsFields = false;
    /** @type {boolean} */
    this._hasUserSelectedContinuousObsFields = false;

    /** @type {{ categorical: { destroy: Function } | null, continuous: { destroy: Function } | null }} */
    this._fieldPickers = { categorical: null, continuous: null };

    // Page selection mode: 'dynamic' (follow active) or 'manual' (user-selected)
    this._pageMode = PAGE_MODE.DYNAMIC;

    // Manually selected pages (used when _pageMode === 'manual')
    /** @type {string[]} */
    this._manuallySelectedPages = [];

    // Page selector component
    /** @type {PageSelectorComponent|null} */
    this._pageSelector = null;

    /** @type {HTMLElement|null} */
    this._pageSelectorContainer = null;

    // Collapsible state (closed by default)
    this._pageSelectorExpanded = false;

    // Pending update flag (for when accordion is closed during highlight changes)
    this._pendingUpdateWhenVisible = false;
    this._destroyPromise = null;

    // Content container (for insights, separate from page selector)
    this._contentContainer = null;

    // Bind page change handlers
    this._handlePageChange = this._handlePageChange.bind(this);
    this._handlePageColorChange = this._handlePageColorChange.bind(this);
  }

  /**
   * Cleanup any mounted field picker UI components (prevents leaked document listeners).
   * @private
   */
  _destroyFieldPickers() {
    if (this._fieldPickers.categorical) {
      this._fieldPickers.categorical.destroy();
      this._fieldPickers.categorical = null;
    }
    if (this._fieldPickers.continuous) {
      this._fieldPickers.continuous.destroy();
      this._fieldPickers.continuous = null;
    }
  }

  /**
   * Cleanup the page selector component
   * @private
   */
  _destroyPageSelector() {
    if (this._pageSelector) {
      this._pageSelector.destroy();
      this._pageSelector = null;
    }
    this._pageSelectorContainer = null;
  }

  // ===========================================================================
  // Page Selection Handlers
  // ===========================================================================

  /**
   * Handle page selection change from PageSelectorComponent
   * @param {string[]} pageIds - Selected page IDs (effective pages based on mode)
   */
  _handlePageChange(pageIds) {
    if (!this._pageSelector) {
      throw new Error(
        'Quick Insights page changes require the current page selector'
      );
    }
    this._pageMode = this._pageSelector.isDynamicMode()
      ? PAGE_MODE.DYNAMIC
      : PAGE_MODE.MANUAL;
    this._manuallySelectedPages = this._pageSelector.getSelectedPages();

    // Update collapsible header mode indicator
    this._updateModeIndicator();

    this._cache.clear();
    this._triggerUpdate();
  }

  /**
   * Handle page mode change from PageSelectorComponent
   * @param {'dynamic'|'manual'} mode - New mode
   * @param {string[]} pageIds - Effective page IDs
   */
  _handleModeChange(mode, pageIds) {
    this._pageMode = mode;
    if (mode === PAGE_MODE.MANUAL && this._pageSelector) {
      this._manuallySelectedPages = this._pageSelector.getSelectedPages();
    } else {
      this._manuallySelectedPages = [];
    }

    // Update collapsible header mode indicator
    this._updateModeIndicator();

    this._cache.clear();
    this._triggerUpdate();
  }

  /**
   * Update the mode indicator in the collapsible header
   * @private
   */
  _updateModeIndicator() {
    const modeIndicator = this._container?.querySelector('.insights-page-mode-indicator');
    if (!modeIndicator) return;

    if (this._pageMode === PAGE_MODE.DYNAMIC) {
      const activePageId = this.dataLayer?.getActiveHighlightPageId?.();
      const pageName = activePageId ? this._getPageName(activePageId) : null;
      modeIndicator.textContent = pageName ? `(${pageName})` : '(Dynamic)';
    } else {
      const selectedCount = this._manuallySelectedPages.length;
      if (selectedCount === 0) {
        modeIndicator.textContent = '(None)';
      } else if (selectedCount === 1) {
        modeIndicator.textContent = `(${this._getPageName(this._manuallySelectedPages[0])})`;
      } else {
        modeIndicator.textContent = `(${selectedCount} pages)`;
      }
    }
  }

  /**
   * Handle page color change from PageSelectorComponent
   * @param {string} pageId - Page ID
   * @param {string} color - New color
   */
  _handlePageColorChange(pageId, color) {
    this.dataLayer?.setPageColor?.(pageId, color);
    this._triggerUpdate();
  }

  /**
   * Get the effective page IDs to analyze based on current mode
   * @returns {string[]}
   * @private
   */
  _getEffectivePageIds() {
    if (this._pageMode === PAGE_MODE.DYNAMIC) {
      // Get the active highlight page
      const activePageId = this.dataLayer?.getActiveHighlightPageId?.();
      return activePageId ? [activePageId] : [];
    } else {
      return this._manuallySelectedPages;
    }
  }

  /**
   * Check if this UI is currently visible (accordion open or floating window expanded)
   * @private
   */
  _isVisible() {
    // Check sidebar accordion item
    const accordionItem = this._container?.closest('.analysis-accordion-item');
    if (accordionItem) {
      return accordionItem.classList.contains('open');
    }

    // Check floating window (uses <details> element)
    const floatingDetails = this._container?.closest('details.analysis-window-panel');
    if (floatingDetails) {
      return floatingDetails.open;
    }

    // Unknown container type - assume visible
    return true;
  }

  /**
   * Invalidate every pending/deferred computation synchronously.
   *
   * Ownership must advance when user intent changes, not when a later debounce
   * callback happens to start. Otherwise an older non-abort failure can still
   * publish during the debounce window (or while the panel is hidden).
   *
   * @returns {number} The newly owned request generation
   * @private
   */
  _beginUpdateIntent() {
    this._currentRequestId++;

    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }

    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    return this._currentRequestId;
  }

  /**
   * Trigger debounced update
   * @private
   */
  _triggerUpdate() {
    this._beginUpdateIntent();

    // Skip fetch if not visible - will refresh when accordion opens
    if (!this._isVisible()) {
      this._pendingUpdateWhenVisible = true;
      return;
    }
    this._pendingUpdateWhenVisible = false;

    const pageIds = this._getEffectivePageIds();
    if (pageIds.length === 0) {
      this._renderEmpty();
      return;
    }

    // Debounce rapid changes
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._trackInteractiveTask(
        this.updateForSelectedPages(),
        'Quick Insights update'
      );
    }, 150);
  }

  /**
   * @param {string[]} selectedKeys
   * @param {string[]} availableKeys
   * @param {string} label
   * @returns {string[]} Validated selection
   * @private
   */
  _requireSelectedKeys(selectedKeys, availableKeys, label) {
    if (!Array.isArray(selectedKeys)) {
      throw new TypeError(`${label} selection must be an array`);
    }
    if (!Array.isArray(availableKeys)) {
      throw new TypeError(`${label} variable inventory must be an array`);
    }

    const available = new Set(availableKeys);
    const out = [];
    const seen = new Set();

    for (const key of selectedKeys) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new TypeError(`${label} field keys must be non-empty strings`);
      }
      if (!available.has(key)) {
        throw new Error(`${label} field "${key}" is not available`);
      }
      if (seen.has(key)) {
        throw new Error(`${label} field "${key}" is selected more than once`);
      }
      seen.add(key);
      out.push(key);
    }

    return out;
  }

  /**
   * Build picker items from available variables.
   * @param {'categorical_obs'|'continuous_obs'} type
   * @returns {{ key: string, label: string }[]}
   * @private
   */
  _getObsVariableItems(type) {
    const vars = this.dataLayer.getAvailableVariables(type) || [];
    return vars.map(v => ({ key: v.key, label: v.name || v.key }));
  }

  /**
   * Apply and persist the selected categorical obs fields.
   * @param {string[]} nextKeys
   * @private
   */
  _applyCategoricalSelection(nextKeys) {
    const variables = this.dataLayer.getAvailableVariables('categorical_obs');
    if (!Array.isArray(variables)) {
      throw new TypeError('Categorical observation variable inventory must be an array');
    }
    const availableKeys = variables.map(v => v.key);
    this._selectedCategoricalObsKeys = this._requireSelectedKeys(
      nextKeys,
      availableKeys,
      'Categorical observation'
    );
    this._hasUserSelectedCategoricalObsFields = true;
  }

  /**
   * Apply and persist the selected continuous obs fields.
   * @param {string[]} nextKeys
   * @private
   */
  _applyContinuousSelection(nextKeys) {
    const variables = this.dataLayer.getAvailableVariables('continuous_obs');
    if (!Array.isArray(variables)) {
      throw new TypeError('Continuous observation variable inventory must be an array');
    }
    const availableKeys = variables.map(v => v.key);
    this._selectedContinuousObsKeys = this._requireSelectedKeys(
      nextKeys,
      availableKeys,
      'Continuous observation'
    );
    this._hasUserSelectedContinuousObsFields = true;
  }

  /**
   * Initialize the Quick Insights panel
   * @param {HTMLElement} [container] - Optional container override
   */
  init(container) {
    if (container) {
      this._container = container;
    }
    this._render();
    this._setupVisibilityListener();
  }

  /**
   * Setup listener for floating window toggle events
   * @private
   */
  _setupVisibilityListener() {
    // Listen for floating window expand/collapse
    const floatingDetails = this._container?.closest('details.analysis-window-panel');
    if (floatingDetails && !this._detailsToggleListener) {
      this._detailsToggleListener = () => {
        if (floatingDetails.open) {
          this.onVisibilityChanged(true);
        }
      };
      floatingDetails.addEventListener('toggle', this._detailsToggleListener);
    }
  }

  /**
   * Render controls - QuickInsights auto-renders, so this is a no-op
   * @override
   */
  _renderControls() {
    // QuickInsights doesn't have traditional controls - it auto-generates insights
  }

  /**
   * Run analysis for the current selected pages
   * @override
   */
  async _runAnalysis() {
    await this.updateForSelectedPages();
  }

  /**
   * Handle page selection change - update when active page changes
   * @override
   */
  onPageSelectionChange() {
    // If in dynamic mode, update when active page changes
    if (this._pageMode === PAGE_MODE.DYNAMIC) {
      this._cache.clear();
      this._triggerUpdate();
    }
    // Refresh page selector to update available pages
    this._pageSelector?.refresh?.();
  }

  /**
   * Handle highlight changes (cells added/removed from pages)
   * Override base class to trigger update for QuickInsights
   * @override
   */
  onHighlightChanged() {
    // Update page selector cell counts
    this._pageSelector?.updateCounts();

    // Clear cache when cell counts change
    this._cache.clear();

    // Trigger update
    this._triggerUpdate();
  }

  /**
   * Handle visibility change (accordion opened/closed)
   * Triggers pending updates when becoming visible
   * @param {boolean} isVisible
   */
  onVisibilityChanged(isVisible) {
    if (isVisible && this._pendingUpdateWhenVisible) {
      this._pendingUpdateWhenVisible = false;
      this._triggerUpdate();
    }
  }

  /**
   * Update insights for selected pages (supports multiple pages)
   */
  async updateForSelectedPages() {
    const requestId = this._beginUpdateIntent();

    // Get effective page IDs based on mode
    const pageIds = this._getEffectivePageIds();

    // Validate selected pages against current pages
    let allPages;
    try {
      allPages = this.dataLayer.getPages();
    } catch {
      this._renderEmpty();
      return;
    }

    const validPageIds = new Set(allPages.map(p => p.id));
    const filteredPageIds = pageIds.filter(id => validPageIds.has(id));

    if (filteredPageIds.length === 0) {
      this._renderEmpty();
      return;
    }

    // Create new abort controller for this request
    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    this._renderLoading();

    try {
      const insights = await this._computeInsights(filteredPageIds, signal);

      // Check if this request is still current (prevents stale renders)
      if (requestId !== this._currentRequestId) {
        debug('QuickInsights', 'Discarding stale result for request', requestId);
        return;
      }

      // Check if we were aborted
      if (signal.aborted) return;

      // Final validation before render - ensure pages still exist
      const currentPages = this.dataLayer.getPages();
      const currentPageIds = new Set(currentPages.map(p => p.id));
      const stillValidPages = insights.pages?.filter(p => currentPageIds.has(p.id)) || [];

      if (stillValidPages.length === 0 && filteredPageIds.length > 0) {
        // Pages were removed during computation
        debug('QuickInsights', 'Pages removed during computation, re-rendering empty');
        this._renderEmpty();
        return;
      }

      // Update insights with only valid pages
      insights.pages = stillValidPages;
      insights.totalCells = stillValidPages.reduce((sum, p) => sum + (p.cellCount || 0), 0);

      this._renderInsights(insights);
    } catch (err) {
      // Only show error if this is still the current request
      if (requestId !== this._currentRequestId) return;

      if (err.name !== 'AbortError') {
        console.error('[QuickInsights] Failed to compute insights:', err);
        this._renderError(err.message);
      }
    }
  }

  /**
   * Render empty state
   */
  _renderEmpty() {
    if (!this._contentContainer) return;
    this._destroyFieldPickers();
    this._contentContainer.innerHTML = `
      <div class="quick-insights-empty">
        <p class="insights-help">Quick Insights shows stats for the active highlight page.</p>
        <p class="insights-help">Switch highlight pages or add highlighted cells to see insights.</p>
      </div>
    `;
  }

  /**
   * Render loading state
   */
  _renderLoading() {
    if (!this._contentContainer) return;
    this._destroyFieldPickers();
    this._contentContainer.innerHTML = `
      <div class="quick-insights-loading">
        <div class="insights-spinner"></div>
        <span>Computing insights...</span>
      </div>
    `;
  }

  /**
   * Render error state
   */
  _renderError(message) {
    if (!this._contentContainer) return;
    this._destroyFieldPickers();
    this._contentContainer.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'quick-insights-error';

    const text = document.createElement('span');
    text.textContent = `Failed to compute insights: ${message || 'Unknown error'}`;
    wrapper.appendChild(text);

    this._contentContainer.appendChild(wrapper);
  }

  /**
   * Compute insights for selected pages (supports multiple pages)
   * @param {string[]} pageIds - Page IDs to analyze
   * @param {AbortSignal} [signal] - Abort signal for cancellation
   */
  async _computeInsights(pageIds, signal) {
    const insights = {
      pages: [],
      totalCells: 0,
      categoricalSummaries: [],
      continuousSummaries: [],
      fieldSelectionMethod: 'default'
    };

    if (!Array.isArray(pageIds) || pageIds.length === 0) return insights;

    // Check abort before processing
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Get every requested page without silently dropping stale identities.
    const allPages = this.dataLayer.getPages();
    if (!Array.isArray(allPages)) {
      throw new TypeError('Quick Insights pages must be an array');
    }
    const pageMap = new Map(allPages.map(p => [p.id, p]));
    const validPageIds = [];

    for (const pageId of pageIds) {
      const page = pageMap.get(pageId);
      if (!page) {
        throw new Error(`Quick Insights page not found: ${pageId}`);
      }

      const cellCount = this.dataLayer.getCellCountForPageId(pageId);
      if (!Number.isSafeInteger(cellCount) || cellCount < 0) {
        throw new TypeError(
          `Quick Insights page "${pageId}" cell count must be a non-negative safe integer`
        );
      }

      validPageIds.push(pageId);
      insights.pages.push({
        id: pageId,
        name: page.name,
        cellCount,
        groupCount: Array.isArray(page.highlightedGroups)
          ? page.highlightedGroups.length
          : 0
      });
      insights.totalCells += cellCount;
    }

    // Resolve available variables
    const allCatFields = this.dataLayer.getAvailableVariables('categorical_obs');
    const allContFields = this.dataLayer.getAvailableVariables('continuous_obs');
    if (!Array.isArray(allCatFields) || !Array.isArray(allContFields)) {
      throw new TypeError(
        'Quick Insights observation variable inventories must be arrays'
      );
    }

    const availableCatKeys = allCatFields.map(f => f.key);
    const availableContKeys = allContFields.map(f => f.key);

    for (const key of this._selectedCategoricalObsKeys) {
      if (!availableCatKeys.includes(key)) {
        throw new Error(
          `Selected categorical observation field "${key}" is not available`
        );
      }
    }
    for (const key of this._selectedContinuousObsKeys) {
      if (!availableContKeys.includes(key)) {
        throw new Error(
          `Selected continuous observation field "${key}" is not available`
        );
      }
    }

    // Default selection (only before the user explicitly picks fields)
    if (!this._hasUserSelectedCategoricalObsFields && this._selectedCategoricalObsKeys.length === 0) {
      this._selectedCategoricalObsKeys = availableCatKeys.slice(0, Math.min(2, availableCatKeys.length));
    }
    if (!this._hasUserSelectedContinuousObsFields && this._selectedContinuousObsKeys.length === 0) {
      this._selectedContinuousObsKeys = availableContKeys.slice(0, Math.min(2, availableContKeys.length));
    }

    insights.fieldSelectionMethod =
      (this._hasUserSelectedCategoricalObsFields || this._hasUserSelectedContinuousObsFields)
        ? 'manual'
        : 'default';

    const selectedCatKeys = [...this._selectedCategoricalObsKeys];
    const selectedContKeys = [...this._selectedContinuousObsKeys];
    const obsFields = [...selectedCatKeys, ...selectedContKeys];
    if (new Set(obsFields).size !== obsFields.length) {
      throw new Error(
        'Quick Insights observation fields must have one exact declared kind'
      );
    }

    if (obsFields.length === 0) {
      return insights;
    }

    // Check abort before starting bulk load
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const bulkData = await this.dataLayer.fetchBulkObsFields({
      pageIds: validPageIds,
      obsFields,
      subsetPages: false,
      includeCategoricalValues: false
    });

    // Check abort after bulk load
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    if (
      bulkData === null ||
      typeof bulkData !== 'object' ||
      Array.isArray(bulkData) ||
      bulkData.fields === null ||
      typeof bulkData.fields !== 'object' ||
      Array.isArray(bulkData.fields) ||
      bulkData.pageData === null ||
      typeof bulkData.pageData !== 'object' ||
      Array.isArray(bulkData.pageData)
    ) {
      throw new TypeError(
        'Quick Insights bulk observation result must contain exact fields and pageData objects'
      );
    }

    for (const fieldKey of selectedCatKeys) {
      if (!Object.hasOwn(bulkData.fields, fieldKey)) {
        throw new Error(
          `Requested observation field "${fieldKey}" is missing from the bulk result`
        );
      }
      const fieldData = bulkData.fields[fieldKey];
      const summary = this._summarizeCategoricalAcrossPages(fieldKey, fieldData, validPageIds, bulkData.pageData, signal);
      if (summary) insights.categoricalSummaries.push(summary);
    }

    for (const fieldKey of selectedContKeys) {
      if (!Object.hasOwn(bulkData.fields, fieldKey)) {
        throw new Error(
          `Requested observation field "${fieldKey}" is missing from the bulk result`
        );
      }
      const fieldData = bulkData.fields[fieldKey];
      const summary = this._summarizeContinuousAcrossPages(fieldKey, fieldData, validPageIds, bulkData.pageData, signal);
      if (summary) insights.continuousSummaries.push(summary);
    }

    return insights;
  }

  /**
   * @param {ArrayLike<number>} counts
   * @param {number} k
   * @returns {{ index: number, count: number }[]}
   * @private
   */
  _topKFromCountsArray(counts, k) {
    /** @type {{ index: number, count: number }[]} */
    const top = [];
    for (let index = 0; index < counts.length; index++) {
      const count = counts[index];
      if (count === 0) continue;

      let insertAt = top.length;
      for (let i = 0; i < top.length; i++) {
        if (count > top[i].count) {
          insertAt = i;
          break;
        }
      }

      if (insertAt >= k) continue;
      top.splice(insertAt, 0, { index, count });
      if (top.length > k) top.length = k;
    }
    return top;
  }

  /**
   * Return the exact cell-index sequence for one requested page.
   * @private
   * @param {Record<string, { cellIndices: ArrayLike<number> }>} pageData
   * @param {string} pageId
   * @returns {ArrayLike<number>}
   */
  _requirePageCellIndices(pageData, pageId) {
    if (
      pageData === null ||
      typeof pageData !== 'object' ||
      Array.isArray(pageData) ||
      !Object.hasOwn(pageData, pageId)
    ) {
      throw new Error(
        `Quick Insights page data is missing requested page "${pageId}"`
      );
    }
    const cellIndices = pageData[pageId]?.cellIndices;
    if (
      !Array.isArray(cellIndices) &&
      !(ArrayBuffer.isView(cellIndices) && !(cellIndices instanceof DataView))
    ) {
      throw new TypeError(
        `Quick Insights page "${pageId}" cellIndices must be an array or typed array`
      );
    }
    return cellIndices;
  }

  /**
   * Summarize categorical data aggregated across all pages.
   * Prefers counting codes to avoid allocating per-cell strings.
   * @private
   * @param {string} fieldName
   * @param {any} fieldData
   * @param {string[]} pageIds
   * @param {Record<string, { cellIndices: number[] }>} pageData
   * @param {AbortSignal} [signal]
   * @returns {{ field: string, total: number, topCategories: { name: string, count: number, percent: string }[] } | null}
   */
  _summarizeCategoricalAcrossPages(fieldName, fieldData, pageIds, pageData, signal) {
    const categories = fieldData?.categories;
    const codes = fieldData?.codes;
    if (!(codes instanceof Uint16Array) || !Array.isArray(categories)) {
      throw new TypeError(
        `Quick Insights categorical field "${fieldName}" requires ` +
        'Uint16Array codes and categories'
      );
    }
    if (categories.length > MAX_CATEGORICAL_CATEGORIES) {
      throw new RangeError(
        `Quick Insights categorical field "${fieldName}" exceeds ` +
        `${MAX_CATEGORICAL_CATEGORIES.toLocaleString('en-US')} categories`
      );
    }

    const missingIndex = categories.length;
    const counts = new Float64Array(categories.length + 1);
    let total = 0;
    let iter = 0;
    for (const pageId of pageIds) {
      const cellIndices = this._requirePageCellIndices(pageData, pageId);
      for (let i = 0; i < cellIndices.length; i++) {
        const cellIdx = cellIndices[i];
        if (
          !Number.isSafeInteger(cellIdx) ||
          cellIdx < 0 ||
          cellIdx >= codes.length
        ) {
          throw new RangeError(
            `Cell index ${String(cellIdx)} is outside categorical field ` +
            `"${fieldName}" length ${codes.length}`
          );
        }
        const code = codes[cellIdx];
        if (code === 65_535) {
          counts[missingIndex]++;
        } else if (code >= categories.length) {
          throw new RangeError(
            `Category code ${code} for "${fieldName}" is outside ` +
            `${categories.length} categories`
          );
        } else {
          counts[code]++;
        }
        total++;
        if ((++iter & 0x3fff) === 0 && signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
      }
    }

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (total === 0) return null;

    const top = this._topKFromCountsArray(counts, 5);
    return {
      field: fieldName,
      total,
      topCategories: top.map(({ index, count }) => ({
        name: index === missingIndex ? '(missing)' : categories[index],
        count,
        percent: ((count / total) * 100).toFixed(1)
      }))
    };
  }

  /**
   * Summarize continuous data aggregated across all pages.
   * Uses the raw Float32 field array and exact page cell indices.
   * @private
   * @param {string} fieldName
   * @param {{ values: Float32Array }} fieldData
   * @param {string[]} pageIds
   * @param {Record<string, { cellIndices: ArrayLike<number> }>} pageData
   * @param {AbortSignal} [signal]
   * @returns {{ field: string, count: number, missingCount: number, mean: number|null, median: number|null, min: number|null, max: number|null, std: number|null, q1: number|null, q3: number|null, approximate: false } | null}
   */
  _summarizeContinuousAcrossPages(fieldName, fieldData, pageIds, pageData, signal) {
    const rawValues = fieldData?.values;
    if (!(rawValues instanceof Float32Array)) {
      throw new TypeError(
        `Continuous field "${fieldName}" requires a Float32Array values payload`
      );
    }

    let count = 0;
    let missingCount = 0;
    let mean = 0;
    let m2 = 0;
    let min = Infinity;
    let max = -Infinity;
    let iter = 0;

    for (const pageId of pageIds) {
      const cellIndices = this._requirePageCellIndices(pageData, pageId);
      for (let i = 0; i < cellIndices.length; i++) {
        const cellIdx = cellIndices[i];
        if (
          !Number.isSafeInteger(cellIdx) ||
          cellIdx < 0 ||
          cellIdx >= rawValues.length
        ) {
          throw new RangeError(
            `Cell index ${String(cellIdx)} is outside continuous field ` +
            `"${fieldName}" length ${rawValues.length}`
          );
        }

        const value = rawValues[cellIdx];
        if (Number.isNaN(value)) {
          missingCount++;
        } else {
          if (!Number.isFinite(value)) {
            throw new TypeError(
              `Continuous field "${fieldName}" contains non-finite value ` +
              `${String(value)} at cell ${cellIdx}`
            );
          }

          count++;
          const delta = value - mean;
          mean += delta / count;
          m2 += delta * (value - mean);
          if (value < min) min = value;
          if (value > max) max = value;
        }

        if ((++iter & 0x3fff) === 0 && signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
      }
    }

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (count === 0 && missingCount === 0) return null;
    if (count === 0) {
      return {
        field: fieldName,
        count,
        missingCount,
        mean: null,
        median: null,
        min: null,
        max: null,
        std: null,
        q1: null,
        q3: null,
        approximate: false
      };
    }

    const sorted = new Float32Array(count);
    let sortedIndex = 0;
    iter = 0;
    for (const pageId of pageIds) {
      const cellIndices = this._requirePageCellIndices(pageData, pageId);
      for (let i = 0; i < cellIndices.length; i++) {
        const value = rawValues[cellIndices[i]];
        if (!Number.isNaN(value)) {
          sorted[sortedIndex++] = value;
        }
        if ((++iter & 0x3fff) === 0 && signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
      }
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    sorted.sort();
    const middle = Math.floor(count / 2);
    const median = count % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];

    return {
      field: fieldName,
      count,
      missingCount,
      mean,
      median,
      min,
      max,
      std: Math.sqrt(m2 / count),
      q1: sorted[Math.floor(count * 0.25)],
      q3: sorted[Math.floor(count * 0.75)],
      approximate: false
    };
  }

  /**
   * Render initial state
   */
  _render() {
    if (!this._container) return;
    // Use classList.add to preserve original classes (e.g., analysis-accordion-content)
    this._container.classList.add('quick-insights-panel');
    this._container.innerHTML = '';

    // Create content container for insights
    this._contentContainer = document.createElement('div');
    this._contentContainer.className = 'quick-insights-content';
    this._container.appendChild(this._contentContainer);

    // Render the collapsible page selector at the bottom
    this._renderPageSelectorSection();

    // Trigger initial update
    this._triggerUpdate();
  }

  /**
   * Render computed insights
   */
  _renderInsights(insights) {
    if (!this._contentContainer) return;

    // Validate insights object
    if (!insights || !Array.isArray(insights.pages)) {
      debugWarn('QuickInsights', 'Invalid insights object');
      this._renderEmpty();
      return;
    }

    // Handle empty pages gracefully
    if (insights.pages.length === 0) {
      this._renderEmpty();
      return;
    }

    // Final safety check - verify container still exists (could be destroyed during async)
    if (!this._contentContainer || !this._contentContainer.parentNode) {
      debug('QuickInsights', 'Container no longer in DOM, skipping render');
      return;
    }

    this._destroyFieldPickers();
    this._contentContainer.innerHTML = '';

    // Page summary header
    const header = document.createElement('div');
    header.className = 'insights-header';

    try {
      const summary = document.createElement('div');
      summary.className = 'insights-summary';

      if (insights.pages.length === 1) {
        const page = insights.pages[0];
        const strong = document.createElement('strong');
        strong.textContent = page?.name || 'Page';
        summary.appendChild(strong);
        summary.appendChild(document.createTextNode(`: ${(insights.totalCells || 0).toLocaleString()} cells`));
      } else {
        const strong = document.createElement('strong');
        strong.textContent = `${insights.pages.length} pages`;
        summary.appendChild(strong);
        summary.appendChild(document.createTextNode(`: ${(insights.totalCells || 0).toLocaleString()} cells total`));

        const pageNames = insights.pages.map(p => p?.name || '').join(', ');
        const pageList = document.createElement('div');
        pageList.className = 'insights-page-list';
        pageList.title = pageNames;
        pageList.textContent = pageNames;
        summary.appendChild(pageList);
      }

      header.appendChild(summary);
      this._contentContainer.appendChild(header);
    } catch (err) {
      debugWarn('QuickInsights', 'Error rendering header:', err);
    }

    try {
      this._renderStandardInsights(insights);
    } catch (err) {
      console.error('[QuickInsights] Error rendering insights content:', err);
    }
  }

  /**
   * Render insights with aggregated stats
   */
  _renderStandardInsights(insights) {
    if (!this._contentContainer) return;

    // Safety check for insights object
    if (!insights || !insights.pages) {
      debugWarn('QuickInsights', 'Invalid insights for standard render');
      return;
    }

    const catItems = this._getObsVariableItems('categorical_obs');
    const contItems = this._getObsVariableItems('continuous_obs');

    // =========================================================================
    // COMPOSITION (categorical obs)
    // =========================================================================
    const catSection = document.createElement('div');
    catSection.className = 'insights-section';

    const catTitle = document.createElement('div');
    catTitle.className = 'insights-section-title';

    const catPicker = createMultiSelectDropdown({
      id: `${this._uiId}-composition-fields`,
      buttonLabel: 'Choose composition fields',
      title: 'Composition fields',
      items: catItems,
      selectedKeys: this._selectedCategoricalObsKeys,
      maxListHeight: 240,
      onApply: (keys) => {
        this._applyCategoricalSelection(keys);
        this._cache.clear();
        this.updateForSelectedPages();
      }
    });
    this._fieldPickers.categorical = catPicker;
    catTitle.appendChild(catPicker.element);

    const catTitleText = document.createElement('span');
    catTitleText.className = 'insights-section-title-text';
    catTitleText.textContent = 'Composition';
    catTitle.appendChild(catTitleText);

    catSection.appendChild(catTitle);

    if (!insights.categoricalSummaries || insights.categoricalSummaries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'insights-section-empty';
      empty.textContent =
        this._selectedCategoricalObsKeys.length === 0
          ? 'No composition fields selected.'
          : 'No composition data available.';
      catSection.appendChild(empty);
    } else {
      for (const summary of insights.categoricalSummaries) {
        const fieldDiv = document.createElement('div');
        fieldDiv.className = 'insights-field';

        const fieldHeader = document.createElement('div');
        fieldHeader.className = 'insights-field-header';
        fieldHeader.textContent = summary.field;
        fieldDiv.appendChild(fieldHeader);

        const pageRow = document.createElement('div');
        pageRow.className = 'insights-page-row';

        const barContainer = document.createElement('div');
        barContainer.className = 'insights-bar-container';

        // Create stacked bar
        let cumPercent = 0;
        for (const cat of summary.topCategories) {
          const segment = document.createElement('div');
          segment.className = 'insights-bar-segment';
          segment.style.width = `${cat.percent}%`;
          segment.style.left = `${cumPercent}%`;
          segment.title = `${cat.name}: ${cat.percent}%`;
          cumPercent += parseFloat(cat.percent);
          barContainer.appendChild(segment);
        }

        pageRow.appendChild(barContainer);

        // Show top 3 category labels
        const labels = document.createElement('div');
        labels.className = 'insights-category-labels';
        for (const c of summary.topCategories.slice(0, 3)) {
          const span = document.createElement('span');
          span.className = 'cat-label';
          span.textContent = `${c.name} ${c.percent}%`;
          labels.appendChild(span);
        }
        pageRow.appendChild(labels);

        fieldDiv.appendChild(pageRow);
        catSection.appendChild(fieldDiv);
      }
    }

    this._contentContainer.appendChild(catSection);

    // =========================================================================
    // STATISTICS (continuous obs)
    // =========================================================================
    const contSection = document.createElement('div');
    contSection.className = 'insights-section';

    const contTitle = document.createElement('div');
    contTitle.className = 'insights-section-title';

    const contPicker = createMultiSelectDropdown({
      id: `${this._uiId}-statistics-fields`,
      buttonLabel: 'Choose statistics fields',
      title: 'Statistics fields',
      items: contItems,
      selectedKeys: this._selectedContinuousObsKeys,
      maxListHeight: 240,
      onApply: (keys) => {
        this._applyContinuousSelection(keys);
        this._cache.clear();
        this.updateForSelectedPages();
      }
    });
    this._fieldPickers.continuous = contPicker;
    contTitle.appendChild(contPicker.element);

    const contTitleText = document.createElement('span');
    contTitleText.className = 'insights-section-title-text';
    contTitleText.textContent = 'Statistics';
    contTitle.appendChild(contTitleText);

    contSection.appendChild(contTitle);

    if (!insights.continuousSummaries || insights.continuousSummaries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'insights-section-empty';
      empty.textContent =
        this._selectedContinuousObsKeys.length === 0
          ? 'No statistics fields selected.'
          : 'No statistics data available.';
      contSection.appendChild(empty);
    } else {
      const table = document.createElement('table');
      table.className = 'insights-stats-table';

      const thead = document.createElement('thead');
      thead.innerHTML = `
        <tr>
          <th>Field</th>
          <th>Mean</th>
          <th>Median</th>
          <th>Std</th>
        </tr>
      `;
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      for (const summary of insights.continuousSummaries) {
        const row = document.createElement('tr');

        const fieldCell = document.createElement('td');
        fieldCell.textContent = String(summary?.field ?? '');
        row.appendChild(fieldCell);

        const meanCell = document.createElement('td');
        meanCell.textContent = Number.isFinite(summary?.mean) ? summary.mean.toFixed(2) : 'N/A';
        row.appendChild(meanCell);

        const medianCell = document.createElement('td');
        medianCell.textContent = Number.isFinite(summary?.median) ? summary.median.toFixed(2) : 'N/A';
        row.appendChild(medianCell);

        const stdCell = document.createElement('td');
        stdCell.textContent = Number.isFinite(summary?.std) ? summary.std.toFixed(2) : 'N/A';
        row.appendChild(stdCell);

        tbody.appendChild(row);
      }
      table.appendChild(tbody);

      contSection.appendChild(table);
    }

    this._contentContainer.appendChild(contSection);
  }

  /**
   * Render the collapsible page selector section at the bottom of the panel.
   * @private
   */
  _renderPageSelectorSection() {
    if (!this._container) return;

    // Cleanup previous page selector
    this._destroyPageSelector();

    // Note: We render the section even when there are no pages,
    // because the Dynamic tab should always be available and pages may be added later.

    // Create collapsible section container
    const section = document.createElement('div');
    section.className = 'insights-section insights-page-selector-section';

    // Create collapsible header
    const header = document.createElement('div');
    header.className = 'insights-collapsible-header';

    const toggleIcon = document.createElement('span');
    toggleIcon.className = 'insights-collapsible-toggle';
    toggleIcon.textContent = this._pageSelectorExpanded ? '▼' : '▶';

    const headerText = document.createElement('span');
    headerText.className = 'insights-collapsible-title';
    headerText.textContent = 'Page Selection';

    // Show current mode indicator
    const modeIndicator = document.createElement('span');
    modeIndicator.className = 'insights-page-mode-indicator';
    if (this._pageMode === PAGE_MODE.DYNAMIC) {
      modeIndicator.textContent = '(Dynamic)';
    } else {
      const selectedCount = this._manuallySelectedPages.length;
      modeIndicator.textContent = selectedCount === 1
        ? `(${this._getPageName(this._manuallySelectedPages[0])})`
        : `(${selectedCount} pages)`;
    }

    header.appendChild(toggleIcon);
    header.appendChild(headerText);
    header.appendChild(modeIndicator);

    // Create content container
    const content = document.createElement('div');
    content.className = 'insights-collapsible-content';

    // The caret is decoration: it repeats what aria-expanded already carries,
    // and reading "▶ Page Selection" aloud helps nobody.
    const announce = createDisclosureHeader({
      header,
      content,
      expanded: this._pageSelectorExpanded,
      glyph: toggleIcon,
      contentId: `${this._controlScope}-page-selection`
    });

    // Toggle handler
    const toggleContent = () => {
      this._pageSelectorExpanded = !this._pageSelectorExpanded;
      toggleIcon.textContent = this._pageSelectorExpanded ? '▼' : '▶';
      announce(this._pageSelectorExpanded);
    };

    header.addEventListener('click', toggleContent);

    section.appendChild(header);
    section.appendChild(content);

    // Create page selector container inside content
    this._pageSelectorContainer = document.createElement('div');
    this._pageSelectorContainer.className = 'insights-page-selector-container';
    content.appendChild(this._pageSelectorContainer);

    // Initialize the shared PageSelectorComponent with Dynamic mode
    this._initPageSelectorComponent();

    this._container.appendChild(section);
  }

  /**
   * Initialize the PageSelectorComponent with Dynamic mode support
   * Uses the shared component for DRY code with Detailed/Correlation modes
   * @private
   */
  _initPageSelectorComponent() {
    if (!this._pageSelectorContainer) return;

    // Destroy previous page selector instance (but keep the container reference)
    if (this._pageSelector) {
      this._pageSelector.destroy();
      this._pageSelector = null;
    }

    // Create the shared PageSelectorComponent with Dynamic mode enabled
    this._pageSelector = new PageSelectorComponent({
      dataLayer: this.dataLayer,
      container: this._pageSelectorContainer,

      // Enable Dynamic mode (unique to Quick Insights)
      supportsDynamicMode: true,
      initialDynamicMode: this._pageMode === PAGE_MODE.DYNAMIC,
      dynamicLabel: 'Dynamic',
      dynamicHelpText: 'Follows the active highlight page',

      // Multi-select support
      allowMultiSelect: true,

      // Initial selection (for manual mode)
      initialSelection: this._manuallySelectedPages,

      // UI options
      showColorPicker: true,
      showCellCounts: true,
      showSelectAll: true,
      showHeader: false,   // Collapsible header already provides title/mode
      showHelpText: false, // Avoid duplicate explanation text inside collapsible
      label: '',

      // Use dataLayer's cell count function for proper wildcard handling
      getCellCountForPageId: (pageId) => this.dataLayer.getCellCountForPageId?.(pageId) || 0,

      // Callbacks
      onSelectionChange: this._handlePageChange,
      onModeChange: this._handleModeChange.bind(this),
      onColorChange: this._handlePageColorChange
    });
  }

  /**
   * Get page name by ID
   * @param {string} pageId - Page ID
   * @returns {string} Page name or ID
   * @private
   */
  _getPageName(pageId) {
    const pages = this.dataLayer.getPages();
    if (!Array.isArray(pages)) {
      throw new TypeError('Quick Insights pages must be an array');
    }
    const page = pages.find(candidate => candidate.id === pageId);
    if (!page) {
      throw new Error(`Quick Insights page not found: ${pageId}`);
    }
    if (typeof page.name !== 'string' || page.name.length === 0) {
      throw new TypeError(`Quick Insights page "${pageId}" requires a name`);
    }
    return page.name;
  }

  /**
   * Clear cache
   */
  clearCache() {
    this._cache.clear();
  }

  exportSettings() {
    const base = super.exportSettings();
    if (!this._pageSelector) {
      throw new Error('Quick Insights settings require an initialized page selector');
    }
    const pageSelectorState = this._pageSelector.exportState();
    if (
      typeof this._hasUserSelectedCategoricalObsFields !== 'boolean' ||
      typeof this._hasUserSelectedContinuousObsFields !== 'boolean'
    ) {
      throw new TypeError(
        'Quick Insights field selection flags must be booleans'
      );
    }

    return {
      ...base,
      selectedCategoricalObsKeys: [...this._selectedCategoricalObsKeys],
      selectedContinuousObsKeys: [...this._selectedContinuousObsKeys],
      hasUserSelectedCategoricalObsFields:
        this._hasUserSelectedCategoricalObsFields,
      hasUserSelectedContinuousObsFields:
        this._hasUserSelectedContinuousObsFields,
      // Page selection persistence (using component state format)
      pageSelectorState
    };
  }

  importSettings(settings) {
    this._requireExactSettingsKeys(
      settings,
      [
        'config',
        'hasUserSelectedCategoricalObsFields',
        'hasUserSelectedContinuousObsFields',
        'pageSelectorState',
        'selectedCategoricalObsKeys',
        'selectedContinuousObsKeys',
        'selectedPages'
      ],
      'Quick Insights settings'
    );
    const base = this._requireBaseSettings(settings);
    if (
      typeof settings.hasUserSelectedCategoricalObsFields !== 'boolean' ||
      typeof settings.hasUserSelectedContinuousObsFields !== 'boolean'
    ) {
      throw new TypeError('Quick Insights field selection flags must be booleans');
    }

    const categoricalVariables = this.dataLayer.getAvailableVariables('categorical_obs');
    const continuousVariables = this.dataLayer.getAvailableVariables('continuous_obs');
    if (!Array.isArray(categoricalVariables) || !Array.isArray(continuousVariables)) {
      throw new TypeError('Quick Insights observation variable inventories must be arrays');
    }
    const categoricalKeys = this._requireSelectedKeys(
      settings.selectedCategoricalObsKeys,
      categoricalVariables.map(variable => variable.key),
      'Categorical observation'
    );
    const continuousKeys = this._requireSelectedKeys(
      settings.selectedContinuousObsKeys,
      continuousVariables.map(variable => variable.key),
      'Continuous observation'
    );

    const state = settings.pageSelectorState;
    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
      throw new TypeError('Quick Insights pageSelectorState must be an object');
    }
    const stateKeys = Object.keys(state).sort();
    const expectedStateKeys = ['customColors', 'mode', 'selectedPages'];
    if (
      stateKeys.length !== expectedStateKeys.length ||
      stateKeys.some((key, index) => key !== expectedStateKeys[index])
    ) {
      throw new TypeError(
        'Quick Insights pageSelectorState must contain exactly: ' +
        expectedStateKeys.join(', ')
      );
    }
    if (state.mode !== PAGE_MODE.DYNAMIC && state.mode !== PAGE_MODE.MANUAL) {
      throw new TypeError('Quick Insights page selector mode must be dynamic or manual');
    }
    if (!Array.isArray(state.selectedPages)) {
      throw new TypeError('Quick Insights selected pages must be an array');
    }
    if (!Array.isArray(state.customColors)) {
      throw new TypeError('Quick Insights custom colors must be an array');
    }

    const pages = this.dataLayer.getPages();
    if (!Array.isArray(pages)) {
      throw new TypeError('Quick Insights pages must be an array');
    }
    const availablePageIds = new Set(pages.map(page => page.id));
    const selectedPages = [];
    const seenPageIds = new Set();
    for (const pageId of state.selectedPages) {
      if (typeof pageId !== 'string' || pageId.length === 0) {
        throw new TypeError('Quick Insights page IDs must be non-empty strings');
      }
      if (!availablePageIds.has(pageId)) {
        throw new Error(`Quick Insights page not found: ${pageId}`);
      }
      if (this.dataLayer.getCellCountForPageId(pageId) === 0) {
        throw new RangeError(
          `Quick Insights page "${pageId}" has zero cells and cannot be selected`
        );
      }
      if (seenPageIds.has(pageId)) {
        throw new Error(`Quick Insights page "${pageId}" is selected more than once`);
      }
      seenPageIds.add(pageId);
      selectedPages.push(pageId);
    }

    const customColors = [];
    const seenColorPageIds = new Set();
    for (const entry of state.customColors) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        entry[0].length === 0 ||
        typeof entry[1] !== 'string' ||
        !/^#[0-9a-fA-F]{6}$/.test(entry[1])
      ) {
        throw new TypeError(
          'Quick Insights custom colors must contain [pageId, color] string pairs'
        );
      }
      const [pageId, color] = entry;
      if (!availablePageIds.has(pageId)) {
        throw new Error(`Quick Insights color page not found: ${pageId}`);
      }
      if (seenColorPageIds.has(pageId)) {
        throw new Error(`Quick Insights page "${pageId}" has more than one custom color`);
      }
      seenColorPageIds.add(pageId);
      customColors.push([pageId, color]);
    }
    if (state.mode === PAGE_MODE.DYNAMIC && selectedPages.length !== 0) {
      throw new TypeError(
        'Quick Insights dynamic mode must not contain manually selected pages'
      );
    }
    if (state.mode === PAGE_MODE.MANUAL && selectedPages.length === 0) {
      throw new TypeError(
        'Quick Insights manual mode requires at least one selected page'
      );
    }

    if (!this._pageSelector) {
      throw new Error('Quick Insights settings require an initialized page selector');
    }

    this._applyBaseSettings(base);
    this._selectedCategoricalObsKeys = categoricalKeys;
    this._selectedContinuousObsKeys = continuousKeys;
    this._hasUserSelectedCategoricalObsFields =
      settings.hasUserSelectedCategoricalObsFields;
    this._hasUserSelectedContinuousObsFields =
      settings.hasUserSelectedContinuousObsFields;
    this._pageMode = state.mode;
    this._manuallySelectedPages = [...selectedPages];
    this._pageSelector.importState({
      mode: state.mode,
      selectedPages,
      customColors
    });
  }

  /**
   * Destroy and cleanup
   * @override
   */
  destroy() {
    if (this._destroyPromise != null) return this._destroyPromise;
    this._isDestroyed = true;
    const errors = [];
    const run = operation => {
      try {
        operation();
      } catch (error) {
        errors.push(error);
      }
    };
    run(() => this._beginUpdateIntent());

    // Clear cache
    run(() => this._cache.clear());

    run(() => this._destroyFieldPickers());
    run(() => this._destroyPageSelector());

    // Remove floating window toggle listener
    if (this._detailsToggleListener) {
      run(() => {
        const floatingDetails = this._container?.closest(
          'details.analysis-window-panel'
        );
        if (floatingDetails) {
          floatingDetails.removeEventListener(
            'toggle',
            this._detailsToggleListener
          );
        }
      });
      this._detailsToggleListener = null;
    }

    const parentTask = super.destroy();
    if (errors.length === 0) {
      this._destroyPromise = parentTask;
      return parentTask;
    }
    const destruction = Promise.resolve(parentTask).then(
      () => {
        if (errors.length === 1) throw errors[0];
        throw new AggregateError(errors, 'Quick Insights cleanup failed');
      },
      parentError => {
        throw new AggregateError(
          [...errors, parentError],
          'Quick Insights cleanup failed'
        );
      }
    );
    this._destroyPromise = destruction;
    void destruction.catch(() => {});
    return destruction;
  }
}

/**
 * Create a Quick Insights instance
 */
export function createQuickInsights(options) {
  const insights = new QuickInsights(options);
  insights.init();
  return insights;
}

export default QuickInsights;
