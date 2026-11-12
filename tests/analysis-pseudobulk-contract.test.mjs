/**
 * Pseudobulk differential expression (analysis overhaul Phase 2): each
 * sample's cells of a group form one unit, a gene's unit value (a matrix
 * that is not counts) is its mean over those cells (per-unit sums from the
 * dot plot's one-pass kernel), and the fit is limma's (`~ group`; one gene:
 * too few to moderate, so its own residual variance). References are R
 * limma 3.68.5 `lmFit` + `eBayes(trend = TRUE)` on the same per-sample means
 * (NA for a sample short of measured cells). A sample with fewer of a
 * side's cells than the minimum per sample is left out of that side (audit
 * F-8), and counted. The counts path and moderation over many genes:
 * `analysis-pseudobulk-limma.test.mjs`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { pseudobulkLimma, pseudobulkUnits } from '../assets/js/app/analysis/stats/pseudobulk.js';
import {
  createGroupSummaryContext,
  summarizeGenesByGroup
} from '../assets/js/app/analysis/compute/group-expression-summary.js';

const MISSING = 255;
// cell: [side, sample, value]; side 0 is in neither group.
const CELLS = [
  [1, 0, 0], [1, 0, 2], // A, sample 0: mean 1.0
  [1, 1, 2.5], [1, 1, 2.5], // A, sample 1: mean 2.5
  [1, 2, 3], // A, sample 2: mean 3.0
  [1, MISSING, 100], // A, no sample: left out
  [2, 0, 1], [2, 0, 0], // B, sample 0: mean 0.5
  [2, 1, 0.7], // B, sample 1: mean 0.7
  [2, 3, 1.9], [2, 3, 1.9], // B, sample 3: mean 1.9
  [2, 4, 0.4], [2, 4, 0], // B, sample 4: mean 0.2
  [0, 2, 50], // neither group
];

/** One gene's fit from its unit sums (values as stored, not counts). */
function geneTest(sum, expressing, measured, unitSide, minCellsPerSample) {
  const unitCount = unitSide.length;
  const { genes } = pseudobulkLimma({
    sums: Float64Array.from(sum), measured, expressing, geneCount: 1,
    units: { unitCount, unitSide, unitSample: Int32Array.from({ length: unitCount }, (_, unit) => unit) },
    counts: false, minCellsPerSample, foldChange: { mode: 'stored', base: null }
  });
  const of = key => genes[key][0];
  return {
    meanA: of('meanA'), meanB: of('meanB'), pctA: of('pctA'), pctB: of('pctB'), log2FoldChange: of('log2FoldChange'),
    statistic: of('statistic'), pValue: of('pValue'), nA: of('nA'), nB: of('nB')
  };
}

function fixture() {
  const codes = Uint8Array.from(CELLS, ([, sample]) => sample);
  const cellsOf = side => Uint32Array.from(CELLS.flatMap(([s], cell) => (s === side ? [cell] : [])));
  const column = Float32Array.from(CELLS, ([, , value]) => value);
  return { codes, cellsA: cellsOf(1), cellsB: cellsOf(2), column };
}

test('each sample of each side is one unit; cells without a sample are left out', () => {
  const { codes, cellsA, cellsB } = fixture();
  const units = pseudobulkUnits(cellsA, cellsB, codes, MISSING, CELLS.length, 1);
  assert.equal(units.unitCount, 7);
  assert.deepEqual([...units.unitSide], [1, 1, 1, 2, 2, 2, 2]);
  assert.deepEqual([...units.unitSample], [0, 1, 2, 0, 1, 3, 4]);
  assert.equal(units.unitsA, 3);
  assert.equal(units.unitsB, 4);
  assert.equal(units.cellsLeftOut, 1);
  assert.deepEqual([...units.cellUnit], [0, 0, 1, 1, 2, -1, 3, 3, 4, 5, 5, 6, 6, -1]);
});

