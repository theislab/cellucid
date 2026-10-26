/**
 * The analysis kernels walk a gene's non-zero entries only. Their answers must
 * be the answers a walk over every cell gives, so each is pinned here against
 * a dense reference built from the shared definitions in math-utils — the
 * same comparisons the dense kernels made before — with `Object.is`: the same
 * IEEE-754 doubles, not merely close ones. Where the numbers are not defined
 * by one summation order (the one-vs-rest Welch moments), the bound is stated.
 *
 * The inputs are expression-shaped (mostly zeros, few distinct values) and
 * also carry every edge the kernels have to get right: negative values, -0,
 * NaN and infinities, all-zero genes, tiny groups, fully tied pools, and more
 * distinct values than the tabulation bound.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOG2_FOLD_CHANGE_PSEUDOCOUNT,
  MAX_TABULATED_DISTINCT_VALUES,
  log2FoldChangeOfMeans,
  mannWhitneyU,
  mean,
  welchTTest
} from '../assets/js/app/analysis/compute/math-utils.js';
import {
  createGroupingContext,
  createTwoGroupContext,
  geneSampleOf,
  groupMarkers,
  splitTwoGroups,
  twoSampleDifferential
} from '../assets/js/app/analysis/compute/gene-statistics.js';
import {
  computeDifferential,
  computeDifferentialOfColumns,
  computeDifferentialOfSubset,
  clearTwoGroupContext,
  setTwoGroupContext
} from '../assets/js/app/analysis/compute/operation-handlers.js';
import { benjaminiHochbergAdjusted } from '../assets/js/app/analysis/stats/statistical-tests.js';
import { createFrameThrottle } from '../assets/js/app/analysis/shared/concurrency-utils.js';

import { virtualTime } from './helpers/virtual-time.mjs';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One gene over `length` cells: a fraction `density` non-zero, drawn from
 * `levels` distinct values (or continuous when `levels` is 0), with optional
 * negatives, -0, and missing values.
 */
function expressionGene(length, seed, {
  density = 0.05,
  levels = 12,
  negative = false,
  missing = 0,
  negativeZeros = 0
} = {}) {
  const random = mulberry32(seed);
  const values = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const draw = random();
    if (draw < missing) {
      values[i] = [NaN, Infinity, -Infinity][Math.floor(random() * 3)];
    } else if (draw < missing + density) {
      const magnitude = levels === 0
        ? random() * 9 + 0.001
        : (1 + Math.floor(random() * levels)) * 0.37;
      values[i] = negative && random() < 0.3 ? -magnitude : magnitude;
    } else if (random() < negativeZeros) {
      values[i] = -0;
    }
  }
  return values;
}

/** The dense differential-expression definition the kernels replaced. */
function denseDifferential(groupA, groupB, method) {
  const a = Array.from(groupA).filter(Number.isFinite);
  const b = Array.from(groupB).filter(Number.isFinite);
  if (a.length < 2 || b.length < 2) {
    return { meanA: NaN, meanB: NaN, log2FoldChange: NaN, pValue: NaN, statistic: NaN, nA: a.length, nB: b.length };
  }
  const meanA = mean(a);
  const meanB = mean(b);
  let minimum = Infinity;
  for (const value of a) if (value < minimum) minimum = value;
  for (const value of b) if (value < minimum) minimum = value;
  const test = method === 'wilcox' ? mannWhitneyU(a, b) : welchTTest(a, b);
  return {
    meanA,
    meanB,
    log2FoldChange: log2FoldChangeOfMeans(meanA, meanB, minimum),
    pValue: test.pValue,
    statistic: test.statistic,
    nA: a.length,
    nB: b.length,
    method
  };
}

const DE_KEYS = ['meanA', 'meanB', 'log2FoldChange', 'pValue', 'statistic', 'nA', 'nB'];

