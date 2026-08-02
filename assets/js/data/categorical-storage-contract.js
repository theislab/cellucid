/**
 * The sole current on-disk contract for categorical code storage.
 *
 * A categorical observation column is stored as an array of integer codes plus
 * an ordered category list. The width of that array decides two things at once,
 * and they must never come apart: which code is reserved to mean "missing", and
 * how many real categories are left over. Every width spends its terminal code
 * on the missing marker, so `uint8` addresses 255 categories (codes 0-254) and
 * `uint16` addresses 65,535 (codes 0-65,534).
 *
 * This module is the single derivation point on the reader side, and the exact
 * peer of `_categorical_storage` and `_declared_categorical_storage` in the
 * Python exporter and `.categorical_code_dtype` in the R exporter. All three
 * writers already resolve width and sentinel in one function each; the readers
 * did not, and derived the same pair independently in five places. A reader
 * that disagreed with a writer by one would not fail loudly — it would read the
 * missing marker as a real category, or a real category as missing, and colour
 * cells by a label they do not have.
 *
 * @module data/categorical-storage-contract
 */

/**
 * @typedef {Object} CategoricalCodeStorage
 * @property {'uint8'|'uint16'} dtype - The on-disk code width.
 * @property {Uint8ArrayConstructor|Uint16ArrayConstructor} TypedArrayClass
 * @property {number} missingValue - The reserved code meaning "no category".
 * @property {number} maxCategories - How many real categories this width holds.
 */

/** @type {Readonly<Record<string, CategoricalCodeStorage>>} */
const STORAGE_BY_DTYPE = Object.freeze({
  uint8: Object.freeze({
    dtype: 'uint8',
    TypedArrayClass: Uint8Array,
    missingValue: 255,
    maxCategories: 255,
  }),
  uint16: Object.freeze({
    dtype: 'uint16',
    TypedArrayClass: Uint16Array,
    missingValue: 65_535,
    maxCategories: 65_535,
  }),
});

/**
 * Every code width the format defines, narrowest first.
 * @type {readonly ('uint8'|'uint16')[]}
 */
export const CATEGORICAL_CODE_DTYPES = Object.freeze(['uint8', 'uint16']);

/**
 * The widest categorical field any Cellucid reader or writer accepts.
 * @type {number}
 */
export const MAX_CATEGORICAL_CATEGORIES = STORAGE_BY_DTYPE.uint16.maxCategories;

/**
 * Resolve the storage a manifest or file already declared.
 *
 * Use this when the width arrives from outside and the question is what that
 * width obliges — the reader's direction.
 *
 * @param {unknown} dtype - The declared code width.
 * @param {string} label - What to name in the failure.
 * @returns {CategoricalCodeStorage}
 */
export function categoricalStorageForDtype(dtype, label) {
  if (typeof label !== 'string' || label.length === 0) {
    throw new TypeError('Categorical storage label must be a non-empty string');
  }
  const storage = typeof dtype === 'string'
    ? Object.hasOwn(STORAGE_BY_DTYPE, dtype) && STORAGE_BY_DTYPE[dtype]
    : null;
  if (!storage) {
    throw new Error(
      `${label} must use one of the exact categorical code widths ` +
      `${CATEGORICAL_CODE_DTYPES.join(' or ')}`
    );
  }
  return storage;
}

/**
 * Require a category count the widest storage can actually address.
 *
 * Every reader that accepts a category list calls this, so the ceiling and the
 * advice a user gets when they cross it are stated once.
 *
 * @param {unknown} nCategories
 * @param {string} label - What to name in the failure.
 * @returns {number} The accepted count.
 */
export function requireCategoricalCategoryCount(nCategories, label) {
  if (typeof label !== 'string' || label.length === 0) {
    throw new TypeError('Categorical storage label must be a non-empty string');
  }
  if (!Number.isSafeInteger(nCategories) || nCategories < 0) {
    throw new Error(`${label} has an invalid category count`);
  }
  if (nCategories > MAX_CATEGORICAL_CATEGORIES) {
    // The advice has to fit both directions this ceiling is met from: a column
    // arriving in a dataset, and a column the user is building in the app.
    throw new Error(
      `${label} has ${nCategories.toLocaleString('en-US')} categories, but ` +
      'Cellucid supports at most ' +
      `${MAX_CATEGORICAL_CATEGORIES.toLocaleString('en-US')}. ` +
      'Reduce or merge categories.'
    );
  }
  return nCategories;
}

/**
 * Choose the narrowest storage that holds a given number of categories.
 *
 * Use this when the categories are in hand and the width has to be picked —
 * the writer's direction, matching `_categorical_storage` in Python.
 *
 * @param {unknown} nCategories
 * @param {string} label - What to name in the failure.
 * @returns {CategoricalCodeStorage}
 */
export function categoricalStorageForCount(nCategories, label) {
  return requireCategoricalCategoryCount(nCategories, label) <=
    STORAGE_BY_DTYPE.uint8.maxCategories
    ? STORAGE_BY_DTYPE.uint8
    : STORAGE_BY_DTYPE.uint16;
}

/**
 * Resolve the storage a codes array is already in.
 *
 * Use this when a typed array is in hand and the question is which code it
 * reserves for "missing". Every caller that asked that question used to answer
 * it inline, and an inline answer is one edit away from disagreeing with the
 * format.
 *
 * @param {unknown} codes - A categorical codes array.
 * @param {string} label - What to name in the failure.
 * @returns {CategoricalCodeStorage}
 */
export function categoricalStorageForCodes(codes, label) {
  if (typeof label !== 'string' || label.length === 0) {
    throw new TypeError('Categorical storage label must be a non-empty string');
  }
  if (codes instanceof Uint8Array) return STORAGE_BY_DTYPE.uint8;
  if (codes instanceof Uint16Array) return STORAGE_BY_DTYPE.uint16;
  throw new TypeError(
    `${label} codes must be one of the exact categorical code widths ` +
    `${CATEGORICAL_CODE_DTYPES.join(' or ')}`
  );
}
