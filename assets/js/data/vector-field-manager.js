/**
 * @fileoverview Vector field loader/normalizer (dimension-specific).
 *
 * Vector fields are per-cell displacement vectors in an embedding space (e.g.
 * scVelo velocity or CellRank drift vectors derived from transition matrices).
 *
 * Coordinate-space contract
 * -------------------------
 * Cellucid’s embedding positions go through two normalization stages:
 * 1) Export/adapters often normalize embeddings into a stable [-1, 1] range.
 * 2) The frontend DimensionManager normalizes again after padding to 3D.
 *
 * For visual correctness, vector fields MUST be expressed in the same coordinate
 * space as the embedding positions *before* the frontend's second normalization.
 * This manager then multiplies vectors by the DimensionManager's per-dimension
 * normalization scale so the final vectors live in the exact render space.
 *
 * Data sources supported (matches Cellucid's 14 loading options):
 * - Prepared exports / server-backed exports: `dataset_identity.json` provides `vector_fields.fields[*].files`
 * - Direct browser AnnData (h5ad / zarr): adapter exposes `getVectorField(fieldId, dim)`
 *
 * @module data/vector-field-manager
 */

import { loadPointsBinary } from './data-loaders.js';
import { getAnnDataAdapter, isAnnDataActive } from './anndata-provider.js';

/**
 * @typedef {object} VectorFieldEntry
 * @property {string} [label]
 * @property {string} [basis]
 * @property {number[]} [available_dimensions]
 * @property {number} [default_dimension]
 * @property {{ [key: string]: string }} [files] - For prepared exports: { "2d": "vectors/velocity_umap_2d.bin.gz", ... }
 * @property {{ [key: string]: number }} [components] - Optional override: { "2d": 2, "3d": 3 }
 */

/**
 * @typedef {object} VectorFieldsMetadata
 * @property {string} [default_field]
 * @property {{ [fieldId: string]: VectorFieldEntry }} [fields]
 */

export function createVectorFieldManager(options = {}) {
  return new VectorFieldManager(options);
}

export class VectorFieldManager {
  constructor({ baseUrl = '', vectorFieldsMetadata = null, dimensionManager = null } = {}) {
    this.baseUrl = baseUrl || '';
    this.dimensionManager = dimensionManager || null;

    /** @type {VectorFieldsMetadata|null} */
    this._meta = vectorFieldsMetadata && typeof vectorFieldsMetadata === 'object'
      ? vectorFieldsMetadata
      : null;

    /** @type {Map<string, VectorFieldEntry>} */
    this._fields = new Map();

    /** @type {string|null} */
    this._defaultField = null;

    /** @type {Map<string, Map<number, Promise<any>>>} */
    this._loading = new Map(); // fieldId -> (dim -> promise)

    this._ingestMetadata(this._meta);
  }

  setBaseUrl(url) {
    this.baseUrl = url || '';
  }

  setMetadata(meta) {
    this._meta = meta && typeof meta === 'object' ? meta : null;
    this._fields.clear();
    this._defaultField = null;
    this._loading.clear();
    this._ingestMetadata(this._meta);
  }

  hasAny() {
    return this._fields.size > 0;
  }

  getDefaultFieldId() {
    return this._defaultField;
  }

  /**
   * @returns {{ id: string, label: string, availableDimensions: number[], defaultDimension: number }[]}
   */
  getAvailableFields() {
    const result = [];
    for (const [id, entry] of this._fields.entries()) {
      const dims = Array.isArray(entry?.available_dimensions)
        ? entry.available_dimensions.filter((d) => Number.isInteger(d) && d >= 1 && d <= 3)
        : [];
      const defaultDim = Number.isInteger(entry?.default_dimension) ? entry.default_dimension : (dims[dims.length - 1] || 3);
      result.push({
        id,
        label: String(entry?.label || id),
        availableDimensions: dims,
        defaultDimension: Math.max(1, Math.min(3, Math.floor(defaultDim || 3)))
      });
    }
    // Stable ordering: default first, then alpha.
    const defaultId = this._defaultField;
    result.sort((a, b) => {
      if (defaultId && a.id === defaultId) return -1;
      if (defaultId && b.id === defaultId) return 1;
      return a.label.localeCompare(b.label);
    });
    return result;
  }

  hasField(fieldId) {
    return this._fields.has(String(fieldId || ''));
  }

  hasFieldDimension(fieldId, dim) {
    const entry = this._fields.get(String(fieldId || '')) || null;
    if (!entry) return false;
    const d = Math.max(1, Math.min(3, Math.floor(dim || 3)));
    const dims = Array.isArray(entry.available_dimensions) ? entry.available_dimensions : [];
    return dims.includes(d);
  }

