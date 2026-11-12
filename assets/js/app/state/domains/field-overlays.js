/**
 * @fileoverview The `field-overlays` state domain: what the person changed
 * about the dataset's fields, and the fields she (or a notebook) made.
 *
 * Value:
 *
 *     {renamedFields: [{source, key, name}],              // key: as the dataset names it
 *      renamedCategories: [{source, field, category, name}], // field, category: original
 *      deletedFields: [{source, key, purged}],
 *      userFields: [{
 *        id, source, kind: 'category'|'continuous', key,  // key: as it is shown
 *        deleted, purged, createdAt,
 *        sourceField, operation,                          // what it was made from (records)
 *        // a category field (not purged):
 *        categories: [label, …],
 *        codes: {cells, values},                          // per cell, by original position
 *        sourcePages, overlapStrategy, overlapLabel, intersectionLabels, uncoveredLabel,
 *        // intersectionLabels: {key: label} by combination of pages, the key
 *        // its pages' positions in sourcePages joined by "+" ("0+2")
 *        palette: ['#rrggbb', …]|null,                    // the colors its categories open with
 *        // a continuous field that holds its own values (no sourceField, not purged):
 *        values: {cells, values: Float32Array}            // NaN: no value
 *      }, …]}
 *
 * Renames and deletions name fields and categories as the dataset does
 * (`registries/rename-registry.js` `toEntries`). A user field's codes and
 * values are per-cell columns by original position (`cell-positions.js`): restored on
 * other open cells, a cell that is not open is left out and a newly open cell
 * has no category (the codes' missing marker) or no value (NaN). A continuous
 * field copied from another (a "copy") holds no values: they are read from
 * its source, as a session restores it.
 *
 * Python and R read this shape from a saved history to apply labels and user
 * fields to an AnnData (`apply_cellucid_session_to_anndata`,
 * `cellucid_apply_session`).
 *
 * Restore first checks the whole value and prepares what it applies (the
 * renames and deletions checked by their registries, each changed user
 * field's arrays laid over the open cells and its codes checked against its
 * categories), so a value that cannot be put back changes nothing. Then it
 * replaces the rename and delete registries when they differ, gives
 * every user field whose definition differs its definition (a new template
 * for a field the value adds), removes the fields it does not hold from the
 * registry and from every view's field list, and re-reads the overlays
 * (`applyFieldOverlays`). A view's own colors and hidden categories of a
 * user category field whose categories changed are carried by label (only
 * what differed from the field's opening colors), so the `filters` and
 * `colors` values that name it stay what they were. Views that color by or
 * filter on a changed field are drawn again.
 *
 * @module app/state/domains/field-overlays
 */

import { openColumn, originalColumn } from './cell-positions.js';
import { sameValue } from './same-value.js';
import { captureFieldColors } from './colors.js';
import { captureFieldFilter } from './filters.js';
import { inEachView, viewIdsOf } from './view-list.js';
import { computeAllLayoutCentroids } from '../../registries/user-defined-fields/centroids.js';
import { requireCategoryCodes } from '../../registries/user-defined-fields.js';
import { RenameRegistry } from '../../registries/rename-registry.js';
import { DeleteRegistry } from '../../registries/delete-registry.js';
import { OverlapStrategy } from '../../utils/field-constants.js';
import { StateValidator } from '../../utils/state-validator.js';
import { categoricalStorageForCodes, isCategoricalCodes } from '../../../data/categorical-storage-contract.js';
import { checkCategoryState, withCategoryChanges } from '../../utils/category-state.js';
import { getFieldRegistry } from '../../utils/field-registry.js';
import { intersectionKey, parseIntersectionKey } from '../../utils/page-membership.js';
import { HEX_COLOR, hexOfRgb01, rgb01OfHex } from '../../../utils/hex-color.js';

/**
 * The value with its generated parts left out of a comparison
 * (`app/actions/domains.js` `canonical`): each user field's id renamed in
 * order (`user_1`, …) and its creation time dropped, so the same steps
 * applied again compare equal.
 */
export function canonicalFieldOverlays(value) {
  return { ...value, userFields: value.userFields.map((item, index) => ({ ...item, id: `user_${index + 1}`, createdAt: null })) };
}

