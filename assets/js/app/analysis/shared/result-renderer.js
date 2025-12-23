/**
 * Result Renderer - Shared result display components
 *
 * Provides reusable UI components for rendering analysis results:
 * - Statistics grids
 * - Data tables
 * - Result sections
 * - Plot containers
 * - Export actions
 *
 * @module shared/result-renderer
 */

import { PlotRegistry } from './plot-registry-utils.js';
import {
  createResultHeader,
  createActionsBar,
  createFormButton
} from './dom-utils.js';
import {
  filterFiniteNumbers,
  mean,
  median,
  std
} from './number-utils.js';

// =============================================================================
// STATISTICS DISPLAY
// =============================================================================

/**
 * Render a statistics grid
 *
 * @param {HTMLElement} container - Container to render into
 * @param {Object[]} stats - Array of { label, value, className?, format? }
 * @param {Object} [options] - Additional options
 * @param {string} [options.className] - Additional CSS class for grid
 * @param {number} [options.columns] - Number of columns (default: auto)
 * @returns {HTMLDivElement} The grid element
 *
 * @example
 * renderStatsGrid(container, [
 *   { label: 'Total Genes', value: 500 },
 *   { label: 'Significant', value: 42, className: 'stat-highlight' },
 *   { label: 'Upregulated', value: 25, className: 'stat-up' },
 *   { label: 'Downregulated', value: 17, className: 'stat-down' }
 * ]);
 */
export function renderStatsGrid(container, stats, options = {}) {
  const grid = document.createElement('div');
  grid.className = `stats-grid ${options.className || ''}`.trim();

  if (options.columns) {
    grid.style.gridTemplateColumns = `repeat(${options.columns}, 1fr)`;
  }

  for (const stat of stats) {
    const item = document.createElement('div');
    item.className = `stat-item ${stat.className || ''}`.trim();

    // Format value if formatter provided
    const displayValue = stat.format ? stat.format(stat.value) : stat.value;
    const valueEl = document.createElement('span');
    valueEl.className = 'stat-value';
    valueEl.textContent = displayValue ?? '';

    const labelEl = document.createElement('span');
    labelEl.className = 'stat-label';
    labelEl.textContent = stat.label ?? '';

    item.appendChild(valueEl);
    item.appendChild(labelEl);

    if (stat.title) {
      item.title = stat.title;
    }

    grid.appendChild(item);
  }

  container.appendChild(grid);
  return grid;
}

/**
 * Render DE summary statistics
 *
 * @param {HTMLElement} container - Container to render into
 * @param {Object} summary - DE summary { totalGenes, significantGenes, upregulated, downregulated }
 * @returns {HTMLDivElement} The stats element
 */
export function renderDESummaryStats(container, summary) {
  return renderStatsGrid(container, [
    { label: 'Genes Tested', value: summary.totalGenes },
    { label: 'Significant (FDR < 0.05)', value: summary.significantGenes, className: 'significant' },
    { label: 'Upregulated', value: summary.upregulated, className: 'up' },
    { label: 'Downregulated', value: summary.downregulated, className: 'down' }
  ], { className: 'de-summary-stats' });
}

/**
 * Render signature summary statistics table
 *
 * @param {HTMLElement} container - Container to render into
 * @param {Object[]} pageData - Array of { pageName, values }
 * @returns {HTMLDivElement} The stats section
 */
