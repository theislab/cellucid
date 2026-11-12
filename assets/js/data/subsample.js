/**
 * Subsampling: which cells of a dataset a subsampled opening keeps.
 *
 * One algorithm family, specified once (docs: "Subsampling specification")
 * and implemented the same in the web app (here, run by the reader worker
 * while a dataset opens), in Python (`cellucid.subsample_cells`) and in R
 * (`cellucid_subsample_cells()`); the shared conformance fixture
 * (`tests/fixtures/subsample-conformance.json`) holds the three to the same
 * index sets. Every result is the ascending original positions of the kept
 * cells, exactly `k` of them.
 *
 * - **Rank.** A cell's rank is `fmix32(position ^ fmix32(seed ^ 0x9e3779b9))`
 *   (`rankOf`): for one seed a bijection of uint32 positions, so no two cells
 *   ever tie; selections take the lowest ranks ("bottom-k").
 * - **uniform** keeps the `k` lowest-ranked cells. Nested: with one seed the
 *   cells kept at `k` are among those kept at any larger `k`.
 * - **stratified** splits `k` over the categories of a categorical field
 *   (cells without a category are one more stratum, last) —
 *   `proportional` (largest remainder) or `balanced` (water-filling), each
 *   stratum first given `min(minPerCategory, its size)` — and keeps the
 *   lowest-ranked cells of each stratum.
 * - **blocks** cuts the cells into runs of `blockSize` neighbors in file
 *   order, ranks the runs by the same hash of their number, and keeps whole
 *   runs in rank order, the last one cut to its first cells to make exactly
 *   `k`. Nested like `uniform`. A run of neighbors is a run of storage, so
 *   a subsample reads about its share of a row-chunked array's bytes.
 * - **spatial** puts the cells of an embedding on a grid of `gridSize`
 *   boxes per axis and splits `k` over the occupied boxes as `balanced`
 *   does (cells with a non-finite coordinate are one more box, last), so
 *   sparse regions keep their cells while dense ones are thinned.
 *
 * Positions are uint32 (a dataset holds at most 2^32 - 1 cells); seeds are
 * uint32. Every method selects through one structure, a set's items in rank
 * order as far as asked (`RankedItems`): one pass over the items collects
 * the ranks below a bound expected to hold the `k` lowest, sorts them and
 * turns each back into its position by the inverse hash. Memory is
 * proportional to `k` for `uniform` and `blocks` (4 bytes a selected item,
 * nothing per cell of the file), and to `n` for `stratified` and `spatial`
 * (their input is per cell already).
 *
 * **One rank pass per opening.** An opening that resolves several sizes of
 * one subsample (a progressive opening's growth steps, `progressive-open.js`;
 * its target resolved first, then the first view, each step, and the
 * target again; a subsample grown from few chunks at every step; a raise or
 * a lowering) resolves them through one cache (`createSubsampleCache`, held
 * by the reader for the opening's life): the items ranked for the largest
 * size serve every smaller one as a prefix, a larger one adds only the
 * items between the two, and a subsample's priority order is that prefix
 * (`SubsampleCache.priorityOrder`), never sorted again. The results are the
 * functions' below, bit for bit.
 *
 * @module data/subsample
 */

import { formatCountOf } from '../utils/format-units.js';
import { fmix32, unfmix32 } from './cell-identity.js';
import { allocateLargeArray } from '../utils/large-arrays.js';
import { sortUint32 } from '../utils/radix-order.js';
import { allocateTypedArray } from './sparse-column-index.js';

/** The subsampling methods, in the order the interface offers them. */
export const SUBSAMPLE_METHODS = Object.freeze(['uniform', 'blocks', 'stratified', 'spatial']);

/** How `stratified` splits a subsample over categories. */
export const STRATIFIED_ALLOCATIONS = Object.freeze(['proportional', 'balanced']);

/** The seed a subsample uses unless one is given. */
export const DEFAULT_SUBSAMPLE_SEED = 0;

/**
 * The version of the subsampling specification this module follows: a file
 * in priority order records it (`uns['cellucid']['priority']['specVersion']`),
 * since its row order is this specification's `uniform` rank.
 */
export const SUBSAMPLE_SPEC_VERSION = 1;

/** Boxes per axis of `spatial` unless given. */
export const DEFAULT_GRID_SIZE = 32;

/**
 * The fewest cells a subsample opens in the viewer, and why. Not chosen:
 * the viewer draws an embedding only when its coordinates vary
 * (`embedding-payload.js`, "no coordinate variation"; a one-cell file is
 * refused by the same rule), and one cell's coordinates never do. The
 * control, the link and the reader's plan hold to it; selecting cells
 * (`subsampleUniform` and the others here, Python's `subsample_cells`, R's
 * `cellucid_subsample_cells()`) still keeps any count from one.
 */
export const FEWEST_OPEN_CELLS = 2;
export const FEWEST_OPEN_CELLS_REASON = 'one cell has no coordinate variation to draw';

const MAX_CELLS = 0xffffffff;

function requireUint32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CELLS) {
    throw new RangeError(`${label} must be an integer in [0, 2^32 - 1]; got ${String(value)}.`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CELLS) {
    throw new RangeError(`${label} must be an integer in [1, 2^32 - 1]; got ${String(value)}.`);
  }
  return value;
}

/** The seed's key: the value every position is XORed with before mixing. */
export function seedKey(seed) {
  return fmix32((requireUint32(seed, 'A subsample seed') ^ 0x9e3779b9) >>> 0);
}

/**
 * The rank of `position` under `seed`.
 *
 * @param {number} seed - uint32
 * @param {number} position - uint32
 * @returns {number} uint32
 */
export function rankOf(seed, position) {
  return fmix32((position ^ seedKey(seed)) >>> 0);
}

/**
 * The exact rational of a decimal text (`0.35`, `1e-3`, `12.5`): `[P, Q]`
 * as BigInts with `Q` a power of ten, or null when it is not one.
 */
