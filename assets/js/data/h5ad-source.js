/**
 * H5AD Data Source for Cellucid
 *
 * Data source that reads AnnData h5ad files directly in the browser.
 * Provides the same interface as other data sources (local-demo, local-user, remote).
 *
 * Features:
 * - Direct h5ad file reading without server
 * - Sparse matrix support
 * - Lazy loading of gene expression data
 * - Automatic UMAP dimension detection
 */

import { DataSourceError, DataSourceErrorCode } from './data-source.js';
import { H5adLoader, isH5adFile, createH5adLoader } from './h5ad-loader.js';
import { getNotificationCenter } from '../app/notification-center.js';

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

/**
 * Adapter that makes H5adLoader compatible with Cellucid data loaders
 * Caches computed data and provides efficient access patterns
 */
class H5adDataAdapter {
  /**
   * @param {H5adLoader} loader - The h5ad loader
   */
  constructor(loader) {
    this._loader = loader;
    this._metadata = null;

    // Caches for computed Cellucid-format data
    this._embeddingCache = new Map();
    this._obsFieldsMetadata = null;  // Just metadata, not data
    this._obsFieldDataCache = new Map();  // Lazy-loaded field data
    this._connectivityCache = undefined;  // undefined = not computed, null = no connectivity

    // Normalization info per dimension
    this._normInfo = new Map();
  }

  /**
   * Initialize the adapter and compute metadata
   * @returns {Promise<void>}
   */
  async initialize() {
    this._metadata = await this._loader.getDatasetMetadata();

    // Compute obs field metadata (NOT the actual data - that's loaded lazily)
    await this._computeObsFieldsMetadata();
  }

  /**
   * Compute obs field metadata only (kind, categories for categorical)
   * Does NOT load actual field data - that happens lazily in getObsFieldData()
   * @private
   */
  async _computeObsFieldsMetadata() {
    this._obsFieldsMetadata = [];

    for (const key of this._loader.obsKeys) {
      try {
        // Get field info without loading all values
        const fieldInfo = await this._loader.getObsFieldInfo(key);

        if (fieldInfo.dtype === 'categorical') {
          // Categories are small, can load them
          this._obsFieldsMetadata.push({
            key,
            kind: 'category',
            categories: fieldInfo.categories,
          });
        } else if (fieldInfo.dtype === 'float' || fieldInfo.dtype === 'int' || fieldInfo.dtype === 'uint') {
          // Continuous - don't load values at init time
          this._obsFieldsMetadata.push({
            key,
            kind: 'continuous',
            // min/max will be computed lazily when field is first accessed
            min: null,
            max: null,
          });
        } else {
          // String/bool treated as categorical - need to read values to get unique set
          // This is expensive but unavoidable for non-explicit categoricals
          const field = await this._loader.getObsField(key);
          const uniqueValues = [...new Set(field.values.filter(v => v != null))].map(String);
          const categories = uniqueValues.sort();
          this._obsFieldsMetadata.push({
            key,
            kind: 'category',
            categories,
            _needsCodeComputation: true,  // Mark that codes need to be computed from values
          });
        }
      } catch (err) {
        console.warn(`[H5adDataAdapter] Failed to process obs field '${key}':`, err);
      }
    }

    // Update metadata with field info
    this._metadata.obs_fields = this._obsFieldsMetadata.map(f => ({
      key: f.key,
      kind: f.kind,
      n_categories: f.kind === 'category' ? f.categories?.length : undefined,
    }));

    const nCategorical = this._obsFieldsMetadata.filter(f => f.kind === 'category').length;
    const nContinuous = this._obsFieldsMetadata.filter(f => f.kind === 'continuous').length;
    this._metadata.stats.n_categorical_fields = nCategorical;
    this._metadata.stats.n_continuous_fields = nContinuous;
  }

  /**
   * Get or compute full field data (lazy loading)
   * @param {string} key - Field name
   * @returns {Promise<Object>}
   * @private
   */
  async _getOrLoadFieldData(key) {
    if (this._obsFieldDataCache.has(key)) {
      return this._obsFieldDataCache.get(key);
    }

    const meta = this._obsFieldsMetadata.find(f => f.key === key);
    if (!meta) {
      throw new Error(`Obs field '${key}' not found`);
    }

    const field = await this._loader.getObsField(key);
    let result;

    if (meta.kind === 'continuous') {
      const values = field.values;
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (Number.isFinite(v)) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      // Update metadata with computed min/max
      meta.min = min === Infinity ? 0 : min;
      meta.max = max === -Infinity ? 1 : max;

      result = {
        kind: 'continuous',
        values: values instanceof Float32Array ? values : new Float32Array(values),
        min: meta.min,
        max: meta.max,
      };
    } else {
      // Categorical
      let codes, categories;
      if (field.dtype === 'categorical' && field.codes) {
        codes = field.codes;
        categories = meta.categories || field.categories;
      } else {
        // Need to compute codes from values
        categories = meta.categories;
        const categoryMap = new Map(categories.map((c, i) => [c, i]));
        codes = new Int32Array(field.values.length);
        for (let i = 0; i < field.values.length; i++) {
          const v = field.values[i];
          codes[i] = v != null ? (categoryMap.get(String(v)) ?? -1) : -1;
        }
      }

      result = {
        kind: 'category',
        categories,
        codes,
      };
    }

    this._obsFieldDataCache.set(key, result);
    return result;
  }

