/**
 * Clustering Engine
 *
 * Hierarchical clustering of the Genes panel heatmap matrix: its genes (rows)
 * and its groups (columns), by correlation, Euclidean or cosine distance with
 * average, complete or single linkage.
 *
 * The work runs in the analysis workers (compute/hierarchical-clustering.js):
 * the condensed distance matrix is computed in disjoint blocks of rows, one
 * per worker, and the merges are found in one worker from those blocks, which
 * are moved between threads, never copied. This thread only validates the
 * matrix, routes the arrays and builds the dendrogram nodes from the merge
 * table. Rows and columns are clustered at the same time.
 *
 * The clustering is exact: every step merges the closest pair of clusters
 * (ties: smallest cluster numbers) and updates distances by the linkage's
 * Lance-Williams rule, all in double precision. Its memory is the condensed
 * matrix, 8 bytes per item pair (`clusteringWorkingSetBytes`); clustering an
 * axis whose matrix does not fit the analysis memory budget is refused with
 * that reason, before anything is allocated (never silently left
 * unclustered).
 *
 * @module genes-panel/clustering-engine
 */

import {
  reorderRows,
  reorderCols,
  transposeMatrix
} from '../shared/matrix-utils.js';
import { isFiniteNumber } from '../shared/number-utils.js';
import { getComputeManager } from '../compute/compute-manager.js';
import { OperationType } from '../compute/operations.js';
import {
  clusteringWorkingSetBytes,
  condensedRowRanges
} from '../compute/hierarchical-clustering.js';
import { analysisWorkerCount } from '../shared/performance-config.js';
import { DEFAULTS, ANALYSIS_PHASES } from './constants.js';

/**
 * Why clustering an axis was refused, in the words a user reads.
 *
 * @param {'rows'|'columns'} axis
 * @param {number} count
 * @param {number} requiredBytes
 * @param {number} budgetBytes
 * @returns {string}
 */
function clusteringRefusal(axis, count, requiredBytes, budgetBytes) {
  const megabytes = bytes => Math.ceil(bytes / 2 ** 20).toLocaleString('en-US');
  const items = axis === 'rows' ? 'genes' : 'groups';
  return (
    `Clustering ${count.toLocaleString('en-US')} ${items} needs about ` +
    `${megabytes(requiredBytes)} MB of memory, more than the ` +
    `${megabytes(budgetBytes)} MB analysis memory budget. Raise the budget in ` +
    `Performance settings, use fewer ${items}, or turn clustering of ${items} off.`
  );
}

/**
 * Dendrogram nodes of a merge table: leaves `{id, isLeaf: true, height: 0}`
 * for ids 0 .. n - 1, then merge s as node n + s with its two children.
 *
 * @param {Int32Array} left
 * @param {Int32Array} right
 * @param {Float64Array} height
 * @param {number} n
 * @returns {Object} The root node
 */
function dendrogramOf(left, right, height, n) {
  const nodes = new Array(2 * n - 1);
  for (let id = 0; id < n; id++) {
    nodes[id] = { id, isLeaf: true, height: 0, left: null, right: null };
  }
  for (let step = 0; step < n - 1; step++) {
    nodes[n + step] = {
      id: n + step,
      isLeaf: false,
      height: height[step],
      left: nodes[left[step]],
      right: nodes[right[step]]
    };
  }
  return nodes[2 * n - 2];
}

// =============================================================================
// CLUSTERING ENGINE
// =============================================================================

/**
 * Clustering Engine
 *
 * Performs hierarchical clustering on expression matrices.
 *
 * @example
 * const engine = new ClusteringEngine();
 * const result = await engine.clusterMatrix({
 *   matrix: expressionMatrix,
 *   clusterRows: true,
 *   clusterCols: true,
 *   distance: 'correlation',
 *   linkage: 'average'
 * });
 */
export class ClusteringEngine {
  /**
   * Create a ClusteringEngine
   *
   * @param {Object} [options]
   * @param {Object} [options.config] - Configuration overrides
   */
  constructor(options = {}) {
    const { config = {} } = options;

    /** @type {Object} Configuration */
    this._config = {
      distance: config.distance ?? DEFAULTS.distance,
      linkage: config.linkage ?? DEFAULTS.linkage,
      clusterRows: config.clusterRows ?? DEFAULTS.clusterRows,
      clusterCols: config.clusterCols ?? DEFAULTS.clusterCols
    };
  }

