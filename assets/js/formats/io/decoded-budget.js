/**
 * One byte budget shared by the caches that keep decoded chunks of one open
 * store: the store's own (`formats/zarr/cache.js` `ByteLru`,
 * `formats/hdf5/lru.js` `ByteCache`) and the reader's chunks kept across a
 * progressive opening's growth (`data/anndata/decoded-chunks.js`). Each
 * cache holds what it keeps and charges it here; together they never hold
 * more than `budgetBytes` (the `decodedBlocks` share of the device,
 * `data/memory-budget.js`), however the reads divide it.
 *
 * A cache that keeps a chunk makes room by letting go of its own least
 * recently used chunks first, then the other caches' (`settle`): what is
 * read now displaces what was read longest ago where it lives, and a cache
 * whose chunks are all in use takes room from the others.
 *
 * A holder is `{bytes, evictOldest()}`: `bytes` what it keeps now,
 * `evictOldest()` lets its least recently used chunk go and says whether it
 * had one to let go.
 *
 * @module formats/io/decoded-budget
 */

export class DecodedBudget {
  /** @param {number} budgetBytes - What every holder keeps together, at most */
  constructor(budgetBytes) {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) throw new TypeError('A cache budget must be a whole number of bytes.');
    this.budgetBytes = budgetBytes;
    /** @type {Set<{bytes: number, evictOldest: () => boolean}>} */
    this._holders = new Set();
  }

  /** A budget of `budget` bytes of its own, or `budget` itself when it is one already. */
  static of(budget) {
    return budget instanceof DecodedBudget ? budget : new DecodedBudget(budget);
  }

  /** What every holder keeps now. */
  get heldBytes() {
    let held = 0;
    for (const holder of this._holders) held += holder.bytes;
    return held;
  }

  /** Count `holder`'s chunks against this budget. */
  attach(holder) {
    this._holders.add(holder);
  }

  /** Stop counting `holder` (it keeps nothing any more). */
  detach(holder) {
    this._holders.delete(holder);
  }

  /** Bring every holder back within the budget after `holder` kept more: its own oldest first. */
  settle(holder) {
    let held = this.heldBytes;
    if (held <= this.budgetBytes) return;
    for (const from of [holder, ...this._holders]) {
      if (from !== holder && !this._holders.has(from)) continue;
      while (held > this.budgetBytes) {
        const before = from.bytes;
        if (!from.evictOldest()) break;
        held -= before - from.bytes;
      }
      if (held <= this.budgetBytes) return;
    }
  }
}
