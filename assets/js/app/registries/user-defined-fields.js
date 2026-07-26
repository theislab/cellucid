/**
 * UserDefinedFieldsRegistry - user-created categoricals derived from highlight pages.
 *
 * Responsibilities:
 * - Create a categorical codes array from highlight pages (with overlap strategy)
 * - Compute per-dimension centroids (raw space) with NO outlier filtering
 * - Persist soft-deletes so derived columns are restorable
 *
 * Session bundles persist:
 * - field *definitions* eagerly via `toSessionMeta()/fromSessionMeta()`
 * - large categorical codes arrays separately as binary chunks
 */

import { StateValidator } from '../utils/state-validator.js';
import { FieldKind, FieldSource, Limits, OverlapStrategy, generateId } from '../utils/field-constants.js';
import { BaseRegistry } from './base-registry.js';
import { computeAllDimensionCentroids, computeCentroidsForDimension } from './user-defined-fields/centroids.js';

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
  if (
    !Array.isArray(categories)
    || categories.length === 0
    || categories.length > Limits.MAX_CATEGORIES_PER_FIELD
  ) {
    throw new TypeError(
      `${context} must contain from 1 through ${Limits.MAX_CATEGORIES_PER_FIELD} labels`
    );
  }
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

function requireCategoryCodes(codes, categories, expectedLength, context) {
  if (
    (!(codes instanceof Uint8Array) && !(codes instanceof Uint16Array))
    || codes.length !== expectedLength
  ) {
    throw new TypeError(`${context} codes must be an exact typed dataset-length array`);
  }
  const missingCode = codes instanceof Uint8Array ? 255 : 65_535;
  for (let index = 0; index < codes.length; index++) {
    if (codes[index] >= categories.length && codes[index] !== missingCode) {
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

  _getActiveFieldCount() {
    let count = 0;
    for (const [id, field] of this._fields) {
      if (!field || typeof field !== 'object') {
        throw new TypeError(`User-defined field "${id}" must be an object`);
      }
      if (typeof field._isDeleted !== 'boolean') {
        throw new TypeError(`User-defined field "${id}" requires exact deletion state`);
      }
      if (field._isDeleted) continue;
      count++;
    }
    return count;
  }

  /**
   * Public wrapper for centroid computation so other components can reuse
   * the exact same multi-dimension centroid logic (DRY).
   *
   * @param {Uint8Array|Uint16Array} codes
   * @param {(string|number|boolean)[]} categories
   * @param {object} state - DataState
   * @returns {Record<string, Array<{category: string, position: number[], n_points: number}>>}
   */
  computeCentroidsByDim(codes, categories, state) {
    return computeAllDimensionCentroids(codes, categories, state);
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

    if (this._getActiveFieldCount() >= Limits.MAX_USER_DEFINED_FIELDS) {
      throw new Error(`Maximum ${Limits.MAX_USER_DEFINED_FIELDS} user-defined fields allowed`);
    }

    const id = generateId('user_cat');
    const centroidsByDim = computeAllDimensionCentroids(codes, categories, state);

    const field = {
      key,
      kind: FieldKind.CATEGORY,
      categories: [...categories],
      codes,
      centroidsByDim,
      loaded: true,

      _isUserDefined: true,
      _isDeleted: false,
      _isPurged: false,
      _userDefinedId: id,
      _fieldSource: source,
      _normalizedDims: new Set(),
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

    if (this._getActiveFieldCount() >= Limits.MAX_USER_DEFINED_FIELDS) {
      throw new Error(`Maximum ${Limits.MAX_USER_DEFINED_FIELDS} user-defined fields allowed`);
    }

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

    if (this._getActiveFieldCount() >= Limits.MAX_USER_DEFINED_FIELDS) {
      throw new Error(`Maximum ${Limits.MAX_USER_DEFINED_FIELDS} user-defined fields allowed`);
    }

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

    const getCellSetForPage = (page) => {
      if (!Array.isArray(page.highlightedGroups)) {
        throw new TypeError(`Highlight page "${page.id}" requires a highlightedGroups array`);
      }
      const cellSet = new Set();
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
        for (const cellIdx of group.cellIndices) {
          if (!Number.isSafeInteger(cellIdx) || cellIdx < 0 || cellIdx >= pointCount) {
            throw new RangeError(
              `Highlight page "${page.id}" group ${groupIndex} has an out-of-range cell index`
            );
          }
          cellSet.add(cellIdx);
        }
      }
      return cellSet;
    };

    const pageLabels = pages.map(pageInfo => pageInfo.label);
    const pageCellSets = resolvedPages.map(({ page }) => (
      getCellSetForPage(page)
    ));
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
      if (pages.length > Limits.MAX_INTERSECTION_PAGES) {
        throw new Error(`Too many pages for intersections (max ${Limits.MAX_INTERSECTION_PAGES})`);
      }

      const membershipByCell = new Map(); // cellIdx -> bitmask

      pageCellSets.forEach((cellSet, pageIndex) => {
        const bit = 1 << pageIndex;
        for (const cellIdx of cellSet) {
          const prev = membershipByCell.has(cellIdx)
            ? membershipByCell.get(cellIdx)
            : 0;
          membershipByCell.set(cellIdx, prev | bit);
        }
      });

      const isPowerOfTwo = v => v > 0 && (v & (v - 1)) === 0;
      const bitCount32 = (v) => {
        let x = v >>> 0;
        let c = 0;
        while (x) { x &= (x - 1); c++; }
        return c;
      };

      const maskCounts = new Map();
      let overlapCount = 0;
      for (const mask of membershipByCell.values()) {
        const previousCount = maskCounts.has(mask)
          ? maskCounts.get(mask)
          : 0;
        maskCounts.set(mask, previousCount + 1);
        if (!isPowerOfTwo(mask)) overlapCount++;
      }

      const intersectionMasks = [...maskCounts.keys()]
        .filter((mask) => !isPowerOfTwo(mask))
        .sort((a, b) => {
          const cardinality = bitCount32(a) - bitCount32(b);
          return cardinality === 0 ? a - b : cardinality;
        });
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
        const maskKey = String(mask);
        intersectionIndexByMask.set(mask, categories.length);
        categories.push(intersectionLabels[maskKey]);
      }

      if (hasUncovered) {
        uncoveredCategoryLabel = uncoveredLabel;
        categories.push(uncoveredCategoryLabel);
      }

      requireCategoryInventory(categories, 'Highlight-page categorical field');

      const uncoveredIndex = hasUncovered ? (categories.length - 1) : 255;
      codes = new Uint8Array(pointCount);
      codes.fill(uncoveredIndex);

      for (const [cellIdx, mask] of membershipByCell) {
        if (isPowerOfTwo(mask)) {
          const pageIndex = Math.log2(mask);
          codes[cellIdx] = pageIndex;
        } else {
          const idx = intersectionIndexByMask.get(mask);
          if (!Number.isSafeInteger(idx)) {
            throw new Error(
              `Intersection mask ${mask} has no exact category index`
            );
          }
          codes[cellIdx] = idx;
        }
      }

      conflictCount = overlapCount;
      if (membershipByCell.size > pointCount) {
        throw new RangeError(
          'Intersection membership exceeds the current point count'
        );
      }
      uncoveredCount = pointCount - membershipByCell.size;
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

      const unassigned = hasUncovered ? (categories.length - 1) : 255;
      codes = new Uint8Array(pointCount);
      codes.fill(unassigned);

      const assignedCount = new Uint8Array(pointCount);
      const conflictFlag = new Uint8Array(pointCount);
      let assignedTotal = 0;

      pageCellSets.forEach((cellSet, catIndex) => {
        for (const cellIdx of cellSet) {
          if (assignedCount[cellIdx] > 0) {
            if (conflictFlag[cellIdx] === 0) {
              conflictFlag[cellIdx] = 1;
              conflictCount++;
            }

            if (strategy === OverlapStrategy.OVERLAP_LABEL && overlapCategoryIndex >= 0) {
              codes[cellIdx] = overlapCategoryIndex;
            } else if (strategy === OverlapStrategy.LAST) {
              codes[cellIdx] = catIndex;
            }
          } else {
            assignedTotal++;
            codes[cellIdx] = catIndex;
          }
          assignedCount[cellIdx]++;
        }
      });

      if (assignedTotal > pointCount) {
        throw new RangeError(
          'Assigned highlight membership exceeds the current point count'
        );
      }
      uncoveredCount = pointCount - assignedTotal;
    }

    const centroidsByDim = computeAllDimensionCentroids(codes, categories, state);
    const id = generateId('user_cat');

    const field = {
      key,
      kind: FieldKind.CATEGORY,
      categories: [...categories],
      codes,
      centroidsByDim,
      loaded: true,

      _isUserDefined: true,
      _isDeleted: false,
      _isPurged: false,
      _userDefinedId: id,
      _fieldSource: FieldSource.OBS,
      _normalizedDims: new Set(),
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
   * Lazy centroid recomputation for a dimension that was not available at creation time.
   * Called when the user switches to a dimension that just loaded.
   * @param {string} fieldId
   * @param {number} dim
   * @param {Float32Array} positions - raw positions with stride = dim
   */
  recomputeCentroidsForDimension(fieldId, dim, positions) {
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
      !field.centroidsByDim
      || typeof field.centroidsByDim !== 'object'
      || Array.isArray(field.centroidsByDim)
    ) {
      throw new TypeError(`User-defined field "${fieldId}" has invalid centroid metadata`);
    }
    field.centroidsByDim[String(dim)] = computeCentroidsForDimension(field.codes, field.categories, positions, dim);
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
      'centroidsByDim',
      'codes',
      'isDeleted',
      'key',
      'normalizedDims',
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
      const expectedLength = (
        field.codes instanceof Uint8Array
        || field.codes instanceof Uint16Array
      )
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
    } else if (
      Object.hasOwn(updates, 'categories')
      || Object.hasOwn(updates, 'codes')
      || Object.hasOwn(updates, 'centroidsByDim')
      || Object.hasOwn(updates, 'normalizedDims')
    ) {
      throw new TypeError('Continuous user-defined fields cannot accept categorical updates');
    }

    const nextCentroids = Object.hasOwn(updates, 'centroidsByDim')
      ? updates.centroidsByDim
      : field.centroidsByDim;
    if (
      field.kind === FieldKind.CATEGORY
      && (
        !nextCentroids
        || typeof nextCentroids !== 'object'
        || Array.isArray(nextCentroids)
      )
    ) {
      throw new TypeError(`User-defined field "${id}" requires centroid metadata`);
    }
    const nextNormalizedDims = Object.hasOwn(updates, 'normalizedDims')
      ? updates.normalizedDims
      : field._normalizedDims;
    if (
      field.kind === FieldKind.CATEGORY
      && !(nextNormalizedDims instanceof Set)
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
      field.centroidsByDim = nextCentroids;
      field._normalizedDims = nextNormalizedDims;
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
      if (!(field.codes instanceof Uint8Array) && !(field.codes instanceof Uint16Array)) {
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
        !field.centroidsByDim
        || typeof field.centroidsByDim !== 'object'
        || Array.isArray(field.centroidsByDim)
        || !(field._normalizedDims instanceof Set)
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
        centroidsByDim: field.centroidsByDim,
        normalizedDims: [...field._normalizedDims],
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
      ) {
        throw new TypeError(`User-defined session item ${itemIndex} has invalid codesType`);
      }
      if (!Number.isSafeInteger(item.codesLength) || item.codesLength < 1) {
        throw new TypeError(`User-defined session item ${itemIndex} has invalid codesLength`);
      }
      if (
        !Array.isArray(item.categories)
        || item.categories.length === 0
        || !item.centroidsByDim
        || typeof item.centroidsByDim !== 'object'
        || Array.isArray(item.centroidsByDim)
        || !Array.isArray(item.normalizedDims)
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
      const field = {
        key: item.key,
        kind: FieldKind.CATEGORY,
        categories: [...item.categories],
        codes: null,
        centroidsByDim: item.centroidsByDim,
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
        _normalizedDims: new Set(item.normalizedDims),

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