  /**
   * Cluster an expression matrix
   *
   * @param {Object} options
   * @param {ExpressionMatrix} options.matrix - Expression matrix to cluster
   * @param {boolean} [options.clusterRows=true] - Whether to cluster rows (genes)
   * @param {boolean} [options.clusterCols=true] - Whether to cluster columns (groups)
   * @param {'correlation'|'euclidean'|'cosine'} [options.distance='correlation'] - Distance metric
   * @param {'average'|'complete'|'single'} [options.linkage='average'] - Linkage method
   * @param {number} options.memoryBudgetBytes - The analysis memory budget;
   *   clustering an axis whose working set exceeds it is refused
   * @param {Function} [options.onProgress] - Progress callback
   * @returns {Promise<ClusteringResult>} Clustering result with reordered indices
   */
  async clusterMatrix(options) {
    const {
      matrix,
      clusterRows = this._config.clusterRows,
      clusterCols = this._config.clusterCols,
      distance = this._config.distance,
      linkage = this._config.linkage,
      memoryBudgetBytes,
      onProgress,
      signal
    } = options;
    if (!Number.isSafeInteger(memoryBudgetBytes) || memoryBudgetBytes <= 0) {
      throw new TypeError('[ClusteringEngine] memoryBudgetBytes must be a positive integer');
    }

    if (!matrix || (!Array.isArray(matrix.values) && !ArrayBuffer.isView(matrix.values))) {
      throw new TypeError('[ClusteringEngine] matrix with numeric values is required');
    }

    const throwIfAborted = () => {
      if (signal?.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }
    };

    const { values, nRows, nCols } = matrix;
    if (!Number.isSafeInteger(nRows) || nRows < 1 || !Number.isSafeInteger(nCols) || nCols < 1) {
      throw new RangeError('[ClusteringEngine] matrix dimensions must be positive integers');
    }
    if (values.length !== nRows * nCols) {
      throw new RangeError('[ClusteringEngine] matrix value count must equal nRows × nCols');
    }
    for (let index = 0; index < values.length; index++) {
      if (!isFiniteNumber(values[index])) {
        throw new TypeError(`[ClusteringEngine] matrix value ${index} must be finite`);
      }
    }
    if (typeof clusterRows !== 'boolean' || typeof clusterCols !== 'boolean') {
      throw new TypeError('[ClusteringEngine] clusterRows and clusterCols must be booleans');
    }
    if (!['correlation', 'euclidean', 'cosine'].includes(distance)) {
      throw new RangeError(`[ClusteringEngine] unknown distance metric: ${String(distance)}`);
    }
    if (!['average', 'complete', 'single'].includes(linkage)) {
      throw new RangeError(`[ClusteringEngine] unknown linkage method: ${String(linkage)}`);
    }
    if (onProgress !== undefined && typeof onProgress !== 'function') {
      throw new TypeError('[ClusteringEngine] onProgress must be a function');
    }
    // Clustering is O(n²) in memory. A requested axis whose working set does
    // not fit the analysis memory budget is refused before anything is
    // allocated, with the reason; it is never returned unclustered.
    const admit = (requested, axis, count) => {
      if (!requested || count <= 1) return false;
      const requiredBytes = clusteringWorkingSetBytes(count);
      if (requiredBytes > memoryBudgetBytes) {
        throw new RangeError(clusteringRefusal(axis, count, requiredBytes, memoryBudgetBytes));
      }
      return true;
    };
    const doClusterRows = admit(clusterRows, 'rows', nRows);
    const doClusterCols = admit(clusterCols, 'columns', nCols);
    const identity = count => Array.from({ length: count }, (_, i) => i);

    if (!doClusterRows && !doClusterCols) {
      return {
        rowOrder: identity(nRows),
        colOrder: identity(nCols),
        rowDendrogram: null,
        colDendrogram: null,
        distance,
        linkage
      };
    }

    throwIfAborted();
    if (onProgress) {
      onProgress({
        phase: ANALYSIS_PHASES.CLUSTERING,
        progress: 10,
        message: doClusterRows ? 'Clustering genes...' : 'Clustering groups...'
      });
    }
    const computeManager = getComputeManager();
    await computeManager.init();
    const items = ArrayBuffer.isView(values) ? values : Float64Array.from(values);
    const [rows, cols] = await Promise.all([
      doClusterRows
        ? this._clusterAxis(computeManager, items, nRows, nCols, distance, linkage, signal)
        : null,
      doClusterCols
        ? this._clusterAxis(
          computeManager,
          transposeMatrix(items, nRows, nCols),
          nCols,
          nRows,
          distance,
          linkage,
          signal
        )
        : null
    ]);
    throwIfAborted();

    if (onProgress) {
      onProgress({
        phase: ANALYSIS_PHASES.CLUSTERING,
        progress: 100,
        message: 'Clustering complete'
      });
    }

    return {
      rowOrder: rows ? rows.order : identity(nRows),
      colOrder: cols ? cols.order : identity(nCols),
      rowDendrogram: rows ? rows.dendrogram : null,
      colDendrogram: cols ? cols.dendrogram : null,
      distance,
      linkage
    };
  }