/** One user field as a value holds it. */
function captureUserField(field, identity) {
  const id = field._userDefinedId;
  const item = {
    id,
    source: field._fieldSource,
    kind: field.kind,
    key: field.key,
    deleted: field._isDeleted === true,
    purged: field._isPurged === true,
    createdAt: field._createdAt,
    sourceField: structuredClone(field._sourceField ?? null),
    operation: structuredClone(field._operation ?? null),
  };
  if (item.purged) return item;
  if (field.kind === 'category') {
    if (!isCategoricalCodes(field.codes)) {
      throw new Error(`The user field "${field.key}" is still being read; its state cannot be taken yet.`);
    }
    item.categories = [...field.categories];
    item.codes = originalColumn(identity, field.codes);
    item.sourcePages = structuredClone(field._sourcePages ?? []);
    item.overlapStrategy = field._overlapStrategy;
    item.overlapLabel = field._overlapLabel ?? null;
    item.intersectionLabels = structuredClone(field._intersectionLabels ?? null);
    item.uncoveredLabel = field._uncoveredLabel ?? null;
    // The colors its categories open with, when the field has its own (a
    // field made from highlight pages: its pages' colors).
    item.palette = Array.isArray(field.palette) && field.palette.length === field.categories.length
      ? field.palette.map(hexOfRgb01)
      : null;
  } else if (field._sourceField === null) {
    if (!(field.values instanceof Float32Array)) {
      throw new Error(`The user field "${field.key}" is still being read; its state cannot be taken yet.`);
    }
    item.values = originalColumn(identity, field.values);
  }
  return item;
}

/**
 * The open dataset's field overlays, as a value.
 *
 * @param {object} state
 */
export function captureFieldOverlays(state) {
  const renames = state.getRenameRegistry().toEntries();
  const identity = state.cellIdentity;
  return {
    renamedFields: renames.fields,
    renamedCategories: renames.categories,
    deletedFields: state.getDeleteRegistry().toEntries(),
    userFields: state.getUserDefinedFieldsRegistry().getAllFields().map(field => captureUserField(field, identity)),
  };
}

/** A template for a user field the registry does not hold, shaped as the registry makes one. */
function newTemplate(item) {
  const common = {
    key: item.key,
    kind: item.kind,
    loaded: false,
    _loadingPromise: null,
    _isUserDefined: true,
    _isDeleted: item.deleted,
    _isPurged: item.purged,
    _userDefinedId: item.id,
    _fieldSource: item.source,
    _sourceField: null,
    _operation: null,
    _createdAt: item.createdAt,
  };
  if (item.kind === 'continuous') return { ...common, values: null };
  return {
    ...common,
    categories: [],
    codes: null,
    centroidsByLayout: new Map(),
    _normalizedLayouts: new Set(),
    _sourcePages: [],
    _overlapStrategy: item.overlapStrategy ?? 'first',
    _overlapLabel: null,
    _intersectionLabels: null,
    _uncoveredLabel: null,
    palette: null,
  };
}

const USER_FIELD_KINDS = Object.freeze(['category', 'continuous']);
const FIELD_SOURCES = Object.freeze(['obs', 'var']);
const OVERLAP_STRATEGIES = Object.freeze(Object.values(OverlapStrategy));

/** A per-cell column of a value: `{cells: Uint32Array|null, values: typed array}` of one length. */
function requireColumn(column, ArrayType, context) {
  if (column === null || typeof column !== 'object' || !ArrayBuffer.isView(column.values)
    || (ArrayType !== null && !(column.values instanceof ArrayType))) {
    throw new TypeError(`${context} must hold its values as ${ArrayType === null ? 'a typed array' : `a ${ArrayType.name}`}.`);
  }
  if (column.cells !== null && (!(column.cells instanceof Uint32Array) || column.cells.length !== column.values.length)) {
    throw new TypeError(`${context} must name one cell (by original position) per value.`);
  }
}

/**
 * A user field's intersection labels, each keyed by its pages
 * (`intersectionKey`), checked against its pages. A key of any other shape
 * is refused: a value records one kind of key (an older session's steps
 * replay through the action's own upgrade path, which names pages by name).
 */
function readIntersectionLabels(item) {
  const labels = item.intersectionLabels;
  if (labels === null) return null;
  if (typeof labels !== 'object' || Array.isArray(labels)) {
    throw new TypeError(`User field "${item.key}" to restore must give its intersection labels as a record.`);
  }
  const pageCount = Array.isArray(item.sourcePages) ? item.sourcePages.length : 0;
  const read = {};
  for (const [key, label] of Object.entries(labels)) {
    try {
      read[intersectionKey(parseIntersectionKey(key, pageCount))] = label;
    } catch (error) {
      throw new TypeError(`User field "${item.key}" to restore labels an intersection it cannot hold: ${error.message}.`);
    }
  }
  return read;
}

