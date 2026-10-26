/**
 * @fileoverview Exact internal ownership for field overlays.
 *
 * @module state/managers/field/overlay-internals
 */

import { FieldKind, FieldSource } from '../../../utils/field-constants.js';
import { StateValidator } from '../../../utils/state-validator.js';
import { getFieldRegistry } from '../../../utils/field-registry.js';
import { requireObjectRecord } from '../../../../utils/exact-record.js';

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

function requireField(field, label) {
  requireObjectRecord(field, label);
  StateValidator.validateFieldKey(field.key);
  if (
    field.kind !== FieldKind.CATEGORY
    && field.kind !== FieldKind.CONTINUOUS
  ) {
    throw new TypeError(`${label} has an unsupported kind`);
  }
  return field;
}

/**
 * How many leading fields of each inventory were checked. A field's key and
 * kind change only through checked paths (a rename validates its new key), and
 * an inventory only grows (user-defined fields are appended), so a checked
 * inventory is read again only from its first unchecked field.
 * @type {WeakMap<Object[], number>}
 */
const checkedInventoryLengths = new WeakMap();

/**
 * One exact field inventory: an array of field records with valid keys and
 * kinds.
 * @param {*} value
 * @param {string} label
 * @param {{nullable?: boolean}} [options]
 * @returns {Object[]|null}
 */
export function requireFields(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  const checked = checkedInventoryLengths.get(value) ?? 0;
  for (let index = Math.min(checked, value.length); index < value.length; index++) {
    requireField(value[index], `${label}[${index}]`);
  }
  checkedInventoryLengths.set(value, value.length);
  return value;
}

