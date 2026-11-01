/**
 * Pseudobulk differential expression (analysis overhaul Phase 2): each
 * sample's cells of a group form one unit, a gene's unit value is its mean
 * over those cells (per-unit sums from the dot plot's one-pass kernel), and the
 * test is Welch's t between the two sides' unit means. References are SciPy
 * `ttest_ind(equal_var=False)` on the same per-sample means. A sample with
 * fewer of a side's cells than the minimum per sample is left out of that
 * side (audit F-8), and counted.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { pseudobulkGeneTest, pseudobulkUnits } from '../assets/js/app/analysis/stats/pseudobulk.js';
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

test('the sample-level Welch t matches SciPy on the per-sample means, from one pass of unit sums', () => {
  const { codes, cellsA, cellsB, column } = fixture();
  const units = pseudobulkUnits(cellsA, cellsB, codes, MISSING, CELLS.length, 1);
  const context = createGroupSummaryContext(units.cellUnit, units.unitCount);
  // The kernel reads the gene's non-zero entries: dense and sparse agree.
  const indices = Uint32Array.from([...column.keys()].filter(cell => column[cell] !== 0));
  const sparse = { length: column.length, indices, values: Float32Array.from(indices, cell => column[cell]) };
  for (const gene of [column, sparse]) {
    const summary = summarizeGenesByGroup(context, [gene], 0, 0);
    const row = pseudobulkGeneTest(summary.sum, summary.expressing, summary.measured, units.unitSide, { mode: 'stored', base: null }, 1);
    assert.ok(Math.abs(row.statistic - 1.8972714457968962) < 1e-6, `t ${row.statistic}`);
    assert.ok(Math.abs(row.pValue - 0.14098385787293172) < 1e-6, `p ${row.pValue}`);
    assert.ok(Math.abs(row.meanA - (1 + 2.5 + 3) / 3) < 1e-6);
    assert.ok(Math.abs(row.meanB - (0.5 + 0.7 + 1.9 + 0.2) / 4) < 1e-6);
    assert.equal(row.score, row.statistic);
    assert.equal(row.nA, 3);
    assert.equal(row.nB, 4);
    // Cells above 0: A 4 of 5 grouped, B 5 of 7.
    assert.ok(Math.abs(row.pctA - 80) < 1e-9);
    assert.ok(Math.abs(row.pctB - (500 / 7)) < 1e-9);
    assert.ok(Math.abs(row.log2FoldChange - Math.log2((row.meanA + 0.01) / (row.meanB + 0.01))) < 1e-6);
  }
});

test('a second SciPy reference, and a side with one sample is not tested', () => {
  const sizes = Uint32Array.of(1, 1, 1, 1, 1);
  const side = Uint8Array.of(1, 1, 2, 2, 2);
  const row = pseudobulkGeneTest(Float64Array.of(0.25, 0.75, 1.5, 2, 4), Uint32Array.of(1, 1, 1, 1, 1), sizes, side, { mode: 'stored', base: null }, 1);
  assert.ok(Math.abs(row.statistic - -2.4886840673530206) < 1e-6);
  assert.ok(Math.abs(row.pValue - 0.10985495793161469) < 1e-6);
  const lone = pseudobulkGeneTest(Float64Array.of(1, 2, 3), Uint32Array.of(1, 1, 1), Uint32Array.of(1, 1, 1), Uint8Array.of(1, 2, 2), { mode: 'stored', base: null }, 1);
  assert.equal(lone.nA, 1);
  assert.ok(Number.isNaN(lone.pValue));
  assert.ok(Number.isNaN(lone.log2FoldChange));
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
  const row = pseudobulkGeneTest(summary.sum, summary.expressing, summary.measured, units.unitSide, { mode: 'stored', base: null }, 2);
  // SciPy: ttest_ind([1.0, 2.5], [0.5, 1.9, 0.2], equal_var=False).
  assert.ok(Math.abs(row.statistic - 0.9655534140000175) < 1e-6, `t ${row.statistic}`);
  assert.ok(Math.abs(row.pValue - 0.4370900714010908) < 1e-6, `p ${row.pValue}`);
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
    const row = pseudobulkGeneTest(summary.sum, summary.expressing, summary.measured, units.unitSide, { mode: 'stored', base: null }, 1);
    // SciPy: ttest_ind([1.0, 2.5, 3.0], [0.5, 1.9, 0.2], equal_var=False):
    // B's sample 1 has no measured cell and is out; A's sample 1 is its one cell.
    assert.equal(row.nA, 3);
    assert.equal(row.nB, 3);
    assert.ok(Math.abs(row.meanA - (1 + 2.5 + 3) / 3) < 1e-6, `meanA ${row.meanA}`);
    assert.ok(Math.abs(row.meanB - (0.5 + 1.9 + 0.2) / 3) < 1e-6, `meanB ${row.meanB}`);
    assert.ok(Math.abs(row.statistic - 1.6306719195138268) < 1e-6, `t ${row.statistic}`);
    assert.ok(Math.abs(row.pValue - 0.17961422961821016) < 1e-6, `p ${row.pValue}`);
    // Shares over the measured cells: A 3 of 4 measured above 0, B 4 of 6.
    assert.ok(Math.abs(row.pctA - 75) < 1e-9, `pctA ${row.pctA}`);
    assert.ok(Math.abs(row.pctB - (400 / 6)) < 1e-9, `pctB ${row.pctB}`);
    // With two measured cells needed, A's samples 1 and 2 (one each) are out too.
    const strict = pseudobulkGeneTest(summary.sum, summary.expressing, summary.measured, units.unitSide, { mode: 'stored', base: null }, 2);
    assert.equal(strict.nA, 1);
    assert.ok(Number.isNaN(strict.pValue), 'one sample of A: not tested');
  }
  assert.throws(
    () => pseudobulkGeneTest(Float64Array.of(1), Uint32Array.of(1), Uint32Array.of(1), Uint8Array.of(1), { mode: 'stored', base: null }, 0),
    /positive integer/
  );
});
