/**
 * @fileoverview Exact modified-only field-filter session state.
 *
 * Every entry is a closed record of explicit changes from the freshly loaded
 * dataset. Restore validates the complete candidate before loading or mutating
 * any field, then clears every field back to its load-time defaults before
 * applying the candidate, so a restored session is the exact saved state and
 * never a merge with whatever happened to be on screen.
 *
 * @module state-serializer/filters
 */

import { getNotificationCenter } from '../notification-center.js';
import { makeFieldId } from '../utils/field-constants.js';
import { formatCountOf } from '../../utils/format-units.js';
import {
  assertArray,
  assertBoolean,
  assertCategoryPrimitive,
  assertFiniteNumber,
  assertNonEmptyString,
  assertNullableFiniteNumber,
  assertNullableString,
  assertSafeInteger,
  DUPLICATE_CATEGORY_POSITION,
  describeCategory,
  indexCategoryPositions,
  requireMethod,
} from '../session/schema-contract.js';
import { requireExactKeys, requireKeys, requirePlainRecord } from '../../utils/exact-record.js';
import {
  forgetPendingCategoryState,
  holdPendingCategoryState
} from '../state/managers/field/pending-categories.js';
import { throwIfAborted, isCancellation, onAbort } from '../../utils/abort.js';
import { categoryRgbAt, checkCategoryState, defaultCategoryColors, hiddenCategoryCount } from '../utils/category-state.js';

const RANGE_EPSILON = 1e-6;
// The outlier filter lives with categorical fields: latent outlier quantiles
// are computed only for categoricals, and the filter manager
// refuses an outlier filter on any other field kind.
const CATEGORY_KEYS = [
  'kind',
  'filterEnabled',
  'visibility',
  'colors',
  'colormapId',
  'outlierFilterEnabled',
  'outlierThreshold'
];
const CONTINUOUS_KEYS = [
  'kind',
  'filterEnabled',
  'filter',
  'colorRange',
  'useLogScale',
  'useFilterColorRange',
  'colormapId'
];
/**
 * Keys a continuous entry may leave out, each meaning its default. The
 * writer always writes them. `zeroGray` (gray for zero) came after sessions
 * written by 0.9.6, which have no such key: absent, it is off, as it is on a
 * freshly loaded field.
 */
const CONTINUOUS_OPTIONAL_KEYS = ['zeroGray'];

/**
 * Every field property that carries user filter/colour intent.
 *
 * This is the exact complement of what the two serializers above read from a
 * field, and the exact set that `ensureCategoryMetadata()` and
 * `ensureContinuousMetadata()` in `state/managers/color-manager.js` lazily
 * default-initialize. Removing a property returns the field to the shape it had
 * when the dataset loaded, so the next `ensure*Metadata()` call re-derives the
 * documented default from the field values.
 *
 * Deliberately absent: `_continuousStats`, `_positiveStats` and
 * `_categoryCounts` are derived from the field values rather than from user
 * intent, and `_continuousStats` is the baseline the writer measures its range
 * deltas against. `_isDeleted`, `_isPurged`, `_originalKey`,
 * `_originalCategories`, `_sourceField`, `_operation`, `_loadingPromise` and
 * `_loadingSignal` are field identity and lifecycle, owned by other session
 * contributors.
 */
const RESET_FIELD_FILTER_PROPERTIES = [
  '_categoryColors',
  '_categoryFilterEnabled',
  '_categoryVisible',
  '_colormapId',
  '_continuousColorRange',
  '_continuousFilter',
  '_filterEnabled',
  '_missingVisible',
  '_outlierFilterEnabled',
  '_outlierThreshold',
  '_useFilterColorRange',
  '_useLogScale',
  '_zeroGray'
];

/**
 * Return one field to its load-time filter and colour defaults.
 *
 * The load-time default is the absence of the property, not a value copied from
 * a sibling default table: every one of these properties is materialized lazily
 * by the colour manager, which stays the single owner of what each default is.
 * @param {object} field
 */
function resetFieldFilterState(field) {
  for (const property of RESET_FIELD_FILTER_PROPERTIES) {
    delete field[property];
  }
  forgetPendingCategoryState(field);
}

