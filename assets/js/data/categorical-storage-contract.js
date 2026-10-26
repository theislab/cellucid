/**
 * The one contract for how the viewer holds a categorical field's codes.
 *
 * A categorical observation column is held as an array of integer codes plus
 * an ordered category list. The width of that array decides two things at once,
 * and they must never come apart: which code is reserved to mean "missing", and
 * how many real categories are left over. Every width spends its terminal code
 * on the missing marker, so `uint8` addresses 255 categories (codes 0-254),
 * `uint16` 65,535 (codes 0-65,534) and `uint32` 4,294,967,295 (codes up to
 * 4,294,967,294). The narrowest width that holds a column is used, so a column
 * needs `uint32` only past 65,535 categories.
 *
 * This module is the single derivation point: the AnnData adapter picks the
 * width a field's codes are narrowed to, and every reader of codes (colouring,
 * filters, analysis, sessions) resolves the missing marker from the array's
 * own width here. A reader that disagreed by one would not fail loudly — it
 * would read the missing marker as a real category, or a real category as
 * missing, and colour cells by a label they do not have.
 *
 * @module data/categorical-storage-contract
 */

import { formatCountOf } from '../utils/format-units.js';

/**
 * @typedef {Object} CategoricalCodeStorage
 * @property {'uint8'|'uint16'|'uint32'} dtype - The code width.
 * @property {Uint8ArrayConstructor|Uint16ArrayConstructor|Uint32ArrayConstructor} TypedArrayClass
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
  uint32: Object.freeze({
    dtype: 'uint32',
    TypedArrayClass: Uint32Array,
    missingValue: 4_294_967_295,
    maxCategories: 4_294_967_295,
  }),
});

/**
 * Every code width the format defines, narrowest first.
 * @type {readonly ('uint8'|'uint16'|'uint32')[]}
 */
export const CATEGORICAL_CODE_DTYPES = Object.freeze(['uint8', 'uint16', 'uint32']);

/**
 * The widest categorical field the code widths address: every code a uint32
 * holds but the missing marker (a format limit, far above any cell count the
 * uint32 cell axis allows).
 * @type {number}
 */
export const MAX_CATEGORICAL_CATEGORIES = STORAGE_BY_DTYPE.uint32.maxCategories;

/**
 * Resolve the storage a file or a field descriptor already declared.
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
      `${CATEGORICAL_CODE_DTYPES.join(', ')}`
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
      `${label} has ${formatCountOf(nCategories, 'category', 'categories')}, but ` +
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
 * Use this when the categories are in hand and the width has to be picked.
 *
 * @param {unknown} nCategories
 * @param {string} label - What to name in the failure.
 * @returns {CategoricalCodeStorage}
 */
export function categoricalStorageForCount(nCategories, label) {
  const count = requireCategoricalCategoryCount(nCategories, label);
  if (count <= STORAGE_BY_DTYPE.uint8.maxCategories) return STORAGE_BY_DTYPE.uint8;
  if (count <= STORAGE_BY_DTYPE.uint16.maxCategories) return STORAGE_BY_DTYPE.uint16;
  return STORAGE_BY_DTYPE.uint32;
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
  if (codes instanceof Uint32Array) return STORAGE_BY_DTYPE.uint32;
  throw new TypeError(
    `${label} codes must be one of the exact categorical code widths ` +
    `${CATEGORICAL_CODE_DTYPES.join(', ')}`
  );
}

/**
 * Whether one value is a categorical codes array of a width the format
 * defines (Uint8Array, Uint16Array or Uint32Array).
 *
 * @param {unknown} codes
 * @returns {boolean}
 */
export function isCategoricalCodes(codes) {
  return codes instanceof Uint8Array ||
    codes instanceof Uint16Array ||
    codes instanceof Uint32Array;
}

/**
 * The missing marker of one codes array: the largest value of its width.
 *
 * @param {Uint8Array|Uint16Array|Uint32Array} codes
 * @returns {number}
 */
export function missingCategoryCode(codes) {
  return categoricalStorageForCodes(codes, 'Categorical codes').missingValue;
}

/**
 * Narrow one field's codes, as an AnnData file stores them (an integer per
 * cell, -1 for a missing category), to the narrowest storage that holds its
 * categories, the missing ones becoming that storage's marker. The reader
 * worker does this before a field crosses to the page, so the page receives
 * the array it keeps and never re-encodes it.
 *
 * @param {ArrayLike<number>} codes - One code per cell: -1, or 0 to nCategories - 1
 * @param {number} nCategories
 * @param {string} label - What to name in a failure.
 * @returns {Uint8Array|Uint16Array|Uint32Array}
 */
export function narrowCategoricalCodes(codes, nCategories, label) {
  const { TypedArrayClass, missingValue } = categoricalStorageForCount(nCategories, label);
  const narrowed = new TypedArrayClass(codes.length);
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    if (code === -1) {
      narrowed[index] = missingValue;
    } else if (code >= 0 && code < nCategories && code === Math.trunc(code)) {
      narrowed[index] = code;
    } else {
      throw new RangeError(
        `${label} has invalid code ${String(code)} at index ${index}; ` +
        `expected -1 or an integer from 0 to ${nCategories - 1}`
      );
    }
  }
  return narrowed;
}
