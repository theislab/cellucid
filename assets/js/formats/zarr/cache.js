/**
 * A least-recently-used cache with a byte budget: decoded chunks (so reading
 * a dense matrix column by column decodes each chunk once) and shard indexes.
 *
 * The budget bounds what is kept, never what can be read: an entry larger
 * than the whole budget is simply not kept.
 *
 * @module formats/zarr/cache
 */

export class ByteLru {
  /** @param {number} budget - Bytes kept at most */
  constructor(budget) {
    if (!Number.isSafeInteger(budget) || budget < 0) throw new TypeError('A cache budget must be a whole number of bytes.');
    this.budget = budget;
    this.bytes = 0;
    this.entries = new Map();
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
    for (const [oldest, entry] of this.entries) {
      if (this.bytes <= this.budget) break;
      this.entries.delete(oldest);
      this.bytes -= entry.bytes;
    }
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}
