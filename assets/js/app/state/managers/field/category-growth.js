/**
 * A text or boolean column's categories grown in place: the cells opened
 * later hold labels the open cells did not (`data/discovered-categories.js`);
 * likewise a categorical coded by the categories its open cells hold (its
 * new categories in stored order, `AnnDataReader._readPresentCategorical`).
 * The column keeps every category it showed, by label: the new labels take
 * their places in label order, each category keeps its color, its
 * visibility and its display name (the rename registry, by label), and the
 * codes the page holds are recoded by label. A new label a restored session
 * set a visibility or color for takes it (`pending-categories.js`). Nothing
 * is read again.
 *
 * @module state/managers/field/category-growth
 */

import { categoricalStorageForCodes, categoricalStorageForCount } from '../../../../data/categorical-storage-contract.js';
import { allocateTypedArray } from '../../../../data/sparse-column-index.js';
import { applyPendingCategoryState } from './pending-categories.js';
import { carriedCategoryState } from '../../../utils/category-state.js';

/**
 * Grow one loaded field's categories to `categories` (every label it has,
 * in label order) with their colors (`palette`), recoding `codes` (the
 * cells it holds, under its present categories) when given.
 *
 * @param {Object} state - The data state (`_applyCategoryOverlay`)
 * @param {Object} field - A categorical obs field whose categories were found
 * @param {{categories: ReadonlyArray<string|boolean>, palette: ReadonlyArray<ReadonlyArray<number>>, codes?: ArrayBufferView|null}} grown
 * @param {{source: string, originalKey: string, label: string}} owner
 * @returns {ArrayBufferView|null} `codes` recoded under `categories`, or null
 */
export function growFieldCategories(state, field, { categories, palette, codes = null }, { source, originalKey, label }) {
  const before = Object.hasOwn(field, '_originalCategories') ? field._originalCategories : field.categories;
  const place = new Map(categories.map((category, index) => [category, index]));
  const moved = Int32Array.from(before, category => {
    const index = place.get(category);
    if (index === undefined) throw new Error(`${label} would lose its category ${JSON.stringify(category)}`);
    return index;
  });

  let recoded = null;
  if (codes !== null) {
    const { missingValue: missingBefore } = categoricalStorageForCodes(codes, label);
    const { TypedArrayClass, missingValue } = categoricalStorageForCount(categories.length, label);
    recoded = allocateTypedArray(TypedArrayClass, codes.length, `${label} codes`);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      recoded[i] = code === missingBefore ? missingValue : moved[code];
    }
  }

  // What was set per category goes with its label; a new one opens in its
  // own color, shown.
  if (field._categoryColors !== undefined || field._categoryVisible !== undefined) {
    state.ensureCategoryMetadata(field);
    const from = new Int32Array(categories.length).fill(-1);
    moved.forEach((index, previous) => { from[index] = previous; });
    const carried = carriedCategoryState(
      { colors: field._categoryColors, visible: field._categoryVisible },
      categories.length,
      index => from[index],
      index => palette[index]
    );
    field._categoryColors = carried.colors;
    field._categoryVisible = carried.visible;
  }
  field.palette = palette.map(color => [color[0], color[1], color[2]]);
  field.categories = [...categories];
  delete field._originalCategories;
  state._applyCategoryOverlay(field, source, originalKey, label);
  // What a session restored for labels that were not open yet applies now
  // that cells holding them are (`pending-categories.js`).
  applyPendingCategoryState(state, field);
  return recoded;
}
