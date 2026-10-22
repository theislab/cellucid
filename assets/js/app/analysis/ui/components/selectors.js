/**
 * UI Selector Components
 *
 * Core selection components for analysis:
 * - Variable selector (categorical/continuous obs fields)
 * - Gene expression selector (searchable dropdown)
 * - Page comparison selector (exactly two pages, for DE)
 * - Plot type selector
 */

import { createIntentPrefetcher } from '../../../utils/intent-prefetch.js';
import { getPageColor } from '../../core/plugin-contract.js';
import { NONE_VALUE } from '../../shared/dom-utils.js';
import { expandPagesWithDerived } from '../../shared/page-derivation-utils.js';
import { StyleManager } from '../../../../utils/style-manager.js';
import { createField } from '../../../ui/components/controls.js';
import { createDomId } from '../../../ui/components/dom-id.js';
import { formatCells } from '../../../ui/components/display-format.js';

// =============================================================================
// PLOT REGISTRY - Imported from centralized location
// =============================================================================

// Import PlotRegistry for local use
// All code should import directly from '../../shared/plot-registry-utils.js'
import { PlotRegistry } from '../../shared/plot-registry-utils.js';

// =============================================================================
// VARIABLE SELECTOR
// =============================================================================

/**
 * Create a variable selector dropdown matching the filtering section pattern exactly
 * Uses .field-select container and .obs-select dropdown
 * @param {Object} options
 * @param {Object[]} options.variables - Array of variable info objects
 * @param {Function} options.onChange - Callback when selection changes
 * @param {string} options.selectedValue - Currently selected value
 * @param {string} options.label - Label text
 * @param {string} options.id - Element ID
 * @returns {HTMLElement}
 */
export function createVariableSelector(options = {}) {
  const {
    variables = [],
    onChange,
    selectedValue = '',
    label = 'Variable',
    ariaLabel = 'Variable',
    id = ''
  } = options;

  const select = document.createElement('select');
  select.className = 'obs-select';
  if (id) select.id = id;

  // Add "None" option - exactly matching filtering section
  const noneOption = document.createElement('option');
  noneOption.value = NONE_VALUE;
  noneOption.textContent = 'None';
  noneOption.selected = !selectedValue || selectedValue === NONE_VALUE;
  select.appendChild(noneOption);

  variables.forEach(v => {
    const option = document.createElement('option');
    option.value = v.key;
    option.textContent = v.key;
    if (v.key === selectedValue) {
      option.selected = true;
    }
    select.appendChild(option);
  });

  select.addEventListener('change', () => {
    if (onChange) onChange(select.value === NONE_VALUE ? '' : select.value);
  });

  // A selector without a visible label still needs a name.
  if (!label) {
    select.setAttribute('aria-label', ariaLabel);
    const container = document.createElement('div');
    container.className = 'control-block field-select';
    container.appendChild(select);
    return container;
  }
  return createField({ label, control: select, className: 'field-select' });
}

// =============================================================================
// GENE EXPRESSION SELECTOR
// =============================================================================

/**
 * Create a gene expression searchable dropdown - exactly matches the filtering section pattern
 * @param {Object} options
 * @param {Object[]} options.genes - Array of gene variable info objects
 * @param {Function} options.onChange - Callback when selection changes
 * @param {((gene: string, signal: AbortSignal) => Promise<unknown>)|null} [options.prefetch]
 *   Loads a gene the user is about to choose (see utils/intent-prefetch.js)
 * @param {string} options.selectedValue - Currently selected gene
 * @param {string} options.label - Label text
 * @param {string} options.id - Element ID
 * @returns {HTMLElement}
 */
