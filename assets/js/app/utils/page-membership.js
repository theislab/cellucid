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

/**
 * The most pages one intersection field may combine. A cell's intersection is
 * the set of pages holding it, stored as one bit per page in a 32-bit mask,
 * and a session records each intersection's label under that mask.
 */
export const MAX_INTERSECTION_PAGES = 32;

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
 * Each cell's page set as a bit mask: bit `p` is set when page `p` holds the
 * cell. The narrowest unsigned width that carries one bit per page is used.
 *
 * @param {Array<{groups: ArrayLike<ArrayLike<number>>, describeGroup: (groupIndex: number) => string}>} pages
 * @param {number} pointCount
 * @returns {{
 *   masks: Uint8Array|Uint16Array|Uint32Array,
 *   pageCounts: number[],
 *   intersectionCounts: Map<number, number>,
 *   overlapCount: number,
 *   coveredCount: number
 * }} `pageCounts[p]` counts cells held by page `p` alone; `intersectionCounts`
 *   counts the cells of every mask with two or more pages.
 */
export function intersectionMembership(pages, pointCount) {
  requirePages(pages, pointCount);
  if (pages.length > MAX_INTERSECTION_PAGES) {
    throw new RangeError(
      `Each intersection supports at most ${MAX_INTERSECTION_PAGES} pages`
    );
  }
  const MaskArray = pages.length <= 8
    ? Uint8Array
    : pages.length <= 16 ? Uint16Array : Uint32Array;
  const masks = new MaskArray(pointCount);
  pages.forEach(({ groups, describeGroup }, pageIndex) => {
    // `>>> 0` keeps bit 31 a positive mask.
    const bit = (1 << pageIndex) >>> 0;
    forEachPageCell(groups, pointCount, describeGroup, cell => {
      masks[cell] = (masks[cell] | bit) >>> 0;
    });
  });

  const pageCounts = new Array(pages.length).fill(0);
  const intersectionCounts = new Map();
  let overlapCount = 0;
  let coveredCount = 0;
  for (let cell = 0; cell < pointCount; cell++) {
    const mask = masks[cell];
    if (mask === 0) continue;
    coveredCount++;
    if ((mask & (mask - 1)) === 0) {
      pageCounts[31 - Math.clz32(mask)]++;
    } else {
      overlapCount++;
      intersectionCounts.set(mask, (intersectionCounts.get(mask) ?? 0) + 1);
    }
  }
  return { masks, pageCounts, intersectionCounts, overlapCount, coveredCount };
}

/** Number of pages in a mask. */
export function maskPageCount(mask) {
  let remaining = mask >>> 0;
  let count = 0;
  while (remaining !== 0) {
    remaining = (remaining & (remaining - 1)) >>> 0;
    count++;
  }
  return count;
}

/** Order intersection masks by how many pages they combine, then by value. */
export function compareIntersectionMasks(left, right) {
  const cardinality = maskPageCount(left) - maskPageCount(right);
  return cardinality === 0 ? left - right : cardinality;
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
