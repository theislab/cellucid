/**
 * @fileoverview Exact vector-field loader for layout-bound displacement data.
 *
 * A vector field is bound to embeddings: one payload per layout (embedding)
 * the field is bound to. The data mapping says which bindings are in use
 * (`resolveVectorFields`); each is read from the AnnData file through the
 * route `vectors/...` of its binding. The reader worker
 * scales the vectors by the transform of the embedding they are bound to, so
 * they inhabit the same render space as its positions, and reports the
 * largest magnitude. Metadata, bindings, file mappings, and
 * numerical payloads are never inferred, coerced, repaired, or substituted.
 *
 * @module data/vector-field-manager
 */

import {
  anndataLoadVectors,
  getActiveAnnDataBinding,
  isAnnDataUrl,
} from './anndata-provider.js';
import { ANNDATA_KIND } from './data-mapping.js';
import { resolveVectorBinding } from './data-mapping-candidates.js';
import { markProvenFiniteFloat32Array } from '../rendering/position-layout.js';
import { isPlainRecord, requireKeys } from '../utils/exact-record.js';
import { formatCountOf } from '../utils/format-units.js';
import { cellsSteady, trackCellWork } from './open-cells-work.js';

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

/**
 * The vector fields a data mapping uses, in the runtime shape the manager
 * takes: field id -> `{label, files: {layoutKey: path}}`.
 *
 * Each binding of the mapping is read through its mapping route; the keys of
 * one field on every basis are one field (`velocity_umap` and
 * `velocity_umap_3d` are `velocity`, `vectorFieldIdOf`). The bound embedding's
 * layout is the one the dimension manager registers for it.
 *
 * A binding that cannot be drawn throws a RangeError naming it.
 *
 * The default field is the one the dataset opens with (`defaultField`, a
 * launch's `vectorFieldDefault`, the identity's `vector_field_default`) when
 * the mapping draws it, else the only field.
 *
 * @param {{mapping: Object, candidates: Object, dimensionManager: Object, defaultField?: string|null}} options
 * @returns {Readonly<{defaultField: string|null, fields: Map<string, Object>}>}
 */
export function resolveVectorFields({ mapping, candidates, dimensionManager, defaultField = null }) {
  if (mapping.kind !== ANNDATA_KIND) {
    throw new TypeError('Vector fields are resolved from an AnnData data mapping.');
  }
  const byField = new Map();
  for (const binding of mapping.vectorFields) {
    const resolved = resolveVectorBinding(candidates, binding);
    if (!resolved.ok) {
      throw new RangeError(`Vector field obsm['${binding.key}'] cannot be drawn: ${resolved.reason}.`);
    }
    const layoutKey = dimensionManager.resolveProvenanceLayout(
      binding.embedding.key,
      [...binding.embedding.columns]
    );
    if (layoutKey === null) {
      throw new RangeError(
        `Vector field obsm['${binding.key}'] is bound to obsm['${binding.embedding.key}'], which cannot be plotted.`
      );
    }
    let files = byField.get(resolved.fieldId);
    if (files === undefined) {
      files = {};
      byField.set(resolved.fieldId, files);
    }
    if (Object.hasOwn(files, layoutKey)) {
      throw new RangeError(
        `Two vector arrays are the vector field "${resolved.fieldId}" of ${layoutKey}; bind only one.`
      );
    }
    files[layoutKey] = resolved.path;
  }
  const fields = new Map(
    [...byField].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([fieldId, files]) => [fieldId, Object.freeze({ label: fieldId, files: Object.freeze(files) })])
  );
  return Object.freeze({
    defaultField: defaultField !== null && fields.has(defaultField)
      ? defaultField
      : (fields.size === 1 ? [...fields.keys()][0] : null),
    fields,
  });
}

