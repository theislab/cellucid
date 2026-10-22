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
 * const pageSelector = new PageSelectorComponent({
 *   dataLayer,
 *   container: document.getElementById('page-select'),
 *   onSelectionChange: (pageIds) => console.log('Selected:', pageIds),
 *   onColorChange: (pageId, color) => console.log('Color changed:', pageId, color)
 * });
 *
 * @example
 * // With Dynamic mode support (Quick Insights)
 * const pageSelector = new PageSelectorComponent({
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

import { formatCells, formatCompactCount } from '../../../ui/components/display-format.js';
import { createDomId } from '../../../ui/components/dom-id.js';
import { createInfoTip } from '../../../ui/components/controls.js';
import { StyleManager } from '../../../../utils/style-manager.js';
import { expandPagesWithDerived } from '../../shared/page-derivation-utils.js';
import { deriveRestOfColor } from '../../shared/color-utils.js';
import { getPageColor } from '../../core/plugin-contract.js';

/** What the Dynamic chip does: its hover title and part of its accessible name. */
const DYNAMIC_MODE_DESCRIPTION = 'Follows the active highlight page.';

/**
 * Page selection mode constants
 * @readonly
 * @enum {string}
 */
export const PAGE_MODE = {
  DYNAMIC: 'dynamic',  // Follow the active highlight page
  MANUAL: 'manual'     // User-selected pages
};

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError(
      `${label} must contain exactly: ${sortedExpected.join(', ')}`
    );
  }
}

/**
 * Announce a page chip's toggle state.
 *
 * Each chip is a native `<button>` toggle, so click, Enter, and Space all
 * reach the same click handler. The page's colour `<input type="color">` is a
 * sibling of that button inside the chip wrapper, never nested in it: an
 * interactive control inside a button is unreachable for assistive
 * technology. The input is laid over the swatch the button draws.
 *
 * @param {HTMLButtonElement} tab
 * @param {Object} options
 * @param {Array<string|null>} options.label - Accessible name parts; empty
 *   parts are dropped.
 * @param {boolean} options.pressed - Whether the chip is currently selected.
 * @param {boolean} options.disabled - Whether the chip can be activated.
 */
