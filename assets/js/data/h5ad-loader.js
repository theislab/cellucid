/**
 * H5AD Loader for Cellucid
 *
 * Client-side JavaScript loader for AnnData h5ad files.
 * Provides sparse matrix support without needing a Python server.
 *
 * Features:
 * - Reads h5ad files directly in the browser using h5wasm
 * - Handles sparse matrices (CSR/CSC) transparently
 * - Individual datasets (embeddings, obs fields, genes) loaded on-demand
 * - Compatible with the Cellucid data format
 *
 * Important Performance Note:
 * Due to browser limitations, the entire h5ad file must be loaded into memory
 * before data can be accessed. For very large h5ad files, consider using:
 * - prepare() in Python for pre-processed binary files, OR
 * - serve_anndata() Python server which supports true lazy loading via backed mode
 *
 * Usage:
 *   const loader = new H5adLoader();
 *   await loader.open(file);  // File object from <input type="file">
 *   const embedding = await loader.getEmbedding('X_umap');
 *   const geneExpr = await loader.getGeneExpression('GAPDH');
 */

import { getNotificationCenter } from '../app/notification-center.js';

// h5wasm module - will be loaded dynamically
let h5wasm = null;

/**
 * Initialize h5wasm library (lazy load)
 * @returns {Promise<void>}
 */
async function initH5wasm() {
  if (h5wasm !== null) return;

  const notifications = getNotificationCenter();
  const notifId = notifications.loading('Loading HDF5 library...', { category: 'data' });

  try {
    // Lazy load h5wasm from local assets (only loaded when h5ad file is opened)
    const module = await import('../../external/hdf5_hl.js');
    await module.ready;
    h5wasm = module;
    console.log('[H5adLoader] h5wasm initialized successfully');
    notifications.complete(notifId, 'HDF5 library ready');
  } catch (err) {
    console.error('[H5adLoader] Failed to load h5wasm:', err);
    notifications.fail(notifId, 'Failed to load HDF5 library');
    throw new Error(
      'Failed to load h5wasm library. h5ad file loading requires h5wasm. ' +
      'Please ensure you have internet connectivity or use pre-exported data.'
    );
  }
}

/**
 * Check if h5wasm is available
 * @returns {boolean}
 */
export function isH5wasmAvailable() {
  return h5wasm !== null;
}

/**
 * Read a sparse matrix (CSR or CSC) from h5ad
 * @param {Object} group - h5wasm group containing sparse matrix
 * @returns {{data: Float32Array, indices: Int32Array, indptr: Int32Array, shape: number[], format: string, colPtrs?: Int32Array}}
 */
function readSparseMatrix(group) {
  // Check encoding type
  const encodingType = group.attrs?.['encoding-type']?.value || '';
  const isCsr = encodingType.includes('csr') || group.keys().includes('indptr');
  const isCsc = encodingType.includes('csc');

  if (!isCsr && !isCsc) {
    throw new Error(`Unknown sparse format: ${encodingType}`);
  }

  // Read components
  const dataDs = group.get('data');
  const indicesDs = group.get('indices');
  const indptrDs = group.get('indptr');

  const data = new Float32Array(dataDs.value);
  const indices = new Int32Array(indicesDs.value);
  const indptr = new Int32Array(indptrDs.value);

  // Get shape from attributes
  let shape = [0, 0];
  if (group.attrs?.['shape']) {
    // Convert BigInt to Number (h5wasm returns BigInt for 64-bit integers)
    shape = Array.from(group.attrs['shape'].value).map(Number);
  } else {
    // Infer shape from indptr and indices
    // CSR: indptr has n_rows+1 entries, indices are column indices
    // CSC: indptr has n_cols+1 entries, indices are row indices
    // NOTE: We use a loop instead of Math.max(...indices) to avoid stack overflow
    // for large arrays (Math.max can't handle arrays > ~100k elements)
    const findMax = (arr) => {
      if (arr.length === 0) return -1;
      let max = arr[0];
      for (let i = 1; i < arr.length; i++) {
        if (arr[i] > max) max = arr[i];
      }
      return max;
    };

    if (isCsr) {
      shape[0] = indptr.length - 1;  // n_rows
      shape[1] = indices.length > 0 ? findMax(indices) + 1 : 0;  // n_cols
    } else {
      // CSC
      shape[0] = indices.length > 0 ? findMax(indices) + 1 : 0;  // n_rows
      shape[1] = indptr.length - 1;  // n_cols
    }
  }

  return {
    data,
    indices,
    indptr,
    shape,
    format: isCsr ? 'csr' : 'csc',
    cscData: null  // Will be populated lazily for CSR matrices when gene access is needed
  };
}