/** Check one user field of a value (its shape; its arrays are checked as they are laid over the open cells). */
function requireUserFieldItem(item, index) {
  const context = `User field ${index + 1} to restore`;
  if (item === null || typeof item !== 'object') throw new TypeError(`${context} must be a record.`);
  if (typeof item.id !== 'string' || item.id.length === 0) throw new TypeError(`${context} needs its id.`);
  if (!FIELD_SOURCES.includes(item.source)) throw new TypeError(`${context} ("${item.id}") must be of obs or var.`);
  if (!USER_FIELD_KINDS.includes(item.kind)) throw new TypeError(`${context} ("${item.id}") must be a category or a continuous field.`);
  StateValidator.validateFieldKey(item.key);
  if (typeof item.deleted !== 'boolean' || typeof item.purged !== 'boolean') {
    throw new TypeError(`User field "${item.key}" to restore must say whether it is deleted and purged.`);
  }
  if (item.purged || item.kind !== 'category') return;
  if (!Array.isArray(item.categories)) throw new TypeError(`User field "${item.key}" to restore must list its categories.`);
  for (const category of item.categories) StateValidator.validateCategoryLabel(category);
  requireColumn(item.codes, null, `The codes of user field "${item.key}"`);
  if (!OVERLAP_STRATEGIES.includes(item.overlapStrategy)) {
    throw new TypeError(`User field "${item.key}" to restore names an unknown overlap strategy "${item.overlapStrategy}".`);
  }
  if (item.palette !== null && (!Array.isArray(item.palette) || item.palette.length !== item.categories.length
    || item.palette.some(color => typeof color !== 'string' || !HEX_COLOR.test(color)))) {
    throw new TypeError(`User field "${item.key}" to restore must give its palette as null or one #rrggbb color a category.`);
  }
}

/**
 * The definition `item` gives a user field's template, its per-cell arrays
 * laid over the open cells and checked (codes in the category inventory, one
 * value per open cell). Nothing is changed: `Object.assign(template, definition)`
 * applies it. `template` is the field's template now (null for a new one);
 * what it already holds the same is not computed again.
 */
function prepareDefinition(state, template, item, identity) {
  const definition = {
    key: item.key,
    _isDeleted: item.deleted,
    _isPurged: item.purged,
    _sourceField: structuredClone(item.sourceField),
    _operation: structuredClone(item.operation),
    _createdAt: item.createdAt,
  };
  if (item.purged) {
    // What a purge releases (`UserDefinedFieldsRegistry.purgeField`).
    Object.assign(definition, { codes: null, values: null, loaded: false });
    if (item.kind === 'category') {
      Object.assign(definition, {
        categories: [], centroidsByLayout: new Map(), _normalizedLayouts: new Set(), _sourcePages: [], _intersectionLabels: null,
        palette: null,
      });
    }
    return definition;
  }
  if (item.kind === 'category') {
    const context = `User field "${item.key}"`;
    const { missingValue } = categoricalStorageForCodes(item.codes.values, context);
    const codes = openColumn(identity, item.codes, item.codes.values.constructor, missingValue);
    const categories = [...item.categories];
    requireCategoryCodes(codes, categories, state.pointCount, context);
    if (template === null || template.codes !== codes || !sameValue(template.categories, categories)) {
      const { centroidsByLayout, normalizedLayouts } = computeAllLayoutCentroids(codes, categories, state);
      Object.assign(definition, { codes, categories, centroidsByLayout, _normalizedLayouts: normalizedLayouts });
    }
    return Object.assign(definition, {
      loaded: true,
      _sourcePages: structuredClone(item.sourcePages),
      _overlapStrategy: item.overlapStrategy,
      _overlapLabel: item.overlapLabel,
      _intersectionLabels: readIntersectionLabels(item),
      _uncoveredLabel: item.uncoveredLabel,
      palette: item.palette === null ? null : item.palette.map(rgb01OfHex),
    });
  }
  if (item.values !== undefined) {
    requireColumn(item.values, Float32Array, `The values of user field "${item.key}"`);
    const values = openColumn(identity, item.values, Float32Array, Number.NaN);
    if (values.length !== state.pointCount) {
      throw new RangeError(`The values of user field "${item.key}" do not fit the ${state.pointCount} open cells.`);
    }
    return Object.assign(definition, { values, loaded: true });
  }
  if (template === null || !sameValue(template._sourceField, item.sourceField) || template.values === undefined) {
    // A copy reads its values from its source when it is next used.
    Object.assign(definition, { values: null, loaded: false });
  }
  return definition;
}

