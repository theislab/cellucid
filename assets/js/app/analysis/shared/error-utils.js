/**
 * Error Handling Utilities
 *
 * Centralizes error handling patterns to provide:
 * - Consistent error messages
 * - User-friendly error formatting
 * - Error categorization
 * - Safe error wrapping for async operations
 *
 * Usage:
 * ```js
 * import { wrapAsync, handleError, AnalysisError } from './error-utils.js';
 *
 * // Wrap an async operation with consistent error handling
 * const result = await wrapAsync(
 *   () => fetchData(),
 *   'DataLoader',
 *   'Failed to load gene data'
 * );
 *
 * // Create typed errors
 * throw new AnalysisError('Insufficient data for analysis', 'INSUFFICIENT_DATA');
 *
 * // Handle errors with notifications
 * handleError(error, notifications, { category: 'analysis' });
 * ```
 *
 * @module shared/error-utils
 */

import { debug, debugError } from './debug-utils.js';

// =============================================================================
// ERROR TYPES
// =============================================================================

/**
 * Base error class for analysis-related errors
 */
export class AnalysisError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} [code] - Error code for categorization
   * @param {Object} [details] - Additional error details
   */
  constructor(message, code = 'ANALYSIS_ERROR', details = {}) {
    super(message);
    this.name = 'AnalysisError';
    this.code = code;
    this.details = details;
    this.timestamp = Date.now();
  }

  /**
   * Get a user-friendly error message
   * @returns {string}
   */
  getUserMessage() {
    return this.message;
  }
}

/**
 * Error for data-related issues
 */
export class DataError extends AnalysisError {
  constructor(message, code = 'DATA_ERROR', details = {}) {
    super(message, code, details);
    this.name = 'DataError';
  }
}

/**
 * Error for computation failures
 */
export class ComputeError extends AnalysisError {
  constructor(message, code = 'COMPUTE_ERROR', details = {}) {
    super(message, code, details);
    this.name = 'ComputeError';
  }
}

/**
 * Error for cancelled operations
 */
export class CancelledError extends AnalysisError {
  constructor(message = 'Operation was cancelled', details = {}) {
    super(message, 'CANCELLED', details);
    this.name = 'CancelledError';
  }
}

/**
 * Error for timeout conditions
 */
export class TimeoutError extends AnalysisError {
  constructor(message = 'Operation timed out', details = {}) {
    super(message, 'TIMEOUT', details);
    this.name = 'TimeoutError';
  }
}

// =============================================================================
// ERROR CODE MAPPING
// =============================================================================

/**
 * Map of error codes to user-friendly messages
 * @type {Object.<string, string>}
 */
export const ERROR_MESSAGES = {
  ANALYSIS_ERROR: 'An error occurred during analysis',
  DATA_ERROR: 'Failed to load or process data',
  COMPUTE_ERROR: 'Computation failed',
  CANCELLED: 'Operation was cancelled',
  TIMEOUT: 'Operation timed out',
  INSUFFICIENT_DATA: 'Not enough data to perform this analysis',
  INVALID_INPUT: 'Invalid input parameters',
  NETWORK_ERROR: 'Network request failed',
  PERMISSION_DENIED: 'Access denied',
  NOT_FOUND: 'Resource not found',
  WEBGL_ERROR: 'Graphics acceleration error'
};

/**
 * Get a user-friendly message for an error code
 * @param {string} code - Error code
 * @returns {string}
 */
export function getErrorMessage(code) {
  return ERROR_MESSAGES[code] || ERROR_MESSAGES.ANALYSIS_ERROR;
}

// =============================================================================
// ERROR HANDLING FUNCTIONS
// =============================================================================

/**
 * Check if an error is a cancellation error (shouldn't show to user)
 * @param {Error} error - Error to check
 * @returns {boolean}
 */
export function isCancellationError(error) {
  if (!error) return false;
  if (error instanceof CancelledError) return true;
  if (error.name === 'AbortError') return true;
  if (error.code === 'CANCELLED') return true;
  return false;
}

/**
 * Check if an error is a timeout error
 * @param {Error} error - Error to check
 * @returns {boolean}
 */
export function isTimeoutError(error) {
  if (!error) return false;
  if (error instanceof TimeoutError) return true;
  if (error.code === 'TIMEOUT') return true;
  if (error.name === 'TimeoutError') return true;
  return false;
}

/**
 * Format an error for display to the user
 * @param {Error} error - Error to format
 * @returns {string}
 */
export function formatErrorForUser(error) {
  if (!error) return 'An unknown error occurred';

  // Use custom message if available
  if (error instanceof AnalysisError) {
    return error.getUserMessage();
  }

  // Use error message if it's user-friendly
  if (error.message && !error.message.includes('Error:')) {
    return error.message;
  }

  // Fallback to generic message
  return 'An unexpected error occurred. Please try again.';
}

