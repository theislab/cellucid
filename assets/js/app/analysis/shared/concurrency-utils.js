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

/** One display frame at 60 Hz, in milliseconds. */
export const FRAME_MS = 1000 / 60;

/**
 * Coalesce a stream of updates to at most one delivery per frame.
 *
 * A long analysis completes thousands of items a second; an update per item
 * (a progress record, a formatted count, a partial result) costs more on this
 * thread than the item did, and nobody sees more than one per frame. `push`
 * takes a function that builds the update, so an update that is replaced
 * before its frame is never built. The latest one is delivered at once when a
 * frame has passed since the last delivery, otherwise when it has.
 *
 * @template T
 * @param {(update: T) => void} deliver
 * @param {number} [intervalMs=FRAME_MS]
 * @param {{clock?: () => number, after?: (ms: number, callback: () => void) => () => void}} [options]
 *   `clock`, the time in milliseconds (`performance.now`), and `after`, a
 *   timer that calls back after `ms` and returns what cancels it
 *   (`setTimeout`); tests give a virtual clock and its timers
 * @returns {{push: (build: () => T) => void, flush: () => void, cancel: () => void}}
 */
export function createFrameThrottle(deliver, intervalMs = FRAME_MS, {
  clock = () => performance.now(),
  after = (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
} = {}) {
  if (typeof deliver !== 'function') {
    throw new TypeError('deliver must be a function');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError('intervalMs must be a positive finite number');
  }
  let lastDelivery = -Infinity;
  /** @type {(() => T)|null} */
  let pending = null;
  /** Cancels the timer of the update waiting for its frame (null: none waits). */
  let cancelTimer = null;
  const flush = () => {
    if (cancelTimer !== null) {
      cancelTimer();
      cancelTimer = null;
    }
    if (pending === null) return;
    const build = pending;
    pending = null;
    lastDelivery = clock();
    deliver(build());
  };
  return {
    push(build) {
      pending = build;
      const elapsed = clock() - lastDelivery;
      if (elapsed >= intervalMs) {
        flush();
      } else if (cancelTimer === null) {
        cancelTimer = after(intervalMs - elapsed, flush);
      }
    },
    flush,
    cancel() {
      cancelTimer?.();
      cancelTimer = null;
      pending = null;
    }
  };
}
