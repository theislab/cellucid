/**
 * AnnData dataframe columns: categorical, nullable and plain columns, the
 * dataframe index, and gene names taken from a var column.
 *
 * Validation (`*Contract`, `validate*`) reads no values; reading (`read*`)
 * reads exactly the arrays a column needs, in parallel where it needs more
 * than one. Both work on loaded groups (`formats/store.js`, `Group.load`):
 * a frame is loaded with its columns known (`loadFrameStructure` adds what
 * its index and nested column names need), a column's parts when it is
 * read.
 *
 * @module data/anndata/dataframe
 */

import { requireCategoricalCategoryCount } from '../categorical-storage-contract.js';
import { decodeAnnDataBoolean, decodeAnnDataBooleanFlags } from '../anndata-value-kinds.js';
import { geneNameText } from '../gene-names.js';
import { StoreNotLoadedError, isGroup } from '../../formats/store.js';
import {
  NULLABLE_ENCODINGS,
  child,
  encodingType,
  numpyDtypeName,
  requireCategoricalOrdered,
  requireEncoding,
  requirePrimitiveKind,
  validateArrayEncoding,
  validateDataFrame,
  validateOneDimensional,
  valueKind,
} from './elements.js';
import { readContinuous, readInt32, readStored } from './values.js';
import { allocateTypedArray } from '../sparse-column-index.js';

/**
 * A categorical column (`categorical` 0.2.0 group of `codes` and
 * `categories`), or null when `key` is not one.
 *
 * @returns {{codes: Object, categories: Object, ordered: boolean}|null}
 */
export function resolveCategoricalColumn(frame, key, format) {
  const item = child(frame, key);
  if (!isGroup(item) || encodingType(item) !== 'categorical') return null;
  const ordered = requireCategoricalOrdered(item, `Categorical field '${key}'`);
  if (!item.has('codes') || !item.has('categories')) {
    throw new Error(`Categorical field '${key}' must contain codes and categories`);
  }
  const codes = item.get('codes');
  const categories = item.get('categories');
  validateArrayEncoding(codes, format, `Categorical codes for '${key}'`, 'array');
  if (isGroup(categories)) {
    if (encodingType(categories) !== 'nullable-string-array') {
      throw new Error(
        `Categorical categories for '${key}' must use a current array or nullable-string-array encoding`
      );
    }
    nullableContract(categories, `${key}' categories`, 'nullable-string-array', format, null);
  } else {
    validateArrayEncoding(categories, format, `Categorical categories for '${key}'`);
  }
  return { codes, categories, ordered };
}

/** The encoding of one dataframe column, checked against the current specs. */
export function validateColumnEncoding(item, format, label) {
  if (!isGroup(item)) return validateArrayEncoding(item, format, label);
  const declared = encodingType(item);
  if (declared === 'categorical') {
    requireCategoricalOrdered(item, label);
    return declared;
  }
  if (NULLABLE_ENCODINGS.has(declared)) {
    requireEncoding(item, declared, '0.1.0', label);
    return declared;
  }
  throw new Error(`${label} uses unsupported encoding '${declared || 'unknown'}'`);
}

/**
 * A nullable column's arrays (`values`, `mask`), checked.
 *
 * @returns {{maskArray: Object, valuesArray: Object, valuesKind: string, valuesLength: number}}
 */
