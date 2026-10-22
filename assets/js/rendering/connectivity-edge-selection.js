/**
 * Which connectivity edges a pane shows.
 *
 * A graph can hold far more edges than a frame can usefully draw (a k = 15
 * neighbour graph has about 11 edges a cell: 110M at 10M cells), so a pane
 * shows the first K of its visible edges in one fixed random order, K being
 * the edge slider's value. An edge is visible when both its endpoints are
 * visible in that pane: shown by every filter and, with level of detail on,
 * admitted at the current level.
 *
 * **The order is stateless.** Edge `order.at(i)` is a keyed bijection of
 * `[0, E)` (a four-round Feistel network on the next power of four, cycle
 * walking past `E`), so no shuffled copy of the graph and no permutation
 * array exists: the endpoint arrays stay as loaded and the order costs O(1)
 * memory at any size. Every K-prefix is a uniform random sample of the edges,
 * the same one in every session for the same graph.
 *
 * **Selection costs O(K / p)**, p being the visible fraction: it walks the
 * order until it has K visible edges. Counting every visible edge (for the
 * slider's range) is O(E) and runs in slices off the interactive path
 * (`countVisibleConnectivityEdges`), sequentially through the arrays.
 */

import { POINT_VISIBILITY_THRESHOLD } from './alpha-visibility.js';

/** The fixed key of the edge order: one graph shows the same edges everywhere. */
export const CONNECTIVITY_EDGE_ORDER_SEED = 42;
const FEISTEL_ROUNDS = 4;

