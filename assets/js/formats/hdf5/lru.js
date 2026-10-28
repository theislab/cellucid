/**
 * Memory budgets of one open file.
 *
 * - `ByteCache`: a least-recently-used cache with a byte budget. It holds
 *   decoded chunks and parsed global heap collections, so reading a dense
 *   matrix column by column decodes each chunk once, and a column of strings
 *   that shares heap collections fetches each collection once. An entry
 *   larger than the whole budget is simply not kept.
 * - `ByteBudget`: bytes of chunk data in flight (fetched and being decoded)
 *   across every read of the file. A read waits for room before fetching
 *   more, so many concurrent reads hold no more than one budget between
 *   them; one piece larger than the budget still runs (alone). Reads someone
 *   waits for are served before background work, which never takes the
 *   budget's reserve.
 *
 * Budgets bound memory; they never limit what can be read.
 *
 * @module formats/hdf5/lru
 */

import { DecodedBudget } from '../io/decoded-budget.js';

export class ByteCache {
  /**
   * @param {number|DecodedBudget} budgetBytes - Bytes kept at most, or a
   *   budget shared with the other caches of decoded chunks of the file
   *   (`formats/io/decoded-budget.js`)
   */
  constructor(budgetBytes) {
    this._budget = DecodedBudget.of(budgetBytes);
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

  /** Keep `value` (weighing `bytes`) unless it alone exceeds the budget. */
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

export class ByteBudget {
  /**
   * @param {number|(() => number)} budgetBytes - A number, or a function read
   *   each time room is weighed (a budget that follows a measured link)
   * @param {{waves?: boolean, reserve?: number|(() => number)}} [options]
   *   `waves`: waiters start once half the budget is free (see `release`);
   *   `reserve`: what background work leaves free for the reads someone
   *   waits for (a slot of a few, half of a byte budget)
   */
  constructor(budgetBytes, { waves = true, reserve = 0 } = {}) {
    this._budget = typeof budgetBytes === 'function' ? budgetBytes : () => budgetBytes;
    this._reserve = typeof reserve === 'function' ? reserve : () => reserve;
    this.waves = waves;
    this.held = 0;
    this.heldBackground = 0;
    /** Waiting reads someone waits for, and waiting background work, each first come, first served. */
    this.waiting = [];
    this.waitingBackground = [];
  }

  get budget() {
    return this._budget();
  }

  /** Whether `bytes` fit now for a foreground (`background` false) or background holder. @private */
  _fits(bytes, background) {
    if (this.held === 0) return true;
    if (!background) return this.held + bytes <= this.budget;
    return this.heldBackground + bytes <= Math.max(0, this.budget - this._reserve()) &&
      this.held + bytes <= this.budget;
  }

  /**
   * Resolves once `bytes` fit (or nothing else is held) with the function
   * that gives them back. Work nobody waits for yet (`background`, read when
   * it is weighed, so work someone starts waiting for is served as theirs)
   * waits while any read someone waits for waits, and keeps within the
   * budget less its reserve: a read a view waits for never waits behind an
   * index built ahead of need.
   *
   * @param {number} bytes
   * @param {boolean|(() => boolean)} [background]
   * @returns {Promise<() => void>}
   */
  acquire(bytes, background = false) {
    const isBackground = typeof background === 'function' ? background : () => background;
    return new Promise(resolve => {
      const waiter = { bytes, resolve, isBackground };
      (isBackground() ? this.waitingBackground : this.waiting).push(waiter);
      this._serve();
    });
  }

  /** Hand out room, foreground first, each queue in order. @private */
  _serve() {
    // Background waiters whose work someone now waits for join the foreground.
    if (this.waitingBackground.some(waiter => !waiter.isBackground())) {
      const promoted = this.waitingBackground.filter(waiter => !waiter.isBackground());
      this.waitingBackground = this.waitingBackground.filter(waiter => waiter.isBackground());
      this.waiting.push(...promoted);
    }
    while (this.waiting.length > 0 && this._fits(this.waiting[0].bytes, false)) {
      this._grant(this.waiting.shift(), false);
    }
    if (this.waiting.length > 0) return;
    while (this.waitingBackground.length > 0 && this._fits(this.waitingBackground[0].bytes, true)) {
      this._grant(this.waitingBackground.shift(), true);
    }
  }

  /** @private */
  _grant(waiter, background) {
    this.held += waiter.bytes;
    if (background) this.heldBackground += waiter.bytes;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      this.held -= waiter.bytes;
      if (background) this.heldBackground -= waiter.bytes;
      // Waiters start in waves, once half the budget is free: pieces started
      // together are fetched together (a remote file merges them into few
      // requests) instead of one round trip each as room trickles back.
      if (this.waves && this.held > this.budget / 2) return;
      this._serve();
    });
  }
}
