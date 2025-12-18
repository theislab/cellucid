/**
 * Statistics Display Components
 *
 * UI components for displaying statistical analysis results:
 * - Summary statistics table
 * - Statistical annotations panel with significance tests
 */

import { runStatisticalTests, formatStatisticalResult } from '../../stats/statistical-tests.js';
import { filterFiniteNumbers } from '../../shared/number-utils.js';

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
    headerRow.innerHTML = `<th>${variableName}</th>` + pageData.map(pd => `<th>${pd.pageName}</th>`).join('');
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const cat of categories) {
      const row = document.createElement('tr');
      row.innerHTML = `<td>${cat}</td>` + pageData.map(pd => {
        const count = pd.values.filter(v => v === cat).length;
        const pct = pd.cellCount > 0 ? ((count / pd.cellCount) * 100).toFixed(1) : '0';
        return `<td>${count} (${pct}%)</td>`;
      }).join('');
      tbody.appendChild(row);
    }
    if (allCategories.size > 10) {
      const moreRow = document.createElement('tr');
      moreRow.innerHTML = `<td colspan="${pageData.length + 1}" style="font-style: italic; color: var(--viewer-ink-muted);">... and ${allCategories.size - 10} more categories</td>`;
      tbody.appendChild(moreRow);
    }
    table.appendChild(tbody);
  } else {
    // Show continuous stats
    const statsByPage = pageData.map(pd => {
      const vals = filterFiniteNumbers(pd.values);
      const n = vals.length;
      if (n === 0) {
        return { count: 0, mean: null, median: null, min: null, max: null, std: null };
      }

      // Mean/std (Welford)
      let mean = 0;
      let m2 = 0;
      for (let i = 0; i < n; i++) {
        const x = vals[i];
        const delta = x - mean;
        mean += delta / (i + 1);
        const delta2 = x - mean;
        m2 += delta * delta2;
      }
      const variance = m2 / n;
      const std = Math.sqrt(variance);

      // Median/min/max (sorted copy)
      const sorted = [...vals].sort((a, b) => a - b);
      const mid = Math.floor(n / 2);
      const median = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

      return {
        count: n,
        mean,
        median,
        min: sorted[0],
        max: sorted[n - 1],
        std
      };
    });

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headerRow.innerHTML = '<th>Statistic</th>' + pageData.map(pd => `<th>${pd.pageName}</th>`).join('');
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const stats = ['count', 'mean', 'median', 'min', 'max', 'std'];
    const statLabels = { count: 'Count', mean: 'Mean', median: 'Median', min: 'Min', max: 'Max', std: 'Std Dev' };

    for (const stat of stats) {
      const row = document.createElement('tr');
      row.innerHTML = `<td>${statLabels[stat]}</td>` + statsByPage.map(pageStats => {
        let value = '-';
        if (pageStats?.count > 0) {
          const raw = pageStats[stat];
          value = stat === 'count' ? raw : raw.toFixed(2);
        }
        return `<td>${value}</td>`;
      }).join('');
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
      row.innerHTML = `<td class="stat-label">${label}</td><td class="stat-value">${value}</td>`;
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
