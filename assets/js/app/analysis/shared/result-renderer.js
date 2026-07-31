/**
 * Result Renderer - Shared result display components
 *
 * Provides reusable UI components for rendering analysis results:
 * - Signature summary statistics
 * - Data tables
 * - Result sections
 * - Plot containers
 * - Gene chips
 *
 * @module shared/result-renderer
 */

import { PlotRegistry } from './plot-registry-utils.js';
import {
  createResultHeader,
  createActionsBar
} from './dom-utils.js';
import {
  mean,
  median,
  std
} from './number-utils.js';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, name) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  return value;
}

function requireElement(value, name) {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.appendChild !== 'function'
  ) {
    throw new TypeError(`${name} must be an appendable element.`);
  }
  return value;
}

function requireKnownKeys(value, keys, name) {
  requirePlainObject(value, name);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${name} contains unknown field "${key}".`);
    }
  }
}

function requireFiniteNumber(value, name) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
  return value;
}

function requireError(error, context) {
  if (error instanceof Error) {
    return error;
  }
  return new TypeError(`${context} threw a non-Error value.`, {
    cause: error
  });
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

// =============================================================================
// STATISTICS DISPLAY
// =============================================================================

/**
 * Render signature summary statistics table
 *
 * @param {HTMLElement} container - Container to render into
 * @param {Object[]} pageData - Array of { pageName, values }
 * @returns {HTMLDivElement} The stats section
 */
export function renderSignatureSummaryStats(container, pageData) {
  requireElement(container, 'Signature statistics container');
  if (!Array.isArray(pageData)) {
    throw new TypeError('Signature statistics pageData must be an array.');
  }
  const section = document.createElement('div');
  section.className = 'signature-stats-section';
  section.innerHTML = '<h5>Summary Statistics</h5>';

  const table = document.createElement('table');
  table.className = 'signature-stats-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const col of ['Page', 'Mean', 'Median', 'Std', 'Cells']) {
    const th = document.createElement('th');
    th.textContent = col;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  for (const [index, pd] of pageData.entries()) {
    requirePlainObject(pd, `Signature statistics page ${index}`);
    requireNonEmptyString(
      pd.pageName,
      `Signature statistics page ${index} pageName`
    );
    if (!Array.isArray(pd.values) && !ArrayBuffer.isView(pd.values)) {
      throw new TypeError(
        `Signature statistics page ${index} values must be an array or typed array.`
      );
    }
    const values = Array.from(pd.values);
    for (const [valueIndex, value] of values.entries()) {
      requireFiniteNumber(
        value,
        `Signature statistics page ${index} value ${valueIndex}`
      );
    }
    const n = values.length;

    if (n === 0) {
      const row = document.createElement('tr');
      const pageCell = document.createElement('td');
      pageCell.textContent = pd.pageName;
      row.appendChild(pageCell);

      const emptyCell = document.createElement('td');
      emptyCell.colSpan = 4;
      emptyCell.textContent = 'No valid values';
      row.appendChild(emptyCell);

      tbody.appendChild(row);
      continue;
    }

    const meanVal = mean(values);
    const medianVal = median(values);
    const stdVal = std(values);
    const row = document.createElement('tr');

    const pageCell = document.createElement('td');
    pageCell.textContent = pd.pageName;
    row.appendChild(pageCell);

    const meanCell = document.createElement('td');
    meanCell.textContent = meanVal.toFixed(3);
    row.appendChild(meanCell);

    const medianCell = document.createElement('td');
    medianCell.textContent = medianVal.toFixed(3);
    row.appendChild(medianCell);

    const stdCell = document.createElement('td');
    stdCell.textContent = stdVal.toFixed(3);
    row.appendChild(stdCell);

    const countCell = document.createElement('td');
    countCell.textContent = n.toLocaleString();
    row.appendChild(countCell);

    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  section.appendChild(table);
  container.appendChild(section);
  return section;
}

// =============================================================================
// DATA TABLES
// =============================================================================

/**
 * Render a data table with headers and rows
 *
 * @param {HTMLElement} container - Container to render into
 * @param {Object} options
 * @param {string} [options.title] - Table title
 * @param {string[]} options.headers - Column headers
 * @param {(string|number)[][]} options.rows - Table rows (2D array)
 * @param {string} [options.className] - Additional CSS class
 * @param {Object[]} [options.columns] - Column definitions { key, header, className?, format? }
 * @returns {HTMLElement} The table container
 */
export function renderDataTable(container, options) {
  requireElement(container, 'Result table container');
  requireKnownKeys(
    options,
    ['className', 'columns', 'headers', 'rows', 'title'],
    'Result table options'
  );
  const { title, headers, rows, className, columns } = options;
  if (title !== undefined) {
    requireNonEmptyString(title, 'Result table title');
  }
  if (className !== undefined && typeof className !== 'string') {
    throw new TypeError('Result table className must be a string.');
  }
  if (!Array.isArray(rows)) {
    throw new TypeError('Result table rows must be an array.');
  }
  const ownsHeaders = Object.hasOwn(options, 'headers');
  const ownsColumns = Object.hasOwn(options, 'columns');
  if (ownsHeaders === ownsColumns) {
    throw new TypeError(
      'Result table requires exactly one of headers or columns.'
    );
  }
  let headerList;
  if (ownsHeaders) {
    if (!Array.isArray(headers) || headers.length === 0) {
      throw new TypeError(
        'Result table headers must be a non-empty array.'
      );
    }
    headerList = headers.map((header, index) =>
      requireNonEmptyString(header, `Result table header ${index}`)
    );
    for (const [rowIndex, row] of rows.entries()) {
      if (!Array.isArray(row) || row.length !== headerList.length) {
        throw new TypeError(
          `Result table row ${rowIndex} must contain exactly ${headerList.length} cells.`
        );
      }
    }
  } else {
    if (!Array.isArray(columns) || columns.length === 0) {
      throw new TypeError(
        'Result table columns must be a non-empty array.'
      );
    }
    const columnKeys = new Set();
    for (const [index, column] of columns.entries()) {
      requireKnownKeys(
        column,
        ['className', 'format', 'header', 'key'],
        `Result table column ${index}`
      );
      requireNonEmptyString(
        column.key,
        `Result table column ${index} key`
      );
      requireNonEmptyString(
        column.header,
        `Result table column ${index} header`
      );
      if (columnKeys.has(column.key)) {
        throw new TypeError(
          `Result table column key "${column.key}" is duplicated.`
        );
      }
      columnKeys.add(column.key);
      if (
        column.className !== undefined &&
        typeof column.className !== 'string'
      ) {
        throw new TypeError(
          `Result table column ${index} className must be a string.`
        );
      }
      if (
        column.format !== undefined &&
        typeof column.format !== 'function'
      ) {
        throw new TypeError(
          `Result table column ${index} format must be a function.`
        );
      }
    }
    for (const [rowIndex, row] of rows.entries()) {
      requirePlainObject(row, `Result table row ${rowIndex}`);
      for (const column of columns) {
        if (!Object.hasOwn(row, column.key)) {
          throw new TypeError(
            `Result table row ${rowIndex} is missing "${column.key}".`
          );
        }
      }
    }
    headerList = columns.map(column => column.header);
  }

  const wrapper = document.createElement('div');
  wrapper.className = className === undefined
    ? 'result-table-container'
    : `result-table-container ${className}`.trim();

  if (title !== undefined) {
    const heading = document.createElement('h5');
    heading.textContent = title;
    wrapper.appendChild(heading);
  }

  const table = document.createElement('table');
  table.className = 'result-data-table';

  // Header
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  for (const h of headerList) {
    const th = document.createElement('th');
    th.textContent = h;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');

    if (ownsColumns) {
      // Use column definitions
      for (const col of columns) {
        const td = document.createElement('td');
        if (col.className !== undefined) td.className = col.className;
        const value = row[col.key];
        const displayValue = col.format === undefined
          ? value
          : col.format(value);
        if (
          typeof displayValue !== 'string' &&
          !Number.isFinite(displayValue)
        ) {
          throw new TypeError(
            `Result table value for "${col.key}" must render as a string or finite number.`
          );
        }
        td.textContent = displayValue;
        tr.appendChild(td);
      }
    } else {
      // Simple array rows
      for (const cell of row) {
        if (typeof cell !== 'string' && !Number.isFinite(cell)) {
          throw new TypeError(
            'Result table cells must be strings or finite numbers.'
          );
        }
        const td = document.createElement('td');
        td.textContent = cell;
        tr.appendChild(td);
      }
    }

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  wrapper.appendChild(table);
  container.appendChild(wrapper);
  return wrapper;
}

// =============================================================================
// RESULT SECTIONS
// =============================================================================

/**
 * Render a complete result section with header, content, and actions
 *
 * @param {HTMLElement} container - Container to render into
 * @param {Object} options
 * @param {string} options.title - Section title
 * @param {string} [options.subtitle] - Section subtitle
 * @param {Function} options.renderContent - Function to render content (receives contentDiv)
 * @param {Object[]} [options.actions] - Action buttons { text, onClick, className? }
 * @returns {HTMLDivElement} The section element
 */
export function renderResultSection(container, options) {
  requireElement(container, 'Result section container');
  requireKnownKeys(
    options,
    ['actions', 'renderContent', 'subtitle', 'title'],
    'Result section options'
  );
  const { title, subtitle, renderContent, actions } = options;
  requireNonEmptyString(title, 'Result section title');
  if (subtitle !== undefined) {
    requireNonEmptyString(subtitle, 'Result section subtitle');
  }
  if (typeof renderContent !== 'function') {
    throw new TypeError(
      'Result section renderContent must be a function.'
    );
  }
  if (actions !== undefined && !Array.isArray(actions)) {
    throw new TypeError('Result section actions must be an array.');
  }

  const section = document.createElement('div');
  section.className = 'result-section';

  // Header
  const header = createResultHeader(title, subtitle);
  section.appendChild(header);

  // Content
  const content = document.createElement('div');
  content.className = 'result-section-content';
  renderContent(content);
  section.appendChild(content);

  // Actions
  if (actions !== undefined && actions.length > 0) {
    const actionsBar = createActionsBar(actions);
    section.appendChild(actionsBar);
  }

  container.appendChild(section);
  return section;
}

// =============================================================================
// PLOT CONTAINERS
// =============================================================================

/**
 * Create a plot container with loading/error states
 *
 * @param {HTMLElement} container - Parent container
 * @param {Object} options
 * @param {string} options.id - Container ID
 * @param {string} [options.className] - Additional CSS class
 * @returns {Object} { element, showLoading, showError, render }
 */
export function createPlotContainer(container, options = {}) {
  requireElement(container, 'Plot container owner');
  requireKnownKeys(options, ['className', 'id'], 'Plot container options');
  const { id, className } = options;
  requireNonEmptyString(id, 'Plot container id');
  if (className !== undefined && typeof className !== 'string') {
    throw new TypeError('Plot container className must be a string.');
  }

  const plotDiv = document.createElement('div');
  plotDiv.className = className === undefined
    ? 'plot-container'
    : `plot-container ${className}`.trim();
  plotDiv.id = id;

  container.appendChild(plotDiv);

  return {
    element: plotDiv,

    showLoading() {
      plotDiv.textContent = '';
      const loading = document.createElement('div');
      loading.className = 'plot-loading';
      const spinner = document.createElement('div');
      spinner.className = 'spinner';
      loading.appendChild(spinner);
      plotDiv.appendChild(loading);
    },

    showError(message) {
      requireNonEmptyString(message, 'Plot error message');
      plotDiv.textContent = '';
      const el = document.createElement('div');
      el.className = 'plot-error';
      el.textContent = `Failed to render plot: ${message}`;
      plotDiv.appendChild(el);
    },

    showEmpty(message = 'No data to display') {
      requireNonEmptyString(message, 'Plot empty-state message');
      plotDiv.textContent = '';
      const el = document.createElement('div');
      el.className = 'plot-empty';
      el.textContent = message;
      plotDiv.appendChild(el);
    },

    async render(plotType, data, plotOptions, layoutEngine) {
      requireNonEmptyString(plotType, 'Plot type');
      requirePlainObject(plotOptions, 'Plot options');
      const plotDef = PlotRegistry.get(plotType);
      if (plotDef === null) {
        const error = new RangeError(`Unknown plot type: ${plotType}`);
        this.showError(error.message);
        throw error;
      }
      if (typeof plotDef.render !== 'function') {
        const error = new TypeError(
          `Plot "${plotType}" must provide render().`
        );
        this.showError(error.message);
        throw error;
      }

      try {
        await plotDef.render(data, plotOptions, plotDiv, layoutEngine);
      } catch (error) {
        const exactError = requireError(error, `Plot "${plotType}" renderer`);
        this.showError(exactError.message);
        throw exactError;
      }
    }
  };
}

// =============================================================================
// GENE LIST DISPLAY
// =============================================================================

/**
 * Render a gene list as chips
 *
 * @param {HTMLElement} container - Container to render into
 * @param {string[]} genes - Gene names
 * @param {Object} [options] - Options
 * @param {string} [options.title] - Section title
 * @returns {HTMLDivElement} The section element
 */
export function renderGeneChips(container, genes, options = {}) {
  requireElement(container, 'Gene chips container');
  if (!Array.isArray(genes)) {
    throw new TypeError('Gene chips genes must be an array.');
  }
  requireKnownKeys(options, ['title'], 'Gene chips options');
  if (options.title !== undefined) {
    requireNonEmptyString(options.title, 'Gene chips title');
  }
  const uniqueGenes = new Set();
  for (const [index, gene] of genes.entries()) {
    requireNonEmptyString(gene, `Gene chips gene ${index}`);
    if (uniqueGenes.has(gene)) {
      throw new TypeError(`Gene chips contains duplicate gene "${gene}".`);
    }
    uniqueGenes.add(gene);
  }
  const section = document.createElement('div');
  section.className = 'gene-chips-section';

  if (options.title !== undefined) {
    const heading = document.createElement('h5');
    heading.textContent = `${options.title} (${genes.length})`;
    section.appendChild(heading);
  }

  const chipsDiv = document.createElement('div');
  chipsDiv.className = 'gene-chips';
  for (const gene of genes) {
    const chip = document.createElement('span');
    chip.className = 'gene-chip';
    chip.textContent = gene;
    chipsDiv.appendChild(chip);
  }

  section.appendChild(chipsDiv);
  container.appendChild(section);
  return section;
}

// =============================================================================
// COMPLETE RESULT RENDERERS
// =============================================================================

/**
 * Render complete signature analysis results
 *
 * @param {HTMLElement} container - Container to render into
 * @param {Object} result - Signature result object
 */
export async function renderSignatureResults(container, result) {
  if (arguments.length !== 2) {
    throw new TypeError(
      'renderSignatureResults requires exactly container and result.'
    );
  }
  requireElement(container, 'Signature result container');
  requireKnownKeys(
    result,
    ['data', 'metadata', 'options', 'plotType', 'subtitle', 'title'],
    'Signature result'
  );
  requireNonEmptyString(result.title, 'Signature result title');
  if (result.subtitle !== undefined) {
    requireNonEmptyString(result.subtitle, 'Signature result subtitle');
  }
  requireNonEmptyString(result.plotType, 'Signature result plotType');
  requirePlainObject(result.options, 'Signature result options');
  if (!Array.isArray(result.data)) {
    throw new TypeError('Signature result data must be an array.');
  }
  if (result.metadata !== undefined) {
    requirePlainObject(result.metadata, 'Signature result metadata');
    if (
      Object.hasOwn(result.metadata, 'genes') &&
      !Array.isArray(result.metadata.genes)
    ) {
      throw new TypeError('Signature result genes must be an array.');
    }
  }
  container.innerHTML = '';
  container.classList.remove('hidden');

  // Header
  const header = createResultHeader(
    result.title,
    result.subtitle
  );
  container.appendChild(header);

  // Plot
  const plotContainer = createPlotContainer(container, {
    id: 'signature-analysis-plot',
    className: 'signature-plot-container'
  });

  plotContainer.showLoading();

  await plotContainer.render(result.plotType, result.data, result.options);

  // Summary stats
  renderSignatureSummaryStats(container, result.data);

  // Gene list
  if (
    result.metadata !== undefined &&
    Object.hasOwn(result.metadata, 'genes')
  ) {
    renderGeneChips(container, result.metadata.genes, {
      title: 'Genes in Signature'
    });
  }
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default {
  // Stats display
  renderSignatureSummaryStats,
  // Tables
  renderDataTable,
  // Sections
  renderResultSection,
  // Plot containers
  createPlotContainer,
  // Gene display
  renderGeneChips,
  // Complete renderers
  renderSignatureResults
};
