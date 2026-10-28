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
 * - **blocks** cuts the cells into runs of `blockSize` neighbours in file
 *   order, ranks the runs by the same hash of their number, and keeps whole
 *   runs in rank order, the last one cut to its first cells to make exactly
 *   `k`. Nested like `uniform`. A run of neighbours is a run of storage, so
 *   a subsample reads about its share of a row-chunked array's bytes.
 * - **spatial** puts the cells of an embedding on a grid of `gridSize`
 *   boxes per axis and splits `k` over the occupied boxes as `balanced`
 *   does (cells with a non-finite coordinate are one more box, last), so
 *   sparse regions keep their cells while dense ones are thinned.
 *
 * Positions are uint32 (a dataset holds at most 2^32 - 1 cells); seeds are
 * uint32. Memory is proportional to `k` for `uniform` and `blocks` (two
 * passes over the positions, nothing per cell is kept), and to `n` for
 * `stratified` and `spatial` (their input is per cell already).
 *
 * @module data/subsample
 */

import { formatCountOf } from '../utils/format-units.js';
import { fmix32 } from './cell-identity.js';
import { allocateLargeArray } from '../utils/large-arrays.js';
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

/** `countFromShare` of a fraction in (0, 1]. */
export function countFromFraction(fraction, nObs) {
  return countFromShare(fraction, nObs);
}

/**
 * The `k` lowest-ranked of `count` items numbered `item(0..count-1)`, as an
 * ascending Uint32Array of their indices into `0..count-1`. Two passes, no
 * per-item memory: a histogram of the ranks' top 16 bits finds the bin the
 * k-th rank falls in; the second pass keeps every item below it and sorts
 * the bin's few items to cut it.
 */
function lowestRanks(count, k, key, item = null) {
  const counts = new Float64Array(65536);
  for (let i = 0; i < count; i++) {
    counts[fmix32(((item === null ? i : item(i)) ^ key) >>> 0) >>> 16]++;
  }
  let bin = 0;
  let below = 0;
  while (below + counts[bin] < k) below += counts[bin++];
  const need = k - below;
  const kept = allocateTypedArray(Uint32Array, below, 'Subsample cells');
  const candidateIndex = allocateTypedArray(Uint32Array, counts[bin], 'Subsample candidates');
  const candidateRank = allocateTypedArray(Uint32Array, counts[bin], 'Subsample candidate ranks');
  let keptAt = 0;
  let candidates = 0;
  for (let i = 0; i < count; i++) {
    const rank = fmix32(((item === null ? i : item(i)) ^ key) >>> 0);
    const top = rank >>> 16;
    if (top < bin) kept[keptAt++] = i;
    else if (top === bin) {
      candidateIndex[candidates] = i;
      candidateRank[candidates++] = rank;
    }
  }
  const ranks = allocateTypedArray(Uint32Array, candidateRank.length, 'Subsample candidate ranks');
  ranks.set(candidateRank);
  const threshold = need === 0 ? -1 : ranks.sort()[need - 1];
  const out = allocateTypedArray(Uint32Array, k, 'Subsample cells');
  let a = 0;
  let b = 0;
  let at = 0;
  while (a < keptAt || b < candidates) {
    if (b >= candidates || (a < keptAt && kept[a] < candidateIndex[b])) out[at++] = kept[a++];
    else {
      if (candidateRank[b] <= threshold) out[at++] = candidateIndex[b];
      b++;
    }
  }
  return out;
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
  requireUint32(nObs, 'A cell count');
  requirePositiveInteger(k, 'A subsample size');
  if (k >= nObs) return null;
  return lowestRanks(nObs, k, seedKey(seed));
}

/**
 * `blocks`: whole runs of `blockSize` neighbouring cells in rank order of
 * their run number, the last one cut to its first cells.
 *
 * @param {number} nObs
 * @param {number} k
 * @param {number} seed
 * @param {number} blockSize
 * @returns {Uint32Array|null}
 */
