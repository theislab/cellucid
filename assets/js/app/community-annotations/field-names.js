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

import { categoryLabel } from '../actions/targets/names.js';
import { isAnnotationExactNonblank } from './wire-contract.js';

/**
 * The field's key in the shared repository: its key in the dataset.
 * @param {{key: string, _originalKey?: string}} field
 * @returns {string}
 */
export function annotationFieldKey(field) {
  return typeof field?._originalKey === 'string' ? field._originalKey : field.key;
}

/**
 * The field's categories in the shared repository: the dataset's labels as
 * text, as the legend shows them (a Loom `ClusterID` of numbers is "0",
 * "1", …; a boolean "true"), in the same positions as `field.categories` (a
 * rename keeps each position). The repository keys categories by name; the
 * numbers themselves made the session refuse the field, and coloring by it
 * failed (bug hunt live pass 5, L18-8).
 * @param {{categories?: unknown[], _originalCategories?: unknown[]}} field
 * @returns {string[]}
 */
export function annotationCategories(field) {
  const categories = Array.isArray(field?._originalCategories)
    ? field._originalCategories
    : (Array.isArray(field?.categories) ? field.categories : []);
  return categories.map(categoryLabel);
}

/**
 * Whether the repository can key these categories (`annotationCategories`):
 * each nonblank without spaces at its ends, none twice. A field whose
 * categories it cannot key is not open to community annotation; it is still
 * shown and colored as any other.
 * @param {string[]} categories
 */
export function annotationKeyable(categories) {
  return categories.every(isAnnotationExactNonblank) && new Set(categories).size === categories.length;
}

/**
 * Whether the field or one of its categories shows a local name.
 * @param {object} field
 */
export function hasLocalNames(field) {
  if (annotationFieldKey(field) !== field.key) return true;
  const original = annotationCategories(field);
  const shown = Array.isArray(field?.categories) ? field.categories : [];
  return original.some((label, index) => label !== categoryLabel(shown[index]));
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