/**
 * Handle an error with optional notification
 *
 * @param {Error} error - Error to handle
 * @param {Object} [notifications] - NotificationCenter instance
 * @param {Object} [options] - Options
 * @param {string} [options.category] - Notification category
 * @param {boolean} [options.silent=false] - If true, don't show notification
 * @param {string} [options.context] - Context for debug logging
 */
export function handleError(error, notifications, options = {}) {
  const { category = 'error', silent = false, context = 'Unknown' } = options;

  // Skip cancelled operations (these are intentional, not errors)
  if (isCancellationError(error)) {
    debug('ErrorHandler', `Cancelled operation in ${context}`);
    return;
  }

  // Log for debugging
  debugError('ErrorHandler', `Error in ${context}:`, error);

  // Show notification if not silent
  if (!silent && notifications) {
    const message = formatErrorForUser(error);
    notifications.error(message, { category });
  }
}

// =============================================================================
// ASYNC WRAPPERS
// =============================================================================

/**
 * Wrap an async function with standardized error handling
 *
 * @template T
 * @param {() => Promise<T>} fn - Async function to wrap
 * @param {string} context - Context for error logging
 * @param {string} [fallbackMessage] - Message if error has no message
 * @returns {Promise<T>} Result of the function
 * @throws {AnalysisError} Re-throws with standardized format
 *
 * @example
 * const data = await wrapAsync(
 *   () => api.fetchGenes(),
 *   'GeneLoader',
 *   'Failed to load gene list'
 * );
 */
export async function wrapAsync(fn, context, fallbackMessage = 'Operation failed') {
  try {
    return await fn();
  } catch (error) {
    // Re-throw cancellation errors as-is
    if (isCancellationError(error)) {
      throw error;
    }

    // Already an AnalysisError - re-throw
    if (error instanceof AnalysisError) {
      debugError(context, error.message, error);
      throw error;
    }

    // Wrap in AnalysisError
    const message = error?.message || fallbackMessage;
    debugError(context, message, error);
    throw new AnalysisError(message, 'ANALYSIS_ERROR', { originalError: error });
  }
}

/**
 * Try an async operation and return null on failure
 *
 * @template T
 * @param {() => Promise<T>} fn - Async function to try
 * @param {string} context - Context for error logging
 * @returns {Promise<T|null>} Result or null on failure
 *
 * @example
 * const data = await tryAsync(() => loadOptionalData(), 'OptionalLoader');
 * if (data) {
 *   // Use data
 * }
 */
export async function tryAsync(fn, context) {
  try {
    return await fn();
  } catch (error) {
    if (!isCancellationError(error)) {
      debugError(context, 'Operation failed (non-critical)', error);
    }
    return null;
  }
}

/**
 * Execute an async operation with a timeout
 *
 * @template T
 * @param {() => Promise<T>} fn - Async function to execute
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} [context] - Context for error message
 * @returns {Promise<T>}
 * @throws {TimeoutError} If operation times out
 *
 * @example
 * const result = await withTimeout(
 *   () => expensiveComputation(),
 *   30000,
 *   'ExpensiveComputation'
 * );
 */
export async function withTimeout(fn, timeoutMs, context = 'Operation') {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TimeoutError(`${context} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * Retry an async operation with exponential backoff
 *
 * @template T
 * @param {() => Promise<T>} fn - Async function to retry
 * @param {Object} [options] - Retry options
 * @param {number} [options.maxAttempts=3] - Maximum retry attempts
 * @param {number} [options.initialDelayMs=1000] - Initial delay between retries
 * @param {number} [options.maxDelayMs=10000] - Maximum delay between retries
 * @param {string} [options.context] - Context for logging
 * @returns {Promise<T>}
 *
 * @example
 * const data = await retry(
 *   () => unstableApi.fetch(),
 *   { maxAttempts: 3, context: 'UnstableAPI' }
 * );
 */
export async function retry(fn, options = {}) {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 10000,
    context = 'Retry'
  } = options;

  let lastError;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry cancellations or timeouts
      if (isCancellationError(error) || isTimeoutError(error)) {
        throw error;
      }

      if (attempt < maxAttempts) {
        debug(context, `Attempt ${attempt} failed, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, maxDelayMs);
      }
    }
  }

  throw lastError;
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default {
  // Error classes
  AnalysisError,
  DataError,
  ComputeError,
  CancelledError,
  TimeoutError,
  // Error messages
  ERROR_MESSAGES,
  getErrorMessage,
  // Error checking
  isCancellationError,
  isTimeoutError,
  formatErrorForUser,
  handleError,
  // Async wrappers
  wrapAsync,
  tryAsync,
  withTimeout,
  retry
};
