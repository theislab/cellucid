/**
 * Unified Operation Definitions for Compute Module
 *
 * SINGLE SOURCE OF TRUTH for all compute operations.
 * All operation types, metadata, and capabilities are defined here.
 *
 * This module is designed to be imported by:
 * - compute-manager.js (orchestrator)
 * - data-worker.js (worker implementation)
 * - fallback-operations.js (CPU fallback)
 * - operation-handlers.js (shared implementations)
 */

// ============================================================================
// Operation Categories
// ============================================================================

/**
 * Operation categories for grouping and filtering
 */
export const OperationCategory = {
  TRANSFORM: 'transform',        // Element-wise transforms (GPU-capable)
  STATISTICS: 'statistics',      // Statistical computations
  EXTRACTION: 'extraction',      // Data extraction operations
  AGGREGATION: 'aggregation',    // Category/value aggregation
  FILTERING: 'filtering',        // Cell/value filtering
  DISTRIBUTION: 'distribution'   // Distribution analysis
};

// ============================================================================
// Operation Type Enum (Backward Compatible)
// ============================================================================

/**
 * Supported operation types - use these constants instead of strings.
 * Exported for backward compatibility with existing code.
 */
export const OperationType = {
  // Transforms (GPU-accelerated)
  LOG1P: 'log1p',
  ZSCORE: 'zscore',
  MINMAX: 'minmax',
  SCALE: 'scale',
  CLAMP: 'clamp',

  // Statistics (Worker or CPU)
  COMPUTE_STATS: 'COMPUTE_STATS',
  COMPUTE_HISTOGRAM: 'COMPUTE_HISTOGRAM',
  COMPUTE_CORRELATION: 'COMPUTE_CORRELATION',
  COMPUTE_DIFFERENTIAL: 'COMPUTE_DIFFERENTIAL',
  COMPUTE_DENSITY: 'COMPUTE_DENSITY',

  // Data extraction (Worker or CPU)
  EXTRACT_VALUES: 'EXTRACT_VALUES',
  BATCH_EXTRACT: 'BATCH_EXTRACT',
  FILTER_CELLS: 'FILTER_CELLS',
  AGGREGATE_CATEGORIES: 'AGGREGATE_CATEGORIES',
  BIN_VALUES: 'BIN_VALUES',
  COMPARE_DISTRIBUTIONS: 'COMPARE_DISTRIBUTIONS'
};

// ============================================================================
// Operation Definitions
// ============================================================================

/**
 * Complete operation definitions with metadata.
 *
 * Each operation includes:
 * - id: Unique identifier (matches OperationType)
 * - name: Human-readable name
 * - description: Brief description of what the operation does
 * - category: Operation category for grouping
 * - gpuCapable: Whether operation can run on GPU
 * - workerCapable: Whether operation can run in Web Worker
 * - payloadFields: Required and optional payload fields
 * - resultFields: Fields returned in the result
 */
