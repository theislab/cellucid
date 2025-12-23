/**
 * PageSelectorComponent - Shared Page Selection Component
 *
 * Provides a reusable multi-select page tabs component with:
 * - Visual page tabs matching highlight module styling
 * - Cell count display per page
 * - Custom color picker per page
 * - Select All/Deselect All actions
 * - Reactive state management
 * - Optional "Dynamic" mode that follows the active highlight page
 *
 * Used by: DetailedAnalysisUI, CorrelationAnalysisUI, QuickInsightsUI, etc.
 *
 * @example
 * // Standard usage (Detailed/Correlation mode)
 * const pageSelector = createPageSelectorComponent({
 *   dataLayer,
 *   container: document.getElementById('page-select'),
 *   onSelectionChange: (pageIds) => console.log('Selected:', pageIds),
 *   onColorChange: (pageId, color) => console.log('Color changed:', pageId, color)
 * });
 *
 * @example
 * // With Dynamic mode support (Quick Insights)
 * const pageSelector = createPageSelectorComponent({
 *   dataLayer,
 *   container: document.getElementById('page-select'),
 *   supportsDynamicMode: true,
 *   initialDynamicMode: true,
 *   onModeChange: (mode, pageIds) => console.log('Mode:', mode, 'Pages:', pageIds),
 *   onSelectionChange: (pageIds) => console.log('Selected:', pageIds)
 * });
 *
 * // Update from external changes
 * pageSelector.refresh();
 *
 * // Cleanup
 * pageSelector.destroy();
 */

import { formatCount } from '../../shared/formatting.js';
import { StyleManager } from '../../../../utils/style-manager.js';
import { expandPagesWithDerived } from '../../shared/page-derivation-utils.js';
import { deriveRestOfColor } from '../../shared/color-utils.js';
import { getPageColor } from '../../core/plugin-contract.js';

/**
 * Page selection mode constants
 * @readonly
 * @enum {string}
 */
export const PAGE_MODE = {
  DYNAMIC: 'dynamic',  // Follow the active highlight page
  MANUAL: 'manual'     // User-selected pages
};

/**
 * PageSelectorComponent Class
 *
 * Encapsulates page selection UI logic for consistent reuse.
 */
export class PageSelectorComponent {
  /**
   * @param {Object} options
   * @param {Object} options.dataLayer - Data layer instance for page info
   * @param {HTMLElement} options.container - Container element to render into
   * @param {Function} [options.onSelectionChange] - Callback when selection changes (receives pageIds array)
   * @param {Function} [options.onColorChange] - Callback when color changes (receives pageId, color)
   * @param {boolean} [options.showColorPicker=true] - Whether to show color picker
   * @param {boolean} [options.showCellCounts=true] - Whether to show cell counts
   * @param {boolean} [options.showSelectAll=true] - Whether to show select all button
   * @param {boolean} [options.showHeader=true] - Whether to show the header row (label + optional mode indicator)
   * @param {boolean} [options.showHelpText=true] - Whether to show the help text under the header
   * @param {string[]} [options.initialSelection] - Initial page IDs to select (for manual mode)
   * @param {string} [options.emptyMessage] - Message when no pages available
   * @param {string} [options.label] - Label text for the selector
   * @param {boolean} [options.includeDerivedPages=false] - Whether to show derived pages (e.g., "Rest of X")
   * @param {Map} [options.customColors] - Map of pageId -> custom color
   * @param {Function} [options.getCellCountForPageId] - Custom cell count function (pageId) => number
   * @param {boolean} [options.supportsDynamicMode=false] - Whether to show the Dynamic option
   * @param {boolean} [options.initialDynamicMode=false] - Whether to start in dynamic mode
   * @param {Function} [options.onModeChange] - Callback when mode changes (receives mode: 'dynamic'|'manual', pageIds: string[])
   * @param {string} [options.dynamicLabel='Dynamic'] - Label for the dynamic tab
   * @param {string} [options.dynamicHelpText] - Help text shown when dynamic mode is enabled
   * @param {boolean} [options.allowMultiSelect=true] - Whether multiple pages can be selected (manual mode only)
   */
  constructor(options) {
    this.dataLayer = options.dataLayer;
    this.container = options.container;
    this.onSelectionChange = options.onSelectionChange;
    this.onColorChange = options.onColorChange;

    // Options with defaults
    this.showColorPicker = options.showColorPicker ?? true;
    this.showCellCounts = options.showCellCounts ?? true;
    this.showSelectAll = options.showSelectAll ?? true;
    this.showHeader = options.showHeader ?? true;
    this.showHelpText = options.showHelpText ?? true;
    this.emptyMessage = options.emptyMessage || 'Create highlight pages first using the Highlighted Cells section above.';
    this.label = options.label ?? 'Compare pages:';
    this.includeDerivedPages = options.includeDerivedPages ?? false;
    this.customColors = options.customColors || new Map();
    this.getCellCountForPageId = options.getCellCountForPageId || null;

    // Dynamic mode options
    this.supportsDynamicMode = options.supportsDynamicMode ?? false;
    this.onModeChange = options.onModeChange || null;
    this.dynamicLabel = options.dynamicLabel ?? 'Dynamic';
    this.dynamicHelpText = options.dynamicHelpText ?? 'Follows the active highlight page';
    this.allowMultiSelect = options.allowMultiSelect ?? true;

    // State
    this._selectedPages = new Set(options.initialSelection || []);
    this._basePages = []; // Store base pages for Select All logic
    this._isDynamicMode = this.supportsDynamicMode && (options.initialDynamicMode ?? true);

    // DOM references
    this._tabsContainer = null;
    this._labelEl = null;
    this._helpEl = null;
    this._dynamicTabEl = null;
    this._modeIndicatorEl = null;

    // Render initial state
    this.render();
  }

