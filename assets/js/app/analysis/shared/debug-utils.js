/**
 * Debug Utilities - Production-safe logging and debugging
 *
 * Centralizes all debug logging to provide:
 * - Production-safe logging (disabled in production builds)
 * - Categorized log levels
 * - Consistent prefix/format for easy filtering
 *
 * Usage:
 * ```js
 * import { debug, debugWarn, debugError } from './debug-utils.js';
 *
 * debug('PlotRenderer', 'Rendering scatter plot', { pointCount: 1000 });
 * debugWarn('DataLoader', 'Large dataset detected');
 * debugError('Analysis', 'Computation failed', error);
 * ```
 *
 * @module shared/debug-utils
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Check if debug mode is enabled.
 * Debug mode is enabled when:
 * - localStorage.debug is truthy
 * - URL contains ?debug=1 or ?debug=true
 * - window.__CELLUCID_DEBUG__ is truthy
 *
 * @returns {boolean}
 */
function isDebugEnabled() {
  if (typeof window === 'undefined') return false;

  const storage = requireDebugStorage();
  const storedValue = storage.getItem('debug');
  if (storedValue === 'true' || storedValue === '1') {
    return true;
  }

  if (
    !window.location ||
    typeof window.location.href !== 'string' ||
    window.location.href.length === 0
  ) {
    throw new TypeError('Debug mode requires an exact window.location.href');
  }
  const url = new URL(window.location.href);
  const queryValue = url.searchParams.get('debug');
  if (queryValue === '1' || queryValue === 'true') {
    return true;
  }

  // Check global flag
  if (window.__CELLUCID_DEBUG__) {
    return true;
  }

  return false;
}

function requireDebugStorage() {
  const storage = globalThis.localStorage;
  if (!storage || typeof storage.getItem !== 'function') {
    throw new TypeError('Debug mode requires localStorage getItem()');
  }
  return storage;
}

// Cache the debug state
let _debugEnabled = null;

/**
 * Get cached debug state (memoized)
 * @returns {boolean}
 */
function getDebugEnabled() {
  if (_debugEnabled === null) {
    _debugEnabled = isDebugEnabled();
  }
  return _debugEnabled;
}

/**
 * Check if debug mode is enabled (memoized).
 * Prefer this over re-parsing URL/localStorage in other modules.
 * @returns {boolean}
 */
export function isDebugMode() {
  return getDebugEnabled();
}

// =============================================================================
// LOGGING FUNCTIONS
// =============================================================================

/**
 * Format a debug message with category prefix
 * @param {string} category - Log category (e.g., 'PlotRenderer', 'DataLoader')
 * @param {string} message - Log message
 * @returns {string}
 */
function formatMessage(category, message) {
  return `[${category}] ${message}`;
}

/**
 * Debug log (only in debug mode)
 * Use for general information that's helpful during development.
 *
 * @param {string} category - Log category
 * @param {string} message - Log message
 * @param {...any} args - Additional arguments to log
 */
export function debug(category, message, ...args) {
  if (!getDebugEnabled()) return;
  console.log(formatMessage(category, message), ...args);
}

/**
 * Debug warning (only in debug mode)
 * Use for non-critical issues that should be noted.
 *
 * @param {string} category - Log category
 * @param {string} message - Warning message
 * @param {...any} args - Additional arguments to log
 */
export function debugWarn(category, message, ...args) {
  if (!getDebugEnabled()) return;
  console.warn(formatMessage(category, message), ...args);
}

/**
 * Debug error (only in debug mode)
 * Use for errors that shouldn't crash the app but should be logged.
 * For errors that should always be logged, use console.error directly.
 *
 * @param {string} category - Log category
 * @param {string} message - Error message
 * @param {...any} args - Additional arguments (often an Error object)
 */
export function debugError(category, message, ...args) {
  if (!getDebugEnabled()) return;
  console.error(formatMessage(category, message), ...args);
}
