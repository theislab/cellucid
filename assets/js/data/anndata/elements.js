/**
 * The AnnData element rules: what each element of an AnnData file must look
 * like in the current on-disk layout (anndata 0.8 and later), judged on the
 * array-store model (`formats/store.js`) and therefore identically for an
 * `.h5ad` (HDF5) and an AnnData Zarr store.
 *
 * Everything here is synchronous over a loaded store: whoever judges an
 * element loads it first (`Group.load`, `ANNDATA_OPENING_PATHS` at open),
 * and element rules never read array values. Files from earlier anndata
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
import { formatCountOf } from '../../utils/format-units.js';

/**
 * What a file holds breaks an AnnData element rule: its container (HDF5,
 * Zarr) read fine, and an element in it is not what anndata writes (a
 * dataframe without its index, a categorical code past its categories, a
 * matrix whose shape disagrees with obs and var, sparse pointers that fall):
 * a writer's error, a hand-built file, or damage. Every rule here and in
 * `dataframe.js`, `sparse.js` and `values.js`, and every check of the
 * reader's of what a file holds, refuses with it; a check of the reader's
 * own work never does. `open.js` (`explainFormatError`) says it to the
 * person as the file's problem, with what to do; anything else that fails
 * is Cellucid's, and is shown as that.
 */
export class AnnDataFormatError extends Error {
  /**
   * @param {string} message - Names the element as the person finds it in their file
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = 'AnnDataFormatError';
  }
}

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

/**
 * What opening an AnnData group loads (`formats/store.js`, `Group.load`):
 * every element's own node -- the group to depth 2: each dataframe column,
 * each `obsm`, `varm`, `obsp`, `varp` and `layers` entry and each `uns`
 * entry, with its attributes, shape and element type; `raw` the same -- and
 * every expression matrix whole (`X`, `layers`, `raw.X`: opening prices the
 * default one, and a gene of any is read without waiting for its
 * structure), with `uns['cellucid']`. So anything that names an element
 * finds it loaded, whatever step of the opening or which reading names it.
 * What waits is what lies inside an element: a categorical's codes and
 * categories, a nullable column's values and mask, a graph's arrays, a
 * nested `uns` entry's children (about half of a CELLxGENE file's
 * objects); the reading that reads an element loads it first
 * (`AnnDataReader._ready`).
 */
export const ANNDATA_OPENING_PATHS = Object.freeze([
  Object.freeze({ path: '', depth: 2 }),
  Object.freeze({ path: 'X', depth: Infinity }),
  Object.freeze({ path: 'layers', depth: Infinity }),
  Object.freeze({ path: 'raw', depth: 2 }),
  Object.freeze({ path: 'raw/X', depth: Infinity }),
  Object.freeze({ path: 'uns/cellucid', depth: Infinity }),
]);

/**
 * `ANNDATA_OPENING_PATHS` of the AnnData group at `prefix` (a MuData
 * modality's: `mod/rna`, or `mod/*` for every one).
 *
 * @param {string} prefix
 * @returns {Array<{path: string, depth: number}>}
 */
export function annDataOpeningPaths(prefix) {
  return ANNDATA_OPENING_PATHS.map(({ path, depth }) => ({ path: path === '' ? prefix : `${prefix}/${path}`, depth }));
}

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
    throw new AnnDataFormatError(`${label} ${key} must be exactly '${expected}'`);
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
  if (!isGroup(node)) throw new AnnDataFormatError(`${label} must be a ${format.storage} mapping group`);
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
    throw new AnnDataFormatError(`${label} ordered must be a boolean attribute, as AnnData writes it`);
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
  if (!isArrayNode(node)) throw new AnnDataFormatError(`${label} must be a ${format.storage} array`);
  return node;
}

