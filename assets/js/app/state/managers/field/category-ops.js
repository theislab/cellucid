/**
 * @fileoverview DataState categorical edit operations.
 *
 * Destructive categorical operations are implemented as:
 * - For source fields, a derived user-defined field + soft-delete of the source field.
 * - For user-defined derived fields, an in-place edit when possible (avoids repeated
 *   large allocations for iterative workflows).
 *
 * Mixed into DataState via `state/managers/field-manager.js`.
 *
 * @module state/managers/field/category-ops
 */

import { getCategoryColor } from '../../../../data/palettes.js';
import { StateValidator } from '../../../utils/state-validator.js';
import { ChangeType, FieldKind, FieldSource } from '../../../utils/field-constants.js';
import { getFieldRegistry } from '../../../utils/field-registry.js';
import { makeUniqueLabel } from '../../../utils/label-utils.js';
import {
  buildDeleteToUnassignedTransform,
  buildMergeCategoriesTransform,
  applyCategoryIndexMapping,
  applyCategoryIndexMappingInPlace
} from '../../../utils/categorical-ops.js';

export class FieldCategoryOpsMethods {
  /**
   * Create a new categorical obs column where one category is merged into a
   * single canonical `unassigned` bucket (accumulating deletions).
   *
   * This is a destructive edit of the category assignment:
   * - For source fields, we create a user-defined derived field and soft-delete
   *   the source field (restorable via Deleted Fields).
   * - For already user-defined derived fields, we edit the field in place to
   *   keep the workflow fast and avoid cluttering the field list. In this path
   *   we remap per-cell codes in place when possible to avoid allocating an
   *   additional full codes array on every edit.
   *
   * @param {number} fieldIndex
   * @param {number} categoryIndex
   * @param {object} [options]
   * @param {string} [options.unassignedLabel='unassigned']
   * @param {string} [options.newKey] - Optional explicit new field key
   * @returns {{ newFieldIndex: number, newKey: string }|null}
   */
  deleteCategoryToUnassigned(fieldIndex, categoryIndex, options = {}) {
    const fields = this.obsData?.fields;

    try {
      StateValidator.validateFieldIndex(fieldIndex, fields);
      const field = fields[fieldIndex];
      StateValidator.validateCategoryIndex(categoryIndex, field);
    } catch (e) {
      console.error('[State] deleteCategoryToUnassigned validation failed:', e.message);
      return null;
    }

    const sourceField = fields[fieldIndex];
    if (!sourceField || sourceField.kind !== FieldKind.CATEGORY) return null;
    if (sourceField._isDeleted === true) return null;

    const canEditInPlace = sourceField._isUserDefined === true && Boolean(sourceField._userDefinedId);
    const editInPlace = options.editInPlace !== false && canEditInPlace;

    const deletedLabel = String(sourceField.categories?.[categoryIndex] ?? '');
    const unassignedLabel = String(options.unassignedLabel ?? 'unassigned').trim() || 'unassigned';

    let transform;
    try {
      transform = buildDeleteToUnassignedTransform(sourceField.categories || [], categoryIndex, { unassignedLabel });
    } catch (err) {
      console.error('[State] deleteCategoryToUnassigned failed:', err.message);
      return null;
    }

    const nextCategories = transform.categories;

    // In-place edit for user-defined derived fields:
    // avoids creating another full field copy on repeated destructive edits.
    if (editInPlace) {
      // Prefer in-place remapping to avoid allocating a full codes copy on every edit.
      // Fallback to allocating when codes isn't a TypedArray (unexpected).
      let nextCodes = sourceField.codes;
      const didInPlace = applyCategoryIndexMappingInPlace(nextCodes, transform.mapping);
      if (!didInPlace) {
        nextCodes = applyCategoryIndexMapping(sourceField.codes, transform.mapping, nextCategories.length);
      }

      try {
        this.ensureCategoryMetadata(sourceField);
      } catch {}

      const oldColors = sourceField._categoryColors || [];
      const oldVisible = sourceField._categoryVisible || {};

      const newColors = new Array(nextCategories.length);
      const newVisible = {};
      for (let i = 0; i < nextCategories.length; i++) newVisible[i] = true;

      const merged = new Set(transform.mergedOldIndices || []);
      const unassignedOld = transform.keptOldUnassignedIndex;
      const unassignedNew = transform.unassignedNewIndex;

      // Unassigned bucket: prefer the kept old unassigned color, otherwise palette default.
      if (unassignedOld != null && oldColors[unassignedOld]) {
        newColors[unassignedNew] = oldColors[unassignedOld];
        newVisible[unassignedNew] = oldVisible[unassignedOld] !== false;
      } else {
        newColors[unassignedNew] = getCategoryColor(unassignedNew);
        newVisible[unassignedNew] = true;
      }

      // Copy remaining categories (skip those merged into unassigned).
      for (let oldIdx = 0; oldIdx < transform.mapping.length; oldIdx++) {
        if (oldIdx === unassignedOld) continue;
        if (merged.has(oldIdx)) continue;
        const newIdx = transform.mapping[oldIdx];
        const c = oldColors[oldIdx];
        if (c) newColors[newIdx] = c;
        newVisible[newIdx] = oldVisible[oldIdx] !== false;
      }

      sourceField.categories = nextCategories;
      if (!didInPlace) sourceField.codes = nextCodes;
      sourceField._categoryColors = newColors;
      sourceField._categoryVisible = newVisible;

      delete sourceField._originalCategories;
      delete sourceField.outlierQuantiles;
      delete sourceField._outlierThreshold;

      try {
        sourceField.centroidsByDim = this._userDefinedFields.computeCentroidsByDim(nextCodes, nextCategories, this);
      } catch (err) {
        console.warn('[State] deleteCategoryToUnassigned in-place centroid compute failed:', err);
      }

      sourceField._operation = {
        type: 'delete-to-unassigned',
        deletedCategoryIndex: categoryIndex,
        deletedCategoryLabel: deletedLabel,
        unassignedLabel: String(unassignedLabel)
      };

      // Keep serialized template in sync for persistence.
      const template = this._userDefinedFields?.getField?.(sourceField._userDefinedId);
      if (template) {
        template.categories = nextCategories;
        template.codes = sourceField.codes;
        if (sourceField.centroidsByDim) template.centroidsByDim = sourceField.centroidsByDim;
        template._operation = sourceField._operation;
      }

      // Remap any category-based highlight groups referencing this field.
      for (const page of this.highlightPages || []) {
        for (const group of (page.highlightedGroups || [])) {
          if (!group || group.type !== 'category') continue;
          if (group.fieldSource !== FieldSource.OBS) continue;
          if (group.fieldIndex !== fieldIndex) continue;
          const oldCat = group.categoryIndex;
          if (!Number.isInteger(oldCat) || oldCat < 0 || oldCat >= transform.mapping.length) continue;
          group.categoryIndex = transform.mapping[oldCat];
        }
      }

      getFieldRegistry().invalidate();
      this._syncActiveContext();

      try {
        this.setActiveField(fieldIndex);
      } catch (err) {
        console.warn('[State] Failed to re-activate edited field:', err);
      }

      this.updateFilterSummary();
      this._refreshHighlightGroupsForField(FieldSource.OBS, fieldIndex);
      this._notifyFieldChange(FieldSource.OBS, fieldIndex, ChangeType.UPDATE, {
        operation: 'delete-to-unassigned',
        unassignedLabel
      });

      // Note: restoration is still possible by restoring the original source column
      // that this user-defined field was derived from.
      return { newFieldIndex: fieldIndex, newKey: sourceField.key, updatedInPlace: true };
    }

    const nextCodes = applyCategoryIndexMapping(sourceField.codes, transform.mapping, nextCategories.length);

    const rootKey = sourceField._sourceField?.sourceKey || sourceField._originalKey || sourceField.key;
    const baseKey = String(options.newKey || `${rootKey} (edited)`).trim() || `${rootKey} (edited)`;
    const existingKeys = (fields || []).filter((f) => f && f._isDeleted !== true).map((f) => f.key);
    const newKey = makeUniqueLabel(baseKey, existingKeys);

    let created;
    try {
      created = this._userDefinedFields.createFromCategoricalCodes(
        {
          key: newKey,
          categories: nextCategories,
          codes: nextCodes,
          meta: {
            _sourceField: {
              kind: 'categorical-obs',
              sourceKey: rootKey,
              sourceIndex: fieldIndex
            },
            _operation: {
              type: 'delete-to-unassigned',
              deletedCategoryIndex: categoryIndex,
              deletedCategoryLabel: String(sourceField.categories?.[categoryIndex] ?? ''),
              unassignedLabel: String(unassignedLabel)
            }
          }
        },
        this
      );
    } catch (err) {
      console.error('[State] deleteCategoryToUnassigned create failed:', err.message);
      return null;
    }

    const derivedField = created.field;

    // Carry forward category UI state (colors/visibility) as a convenience.
    try {
      this.ensureCategoryMetadata(sourceField);
      const newColors = new Array(nextCategories.length);
      const newVisible = {};
      for (let i = 0; i < nextCategories.length; i++) newVisible[i] = true;

      const oldColors = sourceField._categoryColors || [];
      const oldVisible = sourceField._categoryVisible || {};

      // Unassigned bucket: prefer the kept old unassigned color, otherwise palette default.
      const unassignedOld = transform.keptOldUnassignedIndex;
      const unassignedNew = transform.unassignedNewIndex;
      if (unassignedOld != null && oldColors[unassignedOld]) {
        newColors[unassignedNew] = oldColors[unassignedOld];
        newVisible[unassignedNew] = oldVisible[unassignedOld] !== false;
      } else {
        newColors[unassignedNew] = getCategoryColor(unassignedNew);
        newVisible[unassignedNew] = true;
      }

      // Copy remaining categories (skip those merged into unassigned).
      const merged = new Set(transform.mergedOldIndices || []);
      for (let oldIdx = 0; oldIdx < transform.mapping.length; oldIdx++) {
        if (oldIdx === unassignedOld) continue;
        if (merged.has(oldIdx)) continue;
        const newIdx = transform.mapping[oldIdx];
        const c = oldColors[oldIdx];
        if (c) newColors[newIdx] = c;
        newVisible[newIdx] = oldVisible[oldIdx] !== false;
      }

      derivedField._categoryColors = newColors;
      derivedField._categoryVisible = newVisible;
      derivedField._categoryFilterEnabled = sourceField._categoryFilterEnabled ?? true;
      if (sourceField._colormapId) derivedField._colormapId = sourceField._colormapId;
    } catch (err) {
      console.warn('[State] Failed to carry category UI state to derived field:', err);
    }

    // Ensure this derived field does not carry latent outlier filtering state.
    delete derivedField.outlierQuantiles;
    delete derivedField._outlierThreshold;

    fields.push(derivedField);
    const newFieldIndex = fields.length - 1;

    getFieldRegistry().invalidate();
    this._syncActiveContext();
    this._notifyFieldChange(FieldSource.OBS, newFieldIndex, ChangeType.CREATE, { userDefinedId: created.id });

    // Activate new field before deleting the previous one (avoids a brief "no field" state).
    try {
      this.setActiveField(newFieldIndex);
    } catch (err) {
      console.warn('[State] Failed to activate derived field:', err);
    }

    // Soft-delete the source field for a clean UX; restoration is available in Deleted Fields.
    this.deleteField(FieldSource.OBS, fieldIndex);

    return { newFieldIndex, newKey };
  }