  /**
   * Render the complete page selector
   */
  render() {
    if (!this.container) return;

    this.container.innerHTML = '';
    this.container.className = 'control-block analysis-page-selector';

    if (this.showHeader) {
      // Label row with mode indicator
      const labelRow = document.createElement('div');
      labelRow.className = 'analysis-page-selector-header';

      this._labelEl = document.createElement('label');
      this._labelEl.textContent = this.label;
      labelRow.appendChild(this._labelEl);

      // Mode indicator (only for dynamic mode support)
      if (this.supportsDynamicMode) {
        this._modeIndicatorEl = document.createElement('span');
        this._modeIndicatorEl.className = 'analysis-page-mode-indicator';
        this._updateModeIndicator();
        labelRow.appendChild(this._modeIndicatorEl);
      }

      this.container.appendChild(labelRow);
    } else {
      this._labelEl = null;
      this._modeIndicatorEl = null;
    }

    // Get pages from data layer
    const pages = this._getPages();

    if (pages.length === 0 && !this.supportsDynamicMode) {
      this._renderEmpty();
      return;
    }

    // Help text
    this._helpEl = null;
    if (this.showHelpText) {
      if (this.showColorPicker && !this.supportsDynamicMode) {
        this._helpEl = document.createElement('div');
        this._helpEl.className = 'legend-help';
        this._helpEl.textContent = 'Click pages to select. Click color to customize.';
        this.container.appendChild(this._helpEl);
      } else if (this.supportsDynamicMode) {
        this._helpEl = document.createElement('div');
        this._helpEl.className = 'legend-help';
        this._helpEl.textContent = this._isDynamicMode
          ? this.dynamicHelpText
          : (this.showColorPicker
            ? 'Click pages to select. Click color to customize.'
            : 'Click pages to select.');
        this.container.appendChild(this._helpEl);
      }
    }

    // Tabs container
    this._tabsContainer = document.createElement('div');
    this._tabsContainer.className = 'analysis-page-tabs';
    this.container.appendChild(this._tabsContainer);

    // Render page tabs (including Dynamic tab if supported)
    this._renderTabs(pages);
  }

  /**
   * Render empty state when no pages available
   */
  _renderEmpty() {
    const empty = document.createElement('div');
    empty.className = 'legend-help';
    empty.textContent = this.emptyMessage;
    this.container.appendChild(empty);
  }

