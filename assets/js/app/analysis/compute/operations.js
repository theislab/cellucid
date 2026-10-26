/**
 * Unified Operation Definitions for Compute Module
 *
 * SINGLE SOURCE OF TRUTH for all compute operations.
 * All operation types and backend capabilities are defined here.
 *
 * This module is designed to be imported by:
 * - compute-manager.js (orchestrator)
 * - data-worker.js (worker implementation)
 * - operation-handlers.js (shared implementations)
 */

// ============================================================================
// Operation Type Enum
// ============================================================================

/**
 * Supported operation types - use these constants instead of strings.
 */
export const OperationType = {
  COMPUTE_CORRELATION: 'COMPUTE_CORRELATION',
  COMPUTE_DIFFERENTIAL: 'COMPUTE_DIFFERENTIAL',
  SET_TWO_GROUP_CONTEXT: 'SET_TWO_GROUP_CONTEXT',
  COMPUTE_DIFFERENTIAL_OF_COLUMNS: 'COMPUTE_DIFFERENTIAL_OF_COLUMNS',
  CLEAR_TWO_GROUP_CONTEXT: 'CLEAR_TWO_GROUP_CONTEXT',
  COMPUTE_DIFFERENTIAL_OF_SUBSET: 'COMPUTE_DIFFERENTIAL_OF_SUBSET',
  COMPUTE_KERNEL_DENSITY: 'COMPUTE_KERNEL_DENSITY',
  COMPUTE_BOX_STATISTICS: 'COMPUTE_BOX_STATISTICS',
  COMPUTE_VIOLIN_DENSITY: 'COMPUTE_VIOLIN_DENSITY',
  COMPUTE_SUMMARY_STATISTICS: 'COMPUTE_SUMMARY_STATISTICS',
  COMPUTE_STATISTICAL_TESTS: 'COMPUTE_STATISTICAL_TESTS',
  COMPUTE_ORDER_STATISTICS: 'COMPUTE_ORDER_STATISTICS',
  COMPUTE_HISTOGRAM_SAMPLES: 'COMPUTE_HISTOGRAM_SAMPLES',
  COMPUTE_DENSITY_PLAN: 'COMPUTE_DENSITY_PLAN',
  COMPUTE_PAIRWISE_DISTANCES: 'COMPUTE_PAIRWISE_DISTANCES',
  COMPUTE_AGGLOMERATION: 'COMPUTE_AGGLOMERATION',
  COMPUTE_CSV_EXPORT: 'COMPUTE_CSV_EXPORT',
  COMPUTE_GENE_MOMENTS: 'COMPUTE_GENE_MOMENTS',
  // --- composition and dot plot ---
  COMPOSITION_COUNTS: 'COMPOSITION_COUNTS',
  GROUP_SUMMARY_SET_CONTEXT: 'GROUP_SUMMARY_SET_CONTEXT',
  GROUP_SUMMARY_COMPUTE_GENES: 'GROUP_SUMMARY_COMPUTE_GENES',
  GROUP_SUMMARY_CLEAR_CONTEXT: 'GROUP_SUMMARY_CLEAR_CONTEXT'
};

// ============================================================================
// Operation Definitions
// ============================================================================

/**
 * Operation definitions with backend capabilities.
 *
 * Each operation includes:
 * - id: Unique identifier (matches OperationType)
 * - name: Human-readable name
 * - description: Brief description of what the operation does
 * - workerCapable: Whether operation can run in Web Worker
 * - cpuCapable: Whether operation can run on the main thread
 */
