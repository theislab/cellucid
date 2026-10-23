/**
 * Analysis Utilities - Common functions for Analysis UI components
 *
 * Centralizes shared patterns to ensure DRY code:
 * - Page requirements validation
 * - CSV export utilities
 * - Form value extraction
 * - Statistics calculation helpers
 *
 * @module shared/analysis-utils
 */

import { setOwnDataProperty } from '../../../utils/exact-record.js';
import { downloadBlob } from '../../utils/download.js';
import { toCSVCell } from '../compute/csv-export.js';

// =============================================================================
// PAGE REQUIREMENTS VALIDATION
// =============================================================================

/**
 * Requirements definition for an analysis type
 * @typedef {Object} AnalysisRequirements
 * @property {number} [minPages=1] - Minimum number of pages required
 * @property {number} [maxPages] - Maximum number of pages allowed (null = unlimited)
 * @property {string} [description] - Human-readable requirement description
 * @property {boolean} [geneExpression] - Whether the mode needs gene expression data
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
  const headerRow = columns.map(col => (
    toCSVCell(Object.hasOwn(headers, col) ? headers[col] : col)
  )).join(',');

  // Data rows
  const dataRows = data.map(row =>
    columns.map(col => {
      const value = formatValue(
        Object.hasOwn(row, col) ? row[col] : undefined,
        col,
        row
      );
      return toCSVCell(value);
    }).join(',')
  );

  return [headerRow, ...dataRows].join('\n');
}

/**
 * Download a CSV file.
 *
 * @param {string|Blob} csv - CSV text, or the file the CSV writer built
 *   (compute/csv-export.js)
 * @param {string} filename - Filename without extension
 * @param {Object} [notifications] - Notification center for success message
 */
export function downloadCSV(csv, filename, notifications) {
  const blob = csv instanceof Blob ? csv : new Blob([csv], { type: 'text/csv' });
  downloadBlob(blob, `${filename}.csv`);

  if (notifications) {
    notifications.success('Data exported as CSV', { category: 'download' });
  }
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
        setOwnDataProperty(values, name, el.checked);
      } else {
        setOwnDataProperty(values, name, el.value);
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
    if (
      config === null ||
      typeof config !== 'object' ||
      Array.isArray(config)
    ) {
      throw new TypeError(
        `Field ${name} configuration must be an object`
      );
    }
    const el = formContainer.querySelector(`[name="${name}"]`);
    const type = Object.hasOwn(config, 'type') ? config.type : undefined;
    const defaultValue = Object.hasOwn(config, 'default')
      ? config.default
      : undefined;
    let value = el?.value ?? defaultValue;

    switch (type) {
      case 'int':
        value = parseInt(value, 10);
        if (!Number.isFinite(value)) value = defaultValue;
        break;
      case 'float':
        value = parseFloat(value);
        if (!Number.isFinite(value)) value = defaultValue;
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

    setOwnDataProperty(values, name, value);
  }

  return values;
}