export function renderSignatureSummaryStats(container, pageData) {
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

  for (const pd of pageData) {
    const values = filterFiniteNumbers(pd.values);
    const n = values.length;

    if (n === 0) {
      const row = document.createElement('tr');
      const pageCell = document.createElement('td');
      pageCell.textContent = pd.pageName ?? '';
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
    pageCell.textContent = pd.pageName ?? '';
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
  const { title, headers, rows, className, columns } = options;

  const wrapper = document.createElement('div');
  wrapper.className = `result-table-container ${className || ''}`.trim();

  if (title) {
    const heading = document.createElement('h5');
    heading.textContent = title;
    wrapper.appendChild(heading);
  }

  const table = document.createElement('table');
  table.className = 'result-data-table';

  // Header
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  const headerList = columns ? columns.map(c => c.header) : headers;
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

    if (columns) {
      // Use column definitions
      for (const col of columns) {
        const td = document.createElement('td');
        if (col.className) td.className = col.className;
        const value = typeof row === 'object' ? row[col.key] : row;
        td.textContent = col.format ? col.format(value) : value;
        tr.appendChild(td);
      }
    } else {
      // Simple array rows
      for (const cell of row) {
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

/**
 * Render top DE genes table
 *
 * @param {HTMLElement} container - Container to render into
 * @param {Object[]} results - DE results array
 * @param {Object} [options] - Options
 * @param {number} [options.maxRows=15] - Maximum rows to show
 * @param {number} [options.pValueThreshold=0.05] - P-value filter
 * @returns {HTMLElement|null} The table container or null if no results
 */
export function renderDEGenesTable(container, results, options = {}) {
  const { maxRows = 15, pValueThreshold = 0.05 } = options;

  const topGenes = results
    .filter(r => r.adjustedPValue < pValueThreshold)
    .sort((a, b) => Math.abs(b.log2FoldChange) - Math.abs(a.log2FoldChange))
    .slice(0, maxRows);

  if (topGenes.length === 0) return null;

  const wrapper = document.createElement('div');
  wrapper.className = 'de-genes-table-container';
  wrapper.innerHTML = '<h5>Top Differentially Expressed Genes</h5>';

  const table = document.createElement('table');
  table.className = 'de-genes-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const col of ['Gene', 'Log2 FC', 'Adj. p-value', 'Direction']) {
    const th = document.createElement('th');
    th.textContent = col;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const g of topGenes) {
    const row = document.createElement('tr');
    row.className = g.log2FoldChange > 0 ? 'up' : 'down';

    const geneCell = document.createElement('td');
    geneCell.className = 'gene-name';
    geneCell.textContent = g.gene ?? '';
    row.appendChild(geneCell);

    const fcCell = document.createElement('td');
    fcCell.className = 'log2fc';
    fcCell.textContent = Number.isFinite(g.log2FoldChange) ? g.log2FoldChange.toFixed(3) : 'N/A';
    row.appendChild(fcCell);

    const pCell = document.createElement('td');
    pCell.className = 'pvalue';
    pCell.textContent = Number.isFinite(g.adjustedPValue) ? g.adjustedPValue.toExponential(2) : 'N/A';
    row.appendChild(pCell);

    const dirCell = document.createElement('td');
    dirCell.className = 'direction';
    dirCell.textContent = g.log2FoldChange > 0 ? '↑' : '↓';
    row.appendChild(dirCell);

    tbody.appendChild(row);
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
  const { title, subtitle, renderContent, actions } = options;

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
  if (actions && actions.length > 0) {
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
  const { id, className } = options;

  const plotDiv = document.createElement('div');
  plotDiv.className = `plot-container ${className || ''}`.trim();
  if (id) plotDiv.id = id;

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
      plotDiv.textContent = '';
      const el = document.createElement('div');
      el.className = 'plot-error';
      el.textContent = `Failed to render plot: ${message ?? ''}`;
      plotDiv.appendChild(el);
    },

    showEmpty(message = 'No data to display') {
      plotDiv.textContent = '';
      const el = document.createElement('div');
      el.className = 'plot-empty';
      el.textContent = message ?? '';
      plotDiv.appendChild(el);
    },

    async render(plotType, data, plotOptions, layoutEngine) {
      const plotDef = PlotRegistry.get(plotType);
      if (!plotDef) {
        this.showError(`Unknown plot type: ${plotType}`);
        return;
      }

      try {
        await plotDef.render(data, plotOptions, plotDiv, layoutEngine);
      } catch (err) {
        console.error('[PlotContainer] Render error:', err);
        this.showError(err.message);
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
  const section = document.createElement('div');
  section.className = 'gene-chips-section';

  if (options.title) {
    const heading = document.createElement('h5');
    heading.textContent = `${options.title} (${genes.length})`;
    section.appendChild(heading);
  }

  const chipsDiv = document.createElement('div');
  chipsDiv.className = 'gene-chips';
  for (const gene of genes) {
    const chip = document.createElement('span');
    chip.className = 'gene-chip';
    chip.textContent = gene ?? '';
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
 * Render complete DE analysis results
 *
 * @param {HTMLElement} container - Container to render into
 * @param {Object} result - DE result object
 * @param {Object} callbacks - { onExportPNG, onExportCSV }
 */
export async function renderDEResults(container, result, callbacks = {}) {
  container.innerHTML = '';
  container.classList.remove('hidden');

  // Header
  const header = createResultHeader(
    result.title || 'Differential Expression',
    result.subtitle
  );
  container.appendChild(header);

  // Plot
  const plotContainer = createPlotContainer(container, {
    id: 'de-analysis-plot',
    className: 'de-plot-container'
  });

  plotContainer.showLoading();

  try {
    await plotContainer.render(result.plotType, result.data, result.options);
  } catch (err) {
    console.error('[renderDEResults] Plot error:', err);
  }

  // Summary stats
  if (result.data?.summary) {
    renderDESummaryStats(container, result.data.summary);
  }

  // Top genes table
  if (result.data?.results?.length > 0) {
    renderDEGenesTable(container, result.data.results);
  }
}

/**
 * Render complete signature analysis results
 *
 * @param {HTMLElement} container - Container to render into
 * @param {Object} result - Signature result object
 * @param {Object} callbacks - { onExportPNG, onExportCSV }
 */
export async function renderSignatureResults(container, result, callbacks = {}) {
  container.innerHTML = '';
  container.classList.remove('hidden');

  // Header
  const header = createResultHeader(
    result.title || 'Gene Signature Score',
    result.subtitle
  );
  container.appendChild(header);

  // Plot
  const plotContainer = createPlotContainer(container, {
    id: 'signature-analysis-plot',
    className: 'signature-plot-container'
  });

  plotContainer.showLoading();

  try {
    await plotContainer.render(result.plotType, result.data, result.options);
  } catch (err) {
    console.error('[renderSignatureResults] Plot error:', err);
  }

  // Summary stats
  if (result.data) {
    renderSignatureSummaryStats(container, result.data);
  }

  // Gene list
  if (result.metadata?.genes) {
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
  renderStatsGrid,
  renderDESummaryStats,
  renderSignatureSummaryStats,
  // Tables
  renderDataTable,
  renderDEGenesTable,
  // Sections
  renderResultSection,
  // Plot containers
  createPlotContainer,
  // Gene display
  renderGeneChips,
  // Complete renderers
  renderDEResults,
  renderSignatureResults
};
