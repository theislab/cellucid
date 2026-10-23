import assert from 'node:assert/strict';
import test from 'node:test';

import { SignaturePageScorer } from '../assets/js/app/analysis/stats/signature-score.js';
import { medianInPlace } from '../assets/js/app/analysis/compute/math-utils.js';

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * The scores from dense page values, gene by gene into a Float32 sum per cell
 * (sum, mean) or the median of each cell's finite values: the definition the
 * sparse path must equal bit for bit.
 */
function denseReference(denseGenes, cells, method) {
  const scores = new Float32Array(cells.length);
  if (method === 'median') {
    const buffer = new Float64Array(denseGenes.length);
    for (let p = 0; p < cells.length; p++) {
      let present = 0;
      for (const gene of denseGenes) {
        const value = gene[cells[p]];
        if (Number.isFinite(value)) buffer[present++] = value;
      }
      scores[p] = medianInPlace(buffer, present);
    }
    return scores;
  }
  const counts = new Uint32Array(cells.length);
  for (const gene of denseGenes) {
    for (let p = 0; p < cells.length; p++) {
      const value = gene[cells[p]];
      if (Number.isFinite(value)) {
        scores[p] += value;
        counts[p]++;
      }
    }
  }
  for (let p = 0; p < cells.length; p++) {
    if (counts[p] === 0) scores[p] = NaN;
    else if (method === 'mean') scores[p] = scores[p] / counts[p];
  }
  return scores;
}

function sparseOf(dense) {
  const indices = [];
  const values = [];
  for (let cell = 0; cell < dense.length; cell++) {
    if (dense[cell] !== 0) {
      indices.push(cell);
      values.push(dense[cell]);
    }
  }
  return { length: dense.length, indices: Uint32Array.from(indices), values: Float32Array.from(values) };
}

function score(columns, cells, method, pointCount, slice) {
  const scorer = new SignaturePageScorer({ method, geneCount: columns.length, cellIndices: cells, pointCount });
  for (const column of columns) scorer.addGene(column);
  for (let from = 0; from < cells.length; from += slice) {
    scorer.scoreCells(from, Math.min(cells.length, from + slice));
  }
  return scorer.scores;
}

test('signature scores from sparse, dense and mixed columns equal the dense definition bit for bit', () => {
  const random = lcg(7);
  const pointCount = 5000;
  const geneCount = 23;
  const genes = Array.from({ length: geneCount }, (_, g) => Float32Array.from({ length: pointCount }, () => {
    const r = random();
    if (r < 0.002 * (g % 3)) return NaN;
    if (r < 0.85) return 0;
    return Math.fround(Math.exp(random() * 4) - 1);
  }));
  // One gene NaN for a whole block of cells, one all-zero gene.
  genes[4].fill(NaN, 100, 400);
  genes[9].fill(0);
  const cells = Uint32Array.from({ length: pointCount }, (_, i) => i).filter(i => i % 3 !== 1);
  const rest = Array.from({ length: pointCount }, (_, i) => i).filter(i => i % 3 === 1);
  for (const method of ['mean', 'sum', 'median']) {
    for (const page of [cells, rest]) {
      const expected = denseReference(genes, page, method);
      const variants = {
        dense: genes,
        sparse: genes.map(sparseOf),
        mixed: genes.map((gene, g) => (g % 2 === 0 ? sparseOf(gene) : gene))
      };
      for (const [name, columns] of Object.entries(variants)) {
        const actual = score(columns, page, method, pointCount, 777);
        for (let p = 0; p < page.length; p++) {
          assert.ok(Object.is(actual[p], expected[p]), `${method}/${name} cell ${p}: ${actual[p]} vs ${expected[p]}`);
        }
      }
    }
  }
});

test('a cell with no finite value scores NaN; absent sparse entries are zeros', () => {
  const pointCount = 4;
  const a = { length: 4, indices: Uint32Array.of(0, 1), values: Float32Array.of(NaN, 2) };
  const b = Float32Array.of(NaN, 0, 0, 5);
  const cells = Uint32Array.of(0, 1, 2, 3);
  assert.deepEqual(Array.from(score([a, b], cells, 'mean', pointCount, 4)), [NaN, 1, 0, 2.5]);
  assert.deepEqual(Array.from(score([a, b], cells, 'sum', pointCount, 4)), [NaN, 2, 0, 5]);
  assert.deepEqual(Array.from(score([a, b], cells, 'median', pointCount, 4)), [NaN, 1, 0, 2.5]);
});

test('signature scoring refuses columns and cells outside the dataset', () => {
  assert.throws(
    () => new SignaturePageScorer({ method: 'mean', geneCount: 1, cellIndices: [5], pointCount: 5 }),
    /outside the dataset/
  );
  const scorer = new SignaturePageScorer({ method: 'mean', geneCount: 1, cellIndices: [0], pointCount: 5 });
  assert.throws(() => scorer.addGene(new Float32Array(4)), /every dataset cell/);
  assert.throws(
    () => scorer.addGene({ length: 5, indices: Uint32Array.of(9), values: Float32Array.of(1) }),
    /outside the dataset/
  );
});

test('signature scoring without a caller ownership predicate reads its columns', async () => {
  const { DataLayer } = await import('../assets/js/app/analysis/data/data-layer.js');
  const { MultiVariableAnalysis } = await import('../assets/js/app/analysis/stats/multi-variable-analysis.js');
  const layer = new DataLayer({
    pointCount: 3,
    getHighlightPages: () => [{
      id: 'p', name: 'P',
      highlightedGroups: [{ id: 'g', type: 'lasso', label: 'g', enabled: true, cellIndices: [0, 2], cellCount: 2 }],
    }],
    obsData: { fields: [] },
    varData: { fields: [{ key: 'A', kind: 'continuous', loaded: true, values: Float32Array.of(1, 5, 3) }] },
  }, { enableNotifications: false, enablePrefetch: false });
  try {
    const analysis = Object.create(MultiVariableAnalysis.prototype);
    analysis.dataLayer = layer;
    analysis._computeManager = null;
    const [page] = await analysis.computeSignatureScore({ genes: ['A'], pageIds: ['p'], method: 'mean' });
    assert.deepEqual(Array.from(page.scores), [1, 3]);
    assert.deepEqual(Array.from(page.cellIndices), [0, 2]);
  } finally {
    layer.destroy();
  }
});