  /**
   * Get dataset metadata
   * @returns {DatasetMetadata}
   */
  getMetadata() {
    return this._metadata;
  }

  /**
   * Get embedding coordinates for a dimension
   * @param {number} dim - Dimension (1, 2, or 3)
   * @returns {Promise<Float32Array>}
   */
  async getEmbedding(dim) {
    if (this._embeddingCache.has(dim)) {
      return this._embeddingCache.get(dim);
    }

    // Try explicit dimension key first
    let embKey = `X_umap_${dim}d`;
    if (!this._loader.obsmKeys.includes(embKey)) {
      // Fall back to X_umap if it has the right dimension
      if (this._loader.obsmKeys.includes('X_umap')) {
        embKey = 'X_umap';
      } else {
        throw new Error(`No ${dim}D embedding found`);
      }
    }

    const emb = await this._loader.getEmbedding(embKey);

    // Verify dimension
    if (emb.nDims !== dim && embKey !== 'X_umap') {
      throw new Error(`Embedding '${embKey}' has ${emb.nDims} dimensions, expected ${dim}`);
    }

    // Normalize to [-1, 1] range
    const normalized = this._normalizeEmbedding(emb.data, emb.nDims, dim);

    this._embeddingCache.set(dim, normalized);
    return normalized;
  }

  /**
   * Normalize embedding coordinates to [-1, 1] range
   * @param {Float32Array} data - Raw embedding data (flattened)
   * @param {number} srcDim - Source dimensions
   * @param {number} targetDim - Target dimensions
   * @returns {Float32Array}
   * @private
   */
  _normalizeEmbedding(data, srcDim, targetDim) {
    const nCells = data.length / srcDim;
    const result = new Float32Array(nCells * targetDim);

    // Find min/max for each axis
    const mins = new Array(srcDim).fill(Infinity);
    const maxs = new Array(srcDim).fill(-Infinity);

    for (let i = 0; i < nCells; i++) {
      for (let d = 0; d < srcDim; d++) {
        const v = data[i * srcDim + d];
        if (v < mins[d]) mins[d] = v;
        if (v > maxs[d]) maxs[d] = v;
      }
    }

    // Find max range across all axes for uniform scaling
    let maxRange = 0;
    for (let d = 0; d < srcDim; d++) {
      const range = maxs[d] - mins[d];
      if (range > maxRange) maxRange = range;
    }

    if (maxRange < 1e-8) maxRange = 1;

    // Compute centers
    const centers = mins.map((min, d) => (min + maxs[d]) / 2);

    // Normalize
    const scale = 2 / maxRange;
    for (let i = 0; i < nCells; i++) {
      for (let d = 0; d < Math.min(srcDim, targetDim); d++) {
        result[i * targetDim + d] = (data[i * srcDim + d] - centers[d]) * scale;
      }
      // Zero-fill extra dimensions if targetDim > srcDim
      for (let d = srcDim; d < targetDim; d++) {
        result[i * targetDim + d] = 0;
      }
    }

    this._normInfo.set(targetDim, { maxRange, centers, scale });
    return result;
  }

  /**
   * Get obs manifest in Cellucid format
   * @returns {Object}
   */
  getObsManifest() {
    const continuousFields = [];
    const categoricalFields = [];

    for (const field of this._obsFieldsMetadata) {
      if (field.kind === 'continuous') {
        // min/max may be null if not yet computed - use placeholders
        continuousFields.push([field.key, field.min ?? 0, field.max ?? 1]);
      } else {
        // Categorical
        const dtype = field.categories.length <= 254 ? 'uint8' : 'uint16';
        const missingValue = field.categories.length <= 254 ? 255 : 65535;

        // Note: Browser h5ad loader returns empty centroids for performance.
        // Computing centroids requires loading all embedding coordinates upfront,
        // which would defeat the purpose of lazy loading for large datasets.
        // This is an acceptable tradeoff - centroids are optional for visualization.
        // For full centroid support, use prepare() or serve_anndata().
        const centroids = {};

        categoricalFields.push([
          field.key,
          field.categories,
          dtype,
          missingValue,
          centroids,
          0, 1  // outlier quantile range
        ]);
      }
    }

    return {
      _format: 'compact_v1',
      n_points: this._loader.nObs,
      centroid_outlier_quantile: 0.95,
      compression: null,
      _obsSchemas: {
        continuous: {
          pathPattern: 'obs/{key}.values.f32.bin',
          ext: 'f32',
          dtype: 'float32',
          quantized: false,
        },
        categorical: {
          codesPathPattern: 'obs/{key}.codes.{ext}.bin',
          outlierPathPattern: 'obs/{key}.outliers.f32.bin',
          outlierExt: 'f32',
          outlierDtype: 'float32',
          outlierQuantized: false,
        }
      },
      _continuousFields: continuousFields,
      _categoricalFields: categoricalFields,
    };
  }

