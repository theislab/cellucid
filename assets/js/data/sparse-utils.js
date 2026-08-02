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

  // A coordinate outside the declared shape is corruption, not an instruction
  // to drop a value: skipping it turns a damaged matrix into an expression
  // vector that reads as a genuine non-detection for that cell, which is the
  // one wrong answer a biologist cannot see. This is the same rule
  // getSparseColumn() already states for an out-of-range column index.
  if (indices.length !== nnz) {
    throw new RangeError(
      `Sparse matrix declares ${nnz} values but ${indices.length} indices`
    );
  }
  if (indptr.length !== nRows + 1) {
    throw new RangeError(
      `Sparse matrix with ${nRows} rows requires ${nRows + 1} row pointers, ` +
      `but declares ${indptr.length}`
    );
  }
  if (indptr[nRows] !== nnz) {
    throw new RangeError(
      `Sparse matrix row pointers end at ${indptr[nRows]}, ` +
      `which is not its ${nnz} stored values`
    );
  }

  // Edge case: empty matrix
  if (nnz === 0) {
    return {
      colIndptr: new Int32Array(nCols + 1),
      rowIndices: new Int32Array(0),
      colData: new Float32Array(0),
      exactInteger: sparse.exactInteger === true
    };
  }

  // Step 1: Count entries per column
  const colCounts = new Int32Array(nCols + 1);
  for (let i = 0; i < nnz; i++) {
    const col = indices[i];
    if (col < 0 || col >= nCols) {
      throw new RangeError(
        `Sparse matrix column index ${col} at entry ${i} is outside its ` +
        `${nCols}-column shape`
      );
    }
    colCounts[col + 1]++;
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
      const destIdx = colIndptr[col] + colPos[col];
      rowIndices[destIdx] = row;
      colData[destIdx] = data[j];
      colPos[col]++;
    }
  }

  return {
    colIndptr,
    rowIndices,
    colData,
    exactInteger: sparse.exactInteger === true
  };
}

/**
 * Add values into Float32 sparse output without turning a finite sum into
 * infinity during narrowing. Explicit non-finite source values are preserved.
 *
 * @param {number} current
 * @param {number} value
 * @param {string} label
 * @returns {number}
 */
export function addSparseFloat32(
  current,
  value,
  label = 'Sparse column',
  requireExactInteger = false
) {
  const sum = current + value;
  const narrowed = Math.fround(sum);
  if (Number.isFinite(sum) && !Number.isFinite(narrowed)) {
    throw new Error(`${label} value is outside the Float32 range`);
  }
  if (requireExactInteger && Number(narrowed) !== sum) {
    throw new Error(
      `${label} integer sum ${sum} cannot be represented exactly in Float32`
    );
  }
  return narrowed;
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

  // Invalid columns must not look like genuine all-zero expression.
  if (!Number.isSafeInteger(colIdx) ||
      colIdx < 0 ||
      colIdx >= colIndptr.length - 1) {
    throw new Error(`Sparse column index ${colIdx} is out of bounds`);
  }

  const result = new Float32Array(nRows);
  const start = colIndptr[colIdx];
  const end = colIndptr[colIdx + 1];

  for (let j = start; j < end; j++) {
    const rowIdx = rowIndices[j];
    // An out-of-range row is corruption, and dropping it would publish a real
    // zero for a cell whose value is unknown. Same rule as the column index
    // above, and as the shape agreement buildCscFromCsr() proves.
    if (rowIdx < 0 || rowIdx >= nRows) {
      throw new RangeError(
        `Sparse column row index ${rowIdx} at entry ${j} is outside its ` +
        `${nRows}-row shape`
      );
    }
    // Compressed sparse matrices may legally contain duplicate coordinates.
    result[rowIdx] = addSparseFloat32(
      result[rowIdx],
      colData[j],
      'Sparse column',
      cscData.exactInteger === true
    );
  }

  return result;
}

/**
 * Validate one exact direct-AnnData connectivity matrix and construct its
 * canonical upper-triangle edge pairs without mutating the matrix.
 *
 * Values must be finite and non-negative, the diagonal must be zero, and the
 * matrix must be exactly symmetric in both topology and weight. Sparse storage
 * must contain one strictly positive value per coordinate; explicit zeros and
 * duplicate coordinates are corruption rather than instructions to drop, sum,
 * or deduplicate scientific data.
 *
 * @param {Object} sparse - Dense, CSR, or CSC connectivity matrix
 * @param {number} nCells - Exact observation-axis length
 * @returns {{sources: Uint32Array, destinations: Uint32Array, weights: Float64Array, nCells: number, nEdges: number, maxNeighbors: number}}
 */
