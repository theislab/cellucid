/**
 * Shared DOM Utilities for Analysis UI Components
 *
 * Common constants, helper functions, and DOM manipulation utilities
 * used across multiple UI modules. Centralizes shared logic to ensure
 * DRY principles and consistent behavior.
 *
 * NOTE: Formatting functions (formatNumber, formatPValue, formatCount, etc.)
 * are centralized in shared/formatting.js. This file re-exports them
 * for backward compatibility.
 *
 * @module shared/dom-utils
 */

// =============================================================================
// FORMATTING - Re-exported from shared/formatting.js for backward compatibility
// =============================================================================

export {
  formatNumber,
  formatCount,
  formatPValue,
  getSignificanceMarker,
  getSignificanceClass
} from './formatting.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Sentinel value for "None" selection in dropdowns
 */
export const NONE_VALUE = '-1';

// =============================================================================
// PAGE DATA UTILITIES
// =============================================================================

/**
 * Get cell count for a highlight page
 * @param {Object} page - Page object with highlightedGroups
 * @returns {number} Total unique cell count
 */
export function getCellCountForPage(page) {
  if (!page.highlightedGroups) return 0;
  const indices = new Set();
  for (const group of page.highlightedGroups) {
    if (group.enabled === false) continue;
    if (group.cellIndices) {
      for (const idx of group.cellIndices) {
        indices.add(idx);
      }
    }
  }
  return indices.size;
}

// =============================================================================
// DOM ELEMENT FACTORIES
// =============================================================================

/**
 * Create a labeled container element
 * @param {string} className - Container CSS class
 * @param {string} labelText - Label text
 * @param {string} [labelFor] - ID for label 'for' attribute
 * @returns {Object} { container, label }
 */
export function createLabeledContainer(className, labelText, labelFor = '') {
  const container = document.createElement('div');
  container.className = className;

  const label = document.createElement('label');
  if (labelFor) label.htmlFor = labelFor;
  label.textContent = labelText;
  container.appendChild(label);

  return { container, label };
}

/**
 * Create a select element with options
 * @param {Object} options
 * @param {string} options.id - Element ID
 * @param {string} options.className - CSS class
 * @param {Array<{value: string, label: string}>} options.options - Select options
 * @param {string} options.selectedValue - Currently selected value
 * @param {Function} options.onChange - Change handler
 * @returns {HTMLSelectElement}
 */
export function createSelect({ id, className, options, selectedValue, onChange }) {
  const select = document.createElement('select');
  if (id) select.id = id;
  if (className) select.className = className;

  for (const opt of options) {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.value === selectedValue) {
      option.selected = true;
    }
    select.appendChild(option);
  }

  if (onChange) {
    select.addEventListener('change', () => onChange(select.value));
  }

  return select;
}

/**
 * Create a button element
 * @param {Object} options
 * @param {string} options.text - Button text
 * @param {string} options.className - CSS class
 * @param {string} [options.title] - Button title/tooltip
 * @param {Function} options.onClick - Click handler
 * @returns {HTMLButtonElement}
 */
