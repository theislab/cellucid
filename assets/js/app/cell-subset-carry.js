/**
 * @fileoverview What the person made on a dataset, carried across when the
 * dataset is read again with other cells (Open data, Cells to open): its
 * highlight pages and groups, and its user-defined categorical fields
 * (labels, annotations). Both are taken by **original cell position**
 * (`data/cell-identity.js`) before the dataset is read again and given back
 * to the cells of the new reading that hold them:
 *
 * - a highlight group keeps the cells of it that are open again, under its
 *   label and page; a group none of whose cells is open any more is said,
 *   not kept. A category or range group keeps its rule too: bound again to
 *   its field by name, it takes the newly open cells in its category or
 *   range that are visible (`takeInNewCells`), as growing in place does;
 * - a user-defined categorical field keeps each open cell's category; a
 *   newly open cell is labelled as growing in place labels it: from the
 *   file's column the field was made from (a copy, an edit, a consensus;
 *   `DataState.takeInNewlyOpenCells`), else missing (the codes' missing
 *   marker, `categorical-storage-contract.js`);
 * - a user-defined field holding its own values (a column a notebook
 *   pushed) keeps each open cell's value; a cell it had none for is NaN;
 * - a cell hidden by hand (the cell visibility mask) stays hidden.
 *
 * Values are matched by original position with typed arrays (the carried
 * cells sorted by original position, each new cell found by binary
 * search), so a carry holds a few bytes a cell whatever the count.
 *
 * Cells grown or cut in place (a larger or smaller share of the same method
 * and seed) carry nothing: what is shown stays (`open-cells-resize.js`).
 *
 * @module cell-subset-carry
 */

import { formatCountOf } from '../utils/format-units.js';
import { categoricalStorageForCount } from '../data/categorical-storage-contract.js';

/** Highlight types a group is re-made as itself; any other is re-made as `annotation`, a category or range group then bound to its rule again. */
const DIRECT_TYPES = new Set(['annotation', 'combined', 'knn', 'lasso', 'proximity']);

/** The rule a category or range group was made by, by field name; null for any other group. */
function ruleOf(group) {
  if (group.type === 'category') {
    return { type: 'category', fieldKey: group.fieldKey, fieldSource: group.fieldSource, categoryName: group.categoryName };
  }
  if (group.type === 'range') {
    return { type: 'range', fieldKey: group.fieldKey, fieldSource: group.fieldSource, rangeMin: group.rangeMin, rangeMax: group.rangeMax };
  }
  return null;
}

/**
 * Take what is carried from the dataset on screen.
 *
 * @param {object} state - The DataState
 * @returns {{pages: Array, fields: Array, activePage: number, hidden: Uint32Array, before: import('../data/cell-identity.js').CellIdentity}}
 *   `hidden`: the original positions of the cells hidden by hand;
 *   `before`: the identity of the cells open (what is carried is matched
 *   by it, when it is given back)
 */
export function captureCarried(state) {
  const identity = state.cellIdentity;
  const activeId = state.getActivePageId?.() ?? null;
  const pages = (state.getHighlightPages?.() ?? []).map(page => ({
    name: page.name,
    groups: (page.highlightedGroups ?? []).map(group => ({
      type: DIRECT_TYPES.has(group.type) ? group.type : 'annotation',
      rule: ruleOf(group),
      label: group.label,
      enabled: group.enabled !== false,
      cells: identity.toOriginal(group.cellIndices),
    })),
  }));
  const activePage = Math.max(0, (state.getHighlightPages?.() ?? []).findIndex(page => page.id === activeId));
  const fields = [];
  for (const field of state.obsData?.fields ?? []) {
    if (field?._isUserDefined !== true || field._isDeleted === true) continue;
    if (field.kind === 'category' && ArrayBuffer.isView(field.codes) && field.codes.length === state.pointCount) {
      // What it was made from goes with it: newly open cells are labelled
      // from that column (`takeInNewCells`).
      const meta = {};
      if (field._sourceField != null) meta._sourceField = field._sourceField;
      if (field._operation != null) meta._operation = field._operation;
      fields.push({ key: field.key, kind: 'category', categories: [...field.categories], meta, codes: field.codes.slice() });
    } else if (field.kind === 'continuous' && field._sourceField === null && field.values instanceof Float32Array && field.values.length === state.pointCount) {
      fields.push({ key: field.key, kind: 'continuous', operation: field._operation, values: field.values.slice() });
    }
  }
  // Cells hidden by hand (the cell visibility mask), by original position.
  const mask = state.cellVisibilityMask;
  let hidden = 0;
  if (ArrayBuffer.isView(mask) && mask.length === state.pointCount) for (let i = 0; i < mask.length; i++) if (mask[i] === 0) hidden++;
  const hiddenCells = new Uint32Array(hidden);
  if (hidden > 0) {
    let at = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] === 0) hiddenCells[at++] = i;
  }
  return { pages, fields, activePage, hidden: hidden === 0 ? hiddenCells : identity.toOriginal(hiddenCells), before: identity };
}