function requireRestoreSignal(options) {
  requireExactKeys(options, ['signal'], 'Filter restore options');
  const signal = options.signal;
  if (signal !== null && !(signal instanceof AbortSignal)) {
    throw new TypeError(
      'Filter restore signal must be an AbortSignal or null.'
    );
  }
  return signal;
}

function assertRgb(color, context) {
  if (!Array.isArray(color) || color.length !== 3) {
    throw new TypeError(`${context} must be an RGB triplet.`);
  }
  for (let channel = 0; channel < color.length; channel++) {
    const value = assertFiniteNumber(color[channel], `${context} channel ${channel}`);
    if (value < 0 || value > 1) {
      throw new RangeError(`${context} channels must be from 0 through 1.`);
    }
  }
  return color;
}

function assertRange(value, context) {
  requireExactKeys(value, ['min', 'max'], context);
  const min = assertFiniteNumber(value.min, `${context} min`);
  const max = assertFiniteNumber(value.max, `${context} max`);
  if (min > max) {
    throw new RangeError(`${context} min must not exceed max.`);
  }
  return value;
}

function assertNullableBoolean(value, context) {
  if (value === null) return value;
  return assertBoolean(value, context);
}

/**
 * The name of one category of a field, by its current position.
 *
 * @param {object} field
 * @param {number} categoryIndex
 * @param {string} context
 * @returns {string|number|boolean}
 */
function categoryNameAt(field, categoryIndex, context) {
  if (!Array.isArray(field.categories)) {
    throw new TypeError(
      `${context} requires the category inventory of "${field.key}".`
    );
  }
  if (categoryIndex >= field.categories.length) {
    throw new RangeError(
      `${context} is outside the categories of "${field.key}".`
    );
  }
  return assertCategoryPrimitive(field.categories[categoryIndex], context);
}

/** A saved category of a text or boolean column that no open cell holds. */
const CATEGORY_NOT_OPEN = -1;

/**
 * Resolve one saved category name to its position in the current field.
 *
 * A category position is not pinned by anything the session can check: the
 * dataset fingerprint covers the cells, not the category inventory, so
 * exporting the same cells with one more category shifts every category after
 * it. The name is the stable identity, and it is what the entry records, so a
 * name that is gone is refused by name rather than applied to whichever
 * category now sits at the old position.
 *
 * A text or boolean column (`field.discovered`), or a categorical coded by
 * the categories its open cells hold (a dictionary larger than the open
 * cells and than one request, `storedCategoryCount`), has as categories the
 * labels its open cells hold: a name it lacks belongs to cells that are not open
 * (a published starting view on a subsample, a session that hid a category
 * the cells it was saved on no longer hold), and is `CATEGORY_NOT_OPEN`,
 * held until such cells open (`pending-categories.js`). A stored dictionary
 * that lacks the name is another dataset.
 *
 * @param {object} field
 * @param {Map<string|number|boolean, number>} positions - `indexCategoryPositions(field.categories)`
 * @param {string|number|boolean} categoryName
 * @param {string} context
 * @returns {number}
 */
function resolveCategoryIndex(field, positions, categoryName, context) {
  const categoryIndex = positions.get(categoryName);
  if (categoryIndex === undefined) {
    if (field.discovered === true) return CATEGORY_NOT_OPEN;
    throw new RangeError(
      `${context} names the category ${describeCategory(categoryName)}, `
      + `which "${field.key}" no longer has.`
    );
  }
  if (categoryIndex === DUPLICATE_CATEGORY_POSITION) {
    throw new TypeError(
      `${context} names the category ${describeCategory(categoryName)}, `
      + `and "${field.key}" lists it more than once.`
    );
  }
  return categoryIndex;
}

function assertNullableRange(value, context) {
  if (value === null) return value;
  return assertRange(value, context);
}

function assertFieldInventory(fields, context) {
  assertArray(fields, context);
  const keys = new Set();
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field === null || typeof field !== 'object') {
      throw new TypeError(`${context} entry ${index} must be an object.`);
    }
    const key = assertNonEmptyString(field.key, `${context} entry ${index} key`);
    if (keys.has(key)) {
      throw new TypeError(`${context} contains duplicate key "${key}".`);
    }
    keys.add(key);
    if (field.kind !== 'category' && field.kind !== 'continuous') {
      throw new TypeError(`${context} field "${key}" has unsupported kind.`);
    }
  }
  return fields;
}

