/**
 * Base AnnData Adapter for Cellucid
 *
 * Shared base class for H5adDataAdapter and ZarrDataAdapter.
 * Contains common logic for:
 * - Embedding normalization
 * - Obs manifest generation
 * - Var manifest generation
 * - Obs field data processing
 * - Connectivity edge extraction
 *
 * Subclasses must implement:
 * - _getLoader() - Returns the underlying loader (H5adLoader or ZarrLoader)
 * - _computeObsFieldsMetadata() - Compute obs field metadata (may have format-specific logic)
 *
 * This eliminates ~500 lines of duplicated code between h5ad.js and zarr.js.
 */

import { extractConnectivityEdges } from './sparse-utils.js';

/**
 * Base adapter class for AnnData file formats
 * @abstract
 */
export class BaseAnnDataAdapter {
  /**
   * @param {Object} loader - The underlying loader (H5adLoader or ZarrLoader)
   */
  constructor(loader) {
    /** @protected */
    this._loader = loader;

    /** @type {Object|null} */
    this._metadata = null;

    /** @type {Map<number, Float32Array>} Cached embeddings per dimension */
    this._embeddingCache = new Map();

    /** @type {Array|null} Obs field metadata (kind, categories, etc.) */
    this._obsFieldsMetadata = null;

    /** @type {Map<string, Object>} Lazy-loaded obs field data */
    this._obsFieldDataCache = new Map();

    /** @type {Object|undefined|null} undefined = not computed, null = no connectivity, object = has data */
    this._connectivityCache = undefined;

    /** @type {Map<number, Object>} Normalization info per dimension */
    this._normInfo = new Map();
  }

  /**
   * Initialize the adapter and compute metadata
   * @returns {Promise<void>}
   */
  async initialize() {
    this._metadata = await this._loader.getDatasetMetadata();
    await this._computeObsFieldsMetadata();
  }