export function createButton({ text, className, title, onClick }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = text;
  if (title) btn.title = title;
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

/**
 * Create a checkbox with label
 * @param {Object} options
 * @param {string} options.id - Element ID
 * @param {string} options.label - Label text
 * @param {boolean} options.checked - Initial checked state
 * @param {string} [options.title] - Tooltip text
 * @param {Function} options.onChange - Change handler
 * @returns {Object} { container, checkbox, label }
 */
export function createCheckbox({ id, label, checked, title, onChange }) {
  const container = document.createElement('div');
  container.className = 'checkbox-row';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = id;
  checkbox.checked = checked;

  const labelEl = document.createElement('label');
  labelEl.htmlFor = id;
  labelEl.textContent = label;
  if (title) labelEl.title = title;

  if (onChange) {
    checkbox.addEventListener('change', () => onChange(checkbox.checked));
  }

  container.appendChild(checkbox);
  container.appendChild(labelEl);

  return { container, checkbox, label: labelEl };
}

/**
 * Create a range slider with value display
 * @param {Object} options
 * @param {string} options.id - Element ID
 * @param {number} options.min - Minimum value
 * @param {number} options.max - Maximum value
 * @param {number} options.step - Step increment
 * @param {number} options.value - Current value
 * @param {Function} options.onChange - Change handler (called on 'change')
 * @param {Function} [options.onInput] - Input handler (called on 'input')
 * @returns {Object} { container, input, valueDisplay }
 */
export function createRangeSlider({ id, min, max, step, value, onChange, onInput }) {
  const container = document.createElement('div');
  container.className = 'slider-row';

  const input = document.createElement('input');
  input.type = 'range';
  input.id = id;
  input.min = min;
  input.max = max;
  input.step = step;
  input.value = value;

  const valueDisplay = document.createElement('span');
  valueDisplay.className = 'slider-value';
  valueDisplay.textContent = value;

  input.addEventListener('input', () => {
    valueDisplay.textContent = input.value;
    if (onInput) onInput(parseFloat(input.value));
  });

  input.addEventListener('change', () => {
    if (onChange) onChange(parseFloat(input.value));
  });

  container.appendChild(input);
  container.appendChild(valueDisplay);

  return { container, input, valueDisplay };
}

// =============================================================================
// FORM UTILITIES (for Analysis UIs)
// =============================================================================

/**
 * Create a form input row with label and input element
 * @param {string} labelText - Label text
 * @param {HTMLElement} inputEl - Input element to include
 * @param {Object} [options] - Additional options
 * @param {string} [options.className] - Additional CSS class
 * @param {string} [options.description] - Help text below input
 * @returns {HTMLDivElement}
 */
export function createFormRow(labelText, inputEl, options = {}) {
  const row = document.createElement('div');
  row.className = `analysis-input-row ${options.className || ''}`.trim();

  const label = document.createElement('label');
  label.textContent = labelText;
  row.appendChild(label);

  row.appendChild(inputEl);

  if (options.description) {
    const desc = document.createElement('div');
    desc.className = 'input-description';
    desc.textContent = options.description;
    row.appendChild(desc);
  }

  return row;
}

/**
 * Create a form select element with consistent styling
 * @param {string} name - Select name attribute
 * @param {Array<{value: string|number, label: string, description?: string, selected?: boolean}>} options - Select options
 * @param {Object} [config] - Additional configuration
 * @param {string} [config.className] - CSS class (default: 'obs-select')
 * @param {Function} [config.onChange] - Change handler
 * @param {boolean} [config.showDescription] - Show description below select (default: true if any option has description)
 * @returns {HTMLElement} Select element or wrapper with description
 */
export function createFormSelect(name, options, config = {}) {
  const hasDescriptions = options.some(opt => opt.description);
  const showDescription = config.showDescription ?? hasDescriptions;

  const select = document.createElement('select');
  select.className = config.className || 'obs-select';
  select.name = name;

  // Build options map for description lookup
  const optionsMap = new Map();

  for (const opt of options) {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.selected) option.selected = true;
    select.appendChild(option);
    optionsMap.set(String(opt.value), opt);
  }

  // If no descriptions, return simple select
  if (!showDescription) {
    if (config.onChange) {
      select.addEventListener('change', (e) => config.onChange(e.target.value));
    }
    return select;
  }

  // Create wrapper with description
  const wrapper = document.createElement('div');
  wrapper.className = 'form-select-with-description';
  wrapper.appendChild(select);

  const descEl = document.createElement('div');
  descEl.className = 'form-select-description';
  wrapper.appendChild(descEl);

  // Update description based on selection
  const updateDescription = () => {
    const opt = optionsMap.get(select.value);
    descEl.textContent = opt?.description || '';
  };

  select.addEventListener('change', () => {
    updateDescription();
    if (config.onChange) config.onChange(select.value);
  });

  // Set initial description
  updateDescription();

  return wrapper;
}

/**
 * Create a form textarea element
 * @param {Object} options
 * @param {string} [options.name] - Textarea name
 * @param {string} [options.className] - CSS class
 * @param {string} [options.placeholder] - Placeholder text
 * @param {number} [options.rows] - Number of rows (default: 4)
 * @param {string} [options.value] - Initial value
 * @param {Function} [options.onInput] - Input handler
 * @returns {HTMLTextAreaElement}
 */
export function createFormTextarea({ name, className, placeholder, rows = 4, value = '', onInput }) {
  const textarea = document.createElement('textarea');
  if (name) textarea.name = name;
  textarea.className = className || 'analysis-form-textarea';
  if (placeholder) textarea.placeholder = placeholder;
  textarea.rows = rows;
  textarea.value = value;

  if (onInput) {
    textarea.addEventListener('input', (e) => onInput(e.target.value));
  }

  return textarea;
}

/**
 * Create a form button with consistent styling
 * @param {string} text - Button text
 * @param {Function} onClick - Click handler
 * @param {Object} [options] - Additional options
 * @param {string} [options.className] - CSS class (default: 'btn-small')
 * @param {string} [options.type] - Button type (default: 'button')
 * @param {boolean} [options.disabled] - Initial disabled state
 * @returns {HTMLButtonElement}
 */