function explicitBooleanChange(value, changedValue, context) {
  if (value === undefined) return null;
  assertBoolean(value, context);
  return value === changedValue ? value : null;
}

function explicitNullableColormap(value, unchangedId, context) {
  if (value === undefined || value === null || value === unchangedId) return null;
  return assertNonEmptyString(value, context);
}

function changedOutlierThreshold(field) {
  if (field._outlierThreshold === undefined || field._outlierThreshold === null) {
    return null;
  }
  const threshold = assertFiniteNumber(
    field._outlierThreshold,
    `Category outlierThreshold for "${field.key}"`
  );
  if (threshold < 0 || threshold > 1) {
    throw new RangeError(`Category outlierThreshold for "${field.key}" must be from 0 through 1.`);
  }
  return threshold < 0.9999 ? threshold : null;
}

function serializeCategoryFilter(field) {
  // Colours and visibility as `utils/category-state.js` holds them, checked.
  if (field._categoryColors !== undefined || field._categoryVisible !== undefined) checkCategoryState(field);
  const visibility = [];
  if (field._categoryVisible !== undefined && hiddenCategoryCount(field._categoryVisible) > 0) {
    for (let categoryIndex = 0; categoryIndex < field._categoryVisible.length; categoryIndex++) {
      if (field._categoryVisible[categoryIndex] === 1) continue;
      visibility.push({
        categoryIndex,
        categoryName: categoryNameAt(
          field,
          categoryIndex,
          `Category visibility index ${categoryIndex}`
        ),
        visible: false
      });
    }
  }
  // The cells without a category, hidden by the legend's Missing row: the
  // category named null, last.
  if (field._missingVisible === false) {
    visibility.push({ categoryIndex: null, categoryName: null, visible: false });
  }

  const colors = [];
  if (field._categoryColors !== undefined) {
    const defaults = defaultCategoryColors(field);
    const colorsOf = field._categoryColors;
    for (let categoryIndex = 0; categoryIndex < field.categories.length; categoryIndex++) {
      // The default is a function of position (the file's palette, else
      // Cellucid's), so "changed" is measured against the position the colour
      // is currently at, as drawn (its bytes). Only the change itself is
      // carried across a rewritten file, and it is carried by name.
      const at = categoryIndex * 3;
      if (colorsOf[at] !== defaults[at] || colorsOf[at + 1] !== defaults[at + 1] || colorsOf[at + 2] !== defaults[at + 2]) {
        colors.push({
          categoryName: categoryNameAt(
            field,
            categoryIndex,
            `Category color index ${categoryIndex}`
          ),
          color: categoryRgbAt(field._categoryColors, categoryIndex)
        });
      }
    }
  }

  const entry = {
    kind: 'category',
    filterEnabled: explicitBooleanChange(
      field._categoryFilterEnabled,
      false,
      `Category filterEnabled for "${field.key}"`
    ),
    visibility: visibility.map(change => ({
      categoryName: change.categoryName,
      visible: change.visible
    })),
    colors,
    colormapId: explicitNullableColormap(
      field._colormapId,
      null,
      `Category colormapId for "${field.key}"`
    ),
    outlierFilterEnabled: explicitBooleanChange(
      field._outlierFilterEnabled,
      false,
      `Category outlierFilterEnabled for "${field.key}"`
    ),
    outlierThreshold: changedOutlierThreshold(field)
  };
  const changed = (
    entry.filterEnabled !== null
    || entry.visibility.length > 0
    || entry.colors.length > 0
    || entry.colormapId !== null
    || entry.outlierFilterEnabled !== null
    || entry.outlierThreshold !== null
  );
  return changed ? entry : null;
}

function changedRange(candidate, stats, context) {
  if (candidate === undefined || candidate === null) return null;
  assertRange(candidate, context);
  assertRange(stats, `${context} current stats`);
  const changed = (
    Math.abs(candidate.min - stats.min) > RANGE_EPSILON
    || Math.abs(candidate.max - stats.max) > RANGE_EPSILON
  );
  return changed ? { min: candidate.min, max: candidate.max } : null;
}

