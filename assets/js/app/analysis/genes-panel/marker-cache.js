/**
 * Marker Cache
 *
 * An in-memory LRU of marker discovery results, for the categories analysed
 * most recently. Entries are addressed by the data generation they were
 * computed over (see `identity` below), so a reload under the same dataset id
 * never serves markers computed from other expression values. Nothing outlives
 * the page: a dataset id does not identify the expression values a reload
 * brings, so there is no generation key an entry could be trusted under there.
 *
 * @module genes-panel/marker-cache
 */

import { DEFAULTS, CACHE_KEYS } from './constants.js';

function requireCacheIdentity(identity) {
  if (
    identity === null ||
    typeof identity !== 'object' ||
    Array.isArray(identity) ||
    Object.keys(identity).join(',') !== 'key' ||
    typeof identity.key !== 'string' ||
    identity.key.trim().length === 0
  ) {
    throw new TypeError(
      'MarkerCache dataset identity is required as exactly { key: non-empty string }'
    );
  }
  return identity;
}

/**
 * Copy the mutable marker-result ownership envelopes while retaining the large
 * typed statistic buffers, which are read-only after discovery. This keeps the
 * hot cache isolated from UI threshold rebuilds without duplicating the
 * scientific arrays on every cache access.
 *
 * @param {any} data
 * @returns {any}
 */
function cloneMarkerCacheData(data) {
  if (
    data === null ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    ArrayBuffer.isView(data)
  ) {
    return data;
  }
  const prototype = Object.getPrototypeOf(data);
  if (prototype !== Object.prototype && prototype !== null) {
    return data;
  }

  const clone = { ...data };
  if (
    Object.hasOwn(data, 'groups') &&
    data.groups !== null &&
    typeof data.groups === 'object' &&
    !Array.isArray(data.groups)
  ) {
    clone.groups = Object.fromEntries(
      Object.entries(data.groups).map(([groupId, group]) => {
        if (
          group === null ||
          typeof group !== 'object' ||
          Array.isArray(group)
        ) {
          return [groupId, group];
        }
        const groupClone = { ...group };
        if (Array.isArray(group.markers)) {
          groupClone.markers = group.markers.map(marker => (
            marker !== null &&
            typeof marker === 'object' &&
            !Array.isArray(marker)
              ? { ...marker }
              : marker
          ));
        }
        return [groupId, groupClone];
      })
    );
  }

  if (
    Object.hasOwn(data, 'stats') &&
    data.stats !== null &&
    typeof data.stats === 'object' &&
    !Array.isArray(data.stats)
  ) {
    clone.stats = { ...data.stats };
    for (const key of [
      'genes',
      'groupIds',
      'pValuesByGroup',
      'adjustedPValuesByGroup',
      'log2FoldChangeByGroup',
      'meanInGroupByGroup'
    ]) {
      if (Array.isArray(data.stats[key])) {
        clone.stats[key] = [...data.stats[key]];
      }
    }
  }

  return clone;
}

// =============================================================================
// MARKER CACHE CLASS
// =============================================================================

/**
 * Marker Cache
 *
 * Every entry is addressed by the analysis parameters *and* by
 * `groupingDigest`, the digest of the exact per-cell category codes the
 * markers were computed over — see `computeCategoryGroupingDigest` in
 * `data/data-layer.js`. The field key is not an identity: a user-defined
 * categorical field can have its codes rewritten in place under the same key.
 *
 * @example
 * const cache = new MarkerCache({
 *   maxCategories: 3,
 *   identity: { key: JSON.stringify(['load', 'pbmc3k', 1, geneAxis]) }
 * });
 *
 * const params = {
 *   method: 'wilcox',
 *   minCells: 10,
 *   groupingDigest: computeCategoryGroupingDigest(obsCodes)
 * };
 *
 * // Store results
 * await cache.set('cell_type', markers, params);
 *
 * // Retrieve results
 * const cached = await cache.get('cell_type', params);
 */
export class MarkerCache {
  /**
   * Create a MarkerCache
   *
   * @param {Object} [options]
   * @param {number} [options.maxCategories=3] - Max categories kept
   * @param {{ key: string }} options.identity - The data generation entries
   *   belong to. `key` must change whenever the data may have changed.
   */
  constructor(options = {}) {
    /** @type {number} Max categories kept */
    this._maxCategories = options.maxCategories ?? DEFAULTS.cacheMaxCategories;

    const identity = requireCacheIdentity(options.identity);
    /** @type {string} Data generation key */
    this._identityKey = identity.key;
    if (!Number.isSafeInteger(this._maxCategories) || this._maxCategories < 1) {
      throw new RangeError('MarkerCache maxCategories must be a positive integer');
    }

    /** @type {Map<string, any>} Entries, least recently used first */
    this._hotCache = new Map();
  }