function requireInventory(owner, source, { nullable = false } = {}) {
  requireSource(source);
  const data = source === FieldSource.VAR
    ? owner.varData
    : owner.obsData;
  if (nullable && data === null) return null;
  requireObjectRecord(data, `${source} field data`);
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

/**
 * The registry revisions each field inventory shows. A copy of an inventory
 * (a kept view's, a restored view's) shows what its source showed
 * (`carryOverlayRevisions`).
 * @type {WeakMap<Object[], {rename: number, delete: number}>}
 */
const overlayRevisions = new WeakMap();

/**
 * A copied inventory shows the same overlays as the one it was copied from.
 * @param {Object[]|undefined|null} from
 * @param {Object[]} to
 */
export function carryOverlayRevisions(from, to) {
  if (!Array.isArray(from)) return;
  const shown = overlayRevisions.get(from);
  if (shown !== undefined) overlayRevisions.set(to, shown);
}

/** Where a field of `originalKey` is in one inventory, or -1. */
function findFieldByOriginalKey(fields, source, originalKey) {
  // Inventories of one dataset list its fields in one order, so the shared
  // index is checked first; user-defined fields are never registry-edited.
  const indexed = getFieldRegistry().getIndexByKey(source, originalKey);
  const at = fields[indexed];
  if (at !== undefined && (at._originalKey ?? at.key) === originalKey) {
    return indexed;
  }
  return fields.findIndex(field => (field?._originalKey ?? field?.key) === originalKey);
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

  /**
   * Show one field inventory under the rename and delete registries.
   *
   * An inventory remembers the registry revisions it shows
   * (`overlayRevisions`); applying them again reads only the fields edited
   * since, so a view switch or a kept view costs the edits, not one pass over
   * every gene. An inventory not seen before, or one older than a whole
   * registry replacement (a dataset or a session restore), is read in full.
   */
  _applyOverlaysToFields(fields, source) {
    requireSource(source);
    if (fields === null) return;
    if (!Array.isArray(fields)) {
      throw new TypeError(`${source} overlay field inventory must be an array`);
    }
    if (fields.length === 0) return;
    for (const methodName of [
      'getDisplayCategory',
      'getDisplayKey',
      'getRevision',
      'editsSince',
      'hasEntriesFor'
    ]) {
      requireMethod(this._renameRegistry, methodName, 'Rename registry');
    }
    for (const methodName of ['isDeleted', 'isPurged', 'getRevision', 'editsSince', 'hasEntriesFor']) {
      requireMethod(this._deleteRegistry, methodName, 'Delete registry');
    }
    const revisions = {
      rename: this._renameRegistry.getRevision(),
      delete: this._deleteRegistry.getRevision()
    };
    const shown = overlayRevisions.get(fields);
    const renameEdits = shown === undefined
      ? null
      : this._renameRegistry.editsSince(shown.rename);
    const deleteEdits = shown === undefined
      ? null
      : this._deleteRegistry.editsSince(shown.delete);
    if (renameEdits === null || deleteEdits === null) {
      const inventory = requireFields(
        fields,
        `${source} overlay field inventory`
      );
      // With nothing of this source renamed or deleted, a field shows its
      // own name and categories: only a field still showing an earlier
      // overlay is read.
      const overlaid = this._renameRegistry.hasEntriesFor(source)
        || this._deleteRegistry.hasEntriesFor(source);
      for (let fieldIndex = 0; fieldIndex < inventory.length; fieldIndex++) {
        const field = inventory[fieldIndex];
        if (
          overlaid
          || field._isUserDefined === true
          || Object.hasOwn(field, '_originalKey')
          || Object.hasOwn(field, '_originalCategories')
          || Object.hasOwn(field, '_isDeleted')
          || Object.hasOwn(field, '_isPurged')
        ) {
          this._applyOverlayToField(field, source, fieldIndex);
        }
      }
    } else {
      const edited = new Set();
      for (const edit of [...renameEdits, ...deleteEdits]) {
        if (edit.source === source) edited.add(edit.originalKey);
      }
      for (const originalKey of edited) {
        const fieldIndex = findFieldByOriginalKey(fields, source, originalKey);
        if (fieldIndex < 0) continue;
        requireField(fields[fieldIndex], `${source} overlay field inventory[${fieldIndex}]`);
        this._applyOverlayToField(fields[fieldIndex], source, fieldIndex);
      }
    }
    overlayRevisions.set(fields, revisions);
  }

  /** Show one field under the rename and delete registries. */
  _applyOverlayToField(field, source, fieldIndex) {
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
      return;
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

    if (field.kind !== FieldKind.CATEGORY) return;
    // A column whose categories are found when it is first loaded gets
    // its category renames then (field/loading.js).
    if (field.categories === null) return;
    this._applyCategoryOverlay(field, source, originalKey, `${source} field ${fieldIndex}`);
  }

  /**
   * Show one categorical field's categories under their display names (the
   * rename registry), keeping the original names beside them.
   *
   * @param {Object} field
   * @param {string} source
   * @param {string} originalKey
   * @param {string} label
   */
  _applyCategoryOverlay(field, source, originalKey, label) {
    const categories = requireCategoryInventory(
      field,
      label
    );
    const previousCategories = [...categories];
    let originalCategories;
    if (Object.hasOwn(field, '_originalCategories')) {
      if (
        !Array.isArray(field._originalCategories)
        || field._originalCategories.length !== categories.length
      ) {
        throw new TypeError(
          `${label} original categories must exactly match its inventory`
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
      (originalLabel) => {
        const displayLabel = this._renameRegistry.getDisplayCategory(
          source,
          originalKey,
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

  _injectUserDefinedFields() {
    this._injectUserDefinedFieldsForSource(FieldSource.OBS);
    this._injectUserDefinedFieldsForSource(FieldSource.VAR);
  }

  /**
   * Every copy of one user-defined field, each once: the registry's own
   * (first), then the field object of each view's inventory that names it
   * (the focused view's is the state's, every other view's is its context's).
   *
   * @param {string} fieldId
   * @param {'obs'|'var'} source
   * @returns {object[]}
   */
  _userDefinedFieldCopies(fieldId, source) {
    requireSource(source);
    const id = requireIdentifier(fieldId, 'User-defined field id');
    requireMethod(this._userDefinedFields, 'getField', 'User-defined field registry');
    const template = requireField(
      this._userDefinedFields.getField(id),
      'User-defined field template'
    );
    if (template._userDefinedId !== id || template._fieldSource !== source) {
      throw new Error('User-defined field template ownership is inconsistent');
    }
    const copies = [template];
    const collect = (view, label) => {
      const inventory = source === FieldSource.VAR ? view.varData : view.obsData;
      if (inventory === null || inventory === undefined) return;
      const fields = requireFields(inventory.fields, label);
      for (const field of fields) {
        if (field._userDefinedId === id && !copies.includes(field)) copies.push(field);
      }
    };
    collect(this, `Focused ${source} fields`);
    if (this.viewContexts instanceof Map) {
      for (const [viewId, context] of this.viewContexts) {
        if (viewId === this.activeViewId) continue;
        collect(context, `View "${viewId}" ${source} fields`);
      }
    }
    return copies;
  }

  /**
   * Give a user-defined categorical a new definition in every copy at once.
   *
   * Its categories, codes and centroid tables are the field's, not a view's:
   * the registry holds one definition, a session saves it, and every view's
   * copy holds the same arrays and tables. A copy left holding the previous
   * ones went on drawing them, computed a new layout's centroids into a table
   * it no longer shared, or met the new categories under colours indexed for
   * the old ones. What belongs to a view, its colours and hidden categories,
   * is carried into the new categories by `carryCategoryState`, from that
   * copy's own; what the previous definition derived (counts, outlier
   * quantiles, the record of renamed categories) is dropped from every copy.
   *
   * The caller draws the views that use the field again
   * (`_redrawViewsUsingUserDefinedField`).
   *
   * @param {string} fieldId
   * @param {{
   *   categories: Array<string|number|boolean>,
   *   codes: Uint8Array|Uint16Array|Uint32Array,
   *   centroidsByLayout: Map<string, Array<object>>,
   *   normalizedLayouts: Set<string>,
   *   operation: object|null,
   *   sourceField?: object|null
   * }} definition
   * @param {(state: {
   *   categories: Array<string|number|boolean>,
   *   colors: number[][],
   *   visible: Object<number, boolean>
   * }) => {colors: number[][], visible: Object<number, boolean>}} carryCategoryState
   */
  _publishUserDefinedCategorical(fieldId, definition, carryCategoryState) {
    if (typeof carryCategoryState !== 'function') {
      throw new TypeError('A user-defined definition requires how a view carries its category state');
    }
    const copies = this._userDefinedFieldCopies(fieldId, FieldSource.OBS);
    for (const copy of copies) {
      if (copy.kind !== FieldKind.CATEGORY) {
        throw new TypeError('Every copy of a user-defined categorical must be categorical');
      }
    }
    // Each copy's own category state, read before the categories change.
    const carried = copies.map(copy => {
      if (copy._categoryColors === undefined && copy._categoryVisible === undefined) return null;
      this.ensureCategoryMetadata(copy);
      return carryCategoryState({
        categories: copy.categories,
        colors: copy._categoryColors,
        visible: copy._categoryVisible,
      });
    });
    const updated = requireBoolean(
      this._userDefinedFields.updateField(fieldId, {
        categories: definition.categories,
        codes: definition.codes,
        centroidsByLayout: definition.centroidsByLayout,
        normalizedLayouts: definition.normalizedLayouts,
        operation: definition.operation,
        ...(Object.hasOwn(definition, 'sourceField') ? { sourceField: definition.sourceField } : {}),
      }),
      'User-defined definition update result'
    );
    if (!updated) {
      throw new Error('User-defined definition update did not complete');
    }
    const [template] = copies;
    copies.forEach((copy, index) => {
      copy.categories = template.categories;
      copy.codes = template.codes;
      copy.centroidsByLayout = template.centroidsByLayout;
      copy._normalizedLayouts = template._normalizedLayouts;
      copy._sourceField = template._sourceField;
      copy._operation = template._operation;
      copy.loaded = true;
      const state = carried[index];
      if (state !== null) {
        copy._categoryColors = state.colors;
        copy._categoryVisible = state.visible;
      }
      delete copy._categoryCounts;
      delete copy._originalCategories;
      delete copy.outlierQuantiles;
      delete copy._outlierThreshold;
    });
    getFieldRegistry().invalidate();
  }

  /**
   * Draw again every view that uses a user-defined categorical whose
   * definition changed: a view coloured by it, from its new codes, and a view
   * that hides some of its categories, by its new visibility. Each other view
   * is drawn as the focused view, which then gets the focus back, as a new
   * latent space recolours the views (`_recolourCategoricalViews`).
   *
   * @param {string} fieldId
   * @param {{includeFocused: boolean}} options - Whether the focused view is
   *   drawn here too, or by the caller.
   */
  _redrawViewsUsingUserDefinedField(fieldId, { includeFocused }) {
    requireIdentifier(fieldId, 'User-defined field id');
    requireBoolean(includeFocused, 'Focused-view redraw');
    const focused = this.activeViewId;
    const useIn = view => {
      const fields = view.obsData?.fields;
      if (!Array.isArray(fields)) return null;
      const index = fields.findIndex(field => field?._userDefinedId === fieldId);
      if (index < 0) return null;
      const field = fields[index];
      if (field._isDeleted === true || field.loaded !== true) return null;
      const shows = view.activeFieldSource === FieldSource.OBS && view.activeFieldIndex === index;
      const filters = field._categoryFilterEnabled !== false
        && field._categoryVisible !== undefined
        && field.categories.some((_, code) => field._categoryVisible[code] === false);
      return shows || filters ? { index, shows } : null;
    };
    const redraw = use => {
      if (use.shows) this.setActiveField(use.index);
      else this.computeGlobalVisibility();
    };
    const others = [];
    if (this.viewContexts instanceof Map) {
      for (const [viewId, context] of this.viewContexts) {
        if (viewId === focused) continue;
        const use = useIn(context);
        if (use !== null) others.push(viewId);
      }
    }
    for (const viewId of others) {
      this.setActiveView(viewId);
      const use = useIn(this);
      if (use !== null) redraw(use);
    }
    if (this.activeViewId !== focused) this.setActiveView(focused);
    if (includeFocused) {
      const use = useIn(this);
      if (use !== null) redraw(use);
    }
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

    const existingIds = new Map();
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
      existingIds.set(fieldId, field);
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
      const copy = existingIds.get(templateId);
      if (copy !== undefined) {
        // A view's copy is deleted, restored and purged with its field, as a
        // dataset field's copy follows the delete registry
        // (`_applyOverlayToField`) when its view is shown: a field deleted in
        // another view is deleted here, and a purged one no longer holds
        // what its field released.
        if (copy !== template) {
          copy._isDeleted = template._isDeleted === true;
          copy._isPurged = template._isPurged === true;
          if (copy._isPurged) {
            copy.codes = template.codes;
            copy.values = template.values;
            copy.categories = template.categories;
            copy.centroidsByLayout = template.centroidsByLayout;
            copy._normalizedLayouts = template._normalizedLayouts;
            copy.loaded = template.loaded;
          }
        }
        continue;
      }

      const clone = { ...template, _loadingPromise: null };
      delete clone._categoryColors;
      delete clone._categoryVisible;
      delete clone._continuousStats;
      delete clone._continuousFilter;
      delete clone._continuousColorRange;
      delete clone._categoryCounts;
      fields.push(clone);
      existingIds.set(templateId, clone);
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
    if (!Object.hasOwn(field, 'centroidsByLayout')) return;
    const byLayout = field.centroidsByLayout;
    if (!(byLayout instanceof Map)) {
      throw new TypeError('Category field centroidsByLayout must be a Map');
    }
    const pendingUpdates = [];
    for (const [layoutKey, centroids] of byLayout) {
      if (typeof layoutKey !== 'string' || layoutKey.length === 0) {
        throw new TypeError(
          'Category centroid layout keys must be non-empty strings'
        );
      }
      if (!Array.isArray(centroids)) {
        throw new TypeError(
          `Category centroids of layout "${layoutKey}" must be an array`
        );
      }
      const seenCategories = new Set();
      for (let centroidIndex = 0; centroidIndex < centroids.length; centroidIndex++) {
        const centroid = requireObjectRecord(
          centroids[centroidIndex],
          `Category centroid ${layoutKey}:${centroidIndex}`
        );
        StateValidator.validateCategoryLabel(centroid.category);
        if (!categoryMapping.has(centroid.category)) {
          throw new TypeError(
            `Category centroids of layout "${layoutKey}" reference an unknown category identity`
          );
        }
        if (seenCategories.has(centroid.category)) {
          throw new TypeError(
            `Category centroids of layout "${layoutKey}" duplicate a category identity`
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
      const page = requireObjectRecord(
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
        const group = requireObjectRecord(
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

  /**
   * Give a user-defined categorical centroids for a layout it has none for.
   *
   * `positions` are the layout's normalized positions, the ones the view is
   * about to draw: the caller has already loaded and pinned them, so the
   * centroids are computed from exactly that geometry and are normalized from
   * birth. Any other field is left alone.
   *
   * @param {object} field
   * @param {string} layoutKey
   * @param {Float32Array} positions - normalized positions, stride = dimension
   */
  _ensureUserDefinedCentroidsForLayout(field, layoutKey, positions) {
    requireField(field, 'Layout field');
    if (field._isUserDefined !== true) return;
    if (field.kind !== FieldKind.CATEGORY) return;
    const fieldId = requireIdentifier(
      field._userDefinedId,
      'User-defined centroid field id'
    );
    const key = requireIdentifier(layoutKey, 'Centroid layout key');
    if (!(field.centroidsByLayout instanceof Map)) {
      throw new TypeError(
        'User-defined field centroidsByLayout must be a Map'
      );
    }
    if (field.centroidsByLayout.has(key)) {
      if (!Array.isArray(field.centroidsByLayout.get(key))) {
        throw new TypeError(
          `User-defined centroids of layout "${key}" must be an array`
        );
      }
      return;
    }
    if (
      this.dimensionManager === null
      || typeof this.dimensionManager !== 'object'
      || typeof this.dimensionManager.getLayout !== 'function'
    ) {
      throw new TypeError(
        'User-defined centroid computation requires the current DimensionManager'
      );
    }
    const dimension = this.dimensionManager.getLayout(key).dimension;
    if (
      !(positions instanceof Float32Array)
      || positions.length !== this.pointCount * dimension
    ) {
      throw new TypeError(
        `Normalized ${dimension}D positions must exactly match the current dataset`
      );
    }
    requireMethod(
      this._userDefinedFields,
      'recomputeCentroidsForLayout',
      'User-defined field registry'
    );
    this._userDefinedFields.recomputeCentroidsForLayout(
      fieldId,
      key,
      dimension,
      positions
    );
    if (
      !field.centroidsByLayout.has(key)
      || !(field._normalizedLayouts instanceof Set)
      || !field._normalizedLayouts.has(key)
    ) {
      throw new Error(
        `Normalized user-defined centroids of layout "${key}" were not published`
      );
    }
  }
}