/**
 * Check a whole value and prepare everything its restore applies, changing
 * nothing: the renames and deletions (checked by their registries' own
 * `fromEntries`, on registries of their own), and each user field whose
 * definition differs, its template (the registry's own when it is of the
 * same kind and source, else a new one) and the definition it gets.
 *
 * @returns {{renames: boolean, deletions: boolean, fields: Array<{template: object, definition: object|null}>}}
 */
function prepareRestore(state, current, value) {
  if (value === null || typeof value !== 'object' || !Array.isArray(value.renamedFields)
    || !Array.isArray(value.renamedCategories) || !Array.isArray(value.deletedFields) || !Array.isArray(value.userFields)) {
    throw new TypeError('The field changes to restore must list renames, deletions and user fields.');
  }
  const renames = !sameValue(current.renamedFields, value.renamedFields) || !sameValue(current.renamedCategories, value.renamedCategories);
  if (renames) new RenameRegistry().fromEntries({ fields: value.renamedFields, categories: value.renamedCategories });
  const deletions = !sameValue(current.deletedFields, value.deletedFields);
  if (deletions) new DeleteRegistry().fromEntries(value.deletedFields);
  const ids = new Set();
  value.userFields.forEach((item, index) => {
    requireUserFieldItem(item, index);
    if (ids.has(item.id)) throw new TypeError(`The user field id "${item.id}" is listed twice.`);
    ids.add(item.id);
  });
  const registry = state.getUserDefinedFieldsRegistry();
  const identity = state.cellIdentity;
  const before = new Map(current.userFields.map(item => [item.id, item]));
  const fields = value.userFields.map(item => {
    const existing = registry.getField(item.id) ?? null;
    if (existing !== null && sameValue(before.get(item.id), item)) return { template: existing, definition: null };
    const reused = existing !== null && existing.kind === item.kind && existing._fieldSource === item.source ? existing : null;
    return {
      template: reused ?? newTemplate(item),
      definition: prepareDefinition(state, reused, item, identity),
    };
  });
  return { renames, deletions, fields };
}

/** The definition properties a view's copy of a user field shares with its template. */
const SHARED_DEFINITION = [
  'key', 'categories', 'codes', 'values', 'centroidsByLayout', 'loaded', '_normalizedLayouts',
  '_isDeleted', '_isPurged', '_sourceField', '_operation', '_sourcePages', '_overlapStrategy',
  '_overlapLabel', '_intersectionLabels', '_uncoveredLabel', '_createdAt', 'palette',
];

/**
 * Give a field a definition's `properties`: a view's copy its template's, or
 * a template (which a view may show as itself) the definition put back.
 * When its categories change, or the colors they open with (its own
 * `palette`), what belonged to the categories it had goes, and the colors and
 * hidden categories it was given are carried by label: what differed from the
 * opening colors and visibility, as the `colors` and `filters` domains name it.
 */
function adoptDefinition(copy, source, properties) {
  const category = (source.kind ?? copy.kind) === 'category';
  const categoriesChange = category && (
    (Object.hasOwn(source, 'categories') && copy.categories !== source.categories && !sameValue(copy.categories, source.categories))
    || (Object.hasOwn(source, 'palette') && !sameValue(copy.palette ?? null, source.palette ?? null))
  );
  let carried = null;
  if (categoriesChange && Array.isArray(copy.categories)) {
    carried = { colors: captureFieldColors(copy, 'obs'), filter: captureFieldFilter(copy, 'obs') };
  }
  for (const property of properties) {
    if (Object.hasOwn(source, property)) copy[property] = source[property];
  }
  if (!categoriesChange) return;
  delete copy._categoryColors;
  delete copy._categoryVisible;
  delete copy._categoryCounts;
  delete copy._originalCategories;
  delete copy.outlierQuantiles;
  delete copy._outlierThreshold;
  if (carried === null || !copy.loaded || !Array.isArray(copy.categories)) return;
  const place = new Map(copy.categories.map((label, index) => [label, index]));
  const hidden = (carried.filter?.hidden ?? []).filter(label => place.has(label));
  const colors = (carried.colors?.colors ?? []).filter(({ category }) => place.has(category));
  if (hidden.length === 0 && colors.length === 0) return;
  checkCategoryState(copy);
  withCategoryChanges(copy, {
    visibility: hidden.map(label => ({ index: place.get(label), visible: false })),
    colors: colors.map(({ category, color }) => ({ index: place.get(category), rgb: rgb01OfHex(color) })),
  });
}