function requireManagerOptions(options) {
  requireKeys(
    options,
    ['baseUrl', 'vectorFields', 'dimensionManager'],
    [],
    'VectorFieldManager options'
  );
  const baseUrl = requireNonEmptyString(options.baseUrl, 'VectorFieldManager baseUrl');
  if (!baseUrl.endsWith('/')) {
    throw new TypeError(
      'VectorFieldManager baseUrl must be an explicit directory URL ending in "/".'
    );
  }
  const dimensionManager = options.dimensionManager;
  if (
    dimensionManager === null ||
    typeof dimensionManager !== 'object' ||
    typeof dimensionManager.getPositions !== 'function' ||
    typeof dimensionManager.getNormTransform !== 'function' ||
    typeof dimensionManager.getLayout !== 'function' ||
    typeof dimensionManager.hasLayout !== 'function'
  ) {
    throw new TypeError(
      'VectorFieldManager dimensionManager must provide getPositions(), getNormTransform(), getLayout(), and hasLayout().'
    );
  }
  const vectorFields = options.vectorFields;
  if (
    !isPlainRecord(vectorFields) ||
    !(vectorFields.fields instanceof Map) ||
    (vectorFields.defaultField !== null && !vectorFields.fields.has(vectorFields.defaultField))
  ) {
    throw new TypeError('VectorFieldManager vectorFields must come from resolveVectorFields().');
  }
  return {
    baseUrl,
    dimensionManager,
    metadata: vectorFields,
  };
}

export function createVectorFieldManager(options) {
  return new VectorFieldManager(options);
}

export class VectorFieldManager {
  constructor(options) {
    const parsed = requireManagerOptions(options);
    this.baseUrl = parsed.baseUrl;
    this.dimensionManager = parsed.dimensionManager;
    this._fields = parsed.metadata.fields;
    this._defaultField = parsed.metadata.defaultField;

    // Each payload belongs to the layout of the embedding it is bound to:
    // fieldId -> layoutKey -> dimension. An embedding id is the layout key of
    // that embedding, and every declared embedding is a registered layout.
    /** @type {Map<string, Map<string, number>>} */
    this._bindings = new Map();
    for (const [fieldId, entry] of this._fields) {
      const bound = new Map();
      for (const layoutKey of Object.keys(entry.files)) {
        if (!this.dimensionManager.hasLayout(layoutKey)) {
          throw new Error(
            `Vector field "${fieldId}" is bound to embedding "${layoutKey}", ` +
            'which the dimension manager has not registered.'
          );
        }
        bound.set(layoutKey, this.dimensionManager.getLayout(layoutKey).dimension);
      }
      this._bindings.set(fieldId, bound);
    }

    /**
     * Loads under way, by field and layout, with the open cell count each
     * reads for: a load is shared only by callers of the same cells.
     * @type {Map<string, Map<string, {cells: number, promise: Promise<object>}>>}
     */
    this._loading = new Map();

    /** Owns every download this manager starts; aborted by dispose(). */
    this._lifetime = new AbortController();
  }

  /**
   * Retire this manager: its dataset was replaced, so any vector payload
   * still downloading is aborted rather than finished for nobody.
   */
  dispose() {
    this._lifetime.abort(
      new DOMException('The vector-field manager was replaced.', 'AbortError')
    );
  }

  hasAny() {
    return this._fields.size > 0;
  }

  getDefaultFieldId() {
    return this._defaultField;
  }

