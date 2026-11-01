/**
 * Which connectivity edges a pane shows.
 *
 * A graph can hold far more edges than a frame can usefully draw (a k = 15
 * neighbour graph has about 11 edges a cell: 110M at 10M cells), so a pane
 * shows the first K of its visible edges in one fixed random order, K being
 * the edge slider's value. An edge is visible when both its endpoints are
 * visible in that pane: shown by every filter and, with level of detail on,
 * drawn at the current level (`LodMembership`).
 *
 * **The order.** Edge `order.at(i)` is a keyed bijection of `[0, E)` (a
 * four-round Feistel network on the next power of two, cycle walking past
 * `E`), and `order.rankOf(edge)` is its inverse. Each round function is a
 * table of one half's values (`sqrt(E)` entries), so a step is four table
 * reads, and the order costs O(sqrt E) memory. Every K-prefix is a uniform
 * random sample of the edges, the same one in every session for the same
 * graph.
 *
 * **The graph.** The reader worker hands over the forward adjacency
 * (`ConnectivityEdges`, data/connectivity-edges.js): edge `e`'s destination
 * and strength by edge, each cell's edges as one range of `forwardOffsets`.
 * Nothing is stored by rank: the edge of rank `r` is `order.at(r)`, its
 * destination and strength are read by edge, and its source is the cell
 * whose range holds it, found by binary search between the sources of the
 * enclosing block of `2^SOURCE_BLOCK_BITS` edges (`blockSources`, a
 * quarter of a bit an edge). A shown record is exactly what the GPU draws (source,
 * destination, strength bits; rendering/connectivity-edge-layer.js).
 *
 * **Selection** returns the first K visible records, exactly, by whichever
 * of two walks costs less for the pane's visibility:
 *
 * - the ordered scan reads ranks from 0 until it has K visible edges, a
 *   destination's visibility first (a hidden one costs no source search):
 *   O(K / visible fraction);
 * - the visible-cell walk reads only the visible cells' forward edges,
 *   ranks the visible ones, keeps the K smallest ranks in a buffer of at
 *   most twice K (a threshold tightens as it fills) and sorts them:
 *   O(cells + visible cells' edges), whatever K is, in O(K) memory.
 *
 * The scan runs first in doubling chunks; after each chunk it estimates
 * both remaining costs from what it has seen and hands over to the cell walk
 * when that is cheaper. Both give the same records in the same order.
 *
 * **The shown-order prefix.** The records of the first 4K ranks are kept in
 * rank order (`shownOrderPrefix`, 48 bytes a shown edge, made when K is set
 * and kept across filter changes), so a pane with no hidden cell copies K of
 * them and a scan that finds its K within them (a quarter or more of the
 * edges visible) reads them sequentially, as the GPU is sent them. Records
 * are made in edge order (`writeRecords`: the ranks' edges sorted, their
 * sources found in one forward walk), so K records cost K order steps and
 * one pass, not K searches; the cell walk writes its K the same way. The
 * cell walk also yields the exact visible-edge count; after a scan, the
 * count (the slider's range) is counted over the visible cells in slices off
 * the interactive path (`countVisibleConnectivityEdges`).
 */

import { POINT_VISIBILITY_THRESHOLD } from './alpha-visibility.js';
import { requireLodMembership } from './high-perf/renderer-contracts.js';
import { isUnplacedCell, unplacedCountOf } from './unplaced-positions.js';

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
 * and, with a reduced level of detail, the cells the level draws
 * (`LodMembership`, null at full detail).
 *
 * @param {{transparency: Uint8Array, lodMembership: import('./high-perf/renderer-contracts.js').LodMembership|null}} visibility
 * @param {number} cellCount
 */
