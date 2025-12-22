/**
 * UI Selector Components
 *
 * Core selection components for analysis:
 * - Variable selector (categorical/continuous obs fields)
 * - Gene expression selector (searchable dropdown)
 * - Page selector (multi-select with color customization)
 * - Plot type selector
 */

import { getPageColor } from '../../core/plugin-contract.js';
import { NONE_VALUE, getCellCountForPage } from '../../shared/dom-utils.js';
import { formatCount } from '../../shared/formatting.js';
import { deriveRestOfColor } from '../../shared/color-utils.js';
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

  // Search input - styled like obs-select
  const input = document.createElement('input');
  input.type = 'text';
  input.id = `${id}-search`;
  input.className = 'obs-select gene-search-input';
  input.placeholder = 'None';
  input.autocomplete = 'off';

  // Dropdown list
  const dropdown = document.createElement('div');
  dropdown.id = `${id}-dropdown`;
  dropdown.className = 'dropdown-list';

  let currentSelectedGene = selectedValue;

  const updateSelectedDisplay = () => {
    if (currentSelectedGene) {
      input.value = currentSelectedGene;
      input.classList.add('has-selection');
    } else {
      input.value = '';
      input.classList.remove('has-selection');
    }
  };

  const renderOptions = (filter = '') => {
    dropdown.innerHTML = '';

    // Add "None" option at the top to clear selection
    const noneItem = document.createElement('div');
    noneItem.className = 'dropdown-item';
    noneItem.textContent = 'None';
    noneItem.classList.add('text-tertiary');
    noneItem.addEventListener('mousedown', (e) => {
      e.preventDefault();
      currentSelectedGene = '';
      dropdown.style.display = 'none';
      input.blur();
      updateSelectedDisplay();
      if (onChange) onChange('');
    });
    dropdown.appendChild(noneItem);

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
      dropdown.appendChild(empty);
      return;
    }

    filtered.forEach(g => {
      const item = document.createElement('div');
      item.className = 'dropdown-item' + (g.key === currentSelectedGene ? ' selected' : '');
      item.textContent = g.key;

      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        currentSelectedGene = g.key;
        dropdown.style.display = 'none';
        input.blur();
        updateSelectedDisplay();
        if (onChange) onChange(g.key);
      });

      dropdown.appendChild(item);
    });
  };

  input.addEventListener('focus', () => {
    // Clear input to allow searching, but remember selection
    if (currentSelectedGene) {
      input.value = '';
    }
    renderOptions('');
    dropdown.style.display = 'block';
  });

  input.addEventListener('input', () => {
    renderOptions(input.value);
    dropdown.style.display = 'block';
  });

  input.addEventListener('blur', () => {
    // Small delay to allow mousedown on items to fire
    requestAnimationFrame(() => {
      dropdown.style.display = 'none';
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
// PAGE SELECTOR
// =============================================================================

/**
 * Create page selector that MATCHES the highlight module tabs style exactly
 * Uses the same .highlight-page-tab styling with colors, names, counts
 * Includes color picker for each page
 * @param {Object} options
 * @param {Object[]} options.pages - Array of page objects { id, name, highlightedGroups }
 * @param {string[]} options.selectedIds - Currently selected page IDs
 * @param {Function} options.onChange - Callback when selection changes
 * @param {Function} options.onColorChange - Callback when color changes (pageId, color)
 * @param {Map} options.customColors - Map of pageId -> custom color
 * @returns {HTMLElement}
 */
export function createPageSelector(options = {}) {
  const {
    pages = [],
    selectedIds = [],
    onChange,
    onColorChange,
    customColors = new Map(),
    includeDerivedPages = false,
    getCellCountForPageId = null
  } = options;

  const container = document.createElement('div');
  container.className = 'control-block analysis-page-selector';

  const label = document.createElement('label');
  label.textContent = 'Compare pages:';
  container.appendChild(label);

  if (pages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'legend-help';
    empty.textContent = 'Create highlight pages first using the Highlighted Cells section above.';
    container.appendChild(empty);
    return container;
  }

  const helpText = document.createElement('div');
  helpText.className = 'legend-help';
  helpText.textContent = 'Click pages to select. Click color to customize.';
  container.appendChild(helpText);

  // Create tabs container matching highlight module exactly
  const tabsContainer = document.createElement('div');
  tabsContainer.className = 'analysis-page-tabs';

  const baseIndexById = new Map();
  pages.forEach((p, idx) => {
    if (p?.id) baseIndexById.set(p.id, idx);
  });

  const displayPages = includeDerivedPages
    ? expandPagesWithDerived(pages, { includeRestOf: true })
    : pages;

  let selected = new Set(selectedIds);

  const renderTabs = () => {
    tabsContainer.innerHTML = '';

    displayPages.forEach((page, index) => {
      const isSelected = selected.has(page.id);
      const derived = page?._derived || null;
      const baseId = derived?.baseId || page.id;
      const baseIndex = baseIndexById.get(baseId) ?? index;

      const cellCount = typeof getCellCountForPageId === 'function'
        ? getCellCountForPageId(page.id)
        : getCellCountForPage(page);

      const basePage = pages.find((p) => p.id === baseId) || null;
      const baseColor = basePage?.color || customColors.get(baseId) || getPageColor(baseIndex);
      const defaultColor = derived?.kind === 'rest_of'
        ? deriveRestOfColor(baseColor)
        : baseColor;

      const currentColor = page?.color || customColors.get(page.id) || defaultColor;

      const tab = document.createElement('div');
      tab.className = 'analysis-page-tab' +
        (derived ? ' derived' : '') +
        (isSelected ? ' selected' : '');
      tab.dataset.pageId = page.id;

      // Color swatch container (rectangular, matching categorical obs legend style)
      const colorIndicator = document.createElement('span');
      colorIndicator.className = 'analysis-page-color';
      StyleManager.setVariable(colorIndicator, '--analysis-page-color', currentColor);
      colorIndicator.title = 'Click to change color';

      // Color picker input (overlays the swatch)
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.className = 'analysis-page-color-input';
      colorInput.value = currentColor;
      colorInput.title = 'Click to change color';
      colorInput.addEventListener('input', (e) => {
        const newColor = e.target.value;
        customColors.set(page.id, newColor);
        StyleManager.setVariable(colorIndicator, '--analysis-page-color', newColor);
        if (onColorChange) onColorChange(page.id, newColor);
      });
      colorInput.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent tab selection toggle
      });

      // Nest input inside swatch for proper absolute positioning
      colorIndicator.appendChild(colorInput);
      tab.appendChild(colorIndicator);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'analysis-page-name';
      nameSpan.textContent = page.name;
      nameSpan.title = page.name;
      tab.appendChild(nameSpan);

      const countSpan = document.createElement('span');
      countSpan.className = 'analysis-page-count';
      countSpan.textContent = cellCount > 0 ? formatCount(cellCount) : '(0)';
      tab.appendChild(countSpan);

      // Click to toggle selection (but not on color indicator)
      tab.addEventListener('click', () => {
        if (selected.has(page.id)) {
          selected.delete(page.id);
        } else {
          // Ensure derived pages get a stable default color for plotting.
          if (derived && !customColors.has(page.id)) {
            customColors.set(page.id, currentColor);
          }
          selected.add(page.id);
        }
        renderTabs();
        if (onChange) onChange(Array.from(selected));
      });

      tabsContainer.appendChild(tab);
    });

    // Add "Select All" / "Clear" buttons
    const actionsRow = document.createElement('div');
    actionsRow.className = 'analysis-page-actions';

    if (pages.length > 1) {
      const selectAllBtn = document.createElement('button');
      selectAllBtn.type = 'button';
      selectAllBtn.className = 'btn-small';
      const baseIds = pages.map(p => p.id);
      const allBaseSelected = baseIds.length > 0 && baseIds.every(id => selected.has(id));
      selectAllBtn.textContent = (allBaseSelected && selected.size > 0) ? 'Deselect All' : 'Select All';
      selectAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (allBaseSelected) {
          // Clear all (including derived selections) to match user expectations.
          selected.clear();
        } else {
          // Only select base pages to avoid accidentally selecting huge complements.
          for (const id of baseIds) selected.add(id);
        }
        renderTabs();
        if (onChange) onChange(Array.from(selected));
      });
      actionsRow.appendChild(selectAllBtn);
    }

    tabsContainer.appendChild(actionsRow);
  };

  renderTabs();
  container.appendChild(tabsContainer);

  // Store reference for external update
  container._updateSelection = (newIds) => {
    selected = new Set(newIds);
    renderTabs();
  };

  container._getSelection = () => Array.from(selected);

  container._getCustomColors = () => new Map(customColors);

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
    includeDerivedPages = true
  } = options;

  const container = document.createElement('div');
  container.className = 'control-block page-comparison-selector';

  const selectablePages = includeDerivedPages
    ? expandPagesWithDerived(pages, { includeRestOf: true })
    : pages;

  // If fewer than 2 selectable options, show message
  if (selectablePages.length < 2) {
    const notice = document.createElement('div');
    notice.className = 'legend-help';
    notice.textContent = 'Need at least 1 page for comparison. Create a highlight page using the Highlighted Cells section above.';
    container.appendChild(notice);
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
  let selectedA = selectedIds[0] || pages[0]?.id || selectablePages[0]?.id;
  let selectedB = selectedIds[1] ||
    (pages.length > 1 && pages[1].id !== selectedA
      ? pages[1].id
      : selectablePages.find(p => p.id !== selectedA)?.id || selectedA);

  // Ensure selectedB is different from selectedA
  if (selectedB === selectedA) {
    selectedB = selectablePages.find(p => p.id !== selectedA)?.id || selectedA;
  }

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

    const addOption = (page, parent) => {
      const option = document.createElement('option');
      option.value = page.id;
      option.textContent = page.name;
      option.selected = page.id === currentValue;
      // Disable the option if it's selected in the other dropdown
      if (page.id === otherValue) option.disabled = true;
      parent.appendChild(option);
    };

    const baseGroup = document.createElement('optgroup');
    baseGroup.label = 'Pages';
    pages.forEach((page) => addOption(page, baseGroup));
    select.appendChild(baseGroup);

    if (includeDerivedPages) {
      const derivedGroup = document.createElement('optgroup');
      derivedGroup.label = 'Wildcards';
      selectablePages
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
  createPageSelector,
  createPageComparisonSelector,
  createPlotTypeSelector
};