const MAX_CONNECTIVITY_WORKING_BYTES = 512 * 1024 * 1024;

function connectivityStorageBytes(values, unpackedBytesPerItem) {
  if (!values) return 0n;
  if (Number.isSafeInteger(values.byteLength) && values.byteLength >= 0) {
    return BigInt(values.byteLength);
  }
  if (!Number.isSafeInteger(values.length) || values.length < 0) {
    throw new Error('Connectivity storage has an invalid length');
  }
  return BigInt(values.length) * BigInt(unpackedBytesPerItem);
}

function requireConnectivityWorkingSet(sourceBytes, additionalBytes) {
  if (sourceBytes + additionalBytes >
      BigInt(MAX_CONNECTIVITY_WORKING_BYTES)) {
    throw new Error(
      `Connectivity edge working set exceeds the ${MAX_CONNECTIVITY_WORKING_BYTES}-byte browser limit; use the Cellucid server or prepared format`
    );
  }
}

function connectivityWeight(value, label) {
  if (typeof value !== 'number') {
    throw new TypeError(
      `${label} must contain only real numeric weights`
    );
  }
  if (!Number.isFinite(value)) {
    throw new Error('Connectivity weights must all be finite');
  }
  if (value < 0) {
    throw new Error('Connectivity weights must all be non-negative');
  }
  return value;
}

function buildConnectivityEdgeResult(
  sources,
  destinations,
  weights,
  nCells
) {
  if (
    !(sources instanceof Uint32Array) ||
    !(destinations instanceof Uint32Array) ||
    !(weights instanceof Float64Array) ||
    sources.length !== destinations.length ||
    sources.length !== weights.length
  ) {
    throw new Error(
      'Connectivity edge buffers must contain equal-length Uint32 endpoints and Float64 weights'
    );
  }
  const degrees = new Uint32Array(nCells);
  let maxNeighbors = 0;
  for (let index = 0; index < sources.length; index++) {
    const sourceDegree = ++degrees[sources[index]];
    const destinationDegree = ++degrees[destinations[index]];
    if (sourceDegree > maxNeighbors) maxNeighbors = sourceDegree;
    if (destinationDegree > maxNeighbors) {
      maxNeighbors = destinationDegree;
    }
  }
  return {
    sources,
    destinations,
    weights,
    nCells,
    nEdges: sources.length,
    maxNeighbors,
  };
}

function heapSortNumeric(keys, values, length) {
  const swap = (left, right) => {
    const key = keys[left];
    keys[left] = keys[right];
    keys[right] = key;
    if (values) {
      const value = values[left];
      values[left] = values[right];
      values[right] = value;
    }
  };
  const siftDown = (start, end) => {
    let root = start;
    while (root * 2 + 1 <= end) {
      let child = root * 2 + 1;
      if (child + 1 <= end && keys[child] < keys[child + 1]) child++;
      if (keys[root] >= keys[child]) return;
      swap(root, child);
      root = child;
    }
  };

  for (let start = Math.floor((length - 2) / 2); start >= 0; start--) {
    siftDown(start, length - 1);
  }
  for (let end = length - 1; end > 0; end--) {
    swap(0, end);
    siftDown(0, end - 1);
  }
}

