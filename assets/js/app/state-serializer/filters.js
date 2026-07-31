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

import { getCategoryColor } from '../../data/palettes.js';
import { makeFieldId } from '../utils/field-constants.js';
import {
  assertArray,
  assertBoolean,
  assertExactKeys,
  assertFiniteNumber,
  assertNonEmptyString,
  assertNullableFiniteNumber,
  assertNullableString,
  assertPlainRecord,
  assertSafeInteger,
  requireMethod
} from '../session/schema-contract.js';

const COLOR_EPSILON = 1e-4;
const RANGE_EPSILON = 1e-6;
const CATEGORY_KEYS = [
  'kind',
  'filterEnabled',
  'visibility',
  'colors',
  'colormapId'
];
const CONTINUOUS_KEYS = [
  'kind',
  'filterEnabled',
  'filter',
  'colorRange',
  'useLogScale',
  'useFilterColorRange',
  'outlierFilterEnabled',
  'outlierThreshold',
  'colormapId'
];

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
  '_outlierFilterEnabled',
  '_outlierThreshold',
  '_useFilterColorRange',
  '_useLogScale'
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
}

function requireRestoreSignal(options) {
  assertExactKeys(options, ['signal'], 'Filter restore options');
  const signal = options.signal;
  if (signal !== null && !(signal instanceof AbortSignal)) {
    throw new TypeError(
      'Filter restore signal must be an AbortSignal or null.'
    );
  }
  return signal;
}

