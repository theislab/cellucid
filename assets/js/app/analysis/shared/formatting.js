/**
 * Formatting Utilities - Analysis Module
 *
 * Centralized formatting functions for consistent number, p-value,
 * and count display across the analysis module.
 *
 * @module shared/formatting
 */

// =============================================================================
// NUMBER FORMATTING
// =============================================================================

/**
 * Format a number for display.
 *
 * Uses exponential notation for very large (>=10000) or very small (<0.01)
 * numbers. Removes trailing zeros for cleaner display.
 *
 * @param {number} value - Number to format
 * @param {number} [precision=2] - Decimal places
 * @param {Object} [options={}] - Additional options
 * @param {boolean} [options.alwaysShowSign=false] - Show + for positive numbers
 * @param {string} [options.nanValue='N/A'] - Value to return for NaN/invalid
 * @returns {string} Formatted number string
 *
 * @example
 * formatNumber(1234.567)     // "1234.57"
 * formatNumber(0.00123)      // "1.2e-3"
 * formatNumber(12345678)     // "1.23e+7"
 * formatNumber(null)         // "N/A"
 */
export function formatNumber(value, precision = 2, options = {}) {
  const { alwaysShowSign = false, nanValue = 'N/A' } = options;

  if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
    return nanValue;
  }

  if (typeof value !== 'number') {
    return String(value);
  }

  let result;

  // Use exponential for very large or very small numbers
  if (Math.abs(value) >= 10000 || (Math.abs(value) < 0.01 && value !== 0)) {
    result = value.toExponential(precision);
  } else {
    // Remove trailing zeros
    result = value.toFixed(precision).replace(/\.?0+$/, '');
  }

  // Add + sign for positive numbers if requested
  if (alwaysShowSign && value > 0) {
    result = '+' + result;
  }

  return result;
}

/**
 * Format a number with fixed precision (no exponential).
 *
 * Simple formatting that always uses toFixed. Useful for display
 * in UI elements where consistent formatting is preferred.
 *
 * @param {number} value - Number to format
 * @param {number} [precision=2] - Decimal places
 * @returns {string} Formatted number or 'N/A' if invalid
 *
 * @example
 * formatFixed(1234.567)   // "1234.57"
 * formatFixed(0.00123)    // "0.00"
 * formatFixed(null)       // "N/A"
 */
export function formatFixed(value, precision = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'N/A';
  }
  return value.toFixed(precision);
}

/**
 * Format a count with K/M/B suffixes for large numbers.
 *
 * @param {number} n - Count to format
 * @param {number} [decimals=1] - Decimal places for abbreviated numbers
 * @returns {string} Formatted string (e.g., "1.2K", "3.5M", "1.2B")
 *
 * @example
 * formatCount(500)        // "500"
 * formatCount(1500)       // "1.5K"
 * formatCount(1500000)    // "1.5M"
 * formatCount(1500000000) // "1.5B"
 */
export function formatCount(n, decimals = 1) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return '0';
  }

  const absN = Math.abs(n);
  const sign = n < 0 ? '-' : '';

  if (absN >= 1e9) {
    return sign + (absN / 1e9).toFixed(decimals) + 'B';
  }
  if (absN >= 1e6) {
    return sign + (absN / 1e6).toFixed(decimals) + 'M';
  }
  if (absN >= 1e3) {
    return sign + (absN / 1e3).toFixed(decimals) + 'K';
  }
  return sign + Math.round(absN).toString();
}

/**
 * Format a percentage value.
 *
 * @param {number} value - Value (0-1 or 0-100)
 * @param {number} [precision=1] - Decimal places
 * @param {boolean} [isDecimal=true] - Whether value is 0-1 (true) or 0-100 (false)
 * @returns {string} Formatted percentage with % suffix
 *
 * @example
 * formatPercent(0.234)         // "23.4%"
 * formatPercent(23.4, 1, false) // "23.4%"
 * formatPercent(1)             // "100.0%"
 */
export function formatPercent(value, precision = 1, isDecimal = true) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'N/A';
  }

  const pct = isDecimal ? value * 100 : value;
  return pct.toFixed(precision) + '%';
}

// =============================================================================
// P-VALUE FORMATTING
// =============================================================================

/**
 * Format a p-value for display.
 *
 * Shows "<0.001" for very small p-values (cleaner than exponential).
 * This is the recommended format for statistical reporting.
 *
 * @param {number} pValue - P-value to format (0-1)
 * @returns {string} Formatted p-value
 *
 * @example
 * formatPValue(0.0001)  // "<0.001"
 * formatPValue(0.005)   // "0.005"
 * formatPValue(0.05)    // "0.05"
 * formatPValue(0.5)     // "0.50"
 */
