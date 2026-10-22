/**
 * Matrix Utilities
 *
 * Centralized matrix operations for heatmaps, clustering, and expression analysis.
 * Uses existing number-utils for core statistics to maintain DRY code.
 *
 * Features:
 * - Row/column-wise z-score normalization
 * - Log1p transformation
 * - Matrix transposition
 * - Distance matrix computation (correlation, Euclidean, cosine)
 * - Pearson correlation
 *
 * Performance Notes:
 * - All operations work with Float32Array for memory efficiency
 * - Single-pass algorithms where possible
 * - Safe for large matrices (100+ genes x 20+ groups)
 *
 * @module shared/matrix-utils
 */

import { isFiniteNumber, mean, std } from './number-utils.js';
import { pearsonCorrelation } from '../compute/math-utils.js';

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

// =============================================================================
// CORRELATION AND DISTANCE
// =============================================================================

/**
 * Compute Euclidean distance between two vectors.
 *
 * @param {Float32Array|number[]} a - First vector
 * @param {Float32Array|number[]} b - Second vector
 * @returns {number} Euclidean distance
 */
function euclideanDistance(a, b) {
  const n = Math.min(a.length, b.length);
  let sumSq = 0;
  let count = 0;

  for (let i = 0; i < n; i++) {
    const ai = a[i], bi = b[i];
    if (!isFiniteNumber(ai) || !isFiniteNumber(bi)) continue;
    const diff = ai - bi;
    sumSq += diff * diff;
    count++;
  }

  return count > 0 ? Math.sqrt(sumSq) : 0;
}

/**
 * Compute cosine distance (1 - cosine similarity) between two vectors.
 *
 * @param {Float32Array|number[]} a - First vector
 * @param {Float32Array|number[]} b - Second vector
 * @returns {number} Cosine distance (0 to 2)
 */
function cosineDistance(a, b) {
  const n = Math.min(a.length, b.length);
  let dotProduct = 0, normA = 0, normB = 0;

  for (let i = 0; i < n; i++) {
    const ai = a[i], bi = b[i];
    if (!isFiniteNumber(ai) || !isFiniteNumber(bi)) continue;
    dotProduct += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 1; // Max distance if vectors are zero

  const similarity = dotProduct / denom;
  return 1 - similarity;
}

// =============================================================================
// DISTANCE MATRICES
// =============================================================================

/**
 * Compute pairwise correlation distance matrix (1 - r) for rows.
 *
 * @param {Float32Array} matrix - Row-major flattened matrix
 * @param {number} nRows - Number of rows
 * @param {number} nCols - Number of columns
 * @returns {Float32Array} nRows x nRows distance matrix (symmetric)
 *
 * @example
 * const matrix = new Float32Array([1, 2, 3, 4, 5, 6]); // 2x3
 * const dist = correlationDistanceMatrix(matrix, 2, 3);
 * // Returns 2x2 distance matrix
 */
function correlationDistanceMatrix(matrix, nRows, nCols) {
  const dist = new Float32Array(nRows * nRows);

  for (let i = 0; i < nRows; i++) {
    dist[i * nRows + i] = 0; // Self-distance is 0

    for (let j = i + 1; j < nRows; j++) {
      const rowI = matrix.subarray(i * nCols, (i + 1) * nCols);
      const rowJ = matrix.subarray(j * nCols, (j + 1) * nCols);
      const r = pearsonCorrelation(rowI, rowJ);
      const d = 1 - r;

      dist[i * nRows + j] = d;
      dist[j * nRows + i] = d;
    }
  }

  return dist;
}

/**
 * Compute pairwise Euclidean distance matrix for rows.
 *
 * @param {Float32Array} matrix - Row-major flattened matrix
 * @param {number} nRows - Number of rows
 * @param {number} nCols - Number of columns
 * @returns {Float32Array} nRows x nRows distance matrix (symmetric)
 */
function euclideanDistanceMatrix(matrix, nRows, nCols) {
  const dist = new Float32Array(nRows * nRows);

  for (let i = 0; i < nRows; i++) {
    dist[i * nRows + i] = 0;

    for (let j = i + 1; j < nRows; j++) {
      const rowI = matrix.subarray(i * nCols, (i + 1) * nCols);
      const rowJ = matrix.subarray(j * nCols, (j + 1) * nCols);
      const d = euclideanDistance(rowI, rowJ);

      dist[i * nRows + j] = d;
      dist[j * nRows + i] = d;
    }
  }

  return dist;
}

/**
 * Compute pairwise cosine distance matrix for rows.
 *
 * @param {Float32Array} matrix - Row-major flattened matrix
 * @param {number} nRows - Number of rows
 * @param {number} nCols - Number of columns
 * @returns {Float32Array} nRows x nRows distance matrix (symmetric)
 */
function cosineDistanceMatrix(matrix, nRows, nCols) {
  const dist = new Float32Array(nRows * nRows);

  for (let i = 0; i < nRows; i++) {
    dist[i * nRows + i] = 0;

    for (let j = i + 1; j < nRows; j++) {
      const rowI = matrix.subarray(i * nCols, (i + 1) * nCols);
      const rowJ = matrix.subarray(j * nCols, (j + 1) * nCols);
      const d = cosineDistance(rowI, rowJ);

      dist[i * nRows + j] = d;
      dist[j * nRows + i] = d;
    }
  }

  return dist;
}

/**
 * Compute distance matrix using specified metric.
 *
 * @param {Float32Array} matrix - Row-major flattened matrix
 * @param {number} nRows - Number of rows
 * @param {number} nCols - Number of columns
 * @param {'correlation'|'euclidean'|'cosine'} [metric='correlation'] - Distance metric
 * @returns {Float32Array} nRows x nRows distance matrix
 */
export function computeDistanceMatrix(matrix, nRows, nCols, metric = 'correlation') {
  switch (metric) {
    case 'euclidean':
      return euclideanDistanceMatrix(matrix, nRows, nCols);
    case 'cosine':
      return cosineDistanceMatrix(matrix, nRows, nCols);
    case 'correlation':
    default:
      return correlationDistanceMatrix(matrix, nRows, nCols);
  }
}
