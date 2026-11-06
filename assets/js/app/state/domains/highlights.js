/**
 * @fileoverview The `highlights` state domain: highlight pages and their
 * groups of cells.
 *
 * Value:
 *
 *     {active: pageId|null,              // the page shown
 *      pages: [{
 *        id, name, color: '#rrggbb',
 *        groups: [{
 *          id, type, label, enabled,      // type: annotation, lasso, knn, proximity,
 *                                         //   combined, category, range
 *          cells: Uint32Array,            // original positions, ascending (cell-positions.js)
 *          field?: {source, key},         // category and range groups: the field they
 *          category?: label,              //   were made from (its key as shown), the
 *          range?: {min, max}             //   category, or the range
 *        }, …]
 *      }, …]}
 *
 * Page and group ids are kept (`page_<n>`, `highlight_<n>`): analysis
 * settings name pages by id, and a restored page is the same page. The id
 * counters are not part of the value; a restore never lowers them, so an id
 * is never reused on another branch.
 *
 * Python and R read this shape from a saved history to apply highlights to an
 * AnnData (`apply_cellucid_session_to_anndata`, `cellucid_apply_session`):
 * each group's label and its cells by original position.
 *
 * Restore lays each group's cells over the cells open now (a cell that is not
 * open is left out; a group none of whose cells is open is left out), binds a
 * category or range group to its field by name, and publishes the pages as a
 * session restore does (`_recomputeHighlightArray`, the page and highlight
 * events).
 *
 * @module app/state/domains/highlights
 */

import { openCellList, originalCellList } from './cell-positions.js';
import { loadFields } from './fields.js';
import {
  DUPLICATE_CATEGORY_POSITION,
  describeCategory,
  indexCategoryPositions,
} from '../../session/schema-contract.js';
import { formatCountOf } from '../../../utils/format-units.js';

/**
 * The value with its generated ids renamed in order (`page_1`, … and
 * `highlight_1`, …), what a comparison of two values made by the same steps
 * reads (`app/actions/domains.js` `canonical`): the counters behind the ids
 * are never lowered, so the same steps applied again make other ids.
 */
export function canonicalHighlights(value) {
  const pages = new Map(value.pages.map((page, index) => [page.id, `page_${index + 1}`]));
  let group = 0;
  return {
    active: value.active === null ? null : (pages.get(value.active) ?? value.active),
    pages: value.pages.map(page => ({
      ...page, id: pages.get(page.id), groups: page.groups.map(each => ({ ...each, id: `highlight_${++group}` })),
    })),
  };
}

/** The group types that name a field, and so carry a field binding. */
export const FIELD_BOUND_HIGHLIGHT_TYPES = new Set(['category', 'range']);

/**
 * Bind field-owned highlight groups to the field and category they name.
 *
 * `fieldIndex` and `categoryIndex` are positions, and nothing pins a
 * position: re-exporting the same cells with one more obs column shifts every
 * field after it, and one more category every category after it.
 * `fieldKey` and `categoryName` are the stable identity, so both positions are
 * derived from the names, the way a filter is (`filters.js`).
 * A name that is gone is refused by name, never re-bound to whatever now sits
 * at the old position.
 *
 * @param {object} state
 * @param {{allowDeleted?: boolean}} [options] - Whether a deleted field binds
 *   (a history step restores a group whose field was deleted after it was
 *   made; a session file names only fields that are shown)
 * @returns {(group: {type: string, fieldKey: string, fieldSource: string, categoryName?: unknown}, context: string) =>
 *   {fieldIndex: number, categoryIndex: number|null}}
 */
