/**
 * LRU Cache - a least-recently-used cache bounded by a byte budget
 *
 * The budget is the one bound: what the held values weigh against a share of
 * the device's memory (`data/memory-budget.js`). There is no entry count and
 * no age: a count cap evicted small results while memory was free, and an age
 * let go of results nothing had made stale (F123). An evicted result is
 * computed again.
 *
 * It keeps hit, miss and eviction statistics.
 *
 * @module shared/lru-cache
 */

import { requireObjectKeys } from '../../../utils/exact-record.js';

/**
 * @typedef {Object} LRUCacheOptions
 * @property {number|(() => number)} maxBytes - Maximum total `sizeOf` of the
 *   held values (positive), or a function read at every `set` (a residency
 *   share of the device, `data/memory-budget.js`, which lowers after a
 *   refused allocation). A value larger than the whole budget is not cached.
 * @property {(value: *) => number} sizeOf - Byte size of one value
 * @property {() => number} [heldBytes] - Bytes the owner holds beside the
 *   entries that count against the same budget (arrays the entries share,
 *   counted once); the entries take what is left
 */

/**
 * @typedef {Object} CacheEntry
 * @property {*} value - The cached value
 * @property {number} bytes - `sizeOf(value)`
 */

/**
 * @typedef {Object} CacheStats
 * @property {number} size - Current number of entries
 * @property {number} bytes - Total `sizeOf` of the held values
 * @property {number} maxBytes - Byte budget
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
 * const cache = new LRUCache({ maxBytes: () => share, sizeOf: value => value.byteLength });
 * cache.set('key1', new Float32Array(8));
 * const value = cache.get('key1');
 */
export class LRUCache {
  /**
   * Create a new LRU cache
   * @param {LRUCacheOptions} options - Cache configuration options
   */
  constructor(options) {
    requireObjectKeys(options, ['maxBytes', 'sizeOf'], ['heldBytes'], 'LRUCache options');
    const { maxBytes, sizeOf, heldBytes = null } = options;
    if (typeof maxBytes !== 'function' && (!Number.isFinite(maxBytes) || maxBytes <= 0)) {
      throw new RangeError('LRUCache maxBytes must be a positive finite number or a function');
    }
    if (typeof sizeOf !== 'function') {
      throw new TypeError('LRUCache maxBytes requires a sizeOf function');
    }
    if (heldBytes !== null && typeof heldBytes !== 'function') {
      throw new TypeError('LRUCache heldBytes is a function');
    }

    /** @private @type {number|(() => number)} Byte budget */
    this._maxBytes = maxBytes;

    /** @private @type {Function} Value byte size */
    this._sizeOf = sizeOf;

    /** @private @type {(() => number)|null} Bytes held beside the entries */
    this._heldBytes = heldBytes;

    /** @type {number} Total byte size of the held values */
    this._bytes = 0;

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
   * Get a value from the cache, and make it the most recently used.
   *
   * @param {string} key - Cache key
   * @returns {*} The cached value, or undefined if not found
   */
  get(key) {
    const entry = this._cache.get(key);

    if (!entry) {
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
   * The byte budget now.
   * @returns {number}
   */
  get maxBytes() {
    const budget = typeof this._maxBytes === 'function' ? this._maxBytes() : this._maxBytes;
    if (!Number.isFinite(budget) || budget < 0) {
      throw new RangeError('LRUCache maxBytes must be a non-negative finite number');
    }
    return budget;
  }

  /**
   * What the entries may hold now: the budget less the bytes held beside them.
   * @returns {number}
   * @private
   */
  _entryBudget() {
    const held = this._heldBytes === null ? 0 : this._heldBytes();
    if (!Number.isFinite(held) || held < 0) {
      throw new RangeError('LRUCache heldBytes must return a non-negative finite number');
    }
    return this.maxBytes - held;
  }

  /**
   * Set a value in the cache, as the most recently used. The least recently
   * used entries go until it fits the budget; a value larger than the whole
   * budget is not kept.
   *
   * @param {string} key - Cache key
   * @param {*} value - Value to cache
   * @returns {LRUCache} Returns this for chaining
   */
  set(key, value) {
    // If key exists, delete it first (will be re-added at end)
    this._remove(key);

    const bytes = this._sizeOf(value);
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new RangeError('LRUCache sizeOf must return a non-negative finite number');
    }
    const budget = this._entryBudget();
    // A value that alone exceeds the budget would evict everything else and
    // still overrun it, so it is simply not kept.
    if (bytes > budget) {
      this.trim();
      return this;
    }

    while (this._cache.size > 0 && this._bytes + bytes > budget) {
      const oldestKey = this._cache.keys().next().value;
      this._evict(oldestKey);
    }

    this._cache.set(key, { value, bytes });
    this._bytes += bytes;

    return this;
  }

  /**
   * Evict the least recently used entries until what is held fits the
   * budget: after the budget lowered or the bytes held beside the entries
   * grew.
   * @returns {number} Entries evicted
   */
  trim() {
    const budget = this._entryBudget();
    let evicted = 0;
    while (this._cache.size > 0 && this._bytes > budget) {
      const oldestKey = this._cache.keys().next().value;
      this._evict(oldestKey);
      evicted++;
    }
    return evicted;
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
   * @param {string} key - Cache key
   * @returns {boolean} True if key exists
   */
  has(key) {
    return this._cache.has(key);
  }

  /**
   * Delete a key from the cache
   *
   * @param {string} key - Cache key to delete
   * @returns {boolean} True if the key was deleted
   */
  delete(key) {
    return this._remove(key);
  }

  /** Clear all entries from the cache. */
  clear() {
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
   * Get cache statistics
   * @returns {CacheStats} Cache statistics object
   */
  getStats() {
    const total = this._hits + this._misses;
    return {
      size: this._cache.size,
      bytes: this._bytes,
      maxBytes: this.maxBytes,
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      hitRate: total > 0 ? Math.round((this._hits / total) * 100) : 0
    };
  }

  /**
   * Evict one entry for room, counting it.
   * @param {string} key - Key to evict
   * @private
   */
  _evict(key) {
    this._remove(key);
    this._evictions++;
  }
}
