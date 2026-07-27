/**
 * @fileoverview Exact internal ownership for field overlays.
 *
 * @module state/managers/field/overlay-internals
 */

import { FieldKind, FieldSource } from '../../../utils/field-constants.js';
import { StateValidator } from '../../../utils/state-validator.js';

function requireSource(source) {
  if (source !== FieldSource.OBS && source !== FieldSource.VAR) {
    throw new TypeError('Field source must be exactly obs or var');
  }
  return source;
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

function requireIndex(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
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

function requireFields(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  value.forEach((field, index) => {
    requireField(field, `${label}[${index}]`);
  });
  return value;
}

function requireInventory(owner, source, { nullable = false } = {}) {
  requireSource(source);
  const data = source === FieldSource.VAR
    ? owner.varData
    : owner.obsData;
  if (nullable && data === null) return null;
  requireRecord(data, `${source} field data`);
  return requireFields(data.fields, `${source} field inventory`);
}

function requireCategoryInventory(field, label) {
  if (!Array.isArray(field.categories) || field.categories.length === 0) {
    throw new TypeError(`${label} categories must be a non-empty array`);
  }
  field.categories.forEach((category) => {
    StateValidator.validateCategoryLabel(category);
  });
  return field.categories;
}

function requireOriginalKey(field) {
  if (Object.hasOwn(field, '_originalKey')) {
    StateValidator.validateFieldKey(field._originalKey);
    return field._originalKey;
  }
  StateValidator.validateFieldKey(field.key);
  return field.key;
}

function formatRangeValue(value) {
  if (!Number.isFinite(value)) {
    throw new TypeError('Highlight range bounds must be finite numbers');
  }
  if (
    Math.abs(value) >= 1000
    || (Math.abs(value) > 0 && Math.abs(value) < 0.01)
  ) {
    return value.toExponential(2);
  }
  return value.toFixed(2);
}

export class FieldOverlayInternalMethods {
  _ensureActiveSelectionNotDeleted() {
    const source = this.activeFieldSource;
    if (source === null) {
      if (
        this.activeFieldIndex !== -1
        || this.activeVarFieldIndex !== -1
      ) {
        throw new Error(
          'No active field requires both active field indices to be -1'
        );
      }
      return;
    }
    requireSource(source);
    const activeIndex = source === FieldSource.VAR
      ? this.activeVarFieldIndex
      : this.activeFieldIndex;
    const inactiveIndex = source === FieldSource.VAR
      ? this.activeFieldIndex
      : this.activeVarFieldIndex;
    requireIndex(activeIndex, 'Active field index');
    if (inactiveIndex !== -1) {
      throw new Error('Inactive field index must be exactly -1');
    }
    const fields = requireInventory(this, source);
    if (activeIndex >= fields.length) {
      throw new RangeError(
        'Active field index is outside its exact inventory'
      );
    }
    if (fields[activeIndex]._isDeleted === true) {
      this.activeFieldIndex = -1;
      this.activeVarFieldIndex = -1;
      this.activeFieldSource = null;
    }
  }

  _applyOverlaysToFields(fields, source) {
    requireSource(source);
    const inventory = requireFields(
      fields,
      `${source} overlay field inventory`,
      { nullable: true }
    );
    if (inventory === null || inventory.length === 0) return;
    for (const methodName of [
      'getDisplayCategory',
      'getDisplayKey'
    ]) {
      requireMethod(this._renameRegistry, methodName, 'Rename registry');
    }
    for (const methodName of ['isDeleted', 'isPurged']) {
      requireMethod(this._deleteRegistry, methodName, 'Delete registry');
    }

    for (let fieldIndex = 0; fieldIndex < inventory.length; fieldIndex++) {
      const field = inventory[fieldIndex];
      if (field._isUserDefined === true) {
        requireIdentifier(
          field._userDefinedId,
          `User-defined ${source} field ${fieldIndex} id`
        );
        if (field._fieldSource !== source) {
          throw new Error(
            `User-defined ${source} field ${fieldIndex} has mismatched ownership`
          );
        }
        continue;
      }

      const originalKey = requireOriginalKey(field);
      const displayKey = this._renameRegistry.getDisplayKey(
        source,
        originalKey
      );
      StateValidator.validateFieldKey(displayKey);
      if (displayKey === originalKey) {
        field.key = originalKey;
        delete field._originalKey;
      } else {
        field._originalKey = originalKey;
        field.key = displayKey;
      }

      const deleted = requireBoolean(
        this._deleteRegistry.isDeleted(source, originalKey),
        'Delete registry deletion state'
      );
      const purged = requireBoolean(
        this._deleteRegistry.isPurged(source, originalKey),
        'Delete registry purge state'
      );
      if (purged && !deleted) {
        throw new Error('Purged field overlay must also be deleted');
      }
      if (deleted) field._isDeleted = true;
      else delete field._isDeleted;
      if (purged) field._isPurged = true;
      else delete field._isPurged;

      if (field.kind !== FieldKind.CATEGORY) continue;
      const categories = requireCategoryInventory(
        field,
        `${source} field ${fieldIndex}`
      );
      const previousCategories = [...categories];
      let originalCategories;
      if (Object.hasOwn(field, '_originalCategories')) {
        if (
          !Array.isArray(field._originalCategories)
          || field._originalCategories.length !== categories.length
        ) {
          throw new TypeError(
            `${source} field ${fieldIndex} original categories must exactly match its inventory`
          );
        }
        field._originalCategories.forEach((category) => {
          StateValidator.validateCategoryLabel(category);
        });
        originalCategories = [...field._originalCategories];
      } else {
        originalCategories = [...categories];
      }

      const displayCategories = originalCategories.map(
        (originalLabel, categoryIndex) => {
          const displayLabel = this._renameRegistry.getDisplayCategory(
            source,
            originalKey,
            categoryIndex,
            originalLabel
          );
          StateValidator.validateCategoryLabel(displayLabel);
          return displayLabel;
        }
      );
      const hasRename = displayCategories.some(
        (category, index) => category !== originalCategories[index]
      );
      field.categories = displayCategories;
      if (hasRename) {
        field._originalCategories = originalCategories;
      } else {
        delete field._originalCategories;
      }
      this._syncCentroidCategoryLabels(field, previousCategories);
    }
  }

  _injectUserDefinedFields() {
    this._injectUserDefinedFieldsForSource(FieldSource.OBS);
    this._injectUserDefinedFieldsForSource(FieldSource.VAR);
  }

  _injectUserDefinedFieldsForSource(source) {
    requireSource(source);
    const fields = requireInventory(this, source, { nullable: true });
    if (fields === null) return;
    requireMethod(
      this._userDefinedFields,
      'getAllFieldsForSource',
      'User-defined field registry'
    );

    const existingIds = new Set();
    for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
      const field = fields[fieldIndex];
      if (field._isUserDefined !== true) continue;
      const fieldId = requireIdentifier(
        field._userDefinedId,
        `Injected ${source} field ${fieldIndex} id`
      );
      if (field._fieldSource !== source) {
        throw new Error(
          `Injected ${source} field ${fieldIndex} has mismatched ownership`
        );
      }
      if (existingIds.has(fieldId)) {
        throw new Error(
          `Injected ${source} field id "${fieldId}" is duplicated`
        );
      }
      existingIds.add(fieldId);
    }

    const templates = this._userDefinedFields.getAllFieldsForSource(source);
    if (!Array.isArray(templates)) {
      throw new TypeError(
        'User-defined field registry must publish an array'
      );
    }
    const templateIds = new Set();
    for (let index = 0; index < templates.length; index++) {
      const template = requireField(
        templates[index],
        `User-defined ${source} template ${index}`
      );
      const templateId = requireIdentifier(
        template._userDefinedId,
        `User-defined ${source} template ${index} id`
      );
      if (
        template._isUserDefined !== true
        || template._fieldSource !== source
      ) {
        throw new Error(
          `User-defined ${source} template ${index} has inconsistent ownership`
        );
      }
      if (templateIds.has(templateId)) {
        throw new Error(
          `User-defined ${source} template id "${templateId}" is duplicated`
        );
      }
      templateIds.add(templateId);
      if (existingIds.has(templateId)) continue;

      const clone = { ...template, _loadingPromise: null };
      delete clone._categoryColors;
      delete clone._categoryVisible;
      delete clone._continuousStats;
      delete clone._continuousFilter;
      delete clone._continuousColorRange;
      delete clone._categoryCounts;
      fields.push(clone);
      existingIds.add(templateId);
    }
  }

  _syncCentroidCategoryLabels(field, previousCategories) {
    requireField(field, 'Centroid field');
    if (field.kind !== FieldKind.CATEGORY) {
      throw new TypeError('Centroid label sync requires a categorical field');
    }
    const categories = requireCategoryInventory(field, 'Centroid field');
    if (
      !Array.isArray(previousCategories)
      || previousCategories.length !== categories.length
    ) {
      throw new TypeError(
        'Previous centroid category inventory must match the current inventory'
      );
    }
    const categoryMapping = new Map();
    for (let index = 0; index < previousCategories.length; index++) {
      const previousCategory = previousCategories[index];
      StateValidator.validateCategoryLabel(previousCategory);
      if (categoryMapping.has(previousCategory)) {
        throw new TypeError(
          'Previous centroid category inventory must contain unique identities'
        );
      }
      categoryMapping.set(previousCategory, categories[index]);
    }
    if (new Set(categories).size !== categories.length) {
      throw new TypeError(
        'Current centroid category inventory must contain unique identities'
      );
    }
    if (!Object.hasOwn(field, 'centroidsByDim')) return;
    const byDimension = field.centroidsByDim;
    requireRecord(byDimension, 'Category field centroidsByDim');
    const pendingUpdates = [];
    for (const [dimension, centroids] of Object.entries(byDimension)) {
      if (!/^[1-3]$/.test(dimension)) {
        throw new TypeError(
          'Category centroid dimension keys must be 1, 2, or 3'
        );
      }
      if (!Array.isArray(centroids)) {
        throw new TypeError(
          `Category centroid dimension ${dimension} must be an array`
        );
      }
      const seenCategories = new Set();
      for (let centroidIndex = 0; centroidIndex < centroids.length; centroidIndex++) {
        const centroid = requireRecord(
          centroids[centroidIndex],
          `Category centroid ${dimension}:${centroidIndex}`
        );
        StateValidator.validateCategoryLabel(centroid.category);
        if (!categoryMapping.has(centroid.category)) {
          throw new TypeError(
            `Category centroid dimension ${dimension} references an unknown category identity`
          );
        }
        if (seenCategories.has(centroid.category)) {
          throw new TypeError(
            `Category centroid dimension ${dimension} duplicates a category identity`
          );
        }
        seenCategories.add(centroid.category);
        pendingUpdates.push([
          centroid,
          categoryMapping.get(centroid.category),
        ]);
      }
    }
    pendingUpdates.forEach(([centroid, category]) => {
      centroid.category = category;
    });
  }

  _refreshHighlightGroupsForField(source, fieldIndex) {
    requireSource(source);
    const index = requireIndex(fieldIndex, 'Highlight field index');
    const fields = requireInventory(this, source);
    if (index >= fields.length) {
      throw new RangeError(
        'Highlight field index is outside its exact inventory'
      );
    }
    const field = fields[index];
    if (!Array.isArray(this.highlightPages)) {
      throw new TypeError('Highlight pages must be an array');
    }
    requireMethod(this, '_notifyHighlightChange', 'Highlight state');

    const targets = [];
    for (let pageIndex = 0; pageIndex < this.highlightPages.length; pageIndex++) {
      const page = requireRecord(
        this.highlightPages[pageIndex],
        `Highlight page ${pageIndex}`
      );
      if (!Array.isArray(page.highlightedGroups)) {
        throw new TypeError(
          `Highlight page ${pageIndex} highlightedGroups must be an array`
        );
      }
      for (
        let groupIndex = 0;
        groupIndex < page.highlightedGroups.length;
        groupIndex++
      ) {
        const group = requireRecord(
          page.highlightedGroups[groupIndex],
          `Highlight group ${pageIndex}:${groupIndex}`
        );
        if (!Object.hasOwn(group, 'fieldSource')) continue;
        requireSource(group.fieldSource);
        requireIndex(
          group.fieldIndex,
          `Highlight group ${pageIndex}:${groupIndex} field index`
        );
        if (
          group.fieldSource !== source
          || group.fieldIndex !== index
        ) {
          continue;
        }
        if (group.type === 'category') {
          if (field.kind !== FieldKind.CATEGORY) {
            throw new Error(
              'Category highlight must reference a categorical field'
            );
          }
          const categories = requireCategoryInventory(
            field,
            'Highlighted category field'
          );
          const categoryIndex = requireIndex(
            group.categoryIndex,
            'Highlight category index'
          );
          if (categoryIndex >= categories.length) {
            throw new RangeError(
              'Highlight category index is outside its inventory'
            );
          }
        } else if (group.type === 'range') {
          if (field.kind !== FieldKind.CONTINUOUS) {
            throw new Error(
              'Range highlight must reference a continuous field'
            );
          }
          formatRangeValue(group.rangeMin);
          formatRangeValue(group.rangeMax);
        } else {
          throw new TypeError(
            'Field-owned highlight type must be category or range'
          );
        }
        targets.push(group);
      }
    }

    for (const group of targets) {
      group.fieldKey = field.key;
      if (group.type === 'category') {
        const categoryName = field.categories[group.categoryIndex];
        group.categoryName = categoryName;
        group.label = `${field.key}: ${categoryName}`;
      } else {
        group.label = (
          `${field.key}: ${formatRangeValue(group.rangeMin)}`
          + ` – ${formatRangeValue(group.rangeMax)}`
        );
      }
    }
    this._notifyHighlightChange();
  }

  _ensureUserDefinedCentroidsForDim(field, dim) {
    requireField(field, 'Dimension field');
    if (field._isUserDefined !== true) return;
    if (field.kind !== FieldKind.CATEGORY) return;
    const fieldId = requireIdentifier(
      field._userDefinedId,
      'User-defined centroid field id'
    );
    const dimension = requireIndex(dim, 'Centroid dimension');
    if (dimension < 1 || dimension > 3) {
      throw new RangeError('Centroid dimension must be from 1 through 3');
    }
    requireRecord(
      field.centroidsByDim,
      'User-defined field centroidsByDim'
    );
    const dimensionKey = String(dimension);
    if (Object.hasOwn(field.centroidsByDim, dimensionKey)) {
      if (!Array.isArray(field.centroidsByDim[dimensionKey])) {
        throw new TypeError(
          `User-defined centroid dimension ${dimensionKey} must be an array`
        );
      }
      return;
    }
    if (
      this.dimensionManager === null
      || typeof this.dimensionManager !== 'object'
      || !(this.dimensionManager.positionCache instanceof Map)
    ) {
      throw new TypeError(
        'User-defined centroid computation requires DimensionManager positionCache'
      );
    }
    if (!this.dimensionManager.positionCache.has(dimension)) {
      throw new Error(
        `Raw ${dimension}D positions are unavailable for centroid computation`
      );
    }
    const rawPositions = this.dimensionManager.positionCache.get(dimension);
    if (
      !(rawPositions instanceof Float32Array)
      || rawPositions.length !== this.pointCount * dimension
    ) {
      throw new TypeError(
        `Raw ${dimension}D positions must exactly match the current dataset`
      );
    }
    requireMethod(
      this._userDefinedFields,
      'recomputeCentroidsForDimension',
      'User-defined field registry'
    );
    this._userDefinedFields.recomputeCentroidsForDimension(
      fieldId,
      dimension,
      rawPositions
    );
    if (!Object.hasOwn(field.centroidsByDim, dimensionKey)) {
      throw new Error(
        `User-defined centroid dimension ${dimensionKey} was not published`
      );
    }
    if (!(field._normalizedDims instanceof Set)) {
      throw new TypeError(
        'User-defined centroid normalization state must be a Set'
      );
    }
    field._normalizedDims.delete(dimensionKey);
  }
}
