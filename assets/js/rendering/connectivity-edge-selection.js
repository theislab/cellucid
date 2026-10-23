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
 * **The order.** Edge `order.at(i)` is a keyed bijection of `[0, E)` (a
 * four-round Feistel network on the next power of two, cycle walking past
 * `E`), and `order.rankOf(edge)` is its inverse. Each round function is a
 * table of one half's values (`sqrt(E)` entries), so a step is four table
 * reads, and the order costs O(sqrt E) memory. Every K-prefix is a uniform
 * random sample of the edges, the same one in every session for the same
 * graph.
 *
 * **The ordered records.** The selection reads the graph in that order, so
 * the edges arrive in it: one 12-byte record a rank (source, destination,
 * strength bits), written by the reader worker as it builds the graph
 * (`ConnectivityEdges`, data/connectivity-edges.js). A record is also exactly
 * what the GPU draws (rendering/connectivity-edge-layer.js).
 *
 * **Selection** returns the first K visible records, exactly, by whichever
 * of two walks costs less for the pane's visibility:
 *
 * - the ordered scan reads records from rank 0 until it has K visible ones:
 *   sequential reads, O(K / visible fraction);
 * - the visible-cell walk reads only the visible cells' forward edges in
 *   the adjacency (`forwardOffsets`, the last of each cell's `neighbors`), ranks the visible
 *   ones, keeps the K smallest ranks and sorts them: O(cells + visible
 *   cells' edges), whatever K is.
 *
 * The scan runs first in doubling chunks; after each chunk it estimates
 * both remaining costs from the visible fraction it has seen and hands over
 * to the cell walk when that is cheaper. Both give the same records in the
 * same order. The cell walk also yields the exact visible-edge count; after
 * a scan, the count (the slider's range) is counted over the visible cells
 * in slices off the interactive path (`countVisibleConnectivityEdges`).
 */

import { POINT_VISIBILITY_THRESHOLD } from './alpha-visibility.js';

/** The fixed key of the edge order: one graph shows the same edges everywhere. */
export const CONNECTIVITY_EDGE_ORDER_SEED = 42;
/** Words in one record: source cell, destination cell, strength (float32 bits). */
export const CONNECTIVITY_RECORD_WORDS = 3;
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
 * A keyed bijection of `[0, edgeCount)` and its inverse.
 *
 * @param {number} edgeCount
 * @param {number} [seed=CONNECTIVITY_EDGE_ORDER_SEED]
 * @returns {Readonly<{edgeCount: number, bits: number,
 *   at: (index: number) => number, rankOf: (edge: number) => number}>}
 */
export function createConnectivityEdgeOrder(edgeCount, seed = CONNECTIVITY_EDGE_ORDER_SEED) {
  if (!Number.isSafeInteger(edgeCount) || edgeCount < 0 || edgeCount > 0x1_0000_0000) {
    throw new RangeError('Connectivity edge order needs an edge count in [0, 2^32].');
  }
  // A Feistel network on the smallest power of two >= edgeCount (at least
  // 4), split into a high half of `high` bits and a low half of `low` bits.
  // Each round swaps the halves' roles, so after an even number of rounds
  // the split is back where it started; the network is a bijection for any
  // split. Cycle walking then visits fewer than 2 values on average, and
  // walking the inverse back to `[0, edgeCount)` inverts it.
  let bits = 2;
  while (2 ** bits < edgeCount) bits++;
  const high = Math.ceil(bits / 2);
  const low = bits - high;
  const highMask = (2 ** high - 1) >>> 0;
  const lowMask = (2 ** low - 1) >>> 0;
  const lowSpan = lowMask + 1;
  const keys = new Uint32Array(FEISTEL_ROUNDS);
  let state = mix32(seed ^ 0x9e3779b9);
  for (let round = 0; round < FEISTEL_ROUNDS; round++) {
    state = mix32(state + 0x6d2b79f5);
    keys[round] = state;
  }
  // Round r's function of one half, `mix32(half ^ key_r)` masked to the
  // other half's width, tabulated over every value of its input half.
  // Rounds: (A: high bits, B: low bits) -> (B, A ^ F(B)), so the inputs
  // alternate between `low` and `high` bits wide.
  const f0 = new Uint16Array(lowSpan);
  const f1 = new Uint16Array(highMask + 1);
  const f2 = new Uint16Array(lowSpan);
  const f3 = new Uint16Array(highMask + 1);
  for (let half = 0; half < lowSpan; half++) {
    f0[half] = mix32(half ^ keys[0]) & highMask;
    f2[half] = mix32(half ^ keys[2]) & highMask;
  }
  for (let half = 0; half <= highMask; half++) {
    f1[half] = mix32(half ^ keys[1]) & lowMask;
    f3[half] = mix32(half ^ keys[3]) & lowMask;
  }
  // Every value is below 2^bits <= 2^32, so `>>>` reads its high half
  // exactly and every product stays an exact integer.
  const at = index => {
    let value = index;
    do {
      const a = value >>> low;
      const b = value & lowMask;
      const c = a ^ f0[b]; // pair (b: low, c: high)
      const d = b ^ f1[c]; // pair (c: high, d: low)
      const e = c ^ f2[d]; // pair (d: low, e: high)
      value = e * lowSpan + (d ^ f3[e]); // pair (e: high, f: low)
    } while (value >= edgeCount);
    return value;
  };
  const rankOf = edge => {
    let value = edge;
    do {
      const e = value >>> low;
      const d = (value & lowMask) ^ f3[e];
      const c = e ^ f2[d];
      const b = d ^ f1[c];
      value = (c ^ f0[b]) * lowSpan + b;
    } while (value >= edgeCount);
    return value;
  };
  return Object.freeze({ edgeCount, bits, at, rankOf });
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
// point threshold exactly when it is 1, so it is its own 0/1 mask.
const VISIBLE_BYTE = Math.ceil(POINT_VISIBILITY_THRESHOLD);
if (VISIBLE_BYTE !== 1) {
  throw new Error('Connectivity visibility masks need the point threshold between bytes 0 and 1.');
}

/**
 * One pane's visible cells as a 0/1 byte a cell, or null when every cell is
 * visible (then every edge is). Without LOD the transparency is the mask
 * itself; with LOD the mask is written into `scratch` (one byte a cell).
 *
 * @param {{transparency: Uint8Array, admissionLevels: Uint8Array|null, lodLevel: number}|null} visibility
 * @param {Uint8Array|null} scratch
 * @returns {{mask: Uint8Array|null, scratch: Uint8Array|null}}
 */
export function connectivityVisibleCells(visibility, scratch) {
  if (visibility === null) return { mask: null, scratch };
  const { transparency, admissionLevels, lodLevel } = visibility;
  const cellCount = transparency.length;
  if (admissionLevels === null) {
    let every = 1;
    for (let cell = 0; cell < cellCount; cell++) every &= transparency[cell];
    return { mask: every === 1 ? null : transparency, scratch };
  }
  const mask = scratch !== null && scratch.length === cellCount ? scratch : new Uint8Array(cellCount);
  let every = 1;
  for (let cell = 0; cell < cellCount; cell++) {
    const shown = transparency[cell] & (admissionLevels[cell] <= lodLevel ? 1 : 0);
    mask[cell] = shown;
    every &= shown;
  }
  return { mask: every === 1 ? null : mask, scratch: mask };
}

/**
 * The selection's view of one graph (`ConnectivityEdges` from the reader
 * worker): its arrays by reference, and its order.
 *
 * @param {{records: Uint32Array, forwardOffsets: Uint32Array, neighborOffsets: Uint32Array,
 *   neighbors: Uint32Array, nEdges: number, nCells: number}} graph
 */
export function createConnectivityEdgeIndex({ records, forwardOffsets, neighborOffsets, neighbors, nEdges, nCells }) {
  if (
    !(records instanceof Uint32Array) ||
    !(forwardOffsets instanceof Uint32Array) ||
    !(neighborOffsets instanceof Uint32Array) ||
    !(neighbors instanceof Uint32Array) ||
    !Number.isSafeInteger(nEdges) || nEdges < 0 ||
    !Number.isSafeInteger(nCells) || nCells <= 0 ||
    records.length !== nEdges * CONNECTIVITY_RECORD_WORDS ||
    forwardOffsets.length !== nCells + 1 || forwardOffsets[nCells] !== nEdges ||
    neighborOffsets.length !== nCells + 1 || neighbors.length !== 2 * nEdges ||
    neighborOffsets[nCells] !== 2 * nEdges
  ) {
    throw new TypeError(
      'Connectivity edges need Uint32 ordered records (three words an edge), forward and neighbour ' +
      'offsets (cells + 1 each), the neighbours (two an edge) and a positive cell count.'
    );
  }
  return {
    records,
    forwardOffsets,
    neighborOffsets,
    neighbors,
    edgeCount: nEdges,
    cellCount: nCells,
    order: createConnectivityEdgeOrder(nEdges),
  };
}

/** Reusable buffers of the visible-cell walk; they grow to the largest walk. */
export function createConnectivitySelectionScratch() {
  return { keys: new Uint32Array(0), sorted: new Uint32Array(0), histogram: new Uint32Array(1 << RADIX_BITS) };
}

// Costs, in ordered-scan reads, measured on the app's kernels over a
// 6.3M-edge graph (scan 1.5 ns a rank): the cell walk reads each cell's mask
// byte and offsets (~1 ns) and ranks, sorts and writes each visible edge
// (~20 ns). Only the ratios matter.
const COST_CELL = 0.7;
const COST_VISIBLE_EDGE = 13;
/** Ranks the scan reads before it first compares the walks; the chunk then doubles. */
const FIRST_SCAN_CHUNK = 1 << 14;
const RADIX_BITS = 12;
const RADIX_MASK = (1 << RADIX_BITS) - 1;

/**
 * Write the first `target` visible records of the order into `out` and
 * return how many were written and, when this selection established it, the
 * exact number of visible edges (else null). `mask` is
 * `connectivityVisibleCells(...).mask` (null: every cell visible).
 *
 * @param {ReturnType<typeof createConnectivityEdgeIndex>} index
 * @param {Uint8Array|null} mask
 * @param {number} target
 * @param {Uint32Array} out - At least `target` records long.
 * @param {ReturnType<typeof createConnectivitySelectionScratch>} scratch
 * @returns {{shown: number, visibleCount: number|null}}
 */
export function selectConnectivityEdges(index, mask, target, out, scratch) {
  const edgeCount = index.edgeCount;
  if (!Number.isSafeInteger(target) || target < 0 || target > edgeCount) {
    throw new RangeError(`Connectivity selection target must be an integer in [0, ${edgeCount}].`);
  }
  if (!(out instanceof Uint32Array) || out.length < target * 3) {
    throw new RangeError('Connectivity selection needs an output of at least the target records.');
  }
  if (mask === null) {
    out.set(index.records.subarray(0, target * 3));
    return { shown: target, visibleCount: edgeCount };
  }
  if (target === 0) return { shown: 0, visibleCount: null };
  const records = index.records;
  let shown = 0;
  let rank = 0;
  let chunk = FIRST_SCAN_CHUNK;
  while (rank < edgeCount) {
    const end = Math.min(edgeCount, rank + chunk);
    // Each record is written to the next output slot and kept by advancing
    // past it only when both endpoints are visible: no branch on the
    // visibility, which a filter makes unpredictable. Slots stay below
    // `target`, since the scan stops when the last one is kept.
    let next = rank;
    while (next < end) {
      const at = next * 3;
      const source = records[at];
      const destination = records[at + 1];
      const write = shown * 3;
      out[write] = source;
      out[write + 1] = destination;
      out[write + 2] = records[at + 2];
      next++;
      shown += mask[source] & mask[destination];
      if (shown === target) break;
    }
    rank = next;
    if (shown === target) {
      return { shown, visibleCount: rank === edgeCount ? shown : null };
    }
    if (rank === edgeCount) break;
    // Compare finishing the scan with the cell walk, from the visible
    // fraction seen so far.
    const fraction = shown / rank;
    const remaining = fraction > 0
      ? Math.min(edgeCount - rank, (target - shown) / fraction)
      : edgeCount - rank;
    const scanCost = remaining;
    const walkCost = index.cellCount * COST_CELL + fraction * edgeCount * COST_VISIBLE_EDGE;
    if (walkCost < scanCost) return selectFromVisibleCells(index, mask, target, out, scratch);
    chunk *= 2;
  }
  // The whole order was read: every visible edge is shown.
  return { shown, visibleCount: shown };
}

/**
 * The cell walk: rank every visible edge from the visible cells' forward
 * adjacency, keep the `target` smallest ranks, sort them, write their
 * records. Exact visible count included.
 */
function selectFromVisibleCells(index, mask, target, out, scratch) {
  const { forwardOffsets, neighborOffsets, neighbors, cellCount, order, records } = index;
  const rankOf = order.rankOf;
  const histogram = scratch.histogram;
  // Bucket ranks by their top RADIX_BITS bits to find the K-th smallest's
  // bucket without sorting every visible edge.
  const shift = Math.max(0, order.bits - RADIX_BITS);
  histogram.fill(0);
  // Collect the visible cells' visible forward edges, then rank them: two
  // tight passes (the visibility test writes unconditionally and advances
  // by the destination's mask byte, so it does not branch on it).
  let keys = scratch.keys;
  let count = 0;
  for (let cell = 0; cell < cellCount; cell++) {
    if (mask[cell] === 0) continue;
    const start = forwardOffsets[cell];
    const end = forwardOffsets[cell + 1];
    // Its forward neighbours are the last of its neighbours.
    const destinationAt = neighborOffsets[cell + 1] - end;
    if (count + (end - start) > keys.length) {
      const grown = new Uint32Array(Math.max(1024, (count + (end - start)) * 2));
      grown.set(keys.subarray(0, count));
      keys = grown;
      scratch.keys = keys;
    }
    for (let edge = start; edge < end; edge++) {
      keys[count] = edge;
      count += mask[neighbors[destinationAt + edge]];
    }
  }
  for (let i = 0; i < count; i++) {
    const rank = rankOf(keys[i]);
    keys[i] = rank;
    histogram[rank >>> shift]++;
  }
  let kept = count;
  if (count > target) {
    let below = 0;
    let bucket = 0;
    while (below + histogram[bucket] < target) below += histogram[bucket++];
    const limit = (bucket + 1) * 2 ** shift;
    kept = 0;
    for (let i = 0; i < count; i++) {
      const rank = keys[i];
      keys[kept] = rank;
      kept += rank < limit ? 1 : 0;
    }
  }
  const sorted = sortRanks(keys, kept, order.bits, scratch);
  const shown = Math.min(kept, target);
  for (let i = 0; i < shown; i++) {
    const read = sorted[i] * 3;
    const write = i * 3;
    out[write] = records[read];
    out[write + 1] = records[read + 1];
    out[write + 2] = records[read + 2];
  }
  return { shown, visibleCount: count };
}

/** Ascending LSD radix sort of `keys[0, count)`; returns the array holding the result. */
function sortRanks(keys, count, bits, scratch) {
  if (scratch.sorted.length < count) scratch.sorted = new Uint32Array(keys.length);
  const histogram = scratch.histogram;
  let from = keys;
  let to = scratch.sorted;
  for (let shift = 0; shift < bits; shift += RADIX_BITS) {
    histogram.fill(0);
    for (let i = 0; i < count; i++) histogram[(from[i] >>> shift) & RADIX_MASK]++;
    let sum = 0;
    for (let digit = 0; digit <= RADIX_MASK; digit++) {
      const n = histogram[digit];
      histogram[digit] = sum;
      sum += n;
    }
    for (let i = 0; i < count; i++) {
      const key = from[i];
      to[histogram[(key >>> shift) & RADIX_MASK]++] = key;
    }
    const swap = from;
    from = to;
    to = swap;
  }
  return from;
}

/**
 * Count the visible edges whose source is one of cells `[cellStart,
 * cellEnd)` (sequential reads over the visible cells' forward edges; the
 * whole count is the sum over every cell).
 *
 * @param {ReturnType<typeof createConnectivityEdgeIndex>} index
 * @param {Uint8Array} mask
 * @param {number} cellStart
 * @param {number} cellEnd
 * @returns {number}
 */
export function countVisibleConnectivityEdges(index, mask, cellStart, cellEnd) {
  const { forwardOffsets, neighborOffsets, neighbors } = index;
  let count = 0;
  for (let cell = cellStart; cell < cellEnd; cell++) {
    if (mask[cell] === 0) continue;
    // Its forward neighbours are the last of its neighbours.
    const end = neighborOffsets[cell + 1];
    for (let at = end - (forwardOffsets[cell + 1] - forwardOffsets[cell]); at < end; at++) count += mask[neighbors[at]];
  }
  return count;
}
