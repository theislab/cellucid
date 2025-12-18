/**
 * Quick Insights Module
 *
 * Provides immediate, automatic analysis for the active highlight page.
 * Designed for a fast "single-page" experience:
 * - Auto-generates insights without requiring configuration
 * - Shows key statistics and distributions for the active page
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

import { createMultiSelectDropdown } from '../components/multi-select-dropdown.js';

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
      maxPages: 1,
      description: 'Uses the active highlight page'
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
    // Note: _cache reserved for future optimization (caching field statistics)
    // Currently cleared on page/highlight changes to ensure fresh computation
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
   * Resolve the active highlight page ID.
   * Falls back to the first available highlight page if the state's active ID is missing/invalid.
   * @returns {string|null}
   * @private
   */
  _getActivePageId() {
    let pages;
    try {
      pages = this.dataLayer.getPages();
    } catch {
      return null;
    }

    if (!Array.isArray(pages) || pages.length === 0) return null;

    const state = this.dataLayer?.state;
    const activeId = state?.getActivePageId?.() ?? state?.activePageId ?? null;
    if (activeId && pages.some(p => p.id === activeId)) return activeId;

    return pages[0]?.id ?? null;
  }

  /**
   * Handle page selection change (implements BaseAnalysisUI pattern)
   * Uses debouncing to prevent rapid successive calls from causing issues
   */
  onPageSelectionChange() {
    const activePageId = this._getActivePageId();
    this._selectedPages = activePageId ? [activePageId] : [];
    this._currentConfig.pages = this._selectedPages;

    // Clear cache when pages change (data may be stale)
    this._cache.clear();

    // Cancel any pending computation immediately
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }

    // Clear any pending debounce timer
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    // If no valid pages, render empty immediately
    if (this._selectedPages.length === 0) {
      this._renderEmpty();
      return;
    }

    // Debounce rapid page changes (e.g., during bulk add/remove)
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this.updateForActivePage();
    }, 150); // 150ms debounce
  }

  /**
   * Handle highlight changes (cells added/removed from pages)
   * Override base class to properly trigger update for QuickInsights
   * @override
   */
  onHighlightChanged() {
    const activePageId = this._getActivePageId();
    this._selectedPages = activePageId ? [activePageId] : [];
    this._currentConfig.pages = this._selectedPages;

    // Clear cache when cell counts change
    this._cache.clear();

    // Cancel any pending computation immediately to prevent stale renders
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }

    // Trigger update if we have pages
    if (this._selectedPages.length > 0) {
      // Use debouncing to prevent rapid successive updates
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
      }
      this._debounceTimer = setTimeout(() => {
        this._debounceTimer = null;
        this.updateForActivePage();
      }, 200); // Slightly longer debounce for highlight changes
    } else {
      // No valid pages, render empty state
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }
      this._renderEmpty();
    }
  }

  /**
   * Update insights for the active highlight page
   */
  async updateForActivePage() {
    // Cancel any pending computation FIRST
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }

    // Increment request ID to track this specific request
    this._currentRequestId++;
    const requestId = this._currentRequestId;

    const activePageId = this._getActivePageId();
    const filteredPageIds = activePageId ? [activePageId] : [];

    // Update internal state with validated page IDs
    this._selectedPages = filteredPageIds;
    this._currentConfig.pages = this._selectedPages;

    if (filteredPageIds.length === 0) {
      this._renderEmpty();
      return;
    }

    // Create new abort controller for this request
    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    this._renderLoading();

    try {
      const insights = await this._computeInsights(activePageId, signal);

      // Check if this request is still current (prevents stale renders)
      if (requestId !== this._currentRequestId) {
        console.debug('[QuickInsights] Discarding stale result for request', requestId);
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
        console.debug('[QuickInsights] Pages removed during computation, re-rendering empty');
        this._renderEmpty();
        return;
      }

      // Update insights with only valid pages
      insights.pages = stillValidPages;
      insights.totalCells = stillValidPages.reduce((sum, p) => sum + (p.cellCount || 0), 0);

      // Sync internal state with validated pages
      this._selectedPages = stillValidPages.map(p => p.id);
      this._currentConfig.pages = this._selectedPages;

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
    if (!this._container) return;
    this._destroyFieldPickers();
    this._container.innerHTML = `
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
    if (!this._container) return;
    this._destroyFieldPickers();
    this._container.innerHTML = `
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
    if (!this._container) return;
    this._destroyFieldPickers();
    // Escape message to prevent XSS
    const escapedMessage = this._escapeHtml(message || 'Unknown error');
    this._container.innerHTML = `
      <div class="quick-insights-error">
        <span>Failed to compute insights: ${escapedMessage}</span>
      </div>
    `;
  }

  /**
   * Compute insights for the active highlight page
   * Uses intelligent field selection based on entropy/variance/missingness
   * @param {string|null} pageId - Active page ID to analyze
   * @param {AbortSignal} [signal] - Abort signal for cancellation
   */
  async _computeInsights(pageId, signal) {
    const insights = {
      pages: [],
      totalCells: 0,
      categoricalSummaries: [],
      continuousSummaries: [],
      fieldSelectionMethod: 'intelligent' // Track how fields were selected
    };

    if (!pageId) return insights;

    // Check abort before processing the page
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Get page info - only include page that exists and has cells
    const allPages = this.dataLayer.getPages();
    const page = allPages.find(p => p.id === pageId);
    if (!page) {
      console.debug(`[QuickInsights] Active page not found: ${pageId}`);
      return insights;
    }

    const cellIndices = this.dataLayer.getCellIndicesForPage(pageId);
    if (!cellIndices || cellIndices.length === 0) {
      console.debug(`[QuickInsights] Active page is empty: ${pageId}`);
      return insights;
    }

    const validPageIds = [pageId];

    insights.pages.push({
      id: pageId,
      name: page.name,
      cellCount: cellIndices.length,
      groupCount: page.highlightedGroups?.length || 0
    });
    insights.totalCells = cellIndices.length;

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

    // Bulk load selected obs fields for the active page
    let bulkData;
    try {
      bulkData = await this.dataLayer.fetchBulkObsFields({
        pageIds: validPageIds,
        obsFields
      });
    } catch (err) {
      console.warn('[QuickInsights] Failed to fetch bulk obs fields:', err);
      return insights;
    }

    // Check abort after bulk load
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    if (!bulkData || !bulkData.fields || !bulkData.pageData) {
      console.warn('[QuickInsights] Invalid bulk data structure');
      return insights;
    }

    const pageInfo = bulkData.pageData[pageId];
    const pageName = pageInfo?.name || page.name || pageId;

    // Categorical summaries (manual order)
    for (const fieldKey of selectedCatKeys) {
      const fieldData = bulkData.fields[fieldKey];
      const pd = fieldData?.[pageId];
      const cellCount = pd?.cellCount || 0;
      if (!pd || cellCount <= 0) continue;

      const pageData = [{
        pageId,
        pageName,
        values: Array.from(pd.values || []),
        cellCount
      }];

      insights.categoricalSummaries.push(this._summarizeCategorical(fieldKey, pageData));
    }

    // Continuous summaries (manual order)
    for (const fieldKey of selectedContKeys) {
      const fieldData = bulkData.fields[fieldKey];
      const pd = fieldData?.[pageId];
      const cellCount = pd?.cellCount || 0;
      if (!pd || cellCount <= 0) continue;

      const pageData = [{
        pageId,
        pageName,
        values: Array.from(pd.values || []),
        cellCount
      }];

      insights.continuousSummaries.push(this._summarizeContinuous(fieldKey, pageData));
    }

    return insights;
  }

  /**
   * Summarize categorical data across pages
   */
  _summarizeCategorical(fieldName, pageData) {
    const summary = {
      field: fieldName,
      pages: []
    };

    for (const pd of pageData) {
      // Count categories
      const counts = new Map();
      for (const val of pd.values) {
        counts.set(val, (counts.get(val) || 0) + 1);
      }

      // Get top 5 categories
      const sorted = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      const total = pd.values.length;
      summary.pages.push({
        pageId: pd.pageId,
        pageName: pd.pageName,
        total,
        topCategories: sorted.map(([cat, count]) => ({
          name: cat,
          count,
          percent: total > 0 ? (count / total * 100).toFixed(1) : '0'
        }))
      });
    }

    return summary;
  }

  /**
   * Summarize continuous data across pages
   * Uses streaming stats for huge pages to avoid full sorting
   */
  _summarizeContinuous(fieldName, pageData) {
    const summary = {
      field: fieldName,
      pages: []
    };

    for (const pd of pageData) {
      // Use streaming stats for large pages (> 50k cells) to avoid expensive full sort
      const stats = computeStreamingStats(pd.values, 50000);

      if (stats.count === 0) {
        summary.pages.push({
          pageId: pd.pageId,
          pageName: pd.pageName,
          count: 0,
          mean: null,
          median: null
        });
        continue;
      }

      summary.pages.push({
        pageId: pd.pageId,
        pageName: pd.pageName,
        count: stats.count,
        mean: stats.mean,
        median: stats.median,
        min: stats.min,
        max: stats.max,
        std: stats.std,
        q1: stats.q1,
        q3: stats.q3,
        approximate: stats.approximate
      });
    }

    return summary;
  }

  /**
   * Render initial state
   */
  _render() {
    if (!this._container) return;
    // Use classList.add to preserve original classes (e.g., analysis-accordion-content)
    this._container.classList.add('quick-insights-panel');
    this._renderEmpty();
  }

  /**
   * Render computed insights
   */
  _renderInsights(insights) {
    if (!this._container) return;

    // Validate insights object
    if (!insights || !Array.isArray(insights.pages)) {
      console.warn('[QuickInsights] Invalid insights object');
      this._renderEmpty();
      return;
    }

    // Handle empty pages gracefully
    if (insights.pages.length === 0) {
      this._renderEmpty();
      return;
    }

    // Final safety check - verify container still exists (could be destroyed during async)
    if (!this._container || !this._container.parentNode) {
      console.debug('[QuickInsights] Container no longer in DOM, skipping render');
      return;
    }

    this._destroyFieldPickers();
    this._container.innerHTML = '';

    // Page summary header
    const header = document.createElement('div');
    header.className = 'insights-header';

    try {
      const page = insights.pages[0];
      header.innerHTML = `
        <div class="insights-summary">
          <strong>${this._escapeHtml(page?.name || 'Page')}</strong>: ${(insights.totalCells || 0).toLocaleString()} cells
        </div>
      `;
      this._container.appendChild(header);
    } catch (err) {
      console.warn('[QuickInsights] Error rendering header:', err);
    }

    try {
      this._renderStandardInsights(insights);
    } catch (err) {
      console.error('[QuickInsights] Error rendering insights content:', err);
      // Don't crash - just show what we have
    }

  }

  /**
   * Escape HTML to prevent XSS
   * @private
   */
  _escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Render insights (single-page)
   */
  _renderStandardInsights(insights) {
    if (!this._container) return;

    // Safety check for insights object
    if (!insights || !insights.pages) {
      console.warn('[QuickInsights] Invalid insights for standard render');
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
          : 'No composition data available for this page.';
      catSection.appendChild(empty);
    } else {
      for (const summary of insights.categoricalSummaries) {
        const fieldDiv = document.createElement('div');
        fieldDiv.className = 'insights-field';

        const fieldHeader = document.createElement('div');
        fieldHeader.className = 'insights-field-header';
        fieldHeader.textContent = summary.field;
        fieldDiv.appendChild(fieldHeader);

        // Single active page
        for (const page of summary.pages) {
          const pageRow = document.createElement('div');
          pageRow.className = 'insights-page-row';

          const barContainer = document.createElement('div');
          barContainer.className = 'insights-bar-container';

          // Create stacked bar
          let cumPercent = 0;
          for (const cat of page.topCategories) {
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
          labels.innerHTML = page.topCategories.slice(0, 3)
            .map(c => `<span class="cat-label">${c.name} ${c.percent}%</span>`)
            .join('');
          pageRow.appendChild(labels);

          fieldDiv.appendChild(pageRow);
        }

        catSection.appendChild(fieldDiv);
      }
    }

    this._container.appendChild(catSection);

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
          : 'No statistics data available for this page.';
      contSection.appendChild(empty);
    } else {
      const table = document.createElement('table');
      table.className = 'insights-stats-table';

      const thead = document.createElement('thead');
      thead.innerHTML = `
        <tr>
          <th>Field</th>
          <th>Value</th>
        </tr>
      `;
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      for (const summary of insights.continuousSummaries) {
        const row = document.createElement('tr');
        const value = summary.pages?.[0]?.mean;
        row.innerHTML = `
          <td>${summary.field}</td>
          <td>${value !== null && value !== undefined ? value.toFixed(2) : 'N/A'}</td>
        `;
        tbody.appendChild(row);
      }
      table.appendChild(tbody);

      contSection.appendChild(table);
    }

    this._container.appendChild(contSection);
  }

  /**
   * Clear cache
   */
  clearCache() {
    this._cache.clear();
  }

  /**
   * Destroy and cleanup
   * @override
   */
  destroy() {
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
