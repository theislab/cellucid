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
  applyCategoryIndexMapping
} from '../../../utils/categorical-ops.js';

function requireEditableCodes(codes, pointCount) {
  if (
    (!(codes instanceof Uint8Array) && !(codes instanceof Uint16Array))
    || codes.length !== pointCount
  ) {
    throw new TypeError(
      'Category editing requires Uint8Array or Uint16Array codes matching the dataset.'
    );
  }
  return codes;
}

function requireCategoryEditBaseKey(options, generatedKey) {
  if (options.newKey === undefined) return generatedKey;
  StateValidator.validateFieldKey(options.newKey);
  return options.newKey;
}

function collectHighlightCategoryRemaps(state, fieldIndex, mapping) {
  if (!Array.isArray(state.highlightPages)) {
    throw new TypeError('Category editing requires the exact highlight-page inventory.');
  }
  const remaps = [];
  for (let pageIndex = 0; pageIndex < state.highlightPages.length; pageIndex++) {
    const page = state.highlightPages[pageIndex];
    if (!page || typeof page !== 'object' || !Array.isArray(page.highlightedGroups)) {
      throw new TypeError(`Highlight page ${pageIndex} has invalid group state.`);
    }
    for (let groupIndex = 0; groupIndex < page.highlightedGroups.length; groupIndex++) {
      const group = page.highlightedGroups[groupIndex];
      if (!group || typeof group !== 'object') {
        throw new TypeError(`Highlight page ${pageIndex} group ${groupIndex} must be an object.`);
      }
      if (
        group.type !== 'category'
        || group.fieldSource !== FieldSource.OBS
        || group.fieldIndex !== fieldIndex
      ) {
        continue;
      }
      if (
        !Number.isSafeInteger(group.categoryIndex)
        || group.categoryIndex < 0
        || group.categoryIndex >= mapping.length
      ) {
        throw new RangeError(
          `Highlight page ${pageIndex} group ${groupIndex} has an invalid category reference.`
        );
      }
      remaps.push({
        group,
        categoryIndex: mapping[group.categoryIndex]
      });
    }
  }
  return remaps;
}

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
   * @param {object} options
   * @param {boolean} options.editInPlace
   * @param {string} options.unassignedLabel
   * @param {string} [options.newKey] - Optional explicit new field key
   * @returns {{
   *   newFieldIndex: number,
   *   newKey: string,
   *   updatedInPlace: boolean
   * }}
   */
  deleteCategoryToUnassigned(fieldIndex, categoryIndex, options) {
    const fields = this.obsData?.fields;

    StateValidator.validateFieldIndex(fieldIndex, fields);
    const sourceField = fields[fieldIndex];
    StateValidator.validateCategoryIndex(categoryIndex, sourceField);
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Delete-category options must be an object.');
    }
    if (sourceField._isDeleted === true) {
      throw new Error('Deleted fields cannot be edited.');
    }
    if (typeof options.editInPlace !== 'boolean') {
      throw new TypeError('Delete-category editInPlace must be exactly true or false.');
    }
    if (
      typeof options.unassignedLabel !== 'string'
      || options.unassignedLabel.length === 0
      || options.unassignedLabel !== options.unassignedLabel.trim()
    ) {
      throw new TypeError('Delete-category unassignedLabel must be a non-empty trimmed string.');
    }

    const canEditInPlace = sourceField._isUserDefined === true && Boolean(sourceField._userDefinedId);
    if (options.editInPlace && !canEditInPlace) {
      throw new Error('Only registered user-defined fields can be edited in place.');
    }
    const editInPlace = options.editInPlace;

    const deletedLabel = sourceField.categories[categoryIndex];
    const unassignedLabel = options.unassignedLabel;
    requireEditableCodes(sourceField.codes, this.pointCount);
    const transform = buildDeleteToUnassignedTransform(
      sourceField.categories,
      categoryIndex,
      { unassignedLabel }
    );

    const nextCategories = transform.categories;
    const nextCodes = applyCategoryIndexMapping(
      sourceField.codes,
      transform.mapping,
      nextCategories.length
    );
    requireEditableCodes(nextCodes, this.pointCount);
    this.ensureCategoryMetadata(sourceField);

    // In-place edit for user-defined derived fields:
    // avoids creating another full field copy on repeated destructive edits.
    if (editInPlace) {
      const oldColors = sourceField._categoryColors;
      const oldVisible = sourceField._categoryVisible;

      const newColors = new Array(nextCategories.length);
      const newVisible = {};
      for (let i = 0; i < nextCategories.length; i++) newVisible[i] = true;

      const merged = new Set(transform.mergedOldIndices);
      const unassignedOld = transform.keptOldUnassignedIndex;
      const unassignedNew = transform.unassignedNewIndex;

      // Unassigned bucket: prefer the kept old unassigned color, otherwise palette default.
      if (unassignedOld !== null) {
        newColors[unassignedNew] = [...oldColors[unassignedOld]];
        newVisible[unassignedNew] = oldVisible[unassignedOld];
      } else {
        newColors[unassignedNew] = getCategoryColor(unassignedNew);
        newVisible[unassignedNew] = true;
      }

      // Copy remaining categories (skip those merged into unassigned).
      for (let oldIdx = 0; oldIdx < transform.mapping.length; oldIdx++) {
        if (oldIdx === unassignedOld) continue;
        if (merged.has(oldIdx)) continue;
        const newIdx = transform.mapping[oldIdx];
        newColors[newIdx] = [...oldColors[oldIdx]];
        newVisible[newIdx] = oldVisible[oldIdx];
      }

      const nextCentroidsByDim = this._userDefinedFields.computeCentroidsByDim(
        nextCodes,
        nextCategories,
        this
      );
      const template = this._userDefinedFields.getField(sourceField._userDefinedId);
      if (!template) {
        throw new Error('The user-defined field registry does not own the edited field.');
      }
      const highlightRemaps = collectHighlightCategoryRemaps(
        this,
        fieldIndex,
        transform.mapping
      );

      sourceField.categories = nextCategories;
      sourceField.codes = nextCodes;
      sourceField._categoryColors = newColors;
      sourceField._categoryVisible = newVisible;
      sourceField.centroidsByDim = nextCentroidsByDim;

      delete sourceField._originalCategories;
      delete sourceField.outlierQuantiles;
      delete sourceField._outlierThreshold;

      sourceField._operation = {
        type: 'delete-to-unassigned',
        deletedCategoryIndex: categoryIndex,
        deletedCategoryLabel: deletedLabel,
        unassignedLabel
      };

      // Keep serialized template in sync for persistence.
      template.categories = nextCategories;
      template.codes = sourceField.codes;
      template.centroidsByDim = sourceField.centroidsByDim;
      template._operation = sourceField._operation;

      // Remap any category-based highlight groups referencing this field.
      for (const remap of highlightRemaps) {
        remap.group.categoryIndex = remap.categoryIndex;
      }

      getFieldRegistry().invalidate();
      this._syncActiveContext();

      this.setActiveField(fieldIndex);

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

    const rootKey = sourceField._sourceField?.sourceKey || sourceField._originalKey || sourceField.key;
    const baseKey = requireCategoryEditBaseKey(options, `${rootKey} (edited)`);
    const existingKeys = fields.filter((f) => f && f._isDeleted !== true).map((f) => f.key);
    const newKey = makeUniqueLabel(baseKey, existingKeys);

    const created = this._userDefinedFields.createFromCategoricalCodes(
      {
        key: newKey,
        categories: nextCategories,
        codes: nextCodes,
        source: FieldSource.OBS,
        meta: {
          _sourceField: {
            kind: 'categorical-obs',
            sourceKey: rootKey,
            sourceIndex: fieldIndex
          },
          _operation: {
            type: 'delete-to-unassigned',
            deletedCategoryIndex: categoryIndex,
            deletedCategoryLabel: deletedLabel,
            unassignedLabel
          }
        }
      },
      this
    );

    const derivedField = created.field;

    // Carry forward category UI state (colors/visibility) as a convenience.
    const newColors = new Array(nextCategories.length);
    const newVisible = {};
    for (let i = 0; i < nextCategories.length; i++) newVisible[i] = true;

    const oldColors = sourceField._categoryColors;
    const oldVisible = sourceField._categoryVisible;

    const unassignedOld = transform.keptOldUnassignedIndex;
    const unassignedNew = transform.unassignedNewIndex;
    if (unassignedOld !== null) {
      newColors[unassignedNew] = [...oldColors[unassignedOld]];
      newVisible[unassignedNew] = oldVisible[unassignedOld];
    } else {
      newColors[unassignedNew] = getCategoryColor(unassignedNew);
      newVisible[unassignedNew] = true;
    }

    const merged = new Set(transform.mergedOldIndices);
    for (let oldIdx = 0; oldIdx < transform.mapping.length; oldIdx++) {
      if (oldIdx === unassignedOld) continue;
      if (merged.has(oldIdx)) continue;
      const newIdx = transform.mapping[oldIdx];
      newColors[newIdx] = [...oldColors[oldIdx]];
      newVisible[newIdx] = oldVisible[oldIdx];
    }

    derivedField._categoryColors = newColors;
    derivedField._categoryVisible = newVisible;
    derivedField._categoryFilterEnabled = sourceField._categoryFilterEnabled;
    // Ensure this derived field does not carry latent outlier filtering state.
    delete derivedField.outlierQuantiles;
    delete derivedField._outlierThreshold;

    fields.push(derivedField);
    const newFieldIndex = fields.length - 1;

    getFieldRegistry().invalidate();
    this._syncActiveContext();
    this._notifyFieldChange(FieldSource.OBS, newFieldIndex, ChangeType.CREATE, { userDefinedId: created.id });

    // Activate new field before deleting the previous one (avoids a brief "no field" state).
    this.setActiveField(newFieldIndex);

    // Soft-delete the source field for a clean UX; restoration is available in Deleted Fields.
    this.deleteField(FieldSource.OBS, fieldIndex);

    return { newFieldIndex, newKey, updatedInPlace: false };
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
   * @param {object} options
   * @param {boolean} options.editInPlace
   * @param {string} [options.newKey]
   * @returns {{
   *   newFieldIndex: number,
   *   newKey: string,
   *   updatedInPlace: boolean,
   *   mergedCategoryLabel: string
   * }}
   */
  mergeCategoriesToNewField(fieldIndex, fromCategoryIndex, toCategoryIndex, options) {
    const fields = this.obsData?.fields;

    StateValidator.validateFieldIndex(fieldIndex, fields);
    const sourceField = fields[fieldIndex];
    StateValidator.validateCategoryIndex(fromCategoryIndex, sourceField);
    StateValidator.validateCategoryIndex(toCategoryIndex, sourceField);
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Merge-category options must be an object.');
    }
    if (sourceField._isDeleted === true) {
      throw new Error('Deleted fields cannot be edited.');
    }
    if (typeof options.editInPlace !== 'boolean') {
      throw new TypeError('Merge-category editInPlace must be exactly true or false.');
    }
    if (
      options.mergedLabel !== undefined
      && (
        typeof options.mergedLabel !== 'string'
        || options.mergedLabel.length === 0
        || options.mergedLabel !== options.mergedLabel.trim()
      )
    ) {
      throw new TypeError('Merge-category mergedLabel must be a non-empty trimmed string.');
    }

    const canEditInPlace = sourceField._isUserDefined === true && Boolean(sourceField._userDefinedId);
    if (options.editInPlace && !canEditInPlace) {
      throw new Error('Only registered user-defined fields can be edited in place.');
    }
    const editInPlace = options.editInPlace;

    requireEditableCodes(sourceField.codes, this.pointCount);
    const transform = buildMergeCategoriesTransform(
      sourceField.categories,
      fromCategoryIndex,
      toCategoryIndex
    );

    const nextCategories = transform.categories;
    const fromLabel = sourceField.categories[fromCategoryIndex];
    const toLabel = sourceField.categories[toCategoryIndex];
    const targetNewIndex = transform.targetNewIndex;
    if (
      !Number.isSafeInteger(targetNewIndex)
      || targetNewIndex < 0
      || targetNewIndex >= nextCategories.length
    ) {
      throw new RangeError('Category merge returned an invalid target category index.');
    }

    // Rename the merged bucket so the result is explicit to the user.
    // The merged label is "dragged + target" so drag direction is visible.
    const mergedBase = options.mergedLabel ?? `merged ${fromLabel} + ${toLabel}`;
    const mergedLabel = makeUniqueLabel(
      mergedBase,
      nextCategories.filter((_, idx) => idx !== targetNewIndex)
    );
    nextCategories[targetNewIndex] = mergedLabel;
    const nextCodes = applyCategoryIndexMapping(
      sourceField.codes,
      transform.mapping,
      nextCategories.length
    );
    requireEditableCodes(nextCodes, this.pointCount);
    this.ensureCategoryMetadata(sourceField);

    if (editInPlace) {
      const oldColors = sourceField._categoryColors;
      const oldVisible = sourceField._categoryVisible;
      const newColors = new Array(nextCategories.length);
      const newVisible = {};
      for (let i = 0; i < nextCategories.length; i++) newVisible[i] = true;

      // Merged bucket color should come from the dragged category.
      newColors[targetNewIndex] = [...oldColors[fromCategoryIndex]];
      newVisible[targetNewIndex] = oldVisible[fromCategoryIndex] || oldVisible[toCategoryIndex];

      for (let oldIdx = 0; oldIdx < transform.mapping.length; oldIdx++) {
        if (oldIdx === fromCategoryIndex || oldIdx === toCategoryIndex) continue;
        const newIdx = transform.mapping[oldIdx];
        newColors[newIdx] = [...oldColors[oldIdx]];
        newVisible[newIdx] = oldVisible[oldIdx];
      }

      const nextCentroidsByDim = this._userDefinedFields.computeCentroidsByDim(
        nextCodes,
        nextCategories,
        this
      );
      const template = this._userDefinedFields.getField(sourceField._userDefinedId);
      if (!template) {
        throw new Error('The user-defined field registry does not own the edited field.');
      }
      const highlightRemaps = collectHighlightCategoryRemaps(
        this,
        fieldIndex,
        transform.mapping
      );

      sourceField.categories = nextCategories;
      sourceField.codes = nextCodes;
      sourceField._categoryColors = newColors;
      sourceField._categoryVisible = newVisible;
      sourceField.centroidsByDim = nextCentroidsByDim;

      delete sourceField._originalCategories;
      delete sourceField.outlierQuantiles;
      delete sourceField._outlierThreshold;

      sourceField._operation = {
        type: 'merge-categories',
        fromCategoryIndex,
        toCategoryIndex,
        fromCategoryLabel: fromLabel,
        toCategoryLabel: toLabel,
        mergedCategoryLabel: mergedLabel
      };

      // Keep serialized template in sync for persistence.
      template.categories = nextCategories;
      template.codes = sourceField.codes;
      template.centroidsByDim = sourceField.centroidsByDim;
      template._operation = sourceField._operation;

      // Remap any category-based highlight groups referencing this field.
      for (const remap of highlightRemaps) {
        remap.group.categoryIndex = remap.categoryIndex;
      }

      getFieldRegistry().invalidate();
      this._syncActiveContext();

      this.setActiveField(fieldIndex);

      this.updateFilterSummary();
      this._refreshHighlightGroupsForField(FieldSource.OBS, fieldIndex);
      this._notifyFieldChange(FieldSource.OBS, fieldIndex, ChangeType.UPDATE, {
        operation: 'merge-categories',
        mergedCategoryLabel: mergedLabel
      });

      return { newFieldIndex: fieldIndex, newKey: sourceField.key, updatedInPlace: true, mergedCategoryLabel: mergedLabel };
    }

    const rootKey = sourceField._sourceField?.sourceKey || sourceField._originalKey || sourceField.key;
    const baseKey = requireCategoryEditBaseKey(options, `${rootKey} (merged)`);
    const existingKeys = fields.filter((f) => f && f._isDeleted !== true).map((f) => f.key);
    const newKey = makeUniqueLabel(baseKey, existingKeys);

    const created = this._userDefinedFields.createFromCategoricalCodes(
      {
        key: newKey,
        categories: nextCategories,
        codes: nextCodes,
        source: FieldSource.OBS,
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
            fromCategoryLabel: fromLabel,
            toCategoryLabel: toLabel,
            mergedCategoryLabel: mergedLabel
          }
        }
      },
      this
    );

    const derivedField = created.field;

    // Carry forward category UI state (colors/visibility).
    const newColors = new Array(nextCategories.length);
    const newVisible = {};
    for (let i = 0; i < nextCategories.length; i++) newVisible[i] = true;

    const oldColors = sourceField._categoryColors;
    const oldVisible = sourceField._categoryVisible;

    newColors[targetNewIndex] = [...oldColors[fromCategoryIndex]];
    newVisible[targetNewIndex] = oldVisible[fromCategoryIndex] || oldVisible[toCategoryIndex];

    for (let oldIdx = 0; oldIdx < transform.mapping.length; oldIdx++) {
      if (oldIdx === fromCategoryIndex || oldIdx === toCategoryIndex) continue;
      const newIdx = transform.mapping[oldIdx];
      newColors[newIdx] = [...oldColors[oldIdx]];
      newVisible[newIdx] = oldVisible[oldIdx];
    }

    derivedField._categoryColors = newColors;
    derivedField._categoryVisible = newVisible;
    derivedField._categoryFilterEnabled = sourceField._categoryFilterEnabled;

    delete derivedField.outlierQuantiles;
    delete derivedField._outlierThreshold;

    fields.push(derivedField);
    const newFieldIndex = fields.length - 1;

    getFieldRegistry().invalidate();
    this._syncActiveContext();
    this._notifyFieldChange(FieldSource.OBS, newFieldIndex, ChangeType.CREATE, { userDefinedId: created.id });

    this.setActiveField(newFieldIndex);

    this.deleteField(FieldSource.OBS, fieldIndex);

    return {
      newFieldIndex,
      newKey,
      updatedInPlace: false,
      mergedCategoryLabel: mergedLabel
    };
  }

  createCategoricalFromPages(options) {
    StateValidator.validateUserDefinedOptions(options);
    if (
      this.obsData === null
      || typeof this.obsData !== 'object'
      || Array.isArray(this.obsData)
      || !Array.isArray(this.obsData.fields)
    ) {
      throw new TypeError(
        'Highlight-page categorical creation requires the current observation field inventory.'
      );
    }
    for (let index = 0; index < this.obsData.fields.length; index++) {
      const field = this.obsData.fields[index];
      if (
        field === null
        || typeof field !== 'object'
        || Array.isArray(field)
        || typeof field.key !== 'string'
        || field.key.length === 0
      ) {
        throw new TypeError(
          `Observation field ${index} is malformed.`
        );
      }
      if (field._isDeleted !== true && field.key === options.key) {
        throw new Error(
          `A visible observation field named "${options.key}" already exists.`
        );
      }
    }
    if (
      this._userDefinedFields === null
      || typeof this._userDefinedFields !== 'object'
      || typeof this._userDefinedFields.createFromPages !== 'function'
    ) {
      throw new TypeError(
        'Highlight-page categorical creation requires its field registry.'
      );
    }
    const result = this._userDefinedFields.createFromPages(options, this);
    if (
      result === null
      || typeof result !== 'object'
      || Array.isArray(result)
      || Object.keys(result).sort().join(',') !==
        'conflicts,field,id,uncoveredCount'
      || typeof result.id !== 'string'
      || result.id.length === 0
      || result.field === null
      || typeof result.field !== 'object'
      || Array.isArray(result.field)
      || result.field.key !== options.key
      || result.field._userDefinedId !== result.id
      || !Number.isSafeInteger(result.conflicts)
      || result.conflicts < 0
      || !Number.isSafeInteger(result.uncoveredCount)
      || result.uncoveredCount < 0
    ) {
      throw new TypeError(
        'User-defined field registry returned a malformed categorical result.'
      );
    }

    this.obsData.fields.push(result.field);
    const newIndex = this.obsData.fields.length - 1;

    getFieldRegistry().invalidate();
    this._syncActiveContext();
    this._notifyFieldChange(
      FieldSource.OBS,
      newIndex,
      ChangeType.CREATE,
      { userDefinedId: result.id }
    );

    return result;
  }
}