export function nullableContract(item, key, declared, format, expectedLength = null) {
  if (!isGroup(item)) throw new Error(`Nullable field '${key}' must be a ${format.storage} group`);
  requireEncoding(item, declared, '0.1.0', `Nullable field '${key}'`);
  if (!item.has('values') || !item.has('mask')) {
    throw new Error(`Nullable field '${key}' must contain values and mask datasets`);
  }
  const valuesArray = item.get('values');
  const maskArray = item.get('mask');
  validateArrayEncoding(
    valuesArray,
    format,
    `Nullable values for '${key}'`,
    declared === 'nullable-string-array' ? 'string-array' : 'array'
  );
  validateArrayEncoding(maskArray, format, `Nullable mask for '${key}'`, 'array');
  const valuesLength = validateOneDimensional(valuesArray, format, `Nullable values for '${key}'`, expectedLength);
  const maskLength = validateOneDimensional(maskArray, format, `Nullable mask for '${key}'`, expectedLength ?? valuesLength);
  if (valuesLength !== maskLength) throw new Error(`Nullable values and mask lengths differ for '${key}'`);
  const valuesKind = valueKind(valuesArray);
  if (valueKind(maskArray) !== 'bool') throw new Error(`Nullable mask for '${key}' must use a boolean dtype`);
  if (declared === 'nullable-integer' && valuesKind !== 'int' && valuesKind !== 'uint') {
    throw new Error(`Nullable integer values for '${key}' must use an integer dtype`);
  }
  if (declared === 'nullable-boolean' && valuesKind !== 'bool') {
    throw new Error(`Nullable boolean values for '${key}' must use a boolean dtype`);
  }
  if (declared === 'nullable-string-array' && valuesKind !== 'string') {
    throw new Error(`Nullable string values for '${key}' must use a string dtype`);
  }
  if (!NULLABLE_ENCODINGS.has(declared)) {
    throw new Error(`Unsupported nullable encoding-type '${declared}' for '${key}'`);
  }
  return { maskArray, valuesArray, valuesKind, valuesLength };
}

/** A boolean mask as 0/1 bytes; any other stored value is refused. */
export async function readBooleanMask(maskArray, length, label, options, range = null) {
  const { start, end } = range ?? { start: 0, end: length };
  const raw = await readStored(maskArray, start, end, label, options);
  const message = `${label} must contain only boolean values`;
  const mask = raw instanceof Uint8Array ? raw : allocateTypedArray(Uint8Array, end - start, label);
  for (let i = 0; i < end - start; i++) {
    const value = raw[i];
    if (value === 0 || value === 1) mask[i] = value;
    else mask[i] = decodeAnnDataBoolean(value, message) ? 1 : 0;
  }
  return mask;
}

/**
 * A nullable column's values: integers as numbers with NaN where missing
 * (float32, or float64 where float32 cannot hold them exactly:
 * `exactIntegersNeedFloat64`), booleans and strings as values with null
 * where missing. `range` (`{start, end}`) reads only those rows; every row
 * by default.
 */
export async function readNullableValues(item, key, declared, format, expectedLength = null, contract = null, options = {}, range = null) {
  const { maskArray, valuesArray, valuesKind, valuesLength: storedLength } =
    contract ?? nullableContract(item, key, declared, format, expectedLength);
  const { start, end } = range ?? { start: 0, end: storedLength };
  const valuesLength = end - start;
  if (declared === 'nullable-integer') {
    // Only present values are checked: what a writer leaves under the mask
    // is not data. Integers stay exact: float64 where float32 cannot hold
    // them (`readContinuous`, 64-bit ones through their words).
    const [mask, values] = await Promise.all([
      readBooleanMask(maskArray, storedLength, `Nullable mask for '${key}'`, options, { start, end }),
      readContinuous(valuesArray, start, end, `Nullable values for '${key}'`, options),
    ]);
    for (let i = 0; i < valuesLength; i++) if (mask[i]) values[i] = Number.NaN;
    return { dtype: valuesKind === 'uint' ? 'uint' : 'int', values };
  }
  const [mask, rawValues] = await Promise.all([
    readBooleanMask(maskArray, storedLength, `Nullable mask for '${key}'`, options, { start, end }),
    readStored(valuesArray, start, end, `Nullable values for '${key}'`, options),
  ]);
  if (declared === 'nullable-boolean') {
    // One byte a cell (0, 1, or missing), coded by its caller (`codeBooleanColumn`).
    const message = `Nullable boolean values for '${key}' must contain only boolean values`;
    return { dtype: 'bool', flags: decodeAnnDataBooleanFlags(rawValues, mask, message) };
  }
  const values = new Array(valuesLength);
  for (let i = 0; i < valuesLength; i++) values[i] = mask[i] ? null : String(rawValues[i]);
  return { dtype: 'string', values };
}

