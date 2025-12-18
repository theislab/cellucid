/**
 * LRU Cache - Least Recently Used Cache Implementation
 *
 * A generic LRU cache with support for:
 * - Configurable maximum size
 * - Optional time-based expiration (maxAge)
 * - Eviction callbacks
 * - Cache statistics
 *
 * @module shared/lru-cache
 */

/**
 * @typedef {Object} LRUCacheOptions
 * @property {number} [maxSize=100] - Maximum number of entries
 * @property {number} [maxAge=0] - Maximum age in milliseconds (0 = no expiration)
 * @property {Function} [onEvict] - Callback when entry is evicted: (key, value) => void
 */

/**
 * @typedef {Object} CacheEntry
 * @property {*} value - The cached value
 * @property {number} timestamp - When the entry was created/updated
 */

/**
 * @typedef {Object} CacheStats
 * @property {number} size - Current number of entries
 * @property {number} maxSize - Maximum allowed entries
 * @property {number} hits - Number of cache hits
 * @property {number} misses - Number of cache misses
 * @property {number} evictions - Number of evictions
 * @property {number} hitRate - Hit rate as percentage (0-100)
 */

/**
 * LRU (Least Recently Used) Cache implementation
 *
 * Uses a Map to maintain insertion order, which naturally gives us
 * LRU behavior when we delete and re-insert on access.
 *
 * @example
 * // Basic usage
 * const cache = new LRUCache({ maxSize: 100 });
 * cache.set('key1', 'value1');
 * const value = cache.get('key1'); // 'value1'
 *
 * @example
 * // With time-based expiration
 * const cache = new LRUCache({
 *   maxSize: 50,
 *   maxAge: 5 * 60 * 1000, // 5 minutes
 *   onEvict: (key, value) => console.log(`Evicted: ${key}`)
 * });
 */
export class LRUCache {
  /**
   * Create a new LRU cache
   * @param {LRUCacheOptions} [options={}] - Cache configuration options
   */
  constructor(options = {}) {
    const {
      maxSize = 100,
      maxAge = 0,
      onEvict = null
    } = options;

    /** @type {number} Maximum cache size */
    this.maxSize = maxSize;

    /** @type {number} Maximum age in ms (0 = no expiration) */
    this.maxAge = maxAge;

    /** @type {Function|null} Eviction callback */
    this.onEvict = onEvict;

    /** @type {Map<string, CacheEntry>} Internal cache storage */
    this._cache = new Map();

    // Statistics
    /** @private */
    this._hits = 0;
    /** @private */
    this._misses = 0;
    /** @private */
    this._evictions = 0;
  }

  /**
   * Get a value from the cache
   *
   * If the key exists and hasn't expired, returns the value and
   * moves the entry to the end (most recently used).
   *
   * @param {string} key - Cache key
   * @returns {*} The cached value, or undefined if not found/expired
   *
   * @example
   * const value = cache.get('myKey');
   * if (value !== undefined) {
   *   // Use cached value
   * }
   */
  get(key) {
    const entry = this._cache.get(key);

    if (!entry) {
      this._misses++;
      return undefined;
    }

    // Check expiration
    if (this.maxAge > 0 && (Date.now() - entry.timestamp) >= this.maxAge) {
      this._evict(key, entry.value);
      this._misses++;
      return undefined;
    }

    // Move to end (most recently used) by delete and re-insert
    this._cache.delete(key);
    this._cache.set(key, entry);

    this._hits++;
    return entry.value;
  }

  /**
   * Set a value in the cache
   *
   * If the key already exists, updates the value and moves it to
   * most recently used. If at capacity, evicts the least recently
   * used entry first.
   *
   * @param {string} key - Cache key
   * @param {*} value - Value to cache
   * @returns {LRUCache} Returns this for chaining
   *
   * @example
   * cache.set('user:123', userData)
   *      .set('user:456', otherData);
   */
  set(key, value) {
    // If key exists, delete it first (will be re-added at end)
    if (this._cache.has(key)) {
      this._cache.delete(key);
    }

    // Evict oldest if at capacity
    while (this._cache.size >= this.maxSize) {
      const oldestKey = this._cache.keys().next().value;
      const oldestEntry = this._cache.get(oldestKey);
      this._evict(oldestKey, oldestEntry?.value);
    }

    // Add new entry
    this._cache.set(key, {
      value,
      timestamp: Date.now()
    });

    return this;
  }

  /**
   * Check if a key exists in the cache (without affecting LRU order)
   *
   * Note: Does not check expiration or update access order.
   * Use get() if you want to retrieve the value.
   *
   * @param {string} key - Cache key
   * @returns {boolean} True if key exists
   */
  has(key) {
    if (!this._cache.has(key)) {
      return false;
    }

    // Optionally check expiration without updating LRU order
    if (this.maxAge > 0) {
      const entry = this._cache.get(key);
      if ((Date.now() - entry.timestamp) >= this.maxAge) {
        return false;
      }
    }

    return true;
  }

