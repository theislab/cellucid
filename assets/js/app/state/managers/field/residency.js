/**
 * @fileoverview Byte-bounded residency of loaded field data.
 *
 * A loaded field keeps its per-cell arrays (continuous values, category codes,
 * outlier quantiles) on its field object, and every view context shares them.
 * Nothing used to release them: the obs and gene caches were bounded by entry
 * count, and evicting an entry dropped only the cache's own reference while
 * the field objects kept the arrays alive. Browsing genes therefore grew the
 * heap by four bytes per cell per gene until the tab ran out of memory.
 *
 * Arrays a view still needs are always resident: the active field of every
 * view, every field carrying filter state in any view (every filter applies
 * whatever is coloured, and a disabled filter can be re-enabled without a
 * reload), and every field mid-load. An inactive gene whose column has a
 * sparse form (`data/column-forms.js`: nearly every gene) keeps that form
 * alone, its entries instead of four bytes a cell (40 MB at 10M cells), and
 * selecting it again makes its column from the form without a read
 * (`compactedColumn`). The remaining inactive fields are released
 * least-recently-used first while their bytes exceed the inactive-field
 * budget (`data/memory-budget.js`, a share of the device memory the browser
 * reports); selecting one again reloads it. The budget only decides what is
 * kept warm: a field of any size is loaded and shown.
 *
 * Release runs when the active field changes, never while fields are being
 * staged, so a session restore or analysis that loads several fields before
 * using them cannot lose one in between.
 *
 * @module state/managers/field/residency
 */

import { residencyBudgetBytes } from '../../../../data/memory-budget.js';
import { columnFormOf, noteColumnForm } from '../../../../data/column-forms.js';
import { allocateTypedArray } from '../../../../data/sparse-column-index.js';
import { hasOutlierFilter, hasRangeFilter } from '../filter-manager.js';
import { hiddenCategoryCount } from '../../../utils/category-state.js';

const FIELD_ARRAY_KEYS = Object.freeze(['values', 'codes', 'outlierQuantiles']);

/** The residency key a field is cached under (see field/loading.js). */
function fieldCacheKey(field, fieldIndex) {
  return field._originalKey || field.key || String(fieldIndex);
}

function viewsOf(state) {
  const views = [state];
  if (state.viewContexts instanceof Map) {
    for (const ctx of state.viewContexts.values()) {
      if (ctx === null || typeof ctx !== 'object') continue;
      // The active view's context shares the state's own inventories
      // (view-context-core.js `_syncActiveContext`); walking them twice would
      // only repeat the state's answer.
      if (ctx.obsData === state.obsData && ctx.varData === state.varData) continue;
      views.push(ctx);
    }
  }
  return views;
}

/**
 * Whether a field carries a filter in some state (enabled or not): its arrays
 * stay, since every filter applies whatever is coloured.
 */
function hasFilterState(field) {
  if (field.kind === 'category') {
    if (hasOutlierFilter(field) || field._missingVisible === false) return true;
    return field._categoryVisible !== undefined && hiddenCategoryCount(field._categoryVisible) > 0;
  }
  return hasRangeFilter(field);
}

/**
 * Each inventory's fields by cache key, made once per fields array and kept
 * while its length is the same: an inventory only ever grows by appending
 * (`push`) or is replaced whole, and a field's cache key never changes (a
 * rename keeps the first key as `_originalKey`). The residency questions are
 * asked on every memory report (each worker report, each working-set change),
 * so they look up the few cached keys here instead of walking every gene.
 *
 * @type {WeakMap<object[], {length: number, positions: Map<string, number|number[]>, aliases: number[]}>}
 */
const inventoryIndexes = new WeakMap();

/** Fields walked to index an inventory, since the module loaded (tests count the work). */
let indexedFields = 0;

/** @returns {number} Fields walked to index inventories so far (`inventoryIndex`). */
export function indexedFieldCount() {
  return indexedFields;
}

function inventoryIndex(fields) {
  const known = inventoryIndexes.get(fields);
  if (known !== undefined && known.length === fields.length) return known;
  const positions = new Map();
  const aliases = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field === null || typeof field !== 'object') continue;
    const key = fieldCacheKey(field, index);
    const at = positions.get(key);
    if (at === undefined) positions.set(key, index);
    else if (typeof at === 'number') positions.set(key, [at, index]);
    else at.push(index);
    // A user-defined field may share its source's arrays (`_sourceField`).
    if (Object.hasOwn(field, '_sourceField')) aliases.push(index);
  }
  indexedFields += fields.length;
  const made = { length: fields.length, positions, aliases };
  inventoryIndexes.set(fields, made);
  return made;
}

