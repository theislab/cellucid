/**
 * UserDefinedFieldsRegistry - user-created categoricals derived from highlight pages.
 *
 * Responsibilities:
 * - Create a categorical codes array from highlight pages (with overlap strategy)
 * - Compute per-layout centroids from the normalized positions the viewer
 *   draws, with NO outlier filtering
 * - Persist soft-deletes so derived columns are restorable
 *
 * The history and session files keep these fields through the
 * `field-overlays` state domain (`app/state/domains/field-overlays.js`): each
 * field's definition with its codes or values as columns by original cell
 * position, put back as the registry's inventory with `adoptFields`.
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
  intersectionKey,
  intersectionMembership,
  orderedMembership
} from '../utils/page-membership.js';
import {
  computeAllLayoutCentroids,
  computeCentroidsForDimension
} from './user-defined-fields/centroids.js';
import { isCategoricalCodes } from '../../data/categorical-storage-contract.js';
import { getCategoryColor } from '../../data/palettes.js';
import { distinctColor } from '../../data/distinct-colors.js';
import { isHexColor, rgb01OfHex } from '../../utils/hex-color.js';

/**
 * The colors a field made from highlight pages opens with (its own palette,
 * `field.palette`, as a file's `uns['<key>_colors']`): each page's category
 * in its page's color, one color for one page wherever it is shown; every
 * other category (the overlap label, an intersection, the cells on no page),
 * in order, the category palette's color of its place when that can be told
 * apart from the pages' and the ones before it, else the next palette color
 * that can (`distinct-colors.js`). A category's color depends only on the
 * pages and the categories before it. Create categorical's preview draws the
 * same colors.
 *
 * @param {ReadonlyArray<string>} pageColors - Each page's `#rrggbb`, in the field's page order
 * @param {number} categoryCount - The field's categories, the pages' first
 * @returns {Array<[number, number, number]>} RGB channels from 0 to 1, a category each
 */
export function pageFieldPalette(pageColors, categoryCount) {
  if (!Array.isArray(pageColors) || !Number.isSafeInteger(categoryCount) || categoryCount < pageColors.length) {
    throw new TypeError('A page field palette takes each page\'s color and at least as many categories as pages.');
  }
  const palette = pageColors.map((color, index) => {
    if (!isHexColor(color)) throw new TypeError(`Highlight page ${index + 1}'s color must be a #rrggbb color.`);
    return rgb01OfHex(color);
  });
  for (let index = pageColors.length; index < categoryCount; index++) {
    palette.push(distinctColor(palette, getCategoryColor(index)));
  }
  return palette;
}

/**
 * One category's color in `pageFieldPalette`: the page's for a page's
 * category, else the one the palette gives its place beside the pages and
 * the categories before it.
 *
 * @param {ReadonlyArray<string>} pageColors
 * @param {number} index - The category's place in the field
 * @returns {[number, number, number]}
 */
export function pageFieldColor(pageColors, index) {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new TypeError('A page field color is of a category\'s place, a non-negative integer.');
  }
  return pageFieldPalette(pageColors, Math.max(index + 1, pageColors.length))[index];
}

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

/**
 * Require the values of a stored continuous field: one float32 per open
 * cell, NaN where a cell has none.
 */