  /**
   * One descriptor per field. `layoutKeys` are the embeddings the field is
   * bound to, in embedding order: a field is drawn only in a view showing one
   * of them, and each one's dimension is that embedding's.
   *
   * @returns {{ id: string, label: string, layoutKeys: string[] }[]}
   */
  getAvailableFields() {
    const result = [];
    for (const [id, entry] of this._fields.entries()) {
      const bound = this._bindings.get(id);
      result.push(Object.freeze({
        id,
        label: entry.label,
        layoutKeys: Object.freeze([...bound.keys()]),
      }));
    }
    const defaultId = this._defaultField;
    result.sort((a, b) => {
      if (defaultId !== null && a.id === defaultId) return -1;
      if (defaultId !== null && b.id === defaultId) return 1;
      if (a.label < b.label) return -1;
      if (a.label > b.label) return 1;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    return result;
  }

  hasField(fieldId) {
    return this._fields.has(
      requireNonEmptyString(fieldId, 'VectorFieldManager fieldId')
    );
  }

  hasFieldLayout(fieldId, layoutKey) {
    const id = requireNonEmptyString(fieldId, 'VectorFieldManager fieldId');
    const key = requireNonEmptyString(layoutKey, 'VectorFieldManager layoutKey');
    const bound = this._bindings.get(id);
    return bound !== undefined && bound.has(key);
  }

  /**
   * Load vectors for an exact field and bound layout, then apply that
   * layout's normalization scale. The returned buffer always has the
   * layout's dimension of components per cell.
   *
   * @param {string} fieldId
   * @param {string} layoutKey
   * @returns {Promise<{ vectors: Float32Array, components: 1|2|3, cellCount: number, maxMagnitude: number }>}
   */
  async loadField(fieldId, layoutKey) {
    const id = requireNonEmptyString(
      fieldId,
      'VectorFieldManager fieldId'
    );
    const key = requireNonEmptyString(
      layoutKey,
      'VectorFieldManager layoutKey'
    );
    // The open cells being changed in place: read for the cells after it
    // (`open-cells-work.js`).
    const steady = cellsSteady();
    if (steady !== null) await steady;
    if (this._lifetime.signal.aborted) throw this._lifetime.signal.reason;
    const entry = this._fields.get(id);
    if (entry === undefined) {
      throw new Error(`VectorFieldManager.loadField: unknown field "${id}".`);
    }
    const dim = this._bindings.get(id).get(key);
    if (dim === undefined) {
      throw new Error(
        `VectorFieldManager.loadField: field "${id}" declares no data for layout "${key}".`
      );
    }

    let perField = this._loading.get(id);
    if (perField === undefined) {
      perField = new Map();
      this._loading.set(id, perField);
    }
    const cells = this.dimensionManager.nCells;
    const activeLoad = perField.get(key);
    if (activeLoad !== undefined && activeLoad.cells === cells) {
      return activeLoad.promise;
    }

    const promise = trackCellWork(this._loadExactField(id, entry, key, dim));
    const own = { cells, promise };
    perField.set(key, own);
    try {
      return await promise;
    } finally {
      if (perField.get(key) === own) perField.delete(key);
      if (perField.size === 0 && this._loading.get(id) === perField) {
        this._loading.delete(id);
      }
    }
  }

  async _loadExactField(id, entry, layoutKey, dimension) {
    const filename = entry.files[layoutKey];
    if (!isAnnDataUrl(this.baseUrl)) {
      throw new TypeError('VectorFieldManager reads an AnnData dataset by its anndata:// base.');
    }
    // An anndata:// dataset id is not a URL host, so the payload
    // path is resolved textually; its adapter answers the mapping route.
    // The positions and the vectors are asked for together: the reader
    // worker reads both at once and scales the vectors by the embedding's
    // transform as it reads them.
    const binding = getActiveAnnDataBinding(this.baseUrl);
    const [positions, payload] = await Promise.all([
      this.dimensionManager.getPositions(layoutKey),
      anndataLoadVectors(
        `${this.baseUrl}${filename}`,
        dimension,
        { signal: this._lifetime.signal }
      ),
    ]);
    const currentBinding = getActiveAnnDataBinding(this.baseUrl);
    if (
      currentBinding.adapter !== binding.adapter ||
      currentBinding.source !== binding.source
    ) {
      // Read for a dataset (or open cells) no longer shown: superseded.
      throw new DOMException(
        `The vector field "${id}" was read for a dataset no longer shown.`,
        'AbortError'
      );
    }
    if (
      !(positions instanceof Float32Array) ||
      positions.length === 0 ||
      positions.length % dimension !== 0
    ) {
      throw new Error(
        `VectorFieldManager.loadField: getPositions() must return a non-empty Float32Array with ${formatCountOf(dimension, 'component')} per cell.`
      );
    }
    const cellCount = positions.length / dimension;
    const { vectors, maxMagnitude } = payload ?? {};
    if (!(vectors instanceof Float32Array)) {
      throw new Error(
        'VectorFieldManager.loadField: an AnnData vector payload must be a Float32Array.'
      );
    }
    const expectedLength = cellCount * dimension;
    if (vectors.length !== expectedLength) {
      throw new Error(
        `VectorFieldManager.loadField: vectors length ${vectors.length} does not equal expected length ${expectedLength}.`
      );
    }
    if (!Number.isFinite(maxMagnitude) || maxMagnitude < 0) {
      throw new Error(
        `VectorFieldManager.loadField: field "${id}" must carry a finite non-negative largest magnitude.`
      );
    }
    // Checked finite and scaled where it was read; shared read-only with the
    // adapter's cache.
    markProvenFiniteFloat32Array(vectors);

    return Object.freeze({
      vectors,
      components: dimension,
      cellCount,
      maxMagnitude,
    });
  }
}