/**
 * Bring one view's field list in line with the registry: drop the copies of
 * user fields it no longer holds, and give the copies of `changed` fields
 * their new definitions. The view's active field follows its field object.
 */
function syncViewFields(owner, kept, changed) {
  for (const [data, source, indexKey] of [[owner.obsData, 'obs', 'activeFieldIndex'], [owner.varData, 'var', 'activeVarFieldIndex']]) {
    const fields = data?.fields;
    if (!Array.isArray(fields)) continue;
    const activeField = owner.activeFieldSource === source ? fields[owner[indexKey]] ?? null : null;
    let removedAny = false;
    for (let index = fields.length - 1; index >= 0; index--) {
      const field = fields[index];
      if (field?._isUserDefined !== true) continue;
      const template = kept.get(field._userDefinedId);
      if (template === undefined) {
        // User fields follow the dataset's own fields (`_injectUserDefinedFields`
        // appends them), so removing one moves no dataset field.
        if (fields.slice(index + 1).some(other => other?._isUserDefined !== true)) {
          throw new Error(`The ${source} field list holds a dataset field after the user field "${field.key}".`);
        }
        fields.splice(index, 1);
        removedAny = true;
      } else if (changed.has(field._userDefinedId) && field !== template) {
        adoptDefinition(field, template, SHARED_DEFINITION);
      }
    }
    if (removedAny && activeField !== null) {
      const at = fields.indexOf(activeField);
      if (at >= 0) owner[indexKey] = at;
      else {
        owner.activeFieldIndex = -1;
        owner.activeVarFieldIndex = -1;
        owner.activeFieldSource = null;
      }
    }
  }
}

/** Highlight groups bound to a field point at its position; a field list that moved moves them. */
function rebindHighlightGroups(state, fieldsBefore) {
  for (const page of state.highlightPages ?? []) {
    for (const group of page.highlightedGroups ?? []) {
      if (group.fieldSource === undefined) continue;
      const field = fieldsBefore[group.fieldSource]?.[group.fieldIndex];
      const fields = (group.fieldSource === 'var' ? state.varData : state.obsData)?.fields ?? [];
      const at = field === undefined ? -1 : fields.indexOf(field);
      if (at >= 0) group.fieldIndex = at;
    }
  }
}

function describeUserField(before, after) {
  const lines = [];
  if (before === undefined) return [`${after.kind === 'category' ? 'Annotation' : 'Field'} "${after.key}" made`];
  if (after === undefined) return [`Field "${before.key}" removed`];
  if (before.key !== after.key) lines.push(`Field "${before.key}" renamed "${after.key}"`);
  if (before.deleted !== after.deleted) lines.push(`Field "${after.key}" ${after.deleted ? 'deleted' : 'restored'}`);
  if (before.purged !== after.purged && after.purged) lines.push(`Field "${after.key}" deleted for good`);
  if (!sameValue(before.categories, after.categories)) lines.push(`Field "${after.key}": categories changed`);
  else if (!sameValue(before.codes, after.codes) || !sameValue(before.values, after.values)) lines.push(`Field "${after.key}": values changed`);
  return lines;
}

/**
 * @param {{state: object, viewer: object, refreshUi: () => void}} options
 */
