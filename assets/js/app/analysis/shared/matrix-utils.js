/**
 * Matrix Utilities
 *
 * Matrix operations of the Genes panel heatmap: transforms, transposition and
 * reordering. Clustering distances are computed in the analysis workers
 * (compute/hierarchical-clustering.js).
 *
 * Features:
 * - Row-wise z-score normalization
 * - Log1p transformation
 * - Matrix transposition and row/column reordering
 *
 * Performance Notes:
 * - All operations work with Float32Array for memory efficiency
 * - Single-pass algorithms where possible
 * - Safe for large matrices (100+ genes x 20+ groups)
 *
 * @module shared/matrix-utils
 */

import { isFiniteNumber, mean, std } from './number-utils.js';

// =============================================================================
// MATRIX TRANSFORMATIONS
// =============================================================================

/**
 * Apply row-wise z-score normalization to a matrix.
 * Each row is normalized to have mean=0 and std=1.
 *
 * @param {Float32Array} matrix - Row-major flattened matrix
 * @param {number} nRows - Number of rows
 * @param {number} nCols - Number of columns
 * @returns {Float32Array} New normalized matrix (does not mutate input)
 *
 * @example
 * const matrix = new Float32Array([1, 2, 3, 4, 5, 6]); // 2x3
 * const normalized = zscoreRows(matrix, 2, 3);
 */
export function zscoreRows(matrix, nRows, nCols) {
  const result = new Float32Array(matrix.length);

  for (let r = 0; r < nRows; r++) {
    const offset = r * nCols;
    const row = [];

    // Extract finite values from row
    for (let c = 0; c < nCols; c++) {
      const v = matrix[offset + c];
      if (isFiniteNumber(v)) row.push(v);
    }

    // Compute row statistics
    const mu = row.length > 0 ? mean(row) : 0;
    const sigma = row.length > 1 ? (std(row) || 1) : 1; // Avoid division by zero

    // Normalize row values
    for (let c = 0; c < nCols; c++) {
      const v = matrix[offset + c];
      result[offset + c] = isFiniteNumber(v) ? (v - mu) / sigma : 0;
    }
  }

  return result;
}

/**
 * Apply log1p transform (log(1 + x)) to all values.
 * Handles negative values by clamping to 0.
 *
 * @param {Float32Array} values - Input values
 * @returns {Float32Array} Transformed values
 *
 * @example
 * const values = new Float32Array([0, 1, 10, 100]);
 * const logged = log1pTransform(values);
 * // [0, 0.693, 2.398, 4.615]
 */
export function log1pTransform(values) {
  const result = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    result[i] = Math.log1p(Math.max(0, values[i]));
  }
  return result;
}

// =============================================================================
// MATRIX OPERATIONS
// =============================================================================

/**
 * Transpose a matrix from row-major to column-major (or vice versa).
 *
 * @param {Float32Array} matrix - Row-major flattened matrix
 * @param {number} nRows - Number of rows in input
 * @param {number} nCols - Number of columns in input
 * @returns {Float32Array} Transposed matrix (nCols x nRows)
 *
 * @example
 * const matrix = new Float32Array([1, 2, 3, 4, 5, 6]); // 2x3
 * const transposed = transposeMatrix(matrix, 2, 3);
 * // Returns 3x2 matrix: [1, 4, 2, 5, 3, 6]
 */
export function transposeMatrix(matrix, nRows, nCols) {
  const result = new Float32Array(matrix.length);
  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      result[c * nRows + r] = matrix[r * nCols + c];
    }
  }
  return result;
}

/**
 * Reorder matrix rows according to the given order.
 *
 * @param {Float32Array} matrix - Row-major flattened matrix
 * @param {number} nRows - Number of rows
 * @param {number} nCols - Number of columns
 * @param {number[]} rowOrder - Array of row indices in desired order
 * @returns {Float32Array} Reordered matrix
 */
export function reorderRows(matrix, nRows, nCols, rowOrder) {
  const result = new Float32Array(matrix.length);
  for (let i = 0; i < rowOrder.length; i++) {
    const srcRow = rowOrder[i];
    const srcOffset = srcRow * nCols;
    const dstOffset = i * nCols;
    for (let c = 0; c < nCols; c++) {
      result[dstOffset + c] = matrix[srcOffset + c];
    }
  }
  return result;
}

/**
 * Reorder matrix columns according to the given order.
 *
 * @param {Float32Array} matrix - Row-major flattened matrix
 * @param {number} nRows - Number of rows
 * @param {number} nCols - Number of columns
 * @param {number[]} colOrder - Array of column indices in desired order
 * @returns {Float32Array} Reordered matrix
 */
export function reorderCols(matrix, nRows, nCols, colOrder) {
  const result = new Float32Array(matrix.length);
  for (let r = 0; r < nRows; r++) {
    const srcOffset = r * nCols;
    const dstOffset = r * colOrder.length;
    for (let i = 0; i < colOrder.length; i++) {
      result[dstOffset + i] = matrix[srcOffset + colOrder[i]];
    }
  }
  return result;
}
