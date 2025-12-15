/**
 * H5AD Module for Cellucid
 *
 * Client-side JavaScript module for AnnData h5ad file support.
 * Provides sparse matrix support without needing a Python server.
 *
 * This module combines:
 * - H5adLoader: Core loader using h5wasm for reading h5ad files
 * - H5adDataSource: Data source providing the standard Cellucid interface
 * - H5adDataProvider: Bridge functions for data source manager integration
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FEATURES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * - Reads h5ad files directly in the browser using h5wasm
 * - Handles sparse matrices (CSR/CSC) with automatic conversion for efficiency
 * - Individual datasets (embeddings, obs fields, genes) loaded on-demand
 * - Lazy loading of gene expression data
 * - Automatic UMAP dimension detection
 * - Provides the same interface as other data sources (local-demo, local-user, remote)
 * - Compatible with the Cellucid data format
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IMPORTANT: PERFORMANCE LIMITATIONS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Browser h5ad loading is NOT truly lazy. Due to browser limitations, the
 * entire h5ad file must be loaded into memory before data can be accessed.
 *
 * For large datasets (>100k cells), consider these alternatives:
 * - prepare() in Python for pre-processed binary files
 * - serve_anndata() Python server which supports true lazy loading via backed mode
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DATA PROVIDER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module provides a bridge between the standard Cellucid data loaders
 * and the H5AD file loader. When the active data source is an h5ad file,
 * the provider intercepts data requests and fulfills them directly from
 * the h5ad file instead of fetching URLs.
 *
 * This allows the rest of the application to work unchanged while supporting
 * h5ad files as a data source.
 */

import { getNotificationCenter } from '../app/notification-center.js';
import { buildCscFromCsr, getSparseColumn, findMax, toInt32Array, toFloat32Array } from './sparse-utils.js';
import { DataSourceError, DataSourceErrorCode } from './data-source.js';
import { BaseAnnDataAdapter } from './base-anndata-adapter.js';
import { getDataSourceManager } from './data-source-manager.js';

// ============================================================================
// H5AD LOADER
// ============================================================================

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
      'This may indicate a browser compatibility issue or corrupted installation. ' +
      'Try refreshing the page or use pre-exported data format instead.'
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
 * @returns {{data: Float32Array, indices: Int32Array, indptr: Int32Array, shape: number[], format: string, cscData?: Object}}
 */
