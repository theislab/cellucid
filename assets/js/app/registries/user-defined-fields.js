/**
 * UserDefinedFieldsRegistry - user-created categoricals derived from highlight pages.
 *
 * Responsibilities:
 * - Create a categorical codes array from highlight pages (with overlap strategy)
 * - Compute per-layout centroids from the normalized positions the viewer
 *   draws, with NO outlier filtering
 * - Persist soft-deletes so derived columns are restorable
 *
 * Session bundles persist:
 * - field *definitions* eagerly via `toSessionMeta()/fromSessionMeta()`
 * - large categorical codes arrays separately as binary chunks
 */

import { StateValidator } from '../utils/state-validator.js';
import { FieldKind, FieldSource, OverlapStrategy, generateId } from '../utils/field-constants.js';
import {
  categoricalStorageForCodes,
  categoricalStorageForCount,
  requireCategoricalCategoryCount
} from '../../data/categorical-storage-contract.js';
import { BaseRegistry } from './base-registry.js';
import {
  compareIntersectionMasks,
  intersectionMembership,
  orderedMembership
} from '../utils/page-membership.js';
import {
  computeAllLayoutCentroids,
  computeCentroidsForDimension
} from './user-defined-fields/centroids.js';
import { isCategoricalCodes } from '../../data/categorical-storage-contract.js';

function requireNonEmptyTrimmedString(value, context) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
  ) {
    throw new TypeError(`${context} must be a non-empty trimmed string`);
  }
  return value;
}

function requireNullableRecord(value, context) {
  if (
    value !== null
    && (
      typeof value !== 'object'
      || Array.isArray(value)
    )
  ) {
    throw new TypeError(`${context} must be an object or null`);
  }
  return value;
}

function requireCategoryInventory(categories, context) {
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new TypeError(`${context} must contain at least one label`);
  }
  // The ceiling a user-defined field accepts is the ceiling every reader and
  // both writers accept, derived once in `data/categorical-storage-contract.js`.
  // A narrower one here refused to copy, merge, or edit a categorical the app
  // had just loaded and drawn.
  requireCategoricalCategoryCount(categories.length, context);
  const categorySet = new Set();
  for (let index = 0; index < categories.length; index++) {
    const category = categories[index];
    StateValidator.validateCategoryLabel(category);
    if (categorySet.has(category)) {
      throw new TypeError(`${context} category label "${category}" is duplicated`);
    }
    categorySet.add(category);
  }
  return categories;
}

/**
 * Require that every code indexes a real category.
 *
 * Exported because the session restore path has to ask the same question. A
 * bundle can declare a code length and a code width that both check out while
 * naming categories the field does not have, and nothing downstream looks
 * again - the codes go straight into the field.
 *
 * @param {unknown} codes
 * @param {string[]} categories
 * @param {number} expectedLength
 * @param {string} context
 * @returns {Uint8Array|Uint16Array}
 */
export function requireCategoryCodes(codes, categories, expectedLength, context) {
  if (
    !isCategoricalCodes(codes)
    || codes.length !== expectedLength
  ) {
    throw new TypeError(`${context} codes must be an exact typed dataset-length array`);
  }
  const { missingValue } = categoricalStorageForCodes(codes, context);
  for (let index = 0; index < codes.length; index++) {
    if (codes[index] >= categories.length && codes[index] !== missingValue) {
      throw new RangeError(`${context} code ${index} is outside the category inventory`);
    }
  }
  return codes;
}

export class UserDefinedFieldsRegistry extends BaseRegistry {
  constructor() {
    super();
    this._fields = this._data; // id -> field definition
  }

  /**
   * Public wrapper for centroid computation so other components can reuse
   * the exact same per-layout centroid logic (DRY).
   *
   * Centroids exist for every layout whose normalized positions are resident,
   * and every one of them is recorded in `normalizedLayouts`: a field takes
   * both together. Each layout has one centroid for each category that holds
   * at least one cell.
   *
   * @param {Uint8Array|Uint16Array|Uint32Array} codes
   * @param {(string|number|boolean)[]} categories
   * @param {object} state - DataState
   * @returns {{
   *   centroidsByLayout: Map<string, Array<{category: string|number|boolean, position: number[], n_points: number}>>,
   *   normalizedLayouts: Set<string>
   * }}
   */
  computeCentroidsByLayout(codes, categories, state) {
    return computeAllLayoutCentroids(codes, categories, state);
  }

