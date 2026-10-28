/**
 * The priority of the open cells: the one order in which every "first `m`
 * cells" of the app is taken — the levels of detail the renderer draws
 * (`rendering/high-perf/draw-order.js`) and the first pass of a progressive
 * analysis (`app/analysis/shared/progressive-cells.js`).
 *
 * The priority is the subsampling specification's uniform rank (`rankOf`,
 * `subsample.js`), so **every prefix of it is a uniform random sample of the
 * open cells**: a reduced level of detail draws the same mix of categories
 * and the same density as all cells do, up to sampling noise, and an
 * analysis's first pass sees an unbiased sample. It is also the order
 * subsamples are taken in, so the cells a level of detail draws first are the
 * cells a smaller subsample with the same seed would open.
 *
 * A priority is one of two frozen descriptors:
 *
 * - `OPEN_ORDER_PRIORITY` (`seed` null): open cell `i` has priority `i`. The
 *   open cells already are in priority order: a priority-ordered file
 *   (`anndata/priority-layout.js`) opened whole or by a prefix, or a subsample
 *   of any cell-level method, which opens in its priority order
 *   (`priorityOrder`). Nothing is computed.
 * - `{seed, originals}`: open cell `i` has the rank under `seed` of its
 *   original position, `originals[i]`, or `i` when `originals` is null (every
 *   cell open, in file order). This is every other opening: a file Cellucid
 *   did not write, opened whole, takes the default seed; a `blocks` subsample,
 *   which opens whole runs of neighbours in their run order, takes its own
 *   seed, so its levels of detail are a uniform sample of its cells and not of
 *   its runs.
 *
 * Ranks are a bijection of uint32 positions for one seed, so no two cells tie.
 *
 * @module data/cell-priority
 */

import { fmix32 } from './cell-identity.js';
import { DEFAULT_SUBSAMPLE_SEED, seedKey } from './subsample.js';
import { formatCountOf } from '../utils/format-units.js';
import { allocateTypedArray } from './sparse-column-index.js';

/** The open cells are in priority order. */
export const OPEN_ORDER_PRIORITY = Object.freeze({ seed: null, originals: null });

/** Every cell open in file order, ranked under the default seed: the priority of a dataset nothing else describes. */
export const DEFAULT_CELL_PRIORITY = Object.freeze({ seed: DEFAULT_SUBSAMPLE_SEED, originals: null });

/**
 * A priority by rank under `seed`.
 *
 * @param {number} seed - uint32
 * @param {Uint32Array|null} originals - Original position of each open cell; null: open cell `i` is position `i`
 * @returns {Readonly<{seed: number, originals: Uint32Array|null}>}
 */
export function rankedCellPriority(seed, originals = null) {
  seedKey(seed);
  if (originals !== null && !(originals instanceof Uint32Array)) {
    throw new TypeError('A cell priority names original positions as a Uint32Array.');
  }
  return seed === DEFAULT_SUBSAMPLE_SEED && originals === null
    ? DEFAULT_CELL_PRIORITY
    : Object.freeze({ seed, originals });
}

/**
 * A priority as a message carried it (structured clone drops the freeze):
 * the same descriptor again.
 *
 * @param {{seed: number|null, originals: Uint32Array|null}} message
 * @returns {Readonly<{seed: number|null, originals: Uint32Array|null}>}
 */
export function reviveCellPriority(message) {
  if (message === null || typeof message !== 'object') throw new TypeError('A cell priority message must be an object.');
  return message.seed === null && message.originals === null
    ? OPEN_ORDER_PRIORITY
    : rankedCellPriority(message.seed, message.originals ?? null);
}

/**
 * Check a priority descriptor, and that it describes `n` open cells.
 *
 * @param {unknown} priority
 * @param {number} n
 * @returns {Readonly<{seed: number|null, originals: Uint32Array|null}>}
 */
export function requireCellPriority(priority, n) {
  if (priority === null || typeof priority !== 'object' || !Object.isFrozen(priority)) {
    throw new TypeError('A cell priority must be a frozen descriptor (data/cell-priority.js).');
  }
  if (priority.seed === null) {
    if (priority.originals !== null) throw new TypeError('An open-order cell priority names no original positions.');
    return priority;
  }
  seedKey(priority.seed);
  if (priority.originals !== null) {
    if (!(priority.originals instanceof Uint32Array)) {
      throw new TypeError('A cell priority names original positions as a Uint32Array.');
    }
    if (priority.originals.length !== n) {
      throw new RangeError(`A cell priority names ${formatCountOf(priority.originals.length, 'cell')}, not the ${formatCountOf(n, 'open cell')}.`);
    }
  }
  return priority;
}

/**
 * The priority of the cells an opening presents (`AnnDataReader.cellSubset`,
 * `anndata/subsample-plan.js`); `DEFAULT_CELL_PRIORITY` for a dataset opened
 * without one.
 *
 * @param {{ordered?: boolean, spec?: {method: string, seed: number}|null, openOrder?: Uint32Array|null}|null} subset
 * @returns {Readonly<{seed: number|null, originals: Uint32Array|null}>}
 */
export function cellPriorityOf(subset) {
  if (subset === null || subset === undefined || subset.ordered !== true) return DEFAULT_CELL_PRIORITY;
  // `blocks` opens whole runs of neighbours in their run order: a prefix of
  // that is a sample of runs. Its cells are ranked one by one instead.
  if (subset.spec?.method === 'blocks') return rankedCellPriority(subset.spec.seed, subset.openOrder ?? null);
  return OPEN_ORDER_PRIORITY;
}

