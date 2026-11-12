/**
 * @fileoverview Which highlight pages each cell belongs to, for building a
 * categorical field from pages (the category builder's preview and the field
 * it creates compute it identically).
 *
 * Membership is held in typed arrays indexed by cell, never in a `Set` or a
 * `Map` keyed by cell: those refuse more than 16,777,216 entries, so a page
 * covering most of a large dataset could not be turned into a field. A cell
 * listed twice on one page (two groups of the page overlap) counts once.
 *
 * @module utils/page-membership
 */

import { formatCountOf } from '../../utils/format-units.js';

/**
 * Visit every enabled cell index of one page, validating it.
 *
 * @param {ArrayLike<ArrayLike<number>>} groups - The page's enabled groups' cell indices
 * @param {number} pointCount
 * @param {(groupIndex: number) => string} describeGroup - Names a group in errors
 * @param {(cell: number) => void} visit
 */
function forEachPageCell(groups, pointCount, describeGroup, visit) {
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const cells = groups[groupIndex];
    for (let position = 0; position < cells.length; position++) {
      const cell = cells[position];
      if (!Number.isSafeInteger(cell) || cell < 0 || cell >= pointCount) {
        throw new RangeError(`${describeGroup(groupIndex)} has an out-of-range cell index`);
      }
      visit(cell);
    }
  }
}

function requirePages(pages, pointCount) {
  if (!Array.isArray(pages)) {
    throw new TypeError('Page membership requires an array of pages');
  }
  if (!Number.isSafeInteger(pointCount) || pointCount < 0) {
    throw new TypeError('Page membership requires a non-negative safe-integer pointCount');
  }
}

/**
 * The key of a combination of pages: their positions among the field's
 * pages, ascending, joined by "+" (`"0+1"`, `"3+17+41"`). A session records
 * each intersection's label under it. It names any number of pages: an
 * intersection field combines as many pages as the person gives (bug hunt
 * F269: a 32-bit mask per cell once refused a 33rd page).
 *
 * @param {ArrayLike<number>} positions - Ascending page positions
 * @returns {string}
 */
export function intersectionKey(positions) {
  return Array.from(positions).join('+');
}

const INTERSECTION_KEY = /^(?:0|[1-9][0-9]*)(?:\+(?:0|[1-9][0-9]*))+$/;

/**
 * The page positions an intersection key names, checked: two or more
 * positions, ascending without repeats, each one of `pageCount` pages.
 *
 * @param {string} key
 * @param {number} pageCount
 * @returns {number[]}
 */
export function parseIntersectionKey(key, pageCount) {
  if (typeof key !== 'string' || !INTERSECTION_KEY.test(key)) {
    throw new TypeError(
      `Intersection key "${key}" must name two or more page positions joined by "+" (as "0+2")`
    );
  }
  const positions = key.split('+').map(Number);
  for (let index = 0; index < positions.length; index++) {
    const position = positions[index];
    if (!Number.isSafeInteger(position) || position >= pageCount) {
      throw new RangeError(`Intersection key "${key}" names a page beyond the ${formatCountOf(pageCount, 'page')} given`);
    }
    if (index > 0 && position <= positions[index - 1]) {
      throw new RangeError(`Intersection key "${key}" must list its pages ascending, each once`);
    }
  }
  return positions;
}

/**
 * Order combinations of pages by how many pages they combine, then by their
 * page positions (the first differing position first).
 *
 * @param {ArrayLike<number>} left - Ascending page positions
 * @param {ArrayLike<number>} right
 */