/** Gene `k`'s numbers in a batch of results (one entry a gene). */
function rowOf(batch, k) {
  return Object.fromEntries(DE_KEYS.map(key => [key, batch[key][k]]));
}

function assertSameDifferential(actual, expected, label) {
  for (const key of DE_KEYS) {
    assert.ok(Object.is(actual[key], expected[key]), `${label} ${key}: ${actual[key]} !== ${expected[key]}`);
  }
}

function sparseOf(values) {
  const indices = [];
  const stored = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== 0) {
      indices.push(i);
      stored.push(values[i]);
    }
  }
  return { length: values.length, indices: Uint32Array.from(indices), values: Float32Array.from(stored) };
}

const SHAPES = [
  ['sparse quantised', { density: 0.02, levels: 8 }],
  ['dense quantised', { density: 0.6, levels: 16 }],
  ['negative values and -0', { density: 0.1, levels: 6, negative: true, negativeZeros: 0.2 }],
  ['missing values', { density: 0.1, levels: 6, missing: 0.05 }],
  ['continuous past the tabulation bound', { density: 0.5, levels: 0 }],
  ['all zero', { density: 0, levels: 4 }]
];

test('two-sample differential expression over non-zero entries equals the dense definition', () => {
  let comparisons = 0;
  for (const [shape, options] of SHAPES) {
    for (let trial = 0; trial < 40; trial++) {
      const random = mulberry32(trial + 17);
      // Tiny groups (exact Mann-Whitney, n < 2) through to large ones.
      const nA = trial < 8 ? trial : 1 + Math.floor(random() * 3000);
      const nB = trial < 8 ? 9 - trial : 1 + Math.floor(random() * 3000);
      const groupA = expressionGene(nA, trial * 7 + 1, options);
      const groupB = expressionGene(nB, trial * 7 + 2, { ...options, density: (options.density ?? 0) * 1.5 });
      for (const method of ['wilcox', 'ttest']) {
        const expected = denseDifferential(groupA, groupB, method);
        const label = `${shape} trial ${trial} ${method}`;
        assertSameDifferential(computeDifferential({ groupAValues: groupA, groupBValues: groupB, method }), expected, `${label} dense`);
        assertSameDifferential(
          computeDifferential({ groupAValues: sparseOf(groupA), groupBValues: sparseOf(groupB), method }),
          expected,
          `${label} sparse`
        );
        // Plain arrays of doubles keep their precision.
        assertSameDifferential(
          computeDifferential({ groupAValues: Array.from(groupA, v => v * 1.1), groupBValues: Array.from(groupB), method }),
          denseDifferential(Array.from(groupA, v => v * 1.1), groupB, method),
          `${label} array`
        );
        comparisons++;
      }
    }
  }
  assert.equal(comparisons, SHAPES.length * 40 * 2);
});

test('a fully tied pool and a high-cardinality pool keep their exact probabilities', () => {
  const zeros = twoSampleDifferential(geneSampleOf(new Float32Array(30), 0), geneSampleOf(new Float32Array(40), 1), 'wilcox');
  assert.equal(zeros.pValue, 1, 'every value tied: no evidence');
  assert.equal(zeros.statistic, 600);

  // More distinct non-zero values than the tabulation bound, in both groups.
  const size = MAX_TABULATED_DISTINCT_VALUES * 2;
  const groupA = expressionGene(size, 5, { density: 0.9, levels: 0 });
  const groupB = expressionGene(size, 6, { density: 0.9, levels: 0, negative: true });
  for (const method of ['wilcox', 'ttest']) {
    assertSameDifferential(
      twoSampleDifferential(sparseOf(groupA), sparseOf(groupB), method),
      denseDifferential(groupA, groupB, method),
      `high cardinality ${method}`
    );
  }
});

