/**
 * Field constants + helpers used across the app.
 *
 * Why this exists:
 * - Avoids magic strings (`'obs'`, `'var'`, `'category'`, …) sprinkled everywhere
 * - Makes refactors safer (single source of truth)
 * - Enables lightweight "type safety" via well-known enums + validators
 *
 * This file is intentionally dependency-free.
 */

export const FieldKind = Object.freeze({
  CATEGORY: 'category',
  CONTINUOUS: 'continuous'
});

export const FieldSource = Object.freeze({
  OBS: 'obs',
  VAR: 'var'
});

export const ChangeType = Object.freeze({
  RENAME: 'rename',
  CATEGORY_RENAME: 'category-rename',
  DELETE: 'delete',
  RESTORE: 'restore',
  CREATE: 'create',
  UPDATE: 'update'
});

export const OverlapStrategy = Object.freeze({
  FIRST: 'first',
  LAST: 'last',
  OVERLAP_LABEL: 'overlap-label',
  INTERSECTIONS: 'intersections'
});

export const Limits = Object.freeze({
  MAX_FIELD_KEY_LENGTH: 256,
  MAX_CATEGORY_LABEL_LENGTH: 256,
  MAX_USER_DEFINED_FIELDS: 20,
  MAX_INTERSECTION_PAGES: 12,
  MAX_CATEGORIES_PER_FIELD: 255 // keeps codes in Uint8 for user-defined categoricals
});

/**
 * Generate a stable composite identifier for a field.
 * Used for registries that must survive display renames.
 * @param {string} source - 'obs' | 'var'
 * @param {string} fieldKey - Original field key
 * @returns {string} Composite key 'source:fieldKey'
 */
export function makeFieldId(source, fieldKey) {
  return `${source}:${fieldKey}`;
}

/**
 * Parse a composite field identifier back into its parts.
 * @param {string} fieldId
 * @returns {{ source: string, fieldKey: string }}
 */
export function parseFieldId(fieldId) {
  const colonIndex = String(fieldId || '').indexOf(':');
  if (colonIndex === -1) {
    return { source: FieldSource.OBS, fieldKey: String(fieldId || '') };
  }
  return {
    source: fieldId.slice(0, colonIndex),
    fieldKey: fieldId.slice(colonIndex + 1)
  };
}

let _idCounter = 0;

/**
 * Generate a reasonably-unique runtime ID (sufficient for client-only state).
 * @param {string} [prefix='id']
 * @returns {string}
 */
export function generateId(prefix = 'id') {
  _idCounter += 1;
  return `${prefix}_${Date.now()}_${_idCounter}`;
}
