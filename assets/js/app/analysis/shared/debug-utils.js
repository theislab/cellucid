/**
 * Debug Utilities - Production-safe logging and debugging
 *
 * Centralizes all debug logging to provide:
 * - Production-safe logging (disabled in production builds)
 * - Categorized log levels
 * - Optional timing utilities
 * - Consistent prefix/format for easy filtering
 *
 * Usage:
 * ```js
 * import { debug, debugWarn, debugError, debugTime } from './debug-utils.js';
 *
 * debug('PlotRenderer', 'Rendering scatter plot', { pointCount: 1000 });
 * debugWarn('DataLoader', 'Large dataset detected');
 * debugError('Analysis', 'Computation failed', error);
 *
 * const timer = debugTime('Analysis');
 * // ... expensive operation
 * timer.end('Completed analysis');
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

  // Check localStorage
  try {
    if (localStorage.getItem('debug') === 'true' || localStorage.getItem('debug') === '1') {
      return true;
    }
  } catch (_e) {
    // localStorage may not be available
  }

  // Check URL parameter
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('debug') === '1' || url.searchParams.get('debug') === 'true') {
      return true;
    }
  } catch (_e) {
    // URL parsing may fail
  }

  // Check global flag
  if (window.__CELLUCID_DEBUG__) {
    return true;
  }

  return false;
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

/**
 * Enable debug mode programmatically
 */
export function enableDebug() {
  _debugEnabled = true;
  if (typeof window !== 'undefined') {
    window.__CELLUCID_DEBUG__ = true;
    try {
      localStorage.setItem('debug', 'true');
    } catch (_e) {
      // Ignore
    }
  }
}

/**
 * Disable debug mode programmatically
 */
export function disableDebug() {
  _debugEnabled = false;
  if (typeof window !== 'undefined') {
    window.__CELLUCID_DEBUG__ = false;
    try {
      localStorage.removeItem('debug');
    } catch (_e) {
      // Ignore
    }
  }
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

/**
 * Debug group (only in debug mode)
 * Creates a collapsible group in the console.
 *
 * @param {string} category - Log category
 * @param {string} label - Group label
 * @returns {{ end: Function }} Object with end() to close the group
 */
export function debugGroup(category, label) {
  if (!getDebugEnabled()) {
    return { end: () => {} };
  }

  console.groupCollapsed(formatMessage(category, label));

  return {
    end: () => console.groupEnd()
  };
}

// =============================================================================
// TIMING UTILITIES
// =============================================================================

/**
 * Start a debug timer (only in debug mode)
 *
 * @param {string} category - Log category
 * @param {string} [label] - Optional label for the timer
 * @returns {{ end: Function, mark: Function }} Timer control object
 *
 * @example
 * const timer = debugTime('Analysis', 'DE Computation');
 * // ... do work
 * timer.mark('Step 1 complete');
 * // ... more work
 * timer.end('Finished');
 */
export function debugTime(category, label = 'Timer') {
  if (!getDebugEnabled()) {
    return {
      end: () => {},
      mark: () => {}
    };
  }

  const start = performance.now();
  let lastMark = start;

  return {
    /**
     * Mark a checkpoint in the timer
     * @param {string} markLabel - Label for this checkpoint
     */
    mark(markLabel) {
      const now = performance.now();
      const fromStart = (now - start).toFixed(2);
      const fromLast = (now - lastMark).toFixed(2);
      console.log(
        formatMessage(category, `${label} - ${markLabel}`),
        `(+${fromLast}ms, total: ${fromStart}ms)`
      );
      lastMark = now;
    },

    /**
     * End the timer and log the total time
     * @param {string} [endLabel] - Optional label for the end
     */
    end(endLabel = 'Complete') {
      const now = performance.now();
      const total = (now - start).toFixed(2);
      console.log(
        formatMessage(category, `${label} - ${endLabel}`),
        `(total: ${total}ms)`
      );
    }
  };
}

/**
 * Measure async function execution time
 *
 * @template T
 * @param {string} category - Log category
 * @param {string} label - Operation label
 * @param {() => Promise<T>} fn - Async function to measure
 * @returns {Promise<T>} Result of the function
 *
 * @example
 * const result = await debugMeasure('DataLoader', 'Load genes', async () => {
 *   return await fetchGeneData();
 * });
 */
export async function debugMeasure(category, label, fn) {
  const timer = debugTime(category, label);
  try {
    const result = await fn();
    timer.end('Success');
    return result;
  } catch (error) {
    timer.end('Failed');
    throw error;
  }
}

// =============================================================================
// CONDITIONAL EXECUTION
// =============================================================================

/**
 * Execute a function only in debug mode
 *
 * @template T
 * @param {() => T} fn - Function to execute
 * @returns {T|undefined} Result of function, or undefined if not in debug mode
 */
export function debugOnly(fn) {
  if (!getDebugEnabled()) return undefined;
  return fn();
}

/**
 * Log object properties only in debug mode
 * Useful for inspecting complex objects without cluttering production logs.
 *
 * @param {string} category - Log category
 * @param {string} label - Object label
 * @param {Object} obj - Object to inspect
 * @param {string[]} [keys] - Optional list of keys to log (defaults to all)
 */
export function debugInspect(category, label, obj, keys) {
  if (!getDebugEnabled()) return;

  const toLog = keys
    ? Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]))
    : obj;

  console.log(formatMessage(category, label), toLog);
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default {
  // Configuration
  enableDebug,
  disableDebug,
  // Logging
  debug,
  debugWarn,
  debugError,
  debugGroup,
  // Timing
  debugTime,
  debugMeasure,
  // Conditional
  debugOnly,
  debugInspect
};
