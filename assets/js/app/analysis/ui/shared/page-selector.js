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
 * Used by: DetailedAnalysisUI, DEAnalysisUI, etc.
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

import { getPageColor } from '../../core/plugin-contract.js';
import { formatCount } from '../../shared/dom-utils.js';
import { StyleManager } from '../../../../utils/style-manager.js';

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
   * @param {Map} [options.customColors] - Initial custom colors map
   * @param {string} [options.emptyMessage] - Message when no pages available
   * @param {string} [options.label] - Label text for the selector
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

    // State
    this._selectedPages = new Set(options.initialSelection || []);
    this._customColors = new Map(options.customColors || []);

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
    const currentColor = this._customColors.get(page.id) || getPageColor(index);

    const tab = document.createElement('div');
    tab.className = 'analysis-page-tab' + (isSelected ? ' selected' : '');
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
        this._customColors.set(page.id, newColor);
        StyleManager.setVariable(colorIndicator, '--analysis-page-color', newColor);
        if (this.onColorChange) {
          this.onColorChange(page.id, newColor);
        }
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
      this._togglePageSelection(page.id);
    });

    return tab;
  }

  /**
   * Render select all/deselect all button
   */
  _renderSelectAllButton(pages) {
    const actionsRow = document.createElement('div');
    actionsRow.className = 'analysis-page-actions';

    const allSelected = this._selectedPages.size === pages.length;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-small';
    btn.textContent = allSelected ? 'Deselect All' : 'Select All';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();

      if (allSelected) {
        this._selectedPages.clear();
      } else {
        pages.forEach(p => this._selectedPages.add(p.id));
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
  _togglePageSelection(pageId) {
    if (this._selectedPages.has(pageId)) {
      this._selectedPages.delete(pageId);
    } else {
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
   * Get pages from data layer
   */
  _getPages() {
    try {
      return this.dataLayer.getPages() || [];
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
   * Select all pages
   */
  selectAll() {
    const pages = this._getPages();
    this._selectedPages = new Set(pages.map(p => p.id));
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
   * Get custom colors map
   * @returns {Map<string, string>}
   */
  getCustomColors() {
    return new Map(this._customColors);
  }

  /**
   * Set custom color for a page
   * @param {string} pageId
   * @param {string} color
   */
  setCustomColor(pageId, color) {
    this._customColors.set(pageId, color);
    this.render();
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
   * Destroy and cleanup
   */
  destroy() {
    this._selectedPages.clear();
    this._customColors.clear();
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
