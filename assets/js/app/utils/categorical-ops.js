/**
 * Categorical field operations (pure utilities).
 *
 * Centralizes category-index transforms used by categorical edits (merge
 * categories, delete-to-unassigned, group categories into a new field) so
 * state/UI code stays DRY.
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
import { isCategoricalCodes } from '../../data/categorical-storage-contract.js';
import { getCategoryColor } from '../../data/palettes.js';
import { settleDistinctCategoryColors } from '../../data/distinct-colors.js';
import { carriedCategoryState } from './category-state.js';

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
 * unassigned variants) into a single "Unassigned" category (by default).
 *
 * The output mapping is defined for indices `[0, categories.length)`.
 * Codes outside that range are expected to be handled by the caller.
 *
 * @param {Array<string|number|boolean>} categories
 * @param {number} deleteIndex
 * @param {{unassignedLabel: string}} options
 * @returns {{
 *   categories: Array<string|number|boolean>,
 *   mapping: Uint32Array,
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

  const mapping = new Uint32Array(oldCount);
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
 *   mapping: Uint32Array,
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
  const mapping = new Uint32Array(oldCount);

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
 * @param {Uint8Array|Uint16Array|Uint32Array} codes
 * @param {Uint32Array} mapping
 * @param {number} newCategoryCount
 * @returns {Uint8Array|Uint16Array|Uint32Array}
 */
