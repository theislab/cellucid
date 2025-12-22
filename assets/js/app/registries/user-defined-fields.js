/**
 * UserDefinedFieldsRegistry - user-created categoricals derived from highlight pages.
 *
 * Responsibilities:
 * - Create a categorical codes array from highlight pages (with overlap strategy)
 * - Compute per-dimension centroids (raw space) with NO outlier filtering
 * - Serialize/deserialize large codes arrays efficiently (RLE)
 * - Persist soft-deletes so derived columns are restorable
 */

import { rleEncode, rleDecode } from '../utils/rle-codec.js';
import { StateValidator } from '../utils/state-validator.js';
import { FieldKind, FieldSource, Limits, OverlapStrategy, generateId } from '../utils/field-constants.js';
import { makeUniqueLabel } from '../utils/label-utils.js';
import { BaseRegistry } from './base-registry.js';
import { computeAllDimensionCentroids, computeCentroidsForDimension } from './user-defined-fields/centroids.js';

export class UserDefinedFieldsRegistry extends BaseRegistry {
  constructor() {
    super();
    this._fields = this._data; // id -> field definition
  }

  _getActiveFieldCount() {
    let count = 0;
    for (const field of this._fields.values()) {
      if (!field || field._isDeleted === true) continue;
      count++;
    }
    return count;
  }

  /**
   * Public wrapper for centroid computation so other components can reuse
   * the exact same multi-dimension centroid logic (DRY).
   *
   * @param {Uint8Array|Uint16Array} codes
   * @param {string[]} categories
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
   * - Persist the derived field through state snapshots (RLE)
   *
   * @param {object} options
   * @param {string} options.key
   * @param {string[]} options.categories
   * @param {Uint8Array|Uint16Array} options.codes
   * @param {object} [options.meta] - Optional metadata to attach (serialized if possible)
   * @param {object} state - DataState
   * @returns {{id: string, field: object}}
   */
  createFromCategoricalCodes(options, state) {
    const { key, categories, codes, meta, source } = options || {};

    StateValidator.validateFieldKey(key);

    if (!Array.isArray(categories) || categories.length === 0) {
      throw new Error('categories must be a non-empty array');
    }
    if (!codes || typeof codes.length !== 'number') {
      throw new Error('codes must be array-like');
    }

    if (this._getActiveFieldCount() >= Limits.MAX_USER_DEFINED_FIELDS) {
      throw new Error(`Maximum ${Limits.MAX_USER_DEFINED_FIELDS} user-defined fields allowed`);
    }

    const fieldSource = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
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
      _userDefinedId: id,
      _fieldSource: fieldSource,
      _createdAt: Date.now(),
      ...(meta && typeof meta === 'object' ? meta : {})
    };

