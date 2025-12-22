/**
 * Expression Matrix Builder
 *
 * Builds expression matrices for heatmap visualization from marker discovery results.
 * Computes mean expression per group and applies transformations.
 *
 * Features:
 * - Group-wise mean expression computation
 * - Z-score and log1p transformations
 * - Row-major Float32Array output for efficient storage
 * - Streaming gene loading for memory efficiency (no per-group array allocations)
 *
 * @module genes-panel/expression-matrix-builder
 */

import { StreamingGeneLoader } from '../data/streaming-gene-loader.js';
import { zscoreRows, log1pTransform } from '../shared/matrix-utils.js';
import { isFiniteNumber } from '../shared/number-utils.js';
import { DEFAULTS, ANALYSIS_PHASES } from './constants.js';

// =============================================================================
// EXPRESSION MATRIX BUILDER
// =============================================================================

/**
 * Expression Matrix Builder
 *
 * Builds expression matrices from marker genes and group specifications.
 *
 * @example
 * const builder = new ExpressionMatrixBuilder({ dataLayer });
 * const matrix = await builder.buildMatrix({
 *   genes: ['CD3D', 'CD19', 'CD14'],
 *   groups: [
 *     { groupId: 'T_cells', cellIndices: [...] },
 *     { groupId: 'B_cells', cellIndices: [...] }
 *   ],
 *   transform: 'zscore'
 * });
 */
export class ExpressionMatrixBuilder {
  /**
   * Create an ExpressionMatrixBuilder
   *
   * @param {Object} options
   * @param {Object} options.dataLayer - DataLayer instance for loading genes
   * @param {Object} [options.config] - Configuration overrides
   */
  constructor(options) {
    const { dataLayer, config = {} } = options;

    if (!dataLayer) {
      throw new Error('[ExpressionMatrixBuilder] dataLayer is required');
    }

    /** @type {Object} DataLayer instance */
    this.dataLayer = dataLayer;

    /** @type {Object} Configuration */
    this._config = {
      batchSize: config.batchSize ?? DEFAULTS.batchSize,
      networkConcurrency: config.networkConcurrency ?? DEFAULTS.networkConcurrency
    };
  }

  /**
   * Build an expression matrix for heatmap visualization
   *
   * @param {Object} options
   * @param {string[]} options.genes - Gene symbols (rows)
   * @param {Object[]} options.groups - Group specifications (columns)
   * @param {string} options.groups[].groupId - Unique group identifier
   * @param {string} [options.groups[].groupName] - Display name
   * @param {number[]|Uint32Array} options.groups[].cellIndices - Cell indices
   * @param {string} [options.groups[].color] - Group color
   * @param {'none'|'zscore'|'log1p'} [options.transform='zscore'] - Transform to apply
   * @param {Function} [options.onProgress] - Progress callback
   * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
   * @returns {Promise<ExpressionMatrix>} Expression matrix
   */
  async buildMatrix(options) {
    const {
      genes,
      groups,
      transform = DEFAULTS.transform,
      batchConfig = {},
      onProgress,
      signal
    } = options;

    if (!genes || genes.length === 0) {
      throw new Error('[ExpressionMatrixBuilder] genes array is required');
    }
    if (!groups || groups.length === 0) {
      throw new Error('[ExpressionMatrixBuilder] groups array is required');
    }

    const nRows = genes.length;
    const nCols = groups.length;

    // Initialize raw matrix (row-major: genes × groups)
    const rawMatrix = new Float32Array(nRows * nCols);
    rawMatrix.fill(NaN);

    // Create streaming loader
    const loader = new StreamingGeneLoader({
      dataLayer: this.dataLayer,
      config: {
        preloadCount: batchConfig.preloadCount ?? this._config.batchSize,
        networkConcurrency: batchConfig.networkConcurrency ?? this._config.networkConcurrency,
        memoryBudgetMB: batchConfig.memoryBudgetMB
      },
      onProgress: onProgress ? (p) => {
        onProgress({
          phase: ANALYSIS_PHASES.MATRIX,
          progress: Math.round((p.loaded / p.total) * 100),
          loaded: p.loaded,
          total: p.total,
          message: `Loading gene ${p.loaded} of ${p.total}`
        });
      } : null,
      signal
    });

    // Precompute group index arrays for tight loops (avoid repeated property lookups).
    const groupIndices = groups.map((g) => g.cellIndices);

    // Stream raw genes and compute per-group means without allocating per-group arrays.
    for await (const { values, index: geneIdx } of loader.streamGenesRaw(genes)) {
      if (signal?.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }
      // `StreamingGeneLoader.streamGenesRaw()` yields genes in the same order
      // as the requested `genes` array (index is the request index).
      if (!Number.isFinite(geneIdx) || geneIdx < 0 || geneIdx >= nRows) continue;

      // Compute mean expression for each group
      for (let g = 0; g < nCols; g++) {
        rawMatrix[geneIdx * nCols + g] = this._computeMeanByIndices(values, groupIndices[g]);
      }
    }

    if (signal?.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }

    // Apply transformation
    let transformedMatrix = rawMatrix;
    if (transform === 'zscore') {
      transformedMatrix = zscoreRows(rawMatrix, nRows, nCols);
    } else if (transform === 'log1p') {
      transformedMatrix = log1pTransform(rawMatrix);
    }

    // Build metadata arrays
    const groupIds = groups.map(g => g.groupId);
    const groupNames = groups.map(g => g.groupName || g.groupId);
    const groupColors = groups.map(g => g.color || '#999999');

    return {
      genes,
      groupIds,
      groupNames,
      groupColors,
      values: transformedMatrix,
      rawValues: transform !== 'none' ? rawMatrix : null,
      nRows,
      nCols,
      transform
    };
  }