export function formatPValue(pValue) {
  if (typeof pValue !== 'number' || !Number.isFinite(pValue)) {
    return 'N/A';
  }

  if (pValue < 0.001) {
    return '<0.001';
  }
  if (pValue < 0.01) {
    return pValue.toFixed(3);
  }
  return pValue.toFixed(2);
}

/**
 * Format a p-value using exponential notation.
 *
 * Useful when exact small p-values are needed (e.g., in tables).
 *
 * @param {number} pValue - P-value to format (0-1)
 * @param {number} [precision=2] - Decimal places in exponent
 * @returns {string} Formatted p-value
 *
 * @example
 * formatPValueExponential(0.0001)   // "1.00e-4"
 * formatPValueExponential(0.005)    // "0.005"
 */
export function formatPValueExponential(pValue, precision = 2) {
  if (typeof pValue !== 'number' || !Number.isFinite(pValue)) {
    return 'N/A';
  }

  if (pValue < 0.001) {
    return pValue.toExponential(precision);
  }
  if (pValue < 0.01) {
    return pValue.toFixed(3);
  }
  return pValue.toFixed(precision);
}

/**
 * Format a p-value with significance stars.
 *
 * @param {number} pValue - P-value to format
 * @param {boolean} [includeValue=true] - Include the numeric value
 * @returns {string} Formatted p-value with stars
 *
 * @example
 * formatPValueWithStars(0.0001)  // "<0.001 ***"
 * formatPValueWithStars(0.005)   // "0.005 **"
 * formatPValueWithStars(0.03)    // "0.03 *"
 * formatPValueWithStars(0.1)     // "0.10"
 */
export function formatPValueWithStars(pValue, includeValue = true) {
  if (typeof pValue !== 'number' || !Number.isFinite(pValue)) {
    return 'N/A';
  }

  const stars = getSignificanceStars(pValue);
  const value = includeValue ? formatPValue(pValue) : '';

  return stars ? `${value} ${stars}`.trim() : value;
}

/**
 * Get significance stars for a p-value.
 *
 * @param {number} pValue - P-value
 * @returns {string} Star string ('***', '**', '*', or '')
 *
 * @example
 * getSignificanceStars(0.0001)  // "***"
 * getSignificanceStars(0.005)   // "**"
 * getSignificanceStars(0.03)    // "*"
 * getSignificanceStars(0.1)     // ""
 */
export function getSignificanceStars(pValue) {
  if (typeof pValue !== 'number' || !Number.isFinite(pValue)) {
    return '';
  }
  if (pValue < 0.001) return '***';
  if (pValue < 0.01) return '**';
  if (pValue < 0.05) return '*';
  return '';
}

/**
 * Get significance marker for display.
 * Returns Unicode symbols for significance levels.
 *
 * @param {number} pValue - P-value
 * @returns {string} Significance marker
 */
export function getSignificanceMarker(pValue) {
  if (typeof pValue !== 'number' || !Number.isFinite(pValue)) {
    return '';
  }
  if (pValue < 0.001) return '\u2605\u2605\u2605'; // ★★★
  if (pValue < 0.01) return '\u2605\u2605';        // ★★
  if (pValue < 0.05) return '\u2605';              // ★
  return '';
}

/**
 * Get CSS class for significance level.
 *
 * @param {number} pValue - P-value
 * @returns {string} CSS class name
 */
export function getSignificanceClass(pValue) {
  if (typeof pValue !== 'number' || !Number.isFinite(pValue)) {
    return 'stat-ns';
  }
  if (pValue < 0.001) return 'stat-highly-significant';
  if (pValue < 0.01) return 'stat-very-significant';
  if (pValue < 0.05) return 'stat-significant';
  return 'stat-ns';
}

// =============================================================================
// EFFECT SIZE FORMATTING
// =============================================================================

/**
 * Format an effect size (Cohen's d, Cramer's V, etc.).
 *
 * @param {number} effectSize - Effect size value
 * @param {number} [precision=2] - Decimal places
 * @returns {string} Formatted effect size
 *
 * @example
 * formatEffectSize(0.234)  // "0.23"
 * formatEffectSize(-0.82)  // "-0.82"
 */
export function formatEffectSize(effectSize, precision = 2) {
  if (typeof effectSize !== 'number' || !Number.isFinite(effectSize)) {
    return 'N/A';
  }
  return effectSize.toFixed(precision);
}

