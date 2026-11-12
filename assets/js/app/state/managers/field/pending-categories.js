/**
 * Category state a session (or a published starting view) restored for
 * labels the open cells do not hold yet.
 *
 * A text or boolean column's categories are the labels its open cells hold
 * (`discovered`, `data/discovered-categories.js`): on a subsample, a label the
 * session was saved with may belong only to cells that are not open. Its
 * legend visibility and color are held here, by label, and applied when
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
 * What is held for `field`, in the order it was held: the hidden labels and
 * the colors (channels from 0 to 1) of labels its open cells do not hold yet.
 * The state domains read it (`app/state/domains/filters.js`, `colors.js`), so
 * a held label is part of the state, not lost on the next capture.
 *
 * @param {object} field
 * @returns {{visibility: Array<{categoryName: string|boolean, visible: boolean}>, colors: Array<{categoryName: string|boolean, color: number[]}>}}
 */
export function pendingCategoryState(field) {
  const held = PENDING.get(field);
  if (held === undefined) return { visibility: [], colors: [] };
  return {
    visibility: [...held.visibility].map(([categoryName, visible]) => ({ categoryName, visible })),
    colors: [...held.colors].map(([categoryName, color]) => ({ categoryName, color: [...color] })),
  };
}

/**
 * Apply what was held for the labels `field` has now (its categories grew),
 * into its per-category visibility and colors; the caller makes visibility
 * and colors again from them, as it does for every category a growth
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

/**
 * The labels held for each field over every view (the focused view's fields
 * and each other view's context), in field order: what a loaded state names
 * that no open cell holds yet, as the person is told after a load
 * (`app/session/session-serializer.js`). A label held in several views, or
 * for both its visibility and its color, is counted once.
 *
 * @param {object} state - The data state (`obsData`, `varData`, `viewContexts`)
 * @returns {Array<{source: 'obs'|'var', key: string, labels: Array<string|boolean>}>}
 */
export function heldCategoriesOf(state) {
  const focused = state.getActiveViewId?.() ?? null;
  const owners = [state];
  if (state.viewContexts instanceof Map) {
    for (const [viewId, context] of state.viewContexts) if (viewId !== focused) owners.push(context);
  }
  const held = new Map();
  for (const owner of owners) {
    for (const [data, source] of [[owner.obsData, 'obs'], [owner.varData, 'var']]) {
      for (const field of data?.fields ?? []) {
        const pending = field !== null && typeof field === 'object' ? PENDING.get(field) : undefined;
        if (pending === undefined) continue;
        const id = `${source}:${field.key}`;
        if (!held.has(id)) held.set(id, { source, key: field.key, labels: new Set() });
        for (const label of [...pending.visibility.keys(), ...pending.colors.keys()]) held.get(id).labels.add(label);
      }
    }
  }
  return [...held.values()].map(({ source, key, labels }) => ({ source, key, labels: [...labels] }));
}
