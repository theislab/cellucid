/**
 * Marker Cache
 *
 * Tiered caching system for marker discovery results.
 * - Hot cache: In-memory LRU for recent categories
 * - Warm cache: IndexedDB for persistence across sessions
 *
 * Features:
 * - Entries are addressed by the data generation they were computed over
 *   (see `identity` below), so a reload under the same dataset id never
 *   serves markers computed from other expression values
 * - TTL-based expiration for IndexedDB entries
 * - Memory-aware hot cache sizing
 * - Cache key generation from analysis parameters
 *
 * @module genes-panel/marker-cache
 */

import { DEFAULTS, CACHE_KEYS } from './constants.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const DB_NAME = 'cellucid_marker_cache';

function requireCacheIdentity(identity) {
  if (
    identity === null ||
    typeof identity !== 'object' ||
    Array.isArray(identity) ||
    Object.keys(identity).sort().join(',') !== 'key,persistent' ||
    typeof identity.key !== 'string' ||
    identity.key.trim().length === 0 ||
    typeof identity.persistent !== 'boolean'
  ) {
    throw new TypeError(
      'MarkerCache dataset identity is required as exactly { key: non-empty string, persistent: boolean }'
    );
  }
  return identity;
}
const DB_VERSION = 1;
const STORE_NAME = 'markers';

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
      'log2FoldChangeByGroup'
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
 * Provides tiered caching for marker discovery results.
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
 *   maxAgeDays: 7,
 *   cacheVersion: 1,
 *   identity: { key: 'pbmc3k@2026-01-01T00:00:00Z', persistent: true }
 * });
 * await cache.init();
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
   * @param {number} [options.maxCategories=3] - Max categories in hot cache
   * @param {number} [options.maxAgeDays=7] - TTL for IndexedDB entries
   * @param {number} [options.cacheVersion=1] - Version to invalidate old caches
   * @param {{ key: string, persistent: boolean }} options.identity - The
   *   data generation entries belong to. `key` must change whenever the data
   *   may have changed. `persistent` is true only when the key proves the
   *   generation across page loads (a published export timestamp); otherwise
   *   entries live in memory only, because a dataset id alone does not
   *   identify the expression values a reload brings.
   */
  constructor(options = {}) {
    /** @type {number} Max categories in hot cache */
    this._maxCategories = options.maxCategories ?? DEFAULTS.cacheMaxCategories;

    /** @type {number} TTL in days for warm cache */
    this._maxAgeDays = options.maxAgeDays ?? DEFAULTS.cacheMaxAgeDays;

    /** @type {number} Cache version */
    this._cacheVersion = options.cacheVersion ?? DEFAULTS.cacheVersion;

    const identity = requireCacheIdentity(options.identity);
    /** @type {string} Data generation key */
    this._identityKey = identity.key;
    /** @type {boolean} Whether entries may outlive this page */
    this._persistent = identity.persistent;
    if (!Number.isSafeInteger(this._maxCategories) || this._maxCategories < 1) {
      throw new RangeError('MarkerCache maxCategories must be a positive integer');
    }
    if (!Number.isFinite(this._maxAgeDays) || this._maxAgeDays <= 0) {
      throw new RangeError('MarkerCache maxAgeDays must be a positive finite number');
    }
    if (!Number.isSafeInteger(this._cacheVersion) || this._cacheVersion < 1) {
      throw new RangeError('MarkerCache cacheVersion must be a positive integer');
    }

    /** @type {Map<string, { data: any, timestamp: number }>} Hot cache (LRU) */
    this._hotCache = new Map();

    /** @type {IDBDatabase|null} IndexedDB connection */
    this._db = null;

    /** @type {boolean} Whether IndexedDB is available */
    this._indexedDBAvailable = typeof indexedDB !== 'undefined';
  }

  /**
   * Adopt the data generation used in cache keys.
   *
   * Called before every lookup so a dataset switch, or a reload of the same
   * dataset id, can never be answered from another generation's entries.
   *
   * @param {{ key: string, persistent: boolean }} identity
   * @returns {boolean} true if changed
   */
  setIdentity(identity) {
    const exact = requireCacheIdentity(identity);
    if (
      exact.key === this._identityKey &&
      exact.persistent === this._persistent
    ) {
      return false;
    }
    this._identityKey = exact.key;
    this._persistent = exact.persistent;
    // Hot cache entries are keyed by the generation; clearing keeps the
    // in-memory LRU bounded and avoids wasting space on another generation.
    this._hotCache.clear();
    return true;
  }

  /**
   * Initialize the cache (opens IndexedDB connection)
   * @returns {Promise<void>}
   */
  async init() {
    if (this._db !== null) return;
    if (!this._indexedDBAvailable) {
      return;
    }

    this._db = await this._openDatabase();
    await this._cleanupExpired();
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

    // Check hot cache first
    const hotEntry = this._hotCache.get(cacheKey);
    if (hotEntry) {
      // Move to end (LRU)
      this._hotCache.delete(cacheKey);
      this._hotCache.set(cacheKey, hotEntry);
      return cloneMarkerCacheData(hotEntry.data);
    }

    // Check warm cache (IndexedDB)
    if (this._db && this._persistent) {
      const warmEntry = await this._getFromIndexedDB(cacheKey);
      if (warmEntry !== null) {
        // Promote to hot cache
        const ownedEntry = cloneMarkerCacheData(warmEntry);
        this._setHotCache(cacheKey, ownedEntry);
        return cloneMarkerCacheData(ownedEntry);
      }
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

    // Store in hot cache
    this._setHotCache(cacheKey, ownedData);

    // Store in warm cache (IndexedDB)
    if (this._db && this._persistent) {
      await this._setInIndexedDB(cacheKey, ownedData);
    }
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
    const cacheKey = this._buildCacheKey(category, params);

    if (this._hotCache.has(cacheKey)) {
      return true;
    }

    if (this._db && this._persistent) {
      const entry = await this._getFromIndexedDB(cacheKey);
      return entry !== null;
    }

    return false;
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
    const cacheKey = this._buildCacheKey(category, params);

    // Remove from hot cache
    this._hotCache.delete(cacheKey);

    // Remove from warm cache
    if (this._db) {
      await this._deleteFromIndexedDB(cacheKey);
    }
  }

  /**
   * Clear all caches
   * @returns {Promise<void>}
   */
  async clear() {
    this._hotCache.clear();

    if (this._db) {
      await this._clearIndexedDB();
    }
  }

  /**
   * Get cache statistics
   * @returns {Object}
   */
  getStats() {
    return {
      hotCacheSize: this._hotCache.size,
      maxCategories: this._maxCategories,
      indexedDBAvailable: this._indexedDBAvailable,
      identityKey: this._identityKey,
      persistent: this._persistent
    };
  }

  /**
   * Close the cache (cleanup)
   */
  close() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
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
      this._cacheVersion,
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

    // Add new entry
    this._hotCache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  /**
   * Open IndexedDB database
   * @private
   */
  _openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Create object store if doesn't exist
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
    });
  }

  /**
   * Get entry from IndexedDB
   * @private
   */
  async _getFromIndexedDB(key) {
    if (!this._db) return null;

    return new Promise((resolve, reject) => {
      try {
        const tx = this._db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(key);

        request.onerror = () => reject(
          request.error ?? new Error('MarkerCache IndexedDB read failed')
        );
        request.onsuccess = () => {
          const entry = request.result;
          if (!entry) {
            resolve(null);
            return;
          }

          // Check expiration
          const ageMs = Date.now() - entry.timestamp;
          const maxAgeMs = this._maxAgeDays * 24 * 60 * 60 * 1000;

          if (ageMs > maxAgeMs) {
            this._deleteFromIndexedDB(key).then(
              () => resolve(null),
              reject
            );
            return;
          }

          resolve(entry.data);
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Set entry in IndexedDB
   * @private
   */
  async _setInIndexedDB(key, data) {
    if (!this._db) return;

    return new Promise((resolve, reject) => {
      try {
        const tx = this._db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        const entry = {
          key,
          data,
          timestamp: Date.now()
        };

        const request = store.put(entry);
        request.onerror = () => reject(
          request.error ?? new Error('MarkerCache IndexedDB write failed')
        );
        request.onsuccess = () => resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Delete entry from IndexedDB
   * @private
   */
  async _deleteFromIndexedDB(key) {
    if (!this._db) return;

    return new Promise((resolve, reject) => {
      try {
        const tx = this._db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.delete(key);

        request.onerror = () => reject(
          request.error ?? new Error('MarkerCache IndexedDB delete failed')
        );
        request.onsuccess = () => resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Clear all entries from IndexedDB
   * @private
   */
  async _clearIndexedDB() {
    if (!this._db) return;

    return new Promise((resolve, reject) => {
      try {
        const tx = this._db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.clear();

        request.onerror = () => reject(
          request.error ?? new Error('MarkerCache IndexedDB clear failed')
        );
        request.onsuccess = () => resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Clean up expired entries from IndexedDB
   * @private
   */
  async _cleanupExpired() {
    if (!this._db) return;

    const maxAgeMs = this._maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - maxAgeMs;

    return new Promise((resolve, reject) => {
      try {
        const tx = this._db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('timestamp');
        const range = IDBKeyRange.upperBound(cutoff);
        const request = index.openCursor(range);

        request.onerror = () => reject(
          request.error ?? new Error('MarkerCache IndexedDB cleanup scan failed')
        );
        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            const deleteRequest = cursor.delete();
            deleteRequest.onerror = () => reject(
              deleteRequest.error ?? new Error('MarkerCache IndexedDB cleanup delete failed')
            );
            cursor.continue();
          } else {
            resolve();
          }
        };
      } catch (err) {
        reject(err);
      }
    });
  }
}