function readSparseMatrix(group) {
  // Check encoding type - be lenient with format detection
  const encodingType = group.attrs?.['encoding-type']?.value || '';
  const groupKeys = group.keys();

  // Detect format: check encoding-type first, then fall back to checking for expected keys
  let isCsr = encodingType.includes('csr');
  let isCsc = encodingType.includes('csc');

  // If encoding-type doesn't specify format, check for sparse matrix structure
  if (!isCsr && !isCsc) {
    // Sparse matrices should have data, indices, and indptr
    const hasData = groupKeys.includes('data');
    const hasIndices = groupKeys.includes('indices');
    const hasIndptr = groupKeys.includes('indptr');

    if (hasData && hasIndices && hasIndptr) {
      // Assume CSR format (most common for AnnData)
      isCsr = true;
      console.log(`[H5adLoader] Sparse matrix has no encoding-type, assuming CSR (found data, indices, indptr)`);
    } else {
      console.error(`[H5adLoader] Unknown sparse format. encoding-type='${encodingType}', keys=${groupKeys.join(', ')}`);
      throw new Error(`Unknown sparse format: ${encodingType}. Keys: ${groupKeys.join(', ')}`);
    }
  }

  // Read components
  const dataDs = group.get('data');
  const indicesDs = group.get('indices');
  const indptrDs = group.get('indptr');

  // Use safe conversion functions to handle BigInt64Array/BigUint64Array from h5wasm
  // (int64/uint64 dtypes). Direct construction like new Int32Array(BigInt64Array) throws.
  const data = toFloat32Array(dataDs.value);
  const indices = toInt32Array(indicesDs.value);
  const indptr = toInt32Array(indptrDs.value);

  // Edge case: empty sparse matrix
  if (data.length === 0) {
    console.warn('[H5adLoader] Empty sparse matrix');
  }

  // Get shape from attributes
  let shape = [0, 0];
  if (group.attrs?.['shape']) {
    // Convert BigInt to Number (h5wasm returns BigInt for 64-bit integers)
    shape = Array.from(group.attrs['shape'].value).map(Number);
  } else {
    // Infer shape from indptr and indices using shared utility
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

    /** @type {Map<string, number>} Gene name to index lookup for O(1) access */
    this._varNameIndex = new Map();

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

    /** @type {Promise|null} Promise for CSR→CSC conversion to prevent race conditions */
    this._sparseXLoadPromise = null;

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
          // Build O(1) lookup index for gene names
          this._varNameIndex.clear();
          for (let i = 0; i < this._varNames.length; i++) {
            this._varNameIndex.set(this._varNames[i], i);
          }
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

    // Edge case validation: empty AnnData
    if (this._nObs === 0) {
      console.warn('[H5adLoader] AnnData has 0 cells - this may cause issues');
    }

    // Edge case: no X matrix
    if (!root.keys().includes('X')) {
      console.warn('[H5adLoader] No X matrix found in AnnData - gene expression will not be available');
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
   * Get embedding shape without loading full array data.
   * Used for dimension detection to avoid loading large embeddings just to get nDims.
   * @param {string} key - Embedding key (e.g., 'X_umap', 'X_umap_3d')
   * @returns {{shape: number[], nDims: number}}
   */
  getEmbeddingShape(key) {
    this._ensureOpen();

    const obsm = this._file.get('obsm');
    if (!obsm || !obsm.keys().includes(key)) {
      throw new Error(`Embedding '${key}' not found in obsm. Available: ${this._obsmKeys.join(', ')}`);
    }

    const dataset = obsm.get(key);
    const shape = dataset.shape.map(Number);
    return { shape, nDims: shape[1] || 1 };
  }

  /**
   * Get an embedding from obsm
   * @param {string} key - Embedding key (e.g., 'X_umap', 'X_umap_3d')
   * @returns {Promise<{data: Float32Array, shape: number[], nDims: number}>}
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
    // Use || 1 fallback for 1D embeddings where shape[1] is undefined
    const result = { data, shape: shape.map(Number), nDims: Number(shape[1]) || 1 };
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

    // Use O(1) Map lookup instead of O(n) indexOf for better performance with many genes
    const geneIdx = this._varNameIndex.get(geneName);
    if (geneIdx === undefined) {
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
      // Use Promise-based lock to prevent race conditions when multiple concurrent calls
      // both see !this._sparseX and start the expensive CSR→CSC conversion simultaneously
      if (!this._sparseX) {
        if (!this._sparseXLoadPromise) {
          this._sparseXLoadPromise = (async () => {
            const X = this._file.get('X');
            const sparse = readSparseMatrix(X);

            // For CSR format, convert to CSC for efficient column access
            // This is a one-time O(nnz) cost that pays off with repeated gene queries
            if (sparse.format === 'csr') {
              const nnz = sparse.data.length;
              console.log(`[H5adLoader] Converting CSR to CSC (${(nnz / 1e6).toFixed(1)}M non-zeros) for efficient gene access...`);
              const startTime = performance.now();
              sparse.cscData = buildCscFromCsr(sparse);
              const elapsed = (performance.now() - startTime).toFixed(0);
              console.log(`[H5adLoader] CSR→CSC conversion complete in ${elapsed}ms`);

              // MEMORY OPTIMIZATION: Release original CSR arrays since we only use CSC for column access
              // This prevents memory duplication (saves ~50% of sparse matrix memory)
              sparse.data = null;
              sparse.indices = null;
              sparse.indptr = null;
            }
            return sparse;
          })();
        }
        this._sparseX = await this._sparseXLoadPromise;
      }

      // Extract column using efficient method
      if (this._sparseX.format === 'csr') {
        // Use pre-computed CSC format for O(nnz/n_cols) access via shared utility
        result = getSparseColumn(this._sparseX.cscData, geneIdx, this._nObs);
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
      // Categorical column - use safe conversion for int64 dtypes
      const codes = toInt32Array(item.get('codes').value);
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

    // Check if obsp exists
    const rootKeys = this._file.keys();
    if (!rootKeys.includes('obsp')) {
      console.log('[H5adLoader] No obsp group found in h5ad file');
      return null;
    }

    const obsp = this._file.get('obsp');
    const obspKeys = obsp.keys();
    console.log(`[H5adLoader] obsp contains: ${obspKeys.join(', ')}`);

    if (!obspKeys.includes('connectivities')) {
      console.log('[H5adLoader] No connectivities found in obsp');
      return null;
    }

    const conn = obsp.get('connectivities');
    console.log(`[H5adLoader] connectivities type: ${conn.type}`);

    // Should be sparse (Group containing data, indices, indptr)
    if (conn.type !== 'Group') {
      // Try reading as dense connectivity matrix (rare but possible)
      console.warn('[H5adLoader] connectivities is not a Group (sparse). Type:', conn.type);
      console.warn('[H5adLoader] Dense connectivity matrices are not supported, skipping');
      return null;
    }

    // Log what we find in the connectivity group
    const connKeys = conn.keys();
    console.log(`[H5adLoader] connectivities group contains: ${connKeys.join(', ')}`);

    try {
      const result = readSparseMatrix(conn);
      console.log(`[H5adLoader] Loaded connectivity matrix: ${result.shape[0]}x${result.shape[1]}, ${result.indices.length} non-zeros, format=${result.format}`);
      this._cache.set('connectivities', result);
      return result;
    } catch (err) {
      console.error('[H5adLoader] Failed to read connectivity matrix:', err);
      return null;
    }
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

    // Detect available UMAP dimensions using shape metadata only (no full array loading)
    const availableDimensions = [];
    let defaultDimension = 3;

    for (const key of this._obsmKeys) {
      if (key === 'X_umap_3d' || (key === 'X_umap' && !this._obsmKeys.includes('X_umap_3d'))) {
        // Use getEmbeddingShape() to avoid loading full array just for dimension detection
        const { nDims } = this.getEmbeddingShape(key);
        if (nDims === 3) availableDimensions.push(3);
        else if (nDims === 2) availableDimensions.push(2);
        else if (nDims === 1) availableDimensions.push(1);
      }
      if (key === 'X_umap_2d') availableDimensions.push(2);
      if (key === 'X_umap_1d') availableDimensions.push(1);
    }

    // Fallback: check X_umap
    if (availableDimensions.length === 0 && this._obsmKeys.includes('X_umap')) {
      const { nDims } = this.getEmbeddingShape('X_umap');
      availableDimensions.push(nDims);
    }

    // If still no embeddings found, check for any obsm array that could be an embedding
    if (availableDimensions.length === 0) {
      // Look for common embedding key patterns
      const embeddingPatterns = ['X_pca', 'X_tsne', 'X_phate', 'X_draw_graph', 'X_diffmap'];
      for (const pattern of embeddingPatterns) {
        const matchingKey = this._obsmKeys.find(k => k.startsWith(pattern));
        if (matchingKey) {
          try {
            const { nDims } = this.getEmbeddingShape(matchingKey);
            if (nDims >= 1 && nDims <= 3) {
              availableDimensions.push(nDims);
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

    // Count obs field types using getObsFieldInfo() for performance
    // This only loads metadata (dtype, categories) without loading all values/codes
    let nCategorical = 0;
    let nContinuous = 0;

    for (const key of this._obsKeys) {
      const fieldInfo = await this.getObsFieldInfo(key);
      if (fieldInfo.dtype === 'categorical') {
        nCategorical++;
      } else if (fieldInfo.dtype === 'float' || fieldInfo.dtype === 'int' || fieldInfo.dtype === 'uint') {
        nContinuous++;
      }
    }

    // Check connectivity
    const conn = await this.getConnectivities();
    const hasConnectivity = conn !== null;

    // Use case-insensitive regex for extension stripping to handle .H5AD, .h5ad, etc.
    const baseName = this._filename.replace(/\.h5ad$/i, '');
    return {
      version: 2,
      id: baseName,
      name: baseName,
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
    this._sparseXLoadPromise = null;  // Clear conversion promise to allow fresh conversion
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
    this._varNameIndex.clear();
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

// ============================================================================
// H5AD DATA SOURCE
// ============================================================================

/**
 * H5AD-specific adapter extending the shared BaseAnnDataAdapter.
 * Any h5ad-specific overrides would go here.
 */
class H5adDataAdapter extends BaseAnnDataAdapter {
  /**
   * @param {H5adLoader} loader - The h5ad loader
   */
  constructor(loader) {
    super(loader);
  }

  // H5adDataAdapter uses all methods from BaseAnnDataAdapter without modification.
  // Any h5ad-specific overrides can be added here if needed in the future.
}

/**
 * H5AD Data Source for Cellucid
 * Provides the same interface as LocalUserDirDataSource but for h5ad files
 */
export class H5adDataSource {
  constructor() {
    /** @type {H5adLoader|null} */
    this._loader = null;

    /** @type {H5adDataAdapter|null} */
    this._adapter = null;

    /** @type {string|null} */
    this.datasetId = null;

    /** @type {string|null} */
    this.filename = null;

    /** @type {Object|null} */
    this._metadata = null;

    /** @type {Map<string, string>} Blob URLs for virtual files */
    this._blobUrls = new Map();

    this.type = 'h5ad';
  }

  /**
   * Get the type identifier
   * @returns {string}
   */
  getType() {
    return this.type;
  }

  /**
   * Check if a file is loaded
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return this._loader !== null && this._loader.isOpen;
  }

  /**
   * Load an h5ad file
   * @param {File} file - File from file input
   * @returns {Promise<Object>}
   */
  async loadFromFile(file) {
    if (!isH5adFile(file)) {
      throw new DataSourceError(
        'Not an h5ad file',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    // Show performance warning - h5ad loading has significant limitations
    const notifications = getNotificationCenter();
    notifications.warning(
      'Loading h5ad directly in browser. Note: (1) The entire file is loaded into memory, ' +
      '(2) No quantization or compression - larger memory usage, ' +
      '(3) Gene expression loads are slower. For large datasets, use prepare() instead.',
      { duration: 15000 }
    );

    // Clear previous state
    this._cleanup();

    // Create loader and open file
    this._loader = createH5adLoader();
    await this._loader.open(file);

    // Create adapter
    this._adapter = new H5adDataAdapter(this._loader);
    await this._adapter.initialize();

    this.filename = file.name;
    this.datasetId = `h5ad_${file.name.replace(/\.h5ad$/i, '')}`;
    this._metadata = this._adapter.getMetadata();
    this._metadata.id = this.datasetId;

    console.log(`[H5adDataSource] Loaded ${file.name}: ${this._loader.nObs} cells, ${this._loader.nVars} genes`);

    return this._metadata;
  }

  /**
   * List available datasets
   * @returns {Promise<Object[]>}
   */
  async listDatasets() {
    if (!this._metadata) {
      return [];
    }
    return [this._metadata];
  }

  /**
   * Get metadata for a dataset
   * @param {string} datasetId
   * @returns {Promise<Object>}
   */
  async getMetadata(datasetId) {
    if (!this._metadata) {
      throw new DataSourceError(
        'No h5ad file loaded',
        DataSourceErrorCode.NOT_FOUND,
        this.type
      );
    }
    return this._metadata;
  }

  /**
   * Check if a dataset exists
   * @param {string} datasetId
   * @returns {Promise<boolean>}
   */
  async hasDataset(datasetId) {
    return this.datasetId !== null && this.datasetId === datasetId;
  }

  /**
   * Get base URL for the dataset
   * @param {string} _datasetId
   * @returns {string}
   */
  getBaseUrl(_datasetId) {
    return `h5ad://${this.datasetId}/`;
  }

  /**
   * Get the H5AD data adapter (for direct data access)
   * @returns {H5adDataAdapter|null}
   */
  getAdapter() {
    return this._adapter;
  }

  /**
   * Get embedding data
   * @param {number} dim - Dimension (1, 2, or 3)
   * @returns {Promise<Float32Array>}
   */
  async getEmbedding(dim) {
    if (!this._adapter) {
      throw new DataSourceError('No h5ad file loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter.getEmbedding(dim);
  }

  /**
   * Get obs field data
   * @param {string} key - Field name
   * @returns {Promise<Object>}
   */
  async getObsFieldData(key) {
    if (!this._adapter) {
      throw new DataSourceError('No h5ad file loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter.getObsFieldData(key);
  }

  /**
   * Get gene expression values
   * @param {string} geneName - Gene name
   * @returns {Promise<Float32Array>}
   */
  async getGeneExpression(geneName) {
    if (!this._adapter) {
      throw new DataSourceError('No h5ad file loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter.getGeneExpression(geneName);
  }

  /**
   * Get connectivity edges
   * @returns {Promise<Object|null>}
   */
  async getConnectivityEdges() {
    if (!this._adapter) {
      return null;
    }
    return this._adapter.getConnectivityEdges();
  }

  /**
   * Get obs manifest
   * @returns {Object}
   */
  getObsManifest() {
    if (!this._adapter) {
      throw new DataSourceError('No h5ad file loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter.getObsManifest();
  }

  /**
   * Get var manifest
   * @returns {Object}
   */
  getVarManifest() {
    if (!this._adapter) {
      throw new DataSourceError('No h5ad file loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter.getVarManifest();
  }

  /**
   * Get connectivity manifest
   * @returns {Promise<Object|null>}
   */
  async getConnectivityManifest() {
    const edges = await this.getConnectivityEdges();
    if (!edges) return null;

    return {
      format: 'edge_pairs',
      n_cells: this._loader.nObs,
      n_edges: edges.nEdges,
      index_dtype: 'uint32',
      index_bytes: 4,
    };
  }

  /**
   * Resolve h5ad:// URL (not really used, data is accessed directly)
   * @param {string} url
   * @returns {Promise<string>}
   */
  async resolveUrl(url) {
    // h5ad source doesn't use URL fetching, data is accessed directly
    throw new DataSourceError(
      'h5ad source does not support URL resolution. Use direct data access methods.',
      DataSourceErrorCode.UNSUPPORTED,
      this.type
    );
  }

  /**
   * Called when source is deactivated
   */
  onDeactivate() {
    // Revoke blob URLs
    for (const url of this._blobUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this._blobUrls.clear();
  }

  /**
   * Cleanup resources
   * @private
   */
  _cleanup() {
    if (this._adapter) {
      this._adapter.close();
      this._adapter = null;
    }
    if (this._loader) {
      this._loader.close();
      this._loader = null;
    }

    for (const url of this._blobUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this._blobUrls.clear();

    this.datasetId = null;
    this.filename = null;
    this._metadata = null;
  }

  /**
   * Clear the current file
   */
  clear() {
    this._cleanup();
  }

  /**
   * Clear caches without fully closing the source.
   * Used when deactivating to free memory while keeping the file reference.
   */
  clearCaches() {
    if (this._adapter) {
      // Clear adapter caches (embeddings, obs data, connectivity)
      this._adapter._embeddingCache?.clear();
      this._adapter._obsFieldDataCache?.clear();
      this._adapter._normInfo?.clear();
      this._adapter._connectivityCache = undefined;
    }
    if (this._loader) {
      // Clear loader caches (gene expression, obs info)
      this._loader.clearCache();
    }
    console.log('[H5adDataSource] Cleared caches to free memory');
  }

  /**
   * Requires manual reconnection (file access)
   * @returns {boolean}
   */
  requiresManualReconnect() {
    return true;
  }
}

/**
 * Create an H5adDataSource instance
 * @returns {H5adDataSource}
 */
export function createH5adDataSource() {
  return new H5adDataSource();
}

// ============================================================================
// H5AD DATA PROVIDER
// ============================================================================

/**
 * Check if the current data source is an h5ad file
 * @returns {boolean}
 */
export function isH5adActive() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return false;

  // Check if source is local-user in h5ad mode
  if (source.getType?.() === 'local-user') {
    return source.isH5adMode?.() === true;
  }

  // Check if source is h5ad type directly
  return source.getType?.() === 'h5ad';
}

/**
 * Get the active h5ad source adapter
 * @returns {Object|null} H5AD source or adapter
 */
export function getH5adAdapter() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return null;

  // If local-user in h5ad mode
  if (source.getType?.() === 'local-user' && source.isH5adMode?.()) {
    return source.getH5adSource?.()?.getAdapter?.() || null;
  }

  // If h5ad source directly
  if (source.getType?.() === 'h5ad') {
    return source.getAdapter?.() || null;
  }

  return null;
}

/**
 * Get the active h5ad source
 * @returns {Object|null}
 */
export function getH5adSource() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return null;

  // If local-user in h5ad mode
  if (source.getType?.() === 'local-user' && source.isH5adMode?.()) {
    return source.getH5adSource?.() || null;
  }

  // If h5ad source directly
  if (source.getType?.() === 'h5ad') {
    return source;
  }

  return null;
}

/**
 * Load points (embedding) from h5ad source
 * @param {number} dim - Dimension (1, 2, or 3)
 * @returns {Promise<Float32Array>}
 */
export async function h5adLoadPoints(dim) {
  const adapter = getH5adAdapter();
  if (!adapter) {
    throw new Error('No h5ad adapter available');
  }

  return adapter.getEmbedding(dim);
}

/**
 * Load obs manifest from h5ad source
 * @returns {Object}
 */
export function h5adGetObsManifest() {
  const adapter = getH5adAdapter();
  if (!adapter) {
    throw new Error('No h5ad adapter available');
  }

  return adapter.getObsManifest();
}

/**
 * Load var manifest from h5ad source
 * @returns {Object}
 */
export function h5adGetVarManifest() {
  const adapter = getH5adAdapter();
  if (!adapter) {
    throw new Error('No h5ad adapter available');
  }

  return adapter.getVarManifest();
}

/**
 * Load obs field data from h5ad source
 * @param {string} fieldKey - Field name
 * @returns {Promise<{data: ArrayBuffer, kind: string, categories?: string[]}>}
 */
export async function h5adLoadObsField(fieldKey) {
  const adapter = getH5adAdapter();
  if (!adapter) {
    throw new Error('No h5ad adapter available');
  }

  return adapter.getObsFieldData(fieldKey);
}

/**
 * Load gene expression from h5ad source
 * @param {string} geneName - Gene name
 * @returns {Promise<Float32Array>}
 */
export async function h5adLoadGeneExpression(geneName) {
  const adapter = getH5adAdapter();
  if (!adapter) {
    throw new Error('No h5ad adapter available');
  }

  return adapter.getGeneExpression(geneName);
}

/**
 * Load connectivity edges from h5ad source
 * @returns {Promise<{sources: Uint32Array, destinations: Uint32Array, nEdges: number}|null>}
 */
export async function h5adLoadConnectivity() {
  const adapter = getH5adAdapter();
  if (!adapter) {
    return null;
  }

  return adapter.getConnectivityEdges();
}

/**
 * Get connectivity manifest from h5ad source
 * @returns {Promise<Object|null>}
 */
export async function h5adGetConnectivityManifest() {
  const source = getH5adSource();
  if (!source) {
    return null;
  }

  return source.getConnectivityManifest?.() || null;
}

/**
 * Get dataset identity from h5ad source
 * @returns {Object}
 */
export function h5adGetDatasetIdentity() {
  const adapter = getH5adAdapter();
  if (!adapter) {
    throw new Error('No h5ad adapter available');
  }

  return adapter.getMetadata();
}

/**
 * Check if a URL is an h5ad:// URL
 * @param {string} url
 * @returns {boolean}
 */
export function isH5adUrl(url) {
  return url?.startsWith('h5ad://');
}

/**
 * Parse an h5ad:// URL
 * @param {string} url
 * @returns {{datasetId: string, path: string}|null}
 */
export function parseH5adUrl(url) {
  if (!isH5adUrl(url)) return null;

  // Format: h5ad://datasetId/path
  const withoutProtocol = url.substring('h5ad://'.length);
  const slashIdx = withoutProtocol.indexOf('/');

  if (slashIdx === -1) {
    return { datasetId: withoutProtocol, path: '' };
  }

  return {
    datasetId: withoutProtocol.substring(0, slashIdx),
    path: withoutProtocol.substring(slashIdx + 1)
  };
}