const Operations = {
  [OperationType.COMPUTE_CORRELATION]: {
    id: OperationType.COMPUTE_CORRELATION,
    name: 'Compute Correlation',
    description: 'Compute Pearson or Spearman correlation coefficient with p-value',
    workerCapable: true,
    cpuCapable: true
  },

  [OperationType.COMPUTE_DIFFERENTIAL]: {
    id: OperationType.COMPUTE_DIFFERENTIAL,
    name: 'Compute Differential Expression',
    description: 'Compute differential expression statistics (Mann-Whitney U or Welch t-test)',
    workerCapable: true,
    cpuCapable: true
  },

  [OperationType.SET_TWO_GROUP_CONTEXT]: {
    id: OperationType.SET_TWO_GROUP_CONTEXT,
    name: 'Set Two-Group Context',
    description: 'Hold the two groups of a differential expression run, cell by cell, for its genes',
    workerCapable: true,
    cpuCapable: true
  },

  [OperationType.COMPUTE_DIFFERENTIAL_OF_COLUMNS]: {
    id: OperationType.COMPUTE_DIFFERENTIAL_OF_COLUMNS,
    name: 'Compute Differential Expression of Gene Columns',
    description: 'Differential expression of a batch of whole gene columns between the two held groups',
    workerCapable: true,
    cpuCapable: true
  },

  [OperationType.CLEAR_TWO_GROUP_CONTEXT]: {
    id: OperationType.CLEAR_TWO_GROUP_CONTEXT,
    name: 'Clear Two-Group Context',
    description: 'Release the two groups held for a differential expression run',
    workerCapable: true,
    cpuCapable: true
  },

  [OperationType.COMPUTE_DIFFERENTIAL_OF_SUBSET]: {
    id: OperationType.COMPUTE_DIFFERENTIAL_OF_SUBSET,
    name: 'Compute Differential Expression of a Cell Subset',
    description: 'Differential expression of a run of genes read in the cells of the two held groups',
    workerCapable: true,
    cpuCapable: true
  },

  [OperationType.COMPUTE_KERNEL_DENSITY]: {
    id: OperationType.COMPUTE_KERNEL_DENSITY,
    name: 'Compute Kernel Density',
    description: 'Evaluate a Gaussian kernel density at a slice of evaluation points',
    workerCapable: true,
    cpuCapable: true
  },

  [OperationType.COMPUTE_BOX_STATISTICS]: {
    id: OperationType.COMPUTE_BOX_STATISTICS,
    name: 'Compute Box Statistics',
    description: 'Box-plot statistics and drawn points, as Plotly computes them from raw values',
    workerCapable: true,
    cpuCapable: true
  },

  [OperationType.COMPUTE_VIOLIN_DENSITY]: {
    id: OperationType.COMPUTE_VIOLIN_DENSITY,
    name: 'Compute Violin Density',
    description: 'A slice of the kernel density grid a violin draws, as Plotly computes it',
    workerCapable: true,
    cpuCapable: true
  },

  [OperationType.COMPUTE_SUMMARY_STATISTICS]: {
    id: OperationType.COMPUTE_SUMMARY_STATISTICS,
    name: 'Compute Summary Statistics',
    description: 'Count, mean, median, standard deviation, minimum and maximum of one page',
    workerCapable: true,
    cpuCapable: true
  },

  [OperationType.COMPUTE_STATISTICAL_TESTS]: {
    id: OperationType.COMPUTE_STATISTICAL_TESTS,
    name: 'Compute Statistical Tests',
    description: 'The two-group or multi-group tests of continuous pages',
    workerCapable: true,
    cpuCapable: true
  },

  [OperationType.COMPUTE_ORDER_STATISTICS]: {
    id: OperationType.COMPUTE_ORDER_STATISTICS,
    name: 'Compute Order Statistics',
    description: 'Values at given positions of the ascending order of finite values',
    workerCapable: true,
    cpuCapable: true
  },

  [OperationType.COMPUTE_HISTOGRAM_SAMPLES]: {
    id: OperationType.COMPUTE_HISTOGRAM_SAMPLES,
    name: 'Compute Histogram Samples',
    description: 'Shared histogram bins and each page\'s representative sample',
    workerCapable: true,
    cpuCapable: true
  },

  [OperationType.COMPUTE_DENSITY_PLAN]: {
    id: OperationType.COMPUTE_DENSITY_PLAN,
    name: 'Compute Density Plan',
    description: 'A page\'s density curve, or the plan its kernel sum is split by',
    workerCapable: true,
    cpuCapable: true
  },

  [OperationType.COMPUTE_PAIRWISE_DISTANCES]: {
    id: OperationType.COMPUTE_PAIRWISE_DISTANCES,
    name: 'Compute Pairwise Distances',
    description: 'A block of rows of the condensed distance matrix of a clustering',
    workerCapable: true,
    cpuCapable: true
  },

  [OperationType.COMPUTE_AGGLOMERATION]: {
    id: OperationType.COMPUTE_AGGLOMERATION,
    name: 'Compute Agglomeration',
    description: 'Hierarchical clustering merges and leaf order from condensed distance blocks',
    workerCapable: true,
    cpuCapable: true
  },

  [OperationType.COMPUTE_CSV_EXPORT]: {
    id: OperationType.COMPUTE_CSV_EXPORT,
    name: 'Compute CSV Export',
    description: 'The lines of a range of rows of a per-cell CSV file, as a Blob',
    workerCapable: true,
    cpuCapable: true
  },

  [OperationType.COMPUTE_GENE_MOMENTS]: {
    id: OperationType.COMPUTE_GENE_MOMENTS,
    name: 'Compute Gene Moments',
    description: 'Sum, sum of squares and non-zero count of each of a batch of gene columns over every cell',
    workerCapable: true,
    cpuCapable: true
  },

  // --- composition and dot plot ---
  [OperationType.COMPOSITION_COUNTS]: {
    id: OperationType.COMPOSITION_COUNTS,
    name: 'Composition Counts',
    description: 'Cells of each cell type in each sample or condition, in one pass over the cells',
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.GROUP_SUMMARY_SET_CONTEXT]: {
    id: OperationType.GROUP_SUMMARY_SET_CONTEXT,
    name: 'Set Group Summary Context',
    description: 'Hold the group of every cell for a dot plot run',
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.GROUP_SUMMARY_COMPUTE_GENES]: {
    id: OperationType.GROUP_SUMMARY_COMPUTE_GENES,
    name: 'Group Summary of Genes',
    description: 'Per-group sum, cells above the expression cutoff and their sum, for a run of genes',
    workerCapable: true,
    cpuCapable: true
  },
  [OperationType.GROUP_SUMMARY_CLEAR_CONTEXT]: {
    id: OperationType.GROUP_SUMMARY_CLEAR_CONTEXT,
    name: 'Clear Group Summary Context',
    description: 'Release the groups of a dot plot run',
    workerCapable: true,
    cpuCapable: true
  }
};

/**
 * Set of operations that can run in Web Workers.
 * All current operations have the same shared implementation in a worker.
 */
export const WORKER_CAPABLE_OPERATIONS = new Set(
  Object.values(Operations)
    .filter(op => op.workerCapable)
    .map(op => op.id)
);

/**
 * Set of operations with an exact main-thread implementation.
 */
export const CPU_CAPABLE_OPERATIONS = new Set(
  Object.values(Operations)
    .filter(op => op.cpuCapable)
    .map(op => op.id)
);

/**
 * Check if operation exists
 * @param {string} operationId - Operation ID
 * @returns {boolean} True if operation exists
 */
export function isValidOperation(operationId) {
  return Object.hasOwn(Operations, operationId);
}
