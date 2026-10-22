/**
 * Concurrency Utilities
 *
 * Small helpers for safely running asynchronous work with bounded concurrency.
 * Designed for performance-sensitive analysis flows (e.g., DE) where we want to:
 * - keep worker pools saturated
 * - avoid unbounded in-flight allocations
 *
 * @module shared/concurrency-utils
 */

import { yieldToMacrotask } from '../../../utils/yield-macrotask.js';

/**
 * Wait until a Set of in-flight promises is below a given size.
 *
 * Typical usage:
 * - add promises to a `Set`
 * - each promise removes itself from the set in `.finally()`
 * - call this helper before scheduling more work
 *
 * @template T
 * @param {Set<Promise<T>>} inFlight
 * @param {number} maxInFlight
 * @returns {Promise<void>}
 */
export async function waitForAvailableSlot(inFlight, maxInFlight) {
  if (!(inFlight instanceof Set)) {
    throw new TypeError('inFlight must be a Set of promises');
  }
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight <= 0) {
    throw new TypeError('maxInFlight must be a positive safe integer');
  }

  // While we're at capacity, wait for any promise to settle.
  // Promises must remove themselves from the set in `.finally()`.
  while (inFlight.size >= maxInFlight) {
    await Promise.race(inFlight);
  }
}

/**
 * Longest stretch, in milliseconds, a cooperative analysis loop runs before it
 * hands the event loop back. Below one 60 Hz frame, so input and painting keep
 * their turn while a long gene list streams.
 */
export const MAIN_THREAD_SLICE_MS = 12;

/**
 * A yield that only yields once the current slice of work has used up
 * `sliceMs`. Loops call it once per item; it costs a clock read until the slice
 * is spent, so a loop of cheap items no longer pauses on a fixed item count.
 *
 * @param {number} [sliceMs=MAIN_THREAD_SLICE_MS]
 * @returns {() => Promise<void>|undefined} Returns a promise only when it yields
 */
export function createSlicedYield(sliceMs = MAIN_THREAD_SLICE_MS) {
  if (!Number.isFinite(sliceMs) || sliceMs <= 0) {
    throw new TypeError('sliceMs must be a positive finite number');
  }
  let sliceStart = performance.now();
  return function yieldIfSliceSpent() {
    if (performance.now() - sliceStart < sliceMs) return undefined;
    // One macrotask: input, painting and queued network callbacks run first,
    // and unlike setTimeout(0) it is never clamped to 4 ms, which over a long
    // chain of yields turned into seconds of idle time.
    return yieldToMacrotask().then(() => {
      sliceStart = performance.now();
    });
  };
}
