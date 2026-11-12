/**
 * `ByteBudget`: bytes of chunk data in flight (fetched and being decoded)
 * across every read of one open file. A read waits for room before fetching
 * more, so many concurrent reads hold no more than one budget between them;
 * one piece larger than the budget still runs (alone). Reads someone waits
 * for are served before background work, which never takes the budget's
 * reserve. What the file keeps decoded is `formats/io/byte-cache.js`'s.
 *
 * Budgets bound memory; they never limit what can be read.
 *
 * @module formats/hdf5/byte-budget
 */

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
