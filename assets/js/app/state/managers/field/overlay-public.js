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
import {
  ChangeType,
  FieldKind,
  FieldSource,
  Limits
} from '../../../utils/field-constants.js';
import { getFieldRegistry } from '../../../utils/field-registry.js';
import { makeUniqueLabel } from '../../../utils/label-utils.js';
import { getCategoryColor } from '../../../../data/palettes.js';

function requireSource(source) {
  if (source !== FieldSource.OBS && source !== FieldSource.VAR) {
    throw new TypeError('Field source must be exactly obs or var');
  }
  return source;
}

function requireRecord(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireMethod(owner, methodName, label) {
  if (
    owner === null
    || typeof owner !== 'object'
    || typeof owner[methodName] !== 'function'
  ) {
    throw new TypeError(`${label} must implement ${methodName}()`);
  }
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be exactly boolean`);
  }
  return value;
}

function requireIdentifier(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
  ) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requireField(field, label) {
  requireRecord(field, label);
  StateValidator.validateFieldKey(field.key);
  if (
    field.kind !== FieldKind.CATEGORY
    && field.kind !== FieldKind.CONTINUOUS
  ) {
    throw new TypeError(`${label} has an unsupported kind`);
  }
  return field;
}

function requireInventory(owner, source, { allowAbsent = false } = {}) {
  requireSource(source);
  const data = source === FieldSource.VAR
    ? owner.varData
    : owner.obsData;
  if (allowAbsent && data === null) return [];
  requireRecord(data, `${source} field data`);
  if (!Array.isArray(data.fields)) {
    throw new TypeError(`${source} field inventory must be an array`);
  }
  data.fields.forEach((field, index) => {
    requireField(field, `${source} field inventory[${index}]`);
  });
  return data.fields;
}

function requireFieldAt(owner, source, fieldIndex) {
  const fields = requireInventory(owner, source);
  StateValidator.validateFieldIndex(fieldIndex, fields);
  return { fields, field: fields[fieldIndex], fieldIndex };
}

function requireCategoryField(field, label) {
  requireField(field, label);
  if (field.kind !== FieldKind.CATEGORY) {
    throw new TypeError(`${label} must be categorical`);
  }
  if (!Array.isArray(field.categories) || field.categories.length === 0) {
    throw new TypeError(`${label} categories must be a non-empty array`);
  }
  const seen = new Set();
  for (const category of field.categories) {
    StateValidator.validateCategoryLabel(category);
    if (seen.has(category)) {
      throw new TypeError(`${label} contains duplicate category labels`);
    }
    seen.add(category);
  }
  return field;
}

function requireCategoryPayload(categories, codes, pointCount, label) {
  if (
    !Array.isArray(categories)
    || categories.length === 0
    || categories.length > Limits.MAX_CATEGORIES_PER_FIELD
  ) {
    throw new TypeError(
      `${label} categories must contain from 1 through ${Limits.MAX_CATEGORIES_PER_FIELD} values`
    );
  }
  const seen = new Set();
  for (const category of categories) {
    StateValidator.validateCategoryLabel(category);
    if (seen.has(category)) {
      throw new TypeError(`${label} category labels must be unique`);
    }
    seen.add(category);
  }
  if (
    (!(codes instanceof Uint8Array) && !(codes instanceof Uint16Array))
    || codes.length !== pointCount
  ) {
    throw new TypeError(
      `${label} codes must be an exact dataset-length typed array`
    );
  }
  const missing = codes instanceof Uint8Array ? 255 : 65_535;
  for (let index = 0; index < codes.length; index++) {
    if (codes[index] >= categories.length && codes[index] !== missing) {
      throw new RangeError(
        `${label} code ${index} is outside the category inventory`
      );
    }
  }
}

function requireOriginalKey(field) {
  if (Object.hasOwn(field, '_originalKey')) {
    StateValidator.validateFieldKey(field._originalKey);
    return field._originalKey;
  }
  StateValidator.validateFieldKey(field.key);
  return field.key;
}

function requireUserDefinedOwner(owner) {
  for (const methodName of [
    'computeCentroidsByDim',
    'createContinuousAlias',
    'createFromCategoricalCodes',
    'getField',
    'updateField'
  ]) {
    requireMethod(
      owner._userDefinedFields,
      methodName,
      'User-defined field registry'
    );
  }
  return owner._userDefinedFields;
}

function requireExactOptions(options, allowedKeys, label) {
  requireRecord(options, label);
  for (const key of Object.keys(options)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${label} contains unknown key "${key}"`);
    }
  }
  return options;
}

export class FieldOverlayPublicMethods {
  // --- Existing API -------------------------------------------------------------