  /**
   * Register a user-defined categorical from already-materialized codes.
   * Used for destructive categorical edits (merge categories, delete→unassigned)
   * where we want to:
   * - Keep the original field intact (restorable via Deleted Fields)
   * - Persist the derived field through session bundles (compact binary codes)
   *
   * @param {object} options
   * @param {string} options.key
   * @param {(string|number|boolean)[]} options.categories
   * @param {Uint8Array|Uint16Array} options.codes
   * @param {object} [options.meta] - Optional metadata to attach (serialized if possible)
   * @param {object} state - DataState
   * @returns {{id: string, field: object}}
   */
  createFromCategoricalCodes(options, state) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Categorical field creation options must be an object');
    }
    const { key, categories, codes, meta, source } = options;

    StateValidator.validateFieldKey(key);

    requireCategoryInventory(categories, 'Categorical field');
    if (
      !state
      || typeof state !== 'object'
      || !Number.isSafeInteger(state.pointCount)
      || state.pointCount < 1
    ) {
      throw new TypeError('Categorical field creation requires an exact current pointCount');
    }
    requireCategoryCodes(codes, categories, state.pointCount, 'Categorical field');
    if (source !== FieldSource.OBS && source !== FieldSource.VAR) {
      throw new TypeError('Categorical field source must be exactly "obs" or "var"');
    }
    if (meta !== undefined) {
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
        throw new TypeError('Categorical field metadata must be an object');
      }
      for (const metadataKey of Object.keys(meta)) {
        if (metadataKey !== '_sourceField' && metadataKey !== '_operation') {
          throw new TypeError(`Unsupported categorical field metadata key "${metadataKey}"`);
        }
        const metadataValue = meta[metadataKey];
        if (!metadataValue || typeof metadataValue !== 'object' || Array.isArray(metadataValue)) {
          throw new TypeError(`Categorical field metadata ${metadataKey} must be an object`);
        }
      }
    }

    const id = generateId('user_cat');
    const { centroidsByLayout, normalizedLayouts } =
      computeAllLayoutCentroids(codes, categories, state);

    const field = {
      key,
      kind: FieldKind.CATEGORY,
      categories: [...categories],
      codes,
      centroidsByLayout,
      loaded: true,

      _isUserDefined: true,
      _isDeleted: false,
      _isPurged: false,
      _userDefinedId: id,
      _fieldSource: source,
      _normalizedLayouts: normalizedLayouts,
      _sourceField: meta?._sourceField ?? null,
      _operation: meta?._operation ?? null,
      _sourcePages: [],
      _overlapStrategy: OverlapStrategy.FIRST,
      _overlapLabel: null,
      _intersectionLabels: null,
      _uncoveredLabel: null,
      _createdAt: Date.now(),
    };

    this._fields.set(id, field);
    return { id, field };
  }

  /**
   * Register a user-defined continuous field that is sourced from an existing
   * obs/var continuous field (e.g. "copy continuous obs" or "copy gene expression").
   *
   * We intentionally do NOT persist the raw values array in session bundles.
   * DataState re-materializes values by copying from the referenced source field.
   *
   * @param {object} options
   * @param {string} options.key
   * @param {'obs'|'var'} options.source
   * @param {{sourceKey: string, sourceIndex?: number, kind?: string}} options.sourceField
   * @param {object} [options.meta]
   * @returns {{id: string, field: object}}
   */
  createContinuousAlias(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Continuous field copy options must be an object');
    }
    const { key, source, sourceField, meta } = options;

    StateValidator.validateFieldKey(key);

    if (source !== FieldSource.OBS && source !== FieldSource.VAR) {
      throw new TypeError('Continuous field source must be exactly "obs" or "var"');
    }
    if (!sourceField || typeof sourceField !== 'object' || Array.isArray(sourceField)) {
      throw new TypeError('Continuous field copy requires sourceField metadata');
    }
    if (
      typeof sourceField.sourceKey !== 'string'
      || sourceField.sourceKey.length === 0
      || sourceField.sourceKey !== sourceField.sourceKey.trim()
    ) {
      throw new Error('sourceField.sourceKey must be a non-empty trimmed string');
    }
    if (
      typeof sourceField.kind !== 'string'
      || sourceField.kind.length === 0
      || sourceField.kind !== sourceField.kind.trim()
    ) {
      throw new TypeError('sourceField.kind must be a non-empty trimmed string');
    }
    if (!Number.isSafeInteger(sourceField.sourceIndex) || sourceField.sourceIndex < 0) {
      throw new TypeError('sourceField.sourceIndex must be a non-negative safe integer');
    }
    if (meta !== undefined) {
      if (
        !meta
        || typeof meta !== 'object'
        || Array.isArray(meta)
        || Object.keys(meta).some((metadataKey) => metadataKey !== '_operation')
      ) {
        throw new TypeError('Continuous field metadata may contain only _operation');
      }
      if (!meta._operation || typeof meta._operation !== 'object' || Array.isArray(meta._operation)) {
        throw new TypeError('Continuous field _operation metadata must be an object');
      }
    }

    const id = generateId(source === FieldSource.VAR ? 'user_var_cont' : 'user_obs_cont');
    const template = {
      key,
      kind: FieldKind.CONTINUOUS,
      values: null,
      loaded: false,
      _loadingPromise: null,

      _isUserDefined: true,
      _isDeleted: false,
      _isPurged: false,
      _userDefinedId: id,
      _fieldSource: source,
      _sourceField: { ...sourceField },
      _operation: meta?._operation ?? null,
      _createdAt: Date.now(),
    };

    // Store the template (no values). Return a shallow clone so callers can
    // materialize values without bloating the serialized template.
    this._fields.set(id, template);
    return { id, field: { ...template } };
  }

  /**
   * Create a categorical field from highlight pages.
   * @param {object} options
   * @param {string} options.key
   * @param {Array<{pageId: string, label: string}>} options.pages
   * @param {string} options.uncoveredLabel
   * @param {string} options.overlapStrategy - 'first'|'last'|'overlap-label'|'intersections'
   * @param {string} options.overlapLabel
   * @param {Record<string, string>} options.intersectionLabels - mask->label when overlapStrategy='intersections'
   * @param {object} state - DataState
   * @returns {{id: string, field: object, conflicts: number, uncoveredCount: number}}
   */
  createFromPages(options, state) {
    StateValidator.validateUserDefinedOptions(options);
    const {
      key,
      pages,
      uncoveredLabel,
      overlapStrategy,
      overlapLabel,
      intersectionLabels
    } = options;

    if (
      state === null
      || typeof state !== 'object'
      || Array.isArray(state)
      || !Number.isSafeInteger(state.pointCount)
      || state.pointCount < 1
      || !Array.isArray(state.highlightPages)
    ) {
      throw new Error('Creating a categorical requires exact current cell and highlight-page state');
    }

    const pointCount = state.pointCount;
    const pagesById = new Map();
    for (
      let pageIndex = 0;
      pageIndex < state.highlightPages.length;
      pageIndex++
    ) {
      const page = state.highlightPages[pageIndex];
      if (
        page === null
        || typeof page !== 'object'
        || Array.isArray(page)
        || typeof page.id !== 'string'
        || page.id.length === 0
        || page.id !== page.id.trim()
        || !Array.isArray(page.highlightedGroups)
      ) {
        throw new TypeError(
          `Current highlight page ${pageIndex} is malformed`
        );
      }
      if (pagesById.has(page.id)) {
        throw new Error(`Current highlight page id "${page.id}" is duplicated`);
      }
      pagesById.set(page.id, page);
    }
    const resolvedPages = pages.map((pageInfo, pageIndex) => {
      const page = pagesById.get(pageInfo.pageId);
      if (page === undefined) {
        throw new Error(
          `Page ${pageIndex} does not identify a current highlight page: ${pageInfo.pageId}`
        );
      }
      return {
        pageInfo,
        page
      };
    });

    // Each page's enabled groups, validated as the membership is built.
    const membershipPages = resolvedPages.map(({ page }) => {
      if (!Array.isArray(page.highlightedGroups)) {
        throw new TypeError(`Highlight page "${page.id}" requires a highlightedGroups array`);
      }
      const groups = [];
      const groupIndices = [];
      for (let groupIndex = 0; groupIndex < page.highlightedGroups.length; groupIndex++) {
        const group = page.highlightedGroups[groupIndex];
        if (!group || typeof group !== 'object' || Array.isArray(group)) {
          throw new TypeError(`Highlight page "${page.id}" group ${groupIndex} must be an object`);
        }
        if (typeof group.enabled !== 'boolean') {
          throw new TypeError(
            `Highlight page "${page.id}" group ${groupIndex} requires exact enabled state`
          );
        }
        if (!Array.isArray(group.cellIndices) && !(group.cellIndices instanceof Uint32Array)) {
          throw new TypeError(
            `Highlight page "${page.id}" group ${groupIndex} requires exact cell indices`
          );
        }
        if (!group.enabled) continue;
        groups.push(group.cellIndices);
        groupIndices.push(groupIndex);
      }
      return {
        groups,
        describeGroup: position => `Highlight page "${page.id}" group ${groupIndices[position]}`
      };
    });

    const pageLabels = pages.map(pageInfo => pageInfo.label);
    const hasUncovered = uncoveredLabel.length > 0;
    const strategy = overlapStrategy;

    let categories = [...pageLabels];
    let overlapCategoryLabel = null;
    let overlapCategoryIndex = -1;
    let intersectionLabelByMask = null;
    let uncoveredCategoryLabel = null;
    let uncoveredCount = 0;
    let conflictCount = 0;
    let codes = null;

    // ---------------------------------------------------------------------
    // Strategy: split overlaps into intersection categories
    // ---------------------------------------------------------------------
    if (strategy === OverlapStrategy.INTERSECTIONS) {
      const membership = intersectionMembership(membershipPages, pointCount);
      const intersectionMasks = [...membership.intersectionCounts.keys()]
        .sort(compareIntersectionMasks);
      const expectedMaskKeys = intersectionMasks.map(mask => String(mask));
      const expectedMaskKeySet = new Set(expectedMaskKeys);
      const providedMaskKeys = Object.keys(intersectionLabels);
      if (
        providedMaskKeys.length !== expectedMaskKeys.length
        || providedMaskKeys.some(maskKey => !expectedMaskKeySet.has(maskKey))
      ) {
        throw new Error(
          'Intersection labels must identify every current overlap mask exactly once'
        );
      }

      intersectionLabelByMask = { ...intersectionLabels };
      const intersectionIndexByMask = new Map();

      for (const mask of intersectionMasks) {
        intersectionIndexByMask.set(mask, categories.length);
        categories.push(intersectionLabels[String(mask)]);
      }

      if (hasUncovered) {
        uncoveredCategoryLabel = uncoveredLabel;
        categories.push(uncoveredCategoryLabel);
      }

      requireCategoryInventory(categories, 'Highlight-page categorical field');

      const storage = categoricalStorageForCount(
        categories.length,
        'Highlight-page categorical field'
      );
      const uncoveredIndex = hasUncovered
        ? (categories.length - 1)
        : storage.missingValue;
      codes = new storage.TypedArrayClass(pointCount);
      const { masks } = membership;
      for (let cellIdx = 0; cellIdx < pointCount; cellIdx++) {
        const mask = masks[cellIdx];
        if (mask === 0) {
          codes[cellIdx] = uncoveredIndex;
        } else if ((mask & (mask - 1)) === 0) {
          codes[cellIdx] = 31 - Math.clz32(mask);
        } else {
          codes[cellIdx] = intersectionIndexByMask.get(mask);
        }
      }

      conflictCount = membership.overlapCount;
      uncoveredCount = pointCount - membership.coveredCount;
    } else {
      // -------------------------------------------------------------------
      // Strategies: first/last/overlap-label
      // -------------------------------------------------------------------

      if (strategy === OverlapStrategy.OVERLAP_LABEL) {
        overlapCategoryLabel = overlapLabel;
        overlapCategoryIndex = categories.length;
        categories.push(overlapCategoryLabel);
      } else if (
        strategy !== OverlapStrategy.FIRST
        && strategy !== OverlapStrategy.LAST
      ) {
        throw new TypeError(
          `Overlap strategy "${strategy}" has no implementation`
        );
      }

      if (hasUncovered) {
        uncoveredCategoryLabel = uncoveredLabel;
        categories.push(uncoveredCategoryLabel);
      }

      requireCategoryInventory(categories, 'Highlight-page categorical field');

      const storage = categoricalStorageForCount(
        categories.length,
        'Highlight-page categorical field'
      );
      const unassigned = hasUncovered
        ? (categories.length - 1)
        : storage.missingValue;
      codes = new storage.TypedArrayClass(pointCount);

      const membership = orderedMembership(membershipPages, pointCount);
      const owner = strategy === OverlapStrategy.LAST ? membership.last : membership.first;
      const { overlapping } = membership;
      for (let cellIdx = 0; cellIdx < pointCount; cellIdx++) {
        const page = owner[cellIdx];
        if (page < 0) {
          codes[cellIdx] = unassigned;
        } else if (strategy === OverlapStrategy.OVERLAP_LABEL && overlapping[cellIdx] === 1) {
          codes[cellIdx] = overlapCategoryIndex;
        } else {
          codes[cellIdx] = page;
        }
      }
      conflictCount = membership.overlapCount;
      uncoveredCount = pointCount - membership.coveredCount;
    }

    const { centroidsByLayout, normalizedLayouts } =
      computeAllLayoutCentroids(codes, categories, state);
    const id = generateId('user_cat');

    const field = {
      key,
      kind: FieldKind.CATEGORY,
      categories: [...categories],
      codes,
      centroidsByLayout,
      loaded: true,

      _isUserDefined: true,
      _isDeleted: false,
      _isPurged: false,
      _userDefinedId: id,
      _fieldSource: FieldSource.OBS,
      _normalizedLayouts: normalizedLayouts,
      _sourceField: null,
      _operation: null,
      _sourcePages: pages.map((p) => ({ pageId: p.pageId, label: p.label })),
      _overlapStrategy: strategy,
      _overlapLabel: overlapCategoryLabel,
      _intersectionLabels: intersectionLabelByMask,
      _uncoveredLabel: uncoveredCategoryLabel,
      _createdAt: Date.now()
    };

    this._fields.set(id, field);

    return { id, field, conflicts: conflictCount, uncoveredCount };
  }

  /**
   * Lazy centroid computation for a layout that was not resident when the
   * field's centroids were last computed. Called when a view switches to a
   * layout, with the normalized positions that view is about to draw; the
   * centroids are therefore normalized, and recorded as such.
   * @param {string} fieldId
   * @param {string} layoutKey
   * @param {number} dim - The layout's dimension
   * @param {Float32Array} positions - the layout's normalized positions, stride = dim
   */
  recomputeCentroidsForLayout(fieldId, layoutKey, dim, positions) {
    if (
      typeof fieldId !== 'string'
      || fieldId.length === 0
      || fieldId !== fieldId.trim()
    ) {
      throw new TypeError('Centroid field id must be a non-empty trimmed string');
    }
    const field = this._fields.get(fieldId);
    if (!field) {
      throw new Error(`User-defined field "${fieldId}" does not exist`);
    }
    if (
      !(field.centroidsByLayout instanceof Map)
      || !(field._normalizedLayouts instanceof Set)
    ) {
      throw new TypeError(`User-defined field "${fieldId}" has invalid centroid metadata`);
    }
    if (typeof layoutKey !== 'string' || layoutKey.length === 0) {
      throw new TypeError('Centroid layout key must be a non-empty string');
    }
    const centroids =
      computeCentroidsForDimension(field.codes, field.categories, positions, dim);
    field.centroidsByLayout.set(layoutKey, centroids);
    field._normalizedLayouts.add(layoutKey);
  }

  getField(id) {
    return this._fields.get(id);
  }

  getAllFields() {
    return [...this._fields.values()];
  }

  getAllFieldsForSource(source) {
    if (source !== FieldSource.OBS && source !== FieldSource.VAR) {
      throw new TypeError('User-defined field source must be exactly "obs" or "var"');
    }
    return this.getAllFields().filter((field) => {
      if (!field || typeof field !== 'object') {
        throw new TypeError('User-defined field inventory contains an invalid entry');
      }
      if (field._fieldSource !== FieldSource.OBS && field._fieldSource !== FieldSource.VAR) {
        throw new TypeError(`User-defined field "${field._userDefinedId}" has invalid source`);
      }
      return field._fieldSource === source;
    });
  }

  deleteField(id) {
    return this._fields.delete(id);
  }

  /**
   * Purge a soft-deleted field, releasing everything it can no longer use.
   *
   * A purge is irreversible - the restore list excludes purged fields - so the
   * per-cell codes, the category inventory and the centroids are dead weight
   * the moment it happens. They are released here rather than left for the
   * garbage collector to never collect, because the template stays in the map
   * so its id stays taken.
   *
   * The entry is kept, not deleted, so a later field cannot silently reuse the
   * id a session bundle may still name.
   *
   * @param {string} id
   * @returns {boolean} `true` once the field is purged.
   */
  purgeField(id) {
    requireNonEmptyTrimmedString(id, 'User-defined field id');
    const field = this._fields.get(id);
    if (!field) {
      throw new Error(`User-defined field "${id}" does not exist`);
    }
    if (field._isDeleted !== true) {
      throw new Error('Only a soft-deleted user-defined field can be purged');
    }
    if (field._isPurged === true) return true;

    field._isPurged = true;
    field.codes = null;
    field.values = null;
    field.categories = [];
    field.centroidsByLayout = new Map();
    field.loaded = false;
    field._normalizedLayouts = new Set();
    field._sourcePages = [];
    field._intersectionLabels = null;
    return true;
  }

  updateField(id, updates) {
    requireNonEmptyTrimmedString(id, 'User-defined field id');
    const field = this._fields.get(id);
    if (!field) {
      throw new Error(`User-defined field "${id}" does not exist`);
    }
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new TypeError('User-defined field updates must be an object');
    }
    const updateKeys = Object.keys(updates);
    const supportedKeys = new Set([
      'categories',
      'centroidsByLayout',
      'codes',
      'isDeleted',
      'key',
      'normalizedLayouts',
      'operation',
      'sourceField'
    ]);
    if (updateKeys.length === 0) {
      throw new TypeError('User-defined field updates must not be empty');
    }
    for (const updateKey of updateKeys) {
      if (!supportedKeys.has(updateKey)) {
        throw new TypeError(`Unsupported user-defined field update "${updateKey}"`);
      }
    }

    const nextKey = Object.hasOwn(updates, 'key') ? updates.key : field.key;
    StateValidator.validateFieldKey(nextKey);
    const nextCategories = Object.hasOwn(updates, 'categories')
      ? updates.categories
      : field.categories;
    const nextCodes = Object.hasOwn(updates, 'codes') ? updates.codes : field.codes;
    if (field.kind === FieldKind.CATEGORY) {
      requireCategoryInventory(nextCategories, `User-defined field "${id}"`);
      // Every code is already known to name a category in this inventory; that
      // is this registry's invariant, established at creation and re-checked on
      // every update that moves either operand. A rename moves neither -- it
      // swaps a label for a label of the same inventory size against the same
      // array -- so re-reading every code cannot change the verdict, and at
      // dataset scale that read is the entire cost of the edit. It also used to
      // reject a rename outright while a restored field waited for its lazy
      // codes chunk, because an unloaded field has no codes to walk.
      const inventoryResized = nextCategories.length !== field.categories.length;
      if (nextCodes !== field.codes || inventoryResized) {
        const expectedLength = isCategoricalCodes(field.codes)
          ? field.codes.length
          : field._codesLengthHint;
        if (!Number.isSafeInteger(expectedLength) || expectedLength < 1) {
          throw new TypeError(`User-defined field "${id}" requires an exact code length`);
        }
        requireCategoryCodes(
          nextCodes,
          nextCategories,
          expectedLength,
          `User-defined field "${id}"`
        );
      }
    } else if (
      Object.hasOwn(updates, 'categories')
      || Object.hasOwn(updates, 'codes')
      || Object.hasOwn(updates, 'centroidsByLayout')
      || Object.hasOwn(updates, 'normalizedLayouts')
    ) {
      throw new TypeError('Continuous user-defined fields cannot accept categorical updates');
    }

    const nextCentroids = Object.hasOwn(updates, 'centroidsByLayout')
      ? updates.centroidsByLayout
      : field.centroidsByLayout;
    if (
      field.kind === FieldKind.CATEGORY
      && !(nextCentroids instanceof Map)
    ) {
      throw new TypeError(`User-defined field "${id}" requires centroid metadata`);
    }
    const nextNormalizedLayouts = Object.hasOwn(updates, 'normalizedLayouts')
      ? updates.normalizedLayouts
      : field._normalizedLayouts;
    if (
      field.kind === FieldKind.CATEGORY
      && !(nextNormalizedLayouts instanceof Set)
    ) {
      throw new TypeError(`User-defined field "${id}" normalization state must be a Set`);
    }
    const nextSourceField = Object.hasOwn(updates, 'sourceField')
      ? updates.sourceField
      : field._sourceField;
    const nextOperation = Object.hasOwn(updates, 'operation')
      ? updates.operation
      : field._operation;
    requireNullableRecord(nextSourceField, `User-defined field "${id}" source metadata`);
    requireNullableRecord(nextOperation, `User-defined field "${id}" operation metadata`);
    const nextIsDeleted = Object.hasOwn(updates, 'isDeleted')
      ? updates.isDeleted
      : field._isDeleted;
    if (typeof nextIsDeleted !== 'boolean') {
      throw new TypeError(`User-defined field "${id}" deletion state must be boolean`);
    }

    field.key = nextKey;
    field._sourceField = nextSourceField;
    field._operation = nextOperation;
    field._isDeleted = nextIsDeleted;
    if (field.kind === FieldKind.CATEGORY) {
      field.categories = nextCategories;
      field.codes = nextCodes;
      field.centroidsByLayout = nextCentroids;
      field._normalizedLayouts = nextNormalizedLayouts;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  /**
   * Session-bundle metadata export (NO heavy codes payloads).
   *
   * The session bundle stores user-defined field definitions in an eager JSON
   * chunk (key/categories/source refs), while the large categorical `codes`
   * arrays are stored separately as binary chunks and loaded lazily.
   *
   * Centroids are not part of the record: they are derived from the codes
   * and each layout's positions, and recomputed when the codes are restored.
   *
   * @returns {any[]}
   */
  toSessionMeta() {
    const result = [];
    for (const [id, field] of this._fields) {
      requireNonEmptyTrimmedString(id, 'User-defined field id');
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        throw new TypeError(`User-defined field "${id}" must be an object`);
      }
      const source = field._fieldSource;
      if (source !== FieldSource.OBS && source !== FieldSource.VAR) {
        throw new TypeError(`User-defined field "${id}" has invalid source`);
      }
      const kind = field.kind;
      if (kind !== FieldKind.CONTINUOUS && kind !== FieldKind.CATEGORY) {
        throw new TypeError(`User-defined field "${id}" has invalid kind`);
      }
      StateValidator.validateFieldKey(field.key);
      if (typeof field._isDeleted !== 'boolean' || typeof field._isPurged !== 'boolean') {
        throw new TypeError(`User-defined field "${id}" requires exact lifecycle state`);
      }
      if (field._isPurged && !field._isDeleted) {
        throw new TypeError(`Purged user-defined field "${id}" must also be deleted`);
      }
      requireNullableRecord(field._sourceField, `User-defined field "${id}" source metadata`);
      requireNullableRecord(field._operation, `User-defined field "${id}" operation metadata`);
      if (!Number.isFinite(field._createdAt)) {
        throw new TypeError(`User-defined field "${id}" requires a finite creation time`);
      }

      if (field._isPurged) {
        // A purge is irreversible, so nothing here can ever be shown or
        // restored again. Only the identity survives, and only so the id
        // stays taken. Describing the released arrays would be describing
        // data that no longer exists, and writing them would add megabytes
        // to every bundle for a column the user permanently discarded.
        result.push({
          id,
          source,
          kind,
          key: field.key,
          isDeleted: true,
          isPurged: true,
          sourceField: field._sourceField,
          operation: field._operation,
          createdAt: field._createdAt
        });
        continue;
      }

      if (kind === FieldKind.CONTINUOUS) {
        // Continuous aliases: metadata-only, values are materialized by copying from source fields.
        result.push({
          id,
          source,
          kind,
          key: field.key,
          isDeleted: field._isDeleted,
          isPurged: field._isPurged,
          sourceField: field._sourceField,
          operation: field._operation,
          createdAt: field._createdAt
        });
        continue;
      }

      // Categorical user-defined fields: store definition (no codes array).
      requireCategoryInventory(
        field.categories,
        `User-defined field "${id}"`
      );
      if (!isCategoricalCodes(field.codes)) {
        throw new TypeError(`User-defined field "${id}" requires exact typed codes`);
      }
      if (field.loaded !== true) {
        throw new TypeError(
          `User-defined field "${id}" must be loaded before session capture`
        );
      }
      requireCategoryCodes(
        field.codes,
        field.categories,
        field.codes.length,
        `User-defined field "${id}"`
      );
      const codesType = field.codes.constructor.name;
      const codesLength = field.codes.length;
      if (
        !(field.centroidsByLayout instanceof Map)
        || !(field._normalizedLayouts instanceof Set)
        || !Array.isArray(field._sourcePages)
        || !Object.values(OverlapStrategy).includes(field._overlapStrategy)
      ) {
        throw new TypeError(`User-defined field "${id}" has invalid categorical metadata`);
      }
      if (field._overlapLabel !== null) {
        requireNonEmptyTrimmedString(field._overlapLabel, `User-defined field "${id}" overlap label`);
      }
      requireNullableRecord(
        field._intersectionLabels,
        `User-defined field "${id}" intersection labels`
      );
      if (field._uncoveredLabel !== null) {
        requireNonEmptyTrimmedString(field._uncoveredLabel, `User-defined field "${id}" uncovered label`);
      }

      result.push({
        id,
        source,
        kind,
        key: field.key,
        categories: [...field.categories],
        isDeleted: field._isDeleted,
        isPurged: field._isPurged,
        codesLength,
        codesType,
        sourceField: field._sourceField,
        operation: field._operation,
        sourcePages: field._sourcePages,
        overlapStrategy: field._overlapStrategy,
        overlapLabel: field._overlapLabel,
        intersectionLabels: field._intersectionLabels,
        uncoveredLabel: field._uncoveredLabel,
        createdAt: field._createdAt
      });
    }
    return result;
  }

  /**
   * Restore user-defined field definitions from session-bundle metadata.
   *
   * Note: categorical `codes` arrays are intentionally NOT restored here.
   * They are attached later by the session-bundle lazy `user-defined/codes/*` chunks.
   *
   * @param {any[]} data
   */
  fromSessionMeta(data) {
    if (!Array.isArray(data)) {
      throw new TypeError('User-defined session metadata must be an array');
    }
    const restored = new Map();
    for (let itemIndex = 0; itemIndex < data.length; itemIndex++) {
      const item = data[itemIndex];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new TypeError(`User-defined session item ${itemIndex} must be an object`);
      }
      const kind = item.kind;
      const source = item.source;
      if (kind !== FieldKind.CONTINUOUS && kind !== FieldKind.CATEGORY) {
        throw new TypeError(`User-defined session item ${itemIndex} has invalid kind`);
      }
      if (source !== FieldSource.OBS && source !== FieldSource.VAR) {
        throw new TypeError(`User-defined session item ${itemIndex} has invalid source`);
      }
      requireNonEmptyTrimmedString(item.id, `User-defined session item ${itemIndex} id`);
      StateValidator.validateFieldKey(item.key);
      if (restored.has(item.id)) {
        throw new TypeError(`User-defined session id "${item.id}" is duplicated`);
      }
      if (typeof item.isDeleted !== 'boolean' || typeof item.isPurged !== 'boolean') {
        throw new TypeError(`User-defined session item ${itemIndex} requires exact lifecycle state`);
      }
      if (item.isPurged && !item.isDeleted) {
        throw new TypeError(`Purged user-defined session item ${itemIndex} must also be deleted`);
      }
      requireNullableRecord(item.sourceField, `User-defined session item ${itemIndex} source metadata`);
      requireNullableRecord(item.operation, `User-defined session item ${itemIndex} operation metadata`);
      if (!Number.isFinite(item.createdAt)) {
        throw new TypeError(`User-defined session item ${itemIndex} requires a finite creation time`);
      }

      if (item.isPurged) {
        // The tombstone written by `toSessionMeta`. It carries no codes and
        // no categories because the purge released them, so restoring it can
        // only re-establish that the id is taken.
        restored.set(item.id, {
          key: item.key,
          kind,
          values: null,
          codes: null,
          categories: [],
          centroidsByLayout: new Map(),
          loaded: false,
          _loadingPromise: null,

          _isUserDefined: true,
          _isDeleted: true,
          _isPurged: true,
          _userDefinedId: item.id,
          _fieldSource: source,
          _normalizedLayouts: new Set(),
          _sourceField: item.sourceField,
          _operation: item.operation,
          _sourcePages: [],
          _overlapStrategy: OverlapStrategy.FIRST,
          _overlapLabel: null,
          _intersectionLabels: null,
          _uncoveredLabel: null,
          _createdAt: item.createdAt
        });
        continue;
      }

      if (kind === FieldKind.CONTINUOUS) {
        const field = {
          key: item.key,
          kind: FieldKind.CONTINUOUS,
          values: null,
          loaded: false,
          _loadingPromise: null,

          _isUserDefined: true,
          _isDeleted: item.isDeleted,
          _isPurged: item.isPurged,
          _userDefinedId: item.id,
          _fieldSource: source,
          _sourceField: item.sourceField,
          _operation: item.operation,
          _createdAt: item.createdAt
        };

        restored.set(item.id, field);
        continue;
      }

      // Categorical metadata is incomplete until its exact binary codes chunk
      // is restored. Never publish an empty array as usable scientific data.
      if (
        item.codesType !== 'Uint8Array'
        && item.codesType !== 'Uint16Array'
        && item.codesType !== 'Uint32Array'
      ) {
        throw new TypeError(`User-defined session item ${itemIndex} has invalid codesType`);
      }
      if (!Number.isSafeInteger(item.codesLength) || item.codesLength < 1) {
        throw new TypeError(`User-defined session item ${itemIndex} has invalid codesLength`);
      }
      if (
        !Array.isArray(item.categories)
        || item.categories.length === 0
        || !Array.isArray(item.sourcePages)
        || !Object.values(OverlapStrategy).includes(item.overlapStrategy)
      ) {
        throw new TypeError(`User-defined session item ${itemIndex} has invalid categorical metadata`);
      }
      requireCategoryInventory(
        item.categories,
        `User-defined session item ${itemIndex}`
      );
      if (item.overlapLabel !== null) {
        requireNonEmptyTrimmedString(
          item.overlapLabel,
          `User-defined session item ${itemIndex} overlap label`
        );
      }
      requireNullableRecord(
        item.intersectionLabels,
        `User-defined session item ${itemIndex} intersection labels`
      );
      if (item.uncoveredLabel !== null) {
        requireNonEmptyTrimmedString(
          item.uncoveredLabel,
          `User-defined session item ${itemIndex} uncovered label`
        );
      }
      // Centroids are not stored: they are derived from the codes and the
      // positions of each layout, and computed once the codes are restored.
      const centroidsByLayout = new Map();
      const normalizedLayouts = new Set();
      const field = {
        key: item.key,
        kind: FieldKind.CATEGORY,
        categories: [...item.categories],
        codes: null,
        centroidsByLayout,
        loaded: false,
        _loadingPromise: null,

        _isUserDefined: true,
        _isDeleted: item.isDeleted,
        _isPurged: item.isPurged,
        _userDefinedId: item.id,
        _fieldSource: source,
        _sourceField: item.sourceField,
        _operation: item.operation,
        _sourcePages: item.sourcePages,
        _overlapStrategy: item.overlapStrategy,
        _overlapLabel: item.overlapLabel,
        _intersectionLabels: item.intersectionLabels,
        _uncoveredLabel: item.uncoveredLabel,
        _createdAt: item.createdAt,
        _normalizedLayouts: normalizedLayouts,

        // Hints used by session restore to validate incoming code payloads.
        _codesLengthHint: item.codesLength,
        _codesTypeHint: item.codesType
      };

      restored.set(item.id, field);
    }

    this._fields.clear();
    for (const [id, field] of restored) {
      this._fields.set(id, field);
    }
  }

  clear() {
    this._fields.clear();
  }
}
