/**
 * CancellableOperation - Centralized abort pattern for async operations
 *
 * Provides a clean abstraction for managing cancellable async operations,
 * handling race conditions, and coordinating multiple concurrent requests.
 *
 * Usage:
 * ```js
 * import { CancellableOperation, createOperationContext } from './cancellable-operation.js';
 *
 * class AnalysisComponent {
 *   constructor() {
 *     this._operation = new CancellableOperation();
 *   }
 *
 *   async runAnalysis(params) {
 *     // Start a new operation, cancelling any previous one
 *     const ctx = this._operation.start();
 *
 *     // Check if operation was cancelled before async work
 *     if (ctx.isCancelled()) return null;
 *
 *     const data = await fetchData(params);
 *
 *     // Check again after async work
 *     if (ctx.isCancelled()) return null;
 *
 *     // Process and return result
 *     return processData(data);
 *   }
 *
 *   destroy() {
 *     this._operation.cancel();
 *   }
 * }
 * ```
 *
 * @module shared/cancellable-operation
 */

import { CancelledError } from './error-utils.js';

// =============================================================================
// OPERATION CONTEXT
// =============================================================================

/**
 * Context for a single operation instance
 * Tracks whether the operation has been cancelled and provides utilities
 */
export class OperationContext {
  /**
   * @param {number} id - Unique operation ID
   * @param {AbortSignal} signal - AbortController signal
   */
  constructor(id, signal) {
    this._id = id;
    this._signal = signal;
    this._cancelled = false;
  }

  /**
   * Get the operation ID
   * @returns {number}
   */
  get id() {
    return this._id;
  }

  /**
   * Get the AbortSignal for fetch/other APIs
   * @returns {AbortSignal}
   */
  get signal() {
    return this._signal;
  }

  /**
   * Check if this operation has been cancelled
   * @returns {boolean}
   */
  isCancelled() {
    return this._cancelled || this._signal.aborted;
  }

  /**
   * Mark as cancelled (internal use)
   */
  _markCancelled() {
    this._cancelled = true;
  }

  /**
   * Throw CancelledError if operation is cancelled
   * Use this at checkpoints in long-running operations
   * @throws {CancelledError}
   */
  throwIfCancelled() {
    if (this.isCancelled()) {
      throw new CancelledError('Operation was cancelled');
    }
  }

  /**
   * Execute a function only if not cancelled
   * @template T
   * @param {() => T} fn - Function to execute
   * @returns {T|null} Result or null if cancelled
   */
  ifNotCancelled(fn) {
    if (this.isCancelled()) return null;
    return fn();
  }

  /**
   * Execute an async function with cancellation check before and after
   * @template T
   * @param {() => Promise<T>} fn - Async function to execute
   * @returns {Promise<T|null>} Result or null if cancelled
   */
  async runAsync(fn) {
    if (this.isCancelled()) return null;
    const result = await fn();
    if (this.isCancelled()) return null;
    return result;
  }
}

// =============================================================================
// CANCELLABLE OPERATION
// =============================================================================

let operationCounter = 0;

/**
 * Manages a single cancellable operation slot
 * Starting a new operation automatically cancels any previous one
 */
export class CancellableOperation {
  constructor() {
    this._currentId = 0;
    this._controller = null;
    this._context = null;
  }

  /**
   * Start a new operation, cancelling any previous one
   * @returns {OperationContext}
   */
  start() {
    // Cancel previous operation if exists
    this.cancel();

    // Create new operation
    this._currentId = ++operationCounter;
    this._controller = new AbortController();
    this._context = new OperationContext(this._currentId, this._controller.signal);

    return this._context;
  }

  /**
   * Cancel the current operation if any
   */
  cancel() {
    if (this._controller) {
      this._controller.abort();
      if (this._context) {
        this._context._markCancelled();
      }
    }
    this._controller = null;
    this._context = null;
  }

  /**
   * Get the current operation context
   * @returns {OperationContext|null}
   */
  getCurrentContext() {
    return this._context;
  }

  /**
   * Check if there's an active operation
   * @returns {boolean}
   */
  isActive() {
    return this._context !== null && !this._context.isCancelled();
  }

  /**
   * Check if a given context is still the current operation
   * @param {OperationContext} ctx - Context to check
   * @returns {boolean}
   */
  isCurrent(ctx) {
    return ctx && ctx.id === this._currentId && !ctx.isCancelled();
  }
}

// =============================================================================
// MULTI-SLOT OPERATION MANAGER
// =============================================================================

/**
 * Manages multiple named cancellable operations
 * Useful when a component needs to track several independent async operations
 */
export class OperationManager {
  constructor() {
    /** @type {Map<string, CancellableOperation>} */
    this._operations = new Map();
  }

  /**
   * Get or create an operation slot by name
   * @param {string} name - Operation name
   * @returns {CancellableOperation}
   */
  getOrCreate(name) {
    if (!this._operations.has(name)) {
      this._operations.set(name, new CancellableOperation());
    }
    return this._operations.get(name);
  }

  /**
   * Start a named operation
   * @param {string} name - Operation name
   * @returns {OperationContext}
   */
  start(name) {
    return this.getOrCreate(name).start();
  }

  /**
   * Cancel a named operation
   * @param {string} name - Operation name
   */
  cancel(name) {
    const op = this._operations.get(name);
    if (op) {
      op.cancel();
    }
  }

  /**
   * Cancel all operations
   */
  cancelAll() {
    for (const op of this._operations.values()) {
      op.cancel();
    }
  }

  /**
   * Check if a named operation is active
   * @param {string} name - Operation name
   * @returns {boolean}
   */
  isActive(name) {
    const op = this._operations.get(name);
    return op ? op.isActive() : false;
  }

  /**
   * Clean up - cancel all operations
   */
  destroy() {
    this.cancelAll();
    this._operations.clear();
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Create a simple operation context for one-off use
 * @returns {{ context: OperationContext, cancel: Function }}
 */
export function createOperationContext() {
  const controller = new AbortController();
  const context = new OperationContext(++operationCounter, controller.signal);

  return {
    context,
    cancel: () => {
      controller.abort();
      context._markCancelled();
    }
  };
}

/**
 * Wrap a promise with cancellation support
 *
 * @template T
 * @param {Promise<T>} promise - Promise to wrap
 * @param {AbortSignal} signal - AbortSignal to check
 * @returns {Promise<T>}
 * @throws {CancelledError} If cancelled before completion
 */
export function withCancellation(promise, signal) {
  return new Promise((resolve, reject) => {
    // Check if already aborted
    if (signal.aborted) {
      reject(new CancelledError('Operation was cancelled'));
      return;
    }

    // Listen for abort
    const onAbort = () => {
      reject(new CancelledError('Operation was cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    // Wait for promise
    promise
      .then(result => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          reject(new CancelledError('Operation was cancelled'));
        } else {
          resolve(result);
        }
      })
      .catch(error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });
  });
}

/**
 * Create a request ID tracker for race condition prevention
 * This is a simpler alternative when you just need ID tracking
 *
 * @returns {{ next: () => number, isCurrent: (id: number) => boolean }}
 */
export function createRequestIdTracker() {
  let currentId = 0;

  return {
    /**
     * Get the next request ID
     * @returns {number}
     */
    next() {
      return ++currentId;
    },

    /**
     * Check if a request ID is still current
     * @param {number} id - ID to check
     * @returns {boolean}
     */
    isCurrent(id) {
      return id === currentId;
    }
  };
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default {
  // Classes
  OperationContext,
  CancellableOperation,
  OperationManager,
  // Helper functions
  createOperationContext,
  withCancellation,
  createRequestIdTracker
};
