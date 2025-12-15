/**
 * Sparse Matrix Utilities for Cellucid
 *
 * Shared utilities for handling sparse matrices (CSR/CSC format) used by
 * both H5AD and Zarr loaders. Consolidates duplicate code to a single source.
 *
 * Sparse Matrix Formats:
 * - CSR (Compressed Sparse Row): Efficient for row access
 *   - indptr: Row pointers (length n_rows + 1)
 *   - indices: Column indices for non-zero values
 *   - data: Non-zero values
 *
 * - CSC (Compressed Sparse Column): Efficient for column access
 *   - indptr: Column pointers (length n_cols + 1)
 *   - indices: Row indices for non-zero values
 *   - data: Non-zero values
 *
 * For gene expression access (extracting a column), CSC is efficient O(nnz/n_cols).
 * For CSR matrices, we convert to CSC once and cache for repeated column access.
 */

/**
 * Build CSC format from CSR matrix for efficient column access.
 * This is a one-time O(nnz) operation that enables O(nnz/n_cols) column access.
 *
 * @param {Object} sparse - Sparse matrix in CSR format
 * @param {Float32Array|Float64Array} sparse.data - Non-zero values
 * @param {Int32Array} sparse.indices - Column indices
 * @param {Int32Array} sparse.indptr - Row pointers
 * @param {number[]} sparse.shape - [n_rows, n_cols]
 * @returns {{colIndptr: Int32Array, rowIndices: Int32Array, colData: Float32Array}}
 */
export function buildCscFromCsr(sparse) {
  const { data, indices, indptr, shape } = sparse;
  const nRows = shape[0];
  const nCols = shape[1];
  const nnz = data.length;

  // Edge case: empty matrix
  if (nnz === 0) {
    return {
      colIndptr: new Int32Array(nCols + 1),
      rowIndices: new Int32Array(0),
      colData: new Float32Array(0)
    };
  }

  // Step 1: Count entries per column
  const colCounts = new Int32Array(nCols + 1);
  for (let i = 0; i < nnz; i++) {
    const col = indices[i];
    // Edge case: validate column index to prevent out-of-bounds
    if (col >= 0 && col < nCols) {
      colCounts[col + 1]++;
    }
  }

  // Step 2: Build column indptr (cumulative sum)
  const colIndptr = new Int32Array(nCols + 1);
  for (let c = 0; c < nCols; c++) {
    colIndptr[c + 1] = colIndptr[c] + colCounts[c + 1];
  }

  // Step 3: Fill row indices and data for CSC format
  const rowIndices = new Int32Array(nnz);
  const colData = new Float32Array(nnz);
  const colPos = new Int32Array(nCols);  // Current position for each column

  for (let row = 0; row < nRows; row++) {
    const start = indptr[row];
    const end = indptr[row + 1];
    for (let j = start; j < end; j++) {
      const col = indices[j];
      // Edge case: validate column index
      if (col >= 0 && col < nCols) {
        const destIdx = colIndptr[col] + colPos[col];
        rowIndices[destIdx] = row;
        colData[destIdx] = data[j];
        colPos[col]++;
      }
    }
  }

  return { colIndptr, rowIndices, colData };
}

/**
 * Extract a single column from a sparse matrix using CSC format.
 * This is efficient O(nnz/n_cols) operation.
 *
 * @param {Object} cscData - CSC format data
 * @param {Int32Array} cscData.colIndptr - Column pointers
 * @param {Int32Array} cscData.rowIndices - Row indices
 * @param {Float32Array} cscData.colData - Non-zero values
 * @param {number} colIdx - Column index to extract
 * @param {number} nRows - Number of rows (for result array size)
 * @returns {Float32Array} Dense column vector
 */
