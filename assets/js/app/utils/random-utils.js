/**
 * @fileoverview Deterministic random utilities.
 *
 * Provides a tiny, dependency-free PRNG used for reproducible sampling
 * (e.g. density reduction, connectivity shuffles). Keeping this centralized
 * avoids duplicate implementations and keeps behavior consistent.
 *
 * @module utils/random-utils
 */

/**
 * Create a seeded PRNG (Mulberry32).
 *
 * @param {number} seed
 * @returns {() => number} Function returning a float in [0, 1)
 */
export function createMulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