  /**
   * Delete a key from the cache
   *
   * @param {string} key - Cache key to delete
   * @returns {boolean} True if the key was deleted
   */
  delete(key) {
    const entry = this._cache.get(key);
    if (entry) {
      this._cache.delete(key);
      // Note: Not calling onEvict for explicit deletes
      return true;
    }
    return false;
  }

  /**
   * Clear all entries from the cache
   *
   * @param {boolean} [callOnEvict=false] - Whether to call onEvict for each entry
   */
  clear(callOnEvict = false) {
    if (callOnEvict && this.onEvict) {
      for (const [key, entry] of this._cache) {
        this.onEvict(key, entry.value);
      }
    }
    this._cache.clear();
  }

  /**
   * Get the current size of the cache
   * @returns {number} Number of entries
   */
  size() {
    return this._cache.size;
  }

  /**
   * Get all keys in the cache (from least to most recently used)
   * @returns {IterableIterator<string>} Iterator of keys
   */
  keys() {
    return this._cache.keys();
  }

  /**
   * Get all values in the cache (from least to most recently used)
   * @returns {IterableIterator<*>} Iterator of values
   */
  values() {
    const self = this;
    return (function* () {
      for (const entry of self._cache.values()) {
        yield entry.value;
      }
    })();
  }

  /**
   * Get all entries in the cache (from least to most recently used)
   * @returns {IterableIterator<[string, *]>} Iterator of [key, value] pairs
   */
  entries() {
    const self = this;
    return (function* () {
      for (const [key, entry] of self._cache.entries()) {
        yield [key, entry.value];
      }
    })();
  }

  /**
   * Iterate over cache entries
   * @param {Function} callback - Function to call for each entry: (value, key, cache) => void
   */
  forEach(callback) {
    for (const [key, entry] of this._cache) {
      callback(entry.value, key, this);
    }
  }

  /**
   * Remove expired entries from the cache
   *
   * Only useful when maxAge is set. Returns the number of
   * entries removed.
   *
   * @returns {number} Number of expired entries removed
   */
  prune() {
    if (this.maxAge === 0) {
      return 0;
    }

    const now = Date.now();
    let pruned = 0;

    for (const [key, entry] of this._cache) {
      if ((now - entry.timestamp) >= this.maxAge) {
        this._evict(key, entry.value);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Get cache statistics
   * @returns {CacheStats} Cache statistics object
   */
  getStats() {
    const total = this._hits + this._misses;
    return {
      size: this._cache.size,
      maxSize: this.maxSize,
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      hitRate: total > 0 ? Math.round((this._hits / total) * 100) : 0
    };
  }

  /**
   * Reset cache statistics
   */
  resetStats() {
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  /**
   * Get the age of a cached entry in milliseconds
   * @param {string} key - Cache key
   * @returns {number|null} Age in ms, or null if not found
   */
  getAge(key) {
    const entry = this._cache.get(key);
    if (!entry) {
      return null;
    }
    return Date.now() - entry.timestamp;
  }

  /**
   * Peek at a value without affecting LRU order
   * @param {string} key - Cache key
   * @returns {*} The cached value, or undefined if not found
   */
  peek(key) {
    const entry = this._cache.get(key);
    if (!entry) {
      return undefined;
    }

    // Check expiration
    if (this.maxAge > 0 && (Date.now() - entry.timestamp) >= this.maxAge) {
      return undefined;
    }

    return entry.value;
  }

  /**
   * Update maxSize and evict entries if necessary
   * @param {number} newMaxSize - New maximum size
   */
  setMaxSize(newMaxSize) {
    this.maxSize = newMaxSize;

    // Evict if over new limit
    while (this._cache.size > this.maxSize) {
      const oldestKey = this._cache.keys().next().value;
      const oldestEntry = this._cache.get(oldestKey);
      this._evict(oldestKey, oldestEntry?.value);
    }
  }

  /**
   * Internal method to evict an entry
   * @param {string} key - Key to evict
   * @param {*} value - Value being evicted
   * @private
   */
  _evict(key, value) {
    this._cache.delete(key);
    this._evictions++;

    if (this.onEvict) {
      try {
        this.onEvict(key, value);
      } catch (err) {
        console.warn('[LRUCache] onEvict callback error:', err);
      }
    }
  }
}

/**
 * Create a new LRU cache instance
 *
 * @param {LRUCacheOptions} [options={}] - Cache options
 * @returns {LRUCache} New cache instance
 *
 * @example
 * const cache = createLRUCache({ maxSize: 50, maxAge: 60000 });
 */
export function createLRUCache(options = {}) {
  return new LRUCache(options);
}

export default LRUCache;
