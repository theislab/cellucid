/**
 * Virtual time for tests of code that measures time or waits on latency.
 *
 * A fake source stands for a link with a round trip by sleeping on this
 * clock (`sleep(ms)`), and the code under test measures with it (`now`, given
 * as its `clock`). The clock moves only when the process is idle: no promise
 * continuation and no `setImmediate` callback is left to run, so every request
 * the code would start at this instant has started. Then it jumps to the
 * earliest sleeper's wake-up time and wakes every sleeper due then, in the
 * order they slept. Work the process does between two jumps takes no time.
 *
 * So what a test asserts on elapsed time is the structure of the requests
 * (how many round trips run one after another), never how fast the machine
 * running the test is: a loaded CI runner gives the same times as an idle one.
 *
 * Idle is read from the event loop itself (`process.getActiveResourcesInfo`):
 * the readers under test schedule their plans with `setImmediate`, and a
 * pending one is listed there. Real timers (`setTimeout`) are not waited for;
 * code that waits on one is not under virtual time.
 */

const IDLE_ROUNDS_LIMIT = 100_000;

/** The wait for idle in progress, shared: two waits of their own would each see the other's callback pending. */
let idle = null;

/** Resolves on a later macrotask once no `setImmediate` callback is pending. */
export function settle() {
  idle ??= (async () => {
    try {
      for (let round = 0; round < IDLE_ROUNDS_LIMIT; round++) {
        await new Promise(resolve => setImmediate(resolve));
        if (!process.getActiveResourcesInfo().includes('Immediate')) return;
      }
      throw new Error(`the process never went idle in ${IDLE_ROUNDS_LIMIT} rounds of setImmediate`);
    } finally {
      idle = null;
    }
  })();
  return idle;
}

/**
 * `after(ms, callback)` is a timer on the clock, with the shape of the
 * timers a link runs on (`ResponseClock`'s `after`): it calls `callback` once
 * the clock reaches `ms` from now and returns what cancels it. A cancelled
 * timer is forgotten: the clock never moves to its time.
 *
 * @returns {{now: () => number, sleep: (ms: number) => Promise<void>,
 *   after: (ms: number, callback: () => void) => () => void, settle: () => Promise<void>}}
 */
export function virtualTime() {
  let current = 0;
  let order = 0;
  /** @type {Array<{at: number, order: number, wake: () => void, cancelled: boolean}>} */
  const sleepers = [];
  let driving = false;

  async function drive() {
    driving = true;
    try {
      while (sleepers.length > 0) {
        await settle();
        if (sleepers.length === 0) break;
        let at = Infinity;
        for (const sleeper of sleepers) at = Math.min(at, sleeper.at);
        current = at;
        const due = sleepers.filter(sleeper => sleeper.at === at).sort((a, b) => a.order - b.order);
        for (const sleeper of due) sleepers.splice(sleepers.indexOf(sleeper), 1);
        // A timer woken first may cancel one due with it.
        for (const sleeper of due) if (!sleeper.cancelled) sleeper.wake();
      }
    } finally {
      driving = false;
    }
  }

  function after(ms, callback) {
    if (!(ms >= 0)) throw new RangeError(`a sleep of ${ms} ms`);
    const sleeper = { at: current + ms, order: order++, wake: callback, cancelled: false };
    sleepers.push(sleeper);
    if (!driving) drive();
    return () => {
      sleeper.cancelled = true;
      const at = sleepers.indexOf(sleeper);
      if (at >= 0) sleepers.splice(at, 1);
    };
  }

  return {
    now: () => current,
    sleep: ms => new Promise(wake => { after(ms, wake); }),
    after,
    settle,
  };
}
