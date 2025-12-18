/**
 * Data Processing Web Worker
 *
 * Handles computationally intensive data operations off the main thread:
 * - Value extraction from large cell arrays
 * - Statistical computations
 * - Correlation analysis
 * - Data aggregation
 *
 * This prevents UI blocking when processing large single-cell datasets (100K+ cells)
 *
 * Worker Pool Support:
 * When used with WorkerPool, the worker receives an INIT message with its ID.
 * This enables coordinated parallel processing across multiple workers.
 *
 * REFACTORED: Now uses shared operation-handlers.js for all implementations.
 * This eliminates code duplication with fallback-operations.js.
 */

/* eslint-env worker */

// Import shared operation handlers and math utilities
// These are ES modules that work in both main thread and worker context
import { executeOperation } from './operation-handlers.js';
import { OperationType } from './operations.js';

// ============================================================================
// Worker Pool State
// ============================================================================

let workerId = null;
let poolSize = 1;

// ============================================================================
// Message Handler
// ============================================================================

self.onmessage = function(e) {
  const { type, payload, requestId } = e.data;

  // Handle INIT message from worker pool
  if (type === 'INIT') {
    workerId = payload.id;
    poolSize = payload.poolSize || 1;
    self.postMessage({ type: 'INIT_ACK', workerId });
    return;
  }

  // Handle GET_WORKER_INFO special case
  if (type === 'GET_WORKER_INFO') {
    self.postMessage({
      requestId,
      success: true,
      result: { workerId, poolSize }
    });
    return;
  }

  try {
    // Use the shared operation handler
    const result = executeOperation(type, payload);

    self.postMessage({ requestId, success: true, result });

  } catch (error) {
    self.postMessage({
      requestId,
      success: false,
      error: error.message
    });
  }
};

// ============================================================================
// Error Handler
// ============================================================================

self.onerror = function(error) {
  console.error('[DataWorker] Unhandled error:', error);
};

// ============================================================================
// Export for testing (optional)
// ============================================================================

// Make OperationType available for direct worker testing
export { OperationType };