    this._fields.set(id, field);
    return { id, field };
  }

  /**
   * Register a user-defined continuous field that is sourced from an existing
   * obs/var continuous field (e.g. "copy continuous obs" or "copy gene expression").
   *
   * We intentionally do NOT persist the raw values array in snapshots.
   * DataState re-materializes values by copying from the referenced source field.
   *
   * @param {object} options
   * @param {string} options.key
   * @param {'obs'|'var'} options.source
   * @param {{sourceKey: string, sourceIndex?: number, kind?: string}} options.sourceField
   * @param {object} [options.meta]
   * @returns {{id: string, field: object}}
   */
  createContinuousAlias(options = {}) {
    const { key, source, sourceField, meta } = options || {};

    StateValidator.validateFieldKey(key);

    if (this._getActiveFieldCount() >= Limits.MAX_USER_DEFINED_FIELDS) {
      throw new Error(`Maximum ${Limits.MAX_USER_DEFINED_FIELDS} user-defined fields allowed`);
    }

    const fieldSource = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const stableKey = String(sourceField?.sourceKey ?? '').trim();
    if (!stableKey) {
      throw new Error('sourceField.sourceKey is required for continuous aliases');
    }

    const id = generateId(fieldSource === FieldSource.VAR ? 'user_var_cont' : 'user_obs_cont');
    const template = {
      key,
      kind: FieldKind.CONTINUOUS,
      values: null,
      loaded: false,
      _loadingPromise: null,

      _isUserDefined: true,
      _isDeleted: false,
      _userDefinedId: id,
      _fieldSource: fieldSource,
      _sourceField: { ...(sourceField || {}), sourceKey: stableKey },
      _createdAt: Date.now(),
      ...(meta && typeof meta === 'object' ? meta : {})
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
   * @param {Array<{pageId: string, label?: string}>} options.pages
   * @param {string} [options.uncoveredLabel]
   * @param {string} [options.overlapStrategy='first'] - 'first'|'last'|'overlap-label'|'intersections'
   * @param {string} [options.overlapLabel] - Label for overlapping cells when overlapStrategy='overlap-label'
   * @param {Record<string, string>} [options.intersectionLabels] - mask->label when overlapStrategy='intersections'
   * @param {object} state - DataState
   * @returns {{id: string, field: object, conflicts: number, uncoveredCount: number}}
   */
  createFromPages(options, state) {
    const {
      key,
      pages,
      uncoveredLabel,
      overlapStrategy = OverlapStrategy.FIRST,
      overlapLabel,
      intersectionLabels
    } = options || {};

    StateValidator.validateUserDefinedOptions(options);

    if (this._getActiveFieldCount() >= Limits.MAX_USER_DEFINED_FIELDS) {
      throw new Error(`Maximum ${Limits.MAX_USER_DEFINED_FIELDS} user-defined fields allowed`);
    }

    const id = generateId('user_cat');
    const pointCount = state.pointCount || 0;
    if (!pointCount) throw new Error('No cell data loaded yet');

    const getCellSetForPage = (pageId) => {
      const page = state.highlightPages?.find?.((p) => p.id === pageId);
      if (!page) {
        console.warn(`[UserDefinedFields] Page not found: ${pageId}`);
        return null;
      }
      const cellSet = new Set();
      for (const group of (page.highlightedGroups || [])) {
        if (group.enabled === false) continue;
        for (const cellIdx of (group.cellIndices || [])) {
          if (cellIdx >= 0 && cellIdx < pointCount) cellSet.add(cellIdx);
        }
      }
      return cellSet;
    };

    const pageLabels = pages.map((p) => {
      const page = state.highlightPages?.find?.((hp) => hp.id === p.pageId);
      const fallback = page?.name || 'Category';
      return String((p.label ?? fallback) || 'Category');
    });

    const uncoveredTrim = String(uncoveredLabel || '').trim();
    const hasUncovered = uncoveredTrim.length > 0;
    const strategy = overlapStrategy || OverlapStrategy.FIRST;

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

      pages.forEach((pageInfo, pageIndex) => {
        const cellSet = getCellSetForPage(pageInfo.pageId);
        if (!cellSet) return;
        const bit = 1 << pageIndex;
        for (const cellIdx of cellSet) {
          const prev = membershipByCell.get(cellIdx) || 0;
          membershipByCell.set(cellIdx, prev | bit);
        }
      });

      const isPowerOfTwo = (v) => v && (v & (v - 1)) === 0;
      const bitCount32 = (v) => {
        let x = v >>> 0;
        let c = 0;
        while (x) { x &= (x - 1); c++; }
        return c;
      };

      const maskCounts = new Map();
      let overlapCount = 0;
      for (const mask of membershipByCell.values()) {
        maskCounts.set(mask, (maskCounts.get(mask) || 0) + 1);
        if (!isPowerOfTwo(mask)) overlapCount++;
      }

      const intersectionMasks = [...maskCounts.keys()]
        .filter((mask) => !isPowerOfTwo(mask))
        .sort((a, b) => bitCount32(a) - bitCount32(b) || a - b);

      intersectionLabelByMask = {};
      const intersectionIndexByMask = new Map();

      for (const mask of intersectionMasks) {
        const maskKey = String(mask);
        const requested = String(intersectionLabels?.[maskKey] ?? '').trim();

        const parts = [];
        for (let i = 0; i < pages.length; i++) {
          if (mask & (1 << i)) parts.push(String(pageLabels[i] ?? `Page ${i + 1}`));
        }
        const defaultLabel = parts.join(' & ') || 'Overlap';
        const base = requested || defaultLabel;
        const unique = makeUniqueLabel(base, categories);

        intersectionLabelByMask[maskKey] = unique;
        intersectionIndexByMask.set(mask, categories.length);
        categories.push(unique);
      }

      if (hasUncovered) {
        uncoveredCategoryLabel = makeUniqueLabel(uncoveredTrim, categories);
        categories.push(uncoveredCategoryLabel);
      }

      if (categories.length > Limits.MAX_CATEGORIES_PER_FIELD) {
        throw new Error(`Too many categories (max ${Limits.MAX_CATEGORIES_PER_FIELD})`);
      }

      const uncoveredIndex = hasUncovered ? (categories.length - 1) : 255;
      codes = new Uint8Array(pointCount);
      codes.fill(uncoveredIndex);

      for (const [cellIdx, mask] of membershipByCell) {
        if (isPowerOfTwo(mask)) {
          const pageIndex = Math.log2(mask);
          codes[cellIdx] = pageIndex;
        } else {
          const idx = intersectionIndexByMask.get(mask);
          if (idx != null) codes[cellIdx] = idx;
        }
      }

      conflictCount = overlapCount;
      uncoveredCount = Math.max(0, pointCount - membershipByCell.size);
    } else {
      // -------------------------------------------------------------------
      // Strategies: first/last/overlap-label
      // -------------------------------------------------------------------

      if (strategy === OverlapStrategy.OVERLAP_LABEL) {
        const baseOverlap = String(overlapLabel ?? 'Overlap').trim() || 'Overlap';
        overlapCategoryLabel = makeUniqueLabel(baseOverlap, categories);
        overlapCategoryIndex = categories.length;
        categories.push(overlapCategoryLabel);
      }

      if (hasUncovered) {
        uncoveredCategoryLabel = makeUniqueLabel(uncoveredTrim, categories);
        categories.push(uncoveredCategoryLabel);
      }

      if (categories.length > Limits.MAX_CATEGORIES_PER_FIELD) {
        throw new Error(`Too many categories (max ${Limits.MAX_CATEGORIES_PER_FIELD})`);
      }

      const unassigned = hasUncovered ? (categories.length - 1) : 255;
      codes = new Uint8Array(pointCount);
      codes.fill(unassigned);

      const assignedCount = new Uint8Array(pointCount);
      const conflictFlag = new Uint8Array(pointCount);
      let assignedTotal = 0;

      pages.forEach((pageInfo, catIndex) => {
        const cellSet = getCellSetForPage(pageInfo.pageId);
        if (!cellSet) return;

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

      uncoveredCount = Math.max(0, pointCount - assignedTotal);
    }

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
      _userDefinedId: id,
      _fieldSource: FieldSource.OBS,
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
    const field = this._fields.get(fieldId);
    if (!field) return;
    if (!field.centroidsByDim) field.centroidsByDim = {};
    field.centroidsByDim[String(dim)] = computeCentroidsForDimension(field.codes, field.categories, positions, dim);
  }

  getField(id) {
    return this._fields.get(id);
  }

  getAllFields() {
    return [...this._fields.values()];
  }

  getAllFieldsForSource(source) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    return this.getAllFields().filter((f) => (f?._fieldSource || FieldSource.OBS) === src);
  }

  deleteField(id) {
    return this._fields.delete(id);
  }

  updateField(id, updates) {
    const field = this._fields.get(id);
    if (!field) return false;
    if (updates.key) field.key = updates.key;
    if (updates.categories) field.categories = updates.categories;
    if (updates.codes) field.codes = updates.codes;
    if (updates.centroidsByDim) field.centroidsByDim = updates.centroidsByDim;
    if (updates.sourceField) field._sourceField = updates.sourceField;
    if (updates.operation) field._operation = updates.operation;
    if (updates.isDeleted != null) field._isDeleted = updates.isDeleted === true;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  toJSON() {
    const result = [];
    for (const [id, field] of this._fields) {
      const source = field?._fieldSource === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
      const kind = field?.kind === FieldKind.CONTINUOUS ? FieldKind.CONTINUOUS : FieldKind.CATEGORY;

      if (kind === FieldKind.CATEGORY) {
        const codesRLE = rleEncode(field.codes);
        result.push({
          id,
          source,
          kind,
          key: field.key,
          categories: [...(field.categories || [])],
          isDeleted: field._isDeleted === true,
          isPurged: field._isPurged === true,
          codesRLE,
          codesLength: field.codes?.length || 0,
          codesType: field.codes?.constructor?.name || 'Uint8Array',
          centroidsByDim: field.centroidsByDim || {},
          normalizedDims: field._normalizedDims ? [...field._normalizedDims] : [],
          sourceField: field._sourceField || null,
          operation: field._operation || null,
          sourcePages: field._sourcePages || [],
          overlapStrategy: field._overlapStrategy || 'first',
          overlapLabel: field._overlapLabel || null,
          intersectionLabels: field._intersectionLabels || null,
          uncoveredLabel: field._uncoveredLabel || null,
          createdAt: field._createdAt || null
        });
        continue;
      }

      // Continuous aliases: persist only metadata + stable source reference.
      result.push({
        id,
        source,
        kind,
        key: field.key,
        isDeleted: field._isDeleted === true,
        isPurged: field._isPurged === true,
        sourceField: field._sourceField || null,
        operation: field._operation || null,
        createdAt: field._createdAt || null
      });
    }
    return result;
  }

  fromJSON(data, state) {
    this._fields.clear();

    for (const item of (data || [])) {
      const kind = item?.kind === FieldKind.CONTINUOUS ? FieldKind.CONTINUOUS : FieldKind.CATEGORY;
      const source = item?.source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;

      if (kind === FieldKind.CONTINUOUS) {
        const field = {
          key: item.key,
          kind: FieldKind.CONTINUOUS,
          values: null,
          loaded: false,
          _loadingPromise: null,

          _isUserDefined: true,
          _isDeleted: item.isDeleted === true,
          _isPurged: item.isPurged === true,
          _userDefinedId: item.id,
          _fieldSource: source,
          _sourceField: item.sourceField || null,
          _operation: item.operation || null,
          _createdAt: item.createdAt || null
        };

        this._fields.set(item.id, field);
        continue;
      }

      const ArrayType = item.codesType === 'Uint16Array' ? Uint16Array : Uint8Array;
      const codes = rleDecode(item.codesRLE, item.codesLength, ArrayType);

      let centroidsByDim = item.centroidsByDim || {};
      if (!centroidsByDim || Object.keys(centroidsByDim).length === 0) {
        centroidsByDim = computeAllDimensionCentroids(codes, item.categories || [], state);
      }

      const field = {
        key: item.key,
        kind: FieldKind.CATEGORY,
        categories: item.categories || [],
        codes,
        centroidsByDim,
        loaded: true,

        _isUserDefined: true,
        _isDeleted: item.isDeleted === true,
        _isPurged: item.isPurged === true,
        _userDefinedId: item.id,
        _fieldSource: source,
        _sourceField: item.sourceField || null,
        _operation: item.operation || null,
        _sourcePages: item.sourcePages || [],
        _overlapStrategy: item.overlapStrategy || 'first',
        _overlapLabel: item.overlapLabel || null,
        _intersectionLabels: item.intersectionLabels || null,
        _uncoveredLabel: item.uncoveredLabel || null,
        _createdAt: item.createdAt || null,
        _normalizedDims: Array.isArray(item.normalizedDims) ? new Set(item.normalizedDims) : null
      };

      this._fields.set(item.id, field);
    }
  }

  clear() {
    this._fields.clear();
  }
}