  /**
   * Load vectors for a field + dimension and scale them into the final render space.
   *
   * Returned vectors are shaped as a flat Float32Array:
   * - components=1: [vx0, vx1, ...]
   * - components=2: [vx0, vy0, vx1, vy1, ...]
   * - components=3: [vx0, vy0, vz0, vx1, vy1, vz1, ...]
   *
   * @param {string} fieldId
   * @param {number} dim
   * @param {{ showProgress?: boolean }} [options]
   * @returns {Promise<{ vectors: Float32Array, components: 1|2|3, cellCount: number, maxMagnitude: number }>}
   */
  async loadField(fieldId, dim, options = {}) {
    const id = String(fieldId || '');
    const entry = this._fields.get(id) || null;
    if (!entry) {
      throw new Error(`VectorFieldManager.loadField: unknown field "${id}"`);
    }

    const d = Math.max(1, Math.min(3, Math.floor(dim || 3)));
    if (!this.dimensionManager) {
      throw new Error('VectorFieldManager.loadField: missing dimensionManager');
    }

    let perField = this._loading.get(id);
    if (!perField) {
      perField = new Map();
      this._loading.set(id, perField);
    }
    if (perField.has(d)) return perField.get(d);

    const showProgress = options.showProgress !== false;

    const promise = (async () => {
      // Ensure the dimension manager has computed the normalization scale for this dimension.
      const positions3D = await this.dimensionManager.getPositions3D(d);
      const cellCount = Math.floor((positions3D?.length || 0) / 3);
      if (cellCount <= 0) {
        throw new Error('VectorFieldManager.loadField: positions not loaded');
      }

      const transform = typeof this.dimensionManager.getNormTransform === 'function'
        ? this.dimensionManager.getNormTransform(d)
        : null;
      const scale = Number(transform?.scale) || 1;

      /** @type {1|2|3} */
      let components = (entry?.components && typeof entry.components === 'object')
        ? (Number(entry.components[`${d}d`]) || Number(entry.components[String(d)]) || d)
        : d;
      components = (components === 1 || components === 2 || components === 3) ? components : d;

      let vectors = null;

      if (isAnnDataActive()) {
        const adapter = getAnnDataAdapter();
        if (!adapter || typeof adapter.getVectorField !== 'function') {
          throw new Error('VectorFieldManager.loadField: active AnnData adapter does not support getVectorField()');
        }
        // Clone to avoid mutating adapter caches when applying DimensionManager scaling/sanitization.
        vectors = new Float32Array(await adapter.getVectorField(id, d));
        components = d;
      } else {
        const files = entry?.files || null;
        const filename = files?.[`${d}d`] || files?.[String(d)] || null;
        if (!filename) {
          throw new Error(`VectorFieldManager.loadField: files missing entry for "${id}" ${d}d`);
        }
        const url = this.baseUrl.endsWith('/') ? `${this.baseUrl}${filename}` : `${this.baseUrl}/${filename}`;
        vectors = await loadPointsBinary(url, {
          showProgress,
          displayName: `${d}D vector field`,
          dimension: d
        });
      }

      if (!(vectors instanceof Float32Array)) {
        throw new Error('VectorFieldManager.loadField: expected Float32Array');
      }
      const expected = cellCount * components;
      if (vectors.length !== expected) {
        throw new Error(`VectorFieldManager.loadField: vectors length ${vectors.length} !== expected ${expected}`);
      }

      // Scale into the final render space (translation doesn't apply to vectors).
      let maxMag = 0;
      const stride = components;
      if (scale !== 1) {
        for (let i = 0; i < cellCount; i++) {
          const base = i * stride;
          let sumSq = 0;
          for (let c = 0; c < stride; c++) {
            const v = vectors[base + c];
            const scaled = Number.isFinite(v) ? v * scale : 0;
            vectors[base + c] = scaled;
            sumSq += scaled * scaled;
          }
          const mag = Math.sqrt(sumSq);
          if (mag > maxMag) maxMag = mag;
        }
      } else {
        for (let i = 0; i < cellCount; i++) {
          const base = i * stride;
          let sumSq = 0;
          for (let c = 0; c < stride; c++) {
            const v = vectors[base + c];
            const safe = Number.isFinite(v) ? v : 0;
            if (!Number.isFinite(v)) vectors[base + c] = 0;
            sumSq += safe * safe;
          }
          const mag = Math.sqrt(sumSq);
          if (mag > maxMag) maxMag = mag;
        }
      }

      if (!Number.isFinite(maxMag) || maxMag <= 0) maxMag = 1;

      return {
        vectors,
        components,
        cellCount,
        maxMagnitude: maxMag
      };
    })();

    perField.set(d, promise);
    try {
      return await promise;
    } finally {
      perField.delete(d);
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  _ingestMetadata(meta) {
    const fieldsObj = meta?.fields;
    if (!fieldsObj || typeof fieldsObj !== 'object') return;

    for (const [id, entry] of Object.entries(fieldsObj)) {
      if (!id || !entry || typeof entry !== 'object') continue;

      const dims = Array.isArray(entry.available_dimensions)
        ? entry.available_dimensions.filter((d) => Number.isInteger(d) && d >= 1 && d <= 3)
        : [];
      if (dims.length === 0) continue;

      this._fields.set(String(id), /** @type {VectorFieldEntry} */ (entry));
    }

    const defaultField = meta?.default_field;
    if (defaultField && this._fields.has(String(defaultField))) {
      this._defaultField = String(defaultField);
    } else {
      // Prefer velocity_umap if present, otherwise first by insertion order.
      if (this._fields.has('velocity_umap')) this._defaultField = 'velocity_umap';
      else this._defaultField = this._fields.size ? this._fields.keys().next().value : null;
    }
  }
}
