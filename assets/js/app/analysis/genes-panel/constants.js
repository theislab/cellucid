/**
 * Marker genes constants: the heatmap's display defaults, the messages a run
 * can end with, the progress phases, and the shapes of a result.
 *
 * The analysis options (groups, test, filters, ranking) are declared in
 * `options/marker-options.js`; nothing here duplicates them. A run sizes
 * itself (`shared/run-tuner.js`): there is no batch, memory or parallelism
 * setting.
 *
 * @module genes-panel/constants
 */

// =============================================================================
// DISPLAY DEFAULTS (the expanded view's heatmap)
// =============================================================================

export const DEFAULTS = Object.freeze({
  /** Heatmap value transform. */
  transform: 'zscore',
  colorscale: 'RdBu',
  showValues: false,
  /** Heatmap clustering (the expanded view's plot options). */
  distance: 'correlation',
  linkage: 'average',
  clusterRows: true,
  clusterCols: true,
});

// =============================================================================
// MESSAGES
// =============================================================================

/**
 * Messages a run can end with. An entry that contains a `{placeholder}` is a
 * template, and it reaches a user only through `formatError`, which refuses
 * to leave a placeholder unfilled
 * (`tests/genes-panel-error-message-substitution.test.mjs`).
 *
 * A small group is never an error (it is skipped, pooled or flagged:
 * `options/marker-options.js`), and neither is a filter that leaves no gene
 * (the result says so and offers to relax the filters).
 */
export const ERROR_MESSAGES = {
  NO_CATEGORICAL_OBS:
    'No categorical observation fields found. Upload data with cell type or cluster annotations.',

  TOO_FEW_GROUPS:
    'At least 2 groups with cells are needed to compare. Found: {n}.',

  NO_GENES_AVAILABLE:
    'This dataset publishes no gene expression fields, so no gene panel can be built. Load a dataset that includes gene expression.',

  NO_GENES_TO_TEST:
    'The gene filters leave no gene to test. Clear Exclude genes or Only genes in.'
};

/**
 * Format an error message with variable substitution.
 *
 * @param {string} template - Message template from ERROR_MESSAGES
 * @param {Object} vars - Variables to substitute
 * @returns {string} Formatted message
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
// PHASE NAMES (job steps)
// =============================================================================

export const ANALYSIS_PHASES = {
  INIT: 'Preparing groups',
  DISCOVERY: 'Testing genes',
  CORRECTION: 'Correcting for multiple testing',
  CLUSTERING: 'Clustering',
  RENDER: 'Drawing the result'
};

// =============================================================================
// RESULT SHAPES
// =============================================================================

/**
 * @typedef {Object} MarkerGroup
 * @property {string} groupId - `category-code:<code>`, or `pooled:small`
 * @property {string|number|boolean} groupName - Exact categorical label
 * @property {number} cellCount - Cells in scope
 * @property {string} color
 * @property {boolean} tested - Tested against its reference
 * @property {boolean} small - Fewer cells than the minimum
 * @property {'skipped'|'pooled'|null} smallFate - What the small-group policy did
 */

/**
 * The full statistics of a marker run: every tested gene for every group,
 * so filters, ranking and the number shown are re-applied without testing
 * again (`marker-selection.js`).
 *
 * @typedef {Object} MarkerStatistics
 * @property {string[]} genes - The genes tested, in dataset order
 * @property {MarkerGroup[]} groups
 * @property {Float64Array[]} pValuesByGroup - NaN where untested
 * @property {Float64Array[]} adjustedPValuesByGroup
 * @property {Float32Array[]} scoresByGroup - Rank-sum z or Welch t
 * @property {Float32Array[]} log2FoldChangeByGroup
 * @property {Float32Array[]} meanInGroupByGroup
 * @property {Float32Array[]} pctInByGroup - % of the group's cells non-zero
 * @property {Float32Array[]} pctRefByGroup - % of the reference's cells non-zero
 * @property {Float32Array[]} aurocByGroup - NaN for t-tests
 * @property {number[]} genesTestedByGroup - The multiple-testing family size
 */

/**
 * @typedef {Object} ExpressionMatrix
 * @property {string[]} genes - Row labels (gene symbols)
 * @property {string[]} groupIds - Column identifiers
 * @property {(string|number|boolean)[]} groupNames - Exact categorical display labels
 * @property {string[]} groupColors - Column colors
 * @property {Float32Array} values - Row-major flattened matrix
 * @property {Float32Array|null} rawValues - The means before the transform
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
