/**
 * The AnnData element rules: what each element of an AnnData file must look
 * like in the current on-disk layout (anndata 0.8 and later), judged on the
 * array-store model (`formats/store.js`) and therefore identically for an
 * `.h5ad` (HDF5) and an AnnData Zarr store.
 *
 * Everything here is synchronous: a store is opened with its whole node tree,
 * so element rules never read array values. Files from earlier anndata
 * releases are presented in the current layout before these rules see them
 * (`older-layouts.js`), so there is one set of rules.
 *
 * Every message names the element the way a user finds it in their file
 * (`obs`, `obsm['X_umap']`, `X`), and the storage (`HDF5`, `Zarr`) where it
 * matters which one is meant.
 *
 * @module data/anndata/elements
 */

import { isArrayNode, isGroup } from '../../formats/store.js';

/**
 * How messages name the file and its storage.
 *
 * @typedef {Object} AnnDataFormat
 * @property {'HDF5'|'Zarr'} storage
 * @property {'H5AD'|'AnnData Zarr'} file
 */

/** @type {AnnDataFormat} */
export const H5AD_FORMAT = Object.freeze({ storage: 'HDF5', file: 'H5AD' });
/** @type {AnnDataFormat} */
export const ZARR_FORMAT = Object.freeze({ storage: 'Zarr', file: 'AnnData Zarr' });

/** Encodings of nullable dataframe columns (anndata 0.1.0 element specs). */
export const NULLABLE_ENCODINGS = Object.freeze(new Set([
  'nullable-integer',
  'nullable-boolean',
  'nullable-string-array',
]));

/** The value of one attribute, or undefined when the node has none. */
export function attributeValue(node, key) {
  const attrs = node?.attrs;
  if (attrs === null || typeof attrs !== 'object' || !Object.hasOwn(attrs, key)) return undefined;
  return attrs[key];
}

/** A node's `encoding-type`, or `''` when it declares none. */
export function encodingType(node) {
  let value = attributeValue(node, 'encoding-type');
  if (Array.isArray(value)) {
    if (value.length !== 1) return '';
    value = value[0];
  }
  return typeof value === 'string' ? value : '';
}

export function requireExactStringAttribute(node, key, expected, label) {
  const value = attributeValue(node, key);
  if (typeof value !== 'string' || value !== expected) {
    throw new Error(`${label} ${key} must be exactly '${expected}'`);
  }
  return value;
}

export function requireEncoding(node, expectedType, expectedVersion, label) {
  requireExactStringAttribute(node, 'encoding-type', expectedType, label);
  requireExactStringAttribute(node, 'encoding-version', expectedVersion, label);
}

/**
 * A group with the AnnData mapping encoding (`dict` 0.1.0): `obsm`, `obsp`,
 * `layers`, `uns` and the like.
 *
 * @param {unknown} node
 * @param {AnnDataFormat} format
 * @param {string} label
 */
export function requireMapping(node, format, label) {
  if (!isGroup(node)) throw new Error(`${label} must be a ${format.storage} mapping group`);
  requireEncoding(node, 'dict', '0.1.0', label);
  return node;
}

/**
 * The `ordered` flag of a categorical group (`categorical` 0.2.0): a boolean
 * attribute -- an HDF5 boolean enum (as h5py writes NumPy booleans) or a JSON
 * boolean in Zarr, both decoded to `true`/`false` by the store -- or the
 * integer 0 or 1 some other writers store.
 */
export function requireCategoricalOrdered(group, label) {
  requireEncoding(group, 'categorical', '0.2.0', label);
  let ordered = attributeValue(group, 'ordered');
  if (Array.isArray(ordered) && ordered.length === 1) ordered = ordered[0];
  if (ordered === 0 || ordered === 1 || ordered === 0n || ordered === 1n) return Number(ordered) === 1;
  if (typeof ordered !== 'boolean') {
    throw new Error(`${label} ordered must be a boolean attribute, as AnnData writes it`);
  }
  return ordered;
}

/**
 * The AnnData value kind of an array: `float`, `int`, `uint`, `bool`,
 * `string`, or `unknown` for what AnnData never stores as a column (compound,
 * opaque, non-boolean enum).
 *
 * @param {unknown} array
 * @returns {'float'|'int'|'uint'|'bool'|'string'|'unknown'}
 */
export function valueKind(array) {
  const kind = array?.dtype?.kind;
  return kind === 'float' || kind === 'int' || kind === 'uint' || kind === 'bool' || kind === 'string'
    ? kind
    : 'unknown';
}

/** The NumPy name of an array's element type, as the data-mapping catalog spells it. */
export function numpyDtypeName(array) {
  const kind = valueKind(array);
  if (kind === 'string') return 'string';
  if (kind === 'unknown') return 'object';
  return array.dtype.name;
}

/** Bytes of one stored element (8 for variable-length values, for planning). */
export function elementBytes(array) {
  const bytes = array?.dtype?.bytes;
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 8;
}