export function applyCategoryIndexMapping(codes, mapping, newCategoryCount) {
  if (!isCategoricalCodes(codes)) {
    throw new TypeError('Category remapping requires Uint8Array, Uint16Array or Uint32Array codes.');
  }
  if (!(mapping instanceof Uint32Array) || mapping.length === 0) {
    throw new TypeError('Category remapping requires a nonempty Uint32Array mapping.');
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

/**
 * One view's colors and category visibility, carried into the categories of
 * a delete-to-unassigned edit: every kept category keeps its own; the
 * unassigned category keeps those of the unassigned category it already was,
 * or else is shown in the palette color of its index when that can be told
 * apart from the kept ones (`distinct-colors.js`), else in the next one that
 * can.
 *
 * @param {ReturnType<typeof buildDeleteToUnassignedTransform>} transform
 * @param {{colors: Uint8Array, visible: Uint8Array}} state - by old index (`category-state.js`)
 * @returns {{colors: Uint8Array, visible: Uint8Array}} by new index
 */
export function carryCategoryStateThroughDelete(transform, state) {
  const count = transform.categories.length;
  const from = new Int32Array(count).fill(-1);
  const unassignedOld = transform.keptOldUnassignedIndex;
  if (unassignedOld !== null) from[transform.unassignedNewIndex] = unassignedOld;
  const merged = new Set(transform.mergedOldIndices);
  for (let oldIndex = 0; oldIndex < transform.mapping.length; oldIndex++) {
    if (oldIndex === unassignedOld || merged.has(oldIndex)) continue;
    from[transform.mapping[oldIndex]] = oldIndex;
  }
  const carried = carriedCategoryState(state, count, index => from[index], getCategoryColor);
  settleDistinctCategoryColors(carried.colors, index => from[index] < 0);
  return carried;
}

/**
 * One view's colors and category visibility, carried into the categories of
 * a merge: the merged category takes the color of the one dragged onto the
 * other and is shown while either was; every other category keeps its own.
 *
 * @param {ReturnType<typeof buildMergeCategoriesTransform>} transform
 * @param {number} fromIndex - The dragged category, by old index.
 * @param {number} toIndex - The category it was dropped on, by old index.
 * @param {{colors: Uint8Array, visible: Uint8Array}} state - by old index (`category-state.js`)
 * @returns {{colors: Uint8Array, visible: Uint8Array}} by new index
 */
export function carryCategoryStateThroughMerge(transform, fromIndex, toIndex, state) {
  const count = transform.categories.length;
  const from = new Int32Array(count).fill(-1);
  from[transform.targetNewIndex] = fromIndex;
  for (let oldIndex = 0; oldIndex < transform.mapping.length; oldIndex++) {
    if (oldIndex === fromIndex || oldIndex === toIndex) continue;
    from[transform.mapping[oldIndex]] = oldIndex;
  }
  const carried = carriedCategoryState(state, count, index => from[index], getCategoryColor);
  // Shown while either was (the array is still being made: no one shares it).
  if (state.visible[toIndex] === 1) carried.visible[transform.targetNewIndex] = 1;
  return carried;
}

/**
 * One view's colors and category visibility, carried into another category
 * list by category: a category it had keeps its color and visibility, a new
 * one is shown in the palette color of its index when that can be told apart
 * from the others (`distinct-colors.js`), else in the next one that can.
 *
 * @param {Array<string|number|boolean>} previousCategories
 * @param {Array<string|number|boolean>} categories
 * @param {{colors: Uint8Array, visible: Uint8Array}} state - by previous index (`category-state.js`)
 * @returns {{colors: Uint8Array, visible: Uint8Array}} by new index
 */
export function carryCategoryStateByCategory(previousCategories, categories, state) {
  const previousIndexOf = new Map();
  previousCategories.forEach((category, index) => previousIndexOf.set(category, index));
  const from = index => previousIndexOf.get(categories[index]) ?? -1;
  const carried = carriedCategoryState(state, categories.length, from, getCategoryColor);
  settleDistinctCategoryColors(carried.colors, index => from(index) < 0);
  return carried;
}

/**
 * Build an index mapping that groups categories into new ones: each group
 * (a label and the old indices it holds) becomes one category, in the order
 * the groups are given; every category no group holds is kept as it is,
 * after them in its old order, or, with `restLabel`, joins the category of
 * that label (a group's, or one more after the groups).
 *
 * @param {Array<string|number|boolean>} categories
 * @param {Array<{label: string, members: number[]}>} groups - each old index in one group at most
 * @param {string|null} restLabel
 * @returns {{categories: Array<string|number|boolean>, mapping: Uint32Array, firstOf: Int32Array, membersOf: number[][], groupCount: number}}
 *   `firstOf`/`membersOf`: by new index, the old categories it holds (the first, and all);
 *   `groupCount`: the new categories that group (the first ones: the groups, and
 *   with `restLabel` every category, the rest one too), the others kept as they were
 */
export function buildGroupCategoriesTransform(categories, groups, restLabel) {
  const labels = requireCategories(categories);
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new TypeError('Grouping categories requires at least one group.');
  }
  const mapping = new Uint32Array(labels.length);
  const grouped = new Int32Array(labels.length).fill(-1);
  const next = [];
  const membersOf = [];
  const indexOf = new Map();
  groups.forEach((group, groupIndex) => {
    if (typeof group?.label !== 'string' || group.label.length === 0 || indexOf.has(group.label)) {
      throw new TypeError(`Group ${groupIndex} needs a label of its own.`);
    }
    if (!Array.isArray(group.members) || group.members.length === 0) {
      throw new TypeError(`Group ${groupIndex} must hold at least one category.`);
    }
    indexOf.set(group.label, next.length);
    next.push(group.label);
    // In the order the group lists them: its first is the one it is colored as.
    membersOf.push([...group.members]);
    for (const old of group.members) {
      if (!Number.isSafeInteger(old) || old < 0 || old >= labels.length) {
        throw new RangeError(`Group ${groupIndex} holds a category out of bounds (${old}).`);
      }
      if (grouped[old] !== -1) throw new Error(`Category ${old} is in two groups.`);
      grouped[old] = groupIndex;
    }
  });
  for (let old = 0; old < labels.length; old++) {
    if (grouped[old] !== -1) {
      mapping[old] = grouped[old];
      continue;
    }
    let target;
    if (restLabel !== null) {
      if (!indexOf.has(restLabel)) {
        indexOf.set(restLabel, next.length);
        next.push(restLabel);
        membersOf.push([]);
      }
      target = indexOf.get(restLabel);
    } else {
      if (indexOf.has(labels[old])) throw new Error(`Category ${old} is kept under a label a group takes.`);
      indexOf.set(labels[old], next.length);
      target = next.length;
      next.push(labels[old]);
      membersOf.push([]);
    }
    mapping[old] = target;
    membersOf[target].push(old);
  }
  const firstOf = Int32Array.from(membersOf, members => (members.length === 0 ? -1 : members[0]));
  return { categories: next, mapping, firstOf, membersOf, groupCount: restLabel === null ? groups.length : next.length };
}

/**
 * One view's colors and category visibility, carried into the categories of
 * a grouping: a kept category keeps its own; each group, in order, takes the
 * color of the first category it holds when that can be told apart from the
 * kept categories' and the earlier groups' (`distinct-colors.js`), else the
 * next palette color that can (two groups whose first categories are gold
 * and orange would look like one); each is shown while any of its
 * categories was.
 *
 * @param {ReturnType<typeof buildGroupCategoriesTransform>} transform
 * @param {{colors: Uint8Array, visible: Uint8Array}} state - by old index (`category-state.js`)
 * @returns {{colors: Uint8Array, visible: Uint8Array}} by new index
 */
export function carryCategoryStateThroughGroup(transform, state) {
  const carried = carriedCategoryState(state, transform.categories.length, index => transform.firstOf[index], getCategoryColor);
  settleDistinctCategoryColors(carried.colors, index => index < transform.groupCount);
  // Shown while any of its categories was (the array is still being made: no one shares it).
  transform.membersOf.forEach((members, index) => {
    if (members.some(old => state.visible[old] === 1)) carried.visible[index] = 1;
  });
  return carried;
}