export function getSparseColumn(cscData, colIdx, nRows) {
  const { colIndptr, rowIndices, colData } = cscData;
  const result = new Float32Array(nRows);

  // Edge case: column index out of range
  if (colIdx < 0 || colIdx >= colIndptr.length - 1) {
    console.warn(`[sparse-utils] Column index ${colIdx} out of range, returning zeros`);
    return result;
  }

  const start = colIndptr[colIdx];
  const end = colIndptr[colIdx + 1];

  for (let j = start; j < end; j++) {
    const rowIdx = rowIndices[j];
    // Edge case: validate row index
    if (rowIdx >= 0 && rowIdx < nRows) {
      result[rowIdx] = colData[j];
    }
  }

  return result;
}

/**
 * Extract connectivity edges from a sparse adjacency matrix.
 * Returns unique edges where source < destination (undirected graph).
 *
 * @param {Object} sparse - Sparse matrix (CSR or CSC format)
 * @param {Int32Array} sparse.indptr - Row/column pointers
 * @param {Int32Array} sparse.indices - Column/row indices
 * @param {number} nCells - Number of cells (for validation)
 * @returns {{sources: Uint32Array, destinations: Uint32Array, nEdges: number}}
 */
export function extractConnectivityEdges(sparse, nCells) {
  const { indptr, indices } = sparse;

  // Edge case: empty connectivity
  if (!indptr || !indices || indices.length === 0) {
    return {
      sources: new Uint32Array(0),
      destinations: new Uint32Array(0),
      nEdges: 0
    };
  }

  const nRows = indptr.length - 1;
  const edgeSources = [];
  const edgeDestinations = [];

  for (let cell = 0; cell < nRows && cell < nCells; cell++) {
    const start = indptr[cell];
    const end = indptr[cell + 1];

    for (let j = start; j < end; j++) {
      const neighbor = indices[j];
      // Only add edge once (src < dst) and validate neighbor index
      if (cell < neighbor && neighbor < nCells) {
        edgeSources.push(cell);
        edgeDestinations.push(neighbor);
      }
    }
  }

  return {
    sources: new Uint32Array(edgeSources),
    destinations: new Uint32Array(edgeDestinations),
    nEdges: edgeSources.length
  };
}

/**
 * Safely convert a typed array to Int32Array, handling BigInt64Array/BigUint64Array.
 * This is needed because new Int32Array(BigInt64Array) throws a TypeError.
 *
 * @param {TypedArray} arr - Source array (may be BigInt64Array, BigUint64Array, or other)
 * @returns {Int32Array} Converted array
 */
export function toInt32Array(arr) {
  // Already Int32Array - return as-is
  if (arr instanceof Int32Array) {
    return arr;
  }

  // Handle BigInt64Array and BigUint64Array (int64/uint64 from h5wasm)
  if (arr instanceof BigInt64Array || arr instanceof BigUint64Array) {
    const result = new Int32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      // Convert BigInt to Number, clamping to Int32 range to prevent overflow
      const val = arr[i];
      // BigInt comparison uses BigInt literals
      if (val > 2147483647n) {
        result[i] = 2147483647; // Int32 max
      } else if (val < -2147483648n) {
        result[i] = -2147483648; // Int32 min
      } else {
        result[i] = Number(val);
      }
    }
    return result;
  }

  // For other typed arrays (Int8Array, Int16Array, Uint32Array, etc.)
  return new Int32Array(arr);
}

/**
 * Safely convert a typed array to Float32Array, handling BigInt64Array/BigUint64Array.
 * This is needed because new Float32Array(BigInt64Array) throws a TypeError.
 *
 * @param {TypedArray} arr - Source array (may be BigInt64Array, BigUint64Array, or other)
 * @returns {Float32Array} Converted array
 */
export function toFloat32Array(arr) {
  // Already Float32Array - return as-is
  if (arr instanceof Float32Array) {
    return arr;
  }

  // Handle BigInt64Array and BigUint64Array
  if (arr instanceof BigInt64Array || arr instanceof BigUint64Array) {
    const result = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      result[i] = Number(arr[i]);
    }
    return result;
  }

  // For other typed arrays
  return new Float32Array(arr);
}