  /**
   * Build matrix from pre-loaded gene data (when data is already in memory)
   *
   * @param {Object} options
   * @param {string[]} options.genes - Gene symbols (rows)
   * @param {Object[]} options.groups - Group specifications (columns)
   * @param {Map<string, Map<string, Float32Array>>} options.geneData - Pre-loaded gene data
   *        Map of gene -> Map of groupId -> values
   * @param {'none'|'zscore'|'log1p'} [options.transform='zscore'] - Transform to apply
   * @returns {ExpressionMatrix} Expression matrix
   */
  buildMatrixFromData(options) {
    const {
      genes,
      groups,
      geneData,
      transform = DEFAULTS.transform
    } = options;

    const nRows = genes.length;
    const nCols = groups.length;

    // Initialize raw matrix
    const rawMatrix = new Float32Array(nRows * nCols);
    rawMatrix.fill(NaN);

    // Fill matrix with mean values
    for (let r = 0; r < nRows; r++) {
      const gene = genes[r];
      const geneGroupData = geneData.get(gene);

      if (!geneGroupData) continue;

      for (let c = 0; c < nCols; c++) {
        const group = groups[c];
        const values = geneGroupData.get(group.groupId);

        if (values && values.length > 0) {
          rawMatrix[r * nCols + c] = this._computeMean(values);
        }
      }
    }

    // Apply transformation
    let transformedMatrix = rawMatrix;
    if (transform === 'zscore') {
      transformedMatrix = zscoreRows(rawMatrix, nRows, nCols);
    } else if (transform === 'log1p') {
      transformedMatrix = log1pTransform(rawMatrix);
    }

    // Build metadata arrays
    const groupIds = groups.map(g => g.groupId);
    const groupNames = groups.map(g => g.groupName || g.groupId);
    const groupColors = groups.map(g => g.color || '#999999');

    return {
      genes,
      groupIds,
      groupNames,
      groupColors,
      values: transformedMatrix,
      rawValues: transform !== 'none' ? rawMatrix : null,
      nRows,
      nCols,
      transform
    };
  }

  /**
   * Re-transform an existing matrix with a different transformation
   *
   * @param {ExpressionMatrix} matrix - Existing matrix
   * @param {'none'|'zscore'|'log1p'} transform - New transform to apply
   * @returns {ExpressionMatrix} New matrix with different transform
   */
  retransform(matrix, transform) {
    const rawValues = matrix.rawValues || matrix.values;

    let transformedMatrix = rawValues;
    if (transform === 'zscore') {
      transformedMatrix = zscoreRows(rawValues, matrix.nRows, matrix.nCols);
    } else if (transform === 'log1p') {
      transformedMatrix = log1pTransform(rawValues);
    }

    return {
      ...matrix,
      values: transformedMatrix,
      rawValues: rawValues,
      transform
    };
  }