/** Names that may not be missing: an index. */
async function readNames(array, length, label, options) {
  const raw = await readStored(array, 0, length, label, options);
  const names = new Array(length);
  for (let i = 0; i < length; i++) {
    const value = raw[i];
    if (value === null || value === undefined) throw new Error(`${label} cannot contain missing names`);
    names[i] = typeof value === 'string' ? value : String(value);
  }
  return names;
}

/**
 * A dataframe index: its length, and its names when `materialize`.
 *
 * @returns {Promise<{length: number, values: string[]|null}>}
 */
export async function readDataFrameIndex(indexNode, format, label, expectedLength = null, materialize = false, options = {}) {
  if (isGroup(indexNode)) {
    await indexNode.load([''], options);
    const declared = encodingType(indexNode);
    if (declared !== 'nullable-string-array') {
      throw new Error(`${label} group uses unsupported encoding '${declared || 'unknown'}'`);
    }
    const contract = nullableContract(indexNode, label, declared, format, expectedLength);
    const mask = await readBooleanMask(contract.maskArray, contract.valuesLength, `Nullable mask for '${label}'`, options);
    if (mask.some(value => value !== 0)) throw new Error(`${label} cannot contain missing names`);
    return {
      length: contract.valuesLength,
      values: materialize ? await readNames(contract.valuesArray, contract.valuesLength, label, options) : null,
    };
  }
  validateArrayEncoding(indexNode, format, label, 'string-array');
  const length = validateOneDimensional(indexNode, format, label, expectedLength);
  if (valueKind(indexNode) !== 'string') throw new Error(`${label} must use a string dtype`);
  return { length, values: materialize ? await readNames(indexNode, length, label, options) : null };
}

function freezeUniqueCategories(categories, key) {
  const seen = new Set();
  for (const category of categories) {
    const type = typeof category;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') {
      throw new Error(`Categorical categories for '${key}' contain an unsupported label type`);
    }
    if (type === 'number' && !Number.isFinite(category)) {
      throw new Error(`Categorical categories for '${key}' contain a non-finite numeric label`);
    }
    if (seen.has(category)) throw new Error(`Categorical categories for '${key}' contain a duplicate label`);
    seen.add(category);
  }
  return Object.freeze(categories);
}

/** The number of categories, checked, without reading them. */
export function categoryCount(categories, key, format) {
  if (isGroup(categories)) {
    const declared = encodingType(categories);
    if (declared !== 'nullable-string-array') {
      throw new Error(`Categorical categories for '${key}' use unsupported encoding '${declared}'`);
    }
    const contract = nullableContract(categories, `${key}' categories`, declared, format, null);
    return requireCategoricalCategoryCount(contract.valuesLength, `Categorical observation field "${key}"`);
  }
  validateArrayEncoding(categories, format, `Categorical categories for '${key}'`);
  const length = validateOneDimensional(categories, format, `Categorical categories for '${key}'`);
  requireCategoricalCategoryCount(length, `Categorical observation field "${key}"`);
  if (valueKind(categories) === 'unknown') {
    throw new Error(`Categorical categories for '${key}' must use a numeric, boolean, or string dtype`);
  }
  return length;
}