/** Open positions `0 … n-1`. */
function openPositions(n) {
  const positions = new Uint32Array(n);
  for (let i = 0; i < n; i++) positions[i] = i;
  return positions;
}

/**
 * The carried cells by original position: `originals` ascending, and the
 * open position (in the carried reading) of each.
 */
function sortedByOriginal(originals) {
  const n = originals.length;
  let ascending = true;
  for (let i = 1; i < n && ascending; i++) ascending = originals[i - 1] < originals[i];
  if (ascending) return { originals, positions: openPositions(n) };
  // Each cell's (original, position) packed in one 64-bit key, sorted
  // natively: no comparator call per pair, whatever the count.
  const keys = new BigUint64Array(n);
  for (let i = 0; i < n; i++) keys[i] = (BigInt(originals[i]) << 32n) | BigInt(i);
  keys.sort();
  const sortedOriginals = new Uint32Array(n);
  const positions = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    sortedOriginals[i] = Number(keys[i] >> 32n);
    positions[i] = Number(keys[i] & 0xffffffffn);
  }
  return { originals: sortedOriginals, positions };
}

/**
 * For each cell open now (its original position), the carried reading's
 * open position of the same cell, or -1 when that reading did not open it.
 */
function carriedPositions(cells, opened) {
  const { originals, positions } = cells;
  const out = new Int32Array(opened.length);
  for (let i = 0; i < opened.length; i++) {
    const original = opened[i];
    let lo = 0;
    let hi = originals.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (originals[mid] < original) lo = mid + 1;
      else hi = mid;
    }
    out[i] = lo < originals.length && originals[lo] === original ? positions[lo] : -1;
  }
  return out;
}

/**
 * The open positions (ascending) of the cells `now` opens that `before`
 * did not: their original positions are not among `before`'s kept cells
 * (ascending, `cell-identity.js`; null when every cell was open).
 */
function newlyOpen(before, now, n) {
  if (before.kept === null) return new Uint32Array(0);
  const kept = before.kept;
  const originals = now.toOriginal(openPositions(n));
  const isNew = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const original = originals[i];
    let lo = 0;
    let hi = kept.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (kept[mid] < original) lo = mid + 1;
      else hi = mid;
    }
    if (lo === kept.length || kept[lo] !== original) {
      isNew[i] = 1;
      count++;
    }
  }
  const cells = new Uint32Array(count);
  let at = 0;
  for (let i = 0; i < n; i++) if (isNew[i] === 1) cells[at++] = i;
  return cells;
}

/**
 * Give what was carried to the dataset now on screen.
 *
 * @param {object} state
 * @param {{pages: Array, fields: Array, activePage: number}} carried
 * @returns {{groups: number, dropped: string[], fields: number, hidden: number, rules: Array<{group: object, rule: object}>}}
 *   What was given back, the labels of groups none of whose cells is open
 *   now, and the groups made again from a rule (`takeInNewCells` binds them)
 */
export function restoreCarried(state, carried) {
  const identity = state.cellIdentity;
  const dropped = [];
  const rules = [];
  let groups = 0;
  state.ensureHighlightPage?.();
  const pageIds = [];
  carried.pages.forEach((page, index) => {
    let target = state.getHighlightPages()[index] ?? null;
    if (target === null) target = state.createHighlightPage(page.name);
    else if (target.name !== page.name) state.renameHighlightPage(target.id, page.name);
    pageIds.push(target.id);
    state.switchToPage(target.id);
    for (const group of page.groups) {
      const { positions } = identity.fromOriginal(group.cells);
      if (positions.length === 0) {
        dropped.push(group.label);
        continue;
      }
      const made = state.addHighlightDirect({ cellIndices: positions, label: group.label, type: group.type });
      if (!group.enabled) state.toggleHighlightEnabled(made.id, false);
      if (group.rule !== null) rules.push({ group: made, rule: group.rule });
      groups++;
    }
  });
  if (pageIds.length > 0) state.switchToPage(pageIds[Math.min(carried.activePage, pageIds.length - 1)]);

  let fields = 0;
  // Every field carried the same cells: one lookup serves them all.
  let from = null;
  for (const field of carried.fields) {
    from ??= carriedPositions(
      sortedByOriginal(carried.before.toOriginal(openPositions(carried.before.n))),
      identity.toOriginal(openPositions(state.pointCount))
    );
    if (field.kind === 'category') {
      const { TypedArrayClass, missingValue } = categoricalStorageForCount(field.categories.length, `Field '${field.key}'`);
      const codes = new TypedArrayClass(state.pointCount);
      for (let i = 0; i < codes.length; i++) codes[i] = from[i] < 0 ? missingValue : field.codes[from[i]];
      state.upsertUserDefinedCategoricalField({ key: field.key, categories: field.categories, codes, ...(Object.keys(field.meta).length === 0 ? {} : { meta: field.meta }) });
    } else {
      const values = new Float32Array(state.pointCount);
      for (let i = 0; i < values.length; i++) values[i] = from[i] < 0 ? Number.NaN : field.values[from[i]];
      state.upsertUserDefinedContinuousField({ key: field.key, values, operation: field.operation });
    }
    fields++;
  }
  // Cells hidden by hand stay hidden where they are open again.
  const { positions: hidden } = carried.hidden.length === 0 ? { positions: new Uint32Array(0) } : identity.fromOriginal(carried.hidden);
  if (hidden.length > 0) state.setCellVisibility(hidden, false);
  return { groups, dropped, fields, hidden: hidden.length, rules };
}