  /**
   * Extract a submatrix for a subset of genes and/or groups
   *
   * @param {ExpressionMatrix} matrix - Source matrix
   * @param {Object} options
   * @param {string[]} [options.genes] - Subset of genes (null = all)
   * @param {string[]} [options.groupIds] - Subset of groups (null = all)
   * @returns {ExpressionMatrix} Submatrix
   */
  extractSubmatrix(matrix, options) {
    const { genes = null, groupIds = null } = options;

    // Determine row indices
    let rowIndices;
    let outGenes;
    if (genes) {
      const geneIndexMap = new Map(matrix.genes.map((g, i) => [g, i]));
      rowIndices = genes.map(g => geneIndexMap.get(g)).filter(i => i !== undefined);
      outGenes = rowIndices.map(i => matrix.genes[i]);
    } else {
      rowIndices = matrix.genes.map((_, i) => i);
      outGenes = matrix.genes;
    }

    // Determine column indices
    let colIndices;
    let outGroupIds, outGroupNames, outGroupColors;
    if (groupIds) {
      const groupIndexMap = new Map(matrix.groupIds.map((g, i) => [g, i]));
      colIndices = groupIds.map(g => groupIndexMap.get(g)).filter(i => i !== undefined);
      outGroupIds = colIndices.map(i => matrix.groupIds[i]);
      outGroupNames = colIndices.map(i => matrix.groupNames[i]);
      outGroupColors = colIndices.map(i => matrix.groupColors[i]);
    } else {
      colIndices = matrix.groupIds.map((_, i) => i);
      outGroupIds = matrix.groupIds;
      outGroupNames = matrix.groupNames;
      outGroupColors = matrix.groupColors;
    }

    // Extract submatrix
    const nRows = rowIndices.length;
    const nCols = colIndices.length;
    const values = new Float32Array(nRows * nCols);
    const rawValues = matrix.rawValues ? new Float32Array(nRows * nCols) : null;

    for (let r = 0; r < nRows; r++) {
      const srcRow = rowIndices[r];
      for (let c = 0; c < nCols; c++) {
        const srcCol = colIndices[c];
        const srcIdx = srcRow * matrix.nCols + srcCol;
        const dstIdx = r * nCols + c;
        values[dstIdx] = matrix.values[srcIdx];
        if (rawValues && matrix.rawValues) {
          rawValues[dstIdx] = matrix.rawValues[srcIdx];
        }
      }
    }

    return {
      genes: outGenes,
      groupIds: outGroupIds,
      groupNames: outGroupNames,
      groupColors: outGroupColors,
      values,
      rawValues,
      nRows,
      nCols,
      transform: matrix.transform
    };
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Compute mean of finite values
   * @private
   */
  _computeMean(values) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!isFiniteNumber(v)) continue;
      sum += v;
      count++;
    }
    return count > 0 ? (sum / count) : NaN;
  }

  /**
   * Compute mean of finite values at the provided indices.
   *
   * This avoids allocating a per-group gathered array for every (gene, group)
   * combination, which significantly reduces peak memory and GC churn.
   *
   * @private
   * @param {ArrayLike<number>} values - Per-cell gene values (length = nCells)
   * @param {ArrayLike<number>} indices - Cell indices for the group
   * @returns {number}
   */
  _computeMeanByIndices(values, indices) {
    if (!indices || indices.length === 0) return NaN;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      const v = values[idx];
      if (!isFiniteNumber(v)) continue;
      sum += v;
      count++;
    }
    return count > 0 ? (sum / count) : NaN;
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create an ExpressionMatrixBuilder instance
 *
 * @param {Object} options - Same options as ExpressionMatrixBuilder constructor
 * @returns {ExpressionMatrixBuilder}
 */
export function createExpressionMatrixBuilder(options) {
  return new ExpressionMatrixBuilder(options);
}

export default ExpressionMatrixBuilder;
