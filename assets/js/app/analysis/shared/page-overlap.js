/**
 * @fileoverview Cells that groups being compared share.
 *
 * Every test that compares groups of cells — differential expression,
 * Welch's t, Mann-Whitney, ANOVA, Kruskal-Wallis, χ² and Fisher's exact test
 * of the Detailed view, pages scored by a gene signature — assumes the
 * groups are independent samples. Two pages that share cells (a page and a
 * page inside it, two lassos that cross) are not: the shared cells are
 * counted on both sides. Differential expression refuses such groups; the
 * Detailed view shows the pages and their summaries, says how many cells
 * they share, and leaves the tests out. One count for every comparison.
 *
 * @module shared/page-overlap
 */

import { formatCountOf } from '../../../utils/format-units.js';

/**
 * How many cells two cell lists (ascending, each cell once) share: one merge
 * walk, O(a + b).
 *
 * @param {ArrayLike<number>} left
 * @param {ArrayLike<number>} right
 * @returns {number}
 */
export function sharedCellCount(left, right) {
  let shared = 0;
  for (let i = 0, j = 0; i < left.length && j < right.length;) {
    if (left[i] === right[j]) {
      shared++;
      i++;
      j++;
    } else if (left[i] < right[j]) i++;
    else j++;
  }
  return shared;
}

/**
 * How many distinct cells are in more than one of `cellLists` (each a list
 * of distinct cells, in any order): one pass over every list with a count
 * per cell, saturating at two.
 *
 * @param {ArrayLike<number>[]} cellLists
 * @returns {number}
 */
export function cellsInSeveral(cellLists) {
  if (cellLists.length < 2) return 0;
  if (cellLists.length === 2) {
    const [a, b] = cellLists;
    if (isAscending(a) && isAscending(b)) return sharedCellCount(a, b);
  }
  let end = 0;
  for (const list of cellLists) {
    for (let i = 0; i < list.length; i++) if (list[i] >= end) end = list[i] + 1;
  }
  const seen = new Uint8Array(end);
  let shared = 0;
  for (const list of cellLists) {
    for (let i = 0; i < list.length; i++) {
      const cell = list[i];
      const count = seen[cell];
      if (count === 1) shared++;
      if (count < 2) seen[cell] = count + 1;
    }
  }
  return shared;
}

function isAscending(list) {
  for (let i = 1; i < list.length; i++) if (list[i] <= list[i - 1]) return false;
  return true;
}

/**
 * Why tests of independent groups do not apply to pages that share cells,
 * in one sentence; null when they share none or a page's cells are not
 * known.
 *
 * @param {Array<{cellIndices?: ArrayLike<number>|null}>} pages
 * @returns {string|null}
 */
export function sharedCellsReason(pages) {
  if (!Array.isArray(pages) || pages.length < 2) return null;
  const lists = pages.map(page => page?.cellIndices ?? null);
  if (lists.some(list => list === null || typeof list !== 'object')) return null;
  const shared = cellsInSeveral(lists);
  if (shared === 0) return null;
  return `The pages share ${formatCountOf(shared, 'cell')}; these tests assume groups with no cell in common, so they are not run. Compare pages without shared cells.`;
}