  /**
   * Create a new categorical obs column where one category is merged into another.
   *
   * Implemented as:
   * - For source fields, a derived user-defined field + soft-delete of the source field.
   * - For user-defined derived fields, an in-place edit (with in-place code remapping
   *   when possible) to support repeated drag-merge workflows without repeated large
   *   allocations or a growing field list.
   *
   * @param {number} fieldIndex
   * @param {number} fromCategoryIndex
   * @param {number} toCategoryIndex
   * @param {object} [options]
   * @param {string} [options.newKey]
   * @returns {{ newFieldIndex: number, newKey: string }|null}
   */
  mergeCategoriesToNewField(fieldIndex, fromCategoryIndex, toCategoryIndex, options = {}) {
    const fields = this.obsData?.fields;

    try {
      StateValidator.validateFieldIndex(fieldIndex, fields);
      const field = fields[fieldIndex];
      StateValidator.validateCategoryIndex(fromCategoryIndex, field);
      StateValidator.validateCategoryIndex(toCategoryIndex, field);
    } catch (e) {
      console.error('[State] mergeCategoriesToNewField validation failed:', e.message);
      return null;
    }

    const sourceField = fields[fieldIndex];
    if (!sourceField || sourceField.kind !== FieldKind.CATEGORY) return null;
    if (sourceField._isDeleted === true) return null;

    const canEditInPlace = sourceField._isUserDefined === true && Boolean(sourceField._userDefinedId);
    const editInPlace = options.editInPlace !== false && canEditInPlace;

    let transform;
    try {
      transform = buildMergeCategoriesTransform(sourceField.categories || [], fromCategoryIndex, toCategoryIndex);
    } catch (err) {
      console.error('[State] mergeCategoriesToNewField failed:', err.message);
      return null;
    }

    const nextCategories = transform.categories;
    const fromLabel = String(sourceField.categories?.[fromCategoryIndex] ?? '');
    const toLabel = String(sourceField.categories?.[toCategoryIndex] ?? '');
    const targetNewIndex = transform.targetNewIndex;

    // Rename the merged bucket so the result is explicit to the user.
    // The merged label is "dragged + target" so drag direction is visible.
    const mergedBase = String(options.mergedLabel ?? `merged ${fromLabel} + ${toLabel}`).trim() || 'merged';
    const mergedLabel = makeUniqueLabel(
      mergedBase,
      nextCategories.filter((_, idx) => idx !== targetNewIndex)
    );
    if (nextCategories[targetNewIndex] != null) {
      nextCategories[targetNewIndex] = mergedLabel;
    }

    if (editInPlace) {
      // Prefer in-place remapping to avoid allocating a full codes copy on every edit.
      // Fallback to allocating when codes isn't a TypedArray (unexpected).
      let nextCodes = sourceField.codes;
      const didInPlace = applyCategoryIndexMappingInPlace(nextCodes, transform.mapping);
      if (!didInPlace) {
        nextCodes = applyCategoryIndexMapping(sourceField.codes, transform.mapping, nextCategories.length);
      }

      try {
        this.ensureCategoryMetadata(sourceField);
      } catch {}

      const oldColors = sourceField._categoryColors || [];
      const oldVisible = sourceField._categoryVisible || {};
      const newColors = new Array(nextCategories.length);
      const newVisible = {};
      for (let i = 0; i < nextCategories.length; i++) newVisible[i] = true;

      // Merged bucket color should come from the dragged category.
      const draggedColor = oldColors[fromCategoryIndex] || getCategoryColor(fromCategoryIndex);
      newColors[targetNewIndex] = draggedColor;
      newVisible[targetNewIndex] = (oldVisible[fromCategoryIndex] !== false) || (oldVisible[toCategoryIndex] !== false);

      for (let oldIdx = 0; oldIdx < transform.mapping.length; oldIdx++) {
        if (oldIdx === fromCategoryIndex || oldIdx === toCategoryIndex) continue;
        const newIdx = transform.mapping[oldIdx];
        const c = oldColors[oldIdx];
        if (c) newColors[newIdx] = c;
        newVisible[newIdx] = oldVisible[oldIdx] !== false;
      }

      sourceField.categories = nextCategories;
      if (!didInPlace) sourceField.codes = nextCodes;
      sourceField._categoryColors = newColors;
      sourceField._categoryVisible = newVisible;

      delete sourceField._originalCategories;
      delete sourceField.outlierQuantiles;
      delete sourceField._outlierThreshold;

      try {
        sourceField.centroidsByDim = this._userDefinedFields.computeCentroidsByDim(nextCodes, nextCategories, this);
      } catch (err) {
        console.warn('[State] mergeCategoriesToNewField in-place centroid compute failed:', err);
      }

      sourceField._operation = {
        type: 'merge-categories',
        fromCategoryIndex,
        toCategoryIndex,
        fromCategoryLabel: fromLabel,
        toCategoryLabel: toLabel,
        mergedCategoryLabel: mergedLabel
      };

      // Keep serialized template in sync for persistence.
      const template = this._userDefinedFields?.getField?.(sourceField._userDefinedId);
      if (template) {
        template.categories = nextCategories;
        template.codes = sourceField.codes;
        if (sourceField.centroidsByDim) template.centroidsByDim = sourceField.centroidsByDim;
        template._operation = sourceField._operation;
      }

      // Remap any category-based highlight groups referencing this field.
      for (const page of this.highlightPages || []) {
        for (const group of (page.highlightedGroups || [])) {
          if (!group || group.type !== 'category') continue;
          if (group.fieldSource !== FieldSource.OBS) continue;
          if (group.fieldIndex !== fieldIndex) continue;
          const oldCat = group.categoryIndex;
          if (!Number.isInteger(oldCat) || oldCat < 0 || oldCat >= transform.mapping.length) continue;
          group.categoryIndex = transform.mapping[oldCat];
        }
      }

      getFieldRegistry().invalidate();
      this._syncActiveContext();

      try {
        this.setActiveField(fieldIndex);
      } catch (err) {
        console.warn('[State] Failed to re-activate merged field:', err);
      }

      this.updateFilterSummary();
      this._refreshHighlightGroupsForField(FieldSource.OBS, fieldIndex);
      this._notifyFieldChange(FieldSource.OBS, fieldIndex, ChangeType.UPDATE, {
        operation: 'merge-categories',
        mergedCategoryLabel: mergedLabel
      });

      return { newFieldIndex: fieldIndex, newKey: sourceField.key, updatedInPlace: true, mergedCategoryLabel: mergedLabel };
    }

    const nextCodes = applyCategoryIndexMapping(sourceField.codes, transform.mapping, nextCategories.length);

    const rootKey = sourceField._sourceField?.sourceKey || sourceField._originalKey || sourceField.key;
    const baseKey = String(options.newKey || `${rootKey} (merged)`).trim() || `${rootKey} (merged)`;
    const existingKeys = (fields || []).filter((f) => f && f._isDeleted !== true).map((f) => f.key);
    const newKey = makeUniqueLabel(baseKey, existingKeys);

    let created;
    try {
      created = this._userDefinedFields.createFromCategoricalCodes(
        {
          key: newKey,
          categories: nextCategories,
          codes: nextCodes,
          meta: {
            _sourceField: {
              kind: 'categorical-obs',
              sourceKey: rootKey,
              sourceIndex: fieldIndex
            },
            _operation: {
              type: 'merge-categories',
              fromCategoryIndex,
              toCategoryIndex,
              fromCategoryLabel: String(sourceField.categories?.[fromCategoryIndex] ?? ''),
              toCategoryLabel: String(sourceField.categories?.[toCategoryIndex] ?? '')
            }
          }
        },
        this
      );
    } catch (err) {
      console.error('[State] mergeCategoriesToNewField create failed:', err.message);
      return null;
    }

    const derivedField = created.field;

    // Carry forward category UI state (colors/visibility).
    try {
      this.ensureCategoryMetadata(sourceField);
      const newColors = new Array(nextCategories.length);
      const newVisible = {};
      for (let i = 0; i < nextCategories.length; i++) newVisible[i] = true;

      const oldColors = sourceField._categoryColors || [];
      const oldVisible = sourceField._categoryVisible || {};

      // Merged bucket color comes from the dragged category.
      const draggedColor = oldColors[fromCategoryIndex] || getCategoryColor(fromCategoryIndex);
      newColors[targetNewIndex] = draggedColor;
      newVisible[targetNewIndex] = (oldVisible[fromCategoryIndex] !== false) || (oldVisible[toCategoryIndex] !== false);

      // Copy remaining categories (skip merged source and avoid overwriting merged bucket).
      for (let oldIdx = 0; oldIdx < transform.mapping.length; oldIdx++) {
        if (oldIdx === fromCategoryIndex || oldIdx === toCategoryIndex) continue;
        const newIdx = transform.mapping[oldIdx];
        const c = oldColors[oldIdx];
        if (c) newColors[newIdx] = c;
        newVisible[newIdx] = oldVisible[oldIdx] !== false;
      }

      derivedField._categoryColors = newColors;
      derivedField._categoryVisible = newVisible;
      derivedField._categoryFilterEnabled = sourceField._categoryFilterEnabled ?? true;
      if (sourceField._colormapId) derivedField._colormapId = sourceField._colormapId;
    } catch (err) {
      console.warn('[State] Failed to carry category UI state to merged field:', err);
    }

    delete derivedField.outlierQuantiles;
    delete derivedField._outlierThreshold;

    fields.push(derivedField);
    const newFieldIndex = fields.length - 1;

    getFieldRegistry().invalidate();
    this._syncActiveContext();
    this._notifyFieldChange(FieldSource.OBS, newFieldIndex, ChangeType.CREATE, { userDefinedId: created.id });

    try {
      this.setActiveField(newFieldIndex);
    } catch (err) {
      console.warn('[State] Failed to activate merged field:', err);
    }

    this.deleteField(FieldSource.OBS, fieldIndex);

    return { newFieldIndex, newKey, mergedCategoryLabel: mergedLabel };
  }

  createCategoricalFromPages(options) {
    const result = this._userDefinedFields.createFromPages(options, this);

    if (result.field) {
      if (!this.obsData) this.obsData = { fields: [] };
      if (!this.obsData.fields) this.obsData.fields = [];

      this.obsData.fields.push(result.field);
      const newIndex = this.obsData.fields.length - 1;

      getFieldRegistry().invalidate();
      this._syncActiveContext();
      this._notifyFieldChange(FieldSource.OBS, newIndex, ChangeType.CREATE, { userDefinedId: result.id });
    }

    return result;
  }
}