export function subsampleBlocks(nObs, k, seed, blockSize) {
  requireUint32(nObs, 'A cell count');
  requirePositiveInteger(k, 'A subsample size');
  requirePositiveInteger(blockSize, 'A block size');
  if (k >= nObs) return null;
  const blocks = Math.ceil(nObs / blockSize);
  const key = seedKey(seed);
  // Every block holds `blockSize` cells but the last; the blocks of the
  // lowest ranks cover `k` cells within one block more than `k / blockSize`.
  const take = Math.min(blocks, Math.ceil(k / blockSize) + 1);
  const chosen = lowestRanks(blocks, take, key);
  const order = Array.from(chosen).sort((x, y) => fmix32((x ^ key) >>> 0) - fmix32((y ^ key) >>> 0));
  const spans = [];
  let left = k;
  for (const block of order) {
    if (left === 0) break;
    const start = block * blockSize;
    const size = Math.min(blockSize, nObs - start);
    const used = Math.min(size, left);
    spans.push([start, used]);
    left -= used;
  }
  spans.sort((x, y) => x[0] - y[0]);
  const out = allocateTypedArray(Uint32Array, k, 'Subsample cells');
  let at = 0;
  for (const [start, used] of spans) for (let i = 0; i < used; i++) out[at++] = start + i;
  return out;
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
 * Keep `quota[s]` lowest-ranked cells of every stratum `s` (`strata[cell]`
 * in `0..nStrata-1`).
 */
function lowestPerStratum(strata, nStrata, quota, key) {
  const n = strata.length;
  // Cells grouped by stratum (counting sort), ascending within each.
  const start = allocateTypedArray(Float64Array, nStrata + 1, 'Subsample stratum starts');
  for (let cell = 0; cell < n; cell++) start[strata[cell] + 1]++;
  for (let s = 0; s < nStrata; s++) start[s + 1] += start[s];
  const grouped = allocateTypedArray(Uint32Array, n, 'Subsample cells by stratum');
  const fill = start.slice(0, nStrata);
  for (let cell = 0; cell < n; cell++) grouped[fill[strata[cell]]++] = cell;
  const keep = allocateTypedArray(Uint8Array, n, 'Subsample kept cells');
  let total = 0;
  for (let s = 0; s < nStrata; s++) {
    const want = quota[s];
    if (want === 0) continue;
    const from = start[s];
    const size = start[s + 1] - from;
    total += want;
    if (want >= size) {
      for (let i = from; i < from + size; i++) keep[grouped[i]] = 1;
      continue;
    }
    const picked = lowestRanks(size, want, key, i => grouped[from + i]);
    for (let i = 0; i < picked.length; i++) keep[grouped[from + picked[i]]] = 1;
  }
  const out = allocateTypedArray(Uint32Array, total, 'Subsample cells');
  let at = 0;
  for (let cell = 0; cell < n; cell++) if (keep[cell] === 1) out[at++] = cell;
  return out;
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
export function subsampleStratified(codes, nCategories, k, seed, { allocation = 'proportional', minPerCategory = 0 } = {}) {
  const nObs = requireUint32(codes.length, 'A cell count');
  requirePositiveInteger(k, 'A subsample size');
  requireUint32(nCategories, 'A category count');
  requireUint32(minPerCategory, 'A minimum per category');
  if (!STRATIFIED_ALLOCATIONS.includes(allocation)) throw new RangeError(`Unknown allocation '${String(allocation)}'.`);
  if (k >= nObs) return null;
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
  return splitOverStrata(strata, sizes, k, seed, allocation, minPerCategory);
}

function splitOverStrata(strata, sizes, k, seed, allocation, minimum) {
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
  return lowestPerStratum(strata, sizes.length, quota, seedKey(seed));
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
export function subsampleSpatial(coordinates, dimensions, k, seed, { gridSize = DEFAULT_GRID_SIZE } = {}) {
  requirePositiveInteger(k, 'A subsample size');
  const { boxes } = gridBoxes(coordinates, dimensions, gridSize);
  const nObs = requireUint32(boxes.length, 'A cell count');
  if (k >= nObs) return null;
  // Occupied boxes renumbered densely, in box order.
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
  return splitOverStrata(strata, sizes, k, seed, 'balanced', 0);
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
    const ranks = allocateTypedArray(Uint32Array, kept.length, 'Subsample ranks');
    for (let i = 0; i < kept.length; i++) ranks[i] = fmix32((kept[i] ^ key) >>> 0);
    return sortedByKey(kept, ranks);
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
 * Short words for a subsample, as the Dataset card shows it:
 * `uniform, seed 0`, `blocks of 512, seed 7`, `stratified by cell_type, seed 0`.
 *
 * @param {Readonly<SubsampleSpec>} spec
 * @returns {string}
 */
export function describeSubsampleMethod(spec) {
  switch (spec.method) {
    case 'blocks': return `blocks of ${spec.blockSize}, seed ${spec.seed}`;
    case 'stratified': return `stratified by ${spec.field}${spec.allocation === 'balanced' ? ', balanced' : ''}, seed ${spec.seed}`;
    case 'spatial': return `spatial on ${spec.embedding}, seed ${spec.seed}`;
    default: return `uniform, seed ${spec.seed}`;
  }
}