function serializeContinuousFilter(field) {
  const filter = changedRange(
    field._continuousFilter,
    field._continuousStats,
    `Continuous filter for "${field.key}"`
  );

  const entry = {
    kind: 'continuous',
    filterEnabled: explicitBooleanChange(
      field._filterEnabled,
      false,
      `Continuous filterEnabled for "${field.key}"`
    ),
    filter,
    // Restore clears the field to its load-time defaults and then replays this
    // entry, so an omitted color range means "whatever the colour manager
    // derives next". That derivation is the effective filter range
    // (`ensureContinuousMetadata()` defaults `_continuousColorRange` to
    // `_continuousFilter`, not to `_continuousStats`), so the color range has to
    // be measured against the same baseline. Measuring it against the field
    // statistics would omit the color range for a field whose filter was
    // narrowed, and the restored colour scale would silently follow the filter.
    colorRange: changedRange(
      field._continuousColorRange,
      filter ?? field._continuousStats,
      `Continuous colorRange for "${field.key}"`
    ),
    useLogScale: explicitBooleanChange(
      field._useLogScale,
      true,
      `Continuous useLogScale for "${field.key}"`
    ),
    useFilterColorRange: explicitBooleanChange(
      field._useFilterColorRange,
      false,
      `Continuous useFilterColorRange for "${field.key}"`
    ),
    // Gray for zero is off by default: only turning it on is a change.
    zeroGray: explicitBooleanChange(
      field._zeroGray,
      true,
      `Continuous zeroGray for "${field.key}"`
    ),
    colormapId: explicitNullableColormap(
      field._colormapId,
      'viridis',
      `Continuous colormapId for "${field.key}"`
    )
  };
  const changed = Object.entries(entry).some(
    ([key, value]) => key !== 'kind' && value !== null
  );
  return changed ? entry : null;
}

/**
 * Whether a field carries any filter or colour property at all. Most fields
 * of a dataset with thousands of genes carry none, and are skipped without
 * being serialized.
 * @param {object} field
 * @returns {boolean}
 */
export function hasFilterState(field) {
  for (const property of RESET_FIELD_FILTER_PROPERTIES) {
    if (field[property] !== undefined) return true;
  }
  return false;
}

export function serializeFiltersForFields(fields, source) {
  if (source !== 'obs' && source !== 'var') {
    throw new TypeError('Filter source must be exactly "obs" or "var".');
  }
  assertArray(fields, `Current ${source} field inventory`);
  const filters = {};
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field === null || typeof field !== 'object') {
      throw new TypeError(`Current ${source} field inventory entry ${index} must be an object.`);
    }
    // Thousands of gene fields carry no filter state; only the ones that do
    // are checked and written.
    if (field._isDeleted === true || !hasFilterState(field)) continue;
    const key = assertNonEmptyString(field.key, `Current ${source} field inventory entry ${index} key`);
    if (field.kind !== 'category' && field.kind !== 'continuous') {
      throw new TypeError(`Current ${source} field inventory field "${key}" has unsupported kind.`);
    }
    if (Object.hasOwn(filters, makeFieldId(source, key))) {
      throw new TypeError(`Current ${source} field inventory contains duplicate key "${key}".`);
    }
    const entry = field.kind === 'category'
      ? serializeCategoryFilter(field)
      : serializeContinuousFilter(field);
    if (entry !== null) {
      filters[makeFieldId(source, field.key)] = entry;
    }
  }
  return filters;
}

function parseExactFieldId(fieldId) {
  assertNonEmptyString(fieldId, 'Filter field id');
  const separator = fieldId.indexOf(':');
  if (separator <= 0 || separator === fieldId.length - 1) {
    throw new TypeError(`Filter field id "${fieldId}" must be source:key.`);
  }
  const source = fieldId.slice(0, separator);
  if (source !== 'obs' && source !== 'var') {
    throw new TypeError(`Filter field id "${fieldId}" has unsupported source.`);
  }
  const fieldKey = fieldId.slice(separator + 1);
  assertNonEmptyString(fieldKey, `Filter field id "${fieldId}" key`);
  return { source, fieldKey };
}

