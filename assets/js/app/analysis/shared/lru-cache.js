/**
 * LRU Cache - Least Recently Used Cache Implementation
 *
 * A generic LRU cache with support for:
 * - Configurable maximum size, in entries and optionally in bytes
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
 * @property {number} [maxBytes=0] - Maximum total `sizeOf` of the held values
 *   (0 = unbounded). A value larger than the whole budget is not cached.
 * @property {(value: *) => number} [sizeOf] - Byte size of one value; required
 *   with `maxBytes`
 * @property {Function} [onEvict] - Callback when entry is evicted: (key, value) => void
 */

/**
 * @typedef {Object} CacheEntry
 * @property {*} value - The cached value
 * @property {number} timestamp - When the entry was created/updated
 * @property {number} bytes - `sizeOf(value)` when the cache has a byte budget
 */

/**
 * @typedef {Object} CacheStats
 * @property {number} size - Current number of entries
 * @property {number} maxSize - Maximum allowed entries
 * @property {number} bytes - Total `sizeOf` of the held values
 * @property {number} maxBytes - Byte budget (0 = unbounded)
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
      maxBytes = 0,
      sizeOf = null,
      onEvict = null
    } = options;
    if (!Number.isFinite(maxBytes) || maxBytes < 0) {
      throw new RangeError('LRUCache maxBytes must be a non-negative finite number');
    }
    if (maxBytes > 0 && typeof sizeOf !== 'function') {
      throw new TypeError('LRUCache maxBytes requires a sizeOf function');
    }

    /** @type {number} Maximum cache size */
    this.maxSize = maxSize;

    /** @type {number} Maximum age in ms (0 = no expiration) */
    this.maxAge = maxAge;

    /** @type {number} Byte budget (0 = unbounded) */
    this.maxBytes = maxBytes;

    /** @type {Function|null} Value byte size, used with maxBytes */
    this._sizeOf = maxBytes > 0 ? sizeOf : null;

    /** @type {number} Total byte size of the held values */
    this._bytes = 0;

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
    this._remove(key);

    const bytes = this._sizeOf === null ? 0 : this._sizeOf(value);
    if (this._sizeOf !== null) {
      if (!Number.isFinite(bytes) || bytes < 0) {
        throw new RangeError('LRUCache sizeOf must return a non-negative finite number');
      }
      // A value that alone exceeds the budget would evict everything else and
      // still overrun it, so it is simply not kept.
      if (bytes > this.maxBytes) return this;
    }

    // Evict oldest while at capacity, in entries or in bytes
    while (
      this._cache.size > 0 &&
      (
        this._cache.size >= this.maxSize ||
        (this._sizeOf !== null && this._bytes + bytes > this.maxBytes)
      )
    ) {
      const oldestKey = this._cache.keys().next().value;
      const oldestEntry = this._cache.get(oldestKey);
      this._evict(oldestKey, oldestEntry?.value);
    }

    // Add new entry
    this._cache.set(key, {
      value,
      timestamp: Date.now(),
      bytes
    });
    this._bytes += bytes;

    return this;
  }

  /**
   * Drop one entry and its byte share without counting an eviction.
   * @param {string} key
   * @returns {boolean} True if the key was present
   * @private
   */
  _remove(key) {
    const entry = this._cache.get(key);
    if (!entry) return false;
    this._cache.delete(key);
    this._bytes -= entry.bytes;
    return true;
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
    // Note: Not calling onEvict for explicit deletes
    return this._remove(key);
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
    this._bytes = 0;
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
      bytes: this._bytes,
      maxBytes: this.maxBytes,
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
    this._remove(key);
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