  getFields() {
    return requireInventory(this, FieldSource.OBS, { allowAbsent: true });
  }

  getVarFields() {
    return requireInventory(this, FieldSource.VAR, { allowAbsent: true });
  }

  getActiveField() {
    if (this.activeFieldSource === null) {
      if (
        this.activeFieldIndex !== -1 ||
        this.activeVarFieldIndex !== -1
      ) {
        throw new Error(
          'No active field requires both field indices to be -1.'
        );
      }
      return null;
    }
    if (
      this.activeFieldSource !== FieldSource.OBS &&
      this.activeFieldSource !== FieldSource.VAR
    ) {
      throw new TypeError(
        'Active field source must be exactly obs, var, or null.'
      );
    }
    const isVar = this.activeFieldSource === FieldSource.VAR;
    const activeIndex = isVar
      ? this.activeVarFieldIndex
      : this.activeFieldIndex;
    const inactiveIndex = isVar
      ? this.activeFieldIndex
      : this.activeVarFieldIndex;
    if (inactiveIndex !== -1) {
      throw new Error('The inactive field source index must be -1.');
    }
    const data = isVar ? this.varData : this.obsData;
    const sourceLabel = isVar ? 'Variable' : 'Observation';
    if (
      data === null ||
      typeof data !== 'object' ||
      !Array.isArray(data.fields)
    ) {
      throw new TypeError(
        `${sourceLabel} field metadata must publish a fields array.`
      );
    }
    if (
      !Number.isSafeInteger(activeIndex) ||
      activeIndex < 0 ||
      activeIndex >= data.fields.length
    ) {
      throw new RangeError(
        `${sourceLabel} active field index is outside its exact inventory.`
      );
    }
    const field = data.fields[activeIndex];
    if (
      field === null ||
      typeof field !== 'object' ||
      Array.isArray(field)
    ) {
      throw new TypeError(
        `${sourceLabel} active field must be one metadata object.`
      );
    }
    return field;
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
    const obsFields = this.obsData === null
      ? null
      : requireInventory(this, FieldSource.OBS);
    const varFields = this.varData === null
      ? null
      : requireInventory(this, FieldSource.VAR);
    this._applyOverlaysToFields(obsFields, FieldSource.OBS);
    this._applyOverlaysToFields(varFields, FieldSource.VAR);
    this._injectUserDefinedFields();

    // Keep active selection pointing at a non-deleted field (buffers remain untouched).
    this._ensureActiveSelectionNotDeleted();

    getFieldRegistry().invalidate();
    this._syncActiveContext();
  }

  getVisibleFields(source) {
    requireSource(source);
    return getFieldRegistry().getVisibleFields(source);
  }

  isFieldDeleted(source, fieldIndex) {
    const { field } = requireFieldAt(this, source, fieldIndex);
    if (
      Object.hasOwn(field, '_isDeleted')
      && typeof field._isDeleted !== 'boolean'
    ) {
      throw new TypeError('Field deletion state must be exactly boolean');
    }
    return field._isDeleted === true;
  }

  renameField(source, fieldIndex, newKey) {
    const src = requireSource(source);
    const { fields, field } = requireFieldAt(this, src, fieldIndex);
    StateValidator.validateFieldKey(newKey);

    if (StateValidator.isDuplicateKey(newKey, fields, fieldIndex)) {
      throw new Error(`Visible field name "${newKey}" already exists`);
    }

    const isUserDefined = field._isUserDefined === true;
    if (isUserDefined) {
      requireIdentifier(field._userDefinedId, 'User-defined field id');
      requireUserDefinedOwner(this);
    }
    if (!Object.hasOwn(field, '_originalKey')) {
      field._originalKey = field.key;
    }
    const originalKey = requireOriginalKey(field);
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
      const updated = requireBoolean(
        this._userDefinedFields.updateField(
          field._userDefinedId,
          { key: field.key }
        ),
        'User-defined field rename result'
      );
      if (!updated) {
        throw new Error('User-defined field rename did not complete');
      }
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
    const src = requireSource(source);
    const { field } = requireFieldAt(this, src, fieldIndex);
    if (!Object.hasOwn(field, '_originalKey')) return true;
    StateValidator.validateFieldKey(field._originalKey);
    return this.renameField(src, fieldIndex, field._originalKey);
  }