function validateCategoryEntry(entry, field, fieldId) {
  requireExactKeys(entry, CATEGORY_KEYS, `Category filter "${fieldId}"`);
  if (entry.kind !== 'category') {
    throw new TypeError(`Category filter "${fieldId}" must declare kind "category".`);
  }
  assertNullableBoolean(entry.filterEnabled, `Category filter "${fieldId}" filterEnabled`);
  assertNullableString(entry.colormapId, `Category filter "${fieldId}" colormapId`);
  assertNullableBoolean(
    entry.outlierFilterEnabled,
    `Category filter "${fieldId}" outlierFilterEnabled`
  );
  const threshold = assertNullableFiniteNumber(
    entry.outlierThreshold,
    `Category filter "${fieldId}" outlierThreshold`
  );
  if (threshold !== null && (threshold < 0 || threshold > 1)) {
    throw new RangeError(`Category filter "${fieldId}" outlierThreshold must be from 0 through 1.`);
  }
  assertArray(entry.visibility, `Category filter "${fieldId}" visibility`);
  assertArray(entry.colors, `Category filter "${fieldId}" colors`);
  // A field whose categories are found when it is first loaded (a direct
  // AnnData string column) is checked here by shape and names; its names
  // are resolved to positions once the restore has loaded it.
  if (field.categories !== null && !Array.isArray(field.categories)) {
    throw new TypeError(`Current category field "${fieldId}" requires a category inventory.`);
  }
  const positions = field.categories === null ? null : indexCategoryPositions(field.categories);

  const visibilityIndices = new Set();
  const resolvedVisibility = [];
  // Saved categories no open cell holds, by name (`CATEGORY_NOT_OPEN`).
  const pending = { visibility: [], colors: [] };
  const pendingNames = { visibility: new Set(), colors: new Set() };
  for (const change of entry.visibility) {
    requireExactKeys(
      change,
      ['categoryName', 'visible'],
      `Category filter "${fieldId}" visibility change`
    );
    // null names the cells without a category (the legend's Missing row).
    if (change.categoryName !== null) {
      assertCategoryPrimitive(
        change.categoryName,
        `Category filter "${fieldId}" visibility categoryName`
      );
    }
    const categoryIndex = positions === null || change.categoryName === null
      ? change.categoryName
      : resolveCategoryIndex(
        field,
        positions,
        change.categoryName,
        `Category filter "${fieldId}" visibility change`
      );
    if (change.visible !== false) {
      throw new TypeError(`Category filter "${fieldId}" visibility changes must be explicit false values.`);
    }
    if (categoryIndex === CATEGORY_NOT_OPEN) {
      if (pendingNames.visibility.has(change.categoryName)) {
        throw new TypeError(`Category filter "${fieldId}" repeats a visibility category.`);
      }
      pendingNames.visibility.add(change.categoryName);
      pending.visibility.push({ categoryName: change.categoryName, visible: change.visible });
      continue;
    }
    if (visibilityIndices.has(categoryIndex)) {
      throw new TypeError(`Category filter "${fieldId}" repeats a visibility category.`);
    }
    visibilityIndices.add(categoryIndex);
    resolvedVisibility.push({ categoryIndex, visible: change.visible });
  }

  const colorIndices = new Set();
  const resolvedColors = [];
  for (const change of entry.colors) {
    requireExactKeys(
      change,
      ['categoryName', 'color'],
      `Category filter "${fieldId}" color change`
    );
    assertCategoryPrimitive(
      change.categoryName,
      `Category filter "${fieldId}" color categoryName`
    );
    const categoryIndex = positions === null
      ? change.categoryName
      : resolveCategoryIndex(
        field,
        positions,
        change.categoryName,
        `Category filter "${fieldId}" color change`
      );
    assertRgb(change.color, `Category filter "${fieldId}" color`);
    if (categoryIndex === CATEGORY_NOT_OPEN) {
      if (pendingNames.colors.has(change.categoryName)) {
        throw new TypeError(`Category filter "${fieldId}" repeats a color category.`);
      }
      pendingNames.colors.add(change.categoryName);
      pending.colors.push({ categoryName: change.categoryName, color: change.color });
      continue;
    }
    if (colorIndices.has(categoryIndex)) {
      throw new TypeError(`Category filter "${fieldId}" repeats a color category.`);
    }
    colorIndices.add(categoryIndex);
    resolvedColors.push({ categoryIndex, color: change.color });
  }

  if (
    entry.filterEnabled === null
    && entry.visibility.length === 0
    && entry.colors.length === 0
    && entry.colormapId === null
    && entry.outlierFilterEnabled === null
    && entry.outlierThreshold === null
  ) {
    throw new TypeError(`Category filter "${fieldId}" must contain an explicit change.`);
  }
  if (positions === null) return null;
  return { visibility: resolvedVisibility, colors: resolvedColors, pending };
}

