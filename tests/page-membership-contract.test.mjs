import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_INTERSECTION_PAGES,
  compareIntersectionMasks,
  intersectionMembership,
  orderedMembership,
  orderedPageCounts
} from '../assets/js/app/utils/page-membership.js';

function page(name, ...groups) {
  return { groups, describeGroup: index => `Highlight page "${name}" group ${index}` };
}

test('ordered strategies give each cell one owner, counting a cell listed twice on a page once', () => {
  // Cell 1 is on page a twice (two groups) and on page b; cell 3 is on b and c.
  const pages = [page('a', [0, 1], [1]), page('b', [1, 2, 3]), page('c', [3, 4])];
  const membership = orderedMembership(pages, 6);
  assert.deepEqual([...membership.first], [0, 0, 1, 1, 2, -1]);
  assert.deepEqual([...membership.last], [0, 1, 1, 2, 2, -1]);
  assert.equal(membership.overlapCount, 2);
  assert.equal(membership.coveredCount, 5);
  assert.deepEqual(orderedPageCounts(membership, 3, 'first'), [2, 2, 1]);
  assert.deepEqual(orderedPageCounts(membership, 3, 'last'), [1, 2, 2]);
  assert.deepEqual(orderedPageCounts(membership, 3, 'overlap-label'), [1, 1, 1]);
});

test('intersections count single-page cells per page and every overlap mask', () => {
  const pages = [page('a', [0, 1], [1]), page('b', [1, 2, 3]), page('c', [3, 4, 1])];
  const membership = intersectionMembership(pages, 6);
  assert.deepEqual([...membership.masks], [1, 7, 2, 6, 4, 0]);
  assert.deepEqual(membership.pageCounts, [1, 1, 1]);
  assert.deepEqual([...membership.intersectionCounts].sort((l, r) => l[0] - r[0]), [[6, 1], [7, 1]]);
  assert.equal(membership.overlapCount, 2);
  assert.equal(membership.coveredCount, 5);
  assert.deepEqual([7, 6, 3, 5].sort(compareIntersectionMasks), [3, 5, 6, 7]);
});

test('an intersection combines up to 32 pages, the width of its mask', () => {
  assert.equal(MAX_INTERSECTION_PAGES, 32);
  const pages = Array.from({ length: 32 }, (_, index) => page(`p${index}`, [0, index + 1]));
  const membership = intersectionMembership(pages, 34);
  assert.ok(membership.masks instanceof Uint32Array);
  assert.equal(membership.masks[0], 0xffff_ffff);
  assert.equal(membership.masks[32], 0x8000_0000);
  assert.equal(membership.pageCounts[31], 1);
  assert.deepEqual([...membership.intersectionCounts], [[0xffff_ffff, 1]]);
  assert.throws(
    () => intersectionMembership([...pages, page('p32', [0])], 34),
    /at most 32 pages/
  );
});

test('an out-of-range cell names its page and group', () => {
  assert.throws(
    () => orderedMembership([page('a', [0]), page('b', [0], [9])], 4),
    /Highlight page "b" group 1 has an out-of-range cell index/
  );
});

test('a page covering more cells than a JavaScript Set can hold becomes a field', () => {
  // A Set or Map refuses more than 2^24 entries; membership is typed arrays.
  const pointCount = 2 ** 24 + 3;
  const everyCell = new Uint32Array(pointCount);
  for (let cell = 0; cell < pointCount; cell++) everyCell[cell] = cell;
  const pages = [page('all', everyCell), page('tail', [pointCount - 1])];

  const intersections = intersectionMembership(pages, pointCount);
  assert.equal(intersections.coveredCount, pointCount);
  assert.equal(intersections.pageCounts[0], pointCount - 1);
  assert.deepEqual([...intersections.intersectionCounts], [[3, 1]]);

  const ordered = orderedMembership(pages, pointCount);
  assert.equal(ordered.coveredCount, pointCount);
  assert.equal(ordered.overlapCount, 1);
  assert.deepEqual(orderedPageCounts(ordered, 2, 'last'), [pointCount - 1, 1]);
});
