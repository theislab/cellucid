/**
 * @fileoverview Exact vector-field loader for layout-bound displacement data.
 *
 * A vector field is bound to embeddings: one payload per layout (embedding)
 * the field is bound to. The data mapping says which bindings are in use
 * (`resolveVectorFields`): a prepared export's are the payloads its dataset
 * identity declares, an AnnData file's are read through the mapping route
 * `_cellucid/mapping/vectors/...` of each binding. Vector values are scaled by
 * the bound layout's DimensionManager normalization scale so they inhabit the
 * same render space as its positions. Metadata, bindings, file mappings, and
 * numerical payloads are never inferred, coerced, repaired, or substituted.
 *
 * @module data/vector-field-manager
 */

import { loadPointsBinary } from './data-loaders.js';
import {
  anndataLoadVectors,
  getActiveAnnDataBinding,
  isAnnDataUrl,
} from './anndata-provider.js';
import {
  identityPayloadCompression,
  resolveUrl,
  validateVectorFieldsMetadata,
} from './data-source.js';
import { ANNDATA_KIND } from './data-mapping.js';
import { resolveVectorBinding } from './data-mapping-candidates.js';

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, requiredKeys, optionalKeys, label) {
  if (!isPlainRecord(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label} contains unsupported key "${key}".`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${label} must declare "${key}".`);
    }
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

/**
 * Freeze one identity's `vector_fields` into the runtime shape.
 *
 * The rule itself lives in exactly one place — validateVectorFieldsMetadata()
 * in data-source.js — so the runtime manager, the hosted-catalog reader, and
 * the local prepared-export reader cannot disagree about what a vector field
 * is. A prepared export's vector fields are read from these `files`.
 *
 * @param {Object} identity - A dataset identity (version 3).
 * @returns {Readonly<{defaultField: string|null, fields: Map<string, Object>}>}
 */
function identityVectorFields(identity) {
  if (
    !isPlainRecord(identity) ||
    !isPlainRecord(identity.embeddings) ||
    !isPlainRecord(identity.embeddings.items)
  ) {
    throw new TypeError(
      'VectorFieldManager identity must be a dataset identity with embedding items.'
    );
  }
  if (!Object.hasOwn(identity, 'vector_fields')) {
    return Object.freeze({
      defaultField: null,
      fields: new Map(),
    });
  }
  const value = identity.vector_fields;
  validateVectorFieldsMetadata(value, {
    embeddingItems: identity.embeddings.items,
    compression: identityPayloadCompression(identity),
    sourceType: 'vector-field-manager',
  });

  const fields = new Map();
  for (const [fieldId, field] of Object.entries(value.fields)) {
    fields.set(fieldId, Object.freeze({
      label: field.label,
      files: Object.freeze({ ...field.files }),
    }));
  }

  return Object.freeze({
    defaultField: value.default_field,
    fields,
  });
}

/**
 * The vector fields a data mapping uses, in the runtime shape the manager
 * takes: field id -> `{label, files: {layoutKey: path}}`.
 *
 * - A prepared export uses the bindings of its dataset identity that the
 *   mapping lists.
 * - An AnnData file uses each binding of the mapping, read through its
 *   mapping route; `<field>_umap_<d>d` keys of every dimension are one field
 *   (`vectorFieldIdOf`). The bound embedding's layout is the one the
 *   dimension manager registers for it.
 *
 * A binding that cannot be drawn throws a RangeError naming it.
 *
 * @param {{identity: Object, mapping: Object, candidates: Object|null, dimensionManager: Object}} options
 * @returns {Readonly<{defaultField: string|null, fields: Map<string, Object>}>}
 */
export function resolveVectorFields({ identity, mapping, candidates, dimensionManager }) {
  if (mapping.kind !== ANNDATA_KIND) {
    const declared = identityVectorFields(identity);
    const used = new Set(
      mapping.vectorFields.map(binding => JSON.stringify([binding.field, binding.embedding.key]))
    );
    const fields = new Map();
    for (const [fieldId, entry] of declared.fields) {
      const files = Object.fromEntries(
        Object.entries(entry.files).filter(([layoutKey]) => used.has(JSON.stringify([fieldId, layoutKey])))
      );
      if (Object.keys(files).length > 0) {
        fields.set(fieldId, Object.freeze({ label: entry.label, files: Object.freeze(files) }));
      }
    }
    return Object.freeze({
      defaultField: fields.has(declared.defaultField) ? declared.defaultField : null,
      fields,
    });
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
    defaultField: fields.size === 1 ? [...fields.keys()][0] : null,
    fields,
  });
}