  /**
   * Compute obs field metadata (to be overridden by subclasses if needed)
   * @protected
   * @returns {Promise<void>}
   */
  async _computeObsFieldsMetadata() {
    this._obsFieldsMetadata = [];

    for (const key of this._loader.obsKeys) {
      try {
        const fieldInfo = await this._loader.getObsFieldInfo(key);

        if (fieldInfo.dtype === 'categorical') {
          this._obsFieldsMetadata.push({
            key,
            kind: 'category',
            categories: fieldInfo.categories,
          });
        } else if (fieldInfo.dtype === 'float' || fieldInfo.dtype === 'int' || fieldInfo.dtype === 'uint') {
          this._obsFieldsMetadata.push({
            key,
            kind: 'continuous',
            min: null,
            max: null,
          });
        } else if (fieldInfo.dtype === 'string' || fieldInfo.dtype === 'bool') {
          // String/bool treated as categorical
          const field = await this._loader.getObsField(key);
          const uniqueValues = [...new Set(field.values.filter(v => v != null))].map(String);
          const categories = uniqueValues.sort();
          this._obsFieldsMetadata.push({
            key,
            kind: 'category',
            categories,
            _needsCodeComputation: true,
          });
        } else {
          console.warn(`[BaseAnnDataAdapter] Skipping obs field '${key}' with dtype: ${fieldInfo.dtype}`);
        }
      } catch (err) {
        console.warn(`[BaseAnnDataAdapter] Failed to process obs field '${key}':`, err);
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
   * @protected
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

      const len = values.length;
      for (let i = 0; i < len; i++) {
        const v = values[i];
        if (Number.isFinite(v)) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }

      // Edge case: all values are NaN/Inf
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
   * @returns {Object}
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

    // Verify dimension (allow X_umap to have any dimension)
    if (emb.nDims !== dim && embKey !== 'X_umap') {
      throw new Error(`Embedding '${embKey}' has ${emb.nDims} dimensions, expected ${dim}`);
    }

    // Normalize to [-1, 1] range
    const normalized = this._normalizeEmbedding(emb.data, emb.nDims, dim);

    this._embeddingCache.set(dim, normalized);
    return normalized;
  }

  /**
   * Normalize embedding coordinates to [-1, 1] range.
   * Handles NaN/Inf values and ensures uniform scaling across all axes.
   *
   * @param {Float32Array} data - Raw embedding data (flattened, row-major)
   * @param {number} srcDim - Source dimensions
   * @param {number} targetDim - Target dimensions
   * @returns {Float32Array}
   * @protected
   */
  _normalizeEmbedding(data, srcDim, targetDim) {
    const nCells = data.length / srcDim;

    // Edge case: empty data
    if (nCells === 0) {
      console.warn('[BaseAnnDataAdapter] Empty embedding data');
      return new Float32Array(0);
    }

    const result = new Float32Array(nCells * targetDim);

    // Find min/max for each axis, filtering out NaN/Inf
    // IMPORTANT: Only update mins/maxs for cells where ALL dimensions are finite
    // to prevent partial data from cells with NaN in later dimensions from skewing scaling
    const mins = new Array(srcDim).fill(Infinity);
    const maxs = new Array(srcDim).fill(-Infinity);
    let validCount = 0;

    for (let i = 0; i < nCells; i++) {
      // First pass: check if ALL dimensions are finite for this cell
      let cellValid = true;
      const baseIdx = i * srcDim;
      for (let d = 0; d < srcDim; d++) {
        if (!Number.isFinite(data[baseIdx + d])) {
          cellValid = false;
          break;
        }
      }

      // Second pass: only update mins/maxs if the entire cell is valid
      if (cellValid) {
        validCount++;
        for (let d = 0; d < srcDim; d++) {
          const v = data[baseIdx + d];
          if (v < mins[d]) mins[d] = v;
          if (v > maxs[d]) maxs[d] = v;
        }
      }
    }

    // Edge case: all values are NaN/Inf
    if (validCount === 0) {
      console.warn('[BaseAnnDataAdapter] All embedding values are NaN/Inf, returning zeros');
      return result; // Already zero-filled
    }

    // Log warning if some values are invalid
    if (validCount < nCells) {
      console.warn(`[BaseAnnDataAdapter] ${nCells - validCount} cells have NaN/Inf in embedding coordinates`);
    }

    // Find max range across all axes for uniform scaling
    let maxRange = 0;
    for (let d = 0; d < srcDim; d++) {
      // If min is still Infinity, no valid values for this dimension
      if (mins[d] === Infinity) {
        mins[d] = 0;
        maxs[d] = 1;
      }
      const range = maxs[d] - mins[d];
      if (range > maxRange) maxRange = range;
    }

    // Edge case: all values are identical
    if (maxRange < 1e-8) maxRange = 1;

    // Compute centers
    const centers = mins.map((min, d) => (min + maxs[d]) / 2);

    // Normalize
    const scale = 2 / maxRange;
    for (let i = 0; i < nCells; i++) {
      for (let d = 0; d < Math.min(srcDim, targetDim); d++) {
        const v = data[i * srcDim + d];
        // Replace NaN/Inf with 0 (center)
        if (Number.isFinite(v)) {
          result[i * targetDim + d] = (v - centers[d]) * scale;
        } else {
          result[i * targetDim + d] = 0;
        }
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
   * Get obs manifest in Cellucid compact format
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
        const nCategories = field.categories.length;

        // Edge case: handle overflow for category counts
        // uint8 can hold 0-254 (255 is missing value)
        // uint16 can hold 0-65534 (65535 is missing value)
        let dtype, missingValue;
        if (nCategories > 65534) {
          console.warn(`[BaseAnnDataAdapter] Field '${field.key}' has ${nCategories} categories, exceeding uint16 limit. Truncating to 65534.`);
          dtype = 'uint16';
          missingValue = 65535;
        } else if (nCategories > 254) {
          dtype = 'uint16';
          missingValue = 65535;
        } else {
          dtype = 'uint8';
          missingValue = 255;
        }

        // Note: Browser loaders return empty centroids for performance.
        // Computing centroids requires loading all embedding coordinates upfront,
        // which would defeat lazy loading for large datasets.
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
   * Get var manifest in Cellucid compact format
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
   * @returns {Promise<{data: ArrayBuffer, kind: string, categories?: string[], min?: number, max?: number}>}
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
      const nCategories = fieldData.categories.length;

      // Apply same overflow handling as in getObsManifest
      let TypedArrayClass, missingValue, dtypeStr;
      if (nCategories > 65534) {
        TypedArrayClass = Uint16Array;
        missingValue = 65535;
        dtypeStr = 'uint16';
      } else if (nCategories > 254) {
        TypedArrayClass = Uint16Array;
        missingValue = 65535;
        dtypeStr = 'uint16';
      } else {
        TypedArrayClass = Uint8Array;
        missingValue = 255;
        dtypeStr = 'uint8';
      }

      const codes = new TypedArrayClass(fieldData.codes.length);
      for (let i = 0; i < fieldData.codes.length; i++) {
        const code = fieldData.codes[i];
        // Handle missing values and overflow
        if (code < 0) {
          codes[i] = missingValue;
        } else if (nCategories > 65534 && code >= 65534) {
          codes[i] = 65534; // Clamp to max valid code
        } else {
          codes[i] = code;
        }
      }

      return {
        data: codes.buffer,
        kind: 'category',
        categories: fieldData.categories,
        dtype: dtypeStr,
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
    // Check if already computed
    if (this._connectivityCache !== undefined) {
      return this._connectivityCache;
    }

    console.log('[BaseAnnDataAdapter] Loading connectivity edges...');

    let conn;
    try {
      conn = await this._loader.getConnectivities();
    } catch (err) {
      console.error('[BaseAnnDataAdapter] Error loading connectivities:', err);
      this._connectivityCache = null;
      return null;
    }

    if (!conn) {
      console.log('[BaseAnnDataAdapter] No connectivity data available');
      this._connectivityCache = null;
      return null;
    }

    // Edge case: connectivity exists but has no data
    if (!conn.indptr || !conn.indices) {
      console.warn('[BaseAnnDataAdapter] Connectivity matrix missing indptr or indices');
      this._connectivityCache = null;
      return null;
    }

    if (conn.indices.length === 0) {
      console.warn('[BaseAnnDataAdapter] Connectivity matrix has no edges (indices.length === 0)');
      this._connectivityCache = null;
      return null;
    }

    console.log(`[BaseAnnDataAdapter] Connectivity matrix: ${conn.shape?.[0] || 'unknown'}x${conn.shape?.[1] || 'unknown'}, ${conn.indices.length} non-zeros`);

    // Use shared utility for edge extraction
    const edges = extractConnectivityEdges(conn, this._loader.nObs);

    console.log(`[BaseAnnDataAdapter] Extracted ${edges.nEdges} unique edges`);

    this._connectivityCache = {
      sources: edges.sources,
      destinations: edges.destinations,
      nEdges: edges.nEdges,
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
    this._connectivityCache = undefined;
    this._normInfo.clear();
  }
}
