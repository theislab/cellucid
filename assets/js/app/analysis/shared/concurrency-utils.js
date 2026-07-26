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

export default {
  waitForAvailableSlot
};
