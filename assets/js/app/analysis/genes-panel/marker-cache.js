/**
 * Marker Cache
 *
 * Marker runs kept in memory, least recently used first, held to a quarter
 * of the analysis memory budget as it stands at each store
 * (`data/memory-budget.js` `residencyBudgetBytes('analysis')`, which halves
 * after a refused allocation), and emptied on memory pressure. An entry is
 * the full statistics of a run (`MarkerStatistics`), keyed by everything that
 * changes them: the field, the grouping of its cells, the cell scope, the
 * groups tested, the reference, the rest, the small-group policy and minimum,
 * the test, the p-value convention, the correction, the fold change and the
 * genes tested. Filters, ranking and the number shown are not in the key:
 * they are re-applied to a cached entry.
 *
 * Entries belong to one load (`identity`): a reload under the same dataset id
 * never serves markers computed from other values. Nothing outlives the page.
 *
 * @module genes-panel/marker-cache
 */

import { residencyBudgetBytes } from '../../../data/memory-budget.js';

/** Share of the analysis budget cached runs may hold. */
const CACHE_SHARE = 1 / 4;

function requireCacheIdentity(identity) {
  if (
    identity === null ||
    typeof identity !== 'object' ||
    Array.isArray(identity) ||
    Object.keys(identity).join(',') !== 'key' ||
    typeof identity.key !== 'string' ||
    identity.key.trim().length === 0
  ) {
    throw new TypeError('MarkerCache dataset identity is required as exactly { key: non-empty string }');
  }
  return identity;
}

/** Bytes the typed arrays of a value hold. */
export function markerStatisticsBytes(value) {
  let bytes = 0;
  const seen = new Set();
  const visit = node => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (ArrayBuffer.isView(node)) {
      bytes += node.byteLength;
      return;
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) visit(child);
  };
  visit(value);
  return bytes;
}

export class MarkerCache {
  /**
   * @param {Object} options
   * @param {{ key: string }} options.identity - The load entries belong to
   * @param {() => number} [options.budgetBytes] - The analysis budget, read at
   *   every store
   */
  constructor(options = {}) {
    this._identityKey = requireCacheIdentity(options.identity).key;
    this._budgetBytes = options.budgetBytes ?? (() => residencyBudgetBytes('analysis'));
    /** @type {Map<string, {value: Object, bytes: number}>} least recently used first */
    this._entries = new Map();
    this._bytes = 0;
  }

  /** Adopt another load: entries of the previous one are dropped. */
  setIdentity(identity) {
    const { key } = requireCacheIdentity(identity);
    if (key === this._identityKey) return false;
    this._identityKey = key;
    this.clear();
    return true;
  }

  /** @param {Object} params - Everything that changes a run's statistics */
  keyOf(params) {
    return JSON.stringify([this._identityKey, params]);
  }

  get(params) {
    const key = this.keyOf(params);
    const entry = this._entries.get(key);
    if (entry === undefined) return null;
    this._entries.delete(key);
    this._entries.set(key, entry);
    return entry.value;
  }

  set(params, value) {
    const key = this.keyOf(params);
    const bytes = markerStatisticsBytes(value);
    const limit = Math.floor(this._budgetBytes() * CACHE_SHARE);
    const prior = this._entries.get(key);
    if (prior !== undefined) {
      this._entries.delete(key);
      this._bytes -= prior.bytes;
    }
    // A run larger than the whole share is kept alone rather than not at all:
    // it is the one the panel shows.
    while (this._entries.size > 0 && this._bytes + bytes > limit) {
      const [oldestKey, oldest] = this._entries.entries().next().value;
      this._entries.delete(oldestKey);
      this._bytes -= oldest.bytes;
    }
    this._entries.set(key, { value, bytes });
    this._bytes += bytes;
  }

  /** Memory pressure: keep only the most recent entry. */
  trim() {
    while (this._entries.size > 1) {
      const [oldestKey, oldest] = this._entries.entries().next().value;
      this._entries.delete(oldestKey);
      this._bytes -= oldest.bytes;
    }
  }

  clear() {
    this._entries.clear();
    this._bytes = 0;
  }

  getStats() {
    return { entries: this._entries.size, bytes: this._bytes };
  }

  close() {
    this.clear();
  }
}
