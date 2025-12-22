/**
 * PageSelectorComponent - Shared Page Selection Component
 *
 * Provides a reusable multi-select page tabs component with:
 * - Visual page tabs matching highlight module styling
 * - Cell count display per page
 * - Custom color picker per page
 * - Select All/Deselect All actions
 * - Reactive state management
 *
 * Used by: DetailedAnalysisUI, CorrelationAnalysisUI, etc.
 *
 * @example
 * const pageSelector = createPageSelectorComponent({
 *   dataLayer,
 *   container: document.getElementById('page-select'),
 *   onSelectionChange: (pageIds) => console.log('Selected:', pageIds),
 *   onColorChange: (pageId, color) => console.log('Color changed:', pageId, color)
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
   * @param {string[]} [options.initialSelection] - Initial page IDs to select
   * @param {string} [options.emptyMessage] - Message when no pages available
   * @param {string} [options.label] - Label text for the selector
   * @param {boolean} [options.includeDerivedPages=false] - Whether to show derived pages (e.g., "Rest of X")
   * @param {Map} [options.customColors] - Map of pageId -> custom color
   * @param {Function} [options.getCellCountForPageId] - Custom cell count function (pageId) => number
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
    this.emptyMessage = options.emptyMessage || 'Create highlight pages first using the Highlighted Cells section above.';
    this.label = options.label ?? 'Compare pages:';
    this.includeDerivedPages = options.includeDerivedPages ?? false;
    this.customColors = options.customColors || new Map();
    this.getCellCountForPageId = options.getCellCountForPageId || null;

    // State
    this._selectedPages = new Set(options.initialSelection || []);
    this._basePages = []; // Store base pages for Select All logic

    // DOM references
    this._tabsContainer = null;
    this._labelEl = null;
    this._helpEl = null;

    // Render initial state
    this.render();
  }

  /**
   * Render the complete page selector
   */
  render() {
    this.container.innerHTML = '';
    this.container.className = 'control-block analysis-page-selector';

    // Label
    this._labelEl = document.createElement('label');
    this._labelEl.textContent = this.label;
    this.container.appendChild(this._labelEl);

    // Get pages from data layer
    const pages = this._getPages();

    if (pages.length === 0) {
      this._renderEmpty();
      return;
    }

    // Help text
    if (this.showColorPicker) {
      this._helpEl = document.createElement('div');
      this._helpEl.className = 'legend-help';
      this._helpEl.textContent = 'Click pages to select. Click color to customize.';
      this.container.appendChild(this._helpEl);
    }

    // Tabs container
    this._tabsContainer = document.createElement('div');
    this._tabsContainer.className = 'analysis-page-tabs';
    this.container.appendChild(this._tabsContainer);

    // Render page tabs
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

    pages.forEach((page, index) => {
      const tab = this._createPageTab(page, index);
      this._tabsContainer.appendChild(tab);
    });

    // Select All / Deselect All button
    if (this.showSelectAll && pages.length > 1) {
      this._renderSelectAllButton(pages);
    }
  }

  /**
   * Create a single page tab element
   */
  _createPageTab(page, index) {
    const isSelected = this._selectedPages.has(page.id);
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
      this._togglePageSelection(page.id, page);
    });

    return tab;
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
   * Toggle page selection
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
      this.onSelectionChange(this.getSelectedPages());
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

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Get currently selected page IDs
   * @returns {string[]}
   */
  getSelectedPages() {
    return Array.from(this._selectedPages);
  }

  /**
   * Set selected page IDs
   * @param {string[]} pageIds
   */
  setSelectedPages(pageIds) {
    this._selectedPages = new Set(pageIds);
    this.render();
  }

  /**
   * Select all base pages (not derived, matching button behavior)
   */
  selectAll() {
    this._getPages(); // Ensure _basePages is populated
    this._selectedPages = new Set(this._basePages.map(p => p.id));
    this.render();
    this._notifySelectionChange();
  }

  /**
   * Deselect all pages
   */
  deselectAll() {
    this._selectedPages.clear();
    this.render();
    this._notifySelectionChange();
  }

  /**
   * Update cell counts display (call after highlights change)
   */
  updateCounts() {
    if (!this._tabsContainer) return;

    const pageTabs = this._tabsContainer.querySelectorAll('.analysis-page-tab');
    pageTabs.forEach(tab => {
      const pageId = tab.dataset.pageId;
      if (pageId) {
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
   */
  refresh() {
    const pages = this._getPages();
    const allPageIds = new Set(pages.map(p => p.id));

    // Remove pages that no longer exist
    for (const pageId of this._selectedPages) {
      if (!allPageIds.has(pageId)) {
        this._selectedPages.delete(pageId);
      }
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
   * Destroy and cleanup
   */
  destroy() {
    this._selectedPages.clear();
    this.container.innerHTML = '';
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