const RADIX_BITS = 16;
const RADIX_SIZE = 1 << RADIX_BITS;
const RADIX_MASK = RADIX_SIZE - 1;

/** Inverse of `fmix32` (multiplicative inverses of its two constants mod 2^32). */
function inverseFmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7ed1b41d);
  h ^= (h >>> 13) ^ (h >>> 26);
  h = Math.imul(h, 0xa5cb9243);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Offsets of both 16-bit digits of `keys`, from one counting pass. */
function digitOffsets(keys) {
  const low = new Uint32Array(RADIX_SIZE);
  const high = new Uint32Array(RADIX_SIZE);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    low[key & RADIX_MASK]++;
    high[key >>> RADIX_BITS]++;
  }
  let lowAt = 0;
  let highAt = 0;
  for (let digit = 0; digit < RADIX_SIZE; digit++) {
    const lowCount = low[digit];
    low[digit] = lowAt;
    lowAt += lowCount;
    const highCount = high[digit];
    high[digit] = highAt;
    highAt += highCount;
  }
  return { low, high };
}

/**
 * The open cells in priority order: open positions, highest priority (lowest
 * rank) first. A prefix of it is a uniform random sample of the open cells.
 *
 * Working memory: the result alone for `OPEN_ORDER_PRIORITY`; two
 * `Uint32Array(n)` when ranks come from open positions (the ranks are sorted
 * alone, each cell then recovered from its rank, which is a bijection of its
 * position); four when they come from `originals`. Two stable passes of a
 * 16-bit radix sort, each a sequential scan.
 *
 * @param {number} n - Open cells
 * @param {Readonly<{seed: number|null, originals: Uint32Array|null}>} priority
 * @returns {Uint32Array}
 */
export function buildPriorityOrder(n, priority) {
  requireCellPriority(priority, n);
  if (priority.seed === null) {
    const order = allocateTypedArray(Uint32Array, n, 'Cell priority order');
    for (let i = 0; i < n; i++) order[i] = i;
    return order;
  }
  const key = seedKey(priority.seed);
  const originals = priority.originals;
  let keys = allocateTypedArray(Uint32Array, n, 'Cell priority ranks');
  if (originals === null) {
    for (let i = 0; i < n; i++) keys[i] = fmix32((i ^ key) >>> 0);
  } else {
    for (let i = 0; i < n; i++) keys[i] = fmix32((originals[i] ^ key) >>> 0);
  }
  const { low, high } = digitOffsets(keys);
  let scratch = allocateTypedArray(Uint32Array, n, 'Cell priority ranks');
  if (originals === null) {
    // Ranks are distinct, so the sorted ranks name the cells by themselves.
    for (let i = 0; i < n; i++) {
      const value = keys[i];
      scratch[low[value & RADIX_MASK]++] = value;
    }
    for (let i = 0; i < n; i++) {
      const value = scratch[i];
      keys[high[value >>> RADIX_BITS]++] = value;
    }
    for (let i = 0; i < n; i++) keys[i] = (inverseFmix32(keys[i]) ^ key) >>> 0;
    scratch = null;
    return keys;
  }
  const ids = allocateTypedArray(Uint32Array, n, 'Cell priority order');
  let scratchIds = allocateTypedArray(Uint32Array, n, 'Cell priority order');
  for (let i = 0; i < n; i++) {
    const at = low[keys[i] & RADIX_MASK]++;
    scratch[at] = keys[i];
    scratchIds[at] = i;
  }
  keys = null;
  for (let i = 0; i < n; i++) ids[high[scratch[i] >>> RADIX_BITS]++] = scratchIds[i];
  scratch = null;
  scratchIds = null;
  return ids;
}

/**
 * The first cells of the priority order, about `m` of `n`, as a membership
 * test: open positions `< m` for `OPEN_ORDER_PRIORITY`, else the cells whose
 * rank is below the `m / n` share of the rank range. Either way the cells it
 * holds are a prefix of `buildPriorityOrder`, so a uniform random sample of
 * the open cells; a ranked cut holds `m` cells up to sampling noise (each
 * cell is in it with probability `m / n`), and `count` says exactly how many
 * of any list are.
 *
 * @param {Readonly<{seed: number|null, originals: Uint32Array|null}>} priority
 * @param {number} n - Open cells
 * @param {number} m - Cells wanted, in [0, n]
 * @returns {{priority: object, n: number, m: number, has: (cell: number) => boolean, filter: (cells: ArrayLike<number>) => Uint32Array}}
 */
export function priorityPrefix(priority, n, m) {
  requireCellPriority(priority, n);
  if (!Number.isSafeInteger(m) || m < 0 || m > n) {
    throw new RangeError(`A priority prefix takes 0 to ${formatCountOf(n, 'cell')}; got ${m}.`);
  }
  let has;
  if (priority.seed === null) {
    has = cell => cell < m;
  } else {
    const key = seedKey(priority.seed);
    const originals = priority.originals;
    // Ranks are uniform over uint32: below `threshold` holds an m / n share.
    const threshold = m === n ? 2 ** 32 : Math.floor((m / n) * 2 ** 32);
    has = originals === null
      ? cell => fmix32((cell ^ key) >>> 0) < threshold
      : cell => fmix32((originals[cell] ^ key) >>> 0) < threshold;
  }
  const filter = cells => {
    const out = allocateTypedArray(Uint32Array, cells.length, 'Priority prefix cells');
    let count = 0;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (has(cell)) out[count++] = cell;
    }
    if (count === out.length) return out;
    const kept = allocateTypedArray(Uint32Array, count, 'Priority prefix cells');
    kept.set(out.subarray(0, count));
    return kept;
  };
  return Object.freeze({ priority, n, m, has, filter });
}
