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

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

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
