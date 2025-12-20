/**
 * Analysis Utilities - Common functions for Analysis UI components
 *
 * Centralizes shared patterns to ensure DRY code:
 * - Loading state management
 * - Page requirements validation
 * - CSV export utilities
 * - Form value extraction
 * - Statistics calculation helpers
 *
 * @module shared/analysis-utils
 */

import {
  isFiniteNumber,
  filterFiniteNumbers,
  mean as computeMean,
  std as computeStd,
  median as computeMedian
} from './number-utils.js';

// =============================================================================
// LOADING STATE MANAGEMENT
// =============================================================================

/**
 * Run an analysis with standard loading state management
 *
 * Handles:
 * - Setting _isLoading flag on component
 * - Disabling/enabling run button
 * - Showing loading notification
 * - Completing/failing notification
 *
 * @param {Object} options
 * @param {Object} options.component - The UI component (must have _isLoading, _notifications)
 * @param {HTMLButtonElement} [options.runButton] - The run button to disable
 * @param {string} options.loadingMessage - Loading notification message
 * @param {string} options.successMessage - Success notification message
 * @param {Function} options.analysisFunction - The async analysis function
 * @param {string} [options.category='calculation'] - Notification category
 * @returns {Promise<any>} Analysis result or null if already loading
 *
 * @example
 * const result = await runAnalysisWithLoadingState({
 *   component: this,
 *   runButton: this._formContainer.querySelector('.analysis-run-btn'),
 *   loadingMessage: 'Running differential expression...',
 *   successMessage: 'Analysis complete',
 *   analysisFunction: () => this._runDEAnalysis()
 * });
 */
export async function runAnalysisWithLoadingState(options) {
  const {
    component,
    runButton,
    loadingMessage,
    successMessage,
    analysisFunction,
    category = 'calculation'
  } = options;

  // Prevent concurrent runs
  if (component._isLoading) return null;

  component._isLoading = true;
  const originalText = runButton?.textContent;
  const notifId = component._notifications?.loading(loadingMessage, { category });

  // Update button state
  if (runButton) {
    runButton.disabled = true;
    runButton.textContent = 'Running...';
  }

  try {
    const result = await analysisFunction();
    if (component._notifications && notifId) {
      component._notifications.complete(notifId, successMessage);
    }
    return result;
  } catch (error) {
    if (component._notifications && notifId) {
      component._notifications.fail(notifId, `Analysis failed: ${error.message}`);
    }
    throw error;
  } finally {
    component._isLoading = false;
    if (runButton) {
      runButton.disabled = false;
      runButton.textContent = originalText;
    }
  }
}

/**
 * Create a managed loading state for a component
 * Returns helpers for managing loading without the full wrapper
 *
 * @param {Object} component - The UI component
 * @returns {Object} { start, complete, fail, isLoading }
 */
export function createLoadingState(component) {
  let isLoading = false;
  let currentNotifId = null;

  return {
    get isLoading() {
      return isLoading;
    },

    start(message, category = 'calculation') {
      if (isLoading) return false;
      isLoading = true;
      currentNotifId = component._notifications?.loading(message, { category });
      return true;
    },

    complete(message) {
      if (!isLoading) return;
      if (component._notifications && currentNotifId) {
        component._notifications.complete(currentNotifId, message);
      }
      isLoading = false;
      currentNotifId = null;
    },

    fail(message) {
      if (!isLoading) return;
      if (component._notifications && currentNotifId) {
        component._notifications.fail(currentNotifId, message);
      }
      isLoading = false;
      currentNotifId = null;
    }
  };
}

// =============================================================================
// PAGE REQUIREMENTS VALIDATION
// =============================================================================

/**
 * Requirements definition for an analysis type
 * @typedef {Object} AnalysisRequirements
 * @property {number} [minPages=1] - Minimum number of pages required
 * @property {number} [maxPages] - Maximum number of pages allowed (null = unlimited)
 * @property {string} [description] - Human-readable requirement description
 */

/**
 * Validation result
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Whether validation passed
 * @property {string} [error] - Error message if invalid
 */

/**
 * Validate page requirements for an analysis type
 *
 * @param {string[]} pageIds - Selected page IDs
 * @param {AnalysisRequirements} requirements - Requirements definition
 * @returns {ValidationResult}
 *
 * @example
 * const result = validatePageRequirements(selectedPages, { minPages: 2, maxPages: 2 });
 * if (!result.valid) {
 *   showError(result.error);
 * }
 */
