/**
 * Categorical field operations (pure utilities).
 *
 * Centralizes category-index transforms used by destructive categorical edits
 * (merge categories, delete-to-unassigned) so state/UI code stays DRY.
 *
 * These helpers are intentionally state-free:
 * - Input: categories array + indices
 * - Output: an index mapping + a derived categories array
 *
 * @module categorical-ops
 */

import {
  categoricalStorageForCodes,
  categoricalStorageForCount
} from '../../data/categorical-storage-contract.js';

function requireCategories(categories) {
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new TypeError('Category transform requires a nonempty category array.');
  }
  const seen = new Set();
  for (let index = 0; index < categories.length; index++) {
    const category = categories[index];
    const type = typeof category;
    if (
      (type !== 'string' && type !== 'number' && type !== 'boolean')
      || (type === 'number' && !Number.isFinite(category))
    ) {
      throw new TypeError(
        `Category ${index} must be a string, finite number, or boolean.`
      );
    }
    if (seen.has(category)) {
      throw new TypeError(`Category ${index} duplicates an existing category value.`);
    }
    seen.add(category);
  }
  return categories;
}

/**
 * Build an index mapping that merges a "deleted" category (and any existing
 * unassigned variants) into a single "unassigned" category.
 *
 * The output mapping is defined for indices `[0, categories.length)`.
 * Codes outside that range are expected to be handled by the caller.
 *
 * @param {Array<string|number|boolean>} categories
 * @param {number} deleteIndex
 * @param {{unassignedLabel: string}} options
 * @returns {{
 *   categories: Array<string|number|boolean>,
 *   mapping: Uint16Array,
 *   unassignedNewIndex: number,
 *   keptOldUnassignedIndex: number|null,
 *   mergedOldIndices: number[]
 * }}
 */
export function buildDeleteToUnassignedTransform(categories, deleteIndex, options) {
  const labels = requireCategories(categories);
  const oldCount = labels.length;
  if (
    !options
    || typeof options !== 'object'
    || Array.isArray(options)
    || Object.keys(options).join(',') !== 'unassignedLabel'
    || typeof options.unassignedLabel !== 'string'
    || options.unassignedLabel.length === 0
    || options.unassignedLabel !== options.unassignedLabel.trim()
  ) {
    throw new TypeError(
      'Delete-category transform requires exactly one nonempty trimmed unassignedLabel.'
    );
  }
  const unassignedLabel = options.unassignedLabel;
  const existingUnassignedIndex = labels.findIndex(
    category => category === unassignedLabel
  );
  if (!Number.isSafeInteger(deleteIndex) || deleteIndex < 0 || deleteIndex >= oldCount) {
    throw new RangeError(`deleteIndex out of bounds (${deleteIndex})`);
  }
  if (existingUnassignedIndex >= 0 && deleteIndex === existingUnassignedIndex) {
    throw new Error('Cannot delete the unassigned category');
  }

  const mapping = new Uint16Array(oldCount);
  const newCategories = [];
  let unassignedNewIndex = -1;

  for (let i = 0; i < oldCount; i++) {
    if (i === existingUnassignedIndex) {
      unassignedNewIndex = newCategories.length;
      newCategories.push(unassignedLabel);
      mapping[i] = unassignedNewIndex;
      continue;
    }
    if (i === deleteIndex) continue;

    const nextIndex = newCategories.length;
    newCategories.push(labels[i]);
    mapping[i] = nextIndex;
  }

  if (unassignedNewIndex < 0) {
    unassignedNewIndex = newCategories.length;
    newCategories.push(unassignedLabel);
  }
  mapping[deleteIndex] = unassignedNewIndex;

  return {
    categories: newCategories,
    mapping,
    unassignedNewIndex,
    keptOldUnassignedIndex:
      existingUnassignedIndex >= 0 ? existingUnassignedIndex : null,
    mergedOldIndices: [deleteIndex]
  };
}

/**
 * Build an index mapping that merges one category into another.
 * The merged-away category is removed from the output categories list.
 *
 * @param {Array<string|number|boolean>} categories
 * @param {number} fromIndex
 * @param {number} toIndex
 * @returns {{
 *   categories: Array<string|number|boolean>,
 *   mapping: Uint16Array,
 *   targetNewIndex: number
 * }}
 */
export function buildMergeCategoriesTransform(categories, fromIndex, toIndex) {
  const labels = requireCategories(categories);
  const oldCount = labels.length;

  if (!Number.isSafeInteger(fromIndex) || fromIndex < 0 || fromIndex >= oldCount) {
    throw new RangeError(`fromIndex out of bounds (${fromIndex})`);
  }
  if (!Number.isSafeInteger(toIndex) || toIndex < 0 || toIndex >= oldCount) {
    throw new RangeError(`toIndex out of bounds (${toIndex})`);
  }
  if (fromIndex === toIndex) {
    throw new Error('Cannot merge a category into itself');
  }

  const targetNewIndex = toIndex > fromIndex ? toIndex - 1 : toIndex;
  const mapping = new Uint16Array(oldCount);

  for (let i = 0; i < oldCount; i++) {
    if (i === fromIndex) {
      mapping[i] = targetNewIndex;
      continue;
    }
    mapping[i] = i > fromIndex ? i - 1 : i;
  }

  const newCategories = labels.filter((_, idx) => idx !== fromIndex);

  return { categories: newCategories, mapping, targetNewIndex };
}

/**
 * Apply an old-index -> new-index mapping to a codes array.
 *
 * @param {Uint8Array|Uint16Array} codes
 * @param {Uint16Array} mapping
 * @param {number} newCategoryCount
 * @returns {Uint8Array|Uint16Array}
 */
export function applyCategoryIndexMapping(codes, mapping, newCategoryCount) {
  if (!(codes instanceof Uint8Array) && !(codes instanceof Uint16Array)) {
    throw new TypeError('Category remapping requires Uint8Array or Uint16Array codes.');
  }
  if (!(mapping instanceof Uint16Array) || mapping.length === 0) {
    throw new TypeError('Category remapping requires a nonempty Uint16Array mapping.');
  }
  if (!Number.isSafeInteger(newCategoryCount) || newCategoryCount < 1) {
    throw new RangeError('Category remapping requires at least one category.');
  }
  const outputStorage = categoricalStorageForCount(
    newCategoryCount,
    'Category remapping'
  );
  for (let index = 0; index < mapping.length; index++) {
    if (mapping[index] >= newCategoryCount) {
      throw new RangeError(`Category mapping ${index} is outside the new category inventory.`);
    }
  }
  const { missingValue: inputMissingCode } = categoricalStorageForCodes(
    codes,
    'Category remapping'
  );
  for (let index = 0; index < codes.length; index++) {
    if (codes[index] >= mapping.length && codes[index] !== inputMissingCode) {
      throw new RangeError(`Category code ${index} is outside the old category inventory.`);
    }
  }

  const ArrayType = outputStorage.TypedArrayClass;
  const outputMissingCode = outputStorage.missingValue;
  const out = new ArrayType(codes.length);
  for (let i = 0; i < codes.length; i++) {
    const oldIndex = codes[i];
    out[i] = oldIndex === inputMissingCode
      ? outputMissingCode
      : mapping[oldIndex];
  }
  return out;
}