function requireStoredValues(values, pointCount, context) {
  if (!(values instanceof Float32Array)) {
    throw new TypeError(`${context} values must be a Float32Array`);
  }
  if (!Number.isSafeInteger(pointCount) || values.length !== pointCount) {
    throw new TypeError(`${context} values must hold one value per open cell`);
  }
  return values;
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
   * Register a user-defined continuous field that holds its own values: a
   * column a notebook pushed (the `field.push` action). Unlike a continuous
   * alias, nothing can derive these values again, so the template keeps them
   * and a session stores them (`user-defined/values/<id>`).
   *
   * @param {object} options
   * @param {string} options.key
   * @param {Float32Array} options.values - One value per open cell, NaN for none
   * @param {{type: string}} options.operation - What made it (`notebook-push`)
   * @param {object} state - DataState
   * @returns {{id: string, field: object}}
   */
  createStoredContinuous(options, state) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Stored continuous field options must be an object');
    }
    const { key, values, operation } = options;
    StateValidator.validateFieldKey(key);
    requireStoredValues(values, state?.pointCount, 'Stored continuous field');
    requireNullableRecord(operation, 'Stored continuous field operation');
    const id = generateId('user_obs_value');
    const template = {
      key,
      kind: FieldKind.CONTINUOUS,
      values,
      loaded: true,
      _loadingPromise: null,

      _isUserDefined: true,
      _isDeleted: false,
      _isPurged: false,
      _userDefinedId: id,
      _fieldSource: FieldSource.OBS,
      _sourceField: null,
      _operation: operation,
      _createdAt: Date.now(),
    };
    this._fields.set(id, template);
    return { id, field: { ...template } };
  }

  /**
   * Replace the values of a stored continuous field (a notebook pushed the
   * same key again).
   *
   * @param {string} id
   * @param {Float32Array} values
   * @param {object} state - DataState
   */
  replaceStoredValues(id, values, state) {
    const field = this._fields.get(id);
    if (!field || field.kind !== FieldKind.CONTINUOUS || field._sourceField !== null) {
      throw new Error(`User-defined field "${id}" does not hold its own values`);
    }
    requireStoredValues(values, state?.pointCount, `Stored continuous field "${id}"`);
    field.values = values;
    field.loaded = true;
  }

  /**
   * Create a categorical field from highlight pages.
   * @param {object} options
   * @param {string} options.key
   * @param {Array<{pageId: string, label: string}>} options.pages
   * @param {string} options.uncoveredLabel
   * @param {string} options.overlapStrategy - 'first'|'last'|'overlap-label'|'intersections'
   * @param {string} options.overlapLabel
   * @param {Record<string, string>} options.intersectionLabels - intersection key (`intersectionKey`) -> label when overlapStrategy='intersections'
   * @param {{categories: string[], codes: ArrayLike<number>, missing: number}|null} options.rest - a
   *   categorical field whose category the cells on no page keep (its labels, its code of each open
   *   cell, its missing code); null: they take `uncoveredLabel` (so relabelling the
   *   cells of a page inside an existing annotation is one call)
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
      intersectionLabels,
      rest = null
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
    if (typeof state.getHighlightPageColor !== 'function') {
      throw new TypeError('Creating a categorical requires each highlight page\'s color');
    }
    const pageColors = pages.map(pageInfo => state.getHighlightPageColor(pageInfo.pageId));
    // Cells on no page take the uncovered label, a category only when such
    // cells exist: one named for nobody is a legend row of 0 cells the builder
    // never asked about (it hides the question when every cell is covered).
    const labelsUncovered = uncoveredLabel.length > 0;
    const strategy = overlapStrategy;
    if (rest !== null && rest.codes.length !== pointCount) {
      throw new RangeError('The field whose categories the cells on no page keep must have one code per open cell');
    }
    /**
     * With `rest`, each cell on no page keeps its category there: those
     * categories are added after the pages' (one a page already names is
     * that page's), and only a cell with none there takes the uncovered
     * label. Returns each rest code's category (-1: none needed) and how many
     * cells on no page are left for the uncovered label.
     */
    const keepRest = isUncovered => {
      if (rest === null) return { restCategoryOf: null, unlabeled: null };
      const used = new Uint8Array(rest.categories.length);
      let unlabeled = 0;
      for (let cellIdx = 0; cellIdx < pointCount; cellIdx++) {
        if (!isUncovered(cellIdx)) continue;
        const code = rest.codes[cellIdx];
        if (code === rest.missing || code < 0 || code >= rest.categories.length) unlabeled++;
        else used[code] = 1;
      }
      const restCategoryOf = new Int32Array(rest.categories.length).fill(-1);
      for (let code = 0; code < rest.categories.length; code++) {
        if (used[code] === 0) continue;
        const label = rest.categories[code];
        const at = categories.indexOf(label);
        restCategoryOf[code] = at >= 0 ? at : categories.push(label) - 1;
      }
      return { restCategoryOf, unlabeled };
    };
    const codeOfUncovered = (restCategoryOf, cellIdx, unassigned) => {
      if (restCategoryOf === null) return unassigned;
      const code = rest.codes[cellIdx];
      const at = code === rest.missing || code < 0 || code >= restCategoryOf.length ? -1 : restCategoryOf[code];
      return at >= 0 ? at : unassigned;
    };

    let categories = [...pageLabels];
    let overlapCategoryLabel = null;
    let overlapCategoryIndex = -1;
    let intersectionLabelByKey = null;
    let uncoveredCategoryLabel = null;
    let uncoveredCount = 0;
    let conflictCount = 0;
    let codes = null;

    // ---------------------------------------------------------------------
    // Strategy: split overlaps into intersection categories
    // ---------------------------------------------------------------------
    if (strategy === OverlapStrategy.INTERSECTIONS) {
      const membership = intersectionMembership(membershipPages, pointCount);
      const expectedKeys = membership.intersections.map(row => row.key);
      const expectedKeySet = new Set(expectedKeys);
      const providedKeys = Object.keys(intersectionLabels);
      if (
        providedKeys.length !== expectedKeys.length
        || providedKeys.some(key => !expectedKeySet.has(key))
      ) {
        throw new Error(
          'Intersection labels must name every combination of pages that holds cells exactly once'
        );
      }

      intersectionLabelByKey = { ...intersectionLabels };
      // The category of each combination of pages: a single page's own,
      // an intersection's, or the uncovered one (the empty combination).
      const { combinations, combinationOf } = membership;
      const categoryOfCombination = new Int32Array(combinations.length);
      const intersectionIndexByKey = new Map();
      for (const { key } of membership.intersections) {
        intersectionIndexByKey.set(key, categories.length);
        categories.push(intersectionLabels[key]);
      }
      const { restCategoryOf, unlabeled } = keepRest(cellIdx => combinationOf[cellIdx] === 0);
      const hasUncovered = labelsUncovered && (unlabeled ?? (pointCount - membership.coveredCount)) > 0;

      // A kept category named as the uncovered label is that category (`rest`).
      let uncoveredIndex = -1;
      if (hasUncovered) {
        uncoveredCategoryLabel = uncoveredLabel;
        uncoveredIndex = categories.indexOf(uncoveredCategoryLabel);
        if (uncoveredIndex < 0) uncoveredIndex = categories.push(uncoveredCategoryLabel) - 1;
      }

      requireCategoryInventory(categories, 'Highlight-page categorical field');

      const storage = categoricalStorageForCount(
        categories.length,
        'Highlight-page categorical field'
      );
      categoryOfCombination[0] = hasUncovered
        ? uncoveredIndex
        : storage.missingValue;
      for (let id = 1; id < combinations.length; id++) {
        const combination = combinations[id];
        // A combination reached on the way to a larger one and holding no
        // cell has no category; no cell reads it.
        categoryOfCombination[id] = combination.length === 1
          ? combination[0]
          : (intersectionIndexByKey.get(intersectionKey(combination)) ?? -1);
      }
      codes = new storage.TypedArrayClass(pointCount);
      for (let cellIdx = 0; cellIdx < pointCount; cellIdx++) {
        const combination = combinationOf[cellIdx];
        codes[cellIdx] = combination === 0
          ? codeOfUncovered(restCategoryOf, cellIdx, categoryOfCombination[0])
          : categoryOfCombination[combination];
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

      const membership = orderedMembership(membershipPages, pointCount);
      const { restCategoryOf, unlabeled } = keepRest(cellIdx => membership.first[cellIdx] < 0);
      const hasUncovered = labelsUncovered && (unlabeled ?? (pointCount - membership.coveredCount)) > 0;
      // A kept category named as the uncovered label is that category (`rest`).
      let uncoveredIndex = -1;
      if (hasUncovered) {
        uncoveredCategoryLabel = uncoveredLabel;
        uncoveredIndex = categories.indexOf(uncoveredCategoryLabel);
        if (uncoveredIndex < 0) uncoveredIndex = categories.push(uncoveredCategoryLabel) - 1;
      }

      requireCategoryInventory(categories, 'Highlight-page categorical field');

      const storage = categoricalStorageForCount(
        categories.length,
        'Highlight-page categorical field'
      );
      const unassigned = hasUncovered
        ? uncoveredIndex
        : storage.missingValue;
      codes = new storage.TypedArrayClass(pointCount);

      const owner = strategy === OverlapStrategy.LAST ? membership.last : membership.first;
      const { overlapping } = membership;
      for (let cellIdx = 0; cellIdx < pointCount; cellIdx++) {
        const page = owner[cellIdx];
        if (page < 0) {
          codes[cellIdx] = codeOfUncovered(restCategoryOf, cellIdx, unassigned);
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
      // Each page's category in its page's color (`pageFieldPalette`).
      palette: pageFieldPalette(pageColors, categories.length),
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
      _intersectionLabels: intersectionLabelByKey,
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
    if (field.kind === FieldKind.CATEGORY) field.palette = null;
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
      // dataset scale that read is the entire cost of the edit.
      const inventoryResized = nextCategories.length !== field.categories.length;
      if (nextCodes !== field.codes || inventoryResized) {
        if (!isCategoricalCodes(field.codes)) {
          throw new TypeError(`User-defined field "${id}" requires an exact code length`);
        }
        requireCategoryCodes(
          nextCodes,
          nextCategories,
          field.codes.length,
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

  clear() {
    this._fields.clear();
  }

  /**
   * Replace the inventory with `fields`, in this order: the state a history
   * step restores (`app/state/domains/field-overlays.js`). A field object
   * that is already registered under its id stays the same object, so every
   * view's copy of it keeps referring to its template.
   *
   * @param {object[]} fields - Templates, each with its `_userDefinedId`
   */
  adoptFields(fields) {
    if (!Array.isArray(fields)) throw new TypeError('User-defined fields must be a list');
    const next = new Map();
    for (const field of fields) {
      if (!field || typeof field !== 'object' || field._isUserDefined !== true) {
        throw new TypeError('A user-defined field template must be a user-defined field');
      }
      const id = requireNonEmptyTrimmedString(field._userDefinedId, 'User-defined field id');
      if (next.has(id)) throw new TypeError(`User-defined field id "${id}" is duplicated`);
      next.set(id, field);
    }
    this._fields.clear();
    for (const [id, field] of next) this._fields.set(id, field);
  }
}