export function validatePageRequirements(pageIds, requirements) {
  const count = pageIds?.length || 0;
  const { minPages = 1, maxPages } = requirements || {};

  if (minPages && count < minPages) {
    const msg = maxPages === minPages
      ? `Requires exactly ${minPages} page(s). Currently ${count} selected.`
      : `Requires at least ${minPages} page(s). Currently ${count} selected.`;
    return { valid: false, error: msg };
  }

  if (maxPages && count > maxPages) {
    const msg = maxPages === minPages
      ? `Requires exactly ${maxPages} page(s). Currently ${count} selected.`
      : `Requires at most ${maxPages} page(s). Currently ${count} selected.`;
    return { valid: false, error: msg };
  }

  return { valid: true };
}

/**
 * Get human-readable requirement text
 *
 * @param {AnalysisRequirements} requirements
 * @returns {string}
 */
export function getRequirementText(requirements) {
  const { minPages = 1, maxPages, description } = requirements || {};

  if (description) return description;

  if (minPages === maxPages) {
    return `Select exactly ${minPages} page(s)`;
  } else if (maxPages) {
    return `Select ${minPages}-${maxPages} page(s)`;
  } else if (minPages > 1) {
    return `Select at least ${minPages} pages`;
  } else {
    return `Select at least 1 page`;
  }
}

// =============================================================================
// CSV EXPORT UTILITIES
// =============================================================================

/**
 * Convert a value to a safe CSV cell.
 * - Numbers: finite numbers only; non-finite -> empty
 * - Strings/others: quoted if needed; quotes are escaped by doubling
 *
 * @param {*} value
 * @returns {string}
 */
export function toCSVCell(value) {
  if (value === null || value === undefined) return '';

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }

  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generic function to convert an array of objects to CSV format
 *
 * @param {Object[]} data - Array of objects to convert
 * @param {Object} [options] - Options
 * @param {string[]} [options.columns] - Column keys to include (default: all keys from first object)
 * @param {Object} [options.headers] - Custom headers { key: 'Header Label' }
 * @param {Function} [options.formatValue] - Custom value formatter (receives value, key, row)
 * @returns {string} CSV content
 *
 * @example
 * const data = [
 *   { name: 'Gene A', pValue: 0.001, log2FC: 2.5 },
 *   { name: 'Gene B', pValue: 0.05, log2FC: -1.2 }
 * ];
 * const csv = toCSV(data, {
 *   columns: ['name', 'pValue', 'log2FC'],
 *   headers: { name: 'Gene', pValue: 'P-value', log2FC: 'Log2 Fold Change' }
 * });
 */
export function toCSV(data, options = {}) {
  if (!data || data.length === 0) {
    return '';
  }

  const {
    columns = Object.keys(data[0]),
    headers = {},
    formatValue = (v) => v
  } = options;

  // Header row
  const headerRow = columns.map(col => toCSVCell(headers[col] || col)).join(',');

  // Data rows
  const dataRows = data.map(row =>
    columns.map(col => {
      const value = formatValue(row[col], col, row);
      return toCSVCell(value);
    }).join(',')
  );

  return [headerRow, ...dataRows].join('\n');
}

/**
 * Download data as CSV file
 *
 * @param {string} csv - CSV content
 * @param {string} filename - Filename without extension
 * @param {Object} [notifications] - Notification center for success message
 */
