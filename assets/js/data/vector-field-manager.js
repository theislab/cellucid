/**
 * @fileoverview Exact vector-field loader for dimension-specific displacement data.
 *
 * Vector values are scaled by the DimensionManager normalization scale so they
 * inhabit the same render space as the corresponding embedding. Metadata,
 * dimensions, file mappings, and numerical payloads are never inferred,
 * coerced, repaired, or substituted.
 *
 * @module data/vector-field-manager
 */

import { loadPointsBinary } from './data-loaders.js';
import {
  getActiveAnnDataBinding,
  isAnnDataUrl,
} from './anndata-provider.js';
import {
  resolveUrl,
  validateVectorFieldsMetadata,
} from './data-source.js';

const SUPPORTED_DIMENSIONS = Object.freeze([1, 2, 3]);
const SUPPORTED_DIMENSION_SET = new Set(SUPPORTED_DIMENSIONS);

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

function requireDimension(value, label) {
  if (!Number.isInteger(value) || !SUPPORTED_DIMENSION_SET.has(value)) {
    throw new RangeError(`${label} must be exactly 1, 2, or 3.`);
  }
  return value;
}

/**
 * Freeze one already-validated `vector_fields` object into the runtime shape.
 *
 * The rule itself lives in exactly one place — validateVectorFieldsMetadata()
 * in data-source.js — so the runtime manager, the hosted-catalog reader, and
 * the local prepared-export reader cannot disagree about what a vector field
 * is. `files` is the only path map the format has: the in-browser H5AD/Zarr
 * adapters publish `files` too and resolve their own obsm keys privately, so
 * this module routes a direct-AnnData read by the dataset's protocol, never by
 * the shape of its metadata.
 *
 * @param {unknown} value
 * @returns {Readonly<{defaultField: string|null, fields: Map<string, Object>}>}
 */
function parseMetadata(value) {
  if (value === null) {
    return Object.freeze({
      defaultField: null,
      fields: new Map(),
    });
  }
  validateVectorFieldsMetadata(value, { sourceType: 'vector-field-manager' });

  const fields = new Map();
  for (const [fieldId, field] of Object.entries(value.fields)) {
    const dimensions = Object.freeze([...field.available_dimensions]);
    const files = {};
    for (const dimension of dimensions) {
      files[`${dimension}d`] = field.files[`${dimension}d`];
    }
    fields.set(fieldId, Object.freeze({
      label: field.label,
      basis: field.basis,
      available_dimensions: dimensions,
      default_dimension: field.default_dimension,
      files: Object.freeze(files),
    }));
  }

  return Object.freeze({
    defaultField: value.default_field,
    fields,
  });
}

function requireManagerOptions(options) {
  requireExactKeys(
    options,
    ['baseUrl', 'vectorFieldsMetadata', 'dimensionManager'],
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
    typeof dimensionManager.getPositions3D !== 'function' ||
    typeof dimensionManager.getNormTransform !== 'function'
  ) {
    throw new TypeError(
      'VectorFieldManager dimensionManager must provide getPositions3D() and getNormTransform().'
    );
  }
  return {
    baseUrl,
    dimensionManager,
    metadata: parseMetadata(options.vectorFieldsMetadata),
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

    /** @type {Map<string, Map<number, Promise<object>>>} */
    this._loading = new Map();
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
      result.push(Object.freeze({
        id,
        label: entry.label,
        availableDimensions: entry.available_dimensions,
        defaultDimension: entry.default_dimension,
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

  hasFieldDimension(fieldId, dimension) {
    const id = requireNonEmptyString(fieldId, 'VectorFieldManager fieldId');
    const dim = requireDimension(
      dimension,
      'VectorFieldManager dimension'
    );
    const entry = this._fields.get(id);
    return entry !== undefined &&
      entry.available_dimensions.includes(dim);
  }

  /**
   * Load vectors for an exact field and dimension, then apply the embedding
   * normalization scale. The returned buffer always has `dimension`
   * components per cell.
   *
   * @param {string} fieldId
   * @param {number} dimension
   * @param {{ showProgress: boolean }} options
   * @returns {Promise<{ vectors: Float32Array, components: 1|2|3, cellCount: number, maxMagnitude: number }>}
   */
  async loadField(fieldId, dimension, options) {
    const id = requireNonEmptyString(
      fieldId,
      'VectorFieldManager fieldId'
    );
    const dim = requireDimension(
      dimension,
      'VectorFieldManager dimension'
    );
    const showProgress = requireLoadOptions(options);
    const entry = this._fields.get(id);
    if (entry === undefined) {
      throw new Error(`VectorFieldManager.loadField: unknown field "${id}".`);
    }
    if (!entry.available_dimensions.includes(dim)) {
      throw new Error(
        `VectorFieldManager.loadField: field "${id}" does not declare ${dim}D data.`
      );
    }

    let perField = this._loading.get(id);
    if (perField === undefined) {
      perField = new Map();
      this._loading.set(id, perField);
    }
    const activeLoad = perField.get(dim);
    if (activeLoad !== undefined) {
      return activeLoad;
    }

    const promise = this._loadExactField(id, entry, dim, showProgress);
    perField.set(dim, promise);
    try {
      return await promise;
    } finally {
      perField.delete(dim);
      if (perField.size === 0) {
        this._loading.delete(id);
      }
    }
  }

  async _loadExactField(id, entry, dimension, showProgress) {
    const positions3D = await this.dimensionManager.getPositions3D(dimension);
    if (
      !(positions3D instanceof Float32Array) ||
      positions3D.length === 0 ||
      positions3D.length % 3 !== 0
    ) {
      throw new Error(
        'VectorFieldManager.loadField: getPositions3D() must return a non-empty Float32Array with three components per cell.'
      );
    }
    const cellCount = positions3D.length / 3;

    const transform = this.dimensionManager.getNormTransform(dimension);
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

    let vectors;
    if (isAnnDataUrl(this.baseUrl)) {
      // An h5ad:// or zarr:// dataset publishes declarative `files` paths that
      // no transport can fetch; the adapter owns the obsm resolution behind
      // getVectorField(). Routing on the protocol keeps the metadata shape the
      // same as an on-disk export's.
      const binding = getActiveAnnDataBinding(this.baseUrl);
      if (typeof binding.adapter.getVectorField !== 'function') {
        throw new Error(
          'VectorFieldManager.loadField: the active AnnData adapter must provide getVectorField().'
        );
      }
      const adapterVectors = await binding.adapter.getVectorField(
        id,
        dimension
      );
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
          'VectorFieldManager.loadField: AnnData getVectorField() must return Float32Array.'
        );
      }
      vectors = new Float32Array(adapterVectors);
    } else {
      const filename = entry.files[`${dimension}d`];
      vectors = await loadPointsBinary(
        resolveUrl(this.baseUrl, filename),
        {
          showProgress,
          displayName: `${dimension}D vector field`,
          dimension,
          expectedBytes:
            cellCount * dimension * Float32Array.BYTES_PER_ELEMENT,
          signal: null,
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