export function createFormButton(text, onClick, options = {}) {
  const btn = document.createElement('button');
  btn.type = options.type || 'button';
  btn.className = options.className || 'btn-small';
  btn.textContent = text;
  if (options.disabled) btn.disabled = true;
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

/**
 * Create a notice/warning message element
 * @param {string} message - Message text
 * @param {Object} [options] - Additional options
 * @param {string} [options.icon] - Icon character (default: '⚠')
 * @param {string} [options.className] - CSS class
 * @returns {HTMLDivElement}
 */
export function createNotice(message, options = {}) {
  const notice = document.createElement('div');
  notice.className = options.className || 'analysis-requirement-notice';
  notice.innerHTML = `
    <span class="notice-icon">${options.icon || '⚠'}</span>
    <span>${message}</span>
  `;
  return notice;
}

/**
 * Create an analysis result header
 * @param {string} title - Title text
 * @param {string} [subtitle] - Optional subtitle
 * @returns {HTMLDivElement}
 */
export function createResultHeader(title, subtitle) {
  const header = document.createElement('div');
  header.className = 'result-header';
  header.innerHTML = `
    <h3>${title}</h3>
    ${subtitle ? `<p class="result-subtitle">${subtitle}</p>` : ''}
  `;
  return header;
}

/**
 * Create an actions bar with buttons
 * @param {Array<{text: string, onClick: Function, className?: string}>} buttons - Button definitions
 * @returns {HTMLDivElement}
 */
export function createActionsBar(buttons) {
  const bar = document.createElement('div');
  bar.className = 'result-actions-bar';

  for (const btnDef of buttons) {
    const btn = createFormButton(btnDef.text, btnDef.onClick, {
      className: btnDef.className || 'btn-small'
    });
    bar.appendChild(btn);
  }

  return bar;
}

// =============================================================================
// STATS TABLE RENDERING
// =============================================================================

/**
 * Render a generic statistics table from key-value data
 *
 * @param {Object} stats - Statistics object with key-value pairs
 * @param {Object} [options] - Rendering options
 * @param {Object} [options.labels] - Custom labels for keys (e.g., { std: 'Std Dev' })
 * @param {Function} [options.formatValue] - Custom value formatter (default: 2 decimal places)
 * @param {string} [options.className] - Additional CSS class
 * @param {string[]} [options.order] - Order of keys to display (defaults to Object.keys order)
 * @param {string[]} [options.highlight] - Keys to highlight
 * @returns {HTMLTableElement}
 *
 * @example
 * const stats = { count: 100, mean: 5.23, std: 1.45, pValue: 0.003 };
 * const table = renderStatsTable(stats, {
 *   labels: { std: 'Std Dev', pValue: 'p-value' },
 *   highlight: ['pValue']
 * });
 * container.appendChild(table);
 */
export function renderStatsTable(stats, options = {}) {
  const {
    labels = {},
    formatValue = (v) => typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : String(v),
    className = '',
    order = Object.keys(stats),
    highlight = []
  } = options;

  const table = document.createElement('table');
  table.className = `analysis-stats-table ${className}`.trim();

  const tbody = document.createElement('tbody');

  for (const key of order) {
    if (!(key in stats)) continue;

    const value = stats[key];
    const label = labels[key] || key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1');

    const row = document.createElement('tr');
    if (highlight.includes(key)) {
      row.className = 'highlight';
    }

    const labelCell = document.createElement('td');
    labelCell.className = 'stat-label';
    labelCell.textContent = label;

    const valueCell = document.createElement('td');
    valueCell.className = 'stat-value';
    valueCell.textContent = value === null || value === undefined ? '-' : formatValue(value);

    row.appendChild(labelCell);
    row.appendChild(valueCell);
    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  return table;
}

/**
 * Render a comparison stats table with multiple columns
 *
 * @param {Object[]} groups - Array of { name: string, stats: Object }
 * @param {Object} [options] - Rendering options
 * @param {Object} [options.labels] - Custom labels for stat keys
 * @param {Function} [options.formatValue] - Custom value formatter
 * @param {string[]} [options.statOrder] - Order of stats to display
 * @param {string} [options.className] - Additional CSS class
 * @returns {HTMLTableElement}
 *
 * @example
 * const groups = [
 *   { name: 'Group A', stats: { count: 50, mean: 5.2 } },
 *   { name: 'Group B', stats: { count: 45, mean: 4.8 } }
 * ];
 * const table = renderComparisonStatsTable(groups, {
 *   labels: { count: 'N' },
 *   statOrder: ['count', 'mean']
 * });
 */
export function renderComparisonStatsTable(groups, options = {}) {
  const {
    labels = {},
    formatValue = (v) => typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : String(v),
    statOrder,
    className = ''
  } = options;

  // Determine stat keys from first group if not specified
  const keys = statOrder || (groups[0]?.stats ? Object.keys(groups[0].stats) : []);

  const table = document.createElement('table');
  table.className = `analysis-stats-table ${className}`.trim();

  // Header row
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  headerRow.innerHTML = '<th>Statistic</th>' + groups.map(g => `<th>${g.name}</th>`).join('');
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body rows
  const tbody = document.createElement('tbody');
  for (const key of keys) {
    const label = labels[key] || key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1');

    const row = document.createElement('tr');
    const labelCell = document.createElement('td');
    labelCell.textContent = label;
    row.appendChild(labelCell);

    for (const group of groups) {
      const valueCell = document.createElement('td');
      const value = group.stats?.[key];
      valueCell.textContent = value === null || value === undefined ? '-' : formatValue(value);
      row.appendChild(valueCell);
    }

    tbody.appendChild(row);
  }
  table.appendChild(tbody);

  return table;
}

// =============================================================================
// DOM MANIPULATION UTILITIES
// =============================================================================

/**
 * Clear all children from an element
 * @param {HTMLElement} element - Element to clear
 */
export function clearElement(element) {
  element.innerHTML = '';
}

/**
 * Add multiple classes to an element
 * @param {HTMLElement} element - Target element
 * @param {...string} classNames - Classes to add
 */
export function addClass(element, ...classNames) {
  element.classList.add(...classNames.filter(Boolean));
}

/**
 * Remove multiple classes from an element
 * @param {HTMLElement} element - Target element
 * @param {...string} classNames - Classes to remove
 */
export function removeClass(element, ...classNames) {
  element.classList.remove(...classNames.filter(Boolean));
}

/**
 * Toggle a class on an element
 * @param {HTMLElement} element - Target element
 * @param {string} className - Class to toggle
 * @param {boolean} [force] - Force add (true) or remove (false)
 */
export function toggleClass(element, className, force) {
  element.classList.toggle(className, force);
}

/**
 * Set multiple styles on an element
 * @param {HTMLElement} element - Target element
 * @param {Object} styles - Style key-value pairs
 */
export function setStyles(element, styles) {
  for (const [key, value] of Object.entries(styles)) {
    element.style[key] = value;
  }
}

// =============================================================================
// EVENT UTILITIES
// =============================================================================

/**
 * Add event listener with automatic cleanup
 * @param {HTMLElement} element - Target element
 * @param {string} event - Event name
 * @param {Function} handler - Event handler
 * @returns {Function} Cleanup function to remove listener
 */
export function addListener(element, event, handler) {
  element.addEventListener(event, handler);
  return () => element.removeEventListener(event, handler);
}

/**
 * Create a debounced version of a function
 * @param {Function} fn - Function to debounce
 * @param {number} delay - Delay in milliseconds
 * @returns {Function} Debounced function
 */
export function debounce(fn, delay) {
  let timeoutId;
  return function (...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Create a throttled version of a function
 * @param {Function} fn - Function to throttle
 * @param {number} limit - Minimum time between calls in milliseconds
 * @returns {Function} Throttled function
 */
export function throttle(fn, limit) {
  let inThrottle;
  return function (...args) {
    if (!inThrottle) {
      fn.apply(this, args);
      inThrottle = true;
      setTimeout(() => { inThrottle = false; }, limit);
    }
  };
}

// =============================================================================
// DEFAULT EXPORT (for backward compatibility)
// =============================================================================

// Import formatting functions for use in default export
import {
  formatNumber as _formatNumber,
  formatCount as _formatCount,
  formatPValue as _formatPValue,
  getSignificanceMarker as _getSignificanceMarker,
  getSignificanceClass as _getSignificanceClass
} from './formatting.js';

export default {
  // Constants
  NONE_VALUE,
  // Formatting (from shared/formatting.js)
  formatCount: _formatCount,
  formatNumber: _formatNumber,
  formatPValue: _formatPValue,
  getSignificanceMarker: _getSignificanceMarker,
  getSignificanceClass: _getSignificanceClass,
  // Page utilities
  getCellCountForPage,
  // Element factories
  createLabeledContainer,
  createSelect,
  createButton,
  createCheckbox,
  createRangeSlider,
  // Form utilities (for Analysis UIs)
  createFormRow,
  createFormSelect,
  createFormTextarea,
  createFormButton,
  createNotice,
  createResultHeader,
  createActionsBar,
  // Stats table rendering
  renderStatsTable,
  renderComparisonStatsTable,
  // DOM manipulation
  clearElement,
  addClass,
  removeClass,
  toggleClass,
  setStyles,
  // Events
  addListener,
  debounce,
  throttle
};
