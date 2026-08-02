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

/**
 * How many categories one field may hold is not stated here. That ceiling is a
 * property of the on-disk code width and is derived once, in
 * `data/categorical-storage-contract.js`, alongside the missing-code sentinel
 * it is inseparable from. A copy in this file sat at 255 -- the uint8 ceiling
 * -- and so refused every operation on the uint16 categoricals both exporters
 * write and every reader accepts.
 */
export const Limits = Object.freeze({
  MAX_FIELD_KEY_LENGTH: 256,
  MAX_CATEGORY_LABEL_LENGTH: 256,
  MAX_USER_DEFINED_FIELDS: 20,
  MAX_INTERSECTION_PAGES: 12
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
