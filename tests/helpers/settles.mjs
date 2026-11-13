/**
 * Whether a promise settles while the work it must not wait for is held.
 *
 * The tests that use this hold a piece of work open (a deferred they resolve
 * later) and ask that something else — a stopped action, a cancelled read —
 * ends without it. "Without it" is the subject, not "within so many turns of
 * the event loop": a module imported for the first time on the way, or any
 * other real I/O, takes as long as the machine takes, and on a fast runner
 * fifty immediates pass before one file is read. The bound
 * here is real time, generous, and only reached when the promise really waits
 * for the held work, which never ends by itself.
 */

/**
 * The outcome of `promise` (`{value}` or `{error}`) once it settles, or null
 * when it has not within `withinMs` of real time.
 *
 * @param {Promise<unknown>} promise
 * @param {{withinMs?: number}} [options]
 * @returns {Promise<{value: unknown}|{error: unknown}|null>}
 */
export function settlesSoon(promise, { withinMs = 10_000 } = {}) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), withinMs);
    const settle = outcome => {
      clearTimeout(timer);
      resolve(outcome);
    };
    promise.then(value => settle({ value }), error => settle({ error }));
  });
}

/**
 * Whether `promise` is still pending after `turns` full turns of the event
 * loop (timers and I/O callbacks included in each): what waits for held work
 * has not ended by then. A promise that ends later than that for another
 * reason would pass here wrongly, so a test pairs this with the settled
 * outcome it expects once the work is released.
 *
 * @param {Promise<unknown>} promise
 * @param {number} [turns]
 * @returns {Promise<boolean>}
 */
export async function staysPending(promise, turns = 5) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < turns && !settled; i += 1) await new Promise(resolve => setTimeout(resolve, 1));
  return !settled;
}

/**
 * Wait until `condition()` is true. What a test expects to happen is waited
 * for as itself, not for a number of event-loop turns (the same turns pass in
 * microseconds on one machine and around real work on another); what never
 * happens ends as the test's own timeout, or here after `withinMs`, naming
 * what was waited for.
 *
 * @param {() => boolean} condition
 * @param {string} what - for the failure message
 * @param {{withinMs?: number}} [options]
 */
export async function until(condition, what, { withinMs = 10_000 } = {}) {
  const deadline = Date.now() + withinMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Waited ${withinMs} ms for ${what}.`);
    await new Promise(resolve => setImmediate(resolve));
  }
}