  /**
   * Render page tabs
   */
  _renderTabs(pages) {
    this._tabsContainer.innerHTML = '';

    // Render Dynamic tab first if supported
    if (this.supportsDynamicMode) {
      const dynamicTab = this._createDynamicTab();
      this._tabsContainer.appendChild(dynamicTab);
    }

    // Render regular page tabs
    pages.forEach((page, index) => {
      const tab = this._createPageTab(page, index);
      this._tabsContainer.appendChild(tab);
    });

    // Select All / Deselect All button (only for manual mode with multi-select)
    if (this.showSelectAll && pages.length > 1 && this.allowMultiSelect && !this._isDynamicMode) {
      this._renderSelectAllButton(pages);
    }
  }

  /**
   * Create the Dynamic tab element
   * @returns {HTMLElement}
   */
  _createDynamicTab() {
    const tab = document.createElement('div');
    tab.className = 'analysis-page-tab insights-dynamic-tab' +
      (this._isDynamicMode ? ' selected' : '');
    tab.dataset.pageId = PAGE_MODE.DYNAMIC;

    // Dynamic icon
    const icon = document.createElement('span');
    icon.className = 'insights-dynamic-icon';
    icon.innerHTML = '⟳'; // Unicode refresh/sync symbol
    tab.appendChild(icon);

    // Dynamic label with active page name
    const nameSpan = document.createElement('span');
    nameSpan.className = 'analysis-page-name';
    if (this._isDynamicMode) {
      const activePageName = this._getActivePageName();
      nameSpan.textContent = activePageName ? `${this.dynamicLabel}: ${activePageName}` : this.dynamicLabel;
    } else {
      nameSpan.textContent = this.dynamicLabel;
    }
    nameSpan.title = this.dynamicHelpText;
    tab.appendChild(nameSpan);

    // Cell count for active page in dynamic mode
    if (this.showCellCounts && this._isDynamicMode) {
      const activePageId = this._getActivePageId();
      if (activePageId) {
        const cellCount = this._getCellCount(activePageId);
        const countSpan = document.createElement('span');
        countSpan.className = 'analysis-page-count';
        countSpan.textContent = cellCount > 0 ? formatCount(cellCount) : '(0)';
        tab.appendChild(countSpan);
      }
    }

    // Click to activate dynamic mode
    tab.addEventListener('click', () => {
      this._setDynamicModeInternal(true);
    });

    this._dynamicTabEl = tab;
    return tab;
  }

  /**
   * Create a single page tab element
   */
  _createPageTab(page, index) {
    const isSelected = !this._isDynamicMode && this._selectedPages.has(page.id);
    const cellCount = this._getCellCount(page.id);
    const derived = page?._derived || null;
    const baseId = derived?.baseId || page.id;

    // Find base page index for default color
    const baseIndex = this._basePages.findIndex(p => p.id === baseId);
    const effectiveIndex = baseIndex >= 0 ? baseIndex : index;

    // Determine color: custom > dataLayer > page.color > default palette
    const basePage = this._basePages.find(p => p.id === baseId) || null;
    const baseColor = this.customColors.get(baseId)
      || (typeof this.dataLayer?.getPageColor === 'function' ? this.dataLayer.getPageColor(baseId) : null)
      || basePage?.color
      || getPageColor(effectiveIndex);

    // For derived "rest of" pages, derive a lighter color
    const currentColor = derived?.kind === 'rest_of'
      ? (this.customColors.get(page.id) || deriveRestOfColor(baseColor))
      : (this.customColors.get(page.id) || baseColor);

    const tab = document.createElement('div');
    tab.className = 'analysis-page-tab' +
      (derived ? ' derived' : '') +
      (isSelected ? ' selected' : '');
    tab.dataset.pageId = page.id;

    // Color swatch
    const colorIndicator = document.createElement('span');
    colorIndicator.className = 'analysis-page-color';
    StyleManager.setVariable(colorIndicator, '--analysis-page-color', currentColor);

    if (this.showColorPicker) {
      colorIndicator.title = 'Click to change color';

      // Color picker input
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.className = 'analysis-page-color-input';
      colorInput.value = currentColor;
      colorInput.title = 'Click to change color';

      colorInput.addEventListener('input', (e) => {
        const newColor = e.target.value;
        this.customColors.set(page.id, newColor);
        StyleManager.setVariable(colorIndicator, '--analysis-page-color', newColor);
        if (this.onColorChange) this.onColorChange(page.id, newColor);
        else this.dataLayer?.setPageColor?.(page.id, newColor);
      });

      colorInput.addEventListener('click', (e) => {
        e.stopPropagation();
      });

      colorIndicator.appendChild(colorInput);
    }

    tab.appendChild(colorIndicator);

    // Page name
    const nameSpan = document.createElement('span');
    nameSpan.className = 'analysis-page-name';
    nameSpan.textContent = page.name;
    nameSpan.title = page.name;
    tab.appendChild(nameSpan);

    // Cell count
    if (this.showCellCounts) {
      const countSpan = document.createElement('span');
      countSpan.className = 'analysis-page-count';
      countSpan.textContent = cellCount > 0 ? formatCount(cellCount) : '(0)';
      tab.appendChild(countSpan);
    }

    // Click to toggle selection
    tab.addEventListener('click', () => {
      this._handlePageClick(page.id, page);
    });

    return tab;
  }

