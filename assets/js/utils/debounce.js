/**
 * @fileoverview The one debounce: run something once calls to it stop coming
 * for a while, with the arguments of the last call.
 *
 * Every "wait until the person (or the reads) pause, then act" goes through
 * `debounce`: a search box that filters once typing pauses, a preview redrawn
 * once its controls settle, a camera gesture's end told once the wheel rests,
 * a transport bar hidden once the pointer rests, a journal closed once the
 * reads go quiet, idle workers retired once nothing came for a while. A
 * timer written by hand for it (`clearTimeout(t); t = setTimeout(...)`) is a
 * copy (`tests/one-implementation-contract.test.mjs`).
 *
 * What a debounce is not: work coalesced to one run soon after the first ask
 * (`if (timer !== null) return; timer = setTimeout(...)`: later asks join it,
 * they do not push it back), a deadline (`utils/deadline.js`), the next
 * macrotask (`utils/yield-macrotask.js`), a growing wait before trying again
 * (`utils/backoff.js`).
 *
 * @module utils/debounce
 */

/**
 * A debounced function (`debounce`): called with the arguments `A`, with its
 * `cancel()`, `flush()` and `pending`.
 *
 * @template {unknown[]} A
 * @typedef {((...args: A) => void) & {cancel: () => boolean, flush: () => boolean, readonly pending: boolean}} Debounced
 */

/**
 * `callback`, run once `waitMs` passed without another call, with the last
 * call's arguments. `waitMs` may be a function of those arguments (a wait the
 * caller measures or names per call). The function returned has:
 *
 * - `cancel()`: drop the run waiting (true when one was);
 * - `flush()`: run the one waiting now (true when one was);
 * - `pending`: whether a run is waiting.
 *
 * `unref`: on Node, the waiting run keeps no process alive (a journal closed
 * once quiet, idle workers retired); browsers ignore it.
 *
 * @template {unknown[]} A
 * @param {(...args: A) => void} callback
 * @param {number|((...args: A) => number)} waitMs
 * @param {{unref?: boolean}} [options]
 * @returns {Debounced<A>}
 */
export function debounce(callback, waitMs, { unref = false } = {}) {
  if (typeof callback !== 'function') throw new TypeError('A debounce runs a function.');
  if (typeof waitMs !== 'function' && !(Number.isFinite(waitMs) && waitMs >= 0)) {
    throw new TypeError('A debounce waits a finite number of milliseconds, or a function giving one.');
  }
  let timer = null;
  let lastArgs = null;
  const run = () => {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    callback(...args);
  };
  const debounced = (...args) => {
    lastArgs = args;
    if (timer !== null) clearTimeout(timer);
    const wait = typeof waitMs === 'function' ? waitMs(...args) : waitMs;
    // Only the timer set last runs: one canceled or replaced never does,
    // even when its callback is called after all.
    const own = setTimeout(() => {
      if (timer === own) run();
    }, wait);
    timer = own;
    if (unref) own?.unref?.();
  };
  debounced.cancel = () => {
    if (timer === null) return false;
    clearTimeout(timer);
    timer = null;
    lastArgs = null;
    return true;
  };
  debounced.flush = () => {
    if (timer === null) return false;
    clearTimeout(timer);
    run();
    return true;
  };
  Object.defineProperty(debounced, 'pending', { get: () => timer !== null });
  return debounced;
}
