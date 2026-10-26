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

import { createUcellContext, ucellAddGenes, ucellFinish } from '../assets/js/app/analysis/compute/ucell.js';

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
  let sum = 0;
  for (const s of members) {
    const rank = rankOf(UNION[s]);
    sum += rank > maxRank ? maxRank + 1 : rank;
  }
  const size = members.length;
  return 1 - (sum - (size * (size + 1)) / 2) / (size * maxRank);
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