/** A shape of non-negative safe integers, optionally of an exact rank. */
export function shapeOf(node, label, expectedDimensions = null) {
  const raw = node?.shape;
  if (!Array.isArray(raw)) throw new AnnDataFormatError(`${label} shape is required`);
  const shape = raw.map(Number);
  if (shape.some(dimension => !Number.isSafeInteger(dimension) || dimension < 0)) {
    throw new AnnDataFormatError(`${label} shape dimensions must be non-negative safe integers`);
  }
  if (expectedDimensions !== null && shape.length !== expectedDimensions) {
    throw new AnnDataFormatError(
      `${label} must have exactly ${formatCountOf(expectedDimensions, 'dimension')}`
    );
  }
  return shape;
}

/** A shape given as an attribute value (a sparse matrix's `shape`). */
export function shapeFromAttribute(value, label) {
  if (!Array.isArray(value)) throw new AnnDataFormatError(`${label} shape is required`);
  const shape = value.map(dimension => (typeof dimension === 'bigint' ? Number(dimension) : Number(dimension)));
  if (shape.some(dimension => !Number.isSafeInteger(dimension) || dimension < 0)) {
    throw new AnnDataFormatError(`${label} shape dimensions must be non-negative safe integers`);
  }
  return shape;
}

export function validateOneDimensional(node, format, label, expectedLength = null) {
  requireArray(node, format, label);
  const [length] = shapeOf(node, label, 1);
  if (expectedLength !== null && length !== expectedLength) {
    throw new AnnDataFormatError(`${label} length ${length} does not match ${expectedLength}`);
  }
  return length;
}

export function requirePrimitiveKind(array, label) {
  const kind = valueKind(array);
  if (kind === 'unknown') throw new AnnDataFormatError(`${label} uses an unsupported element type`);
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
    throw new AnnDataFormatError(`${label} encoding-type must be exactly 'array' or 'string-array'`);
  }
  const requiredType = expectedType ?? declared;
  requireEncoding(node, requiredType, '0.2.0', label);
  const kind = valueKind(node);
  if (requiredType === 'string-array' && kind !== 'string') {
    throw new AnnDataFormatError(`${label} declares string-array but does not use a string dtype`);
  }
  if (requiredType === 'array' && kind === 'string') {
    throw new AnnDataFormatError(`${label} declares array but uses a string dtype`);
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
    throw new AnnDataFormatError(`${label} is required and must be a ${format.storage} dataframe group`);
  }
  requireEncoding(node, 'dataframe', '0.2.0', label);
  const indexKey = attributeValue(node, '_index');
  if (typeof indexKey !== 'string' || indexKey.length === 0) {
    throw new AnnDataFormatError(`${label} _index must be a non-empty string`);
  }
  const rawOrder = attributeValue(node, 'column-order');
  const columnOrder = Array.isArray(rawOrder) ? rawOrder : null;
  if (columnOrder === null || columnOrder.some(key => typeof key !== 'string' || key.length === 0)) {
    throw new AnnDataFormatError(`${label} column-order must be an array of non-empty strings`);
  }
  const seen = new Set();
  for (const key of columnOrder) {
    if (seen.has(key)) throw new AnnDataFormatError(`${label} column-order contains duplicate column '${key}'`);
    // A column named as the index holds the index's values: anndata writes
    // it once and lists it as a column too.
    seen.add(key);
  }
  if (!node.has(indexKey)) throw new AnnDataFormatError(`${label} index child '${indexKey}' was not found`);
  // A declared column that is not there is that column's defect, left out
  // of the dataset with the reason (`dataframe.js` `columnDefect`).
  // Files from anndata 0.7 keep categories there; they are read through
  // `older-layouts.js`, so one here, unless it is a column of that name, is
  // a dataframe that mixes two layouts.
  if (node.has('__categories') && !seen.has('__categories')) {
    throw new AnnDataFormatError(
      `${label} declares the current dataframe encoding but keeps categories in '__categories' as anndata 0.7 did; write the file again with one AnnData release`
    );
  }
  return { columnOrder: [...columnOrder], indexKey };
}

/** A child of `group`, or null when the group lacks it. */
export function child(group, key) {
  return isGroup(group) && group.has(key) ? group.get(key) : null;
}