  /**
   * Handle click on a regular page tab
   * @param {string} pageId
   * @param {Object} page
   */
  _handlePageClick(pageId, page) {
    if (this.supportsDynamicMode) {
      // Switch to manual mode and select this page
      if (this._isDynamicMode) {
        // Switching from dynamic to manual
        this._isDynamicMode = false;
        this._selectedPages.clear();
        this._selectedPages.add(pageId);
      } else if (this.allowMultiSelect) {
        // Already in manual mode - toggle selection
        this._togglePageSelectionInternal(pageId, page);
      } else {
        // Single select mode - replace selection
        this._selectedPages.clear();
        this._selectedPages.add(pageId);
      }

      // If nothing selected in manual mode, revert to dynamic
      if (!this._isDynamicMode && this._selectedPages.size === 0) {
        this._setDynamicModeInternal(true);
        return;
      }

      // Re-render and notify
      const pages = this._getPages();
      this._renderTabs(pages);
      this._updateModeIndicator();
      this._updateHelpText();
      this._notifyModeChange();
      this._notifySelectionChange();
    } else {
      // Standard behavior without dynamic mode
      this._togglePageSelection(pageId, page);
    }
  }

  /**
   * Toggle page selection (internal, without mode changes)
   * @param {string} pageId
   * @param {Object} page
   */
  _togglePageSelectionInternal(pageId, page) {
    if (this._selectedPages.has(pageId)) {
      this._selectedPages.delete(pageId);
    } else {
      // Ensure derived pages get a stable default color for plotting
      if (page?._derived && !this.customColors.has(pageId)) {
        const baseId = page._derived.baseId;
        const baseIndex = this._basePages.findIndex(p => p.id === baseId);
        const basePage = this._basePages.find(p => p.id === baseId);
        const baseColor = this.customColors.get(baseId)
          || this.dataLayer?.getPageColor?.(baseId)
          || basePage?.color
          || getPageColor(baseIndex >= 0 ? baseIndex : 0);
        const derivedColor = page._derived.kind === 'rest_of'
          ? deriveRestOfColor(baseColor)
          : baseColor;
        this.customColors.set(pageId, derivedColor);
      }
      this._selectedPages.add(pageId);
    }
  }

  /**
   * Set dynamic mode internally and update UI
   * @param {boolean} isDynamic
   */
  _setDynamicModeInternal(isDynamic) {
    if (this._isDynamicMode === isDynamic) return;

    this._isDynamicMode = isDynamic;

    if (isDynamic) {
      // Clear manual selection when switching to dynamic
      this._selectedPages.clear();
    }

    // Re-render and notify
    const pages = this._getPages();
    this._renderTabs(pages);
    this._updateModeIndicator();
    this._updateHelpText();
    this._notifyModeChange();
    this._notifySelectionChange();
  }

