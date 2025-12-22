/**
 * @fileoverview DataState field operations (public surface).
 *
 * This module contains user-facing field operations (renames, deletes/restores,
 * duplication, and applying rename/delete overlays). It is mixed into DataState
 * via `state/managers/field-manager.js`.
 *
 * @module state/managers/field/overlay-public
 */

import { StateValidator } from '../../../utils/state-validator.js';
import { ChangeType, FieldKind, FieldSource } from '../../../utils/field-constants.js';
import { getFieldRegistry } from '../../../utils/field-registry.js';
import { makeUniqueLabel } from '../../../utils/label-utils.js';

export class FieldOverlayPublicMethods {
  // --- Existing API -------------------------------------------------------------

  getFields() {
    return this.obsData?.fields || [];
  }

  getVarFields() {
    return this.varData?.fields || [];
  }

  getActiveField() {
    if (this.activeFieldSource === 'var') {
      return this.getVarFields()[this.activeVarFieldIndex];
    }
    return this.getFields()[this.activeFieldIndex];
  }

  // --- Field operations (rename / delete / user-defined) ----------------------

  getRenameRegistry() { return this._renameRegistry; }
  getDeleteRegistry() { return this._deleteRegistry; }
  getUserDefinedFieldsRegistry() { return this._userDefinedFields; }

  /**
   * Apply rename/delete overlays stored in registries to the currently loaded field metadata.
   * This is safe to call during view switching because it does not touch render buffers.
   */
  applyFieldOverlays() {
    this._applyOverlaysToFields(this.obsData?.fields, FieldSource.OBS);
    this._applyOverlaysToFields(this.varData?.fields, FieldSource.VAR);
    this._injectUserDefinedFields();

    // Keep active selection pointing at a non-deleted field (buffers remain untouched).
    this._ensureActiveSelectionNotDeleted();

    getFieldRegistry().invalidate();
    this._syncActiveContext();
  }

  getVisibleFields(source) {
    return getFieldRegistry().getVisibleFields(source);
  }

  isFieldDeleted(source, fieldIndex) {
    const fields = source === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;
    return fields?.[fieldIndex]?._isDeleted === true;
  }

  renameField(source, fieldIndex, newKey) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const fields = src === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;

    try {
      StateValidator.validateFieldIndex(fieldIndex, fields);
      StateValidator.validateFieldKey(newKey);
    } catch (e) {
      console.error('[State] renameField validation failed:', e.message);
      return false;
    }

    if (StateValidator.isDuplicateKey(newKey, fields, fieldIndex)) {
      console.error('[State] renameField: duplicate key', newKey);
      return false;
    }

    const field = fields[fieldIndex];
    if (!field) return false;

    const isUserDefined = field._isUserDefined === true && field._userDefinedId;

    if (!field._originalKey) {
      field._originalKey = field.key;
    }

    const originalKey = field._originalKey;
    const previousKey = field.key;

    if (newKey === originalKey) {
      field.key = originalKey;
      delete field._originalKey;
      if (!isUserDefined) {
        this._renameRegistry.revertFieldRename(src, originalKey);
      }
    } else {
      field.key = newKey;
      if (!isUserDefined) {
        this._renameRegistry.setFieldRename(src, originalKey, newKey);
      }
    }

    if (isUserDefined) {
      this._userDefinedFields?.updateField?.(field._userDefinedId, { key: field.key });
    }

