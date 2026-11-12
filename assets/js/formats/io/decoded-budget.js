/**
 * One byte budget shared by the caches that keep decoded chunks of one open
 * store: the store's own (`formats/io/byte-cache.js` `ByteCache`, one per
 * Zarr store or HDF5 file) and the reader's chunks kept across a
 * progressive opening's growth (`data/anndata/decoded-chunks.js`). Each
 * cache holds what it keeps and charges it here; together they never hold
 * more than `budgetBytes` (the `decodedBlocks` share of the memory model,
 * `data/memory-budget.js`, read whenever it is used), however the reads
 * divide it.
 *
 * A cache that keeps a chunk makes room by letting go of its own least
 * recently used chunks first, then the other caches' (`settle`): what is
 * read now displaces what was read longest ago where it lives, and a cache
 * whose chunks are all in use takes room from the others.
 *
 * What the budgets of every open store keep together is what the memory
 * model counts as decoded chunks (`heldDecodedBytes`), and what it trims
 * when the allowance or the working set changes, or the page is hidden
 * (`trimDecodedChunks`): chunks stay while nothing asks for their room, so
 * a gene read after a pause next to the last one decodes nothing again. A
 * chunk let go is decoded again when asked for (its bytes from the byte
 * caches, or fetched).
 *
 * A holder is `{bytes, evictOldest(), clear()}`: `bytes` what it keeps now,
 * `evictOldest()` lets its least recently used chunk go and says whether it
 * had one to let go, `clear()` lets every one go.
 *
 * @module formats/io/decoded-budget
 */

/**
 * The budgets of decoded chunks, weakly: a store dropped without closing
 * takes its budget with it.
 * @type {Set<WeakRef<DecodedBudget>>}
 */
const counted = new Set();

function liveBudgets() {
  const live = [];
  for (const ref of counted) {
    const budget = ref.deref();
    if (budget === undefined) counted.delete(ref);
    else live.push(budget);
  }
  return live;
}

export class DecodedBudget {
  /**
   * @param {number|(() => number)} budgetBytes - What every holder keeps
   *   together, at most: a number, or a function read whenever it is used
   *   (a share of the memory model)
   * @param {{structure?: boolean}} [options] - `structure: true` for a cache
   *   of a store's structure (a sharded array's shard indexes), which a later
   *   read would fetch again rather than decode: not counted as decoded
   *   chunks, never trimmed
   */
  constructor(budgetBytes, { structure = false } = {}) {
    if (typeof budgetBytes === 'function') {
      this._budget = budgetBytes;
    } else {
      if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) throw new TypeError('A cache budget must be a whole number of bytes.');
      this._budget = () => budgetBytes;
    }
    /** @type {Set<{bytes: number, evictOldest: () => boolean, clear: () => void}>} */
    this._holders = new Set();
    if (!structure) counted.add(new WeakRef(this));
  }

  /** A budget of `budget` bytes of its own, or `budget` itself when it is one already. */
  static of(budget) {
    return budget instanceof DecodedBudget ? budget : new DecodedBudget(budget);
  }

  /** What every holder keeps together, at most, now. */
  get budgetBytes() {
    return this._budget();
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

  /** Let every holder's chunks go. */
  releaseAll() {
    for (const holder of this._holders) holder.clear();
  }

  /** Bring every holder back within the budget after `holder` kept more: its own oldest first. */
  settle(holder) {
    this.trimTo(this.budgetBytes, holder);
  }

  /**
   * Let the oldest chunks go until every holder together keeps no more than
   * `target` bytes: `first`'s own first, then the others'.
   *
   * @param {number} target
   * @param {Object|null} [first]
   */
  trimTo(target, first = null) {
    let held = this.heldBytes;
    if (held <= target) return;
    if (target === 0) {
      this.releaseAll();
      return;
    }
    for (const from of first === null ? [...this._holders] : [first, ...this._holders]) {
      if (from !== first && !this._holders.has(from)) continue;
      while (held > target) {
        const before = from.bytes;
        if (!from.evictOldest()) break;
        held -= before - from.bytes;
      }
      if (held <= target) return;
    }
  }
}

/** What the decoded chunks of every open store keep together, in bytes. */
export function heldDecodedBytes() {
  let held = 0;
  for (const budget of liveBudgets()) held += budget.heldBytes;
  return held;
}

/**
 * Let decoded chunks go, every store's oldest first, until together they
 * keep no more than `target` bytes (0: every one).
 *
 * @param {number} target
 * @returns {string|null} What was let go, in words
 */
export function trimDecodedChunks(target) {
  const budgets = liveBudgets();
  let held = budgets.reduce((sum, budget) => sum + budget.heldBytes, 0);
  const before = held;
  for (const budget of budgets) {
    if (held <= target) break;
    const own = budget.heldBytes;
    budget.trimTo(Math.max(0, target - (held - own)));
    held += budget.heldBytes - own;
  }
  return held < before ? 'decoded chunks' : null;
}