export function createHighlightFieldBinder(state, { allowDeleted = false } = {}) {
  const lookups = new Map();
  // One name index per category field for the whole pass.
  const categoryPositions = new Map();

  function lookupFor(source) {
    let lookup = lookups.get(source);
    if (lookup !== undefined) return lookup;
    const data = source === 'obs' ? state.obsData : state.varData;
    if (data === null || typeof data !== 'object' || !Array.isArray(data.fields)) {
      throw new TypeError(`Highlight field binding requires the current ${source} field inventory.`);
    }
    lookup = { fields: data.fields, byKey: new Map() };
    data.fields.forEach((field, index) => {
      if (field === null || typeof field !== 'object' || typeof field.key !== 'string' || field.key.length === 0) {
        throw new TypeError(`Current ${source} field inventory entry ${index} must be a field with a key.`);
      }
      if (lookup.byKey.has(field.key)) throw new TypeError(`Current ${source} field inventory contains duplicate key "${field.key}".`);
      lookup.byKey.set(field.key, index);
    });
    lookups.set(source, lookup);
    return lookup;
  }

  return function bindHighlightField(group, context) {
    const source = group.fieldSource;
    const { fields, byKey } = lookupFor(source);
    const fieldIndex = byKey.get(group.fieldKey);
    if (fieldIndex === undefined || (!allowDeleted && fields[fieldIndex]._isDeleted === true)) {
      throw new RangeError(
        `${context} was saved on the ${source} field "${group.fieldKey}", `
        + 'which the dataset that is open now does not have.'
      );
    }
    const field = fields[fieldIndex];
    const requiredKind = group.type === 'category' ? 'category' : 'continuous';
    if (field.kind !== requiredKind) {
      throw new TypeError(
        `${context} was saved on the ${source} field "${group.fieldKey}" as a `
        + `${requiredKind} field, and that field is "${String(field.kind)}" in `
        + 'the dataset that is open now.'
      );
    }
    if (group.type !== 'category') return { fieldIndex, categoryIndex: null };
    if (!Array.isArray(field.categories)) {
      throw new TypeError(`${context} requires the category inventory of the ${source} field "${group.fieldKey}".`);
    }
    let positions = categoryPositions.get(field);
    if (positions === undefined) {
      positions = indexCategoryPositions(field.categories);
      categoryPositions.set(field, positions);
    }
    const categoryIndex = positions.get(group.categoryName);
    // Refused for every field: a category group holds cells of its category,
    // and it is restored on the cells it was made on, so they hold it.
    if (categoryIndex === undefined) {
      throw new RangeError(
        `${context} was saved on the category ${describeCategory(group.categoryName)} of the ${source} field `
        + `"${group.fieldKey}", which that field no longer has.`
      );
    }
    if (categoryIndex === DUPLICATE_CATEGORY_POSITION) {
      throw new TypeError(
        `${context} names the category ${describeCategory(group.categoryName)} of the ${source} field `
        + `"${group.fieldKey}", and that field lists it more than once.`
      );
    }
    return { fieldIndex, categoryIndex };
  };
}

/**
 * The obs fields that category groups name whose categories are found only
 * when they are loaded (a text or boolean column): loaded before binding.
 *
 * @param {object} state
 * @param {Iterable<{type: string, fieldSource: string, fieldKey: string}>} groups
 * @returns {number[]} Their positions
 */
export function fieldsToLoadForHighlightBinding(state, groups) {
  const fields = Array.isArray(state.obsData?.fields) ? state.obsData.fields : [];
  const indexByKey = new Map(fields.map((field, index) => [field?.key, index]));
  const pending = new Set();
  for (const group of groups) {
    if (group.type !== 'category' || group.fieldSource !== 'obs') continue;
    const index = indexByKey.get(group.fieldKey);
    if (index === undefined) continue;
    if (fields[index].kind === 'category' && fields[index].categories === null) pending.add(index);
  }
  return [...pending];
}

function suffixOf(id, prefix) {
  const match = new RegExp(`^${prefix}([1-9]\\d*)$`).exec(id);
  return match === null ? 0 : Number(match[1]);
}

/** One group as a value holds it. */
function captureGroup(group, identity) {
  const out = {
    id: group.id,
    type: group.type,
    label: group.label,
    enabled: group.enabled !== false,
    cells: originalCellList(identity, group.cellIndices),
  };
  if (group.type === 'category') {
    out.field = { source: group.fieldSource, key: group.fieldKey };
    out.category = group.categoryName;
  } else if (group.type === 'range') {
    out.field = { source: group.fieldSource, key: group.fieldKey };
    out.range = { min: group.rangeMin, max: group.rangeMax };
  }
  return out;
}

/** Two values' pages and groups compared, the cells by content. */
function sameHighlights(a, b) {
  if (a.active !== b.active || a.pages.length !== b.pages.length) return false;
  for (let p = 0; p < a.pages.length; p++) {
    const x = a.pages[p];
    const y = b.pages[p];
    if (x.id !== y.id || x.name !== y.name || x.color !== y.color || x.groups.length !== y.groups.length) return false;
    for (let g = 0; g < x.groups.length; g++) {
      const { cells: cellsX, ...restX } = x.groups[g];
      const { cells: cellsY, ...restY } = y.groups[g];
      if (JSON.stringify(restX) !== JSON.stringify(restY)) return false;
      if (cellsX !== cellsY && (cellsX.length !== cellsY.length || cellsX.some((cell, i) => cell !== cellsY[i]))) return false;
    }
  }
  return true;
}

/**
 * @param {{state: object, refreshUi: () => void}} options
 */