  /**
   * Cluster the items (rows) of a row-major matrix in the analysis workers:
   * distance blocks on every worker, then the merges in one.
   *
   * @param {import('../compute/compute-manager.js').ComputeManager} computeManager
   * @param {Float32Array} values - Items × features, finite
   * @param {number} nItems - At least 2
   * @param {number} nFeatures
   * @param {string} metric
   * @param {string} linkage
   * @param {AbortSignal|undefined} signal
   * @returns {Promise<{order: number[], dendrogram: Object}>}
   * @private
   */
  async _clusterAxis(computeManager, values, nItems, nFeatures, metric, linkage, signal) {
    const ranges = condensedRowRanges(nItems, analysisWorkerCount());
    const execution = { signal: signal ?? null };
    const blocks = await Promise.all(ranges.map(([rowFrom, rowTo]) => computeManager.execute(
      OperationType.COMPUTE_PAIRWISE_DISTANCES,
      { values, nItems, nFeatures, metric, rowFrom, rowTo },
      // Every block reads the same items: each worker gets a copy.
      { ...execution, transfer: false }
    )));
    const merges = await computeManager.execute(
      OperationType.COMPUTE_AGGLOMERATION,
      { blocks: blocks.map(block => block.distances), ranges, nItems, linkage },
      execution
    );
    const { left, right, height, order } = merges;
    if (
      !(left instanceof Int32Array) || left.length !== nItems - 1 ||
      !(right instanceof Int32Array) || right.length !== nItems - 1 ||
      !(height instanceof Float64Array) || height.length !== nItems - 1 ||
      !(order instanceof Int32Array) || order.length !== nItems
    ) {
      throw new Error('[ClusteringEngine] agglomeration returned a malformed merge table');
    }
    return {
      order: Array.from(order),
      dendrogram: dendrogramOf(left, right, height, nItems)
    };
  }

  /**
   * Apply clustering result to reorder a matrix
   *
   * @param {ExpressionMatrix} matrix - Matrix to reorder
   * @param {ClusteringResult} clustering - Clustering result
   * @returns {ExpressionMatrix} Reordered matrix
   */
  applyOrdering(matrix, clustering) {
    const { rowOrder, colOrder } = clustering;
    const requirePermutation = (order, size, name) => {
      if (
        !Array.isArray(order) ||
        order.length !== size ||
        new Set(order).size !== size ||
        order.some(index => !Number.isSafeInteger(index) || index < 0 || index >= size)
      ) {
        throw new TypeError(`[ClusteringEngine] ${name} must be an exact permutation`);
      }
    };
    requirePermutation(rowOrder, matrix.nRows, 'rowOrder');
    requirePermutation(colOrder, matrix.nCols, 'colOrder');

    // Reorder values
    let reorderedValues = reorderRows(matrix.values, matrix.nRows, matrix.nCols, rowOrder);
    let reorderedRaw = matrix.rawValues;
    if (reorderedRaw !== undefined && reorderedRaw !== null) {
      reorderedRaw = reorderRows(reorderedRaw, matrix.nRows, matrix.nCols, rowOrder);
    }

    reorderedValues = reorderCols(reorderedValues, matrix.nRows, matrix.nCols, colOrder);
    if (reorderedRaw !== undefined && reorderedRaw !== null) {
      reorderedRaw = reorderCols(reorderedRaw, matrix.nRows, matrix.nCols, colOrder);
    }

    // Reorder metadata
    const reorderedGenes = rowOrder.map(i => matrix.genes[i]);
    const reorderedGroupIds = colOrder.map(i => matrix.groupIds[i]);
    const reorderedGroupNames = colOrder.map(i => matrix.groupNames[i]);
    const reorderedGroupColors = colOrder.map(i => matrix.groupColors[i]);

    return {
      ...matrix,
      genes: reorderedGenes,
      groupIds: reorderedGroupIds,
      groupNames: reorderedGroupNames,
      groupColors: reorderedGroupColors,
      values: reorderedValues,
      rawValues: reorderedRaw
    };
  }
}
