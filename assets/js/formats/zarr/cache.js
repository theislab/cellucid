/**
 * A least-recently-used cache with a byte budget: decoded chunks (so reading
 * a dense matrix column by column decodes each chunk once) and shard indexes.
 *
 * The budget bounds what is kept, never what can be read: an entry larger
 * than the whole budget is simply not kept.
 *
 * @module formats/zarr/cache
 */

import { DecodedBudget } from '../io/decoded-budget.js';

export class ByteLru {
  /**
   * @param {number|DecodedBudget} budget - Bytes kept at most, or a budget
   *   shared with the other caches of decoded chunks of the store
   *   (`formats/io/decoded-budget.js`)
   */
  constructor(budget) {
    this._budget = DecodedBudget.of(budget);
    this.bytes = 0;
    this.entries = new Map();
    this._budget.attach(this);
  }

  /** The bytes this cache and those sharing its budget keep at most. */
  get budget() {
    return this._budget.budgetBytes;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value, bytes) {
    if (bytes > this.budget) return;
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.entries.delete(key);
      this.bytes -= previous.bytes;
    }
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    this._budget.settle(this);
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
}