/** A categorical column's labels: unique strings, finite numbers or booleans. */
export async function readCategories(categories, key, format, options = {}) {
  if (isGroup(categories)) {
    const declared = encodingType(categories);
    if (declared !== 'nullable-string-array') {
      throw new Error(`Categorical categories for '${key}' use unsupported encoding '${declared}'`);
    }
    const nullableKey = `${key}' categories`;
    const contract = nullableContract(categories, nullableKey, declared, format, null);
    requireCategoricalCategoryCount(contract.valuesLength, `Categorical observation field "${key}"`);
    const result = await readNullableValues(categories, nullableKey, declared, format, null, contract, options);
    if (result.values.some(value => value === null)) {
      throw new Error(`Categorical categories for '${key}' cannot contain missing labels`);
    }
    return freezeUniqueCategories(result.values, key);
  }
  const length = categoryCount(categories, key, format);
  const raw = await readStored(categories, 0, length, `Categorical categories for '${key}'`, options);
  return freezeUniqueCategories(categoryLabels(raw, valueKind(categories), key), key);
}

/**
 * Some of a categorical column's labels: those at the stored positions
 * `positions` (ascending), in that order, each exactly what
 * `readCategories` gives at its position. `gather(array, positions)` is the
 * array's rows at those positions (`views/cell-subset.js` `gatheredArray`):
 * only what they need of its storage is read (a dictionary of one category
 * per cell is tens of megabytes; a share of the cells names a share of
 * them). Labels must be unique among those read; the others are not read,
 * so not checked. A nullable dictionary (a group of values and mask,
 * which anndata does not write for categories) is read whole and picked.
 *
 * @param {Object} categories
 * @param {Uint32Array} positions
 * @param {string} key
 * @param {import('./elements.js').AnnDataFormat} format
 * @param {Object} options - Read options
 * @param {(array: Object, positions: Uint32Array) => Object} gather
 * @returns {Promise<ReadonlyArray<string|number|boolean>>}
 */
export async function readCategoriesAt(categories, positions, key, format, options, gather) {
  if (isGroup(categories)) {
    const all = await readCategories(categories, key, format, options);
    return Object.freeze(Array.from(positions, position => all[position]));
  }
  categoryCount(categories, key, format);
  if (positions.length === 0) return Object.freeze([]);
  const raw = await readStored(gather(categories, positions), 0, positions.length, `Categorical categories for '${key}'`, options);
  return freezeUniqueCategories(categoryLabels(raw, valueKind(categories), key), key);
}

/** Stored category values as labels (`readCategories`): text, booleans or finite numbers. */
function categoryLabels(raw, kind, key) {
  if (kind === 'string') return Array.from(raw, value => String(value));
  if (kind === 'bool') {
    return Array.from(raw, value => decodeAnnDataBoolean(
      value,
      `Categorical categories for '${key}' contain a non-boolean value`
    ));
  }
  // Labels are names: a 64-bit integer label beyond 2^53 has no exact
  // number, so such labels are all given as their exact decimal text.
  if (Array.prototype.some.call(raw, value => typeof value === 'bigint' && (value > 9007199254740991n || value < -9007199254740991n))) {
    return Array.from(raw, value => String(value));
  }
  return Array.from(raw, value => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Error(`Categorical categories for '${key}' cannot contain non-finite numeric labels`);
    }
    return numeric;
  });
}

/**
 * Validate a categorical column's codes array: one integer per row, signed
 * (anndata's, -1 for a missing value) or unsigned (other writers'; every
 * code then names a category, checked as the codes are read).
 */
export function validateCodes(codes, key, format, nRows) {
  validateArrayEncoding(codes, format, `Categorical codes for '${key}'`, 'array');
  const length = validateOneDimensional(codes, format, `Categorical codes for '${key}'`, nRows);
  const kind = valueKind(codes);
  if (kind !== 'int' && kind !== 'uint') throw new Error(`Categorical codes for '${key}' must use an integer dtype`);
  return length;
}

/**
 * A categorical column's codes as int32, each a category or -1 (missing);
 * `range` (`{start, end}`) reads only those rows, every row by default.
 */
