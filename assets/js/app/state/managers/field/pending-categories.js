/**
 * Category state a session (or a published starting view) restored for
 * labels the open cells do not hold yet.
 *
 * A text or boolean column's categories are the labels its open cells hold
 * (`discovered`, `data/discovered-categories.js`): on a subsample, a label the
 * session was saved with may belong only to cells that are not open. Its
 * legend visibility and colour are held here, by label, and applied when
 * cells holding it open and the column grows that category
 * (`category-growth.js`). So for a categorical whose dictionary has more
 * categories than there are open cells and than one request reads: it is
 * coded by the categories its open cells hold (`storedCategoryCount`,
 * `AnnDataReader._readPresentCategorical`), and marked `discovered` when
 * loaded. Any other stored dictionary never lacks a label of the same
 * dataset, so nothing is held for it.
 *
 * Held per field object: each view's field carries its own state.
 *
 * @module state/managers/field/pending-categories
 */

import { withCategoryChanges } from '../../../utils/category-state.js';

/** @type {WeakMap<object, {visibility: Map<string|boolean, boolean>, colors: Map<string|boolean, number[]>}>} */
const PENDING = new WeakMap();

/**
 * Hold restored category state for labels `field` does not have yet,
 * replacing what was held for it before (a restore is the whole state).
 *
 * @param {object} field
 * @param {{visibility: Array<{categoryName: string|boolean, visible: boolean}>, colors: Array<{categoryName: string|boolean, color: number[]}>}} pending
 * @returns {number} How many categories are held
 */
export function holdPendingCategoryState(field, { visibility, colors }) {
  const held = {
    visibility: new Map(visibility.map(({ categoryName, visible }) => [categoryName, visible])),
    colors: new Map(colors.map(({ categoryName, color }) => [categoryName, [...color]])),
  };
  const labels = new Set([...held.visibility.keys(), ...held.colors.keys()]);
  if (labels.size === 0) PENDING.delete(field);
  else PENDING.set(field, held);
  return labels.size;
}

/** Forget what was held for `field` (its filters were restored or reset anew). */
export function forgetPendingCategoryState(field) {
  PENDING.delete(field);
}

/**
 * Apply what was held for the labels `field` has now (its categories grew),
 * into its per-category visibility and colours; the caller makes visibility
 * and colours again from them, as it does for every category a growth
 * carries.
 *
 * @param {object} state - The data state (`ensureCategoryMetadata`)
 * @param {object} field
 * @returns {number} How many categories were applied
 */
export function applyPendingCategoryState(state, field) {
  const held = PENDING.get(field);
  if (held === undefined) return 0;
  const place = new Map(field.categories.map((category, index) => [category, index]));
  state.ensureCategoryMetadata(field);
  const visibility = [];
  const colors = [];
  for (const [label, visible] of held.visibility) {
    const index = place.get(label);
    if (index === undefined) continue;
    visibility.push({ index, visible });
    held.visibility.delete(label);
  }
  for (const [label, color] of held.colors) {
    const index = place.get(label);
    if (index === undefined) continue;
    colors.push({ index, rgb: color });
    held.colors.delete(label);
  }
  withCategoryChanges(field, { visibility, colors });
  const applied = visibility.length + colors.length;
  if (held.visibility.size === 0 && held.colors.size === 0) PENDING.delete(field);
  return applied;
}
