/**
 * UCell scores (`compute/ucell.js`) equal the numpy reference of
 * `tests/fixtures/analysis/scanpy-reference.json` (`ucell`: each cell's genes
 * ranked highest first with `rankdata` average ties, ranks past `max_rank`
 * as `max_rank + 1`, score `1 − (Σ ranks − S(S+1)/2) / (S · max_rank)`), and
 * do not depend on how the cells are split across workers.
 *
 * The cells are split into W ∈ {1, 2, 3, 7} contiguous ranges, one per
 * worker, as `MultiVariableAnalysis._ucellScores` splits them; every gene
 * reaches every range as its non-zero entries there, several genes per
 * message. The scores of every split are bit-identical, and equal to the
 * reference rounded to float32 (ranks are exact; the formula is the same
 * double expression on both sides, then stored as float32).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createUcellContext, ucellAddGenes, ucellContextBytesPerCell, ucellFinish } from '../assets/js/app/analysis/compute/ucell.js';

const REFERENCE = JSON.parse(readFileSync(new URL('./fixtures/analysis/scanpy-reference.json', import.meta.url), 'utf8'));
const { var_names: GENES, X } = REFERENCE.data;
const CELLS = X.length;
const SIGNATURE = REFERENCE.ucell.max_rank_10.genes;
const UNION = SIGNATURE.map(gene => GENES.indexOf(gene));
/** The fixture's set, and a second set of three of its genes. */
const SETS = [[0, 1, 2, 3, 4], [4, 0, 2]];
const GENES_PER_MESSAGE = 5;

/** The cells [from, to) scored as one worker scores them. */
function scoreRange(from, to, maxRank) {
  const cellCount = to - from;
  const S = UNION.length;
  const setValues = new Float32Array(cellCount * S);
  for (let c = 0; c < cellCount; c++) {
    UNION.forEach((j, s) => { setValues[c * S + s] = X[from + c][j]; });
  }
  const context = createUcellContext({
    cellCount, setValues, setGeneCount: S, geneCount: GENES.length, sets: SETS, maxRank,
  });
  for (let first = 0; first < GENES.length; first += GENES_PER_MESSAGE) {
    const last = Math.min(GENES.length, first + GENES_PER_MESSAGE);
    const pointers = new Uint32Array(last - first + 1);
    const cells = [];
    const values = [];
    for (let j = first; j < last; j++) {
      for (let c = 0; c < cellCount; c++) {
        const value = X[from + c][j];
        if (value !== 0) {
          cells.push(c);
          values.push(value);
        }
      }
      pointers[j - first + 1] = cells.length;
    }
    ucellAddGenes(context, { pointers, cells: Uint32Array.from(cells), values: Float32Array.from(values) });
  }
  return ucellFinish(context);
}

/** Every cell's scores with the cells split into `workers` contiguous ranges. */
function scoreSplit(workers, maxRank) {
  const out = new Float32Array(CELLS * SETS.length);
  const size = Math.ceil(CELLS / workers);
  for (let from = 0; from < CELLS; from += size) {
    const to = Math.min(CELLS, from + size);
    out.set(scoreRange(from, to, maxRank), from * SETS.length);
  }
  return out;
}

/** UCell of one cell and set, written from its definition. */
function definitionScore(cell, members, maxRank) {
  const row = X[cell];
  const rankOf = j => {
    let greater = 0;
    let equal = 0;
    for (const value of row) {
      if (value > row[j]) greater++;
      else if (value === row[j]) equal++;
    }
    return greater + (equal + 1) / 2;
  };
  // The UCell package's u_stat: max rank at most the genes, ranks at or past
  // it count as it, normalized by the range S·maxRank − S(S+1)/2.
  const cap = Math.min(maxRank, row.length);
  let sum = 0;
  for (const s of members) {
    const rank = rankOf(UNION[s]);
    sum += rank >= cap ? cap : rank;
  }
  const size = members.length;
  const fewest = (size * (size + 1)) / 2;
  return 1 - (sum - fewest) / (size * cap - fewest);
}