export async function readCodes(codes, nCategories, key, format, nRows, options = {}, range = null) {
  const length = validateCodes(codes, key, format, nRows);
  const { start, end } = range ?? { start: 0, end: length };
  const values = await readInt32(codes, start, end, `Categorical code for '${key}'`, options);
  for (let i = 0; i < values.length; i++) {
    const code = values[i];
    if (code < -1 || code >= nCategories) {
      throw new Error(`Categorical code ${code} for '${key}' is outside missing-or-category bounds`);
    }
  }
  return values;
}

/**
 * Check one dataframe column as opening sees it, reading no values: its own
 * encoding, and an array's shape and element type against the frame's row
 * count. A categorical or nullable column is a group whose parts (codes and
 * categories, values and mask) are not loaded at open
 * (`ANNDATA_OPENING_PATHS`): they are loaded and checked when the column is
 * read (`resolveCategoricalColumn`, `validateCodes`, `nullableContract`),
 * which refuses a column whose parts are wrong with the same words.
 */
export function validateColumnAxis(frame, key, format, frameLabel, expectedLength) {
  if (!frame.has(key)) throw new Error(`${frameLabel} declared column '${key}' was not found`);
  const item = frame.get(key);
  const label = `${frameLabel} column '${key}'`;
  validateColumnEncoding(item, format, label);
  if (isGroup(item)) return;
  validateOneDimensional(item, format, label, expectedLength);
  requirePrimitiveKind(item, label);
}

/**
 * Why one dataframe column cannot be read (`validateColumnAxis`'s refusal,
 * as a sentence), or null when it can. One column a reader does not
 * understand (an unknown encoding, a compound or opaque dtype, the wrong
 * length) is left out of the dataset with this reason, never the dataset
 * refused for it: the frame's index and shape are what the file needs. A
 * column whose parts are wrong is refused when it is read.
 *
 * @param {Object} frame
 * @param {string} key
 * @param {import('./elements.js').AnnDataFormat} format
 * @param {string} frameLabel - `obs`, `var`, `raw.var`, `<modality> var`
 * @param {number|null} expectedLength
 * @returns {string|null}
 */
export function columnDefect(frame, key, format, frameLabel, expectedLength) {
  try {
    validateColumnAxis(frame, key, format, frameLabel, expectedLength);
    return null;
  } catch (error) {
    // Not loading what is checked is the reader's mistake, never the file's.
    if (error instanceof StoreNotLoadedError) throw error;
    return `${String(error?.message ?? error).replace(/\.$/, '')}; the column was not read.`;
  }
}

/**
 * Load what checking a loaded dataframe's columns and reading its index
 * navigate besides its own children (`formats/store.js`, `Group.load`): its
 * index whole (a nullable index is a group of values and mask), and the way
 * to each column whose name is a path (`a/b`, a column in a nested group).
 * Columns' own parts are not loaded: they are when the column is read.
 *
 * @param {Object|null} frame - A loaded dataframe group (or anything else: nothing is loaded)
 * @param {{signal?: AbortSignal|null, activity?: Object|null}} [options]
 * @returns {Promise<void>}
 */
export async function loadFrameStructure(frame, options = {}) {
  if (!isGroup(frame)) return;
  const indexKey = frame.attrs?._index;
  const order = frame.attrs?.['column-order'];
  const columns = Array.isArray(order) ? order.map(String) : (typeof order === 'string' ? [order] : []);
  const paths = columns.filter(key => key.includes('/')).map(path => ({ path, depth: 0 }));
  if (typeof indexKey === 'string' && indexKey !== '') paths.push(indexKey);
  await frame.load(paths, options);
}

/**
 * The columns of a dataframe that can be read and the dtype each holds,
 * for the data-mapping catalog: a column `columnDefect` refuses is left out.
 */
