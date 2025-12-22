/**
 * FieldRegistry - Centralized O(1) lookups for obs/var fields.
 *
 * This registry is intentionally a *thin index layer*:
 * - Avoids repeated linear scans across thousands of fields/genes
 * - Uses `_originalKey` when present to make lookups stable across renames
 * - Provides convenience filters (visible, deleted, categorical/continuous)
 *
 * Note: the registry is bound to a DataState instance (see bind()).
 */

import { FieldKind, FieldSource } from './field-constants.js';

class FieldRegistry {
  constructor() {
    this._obsIndex = new Map(); // originalKey -> fieldIndex
    this._varIndex = new Map(); // originalKey -> fieldIndex
    this._state = null;
    this._dirty = true;
  }

  /**
   * Bind to a DataState instance.
   * @param {object} state
   */
  bind(state) {
    this._state = state;
    this._dirty = true;
  }

  /**
   * Mark indices as needing rebuild.
   */
  invalidate() {
    this._dirty = true;
  }

  _rebuild() {
    if (!this._dirty || !this._state) return;

    this._obsIndex.clear();
    this._varIndex.clear();

    const obsFields = this._state.obsData?.fields || [];
    obsFields.forEach((field, idx) => {
      if (!field) return;
      const originalKey = field._originalKey || field.key;
      if (originalKey) this._obsIndex.set(String(originalKey), idx);
    });

    const varFields = this._state.varData?.fields || [];
    varFields.forEach((field, idx) => {
      if (!field) return;
      const originalKey = field._originalKey || field.key;
      if (originalKey) this._varIndex.set(String(originalKey), idx);
    });

    this._dirty = false;
  }

  getIndexByKey(source, originalKey) {
    this._rebuild();
    const map = source === FieldSource.VAR ? this._varIndex : this._obsIndex;
    return map.get(String(originalKey)) ?? -1;
  }

  getByKey(source, originalKey) {
    this._rebuild();
    const index = this.getIndexByKey(source, originalKey);
    if (index < 0) return null;
    const fields = source === FieldSource.VAR ? this._state.varData?.fields : this._state.obsData?.fields;
    return fields?.[index] || null;
  }

  getVisibleFields(source) {
    const fields = source === FieldSource.VAR ? this._state?.varData?.fields : this._state?.obsData?.fields;
    return (fields || [])
      .map((field, index) => ({ field, index }))
      .filter(({ field }) => field && field._isDeleted !== true);
  }

  getDeletedFields(source) {
    const fields = source === FieldSource.VAR ? this._state?.varData?.fields : this._state?.obsData?.fields;
    const result = (fields || [])
      .map((field, index) => ({ field, index }))
      .filter(({ field }) => field && field._isDeleted === true && field._isPurged !== true);

    // Also check user-defined registry for deleted templates not yet in fields array
    const userDefinedRegistry = this._state?._userDefinedFields;
    if (userDefinedRegistry?.getAllFieldsForSource) {
      const existingIds = new Set(result.map(({ field }) => field._userDefinedId).filter(Boolean));
      const templates = userDefinedRegistry.getAllFieldsForSource(source);
      for (const template of templates) {
        if (!template || !template._userDefinedId) continue;
        if (existingIds.has(template._userDefinedId)) continue;
        if (template._isDeleted === true && template._isPurged !== true) {
          // Add template as a "virtual" deleted field with index -1
          result.push({ field: template, index: -1 });
        }
      }
    }

    return result;
  }

  getCategoricalFields(source) {
    return this.getVisibleFields(source).filter(({ field }) => field.kind === FieldKind.CATEGORY);
  }

  getContinuousFields(source) {
    return this.getVisibleFields(source).filter(({ field }) => field.kind === FieldKind.CONTINUOUS);
  }

  getUserDefinedFields() {
    return this.getVisibleFields(FieldSource.OBS).filter(({ field }) => field._isUserDefined === true);
  }
}

let _instance = null;

export function getFieldRegistry() {
  if (!_instance) _instance = new FieldRegistry();
  return _instance;
}

export { FieldRegistry };