function throwIfAborted(signal) {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('Filter restore was aborted.', 'AbortError');
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

function colorsEqual(a, b) {
  assertRgb(a, 'Field category color');
  assertRgb(b, 'Default category color');
  return (
    Math.abs(a[0] - b[0]) < COLOR_EPSILON
    && Math.abs(a[1] - b[1]) < COLOR_EPSILON
    && Math.abs(a[2] - b[2]) < COLOR_EPSILON
  );
}

function assertRange(value, context) {
  assertExactKeys(value, ['min', 'max'], context);
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

function serializeCategoryFilter(field) {
  const visibility = [];
  if (field._categoryVisible !== undefined) {
    assertPlainRecord(field._categoryVisible, `Category visibility for "${field.key}"`);
    for (const [rawIndex, visible] of Object.entries(field._categoryVisible)) {
      if (!/^(0|[1-9]\d*)$/.test(rawIndex)) {
        throw new TypeError(`Category visibility index "${rawIndex}" must be canonical.`);
      }
      assertBoolean(visible, `Category visibility "${field.key}"[${rawIndex}]`);
      if (visible === false) {
        visibility.push({
          categoryIndex: Number(rawIndex),
          visible
        });
      }
    }
  }
  visibility.sort((a, b) => a.categoryIndex - b.categoryIndex);

  const colors = [];
  if (field._categoryColors !== undefined) {
    assertArray(field._categoryColors, `Category colors for "${field.key}"`);
    for (let categoryIndex = 0; categoryIndex < field._categoryColors.length; categoryIndex++) {
      const color = field._categoryColors[categoryIndex];
      if (color === undefined || color === null) continue;
      assertRgb(color, `Category color "${field.key}"[${categoryIndex}]`);
      if (!colorsEqual(color, getCategoryColor(categoryIndex))) {
        colors.push({
          categoryIndex,
          color: [...color]
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
    visibility,
    colors,
    colormapId: explicitNullableColormap(
      field._colormapId,
      null,
      `Category colormapId for "${field.key}"`
    )
  };
  const changed = (
    entry.filterEnabled !== null
    || entry.visibility.length > 0
    || entry.colors.length > 0
    || entry.colormapId !== null
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
  let outlierThreshold = null;
  if (field._outlierThreshold !== undefined && field._outlierThreshold !== null) {
    const threshold = assertFiniteNumber(
      field._outlierThreshold,
      `Continuous outlierThreshold for "${field.key}"`
    );
    if (threshold < 0 || threshold > 1) {
      throw new RangeError(`Continuous outlierThreshold for "${field.key}" must be from 0 through 1.`);
    }
    if (threshold < 0.9999) outlierThreshold = threshold;
  }

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
    outlierFilterEnabled: explicitBooleanChange(
      field._outlierFilterEnabled,
      false,
      `Continuous outlierFilterEnabled for "${field.key}"`
    ),
    outlierThreshold,
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

export function serializeFiltersForFields(fields, source) {
  if (source !== 'obs' && source !== 'var') {
    throw new TypeError('Filter source must be exactly "obs" or "var".');
  }
  assertFieldInventory(fields, `Current ${source} field inventory`);
  const filters = {};
  for (const field of fields) {
    if (field._isDeleted === true) continue;
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
  assertExactKeys(entry, CATEGORY_KEYS, `Category filter "${fieldId}"`);
  if (entry.kind !== 'category') {
    throw new TypeError(`Category filter "${fieldId}" must declare kind "category".`);
  }
  assertNullableBoolean(entry.filterEnabled, `Category filter "${fieldId}" filterEnabled`);
  assertNullableString(entry.colormapId, `Category filter "${fieldId}" colormapId`);
  assertArray(entry.visibility, `Category filter "${fieldId}" visibility`);
  assertArray(entry.colors, `Category filter "${fieldId}" colors`);
  if (!Array.isArray(field.categories)) {
    throw new TypeError(`Current category field "${fieldId}" requires a category inventory.`);
  }

  const visibilityIndices = new Set();
  for (const change of entry.visibility) {
    assertExactKeys(
      change,
      ['categoryIndex', 'visible'],
      `Category filter "${fieldId}" visibility change`
    );
    const categoryIndex = assertSafeInteger(
      change.categoryIndex,
      `Category filter "${fieldId}" categoryIndex`
    );
    if (categoryIndex >= field.categories.length) {
      throw new RangeError(`Category filter "${fieldId}" categoryIndex is out of range.`);
    }
    if (visibilityIndices.has(categoryIndex)) {
      throw new TypeError(`Category filter "${fieldId}" repeats a visibility categoryIndex.`);
    }
    visibilityIndices.add(categoryIndex);
    if (change.visible !== false) {
      throw new TypeError(`Category filter "${fieldId}" visibility changes must be explicit false values.`);
    }
  }

  const colorIndices = new Set();
  for (const change of entry.colors) {
    assertExactKeys(
      change,
      ['categoryIndex', 'color'],
      `Category filter "${fieldId}" color change`
    );
    const categoryIndex = assertSafeInteger(
      change.categoryIndex,
      `Category filter "${fieldId}" color categoryIndex`
    );
    if (categoryIndex >= field.categories.length) {
      throw new RangeError(`Category filter "${fieldId}" color categoryIndex is out of range.`);
    }
    if (colorIndices.has(categoryIndex)) {
      throw new TypeError(`Category filter "${fieldId}" repeats a color categoryIndex.`);
    }
    colorIndices.add(categoryIndex);
    assertRgb(change.color, `Category filter "${fieldId}" color`);
  }

  if (
    entry.filterEnabled === null
    && entry.visibility.length === 0
    && entry.colors.length === 0
    && entry.colormapId === null
  ) {
    throw new TypeError(`Category filter "${fieldId}" must contain an explicit change.`);
  }
}

function validateContinuousEntry(entry, fieldId) {
  assertExactKeys(entry, CONTINUOUS_KEYS, `Continuous filter "${fieldId}"`);
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
  assertNullableBoolean(
    entry.outlierFilterEnabled,
    `Continuous filter "${fieldId}" outlierFilterEnabled`
  );
  const threshold = assertNullableFiniteNumber(
    entry.outlierThreshold,
    `Continuous filter "${fieldId}" outlierThreshold`
  );
  if (threshold !== null && (threshold < 0 || threshold > 1)) {
    throw new RangeError(`Continuous filter "${fieldId}" outlierThreshold must be from 0 through 1.`);
  }
  assertNullableString(entry.colormapId, `Continuous filter "${fieldId}" colormapId`);
  if (
    entry.filterEnabled === null
    && entry.filter === null
    && entry.colorRange === null
    && entry.useLogScale === null
    && entry.useFilterColorRange === null
    && entry.outlierFilterEnabled === null
    && entry.outlierThreshold === null
    && entry.colormapId === null
  ) {
    throw new TypeError(`Continuous filter "${fieldId}" must contain an explicit change.`);
  }
}

export function validateFiltersForState(state, filters) {
  if (state === null || typeof state !== 'object') {
    throw new TypeError('Filter validation requires the current DataState owner.');
  }
  assertPlainRecord(filters, 'Session filters');
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
  const obsLookup = new Map(obsFields.map((field, index) => [field.key, index]));
  const varLookup = new Map(varFields.map((field, index) => [field.key, index]));
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
    if (field.kind === 'category') {
      validateCategoryEntry(entry, field, fieldId);
    } else {
      validateContinuousEntry(entry, fieldId);
    }
    if (entry.kind !== field.kind) {
      throw new TypeError(
        `Filter "${fieldId}" kind does not match current field kind "${field.kind}".`
      );
    }
    actions.push({ source, fieldIndex, field, entry });
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
    const forwardCallerAbort = () => {
      if (loadController.signal.aborted) return;
      loadController.abort(signal?.reason);
    };
    if (signal !== null) {
      signal.addEventListener('abort', forwardCallerAbort, { once: true });
      if (signal.aborted) forwardCallerAbort();
    }
    let loadOutcomes;
    try {
      loadOutcomes = await Promise.allSettled(actions.map(async ({
        source,
        fieldIndex
      }) => {
        try {
          if (source === 'obs') {
            await state.ensureFieldLoaded(fieldIndex, {
              signal: loadController.signal
            });
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
      signal?.removeEventListener('abort', forwardCallerAbort);
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
    }

    if (actions.some(action => action.entry.kind === 'category')) {
      requireMethod(state, 'setVisibilityForCategory', 'Category filter restore owner');
      requireMethod(state, 'setColorForCategory', 'Category filter restore owner');
    }

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

      for (const { field, entry } of actions) {
        throwIfAborted(signal);
        if (entry.kind === 'category') {
          for (const change of entry.visibility) {
            state.setVisibilityForCategory(
              field,
              change.categoryIndex,
              change.visible
            );
          }
          for (const change of entry.colors) {
            state.setColorForCategory(
              field,
              change.categoryIndex,
              [...change.color]
            );
          }
          if (entry.filterEnabled !== null) {
            field._categoryFilterEnabled = entry.filterEnabled;
          }
          if (entry.colormapId !== null) {
            field._colormapId = entry.colormapId;
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
        if (entry.outlierFilterEnabled !== null) {
          field._outlierFilterEnabled = entry.outlierFilterEnabled;
        }
        if (entry.outlierThreshold !== null) {
          field._outlierThreshold = entry.outlierThreshold;
        }
        if (entry.colormapId !== null) {
          field._colormapId = entry.colormapId;
        }
      }
      throwIfAborted(signal);
    } finally {
      state.endBatch();
    }

    return { restored: actions.length };
  }

  return {
    serializeFiltersForFields,
    serializeFilters,
    validateFilters: filters => validateFiltersForState(state, filters),
    restoreFilters
  };
}