test('the sample-level t matches limma on the per-sample means, from one pass of unit sums', () => {
  const { codes, cellsA, cellsB, column } = fixture();
  const units = pseudobulkUnits(cellsA, cellsB, codes, MISSING, CELLS.length, 1);
  const context = createGroupSummaryContext(units.cellUnit, units.unitCount);
  // The kernel reads the gene's non-zero entries: dense and sparse agree.
  const indices = Uint32Array.from([...column.keys()].filter(cell => column[cell] !== 0));
  const sparse = { length: column.length, indices, values: Float32Array.from(indices, cell => column[cell]) };
  for (const gene of [column, sparse]) {
    const summary = summarizeGenesByGroup(context, [gene], 0, 0);
    const row = geneTest(summary.sum, summary.expressing, summary.measured, units.unitSide, 1);
    assert.ok(Math.abs(row.statistic - 2.006022230728274) < 1e-6, `t ${row.statistic}`);
    assert.ok(Math.abs(row.pValue - 0.10115864056452907) < 1e-6, `p ${row.pValue}`);
    assert.ok(Math.abs(row.meanA - (1 + 2.5 + 3) / 3) < 1e-6);
    assert.ok(Math.abs(row.meanB - (0.5 + 0.7 + 1.9 + 0.2) / 4) < 1e-6);
    assert.equal(row.nA, 3);
    assert.equal(row.nB, 4);
    // Cells above 0: A 4 of 5 grouped, B 5 of 7.
    assert.ok(Math.abs(row.pctA - 80) < 1e-9);
    assert.ok(Math.abs(row.pctB - (500 / 7)) < 1e-9);
    assert.ok(Math.abs(row.log2FoldChange - Math.log2((row.meanA + 0.01) / (row.meanB + 0.01))) < 1e-6);
  }
});

test('a second limma reference, and a side with one sample is still fit (its variance from the other side)', () => {
  const sizes = Uint32Array.of(1, 1, 1, 1, 1);
  const side = Uint8Array.of(1, 1, 2, 2, 2);
  const row = geneTest(Float64Array.of(0.25, 0.75, 1.5, 2, 4), Uint32Array.of(1, 1, 1, 1, 1), sizes, side, 1);
  assert.ok(Math.abs(row.statistic - -1.9930915164897594) < 1e-6);
  assert.ok(Math.abs(row.pValue - 0.14026243996564908) < 1e-6);
  // limma fits ~ group on 1 + 2 samples: one residual df.
  const lone = geneTest(Float64Array.of(1, 2, 3), Uint32Array.of(1, 1, 1), Uint32Array.of(1, 1, 1), Uint8Array.of(1, 2, 2), 1);
  assert.equal(lone.nA, 1);
  assert.ok(Math.abs(lone.statistic - -1.7320508075688763) < 1e-6);
  assert.ok(Math.abs(lone.pValue - 0.33333333333333343) < 1e-6);
});

test('a sample with fewer cells than the minimum is left out of its side, and counted', () => {
  const { codes, cellsA, cellsB, column } = fixture();
  assert.throws(() => pseudobulkUnits(cellsA, cellsB, codes, MISSING, CELLS.length, 0), /positive integer/);
  // A's sample 2 and B's sample 1 hold one cell each.
  const units = pseudobulkUnits(cellsA, cellsB, codes, MISSING, CELLS.length, 2);
  assert.deepEqual([...units.unitSide], [1, 1, 2, 2, 2]);
  assert.deepEqual([...units.unitSample], [0, 1, 0, 3, 4]);
  assert.equal(units.smallUnitsA, 1);
  assert.equal(units.smallUnitsB, 1);
  assert.equal(units.cellsInSmallUnits, 2);
  assert.equal(units.cellsLeftOut, 1);
  assert.deepEqual([...units.cellUnit], [0, 0, 1, 1, -1, -1, 2, 2, -1, 3, 3, 4, 4, -1]);
  const context = createGroupSummaryContext(units.cellUnit, units.unitCount);
  const summary = summarizeGenesByGroup(context, [column], 0, 0);
  const row = geneTest(summary.sum, summary.expressing, summary.measured, units.unitSide, 2);
  // limma: lmFit(c(1.0, 2.5, 0.5, 1.9, 0.2), ~ group), eBayes.
  assert.ok(Math.abs(row.statistic - 1.0067122891834714) < 1e-6, `t ${row.statistic}`);
  assert.ok(Math.abs(row.pValue - 0.38823601425710602) < 1e-6, `p ${row.pValue}`);
  assert.equal(row.nA, 2);
  assert.equal(row.nB, 3);
});