export function createHighlightsDomain({ state, refreshUi }) {
  function capture() {
    const identity = state.cellIdentity;
    return {
      active: state.getActivePageId() ?? null,
      pages: state.getHighlightPages().map(page => ({
        id: page.id,
        name: page.name,
        color: page.color,
        groups: page.highlightedGroups.map(group => captureGroup(group, identity)),
      })),
    };
  }

  async function restore(value, { signal = null } = {}) {
    if (value === null || typeof value !== 'object' || !Array.isArray(value.pages)) {
      throw new TypeError('The highlights to restore must list their pages.');
    }
    if (sameHighlights(capture(), value)) return;
    const named = value.pages.flatMap(page => page.groups.filter(group => group.field !== undefined)
      .map(group => ({ type: group.type, fieldSource: group.field.source, fieldKey: group.field.key })));
    const loads = fieldsToLoadForHighlightBinding(state, named);
    const fields = state.obsData.fields;
    await loadFields(state, loads.map(() => ({ source: 'obs' })), loads.map(index => ({ field: fields[index], index })), signal);
    const identity = state.cellIdentity;
    const bind = createHighlightFieldBinder(state, { allowDeleted: true });
    let pageCounter = state._highlightPageIdCounter;
    let groupCounter = state._highlightIdCounter;
    const pages = value.pages.map((page, pageIndex) => {
      pageCounter = Math.max(pageCounter, suffixOf(page.id, 'page_'));
      const groups = [];
      for (const group of page.groups) {
        groupCounter = Math.max(groupCounter, suffixOf(group.id, 'highlight_'));
        const positions = openCellList(identity, group.cells);
        // None of its cells is open now (another share of the cells).
        if (positions.length === 0) continue;
        const restored = {
          id: group.id,
          type: group.type,
          label: group.label,
          enabled: group.enabled,
          cellIndices: positions,
          cellCount: positions.length,
        };
        if (group.field !== undefined) {
          const binding = bind(
            { type: group.type, fieldSource: group.field.source, fieldKey: group.field.key, categoryName: group.category },
            `The highlight "${group.label}" on page "${page.name}" (page ${pageIndex + 1})`,
          );
          restored.fieldKey = group.field.key;
          restored.fieldIndex = binding.fieldIndex;
          restored.fieldSource = group.field.source;
          if (group.type === 'category') {
            restored.categoryIndex = binding.categoryIndex;
            restored.categoryName = group.category;
          } else {
            restored.rangeMin = group.range.min;
            restored.rangeMax = group.range.max;
          }
        }
        groups.push(restored);
      }
      return { id: page.id, name: page.name, color: page.color, highlightedGroups: groups };
    });
    if (value.active !== null && !pages.some(page => page.id === value.active)) {
      throw new RangeError(`The highlight page shown, "${value.active}", is not among the pages to restore.`);
    }
    state.highlightPages = pages;
    state.activePageId = value.active;
    state._highlightPageIdCounter = pageCounter;
    state._highlightIdCounter = groupCounter;
    state._recomputeHighlightArray();
    state._notifyHighlightPageChange();
    state._notifyHighlightChange();
    refreshUi();
  }

  return {
    capture,
    restore,
    canonical: canonicalHighlights,
    describe(a, b) {
      const lines = [];
      const pagesA = new Map(a.pages.map(page => [page.id, page]));
      const pagesB = new Map(b.pages.map(page => [page.id, page]));
      for (const [id, page] of pagesB) {
        const was = pagesA.get(id);
        if (was === undefined) {
          lines.push(`Highlight page "${page.name}" added`);
          continue;
        }
        if (was.name !== page.name) lines.push(`Highlight page "${was.name}" renamed "${page.name}"`);
        if (was.color !== page.color) lines.push(`Highlight page "${page.name}" recoloured`);
        const groupsA = new Map(was.groups.map(group => [group.id, group]));
        const groupsB = new Map(page.groups.map(group => [group.id, group]));
        for (const [groupId, group] of groupsB) {
          const before = groupsA.get(groupId);
          if (before === undefined) lines.push(`"${group.label}" highlighted (${formatCountOf(group.cells.length, 'cell')}) on "${page.name}"`);
          else if (before.enabled !== group.enabled) lines.push(`"${group.label}" ${group.enabled ? 'shown' : 'hidden'} on "${page.name}"`);
          else if (before.label !== group.label) lines.push(`"${before.label}" renamed "${group.label}"`);
          else if (before.cells.length !== group.cells.length) lines.push(`"${group.label}" now ${formatCountOf(group.cells.length, 'cell')}`);
        }
        for (const [groupId, group] of groupsA) if (!groupsB.has(groupId)) lines.push(`"${group.label}" removed from "${page.name}"`);
      }
      for (const [id, page] of pagesA) if (!pagesB.has(id)) lines.push(`Highlight page "${page.name}" removed`);
      if (a.active !== b.active && pagesB.has(b.active)) lines.push(`Highlight page "${pagesB.get(b.active).name}" shown`);
      return lines;
    },
  };
}
