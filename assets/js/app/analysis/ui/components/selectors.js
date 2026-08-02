/**
 * UI Selector Components
 *
 * Core selection components for analysis:
 * - Variable selector (categorical/continuous obs fields)
 * - Gene expression selector (searchable dropdown)
 * - Page comparison selector (exactly two pages, for DE)
 * - Plot type selector
 */

import { getPageColor } from '../../core/plugin-contract.js';
import { NONE_VALUE } from '../../shared/dom-utils.js';
import { expandPagesWithDerived } from '../../shared/page-derivation-utils.js';
import { StyleManager } from '../../../../utils/style-manager.js';

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
    id = ''
  } = options;

  const container = document.createElement('div');
  container.className = 'field-select';

  // Only add label if provided
  if (label) {
    const labelEl = document.createElement('label');
    if (id) labelEl.htmlFor = id;
    labelEl.textContent = label;
    container.appendChild(labelEl);
  }

  const select = document.createElement('select');
  select.className = 'obs-select';
  if (id) select.id = id;

  // Add "None" option - exactly matching filtering section
  const noneOption = document.createElement('option');
  noneOption.value = NONE_VALUE;
  noneOption.textContent = 'None';
  noneOption.selected = !selectedValue || selectedValue === NONE_VALUE;
  select.appendChild(noneOption);

  // Add variable options
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

  container.appendChild(select);

  return container;
}

// =============================================================================
// GENE EXPRESSION SELECTOR
// =============================================================================

/**
 * Create a gene expression searchable dropdown - exactly matches the filtering section pattern
 * @param {Object} options
 * @param {Object[]} options.genes - Array of gene variable info objects
 * @param {Function} options.onChange - Callback when selection changes
 * @param {string} options.selectedValue - Currently selected gene
 * @param {string} options.label - Label text
 * @param {string} options.id - Element ID
 * @returns {HTMLElement}
 */