test('a cell without a value (NaN) is out of its unit mean, and a unit short of measured cells out of that gene', () => {
  const { codes, cellsA, cellsB, column } = fixture();
  const units = pseudobulkUnits(cellsA, cellsB, codes, MISSING, CELLS.length, 1);
  const context = createGroupSummaryContext(units.cellUnit, units.unitCount);
  // A's sample 1 loses one of its two cells (2.5 → NaN), B's sample 1 its only cell.
  const unmeasured = Float32Array.from(column);
  unmeasured[3] = NaN;
  unmeasured[8] = NaN;
  const indices = Uint32Array.from([...unmeasured.keys()].filter(cell => unmeasured[cell] !== 0));
  const sparse = { length: unmeasured.length, indices, values: Float32Array.from(indices, cell => unmeasured[cell]) };
  for (const gene of [unmeasured, sparse]) {
    const summary = summarizeGenesByGroup(context, [gene], 0, 0);
    assert.deepEqual([...summary.measured], [2, 1, 1, 2, 0, 2, 2]);
    assert.deepEqual([...summary.sizes], [2, 2, 1, 2, 1, 2, 2]);
    const row = geneTest(summary.sum, summary.expressing, summary.measured, units.unitSide, 1);
    // limma on c(1.0, 2.5, 3.0) and c(0.5, NA, 1.9, 0.2): B's sample 1 has
    // no measured cell and is missing; A's sample 1 is its one cell.
    assert.equal(row.nA, 3);
    assert.equal(row.nB, 3);
    assert.ok(Math.abs(row.meanA - (1 + 2.5 + 3) / 3) < 1e-6, `meanA ${row.meanA}`);
    assert.ok(Math.abs(row.meanB - (0.5 + 1.9 + 0.2) / 3) < 1e-6, `meanB ${row.meanB}`);
    assert.ok(Math.abs(row.statistic - 1.6306719195138273) < 1e-6, `t ${row.statistic}`);
    assert.ok(Math.abs(row.pValue - 0.17829396619779228) < 1e-6, `p ${row.pValue}`);
    // Shares over the measured cells: A 3 of 4 measured above 0, B 4 of 6.
    assert.ok(Math.abs(row.pctA - 75) < 1e-9, `pctA ${row.pctA}`);
    assert.ok(Math.abs(row.pctB - (400 / 6)) < 1e-9, `pctB ${row.pctB}`);
    // With two measured cells needed, A's samples 1 and 2 (one each) are
    // missing too: limma on c(1.0, NA, NA) and c(0.5, NA, 1.9, 0.2).
    const strict = geneTest(summary.sum, summary.expressing, summary.measured, units.unitSide, 2);
    assert.equal(strict.nA, 1);
    assert.ok(Math.abs(strict.statistic - 0.12725695259515582) < 1e-6, `t ${strict.statistic}`);
    assert.ok(Math.abs(strict.pValue - 0.91037785701035567) < 1e-6, `p ${strict.pValue}`);
  }
  assert.throws(() => geneTest(Float64Array.of(1, 2), Uint32Array.of(1, 1), Uint32Array.of(1, 1), Uint8Array.of(1, 2), 0), /positive integer/);
});
