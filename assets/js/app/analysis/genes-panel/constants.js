/**
 * Genes Panel Constants
 *
 * Shared constants, default configurations, and JSDoc type definitions
 * for the marker genes panel feature.
 *
 * Design Principles:
 * - All configurable values in one place for easy tuning
 * - Type definitions provide IDE support and documentation
 * - Error messages centralized for consistent UX
 *
 * @module genes-panel/constants
 */

// =============================================================================
// DEFAULT CONFIGURATION
// =============================================================================

/**
 * Default analysis settings
 */
export const DEFAULTS = {
  // Analysis parameters
  topNPerGroup: 10,
  method: 'wilcox',
  minCells: 10,
  pValueThreshold: 0.05,
  foldChangeThreshold: 1.0,
  useAdjustedPValue: true,

  // Visualization parameters
  transform: 'zscore',
  colorscale: 'RdBu',
  showValues: false,

  // Clustering parameters
  distance: 'correlation',
  linkage: 'average',
  clusterRows: true,
  clusterCols: true,

  // Performance parameters
  batchSize: 100,
  memoryBudgetMB: 512,
  // Must agree with PerformanceConfig.batch.networkConcurrency; see the
  // measurement recorded there for why twelve.
  networkConcurrency: 12,
  progressInterval: 100, // Emit partial results every N genes

  // Cache parameters
  cacheMaxCategories: 3, // Hot cache: number of categories to keep in memory
  cacheMaxAgeDays: 7,    // Warm cache: IndexedDB TTL
  cacheVersion: 1        // Increment to invalidate old caches
};

// =============================================================================
// OPTION SCHEMAS (for UI rendering)
// =============================================================================

/**
 * Top N options for marker selection
 */
export const TOP_N_OPTIONS = [
  { value: 5, label: '5 genes', description: 'Quick overview' },
  { value: 10, label: '10 genes', description: 'Standard analysis' },
  { value: 20, label: '20 genes', description: 'Detailed analysis' },
  { value: 50, label: '50 genes', description: 'Comprehensive' },
  { value: 100, label: '100 genes', description: 'Full panel' },
  { value: 'all', label: 'All genes', description: 'Return all genes (slower, larger tables)', selected: true }
];

/**
 * Statistical method options
 */
export const METHOD_OPTIONS = [
  {
    value: 'wilcox',
    label: 'Wilcoxon',
    description: 'Rank-based test, robust to outliers and non-normal distributions.',
    selected: true
  },
  {
    value: 'ttest',
    label: 't-test',
    description: 'Parametric test, assumes normally distributed expression data.'
  }
];

/**
 * Transform options for heatmap display
 */
export const TRANSFORM_OPTIONS = [
  { value: 'zscore', label: 'Z-score', description: 'Row-wise standardization (mean=0, std=1)', selected: true },
  { value: 'log1p', label: 'Log(1+x)', description: 'Log transform for visualization' },
  { value: 'none', label: 'None', description: 'Raw expression values' }
];

/**
 * Colorscale options for heatmap
 */
export const COLORSCALE_OPTIONS = [
  { value: 'RdBu', label: 'Red-Blue', description: 'Diverging, good for z-scores', selected: true },
  { value: 'Viridis', label: 'Viridis', description: 'Perceptually uniform, colorblind-safe' },
  { value: 'Blues', label: 'Blues', description: 'Sequential blue gradient' },
  { value: 'YlOrRd', label: 'Yellow-Red', description: 'Sequential warm gradient' },
  { value: 'Greens', label: 'Greens', description: 'Sequential green gradient' }
];

/**
 * Distance metric options for clustering
 */
export const DISTANCE_OPTIONS = [
  { value: 'correlation', label: 'Correlation', description: '1 - Pearson r', selected: true },
  { value: 'euclidean', label: 'Euclidean', description: 'Straight-line distance' },
  { value: 'cosine', label: 'Cosine', description: 'Angular distance' }
];

/**
 * Linkage method options for hierarchical clustering
 */
export const LINKAGE_OPTIONS = [
  { value: 'average', label: 'Average', description: 'UPGMA - balanced clusters', selected: true },
  { value: 'complete', label: 'Complete', description: 'Maximum distance - compact clusters' },
  { value: 'single', label: 'Single', description: 'Minimum distance - chained clusters' }
];

/**
 * Display mode options
 */
export const MODE_OPTIONS = [
  { value: 'ranked', label: 'Ranked Genes', description: 'Show top markers sorted by significance' },
  { value: 'clustered', label: 'Clustered', description: 'Hierarchically clustered heatmap' },
  { value: 'custom', label: 'Custom Genes', description: 'User-defined gene list' }
];