  renameCategory(source, fieldIndex, categoryIndex, newLabel) {
    const src = requireSource(source);
    const { field } = requireFieldAt(this, src, fieldIndex);
    requireCategoryField(field, 'Category rename field');
    StateValidator.validateCategoryIndex(categoryIndex, field);
    StateValidator.validateCategoryLabel(newLabel);
    if (
      field.categories.some(
        (label, index) => index !== categoryIndex && label === newLabel
      )
    ) {
      throw new Error('Category labels must remain unique');
    }
    const isUserDefined = field._isUserDefined === true;
    if (isUserDefined) {
      requireIdentifier(field._userDefinedId, 'User-defined field id');
      requireUserDefinedOwner(this);
    }
    if (!Object.hasOwn(field, '_originalCategories')) {
      field._originalCategories = [...field.categories];
    } else if (
      !Array.isArray(field._originalCategories)
      || field._originalCategories.length !== field.categories.length
    ) {
      throw new TypeError(
        'Original category inventory must match the current categories'
      );
    }

    const originalFieldKey = requireOriginalKey(field);
    const originalLabel = field._originalCategories[categoryIndex];
    const previousCategories = [...field.categories];
    StateValidator.validateCategoryLabel(originalLabel);

    if (newLabel === originalLabel) {
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
      const hasAnyRename = field.categories.some(
        (label, idx) => label !== field._originalCategories[idx]
      );
      if (!hasAnyRename) {
        delete field._originalCategories;
      }
      const updated = requireBoolean(
        this._userDefinedFields.updateField(
          field._userDefinedId,
          { categories: [...field.categories] }
        ),
        'User-defined category rename result'
      );
      if (!updated) {
        throw new Error('User-defined category rename did not complete');
      }
    }

    // Keep centroid labels consistent with the category list.
    this._syncCentroidCategoryLabels(field, previousCategories);
    this._refreshHighlightGroupsForField(src, fieldIndex);

    // If this field is currently active, push centroid label updates.
    if (src === FieldSource.OBS && this.activeFieldSource === FieldSource.OBS && this.activeFieldIndex === fieldIndex) {
      this.buildCentroidsForField(field, { viewId: this.activeViewId });
      this._pushCentroidsToViewer();
    }

    this.updateFilterSummary();
    this._syncActiveContext();
    this._notifyFieldChange(src, fieldIndex, ChangeType.CATEGORY_RENAME, { categoryIndex, newLabel: field.categories[categoryIndex] });
    return true;
  }

  deleteField(source, fieldIndex) {
    const src = requireSource(source);
    const { field } = requireFieldAt(this, src, fieldIndex);
    if (field._isDeleted === true) {
      throw new Error('Field is already deleted');
    }
    if (field._isUserDefined === true) {
      requireIdentifier(field._userDefinedId, 'User-defined field id');
      return this.deleteUserDefinedField(field._userDefinedId, src);
    }

    const originalKey = requireOriginalKey(field);
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
      requireBoolean(
        this.unloadVarField(fieldIndex, { preserveActive: true }),
        'Var field unload result'
      );
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
    const src = requireSource(source);
    const { field } = requireFieldAt(this, src, fieldIndex);
    if (field._isDeleted !== true) {
      throw new Error('Only a soft-deleted field can be purged');
    }
    if (field._isPurged === true) return true;

    const isUserDefined = field._isUserDefined === true;

    if (isUserDefined) {
      const fieldId = requireIdentifier(
        field._userDefinedId,
        'User-defined field id'
      );
      const registry = requireUserDefinedOwner(this);
      const template = requireField(
        registry.getField(fieldId),
        'User-defined field template'
      );
      if (template._userDefinedId !== fieldId) {
        throw new Error('User-defined field template ownership is inconsistent');
      }
      field._isPurged = true;
      template._isDeleted = true;
      template._isPurged = true;
    } else {
      const originalKey = requireOriginalKey(field);
      this._deleteRegistry.markPurged(src, originalKey);
      field._isDeleted = true;
      field._isPurged = true;
    }

    getFieldRegistry().invalidate();
    this.computeGlobalVisibility();
    this.updateFilterSummary();
    this._notifyFieldChange(src, fieldIndex, ChangeType.UPDATE, {
      purged: true,
      userDefinedId: isUserDefined ? field._userDefinedId : null
    });
    return true;
  }

