/**
 * Statistics Display Components
 *
 * UI components for displaying statistical analysis results:
 * - Summary statistics table
 * - Statistical annotations panel with significance tests
 */

import { runStatisticalTests, formatStatisticalResult } from '../../stats/statistical-tests.js';
import {
  filterFiniteNumbers,
  mean as computeMean,
  std as computeStd,
  median as computeMedian
} from '../../shared/number-utils.js';

// =============================================================================
// SUMMARY STATISTICS
// =============================================================================

/**
 * Render summary statistics table
 * @param {HTMLElement} container - Container element
 * @param {Object[]} pageData - Page data with statistics
 * @param {string} variableName - Variable name
 */
export function renderSummaryStats(container, pageData, variableName) {
  container.innerHTML = '';

  if (!pageData || pageData.length === 0) return;

  const isCategorial = pageData[0]?.variableInfo?.kind === 'category';

  const table = document.createElement('table');
  table.className = 'analysis-stats-table';

  if (isCategorial) {
    // Show category counts per page
    const allCategories = new Set();
    for (const pd of pageData) {
      for (const val of pd.values) {
        allCategories.add(val);
      }
    }
    const categories = Array.from(allCategories).slice(0, 10); // Limit to top 10

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const variableHeader = document.createElement('th');
    variableHeader.textContent = variableName ?? '';
    headerRow.appendChild(variableHeader);

    for (const pd of pageData) {
      const th = document.createElement('th');
      th.textContent = pd.pageName ?? '';
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const cat of categories) {
      const row = document.createElement('tr');
      const labelCell = document.createElement('td');
      labelCell.textContent = cat ?? '';
      row.appendChild(labelCell);

      for (const pd of pageData) {
        const count = pd.values.filter(v => v === cat).length;
        const pct = pd.cellCount > 0 ? ((count / pd.cellCount) * 100).toFixed(1) : '0';
        const td = document.createElement('td');
        td.textContent = `${count} (${pct}%)`;
        row.appendChild(td);
      }
      tbody.appendChild(row);
    }
    if (allCategories.size > 10) {
      const moreRow = document.createElement('tr');
      const moreCell = document.createElement('td');
      moreCell.colSpan = pageData.length + 1;
      moreCell.className = 'analysis-stats-more';
      moreCell.textContent = `... and ${allCategories.size - 10} more categories`;
      moreRow.appendChild(moreCell);
      tbody.appendChild(moreRow);
    }
    table.appendChild(tbody);
  } else {
    // Show continuous stats using centralized utilities
    const statsByPage = pageData.map(pd => {
      const vals = filterFiniteNumbers(pd.values);
      const n = vals.length;
      if (n === 0) {
        return { count: 0, mean: null, median: null, min: null, max: null, std: null };
      }

      // Sort once for min/max
      const sorted = [...vals].sort((a, b) => a - b);

      return {
        count: n,
        mean: computeMean(vals),
        median: computeMedian(vals),
        min: sorted[0],
        max: sorted[n - 1],
        std: computeStd(vals)
      };
    });

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const firstHeader = document.createElement('th');
    firstHeader.textContent = 'Statistic';
    headerRow.appendChild(firstHeader);

    for (const pd of pageData) {
      const th = document.createElement('th');
      th.textContent = pd.pageName ?? '';
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const stats = ['count', 'mean', 'median', 'min', 'max', 'std'];
    const statLabels = { count: 'Count', mean: 'Mean', median: 'Median', min: 'Min', max: 'Max', std: 'Std Dev' };

    for (const stat of stats) {
      const row = document.createElement('tr');
      const labelCell = document.createElement('td');
      labelCell.textContent = statLabels[stat] ?? stat;
      row.appendChild(labelCell);

      for (const pageStats of statsByPage) {
        const cell = document.createElement('td');
        if (pageStats?.count > 0) {
          const raw = pageStats[stat];
          cell.textContent = stat === 'count' ? String(raw) : raw.toFixed(2);
        } else {
          cell.textContent = '-';
        }
        row.appendChild(cell);
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
  }

  container.appendChild(table);
}

// =============================================================================
// STATISTICAL ANNOTATIONS
// =============================================================================

/**
 * Render statistical annotations panel
 * Shows appropriate statistical tests based on data type and number of groups
 * @param {HTMLElement} container - Container element
 * @param {Object[]} pageData - Page data with values
 * @param {string} dataType - 'categorical_obs', 'continuous_obs', or 'gene_expression'
 */
export function renderStatisticalAnnotations(container, pageData, dataType) {
  container.innerHTML = '';

  if (!pageData || pageData.length < 2) {
    const help = document.createElement('div');
    help.className = 'analysis-annotations-help';
    help.textContent = 'Select at least 2 pages to see statistical comparisons.';
    container.appendChild(help);
    return;
  }

  // Run statistical tests
  const results = runStatisticalTests(pageData, dataType);

  // Create results display
  const resultsDiv = document.createElement('div');
  resultsDiv.className = 'analysis-annotations-results';

  for (const result of results) {
    const formatted = formatStatisticalResult(result);

    const testCard = document.createElement('div');
    testCard.className = 'analysis-test-card';

    // Test name and significance
    const headerRow = document.createElement('div');
    headerRow.className = 'analysis-test-header';

    const testName = document.createElement('span');
    testName.className = 'analysis-test-name';
    testName.textContent = formatted.test;

    const significance = document.createElement('span');
    significance.className = `analysis-test-significance ${result.significance === 'ns' ? 'not-significant' : 'significant'}`;
    significance.textContent = result.significance;
    significance.title = result.significance === 'ns'
      ? 'Not significant (p ≥ 0.05)'
      : result.significance === '*' ? 'p < 0.05'
      : result.significance === '**' ? 'p < 0.01'
      : 'p < 0.001';

    headerRow.appendChild(testName);
    headerRow.appendChild(significance);
    testCard.appendChild(headerRow);

    // Statistics table
    const statsTable = document.createElement('table');
    statsTable.className = 'analysis-test-stats';

    const addRow = (label, value, highlight = false) => {
      const row = document.createElement('tr');
      if (highlight) row.className = 'highlight';
      const labelCell = document.createElement('td');
      labelCell.className = 'stat-label';
      labelCell.textContent = label ?? '';

      const valueCell = document.createElement('td');
      valueCell.className = 'stat-value';
      valueCell.textContent = value ?? '';

      row.appendChild(labelCell);
      row.appendChild(valueCell);
      statsTable.appendChild(row);
    };

    addRow('Statistic', formatted.statistic);
    addRow('p-value', formatted.pValue, true);
    if (formatted.effectSize !== 'N/A') {
      addRow('Effect Size', formatted.effectSize);
    }

    testCard.appendChild(statsTable);

    // Interpretation
    const interpretation = document.createElement('div');
    interpretation.className = 'analysis-test-interpretation';
    interpretation.textContent = formatted.interpretation;
    testCard.appendChild(interpretation);

    resultsDiv.appendChild(testCard);
  }

  container.appendChild(resultsDiv);

  // Add legend
  const legend = document.createElement('div');
  legend.className = 'analysis-annotations-legend';
  legend.innerHTML = `
    <span class="legend-item"><span class="sig-marker sig-ns">ns</span> not significant</span>
    <span class="legend-item"><span class="sig-marker sig-1">*</span> p &lt; 0.05</span>
    <span class="legend-item"><span class="sig-marker sig-2">**</span> p &lt; 0.01</span>
    <span class="legend-item"><span class="sig-marker sig-3">***</span> p &lt; 0.001</span>
  `;
  container.appendChild(legend);
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  renderSummaryStats,
  renderStatisticalAnnotations
};
