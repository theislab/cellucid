/**
 * Tests that compare groups of cells assume the groups share no cell
 * (audit F-5): differential expression refuses groups that do, and the
 * Detailed view's tests (Welch, Mann-Whitney, ANOVA, Kruskal-Wallis, χ²,
 * Fisher) are not run on pages that do — one count of the shared cells
 * (`shared/page-overlap.js`) for every comparison.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { cellsInSeveral, sharedCellCount, sharedCellsReason } from '../assets/js/app/analysis/shared/page-overlap.js';

function reference(lists) {
  const counts = new Map();
  for (const list of lists) for (const cell of list) counts.set(cell, (counts.get(cell) ?? 0) + 1);
  let shared = 0;
  for (const count of counts.values()) if (count > 1) shared++;
  return shared;
}

test('the cells in more than one list, by a merge or a count per cell', () => {
  let seed = 7;
  const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const list = (n, size) => Uint32Array.from(new Set(Array.from({ length: size }, () => Math.floor(random() * n)))).sort();
  for (let round = 0; round < 50; round++) {
    const lists = Array.from({ length: 2 + (round % 3) }, () => list(500, 1 + Math.floor(random() * 300)));
    assert.equal(cellsInSeveral(lists), reference(lists), `round ${round}`);
    assert.equal(sharedCellCount(lists[0], lists[1]), reference(lists.slice(0, 2)), `round ${round} pair`);
  }
  assert.equal(cellsInSeveral([Uint32Array.of(1, 2)]), 0);
  // Unordered lists are counted too (a sample's cells are in priority order elsewhere).
  assert.equal(cellsInSeveral([[5, 1, 3], [3, 9, 5]]), 2);
  assert.equal(cellsInSeveral([[], [1]]), 0);
});

test('pages that share cells are named with the count; disjoint pages are tested', () => {
  assert.equal(sharedCellsReason([{ cellIndices: Uint32Array.of(1, 2) }, { cellIndices: Uint32Array.of(3, 4) }]), null);
  assert.match(
    sharedCellsReason([{ cellIndices: Uint32Array.of(1, 2, 3) }, { cellIndices: Uint32Array.of(2, 3, 4) }]),
    /^The pages share 2 cells; these tests assume groups with no cell in common/
  );
  // A page inside another.
  assert.match(sharedCellsReason([{ cellIndices: Uint32Array.of(1, 2, 3, 4) }, { cellIndices: Uint32Array.of(2) }]), /share 1 cell;/);
  assert.equal(sharedCellsReason([{ cellIndices: Uint32Array.of(1) }]), null);
  assert.equal(sharedCellsReason([{ values: [1] }, { values: [2] }]), null, 'pages without their cells are not judged');
});

test('differential expression refuses groups that share cells, saying how many', async () => {
  const { MultiVariableAnalysis } = await import('../assets/js/app/analysis/stats/multi-variable-analysis.js');
  const engine = Object.create(MultiVariableAnalysis.prototype);
  engine.dataLayer = { state: { pointCount: 10 }, getGeneKeys: async () => ['G'] };
  await assert.rejects(
    engine.differentialExpression({
      groupA: { name: 'A', cells: Uint32Array.of(1, 2, 3) },
      groupB: { name: 'B', cells: Uint32Array.of(3, 4) },
    }),
    /must be disjoint; they share 1 cell/
  );
});