  /**
   * Adopt the data generation used in cache keys.
   *
   * Called before every lookup so a dataset switch, or a reload of the same
   * dataset id, can never be answered from another generation's entries.
   *
   * @param {{ key: string }} identity
   * @returns {boolean} true if changed
   */
  setIdentity(identity) {
    const exact = requireCacheIdentity(identity);
    if (exact.key === this._identityKey) {
      return false;
    }
    this._identityKey = exact.key;
    // Entries are keyed by the generation; clearing keeps the LRU bounded and
    // avoids wasting space on another generation.
    this._hotCache.clear();
    return true;
  }

  /**
   * Get cached markers for a category
   *
   * @param {string} category - Observation category (e.g., 'cell_type')
   * @param {Object} params - Cache key parameters; must include
   *   `groupingDigest` (32 lowercase hex characters)
   * @returns {Promise<any|null>} Cached data or null
   */
  async get(category, params) {
    const cacheKey = this._buildCacheKey(category, params);

    const hotEntry = this._hotCache.get(cacheKey);
    if (hotEntry) {
      // Move to end (LRU)
      this._hotCache.delete(cacheKey);
      this._hotCache.set(cacheKey, hotEntry);
      return cloneMarkerCacheData(hotEntry);
    }
    return null;
  }

  /**
   * Store markers in cache
   *
   * @param {string} category - Observation category
   * @param {any} data - Data to cache
   * @param {Object} params - Cache key parameters; must include
   *   `groupingDigest` (32 lowercase hex characters)
   * @returns {Promise<void>}
   */
  async set(category, data, params) {
    if (data === undefined) {
      throw new TypeError('MarkerCache data must be defined');
    }
    const cacheKey = this._buildCacheKey(category, params);
    const ownedData = cloneMarkerCacheData(data);

    this._setHotCache(cacheKey, ownedData);
  }

  /**
   * Check if category is cached
   *
   * @param {string} category - Observation category
   * @param {Object} params - Cache key parameters; must include
   *   `groupingDigest` (32 lowercase hex characters)
   * @returns {Promise<boolean>}
   */
  async has(category, params) {
    return this._hotCache.has(this._buildCacheKey(category, params));
  }

  /**
   * Invalidate cache for a category
   *
   * @param {string} category - Observation category
   * @param {Object} params - Cache key parameters; must include
   *   `groupingDigest` (32 lowercase hex characters)
   * @returns {Promise<void>}
   */
  async invalidate(category, params) {
    this._hotCache.delete(this._buildCacheKey(category, params));
  }

  /**
   * Clear all caches
   * @returns {Promise<void>}
   */
  async clear() {
    this._hotCache.clear();
  }

  /**
   * Get cache statistics
   * @returns {Object}
   */
  getStats() {
    return {
      hotCacheSize: this._hotCache.size,
      maxCategories: this._maxCategories,
      identityKey: this._identityKey
    };
  }

  /**
   * Close the cache (cleanup)
   */
  close() {
    this._hotCache.clear();
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Build a cache key from category and parameters
   * @private
   */
  _buildCacheKey(category, params) {
    if (typeof category !== 'string' || category.length === 0 || category.trim().length === 0) {
      throw new TypeError('MarkerCache category must be non-empty text');
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new TypeError('MarkerCache parameters must be an object');
    }
    // The category key names the field; it does not identify the grouping. A
    // user-defined field's codes can be rewritten in place under an unchanged
    // key, so every entry must carry the digest of the exact per-cell code
    // assignment it was computed over. Missing it is a defect in the caller, not
    // a cache miss, so it fails here rather than silently sharing a key.
    if (
      typeof params.groupingDigest !== 'string' ||
      !/^[0-9a-f]{32}$/.test(params.groupingDigest)
    ) {
      throw new TypeError(
        'MarkerCache parameters must carry a groupingDigest of 32 lowercase hex characters'
      );
    }
    const entries = Object.keys(params).sort().map(key => {
      const value = params[key];
      const scalar =
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value));
      if (!scalar) {
        throw new TypeError(`MarkerCache parameter ${key} must be a finite scalar`);
      }
      return [key, value];
    });
    return JSON.stringify([
      this._identityKey,
      CACHE_KEYS.MARKERS,
      category,
      entries
    ]);
  }

  /**
   * Set entry in hot cache with LRU eviction
   * @private
   */
  _setHotCache(key, data) {
    // Remove if exists (to update position)
    this._hotCache.delete(key);

    // Evict oldest if at capacity
    while (this._hotCache.size >= this._maxCategories) {
      const oldest = this._hotCache.keys().next().value;
      this._hotCache.delete(oldest);
    }

    this._hotCache.set(key, data);
  }
}
