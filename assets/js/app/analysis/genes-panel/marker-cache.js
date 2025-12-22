/**
 * Marker Cache
 *
 * Tiered caching system for marker discovery results.
 * - Hot cache: In-memory LRU for recent categories
 * - Warm cache: IndexedDB for persistence across sessions
 *
 * Features:
 * - Automatic cache invalidation based on data version
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
const DB_VERSION = 1;
const STORE_NAME = 'markers';

// =============================================================================
// MARKER CACHE CLASS
// =============================================================================

/**
 * Marker Cache
 *
 * Provides tiered caching for marker discovery results.
 *
 * @example
 * const cache = new MarkerCache({ maxCategories: 3, maxAgeDays: 7 });
 * await cache.init();
 *
 * // Store results
 * await cache.set('cell_type', markers);
 *
 * // Retrieve results
 * const cached = await cache.get('cell_type');
 */
export class MarkerCache {
  /**
   * Create a MarkerCache
   *
   * @param {Object} [options]
   * @param {number} [options.maxCategories=3] - Max categories in hot cache
   * @param {number} [options.maxAgeDays=7] - TTL for IndexedDB entries
   * @param {number} [options.cacheVersion=1] - Version to invalidate old caches
   * @param {string} [options.datasetId] - Dataset identifier for cache keys
   */
  constructor(options = {}) {
    /** @type {number} Max categories in hot cache */
    this._maxCategories = options.maxCategories ?? DEFAULTS.cacheMaxCategories;

    /** @type {number} TTL in days for warm cache */
    this._maxAgeDays = options.maxAgeDays ?? DEFAULTS.cacheMaxAgeDays;

    /** @type {number} Cache version */
    this._cacheVersion = options.cacheVersion ?? DEFAULTS.cacheVersion;

    /** @type {string} Dataset identifier */
    this._datasetId = options.datasetId || 'default';

    /** @type {Map<string, { data: any, timestamp: number }>} Hot cache (LRU) */
    this._hotCache = new Map();

    /** @type {IDBDatabase|null} IndexedDB connection */
    this._db = null;

    /** @type {boolean} Whether IndexedDB is available */
    this._indexedDBAvailable = typeof indexedDB !== 'undefined';
  }

  /**
   * Initialize the cache (opens IndexedDB connection)
   * @returns {Promise<void>}
   */
  async init() {
    if (!this._indexedDBAvailable) {
      console.debug('[MarkerCache] IndexedDB not available, using memory-only cache');
      return;
    }

    try {
      this._db = await this._openDatabase();
      // Clean up expired entries on init
      await this._cleanupExpired();
    } catch (err) {
      console.warn('[MarkerCache] Failed to open IndexedDB, falling back to memory-only:', err.message);
      this._indexedDBAvailable = false;
    }
  }

  /**
   * Get cached markers for a category
   *
   * @param {string} category - Observation category (e.g., 'cell_type')
   * @param {Object} [params] - Additional parameters for cache key
   * @returns {Promise<any|null>} Cached data or null
   */
  async get(category, params = {}) {
    const cacheKey = this._buildCacheKey(category, params);

    // Check hot cache first
    const hotEntry = this._hotCache.get(cacheKey);
    if (hotEntry) {
      // Move to end (LRU)
      this._hotCache.delete(cacheKey);
      this._hotCache.set(cacheKey, hotEntry);
      return hotEntry.data;
    }

    // Check warm cache (IndexedDB)
    if (this._db) {
      const warmEntry = await this._getFromIndexedDB(cacheKey);
      if (warmEntry) {
        // Promote to hot cache
        this._setHotCache(cacheKey, warmEntry);
        return warmEntry;
      }
    }

    return null;
  }

  /**
   * Store markers in cache
   *
   * @param {string} category - Observation category
   * @param {any} data - Data to cache
   * @param {Object} [params] - Additional parameters for cache key
   * @returns {Promise<void>}
   */
  async set(category, data, params = {}) {
    const cacheKey = this._buildCacheKey(category, params);

    // Store in hot cache
    this._setHotCache(cacheKey, data);

    // Store in warm cache (IndexedDB)
    if (this._db) {
      await this._setInIndexedDB(cacheKey, data);
    }
  }

  /**
   * Check if category is cached
   *
   * @param {string} category - Observation category
   * @param {Object} [params] - Additional parameters for cache key
   * @returns {Promise<boolean>}
   */
  async has(category, params = {}) {
    const cacheKey = this._buildCacheKey(category, params);

    if (this._hotCache.has(cacheKey)) {
      return true;
    }

    if (this._db) {
      const entry = await this._getFromIndexedDB(cacheKey);
      return entry !== null;
    }

    return false;
  }

  /**
   * Invalidate cache for a category
   *
   * @param {string} category - Observation category
   * @param {Object} [params] - Additional parameters for cache key
   * @returns {Promise<void>}
   */
  async invalidate(category, params = {}) {
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
      datasetId: this._datasetId
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
  _buildCacheKey(category, params = {}) {
    const parts = [
      this._datasetId,
      'v' + this._cacheVersion,
      CACHE_KEYS.MARKERS,
      category
    ];

    // Add sorted params to key
    const paramKeys = Object.keys(params).sort();
    for (const key of paramKeys) {
      parts.push(`${key}=${params[key]}`);
    }

    return parts.join(':');
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

    return new Promise((resolve) => {
      try {
        const tx = this._db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(key);

        request.onerror = () => resolve(null);
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
            // Expired, delete and return null
            this._deleteFromIndexedDB(key);
            resolve(null);
            return;
          }

          resolve(entry.data);
        };
      } catch (err) {
        resolve(null);
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
        request.onerror = () => reject(request.error);
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

    return new Promise((resolve) => {
      try {
        const tx = this._db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.delete(key);

        request.onerror = () => resolve();
        request.onsuccess = () => resolve();
      } catch (err) {
        resolve();
      }
    });
  }

  /**
   * Clear all entries from IndexedDB
   * @private
   */
  async _clearIndexedDB() {
    if (!this._db) return;

    return new Promise((resolve) => {
      try {
        const tx = this._db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.clear();

        request.onerror = () => resolve();
        request.onsuccess = () => resolve();
      } catch (err) {
        resolve();
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

    return new Promise((resolve) => {
      try {
        const tx = this._db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('timestamp');
        const range = IDBKeyRange.upperBound(cutoff);
        const request = index.openCursor(range);

        request.onerror = () => resolve();
        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
      } catch (err) {
        resolve();
      }
    });
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a MarkerCache instance
 *
 * @param {Object} [options] - Same options as MarkerCache constructor
 * @returns {MarkerCache}
 */
export function createMarkerCache(options) {
  return new MarkerCache(options);
}

export default MarkerCache;