export function extractConnectivityEdges(sparse, nCells) {
  if (!Number.isSafeInteger(nCells) || nCells <= 0) {
    throw new Error('Connectivity cell count must be a positive safe integer');
  }
  if (BigInt(nCells) * BigInt(nCells) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Connectivity dimensions exceed safe edge-key range');
  }

  if (sparse?.format === 'dense') {
    const { data, shape } = sparse;
    if (!Array.isArray(shape) ||
        shape.length !== 2 ||
        shape[0] !== nCells ||
        shape[1] !== nCells ||
        !data ||
        data.length !== nCells * nCells) {
      throw new Error('Dense connectivity matrix must be square and cell-aligned');
    }
    const maximumEdgeCount =
      BigInt(nCells) * BigInt(Math.max(0, nCells - 1)) / 2n;
    const sourceBytes = connectivityStorageBytes(data, 8);
    requireConnectivityWorkingSet(
      sourceBytes,
      maximumEdgeCount * 44n + BigInt(nCells) * 4n
    );

    let edgeCount = 0;
    for (let source = 0; source < nCells; source++) {
      const diagonal = connectivityWeight(
        data[source * nCells + source],
        'Dense connectivity matrix'
      );
      if (diagonal !== 0) {
        throw new Error(
          'Connectivity diagonal values must all be exactly zero'
        );
      }
      for (let destination = source + 1; destination < nCells; destination++) {
        const forward = connectivityWeight(
          data[source * nCells + destination],
          'Dense connectivity matrix'
        );
        const reverse = connectivityWeight(
          data[destination * nCells + source],
          'Dense connectivity matrix'
        );
        if (forward !== reverse) {
          throw new Error(
            'Connectivity matrix topology and weights must be exactly symmetric'
          );
        }
        if (forward > 0) {
          edgeCount++;
        }
      }
    }
    requireConnectivityWorkingSet(
      sourceBytes,
      BigInt(edgeCount) * 44n + BigInt(nCells) * 4n
    );
    const edgeSources = new Uint32Array(edgeCount);
    const edgeDestinations = new Uint32Array(edgeCount);
    const edgeWeights = new Float64Array(edgeCount);
    let edgeIndex = 0;
    for (let source = 0; source < nCells; source++) {
      for (let destination = source + 1; destination < nCells; destination++) {
        const weight = data[source * nCells + destination];
        if (weight > 0) {
          edgeSources[edgeIndex] = source;
          edgeDestinations[edgeIndex] = destination;
          edgeWeights[edgeIndex] = weight;
          edgeIndex++;
        }
      }
    }
    return buildConnectivityEdgeResult(
      edgeSources,
      edgeDestinations,
      edgeWeights,
      nCells
    );
  }

  const { indptr, indices, data, shape } = sparse ?? {};
  const format = sparse?.format;
  if (format !== 'csr' && format !== 'csc') {
    throw new Error(`Unsupported connectivity sparse format '${format}'`);
  }
  if (!Array.isArray(shape) ||
      shape.length !== 2 ||
      shape[0] !== nCells ||
      shape[1] !== nCells) {
    throw new Error('Sparse connectivity matrix must be square and cell-aligned');
  }
  if (!data) {
    throw new Error(
      'Sparse connectivity data is required; implicit values are not supported'
    );
  }
  if (!indices || !indptr ||
      !Number.isSafeInteger(indices.length) ||
      !Number.isSafeInteger(indptr.length) ||
      !Number.isSafeInteger(data.length) ||
      indices.length < 0 ||
      indptr.length < 0 ||
      data.length < 0) {
    throw new Error('Sparse connectivity storage has an invalid length');
  }
  if (data.length !== indices.length) {
    throw new Error('Sparse connectivity data and indices lengths differ');
  }

  const majorAxis = format === 'csr' ? shape[0] : shape[1];
  if (indptr.length !== majorAxis + 1) {
    throw new Error('Connectivity pointer array does not match its sparse format');
  }
  for (let index = 0; index < indptr.length; index++) {
    const pointer = indptr[index];
    if (!Number.isSafeInteger(pointer) ||
        pointer < 0 ||
        pointer > indices.length ||
        (index > 0 && pointer < indptr[index - 1])) {
      throw new Error(
        'Connectivity pointers must be monotonic safe integers within the sparse entry bounds'
      );
    }
  }
  if (indptr[0] !== 0 ||
      indptr[indptr.length - 1] !== indices.length) {
    throw new Error('Connectivity pointers must span every sparse entry');
  }

  const sourceBytes =
    connectivityStorageBytes(data, 8) +
    connectivityStorageBytes(indices, 8) +
    connectivityStorageBytes(indptr, 8);
  // One non-mutating coordinate-key/weight copy plus the canonical,
  // render-owned, and GPU-staging edge payloads for the largest valid
  // symmetric graph. Heap sort below is in-place on the coordinate copy.
  const maximumEdgeCount = Math.floor(indices.length / 2);
  requireConnectivityWorkingSet(
    sourceBytes,
    BigInt(indices.length) * 16n +
      BigInt(maximumEdgeCount) * 44n +
      BigInt(nCells) * 4n
  );
  const directedKeys = new Float64Array(indices.length);
  const directedWeights = new Float64Array(indices.length);
  const directedCount = indices.length;

  for (let major = 0; major < majorAxis; major++) {
    const start = indptr[major];
    const end = indptr[major + 1];

    for (let j = start; j < end; j++) {
      const minor = indices[j];
      if (!Number.isSafeInteger(minor) || minor < 0 || minor >= nCells) {
        throw new Error(`Connectivity index ${minor} is outside cell bounds`);
      }
      const row = format === 'csr' ? major : minor;
      const column = format === 'csr' ? minor : major;
      directedKeys[j] = row * nCells + column;
      const weight = connectivityWeight(
        data[j],
        'Sparse connectivity matrix'
      );
      if (!(weight > 0)) {
        throw new Error(
          'Sparse connectivity storage must omit zero-weight coordinates'
        );
      }
      directedWeights[j] = weight;
    }
  }

  heapSortNumeric(directedKeys, directedWeights, directedCount);
  let previousKey = -1;
  for (let index = 0; index < directedCount; index++) {
    const directedKey = directedKeys[index];
    if (index > 0 && directedKey === previousKey) {
      throw new Error(
        'Sparse connectivity matrix contains a duplicate coordinate'
      );
    }
    previousKey = directedKey;
    const row = Math.floor(directedKey / nCells);
    const column = directedKey - row * nCells;
    if (row === column) {
      throw new Error(
        'Connectivity diagonal values must all be exactly zero'
      );
    }
  }

  const findDirectedIndex = key => {
    let left = 0;
    let right = directedCount - 1;
    while (left <= right) {
      const middle = left + Math.floor((right - left) / 2);
      const candidate = directedKeys[middle];
      if (candidate === key) return middle;
      if (candidate < key) {
        left = middle + 1;
      } else {
        right = middle - 1;
      }
    }
    return -1;
  };

  let edgeCount = 0;
  for (let index = 0; index < directedCount; index++) {
    const directedKey = directedKeys[index];
    const row = Math.floor(directedKey / nCells);
    const column = directedKey - row * nCells;
    const reverseIndex = findDirectedIndex(column * nCells + row);
    if (reverseIndex < 0) {
      throw new Error(
        'Connectivity matrix topology and weights must be exactly symmetric'
      );
    }
    if (directedWeights[reverseIndex] !== directedWeights[index]) {
      throw new Error(
        'Connectivity matrix topology and weights must be exactly symmetric'
      );
    }
    if (row < column) edgeCount++;
  }

  requireConnectivityWorkingSet(
    sourceBytes + BigInt(indices.length) * 16n,
    BigInt(edgeCount) * 44n + BigInt(nCells) * 4n
  );
  const edgeSources = new Uint32Array(edgeCount);
  const edgeDestinations = new Uint32Array(edgeCount);
  const edgeWeights = new Float64Array(edgeCount);
  let edgeIndex = 0;
  for (let index = 0; index < directedCount; index++) {
    const directedKey = directedKeys[index];
    const source = Math.floor(directedKey / nCells);
    const destination = directedKey - source * nCells;
    if (source < destination) {
      edgeSources[edgeIndex] = source;
      edgeDestinations[edgeIndex] = destination;
      edgeWeights[edgeIndex] = directedWeights[index];
      edgeIndex++;
    }
  }

  return buildConnectivityEdgeResult(
    edgeSources,
    edgeDestinations,
    edgeWeights,
    nCells
  );
}

