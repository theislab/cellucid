/**
 * @fileoverview The names community annotation keys a field and its
 * categories on: the dataset's own names, never a local rename.
 *
 * A rename in this browser (`state/managers/field/overlay-public.js`
 * `renameField`, `renameCategory`) keeps the dataset's names in
 * `_originalKey` and `_originalCategories`. The shared repository knows the
 * dataset's names only, so every place that reads or writes community
 * annotation (the legend, the voting dialog, the `annotation.*` actions, the
 * consensus column, the field lock) keys on these, and shows the local name
 * as a display name only. A rename can come back with a history jump, a
 * session or the autosave; keyed on the dataset's names, nothing it touches
 * moves in the repository.
 *
 * @module app/community-annotations/field-names
 */

/**
 * The field's key in the shared repository: its key in the dataset.
 * @param {{key: string, _originalKey?: string}} field
 * @returns {string}
 */
export function annotationFieldKey(field) {
  return typeof field?._originalKey === 'string' ? field._originalKey : field.key;
}

/**
 * The field's categories in the shared repository: the dataset's labels, in
 * the same positions as `field.categories` (a rename keeps each position).
 * @param {{categories?: unknown[], _originalCategories?: unknown[]}} field
 * @returns {unknown[]}
 */
export function annotationCategories(field) {
  if (Array.isArray(field?._originalCategories)) return field._originalCategories;
  return Array.isArray(field?.categories) ? field.categories : [];
}

/**
 * Whether the field or one of its categories shows a local name.
 * @param {object} field
 */
export function hasLocalNames(field) {
  if (annotationFieldKey(field) !== field.key) return true;
  const original = annotationCategories(field);
  return original !== field.categories && original.some((label, index) => label !== field.categories[index]);
}

/**
 * The shown (not deleted) column of the cells whose dataset key is `key`,
 * with its position, or null.
 * @param {{getFields: () => object[]}} state
 * @param {string} key
 * @returns {{field: object, index: number}|null}
 */
export function fieldByAnnotationKey(state, key) {
  const fields = state?.getFields?.() ?? [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field && field._isDeleted !== true && annotationFieldKey(field) === key) return { field, index };
  }
  return null;
}