export function createGeneExpressionSelector(options = {}) {
  const {
    genes = [],
    onChange,
    prefetch = null,
    selectedValue = '',
    label = 'Gene expression',
    id = 'analysis-gene-expression'
  } = options;
  // Prefetch on intent (utils/intent-prefetch.js): a gene kept active or
  // under the pointer is loaded before it is chosen.
  const genePrefetch = prefetch === null ? null : createIntentPrefetcher(prefetch);
  const intendOption = element => {
    const key = element?.dataset.optionKey;
    if (genePrefetch !== null && key) genePrefetch.intend(key);
  };

  const wrapper = document.createElement('div');
  wrapper.className = 'searchable-dropdown';

  // Search input - styled like obs-select.
  // The list used to be driven by `mousedown` alone: no Enter, no Escape, no
  // arrow keys and no combobox semantics, so picking a gene for an analysis was
  // impossible without a pointer.
  const input = document.createElement('input');
  input.type = 'text';
  input.id = `${id}-search`;
  input.className = 'obs-select';
  input.placeholder = 'None';
  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', `${id}-dropdown`);
  if (!label) input.setAttribute('aria-label', 'Gene expression');

  // Dropdown list
  const dropdown = document.createElement('div');
  dropdown.id = `${id}-dropdown`;
  dropdown.className = 'dropdown-list';
  dropdown.setAttribute('role', 'listbox');
  dropdown.setAttribute('aria-label', 'Gene expression options');
  dropdown.hidden = true;

  let currentSelectedGene = selectedValue;
  /** Index into `optionElements` that Enter would commit, or -1. */
  let activeIndex = -1;
  /** @type {HTMLElement[]} */
  let optionElements = [];

  const updateSelectedDisplay = () => {
    if (currentSelectedGene) {
      input.value = currentSelectedGene;
      input.classList.add('has-selection');
    } else {
      input.value = '';
      input.classList.remove('has-selection');
    }
  };

  const isOpen = () => !dropdown.hidden;

  /**
   * Mark one option active. Scrolling it into view forces a layout, so it is
   * done only for keyboard navigation, or once, a frame after the list was
   * (re)built, never right after the options were appended.
   */
  let scrollFrame = null;
  const setActiveIndex = (nextIndex, { scroll = true } = {}) => {
    activeIndex = nextIndex;
    optionElements.forEach((element, index) => {
      const active = index === activeIndex;
      element.classList.toggle('selected', active);
      element.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (activeIndex < 0) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    const active = optionElements[activeIndex];
    input.setAttribute('aria-activedescendant', active.id);
    intendOption(active);
    if (scroll) {
      active.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      if (active.isConnected) active.scrollIntoView({ block: 'nearest' });
    });
  };

  const commit = (gene) => {
    // A prefetch of this gene is the load its choice joins; any other is no
    // longer wanted.
    if (genePrefetch !== null && genePrefetch.current() !== gene) genePrefetch.cancel();
    currentSelectedGene = gene;
    closeDropdown();
    updateSelectedDisplay();
    if (onChange) onChange(gene);
  };

  function closeDropdown() {
    dropdown.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
  }

  // Every opening shows a list just built: it starts at its top. Left where
  // an earlier, longer list was scrolled, it would be clamped to its own end
  // and build its next page before anyone scrolled.
  const openDropdown = () => {
    dropdown.hidden = false;
    dropdown.scrollTop = 0;
    input.setAttribute('aria-expanded', 'true');
  };

  dropdown.addEventListener('pointerover', (e) => {
    const item = e.target instanceof Element
      ? e.target.closest('.dropdown-item[data-option-key]')
      : null;
    if (item !== null && dropdown.contains(item)) intendOption(item);
  });

  // One delegated listener commits whichever option the pointer pressed.
  dropdown.addEventListener('mousedown', (e) => {
    const item = e.target instanceof Element
      ? e.target.closest('.dropdown-item[data-option-key]')
      : null;
    if (item === null || !dropdown.contains(item)) return;
    e.preventDefault();
    commit(item.dataset.optionKey);
  });

  /**
   * Every gene that matches the search is listed. The options are built a page
   * at a time — the first page when the list opens, the next when it is
   * scrolled or arrowed to its end — so a search matching tens of thousands of
   * genes costs a hundred list items to open, not tens of thousands.
   */
  const OPTION_PAGE = 100;
  /** @type {Object[]} Matches of the current search, in gene order. */
  let matches = [];
  let renderedMatches = 0;

  const addOption = (parent, key, text, extraClass) => {
    const item = document.createElement('div');
    item.className = `dropdown-item${extraClass ? ` ${extraClass}` : ''}`;
    item.id = `${id}-option-${optionElements.length}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', 'false');
    item.dataset.optionKey = key;
    item.textContent = text;
    parent.appendChild(item);
    optionElements.push(item);
    return item;
  };

  /** Append the next page of matches (or up to `through`, a match index). */
  const renderMoreMatches = (through = renderedMatches + OPTION_PAGE - 1) => {
    const end = Math.min(matches.length, Math.max(through + 1, renderedMatches));
    if (end <= renderedMatches) return false;
    const fragment = document.createDocumentFragment();
    for (let i = renderedMatches; i < end; i++) {
      addOption(fragment, matches[i].key, matches[i].key);
    }
    renderedMatches = end;
    dropdown.appendChild(fragment);
    return true;
  };

  const renderOptions = (filter = '') => {
    optionElements = [];
    activeIndex = -1;
    // Options are built off-document and inserted in one step.
    const fragment = document.createDocumentFragment();

    // "None" clears the selection.
    addOption(fragment, '', 'None', 'text-tertiary');

    const lowerFilter = filter.toLowerCase();
    // Don't filter if the input shows the current selection
    const isShowingSelection = currentSelectedGene && input.value === currentSelectedGene;
    matches = isShowingSelection
      ? genes
      : genes.filter(g => g.key.toLowerCase().includes(lowerFilter));
    renderedMatches = 0;

    if (matches.length === 0 && filter) {
      const empty = document.createElement('div');
      empty.className = 'dropdown-no-results';
      empty.textContent = 'No matches.';
      empty.setAttribute('role', 'option');
      empty.setAttribute('aria-disabled', 'true');
      empty.setAttribute('aria-selected', 'false');
      fragment.appendChild(empty);
      dropdown.replaceChildren(fragment);
      return;
    }

    dropdown.replaceChildren(fragment);
    // One page to open with, whatever the match count; the current gene is
    // marked when it is on it.
    renderMoreMatches();
    const currentIndex = optionElements.findIndex(
      item => item.dataset.optionKey === currentSelectedGene
    );
    setActiveIndex(currentIndex >= 0 ? currentIndex : 0, { scroll: false });
  };

  dropdown.addEventListener('scroll', () => {
    if (dropdown.scrollTop + dropdown.clientHeight >= dropdown.scrollHeight - 2 * (optionElements[0]?.offsetHeight || 24)) {
      renderMoreMatches();
    }
  });

  input.addEventListener('focus', () => {
    // Clear input to allow searching, but remember selection
    if (currentSelectedGene) {
      input.value = '';
    }
    renderOptions('');
    openDropdown();
  });

  input.addEventListener('input', () => {
    renderOptions(input.value);
    openDropdown();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!isOpen()) return;
      event.preventDefault();
      closeDropdown();
      updateSelectedDisplay();
      return;
    }
    if (event.key === 'Enter') {
      if (!isOpen() || activeIndex < 0) return;
      event.preventDefault();
      commit(optionElements[activeIndex].dataset.optionKey);
      return;
    }
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return;
    }
    event.preventDefault();
    if (!isOpen()) {
      renderOptions(input.value);
      openDropdown();
      return;
    }
    if (optionElements.length === 0) return;
    // Moving past the last option built, or to the end, builds the rest of
    // the way first: every match is reachable from the keyboard.
    if (event.key === 'End' || (event.key === 'ArrowUp' && activeIndex <= 0)) {
      renderMoreMatches(matches.length - 1);
    } else if (event.key === 'ArrowDown' && activeIndex >= optionElements.length - 1) {
      renderMoreMatches();
    }
    const last = optionElements.length - 1;
    if (event.key === 'Home') setActiveIndex(0);
    else if (event.key === 'End') setActiveIndex(last);
    else if (event.key === 'ArrowDown') {
      setActiveIndex(activeIndex >= last ? 0 : activeIndex + 1);
    } else {
      setActiveIndex(activeIndex <= 0 ? last : activeIndex - 1);
    }
  });

  input.addEventListener('blur', () => {
    // Small delay to allow mousedown on items to fire
    requestAnimationFrame(() => {
      closeDropdown();
      // Restore selected value display
      updateSelectedDisplay();
    });
  });

  const container = label
    ? createField({ label, control: input, className: 'field-select' })
    : document.createElement('div');
  if (!label) container.className = 'control-block field-select';
  container.id = `${id}-container`;
  if (label) input.replaceWith(wrapper);
  wrapper.appendChild(input);
  wrapper.appendChild(dropdown);
  if (!label) container.appendChild(wrapper);

  // Set initial state
  if (selectedValue) {
    currentSelectedGene = selectedValue;
    updateSelectedDisplay();
  }

  // Store reference for external control
  container._clearSelection = () => {
    currentSelectedGene = '';
    updateSelectedDisplay();
  };

  container._setSelection = (gene) => {
    currentSelectedGene = gene;
    updateSelectedDisplay();
  };

  return container;
}

// =============================================================================
// PAGE COMPARISON SELECTOR (for two-page analyses like DE)
// =============================================================================

/**
 * Create a two-page comparison selector for analyses requiring exactly 2 pages.
 * When there are exactly 2 pages available, shows them directly.
 * When there are more than 2, allows user to select which 2 to compare.
 *
 * @param {Object} options
 * @param {Object[]} options.pages - Array of page objects { id, name, highlightedGroups }
 * @param {string[]} options.selectedIds - Currently selected page IDs (should be 2 or fewer)
 * @param {Function} options.onChange - Callback when selection changes (receives [pageA, pageB])
 * @param {Map} [options.customColors] - Map of pageId -> custom color
 * @returns {HTMLElement}
 */
export function createPageComparisonSelector(options = {}) {
  const {
    pages = [],
    selectedIds = [],
    onChange,
    customColors = new Map(),
    includeDerivedPages = true,
    getCellCountForPageId
  } = options;
  if (!Array.isArray(pages)) {
    throw new TypeError('Page comparison pages must be an array');
  }
  if (!Array.isArray(selectedIds)) {
    throw new TypeError('Page comparison selectedIds must be an array');
  }
  if (selectedIds.length !== 0 && selectedIds.length !== 2) {
    throw new TypeError(
      'Page comparison selectedIds must contain zero or two page IDs'
    );
  }
  if (typeof onChange !== 'function') {
    throw new TypeError('Page comparison onChange must be a function');
  }
  if (typeof getCellCountForPageId !== 'function') {
    throw new TypeError(
      'Page comparison requires getCellCountForPageId()'
    );
  }

  const container = document.createElement('div');
  container.className = 'control-block page-comparison-selector';

  const displayPages = includeDerivedPages
    ? expandPagesWithDerived(pages, { includeRestOf: true })
    : pages;
  const pageById = new Map();
  const cellCountByPageId = new Map();
  for (const page of displayPages) {
    if (
      page === null ||
      typeof page !== 'object' ||
      Array.isArray(page) ||
      typeof page.id !== 'string' ||
      page.id.length === 0 ||
      typeof page.name !== 'string' ||
      page.name.length === 0
    ) {
      throw new TypeError(
        'Page comparison pages require non-empty string id and name fields'
      );
    }
    if (pageById.has(page.id)) {
      throw new TypeError(
        `Page comparison page ID "${page.id}" is duplicated`
      );
    }
    const cellCount = getCellCountForPageId(page.id);
    if (!Number.isSafeInteger(cellCount) || cellCount < 0) {
      throw new TypeError(
        `Page comparison page "${page.id}" cell count must be a non-negative safe integer`
      );
    }
    pageById.set(page.id, page);
    cellCountByPageId.set(page.id, cellCount);
  }
  const selectedIdSet = new Set();
  for (const pageId of selectedIds) {
    if (typeof pageId !== 'string' || pageId.length === 0) {
      throw new TypeError(
        'Page comparison selected IDs must be non-empty strings'
      );
    }
    if (!pageById.has(pageId)) {
      throw new Error(`Page comparison page "${pageId}" was not found`);
    }
    if (selectedIdSet.has(pageId)) {
      throw new TypeError(
        `Page comparison page "${pageId}" is selected more than once`
      );
    }
    if (cellCountByPageId.get(pageId) === 0) {
      throw new RangeError(
        `Page comparison page "${pageId}" has zero cells and cannot be selected`
      );
    }
    selectedIdSet.add(pageId);
  }
  const selectablePages = displayPages.filter(
    page => cellCountByPageId.get(page.id) > 0
  );

  // If fewer than 2 selectable options, show message
  if (selectablePages.length < 2) {
    const notice = document.createElement('p');
    notice.className = 'empty-state';
    notice.textContent = 'Needs two non-empty groups.';
    container.appendChild(notice);
    // The statuses sit in the same wrapping chip row the page selectors use,
    // so a page name reads on one line instead of folding inside a narrow box.
    const statusRow = document.createElement('div');
    statusRow.className = 'analysis-page-tabs';
    container.appendChild(statusRow);
    for (const page of displayPages) {
      const status = document.createElement('span');
      const cellCount = cellCountByPageId.get(page.id);
      status.className = page._derived ? 'chip chip-status chip-derived' : 'chip chip-status';
      status.dataset.pageId = page.id;
      status.setAttribute(
        'aria-disabled',
        cellCount === 0 ? 'true' : 'false'
      );
      status.textContent = `${page.name} (${formatCells(cellCount)})`;
      statusRow.appendChild(status);
    }
    container._getSelection = () => [];
    return container;
  }

  // If exactly 2 base pages and wildcards are disabled, just show comparison display (no selection needed)
  if (!includeDerivedPages && pages.length === 2) {
    const comparisonDisplay = document.createElement('div');
    comparisonDisplay.className = 'de-page-info';
    const color0 = customColors.get(pages[0].id) || getPageColor(0);
    const color1 = customColors.get(pages[1].id) || getPageColor(1);
    const labelEl = document.createElement('span');
    labelEl.className = 'field-label';
    labelEl.textContent = 'Comparing';

    // The compared pages are drawn as the same chip every page selector uses,
    // with the page colour in its swatch.
    const pageChip = (page, color) => {
      const chip = document.createElement('span');
      chip.className = 'chip chip-status';
      const swatch = document.createElement('span');
      swatch.className = 'color-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      StyleManager.setVariable(swatch, '--swatch-color', color);
      const name = document.createElement('span');
      name.className = 'chip-name';
      name.textContent = page.name;
      chip.append(swatch, name);
      return chip;
    };

    const vsEl = document.createElement('span');
    vsEl.className = 'de-vs';
    vsEl.textContent = 'vs';

    comparisonDisplay.append(
      labelEl,
      pageChip(pages[0], color0),
      vsEl,
      pageChip(pages[1], color1)
    );
    container.appendChild(comparisonDisplay);

    // Ensure both pages are selected
    if (onChange && (selectedIds.length !== 2 || selectedIds[0] !== pages[0].id || selectedIds[1] !== pages[1].id)) {
      setTimeout(() => onChange([pages[0].id, pages[1].id]), 0);
    }
    return container;
  }

  // More than 2 pages - show selection dropdowns. The caption names the pair
  // of dropdowns as a group; each dropdown has its own label.
  const caption = document.createElement('span');
  caption.className = 'field-label';
  caption.id = createDomId('page-comparison-caption');
  caption.textContent = 'Pages to compare';
  container.appendChild(caption);

  // Initialize selection with first two if not already selected
  let selectedA = selectedIds.length === 2
    ? selectedIds[0]
    : selectablePages[0].id;
  let selectedB = selectedIds.length === 2
    ? selectedIds[1]
    : selectablePages[1].id;

  const selectRow = document.createElement('div');
  selectRow.className = 'page-comparison-row';
  selectRow.setAttribute('role', 'group');
  selectRow.setAttribute('aria-labelledby', caption.id);

  // Both dropdowns are built once and updated in place, so choosing a page
  // never rebuilds the control the keyboard user is standing on.
  const createPageDropdown = (labelText, onSelect) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'page-comparison-dropdown';

    const select = document.createElement('select');
    select.className = 'obs-select page-select';
    select.id = createDomId('page-comparison-select');

    const dropdownLabel = document.createElement('label');
    dropdownLabel.htmlFor = select.id;
    dropdownLabel.textContent = labelText;
    wrapper.appendChild(dropdownLabel);

    const addOption = (page, parent) => {
      const option = document.createElement('option');
      option.value = page.id;
      const cellCount = cellCountByPageId.get(page.id);
      option.textContent = cellCount === 0
        ? `${page.name} (${formatCells(0)})`
        : page.name;
      parent.appendChild(option);
    };

    const baseGroup = document.createElement('optgroup');
    baseGroup.label = 'Pages';
    pages.forEach((page) => addOption(page, baseGroup));
    select.appendChild(baseGroup);

    if (includeDerivedPages) {
      const derivedGroup = document.createElement('optgroup');
      derivedGroup.label = 'Wildcards';
      displayPages
        .filter(p => p?._derived)
        .forEach((page) => addOption(page, derivedGroup));
      if (derivedGroup.children.length > 0) {
        select.appendChild(derivedGroup);
      }
    }

    select.addEventListener('change', () => {
      onSelect(select.value);
    });

    wrapper.appendChild(select);
    return { wrapper, select };
  };

  const dropdownA = createPageDropdown('Page A', (val) => {
    selectedA = val;
    updateDropdowns();
    if (onChange) onChange([selectedA, selectedB]);
  });
  const dropdownB = createPageDropdown('Page B', (val) => {
    selectedB = val;
    updateDropdowns();
    if (onChange) onChange([selectedA, selectedB]);
  });

  // A page chosen in one dropdown is disabled in the other; empty pages are
  // never selectable.
  const syncDropdown = (select, currentValue, otherValue) => {
    for (const option of select.options) {
      option.selected = option.value === currentValue;
      option.disabled =
        option.value === otherValue ||
        cellCountByPageId.get(option.value) === 0;
    }
  };
  const updateDropdowns = () => {
    syncDropdown(dropdownA.select, selectedA, selectedB);
    syncDropdown(dropdownB.select, selectedB, selectedA);
  };

  const vsSpan = document.createElement('span');
  vsSpan.className = 'de-vs';
  vsSpan.textContent = 'vs';
  selectRow.append(dropdownA.wrapper, vsSpan, dropdownB.wrapper);
  updateDropdowns();
  container.appendChild(selectRow);

  // Trigger initial callback if selection differs from input
  if (onChange && (selectedIds.length !== 2 || selectedIds[0] !== selectedA || selectedIds[1] !== selectedB)) {
    setTimeout(() => onChange([selectedA, selectedB]), 0);
  }

  // Store methods for external access
  container._getSelection = () => [selectedA, selectedB];
  container._updateSelection = (ids) => {
    if (ids.length >= 2) {
      selectedA = ids[0];
      selectedB = ids[1];
      updateDropdowns();
    }
  };

  return container;
}

// =============================================================================
// PLOT TYPE SELECTOR
// =============================================================================

/**
 * Create a simple plot type dropdown - minimal design
 * @param {Object} options
 * @param {string} options.dataType - Current data type
 * @param {string} options.selectedId - Currently selected plot type
 * @param {Function} options.onChange - Callback when selection changes
 * @returns {HTMLElement}
 */
export function createPlotTypeSelector(options = {}) {
  const { dataType = 'categorical', selectedId = '', onChange, id = 'analysis-plot-type' } = options;

  const select = document.createElement('select');
  select.id = id;
  select.className = 'obs-select';

  // Get compatible plot types
  const plotTypes = PlotRegistry.getForDataType(dataType);

  if (plotTypes.length === 0) {
    const noneOption = document.createElement('option');
    noneOption.value = '';
    noneOption.textContent = 'No plots available';
    select.appendChild(noneOption);
    select.disabled = true;
  } else {
    plotTypes.forEach(pt => {
      const option = document.createElement('option');
      option.value = pt.id;
      option.textContent = pt.name;
      if (pt.id === selectedId || (!selectedId && pt === plotTypes[0])) {
        option.selected = true;
      }
      select.appendChild(option);
    });
  }

  select.addEventListener('change', () => {
    if (onChange) onChange(select.value);
  });

  return createField({ label: 'Plot type', control: select, className: 'field-select' });
}