  /**
   * Restore a soft-deleted field.
   *
   * Restoration never substitutes another name. A visible-key conflict is a
   * public error that must be resolved explicitly before retrying.
   *
   * @param {string} source - 'obs' | 'var'
   * @param {number} fieldIndex
   * @returns {{ok: true, originalKey: string, key: string, userDefinedId: string|null}}
   */
  restoreField(source, fieldIndex) {
    const src = requireSource(source);
    const { fields, field } = requireFieldAt(this, src, fieldIndex);
    if (field._isDeleted !== true) {
      throw new Error('Only a soft-deleted field can be restored');
    }
    if (field._isPurged === true) {
      throw new Error('A purged field cannot be restored');
    }
    const isUserDefined = field._isUserDefined === true;
    const originalKey = requireOriginalKey(field);
    if (
      fields.some(
        (candidate, index) => (
          index !== fieldIndex
          && candidate._isDeleted !== true
          && candidate.key === field.key
        )
      )
    ) {
      throw new Error(
        `Cannot restore "${field.key}" while that visible field name exists`
      );
    }

    let userDefinedId = null;
    if (isUserDefined) {
      userDefinedId = requireIdentifier(
        field._userDefinedId,
        'User-defined field id'
      );
      const registry = requireUserDefinedOwner(this);
      const template = requireField(
        registry.getField(userDefinedId),
        'User-defined field template'
      );
      if (
        template._userDefinedId !== userDefinedId
        || template._fieldSource !== src
      ) {
        throw new Error(
          'User-defined field registry ownership is inconsistent'
        );
      }
      if (template._isDeleted !== true || template._isPurged === true) {
        throw new Error(
          'User-defined field template is not in a restorable state'
        );
      }
      template._isDeleted = false;
      field._isDeleted = false;
    } else {
      requireMethod(
        this._deleteRegistry,
        'markRestored',
        'Delete registry'
      );
      this._deleteRegistry.markRestored(src, originalKey);
      delete field._isDeleted;
    }

    getFieldRegistry().invalidate();
    this.computeGlobalVisibility();
    this.updateFilterSummary();
    this._notifyFieldChange(src, fieldIndex, ChangeType.RESTORE, {
      originalKey,
      userDefinedId
    });
    return {
      ok: true,
      originalKey,
      key: field.key,
      userDefinedId
    };
  }

  /**
   * Restore a deleted user-defined field by its userDefinedId.
   *
   * This handles the case where the field exists only in the UserDefinedFieldsRegistry
   * (not yet injected into the fields array).
   *
   * @param {string} userDefinedId
   * @param {'obs'|'var'} source
   * @returns {{ok: true, key: string, userDefinedId: string}}
   */
  restoreUserDefinedField(userDefinedId, source) {
    const src = requireSource(source);
    const fieldId = requireIdentifier(
      userDefinedId,
      'User-defined field id'
    );
    const registry = requireUserDefinedOwner(this);
    const template = requireField(
      registry.getField(fieldId),
      'User-defined field template'
    );
    if (
      template._isUserDefined !== true
      || template._userDefinedId !== fieldId
      || template._fieldSource !== src
    ) {
      throw new Error('User-defined field template ownership is inconsistent');
    }
    if (template._isDeleted !== true) {
      throw new Error('Only a soft-deleted user-defined field can be restored');
    }
    if (template._isPurged === true) {
      throw new Error('A purged user-defined field cannot be restored');
    }

    const fields = requireInventory(this, src);
    const matches = fields.filter(
      field => field._userDefinedId === fieldId
    );
    if (matches.length > 1) {
      throw new Error(
        `User-defined field id "${fieldId}" is duplicated in ${src}`
      );
    }
    const injected = matches.length === 1 ? matches[0] : null;
    const key = injected === null ? template.key : injected.key;
    StateValidator.validateFieldKey(key);
    if (
      fields.some(
        field => (
          field !== injected
          && field._isDeleted !== true
          && field.key === key
        )
      )
    ) {
      throw new Error(
        `Cannot restore "${key}" while that visible field name exists`
      );
    }

    let field = injected;
    if (field === null) {
      const clone = { ...template };
      delete clone._categoryColors;
      delete clone._categoryVisible;
      delete clone._continuousStats;
      delete clone._continuousFilter;
      delete clone._continuousColorRange;
      delete clone._categoryCounts;
      clone._loadingPromise = null;
      fields.push(clone);
      field = clone;
    }
    field._isDeleted = false;
    template._isDeleted = false;

    getFieldRegistry().invalidate();
    this.computeGlobalVisibility();
    this.updateFilterSummary();
    this._notifyFieldChange(
      src,
      fields.indexOf(field),
      ChangeType.RESTORE,
      { userDefinedId: fieldId }
    );

    return { ok: true, key: field.key, userDefinedId: fieldId };
  }

