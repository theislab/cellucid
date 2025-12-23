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

    /** @type {Map<string, Map<number, Float32Array>>} Cached vector fields per fieldId + dimension */
    this._vectorFieldCache = new Map();

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
    await this._computeVectorFieldsMetadata();
  }

  /**
   * Detect available vector fields in `obsm` and attach a compact metadata
   * summary onto the dataset identity.
   *
   * This keeps the UI fast: we can show/hide the vector field overlay controls
   * without loading the full vector arrays upfront.
   *
   * Naming convention (UMAP basis):
   * - Explicit per-dimension keys: `<field>_umap_<dim>d` (preferred)
   *   - Examples: `velocity_umap_2d`, `T_fwd_umap_3d`
   * - Implicit key: `<field>_umap` with shape `(n_cells, 1|2|3)`
   *   - Accepted ONLY if the explicit `<field>_umap_<dim>d` is not present (clash-safe)
   *
   * Notes:
   * - Keys starting with `X_` are reserved for embeddings and are ignored here.
   * - This does not compute or validate semantics; it only validates shapes.
   *
   * @protected
   */
  async _computeVectorFieldsMetadata() {
    const obsmKeys = Array.isArray(this._loader?.obsmKeys) ? this._loader.obsmKeys : [];
    if (!this._metadata || obsmKeys.length === 0) return;

    const getShapeDims = async (key) => {
      if (typeof this._loader.getEmbeddingShape !== 'function') return null;
      try {
        const shapeMaybe = this._loader.getEmbeddingShape(key);
        const shapeInfo = typeof shapeMaybe?.then === 'function' ? await shapeMaybe : shapeMaybe;
        const nDims = shapeInfo?.nDims;
        return Number.isInteger(nDims) ? nDims : null;
      } catch (_err) {
        return null;
      }
    };

    const isEmbeddingKey = (key) => String(key || '').startsWith('X_');
    const isUmapKey = (key) => String(key || '').endsWith('_umap');

    const fields = new Map(); // fieldId -> { dims: Set<number>, explicit: Set<number>, keysByDim: Record<string, string> }
    const ensureField = (id) => {
      const key = String(id || '');
      if (!fields.has(key)) {
        fields.set(key, { dims: new Set(), explicit: new Set(), keysByDim: {} });
      }
      return fields.get(key);
    };

    // 1) Explicit per-dimension keys: <field>_umap_<dim>d
    for (const key of obsmKeys) {
      const match = String(key).match(/^(.*)_([123])d$/);
      if (!match) continue;
      const baseId = match[1];
      const dim = Number.parseInt(match[2], 10);
      if (!Number.isInteger(dim) || dim < 1 || dim > 3) continue;
      if (!isUmapKey(baseId) || isEmbeddingKey(baseId)) continue;

      const nDims = await getShapeDims(key);
      if (nDims !== null && nDims !== dim) continue;

      const entry = ensureField(baseId);
      entry.keysByDim[`${dim}d`] = key;
      entry.dims.add(dim);
      entry.explicit.add(dim);
    }

    // 2) Implicit key: <field>_umap (shape-derived), only if explicit is missing.
    for (const key of obsmKeys) {
      const baseId = String(key);
      if (!isUmapKey(baseId) || isEmbeddingKey(baseId)) continue;
      // Skip explicit keys already handled above.
      if (baseId.match(/_([123])d$/)) continue;

      const nDims = await getShapeDims(baseId);
      if (!Number.isInteger(nDims) || nDims < 1 || nDims > 3) continue;

      const entry = ensureField(baseId);
      if (entry.explicit.has(nDims)) continue; // clash-safe

      const slot = `${nDims}d`;
      if (!entry.keysByDim[slot]) {
        entry.keysByDim[slot] = baseId;
        entry.dims.add(nDims);
      }
    }

    const buildLabel = (fieldId) => {
      const id = String(fieldId || '');
      if (!id) return '';
      const base = id.endsWith('_umap') ? id.slice(0, -5) : id;
      const pretty = base.replace(/_/g, ' ').trim();
      const titled = pretty ? (pretty[0].toUpperCase() + pretty.slice(1)) : id;
      return id.endsWith('_umap') ? `${titled} (UMAP)` : titled;
    };

    const fieldsObj = {};
    for (const [id, entry] of fields.entries()) {
      const dims = Array.from(entry.dims).sort((a, b) => a - b);
      if (!dims.length) continue;
      fieldsObj[id] = {
        label: buildLabel(id),
        basis: 'umap',
        available_dimensions: dims,
        default_dimension: Math.max(...dims),
        obsm_keys: entry.keysByDim,
      };
    }

    const ids = Object.keys(fieldsObj);
    if (!ids.length) return;

    const defaultField = fieldsObj.velocity_umap ? 'velocity_umap' : ids[0];

    this._metadata.vector_fields = {
      default_field: defaultField,
      fields: fieldsObj,
    };
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
        // Prefer checking shape metadata (cheap) to avoid loading full arrays when mismatched.
        if (typeof this._loader.getEmbeddingShape === 'function') {
          const shapeMaybePromise = this._loader.getEmbeddingShape('X_umap');
          const shapeInfo = typeof shapeMaybePromise?.then === 'function'
            ? await shapeMaybePromise
            : shapeMaybePromise;
          const nDims = shapeInfo?.nDims;
          if (typeof nDims === 'number' && nDims !== dim) {
            throw new Error(`No ${dim}D embedding found (X_umap is ${nDims}D)`);
          }
        }
        embKey = 'X_umap';
      } else {
        throw new Error(`No ${dim}D embedding found`);
      }
    }

    const emb = await this._loader.getEmbedding(embKey);

    // Verify dimension (X_umap must match the requested dimension)
    if (emb.nDims !== dim) {
      throw new Error(`Embedding '${embKey}' has ${emb.nDims} dimensions, expected ${dim}`);
    }

    // Normalize to [-1, 1] range
    const normalized = this._normalizeEmbedding(emb.data, emb.nDims, dim);

    this._embeddingCache.set(dim, normalized);
    return normalized;
  }

  /**
   * Get per-cell displacement vectors for a vector field in `obsm`.
   *
   * Returns a flat Float32Array with `dim` components per cell, scaled by the
   * same normalization scale as the embedding (so vectors live in the same
   * normalized coordinate space as positions).
   *
   * The fieldId should match a `vector_fields.fields` key in dataset identity
   * (e.g. `velocity_umap`, `T_fwd_umap`).
   *
   * @param {string} fieldId
   * @param {number} dim
   * @returns {Promise<Float32Array>}
   */
  async getVectorField(fieldId, dim) {
    const id = String(fieldId || '');
    const d = Math.max(1, Math.min(3, Math.floor(dim || 3)));
    if (!id) {
      throw new Error('BaseAnnDataAdapter.getVectorField: fieldId is required');
    }

    let perField = this._vectorFieldCache.get(id);
    if (!perField) {
      perField = new Map();
      this._vectorFieldCache.set(id, perField);
    }
    if (perField.has(d)) return perField.get(d);

    // Ensure we have the embedding scale for this dimension.
    if (!this._normInfo.has(d)) {
      await this.getEmbedding(d);
    }
    const scale = Number(this._normInfo.get(d)?.scale) || 1;

    const obsmKeys = Array.isArray(this._loader?.obsmKeys) ? this._loader.obsmKeys : [];

    const metaEntry = this._metadata?.vector_fields?.fields?.[id] || null;
    const keyFromMeta = metaEntry?.obsm_keys?.[`${d}d`] || metaEntry?.obsm_keys?.[String(d)] || null;

    const resolveKey = async () => {
      if (keyFromMeta && obsmKeys.includes(keyFromMeta)) return keyFromMeta;

      // Explicit: <field>_<dim>d
      const explicit = `${id}_${d}d`;
      if (obsmKeys.includes(explicit)) return explicit;

      // Implicit: <field> (shape-derived)
      if (!obsmKeys.includes(id)) return null;
      if (typeof this._loader.getEmbeddingShape === 'function') {
        const shapeMaybe = this._loader.getEmbeddingShape(id);
        const shapeInfo = typeof shapeMaybe?.then === 'function' ? await shapeMaybe : shapeMaybe;
        const nDims = shapeInfo?.nDims;
        if (Number.isInteger(nDims) && nDims === d) return id;
        return null;
      }
      // Without shape metadata, load and validate.
      return id;
    };

    const key = await resolveKey();
    if (!key) {
      throw new Error(`No ${d}D vector field found for "${id}" in obsm`);
    }

    const vel = await this._loader.getEmbedding(key);
    if (vel?.nDims !== d) {
      throw new Error(`Vector field '${key}' has ${vel?.nDims} dimensions, expected ${d}`);
    }

    const raw = vel?.data;
    const data = raw instanceof Float32Array ? raw : new Float32Array(raw);
    const len = data.length;
    for (let i = 0; i < len; i++) {
      const v = data[i];
      data[i] = Number.isFinite(v) ? v * scale : 0;
    }

    perField.set(d, data);
    return data;
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
    this._vectorFieldCache.clear();
    this._obsFieldsMetadata = null;
    this._obsFieldDataCache.clear();
    this._connectivityCache = undefined;
    this._normInfo.clear();
  }
}