function requireManagerOptions(options) {
  requireExactKeys(
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

function requireLoadOptions(options) {
  requireExactKeys(options, ['showProgress'], [], 'VectorFieldManager load options');
  if (typeof options.showProgress !== 'boolean') {
    throw new TypeError(
      'VectorFieldManager load options.showProgress must be a boolean.'
    );
  }
  return options.showProgress;
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

    /** @type {Map<string, Map<string, Promise<object>>>} */
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
   * @param {{ showProgress: boolean }} options
   * @returns {Promise<{ vectors: Float32Array, components: 1|2|3, cellCount: number, maxMagnitude: number }>}
   */
  async loadField(fieldId, layoutKey, options) {
    const id = requireNonEmptyString(
      fieldId,
      'VectorFieldManager fieldId'
    );
    const key = requireNonEmptyString(
      layoutKey,
      'VectorFieldManager layoutKey'
    );
    const showProgress = requireLoadOptions(options);
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
    const activeLoad = perField.get(key);
    if (activeLoad !== undefined) {
      return activeLoad;
    }

    const promise = this._loadExactField(id, entry, key, dim, showProgress);
    perField.set(key, promise);
    try {
      return await promise;
    } finally {
      perField.delete(key);
      if (perField.size === 0) {
        this._loading.delete(id);
      }
    }
  }

  async _loadExactField(id, entry, layoutKey, dimension, showProgress) {
    const positions = await this.dimensionManager.getPositions(layoutKey);
    if (
      !(positions instanceof Float32Array) ||
      positions.length === 0 ||
      positions.length % dimension !== 0
    ) {
      throw new Error(
        `VectorFieldManager.loadField: getPositions() must return a non-empty Float32Array with ${dimension} components per cell.`
      );
    }
    const cellCount = positions.length / dimension;

    const transform = this.dimensionManager.getNormTransform(layoutKey);
    if (
      !isPlainRecord(transform) ||
      !Object.hasOwn(transform, 'scale') ||
      typeof transform.scale !== 'number' ||
      !Number.isFinite(transform.scale) ||
      transform.scale <= 0
    ) {
      throw new Error(
        `VectorFieldManager.loadField: ${dimension}D normalization scale must be a finite positive number.`
      );
    }
    const scale = transform.scale;

    const filename = entry.files[layoutKey];
    let vectors;
    if (isAnnDataUrl(this.baseUrl)) {
      // An h5ad:// or zarr:// dataset id is not a URL host, so the payload
      // path is resolved textually; its adapter answers the mapping route.
      const binding = getActiveAnnDataBinding(this.baseUrl);
      const adapterVectors = await anndataLoadVectors(`${this.baseUrl}${filename}`, dimension);
      const currentBinding = getActiveAnnDataBinding(this.baseUrl);
      if (
        currentBinding.adapter !== binding.adapter ||
        currentBinding.source !== binding.source
      ) {
        throw new Error(
          `VectorFieldManager.loadField: direct AnnData ownership changed while loading field "${id}".`
        );
      }
      if (!(adapterVectors instanceof Float32Array)) {
        throw new Error(
          'VectorFieldManager.loadField: an AnnData vector payload must be a Float32Array.'
        );
      }
      vectors = new Float32Array(adapterVectors);
    } else {
      vectors = await loadPointsBinary(
        resolveUrl(this.baseUrl, filename),
        {
          showProgress,
          displayName: `${dimension}D vector field`,
          dimension,
          expectedBytes:
            cellCount * dimension * Float32Array.BYTES_PER_ELEMENT,
          signal: this._lifetime.signal,
          progressTrackerId: null,
        }
      );
    }

    if (!(vectors instanceof Float32Array)) {
      throw new Error(
        'VectorFieldManager.loadField: vector payload must be Float32Array.'
      );
    }
    const expectedLength = cellCount * dimension;
    if (vectors.length !== expectedLength) {
      throw new Error(
        `VectorFieldManager.loadField: vectors length ${vectors.length} does not equal expected length ${expectedLength}.`
      );
    }

    let maxMagnitudeSquared = 0;
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      const offset = cellIndex * dimension;
      let magnitudeSquared = 0;
      for (let component = 0; component < dimension; component++) {
        const value = vectors[offset + component];
        if (!Number.isFinite(value)) {
          throw new Error(
            `VectorFieldManager.loadField: field "${id}" contains a non-finite value at cell ${cellIndex}, component ${component}.`
          );
        }
        vectors[offset + component] = value * scale;
        const scaled = vectors[offset + component];
        if (!Number.isFinite(scaled)) {
          throw new Error(
            `VectorFieldManager.loadField: scaling field "${id}" overflowed at cell ${cellIndex}, component ${component}.`
          );
        }
        magnitudeSquared += scaled * scaled;
      }
      if (!Number.isFinite(magnitudeSquared)) {
        throw new Error(
          `VectorFieldManager.loadField: field "${id}" produced a non-finite magnitude at cell ${cellIndex}.`
        );
      }
      if (magnitudeSquared > maxMagnitudeSquared) {
        maxMagnitudeSquared = magnitudeSquared;
      }
    }
    const maxMagnitude = Math.sqrt(maxMagnitudeSquared);

    return Object.freeze({
      vectors,
      components: dimension,
      cellCount,
      maxMagnitude,
    });
  }
}