// =============================================================================
// P-VALUE THRESHOLDS
// =============================================================================

export const P_VALUE_THRESHOLDS = [
  { value: 0.001, label: '0.001', description: 'Very stringent' },
  { value: 0.01, label: '0.01', description: 'Stringent' },
  { value: 0.05, label: '0.05', description: 'Standard', selected: true },
  { value: 0.1, label: '0.1', description: 'Permissive' }
];

export const FOLD_CHANGE_THRESHOLDS = [
  { value: 0.5, label: '0.5', description: '1.4x change' },
  { value: 1.0, label: '1.0', description: '2x change', selected: true },
  { value: 1.5, label: '1.5', description: '2.8x change' },
  { value: 2.0, label: '2.0', description: '4x change' }
];

// =============================================================================
// ERROR MESSAGES
// =============================================================================

/**
 * User-facing error messages with recovery hints.
 *
 * An entry that contains a `{placeholder}` is a template, and it reaches a user
 * only through `formatError`, which refuses to leave a placeholder unfilled.
 * Throwing such an entry directly would put the literal `{placeholder}` text in
 * front of the user, so `tests/genes-panel-error-message-substitution.test.mjs`
 * rejects any reference to a templated entry outside a `formatError` call.
 */
export const ERROR_MESSAGES = {
  NO_CATEGORICAL_OBS:
    'No categorical observation fields found. Upload data with cell type or cluster annotations.',

  TOO_FEW_CELLS:
    'Group "{name}" has only {n} cells. Minimum required: {min}.',

  TOO_FEW_GROUPS:
    'At least 2 groups required for marker analysis. Found: {n}.',

  NO_GENES_AVAILABLE:
    'This dataset publishes no gene expression fields, so no gene panel can be built. Load a dataset that includes gene expression.',

  GENE_NOT_FOUND:
    'Gene "{symbol}" not found in dataset. Check spelling or try another gene.',

  EMPTY_RESULTS:
    'No significant markers found with current thresholds. Try relaxing p-value ({pValue}) or fold change ({fc}) cutoffs.',

  CANCELLED:
    'Analysis cancelled by user.',

  MEMORY_PRESSURE:
    'Low memory detected. The analysis cannot continue within the configured memory budget.'
};

/**
 * Format an error message with variable substitution.
 *
 * @param {string} template - Message template from ERROR_MESSAGES
 * @param {Object} vars - Variables to substitute
 * @returns {string} Formatted message
 *
 * @example
 * formatError(ERROR_MESSAGES.TOO_FEW_CELLS, { name: 'T cells', n: 5, min: 10 })
 * // 'Group "T cells" has only 5 cells. Minimum required: 10.'
 */
export function formatError(template, vars = {}) {
  if (typeof template !== 'string' || template.length === 0) {
    throw new TypeError('Error template must be a non-empty string');
  }
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) {
    throw new TypeError('Error template variables must be an object');
  }
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (!Object.hasOwn(vars, key)) {
      throw new TypeError(`Missing error template variable: ${key}`);
    }
    const value = vars[key];
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new TypeError(`Error template variable ${key} must be scalar`);
    }
    return `${value}`;
  });
}

// =============================================================================
// PHASE NAMES (for progress tracking)
// =============================================================================

export const ANALYSIS_PHASES = {
  INIT: 'Initializing',
  DISCOVERY: 'Discovering markers',
  MATRIX: 'Building expression matrix',
  CLUSTERING: 'Clustering',
  RENDER: 'Rendering results'
};

// =============================================================================
// CACHE KEY PREFIXES
// =============================================================================

export const CACHE_KEYS = {
  MARKERS: 'markers',
  MATRIX: 'matrix',
  CLUSTERING: 'clustering'
};

// =============================================================================
// JSDoc TYPE DEFINITIONS
// =============================================================================

/**
 * @typedef {Object} GenesPanelConfig
 * @property {string} obsCategory - Observation field name (e.g., 'cell_type')
 * @property {'ranked'|'clustered'|'custom'} mode - Display mode
 * @property {string[]} [customGenes] - For custom mode only
 * @property {number} [topNPerGroup=10] - Top markers per group
 * @property {'wilcox'|'ttest'} [method='wilcox'] - Statistical method
 * @property {number} [minCells=10] - Minimum cells per group
 * @property {number} [pValueThreshold=0.05] - Significance cutoff
 * @property {number} [foldChangeThreshold=1.0] - |log2FC| cutoff
 * @property {boolean} [useAdjustedPValue=true] - Use FDR-corrected p-values
 * @property {'none'|'zscore'|'log1p'} [transform='zscore'] - Heatmap transform
 * @property {'RdBu'|'Viridis'|'Blues'|'YlOrRd'|'Greens'} [colorscale='RdBu']
 * @property {'correlation'|'euclidean'|'cosine'} [distance='correlation']
 * @property {'average'|'complete'|'single'} [linkage='average']
 * @property {boolean} [clusterRows=true]
 * @property {boolean} [clusterCols=true]
 * @property {Object} [batchConfig] - Performance tuning
 */