/**
 * The cells open now that the carried reading did not open (ascending
 * positions), given what is derived from the file as growing in place
 * gives the cells added (`DataState.takeInNewlyOpenCells`): the fields that
 * needs (the columns user-defined categories were made from, the fields of
 * category and range groups) are loaded first; one that cannot be leaves
 * what depends on it as carried. Nothing is looked at when nothing is
 * derived from the file, and nothing is given when other cells were opened
 * (or the app closed) while the fields were loaded.
 *
 * @param {object} state
 * @param {{before: import('../data/cell-identity.js').CellIdentity}} carried
 * @param {{rules: Array<{group: object, rule: object}>}} restored - `restoreCarried`'s
 * @returns {Promise<{fields: number, groups: number}>}
 */
export async function takeInNewCells(state, carried, restored) {
  // The fields read: obs and genes by name.
  const wanted = { obs: new Set(), var: new Set() };
  for (const field of state.obsData?.fields ?? []) {
    const sourceKey = field?._isUserDefined === true && field.kind === 'category' ? field._sourceField?.sourceKey : undefined;
    if (typeof sourceKey === 'string') wanted.obs.add(sourceKey);
  }
  for (const page of state.getHighlightPages?.() ?? []) {
    for (const group of page.highlightedGroups ?? []) {
      if (group.type === 'category' || group.type === 'range') wanted[group.fieldSource === 'var' ? 'var' : 'obs'].add(group.fieldKey);
    }
  }
  for (const { rule } of restored.rules) wanted[rule.fieldSource === 'var' ? 'var' : 'obs'].add(rule.fieldKey);
  if (wanted.obs.size === 0 && wanted.var.size === 0) return { fields: 0, groups: 0 };
  // The genes of the dataset read again are listed after its first view.
  if (wanted.var.size > 0) await state.whenGenesListed();
  const cells = newlyOpen(carried.before, state.cellIdentity, state.pointCount);
  if (cells.length === 0) return { fields: 0, groups: 0 };
  const loads = [];
  for (const source of ['obs', 'var']) {
    const fields = (source === 'var' ? state.varData : state.obsData)?.fields ?? [];
    fields.forEach((field, index) => {
      if (field == null || field._isDeleted === true || field.loaded === true) return;
      if (!wanted[source].has(field._originalKey || field.key) && !wanted[source].has(field.key)) return;
      const load = source === 'var' ? state.ensureVarFieldLoaded(index, { silent: true }) : state.ensureFieldLoaded(index, { silent: true });
      loads.push(load.catch(() => null));
    });
  }
  const identity = state.cellIdentity;
  await Promise.all(loads);
  // Other cells opened meanwhile, or the app was closed: nothing to give.
  if (state.cellIdentity !== identity || state.viewer?.isDisposed?.() === true) return { fields: 0, groups: 0 };
  return state.takeInNewlyOpenCells(cells, restored.rules);
}

/**
 * One sentence on what was carried, or '' when nothing was.
 *
 * @param {{groups: number, dropped: string[], fields: number, hidden?: number}} outcome
 * @returns {string}
 */
export function describeCarried({ groups, dropped, fields, hidden = 0 }) {
  const parts = [];
  if (groups > 0) parts.push(formatCountOf(groups, 'highlight group'));
  if (fields > 0) parts.push(formatCountOf(fields, 'field you made', 'fields you made'));
  if (hidden > 0) parts.push(formatCountOf(hidden, 'cell hidden by hand', 'cells hidden by hand'));
  const listed = parts.length <= 2 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  let text = parts.length === 0 ? '' : `Kept ${listed} on the cells open now.`;
  if (dropped.length > 0) {
    text += `${text === '' ? '' : ' '}${dropped.length === 1 ? `"${dropped[0]}" has` : `${dropped.length} highlight groups have`} no cell open now and ${dropped.length === 1 ? 'was' : 'were'} not kept.`;
  }
  return text;
}
