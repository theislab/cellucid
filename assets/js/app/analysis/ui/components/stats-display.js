/**
 * Statistics Display Components
 *
 * UI components for displaying statistical analysis results:
 * - Summary statistics table
 * - Statistical annotations panel with significance tests
 */

import { runStatisticalTests, formatStatisticalResult } from '../../stats/statistical-tests.js';
import { categoryCounts } from '../../shared/category-counts.js';
import { computeStats } from '../../shared/number-utils.js';
import { getComputeManager } from '../../compute/compute-manager.js';
import { OperationType } from '../../compute/operations.js';

// =============================================================================
// LARGE PAGES: STATISTICS ON THE ANALYSIS WORKERS
// =============================================================================

/**
 * Finite values (over all pages) from which the summary and the tests of
 * continuous pages are computed by an analysis worker before they are shown:
 * their order statistics and tests are linear-time but still take tens of
 * milliseconds per million values on the thread that draws the interface.
 */
const WORKER_MIN_VALUES = 200_000;

/** @type {WeakMap<ArrayLike<number>, ReturnType<typeof computeStats>>} */
const summaryCache = new WeakMap();

/**
 * Test results per first page-values array: the arrays, names and data type
 * they were computed for, and the results.
 * @type {WeakMap<ArrayLike<unknown>, {arrays: ArrayLike<unknown>[], names: string[], dataType: string, results: Object[]}>}
 */
const testsCache = new WeakMap();

const CONTINUOUS_TYPES = new Set(['continuous', 'continuous_obs', 'gene_expression']);

function cachedTests(pageData, dataType) {
  if (!Array.isArray(pageData) || pageData.length === 0) return null;
  const entry = testsCache.get(pageData[0].values);
  if (
    entry === undefined ||
    entry.dataType !== dataType ||
    entry.arrays.length !== pageData.length ||
    entry.arrays.some((values, i) => values !== pageData[i].values) ||
    entry.names.some((name, i) => name !== pageData[i].pageName)
  ) {
    return null;
  }
  return entry.results;
}

function typedCopy(values) {
  return ArrayBuffer.isView(values) ? values : Float64Array.from(values);
}

/**
 * Compute the summary statistics and the statistical tests of large
 * continuous pages on the analysis workers, so that `renderSummaryStats` and
 * `renderStatisticalAnnotations` only read them. Each is the same function
 * wherever it runs (`computeStats`, `runStatisticalTests`), so the numbers are
 * the ones this thread would compute. Categorical pages need nothing: their
 * counts are taken as the page values are built.
 *
 * @param {Object[]} pageData
 * @param {string} dataType
 */
export async function preparePageStatistics(pageData, dataType) {
  if (!Array.isArray(pageData) || !CONTINUOUS_TYPES.has(dataType)) return;
  let total = 0;
  for (const pd of pageData) total += pd.values.length;
  if (total < WORKER_MIN_VALUES) return;
  const manager = getComputeManager();
  await manager.init();
  const work = [];
  for (const pd of pageData) {
    if (summaryCache.has(pd.values)) continue;
    work.push(manager.execute(
      OperationType.COMPUTE_SUMMARY_STATISTICS,
      { values: typedCopy(pd.values) },
      { transfer: !ArrayBuffer.isView(pd.values) }
    ).then(({ _compute, ...stats }) => summaryCache.set(pd.values, stats)));
  }
  if (pageData.length >= 2 && cachedTests(pageData, dataType) === null) {
    const pages = pageData.map(pd => ({ pageName: pd.pageName, values: typedCopy(pd.values) }));
    work.push(manager.execute(
      OperationType.COMPUTE_STATISTICAL_TESTS,
      { pages, dataType },
      { transfer: false }
    ).then(({ results }) => testsCache.set(pageData[0].values, {
      arrays: pageData.map(pd => pd.values),
      names: pageData.map(pd => pd.pageName),
      dataType,
      results
    })));
  }
  await Promise.all(work);
}

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
    // Show category counts per page, read from each page's counts (taken once
    // per values array).
    const pageCounts = pageData.map(pd => categoryCounts(pd.values));
    const allCategories = new Set();
    for (const counts of pageCounts) {
      for (const val of counts.keys()) {
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

      for (let pageIndex = 0; pageIndex < pageData.length; pageIndex++) {
        const pd = pageData[pageIndex];
        const count = pageCounts[pageIndex].get(cat) ?? 0;
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
    // Per-page statistics: computed by an analysis worker beforehand for a
    // large page (preparePageStatistics), on this thread otherwise.
    const statsByPage = pageData.map(pd => {
      const stats = summaryCache.get(pd.values) ?? computeStats(pd.values);
      if (stats.count === 0) {
        return { count: 0, mean: null, median: null, min: null, max: null, std: null };
      }
      return stats;
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
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Select 2+ pages for statistics.';
    container.appendChild(empty);
    return;
  }

  // Run statistical tests (already run by an analysis worker for large pages).
  const results = cachedTests(pageData, dataType) ?? runStatisticalTests(pageData, dataType);

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
    const isUnavailable = result.significance === 'N/A';
    significance.className = `analysis-test-significance ${
      result.significance === 'ns' || isUnavailable ? 'not-significant' : 'significant'
    }`;
    significance.textContent = result.significance;
    significance.title = isUnavailable
      ? 'Statistical significance is not available'
      : result.significance === 'ns'
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
    if (formatted.method) {
      addRow('Method', formatted.method);
    }
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