/**
 * Safely convert a typed array to Int32Array, handling BigInt64Array/BigUint64Array.
 * This is needed because new Int32Array(BigInt64Array) throws a TypeError.
 *
 * @param {TypedArray} arr - Source array (may be BigInt64Array, BigUint64Array, or other)
 * @returns {Int32Array} Converted array
 */
export function toInt32Array(arr, label = 'Integer value') {
  if (!arr || !Number.isSafeInteger(arr.length) || arr.length < 0) {
    throw new Error(`${label} array has an invalid length`);
  }

  // Already Int32Array - return as-is
  if (arr instanceof Int32Array) {
    return arr;
  }

  const result = new Int32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i];
    if (typeof raw === 'bigint') {
      if (raw < -2147483648n || raw > 2147483647n) {
        throw new Error(`${label} ${raw} is outside the Int32 range`);
      }
      result[i] = Number(raw);
      continue;
    }

    const value = Number(raw);
    if (!Number.isSafeInteger(value) ||
        value < -2147483648 ||
        value > 2147483647) {
      throw new Error(`${label} ${String(raw)} is outside the Int32 range`);
    }
    result[i] = value;
  }
  return result;
}

/**
 * Safely convert a typed array to Float32Array, handling BigInt64Array/BigUint64Array.
 * This is needed because new Float32Array(BigInt64Array) throws a TypeError.
 *
 * @param {TypedArray} arr - Source array (may be BigInt64Array, BigUint64Array, or other)
 * @returns {Float32Array} Converted array
 */