test('a gene column split into two held groups equals gathering the groups', () => {
  const cells = 20_000;
  const random = mulberry32(99);
  const groupOfCell = new Uint8Array(cells);
  for (let cell = 0; cell < cells; cell++) {
    const draw = random();
    groupOfCell[cell] = draw < 0.05 ? 1 : (draw < 0.5 ? 2 : 0);
  }
  const cellsOf = group => Array.from(groupOfCell.keys()).filter(cell => groupOfCell[cell] === group);
  const cellsA = cellsOf(1);
  const cellsB = cellsOf(2);
  const contextId = 'identity-run';
  assert.deepEqual(
    setTwoGroupContext({ contextId, groupOfCell }),
    { sizeA: cellsA.length, sizeB: cellsB.length }
  );
  try {
    for (const [shape, options] of SHAPES) {
      const column = expressionGene(cells, shape.length * 31, options);
      const groupA = Float32Array.from(cellsA, cell => column[cell]);
      const groupB = Float32Array.from(cellsB, cell => column[cell]);
      for (const method of ['wilcox', 'ttest']) {
        const expected = denseDifferential(groupA, groupB, method);
        // One task's columns: the gene dense, and the same gene as its entries.
        const batch = computeDifferentialOfColumns({ contextId, columns: [column, sparseOf(column)], method });
        assertSameDifferential(rowOf(batch, 0), expected, `${shape} ${method} dense column`);
        assertSameDifferential(rowOf(batch, 1), expected, `${shape} ${method} sparse column`);
      }
    }
  } finally {
    assert.deepEqual(clearTwoGroupContext({ contextId }), { released: true });
  }
  assert.throws(() => computeDifferentialOfColumns({ contextId, columns: [new Float32Array(cells)], method: 'wilcox' }), /not held/);
});

test('a run of genes read by cell gives each gene its gathered-group numbers', () => {
  // The union of two groups' cells, in cell order, and each position's group.
  const random = mulberry32(7);
  const union = 3000;
  const groupOfPosition = new Uint8Array(union);
  for (let position = 0; position < union; position++) groupOfPosition[position] = random() < 0.4 ? 1 : 2;
  const genes = SHAPES.map(([, options], g) => expressionGene(union, 400 + g, options));
  const pointers = new Float64Array(genes.length + 1);
  const positions = [];
  const values = [];
  genes.forEach((gene, g) => {
    const sparse = sparseOf(gene);
    positions.push(...sparse.indices);
    values.push(...sparse.values);
    pointers[g + 1] = positions.length;
  });
  // The groups of the subset's positions are held once, as a column's cells are.
  const contextId = 'subset-run';
  setTwoGroupContext({ contextId, groupOfCell: groupOfPosition });
  for (const method of ['wilcox', 'ttest']) {
    const run = computeDifferentialOfSubset({
      contextId,
      block: { pointers, positions: Uint32Array.from(positions), values: Float32Array.from(values) },
      method
    });
    genes.forEach((gene, g) => {
      const groupA = gene.filter((_, position) => groupOfPosition[position] === 1);
      const groupB = gene.filter((_, position) => groupOfPosition[position] === 2);
      const expected = denseDifferential(groupA, groupB, method);
      const actual = Object.fromEntries(DE_KEYS.map(key => [key, run[key][g]]));
      assertSameDifferential(actual, expected, `${SHAPES[g][0]} ${method}`);
    });
  }
  assert.deepEqual(clearTwoGroupContext({ contextId }), { released: true });
});

test('splitting a sample checks that its entries are ascending', () => {
  const context = createTwoGroupContext(Uint8Array.of(1, 2, 1, 2));
  assert.throws(
    () => splitTwoGroups({ length: 4, indices: Uint32Array.of(2, 1), values: Float32Array.of(1, 2) }, context),
    /strictly ascending/
  );
  assert.throws(() => createTwoGroupContext(Uint8Array.of(0, 3)), /memberships are 0, 1 or 2/);
});