for (const [name, expected] of Object.entries(REFERENCE.ucell)) {
  test(`UCell ${name}: every split across workers gives the reference scores`, () => {
    assert.deepEqual(expected.genes, SIGNATURE);
    const single = scoreSplit(1, expected.max_rank);
    for (const workers of [2, 3, 7]) {
      assert.deepEqual(scoreSplit(workers, expected.max_rank), single, `${workers} workers`);
    }
    for (let cell = 0; cell < CELLS; cell++) {
      assert.equal(single[cell * SETS.length], Math.fround(expected.scores[cell]), `cell ${cell}`);
      assert.equal(
        single[cell * SETS.length + 1],
        Math.fround(definitionScore(cell, SETS[1], expected.max_rank)),
        `cell ${cell}, second set`,
      );
    }
  });
}

test('a set gene without a value leaves its cell unscored; an entry outside the range is refused', () => {
  const setValues = Float32Array.of(1, NaN, 2, 3);
  const context = createUcellContext({
    cellCount: 2, setValues, setGeneCount: 2, geneCount: 3, sets: [[0, 1]], maxRank: 3,
  });
  ucellAddGenes(context, { pointers: Uint32Array.of(0, 2, 4), cells: Uint32Array.of(0, 1, 1, 0), values: Float32Array.of(1, 2, 3, NaN) });
  const scores = ucellFinish(context);
  assert.ok(Number.isNaN(scores[0]));
  assert.ok(Number.isFinite(scores[1]));
  assert.throws(
    () => ucellAddGenes(context, { pointers: Uint32Array.of(0, 1), cells: Uint32Array.of(2), values: Float32Array.of(1) }),
    RangeError,
  );
  assert.throws(
    () => createUcellContext({ cellCount: 2, setValues: new Float32Array(3), setGeneCount: 2, geneCount: 3, sets: [[0]], maxRank: 3 }),
    TypeError,
  );
});

test('a UCell context holds ucellContextBytesPerCell(S) bytes a cell', () => {
  for (const [cellCount, S] of [[1, 1], [7, 3], [40, 20]]) {
    const context = createUcellContext({ cellCount, setValues: new Float32Array(cellCount * S), setGeneCount: S, geneCount: S + 2, sets: [[0]], maxRank: 5 });
    const held = Object.values(context).filter(ArrayBuffer.isView).reduce((sum, array) => sum + array.byteLength, 0);
    assert.equal(held, cellCount * ucellContextBytesPerCell(S));
  }
});

test('UCell scores 0 with no set gene within the max rank and 1 for the top genes; a NaN set value orders last', () => {
  // One cell of five genes: set genes 3 and 4 hold the two lowest values.
  const values = [[5, 4, 3, 1, 0.5]];
  const context = createUcellContext({
    cellCount: 1, setValues: Float32Array.of(1, 0.5, 5, 4), setGeneCount: 4, geneCount: 5, sets: [[0, 1], [2, 3]], maxRank: 3,
  });
  ucellAddGenes(context, { pointers: Uint32Array.of(0, 1, 2, 3, 4, 5), cells: new Uint32Array(5), values: Float32Array.from(values[0]) });
  const [bottom, top] = ucellFinish(context);
  assert.equal(bottom, 0, 'no set gene within the max rank: 0, as UCell (the 2021 form gave (S − 1) / (2 maxRank))');
  assert.equal(top, 1);
  // A max rank past the genes is the gene count, as UCell caps it.
  const capped = createUcellContext({ cellCount: 1, setValues: new Float32Array(2), setGeneCount: 2, geneCount: 4, sets: [[0, 1]], maxRank: 1500 });
  assert.equal(capped.maxRank, 4);
  // A set too long for the max rank has no score range.
  assert.throws(
    () => createUcellContext({ cellCount: 1, setValues: new Float32Array(3), setGeneCount: 3, geneCount: 10, sets: [[0, 1, 2]], maxRank: 2 }),
    /must exceed half/
  );
  // NaN among a cell's set values sorts after every value, whichever engine sorts.
  const withNaN = createUcellContext({
    cellCount: 1, setValues: Float32Array.of(NaN, 2, 1, NaN, 3), setGeneCount: 5, geneCount: 8, sets: [[1, 2, 4]], maxRank: 8,
  });
  assert.deepEqual([...withNaN.sorted].slice(0, 3), [1, 2, 3]);
  assert.ok(Number.isNaN(withNaN.sorted[3]) && Number.isNaN(withNaN.sorted[4]));
});