export function compareIntersections(left, right) {
  if (left.length !== right.length) return left.length - right.length;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/**
 * Each cell's set of pages, for any number of pages. Every set a cell can
 * have is interned once, as the pages are visited in order: a cell's set
 * grows by its next page, so the same set is always reached by the same
 * steps (set, page) -> set, and one id per set suffices. A cell listed twice
 * on one page counts once.
 *
 * @param {Array<{groups: ArrayLike<ArrayLike<number>>, describeGroup: (groupIndex: number) => string}>} pages
 * @param {number} pointCount
 * @returns {{
 *   combinationOf: Int32Array,
 *   combinations: number[][],
 *   pageCounts: number[],
 *   intersections: Array<{key: string, pages: number[], count: number}>,
 *   overlapCount: number,
 *   coveredCount: number
 * }} `combinationOf[cell]` indexes `combinations` (0: no page, the empty
 *   set); `combinations[id]` lists the set's page positions ascending;
 *   `pageCounts[p]` counts cells held by page `p` alone; `intersections`
 *   lists every set of two or more pages that holds cells, with its key and
 *   count, in `compareIntersections` order.
 */
export function intersectionMembership(pages, pointCount) {
  requirePages(pages, pointCount);
  const pageCount = pages.length;
  const combinationOf = new Int32Array(pointCount);
  const combinations = [[]];
  // The last page of each set, to count a cell listed twice on a page once.
  const lastPage = [-1];
  const next = new Map();
  pages.forEach(({ groups, describeGroup }, pageIndex) => {
    forEachPageCell(groups, pointCount, describeGroup, cell => {
      const from = combinationOf[cell];
      if (lastPage[from] === pageIndex) return;
      const step = from * pageCount + pageIndex;
      let to = next.get(step);
      if (to === undefined) {
        to = combinations.length;
        combinations.push([...combinations[from], pageIndex]);
        lastPage.push(pageIndex);
        next.set(step, to);
      }
      combinationOf[cell] = to;
    });
  });

  const counts = new Float64Array(combinations.length);
  for (let cell = 0; cell < pointCount; cell++) counts[combinationOf[cell]]++;
  const pageCounts = new Array(pageCount).fill(0);
  const intersections = [];
  let overlapCount = 0;
  for (let id = 1; id < combinations.length; id++) {
    const count = counts[id];
    if (count === 0) continue;
    const combination = combinations[id];
    if (combination.length === 1) {
      pageCounts[combination[0]] += count;
    } else {
      overlapCount += count;
      intersections.push({ key: intersectionKey(combination), pages: combination, count });
    }
  }
  intersections.sort((left, right) => compareIntersections(left.pages, right.pages));
  return {
    combinationOf,
    combinations,
    pageCounts,
    intersections,
    overlapCount,
    coveredCount: pointCount - counts[0]
  };
}

/**
 * The first and last page holding each cell, and whether two or more pages
 * hold it, for the first, last and overlap-label strategies. Any number of
 * pages works.
 *
 * @param {Array<{groups: ArrayLike<ArrayLike<number>>, describeGroup: (groupIndex: number) => string}>} pages
 * @param {number} pointCount
 * @returns {{
 *   first: Int32Array,
 *   last: Int32Array,
 *   overlapping: Uint8Array,
 *   overlapCount: number,
 *   coveredCount: number
 * }} `first[cell]` and `last[cell]` are -1 for a cell no page holds.
 */
export function orderedMembership(pages, pointCount) {
  requirePages(pages, pointCount);
  const first = new Int32Array(pointCount).fill(-1);
  const last = new Int32Array(pointCount).fill(-1);
  const overlapping = new Uint8Array(pointCount);
  let overlapCount = 0;
  let coveredCount = 0;
  pages.forEach(({ groups, describeGroup }, pageIndex) => {
    forEachPageCell(groups, pointCount, describeGroup, cell => {
      const previous = last[cell];
      if (previous === pageIndex) return;
      if (previous === -1) {
        first[cell] = pageIndex;
        coveredCount++;
      } else if (overlapping[cell] === 0) {
        overlapping[cell] = 1;
        overlapCount++;
      }
      last[cell] = pageIndex;
    });
  });
  return { first, last, overlapping, overlapCount, coveredCount };
}

/**
 * Cells each page receives under one ordered strategy: `first` and `last`
 * give an overlapping cell to its first or last page; `overlap-label` gives
 * it to no page.
 *
 * @param {ReturnType<typeof orderedMembership>} membership
 * @param {number} pageCount
 * @param {'first'|'last'|'overlap-label'} strategy
 * @returns {number[]}
 */
export function orderedPageCounts(membership, pageCount, strategy) {
  const { first, last, overlapping } = membership;
  const counts = new Array(pageCount).fill(0);
  const owner = strategy === 'last' ? last : first;
  const skipOverlaps = strategy === 'overlap-label';
  for (let cell = 0; cell < owner.length; cell++) {
    const page = owner[cell];
    if (page < 0 || (skipOverlaps && overlapping[cell] === 1)) continue;
    counts[page]++;
  }
  return counts;
}