/** One-vs-rest marker statistics for every group, from the dense definitions. */
function denseMarkers(values, cellGroupIndex, groupCount, method, minCells) {
  const out = [];
  for (let g = 0; g < groupCount; g++) {
    const inGroup = [];
    const rest = [];
    for (let cell = 0; cell < values.length; cell++) {
      const group = cellGroupIndex[cell];
      if (group < 0 || !Number.isFinite(values[cell])) continue;
      (group === g ? inGroup : rest).push(values[cell]);
    }
    let sum = 0;
    for (const value of inGroup) sum += value;
    const tested = inGroup.length >= Math.max(2, minCells) && rest.length >= Math.max(2, minCells);
    out.push({
      nIn: inGroup.length,
      nOut: rest.length,
      meanIn: inGroup.length > 0 ? Math.fround(sum / inGroup.length) : NaN,
      pValue: tested ? (method === 'wilcox' ? mannWhitneyU(inGroup, rest) : welchTTest(inGroup, rest)).pValue : NaN,
      percentIn: inGroup.length > 0 ? Math.fround((inGroup.filter(v => v !== 0).length / inGroup.length) * 100) : 0
    });
  }
  return out;
}

test('markers against the rest over non-zero entries keep every group\'s exact statistics', () => {
  const cells = 12_000;
  const groupCount = 6;
  const random = mulberry32(3);
  const cellGroupIndex = new Int16Array(cells);
  for (let cell = 0; cell < cells; cell++) {
    // A rare group (exact Mann-Whitney once its tie-free) and ungrouped cells.
    const draw = random();
    cellGroupIndex[cell] = draw < 0.03 ? -1 : (draw < 0.033 ? 5 : Math.floor(random() * 5));
  }
  const context = createGroupingContext(cellGroupIndex, groupCount);
  for (const [shape, options] of SHAPES) {
    const values = expressionGene(cells, shape.length * 13, options);
    for (const method of ['wilcox', 'ttest']) {
      const options = {
        method,
        minCells: 3,
        pConvention: 'exact',
        foldChange: { mode: 'stored', pseudocount: LOG2_FOLD_CHANGE_PSEUDOCOUNT }
      };
      const dense = groupMarkers(geneSampleOf(values, 0), context, options);
      const sparse = groupMarkers(sparseOf(values), context, options);
      for (const key of Object.keys(dense)) {
        if (key === 'nAll' || key === 'column') {
          assert.deepEqual(sparse[key], dense[key]);
          continue;
        }
        for (let g = 0; g < groupCount; g++) {
          assert.ok(Object.is(sparse[key][g], dense[key][g]), `${shape} ${method} ${key}[${g}] dense and sparse differ`);
        }
      }
      const reference = denseMarkers(values, cellGroupIndex, groupCount, method, 3);
      for (let g = 0; g < groupCount; g++) {
        const label = `${shape} ${method} group ${g}`;
        assert.equal(dense.nIn[g], reference[g].nIn, `${label} nIn`);
        assert.equal(dense.nOut[g], reference[g].nOut, `${label} nOut`);
        // A group's mean is its values summed in cell order over their count.
        assert.ok(Object.is(dense.meanInGroup[g], reference[g].meanIn), `${label} mean ${dense.meanInGroup[g]} vs ${reference[g].meanIn}`);
        assert.ok(Object.is(dense.percentInGroup[g], reference[g].percentIn), `${label} percent`);
        if (method === 'wilcox') {
          // Exactly the two-sample test of the group against the rest.
          assert.ok(Object.is(dense.pValues[g], reference[g].pValue), `${label} p ${dense.pValues[g]} vs ${reference[g].pValue}`);
        } else if (Number.isNaN(reference[g].pValue)) {
          assert.ok(Number.isNaN(dense.pValues[g]), `${label} untested`);
        } else {
          // Welch from centred moments of the group and of all grouped cells:
          // the same statistic, summed in another order.
          const relative = Math.abs(dense.pValues[g] - reference[g].pValue) / Math.max(reference[g].pValue, 1e-300);
          assert.ok(relative < 1e-9, `${label} p ${dense.pValues[g]} vs ${reference[g].pValue}`);
        }
      }
    }
  }
});

