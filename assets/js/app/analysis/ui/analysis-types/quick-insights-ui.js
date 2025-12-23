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
 * - Uses streaming/approximate statistics for huge pages (avoids full sort)
 * - Intelligent field selection based on entropy/variance/missingness
 * - Caches computed metrics for recently accessed fields
 *
 * Extends BaseAnalysisUI for consistent lifecycle and shared utilities.
 */

import { BaseAnalysisUI } from '../base-analysis-ui.js';

// Import statistical functions from centralized module
import {
  computeStreamingStats
} from '../../stats/quick-stats.js';

// Import debug utilities for production-safe logging
import { debug, debugWarn } from '../../shared/debug-utils.js';

import { createMultiSelectDropdown } from '../components/multi-select-dropdown.js';
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
    // Update internal state from the component
    if (this._pageSelector) {
      this._pageMode = this._pageSelector.isDynamicMode() ? PAGE_MODE.DYNAMIC : PAGE_MODE.MANUAL;
      this._manuallySelectedPages = this._pageSelector.getSelectedPages();
    } else {
      // Fallback for direct calls (shouldn't happen with component)
      if (pageIds.includes(PAGE_MODE.DYNAMIC)) {
        this._pageMode = PAGE_MODE.DYNAMIC;
        this._manuallySelectedPages = [];
      } else {
        this._pageMode = PAGE_MODE.MANUAL;
        this._manuallySelectedPages = pageIds || [];
      }
    }

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
   * Trigger debounced update
   * @private
   */
  _triggerUpdate() {
    // Cancel any pending computation
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }

    // Clear any pending debounce timer
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    const pageIds = this._getEffectivePageIds();
    if (pageIds.length === 0) {
      this._renderEmpty();
      return;
    }

    // Debounce rapid changes
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this.updateForSelectedPages();
    }, 150);
  }

  /**
   * @param {string[]} selectedKeys
   * @param {string[]} availableKeys
   * @returns {string[]} Sanitized selection (deduped, preserves order)
   * @private
   */
  _sanitizeSelectedKeys(selectedKeys, availableKeys) {
    const available = new Set(availableKeys);
    const out = [];
    const seen = new Set();

    for (const key of (selectedKeys || [])) {
      if (!available.has(key)) continue;
      if (seen.has(key)) continue;
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
    const availableKeys = (this.dataLayer.getAvailableVariables('categorical_obs') || []).map(v => v.key);
    this._selectedCategoricalObsKeys = this._sanitizeSelectedKeys(nextKeys, availableKeys);
    this._hasUserSelectedCategoricalObsFields = true;
  }

  /**
   * Apply and persist the selected continuous obs fields.
   * @param {string[]} nextKeys
   * @private
   */
  _applyContinuousSelection(nextKeys) {
    const availableKeys = (this.dataLayer.getAvailableVariables('continuous_obs') || []).map(v => v.key);
    this._selectedContinuousObsKeys = this._sanitizeSelectedKeys(nextKeys, availableKeys);
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
  }

  /**
   * Render controls - QuickInsights auto-renders, so this is a no-op
   * @override
   */
  _renderControls() {
    // QuickInsights doesn't have traditional controls - it auto-generates insights
  }

  /**
   * Run analysis - QuickInsights uses updateForActivePage instead
   * @override
   */
  async _runAnalysis() {
    await this.updateForActivePage();
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
   * Update insights for the active highlight page (legacy method name)
   */
  async updateForActivePage() {
    return this.updateForSelectedPages();
  }

  /**
   * Update insights for selected pages (supports multiple pages)
   */
  async updateForSelectedPages() {
    // Cancel any pending computation FIRST
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }

    // Increment request ID to track this specific request
    this._currentRequestId++;
    const requestId = this._currentRequestId;

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
   * Uses intelligent field selection based on entropy/variance/missingness
   * @param {string[]} pageIds - Page IDs to analyze
   * @param {AbortSignal} [signal] - Abort signal for cancellation
   */
  async _computeInsights(pageIds, signal) {
    const insights = {
      pages: [],
      totalCells: 0,
      categoricalSummaries: [],
      continuousSummaries: [],
      fieldSelectionMethod: 'intelligent'
    };

    if (!pageIds || pageIds.length === 0) return insights;

    // Check abort before processing
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Get all pages and filter valid ones with cells
    const allPages = this.dataLayer.getPages();
    const pageMap = new Map(allPages.map(p => [p.id, p]));
    const validPageIds = [];

    for (const pageId of pageIds) {
      const page = pageMap.get(pageId);
      if (!page) {
        debug('QuickInsights', `Page not found: ${pageId}`);
        continue;
      }

      // Use getCellCountForPageId which handles wildcards properly
      const cellCount = this.dataLayer.getCellCountForPageId?.(pageId) || 0;
      if (cellCount === 0) {
        debug('QuickInsights', `Page is empty: ${pageId}`);
        continue;
      }

      validPageIds.push(pageId);
      insights.pages.push({
        id: pageId,
        name: page.name,
        cellCount: cellCount,
        groupCount: page.highlightedGroups?.length || 0
      });
      insights.totalCells += cellCount;
    }

    if (validPageIds.length === 0) return insights;

    // Resolve available variables
    const allCatFields = this.dataLayer.getAvailableVariables('categorical_obs') || [];
    const allContFields = this.dataLayer.getAvailableVariables('continuous_obs') || [];

    const availableCatKeys = allCatFields.map(f => f.key);
    const availableContKeys = allContFields.map(f => f.key);

    // Sanitize persisted selections against currently available fields
    this._selectedCategoricalObsKeys =
      this._sanitizeSelectedKeys(this._selectedCategoricalObsKeys, availableCatKeys);
    this._selectedContinuousObsKeys =
      this._sanitizeSelectedKeys(this._selectedContinuousObsKeys, availableContKeys);

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
    const obsFields = Array.from(new Set([...selectedCatKeys, ...selectedContKeys]));

    if (obsFields.length === 0) {
      return insights;
    }

    // Check abort before starting bulk load
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Bulk load selected obs fields for all selected pages
    let bulkData;
    try {
      bulkData = await this.dataLayer.fetchBulkObsFields({
        pageIds: validPageIds,
        obsFields,
        // QuickInsights only needs aggregated summaries; avoid per-page copies/strings.
        subsetPages: false,
        includeCategoricalValues: false
      });
    } catch (err) {
      debugWarn('QuickInsights', 'Failed to fetch bulk obs fields:', err);
      return insights;
    }

    // Check abort after bulk load
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    if (!bulkData || !bulkData.fields || !bulkData.pageData) {
      debugWarn('QuickInsights', 'Invalid bulk data structure');
      return insights;
    }

    // Aggregate across all selected pages without materializing giant arrays.
    for (const fieldKey of selectedCatKeys) {
      const fieldData = bulkData.fields[fieldKey];
      if (!fieldData) continue;
      const summary = this._summarizeCategoricalAcrossPages(fieldKey, fieldData, validPageIds, bulkData.pageData, signal);
      if (summary) insights.categoricalSummaries.push(summary);
    }

    for (const fieldKey of selectedContKeys) {
      const fieldData = bulkData.fields[fieldKey];
      if (!fieldData) continue;
      const summary = this._summarizeContinuousAcrossPages(fieldKey, fieldData, validPageIds, bulkData.pageData, signal);
      if (summary) insights.continuousSummaries.push(summary);
    }

    return insights;
  }

  /**
   * @param {Uint32Array} counts
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
    const categories = Array.isArray(fieldData?.categories) ? fieldData.categories : null;
    const codes = fieldData?.codes;

    // Fast path: global codes available.
    if (codes && typeof codes.length === 'number') {
      const categoryCount = categories ? categories.length : 0;
      const missingIndex = categoryCount;
      const unknownIndex = categoryCount + 1;
      const counts = categoryCount > 0 && categoryCount <= 65535
        ? new Uint32Array(categoryCount + 2)
        : null;
      const unknownCounts = counts ? null : new Map();

      let total = 0;
      let iter = 0;

      for (const pageId of pageIds) {
        const cellIndices = pageData?.[pageId]?.cellIndices || [];
        for (let i = 0; i < cellIndices.length; i++) {
          const cellIdx = cellIndices[i];
          const code = cellIdx < codes.length ? codes[cellIdx] : 65535;
          total++;

          if (counts) {
            if (code === 65535 || code == null) counts[missingIndex]++;
            else if (code < 0 || code >= categoryCount) counts[unknownIndex]++;
            else counts[code]++;
          } else {
            const key = (code === 65535 || code == null) ? '(missing)' : `Unknown (${code})`;
            unknownCounts.set(key, (unknownCounts.get(key) || 0) + 1);
          }

          // Abort check every ~16k iterations (keeps UI responsive on huge selections).
          if ((++iter & 0x3fff) === 0 && signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
        }
      }

      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (total === 0) return null;

      if (counts) {
        const top = this._topKFromCountsArray(counts, 5);
        return {
          field: fieldName,
          total,
          topCategories: top.map(({ index, count }) => {
            const name = (index === missingIndex)
              ? '(missing)'
              : (index === unknownIndex)
                ? '(unknown)'
                : (categories?.[index] ?? `Unknown (${index})`);
            return {
              name,
              count,
              percent: total > 0 ? ((count / total) * 100).toFixed(1) : '0'
            };
          })
        };
      }

      // No categories array available; fall back to whatever we counted.
      const entries = Array.from(unknownCounts.entries());
      entries.sort((a, b) => b[1] - a[1]);
      return {
        field: fieldName,
        total,
        topCategories: entries.slice(0, 5).map(([name, count]) => ({
          name,
          count,
          percent: total > 0 ? ((count / total) * 100).toFixed(1) : '0'
        }))
      };
    }

    // Fallback: per-page values exist (e.g., sequential loader path).
    const counts = new Map();
    let total = 0;
    let iter = 0;
    for (const pageId of pageIds) {
      const pd = fieldData?.[pageId];
      const values = pd?.values;
      if (!values || typeof values.length !== 'number') continue;
      for (let i = 0; i < values.length; i++) {
        const raw = values[i];
        const name = (raw === null || raw === undefined || raw === '') ? '(missing)' : String(raw);
        counts.set(name, (counts.get(name) || 0) + 1);
        total++;
        if ((++iter & 0x3fff) === 0 && signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
      }
    }

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (total === 0) return null;

    const top = [];
    for (const [name, count] of counts.entries()) {
      let insertAt = top.length;
      for (let i = 0; i < top.length; i++) {
        if (count > top[i].count) {
          insertAt = i;
          break;
        }
      }
      if (insertAt >= 5) continue;
      top.splice(insertAt, 0, { name, count });
      if (top.length > 5) top.length = 5;
    }

    return {
      field: fieldName,
      total,
      topCategories: top.map(({ name, count }) => ({
        name,
        count,
        percent: total > 0 ? ((count / total) * 100).toFixed(1) : '0'
      }))
    };
  }

  /**
   * Summarize continuous data aggregated across all pages.
   * Prefers using the raw field array + page cell indices to avoid per-page copies.
   * @private
   * @param {string} fieldName
   * @param {any} fieldData
   * @param {string[]} pageIds
   * @param {Record<string, { cellIndices: number[] }>} pageData
   * @param {AbortSignal} [signal]
   * @returns {{ field: string, count: number, mean: number|null, median: number|null, min?: number|null, max?: number|null, std?: number|null, q1?: number|null, q3?: number|null, approximate?: boolean } | null}
   */
  _summarizeContinuousAcrossPages(fieldName, fieldData, pageIds, pageData, signal) {
    const rawValues = fieldData?.values;
    const maxExact = 50000;

    if (rawValues && typeof rawValues.length === 'number') {
      // Count total selected cells (upper bound; includes NaNs which will be filtered).
      let totalCells = 0;
      for (const pageId of pageIds) {
        totalCells += (pageData?.[pageId]?.cellIndices?.length || 0);
      }
      if (totalCells === 0) return null;

      // Exact path for small selections (safe to materialize).
      if (totalCells <= maxExact) {
        const merged = [];
        merged.length = 0;
        let iter = 0;
        for (const pageId of pageIds) {
          const cellIndices = pageData?.[pageId]?.cellIndices || [];
          for (let i = 0; i < cellIndices.length; i++) {
            const idx = cellIndices[i];
            const v = idx < rawValues.length ? rawValues[idx] : NaN;
            if (Number.isFinite(v)) merged.push(v);
            if ((++iter & 0x3fff) === 0 && signal?.aborted) {
              throw new DOMException('Aborted', 'AbortError');
            }
          }
        }

        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const stats = computeStreamingStats(merged, maxExact);
        if (stats.count === 0) {
          return { field: fieldName, count: 0, mean: null, median: null };
        }
        return {
          field: fieldName,
          count: stats.count,
          mean: stats.mean,
          median: stats.median,
          min: stats.min,
          max: stats.max,
          std: stats.std,
          q1: stats.q1,
          q3: stats.q3,
          approximate: stats.approximate
        };
      }

      // Streaming path for huge selections (reservoir sampling for quantiles).
      let count = 0;
      let sum = 0;
      let sumSq = 0;
      let min = Infinity;
      let max = -Infinity;

      const reservoirSize = 1000;
      const reservoir = new Float64Array(reservoirSize);
      let reservoirFilled = 0;

      let iter = 0;
      for (const pageId of pageIds) {
        const cellIndices = pageData?.[pageId]?.cellIndices || [];
        for (let i = 0; i < cellIndices.length; i++) {
          const idx = cellIndices[i];
          const v = idx < rawValues.length ? rawValues[idx] : NaN;
          if (!Number.isFinite(v)) continue;

          count++;
          sum += v;
          sumSq += v * v;
          if (v < min) min = v;
          if (v > max) max = v;

          if (reservoirFilled < reservoirSize) {
            reservoir[reservoirFilled++] = v;
          } else {
            const j = Math.floor(Math.random() * count);
            if (j < reservoirSize) reservoir[j] = v;
          }

          if ((++iter & 0x3fff) === 0 && signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
        }
      }

      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      if (count === 0) {
        return { field: fieldName, count: 0, mean: null, median: null };
      }

      const mean = sum / count;
      const variance = (sumSq / count) - (mean * mean);

      const sample = Array.from(reservoir.slice(0, reservoirFilled)).sort((a, b) => a - b);
      const mid = Math.floor(sample.length / 2);
      const median = sample.length % 2 === 0
        ? (sample[mid - 1] + sample[mid]) / 2
        : sample[mid];

      return {
        field: fieldName,
        count,
        mean,
        median,
        min,
        max,
        std: Math.sqrt(Math.max(0, variance)),
        q1: sample[Math.floor(sample.length * 0.25)],
        q3: sample[Math.floor(sample.length * 0.75)],
        approximate: true
      };
    }

    // Fallback: per-page float arrays exist.
    const merged = [];
    let iter = 0;
    for (const pageId of pageIds) {
      const pd = fieldData?.[pageId];
      const values = pd?.values;
      if (!values || typeof values.length !== 'number') continue;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (Number.isFinite(v)) merged.push(v);
        if ((++iter & 0x3fff) === 0 && signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
      }
    }

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (merged.length === 0) return null;

    const stats = computeStreamingStats(merged, maxExact);
    if (stats.count === 0) {
      return { field: fieldName, count: 0, mean: null, median: null };
    }
    return {
      field: fieldName,
      count: stats.count,
      mean: stats.mean,
      median: stats.median,
      min: stats.min,
      max: stats.max,
      std: stats.std,
      q1: stats.q1,
      q3: stats.q3,
      approximate: stats.approximate
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
        this.updateForActivePage();
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
        this.updateForActivePage();
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
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');

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
    content.style.display = this._pageSelectorExpanded ? 'block' : 'none';

    // Toggle handler
    const toggleContent = () => {
      this._pageSelectorExpanded = !this._pageSelectorExpanded;
      toggleIcon.textContent = this._pageSelectorExpanded ? '▼' : '▶';
      content.style.display = this._pageSelectorExpanded ? 'block' : 'none';
    };

    header.addEventListener('click', toggleContent);
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleContent();
      }
    });

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
    try {
      const pages = this.dataLayer.getPages();
      const page = pages.find(p => p.id === pageId);
      return page?.name || pageId;
    } catch {
      return pageId;
    }
  }

  /**
   * Clear cache
   */
  clearCache() {
    this._cache.clear();
  }

  exportSettings() {
    const base = super.exportSettings();

    // Export page selector state using the component's exportState if available
    let pageSelectorState = null;
    if (this._pageSelector) {
      pageSelectorState = this._pageSelector.exportState();
    } else {
      // Fallback if component not initialized
      pageSelectorState = {
        mode: this._pageMode,
        selectedPages: [...this._manuallySelectedPages],
        customColors: []
      };
    }

    return {
      ...base,
      selectedCategoricalObsKeys: [...this._selectedCategoricalObsKeys],
      selectedContinuousObsKeys: [...this._selectedContinuousObsKeys],
      hasUserSelectedCategoricalObsFields: !!this._hasUserSelectedCategoricalObsFields,
      hasUserSelectedContinuousObsFields: !!this._hasUserSelectedContinuousObsFields,
      // Page selection persistence (using component state format)
      pageSelectorState
    };
  }

  importSettings(settings) {
    if (!settings) return;

    const hasCat = !!settings.hasUserSelectedCategoricalObsFields;
    const hasCont = !!settings.hasUserSelectedContinuousObsFields;

    if (hasCat) {
      this._applyCategoricalSelection(Array.isArray(settings.selectedCategoricalObsKeys) ? settings.selectedCategoricalObsKeys : []);
    } else {
      this._selectedCategoricalObsKeys = [];
      this._hasUserSelectedCategoricalObsFields = false;
    }

    if (hasCont) {
      this._applyContinuousSelection(Array.isArray(settings.selectedContinuousObsKeys) ? settings.selectedContinuousObsKeys : []);
    } else {
      this._selectedContinuousObsKeys = [];
      this._hasUserSelectedContinuousObsFields = false;
    }

    // Restore page selection state
    if (settings.pageSelectorState) {
      // New format using component state
      this._pageMode = settings.pageSelectorState.mode === PAGE_MODE.DYNAMIC
        ? PAGE_MODE.DYNAMIC
        : PAGE_MODE.MANUAL;
      this._manuallySelectedPages = Array.isArray(settings.pageSelectorState.selectedPages)
        ? [...settings.pageSelectorState.selectedPages]
        : [];

      // Import into component if initialized
      if (this._pageSelector) {
        this._pageSelector.importState(settings.pageSelectorState);
      }
    } else if (settings.pageMode !== undefined) {
      // Legacy format for backwards compatibility
      if (settings.pageMode === PAGE_MODE.MANUAL || settings.pageMode === PAGE_MODE.DYNAMIC) {
        this._pageMode = settings.pageMode;
      }
      if (Array.isArray(settings.manuallySelectedPages)) {
        this._manuallySelectedPages = [...settings.manuallySelectedPages];
      }
    }

    super.importSettings(settings);
  }

  /**
   * Destroy and cleanup
   * @override
   */
  destroy() {
    this._isDestroyed = true;
    // Cancel any pending debounced update
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    // Abort any pending computation
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }

    // Increment request ID to invalidate any in-flight requests
    this._currentRequestId++;

    // Clear cache
    this._cache.clear();

    this._destroyFieldPickers();
    this._destroyPageSelector();

    // Clear container
    if (this._container) {
      this._container.innerHTML = '';
    }

    super.destroy();
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
