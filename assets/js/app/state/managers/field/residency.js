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
 * view, every field carrying filter state in any view (a disabled filter can
 * be re-enabled without a reload), and every field mid-load. The remaining,
 * inactive fields are released least-recently-used first while their bytes
 * exceed the inactive-field budget (`data/memory-budget.js`, a share of the
 * device memory the browser reports); selecting one again reloads it. The
 * budget only decides what is kept warm: a field of any size is loaded and
 * shown.
 *
 * Release runs when the active field changes, never while fields are being
 * staged, so a session restore or analysis that loads several fields before
 * using them cannot lose one in between.
 *
 * @module state/managers/field/residency
 */

import { residencyBudgetBytes } from '../../../../data/memory-budget.js';

const FIELD_ARRAY_KEYS = Object.freeze(['values', 'codes', 'outlierQuantiles']);

/** The residency key a field is cached under (see field/loading.js). */
function fieldCacheKey(field, fieldIndex) {
  return field._originalKey || field.key || String(fieldIndex);
}

function viewsOf(state) {
  const views = [state];
  if (state.viewContexts instanceof Map) {
    for (const ctx of state.viewContexts.values()) {
      if (ctx !== null && typeof ctx === 'object') views.push(ctx);
    }
  }
  return views;
}

function hasFilterState(field) {
  if (field.kind === 'category' && field._categoryVisible) {
    for (const visible of Object.values(field._categoryVisible)) {
      if (visible === false) return true;
    }
    return false;
  }
  const filter = field._continuousFilter;
  const stats = field._continuousStats;
  return Boolean(
    filter && stats && (filter.min !== stats.min || filter.max !== stats.max)
  );
}

/**
 * Cache keys whose arrays some view needs right now, per source.
 *
 * @param {object} state
 * @returns {{obs: Set<string>, var: Set<string>}}
 */
function keysInUse(state) {
  const inUse = { obs: new Set(), var: new Set() };
  for (const view of viewsOf(state)) {
    for (const source of ['obs', 'var']) {
      const fields = (source === 'obs' ? view.obsData : view.varData)?.fields;
      if (!Array.isArray(fields)) continue;
      const activeIndex = view.activeFieldSource === source
        ? (source === 'obs' ? view.activeFieldIndex : view.activeVarFieldIndex)
        : -1;
      for (let index = 0; index < fields.length; index++) {
        const field = fields[index];
        if (field === null || typeof field !== 'object') continue;
        if (
          index === activeIndex
          || field._loadingPromise
          || hasFilterState(field)
        ) {
          inUse[source].add(fieldCacheKey(field, index));
        }
        // A user-defined alias shares its source's arrays.
        const sourceKey = field._sourceField?.sourceKey;
        if (field.loaded === true && typeof sourceKey === 'string') {
          inUse[source].add(sourceKey);
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
  return buffers;
}

function releaseField(state, source, cacheKey) {
  for (const view of viewsOf(state)) {
    const fields = (source === 'obs' ? view.obsData : view.varData)?.fields;
    if (!Array.isArray(fields)) continue;
    for (let index = 0; index < fields.length; index++) {
      const field = fields[index];
      if (
        field === null
        || typeof field !== 'object'
        || fieldCacheKey(field, index) !== cacheKey
      ) {
        continue;
      }
      for (const key of FIELD_ARRAY_KEYS) delete field[key];
      field.loaded = false;
    }
  }
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
  const caches = [
    ['obs', state._fieldDataCache],
    ['var', state._varFieldDataCache],
  ].filter(([, cache]) => cache && typeof cache.entries === 'function');
  if (caches.length === 0) return 0;

  const inUse = keysInUse(state);
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

  let released = 0;
  for (const candidate of candidates) {
    if (inactiveBytes <= budgetBytes) break;
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