/**
 * Build CSC format from CSR matrix for efficient column access.
 * This is essentially transposing the sparse matrix representation.
 * @param {Object} sparse - Sparse matrix with data, indices, indptr, shape
 * @returns {{colIndptr: Int32Array, rowIndices: Int32Array, colData: Float32Array}}
 */
function buildCscFromCsr(sparse) {
  const { data, indices, indptr, shape } = sparse;
  const nRows = shape[0];
  const nCols = shape[1];
  const nnz = data.length;

  // Step 1: Count entries per column
  const colCounts = new Int32Array(nCols + 1);
  for (let i = 0; i < nnz; i++) {
    colCounts[indices[i] + 1]++;
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

  return { colIndptr, rowIndices, colData };
}

/**
 * Extract a column from a sparse CSR matrix using CSC format
 * @param {Object} sparse - Sparse matrix with CSC data (cscData field)
 * @param {number} colIdx - Column index
 * @param {number} nRows - Number of rows
 * @returns {Float32Array}
 */
function sparseGetColumnCsc(sparse, colIdx, nRows) {
  const { colIndptr, rowIndices, colData } = sparse.cscData;
  const result = new Float32Array(nRows);

  const start = colIndptr[colIdx];
  const end = colIndptr[colIdx + 1];

  for (let j = start; j < end; j++) {
    result[rowIndices[j]] = colData[j];
  }

  return result;
}

// Maximum number of gene expression arrays to cache (LRU eviction beyond this)
// Each gene array is ~4 bytes * n_cells, so for 500k cells this is ~2MB per gene
// 100 genes = ~200MB max gene cache
const MAX_GENE_CACHE_SIZE = 100;

/**
 * H5AD file loader for AnnData format
 */
export class H5adLoader {
  constructor() {
    /** @type {Object|null} h5wasm File object */
    this._file = null;

    /** @type {string|null} */
    this._filename = null;

    /** @type {string|null} Path in virtual filesystem */
    this._virtualPath = null;

    /** @type {number} */
    this._nObs = 0;

    /** @type {number} */
    this._nVars = 0;

    /** @type {string[]} */
    this._obsKeys = [];

    /** @type {string[]} */
    this._varNames = [];

    /** @type {string[]} */
    this._obsmKeys = [];

    /** @type {Map<string, Object>} General cache for embeddings, obs fields, etc. */
    this._cache = new Map();

    /**
     * @type {Map<string, Float32Array>} LRU cache for gene expression
     * Separate from _cache to allow independent size limits
     */
    this._geneCache = new Map();

    /** @type {Object|null} Sparse X matrix info */
    this._sparseX = null;

    /** @type {Float32Array|null} Dense X matrix cache */
    this._denseX = null;

    /** @type {boolean} */
    this._xIsSparse = false;
  }

  /**
   * Open an h5ad file
   * @param {File} file - File object from file input
   * @returns {Promise<void>}
   */
  async open(file) {
    await initH5wasm();

    const notifications = getNotificationCenter();
    const trackerId = notifications.startDownload(`Loading ${file.name}`);

    try {
      // Read file into ArrayBuffer
      const buffer = await file.arrayBuffer();
      notifications.updateDownload(trackerId, buffer.byteLength, buffer.byteLength);

      // Write to Emscripten virtual filesystem and open with h5wasm
      const FS = h5wasm.FS;
      const virtualPath = '/' + file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      FS.writeFile(virtualPath, new Uint8Array(buffer));
      this._file = new h5wasm.File(virtualPath, 'r');
      this._filename = file.name;
      this._virtualPath = virtualPath;

      // Read basic structure
      await this._readStructure();

      notifications.completeDownload(trackerId);
      console.log(`[H5adLoader] Opened ${file.name}: ${this._nObs} cells, ${this._nVars} genes`);

    } catch (err) {
      notifications.failDownload(trackerId, err.message);
      throw err;
    }
  }

  /**
   * Read the basic structure of the h5ad file
   * @private
   */
  async _readStructure() {
    const root = this._file;

    // Check for X matrix and its format
    if (root.keys().includes('X')) {
      const X = root.get('X');

      // Check if X is a group (sparse) or dataset (dense)
      if (X.type === 'Group') {
        // Sparse matrix
        this._xIsSparse = true;
        const encodingType = X.attrs?.['encoding-type']?.value || '';
        console.log(`[H5adLoader] X is sparse (${encodingType})`);

        // Get shape from attributes
        if (X.attrs?.['shape']) {
          const shape = Array.from(X.attrs['shape'].value);
          // Convert BigInt to Number (h5wasm returns BigInt for 64-bit integers)
          this._nObs = Number(shape[0]);
          this._nVars = Number(shape[1]);
        }
      } else {
        // Dense matrix
        this._xIsSparse = false;
        const shape = X.shape;
        // Convert BigInt to Number (h5wasm returns BigInt for 64-bit integers)
        this._nObs = Number(shape[0]);
        this._nVars = Number(shape[1]);
      }
    }

    // Read obs (cell metadata) structure
    if (root.keys().includes('obs')) {
      const obs = root.get('obs');
      this._obsKeys = this._readDataFrameColumns(obs);

      // Get n_obs if not already set
      if (this._nObs === 0 && obs.attrs?.['_index']) {
        const indexKey = obs.attrs['_index'].value;
        if (obs.keys().includes(indexKey)) {
          const indexDs = obs.get(indexKey);
          this._nObs = Number(indexDs.shape[0]);
        }
      }
    }

    // Read var (gene metadata) structure
    if (root.keys().includes('var')) {
      const var_ = root.get('var');

      // Get variable names (gene identifiers)
      if (var_.attrs?.['_index']) {
        const indexKey = var_.attrs['_index'].value;
        if (var_.keys().includes(indexKey)) {
          const indexDs = var_.get(indexKey);
          this._varNames = Array.from(indexDs.value);
        }
      }

      // Update n_vars if needed
      if (this._nVars === 0) {
        this._nVars = this._varNames.length;
      }
    }

    // Read obsm (embeddings) structure
    if (root.keys().includes('obsm')) {
      const obsm = root.get('obsm');
      this._obsmKeys = obsm.keys();
    }
  }

  /**
   * Read DataFrame column names from an h5ad group
   * @param {Object} group - h5wasm group
   * @returns {string[]}
   * @private
   */
  _readDataFrameColumns(group) {
    const columns = [];

    // Check for column order attribute
    if (group.attrs?.['column-order']) {
      return Array.from(group.attrs['column-order'].value);
    }

    // Fall back to listing keys (excluding index)
    const indexKey = group.attrs?.['_index']?.value || '__index__';

    for (const key of group.keys()) {
      if (key !== indexKey && !key.startsWith('__')) {
        columns.push(key);
      }
    }

    return columns;
  }

  /**
   * Get number of observations (cells)
   * @returns {number}
   */
  get nObs() {
    return this._nObs;
  }

  /**
   * Get number of variables (genes)
   * @returns {number}
   */
  get nVars() {
    return this._nVars;
  }

  /**
   * Get observation metadata keys
   * @returns {string[]}
   */
  get obsKeys() {
    return [...this._obsKeys];
  }

  /**
   * Get variable (gene) names
   * @returns {string[]}
   */
  get varNames() {
    return [...this._varNames];
  }

  /**
   * Get obsm (embedding) keys
   * @returns {string[]}
   */
  get obsmKeys() {
    return [...this._obsmKeys];
  }

  /**
   * Check if file is open
   * @returns {boolean}
   */
  get isOpen() {
    return this._file !== null;
  }

  /**
   * Get an embedding from obsm
   * @param {string} key - Embedding key (e.g., 'X_umap', 'X_umap_3d')
   * @returns {Promise<Float32Array>}
   */
  async getEmbedding(key) {
    this._ensureOpen();

    const cacheKey = `obsm:${key}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const obsm = this._file.get('obsm');
    if (!obsm || !obsm.keys().includes(key)) {
      throw new Error(`Embedding '${key}' not found in obsm. Available: ${this._obsmKeys.join(', ')}`);
    }

    const dataset = obsm.get(key);
    const data = new Float32Array(dataset.value);
    const shape = dataset.shape;

    // Store with shape info (convert BigInt to Number for shape values)
    const result = { data, shape: shape.map(Number), nDims: Number(shape[1]) };
    this._cache.set(cacheKey, result);

    return result;
  }

  /**
   * Get gene expression values for a single gene
   * @param {string} geneName - Gene name
   * @returns {Promise<Float32Array>}
   */
  async getGeneExpression(geneName) {
    this._ensureOpen();

    const geneIdx = this._varNames.indexOf(geneName);
    if (geneIdx === -1) {
      throw new Error(`Gene '${geneName}' not found`);
    }

    // Check LRU gene cache first
    if (this._geneCache.has(geneName)) {
      // Move to end for LRU ordering (delete and re-add)
      const cached = this._geneCache.get(geneName);
      this._geneCache.delete(geneName);
      this._geneCache.set(geneName, cached);
      return cached;
    }

    let result;

    if (this._xIsSparse) {
      // Load sparse matrix components if not cached
      if (!this._sparseX) {
        const X = this._file.get('X');
        this._sparseX = readSparseMatrix(X);

        // For CSR format, convert to CSC for efficient column access
        // This is a one-time O(nnz) cost that pays off with repeated gene queries
        if (this._sparseX.format === 'csr') {
          const nnz = this._sparseX.data.length;
          console.log(`[H5adLoader] Converting CSR to CSC (${(nnz / 1e6).toFixed(1)}M non-zeros) for efficient gene access...`);
          const startTime = performance.now();
          this._sparseX.cscData = buildCscFromCsr(this._sparseX);
          const elapsed = (performance.now() - startTime).toFixed(0);
          console.log(`[H5adLoader] CSR→CSC conversion complete in ${elapsed}ms`);

          // MEMORY OPTIMIZATION: Release original CSR arrays since we only use CSC for column access
          // This prevents memory duplication (saves ~50% of sparse matrix memory)
          this._sparseX.data = null;
          this._sparseX.indices = null;
          this._sparseX.indptr = null;
        }
      }

      // Extract column using efficient method
      if (this._sparseX.format === 'csr') {
        // Use pre-computed CSC format for O(nnz/n_cols) access
        result = sparseGetColumnCsc(this._sparseX, geneIdx, this._nObs);
      } else {
        // CSC - column access is already efficient
        const { data, indices, indptr } = this._sparseX;
        result = new Float32Array(this._nObs);

        const start = indptr[geneIdx];
        const end = indptr[geneIdx + 1];

        for (let j = start; j < end; j++) {
          result[indices[j]] = data[j];
        }
      }
    } else {
      // Dense matrix - cache the entire matrix for efficient repeated column access
      if (!this._denseX) {
        const X = this._file.get('X');
        // Cache the dense matrix data (creates typed array view into file buffer)
        this._denseX = new Float32Array(X.value);
      }

      result = new Float32Array(this._nObs);
      for (let i = 0; i < this._nObs; i++) {
        result[i] = this._denseX[i * this._nVars + geneIdx];
      }
    }

    // LRU cache: evict oldest entries if cache is full
    if (this._geneCache.size >= MAX_GENE_CACHE_SIZE) {
      // Map iteration order is insertion order, so first key is oldest
      const oldestKey = this._geneCache.keys().next().value;
      this._geneCache.delete(oldestKey);
    }
    this._geneCache.set(geneName, result);

    return result;
  }

  /**
   * Get obs field metadata without loading all values (for lazy loading)
   * @param {string} key - Field name
   * @returns {Promise<{dtype: string, categories?: string[]}>}
   */
  async getObsFieldInfo(key) {
    this._ensureOpen();

    const cacheKey = `obs_info:${key}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const obs = this._file.get('obs');
    if (!obs || !obs.keys().includes(key)) {
      throw new Error(`Obs field '${key}' not found`);
    }

    const item = obs.get(key);
    let result;

    // Check if it's a categorical (Group with 'categories' key)
    if (item.type === 'Group' && item.keys().includes('categories')) {
      // Only load categories, not codes (codes are large)
      const categories = Array.from(item.get('categories').value);
      result = {
        dtype: 'categorical',
        categories,
      };
    } else {
      // Infer dtype from dataset properties without reading all values
      // This is a heuristic based on HDF5 dtype
      const hdf5Dtype = item.dtype || 'unknown';

      let dtype;
      if (hdf5Dtype.includes('float')) {
        dtype = 'float';
      } else if (hdf5Dtype.includes('int') && !hdf5Dtype.includes('uint')) {
        dtype = 'int';
      } else if (hdf5Dtype.includes('uint')) {
        dtype = 'uint';
      } else if (hdf5Dtype.includes('S') || hdf5Dtype.includes('O') || hdf5Dtype === '|S') {
        dtype = 'string';
      } else {
        // Fall back to reading a small sample to infer dtype
        dtype = 'unknown';
      }

      result = { dtype };
    }

    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Get obs (cell metadata) field values
   * @param {string} key - Field name
   * @returns {Promise<{values: any[], dtype: string, categories?: string[], codes?: Int32Array}>}
   */
  async getObsField(key) {
    this._ensureOpen();

    const cacheKey = `obs:${key}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const obs = this._file.get('obs');
    if (!obs || !obs.keys().includes(key)) {
      throw new Error(`Obs field '${key}' not found`);
    }

    const item = obs.get(key);
    let result;

    // Check if it's a categorical
    if (item.type === 'Group' && item.keys().includes('categories')) {
      // Categorical column
      const codes = new Int32Array(item.get('codes').value);
      const categories = Array.from(item.get('categories').value);

      // MEMORY OPTIMIZATION: Don't eagerly compute values array for categorical fields.
      // Most code paths use codes + categories directly. Only compute values on-demand.
      result = {
        dtype: 'categorical',
        codes,
        categories,
        // Lazy getter for values - only computed if accessed (rare fallback path)
        get values() {
          // Cache the computed values on first access
          const computed = Array.from(codes, c => c >= 0 ? categories[c] : null);
          Object.defineProperty(this, 'values', { value: computed, writable: false });
          return computed;
        }
      };
    } else {
      // Regular column
      const values = item.value;
      const dtype = this._inferDtype(values);

      result = {
        dtype,
        values: dtype === 'string' ? Array.from(values) : values
      };
    }

    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Get connectivity data from obsp
   * @returns {Promise<{data: Float32Array, indices: Int32Array, indptr: Int32Array}|null>}
   */
  async getConnectivities() {
    this._ensureOpen();

    if (this._cache.has('connectivities')) {
      return this._cache.get('connectivities');
    }

    if (!this._file.keys().includes('obsp')) {
      return null;
    }

    const obsp = this._file.get('obsp');
    if (!obsp.keys().includes('connectivities')) {
      return null;
    }

    const conn = obsp.get('connectivities');

    // Should be sparse
    if (conn.type !== 'Group') {
      console.warn('[H5adLoader] connectivities is not sparse, skipping');
      return null;
    }

    const result = readSparseMatrix(conn);
    this._cache.set('connectivities', result);
    return result;
  }

  /**
   * Infer dtype from values
   * @param {any} values
   * @returns {string}
   * @private
   */
  _inferDtype(values) {
    if (values instanceof Float32Array || values instanceof Float64Array) {
      return 'float';
    }
    if (values instanceof Int32Array || values instanceof Int16Array || values instanceof Int8Array) {
      return 'int';
    }
    if (values instanceof Uint32Array || values instanceof Uint16Array || values instanceof Uint8Array) {
      return 'uint';
    }
    if (Array.isArray(values) && values.length > 0) {
      if (typeof values[0] === 'string') return 'string';
      if (typeof values[0] === 'number') return 'float';
      if (typeof values[0] === 'boolean') return 'bool';
    }
    return 'unknown';
  }

  /**
   * Ensure file is open
   * @private
   */
  _ensureOpen() {
    if (!this._file) {
      throw new Error('No h5ad file is open. Call open() first.');
    }
  }

  /**
   * Get dataset metadata for Cellucid format
   * @returns {Promise<Object>}
   */
  async getDatasetMetadata() {
    this._ensureOpen();

    // Detect available UMAP dimensions
    const availableDimensions = [];
    let defaultDimension = 3;

    for (const key of this._obsmKeys) {
      if (key === 'X_umap_3d' || (key === 'X_umap' && !this._obsmKeys.includes('X_umap_3d'))) {
        const emb = await this.getEmbedding(key);
        if (emb.nDims === 3) availableDimensions.push(3);
        else if (emb.nDims === 2) availableDimensions.push(2);
        else if (emb.nDims === 1) availableDimensions.push(1);
      }
      if (key === 'X_umap_2d') availableDimensions.push(2);
      if (key === 'X_umap_1d') availableDimensions.push(1);
    }

    // Fallback: check X_umap
    if (availableDimensions.length === 0 && this._obsmKeys.includes('X_umap')) {
      const emb = await this.getEmbedding('X_umap');
      availableDimensions.push(emb.nDims);
    }

    // If still no embeddings found, check for any obsm array that could be an embedding
    if (availableDimensions.length === 0) {
      // Look for common embedding key patterns
      const embeddingPatterns = ['X_pca', 'X_tsne', 'X_phate', 'X_draw_graph', 'X_diffmap'];
      for (const pattern of embeddingPatterns) {
        const matchingKey = this._obsmKeys.find(k => k.startsWith(pattern));
        if (matchingKey) {
          try {
            const emb = await this.getEmbedding(matchingKey);
            if (emb.nDims >= 1 && emb.nDims <= 3) {
              availableDimensions.push(emb.nDims);
              console.warn(`[H5adLoader] No UMAP found, using ${matchingKey} as fallback embedding`);
              break;
            }
          } catch (e) {
            // Skip invalid embeddings
          }
        }
      }
    }

    // If absolutely no embeddings found, throw a helpful error
    if (availableDimensions.length === 0) {
      throw new Error(
        `No suitable embeddings found in obsm. Expected X_umap, X_umap_3d, X_umap_2d, or similar. ` +
        `Available obsm keys: ${this._obsmKeys.join(', ') || '(none)'}. ` +
        `Please compute UMAP embeddings before loading in Cellucid.`
      );
    }

    availableDimensions.sort((a, b) => b - a); // Prefer higher dimensions
    defaultDimension = availableDimensions[0];

    // Count obs field types
    let nCategorical = 0;
    let nContinuous = 0;

    for (const key of this._obsKeys) {
      const field = await this.getObsField(key);
      if (field.dtype === 'categorical') {
        nCategorical++;
      } else if (field.dtype === 'float' || field.dtype === 'int') {
        nContinuous++;
      }
    }

    // Check connectivity
    const conn = await this.getConnectivities();
    const hasConnectivity = conn !== null;

    return {
      version: 2,
      id: this._filename.replace('.h5ad', ''),
      name: this._filename.replace('.h5ad', ''),
      description: 'Loaded directly from h5ad file',
      cellucid_data_version: 'h5ad_loader',
      stats: {
        n_cells: this._nObs,
        n_genes: this._nVars,
        n_obs_fields: this._obsKeys.length,
        n_categorical_fields: nCategorical,
        n_continuous_fields: nContinuous,
        has_connectivity: hasConnectivity,
      },
      embeddings: {
        available_dimensions: availableDimensions,
        default_dimension: defaultDimension,
      },
      obs_fields: this._obsKeys.map(key => ({ key, kind: 'unknown' })),
      source: {
        type: 'h5ad_loader',
        filename: this._filename,
      },
      _h5ad_loader: true,
    };
  }

  /**
   * Clear all cached data to free memory
   */
  clearCache() {
    this._cache.clear();
    this._geneCache.clear();  // Clear LRU gene expression cache
    this._sparseX = null;
    this._denseX = null;  // Critical: release dense matrix cache to prevent memory leak
  }

  /**
   * Close the file and release resources
   */
  close() {
    if (this._file) {
      try {
        this._file.close();
      } catch (e) {
        // Ignore close errors
      }
      this._file = null;
    }
    // Clean up virtual filesystem
    if (this._virtualPath && h5wasm?.FS) {
      try {
        h5wasm.FS.unlink(this._virtualPath);
      } catch (e) {
        // Ignore unlink errors (file may not exist)
      }
      this._virtualPath = null;
    }
    this.clearCache();
    this._filename = null;
    this._nObs = 0;
    this._nVars = 0;
    this._obsKeys = [];
    this._varNames = [];
    this._obsmKeys = [];
    this._sparseX = null;
    this._denseX = null;
    this._xIsSparse = false;
  }
}

/**
 * Check if a file appears to be an h5ad file
 * @param {File} file - File to check
 * @returns {boolean}
 */
export function isH5adFile(file) {
  return file.name.toLowerCase().endsWith('.h5ad');
}

/**
 * Create an H5adLoader instance
 * @returns {H5adLoader}
 */
export function createH5adLoader() {
  return new H5adLoader();
}