export function createGeneExpressionSelector(options = {}) {
  const {
    genes = [],
    onChange,
    selectedValue = '',
    label = 'Gene expression:',
    id = 'analysis-gene-expression'
  } = options;

  const container = document.createElement('div');
  container.className = 'field-select';
  container.id = `${id}-container`;

  // Only add label if provided
  if (label) {
    const labelEl = document.createElement('label');
    labelEl.htmlFor = `${id}-search`;
    labelEl.textContent = label;
    container.appendChild(labelEl);
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'searchable-dropdown';

  // Search input - styled like obs-select.
  // The list used to be driven by `mousedown` alone: no Enter, no Escape, no
  // arrow keys and no combobox semantics, so picking a gene for an analysis was
  // impossible without a pointer.
  const input = document.createElement('input');
  input.type = 'text';
  input.id = `${id}-search`;
  input.className = 'obs-select gene-search-input';
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

  const isOpen = () => dropdown.style.display === 'block';

  const setActiveIndex = (nextIndex) => {
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
    active.scrollIntoView({ block: 'nearest' });
  };

  const commit = (gene) => {
    currentSelectedGene = gene;
    closeDropdown();
    updateSelectedDisplay();
    if (onChange) onChange(gene);
  };

  function closeDropdown() {
    dropdown.style.display = 'none';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
  }

  const openDropdown = () => {
    dropdown.style.display = 'block';
    input.setAttribute('aria-expanded', 'true');
  };

  const renderOptions = (filter = '') => {
    dropdown.innerHTML = '';
    optionElements = [];
    activeIndex = -1;

    const addOption = (key, text, extraClass) => {
      const item = document.createElement('div');
      item.className = `dropdown-item${extraClass ? ` ${extraClass}` : ''}`;
      item.id = `${id}-option-${optionElements.length}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      item.dataset.optionKey = key;
      item.textContent = text;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        commit(key);
      });
      dropdown.appendChild(item);
      optionElements.push(item);
      return item;
    };

    // "None" clears the selection.
    addOption('', 'None', 'text-tertiary');

    const lowerFilter = filter.toLowerCase();
    // Don't filter if the input shows the current selection
    const isShowingSelection = currentSelectedGene && input.value === currentSelectedGene;
    const filtered = genes.filter(g =>
      isShowingSelection || g.key.toLowerCase().includes(lowerFilter)
    ).slice(0, 50);

    if (filtered.length === 0 && filter) {
      const empty = document.createElement('div');
      empty.className = 'dropdown-item';
      empty.textContent = 'No matches';
      empty.classList.add('text-tertiary');
      empty.style.fontStyle = 'italic';
      empty.setAttribute('role', 'option');
      empty.setAttribute('aria-disabled', 'true');
      empty.setAttribute('aria-selected', 'false');
      dropdown.appendChild(empty);
      return;
    }

    for (const g of filtered) {
      addOption(g.key, g.key);
    }
    const currentIndex = optionElements.findIndex(
      item => item.dataset.optionKey === currentSelectedGene
    );
    setActiveIndex(currentIndex >= 0 ? currentIndex : 0);
  };

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

  wrapper.appendChild(input);
  wrapper.appendChild(dropdown);
  container.appendChild(wrapper);

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
    const notice = document.createElement('div');
    notice.className = 'legend-help';
    notice.textContent =
      'Differential expression requires two non-empty cell groups.';
    container.appendChild(notice);
    for (const page of displayPages) {
      const status = document.createElement('div');
      const cellCount = cellCountByPageId.get(page.id);
      status.className = 'analysis-page-tab' +
        (page._derived ? ' derived' : '') +
        (cellCount === 0 ? ' disabled' : '');
      status.dataset.pageId = page.id;
      status.setAttribute(
        'aria-disabled',
        cellCount === 0 ? 'true' : 'false'
      );
      status.textContent = `${page.name} (${cellCount.toLocaleString()} cells)`;
      container.appendChild(status);
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
    const labelEl = document.createElement('div');
    labelEl.className = 'de-comparison-label';
    labelEl.textContent = 'Comparing:';

    const badgeA = document.createElement('div');
    badgeA.className = 'de-page-badge page-a';
    badgeA.textContent = pages[0].name;
    StyleManager.setVariable(badgeA, '--de-page-color', color0);

    const vsEl = document.createElement('span');
    vsEl.className = 'de-vs';
    vsEl.textContent = 'vs';

    const badgeB = document.createElement('div');
    badgeB.className = 'de-page-badge page-b';
    badgeB.textContent = pages[1].name;
    StyleManager.setVariable(badgeB, '--de-page-color', color1);

    comparisonDisplay.append(labelEl, badgeA, vsEl, badgeB);
    container.appendChild(comparisonDisplay);

    // Ensure both pages are selected
    if (onChange && (selectedIds.length !== 2 || selectedIds[0] !== pages[0].id || selectedIds[1] !== pages[1].id)) {
      setTimeout(() => onChange([pages[0].id, pages[1].id]), 0);
    }
    return container;
  }

  // More than 2 pages - show selection dropdowns
  const label = document.createElement('label');
  label.textContent = 'Select pages to compare:';
  container.appendChild(label);

  // Initialize selection with first two if not already selected
  let selectedA = selectedIds.length === 2
    ? selectedIds[0]
    : selectablePages[0].id;
  let selectedB = selectedIds.length === 2
    ? selectedIds[1]
    : selectablePages[1].id;

  const selectRow = document.createElement('div');
  selectRow.className = 'page-comparison-row';

  // Create Page A dropdown
  const createPageDropdown = (currentValue, otherValue, onSelect, labelText) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'page-comparison-dropdown';

    const dropdownLabel = document.createElement('span');
    dropdownLabel.className = 'page-comparison-label';
    dropdownLabel.textContent = labelText;
    wrapper.appendChild(dropdownLabel);

    const select = document.createElement('select');
    select.className = 'obs-select page-select';
    // `page-comparison-label` used to be a <span>, which named nothing: both
    // comparison dropdowns reached the accessibility tree anonymous.
    select.setAttribute('aria-label', labelText.replace(/:$/, ''));

    const addOption = (page, parent) => {
      const option = document.createElement('option');
      option.value = page.id;
      const cellCount = cellCountByPageId.get(page.id);
      option.textContent = cellCount === 0
        ? `${page.name} (0 cells)`
        : page.name;
      option.selected = page.id === currentValue;
      // Disable the option if it's selected in the other dropdown
      if (page.id === otherValue || cellCount === 0) {
        option.disabled = true;
      }
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
    return wrapper;
  };

  const updateDropdowns = () => {
    selectRow.innerHTML = '';

    const dropdownA = createPageDropdown(
      selectedA,
      selectedB,
      (val) => {
        selectedA = val;
        updateDropdowns();
        if (onChange) onChange([selectedA, selectedB]);
      },
      'Page A:'
    );

    const vsSpan = document.createElement('span');
    vsSpan.className = 'de-vs';
    vsSpan.textContent = 'vs';

    const dropdownB = createPageDropdown(
      selectedB,
      selectedA,
      (val) => {
        selectedB = val;
        updateDropdowns();
        if (onChange) onChange([selectedA, selectedB]);
      },
      'Page B:'
    );

    selectRow.appendChild(dropdownA);
    selectRow.appendChild(vsSpan);
    selectRow.appendChild(dropdownB);
  };

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

  const container = document.createElement('div');
  container.className = 'field-select';

  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = 'Plot type:';
  container.appendChild(label);

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

  container.appendChild(select);

  return container;
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  PlotRegistry,
  createVariableSelector,
  createGeneExpressionSelector,
  createPageComparisonSelector,
  createPlotTypeSelector
};