function mix32(value) {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * A keyed bijection of `[0, edgeCount)`.
 *
 * @param {number} edgeCount
 * @param {number} [seed=CONNECTIVITY_EDGE_ORDER_SEED]
 * @returns {Readonly<{edgeCount: number, at: (index: number) => number}>}
 */
export function createConnectivityEdgeOrder(edgeCount, seed = CONNECTIVITY_EDGE_ORDER_SEED) {
  if (!Number.isSafeInteger(edgeCount) || edgeCount < 0 || edgeCount > 0x1_0000_0000) {
    throw new RangeError('Connectivity edge order needs an edge count in [0, 2^32].');
  }
  // A Feistel network on the smallest power of two >= edgeCount (at least
  // 4), split into a high half of `high` bits and a low half of `low` bits.
  // Each round swaps the halves' roles, so after an even number of rounds
  // the split is back where it started; the network is a bijection for any
  // split. Cycle walking then visits fewer than 2 values on average.
  let bits = 2;
  while (2 ** bits < edgeCount) bits++;
  const high = Math.ceil(bits / 2);
  const low = bits - high;
  const highMask = (2 ** high - 1) >>> 0;
  const lowMask = (2 ** low - 1) >>> 0;
  const keys = new Uint32Array(FEISTEL_ROUNDS);
  let state = mix32(seed ^ 0x9e3779b9);
  for (let round = 0; round < FEISTEL_ROUNDS; round++) {
    state = mix32(state + 0x6d2b79f5);
    keys[round] = state;
  }
  const k0 = keys[0];
  const k1 = keys[1];
  const k2 = keys[2];
  const k3 = keys[3];
  // Every value is at most 32 bits, so each step is an exact unsigned
  // 32-bit operation. Rounds: (A: high bits, B: low bits) -> (B, A ^ F(B)),
  // so the halves alternate between `high` and `low` bits wide.
  const permute = value => {
    const a = value >>> low;
    const b = value & lowMask;
    const c = (a ^ (mix32(b ^ k0) & highMask)) >>> 0; // pair (b: low, c: high)
    const d = (b ^ (mix32(c ^ k1) & lowMask)) >>> 0; // pair (c: high, d: low)
    const e = (c ^ (mix32(d ^ k2) & highMask)) >>> 0; // pair (d: low, e: high)
    const f = (d ^ (mix32(e ^ k3) & lowMask)) >>> 0; // pair (e: high, f: low)
    return e * (lowMask + 1) + f;
  };
  const at = index => {
    let value = permute(index);
    while (value >= edgeCount) value = permute(value);
    return value;
  };
  return Object.freeze({ edgeCount, at });
}

/**
 * Require one pane's endpoint visibility: per-cell transparency (0/1 bytes)
 * and, with level of detail on, the admission level of every cell and the
 * pane's current level.
 *
 * @param {{transparency: Uint8Array, admissionLevels: Uint8Array|null, lodLevel: number}} visibility
 * @param {number} cellCount
 */
export function requireConnectivityVisibility(visibility, cellCount) {
  if (
    visibility === null ||
    typeof visibility !== 'object' ||
    !(visibility.transparency instanceof Uint8Array) ||
    visibility.transparency.length !== cellCount ||
    (visibility.admissionLevels !== null && (
      !(visibility.admissionLevels instanceof Uint8Array) ||
      visibility.admissionLevels.length !== cellCount ||
      !Number.isInteger(visibility.lodLevel) ||
      visibility.lodLevel < 0
    ))
  ) {
    throw new TypeError(
      'Connectivity visibility needs one transparency byte a cell and, with LOD, one admission level a cell.'
    );
  }
  return visibility;
}

// Transparency is binary (alpha-visibility.js): a byte passes the shared
// point threshold exactly when it is 1.
const VISIBLE_BYTE = Math.ceil(POINT_VISIBILITY_THRESHOLD);

/**
 * Write the first `target` visible edges of `order` into `output` (edge
 * ids, in order) and return how many were written. Walks the order only as
 * far as it needs to.
 *
 * @param {{edgeCount: number, at: (index: number) => number}} order
 * @param {Uint32Array} sources
 * @param {Uint32Array} destinations
 * @param {{transparency: Uint8Array, admissionLevels: Uint8Array|null, lodLevel: number}} visibility
 * @param {number} target
 * @param {Uint32Array} output - At least `target` long.
 * @returns {number}
 */
export function selectVisibleConnectivityEdges(order, sources, destinations, visibility, target, output) {
  if (!(output instanceof Uint32Array) || output.length < target) {
    throw new RangeError('Connectivity edge selection needs an output of at least the target length.');
  }
  const { transparency, admissionLevels, lodLevel } = visibility;
  const edgeCount = order.edgeCount;
  let selected = 0;
  if (admissionLevels === null) {
    for (let index = 0; index < edgeCount && selected < target; index++) {
      const edge = order.at(index);
      if (transparency[sources[edge]] >= VISIBLE_BYTE && transparency[destinations[edge]] >= VISIBLE_BYTE) {
        output[selected++] = edge;
      }
    }
  } else {
    for (let index = 0; index < edgeCount && selected < target; index++) {
      const edge = order.at(index);
      const source = sources[edge];
      const destination = destinations[edge];
      if (
        transparency[source] >= VISIBLE_BYTE &&
        transparency[destination] >= VISIBLE_BYTE &&
        admissionLevels[source] <= lodLevel &&
        admissionLevels[destination] <= lodLevel
      ) {
        output[selected++] = edge;
      }
    }
  }
  return selected;
}

/**
 * Count the visible edges among `[start, end)` in storage order (sequential
 * reads: the cost of counting is one pass over the endpoint arrays).
 *
 * @param {Uint32Array} sources
 * @param {Uint32Array} destinations
 * @param {{transparency: Uint8Array, admissionLevels: Uint8Array|null, lodLevel: number}} visibility
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
export function countVisibleConnectivityEdges(sources, destinations, visibility, start, end) {
  const { transparency, admissionLevels, lodLevel } = visibility;
  let count = 0;
  if (admissionLevels === null) {
    for (let edge = start; edge < end; edge++) {
      if (transparency[sources[edge]] >= VISIBLE_BYTE && transparency[destinations[edge]] >= VISIBLE_BYTE) {
        count++;
      }
    }
  } else {
    for (let edge = start; edge < end; edge++) {
      const source = sources[edge];
      const destination = destinations[edge];
      if (
        transparency[source] >= VISIBLE_BYTE &&
        transparency[destination] >= VISIBLE_BYTE &&
        admissionLevels[source] <= lodLevel &&
        admissionLevels[destination] <= lodLevel
      ) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Whether every cell is visible (no filter and no reduced level): then every
 * edge is, and the count is the edge count without a pass over the edges.
 *
 * @param {{transparency: Uint8Array, admissionLevels: Uint8Array|null, lodLevel: number}} visibility
 * @returns {boolean}
 */
export function isEveryConnectivityCellVisible(visibility) {
  const { transparency, admissionLevels, lodLevel } = visibility;
  for (let cell = 0; cell < transparency.length; cell++) {
    if (transparency[cell] < VISIBLE_BYTE) return false;
  }
  if (admissionLevels !== null) {
    for (let cell = 0; cell < admissionLevels.length; cell++) {
      if (admissionLevels[cell] > lodLevel) return false;
    }
  }
  return true;
}
