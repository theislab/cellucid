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

/**
 * Apply Cellucid's deterministic connectivity LOD permutation while keeping
 * every endpoint pair bound to its exact scientific weight.
 *
 * @param {Uint32Array} sources
 * @param {Uint32Array} destinations
 * @param {Float64Array} weights
 */
export function shuffleConnectivityEdges(
  sources,
  destinations,
  weights
) {
  if (
    !(sources instanceof Uint32Array) ||
    !(destinations instanceof Uint32Array) ||
    !(weights instanceof Float64Array) ||
    sources.length !== destinations.length ||
    sources.length !== weights.length
  ) {
    throw new TypeError(
      'Connectivity shuffling requires equal-length Uint32 endpoints and Float64 weights.'
    );
  }

  const rng = createMulberry32(42);
  for (let index = sources.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(rng() * (index + 1));

    const source = sources[index];
    sources[index] = sources[swapIndex];
    sources[swapIndex] = source;

    const destination = destinations[index];
    destinations[index] = destinations[swapIndex];
    destinations[swapIndex] = destination;

    const weight = weights[index];
    weights[index] = weights[swapIndex];
    weights[swapIndex] = weight;
  }
}