export function createFieldOverlaysDomain({ state, viewer, refreshUi }) {
  async function restore(value) {
    if (value === null || typeof value !== 'object') {
      throw new TypeError('The field changes to restore must list renames, deletions and user fields.');
    }
    const current = captureFieldOverlays(state);
    if (sameValue(current, value)) return;
    // The whole value is checked and prepared before anything changes, so a
    // value that cannot be put back leaves the fields as they were.
    const prepared = prepareRestore(state, current, value);
    const fieldsBefore = { obs: [...(state.obsData?.fields ?? [])], var: [...(state.varData?.fields ?? [])] };
    if (prepared.renames) state.getRenameRegistry().fromEntries({ fields: value.renamedFields, categories: value.renamedCategories });
    if (prepared.deletions) state.getDeleteRegistry().fromEntries(value.deletedFields);
    const registry = state.getUserDefinedFieldsRegistry();
    const templates = [];
    const changed = new Set();
    for (const { template, definition } of prepared.fields) {
      templates.push(template);
      if (definition === null) continue;
      adoptDefinition(template, definition, Object.keys(definition));
      changed.add(template._userDefinedId);
    }
    registry.adoptFields(templates);
    const kept = new Map(templates.map(template => [template._userDefinedId, template]));
    const ids = viewIdsOf(viewer);
    for (const id of ids) {
      const owner = id === state.getActiveViewId() ? state : state.viewContexts.get(id);
      syncViewFields(owner, kept, changed);
    }
    // The focused view reads the registries again and takes in the fields it
    // lacks; every other view does when it is next focused (`setActiveView`).
    state.applyFieldOverlays();
    getFieldRegistry().invalidate();
    rebindHighlightGroups(state, fieldsBefore);
    // Draw again each view that colors by, or filters on, a changed field.
    const uses = ids.map(id => {
      const owner = id === state.getActiveViewId() ? state : state.viewContexts.get(id);
      const fields = owner.obsData?.fields ?? [];
      const active = owner.activeFieldSource === 'obs' ? fields[owner.activeFieldIndex] : null;
      return fields.some(field => changed.has(field?._userDefinedId) && (field === active || captureFieldFilter(field, 'obs') !== null));
    });
    const redraw = uses.flatMap((use, index) => (use ? [index] : []));
    await inEachView(state, ids, redraw, () => {
      const active = state.getActiveField();
      if (state.activeFieldSource === 'obs' && active !== null && changed.has(active._userDefinedId) && active._isDeleted !== true) {
        state.setActiveField(state.activeFieldIndex);
      } else {
        state.computeGlobalVisibility();
      }
    });
    state._syncActiveContext();
    refreshUi();
  }

  return {
    capture: () => captureFieldOverlays(state),
    restore,
    canonical: canonicalFieldOverlays,
    describe(a, b) {
      const lines = [];
      const renamedA = new Map(a.renamedFields.map(entry => [`${entry.source}:${entry.key}`, entry.name]));
      const renamedB = new Map(b.renamedFields.map(entry => [`${entry.source}:${entry.key}`, entry.name]));
      for (const [id, name] of renamedB) if (renamedA.get(id) !== name) lines.push(`Field "${id.slice(id.indexOf(':') + 1)}" shown as "${name}"`);
      for (const id of renamedA.keys()) if (!renamedB.has(id)) lines.push(`Field "${id.slice(id.indexOf(':') + 1)}" shown under its own name`);
      const categoryId = entry => JSON.stringify([entry.source, entry.field, entry.category]);
      const categoriesA = new Map(a.renamedCategories.map(entry => [categoryId(entry), entry]));
      const categoriesB = new Map(b.renamedCategories.map(entry => [categoryId(entry), entry]));
      for (const [id, entry] of categoriesB) {
        if (categoriesA.get(id)?.name !== entry.name) lines.push(`${entry.field}: "${entry.category}" shown as "${entry.name}"`);
      }
      for (const [id, entry] of categoriesA) if (!categoriesB.has(id)) lines.push(`${entry.field}: "${entry.category}" shown under its own name`);
      const deletedA = new Map(a.deletedFields.map(entry => [`${entry.source}:${entry.key}`, entry]));
      const deletedB = new Map(b.deletedFields.map(entry => [`${entry.source}:${entry.key}`, entry]));
      for (const [id, entry] of deletedB) if (!deletedA.has(id)) lines.push(`Field "${entry.key}" deleted`);
      for (const [id, entry] of deletedA) if (!deletedB.has(id)) lines.push(`Field "${entry.key}" restored`);
      const userA = new Map(a.userFields.map(item => [item.id, item]));
      const userB = new Map(b.userFields.map(item => [item.id, item]));
      for (const id of new Set([...userA.keys(), ...userB.keys()])) {
        const x = userA.get(id);
        const y = userB.get(id);
        if (!sameValue(x, y)) lines.push(...describeUserField(x, y));
      }
      return lines;
    },
  };
}