/**
 * @typedef {Object} MarkerGeneResult
 * @property {string} gene - Gene symbol
 * @property {string} groupId - Group identifier
 * @property {number} rank - Rank within group (1 = best)
 * @property {number} pValue - Raw p-value
 * @property {number|null} adjustedPValue - BH-corrected p-value
 * @property {number} log2FoldChange - Log2 fold change vs rest
 * @property {number} meanInGroup - Mean expression in group
 * @property {number} meanOutGroup - Mean expression outside group
 * @property {number} percentInGroup - % cells expressing in group
 * @property {number} percentOutGroup - % cells expressing outside
 */

/**
 * @typedef {Object} GroupMarkers
 * @property {string} groupId - Group identifier
 * @property {string|number|boolean} groupName - Exact categorical display label
 * @property {number} cellCount - Number of cells in group
 * @property {string} color - Group color for display
 * @property {MarkerGeneResult[]} markers - Sorted by rank ascending
 */

/**
 * @typedef {Object} MarkersByCategory
 * @property {string} obsCategory - Observation field analyzed
 * @property {'wilcox'|'ttest'} method - Method used
 * @property {number} computedAt - Timestamp
 * @property {number} computeDuration - Duration in ms
 * @property {number} geneCount - Total genes tested
 * @property {Record<string, GroupMarkers>} groups - Results per group
 */

/**
 * @typedef {Object} ExpressionMatrix
 * @property {string[]} genes - Row labels (gene symbols)
 * @property {string[]} groupIds - Column identifiers
 * @property {(string|number|boolean)[]} groupNames - Exact categorical display labels
 * @property {string[]} groupColors - Column colors
 * @property {Float32Array} values - Row-major flattened matrix
 * @property {number} nRows - Number of rows
 * @property {number} nCols - Number of columns
 * @property {'none'|'zscore'|'log1p'} transform - Applied transform
 */

/**
 * @typedef {Object} ClusteringResult
 * @property {number[]} rowOrder - Permutation of row indices
 * @property {number[]} colOrder - Permutation of column indices
 * @property {Object|null} rowDendrogram - Tree structure for rows
 * @property {Object|null} colDendrogram - Tree structure for columns
 * @property {'correlation'|'euclidean'|'cosine'} distance - Metric used
 * @property {'average'|'complete'|'single'} linkage - Linkage used
 */

/**
 * @typedef {Object} GenesPanelResult
 * @property {MarkersByCategory} markers - Discovered markers
 * @property {ExpressionMatrix} matrix - Expression matrix
 * @property {ClusteringResult|null} clustering - Clustering (if mode=clustered)
 * @property {Object} metadata - Additional info (timing, settings)
 */

/**
 * @typedef {Object} GroupSpec
 * @property {string} groupId - Unique group identifier
 * @property {string|number|boolean} groupName - Exact categorical display label
 * @property {number[]|Uint32Array} cellIndices - Explicit cell indices
 * @property {number[]|Uint32Array} [excludedCellIndices] - For rest-of groups
 * @property {string} [color] - Group color
 * @property {number} [cellCount] - Number of cells
 */

/**
 * @typedef {Object} ProgressUpdate
 * @property {string} phase - Current phase name
 * @property {number} progress - 0-100 percentage
 * @property {number} loaded - Items processed
 * @property {number} total - Total items
 * @property {string} [message] - Status message
 * @property {number} [eta] - Estimated seconds remaining
 */

export default {
  DEFAULTS,
  TOP_N_OPTIONS,
  METHOD_OPTIONS,
  TRANSFORM_OPTIONS,
  COLORSCALE_OPTIONS,
  DISTANCE_OPTIONS,
  LINKAGE_OPTIONS,
  MODE_OPTIONS,
  P_VALUE_THRESHOLDS,
  FOLD_CHANGE_THRESHOLDS,
  ERROR_MESSAGES,
  formatError,
  ANALYSIS_PHASES,
  CACHE_KEYS
};
