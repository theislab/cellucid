/**
 * @fileoverview A category that keeps only some of its cells: "N cells of
 * T cells stay shown" (the legend's count, `filter.category.cell-count`).
 *
 * A field's limits are `field._categoryCellLimits`: a frozen list of
 * `{category, count, seed}` (category by its index in `field.categories`),
 * ascending by category, never changed in place (a change makes a new list,
 * as `utils/category-state.js` does for colours and visibility), so a kept
 * view's copy of the field shares it. A new definition of the categories
 * (a merge or delete in place, `_publishUserDefinedCategorical`) drops them.
 *
 * Which cells stay is the uniform subsample's rule (`data/subsample.js`)
 * applied to the category's open cells: the `count` with the lowest rank
 * under `seed`, a cell ranked by its original position (`rankOf`,
 * `data/subsample.js`). So the
 * same seed and count keep the same cells whatever order they are open in,
 * a larger count keeps every cell a smaller one kept, and a cell open in two
 * subsamples is kept in both or in neither whenever the category's other
 * open cells agree. A step that set a limit replays exactly.
 *
 * The visibility pass reads one bit a cell (`cellSampleFilterOf`): kept or
 * not. The bits are made once per limits list, codes and open cells, and
 * cached on the limits list (a weak key), so every view sharing the list
 * shares them. They hold one bit an open cell: the working set's
 * `category cell samples` part (`computeGlobalVisibility`).
 *
 * @module state/managers/category-cell-sample
 */

import { seedKey } from '../../../data/subsample.js';
import { fmix32 } from '../../../data/cell-identity.js';

const NONE = Object.freeze([]);

/** Bits of the kept cells, per limits list: `{codes, identity, filter}`. */
const SAMPLES = new WeakMap();

/**
 * A field's cell limits (empty when none).
 * @param {object} field
 * @returns {ReadonlyArray<{category: number, count: number, seed: number}>}
 */
export function categoryCellLimitsOf(field) {
  return field?._categoryCellLimits ?? NONE;
}

/** The limit of one category, or null. */
export function categoryCellLimitAt(field, category) {
  return categoryCellLimitsOf(field).find(limit => limit.category === category) ?? null;
}

/**
 * Check one limit: a non-negative integer count and a uint32 seed.
 * @param {{count: number, seed: number}} limit
 */
export function requireCellLimit(limit) {
  if (limit === null || typeof limit !== 'object') throw new TypeError('A cell limit is {count, seed}.');
  if (!Number.isSafeInteger(limit.count) || limit.count < 0) {
    throw new RangeError('A category keeps a whole number of cells, 0 or more.');
  }
  if (!Number.isSafeInteger(limit.seed) || limit.seed < 0 || limit.seed > 0xffffffff) {
    throw new RangeError('A sample seed is a whole number from 0 through 4294967295.');
  }
  return limit;
}

/**
 * Set (`limit`) or remove (null) the limit of category `category`: a new
 * list, ascending by category; no list when none is left.
 *
 * @param {object} field
 * @param {number} category
 * @param {{count: number, seed: number}|null} limit
 */
export function withCategoryCellLimit(field, category, limit) {
  if (!Number.isSafeInteger(category) || category < 0 || category >= field.categories.length) {
    throw new RangeError('A cell limit names a category of the field.');
  }
  if (limit !== null) requireCellLimit(limit);
  const others = categoryCellLimitsOf(field).filter(entry => entry.category !== category);
  const next = limit === null
    ? others
    : [...others, Object.freeze({ category, count: limit.count, seed: limit.seed })].sort((a, b) => a.category - b.category);
  if (next.length === 0) delete field._categoryCellLimits;
  else field._categoryCellLimits = Object.freeze(next);
}

/** Remove every limit of a field. */
export function withoutCategoryCellLimits(field) {
  delete field._categoryCellLimits;
}

/**
 * The cells each limited category keeps, as the visibility pass reads them:
 * `limited[code]` is 1 for a limited category, `bits` one bit an open cell
 * (set: kept), `bytes` their size. Null when no limit hides a cell (every
 * limit at or above its category's open cells).
 *
 * @param {object} field - A categorical field with codes of every open cell
 * @param {import('../../../data/cell-identity.js').CellIdentity} identity - The open cells
 * @returns {{codes: ArrayLike<number>, limited: Uint8Array, bits: Uint8Array, bytes: number}|null}
 */
export function cellSampleFilterOf(field, identity) {
  const limits = field._categoryCellLimits;
  if (limits === undefined || limits.length === 0) return null;
  const codes = field.codes;
  const cached = SAMPLES.get(limits);
  if (cached !== undefined && cached.codes === codes && cached.identity === identity) return cached.filter;
  const filter = sampleFilter(limits, codes, identity, field.categories.length);
  SAMPLES.set(limits, { codes, identity, filter });
  return filter;
}

function sampleFilter(limits, codes, identity, categoryCount) {
  const n = codes.length;
  // Which list each limited category's cells go to, and how many it has.
  const slot = new Int32Array(categoryCount).fill(-1);
  limits.forEach((limit, index) => { slot[limit.category] = index; });
  const sizes = new Uint32Array(limits.length);
  for (let i = 0; i < n; i++) {
    const code = codes[i];
    if (code < categoryCount && slot[code] >= 0) sizes[slot[code]]++;
  }
  const limited = new Uint8Array(categoryCount);
  let any = false;
  for (let index = 0; index < limits.length; index++) {
    if (limits[index].count < sizes[index]) {
      limited[limits[index].category] = 1;
      any = true;
    } else {
      slot[limits[index].category] = -1;
    }
  }
  if (!any) return null;
  // Each limited category's cells, ranked; the `count` lowest ranks stay.
  const ranks = limits.map((limit, index) => (limited[limit.category] === 1 ? new Uint32Array(sizes[index]) : null));
  const fill = new Uint32Array(limits.length);
  // `rankOf(seed, position)`, with each seed's key made once.
  const keys = limits.map(limit => seedKey(limit.seed));
  const rankAt = (at, i) => fmix32((identity.originalAt(i) ^ keys[at]) >>> 0);
  for (let i = 0; i < n; i++) {
    const code = codes[i];
    if (code >= categoryCount) continue;
    const at = slot[code];
    if (at < 0) continue;
    ranks[at][fill[at]++] = rankAt(at, i);
  }
  // The highest rank kept per category: ranks of distinct positions under
  // one seed are distinct (`rankOf` is a bijection), so a threshold keeps
  // exactly `count` cells.
  const threshold = new Float64Array(limits.length).fill(-1);
  for (let index = 0; index < limits.length; index++) {
    if (ranks[index] === null || limits[index].count === 0) continue;
    const sorted = ranks[index].sort();
    threshold[index] = sorted[limits[index].count - 1];
  }
  const bits = new Uint8Array(Math.ceil(n / 8));
  for (let i = 0; i < n; i++) {
    const code = codes[i];
    if (code >= categoryCount) continue;
    const at = slot[code];
    if (at < 0) continue;
    if (rankAt(at, i) <= threshold[at]) bits[i >>> 3] |= 1 << (i & 7);
  }
  return Object.freeze({ codes, limited, bits, bytes: bits.byteLength + limited.byteLength });
}