function keyedAt(fields, position, key) {
  const field = fields[position];
  return field !== null && typeof field === 'object' && fieldCacheKey(field, position) === key;
}

/**
 * Where the fields cached under `key` sit in `fields`, checked against the
 * fields themselves: an index that no longer matches is made again.
 *
 * @param {object[]} fields
 * @param {string} key
 * @returns {number[]}
 */
function positionsOf(fields, key) {
  let at = inventoryIndex(fields).positions.get(key);
  const list = at => (at === undefined ? [] : typeof at === 'number' ? [at] : at);
  if (list(at).every(position => keyedAt(fields, position, key))) return list(at);
  inventoryIndexes.delete(fields);
  at = inventoryIndex(fields).positions.get(key);
  return list(at);
}

/**
 * Cache keys whose arrays some view needs right now, per source, among the
 * cached ones (no other key holds bytes): each view's active field, cached
 * fields mid-load or carrying filter state, and the sources of loaded
 * user-defined aliases. The work is the views times the cached keys and
 * aliases, not the inventories' length.
 *
 * @param {object} state
 * @param {Array<[string, Map]>} caches - `[source, cache]` pairs
 * @returns {{obs: Set<string>, var: Set<string>}}
 */
function keysInUse(state, caches) {
  const inUse = { obs: new Set(), var: new Set() };
  for (const view of viewsOf(state)) {
    for (const [source, cache] of caches) {
      const fields = (source === 'obs' ? view.obsData : view.varData)?.fields;
      if (!Array.isArray(fields)) continue;
      const used = inUse[source];
      const activeIndex = view.activeFieldSource === source
        ? (source === 'obs' ? view.activeFieldIndex : view.activeVarFieldIndex)
        : -1;
      const active = Number.isInteger(activeIndex) && activeIndex >= 0 ? fields[activeIndex] : undefined;
      if (active !== null && typeof active === 'object') used.add(fieldCacheKey(active, activeIndex));
      for (const position of inventoryIndex(fields).aliases) {
        const field = fields[position];
        if (field === null || typeof field !== 'object') continue;
        // A user-defined alias shares its source's arrays.
        const sourceKey = field._sourceField?.sourceKey;
        if (field.loaded === true && typeof sourceKey === 'string') used.add(sourceKey);
      }
      for (const key of cache.keys()) {
        if (used.has(key)) continue;
        for (const position of positionsOf(fields, key)) {
          const field = fields[position];
          if (field._loadingPromise || hasFilterState(field)) {
            used.add(key);
            break;
          }
        }
      }
    }
  }
  return inUse;
}

function entryBuffers(entry) {
  const buffers = [];
  for (const key of FIELD_ARRAY_KEYS) {
    const array = entry?.[key];
    if (ArrayBuffer.isView(array)) buffers.push(array.buffer);
  }
  // A gene kept as its sparse form.
  if (entry?.form) buffers.push(entry.form.indices.buffer, entry.form.values.buffer);
  return buffers;
}

/**
 * The column of a gene kept as its sparse form (`releaseInactiveFieldsOverBudget`),
 * made again from it, its form noted: what reading it again would give, bit
 * for bit, without a read. Null when the entry holds no form.
 *
 * @param {object|undefined} entry - The gene's cache entry
 * @returns {Float32Array|Float64Array|null}
 */
export function compactedColumn(entry) {
  const form = entry?.form ?? null;
  if (form === null) return null;
  const column = allocateTypedArray(form.values.constructor, form.length, 'Gene column');
  column.fill(Number.NaN, form.readRows);
  const { indices, values } = form;
  for (let k = 0; k < indices.length; k++) column[indices[k]] = values[k];
  return noteColumnForm(column, form);
}

function releaseField(state, source, cacheKey) {
  for (const view of viewsOf(state)) {
    const fields = (source === 'obs' ? view.obsData : view.varData)?.fields;
    if (!Array.isArray(fields)) continue;
    for (const position of positionsOf(fields, cacheKey)) {
      const field = fields[position];
      for (const key of FIELD_ARRAY_KEYS) delete field[key];
      field.loaded = false;
    }
  }
}

/**
 * The inactive fields that may be released, least recently used first, and
 * the bytes they hold (each buffer once, none a field in use shares).
 *
 * @param {object} state
 * @returns {{candidates: Array<{source: string, cache: Map, key: string, buffers: ArrayBuffer[]}>, inactiveBytes: number}}
 */