test('marker moments are centred: a tiny spread around a large offset keeps its variance', () => {
  const size = 30_000;
  const cellGroupIndex = new Int16Array(size * 2);
  cellGroupIndex.fill(1, size);
  const values = new Float32Array(size * 2);
  for (let i = 0; i < size; i++) {
    values[i] = 100 + ((i % 3) - 1) * 1e-5;
    values[size + i] = 100.0001 + ((i % 3) - 1) * 1e-5;
  }
  const result = groupMarkers(geneSampleOf(values, 0), createGroupingContext(cellGroupIndex, 2), {
    method: 'ttest',
    minCells: 2,
    pConvention: 'exact',
    foldChange: { mode: 'stored', pseudocount: LOG2_FOLD_CHANGE_PSEUDOCOUNT }
  });
  assert.deepEqual([...result.pValues], [0, 0]);
  // The rest of group 0 is exactly group 1: its mean is exact, not a residue.
  assert.equal(result.meanOutGroup[0], result.meanInGroup[1]);
});

test('Benjamini-Hochberg ranks by p-value then position exactly as the record sort did', () => {
  const random = mulberry32(11);
  for (const size of [5, 900, 8192]) {
    const pValues = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      const draw = random();
      // Ties, exact zeros, ones and untested genes.
      pValues[i] = draw < 0.1 ? NaN : (draw < 0.2 ? 0 : (draw < 0.3 ? 1 : Math.round(random() * 500) / 1000));
    }
    const entries = [];
    pValues.forEach((pValue, index) => {
      if (Number.isFinite(pValue)) entries.push({ index, pValue });
    });
    entries.sort((a, b) => a.pValue - b.pValue || a.index - b.index);
    const expected = new Float64Array(size).fill(NaN);
    const m = entries.length;
    let runningMin = entries[m - 1].pValue;
    expected[entries[m - 1].index] = Math.min(runningMin, 1);
    for (let rank = m - 2; rank >= 0; rank--) {
      const raw = entries[rank].pValue * m / (rank + 1);
      if (raw < runningMin) runningMin = raw;
      expected[entries[rank].index] = Math.min(runningMin, 1);
    }
    const { adjustedPValues, testedCount } = benjaminiHochbergAdjusted(pValues);
    assert.equal(testedCount, m);
    for (let i = 0; i < size; i++) {
      assert.ok(Object.is(adjustedPValues[i], expected[i]), `size ${size} position ${i}`);
    }
  }
});

test('a frame throttle delivers the latest update at most once per interval', async () => {
  // On a virtual clock: a burst of pushes takes no time, however loaded the
  // machine, and a wait is exactly as long as it says.
  const time = virtualTime();
  const delivered = [];
  const throttle = createFrameThrottle(value => delivered.push(value), 20, { clock: time.now, after: time.after });
  let built = 0;
  for (let i = 1; i <= 50; i++) {
    throttle.push(() => {
      built++;
      return i;
    });
  }
  assert.deepEqual(delivered, [1], 'the first update is delivered at once');
  await time.sleep(30);
  assert.deepEqual(delivered, [1, 50], 'then only the latest, a frame later');
  await time.sleep(30);
  assert.equal(built, 2, 'replaced updates are never built');
  // A frame has passed: the next update goes at once; the ones right after
  // wait, and a flush delivers only the latest of them.
  throttle.push(() => 51);
  throttle.push(() => 52);
  throttle.push(() => 53);
  throttle.flush();
  assert.deepEqual(delivered, [1, 50, 51, 53]);
  // A cancelled update is never delivered.
  throttle.push(() => 54);
  throttle.cancel();
  await time.sleep(40);
  assert.deepEqual(delivered, [1, 50, 51, 53]);
});