function decimalRational(text) {
  const match = /^(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (match === null) return null;
  const fraction = match[2] ?? '';
  let exponent = Number(match[3] ?? 0) - fraction.length;
  let P = BigInt(match[1] + fraction);
  let Q = 1n;
  if (exponent >= 0) P *= 10n ** BigInt(exponent);
  else Q = 10n ** BigInt(-exponent);
  return [P, Q];
}

/**
 * The subsample size a share of `nObs` cells stands for, exactly: the share
 * as the rational its decimal text names (`share`, a fraction in (0, 1]: a
 * number is taken as its shortest round-trip decimal, `String(x)`, as
 * Python's `repr` and R's shortest `%.Ng` give it; `percent`: a percentage
 * text in (0, 100]), and the size `round-half-up(nObs × share)` in integer
 * arithmetic, at least 1 and at most `nObs`.
 *
 * @param {number|string} share
 * @param {number} nObs
 * @param {{percent?: boolean}} [options]
 * @returns {number}
 */
export function countFromShare(share, nObs, { percent = false } = {}) {
  requireUint32(nObs, 'A cell count');
  const text = typeof share === 'number' ? String(share) : share;
  const rational = typeof text === 'string' ? decimalRational(text) : null;
  const [P, Q] = rational ?? [0n, 1n];
  const scale = percent ? 100n : 1n;
  if (rational === null || P === 0n || P > Q * scale || (typeof share === 'number' && !Number.isFinite(share))) {
    throw new RangeError(`A subsample ${percent ? 'percentage must be in (0, 100]' : 'fraction must be in (0, 1]'}; got ${String(share)}.`);
  }
  const k = Number((2n * BigInt(nObs) * P + Q * scale) / (2n * Q * scale));
  return Math.min(nObs, Math.max(1, k));
}

/**
 * `countFromShare` of a fraction in (0, 1]: the name the specification and
 * its mirrors use (Python `count_from_fraction`, R
 * `.subsample_count_from_fraction`).
 */
export function countFromFraction(fraction, nObs) {
  return countFromShare(fraction, nObs);
}

/** The rank space: every uint32. */
const RANK_SPACE = 2 ** 32;

/**
 * Uint32 values ascending, in place (and returned): the radix sort past
 * 65,536 values (`sortUint32`, two passes over 65,536 digit counts), the
 * built-in sort below, where those counts would cost more than the values.
 */
function sortAscending(values) {
  return values.length > 65536 ? sortUint32(values) : values.sort();
}

/**
 * Distinct uint32 values below `bound`, ascending, as a new array: as a bit
 * each, then a scan of the bits, when they are at least one in 64 of the
 * values below `bound` (setting and scanning the bits then costs less than
 * the two radix passes); sorted otherwise.
 */
function ascendingCells(values, bound) {
  const k = values.length;
  if (k * 64 < bound) return sortAscending(values.slice());
  const words = allocateTypedArray(Int32Array, Math.ceil(bound / 32), 'Subsample cells');
  setBits(words, values);
  return bitsAscending(words, allocateTypedArray(Uint32Array, k, 'Subsample cells'));
}

/** Set the bit of each of `values` in `words`. */
function setBits(words, values) {
  for (let i = 0; i < values.length; i++) words[values[i] >>> 5] |= 1 << (values[i] & 31);
}

/** The set bits of `words`, ascending, into `out` (as many as are set). */
function bitsAscending(words, out) {
  let at = 0;
  for (let w = 0; w < words.length; w++) {
    let bits = words[w];
    while (bits !== 0) {
      const low = bits & -bits;
      out[at++] = w * 32 + 31 - Math.clz32(low);
      bits ^= low;
    }
  }
  return out;
}

/** Items a collecting pass ranks between checks of the room left for what it collects (`RankedItems`). */
const COLLECT_STEP = 65536;

/**
 * Rank positions `[start, end)` under `key` into `ranks` from `found`,
 * keeping those within `width` of `lower`: each rank is written and kept
 * only when in range, with no branch on it (half the ranks in range is a
 * coin toss a branch would mispredict). Returns the new count.
 */
function collectRanks(start, end, key, lower, width, ranks, found) {
  for (let i = start; i < end; i++) {
    const rank = fmix32((i ^ key) >>> 0);
    ranks[found] = rank;
    found += (((rank - lower) >>> 0) < width) | 0;
  }
  return found;
}

/** `collectRanks` of the positions `items[start..end)`. */
function collectItemRanks(items, start, end, key, lower, width, ranks, found) {
  for (let i = start; i < end; i++) {
    const rank = fmix32((items[i] ^ key) >>> 0);
    ranks[found] = rank;
    found += (((rank - lower) >>> 0) < width) | 0;
  }
  return found;
}

/** Ranks under `key` sorted, each turned back into its position (in place, returned): positions in rank order. */
function positionsByRank(ranks, key) {
  sortAscending(ranks);
  for (let i = 0; i < ranks.length; i++) ranks[i] = (unfmix32(ranks[i]) ^ key) >>> 0;
  return ranks;
}

/** `ranks` with room for `length`, its first `found` kept. */
function roomFor(ranks, found, length) {
  const larger = allocateTypedArray(Uint32Array, length, 'Subsample ranks');
  larger.set(ranks.subarray(0, found));
  return larger;
}

/**
 * The items of one set in rank order, as far as asked: `count` items, the
 * positions `0..count-1` (`items` null) or those `items` lists, each ranked
 * `fmix32(position ^ key)`. `order` holds every item whose rank is below
 * `limit`, by rank, so the `q` lowest-ranked items are `order[0..q)` once it
 * holds `q` (`ensure`): every smaller selection under one seed is a prefix
 * of a larger one, and no item is ranked twice for it.
 *
 * Asking for more scans the items once for the ranks from `limit` up to a
 * bound expected to hold the items still missing -- ranks are spread evenly
 * over the uint32 space, so the bound is the share of it they need, with
 * room for six standard deviations of their binomial count and a few items
 * more -- sorts those ranks and turns each back into its position by the
 * inverse hash (`unfmix32`): another pass follows only when the bound held
 * too few. Memory is 4 bytes a collected item, about as many as asked.
 */
class RankedItems {
  constructor(count, key, items, stats) {
    this.count = count;
    this.key = key;
    this.items = items;
    this.stats = stats;
    /** Whether the items can still be scanned (a stratum's are let go once ranked, `release`). */
    this.scannable = true;
    this.order = new Uint32Array(0);
    this.limit = 0;
  }

  /** Whether the `q` lowest-ranked items are held. */
  holds(q) {
    return this.order.length >= Math.min(q, this.count);
  }

  /** The items in rank order, at least the `q` lowest-ranked (all of them when `q` is at least their count). */
  ensure(q) {
    const want = Math.min(q, this.count);
    while (this.order.length < want) {
      if (!this.scannable) throw new Error('A stratum let go of its cells holds too few of them in rank order.');
      this._collect(want);
    }
    return this.order;
  }

  /** Every item, in rank order, held from now on (`priorityPositions`' computed order of a priority-ordered file). */
  adopt(order) {
    if (order.length !== this.count) throw new RangeError(`A rank order of ${formatCountOf(order.length, 'item')} is not one of ${formatCountOf(this.count, 'item')}.`);
    this.order = order;
    this.limit = RANK_SPACE;
  }

  /** The items are let go: what is held stays, nothing more can be collected. */
  release() {
    this.items = null;
    this.scannable = false;
  }

  _collect(want) {
    const { count, key, items, stats } = this;
    const have = this.order.length;
    const left = count - have;
    const need = want - have;
    const lower = this.limit;
    const span = RANK_SPACE - lower;
    const room = need + 6 * Math.sqrt(need) + 64;
    const upper = room >= left ? RANK_SPACE : Math.min(RANK_SPACE, lower + Math.ceil((span * room) / left));
    const width = upper - lower;
    const expected = (left * width) / span;
    let ranks = allocateTypedArray(Uint32Array, Math.min(count, Math.ceil(expected + 8 * Math.sqrt(expected) + 64) + COLLECT_STEP), 'Subsample ranks');
    let found = 0;
    stats.passes++;
    stats.ranked += count;
    // Every rank is written, kept when in range (`collectRanks`), so each
    // step of items first makes room for all of them.
    for (let start = 0; start < count; start += COLLECT_STEP) {
      const end = Math.min(count, start + COLLECT_STEP);
      if (ranks.length - found < end - start) ranks = roomFor(ranks, found, Math.min(found + count - start, Math.max(ranks.length * 2, found + COLLECT_STEP)));
      found = items === null
        ? collectRanks(start, end, key, lower, width, ranks, found)
        : collectItemRanks(items, start, end, key, lower, width, ranks, found);
    }
    // Each long loop is a function of its own (`collectRanks`,
    // `positionsByRank`), optimized on its own: none runs on in a slower tier
    // when this one is.
    const collected = positionsByRank(ranks.subarray(0, found), key);
    if (have === 0) {
      this.order = found === ranks.length ? ranks : ranks.slice(0, found);
    } else {
      const order = allocateTypedArray(Uint32Array, have + found, 'Subsample order');
      order.set(this.order);
      order.set(collected, have);
      this.order = order;
    }
    this.limit = upper;
  }
}

/**
 * Every position `0..nObs-1` in rank order under `seed`: a priority-ordered
 * file's row order (`priority-layout.js` `priorityPositions`).
 *
 * @param {number} nObs
 * @param {number} seed
 * @returns {Uint32Array}
 */
export function rankOrder(nObs, seed) {
  requireUint32(nObs, 'A cell count');
  return new RankedItems(nObs, seedKey(seed), null, { passes: 0, ranked: 0 }).ensure(nObs);
}

/**
 * `uniform`: the `k` lowest-ranked of `nObs` cells.
 *
 * @param {number} nObs
 * @param {number} k
 * @param {number} seed
 * @returns {Uint32Array|null} Ascending positions; null when `k >= nObs` (every cell)
 */
export function subsampleUniform(nObs, k, seed) {
  return createSubsampleCache().uniform(nObs, k, seed);
}

/**
 * `blocks`: whole runs of `blockSize` neighboring cells in rank order of
 * their run number, the last one cut to its first cells.
 *
 * @param {number} nObs
 * @param {number} k
 * @param {number} seed
 * @param {number} blockSize
 * @returns {Uint32Array|null}
 */
export function subsampleBlocks(nObs, k, seed, blockSize) {
  return createSubsampleCache().blocks(nObs, k, seed, blockSize);
}

/**
 * The `blocks` subsample of `k` cells (`subsampleBlocks`) as its runs of
 * neighboring cells, `[starts[r], ends[r])` ascending and apart (blocks
 * next to one another make one run): what a price of its rows needs
 * (`subsample-plan.js` `rowChunks`), in a step a block, not a cell.
 *
 * @param {number} nObs
 * @param {number} k
 * @param {number} seed
 * @param {number} blockSize
 * @returns {{count: number, starts: Float64Array, ends: Float64Array}|null} Null when `k >= nObs` (every cell)
 */
export function subsampleBlockRuns(nObs, k, seed, blockSize) {
  return createSubsampleCache().blockRuns(nObs, k, seed, blockSize);
}

/**
 * Every cell of `nObs` in the priority order of the `blocks` subsample of
 * all of them: `priorityOrder({method: 'blocks', seed, blockSize}, every
 * cell)`, made a block at a time (no list of every cell to order first).
 *
 * @param {number} nObs
 * @param {number} seed
 * @param {number} blockSize
 * @returns {Uint32Array}
 */
export function blocksPriorityOrder(nObs, seed, blockSize) {
  return createSubsampleCache().blocksPriorityOrder(nObs, seed, blockSize);
}

/** Multiply two uint32 values and divide by a third, exactly: `[floor(a*b/c), (a*b) mod c]`. */
function mulDiv(a, b, c) {
  const product = a * b;
  if (product <= Number.MAX_SAFE_INTEGER) return [Math.floor(product / c), product % c];
  const big = BigInt(a) * BigInt(b);
  const divisor = BigInt(c);
  return [Number(big / divisor), Number(big % divisor)];
}

/**
 * Split `total` over strata of `capacity` cells each (every one non-zero,
 * `total` at most their sum).
 *
 * - `proportional`: `floor(total * capacity / sum)` each, then one more to
 *   the strata of the largest remainders, ties to the earlier stratum.
 * - `balanced`: the highest level `L` with `sum(min(capacity, L)) <= total`,
 *   then one more to the earliest strata holding more than `L`.
 *
 * @param {Float64Array} capacity
 * @param {number} total
 * @param {'proportional'|'balanced'} allocation
 * @returns {Float64Array}
 */
export function allocate(capacity, total, allocation) {
  const strata = capacity.length;
  const out = allocateTypedArray(Float64Array, strata, 'Subsample quotas');
  if (total === 0 || strata === 0) return out;
  let sum = 0;
  for (let s = 0; s < strata; s++) sum += capacity[s];
  if (total > sum) throw new RangeError(`Cannot allocate ${formatCountOf(total, 'cell')} over ${sum}.`);
  if (allocation === 'proportional') {
    const remainder = allocateTypedArray(Float64Array, strata, 'Subsample quota remainders');
    let given = 0;
    for (let s = 0; s < strata; s++) {
      const [quotient, rest] = mulDiv(total, capacity[s], sum);
      out[s] = quotient;
      remainder[s] = rest;
      given += quotient;
    }
    const order = Array.from({ length: strata }, (_, s) => s)
      .sort((x, y) => remainder[y] - remainder[x] || x - y);
    for (let i = 0; i < total - given; i++) out[order[i]]++;
    return out;
  }
  if (allocation !== 'balanced') throw new RangeError(`Unknown allocation '${String(allocation)}'.`);
  // Water-filling: raise the level through the sorted capacities.
  const sorted = Float64Array.from(capacity).sort();
  let level = 0;
  let used = 0;
  let remaining = strata;
  for (let i = 0; i < strata; i++) {
    const step = sorted[i] - level;
    if (used + step * remaining > total) break;
    used += step * remaining;
    level = sorted[i];
    remaining--;
  }
  if (remaining > 0) {
    const raise = Math.floor((total - used) / remaining);
    level += raise;
  }
  let given = 0;
  for (let s = 0; s < strata; s++) {
    out[s] = Math.min(capacity[s], level);
    given += out[s];
  }
  for (let s = 0; s < strata && given < total; s++) {
    if (capacity[s] > level) {
      out[s]++;
      given++;
    }
  }
  return out;
}

/**
 * The cells of every stratum `s` (`strata[cell]` in `0..sizes.length-1`,
 * `sizes[s]` of them) in rank order under `key`, each as far as `quota[s]`
 * (`RankedItems`, one pass over the stratum's cells): what `strataCells`
 * selects from, and selects any smaller quotas from again. The cells of a
 * stratum are let go once ranked.
 */
function rankedStrata(strata, sizes, quota, key, stats) {
  const n = strata.length;
  const nStrata = sizes.length;
  // Cells grouped by stratum (counting sort).
  const start = allocateTypedArray(Float64Array, nStrata + 1, 'Subsample stratum starts');
  for (let s = 0; s < nStrata; s++) start[s + 1] = start[s] + sizes[s];
  const grouped = allocateTypedArray(Uint32Array, n, 'Subsample cells by stratum');
  const fill = start.slice(0, nStrata);
  for (let cell = 0; cell < n; cell++) grouped[fill[strata[cell]]++] = cell;
  const ranked = new Array(nStrata);
  for (let s = 0; s < nStrata; s++) {
    ranked[s] = new RankedItems(sizes[s], key, grouped.subarray(start[s], start[s + 1]), stats);
    if (quota[s] > 0) ranked[s].ensure(quota[s]);
    ranked[s].release();
  }
  return ranked;
}

/** The `quota[s]` lowest-ranked cells of every stratum (`rankedStrata`), ascending; null when one holds too few of them. */
function strataCells(ranked, quota, nObs) {
  let total = 0;
  for (let s = 0; s < ranked.length; s++) {
    if (quota[s] > 0 && !ranked[s].holds(quota[s])) return null;
    total += quota[s];
  }
  const out = allocateTypedArray(Uint32Array, total, 'Subsample cells');
  let at = 0;
  for (let s = 0; s < ranked.length; s++) {
    if (quota[s] === 0) continue;
    out.set(ranked[s].order.subarray(0, quota[s]), at);
    at += quota[s];
  }
  return ascendingCells(out, nObs);
}

/**
 * `stratified`: `k` cells split over the categories of a field.
 *
 * @param {ArrayLike<number>} codes - One per cell: its category, `0..nCategories-1`, or negative / NaN for none
 * @param {number} nCategories
 * @param {number} k
 * @param {number} seed
 * @param {{allocation?: 'proportional'|'balanced', minPerCategory?: number}} [options]
 * @returns {Uint32Array|null}
 */
export function subsampleStratified(codes, nCategories, k, seed, options = {}) {
  return createSubsampleCache().stratified(null, codes, nCategories, k, seed, options);
}

/** Each cell's stratum of a `stratified` subsample (cells without a category last) and each stratum's size. */
function categoryStrata(codes, nCategories) {
  const nObs = codes.length;
  const strata = allocateTypedArray(Uint32Array, nObs, 'Subsample strata');
  const sizes = allocateTypedArray(Float64Array, nCategories + 1, 'Subsample stratum sizes');
  for (let cell = 0; cell < nObs; cell++) {
    const code = codes[cell];
    const stratum = code >= 0 && code < nCategories ? code : nCategories;
    if (!(Number.isInteger(code) || Number.isNaN(code)) || code >= nCategories) {
      throw new RangeError(`Category code ${String(code)} of cell ${cell} is outside the ${formatCountOf(nCategories, 'category', 'categories')}.`);
    }
    strata[cell] = stratum;
    sizes[stratum]++;
  }
  return { strata, sizes };
}

/** How many cells of each stratum (`sizes`) a subsample of `k` keeps: `min(minimum, size)` each, the rest split by `allocation`. */
function stratumQuotas(sizes, k, allocation, minimum) {
  // Only occupied strata take part, in stratum order.
  const occupied = [];
  for (let s = 0; s < sizes.length; s++) if (sizes[s] > 0) occupied.push(s);
  const base = allocateTypedArray(Float64Array, occupied.length, 'Subsample quotas');
  const capacity = allocateTypedArray(Float64Array, occupied.length, 'Subsample stratum capacities');
  let floor = 0;
  occupied.forEach((s, i) => {
    base[i] = Math.min(minimum, sizes[s]);
    capacity[i] = sizes[s] - base[i];
    floor += base[i];
  });
  if (floor > k) {
    throw new RangeError(
      `A subsample of ${formatCountOf(k, 'cell')} cannot hold ${formatCountOf(minimum, 'cell')} of each of ${formatCountOf(occupied.length, 'category', 'categories')} (${formatCountOf(floor, 'cell')}).`
    );
  }
  const extra = allocate(capacity.filter(c => c > 0), k - floor, allocation);
  const quota = allocateTypedArray(Float64Array, sizes.length, 'Subsample quotas');
  let e = 0;
  occupied.forEach((s, i) => {
    quota[s] = base[i] + (capacity[i] > 0 ? extra[e++] : 0);
  });
  return quota;
}

/**
 * The grid box of each cell of an embedding (`spatial`): per axis
 * `floor((x - min) * gridSize / (max - min))` in binary64 over the float32
 * coordinates, `gridSize - 1` at the maximum, 0 on an axis of one value;
 * the box is `b0 + gridSize * b1 + gridSize^2 * b2`. A cell with a
 * non-finite coordinate is in box `gridSize^dimensions` (after every box).
 *
 * @param {ArrayLike<number>} coordinates - Row-major, `dimensions` per cell
 * @param {number} dimensions - 1, 2 or 3
 * @param {number} gridSize
 * @returns {{boxes: Float64Array, nBoxes: number}}
 */
export function gridBoxes(coordinates, dimensions, gridSize) {
  if (![1, 2, 3].includes(dimensions)) throw new RangeError('A spatial subsample needs a 1-, 2- or 3-dimensional embedding.');
  requirePositiveInteger(gridSize, 'A grid size');
  if (gridSize ** dimensions >= 2 ** 53) throw new RangeError(`A grid of ${gridSize} boxes per axis has more boxes than are numbered exactly.`);
  if (coordinates.length % dimensions !== 0) throw new RangeError('Embedding coordinates must be whole rows.');
  const n = coordinates.length / dimensions;
  const values = coordinates instanceof Float32Array ? coordinates : allocateLargeArray(Float32Array, coordinates.length);
  if (values !== coordinates) values.set(coordinates);
  const placed = allocateTypedArray(Uint8Array, n, 'Subsample placed cells');
  const min = new Array(dimensions).fill(Infinity);
  const max = new Array(dimensions).fill(-Infinity);
  for (let cell = 0; cell < n; cell++) {
    let finite = true;
    for (let d = 0; d < dimensions; d++) if (!Number.isFinite(values[cell * dimensions + d])) finite = false;
    if (!finite) continue;
    placed[cell] = 1;
    for (let d = 0; d < dimensions; d++) {
      const x = values[cell * dimensions + d];
      if (x < min[d]) min[d] = x;
      if (x > max[d]) max[d] = x;
    }
  }
  const unplaced = gridSize ** dimensions;
  const boxes = allocateTypedArray(Float64Array, n, 'Subsample grid boxes');
  for (let cell = 0; cell < n; cell++) {
    if (placed[cell] === 0) {
      boxes[cell] = unplaced;
      continue;
    }
    let box = 0;
    let scale = 1;
    for (let d = 0; d < dimensions; d++) {
      const width = max[d] - min[d];
      let b = 0;
      if (width > 0) {
        const offset = values[cell * dimensions + d] - min[d];
        const scaled = offset * gridSize;
        b = Math.floor(scaled / width);
        if (b > gridSize - 1) b = gridSize - 1;
      }
      box += b * scale;
      scale *= gridSize;
    }
    boxes[cell] = box;
  }
  return { boxes, nBoxes: unplaced + 1 };
}

/**
 * `spatial`: `k` cells split as `balanced` over the occupied boxes of a grid
 * over an embedding.
 *
 * @param {ArrayLike<number>} coordinates - Row-major float32 values, `dimensions` per cell
 * @param {number} dimensions
 * @param {number} k
 * @param {number} seed
 * @param {{gridSize?: number}} [options]
 * @returns {Uint32Array|null}
 */
export function subsampleSpatial(coordinates, dimensions, k, seed, options = {}) {
  return createSubsampleCache().spatial(null, coordinates, dimensions, k, seed, options);
}

/** Each cell's stratum of a `spatial` subsample (its occupied grid box, renumbered densely in box order) and each stratum's size. */
function gridStrata(boxes) {
  const nObs = boxes.length;
  const occupiedBoxes = new Set(boxes);
  const order = allocateTypedArray(Float64Array, occupiedBoxes.size, 'Subsample grid boxes');
  let box = 0;
  for (const value of occupiedBoxes) order[box++] = value;
  order.sort();
  const dense = new Map();
  order.forEach((box, i) => dense.set(box, i));
  const strata = allocateTypedArray(Uint32Array, nObs, 'Subsample strata');
  const sizes = allocateTypedArray(Float64Array, order.length, 'Subsample stratum sizes');
  for (let cell = 0; cell < nObs; cell++) {
    const s = dense.get(boxes[cell]);
    strata[cell] = s;
    sizes[s]++;
  }
  return { strata, sizes };
}

/**
 * `items` reordered by their uint32 `keys` ascending (no two equal), in two
 * passes of 16 bits: time proportional to the items, whatever their count.
 *
 * @param {Uint32Array} items
 * @param {Uint32Array} keys - One per item
 * @returns {Uint32Array}
 */
function sortedByKey(items, keys) {
  const n = items.length;
  let from = allocateTypedArray(Uint32Array, n, 'Subsample order');
  for (let i = 0; i < n; i++) from[i] = i;
  let to = allocateTypedArray(Uint32Array, n, 'Subsample order');
  for (const shift of [0, 16]) {
    const starts = new Uint32Array(65537);
    for (let i = 0; i < n; i++) starts[((keys[i] >>> shift) & 0xffff) + 1]++;
    for (let b = 1; b <= 65536; b++) starts[b] += starts[b - 1];
    for (let i = 0; i < n; i++) {
      const item = from[i];
      to[starts[(keys[item] >>> shift) & 0xffff]++] = item;
    }
    [from, to] = [to, from];
  }
  const out = allocateTypedArray(Uint32Array, n, 'Subsample order');
  for (let i = 0; i < n; i++) out[i] = items[from[i]];
  return out;
}

/**
 * The kept cells of a subsample in the order its method takes them: its
 * **priority order**. `blocks` takes whole runs in the rank order of their
 * number, cells in file order within a run (the last run cut to its first
 * cells); every other method takes cells by rank under its seed (`rankOf`).
 *
 * The first `m` cells of this order are always a sample of the same kind
 * at size `m`: for `uniform` and `blocks` exactly the subsample of size `m`
 * under the same seed (they are nested), for `stratified` and `spatial` a
 * uniform sample of the cells they kept. So an opening read in this order
 * is a valid sample at every moment, and a larger subsample with the same
 * method and seed extends a smaller one by appending.
 *
 * @param {Readonly<SubsampleSpec>} spec
 * @param {Uint32Array} kept - Ascending original positions (`keptCellsOf`)
 * @returns {Uint32Array} The same positions, in priority order
 */
export function priorityOrder(spec, kept) {
  const key = seedKey(spec.seed);
  if (spec.method !== 'blocks') {
    // The ranks sorted, each turned back into its position (no two cells share a rank).
    const ranks = allocateTypedArray(Uint32Array, kept.length, 'Subsample order');
    for (let i = 0; i < kept.length; i++) ranks[i] = fmix32((kept[i] ^ key) >>> 0);
    return positionsByRank(ranks, key);
  }
  // Runs of kept cells of one block, each block's rank, then the runs in rank order.
  const blockSize = spec.blockSize;
  const firsts = [];
  for (let i = 0; i < kept.length; i++) {
    if (i === 0 || Math.floor(kept[i] / blockSize) !== Math.floor(kept[i - 1] / blockSize)) firsts.push(i);
  }
  const runs = Uint32Array.from(firsts.keys());
  const ranks = Uint32Array.from(firsts, i => fmix32((Math.floor(kept[i] / blockSize) ^ key) >>> 0));
  const out = allocateTypedArray(Uint32Array, kept.length, 'Subsample order');
  let at = 0;
  for (const run of sortedByKey(runs, ranks)) {
    const end = run + 1 < firsts.length ? firsts[run + 1] : kept.length;
    for (let i = firsts[run]; i < end; i++) out[at++] = kept[i];
  }
  return out;
}

/**
 * The cells of the `blocks` subsample of `k` of `nObs` cells in its priority
 * order: whole blocks in rank order (`blocks`, the blocks' rank order as far
 * as it reaches), each block's cells in file order, the last cut to its
 * first cells.
 */
function blocksInRankOrder(nObs, k, blockSize, blocks) {
  const out = allocateTypedArray(Uint32Array, k, 'Subsample order');
  let at = 0;
  for (let r = 0; at < k; r++) {
    const start = blocks[r] * blockSize;
    const end = start + Math.min(blockSize, nObs - start, k - at);
    for (let row = start; row < end; row++) out[at++] = row;
  }
  return out;
}

/**
 * A cache of the subsamples one opening resolves (module doc, "One rank
 * pass per opening"): each method's items in rank order (`RankedItems`) per
 * cell count, seed and settings, as far as the largest size asked. The
 * reader holds one for the opening's life, its later openings of the same
 * bytes (growth steps, Apply) take it over (`AnnDataReader.open`, `carry`),
 * and it goes when the reader closes. Its results are those of
 * `subsampleUniform`, `subsampleBlocks`, `subsampleBlockRuns`,
 * `blocksPriorityOrder`, `subsampleStratified` and `subsampleSpatial`, bit
 * for bit (each of those is this cache's, used once), and its priority
 * order of a selection it made is `priorityOrder`'s.
 *
 * Memory is what the largest size asked needs (4 bytes a ranked item), as
 * for one selection of that size: nothing per cell of the file is kept for
 * `uniform` and `blocks` (a uniform priority order handed out is a view of
 * the ranked items, not a copy), and a stratum's cells are let go once
 * ranked (a `stratified` or `spatial` size reaching past what was ranked
 * reads its field or embedding again, `heldStrata`).
 *
 * @returns {SubsampleCache}
 */
export function createSubsampleCache() {
  return new SubsampleCache();
}

class SubsampleCache {
  constructor() {
    /**
     * `passes`: scans over every item of a set (the cells of `uniform`, the
     * blocks of `blocks`, a stratum's cells); `ranked`: the ranks they
     * computed. What a growth costs in rank passes, for tests.
     */
    this.stats = { passes: 0, ranked: 0 };
    this._sets = new Map();
    this._strata = new Map();
    /** What each selection returned here was made from, so its priority order is a prefix (`priorityOrder`). */
    this._made = new WeakMap();
  }

  /**
   * The buffers of what this cache holds (every set's rank order and items,
   * the selections and orders it handed out, every stratum's), each once:
   * a holder of the same arrays (the open cells' rows) counts their union.
   *
   * @returns {Set<ArrayBufferLike>}
   */
  buffers() {
    const held = new Set();
    const add = array => {
      if (ArrayBuffer.isView(array) && array.byteLength > 0) held.add(array.buffer);
    };
    for (const set of this._sets.values()) {
      add(set.order);
      add(set.items);
      add(set.ascending?.kept);
      add(set.ordered?.order);
    }
    for (const { ranked } of this._strata.values()) {
      for (const stratum of ranked) {
        add(stratum.order);
        add(stratum.items);
      }
    }
    return held;
  }

  _set(name, count, key) {
    let set = this._sets.get(name);
    if (set === undefined) {
      set = new RankedItems(count, key, null, this.stats);
      /** The last ascending selection (`uniform`). */
      set.ascending = null;
      /** The last priority order handed out: the same size asked again gets the same array. */
      set.ordered = null;
      this._sets.set(name, set);
    }
    return set;
  }

  /**
   * Every cell of a priority-ordered file in its seed's order, as computed
   * for it (`priority-layout.js` `priorityPositions`): its `uniform`
   * subsamples under that seed are its prefixes, nothing ranked again.
   *
   * @param {number} nObs
   * @param {number} seed
   * @param {Uint32Array} order
   */
  adoptRankOrder(nObs, seed, order) {
    const set = this._set(`uniform:${nObs}:${seed}`, nObs, seedKey(seed));
    if (set.order.length < nObs) set.adopt(order);
  }

  /** `subsampleUniform`. */
  uniform(nObs, k, seed) {
    requireUint32(nObs, 'A cell count');
    requirePositiveInteger(k, 'A subsample size');
    if (k >= nObs) return null;
    const set = this._set(`uniform:${nObs}:${seed}`, nObs, seedKey(seed));
    // The same size asked again (a growth's target, resolved first and
    // again at its last step; each step of a growth from few chunks) is the
    // same array.
    if (set.ascending?.k === k) return set.ascending.kept;
    const kept = ascendingCells(set.ensure(k).subarray(0, k), nObs);
    set.ascending = { k, kept };
    this._made.set(kept, { method: 'uniform', seed, set, k });
    return kept;
  }

  /** The blocks of the `blocks` subsample of `k` cells in rank order, how many it takes, and the cells it takes of the last. */
  _chosenBlocks(nObs, k, seed, blockSize) {
    requireUint32(nObs, 'A cell count');
    requirePositiveInteger(k, 'A subsample size');
    requirePositiveInteger(blockSize, 'A block size');
    if (k >= nObs) return null;
    const blocks = Math.ceil(nObs / blockSize);
    const set = this._set(`blocks:${nObs}:${seed}:${blockSize}`, blocks, seedKey(seed));
    // Every block holds `blockSize` cells but the last; the blocks of the
    // lowest ranks cover `k` cells within one block more than `k / blockSize`.
    const order = set.ensure(Math.min(blocks, Math.ceil(k / blockSize) + 1));
    let left = k;
    let taken = 0;
    let last = 0;
    while (left > 0) {
      last = Math.min(blockSize, nObs - order[taken] * blockSize, left);
      left -= last;
      taken++;
    }
    return { set, order, taken, last };
  }

  /** `subsampleBlockRuns`. */
  blockRuns(nObs, k, seed, blockSize) {
    const chosen = this._chosenBlocks(nObs, k, seed, blockSize);
    if (chosen === null) return null;
    const { order, taken, last } = chosen;
    const cut = order[taken - 1];
    const numbers = ascendingCells(order.subarray(0, taken), Math.ceil(nObs / blockSize));
    const starts = allocateTypedArray(Float64Array, taken, 'Subsample runs');
    const ends = allocateTypedArray(Float64Array, taken, 'Subsample runs');
    let count = 0;
    for (let i = 0; i < taken; i++) {
      const start = numbers[i] * blockSize;
      const end = start + (numbers[i] === cut ? last : Math.min(blockSize, nObs - start));
      if (count > 0 && ends[count - 1] === start) ends[count - 1] = end;
      else {
        starts[count] = start;
        ends[count++] = end;
      }
    }
    return { count, starts: starts.slice(0, count), ends: ends.slice(0, count) };
  }

  /** `subsampleBlocks`. */
  blocks(nObs, k, seed, blockSize) {
    const runs = this.blockRuns(nObs, k, seed, blockSize);
    if (runs === null) return null;
    const out = allocateTypedArray(Uint32Array, k, 'Subsample cells');
    let at = 0;
    for (let r = 0; r < runs.count; r++) for (let row = runs.starts[r]; row < runs.ends[r]; row++) out[at++] = row;
    this._made.set(out, { method: 'blocks', seed, blockSize, nObs, set: this._sets.get(`blocks:${nObs}:${seed}:${blockSize}`), k });
    return out;
  }

  /** `blocksPriorityOrder`. */
  blocksPriorityOrder(nObs, seed, blockSize) {
    requireUint32(nObs, 'A cell count');
    requirePositiveInteger(blockSize, 'A block size');
    const blocks = Math.ceil(nObs / blockSize);
    const set = this._set(`blocks:${nObs}:${seed}:${blockSize}`, blocks, seedKey(seed));
    return blocksInRankOrder(nObs, nObs, blockSize, set.ensure(blocks));
  }

  /**
   * `priorityOrder`: of a subsample this cache selected (`uniform`,
   * `blocks`), the prefix of its rank order, nothing sorted; of any other
   * cells, `priorityOrder`'s.
   *
   * @param {Readonly<SubsampleSpec>} spec
   * @param {Uint32Array} kept
   * @returns {Uint32Array}
   */
  priorityOrder(spec, kept) {
    const made = this._made.get(kept);
    if (made === undefined || made.method !== spec.method || made.seed !== spec.seed || (made.method === 'blocks' && made.blockSize !== spec.blockSize)) {
      return priorityOrder(spec, kept);
    }
    const { set, k } = made;
    if (set.ordered?.k === k) return set.ordered.order;
    // A uniform order is a view of the ranked items (they are only ever
    // appended to, in a new array): no copy of it is held twice.
    const order = made.method === 'uniform' ? set.order.subarray(0, k) : blocksInRankOrder(made.nObs, k, made.blockSize, set.order);
    set.ordered = { k, order };
    return order;
  }

  /**
   * `subsampleStratified`; `name` files its strata in the cache for later
   * sizes (`heldStrata`), null files nothing.
   */
  stratified(name, codes, nCategories, k, seed, { allocation = 'proportional', minPerCategory = 0 } = {}) {
    const nObs = requireUint32(codes.length, 'A cell count');
    requirePositiveInteger(k, 'A subsample size');
    requireUint32(nCategories, 'A category count');
    requireUint32(minPerCategory, 'A minimum per category');
    if (!STRATIFIED_ALLOCATIONS.includes(allocation)) throw new RangeError(`Unknown allocation '${String(allocation)}'.`);
    if (k >= nObs) return null;
    const { strata, sizes } = categoryStrata(codes, nCategories);
    return this._strataSelection(name, strata, sizes, k, seed, allocation, minPerCategory);
  }

  /** `subsampleSpatial`; `name` as for `stratified`. */
  spatial(name, coordinates, dimensions, k, seed, { gridSize = DEFAULT_GRID_SIZE } = {}) {
    requirePositiveInteger(k, 'A subsample size');
    const { boxes } = gridBoxes(coordinates, dimensions, gridSize);
    const nObs = requireUint32(boxes.length, 'A cell count');
    if (k >= nObs) return null;
    const { strata, sizes } = gridStrata(boxes);
    return this._strataSelection(name, strata, sizes, k, seed, 'balanced', 0);
  }

  _strataSelection(name, strata, sizes, k, seed, allocation, minimum) {
    const quota = stratumQuotas(sizes, k, allocation, minimum);
    const ranked = rankedStrata(strata, sizes, quota, seedKey(seed), this.stats);
    if (name !== null) this._strata.set(name, { nObs: strata.length, sizes, ranked });
    return strataCells(ranked, quota, strata.length);
  }

  /**
   * A `stratified` or `spatial` subsample of `k` cells from the strata filed
   * under `name` (their sizes and each one's cells ranked so far), nothing
   * read or ranked; null when none are filed or one holds too few ranked
   * cells (then its field or embedding is read again, `stratified`,
   * `spatial`).
   *
   * @param {string} name
   * @param {number} k
   * @param {'proportional'|'balanced'} allocation
   * @param {number} minimum
   * @returns {Uint32Array|null}
   */
  heldStrata(name, k, allocation, minimum) {
    const entry = this._strata.get(name);
    if (entry === undefined) return null;
    return strataCells(entry.ranked, stratumQuotas(entry.sizes, k, allocation, minimum), entry.nObs);
  }
}

/**
 * A subsample specification, checked and complete: what a session records
 * and what the reader resolves. `nObs` and `k` are exact counts.
 *
 * @typedef {Object} SubsampleSpec
 * @property {'uniform'|'blocks'|'stratified'|'spatial'} method
 * @property {number} nObs
 * @property {number} k
 * @property {number} seed
 * @property {number} [blockSize] - `blocks`
 * @property {string} [field] - `stratified`: the obs field
 * @property {'proportional'|'balanced'} [allocation] - `stratified`
 * @property {number} [minPerCategory] - `stratified`
 * @property {string} [embedding] - `spatial`: the obsm key
 * @property {number[]} [columns] - `spatial`: the embedding's columns
 * @property {number} [gridSize] - `spatial`
 */

const SPEC_KEYS = {
  uniform: [],
  blocks: ['blockSize'],
  stratified: ['field', 'allocation', 'minPerCategory'],
  spatial: ['embedding', 'columns', 'gridSize'],
};

/**
 * Check a subsample specification: exactly the keys of its method, every
 * count exact. Returns a frozen copy.
 *
 * @param {unknown} spec
 * @returns {Readonly<SubsampleSpec>}
 */
export function requireSubsampleSpec(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new TypeError('A subsample specification must be an object.');
  const method = spec.method;
  if (!SUBSAMPLE_METHODS.includes(method)) throw new RangeError(`Unknown subsample method '${String(method)}'.`);
  const allowed = ['method', 'nObs', 'k', 'seed', ...SPEC_KEYS[method]];
  for (const key of Object.keys(spec)) {
    if (!allowed.includes(key)) throw new TypeError(`A '${method}' subsample has no '${key}'.`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(spec, key)) throw new TypeError(`A '${method}' subsample needs '${key}'.`);
  }
  const out = { method, nObs: requireUint32(spec.nObs, 'A subsample cell count'), k: requirePositiveInteger(spec.k, 'A subsample size'), seed: requireUint32(spec.seed, 'A subsample seed') };
  if (out.k >= out.nObs) throw new RangeError(`A subsample of ${out.k} of ${formatCountOf(out.nObs, 'cell')} keeps every cell; it is no subsample.`);
  if (method === 'blocks') out.blockSize = requirePositiveInteger(spec.blockSize, 'A block size');
  if (method === 'stratified') {
    if (typeof spec.field !== 'string' || spec.field === '') throw new TypeError('A stratified subsample names its obs field.');
    if (!STRATIFIED_ALLOCATIONS.includes(spec.allocation)) throw new RangeError(`Unknown allocation '${String(spec.allocation)}'.`);
    out.field = spec.field;
    out.allocation = spec.allocation;
    out.minPerCategory = requireUint32(spec.minPerCategory, 'A minimum per category');
  }
  if (method === 'spatial') {
    if (typeof spec.embedding !== 'string' || spec.embedding === '') throw new TypeError('A spatial subsample names its embedding.');
    if (!Array.isArray(spec.columns) || spec.columns.length < 1 || spec.columns.length > 3 ||
        !spec.columns.every(c => Number.isSafeInteger(c) && c >= 0)) {
      throw new TypeError('A spatial subsample names one to three embedding columns.');
    }
    out.embedding = spec.embedding;
    out.columns = Object.freeze([...spec.columns]);
    out.gridSize = requirePositiveInteger(spec.gridSize, 'A grid size');
  }
  return Object.freeze(out);
}

/**
 * Short words for how a subsample chooses its cells, without its seed:
 * `uniform`, `blocks of 512`, `stratified by cell_type, balanced`.
 *
 * @param {Readonly<SubsampleSpec>} spec
 * @returns {string}
 */
export function describeSubsampleChoice(spec) {
  switch (spec.method) {
    case 'blocks': return `blocks of ${spec.blockSize}`;
    case 'stratified': return `stratified by ${spec.field}${spec.allocation === 'balanced' ? ', balanced' : ''}`;
    case 'spatial': return `spatial on ${spec.embedding}`;
    default: return 'uniform';
  }
}

/**
 * Short words for a subsample, as the Dataset card shows it:
 * `uniform, seed 0`, `blocks of 512, seed 7`, `stratified by cell_type, seed 0`.
 *
 * @param {Readonly<SubsampleSpec>} spec
 * @returns {string}
 */
export function describeSubsampleMethod(spec) {
  return `${describeSubsampleChoice(spec)}, seed ${spec.seed}`;
}