export function requireArray(node, format, label) {
  if (!isArrayNode(node)) throw new Error(`${label} must be a ${format.storage} array`);
  return node;
}

/** A shape of non-negative safe integers, optionally of an exact rank. */
export function shapeOf(node, label, expectedDimensions = null) {
  const raw = node?.shape;
  if (!Array.isArray(raw)) throw new Error(`${label} shape is required`);
  const shape = raw.map(Number);
  if (shape.some(dimension => !Number.isSafeInteger(dimension) || dimension < 0)) {
    throw new Error(`${label} shape dimensions must be non-negative safe integers`);
  }
  if (expectedDimensions !== null && shape.length !== expectedDimensions) {
    throw new Error(
      `${label} must have exactly ${expectedDimensions} dimension${expectedDimensions === 1 ? '' : 's'}`
    );
  }
  return shape;
}

/** A shape given as an attribute value (a sparse matrix's `shape`). */
export function shapeFromAttribute(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} shape is required`);
  const shape = value.map(dimension => (typeof dimension === 'bigint' ? Number(dimension) : Number(dimension)));
  if (shape.some(dimension => !Number.isSafeInteger(dimension) || dimension < 0)) {
    throw new Error(`${label} shape dimensions must be non-negative safe integers`);
  }
  return shape;
}

export function validateOneDimensional(node, format, label, expectedLength = null) {
  requireArray(node, format, label);
  const [length] = shapeOf(node, label, 1);
  if (expectedLength !== null && length !== expectedLength) {
    throw new Error(`${label} length ${length} does not match ${expectedLength}`);
  }
  return length;
}

export function requirePrimitiveKind(array, label) {
  const kind = valueKind(array);
  if (kind === 'unknown') throw new Error(`${label} uses an unsupported element type`);
  return kind;
}

/**
 * An array with the current AnnData array encoding: `array` 0.2.0, or
 * `string-array` 0.2.0. anndata stores text as variable-length UTF-8; other
 * writers use fixed-length or ASCII strings, which read as the same text, so
 * any string storage is accepted.
 *
 * @param {unknown} node
 * @param {AnnDataFormat} format
 * @param {string} label
 * @param {'array'|'string-array'|null} [expectedType] - null accepts either
 * @returns {'array'|'string-array'}
 */
export function validateArrayEncoding(node, format, label, expectedType = null) {
  requireArray(node, format, label);
  const declared = encodingType(node);
  if (expectedType === null && declared !== 'array' && declared !== 'string-array') {
    throw new Error(`${label} encoding-type must be exactly 'array' or 'string-array'`);
  }
  const requiredType = expectedType ?? declared;
  requireEncoding(node, requiredType, '0.2.0', label);
  const kind = valueKind(node);
  if (requiredType === 'string-array' && kind !== 'string') {
    throw new Error(`${label} declares string-array but does not use a string dtype`);
  }
  if (requiredType === 'array' && kind === 'string') {
    throw new Error(`${label} declares array but uses a string dtype`);
  }
  return requiredType;
}

/**
 * A dataframe group (`dataframe` 0.2.0): its index key and the columns it
 * declares, each present.
 *
 * @returns {{columnOrder: string[], indexKey: string}}
 */
export function validateDataFrame(node, format, label) {
  if (!isGroup(node)) {
    throw new Error(`${label} is required and must be a ${format.storage} dataframe group`);
  }
  requireEncoding(node, 'dataframe', '0.2.0', label);
  const indexKey = attributeValue(node, '_index');
  if (typeof indexKey !== 'string' || indexKey.length === 0) {
    throw new Error(`${label} _index must be a non-empty string`);
  }
  const rawOrder = attributeValue(node, 'column-order');
  const columnOrder = Array.isArray(rawOrder) ? rawOrder : null;
  if (columnOrder === null || columnOrder.some(key => typeof key !== 'string' || key.length === 0)) {
    throw new Error(`${label} column-order must be an array of non-empty strings`);
  }
  const seen = new Set();
  for (const key of columnOrder) {
    if (seen.has(key)) throw new Error(`${label} column-order contains duplicate column '${key}'`);
    // A column named as the index holds the index's values: anndata writes
    // it once and lists it as a column too.
    seen.add(key);
  }
  if (!node.has(indexKey)) throw new Error(`${label} index child '${indexKey}' was not found`);
  for (const key of columnOrder) {
    if (!node.has(key)) throw new Error(`${label} declared column '${key}' was not found`);
  }
  // Files from anndata 0.7 keep categories there; they are read through
  // `older-layouts.js`, so one here, unless it is a column of that name, is
  // a dataframe that mixes two layouts.
  if (node.has('__categories') && !seen.has('__categories')) {
    throw new Error(
      `${label} declares the current dataframe encoding but keeps categories in '__categories' as anndata 0.7 did; write the file again with one AnnData release`
    );
  }
  return { columnOrder: [...columnOrder], indexKey };
}

/** A child of `group`, or null when the group lacks it. */
export function child(group, key) {
  return isGroup(group) && group.has(key) ? group.get(key) : null;
}
