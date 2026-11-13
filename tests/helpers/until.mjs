/**
 * Wait for a condition, not for a time.
 *
 * Work a test starts and cannot await -- a message crossing a
 * `MessageChannel` or `BroadcastChannel`, a worker's answer, a file written
 * on a thread of its own, a chain of reads the code under test starts on
 * its own -- ends after no fixed time: later on a loaded runner, and later
 * still on Windows, whose timers fire on a 15.6 ms tick and whose message
 * delivery is slower. A test that pauses a fixed time for it passes where
 * the work is quick and fails where it is not. So a test waits for
 * what proves the work happened: an event the code exposes, a promise it
 * returns, or else the state it changes, asked again until it holds.
 *
 * Polling a condition is safe at any speed: its result does not depend on
 * how often it is asked. The bound is for a test that would otherwise hang
 * (the condition never holds) and fails it with what it waited for; it is
 * far past any honest wait, so a slow machine never reaches it. Its timer
 * also keeps the event loop alive meanwhile: a message on a port nothing
 * holds (the product unrefs its ports, as a browser's keep nothing alive)
 * would not, and Node would end the test as a promise pending on an empty
 * event loop (Node 22).
 *
 * Not for what a test checks does not happen ("nothing more is read"): no
 * condition proves an absence. Such a test first waits for what proves the
 * work that could have done it has ended, then asserts.
 *
 * @module tests/helpers/until
 */

import assert from 'node:assert/strict';

const BOUND_MS = 30_000;

/**
 * Resolves once `condition()` (sync or async) is true; fails the test when
 * it is not within `boundMs`.
 *
 * @param {() => boolean|Promise<boolean>} condition
 * @param {string} what - What is waited for, for the failure message
 * @param {{boundMs?: number}} [options]
 * @returns {Promise<void>}
 */
export async function until(condition, what, { boundMs = BOUND_MS } = {}) {
  const deadline = performance.now() + boundMs;
  while (!(await condition())) {
    if (performance.now() > deadline) assert.fail(`Not ${what} within ${boundMs} ms.`);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
