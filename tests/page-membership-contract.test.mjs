import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareIntersections,
  intersectionKey,
  intersectionMembership,
  parseIntersectionKey,
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

/** Each cell's pages, as positions. */
function pagesOfCells(membership) {
  return [...membership.combinationOf].map(id => membership.combinations[id]);
}

test('intersections count single-page cells per page and every combination of pages', () => {
  const pages = [page('a', [0, 1], [1]), page('b', [1, 2, 3]), page('c', [3, 4, 1])];
  const membership = intersectionMembership(pages, 6);
  assert.deepEqual(pagesOfCells(membership), [[0], [0, 1, 2], [1], [1, 2], [2], []]);
  assert.deepEqual(membership.pageCounts, [1, 1, 1]);
  assert.deepEqual(membership.intersections, [
    { key: '1+2', pages: [1, 2], count: 1 },
    { key: '0+1+2', pages: [0, 1, 2], count: 1 },
  ]);
  assert.equal(membership.overlapCount, 2);
  assert.equal(membership.coveredCount, 5);
  assert.deepEqual(
    [[0, 1, 2], [1, 2], [0, 1], [0, 2], [0, 3]].sort(compareIntersections),
    [[0, 1], [0, 2], [0, 3], [1, 2], [0, 1, 2]]
  );
});

test('an intersection combines any number of pages (41 here), keyed by its pages', () => {
  // Cell 0 on every page, cell p + 1 on page p alone, cell 42 on pages 0
  // (twice: two groups) and 40, cell 43 on pages 3, 17 and 35.
  const pages = Array.from({ length: 41 }, (_, index) => page(
    `p${index}`,
    [0, index + 1, ...(index === 0 || index === 40 ? [42] : []), ...([3, 17, 35].includes(index) ? [43] : [])],
    ...(index === 0 ? [[42]] : [])
  ));
  const membership = intersectionMembership(pages, 45);
  const every = Array.from({ length: 41 }, (_, index) => index);
  assert.deepEqual(membership.combinations[membership.combinationOf[0]], every);
  assert.deepEqual(membership.pageCounts, new Array(41).fill(1));
  assert.deepEqual(membership.intersections, [
    { key: '0+40', pages: [0, 40], count: 1 },
    { key: '3+17+35', pages: [3, 17, 35], count: 1 },
    { key: every.join('+'), pages: every, count: 1 },
  ]);
  assert.equal(membership.overlapCount, 3);
  assert.equal(membership.coveredCount, 44);
  assert.equal(membership.combinationOf[44], 0);
});

test('an intersection key is its pages ascending, two or more of the pages given', () => {
  assert.equal(intersectionKey([3, 17, 41]), '3+17+41');
  assert.deepEqual(parseIntersectionKey('3+17+41', 42), [3, 17, 41]);
  for (const key of ['3', '17+3', '3+3', '03+4', '3+42', '+3', '3+', '3+x', 3]) {
    assert.throws(() => parseIntersectionKey(key, 42), /Intersection key/, String(key));
  }
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
  assert.deepEqual(intersections.intersections, [{ key: '0+1', pages: [0, 1], count: 1 }]);

  const ordered = orderedMembership(pages, pointCount);
  assert.equal(ordered.coveredCount, pointCount);
  assert.equal(ordered.overlapCount, 1);
  assert.deepEqual(orderedPageCounts(ordered, 2, 'last'), [pointCount - 1, 1]);
});