function validateContinuousEntry(entry, fieldId) {
  requireKeys(entry, CONTINUOUS_KEYS, CONTINUOUS_OPTIONAL_KEYS, `Continuous filter "${fieldId}"`);
  if (entry.kind !== 'continuous') {
    throw new TypeError(`Continuous filter "${fieldId}" must declare kind "continuous".`);
  }
  assertNullableBoolean(entry.filterEnabled, `Continuous filter "${fieldId}" filterEnabled`);
  assertNullableRange(entry.filter, `Continuous filter "${fieldId}" filter`);
  assertNullableRange(entry.colorRange, `Continuous filter "${fieldId}" colorRange`);
  assertNullableBoolean(entry.useLogScale, `Continuous filter "${fieldId}" useLogScale`);
  assertNullableBoolean(
    entry.useFilterColorRange,
    `Continuous filter "${fieldId}" useFilterColorRange`
  );
  if (Object.hasOwn(entry, 'zeroGray')) assertNullableBoolean(entry.zeroGray, `Continuous filter "${fieldId}" zeroGray`);
  assertNullableString(entry.colormapId, `Continuous filter "${fieldId}" colormapId`);
  if (
    entry.filterEnabled === null
    && entry.filter === null
    && entry.colorRange === null
    && entry.useLogScale === null
    && entry.useFilterColorRange === null
    && (entry.zeroGray ?? null) === null
    && entry.colormapId === null
  ) {
    throw new TypeError(`Continuous filter "${fieldId}" must contain an explicit change.`);
  }
}

/**
 * The current obs and var field inventories with a key index for each, read
 * once. Validating several views' filters against one inventory reads and
 * indexes thousands of gene fields once instead of once per view.
 *
 * @param {object} state
 * @returns {{obsFields: object[], varFields: object[], obsLookup: Map<string, number>, varLookup: Map<string, number>}}
 */
export function readFieldInventory(state) {
  if (state === null || typeof state !== 'object') {
    throw new TypeError('Filter validation requires the current DataState owner.');
  }
  requireMethod(state, 'getFields', 'Filter validation owner');
  requireMethod(state, 'getVarFields', 'Filter validation owner');
  const obsFields = assertFieldInventory(
    state.getFields(),
    'Current obs field inventory'
  );
  const varFields = assertFieldInventory(
    state.getVarFields(),
    'Current var field inventory'
  );
  return {
    obsFields,
    varFields,
    obsLookup: new Map(obsFields.map((field, index) => [field.key, index])),
    varLookup: new Map(varFields.map((field, index) => [field.key, index]))
  };
}

export function validateFiltersForState(state, filters, inventory = readFieldInventory(state)) {
  requirePlainRecord(filters, 'Session filters');
  const { obsFields, varFields, obsLookup, varLookup } = inventory;
  const actions = [];

  for (const [fieldId, entry] of Object.entries(filters)) {
    const { source, fieldKey } = parseExactFieldId(fieldId);
    const fields = source === 'obs' ? obsFields : varFields;
    const lookup = source === 'obs' ? obsLookup : varLookup;
    const fieldIndex = lookup.get(fieldKey);
    if (fieldIndex === undefined || fields[fieldIndex]._isDeleted === true) {
      throw new RangeError(`Current field "${fieldId}" was not found.`);
    }
    const field = fields[fieldIndex];
    let resolved = null;
    if (field.kind === 'category') {
      resolved = validateCategoryEntry(entry, field, fieldId);
    } else {
      validateContinuousEntry(entry, fieldId);
    }
    if (entry.kind !== field.kind) {
      throw new TypeError(
        `Filter "${fieldId}" kind does not match current field kind "${field.kind}".`
      );
    }
    actions.push({ source, fieldIndex, fieldId, field, entry, resolved });
  }
  return actions;
}