  /**
   * Permanently confirm deletion of a user-defined field by its userDefinedId.
   *
   * This handles the case where the field exists only in the UserDefinedFieldsRegistry
   * (not yet injected into the fields array).
   *
   * @param {string} userDefinedId
   * @param {'obs'|'var'} source
   * @returns {boolean}
   */
  purgeUserDefinedField(userDefinedId, source) {
    const src = requireSource(source);
    const fieldId = requireIdentifier(
      userDefinedId,
      'User-defined field id'
    );
    const registry = requireUserDefinedOwner(this);
    const template = requireField(
      registry.getField(fieldId),
      'User-defined field template'
    );
    if (
      template._isUserDefined !== true
      || template._userDefinedId !== fieldId
      || template._fieldSource !== src
    ) {
      throw new Error('User-defined field template ownership is inconsistent');
    }
    if (template._isDeleted !== true) {
      throw new Error('Only a soft-deleted user-defined field can be purged');
    }
    if (template._isPurged === true) return true;

    // Mark template as deleted and purged
    template._isDeleted = true;
    template._isPurged = true;

    // If field exists in array, mark it there too
    const fields = requireInventory(this, src);
    const matches = fields.filter(
      field => field._userDefinedId === fieldId
    );
    if (matches.length > 1) {
      throw new Error(
        `User-defined field id "${fieldId}" is duplicated in ${src}`
      );
    }
    const field = matches.length === 1 ? matches[0] : null;
    if (field !== null) {
      if (field._isDeleted !== true) {
        throw new Error(
          'Injected user-defined field is not in a deleted state'
        );
      }
      field._isDeleted = true;
      field._isPurged = true;
    }

    getFieldRegistry().invalidate();
    this.computeGlobalVisibility();
    this.updateFilterSummary();
    const fieldIndex = field ? fields.indexOf(field) : -1;
    this._notifyFieldChange(
      src,
      fieldIndex,
      ChangeType.UPDATE,
      { purged: true, userDefinedId: fieldId }
    );
    return true;
  }