export function downloadCSV(csv, filename, notifications) {
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.csv`;
  a.click();

  URL.revokeObjectURL(url);

  if (notifications) {
    notifications.success('Data exported as CSV', { category: 'download' });
  }
}

/**
 * Convert page data to CSV format
 *
 * @param {Object[]} pageData - Array of { pageId, pageName, values, cellIndices }
 * @param {string} variableName - Name of the variable for header
 * @returns {string} CSV content
 */
export function pageDataToCSV(pageData, variableName = 'value') {
  const rows = [`page,cell_index,${toCSVCell(variableName)}`];

  for (const pd of pageData) {
    const pageName = toCSVCell(pd.pageName);
    for (let i = 0; i < pd.values.length; i++) {
      const cellIdx = pd.cellIndices?.[i] ?? i;
      const value = pd.values[i];
      rows.push([pageName, toCSVCell(cellIdx), toCSVCell(value)].join(','));
    }
  }

  return rows.join('\n');
}

/**
 * Convert differential expression results to CSV
 *
 * @param {Object[]} results - DE results array
 * @returns {string} CSV content
 */
export function deResultsToCSV(results) {
  const rows = ['gene,meanA,meanB,log2FoldChange,pValue,adjustedPValue'];

  for (const r of results) {
    rows.push([
      toCSVCell(r.gene),
      toCSVCell(r.meanA),
      toCSVCell(r.meanB),
      toCSVCell(r.log2FoldChange),
      toCSVCell(r.pValue),
      toCSVCell(r.adjustedPValue)
    ].join(','));
  }

  return rows.join('\n');
}

/**
 * Convert signature scores to CSV
 *
 * @param {Object[]} pageData - Array of { pageName, values }
 * @returns {string} CSV content
 */
export function signatureScoresToCSV(pageData) {
  const rows = ['page,score'];

  for (const pd of pageData) {
    const pageName = toCSVCell(pd.pageName);
    for (const value of pd.values) {
      if (Number.isFinite(value)) {
        rows.push([pageName, toCSVCell(value)].join(','));
      }
    }
  }

  return rows.join('\n');
}

/**
 * Convert correlation results to CSV
 *
 * @param {Object[]} results - Array of per-page correlation results
 * @param {Object} [metadata] - Optional metadata { method, variableX, variableY }
 * @returns {string} CSV content
 */
export function correlationResultsToCSV(results, metadata = {}) {
  const method = metadata.method || '';
  const x = metadata.variableX || metadata.varX || null;
  const y = metadata.variableY || metadata.varY || null;

  const header = 'page,method,x_type,x_key,y_type,y_key,r,r_squared,p_value,n';
  const rows = [header];

  for (const r of results || []) {
    const page = r?.pageName || '';
    const rVal = typeof r?.r === 'number' && Number.isFinite(r.r) ? r.r : null;
    const rSquaredVal =
      typeof r?.rSquared === 'number' && Number.isFinite(r.rSquared)
        ? r.rSquared
        : (typeof r?.r === 'number' && Number.isFinite(r.r) ? r.r * r.r : null);
    const pVal = typeof r?.pValue === 'number' && Number.isFinite(r.pValue) ? r.pValue : null;
    const nVal =
      typeof r?.n === 'number'
        ? r.n
        : (Array.isArray(r?.xValues) ? r.xValues.length : null);

    rows.push([
      toCSVCell(page),
      toCSVCell(method),
      toCSVCell(x?.type || ''),
      toCSVCell(x?.key || ''),
      toCSVCell(y?.type || ''),
      toCSVCell(y?.key || ''),
      toCSVCell(rVal),
      toCSVCell(rSquaredVal),
      toCSVCell(pVal),
      toCSVCell(nVal)
    ].join(','));
  }

  return rows.join('\n');
}

// =============================================================================
// FORM VALUE EXTRACTION
// =============================================================================

/**
 * Get form values from a form element by name attributes
 *
 * @param {HTMLElement} formContainer - Container with form inputs
 * @param {string[]} fieldNames - Names of fields to extract
 * @returns {Object} Key-value pairs of form values
 *
 * @example
 * const values = getFormValues(form, ['method', 'threshold', 'geneCount']);
 * // { method: 'wilcox', threshold: '0.05', geneCount: '100' }
 */
export function getFormValues(formContainer, fieldNames) {
  const values = {};

  for (const name of fieldNames) {
    const el = formContainer.querySelector(`[name="${name}"]`);
    if (el) {
      if (el.type === 'checkbox') {
        values[name] = el.checked;
      } else {
        values[name] = el.value;
      }
    }
  }

  return values;
}

/**
 * Get form values with automatic type conversion
 *
 * @param {HTMLElement} formContainer - Container with form inputs
 * @param {Object} fieldConfig - Configuration for each field
 * @returns {Object} Typed form values
 *
 * @example
 * const values = getTypedFormValues(form, {
 *   geneCount: { type: 'int', default: 100 },
 *   threshold: { type: 'float', default: 0.05 },
 *   method: { type: 'string', default: 'wilcox' }
 * });
 */
export function getTypedFormValues(formContainer, fieldConfig) {
  const values = {};

  for (const [name, config] of Object.entries(fieldConfig)) {
    const el = formContainer.querySelector(`[name="${name}"]`);
    let value = el?.value ?? config.default;

    switch (config.type) {
      case 'int':
        value = parseInt(value, 10);
        if (!Number.isFinite(value)) value = config.default;
        break;
      case 'float':
        value = parseFloat(value);
        if (!Number.isFinite(value)) value = config.default;
        break;
      case 'bool':
      case 'boolean':
        value = el?.type === 'checkbox' ? el.checked : value === 'true';
        break;
      case 'string':
      default:
        // Keep as string
        break;
    }

    values[name] = value;
  }

  return values;
}

// =============================================================================
// STATISTICS HELPERS
// =============================================================================

/**
 * Compute basic statistics for a numeric array
 * Optimized for performance with streaming for large arrays
 *
 * @param {number[]} values - Numeric values
 * @returns {Object} { count, mean, median, std, min, max, q1, q3 }
 */
export function computeBasicStats(values) {
  const valid = filterFiniteNumbers(values);
  const n = valid.length;

  if (n === 0) {
    return { count: 0, mean: null, median: null, std: null, min: null, max: null };
  }

  // Sort once for quartiles and min/max
  const sorted = [...valid].sort((a, b) => a - b);

  return {
    count: n,
    mean: computeMean(valid),
    median: computeMedian(valid),
    std: computeStd(valid),
    min: sorted[0],
    max: sorted[n - 1],
    q1: sorted[Math.floor(n * 0.25)],
    q3: sorted[Math.floor(n * 0.75)]
  };
}

/**
 * Compute Cohen's d effect size between two groups
 *
 * @param {number[]} group1 - First group values
 * @param {number[]} group2 - Second group values
 * @returns {Object} { effectSize, interpretation, mean1, mean2, std1, std2, n1, n2 }
 */
export function computeEffectSize(group1, group2) {
  const valid1 = filterFiniteNumbers(group1);
  const valid2 = filterFiniteNumbers(group2);

  const n1 = valid1.length;
  const n2 = valid2.length;

  if (n1 < 2 || n2 < 2) {
    return { effectSize: 0, interpretation: 'insufficient data' };
  }

  const mean1 = computeMean(valid1);
  const mean2 = computeMean(valid2);

  // Sample variance uses (n-1) denominator (Bessel's correction) for unbiased estimate
  const var1 = valid1.reduce((a, b) => a + (b - mean1) ** 2, 0) / (n1 - 1);
  const var2 = valid2.reduce((a, b) => a + (b - mean2) ** 2, 0) / (n2 - 1);

  // Pooled standard deviation
  const pooledVar = ((n1 - 1) * var1 + (n2 - 1) * var2) / (n1 + n2 - 2);
  const pooledStd = Math.sqrt(pooledVar);

  if (pooledStd === 0) {
    return { effectSize: 0, interpretation: 'no variance', mean1, mean2 };
  }

  // Cohen's d
  const d = (mean1 - mean2) / pooledStd;

  // Interpretation
  const absD = Math.abs(d);
  let interpretation;
  if (absD < 0.2) interpretation = 'negligible';
  else if (absD < 0.5) interpretation = 'small';
  else if (absD < 0.8) interpretation = 'medium';
  else interpretation = 'large';

  return {
    effectSize: d,
    interpretation,
    mean1,
    mean2,
    std1: Math.sqrt(var1),
    std2: Math.sqrt(var2),
    n1,
    n2
  };
}

// =============================================================================
// PAGE NAME RESOLUTION
// =============================================================================

/**
 * Resolve page IDs to page names
 *
 * @param {string[]} pageIds - Array of page IDs
 * @param {Object} dataLayer - Data layer instance
 * @returns {string[]} Array of page names
 */
export function resolvePageNames(pageIds, dataLayer) {
  const pages = dataLayer.getPages();
  return pageIds.map(id => {
    const page = pages.find(p => p.id === id);
    return page?.name || id;
  });
}

/**
 * Get page info for display
 *
 * @param {string[]} pageIds - Array of page IDs
 * @param {Object} dataLayer - Data layer instance
 * @returns {Object[]} Array of { id, name, cellCount }
 */
export function getPageInfo(pageIds, dataLayer) {
  const pages = dataLayer.getPages();

  return pageIds.map(id => {
    const page = pages.find(p => p.id === id);
    const cellIndices = dataLayer.getCellIndicesForPage(id);
    return {
      id,
      name: page?.name || id,
      cellCount: cellIndices.length
    };
  });
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default {
  // Loading state
  runAnalysisWithLoadingState,
  createLoadingState,
  // Validation
  validatePageRequirements,
  getRequirementText,
  // CSV export
  downloadCSV,
  pageDataToCSV,
  deResultsToCSV,
  signatureScoresToCSV,
  correlationResultsToCSV,
  // Form values
  getFormValues,
  getTypedFormValues,
  // Statistics
  computeBasicStats,
  computeEffectSize,
  // Page utilities
  resolvePageNames,
  getPageInfo
};
