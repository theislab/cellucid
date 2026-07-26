/**
 * Clustering Engine
 *
 * Hierarchical clustering for expression matrices.
 * Supports multiple distance metrics and linkage methods.
 *
 * Features:
 * - Row and column clustering
 * - Correlation, Euclidean, and Cosine distance metrics
 * - Average, Complete, and Single linkage methods
 * - Dendrogram tree structure generation
 *
 * Implementation notes:
 * - Uses an O(n² log n) heap-based agglomerative clustering loop (Lance–Williams updates)
 * - Periodically yields to the event loop to keep the UI responsive
 * - Supports AbortSignal so repeated runs/cancels don't leave the app stuck
 *
 * Performance Notes:
 * - Distance matrix computation: O(n²)
 * - Hierarchical clustering: O(n² log n)
 * - Safe for matrices up to ~500 rows/cols
 *
 * @module genes-panel/clustering-engine
 */

import {
  computeDistanceMatrix,
  reorderRows,
  reorderCols,
  transposeMatrix
} from '../shared/matrix-utils.js';
import { isFiniteNumber } from '../shared/number-utils.js';
import { DEFAULTS, ANALYSIS_PHASES } from './constants.js';

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
      onProgress,
      signal
    } = options;

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
    let rowOrder = Array.from({ length: nRows }, (_, i) => i);
    let colOrder = Array.from({ length: nCols }, (_, i) => i);
    let rowDendrogram = null;
    let colDendrogram = null;

    // Hierarchical clustering is O(n²) in memory and time.
    const MAX_CLUSTER_DIM = 500;
    if (clusterRows && nRows > MAX_CLUSTER_DIM) {
      throw new RangeError(
        `[ClusteringEngine] row clustering requested for ${nRows} rows; maximum is ${MAX_CLUSTER_DIM}`
      );
    }
    if (clusterCols && nCols > MAX_CLUSTER_DIM) {
      throw new RangeError(
        `[ClusteringEngine] column clustering requested for ${nCols} columns; maximum is ${MAX_CLUSTER_DIM}`
      );
    }
    const doClusterRows = clusterRows && nRows > 1;
    const doClusterCols = clusterCols && nCols > 1;

    if (!doClusterRows && !doClusterCols) {
      return {
        rowOrder,
        colOrder,
        rowDendrogram,
        colDendrogram,
        distance,
        linkage
      };
    }

    // Cluster rows (genes)
    if (doClusterRows) {
      throwIfAborted();
      if (onProgress) {
        onProgress({
          phase: ANALYSIS_PHASES.CLUSTERING,
          progress: 10,
          message: 'Computing row distances...'
        });
      }

      const rowDistMatrix = computeDistanceMatrix(values, nRows, nCols, distance);

      throwIfAborted();
      if (onProgress) {
        onProgress({
          phase: ANALYSIS_PHASES.CLUSTERING,
          progress: 30,
          message: 'Clustering rows...'
        });
      }

      const rowClustering = await this._hierarchicalCluster(rowDistMatrix, nRows, linkage, {
        signal,
        onProgress,
        progressBase: 30,
        progressSpan: doClusterCols ? 20 : 60,
        label: 'rows'
      });
      rowOrder = rowClustering.order;
      rowDendrogram = rowClustering.dendrogram;
    }

    // Cluster columns (groups)
    if (doClusterCols) {
      throwIfAborted();
      if (onProgress) {
        onProgress({
          phase: ANALYSIS_PHASES.CLUSTERING,
          progress: 50,
          message: 'Computing column distances...'
        });
      }

      // Transpose to compute column distances
      const transposed = transposeMatrix(values, nRows, nCols);
      const colDistMatrix = computeDistanceMatrix(transposed, nCols, nRows, distance);

      throwIfAborted();
      if (onProgress) {
        onProgress({
          phase: ANALYSIS_PHASES.CLUSTERING,
          progress: 70,
          message: 'Clustering columns...'
        });
      }

      const colClustering = await this._hierarchicalCluster(colDistMatrix, nCols, linkage, {
        signal,
        onProgress,
        progressBase: 70,
        progressSpan: 30,
        label: 'cols'
      });
      colOrder = colClustering.order;
      colDendrogram = colClustering.dendrogram;
    }

    if (onProgress) {
      onProgress({
        phase: ANALYSIS_PHASES.CLUSTERING,
        progress: 100,
        message: 'Clustering complete'
      });
    }

    return {
      rowOrder,
      colOrder,
      rowDendrogram,
      colDendrogram,
      distance,
      linkage
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

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  _sleep0() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  _linkageDistance(linkage, dIK, dJK, sizeI, sizeJ) {
    if (!isFiniteNumber(dIK) || !isFiniteNumber(dJK)) {
      throw new TypeError('[ClusteringEngine] linkage distances must be finite');
    }
    if (!Number.isSafeInteger(sizeI) || sizeI < 1 || !Number.isSafeInteger(sizeJ) || sizeJ < 1) {
      throw new RangeError('[ClusteringEngine] linkage cluster sizes must be positive integers');
    }

    if (linkage === 'single') {
      return Math.min(dIK, dJK);
    }
    if (linkage === 'complete') {
      return Math.max(dIK, dJK);
    }
    if (linkage !== 'average') {
      throw new RangeError(`[ClusteringEngine] unknown linkage method: ${String(linkage)}`);
    }
    return (dIK * sizeI + dJK * sizeJ) / (sizeI + sizeJ);
  }

  /**
   * Lightweight binary min-heap for (distance, i, j) pairs with version stamps.
   * Uses parallel arrays to avoid per-entry object allocations.
   */
  _createPairHeap() {
    return {
      d: /** @type {number[]} */ ([]),
      i: /** @type {number[]} */ ([]),
      j: /** @type {number[]} */ ([]),
      vi: /** @type {number[]} */ ([]),
      vj: /** @type {number[]} */ ([]),
      size() { return this.d.length; },
      push(dist, a, b, va, vb) {
        const idx = this.d.length;
        this.d.push(dist);
        this.i.push(a);
        this.j.push(b);
        this.vi.push(va);
        this.vj.push(vb);

        // sift up
        let k = idx;
        while (k > 0) {
          const p = (k - 1) >> 1;
          if (this.d[p] <= this.d[k]) break;
          this._swap(k, p);
          k = p;
        }
      },
      pop() {
        const n = this.d.length;
        if (n === 0) return null;
        const out = {
          dist: this.d[0],
          i: this.i[0],
          j: this.j[0],
          vi: this.vi[0],
          vj: this.vj[0]
        };

        if (n === 1) {
          this.d.pop(); this.i.pop(); this.j.pop(); this.vi.pop(); this.vj.pop();
          return out;
        }

        this.d[0] = this.d.pop();
        this.i[0] = this.i.pop();
        this.j[0] = this.j.pop();
        this.vi[0] = this.vi.pop();
        this.vj[0] = this.vj.pop();

        // sift down
        let k = 0;
        while (true) {
          const left = k * 2 + 1;
          const right = left + 1;
          let best = k;
          if (left < this.d.length && this.d[left] < this.d[best]) best = left;
          if (right < this.d.length && this.d[right] < this.d[best]) best = right;
          if (best === k) break;
          this._swap(k, best);
          k = best;
        }

        return out;
      },
      _swap(a, b) {
        let t = this.d[a]; this.d[a] = this.d[b]; this.d[b] = t;
        t = this.i[a]; this.i[a] = this.i[b]; this.i[b] = t;
        t = this.j[a]; this.j[a] = this.j[b]; this.j[b] = t;
        t = this.vi[a]; this.vi[a] = this.vi[b]; this.vi[b] = t;
        t = this.vj[a]; this.vj[a] = this.vj[b]; this.vj[b] = t;
      }
    };
  }

  /**
   * Perform hierarchical clustering
   *
   * @param {Float32Array} distMatrix - Distance matrix (n x n)
   * @param {number} n - Number of items
   * @param {'average'|'complete'|'single'} linkage - Linkage method
   * @param {Object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {Function} [options.onProgress]
   * @param {number} [options.progressBase=0]
   * @param {number} [options.progressSpan=100]
   * @param {string} [options.label='items']
   * @returns {Promise<{ order: number[], dendrogram: Object|null }>}
   * @private
   */
  async _hierarchicalCluster(distMatrix, n, linkage, options = {}) {
    if (!Number.isSafeInteger(n) || n < 1) {
      throw new RangeError('[ClusteringEngine] cluster size must be a positive integer');
    }
    if (
      (!Array.isArray(distMatrix) && !ArrayBuffer.isView(distMatrix)) ||
      distMatrix.length !== n * n
    ) {
      throw new RangeError('[ClusteringEngine] distance matrix must contain n × n values');
    }
    if (n <= 1) {
      return {
        order: [0],
        dendrogram: { id: 0, isLeaf: true, height: 0 }
      };
    }

    const { signal, onProgress, progressBase = 0, progressSpan = 100, label = 'items' } = options;
    const throwIfAborted = () => {
      if (signal?.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }
    };

    // We'll mutate a local copy of the distance matrix.
    const dist = new Float32Array(distMatrix);

    // Active clusters are indexed 0..n-1; we reuse the lower index as the merge target.
    const active = new Uint8Array(n);
    active.fill(1);
    let activeCount = n;

    const sizes = new Uint32Array(n);
    sizes.fill(1);

    // Version stamps invalidate stale heap entries after merges.
    const versions = new Uint32Array(n);

    // Dendrogram nodes: leaves first, then internal nodes.
    const nodes = new Array(2 * n - 1);
    for (let i = 0; i < n; i++) {
      nodes[i] = { id: i, isLeaf: true, height: 0, left: null, right: null };
    }
    let nextNodeId = n;

    const nodeIdByCluster = new Int32Array(n);
    for (let i = 0; i < n; i++) nodeIdByCluster[i] = i;

    const heap = this._createPairHeap();

    // Initialize heap with every pair distance.
    // For n<=500 this is safe and keeps clustering O(n^2 log n) without UI lock-ups.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = dist[i * n + j];
        if (!isFiniteNumber(d)) {
          throw new TypeError(
            `[ClusteringEngine] distance between items ${i} and ${j} must be finite`
          );
        }
        heap.push(d, i, j, 0, 0);
      }

      if (i > 0 && i % 64 === 0) {
        throwIfAborted();
        await this._sleep0();
      }
    }

    if (heap.size() === 0) {
      throw new Error('[ClusteringEngine] distance heap is empty for a multi-item matrix');
    }

    let merges = 0;
    while (activeCount > 1) {
      throwIfAborted();

      // Find the closest *valid* pair (lazy-delete stale heap entries).
      let entry = null;
      while (heap.size() > 0) {
        const e = heap.pop();
        if (!e) break;
        const { i, j, vi, vj } = e;
        if (!active[i] || !active[j]) continue;
        if (versions[i] !== vi || versions[j] !== vj) continue;
        entry = e;
        break;
      }

      if (!entry) {
        throw new Error(
          `[ClusteringEngine] no valid merge pair remains with ${activeCount} active clusters`
        );
      }

      const { dist: minDist } = entry;
      let i = entry.i;
      let j = entry.j;
      if (j < i) { const t = i; i = j; j = t; }

      if (!active[i] || !active[j]) continue;

      const sizeI = sizes[i];
      const sizeJ = sizes[j];
      const newSize = sizeI + sizeJ;

      // Create dendrogram node and attach to the merge target (i).
      const leftNode = nodes[nodeIdByCluster[i]];
      const rightNode = nodes[nodeIdByCluster[j]];
      if (!leftNode || !rightNode) {
        throw new Error('[ClusteringEngine] dendrogram node ownership is incomplete');
      }
      const newNode = { id: nextNodeId, isLeaf: false, height: minDist, left: leftNode, right: rightNode };
      nodes[nextNodeId] = newNode;
      nodeIdByCluster[i] = nextNodeId;
      nextNodeId++;

      // Mark j inactive and update i's size/version.
      active[j] = 0;
      activeCount--;
      sizes[i] = newSize;
      sizes[j] = 0;
      versions[i] = versions[i] + 1;
      versions[j] = versions[j] + 1;

      // Update distances for the merged cluster i.
      for (let k = 0; k < n; k++) {
        if (!active[k] || k === i) continue;

        const dIK = dist[i * n + k];
        const dJK = dist[j * n + k];
        const newDist = this._linkageDistance(linkage, dIK, dJK, sizeI, sizeJ);
        if (!isFiniteNumber(newDist)) {
          throw new TypeError('[ClusteringEngine] linkage produced a non-finite distance');
        }

        dist[i * n + k] = newDist;
        dist[k * n + i] = newDist;

        // Push updated pair entry (lazy invalidation will discard stale ones).
        const a = i < k ? i : k;
        const b = i < k ? k : i;
        heap.push(newDist, a, b, versions[a], versions[b]);
      }

      merges++;

      if (onProgress && merges % 10 === 0) {
        const pct = progressBase + Math.min(progressSpan, Math.round((merges / (n - 1)) * progressSpan));
        onProgress({
          phase: ANALYSIS_PHASES.CLUSTERING,
          progress: pct,
          message: `Clustering ${label}... (${merges}/${n - 1})`
        });
      }

      // Yield periodically to keep the UI responsive.
      if (merges % 8 === 0) {
        await this._sleep0();
      }
    }

    // Find the remaining active cluster as root.
    let rootIdx = -1;
    for (let i = 0; i < n; i++) {
      if (active[i]) { rootIdx = i; break; }
    }

    if (rootIdx < 0 || activeCount !== 1) {
      throw new Error('[ClusteringEngine] clustering did not produce exactly one root');
    }
    const rootNode = nodes[nodeIdByCluster[rootIdx]];
    if (!rootNode) {
      throw new Error('[ClusteringEngine] clustering root node is missing');
    }
    const order = this._extractLeafOrder(rootNode);
    if (
      order.length !== n ||
      new Set(order).size !== n ||
      order.some(index => !Number.isSafeInteger(index) || index < 0 || index >= n)
    ) {
      throw new Error('[ClusteringEngine] dendrogram leaf order is not an exact permutation');
    }

    return { order, dendrogram: rootNode };
  }

  /**
   * Extract leaf order from dendrogram (in-order traversal)
   *
   * @param {Object} node - Dendrogram node
   * @returns {number[]} Leaf indices in order
   * @private
   */
  _extractLeafOrder(node) {
    if (!node || typeof node !== 'object') {
      throw new TypeError('[ClusteringEngine] dendrogram node is required');
    }
    if (node.isLeaf) return [node.id];
    if (!node.left || !node.right) {
      throw new TypeError('[ClusteringEngine] internal dendrogram nodes require left and right children');
    }

    const leftOrder = this._extractLeafOrder(node.left);
    const rightOrder = this._extractLeafOrder(node.right);

    return [...leftOrder, ...rightOrder];
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a ClusteringEngine instance
 *
 * @param {Object} [options] - Same options as ClusteringEngine constructor
 * @returns {ClusteringEngine}
 */
export function createClusteringEngine(options) {
  return new ClusteringEngine(options);
}

export default ClusteringEngine;
