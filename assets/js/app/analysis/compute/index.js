/**
 * Compute Module - Public API
 *
 * This is the main entry point for the compute module.
 * Import from this file for all compute-related functionality.
 *
 * Directory Structure:
 * ```
 * compute/
 * ├── index.js                    # This file - public exports
 * ├── operations.js               # Operation definitions (single source of truth)
 * ├── math-utils.js               # Shared mathematical utilities
 * ├── operation-handlers.js       # Shared operation implementations
 * ├── compute-manager.js          # Main orchestrator (GPU → Worker → CPU)
 * ├── gpu-compute.js              # WebGL2 GPU backend
 * ├── worker-pool.js              # Multi-worker pool
 * ├── data-worker.js              # Web worker implementation
 * └── fallback-operations.js      # CPU fallback wrapper
 * ```
 *
 * Recommended Usage:
 * - Use ComputeManager for most operations (handles GPU → Worker → CPU fallback)
 * - Use WorkerPool directly for parallel batch processing
 * - Use operation handlers directly for synchronous main-thread processing
 */

// ============================================================================
// Operation Definitions (Single Source of Truth)
// ============================================================================

export {
  // Enums and constants
  OperationType,
  OperationCategory,
  Operations,
  GPU_CAPABLE_OPERATIONS,
  WORKER_CAPABLE_OPERATIONS,

  // Helper functions
  getOperation,
  isValidOperation,
  isGPUCapable,
  isWorkerCapable,
  getOperationsByCategory,
  validatePayload,
  getAllOperationIds,
  getAllOperations
} from './operations.js';

// ============================================================================
// Mathematical Utilities
// ============================================================================

export {
  // Distribution functions
  normalCDF,
  tCDF,
  incompleteBeta,
  gammaLn,

  // Correlation functions
  computePearsonR,
  computeSpearmanR,
  computeRanks,
  linearRegression,

  // Statistical tests
  mannWhitneyU,
  welchTTest,

  // Binning functions
  equalWidthBreaks,
  quantileBreaks,

  // Condition evaluation
  FilterOperator,
  evaluateCondition,

  // Formatting
  formatNumber,
  formatPValue,

  // Value utilities
  filterNumeric,
  isValidNumber,
  isMissing
} from './math-utils.js';

// ============================================================================
// Operation Handlers (Shared Implementations)
// ============================================================================

export {
  // Transform operations
  log1pTransform,
  zscoreNormalize,
  minmaxNormalize,
  scaleTransform,
  clampTransform,

  // Extraction operations
  extractValues,
  batchExtract,

  // Statistical operations
  computeStats,
  computeCorrelation,
  computeDifferential,

  // Aggregation operations
  aggregateCategories,
  binValues,

  // Filtering operations
  filterCells,

  // Distribution operations
  computeDensity,
  computeHistogram,
  compareDistributions,

  // Unified router
  executeOperation
} from './operation-handlers.js';

// ============================================================================
// ComputeManager (Recommended - handles GPU → Worker → CPU fallback)
// ============================================================================

export {
  ComputeManager,
  BackendStatus,
  getComputeManager,
  createComputeManager,
  initComputeManager
} from './compute-manager.js';

// ============================================================================
// GPU Compute (WebGL2 Transform Feedback)
// ============================================================================

export {
  GPUCompute,
  getGPUCompute,
  createGPUCompute
} from './gpu-compute.js';

// ============================================================================
// Worker Pool (Multi-worker parallel processing)
// ============================================================================

export {
  WorkerPool,
  getWorkerPool,
  createWorkerPool
} from './worker-pool.js';

// ============================================================================
// Fallback Operations (CPU fallback)
// ============================================================================

export { executeFallback } from './fallback-operations.js';

// ============================================================================
// Default Export
// ============================================================================

// Export the most commonly used items as default
// Note: re-exports do not create local bindings, so we import explicitly.
import { getComputeManager, initComputeManager } from './compute-manager.js';
import { OperationType, Operations } from './operations.js';
import { getWorkerPool } from './worker-pool.js';

export default { getComputeManager, initComputeManager, OperationType, Operations, getWorkerPool };