export const Operations = {
  // =========================================================================
  // Transform Operations (GPU-capable)
  // =========================================================================

  [OperationType.LOG1P]: {
    id: OperationType.LOG1P,
    name: 'Log1p Transform',
    description: 'Apply log(1 + x) transform, handles values near 0 better than log(1+x)',
    category: OperationCategory.TRANSFORM,
    gpuCapable: true,
    workerCapable: true,
    payloadFields: {
      required: ['values'],
      optional: []
    },
    resultFields: ['values']
  },

  [OperationType.ZSCORE]: {
    id: OperationType.ZSCORE,
    name: 'Z-Score Normalization',
    description: 'Normalize values to (x - mean) / std',
    category: OperationCategory.TRANSFORM,
    gpuCapable: true,
    workerCapable: true,
    payloadFields: {
      required: ['values'],
      optional: ['mean', 'std']  // If not provided, computed from values
    },
    resultFields: ['values', 'mean', 'std']
  },

  [OperationType.MINMAX]: {
    id: OperationType.MINMAX,
    name: 'Min-Max Normalization',
    description: 'Normalize values to (x - min) / (max - min)',
    category: OperationCategory.TRANSFORM,
    gpuCapable: true,
    workerCapable: true,
    payloadFields: {
      required: ['values'],
      optional: ['min', 'max']  // If not provided, computed from values
    },
    resultFields: ['values', 'min', 'max']
  },

  [OperationType.SCALE]: {
    id: OperationType.SCALE,
    name: 'Scale and Offset',
    description: 'Apply x * scale + offset transform',
    category: OperationCategory.TRANSFORM,
    gpuCapable: true,
    workerCapable: true,
    payloadFields: {
      required: ['values'],
      optional: ['scale', 'offset']  // Defaults: scale=1, offset=0
    },
    resultFields: ['values']
  },

  [OperationType.CLAMP]: {
    id: OperationType.CLAMP,
    name: 'Clamp Values',
    description: 'Clamp values to [min, max] range',
    category: OperationCategory.TRANSFORM,
    gpuCapable: true,
    workerCapable: true,
    payloadFields: {
      required: ['values'],
      optional: ['min', 'max']  // Defaults: min=0, max=1
    },
    resultFields: ['values']
  },

  // =========================================================================
  // Statistics Operations
  // =========================================================================

  [OperationType.COMPUTE_STATS]: {
    id: OperationType.COMPUTE_STATS,
    name: 'Compute Statistics',
    description: 'Compute comprehensive statistics: count, min, max, mean, median, std, q1, q3, iqr',
    category: OperationCategory.STATISTICS,
    gpuCapable: true,  // Basic stats can use GPU
    workerCapable: true,
    payloadFields: {
      required: ['values'],
      optional: []
    },
    resultFields: ['count', 'min', 'max', 'mean', 'median', 'std', 'q1', 'q3', 'iqr', 'sum', 'variance']
  },

  [OperationType.COMPUTE_HISTOGRAM]: {
    id: OperationType.COMPUTE_HISTOGRAM,
    name: 'Compute Histogram',
    description: 'Compute histogram with optimized binning (Sturges, Freedman-Diaconis, or custom)',
    category: OperationCategory.STATISTICS,
    gpuCapable: true,  // Histogram binning can use GPU
    workerCapable: true,
    payloadFields: {
      required: ['values'],
      optional: ['bins', 'range', 'nbins']  // bins: 'auto', 'sturges', 'fd', or number
    },
    resultFields: ['edges', 'counts', 'density', 'binWidth', 'total']
  },

  [OperationType.COMPUTE_CORRELATION]: {
    id: OperationType.COMPUTE_CORRELATION,
    name: 'Compute Correlation',
    description: 'Compute Pearson or Spearman correlation coefficient with p-value',
    category: OperationCategory.STATISTICS,
    gpuCapable: false,
    workerCapable: true,
    payloadFields: {
      required: ['xValues', 'yValues'],
      optional: ['method']  // 'pearson' (default) or 'spearman'
    },
    resultFields: ['r', 'rSquared', 'pValue', 'n', 'method', 'slope', 'intercept']
  },

  [OperationType.COMPUTE_DIFFERENTIAL]: {
    id: OperationType.COMPUTE_DIFFERENTIAL,
    name: 'Compute Differential Expression',
    description: 'Compute differential expression statistics (Mann-Whitney U or Welch t-test)',
    category: OperationCategory.STATISTICS,
    gpuCapable: false,
    workerCapable: true,
    payloadFields: {
      required: ['groupAValues', 'groupBValues'],
      optional: ['method']  // 'wilcox' (default) or 'ttest'
    },
    resultFields: ['meanA', 'meanB', 'log2FoldChange', 'pValue', 'statistic', 'nA', 'nB', 'method']
  },

  [OperationType.COMPUTE_DENSITY]: {
    id: OperationType.COMPUTE_DENSITY,
    name: 'Compute Kernel Density',
    description: 'Compute kernel density estimation using Gaussian kernel with Scott\'s rule bandwidth',
    category: OperationCategory.DISTRIBUTION,
    gpuCapable: false,
    workerCapable: true,
    payloadFields: {
      required: ['values'],
      optional: ['points']  // Number of density points (default: 100)
    },
    resultFields: ['x', 'y', 'bandwidth', 'n']
  },

  // =========================================================================
  // Extraction Operations
  // =========================================================================

  [OperationType.EXTRACT_VALUES]: {
    id: OperationType.EXTRACT_VALUES,
    name: 'Extract Values',
    description: 'Extract values for given cell indices from raw data array',
    category: OperationCategory.EXTRACTION,
    gpuCapable: false,
    workerCapable: true,
    payloadFields: {
      required: ['cellIndices', 'rawValues'],
      optional: ['categories', 'isCategorical']
    },
    resultFields: ['values', 'validIndices', 'validCount']
  },

  [OperationType.BATCH_EXTRACT]: {
    id: OperationType.BATCH_EXTRACT,
    name: 'Batch Extract Values',
    description: 'Extract values for multiple variables in one operation',
    category: OperationCategory.EXTRACTION,
    gpuCapable: false,
    workerCapable: true,
    payloadFields: {
      required: ['cellIndices', 'variables'],
      optional: []
    },
    resultFields: []  // Returns object keyed by variable.key
  },

  // =========================================================================
  // Aggregation Operations
  // =========================================================================

  [OperationType.AGGREGATE_CATEGORIES]: {
    id: OperationType.AGGREGATE_CATEGORIES,
    name: 'Aggregate Categories',
    description: 'Count occurrences of categorical values',
    category: OperationCategory.AGGREGATION,
    gpuCapable: false,
    workerCapable: true,
    payloadFields: {
      required: ['values'],
      optional: ['normalize']  // Whether to compute percentages
    },
    resultFields: ['categories', 'counts', 'total', 'percentages']
  },

  [OperationType.BIN_VALUES]: {
    id: OperationType.BIN_VALUES,
    name: 'Bin Values',
    description: 'Bin continuous values into categories (equal-width, quantile, or custom)',
    category: OperationCategory.AGGREGATION,
    gpuCapable: false,
    workerCapable: true,
    payloadFields: {
      required: ['values'],
      optional: ['method', 'binCount', 'customBreaks']  // method: 'equal_width', 'quantile', 'custom'
    },
    resultFields: ['bins', 'breaks', 'labels']
  },

  // =========================================================================
  // Filtering Operations
  // =========================================================================

  [OperationType.FILTER_CELLS]: {
    id: OperationType.FILTER_CELLS,
    name: 'Filter Cells',
    description: 'Filter cells based on multiple conditions with AND/OR logic',
    category: OperationCategory.FILTERING,
    gpuCapable: false,
    workerCapable: true,
    payloadFields: {
      required: ['cellIndices', 'conditions', 'fieldsData'],
      optional: []
    },
    resultFields: ['filtered', 'originalCount', 'filteredCount']
  },

  // =========================================================================
  // Distribution Operations
  // =========================================================================

  [OperationType.COMPARE_DISTRIBUTIONS]: {
    id: OperationType.COMPARE_DISTRIBUTIONS,
    name: 'Compare Distributions',
    description: 'Compare distributions from multiple groups with aligned histograms and densities',
    category: OperationCategory.DISTRIBUTION,
    gpuCapable: false,
    workerCapable: true,
    payloadFields: {
      required: ['groups'],
      optional: ['normalize']  // Whether to normalize histograms
    },
    resultFields: ['groups', 'range', 'bins']
  }
};