/**
 * Get effect size interpretation (Cohen's d conventions).
 *
 * @param {number} d - Cohen's d value
 * @returns {string} Interpretation ('small', 'medium', 'large', or 'negligible')
 *
 * @example
 * getEffectSizeInterpretation(0.1)  // "negligible"
 * getEffectSizeInterpretation(0.3)  // "small"
 * getEffectSizeInterpretation(0.6)  // "medium"
 * getEffectSizeInterpretation(1.0)  // "large"
 */
export function getEffectSizeInterpretation(d) {
  const absD = Math.abs(d);
  if (absD >= 0.8) return 'large';
  if (absD >= 0.5) return 'medium';
  if (absD >= 0.2) return 'small';
  return 'negligible';
}

// =============================================================================
// FOLD CHANGE FORMATTING
// =============================================================================

/**
 * Format a fold change value.
 *
 * @param {number} fc - Fold change (linear scale)
 * @param {number} [precision=2] - Decimal places
 * @returns {string} Formatted fold change
 *
 * @example
 * formatFoldChange(2.5)   // "2.50"
 * formatFoldChange(0.4)   // "0.40"
 */
export function formatFoldChange(fc, precision = 2) {
  if (fc === null || fc === undefined || Number.isNaN(fc) || !Number.isFinite(fc)) {
    return 'N/A';
  }
  return fc.toFixed(precision);
}

/**
 * Format a log2 fold change value.
 *
 * @param {number} log2fc - Log2 fold change
 * @param {number} [precision=2] - Decimal places
 * @returns {string} Formatted log2 fold change with sign
 *
 * @example
 * formatLog2FoldChange(1.32)   // "+1.32"
 * formatLog2FoldChange(-0.75)  // "-0.75"
 */
export function formatLog2FoldChange(log2fc, precision = 2) {
  if (log2fc === null || log2fc === undefined || Number.isNaN(log2fc) || !Number.isFinite(log2fc)) {
    return 'N/A';
  }

  const sign = log2fc > 0 ? '+' : '';
  return sign + log2fc.toFixed(precision);
}

// =============================================================================
// CONFIDENCE INTERVAL FORMATTING
// =============================================================================

/**
 * Format a confidence interval.
 *
 * @param {[number, number]} ci - Confidence interval [lower, upper]
 * @param {number} [precision=2] - Decimal places
 * @returns {string} Formatted interval
 *
 * @example
 * formatConfidenceInterval([0.23, 0.87])  // "[0.23, 0.87]"
 */
export function formatConfidenceInterval(ci, precision = 2) {
  if (!ci || !Array.isArray(ci) || ci.length !== 2) {
    return 'N/A';
  }

  const [lower, upper] = ci;
  if (typeof lower !== 'number' || !Number.isFinite(lower) || typeof upper !== 'number' || !Number.isFinite(upper)) {
    return 'N/A';
  }

  return `[${lower.toFixed(precision)}, ${upper.toFixed(precision)}]`;
}

// =============================================================================
// RANGE FORMATTING
// =============================================================================

/**
 * Format a numeric range.
 *
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @param {number} [precision=2] - Decimal places
 * @returns {string} Formatted range
 *
 * @example
 * formatRange(0, 100)      // "0 - 100"
 * formatRange(0.1, 15.3)   // "0.10 - 15.30"
 */
export function formatRange(min, max, precision = 2) {
  const minStr = formatNumber(min, precision);
  const maxStr = formatNumber(max, precision);
  return `${minStr} - ${maxStr}`;
}

// =============================================================================
// DURATION FORMATTING
// =============================================================================

/**
 * Format a duration in milliseconds.
 *
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Human-readable duration
 *
 * @example
 * formatDuration(500)      // "500ms"
 * formatDuration(1500)     // "1.5s"
 * formatDuration(65000)    // "1m 5s"
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    return 'N/A';
  }

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

// =============================================================================
// BYTES FORMATTING
// =============================================================================

/**
 * Format bytes to human-readable size.
 *
 * @param {number} bytes - Size in bytes
 * @param {number} [decimals=1] - Decimal places
 * @returns {string} Human-readable size (e.g., "1.5 MB")
 *
 * @example
 * formatBytes(1024)        // "1.0 KB"
 * formatBytes(1048576)     // "1.0 MB"
 * formatBytes(1073741824)  // "1.0 GB"
 */
export function formatBytes(bytes, decimals = 1) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) {
    return '0 B';
  }

  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}
