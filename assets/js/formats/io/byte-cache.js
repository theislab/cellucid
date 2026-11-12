/**
 * A least-recently-used cache with a byte budget: the one cache of decoded
 * pieces of an open store. A Zarr store keeps its decoded chunks and shard
 * indexes in one each (`formats/zarr/open.js`), an HDF5 file its decoded
 * chunks and parsed global heap collections (`formats/hdf5/context.js`), so
 * reading a dense matrix column by column decodes each chunk once, and a
 * column of strings that shares heap collections fetches each collection
 * once.
 *
 * The budget bounds what is kept, never what can be read: an entry larger
 * than the whole budget is simply not kept. A cache given a shared budget
 * (`decoded-budget.js`) makes room in the other caches of that budget too.
 *
 * @module formats/io/byte-cache
 */

import { DecodedBudget } from './decoded-budget.js';

export class ByteCache {
  /**
   * @param {number|DecodedBudget} budget - Bytes kept at most, or a budget
   *   shared with the other caches of decoded pieces of the store
   */
  constructor(budget) {
    this._budget = DecodedBudget.of(budget);
    this.bytes = 0;
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
    this._budget.attach(this);
  }

  /** The bytes this cache and those sharing its budget keep at most. */
  get budget() {
    return this._budget.budgetBytes;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Keep `value` (weighing `bytes`) unless it alone exceeds the budget; whether it was kept. */
  set(key, value, bytes) {
    if (bytes > this.budget) return false;
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.bytes -= previous.bytes;
      this.entries.delete(key);
    }
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    this._budget.settle(this);
    return true;
  }

  /**
   * Let the least recently used entry go, never the most recent (the one
   * just kept); false when there is none other.
   */
  evictOldest() {
    if (this.entries.size < 2) return false;
    const oldest = this.entries.keys().next().value;
    this.bytes -= this.entries.get(oldest).bytes;
    this.entries.delete(oldest);
    return true;
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }

  stats() {
    return { bytes: this.bytes, entries: this.entries.size, hits: this.hits, misses: this.misses, budget: this.budget };
  }
}
