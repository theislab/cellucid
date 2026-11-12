/**
 * @fileoverview The wait before trying again after a failure, growing with
 * each one: the first wait, doubled per attempt up to a ceiling, with "equal
 * jitter" (a random point in its upper half) so many clients that failed
 * together do not try again together. One formula for every retry loop
 * (the chat bar's provider calls, the relay link's reconnection); a host that
 * names its own wait (`Retry-After`) is waited on as asked by the caller
 * instead (`formats/io/hosts.js` governs a host's rate limits apart: it waits
 * for what the host's answers say, not for a growing guess).
 *
 * @module utils/backoff
 */

/**
 * Milliseconds to wait before try `attempt` + 1 (0-based): `firstMs * 2^attempt`,
 * at most `ceilingMs`, scaled by a random factor in [0.5, 1).
 * @param {number} attempt - failures so far, from 0
 * @param {{firstMs: number, ceilingMs: number, random?: () => number}} options
 * @returns {number}
 */
export function backoffDelayMs(attempt, { firstMs, ceilingMs, random = Math.random }) {
  if (!Number.isInteger(attempt) || attempt < 0) throw new RangeError('A backoff attempt is a whole number from 0');
  return Math.min(ceilingMs, firstMs * 2 ** attempt) * (0.5 + random() / 2);
}