export function probeColumns(frame, format, label, expectedLength = null) {
  const { columnOrder } = validateDataFrame(frame, format, label);
  return columnOrder.filter(key => columnDefect(frame, key, format, label, expectedLength) === null).map(key => {
    const node = frame.get(key);
    if (!isGroup(node)) return { key, dtype: numpyDtypeName(node) };
    const declared = encodingType(node);
    if (declared === 'categorical') return { key, dtype: 'categorical' };
    if (declared === 'nullable-integer') return { key, dtype: 'Int64' };
    if (declared === 'nullable-boolean') return { key, dtype: 'boolean' };
    if (declared === 'nullable-string-array') return { key, dtype: 'string' };
    return { key, dtype: 'object' };
  });
}

/**
 * One boolean dataframe column as flags, 1 where true: a numpy `bool` array,
 * or anndata's nullable `boolean` (a missing value is not true). Any other
 * column is refused: it does not say which rows are marked.
 *
 * @returns {Promise<Uint8Array>}
 */
export async function readBooleanColumn(frame, key, format, label, nRows, options = {}) {
  const item = frame.get(key);
  if (isGroup(item)) {
    if (encodingType(item) !== 'nullable-boolean') throw new Error(`${label} is not a true/false column`);
    const contract = nullableContract(item, key, 'nullable-boolean', format, nRows);
    const [mask, values] = await Promise.all([
      readBooleanMask(contract.maskArray, contract.valuesLength, `Nullable mask for '${key}'`, options),
      readBooleanMask(contract.valuesArray, contract.valuesLength, label, options),
    ]);
    const flags = allocateTypedArray(Uint8Array, contract.valuesLength, label);
    for (let row = 0; row < flags.length; row++) flags[row] = values[row] === 1 && mask[row] === 0 ? 1 : 0;
    return flags;
  }
  const length = validateOneDimensional(item, format, label, nRows);
  if (valueKind(item) !== 'bool') throw new Error(`${label} is not a true/false column`);
  return readBooleanMask(item, length, label, options);
}

/**
 * One dataframe column as gene-name text (`gene-names.js`): strings,
 * categories and integers name genes; a missing value is null. Float and
 * boolean columns cannot name genes.
 */
export async function readGeneNameColumn(frame, key, format, label, nRows, options = {}) {
  const categorical = resolveCategoricalColumn(frame, key, format);
  if (categorical) {
    const isFloat = !isGroup(categorical.categories) && valueKind(categorical.categories) === 'float';
    const [rawCategories, codes] = await Promise.all([
      readCategories(categorical.categories, key, format, options),
      (async () => {
        const count = categoryCount(categorical.categories, key, format);
        return readCodes(categorical.codes, count, key, format, nRows, options);
      })(),
    ]);
    const categories = rawCategories.map(category => geneNameText(category, { isFloat }));
    return Array.from(codes, code => (code < 0 ? null : categories[code]));
  }
  const item = frame.get(key);
  const declared = isGroup(item) ? encodingType(item) : null;
  if (declared === 'nullable-string-array' || declared === 'nullable-integer') {
    const contract = nullableContract(item, key, declared, format, nRows);
    const [mask, raw] = await Promise.all([
      readBooleanMask(contract.maskArray, contract.valuesLength, `Nullable mask for '${key}'`, options),
      readStored(contract.valuesArray, 0, contract.valuesLength, label, options),
    ]);
    return Array.from(raw, (value, row) => (mask[row] ? null : geneNameText(
      declared === 'nullable-string-array' ? String(value) : value
    )));
  }
  if (isGroup(item)) throw new Error(`${label} cannot name genes`);
  const length = validateOneDimensional(item, format, label, nRows);
  const kind = valueKind(item);
  if (kind !== 'string' && kind !== 'int' && kind !== 'uint') {
    throw new Error(`${label} cannot name genes: its values are ${kind}`);
  }
  const raw = await readStored(item, 0, length, label, options);
  return Array.from(raw, value => geneNameText(kind === 'string' ? String(value) : value));
}