// ============================================================================
// GPU-Capable Operations Set
// ============================================================================

/**
 * Set of operations that can be accelerated on GPU.
 * Used by compute-manager.js to decide whether to use GPU backend.
 */
export const GPU_CAPABLE_OPERATIONS = new Set(
  Object.values(Operations)
    .filter(op => op.gpuCapable)
    .map(op => op.id)
);

// ============================================================================
// Worker-Capable Operations Set
// ============================================================================

/**
 * Set of operations that can run in Web Workers.
 * All operations support workers (including fallback).
 */
export const WORKER_CAPABLE_OPERATIONS = new Set(
  Object.values(Operations)
    .filter(op => op.workerCapable)
    .map(op => op.id)
);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get operation definition by ID
 * @param {string} operationId - Operation ID
 * @returns {Object|null} Operation definition or null if not found
 */
export function getOperation(operationId) {
  return Operations[operationId] || null;
}

/**
 * Check if operation exists
 * @param {string} operationId - Operation ID
 * @returns {boolean} True if operation exists
 */
export function isValidOperation(operationId) {
  return operationId in Operations;
}

/**
 * Check if operation is GPU-capable
 * @param {string} operationId - Operation ID
 * @returns {boolean} True if operation can run on GPU
 */
export function isGPUCapable(operationId) {
  return GPU_CAPABLE_OPERATIONS.has(operationId);
}

/**
 * Check if operation is Worker-capable
 * @param {string} operationId - Operation ID
 * @returns {boolean} True if operation can run in Web Worker
 */
export function isWorkerCapable(operationId) {
  return WORKER_CAPABLE_OPERATIONS.has(operationId);
}

/**
 * Get operations by category
 * @param {string} category - Category from OperationCategory
 * @returns {Object[]} Array of operation definitions
 */
export function getOperationsByCategory(category) {
  return Object.values(Operations).filter(op => op.category === category);
}

/**
 * Validate payload for an operation
 * @param {string} operationId - Operation ID
 * @param {Object} payload - Payload to validate
 * @returns {{valid: boolean, errors: string[]}} Validation result
 */
export function validatePayload(operationId, payload) {
  const operation = getOperation(operationId);
  if (!operation) {
    return { valid: false, errors: [`Unknown operation: ${operationId}`] };
  }

  const errors = [];
  const { required, optional } = operation.payloadFields;

  // Check required fields
  for (const field of required) {
    if (!(field in payload)) {
      errors.push(`Missing required field: ${field}`);
    } else if (payload[field] === undefined || payload[field] === null) {
      errors.push(`Required field is null/undefined: ${field}`);
    }
  }

  // Check for unknown fields (warning, not error)
  const knownFields = new Set([...required, ...optional]);
  for (const field of Object.keys(payload)) {
    if (!knownFields.has(field)) {
      // Just log warning, don't treat as error
      console.warn(`[Operations] Unknown field in payload for ${operationId}: ${field}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Get all operation IDs
 * @returns {string[]} Array of all operation IDs
 */
export function getAllOperationIds() {
  return Object.keys(Operations);
}

/**
 * Get all operations as array
 * @returns {Object[]} Array of all operation definitions
 */
export function getAllOperations() {
  return Object.values(Operations);
}

// ============================================================================
// Default Export
// ============================================================================

export default {
  OperationType,
  OperationCategory,
  Operations,
  GPU_CAPABLE_OPERATIONS,
  WORKER_CAPABLE_OPERATIONS,
  getOperation,
  isValidOperation,
  isGPUCapable,
  isWorkerCapable,
  getOperationsByCategory,
  validatePayload,
  getAllOperationIds,
  getAllOperations
};