function inactiveFields(state) {
  const caches = [
    ['obs', state._fieldDataCache],
    ['var', state._varFieldDataCache],
  ].filter(([, cache]) => cache && typeof cache.entries === 'function');
  if (caches.length === 0) return { candidates: [], inactiveBytes: 0 };

  const inUse = keysInUse(state, caches);
  const pinned = new Set();
  for (const [source, cache] of caches) {
    for (const [key, entry] of cache.entries()) {
      if (inUse[source].has(key)) {
        for (const buffer of entryBuffers(entry)) pinned.add(buffer);
      }
    }
  }

  // Candidates in recency order across both caches (`_fieldUseOrder` is the
  // shared clock; entries never touched sort first).
  const order = state._fieldUseOrder instanceof Map ? state._fieldUseOrder : null;
  const candidates = [];
  for (const [source, cache] of caches) {
    for (const [key, entry] of cache.entries()) {
      if (inUse[source].has(key)) continue;
      const buffers = entryBuffers(entry).filter(buffer => !pinned.has(buffer));
      if (buffers.length === 0) continue;
      candidates.push({
        source,
        cache,
        key,
        buffers,
        use: order?.get(`${source}\u0000${key}`) ?? 0,
      });
    }
  }
  candidates.sort((a, b) => a.use - b.use);

  const counted = new Set();
  let inactiveBytes = 0;
  for (const candidate of candidates) {
    for (const buffer of candidate.buffers) {
      if (counted.has(buffer)) continue;
      counted.add(buffer);
      inactiveBytes += buffer.byteLength;
    }
  }
  return { candidates, inactiveBytes };
}

/**
 * What the inactive fields hold, in bytes (the `inactiveFields` share the
 * memory model counts, `data/memory-budget.js`).
 *
 * @param {object} state
 * @returns {number}
 */
export function inactiveFieldBytes(state) {
  return inactiveFields(state).inactiveBytes;
}

/**
 * Release inactive field data, least recently used first, while it exceeds
 * `budgetBytes`.
 *
 * @param {object} state - DataState (or an equivalent owner of the two caches).
 * @param {number} [budgetBytes]
 * @returns {number} Bytes released.
 */
export function releaseInactiveFieldsOverBudget(
  state,
  budgetBytes = residencyBudgetBytes('inactiveFields')
) {
  const { candidates, inactiveBytes: held } = inactiveFields(state);
  const order = state._fieldUseOrder instanceof Map ? state._fieldUseOrder : null;
  // Every candidate buffer, so one shared by two fields is subtracted once.
  const counted = new Set(candidates.flatMap(candidate => candidate.buffers));
  let inactiveBytes = held;

  let released = 0;
  // An inactive gene with a sparse form keeps the form alone: its column's
  // bytes are released, whatever the budget, and it is made again from the
  // form when shown (`compactedColumn`).
  for (const candidate of candidates) {
    const entry = candidate.source === 'var' ? candidate.cache.get(candidate.key) : undefined;
    const form = columnFormOf(entry?.values);
    if (form === null || entry.codes !== undefined || entry.outlierQuantiles !== undefined) continue;
    const column = entry.values.buffer;
    if (!candidate.buffers.includes(column)) continue;
    candidate.cache.set(candidate.key, { form });
    releaseField(state, candidate.source, candidate.key);
    candidate.buffers = candidate.buffers.filter(buffer => buffer !== column);
    if (counted.delete(column)) {
      inactiveBytes -= column.byteLength;
      released += column.byteLength;
    }
  }
  for (const candidate of candidates) {
    if (inactiveBytes <= budgetBytes) break;
    // Kept as its form just now: its form is counted from the next release on.
    if (candidate.buffers.length === 0) continue;
    candidate.cache.delete(candidate.key);
    order?.delete(`${candidate.source}\u0000${candidate.key}`);
    releaseField(state, candidate.source, candidate.key);
    for (const buffer of candidate.buffers) {
      if (!counted.delete(buffer)) continue;
      inactiveBytes -= buffer.byteLength;
      released += buffer.byteLength;
    }
  }
  return released;
}

/**
 * Record a use of one field's data on the shared recency clock.
 *
 * @param {object} state
 * @param {'obs'|'var'} source
 * @param {string} cacheKey
 */
export function touchFieldResidency(state, source, cacheKey) {
  if (!(state._fieldUseOrder instanceof Map)) {
    state._fieldUseOrder = new Map();
    state._fieldUseClock = 0;
  }
  state._fieldUseClock += 1;
  state._fieldUseOrder.set(`${source}\u0000${cacheKey}`, state._fieldUseClock);
}
