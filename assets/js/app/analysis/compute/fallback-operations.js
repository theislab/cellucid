/**
 * Fallback Operations Module
 *
 * Provides main-thread fallback implementations for all worker operations.
 * Used when Web Workers are unavailable or fail.
 *
 * REFACTORED: Now delegates to shared operation-handlers.js.
 * This eliminates code duplication with data-worker.js.
 */

// Import shared implementation
import { executeOperation } from './operation-handlers.js';

// ============================================================================
// Main Execution Router
// ============================================================================

/**
 * Execute a fallback operation by type.
 * Used by ComputeManager when GPU and Workers are unavailable.
 *
 * @param {string} type - Operation type
 * @param {Object} payload - Operation payload
 * @returns {any} Operation result
 * @throws {Error} If operation type is unknown
 */
export function executeFallback(type, payload) {
  // Delegate to the shared operation handler
  return executeOperation(type, payload);
}

export default { executeFallback };