export function requireConnectivityVisibility(visibility, cellCount) {
  if (
    visibility === null ||
    typeof visibility !== 'object' ||
    !(visibility.transparency instanceof Uint8Array) ||
    visibility.transparency.length !== cellCount
  ) {
    throw new TypeError(
      'Connectivity visibility needs one transparency byte a cell.'
    );
  }
  requireLodMembership(visibility.lodMembership, {
    pointCount: cellCount,
    owner: 'Connectivity visibility level of detail',
  });
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
 * visible (then every edge is). Without LOD, and with every cell placed, the
 * transparency is the mask itself; otherwise the mask is written into
 * `scratch` (one byte a cell). A cell its embedding does not place (NaN
 * positions in `placement`, `unplaced-positions.js`) is not visible: no edge
 * counts or draws to it.
 *
 * @param {{transparency: Uint8Array, lodMembership: import('./high-perf/renderer-contracts.js').LodMembership|null}|null} visibility
 * @param {Uint8Array|null} scratch
 * @param {{positions: Float32Array, dimension: number}|null} [placement] - The
 *   pane's positions; null leaves placement out.
 * @returns {{mask: Uint8Array|null, scratch: Uint8Array|null}}
 */
export function connectivityVisibleCells(visibility, scratch, placement = null) {
  const unplaced = placement !== null && unplacedCountOf(placement.positions, placement.dimension) > 0;
  if (!unplaced) return visibility === null ? { mask: null, scratch } : visibleCellsOf(visibility, scratch);
  const { positions, dimension } = placement;
  const cellCount = positions.length / dimension;
  const mask = scratch !== null && scratch.length === cellCount ? scratch : new Uint8Array(cellCount);
  // The visible cells, in `mask`, less the unplaced ones.
  const visible = visibility === null ? null : visibleCellsOf(visibility, mask).mask;
  if (visible === null) mask.fill(1);
  else if (visible !== mask) mask.set(visible);
  for (let cell = 0; cell < cellCount; cell++) {
    if (isUnplacedCell(positions, dimension, cell)) mask[cell] = 0;
  }
  return { mask, scratch: mask };
}

/** The visible cells by transparency and level of detail (`connectivityVisibleCells`). */
function visibleCellsOf(visibility, scratch) {
  const { transparency, lodMembership } = visibility;
  const cellCount = transparency.length;
  if (lodMembership === null) {
    let every = 1;
    for (let cell = 0; cell < cellCount; cell++) every &= transparency[cell];
    return { mask: every === 1 ? null : transparency, scratch };
  }
  const mask = scratch !== null && scratch.length === cellCount ? scratch : new Uint8Array(cellCount);
  const { admissionLevels, count, lodLevel } = lodMembership;
  let every = 1;
  if (admissionLevels === null) {
    // The level draws the first `count` cells (`LodMembership`).
    for (let cell = 0; cell < count; cell++) {
      const shown = transparency[cell];
      mask[cell] = shown;
      every &= shown;
    }
    if (count < cellCount) {
      mask.fill(0, count);
      every = 0;
    }
  } else {
    for (let cell = 0; cell < cellCount; cell++) {
      const shown = transparency[cell] & (admissionLevels[cell] <= lodLevel ? 1 : 0);
      mask[cell] = shown;
      every &= shown;
    }
  }
  return { mask: every === 1 ? null : mask, scratch: mask };
}

/** Edges in one block of `blockSources`: the source search runs within one block's cells. */
const SOURCE_BLOCK_BITS = 7;

/**
 * The selection's view of one graph (`ConnectivityEdges` from the reader
 * worker): its arrays by reference, its order, and the source of every
 * `2^SOURCE_BLOCK_BITS`-th edge (`blockSources`, made here in one pass over
 * the cells: the last entry is the last cell, so every block has an end).
 *
 * @param {{forwardOffsets: Uint32Array, partners: Uint32Array, strengths: Float32Array,
 *   nEdges: number, nCells: number}} graph
 */
export function createConnectivityEdgeIndex({ forwardOffsets, partners, strengths, nEdges, nCells }) {
  if (
    !(forwardOffsets instanceof Uint32Array) ||
    !(partners instanceof Uint32Array) ||
    !(strengths instanceof Float32Array) ||
    !Number.isSafeInteger(nEdges) || nEdges < 0 ||
    !Number.isSafeInteger(nCells) || nCells <= 0 ||
    forwardOffsets.length !== nCells + 1 || forwardOffsets[nCells] !== nEdges ||
    partners.length < nEdges || strengths.length < nEdges
  ) {
    throw new TypeError(
      'Connectivity edges need Uint32 forward offsets (cells + 1, ending at the edge count), ' +
      'a Uint32 partner and a Float32 strength for every edge, and a positive cell count.'
    );
  }
  const blockCount = Math.ceil(nEdges / 2 ** SOURCE_BLOCK_BITS);
  const blockSources = new Uint32Array(blockCount + 1);
  let block = 0;
  for (let cell = 0; cell < nCells && block < blockCount; cell++) {
    const end = forwardOffsets[cell + 1];
    while (block < blockCount && block * 2 ** SOURCE_BLOCK_BITS < end) blockSources[block++] = cell;
  }
  blockSources[blockCount] = nCells - 1;
  return {
    forwardOffsets,
    partners,
    strengthBits: new Uint32Array(strengths.buffer, strengths.byteOffset, strengths.length),
    blockSources,
    edgeCount: nEdges,
    cellCount: nCells,
    order: createConnectivityEdgeOrder(nEdges),
    // The records of the first ranks, in rank order (`shownOrderPrefix`).
    prefix: { count: 0, records: new Uint32Array(0) },
  };
}

/** The source of `edge`: the last cell whose forward range starts at or before it, within its block's cells. */
function sourceOf(index, edge) {
  const { forwardOffsets, blockSources } = index;
  const block = edge >>> SOURCE_BLOCK_BITS;
  let low = blockSources[block];
  let high = blockSources[block + 1];
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (forwardOffsets[middle] <= edge) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Reusable buffers of the selection; they grow with K (the cell walk's
 * candidates, at most twice K), never with the visible edges; the edge-order
 * writer's own (`gather*`) hold at most one `WRITE_CHUNK_RANKS` chunk.
 */
export function createConnectivitySelectionScratch() {
  return {
    keys: new Uint32Array(0),
    sorted: new Uint32Array(0),
    gatherEdges: new Uint32Array(0),
    gatherSlots: new Uint32Array(0),
    gatherEdgesOut: new Uint32Array(0),
    gatherSlotsOut: new Uint32Array(0),
    histogram: new Uint32Array(1 << RADIX_BITS),
  };
}

/** The scratch's bytes and the shown-order prefix's (`describeMemory`). */
export function connectivitySelectionScratchBytes(scratch, index = null) {
  let bytes = 0;
  for (const array of Object.values(scratch)) bytes += array.byteLength;
  return bytes + (index?.prefix.records.byteLength ?? 0);
}

function growScratch(scratch, name, length) {
  if (scratch[name].length < length) scratch[name] = new Uint32Array(length);
  return scratch[name];
}

// Costs in nanoseconds, measured on the app's kernels (Apple M1 Pro,
// Node and Chromium; 10M cells, k = 15, 70M edges): a rank of the shown-order
// prefix is one sequential record; a rank past it reads its edge's order step
// and destination (a hidden destination ends there), and a visible
// destination adds the source search; the cell walk reads each cell's mask
// byte and offsets, and ranks, keeps and writes each visible edge. Only the
// ratios matter.
const COST_PREFIX_RANK = 2;
const COST_SCAN_RANK = 35;
const COST_SCAN_SOURCE = 95;
const COST_CELL = 1;
const COST_VISIBLE_EDGE = 25;
/** Ranks the scan reads before it first compares the walks; the chunk then doubles. */
const FIRST_SCAN_CHUNK = 1 << 14;
const RADIX_BITS = 12;
const RADIX_MASK = (1 << RADIX_BITS) - 1;
/**
 * The shown-order prefix holds the records of the first `PREFIX_PER_TARGET
 * * K` ranks: a scan of a pane at least a quarter of whose edges are
 * visible reads only it, sequentially (12 bytes a rank: 48 a shown edge,
 * beside the 40 a shown edge costs on the GPU).
 */
const PREFIX_PER_TARGET = 4;
/** Ranks the edge-order writer sorts at once: its buffers' size, a scheduling choice. */
const WRITE_CHUNK_RANKS = 1 << 20;

/**
 * The records of the first `count` ranks, in rank order (`index.prefix`),
 * made or extended here and kept for every pane's next selection: what the
 * GPU would be sent for them, so a scan within it is a sequential read. It
 * follows K: grown when K needs more, made anew (smaller) when it holds more
 * than twice what K needs.
 */
function shownOrderPrefix(index, count, scratch) {
  const prefix = index.prefix;
  if (prefix.count >= count && prefix.count <= 2 * count) return prefix;
  const records = new Uint32Array(count * CONNECTIVITY_RECORD_WORDS);
  const kept = Math.min(prefix.count, count);
  records.set(prefix.records.subarray(0, kept * CONNECTIVITY_RECORD_WORDS));
  writeRecords(index, null, kept, count - kept, records.subarray(kept * CONNECTIVITY_RECORD_WORDS), scratch);
  index.prefix = { count, records };
  return index.prefix;
}

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
  if (target === 0) return { shown: 0, visibleCount: mask === null ? edgeCount : null };
  const prefix = shownOrderPrefix(index, Math.min(edgeCount, PREFIX_PER_TARGET * target), scratch);
  if (mask === null) {
    out.set(prefix.records.subarray(0, target * 3));
    return { shown: target, visibleCount: edgeCount };
  }
  const { order, partners, strengthBits } = index;
  const at = order.at;
  const records = prefix.records;
  const cached = prefix.count;
  let shown = 0;
  let rank = 0;
  let sourced = 0;
  let chunk = FIRST_SCAN_CHUNK;
  while (rank < edgeCount) {
    const end = Math.min(edgeCount, rank + chunk);
    let next = rank;
    // The prefix's records, in order. Each is written to the next output
    // slot and kept by advancing past it only when both endpoints are
    // visible: no branch on the visibility, which a filter makes
    // unpredictable. Slots stay below `target`, since the scan stops when
    // the last one is kept.
    const cachedEnd = Math.min(end, cached);
    while (next < cachedEnd) {
      const read = next * 3;
      const source = records[read];
      const destination = records[read + 1];
      const write = shown * 3;
      out[write] = source;
      out[write + 1] = destination;
      out[write + 2] = records[read + 2];
      next++;
      shown += mask[source] & mask[destination];
      if (shown === target) break;
    }
    // Past it, each rank's edge: a hidden destination costs no source search.
    while (next < end && shown < target) {
      const edge = at(next++);
      const destination = partners[edge];
      if (mask[destination] === 0) continue;
      sourced++;
      const source = sourceOf(index, edge);
      if (mask[source] === 0) continue;
      const write = shown * 3;
      out[write] = source;
      out[write + 1] = destination;
      out[write + 2] = strengthBits[edge];
      shown++;
    }
    rank = next;
    if (shown === target) {
      return { shown, visibleCount: rank === edgeCount ? shown : null };
    }
    if (rank === edgeCount) break;
    // Compare finishing the scan with the cell walk, from what the scan has
    // seen so far: the visible fraction, and how often a destination is.
    const fraction = shown / rank;
    const remaining = fraction > 0
      ? Math.min(edgeCount - rank, (target - shown) / fraction)
      : edgeCount - rank;
    const inPrefix = Math.max(0, Math.min(cached - rank, remaining));
    const sourcedShare = rank > cached ? sourced / (rank - cached) : fraction;
    const scanCost = inPrefix * COST_PREFIX_RANK +
      (remaining - inPrefix) * (COST_SCAN_RANK + sourcedShare * COST_SCAN_SOURCE);
    const walkCost = index.cellCount * COST_CELL + fraction * edgeCount * COST_VISIBLE_EDGE;
    if (walkCost < scanCost) return selectFromVisibleCells(index, mask, target, out, scratch);
    chunk *= 2;
  }
  // The whole order was read: every visible edge is shown.
  return { shown, visibleCount: shown };
}

/**
 * The cell walk: rank every visible edge from the visible cells' forward
 * adjacency, keep the `target` smallest ranks (in at most twice `target`
 * slots: when they fill, the ranks past the `target`-th smallest's radix
 * bucket go and the threshold tightens), sort them, write their records.
 * Exact visible count included.
 */
function selectFromVisibleCells(index, mask, target, out, scratch) {
  const { forwardOffsets, partners, cellCount, order } = index;
  const rankOf = order.rankOf;
  const capacity = Math.max(2 * target, 1 << RADIX_BITS);
  let keys = growScratch(scratch, 'keys', capacity);
  let threshold = 2 ** order.bits;
  let kept = 0;
  let count = 0;
  for (let cell = 0; cell < cellCount; cell++) {
    if (mask[cell] === 0) continue;
    const end = forwardOffsets[cell + 1];
    for (let edge = forwardOffsets[cell]; edge < end; edge++) {
      if (mask[partners[edge]] === 0) continue;
      count++;
      const rank = rankOf(edge);
      if (rank >= threshold) continue;
      keys[kept++] = rank;
      if (kept === capacity) {
        threshold = tightenedThreshold(keys, kept, target, threshold, scratch.histogram);
        let write = 0;
        for (let i = 0; i < kept; i++) {
          const value = keys[i];
          keys[write] = value;
          write += value < threshold ? 1 : 0;
        }
        kept = write;
      }
    }
  }
  const sorted = sortRanks(keys, kept, order.bits, scratch);
  const shown = Math.min(kept, target);
  writeRecords(index, sorted, 0, shown, out, scratch);
  return { shown, visibleCount: count };
}

/**
 * A threshold below `threshold` that at least `target` of `keys[0, count)`
 * stay under while at least one does not (every key is a distinct rank below
 * `threshold`, and `count` > `target`): the upper end of the radix bucket
 * holding the `target`-th smallest, narrowed into that bucket while it holds
 * every key from it on.
 */
function tightenedThreshold(keys, count, target, threshold, histogram) {
  let low = 0;
  let high = threshold;
  // Keys below `low`: fewer than `target`.
  let below = 0;
  for (;;) {
    let width = 1;
    while ((high - low) / width > histogram.length) width *= 2;
    histogram.fill(0);
    for (let i = 0; i < count; i++) {
      const key = keys[i];
      if (key >= low) histogram[Math.floor((key - low) / width)]++;
    }
    let bucket = 0;
    while (below + histogram[bucket] < target) below += histogram[bucket++];
    const limit = low + (bucket + 1) * width;
    if (below + histogram[bucket] < count || width === 1) return limit;
    low += bucket * width;
    high = limit;
  }
}

/**
 * Write the records of `count` ranks into `out` (record `i` the edge of
 * rank `ranks[first + i]`, or of rank `first + i` when `ranks` is null), in
 * edge order, a chunk of `WRITE_CHUNK_RANKS` at a time: a chunk's edges are
 * sorted with their slots, so the sources come from one forward walk over
 * `forwardOffsets` (a gallop from the last), and the destinations and
 * strengths are read ascending.
 */
function writeRecords(index, ranks, first, count, out, scratch) {
  const { order, partners, strengthBits, forwardOffsets, cellCount } = index;
  const at = order.at;
  const size = Math.min(count, WRITE_CHUNK_RANKS);
  const edges = growScratch(scratch, 'gatherEdges', size);
  const slots = growScratch(scratch, 'gatherSlots', size);
  const edgesOut = growScratch(scratch, 'gatherEdgesOut', size);
  const slotsOut = growScratch(scratch, 'gatherSlotsOut', size);
  for (let chunkStart = 0; chunkStart < count; chunkStart += WRITE_CHUNK_RANKS) {
    const n = Math.min(WRITE_CHUNK_RANKS, count - chunkStart);
    for (let i = 0; i < n; i++) {
      const position = first + chunkStart + i;
      edges[i] = at(ranks === null ? position : ranks[position]);
      slots[i] = chunkStart + i;
    }
    const [sortedEdges, sortedSlots] = sortPairs(edges, slots, edgesOut, slotsOut, n, order.bits, scratch.histogram);
    let cell = 0;
    for (let i = 0; i < n; i++) {
      const edge = sortedEdges[i];
      if (forwardOffsets[cell + 1] <= edge) {
        // Gallop to the source: the last cell whose range starts at or before the edge.
        let low = cell + 1;
        let high = low;
        let step = 1;
        while (high < cellCount - 1 && forwardOffsets[high + 1] <= edge) {
          low = high + 1;
          high = Math.min(cellCount - 1, high + step);
          step *= 2;
        }
        while (low < high) {
          const middle = (low + high + 1) >>> 1;
          if (forwardOffsets[middle] <= edge) low = middle;
          else high = middle - 1;
        }
        cell = low;
      }
      const write = sortedSlots[i] * 3;
      out[write] = cell;
      out[write + 1] = partners[edge];
      out[write + 2] = strengthBits[edge];
    }
  }
}

/** Ascending LSD radix sort of `keys[0, count)` with their `values`; returns the arrays holding the result. */
function sortPairs(keys, values, keysOut, valuesOut, count, bits, histogram) {
  let fromKeys = keys;
  let fromValues = values;
  let toKeys = keysOut;
  let toValues = valuesOut;
  for (let shift = 0; shift < bits; shift += RADIX_BITS) {
    histogram.fill(0);
    for (let i = 0; i < count; i++) histogram[(fromKeys[i] >>> shift) & RADIX_MASK]++;
    let sum = 0;
    for (let digit = 0; digit <= RADIX_MASK; digit++) {
      const n = histogram[digit];
      histogram[digit] = sum;
      sum += n;
    }
    for (let i = 0; i < count; i++) {
      const key = fromKeys[i];
      const at = histogram[(key >>> shift) & RADIX_MASK]++;
      toKeys[at] = key;
      toValues[at] = fromValues[i];
    }
    [fromKeys, toKeys] = [toKeys, fromKeys];
    [fromValues, toValues] = [toValues, fromValues];
  }
  return [fromKeys, fromValues];
}

/** Ascending LSD radix sort of `keys[0, count)`; returns the array holding the result. */
function sortRanks(keys, count, bits, scratch) {
  const sorted = growScratch(scratch, 'sorted', keys.length);
  const histogram = scratch.histogram;
  let from = keys;
  let to = sorted;
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
  const { forwardOffsets, partners } = index;
  let count = 0;
  for (let cell = cellStart; cell < cellEnd; cell++) {
    if (mask[cell] === 0) continue;
    const end = forwardOffsets[cell + 1];
    for (let edge = forwardOffsets[cell]; edge < end; edge++) count += mask[partners[edge]];
  }
  return count;
}
