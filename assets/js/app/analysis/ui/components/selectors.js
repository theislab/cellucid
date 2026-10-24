/**
 * UI Selector Components
 *
 * Core selection components for analysis:
 * - Variable selector (categorical/continuous obs fields)
 * - Gene expression selector (searchable dropdown)
 * - Plot type selector
 */

import { createIntentPrefetcher } from '../../../utils/intent-prefetch.js';
import { NONE_VALUE } from '../../shared/dom-utils.js';
import { createField } from '../../../ui/components/controls.js';
import { createWindowedListbox } from '../../../ui/components/windowed-listbox.js';

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
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', `${id}-dropdown`);
  if (!label) input.setAttribute('aria-label', 'Gene expression');

  // Dropdown list
  const dropdown = document.createElement('div');
  dropdown.id = `${id}-dropdown`;
  dropdown.className = 'dropdown-list';
  dropdown.setAttribute('aria-label', 'Gene expression options');
  dropdown.hidden = true;

  let currentSelectedGene = selectedValue;

  /**
   * One windowed combobox list (ui/components/windowed-listbox.js): entry 0
   * is None, then every gene that matches the search, in gene order. The
   * chosen gene (None when there is none) is marked `selected`.
   */
  /** @type {Object[]} Matches of the current search, in gene order. */
  let matches = [];

  const entryKey = index => (index === 0 ? '' : matches[index - 1].key);

  const geneList = createWindowedListbox({
    input,
    listbox: dropdown,
    idPrefix: `${id}-option`,
    buildOption: index => {
      const item = document.createElement('div');
      item.className = index === 0 ? 'dropdown-item text-tertiary' : 'dropdown-item';
      if (entryKey(index) === currentSelectedGene) item.classList.add('selected');
      item.dataset.optionKey = entryKey(index);
      item.textContent = index === 0 ? 'None' : matches[index - 1].key;
      return item;
    },
    onActive: index => {
      if (genePrefetch !== null && index > 0) genePrefetch.intend(entryKey(index));
    },
  });

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
    geneList.setActive(-1);
  }

  /**
   * Open the list for the search in the input (every gene while the input
   * shows the chosen one), with the chosen gene active wherever it is listed,
   * None otherwise.
   */
  const openDropdown = () => {
    dropdown.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    const filter = input.value;
    const lowerFilter = filter.toLowerCase();
    const isShowingSelection = currentSelectedGene && input.value === currentSelectedGene;
    matches = isShowingSelection
      ? genes
      : genes.filter(g => g.key.toLowerCase().includes(lowerFilter));

    if (matches.length === 0 && filter) {
      const empty = document.createElement('div');
      empty.className = 'dropdown-no-results';
      empty.textContent = 'No matches.';
      empty.setAttribute('role', 'option');
      empty.setAttribute('aria-disabled', 'true');
      empty.setAttribute('aria-selected', 'false');
      geneList.showMessage(empty);
      return;
    }

    geneList.reset(matches.length + 1);
    const currentIndex = currentSelectedGene
      ? matches.findIndex(match => match.key === currentSelectedGene)
      : -1;
    geneList.setActive(currentIndex >= 0 ? currentIndex + 1 : 0);
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

  input.addEventListener('focus', () => {
    // Clear input to allow searching, but remember selection
    if (currentSelectedGene) {
      input.value = '';
    }
    openDropdown();
  });

  input.addEventListener('input', () => {
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
      if (!isOpen() || geneList.getActiveIndex() < 0) return;
      event.preventDefault();
      commit(entryKey(geneList.getActiveIndex()));
      return;
    }
    geneList.handleKeydown(event, { isOpen, open: openDropdown });
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