/**
 * Safely convert a typed array to Uint32Array, handling BigUint64Array.
 * This is needed because BigUint64Array cannot be directly assigned to Uint32Array positions.
 * Used for connectivity indices where uint64 dtypes may appear but values fit in uint32.
 *
 * @param {TypedArray} arr - Source array (may be BigUint64Array or other)
 * @returns {Uint32Array} Converted array
 */
export function toUint32Array(arr) {
  // Already Uint32Array - return as-is
  if (arr instanceof Uint32Array) {
    return arr;
  }

  // Handle BigUint64Array (uint64 from zarr/h5wasm)
  if (arr instanceof BigUint64Array) {
    const result = new Uint32Array(arr.length);
    const maxUint32 = 4294967295n; // 2^32 - 1 as BigInt
    for (let i = 0; i < arr.length; i++) {
      const val = arr[i];
      // Clamp to Uint32 range to prevent overflow
      if (val > maxUint32) {
        result[i] = 4294967295; // Uint32 max
      } else {
        result[i] = Number(val);
      }
    }
    return result;
  }

  // Handle BigInt64Array (int64 - less common for indices but handle it)
  if (arr instanceof BigInt64Array) {
    const result = new Uint32Array(arr.length);
    const maxUint32 = 4294967295n;
    for (let i = 0; i < arr.length; i++) {
      const val = arr[i];
      if (val < 0n) {
        result[i] = 0; // Negative values clamp to 0
      } else if (val > maxUint32) {
        result[i] = 4294967295;
      } else {
        result[i] = Number(val);
      }
    }
    return result;
  }

  // For other typed arrays (Uint16Array, Int32Array, etc.)
  return new Uint32Array(arr);
}

/**
 * Find the maximum value in an array without risking stack overflow.
 * Math.max(...arr) can fail for arrays > ~100k elements.
 *
 * @param {TypedArray|Array} arr - Array to find max in
 * @returns {number} Maximum value, or -1 if array is empty
 */
export function findMax(arr) {
  if (!arr || arr.length === 0) return -1;
  let max = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > max) max = arr[i];
  }
  return max;
}

/**
 * Simple LRU (Least Recently Used) cache using Map insertion order.
 * Provides O(1) get/set operations with automatic eviction.
 *
 * Usage:
 *   const cache = new LRUCache(100);
 *   cache.set('key', value);
 *   const value = cache.get('key'); // Returns value and marks as recently used
 */
export class LRUCache {
  /**
   * @param {number} maxSize - Maximum number of items to cache
   */
  constructor(maxSize = 100) {
    if (maxSize < 1) {
      throw new Error('LRUCache maxSize must be at least 1');
    }
    /** @type {Map<string, any>} */
    this._cache = new Map();
    this._maxSize = maxSize;
  }

  /**
   * Get a value from the cache and mark as recently used.
   * @param {string} key
   * @returns {any|undefined}
   */
  get(key) {
    if (!this._cache.has(key)) {
      return undefined;
    }
    // Move to end (most recently used)
    const value = this._cache.get(key);
    this._cache.delete(key);
    this._cache.set(key, value);
    return value;
  }

  /**
   * Check if a key exists without affecting LRU order.
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this._cache.has(key);
  }

  /**
   * Set a value in the cache, evicting oldest if at capacity.
   * @param {string} key
   * @param {any} value
   */
  set(key, value) {
    // If key exists, delete first to move to end
    if (this._cache.has(key)) {
      this._cache.delete(key);
    } else if (this._cache.size >= this._maxSize) {
      // Evict oldest (first key in Map)
      const oldestKey = this._cache.keys().next().value;
      this._cache.delete(oldestKey);
    }
    this._cache.set(key, value);
  }

  /**
   * Delete a specific key.
   * @param {string} key
   * @returns {boolean} True if key existed
   */
  delete(key) {
    return this._cache.delete(key);
  }

  /**
   * Clear all cached items.
   */
  clear() {
    this._cache.clear();
  }

  /**
   * Get current size of cache.
   * @returns {number}
   */
  get size() {
    return this._cache.size;
  }

  /**
   * Get maximum size of cache.
   * @returns {number}
   */
  get maxSize() {
    return this._maxSize;
  }
}
