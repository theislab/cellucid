/**
 * @fileoverview The coloring a dataset opens with when nothing chose one.
 *
 * A dataset whose catalog names no starting view (a person's own file, a
 * link, a served object) would open with every cell gray and Color by on
 * None. It opens colored by its best categorical field
 * (`utils/field-roles.js` `firstColoringCandidates`: a cell type name first,
 * then the other ranks; never a sample, an id or a quality flag), shown in
 * Color by like any choice. A field only its order recommends is read
 * first to count its categories (2 to the palette's designed colors, else
 * the next). It runs before the dataset's history starts, so it is part of
 * the state the history opens on, not a step.
 *
 * @module app/first-coloring
 */

import { firstColoringCandidates, isModestCategoryCount } from './utils/field-roles.js';

/** The categories a categorical field is known to hold, or null before it is read. */
function categoryCountOf(field) {
  if (Array.isArray(field?.categories)) return field.categories.length;
  return Number.isInteger(field?.categoryCount) ? field.categoryCount : null;
}

/**
 * Color the cells by the dataset's first coloring, when none is shown.
 *
 * @param {{state: object, activateField: (index: number, options: {signal: AbortSignal}) => Promise<unknown>, signal: AbortSignal}} options
 * @returns {Promise<string|null>} the field's key, or null when none was chosen
 */
export async function colorByFirstField({ state, activateField, signal }) {
  if (state.activeFieldSource !== null) return null;
  const fields = (state.obsData?.fields ?? [])
    .map((field, index) => ({ field, index }))
    .filter(({ field }) => field?.kind === 'category' && field._isDeleted !== true)
    .map(({ field, index }) => ({ key: field.key, index, categoryCount: categoryCountOf(field) }));
  for (const candidate of firstColoringCandidates(fields)) {
    if (signal.aborted) return null;
    if (!candidate.ranked && candidate.categoryCount === null) {
      const loaded = await state.ensureFieldLoaded(candidate.index, { signal, silent: true });
      if (!isModestCategoryCount(categoryCountOf(loaded))) continue;
    }
    await activateField(candidate.index, { signal });
    return candidate.key;
  }
  return null;
}