  /**
   * Duplicate a field as a new user-defined field.
   *
   * - Categorical obs: deep-copies codes + categories and computes centroids.
   * - Continuous obs/var: creates a continuous alias that re-materializes values from
   *   the referenced source field when restoring a session bundle.
   *
   * This is a non-destructive operation (the source field remains intact).
   *
   * @param {'obs'|'var'} source
   * @param {number} fieldIndex
   * @param {object} [options]
   * @param {string} [options.newKey]
   * @returns {Promise<{newFieldIndex: number, newKey: string}>}
   */
  async duplicateField(source, fieldIndex, options = {}) {
    const src = requireSource(source);
    const { fields, field } = requireFieldAt(this, src, fieldIndex);
    requireExactOptions(
      options,
      new Set(['newKey']),
      'Field duplicate options'
    );
    if (field._isDeleted === true) {
      throw new Error('A deleted field cannot be duplicated');
    }

    // Ensure the source field has its heavy data materialized first.
    if (src === FieldSource.VAR) {
      await this.ensureVarFieldLoaded(fieldIndex);
    } else {
      await this.ensureFieldLoaded(fieldIndex);
    }

    const existingKeys = fields
      .filter(candidate => candidate._isDeleted !== true)
      .map(candidate => candidate.key);
    let newKey;
    if (Object.hasOwn(options, 'newKey')) {
      StateValidator.validateFieldKey(options.newKey);
      if (existingKeys.includes(options.newKey)) {
        throw new Error(
          `Visible field name "${options.newKey}" already exists`
        );
      }
      newKey = options.newKey;
    } else {
      newKey = makeUniqueLabel(`${field.key} (copy)`, existingKeys);
      StateValidator.validateFieldKey(newKey);
    }
    const userDefinedRegistry = requireUserDefinedOwner(this);

    // ---------------------------------------------------------------------
    // Categorical obs: deep copy codes so subsequent merges don't affect the original.
    // ---------------------------------------------------------------------
    if (field.kind === FieldKind.CATEGORY) {
      if (src !== FieldSource.OBS) {
        throw new TypeError(
          'Categorical var fields cannot be duplicated as gene aliases'
        );
      }

      requireCategoryField(field, 'Categorical duplicate source');
      const categories = [...field.categories];
      const codes = field.codes;
      if (
        (!(codes instanceof Uint8Array) && !(codes instanceof Uint16Array))
        || codes.length !== this.pointCount
      ) {
        throw new TypeError(
          'Categorical duplicate source requires exact dataset-length codes'
        );
      }
      const codesCopy = codes.slice();

      let sourceKey = requireOriginalKey(field);
      if (Object.hasOwn(field, '_sourceField') && field._sourceField !== null) {
        requireRecord(field._sourceField, 'Categorical source descriptor');
        sourceKey = requireIdentifier(
          field._sourceField.sourceKey,
          'Categorical source descriptor.sourceKey'
        );
      }
      const created = userDefinedRegistry.createFromCategoricalCodes(
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
      requireRecord(created, 'Categorical duplicate creation result');
      const createdId = requireIdentifier(
        created.id,
        'Categorical duplicate field id'
      );
      requireCategoryField(
        created.field,
        'Categorical duplicate field'
      );

      // Carry forward category UI state (colors/visibility) as a convenience.
      this.ensureCategoryMetadata(field);
      if (
        !Array.isArray(field._categoryColors)
        || field._categoryColors.length !== categories.length
        || field._categoryColors.some(
          color => (
            !Array.isArray(color)
            || color.length !== 3
            || color.some(channel => !Number.isFinite(channel))
          )
        )
      ) {
        throw new TypeError(
          'Categorical duplicate source colors must match its categories'
        );
      }
      requireRecord(
        field._categoryVisible,
        'Categorical duplicate source visibility'
      );
      const visible = {};
      for (let index = 0; index < categories.length; index++) {
        visible[index] = requireBoolean(
          field._categoryVisible[index],
          `Categorical duplicate visibility ${index}`
        );
      }
      created.field._categoryColors = field._categoryColors.map(
        color => [...color]
      );
      created.field._categoryVisible = visible;
      created.field._categoryFilterEnabled = requireBoolean(
        field._categoryFilterEnabled,
        'Categorical duplicate filter state'
      );
      if (Object.hasOwn(field, '_colormapId')) {
        created.field._colormapId = requireIdentifier(
          field._colormapId,
          'Categorical duplicate colormap id'
        );
      }

      fields.push(created.field);
      const newFieldIndex = fields.length - 1;

      getFieldRegistry().invalidate();
      this._syncActiveContext();
      this._notifyFieldChange(
        FieldSource.OBS,
        newFieldIndex,
        ChangeType.CREATE,
        { userDefinedId: createdId }
      );

      return { newFieldIndex, newKey };
    }

    // ---------------------------------------------------------------------
    // Continuous obs/var: create an alias that can be re-materialized on load.
    // ---------------------------------------------------------------------
    if (field.kind === FieldKind.CONTINUOUS) {
      const sourceKey = requireOriginalKey(field);
      const kind = src === FieldSource.VAR ? 'gene-expression' : 'continuous-obs';
      const created = userDefinedRegistry.createContinuousAlias({
        key: newKey,
        source: src,
        sourceField: { kind, sourceKey, sourceIndex: fieldIndex },
        meta: {
          _operation: { type: 'copy-field', source: src, sourceKey }
        }
      });
      requireRecord(created, 'Continuous duplicate creation result');
      const createdId = requireIdentifier(
        created.id,
        'Continuous duplicate field id'
      );

      const aliasField = requireField(
        created.field,
        'Continuous duplicate field'
      );
      const values = field.values;
      if (
        !ArrayBuffer.isView(values)
        || values instanceof DataView
        || values.length !== this.pointCount
        || typeof values.slice !== 'function'
      ) {
        throw new TypeError(
          'Continuous duplicate source requires exact dataset-length typed values'
        );
      }
      aliasField.values = values.slice();
      aliasField.loaded = true;
      if (src === FieldSource.OBS && Object.hasOwn(field, 'outlierQuantiles')) {
        if (
          !(field.outlierQuantiles instanceof Float32Array)
          || field.outlierQuantiles.length !== this.pointCount
        ) {
          throw new TypeError(
            'Continuous duplicate outlier quantiles must match the dataset'
          );
        }
        aliasField.outlierQuantiles = field.outlierQuantiles;
      }

      // Carry forward continuous UI state.
      for (const key of [
        '_continuousStats',
        '_continuousFilter',
        '_continuousColorRange',
        '_positiveStats'
      ]) {
        if (Object.hasOwn(field, key)) {
          aliasField[key] = { ...requireRecord(field[key], key) };
        }
      }
      for (const key of [
        '_useLogScale',
        '_useFilterColorRange',
        '_filterEnabled',
        '_outlierFilterEnabled'
      ]) {
        if (Object.hasOwn(field, key)) {
          aliasField[key] = requireBoolean(field[key], key);
        }
      }
      if (Object.hasOwn(field, '_outlierThreshold')) {
        if (!Number.isFinite(field._outlierThreshold)) {
          throw new TypeError(
            'Continuous duplicate outlier threshold must be finite'
          );
        }
        aliasField._outlierThreshold = field._outlierThreshold;
      }
      if (Object.hasOwn(field, '_colormapId')) {
        aliasField._colormapId = requireIdentifier(
          field._colormapId,
          'Continuous duplicate colormap id'
        );
      }

      fields.push(aliasField);
      const newFieldIndex = fields.length - 1;

      getFieldRegistry().invalidate();
      this._syncActiveContext();
      this._notifyFieldChange(
        src,
        newFieldIndex,
        ChangeType.CREATE,
        { userDefinedId: createdId }
      );

      return { newFieldIndex, newKey };
    }

    throw new TypeError(`Unsupported duplicate field kind "${field.kind}"`);
  }

  deleteUserDefinedField(fieldId, source) {
    const src = requireSource(source);
    const exactFieldId = requireIdentifier(
      fieldId,
      'User-defined field id'
    );
    const registry = requireUserDefinedOwner(this);
    const template = requireField(
      registry.getField(exactFieldId),
      'User-defined field template'
    );
    if (
      template._isUserDefined !== true
      || template._userDefinedId !== exactFieldId
      || template._fieldSource !== src
    ) {
      throw new Error('User-defined field template ownership is inconsistent');
    }
    if (template._isDeleted === true) {
      throw new Error('User-defined field is already deleted');
    }
    const fields = requireInventory(this, src);
    const matches = fields.filter(
      field => field._userDefinedId === exactFieldId
    );
    if (matches.length > 1) {
      throw new Error(
        `User-defined field id "${exactFieldId}" is duplicated in ${src}`
      );
    }
    const field = matches.length === 1 ? matches[0] : null;

    template._isDeleted = true;
    if (field !== null) field._isDeleted = true;

    if (src === FieldSource.OBS && this.activeFieldSource === FieldSource.OBS && this.activeFieldIndex >= 0) {
      const active = fields[this.activeFieldIndex];
      if (active._userDefinedId === exactFieldId) this.clearActiveField();
    }
    if (src === FieldSource.VAR && this.activeFieldSource === FieldSource.VAR && this.activeVarFieldIndex >= 0) {
      const active = fields[this.activeVarFieldIndex];
      if (active._userDefinedId === exactFieldId) this.clearActiveField();
    }

    getFieldRegistry().invalidate();
    this.computeGlobalVisibility();
    this.updateFilterSummary();
    const fieldIndex = field === null ? -1 : fields.indexOf(field);
    this._notifyFieldChange(src, fieldIndex, ChangeType.DELETE, {
      userDefinedId: exactFieldId,
      originalKey: field === null
        ? template.key
        : requireOriginalKey(field)
    });
    return true;
  }

  isUserDefinedField(source, fieldIndex) {
    const { field } = requireFieldAt(this, source, fieldIndex);
    if (
      Object.hasOwn(field, '_isUserDefined')
      && typeof field._isUserDefined !== 'boolean'
    ) {
      throw new TypeError(
        'User-defined field ownership flag must be exactly boolean'
      );
    }
    return field._isUserDefined === true;
  }

  /**
   * Create or update a user-defined categorical obs field by key.
   *
   * Designed for "computed columns" like community annotation consensus outputs,
   * where the field should be overwritten on each sync without touching the
   * source column.
   *
   * If a non-user-defined field already exists with the requested key, a unique
   * key is generated and returned.
   *
   * @param {object} options
   * @param {string} options.key
   * @param {string[]} options.categories
   * @param {Uint8Array|Uint16Array} options.codes
   * @param {object} [options.meta]
   * @returns {{ fieldIndex: number, key: string, updatedInPlace: boolean }}
   */
  upsertUserDefinedCategoricalField(options) {
    requireExactOptions(
      options,
      new Set(['key', 'categories', 'codes', 'meta']),
      'User-defined categorical upsert options'
    );
    for (const key of ['key', 'categories', 'codes']) {
      if (!Object.hasOwn(options, key)) {
        throw new TypeError(
          `User-defined categorical upsert requires "${key}"`
        );
      }
    }
    if (!Number.isSafeInteger(this.pointCount) || this.pointCount < 1) {
      throw new TypeError(
        'User-defined categorical upsert requires a current positive pointCount'
      );
    }
    const fields = requireInventory(this, FieldSource.OBS);
    const { key, categories, codes, meta } = options;
    StateValidator.validateFieldKey(key);
    requireCategoryPayload(
      categories,
      codes,
      this.pointCount,
      'User-defined categorical upsert'
    );
    if (
      meta !== undefined
      && (
        !meta
        || typeof meta !== 'object'
        || Array.isArray(meta)
        || Object.keys(meta).some(
          metadataKey => metadataKey !== '_sourceField' && metadataKey !== '_operation'
        )
      )
    ) {
      throw new TypeError(
        'User-defined categorical metadata may contain only _sourceField and _operation.'
      );
    }
    if (meta !== undefined) {
      for (const metadataKey of Object.keys(meta)) {
        if (
          !meta[metadataKey]
          || typeof meta[metadataKey] !== 'object'
          || Array.isArray(meta[metadataKey])
        ) {
          throw new TypeError(
            `User-defined categorical metadata ${metadataKey} must be an object.`
          );
        }
      }
    }
    const registry = requireUserDefinedOwner(this);

    const existingIndex = fields.findIndex(
      field => field._isDeleted !== true && field.key === key
    );
    if (existingIndex >= 0) {
      const existing = fields[existingIndex];
      if (
        existing.kind !== FieldKind.CATEGORY
        || existing._isUserDefined !== true
      ) {
        throw new Error(
          `Cannot upsert "${key}" because that visible field is not the owned categorical target`
        );
      }
      const fieldId = requireIdentifier(
        existing._userDefinedId,
        'User-defined categorical target id'
      );
      if (existing._fieldSource !== FieldSource.OBS) {
        throw new Error(
          'User-defined categorical target has mismatched source ownership'
        );
      }
      const template = requireField(
        registry.getField(fieldId),
        'User-defined categorical template'
      );
      if (
        template._userDefinedId !== fieldId
        || template._fieldSource !== FieldSource.OBS
      ) {
        throw new Error(
          'User-defined categorical template ownership is inconsistent'
        );
      }

      const centroidsByDim = registry.computeCentroidsByDim(
        codes,
        categories,
        this
      );
      this.ensureCategoryMetadata(existing);
      const oldIndexByCategory = new Map();
      for (
        let categoryIndex = 0;
        categoryIndex < existing.categories.length;
        categoryIndex++
      ) {
        oldIndexByCategory.set(
          existing.categories[categoryIndex],
          categoryIndex
        );
      }
      const categoryColors = new Array(categories.length);
      const categoryVisible = {};
      for (
        let categoryIndex = 0;
        categoryIndex < categories.length;
        categoryIndex++
      ) {
        const previousIndex = oldIndexByCategory.get(
          categories[categoryIndex]
        );
        if (previousIndex === undefined) {
          categoryColors[categoryIndex] = getCategoryColor(categoryIndex);
          categoryVisible[categoryIndex] = true;
        } else {
          const previousColor = existing._categoryColors[previousIndex];
          if (
            !Array.isArray(previousColor)
            || previousColor.length !== 3
            || previousColor.some(channel => !Number.isFinite(channel))
          ) {
            throw new TypeError(
              `Existing category color ${previousIndex} is invalid`
            );
          }
          categoryColors[categoryIndex] = [...previousColor];
          categoryVisible[categoryIndex] = requireBoolean(
            existing._categoryVisible[previousIndex],
            `Existing category visibility ${previousIndex}`
          );
        }
      }
      const sourceField = (
        meta === undefined
        || !Object.hasOwn(meta, '_sourceField')
      )
        ? existing._sourceField
        : meta._sourceField;
      const operation = (
        meta === undefined
        || !Object.hasOwn(meta, '_operation')
      )
        ? existing._operation
        : meta._operation;
      if (sourceField !== null) {
        requireRecord(sourceField, 'User-defined categorical source metadata');
      }
      if (operation !== null) {
        requireRecord(operation, 'User-defined categorical operation metadata');
      }
      const normalizedDims = new Set();

      const updated = requireBoolean(
        registry.updateField(fieldId, {
          categories: [...categories],
          codes,
          centroidsByDim,
          normalizedDims,
          sourceField,
          operation
        }),
        'User-defined categorical template update result'
      );
      if (!updated) {
        throw new Error(
          'User-defined categorical template update did not complete'
        );
      }

      existing.categories = [...categories];
      existing.codes = codes;
      existing.centroidsByDim = centroidsByDim;
      existing._normalizedDims = normalizedDims;
      existing.loaded = true;
      existing._sourceField = sourceField;
      existing._operation = operation;
      existing._categoryColors = categoryColors;
      existing._categoryVisible = categoryVisible;
      delete existing._categoryCounts;
      delete existing.outlierQuantiles;
      delete existing._outlierThreshold;

      getFieldRegistry().invalidate();
      this._syncActiveContext();
      this._notifyFieldChange(
        FieldSource.OBS,
        existingIndex,
        ChangeType.UPDATE,
        { operation: 'upsert-user-defined' }
      );
      return { fieldIndex: existingIndex, key, updatedInPlace: true };
    }

    const created = registry.createFromCategoricalCodes(
      {
        key,
        categories,
        codes,
        source: FieldSource.OBS,
        meta
      },
      this
    );
    requireRecord(created, 'User-defined categorical creation result');
    const createdId = requireIdentifier(
      created.id,
      'User-defined categorical creation id'
    );
    requireCategoryField(
      created.field,
      'User-defined categorical creation field'
    );
    fields.push(created.field);
    const newFieldIndex = fields.length - 1;
    getFieldRegistry().invalidate();
    this._syncActiveContext();
    this._notifyFieldChange(
      FieldSource.OBS,
      newFieldIndex,
      ChangeType.CREATE,
      { userDefinedId: createdId }
    );
    return { fieldIndex: newFieldIndex, key, updatedInPlace: false };
  }
}