function makeTabOperable(tab, { label, pressed, disabled }) {
  const name = label.filter(part => typeof part === 'string' && part.length > 0)
    .join(', ');
  if (name.length === 0) {
    throw new TypeError('A page chip requires a non-empty accessible name');
  }
  tab.type = 'button';
  tab.setAttribute('aria-label', name);
  tab.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  tab.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  tab.tabIndex = disabled ? -1 : 0;
}

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
    this.emptyMessage = options.emptyMessage || 'Create highlight pages first using the Highlighted Cells section above.';
    this.label = options.label ?? 'Compare pages';
    if (typeof this.label !== 'string' || this.label.length === 0 || this.label.endsWith(':')) {
      throw new TypeError('Page selector label must be non-empty text without a trailing colon');
    }
    this.includeDerivedPages = options.includeDerivedPages ?? false;
    this.customColors = options.customColors || new Map();
    this.getCellCountForPageId = options.getCellCountForPageId || null;

    // Dynamic mode options
    this.supportsDynamicMode = options.supportsDynamicMode ?? false;
    this.onModeChange = options.onModeChange || null;
    this.dynamicLabel = options.dynamicLabel ?? 'Dynamic';
    this.allowMultiSelect = options.allowMultiSelect ?? true;

    // State
    this._basePages = []; // Store base pages for Select All logic
    this._isDynamicMode = this.supportsDynamicMode && (options.initialDynamicMode ?? true);
    const pages = this._getPages();
    if (options.initialSelection === undefined) {
      this._selectedPages = new Set(
        this._isDynamicMode ? [] : this._getDefaultSelection(pages)
      );
    } else {
      this._selectedPages = this._requireSelection(
        options.initialSelection,
        pages,
        'Initial selected pages'
      );
    }

    // DOM references
    this._tabsContainer = null;
    this._selectAllButton = null;
    this._pagesById = null;
    this._chipsById = null;
    this._labelEl = null;
    this._dynamicTabEl = null;
    this._modeIndicatorEl = null;
    this._selectAllButton = null;
    this._pagesById = null;
    this._chipsById = null;

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

    // The chips are a group of toggle buttons, so the caption names the group
    // (`aria-labelledby`); a `<label>` can only name one control.
    let captionId = null;
    if (this.showHeader) {
      const labelRow = document.createElement('div');
      labelRow.className = 'analysis-page-selector-header';

      this._labelEl = document.createElement('span');
      this._labelEl.className = 'field-label';
      this._labelEl.id = createDomId('page-selector-caption');
      this._labelEl.textContent = this.label;
      captionId = this._labelEl.id;
      labelRow.appendChild(this._labelEl);
      // How to pick pages (and recolour them) is told by the (i), not a line.
      const info = createInfoTip({ tip: 'compare-pages', label: 'About choosing pages' });
      labelRow.appendChild(info.button);

      if (this.supportsDynamicMode) {
        this._modeIndicatorEl = document.createElement('span');
        this._modeIndicatorEl.className = 'analysis-page-mode-indicator';
        this._updateModeIndicator();
        labelRow.appendChild(this._modeIndicatorEl);
      }

      this.container.appendChild(labelRow);
      this.container.appendChild(info.popover);
    } else {
      this._labelEl = null;
      this._modeIndicatorEl = null;
    }

    const pages = this._getPages();

    if (pages.length === 0 && !this.supportsDynamicMode) {
      this._renderEmpty();
      return;
    }

    this._tabsContainer = document.createElement('div');
    this._tabsContainer.className = 'analysis-page-tabs';
    this._tabsContainer.setAttribute('role', 'group');
    if (captionId !== null) {
      this._tabsContainer.setAttribute('aria-labelledby', captionId);
    } else {
      this._tabsContainer.setAttribute('aria-label', this.label);
    }
    // One listener per event type serves every chip: the chips are updated in
    // place on a toggle, so nothing is re-bound per click.
    this._tabsContainer.addEventListener('click', (event) => this._handleTabsClick(event));
    this._tabsContainer.addEventListener('input', (event) => this._handleColorInput(event));
    this.container.appendChild(this._tabsContainer);

    this._renderTabs(pages);
  }

  /**
   * Render empty state when no pages available
   */
  _renderEmpty() {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = this.emptyMessage;
    this.container.appendChild(empty);
  }

  /**
   * Build every chip for `pages`. Called when the page set itself changes;
   * a selection change only updates the existing chips (`_syncTabs`).
   */
  _renderTabs(pages) {
    const focused = this._tabsContainer.contains(document.activeElement)
      ? document.activeElement
      : null;
    const focusedPageId = focused?.dataset?.pageId ?? null;
    const focusWasSelectAll = focused !== null
      && focusedPageId === null
      && focused.closest('.analysis-page-actions') !== null;

    // `render()` hands this a fresh, empty container, so the chips are only
    // ever appended; a chip index replaces every later query for them.
    this._pagesById = new Map(pages.map(page => [page.id, page]));
    this._chipsById = new Map();

    if (this.supportsDynamicMode) {
      const dynamicTab = this._createDynamicTab();
      this._chipsById.set(PAGE_MODE.DYNAMIC, dynamicTab);
      this._tabsContainer.appendChild(dynamicTab);
    }
    pages.forEach((page, index) => {
      const { wrapper, tab } = this._createPageTab(page, index);
      this._chipsById.set(page.id, tab);
      this._tabsContainer.appendChild(wrapper);
    });

    this._selectAllButton = null;
    if (this.showSelectAll && pages.length > 1 && this.allowMultiSelect) {
      this._renderSelectAllButton(pages);
    }
    this._syncTabs(pages);

    if (focused === null) return;
    const replacement = focusedPageId !== null
      ? this._findChip(focusedPageId)
      : (focusWasSelectAll ? this._selectAllButton : null);
    if (replacement !== null && !replacement.hidden && replacement.tabIndex >= 0) {
      replacement.focus({ preventScroll: true });
    }
  }

  /**
   * The chip button for one page id, or null.
   * @param {string} pageId
   * @returns {HTMLButtonElement|null}
   */
  _findChip(pageId) {
    return this._chipsById?.get(pageId) ?? null;
  }

  /**
   * Bring every chip's pressed state, the dynamic chip's label and the
   * select-all button in line with the current selection, in place.
   * @param {Array<Object>} pages
   */
  _syncTabs(pages) {
    for (const [pageId, chip] of this._chipsById) {
      if (pageId === PAGE_MODE.DYNAMIC) {
        this._syncDynamicTab(chip);
        continue;
      }
      const selectable = chip.dataset.selectable === 'true';
      const pressed = selectable && !this._isDynamicMode && this._selectedPages.has(pageId);
      chip.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    }
    if (this._selectAllButton !== null) {
      const candidates = this._getSelectionCandidates(pages);
      const allSelected = candidates.length > 0
        && candidates.every(id => this._selectedPages.has(id));
      this._selectAllButton.hidden = this._isDynamicMode || candidates.length === 0;
      this._selectAllButton.dataset.allSelected = allSelected ? 'true' : 'false';
      this._selectAllButton.textContent = allSelected ? 'Deselect all' : 'Select all';
    }
  }

  /**
   * Create the Dynamic tab element
   * @returns {HTMLElement}
   */
  _createDynamicTab() {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'chip insights-dynamic-tab';
    tab.dataset.pageId = PAGE_MODE.DYNAMIC;

    const icon = document.createElement('span');
    icon.className = 'insights-dynamic-icon';
    icon.textContent = '⟳';
    icon.setAttribute('aria-hidden', 'true');
    tab.appendChild(icon);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'chip-name';
    nameSpan.title = DYNAMIC_MODE_DESCRIPTION;
    tab.appendChild(nameSpan);

    if (this.showCellCounts) {
      const countSpan = document.createElement('span');
      countSpan.className = 'chip-count';
      tab.appendChild(countSpan);
    }

    this._dynamicTabEl = tab;
    return tab;
  }

  /**
   * Update the dynamic chip's name, count and announced state.
   * @param {HTMLButtonElement} tab
   */
  _syncDynamicTab(tab) {
    const nameSpan = tab.querySelector('.chip-name');
    const activePageName = this._isDynamicMode ? this._getActivePageName() : '';
    nameSpan.textContent = activePageName
      ? `${this.dynamicLabel}: ${activePageName}`
      : this.dynamicLabel;

    let dynamicCellCount = null;
    const countSpan = tab.querySelector('.chip-count');
    if (countSpan !== null) {
      const activePageId = this._isDynamicMode ? this._getActivePageId() : null;
      dynamicCellCount = activePageId ? this._getCellCount(activePageId) : null;
      countSpan.hidden = dynamicCellCount === null;
      countSpan.textContent = dynamicCellCount === null
        ? ''
        : formatCompactCount(dynamicCellCount);
    }

    makeTabOperable(tab, {
      label: [
        nameSpan.textContent,
        dynamicCellCount === null ? null : formatCells(dynamicCellCount),
        DYNAMIC_MODE_DESCRIPTION
      ],
      pressed: this._isDynamicMode,
      disabled: false
    });
  }

  /**
   * Resolve the colour a page is drawn in.
   * @param {Object} page
   * @param {number} index
   * @returns {string}
   */
  _resolvePageColor(page, index) {
    const derived = page?._derived || null;
    const baseId = derived?.baseId || page.id;
    const baseIndex = this._basePages.findIndex(p => p.id === baseId);
    const effectiveIndex = baseIndex >= 0 ? baseIndex : index;
    const basePage = this._basePages.find(p => p.id === baseId) || null;
    const baseColor = this.customColors.get(baseId)
      || (typeof this.dataLayer?.getPageColor === 'function' ? this.dataLayer.getPageColor(baseId) : null)
      || basePage?.color
      || getPageColor(effectiveIndex);
    return derived?.kind === 'rest_of'
      ? (this.customColors.get(page.id) || deriveRestOfColor(baseColor))
      : (this.customColors.get(page.id) || baseColor);
  }

  /**
   * Create a single page chip: its toggle button plus, when colours are
   * editable, the colour input laid over the swatch beside it.
   * @returns {{ wrapper: HTMLDivElement, tab: HTMLButtonElement }}
   */
  _createPageTab(page, index) {
    const cellCount = this._getCellCount(page.id);
    const isSelectable = cellCount > 0;
    const derived = page?._derived || null;
    const currentColor = this._resolvePageColor(page, index);

    const chip = document.createElement('div');
    chip.className = 'analysis-page-chip';
    const tab = document.createElement('button');
    chip.appendChild(tab);
    tab.className = derived ? 'chip chip-derived' : 'chip';
    tab.dataset.pageId = page.id;
    tab.dataset.selectable = isSelectable ? 'true' : 'false';
    makeTabOperable(tab, {
      label: [
        page.name,
        derived ? 'derived page' : null,
        isSelectable ? formatCells(cellCount) : 'no cells, cannot be selected'
      ],
      pressed: false,
      disabled: !isSelectable
    });
    if (!isSelectable) {
      tab.title = `${page.name} has zero cells and cannot be selected`;
    }

    const swatch = document.createElement('span');
    swatch.className = 'color-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    StyleManager.setVariable(swatch, '--swatch-color', currentColor);
    tab.appendChild(swatch);

    if (this.showColorPicker && isSelectable) {
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.className = 'color-swatch-input';
      colorInput.dataset.pageId = page.id;
      colorInput.value = currentColor;
      colorInput.setAttribute('aria-label', `Colour for ${page.name}`);
      colorInput.title = `Colour for ${page.name}`;
      chip.appendChild(colorInput);
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'chip-name';
    nameSpan.textContent = page.name;
    nameSpan.title = page.name;
    tab.appendChild(nameSpan);

    if (this.showCellCounts) {
      const countSpan = document.createElement('span');
      countSpan.className = 'chip-count';
      countSpan.textContent = formatCompactCount(cellCount);
      tab.appendChild(countSpan);
    }

    return { wrapper: chip, tab };
  }

  /**
   * Delegated click handler for the chips and the select-all button.
   * @param {MouseEvent} event
   */
  _handleTabsClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    if (this._selectAllButton !== null && this._selectAllButton.contains(target)) {
      event.stopPropagation();
      this._handleSelectAll();
      return;
    }
    const chip = target.closest('.chip[data-page-id]');
    if (chip === null || this._findChip(chip.dataset.pageId) !== chip) return;
    const pageId = chip.dataset.pageId;
    if (pageId !== PAGE_MODE.DYNAMIC && chip.dataset.selectable !== 'true') return;
    if (pageId === PAGE_MODE.DYNAMIC) {
      this._setDynamicModeInternal(true);
      return;
    }
    this._handlePageClick(pageId, this._pagesById.get(pageId));
  }

  /**
   * Delegated colour-input handler: recolour the page's swatch and publish.
   * @param {Event} event
   */
  _handleColorInput(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.classList.contains('color-swatch-input')) {
      return;
    }
    const pageId = input.dataset.pageId;
    const newColor = input.value;
    this.customColors.set(pageId, newColor);
    const swatch = this._findChip(pageId)?.querySelector('.color-swatch');
    if (swatch) StyleManager.setVariable(swatch, '--swatch-color', newColor);
    if (this.onColorChange) this.onColorChange(pageId, newColor);
    else this.dataLayer?.setPageColor?.(pageId, newColor);
  }

  /**
   * Handle click on a regular page tab
   * @param {string} pageId
   * @param {Object} page
   */
  _handlePageClick(pageId, page) {
    const pages = this._getPages();
    this._requireSelectablePage(pageId, pages);

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

      this._syncTabs(pages);
      this._updateModeIndicator();
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
    this._requireSelectablePage(pageId, this._getPages());
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

    const pages = this._getPages();
    this._syncTabs(pages);
    this._updateModeIndicator();
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
   * Render the select all / deselect all button. Only base pages (not
   * derived) are toggled, to match expected behavior.
   */
  _renderSelectAllButton(pages) {
    if (this._getSelectionCandidates(pages).length === 0) return;
    const actionsRow = document.createElement('div');
    actionsRow.className = 'analysis-page-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-compact';
    actionsRow.appendChild(btn);
    this._tabsContainer.appendChild(actionsRow);
    this._selectAllButton = btn;
  }

  /**
   * Select every base page, or clear the selection when all are selected.
   */
  _handleSelectAll() {
    const pages = this._getPages();
    if (this._selectAllButton.dataset.allSelected === 'true') {
      this._selectedPages.clear();
      if (this.supportsDynamicMode) {
        this._setDynamicModeInternal(true);
        return;
      }
    } else {
      this._getSelectionCandidates(pages).forEach(id => this._selectedPages.add(id));
    }
    this._syncTabs(pages);
    this._notifySelectionChange();
  }

  /**
   * Toggle page selection (standard behavior without dynamic mode)
   */
  _togglePageSelection(pageId, page) {
    this._requireSelectablePage(pageId, this._getPages());
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

    this._syncTabs(this._getPages());
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
    const basePages = this.dataLayer.getPages();
    if (!Array.isArray(basePages)) {
      throw new TypeError('Page selector data layer must return an array of pages');
    }
    const seenPageIds = new Set();
    for (const page of basePages) {
      if (
        !isPlainObject(page) ||
        typeof page.id !== 'string' ||
        page.id.length === 0 ||
        typeof page.name !== 'string' ||
        page.name.length === 0
      ) {
        throw new TypeError(
          'Page selector pages require non-empty string id and name fields'
        );
      }
      if (seenPageIds.has(page.id)) {
        throw new TypeError(`Page selector page ID "${page.id}" is duplicated`);
      }
      seenPageIds.add(page.id);
    }
    this._basePages = basePages;

    if (this.includeDerivedPages) {
      return expandPagesWithDerived(basePages, { includeRestOf: true });
    }
    return basePages;
  }

  /**
   * Get cell count for a page
   */
  _getCellCount(pageId) {
    let cellCount;
    if (typeof this.getCellCountForPageId === 'function') {
      cellCount = this.getCellCountForPageId(pageId);
    } else {
      const cellIndices = this.dataLayer.getCellIndicesForPage(pageId);
      if (
        cellIndices === null ||
        typeof cellIndices !== 'object' ||
        !Number.isSafeInteger(cellIndices.length) ||
        cellIndices.length < 0
      ) {
        throw new TypeError(
          `Page selector cell indices for "${pageId}" must be an array or typed array`
        );
      }
      cellCount = cellIndices.length;
    }
    if (!Number.isSafeInteger(cellCount) || cellCount < 0) {
      throw new TypeError(
        `Page selector cell count for "${pageId}" must be a non-negative safe integer`
      );
    }
    return cellCount;
  }

  /**
   * Require a page to exist and contain cells before it can be selected.
   * @param {string} pageId
   * @param {Array<{id: string}>} pages
   */
  _requireSelectablePage(pageId, pages) {
    const page = pages.find(candidate => candidate.id === pageId);
    if (!page) {
      throw new Error(`Page selector page "${pageId}" was not found`);
    }
    if (this._getCellCount(pageId) === 0) {
      throw new RangeError(
        `Page selector page "${pageId}" has zero cells and cannot be selected`
      );
    }
  }

  /**
   * Validate one exact page selection.
   * @param {unknown} pageIds
   * @param {Array<{id: string}>} pages
   * @param {string} label
   * @returns {Set<string>}
   */
  _requireSelection(pageIds, pages, label) {
    if (!Array.isArray(pageIds)) {
      throw new TypeError(`${label} must be an array`);
    }
    const selection = new Set();
    for (const pageId of pageIds) {
      if (typeof pageId !== 'string' || pageId.length === 0) {
        throw new TypeError(`${label} IDs must be non-empty strings`);
      }
      this._requireSelectablePage(pageId, pages);
      if (selection.has(pageId)) {
        throw new TypeError(
          `Page selector page "${pageId}" is selected more than once`
        );
      }
      selection.add(pageId);
    }
    return selection;
  }

  /**
   * Return the selectable base-page IDs, or one derived page when no base page
   * contains cells.
   * @param {Array<{id: string, _derived?: Object}>} pages
   * @returns {string[]}
   */
  _getSelectionCandidates(pages) {
    const basePageIds = this._basePages
      .filter(page => this._getCellCount(page.id) > 0)
      .map(page => page.id);
    if (basePageIds.length > 0) {
      return basePageIds;
    }
    const firstDerivedPage = pages.find(
      page => page._derived && this._getCellCount(page.id) > 0
    );
    return firstDerivedPage ? [firstDerivedPage.id] : [];
  }

  /**
   * Get the deterministic fresh manual selection.
   * @param {Array<{id: string, _derived?: Object}>} pages
   * @returns {string[]}
   */
  _getDefaultSelection(pages) {
    return this._getSelectionCandidates(pages);
  }

  /**
   * Get the currently active page ID (for dynamic mode)
   * @returns {string|null}
   */
  _getActivePageId() {
    if (typeof this.dataLayer.getActiveHighlightPageId !== 'function') {
      throw new TypeError(
        'Dynamic page selection requires dataLayer.getActiveHighlightPageId()'
      );
    }
    const activePageId = this.dataLayer.getActiveHighlightPageId();
    if (activePageId === null) {
      return null;
    }
    if (typeof activePageId !== 'string' || activePageId.length === 0) {
      throw new TypeError('The active highlight page ID must be null or a non-empty string');
    }
    const pages = this._basePages.length > 0 ? this._basePages : this._getPages();
    if (!pages.some(page => page.id === activePageId)) {
      throw new Error(`Active highlight page not found: ${activePageId}`);
    }
    return activePageId;
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
    const pages = this._getPages();
    const page = pages.find(candidate => candidate.id === pageId);
    if (!page) {
      throw new Error(`Page selector page not found: ${pageId}`);
    }
    return page.name;
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
      if (activePageId === null) {
        return [];
      }
      this._requireSelectablePage(activePageId, this._getPages());
      return [activePageId];
    }
    return Array.from(this._selectedPages);
  }

  /**
   * Set selected page IDs (switches to manual mode if dynamic mode is supported)
   * @param {string[]} pageIds
   */
  setSelectedPages(pageIds) {
    const pages = this._getPages();
    const nextSelection = this._requireSelection(
      pageIds,
      pages,
      'Selected pages'
    );
    if (this.supportsDynamicMode && pageIds.length > 0) {
      this._isDynamicMode = false;
    }
    this._selectedPages = nextSelection;
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
    if (mode !== PAGE_MODE.DYNAMIC && mode !== PAGE_MODE.MANUAL) {
      throw new TypeError('Page selector mode must be dynamic or manual');
    }
    if (!this.supportsDynamicMode && mode === PAGE_MODE.DYNAMIC) {
      throw new TypeError('This page selector does not support dynamic mode');
    }

    const shouldBeDynamic = mode === PAGE_MODE.DYNAMIC;
    if (this._isDynamicMode !== shouldBeDynamic) {
      this._setDynamicModeInternal(shouldBeDynamic);
    }
  }

  /**
   * Select all base pages (not derived, matching button behavior)
   * Switches to manual mode if dynamic mode is supported
   */
  selectAll() {
    if (this.supportsDynamicMode) {
      this._isDynamicMode = false;
    }
    const pages = this._getPages();
    this._selectedPages = new Set(this._getSelectionCandidates(pages));
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
    if (!this.container) return;
    const pages = this._getPages();
    const rendered = this._pagesById instanceof Map
      && this._tabsContainer?.isConnected === true
      && this._pagesById.size === pages.length
      && pages.every(page => this._pagesById.get(page.id) !== undefined);
    // A changed page set (or a selection the new counts invalidate) needs the
    // full rebuild; otherwise only the counts and availability change, which
    // are written into the existing chips.
    const selectionStillValid = [...this._selectedPages].every(
      pageId => this._getCellCount(pageId) > 0
    );
    if (!rendered || !selectionStillValid
      || (this.supportsDynamicMode && !this._isDynamicMode && this._selectedPages.size === 0)) {
      this.refresh();
      return;
    }
    let availabilityChanged = false;
    for (const page of pages) {
      const chip = this._findChip(page.id);
      if (chip === null) continue;
      const cellCount = this._getCellCount(page.id);
      const selectable = cellCount > 0;
      if ((chip.dataset.selectable === 'true') !== selectable) {
        availabilityChanged = true;
        break;
      }
      const countSpan = chip.querySelector('.chip-count');
      const text = formatCompactCount(cellCount);
      if (countSpan !== null && countSpan.textContent !== text) countSpan.textContent = text;
      const label = [
        page.name,
        page._derived ? 'derived page' : null,
        selectable ? formatCells(cellCount) : 'no cells, cannot be selected'
      ].filter(Boolean).join(', ');
      chip.setAttribute('aria-label', label);
    }
    if (availabilityChanged) {
      this.refresh();
      return;
    }
    this._syncTabs(pages);
    this._updateModeIndicator();
  }

  /**
   * Refresh the component (call when pages change externally)
   * Also updates the dynamic tab if active page changed
   */
  refresh() {
    if (!this.container) return;

    const pages = this._getPages();
    const allPageIds = new Set(pages.map(p => p.id));
    let selectionChanged = false;

    // Remove pages that no longer exist or no longer contain cells.
    for (const pageId of this._selectedPages) {
      if (!allPageIds.has(pageId) || this._getCellCount(pageId) === 0) {
        this._selectedPages.delete(pageId);
        selectionChanged = true;
      }
    }

    // If in manual mode and all selected pages were removed, switch to dynamic
    if (this.supportsDynamicMode && !this._isDynamicMode && this._selectedPages.size === 0) {
      this._isDynamicMode = true;
      selectionChanged = true;
    }

    this.render();
    if (selectionChanged) {
      this._notifySelectionChange();
      if (this.supportsDynamicMode) {
        this._notifyModeChange();
      }
    }
  }

  /**
   * Set a new label
   * @param {string} label
   */
  setLabel(label) {
    if (typeof label !== 'string' || label.length === 0 || label.endsWith(':')) {
      throw new TypeError('Page selector label must be non-empty text without a trailing colon');
    }
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
    requireExactKeys(
      state,
      ['customColors', 'mode', 'selectedPages'],
      'Page selector state'
    );
    if (state.mode !== PAGE_MODE.DYNAMIC && state.mode !== PAGE_MODE.MANUAL) {
      throw new TypeError('Page selector mode must be dynamic or manual');
    }
    if (!this.supportsDynamicMode && state.mode !== PAGE_MODE.MANUAL) {
      throw new TypeError('This page selector does not support dynamic mode');
    }
    if (!Array.isArray(state.selectedPages)) {
      throw new TypeError('Page selector selectedPages must be an array');
    }
    if (!Array.isArray(state.customColors)) {
      throw new TypeError('Page selector customColors must be an array');
    }

    const pages = this._getPages();
    const availablePageIds = new Set(pages.map(page => page.id));
    const selectedPages = this._requireSelection(
      state.selectedPages,
      pages,
      'Page selector selectedPages'
    );
    if (state.mode === PAGE_MODE.DYNAMIC && selectedPages.size !== 0) {
      throw new TypeError(
        'Dynamic page selector state must not contain manually selected pages'
      );
    }
    if (
      this.supportsDynamicMode &&
      state.mode === PAGE_MODE.MANUAL &&
      selectedPages.size === 0
    ) {
      throw new TypeError('Manual page selector state requires at least one page');
    }

    const customColors = new Map();
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
          'Page selector customColors must contain [pageId, #rrggbb] pairs'
        );
      }
      const [pageId, color] = entry;
      if (!availablePageIds.has(pageId)) {
        throw new Error(`Page selector color page "${pageId}" was not found`);
      }
      if (customColors.has(pageId)) {
        throw new TypeError(
          `Page selector page "${pageId}" has more than one custom color`
        );
      }
      customColors.set(pageId, color);
    }

    this._isDynamicMode = state.mode === PAGE_MODE.DYNAMIC;
    this._selectedPages = selectedPages;
    this.customColors = customColors;
    this.render();
  }

  /**
   * Destroy and cleanup
   */
  destroy() {
    this._selectedPages.clear();
    this._dynamicTabEl = null;
    this._modeIndicatorEl = null;
    this._selectAllButton = null;
    this._pagesById = null;
    this._chipsById = null;
    if (this.container) {
      this.container.innerHTML = '';
    }
  }
}