export function createFilterSerializer({ state }) {
  if (state === null || typeof state !== 'object') {
    throw new TypeError('Filter serializer requires the current DataState owner.');
  }

  function serializeFilters() {
    requireMethod(state, 'getFields', 'Filter capture owner');
    requireMethod(state, 'getVarFields', 'Filter capture owner');
    return {
      ...serializeFiltersForFields(state.getFields(), 'obs'),
      ...serializeFiltersForFields(state.getVarFields(), 'var')
    };
  }

  async function restoreFilters(
    filters,
    options = { signal: null }
  ) {
    const signal = requireRestoreSignal(options);
    requireMethod(state, 'ensureFieldLoaded', 'Filter restore owner');
    requireMethod(state, 'ensureVarFieldLoaded', 'Filter restore owner');
    requireMethod(state, 'beginBatch', 'Filter restore owner');
    requireMethod(state, 'endBatch', 'Filter restore owner');

    const actions = validateFiltersForState(state, filters);
    throwIfAborted(signal);

    const loadController = new AbortController();
    const stopForwarding = onAbort(signal, () => {
      if (loadController.signal.aborted) return;
      loadController.abort(signal.reason);
    });
    // Outlier thresholds whose quantiles could not be got: the rest of the
    // session is restored, and these are named, never dropped silently.
    const unrestoredOutliers = new Map();
    let loadOutcomes;
    try {
      loadOutcomes = await Promise.allSettled(actions.map(async ({
        source,
        fieldIndex,
        entry
      }) => {
        try {
          if (source === 'obs') {
            await state.ensureFieldLoaded(fieldIndex, {
              signal: loadController.signal
            });
            // A saved outlier threshold filters at once: the field's
            // quantiles, got on the filter's first use, are got now (read
            // from the file, or computed with progress and Cancel).
            if (
              entry.kind === 'category'
              && entry.outlierThreshold !== null
              && entry.outlierThreshold < 0.9999
            ) {
              requireMethod(state, 'ensureOutlierQuantiles', 'Outlier filter restore owner');
              try {
                const quantiles = await state.ensureOutlierQuantiles(fieldIndex, {
                  signal: loadController.signal
                });
                if (quantiles === null) {
                  unrestoredOutliers.set(fieldIndex, 'no latent space is chosen to measure outliers in');
                }
              } catch (error) {
                if (loadController.signal.aborted) throw error;
                unrestoredOutliers.set(
                  fieldIndex,
                  isCancellation(error)
                    ? 'computing its outlier quantiles was cancelled'
                    : (error?.message ?? String(error))
                );
              }
            }
          } else {
            await state.ensureVarFieldLoaded(fieldIndex, {
              signal: loadController.signal
            });
          }
        } catch (error) {
          if (!loadController.signal.aborted) {
            loadController.abort(error);
          }
          throw error;
        }
      }));
    } finally {
      stopForwarding();
    }
    throwIfAborted(signal);
    const loadFailures = [];
    for (const outcome of loadOutcomes) {
      if (
        outcome.status === 'rejected'
        && !loadFailures.includes(outcome.reason)
      ) {
        loadFailures.push(outcome.reason);
      }
    }
    if (loadFailures.length === 1) throw loadFailures[0];
    if (loadFailures.length > 1) {
      throw new AggregateError(
        loadFailures,
        'Filter field preloads failed.'
      );
    }
    const currentObsFields = assertFieldInventory(
      state.getFields(),
      'Current obs field inventory'
    );
    const currentVarFields = assertFieldInventory(
      state.getVarFields(),
      'Current var field inventory'
    );
    for (const action of actions) {
      const currentFields = action.source === 'obs'
        ? currentObsFields
        : currentVarFields;
      if (currentFields[action.fieldIndex] !== action.field) {
        throw new Error(
          `Filter field "${action.source}:${action.field.key}" was ` +
          'superseded by a replacement inventory.'
        );
      }
      if (action.entry.kind === 'category' && action.resolved === null) {
        // Loaded now: its categories are known, and the saved names resolve.
        action.resolved = validateCategoryEntry(action.entry, action.field, action.fieldId);
        if (action.resolved === null) {
          throw new Error(`Filter field "${action.fieldId}" loaded without its categories.`);
        }
      }
    }

    if (actions.some(action => action.entry.kind === 'category')) {
      requireMethod(state, 'setCategoryStates', 'Category filter restore owner');
    }

    /** @type {Array<{fieldKey: string, count: number}>} */
    const categoriesNotOpen = [];
    state.beginBatch();
    try {
      // A session bundle is the complete field-filter state, not a patch: every
      // field it omits was at its defaults when the session was saved. Clear
      // every current field first so nothing left on screen survives the
      // restore. Deleted fields are skipped for the same reason the writer skips
      // them — they carry no session-visible state.
      for (const fields of [currentObsFields, currentVarFields]) {
        for (const field of fields) {
          if (field._isDeleted === true) continue;
          resetFieldFilterState(field);
        }
      }

      for (const { field, fieldIndex, source, entry, resolved } of actions) {
        throwIfAborted(signal);
        if (entry.kind === 'category') {
          // Positions resolved from the saved names, never the saved
          // positions; every change of a field applied at once (each
          // per-category array copied once, `utils/category-state.js`).
          const visibility = [];
          for (const change of resolved.visibility) {
            if (change.categoryIndex === null) {
              requireMethod(state, 'setMissingCategoryVisibility', 'Missing-value filter restore owner');
              state.setMissingCategoryVisibility(field, change.visible);
              continue;
            }
            visibility.push({ index: change.categoryIndex, visible: change.visible });
          }
          const colors = resolved.colors.map(change => ({ index: change.categoryIndex, rgb: [...change.color] }));
          if (visibility.length > 0 || colors.length > 0) state.setCategoryStates(field, { visibility, colors });
          // Categories of a text or boolean column no open cell holds: held
          // until cells holding them open (`pending-categories.js`).
          const held = holdPendingCategoryState(field, resolved.pending);
          if (held > 0) categoriesNotOpen.push({ fieldKey: field.key, count: held });
          if (entry.filterEnabled !== null) {
            field._categoryFilterEnabled = entry.filterEnabled;
          }
          if (entry.colormapId !== null) {
            field._colormapId = entry.colormapId;
          }
          if (entry.outlierFilterEnabled !== null) {
            field._outlierFilterEnabled = entry.outlierFilterEnabled;
          }
          if (entry.outlierThreshold !== null && !(source === 'obs' && unrestoredOutliers.has(fieldIndex))) {
            field._outlierThreshold = entry.outlierThreshold;
          }
          continue;
        }

        if (entry.filter !== null) {
          field._continuousFilter = { ...entry.filter };
        }
        if (entry.colorRange !== null) {
          field._continuousColorRange = { ...entry.colorRange };
        }
        if (entry.filterEnabled !== null) {
          field._filterEnabled = entry.filterEnabled;
        }
        if (entry.useLogScale !== null) {
          field._useLogScale = entry.useLogScale;
        }
        if (entry.useFilterColorRange !== null) {
          field._useFilterColorRange = entry.useFilterColorRange;
        }
        // Absent (a session written by 0.9.6) or null: off, the default.
        if ((entry.zeroGray ?? null) !== null) {
          field._zeroGray = entry.zeroGray;
        }
        if (entry.colormapId !== null) {
          field._colormapId = entry.colormapId;
        }
      }
      throwIfAborted(signal);
    } finally {
      state.endBatch();
    }

    const outliersNotRestored = actions
      .filter(({ source, fieldIndex }) => source === 'obs' && unrestoredOutliers.has(fieldIndex))
      .map(({ field, fieldIndex, entry }) => ({
        fieldKey: field.key,
        threshold: entry.outlierThreshold,
        reason: unrestoredOutliers.get(fieldIndex),
      }));
    for (const { fieldKey, threshold, reason } of outliersNotRestored) {
      getNotificationCenter().warning(
        `The outlier filter of "${fieldKey}" (${Math.round(threshold * 100)}%) was not restored: ${reason}. ` +
        'Move its outlier slider to apply it again.',
        { category: 'session', duration: 0 }
      );
    }
    for (const { fieldKey, count } of categoriesNotOpen) {
      getNotificationCenter().info(
        `${formatCountOf(count, 'category', 'categories')} of "${fieldKey}" in this session `
        + `${count === 1 ? "isn't" : "aren't"} among the open cells; `
        + `${count === 1 ? 'its settings apply' : 'their settings apply'} when those cells open.`,
        { category: 'session' }
      );
    }
    return { restored: actions.length, outliersNotRestored, categoriesNotOpen };
  }

  return {
    serializeFiltersForFields,
    serializeFilters,
    validateFilters: filters => validateFiltersForState(state, filters),
    restoreFilters
  };
}