  /**
   * Get var manifest in Cellucid format
   * @returns {Object}
   */
  getVarManifest() {
    return {
      _format: 'compact_v1',
      n_points: this._loader.nObs,
      var_gene_id_column: null,
      compression: null,
      quantization: null,
      _varSchema: {
        kind: 'continuous',
        pathPattern: 'var/{key}.values.f32.bin',
        ext: 'f32',
        dtype: 'float32',
        quantized: false,
      },
      fields: this._loader.varNames.map(name => [name]),
    };
  }

  /**
   * Get obs field data as binary (lazy loaded)
   * @param {string} key - Field name
   * @returns {Promise<{data: ArrayBuffer, kind: string, categories?: string[]}>}
   */
  async getObsFieldData(key) {
    // Lazy load the field data
    const fieldData = await this._getOrLoadFieldData(key);

    if (fieldData.kind === 'continuous') {
      return {
        data: fieldData.values.buffer,
        kind: 'continuous',
        min: fieldData.min,
        max: fieldData.max,
      };
    } else {
      // Categorical - convert codes to appropriate dtype
      const dtype = fieldData.categories.length <= 254 ? Uint8Array : Uint16Array;
      const missingValue = fieldData.categories.length <= 254 ? 255 : 65535;

      const codes = new dtype(fieldData.codes.length);
      for (let i = 0; i < fieldData.codes.length; i++) {
        codes[i] = fieldData.codes[i] >= 0 ? fieldData.codes[i] : missingValue;
      }

      return {
        data: codes.buffer,
        kind: 'category',
        categories: fieldData.categories,
        dtype: fieldData.categories.length <= 254 ? 'uint8' : 'uint16',
        missingValue,
      };
    }
  }

  /**
   * Get gene expression values
   * @param {string} geneName - Gene name
   * @returns {Promise<Float32Array>}
   */
  async getGeneExpression(geneName) {
    return this._loader.getGeneExpression(geneName);
  }

  /**
   * Get connectivity edges
   * @returns {Promise<{sources: Uint32Array, destinations: Uint32Array, nEdges: number}|null>}
   */
  async getConnectivityEdges() {
    // Check if already computed (undefined = not yet, null = no connectivity, object = has data)
    if (this._connectivityCache !== undefined) {
      return this._connectivityCache;
    }

    const conn = await this._loader.getConnectivities();
    if (!conn) {
      this._connectivityCache = null;  // Mark as computed but no connectivity
      return null;
    }

    // Extract unique edges (src < dst)
    const { indptr, indices } = conn;
    const nCells = indptr.length - 1;

    const edgeSources = [];
    const edgeDestinations = [];

    for (let cell = 0; cell < nCells; cell++) {
      const start = indptr[cell];
      const end = indptr[cell + 1];

      for (let j = start; j < end; j++) {
        const neighbor = indices[j];
        if (cell < neighbor) {
          edgeSources.push(cell);
          edgeDestinations.push(neighbor);
        }
      }
    }

    const sources = new Uint32Array(edgeSources);
    const destinations = new Uint32Array(edgeDestinations);

    this._connectivityCache = {
      sources,
      destinations,
      nEdges: sources.length,
    };

    return this._connectivityCache;
  }

  /**
   * Get gene names
   * @returns {string[]}
   */
  getGeneNames() {
    return this._loader.varNames;
  }

  /**
   * Close and release resources
   */
  close() {
    this._loader.close();
    this._embeddingCache.clear();
    this._obsFieldsMetadata = null;
    this._obsFieldDataCache.clear();
    this._connectivityCache = undefined;  // Reset to "not computed" state
    this._normInfo.clear();
  }
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

    /** @type {DatasetMetadata|null} */
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
   * @returns {Promise<DatasetMetadata>}
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
    this.datasetId = `h5ad_${file.name.replace('.h5ad', '')}`;
    this._metadata = this._adapter.getMetadata();
    this._metadata.id = this.datasetId;

    console.log(`[H5adDataSource] Loaded ${file.name}: ${this._loader.nObs} cells, ${this._loader.nVars} genes`);

    return this._metadata;
  }

  /**
   * List available datasets
   * @returns {Promise<DatasetMetadata[]>}
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
   * @returns {Promise<DatasetMetadata>}
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

// Note: isH5adUrl is exported from h5ad-data-provider.js to avoid duplication