    this._refreshHighlightGroupsForField(src, fieldIndex);
    getFieldRegistry().invalidate();
    this.updateFilterSummary();
    this._syncActiveContext();
    this._notifyFieldChange(src, fieldIndex, ChangeType.RENAME, { originalKey, previousKey, newKey: field.key });
    return true;
  }

  /**
   * Revert a field rename back to its original key (if renamed).
   * @param {string} source - 'obs' | 'var'
   * @param {number} fieldIndex
   * @returns {boolean}
   */
  revertFieldRename(source, fieldIndex) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const fields = src === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;

    try {
      StateValidator.validateFieldIndex(fieldIndex, fields);
    } catch (e) {
      console.error('[State] revertFieldRename validation failed:', e.message);
      return false;
    }

    const field = fields[fieldIndex];
    if (!field) return false;
    if (!field._originalKey) return true;
    return this.renameField(src, fieldIndex, field._originalKey);
  }

  renameCategory(source, fieldIndex, categoryIndex, newLabel) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const fields = src === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;

    try {
      StateValidator.validateFieldIndex(fieldIndex, fields);
      const field = fields[fieldIndex];
      StateValidator.validateCategoryIndex(categoryIndex, field);
      StateValidator.validateCategoryLabel(newLabel);
    } catch (e) {
      console.error('[State] renameCategory validation failed:', e.message);
      return false;
    }

    const field = fields[fieldIndex];
    const isUserDefined = field._isUserDefined === true && field._userDefinedId;

    if (!field._originalCategories) {
      field._originalCategories = [...field.categories];
    }

    const originalFieldKey = field._originalKey || field.key;
    const originalLabel = field._originalCategories?.[categoryIndex] ?? field.categories[categoryIndex];

    if (newLabel === String(originalLabel)) {
      // Revert this category label to its original.
      field.categories[categoryIndex] = originalLabel;
      if (!isUserDefined) {
        this._renameRegistry.revertCategoryRename(src, originalFieldKey, categoryIndex);
      }
    } else {
      field.categories[categoryIndex] = newLabel;
      if (!isUserDefined) {
        this._renameRegistry.setCategoryRename(src, originalFieldKey, categoryIndex, newLabel);
      }
    }

    if (isUserDefined && Array.isArray(field._originalCategories)) {
      const hasAnyRename = field.categories.some((label, idx) => String(label) !== String(field._originalCategories[idx]));
      if (!hasAnyRename) {
        delete field._originalCategories;
      }
    }

    // Keep centroid labels consistent with the category list.
    this._syncCentroidCategoryLabelAtIndex(field, categoryIndex);
    this._refreshHighlightGroupsForField(src, fieldIndex);

    // If this field is currently active, push centroid label updates.
    if (src === FieldSource.OBS && this.activeFieldSource === FieldSource.OBS && this.activeFieldIndex === fieldIndex) {
      this.buildCentroidsForField(field);
      this._pushCentroidsToViewer();
    }

    this.updateFilterSummary();
    this._syncActiveContext();
    this._notifyFieldChange(src, fieldIndex, ChangeType.CATEGORY_RENAME, { categoryIndex, newLabel: field.categories[categoryIndex] });
    return true;
  }

  deleteField(source, fieldIndex) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const fields = src === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;

    try {
      StateValidator.validateFieldIndex(fieldIndex, fields);
    } catch (e) {
      console.error('[State] deleteField validation failed:', e.message);
      return false;
    }

    const field = fields[fieldIndex];
    if (!field) return false;

    if (field._isUserDefined && field._userDefinedId) {
      return this.deleteUserDefinedField(field._userDefinedId, src);
    }

    const originalKey = field._originalKey || field.key;
    this._deleteRegistry.markDeleted(src, originalKey);
    field._isDeleted = true;

    const wasActive =
      (src === FieldSource.OBS && this.activeFieldSource === FieldSource.OBS && this.activeFieldIndex === fieldIndex) ||
      (src === FieldSource.VAR && this.activeFieldSource === FieldSource.VAR && this.activeVarFieldIndex === fieldIndex);

    if (wasActive) {
      this.clearActiveField();
    }

    if (src === FieldSource.VAR) {
      // Free memory when possible; preserveActive prevents unloading if any view still references it.
      this.unloadVarField(fieldIndex, { preserveActive: true });
    }

    getFieldRegistry().invalidate();
    if (!wasActive) this.computeGlobalVisibility();
    this.updateFilterSummary();
    this._notifyFieldChange(src, fieldIndex, ChangeType.DELETE, { originalKey });
    return true;
  }

  /**
   * Permanently confirm a deleted field so it is no longer restorable.
   *
   * This is intentionally destructive and should only be called from a user
   * confirmation flow (e.g., the Deleted Fields "Confirm" button).
   *
   * @param {'obs'|'var'} source
   * @param {number} fieldIndex
   * @returns {boolean}
   */
  purgeDeletedField(source, fieldIndex) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const fields = src === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;

    try {
      StateValidator.validateFieldIndex(fieldIndex, fields);
    } catch (e) {
      console.error('[State] purgeDeletedField validation failed:', e.message);
      return false;
    }

    const field = fields?.[fieldIndex];
    if (!field) return false;
    if (field._isDeleted !== true) return false;
    if (field._isPurged === true) return true;

    const isUserDefined = field._isUserDefined === true && field._userDefinedId;

    if (isUserDefined) {
      field._isPurged = true;
      const template = this._userDefinedFields?.getField?.(field._userDefinedId);
      if (template) {
        template._isDeleted = true;
        template._isPurged = true;
      }
    } else {
      const originalKey = field._originalKey || field.key;
      this._deleteRegistry.markPurged(src, originalKey);
      field._isDeleted = true;
      field._isPurged = true;
    }

    getFieldRegistry().invalidate();
    this.computeGlobalVisibility();
    this.updateFilterSummary();
    this._notifyFieldChange(src, fieldIndex, ChangeType.UPDATE, { purged: true, userDefinedId: field._userDefinedId || null });
    return true;
  }

  /**
   * Restore a soft-deleted field.
   *
   * Returns a structured result (instead of a boolean) so the UI can surface
   * auto-rename details when restoring would create a duplicate visible key.
   *
   * @param {string} source - 'obs' | 'var'
   * @param {number} fieldIndex
   * @returns {{
   *   ok: boolean,
   *   originalKey?: string,
   *   key?: string,
   *   userDefinedId?: (string|null),
   *   renamedFrom?: (string|null),
   *   renamedTo?: (string|null)
   * }}
   */
  restoreField(source, fieldIndex) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const fields = src === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;
    const field = fields?.[fieldIndex];
    if (!field) return { ok: false };

    if (field._isPurged === true) {
      console.warn('[State] restoreField: cannot restore a confirmed deletion');
      return { ok: false };
    }

    const isUserDefined = field._isUserDefined === true && field._userDefinedId;
    const originalKey = field._originalKey || field.key;

    if (isUserDefined) {
      delete field._isDeleted;
      const template = this._userDefinedFields?.getField?.(field._userDefinedId);
      if (template) delete template._isDeleted;
    } else {
      this._deleteRegistry.markRestored(src, originalKey);
      delete field._isDeleted;
    }

    // If restoring causes a key conflict, auto-rename the restored field to keep
    // visible field keys unique (prevents selectors/filters from breaking).
    let renamedFrom = null;
    let renamedTo = null;
    const existingKeys = (fields || [])
      .map((f, idx) => ({ f, idx }))
      .filter(({ f, idx }) => idx !== fieldIndex && f && f._isDeleted !== true)
      .map(({ f }) => f.key);

    if (existingKeys.includes(field.key)) {
      renamedFrom = field.key;
      renamedTo = makeUniqueLabel(`${field.key} (restored)`, existingKeys);

      if (isUserDefined) {
        field.key = renamedTo;
        this._userDefinedFields?.updateField?.(field._userDefinedId, { key: renamedTo });
      } else {
        const okRename = this.renameField(src, fieldIndex, renamedTo);
        if (!okRename) {
          field.key = renamedTo;
        }
      }
    }

    getFieldRegistry().invalidate();
    this.computeGlobalVisibility();
    this.updateFilterSummary();
    this._notifyFieldChange(src, fieldIndex, ChangeType.RESTORE, {
      originalKey,
      userDefinedId: isUserDefined ? field._userDefinedId : null,
      renamedFrom,
      renamedTo
    });
    return {
      ok: true,
      originalKey,
      userDefinedId: isUserDefined ? field._userDefinedId : null,
      renamedFrom,
      renamedTo,
      key: field.key
    };
  }

  /**
   * Duplicate a field as a new user-defined field.
   *
   * - Categorical obs: deep-copies codes + categories and computes centroids.
   * - Continuous obs/var: creates a continuous alias that re-materializes values from
   *   the referenced source field when loading state snapshots.
   *
   * This is a non-destructive operation (the source field remains intact).
   *
   * @param {'obs'|'var'} source
   * @param {number} fieldIndex
   * @param {object} [options]
   * @param {string} [options.newKey]
   * @returns {Promise<{ newFieldIndex: number, newKey: string }|null>}
   */
  async duplicateField(source, fieldIndex, options = {}) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const fields = src === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;

    try {
      StateValidator.validateFieldIndex(fieldIndex, fields);
    } catch (e) {
      console.error('[State] duplicateField validation failed:', e.message);
      return null;
    }

    const field = fields?.[fieldIndex];
    if (!field || field._isDeleted === true) return null;

    // Ensure the source field has its heavy data materialized first.
    try {
      if (src === FieldSource.VAR) {
        await this.ensureVarFieldLoaded(fieldIndex);
      } else {
        await this.ensureFieldLoaded(fieldIndex);
      }
    } catch (err) {
      console.error('[State] duplicateField load failed:', err);
      return null;
    }

    const existingKeys = (fields || []).filter((f) => f && f._isDeleted !== true).map((f) => f.key);
    const baseKey = String(options.newKey || `${field.key} (copy)`).trim() || `${field.key} (copy)`;
    const newKey = makeUniqueLabel(baseKey, existingKeys);

    // ---------------------------------------------------------------------
    // Categorical obs: deep copy codes so subsequent merges don't affect the original.
    // ---------------------------------------------------------------------
    if (field.kind === FieldKind.CATEGORY) {
      if (src !== FieldSource.OBS) {
        console.warn('[State] duplicateField: categorical var fields are not supported');
        return null;
      }

      const categories = Array.isArray(field.categories) ? [...field.categories] : [];
      const codes = field.codes;
      if (!codes || typeof codes.length !== 'number') return null;
      const codesCopy = typeof codes.slice === 'function' ? codes.slice() : codes;

      const sourceKey = field._sourceField?.sourceKey || field._originalKey || field.key;
      const created = this._userDefinedFields.createFromCategoricalCodes(
        {
          key: newKey,
          categories,
          codes: codesCopy,
          source: FieldSource.OBS,
          meta: {
            _sourceField: {
              kind: 'categorical-obs',
              sourceKey,
              sourceIndex: fieldIndex
            },
            _operation: {
              type: 'copy-field',
              source: FieldSource.OBS,
              sourceKey
            }
          }
        },
        this
      );

      // Carry forward category UI state (colors/visibility) as a convenience.
      try {
        this.ensureCategoryMetadata(field);
        const colors = (field._categoryColors || []).map((c) => (Array.isArray(c) ? [...c] : c));
        const visible = { ...(field._categoryVisible || {}) };
        created.field._categoryColors = colors;
        created.field._categoryVisible = visible;
        created.field._categoryFilterEnabled = field._categoryFilterEnabled ?? true;
        if (field._colormapId) created.field._colormapId = field._colormapId;
      } catch (err) {
        console.warn('[State] duplicateField: failed to carry categorical UI state:', err);
      }

      fields.push(created.field);
      const newFieldIndex = fields.length - 1;

      getFieldRegistry().invalidate();
      this._syncActiveContext();
      this._notifyFieldChange(FieldSource.OBS, newFieldIndex, ChangeType.CREATE, { userDefinedId: created.id });

      return { newFieldIndex, newKey };
    }

    // ---------------------------------------------------------------------
    // Continuous obs/var: create an alias that can be re-materialized on load.
    // ---------------------------------------------------------------------
    if (field.kind === FieldKind.CONTINUOUS) {
      const sourceKey = field._originalKey || field.key;
      const kind = src === FieldSource.VAR ? 'gene-expression' : 'continuous-obs';
      const created = this._userDefinedFields.createContinuousAlias({
        key: newKey,
        source: src,
        sourceField: { kind, sourceKey, sourceIndex: fieldIndex },
        meta: {
          _operation: { type: 'copy-field', source: src, sourceKey }
        }
      });

      const aliasField = created.field;
      const values = field.values;
      if (values && typeof values.length === 'number') {
        aliasField.values = typeof values.slice === 'function' ? values.slice() : values;
        aliasField.loaded = true;
      }
      if (src === FieldSource.OBS && field.outlierQuantiles) {
        aliasField.outlierQuantiles = field.outlierQuantiles;
      }

      // Carry forward continuous UI state.
      if (field._continuousStats) aliasField._continuousStats = { ...field._continuousStats };
      if (field._continuousFilter) aliasField._continuousFilter = { ...field._continuousFilter };
      if (field._continuousColorRange) aliasField._continuousColorRange = { ...field._continuousColorRange };
      if (field._positiveStats) aliasField._positiveStats = { ...field._positiveStats };
      if (field._useLogScale != null) aliasField._useLogScale = field._useLogScale;
      if (field._useFilterColorRange != null) aliasField._useFilterColorRange = field._useFilterColorRange;
      if (field._filterEnabled != null) aliasField._filterEnabled = field._filterEnabled;
      if (field._outlierFilterEnabled != null) aliasField._outlierFilterEnabled = field._outlierFilterEnabled;
      if (field._outlierThreshold != null) aliasField._outlierThreshold = field._outlierThreshold;
      if (field._colormapId) aliasField._colormapId = field._colormapId;

      fields.push(aliasField);
      const newFieldIndex = fields.length - 1;

      getFieldRegistry().invalidate();
      this._syncActiveContext();
      this._notifyFieldChange(src, newFieldIndex, ChangeType.CREATE, { userDefinedId: created.id });

      return { newFieldIndex, newKey };
    }

    console.warn('[State] duplicateField: unsupported field kind:', field.kind);
    return null;
  }

  deleteUserDefinedField(fieldId, source = FieldSource.OBS) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const fields = src === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;
    const field = fields?.find?.((f) => f && f._userDefinedId === fieldId);
    if (!field) return false;

    // User-defined fields are fully owned by Cellucid and serialized via
    // UserDefinedFieldsRegistry. For dev-phase workflows we treat deletion as
    // a soft-delete so the user can restore derived columns (e.g. after
    // delete→unassigned or drag-merge operations).
    field._isDeleted = true;
    const template = this._userDefinedFields?.getField?.(fieldId);
    if (template) template._isDeleted = true;

    if (src === FieldSource.OBS && this.activeFieldSource === FieldSource.OBS && this.activeFieldIndex >= 0) {
      const active = this.obsData?.fields?.[this.activeFieldIndex];
      if (active && active._userDefinedId === fieldId) this.clearActiveField();
    }
    if (src === FieldSource.VAR && this.activeFieldSource === FieldSource.VAR && this.activeVarFieldIndex >= 0) {
      const active = this.varData?.fields?.[this.activeVarFieldIndex];
      if (active && active._userDefinedId === fieldId) this.clearActiveField();
    }

    getFieldRegistry().invalidate();
    this.computeGlobalVisibility();
    this.updateFilterSummary();
    const fieldIndex = fields?.indexOf(field) ?? -1;
    this._notifyFieldChange(src, fieldIndex, ChangeType.DELETE, { userDefinedId: fieldId, originalKey: field._originalKey || field.key });
    return true;
  }

  isUserDefinedField(source, fieldIndex) {
    if (source !== FieldSource.OBS) return false;
    const field = this.obsData?.fields?.[fieldIndex];
    return field?._isUserDefined === true;
  }
}