export function toFloat32Array(
  arr,
  label = 'Numeric value',
  requireExactInteger = false
) {
  if (!arr || !Number.isSafeInteger(arr.length) || arr.length < 0) {
    throw new Error(`${label} array has an invalid length`);
  }

  // Already Float32Array - return as-is when no stronger contract is needed.
  if (arr instanceof Float32Array && !requireExactInteger) {
    return arr;
  }

  const result = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i];
    let value;
    if (typeof raw === 'bigint') {
      if (raw < BigInt(Number.MIN_SAFE_INTEGER) ||
          raw > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`${label} integer is outside the safe numeric range`);
      }
      value = Number(raw);
    } else {
      value = Number(raw);
    }

    const narrowed = Math.fround(value);
    if (Number.isFinite(value) && !Number.isFinite(narrowed)) {
      throw new Error(`${label} value is outside the Float32 range`);
    }
    if (requireExactInteger && Number(narrowed) !== value) {
      throw new Error(
        `${label} integer value ${value} cannot be represented exactly in Float32`
      );
    }
    result[i] = narrowed;
  }
  return result;
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
 * Simple LRU (Least Recently Used) Cache implementation.
 * Used to limit memory usage for field data caches.
 *
 * When the cache exceeds maxSize, the least recently accessed items are evicted.
 * Access order is tracked: get() moves an item to most-recently-used position.
 */
export class LRUCache {
  /**
   * Create a new LRU cache.
   * @param {number} maxSize - Maximum number of items to store (default: 50)
   */
  constructor(maxSize = 50) {
    this.maxSize = maxSize;
    // Map maintains insertion order, which we use for LRU tracking
    // Most recently used items are at the end (re-inserted on access)
    this._cache = new Map();
  }

  /**
   * Get an item from the cache.
   * Moves the item to most-recently-used position.
   * @param {string} key - Cache key
   * @returns {*} Cached value or undefined if not found
   */
  get(key) {
    if (!this._cache.has(key)) {
      return undefined;
    }
    // Move to end (most recently used) by re-inserting
    const value = this._cache.get(key);
    this._cache.delete(key);
    this._cache.set(key, value);
    return value;
  }

  /**
   * Set an item in the cache.
   * Evicts least-recently-used items if cache is full.
   * @param {string} key - Cache key
   * @param {*} value - Value to cache
   */
  set(key, value) {
    // If key exists, delete first to update position
    if (this._cache.has(key)) {
      this._cache.delete(key);
    }

    // Add to end (most recently used)
    this._cache.set(key, value);

    // Evict oldest items if over capacity
    while (this._cache.size > this.maxSize) {
      // Map.keys().next() gives the first (oldest) key
      const oldestKey = this._cache.keys().next().value;
      this._cache.delete(oldestKey);
    }
  }

  /**
   * Check if a key exists in the cache.
   * Does NOT update access order (use get() for that).
   * @param {string} key - Cache key
   * @returns {boolean}
   */
  has(key) {
    return this._cache.has(key);
  }

  /**
   * Delete an item from the cache.
   * @param {string} key - Cache key
   * @returns {boolean} True if item was deleted
   */
  delete(key) {
    return this._cache.delete(key);
  }

  /**
   * Clear all items from the cache.
   */
  clear() {
    this._cache.clear();
  }

  /**
   * Get the current number of items in the cache.
   * @returns {number}
   */
  get size() {
    return this._cache.size;
  }

  /**
   * Get all keys in the cache (oldest to newest).
   * @returns {IterableIterator<string>}
   */
  keys() {
    return this._cache.keys();
  }

  /**
   * Get all values in the cache (oldest to newest).
   * @returns {IterableIterator<*>}
   */
  values() {
    return this._cache.values();
  }

  /**
   * Get all entries in the cache (oldest to newest).
   * @returns {IterableIterator<[string, *]>}
   */
  entries() {
    return this._cache.entries();
  }
}
