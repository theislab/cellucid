/**
 * The module score of Gene signature is scanpy's `score_genes`
 * (`stats/module-score.js`, `MultiVariableAnalysis.computeSignatureScore`
 * with `method: 'module'`), on the synthetic AnnData of
 * `tests/fixtures/analysis/scanpy-reference.json`:
 *
 * - genes binned by the rank (min) of their mean over all cells,
 *   `n_items = round(genes / (bins − 1))` half to even;
 * - controls drawn from each bin a set gene falls in, the set's own genes
 *   removed (`ctrl_as_ref`);
 * - score = mean of the set genes − mean of the controls, per cell.
 *
 * The fixture's `ctrl_size` is every gene, so every bin is taken whole and
 * the control set does not depend on the generator (ours is mulberry32,
 * scanpy's numpy): the scores must agree at 25 and at 5 bins.
 *
 * Tolerance: every value is a multiple of 1/4, so the set and control means
 * are exact in float64 on both sides; the published scores are float32, so a
 * score is held to one float32 ulp of the larger of the two means it is the
 * difference of (the means are float32 before they are subtracted).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';
import {
  expressionBins,
  moduleScoreControls,
  mulberry32,
  roundHalfEven,
} from '../assets/js/app/analysis/stats/module-score.js';
import { geneMomentsFor, momentsMean } from '../assets/js/app/analysis/shared/gene-moments-cache.js';
import { geneMomentsOf } from '../assets/js/app/analysis/compute/operation-handlers.js';

const REFERENCE = JSON.parse(readFileSync(new URL('./fixtures/analysis/scanpy-reference.json', import.meta.url), 'utf8'));
const { var_names: GENES, X } = REFERENCE.data;
const CELLS = X.length;
const COLUMNS = new Map(GENES.map((gene, j) => [gene, Float32Array.from(X, row => row[j])]));

function float32Ulp(value) {
  const f = Math.fround(Math.abs(value));
  if (f === 0) return 2 ** -149;
  return 2 ** (Math.floor(Math.log2(f)) - 23);
}

/** A data layer of the fixture, every cell on one page. */
function analysisOfFixture(generation) {
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  const reads = [];
  analysis.dataLayer = {
    state: { pointCount: CELLS },
    getAvailableVariables: type => (type === 'gene_expression' ? GENES.map(key => ({ key })) : []),
    getDatasetGeneration: () => generation,
    getPageCells: pageIds => pageIds.map(pageId => ({
      pageId,
      pageName: 'All cells',
      cellIndices: Uint32Array.from({ length: CELLS }, (_, cell) => cell),
    })),
    async readGeneColumns(genes) {
      reads.push(genes);
      return genes.map(gene => COLUMNS.get(gene));
    },
    performCacheCleanup() {},
  };
  analysis._computeManager = null;
  // Every gene's moments, as a marker run or the moments pass leaves them.
  const cache = geneMomentsFor(generation);
  for (const gene of GENES) cache.set(gene, geneMomentsOf(COLUMNS.get(gene)));
  return { analysis, reads };
}

test('rounding and binning follow numpy and pandas', () => {
  assert.deepEqual([0.5, 1.5, 2.5, 2.4, 2.6, 3].map(roundHalfEven), [0, 2, 2, 2, 3, 3]);
  // Five finite means at 3 bins: n_items = round(2.5) = 2; rank(method='min')
  // gives 4, 1, 1, 3, 5 (ties share the lowest rank); bin = rank // 2.
  assert.deepEqual(expressionBins([3, 1, 1, 2, NaN, 5], 3), [2, 0, 0, 1, null, 2]);
  const random = mulberry32(0);
  const draws = Array.from({ length: 5 }, random);
  assert.ok(draws.every(value => value >= 0 && value < 1));
  assert.deepEqual(Array.from({ length: 5 }, mulberry32(0)), draws, 'a seed draws the same numbers');
});

test('a bin larger than the control size is drawn reproducibly and without the set genes', () => {
  const means = GENES.map(gene => momentsMean(geneMomentsOf(COLUMNS.get(gene))));
  const setGenes = REFERENCE.score_genes.bins_25.genes;
  const draw = seed => moduleScoreControls({ genes: GENES, means, setGenes, controlSize: 2, bins: 5, seed });
  assert.deepEqual(draw(3), draw(3));
  const controls = draw(3);
  assert.ok(controls.every(gene => !setGenes.includes(gene)));
  const bins = expressionBins(means, 5);
  const setBins = new Set(setGenes.map(gene => bins[GENES.indexOf(gene)]));
  assert.ok(controls.every(gene => setBins.has(bins[GENES.indexOf(gene)])), 'controls come from the set genes’ bins');
  assert.ok(controls.length <= 2 * setBins.size);
});

for (const [name, expected] of Object.entries(REFERENCE.score_genes)) {
  test(`score_genes ${name}: every cell's module score equals scanpy's`, async () => {
    const { analysis, reads } = analysisOfFixture(Symbol(name));
    const result = await analysis.computeSignatureScore({
      geneSets: [{ name: 'Signature', genes: expected.genes }],
      pageIds: ['all'],
      method: 'module',
      controlSize: expected.ctrl_size,
      bins: expected.n_bins,
      seed: 0,
    });
    const [set] = result.sets;
    assert.deepEqual(set.genes, expected.genes);
    assert.ok(set.controlGenes.length > 0);
    assert.ok(set.controlGenes.every(gene => !expected.genes.includes(gene)));
    assert.equal(reads.length, 1, 'every needed gene is read once, together');
    const [page] = set.pages;
    assert.equal(page.scores.length, CELLS);
    for (let cell = 0; cell < CELLS; cell++) {
      const mean = genes => genes.reduce((sum, gene) => sum + COLUMNS.get(gene)[cell], 0) / genes.length;
      const setMean = mean(expected.genes);
      const controlMean = mean(set.controlGenes);
      const reference = expected.scores[cell];
      // The control set is scanpy's: its exact mean gives scanpy's score.
      assert.ok(
        Math.abs(setMean - controlMean - reference) <= 1e-12,
        `cell ${cell}: the control genes are scanpy's (${setMean - controlMean} vs ${reference})`,
      );
      const tolerance = float32Ulp(Math.max(Math.abs(setMean), Math.abs(controlMean))) + float32Ulp(reference);
      assert.ok(
        Math.abs(page.scores[cell] - reference) <= tolerance,
        `cell ${cell}: ${page.scores[cell]} vs ${reference}`,
      );
    }
  });
}