  /**
   * Update the mode indicator text
   */
  _updateModeIndicator() {
    if (!this._modeIndicatorEl) return;

    if (this._isDynamicMode) {
      const activePageName = this._getActivePageName();
      this._modeIndicatorEl.textContent = activePageName ? `(${activePageName})` : '(Dynamic)';
    } else {
      const selectedCount = this._selectedPages.size;
      if (selectedCount === 0) {
        this._modeIndicatorEl.textContent = '(None)';
      } else if (selectedCount === 1) {
        const pageId = Array.from(this._selectedPages)[0];
        const pageName = this._getPageName(pageId);
        this._modeIndicatorEl.textContent = `(${pageName})`;
      } else {
        this._modeIndicatorEl.textContent = `(${selectedCount} pages)`;
      }
    }
  }

  /**
   * Update help text based on current mode
   */
  _updateHelpText() {
    if (!this._helpEl) return;

    if (this._isDynamicMode) {
      this._helpEl.textContent = this.dynamicHelpText;
    } else {
      this._helpEl.textContent = this.showColorPicker
        ? 'Click pages to select. Click color to customize.'
        : 'Click pages to select.';
    }
  }

  /**
   * Render select all/deselect all button
   * Only toggles base pages (not derived) to match expected behavior
   */
  _renderSelectAllButton(pages) {
    const actionsRow = document.createElement('div');
    actionsRow.className = 'analysis-page-actions';

    // Only consider base pages for "all selected" check
    const basePageIds = this._basePages.map(p => p.id);
    const allBaseSelected = basePageIds.every(id => this._selectedPages.has(id));

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-small';
    btn.textContent = allBaseSelected ? 'Deselect All' : 'Select All';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();

      if (allBaseSelected) {
        // Deselect all (including any derived)
        this._selectedPages.clear();
        // If dynamic mode is supported and nothing selected, revert to dynamic
        if (this.supportsDynamicMode) {
          this._setDynamicModeInternal(true);
          return;
        }
      } else {
        // Select only base pages
        basePageIds.forEach(id => this._selectedPages.add(id));
      }

      this._renderTabs(pages);
      this._notifySelectionChange();
    });

    actionsRow.appendChild(btn);
    this._tabsContainer.appendChild(actionsRow);
  }

  /**
   * Toggle page selection (standard behavior without dynamic mode)
   */
  _togglePageSelection(pageId, page) {
    if (this._selectedPages.has(pageId)) {
      this._selectedPages.delete(pageId);
    } else {
      // Ensure derived pages get a stable default color for plotting
      if (page?._derived && !this.customColors.has(pageId)) {
        const baseId = page._derived.baseId;
        const baseIndex = this._basePages.findIndex(p => p.id === baseId);
        const basePage = this._basePages.find(p => p.id === baseId);
        const baseColor = this.customColors.get(baseId)
          || this.dataLayer?.getPageColor?.(baseId)
          || basePage?.color
          || getPageColor(baseIndex >= 0 ? baseIndex : 0);
        const derivedColor = page._derived.kind === 'rest_of'
          ? deriveRestOfColor(baseColor)
          : baseColor;
        this.customColors.set(pageId, derivedColor);
      }
      this._selectedPages.add(pageId);
    }

    // Re-render and notify
    const pages = this._getPages();
    this._renderTabs(pages);
    this._notifySelectionChange();
  }

  /**
   * Notify about selection change
   */
  _notifySelectionChange() {
    if (this.onSelectionChange) {
      this.onSelectionChange(this.getEffectivePageIds());
    }
  }

  /**
   * Notify about mode change
   */
  _notifyModeChange() {
    if (this.onModeChange) {
      const mode = this._isDynamicMode ? PAGE_MODE.DYNAMIC : PAGE_MODE.MANUAL;
      this.onModeChange(mode, this.getEffectivePageIds());
    }
  }

  /**
   * Get pages from data layer (optionally with derived pages)
   */
  _getPages() {
    try {
      const basePages = this.dataLayer.getPages() || [];
      this._basePages = basePages; // Store for Select All logic

      if (this.includeDerivedPages) {
        return expandPagesWithDerived(basePages, { includeRestOf: true });
      }
      return basePages;
    } catch (err) {
      console.error('[PageSelectorComponent] Failed to get pages:', err);
      return [];
    }
  }

  /**
   * Get cell count for a page
   */
  _getCellCount(pageId) {
    try {
      // Use custom callback if provided
      if (typeof this.getCellCountForPageId === 'function') {
        return this.getCellCountForPageId(pageId) || 0;
      }
      return this.dataLayer.getCellIndicesForPage(pageId)?.length || 0;
    } catch (err) {
      return 0;
    }
  }

  /**
   * Get the currently active page ID (for dynamic mode)
   * @returns {string|null}
   */
  _getActivePageId() {
    try {
      if (typeof this.dataLayer?.getActiveHighlightPageId === 'function') {
        return this.dataLayer.getActiveHighlightPageId();
      }
      // Fallback to first page
      const pages = this._basePages.length > 0 ? this._basePages : this._getPages();
      return pages.length > 0 ? pages[0].id : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Get the currently active page name (for dynamic mode)
   * @returns {string}
   */
  _getActivePageName() {
    const activePageId = this._getActivePageId();
    return activePageId ? this._getPageName(activePageId) : '';
  }

  /**
   * Get page name by ID
   * @param {string} pageId
   * @returns {string}
   */
  _getPageName(pageId) {
    try {
      const pages = this._basePages.length > 0 ? this._basePages : this._getPages();
      const page = pages.find(p => p.id === pageId);
      return page?.name || pageId;
    } catch (err) {
      return pageId;
    }
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Get currently selected page IDs (manual selection only)
   * Use getEffectivePageIds() to get the actual pages being used
   * @returns {string[]}
   */
  getSelectedPages() {
    return Array.from(this._selectedPages);
  }

  /**
   * Get the effective page IDs based on current mode
   * In dynamic mode, returns the active page ID
   * In manual mode, returns the selected page IDs
   * @returns {string[]}
   */
  getEffectivePageIds() {
    if (this._isDynamicMode) {
      const activePageId = this._getActivePageId();
      return activePageId ? [activePageId] : [];
    }
    return Array.from(this._selectedPages);
  }

  /**
   * Set selected page IDs (switches to manual mode if dynamic mode is supported)
   * @param {string[]} pageIds
   */
  setSelectedPages(pageIds) {
    if (this.supportsDynamicMode && pageIds.length > 0) {
      this._isDynamicMode = false;
    }
    this._selectedPages = new Set(pageIds);
    this.render();
  }

  /**
   * Check if currently in dynamic mode
   * @returns {boolean}
   */
  isDynamicMode() {
    return this._isDynamicMode;
  }

  /**
   * Get current page mode
   * @returns {'dynamic'|'manual'}
   */
  getMode() {
    return this._isDynamicMode ? PAGE_MODE.DYNAMIC : PAGE_MODE.MANUAL;
  }

  /**
   * Set the page selection mode
   * @param {'dynamic'|'manual'} mode
   */
  setMode(mode) {
    if (!this.supportsDynamicMode) return;

    const shouldBeDynamic = mode === PAGE_MODE.DYNAMIC;
    if (this._isDynamicMode !== shouldBeDynamic) {
      this._setDynamicModeInternal(shouldBeDynamic);
    }
  }

  /**
   * Set dynamic mode directly
   * @param {boolean} isDynamic
   */
  setDynamicMode(isDynamic) {
    if (!this.supportsDynamicMode) return;
    this._setDynamicModeInternal(isDynamic);
  }

  /**
   * Select all base pages (not derived, matching button behavior)
   * Switches to manual mode if dynamic mode is supported
   */
  selectAll() {
    if (this.supportsDynamicMode) {
      this._isDynamicMode = false;
    }
    this._getPages(); // Ensure _basePages is populated
    this._selectedPages = new Set(this._basePages.map(p => p.id));
    this.render();
    this._notifySelectionChange();
    if (this.supportsDynamicMode) {
      this._notifyModeChange();
    }
  }

  /**
   * Deselect all pages
   * Switches to dynamic mode if supported, otherwise clears selection
   */
  deselectAll() {
    this._selectedPages.clear();
    if (this.supportsDynamicMode) {
      this._setDynamicModeInternal(true);
    } else {
      this.render();
      this._notifySelectionChange();
    }
  }

  /**
   * Update cell counts display (call after highlights change)
   */
  updateCounts() {
    if (!this.container || !this._tabsContainer) return;

    // Update dynamic tab cell count if in dynamic mode
    if (this.supportsDynamicMode && this._isDynamicMode && this._dynamicTabEl) {
      const countSpan = this._dynamicTabEl.querySelector('.analysis-page-count');
      const activePageId = this._getActivePageId();
      if (countSpan && activePageId) {
        const cellCount = this._getCellCount(activePageId);
        countSpan.textContent = cellCount > 0 ? formatCount(cellCount) : '(0)';
      }
    }

    // Update regular page tabs
    const pageTabs = this._tabsContainer.querySelectorAll('.analysis-page-tab:not(.insights-dynamic-tab)');
    pageTabs.forEach(tab => {
      const pageId = tab.dataset.pageId;
      if (pageId && pageId !== PAGE_MODE.DYNAMIC) {
        const countSpan = tab.querySelector('.analysis-page-count');
        if (countSpan) {
          const cellCount = this._getCellCount(pageId);
          countSpan.textContent = cellCount > 0 ? formatCount(cellCount) : '(0)';
        }
      }
    });
  }

  /**
   * Refresh the component (call when pages change externally)
   * Also updates the dynamic tab if active page changed
   */
  refresh() {
    if (!this.container) return;

    const pages = this._getPages();
    const allPageIds = new Set(pages.map(p => p.id));

    // Remove pages that no longer exist from selection
    for (const pageId of this._selectedPages) {
      if (!allPageIds.has(pageId)) {
        this._selectedPages.delete(pageId);
      }
    }

    // If in manual mode and all selected pages were removed, switch to dynamic
    if (this.supportsDynamicMode && !this._isDynamicMode && this._selectedPages.size === 0) {
      this._isDynamicMode = true;
    }

    this.render();
  }

  /**
   * Set a new label
   * @param {string} label
   */
  setLabel(label) {
    this.label = label;
    if (this._labelEl) {
      this._labelEl.textContent = label;
    }
  }

  /**
   * Get custom colors map (for passing to plots)
   * @returns {Map<string, string>}
   */
  getCustomColors() {
    return this.customColors;
  }

  /**
   * Export current state for persistence
   * @returns {Object}
   */
  exportState() {
    return {
      mode: this._isDynamicMode ? PAGE_MODE.DYNAMIC : PAGE_MODE.MANUAL,
      selectedPages: Array.from(this._selectedPages),
      customColors: Array.from(this.customColors.entries())
    };
  }

  /**
   * Import state from persistence
   * @param {Object} state
   */
  importState(state) {
    if (!state) return;

    // Restore mode
    if (this.supportsDynamicMode) {
      this._isDynamicMode = state.mode === PAGE_MODE.DYNAMIC;
    }

    // Restore selection
    if (Array.isArray(state.selectedPages)) {
      this._selectedPages = new Set(state.selectedPages);
    }

    // Restore custom colors
    if (Array.isArray(state.customColors)) {
      this.customColors = new Map(state.customColors);
    }

    this.render();
  }

  /**
   * Destroy and cleanup
   */
  destroy() {
    this._selectedPages.clear();
    this._dynamicTabEl = null;
    this._modeIndicatorEl = null;
    if (this.container) {
      this.container.innerHTML = '';
    }
  }
}

/**
 * Factory function to create PageSelectorComponent
 * @param {Object} options
 * @returns {PageSelectorComponent}
 */
export function createPageSelectorComponent(options) {
  return new PageSelectorComponent(options);
}

export default PageSelectorComponent;
