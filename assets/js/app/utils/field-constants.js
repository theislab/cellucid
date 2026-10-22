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
 * Generate a stable composite identifier for a field.
 * Used for registries that must survive display renames.
 * @param {string} source - 'obs' | 'var'
 * @param {string} fieldKey - Original field key
 * @returns {string} Composite key 'source:fieldKey'
 */
export function makeFieldId(source, fieldKey) {
  return `${source}:${fieldKey}`;
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
