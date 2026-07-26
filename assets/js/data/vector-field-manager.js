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
import { getActiveAnnDataBinding } from './anndata-provider.js';
import { resolveUrl } from './data-source.js';

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

function requireDimensions(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array.`);
  }
  const dimensions = value.map((dimension, index) =>
    requireDimension(dimension, `${label}[${index}]`)
  );
  for (let index = 1; index < dimensions.length; index++) {
    if (dimensions[index] <= dimensions[index - 1]) {
      throw new TypeError(
        `${label} must contain unique dimensions in ascending order.`
      );
    }
  }
  return Object.freeze(dimensions);
}

function requireDimensionPathMap(value, dimensions, label) {
  if (!isPlainRecord(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const expectedKeys = dimensions.map((dimension) => `${dimension}d`);
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(
      `${label} must declare exactly ${expectedKeys.join(', ')}.`
    );
  }
  const result = {};
  for (const key of expectedKeys) {
    result[key] = requireNonEmptyString(value[key], `${label}.${key}`);
  }
  return Object.freeze(result);
}

function parseFieldEntry(fieldId, value) {
  const label = `vector_fields.fields.${fieldId}`;
  requireExactKeys(
    value,
    ['label', 'basis', 'available_dimensions', 'default_dimension'],
    ['files', 'obsm_keys'],
    label
  );
  const dimensions = requireDimensions(
    value.available_dimensions,
    `${label}.available_dimensions`
  );
  const defaultDimension = requireDimension(
    value.default_dimension,
    `${label}.default_dimension`
  );
  if (!dimensions.includes(defaultDimension)) {
    throw new TypeError(
      `${label}.default_dimension must be one of its available_dimensions.`
    );
  }
  const hasFiles = Object.hasOwn(value, 'files');
  const hasObsmKeys = Object.hasOwn(value, 'obsm_keys');
  if (hasFiles === hasObsmKeys) {
    throw new TypeError(
      `${label} must declare exactly one of "files" or "obsm_keys".`
    );
  }

  return Object.freeze({
    label: requireNonEmptyString(value.label, `${label}.label`),
    basis: requireNonEmptyString(value.basis, `${label}.basis`),
    available_dimensions: dimensions,
    default_dimension: defaultDimension,
    ...(hasFiles
      ? {
          files: requireDimensionPathMap(
            value.files,
            dimensions,
            `${label}.files`
          )
        }
      : {
          obsm_keys: requireDimensionPathMap(
            value.obsm_keys,
            dimensions,
            `${label}.obsm_keys`
          )
        }),
  });
}

function parseMetadata(value) {
  if (value === null) {
    return Object.freeze({
      defaultField: null,
      fields: new Map(),
    });
  }
  requireExactKeys(
    value,
    ['default_field', 'fields'],
    [],
    'vector_fields'
  );
  if (!isPlainRecord(value.fields) || Object.keys(value.fields).length === 0) {
    throw new TypeError('vector_fields.fields must be a non-empty plain object.');
  }

  const fields = new Map();
  for (const [fieldId, field] of Object.entries(value.fields)) {
    requireNonEmptyString(fieldId, 'vector field id');
    fields.set(fieldId, parseFieldEntry(fieldId, field));
  }

  let defaultField = null;
  if (value.default_field !== null) {
    defaultField = requireNonEmptyString(
      value.default_field,
      'vector_fields.default_field'
    );
    if (!fields.has(defaultField)) {
      throw new TypeError(
        'vector_fields.default_field must be null or name a declared field.'
      );
    }
  }
  return Object.freeze({ defaultField, fields });
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
    if (Object.hasOwn(entry, 'obsm_keys')) {
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

    let maxMagnitude = 0;
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      const offset = cellIndex * dimension;
      const scaledComponents = [];
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
        scaledComponents.push(scaled);
      }
      const magnitude = Math.hypot(...scaledComponents);
      if (!Number.isFinite(magnitude)) {
        throw new Error(
          `VectorFieldManager.loadField: field "${id}" produced a non-finite magnitude at cell ${cellIndex}.`
        );
      }
      if (magnitude > maxMagnitude) {
        maxMagnitude = magnitude;
      }
    }

    return Object.freeze({
      vectors,
      components: dimension,
      cellCount,
      maxMagnitude,
    });
  }
}
