/**
 * The Composition CSV (`composition-ui.js` `tableFile`) against the result an
 * agent reads (`_resultTable`): one table (`compositionTable`), so every
 * column they share holds the same value for every cell type, and the file
 * says what a reader of it alone needs — the samples each condition's mean is
 * over and, for a paired test, the pairs the test took (F108: a paired run's
 * file gave every sample as the test's, `n_samples_Liver 14` beside a paired
 * t over 7 donors, and left out the per-sample proportions the result shows).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CompositionUI } from '../assets/js/app/analysis/ui/analysis-types/composition-ui.js';
import { compositionPairs, testComposition } from '../assets/js/app/analysis/stats/composition-tests.js';

/** Split one CSV line (quoted cells with commas allowed). */
function cellsOf(line) {
  const out = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { cell += '"'; i++; } else if (char === '"') quoted = false; else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { out.push(cell); cell = ''; } else cell += char;
  }
  out.push(cell);
  return out;
}

/**
 * Three donors in Liver and Spleen (pairs), one donor in Liver only and one in
 * Spleen only; four cell types, one ("Mono, classical") with a comma, one
 * ("Langerhans") with cells in one pair only.
 */
function pairedComposition({ paired }) {
  const units = [
    { sample: 'D1', condition: 'Liver', label: 'D1 · Liver' }, { sample: 'D1', condition: 'Spleen', label: 'D1 · Spleen' },
    { sample: 'D2', condition: 'Liver', label: 'D2 · Liver' }, { sample: 'D2', condition: 'Spleen', label: 'D2 · Spleen' },
    { sample: 'D3', condition: 'Liver', label: 'D3 · Liver' }, { sample: 'D3', condition: 'Spleen', label: 'D3 · Spleen' },
    { sample: 'D4', condition: 'Liver', label: 'D4' },
    { sample: 'D5', condition: 'Spleen', label: 'D5' },
  ];
  const unitSample = Int32Array.of(0, 0, 1, 1, 2, 2, 3, 4);
  const conditionOfUnit = Int32Array.of(0, 1, 0, 1, 0, 1, 0, 1);
  const types = ['Kupffer-like', 'Mono, classical', 'DC1', 'Langerhans'];
  const counts = Uint32Array.from([
    [50, 4, 61, 3, 47, 6, 30, 2],
    [100, 80, 120, 95, 90, 70, 60, 40],
    [5, 30, 4, 28, 6, 35, 2, 20],
    // Cells in one pair (D1's spleen) and in D5: paired, too few pairs to test (F109).
    [0, 2, 0, 0, 0, 0, 0, 1],
  ].flat());
  const testResult = testComposition({
    counts, typeCount: types.length, unitCount: units.length, conditionOfUnit, conditionCount: 2,
    samples: true, unitSample, paired, method: 'logit', correction: 'bh',
  });
  return {
    types, units, counts, conditionOfUnit, conditions: ['Liver', 'Spleen'], test: testResult,
    totalCells: counts.reduce((sum, value) => sum + value, 0),
    fields: { cellTypes: 'cell_type', samples: 'donor', condition: 'organ' },
    method: 'logit', correction: 'bh',
    samplesInBoth: compositionPairs(unitSample, conditionOfUnit).first.length,
  };
}

function exported(composition) {
  const ui = Object.create(CompositionUI.prototype);
  ui._lastResult = { composition };
  const file = ui.tableFile();
  const [header, ...lines] = file.csv.split('\n').map(cellsOf);
  const table = ui._resultTable({ composition }, Infinity);
  return { file, header, lines, table };
}

for (const paired of [true, false]) {
  test(`the ${paired ? 'paired' : 'unpaired'} composition CSV is the result table, plus the statistic and the samples behind each number (F108)`, () => {
    const composition = pairedComposition({ paired });
    const { file, header, lines, table } = exported(composition);
    assert.equal(file.name, 'composition_results');
    // Every column the result shows is in the file, in the same order, and per-sample proportions are among them.
    assert.deepEqual(header.filter(column => table.columns.includes(column)), table.columns);
    for (const unit of composition.units) assert.ok(header.includes(`proportion_${unit.label}`), unit.label);
    assert.equal(lines.length, composition.types.length, 'every cell type');
    assert.equal(table.rows.length, composition.types.length);
    for (const [at, row] of table.rows.entries()) {
      const line = lines[at];
      for (const [column, value] of table.columns.map((name, index) => [name, row[index]])) {
        const text = line[header.indexOf(column)];
        if (value === null) assert.equal(text, '', `${row[0]} ${column}: a missing value is an empty cell`);
        else if (typeof value === 'number') assert.equal(Number(text), value, `${row[0]} ${column}`);
        else assert.equal(text, value, `${row[0]} ${column}`);
      }
      const type = composition.types.indexOf(row[0]);
      const statistic = line[header.indexOf('statistic')];
      // A missing value is an empty cell, read back as NaN.
      assert.equal(statistic === '' ? NaN : Number(statistic), composition.test.statistic[type], `${row[0]} statistic`);
    }
    // The samples each condition's mean is over: every sample of it (D4 and D5 included).
    assert.deepEqual(lines.map(line => [line[header.indexOf('n_samples_Liver')], line[header.indexOf('n_samples_Spleen')]]),
      lines.map(() => ['4', '4']));
    if (paired) {
      // Each type's test took the pairs holding its cells: said, so the file is not read as a
      // test over four samples each, nor Langerhans as tested over three pairs (F109).
      assert.equal(composition.test.pairs, 3);
      assert.deepEqual(lines.map(line => [line[0], line[header.indexOf('n_pairs')], line[header.indexOf('test')]]).sort(), [
        ['DC1', '3', 'paired t-test'], ['Kupffer-like', '3', 'paired t-test'],
        ['Langerhans', '1', 'too few pairs'], ['Mono, classical', '3', 'paired t-test'],
      ]);
      assert.equal(lines.find(line => line[0] === 'Langerhans')[header.indexOf('p_value')], '', 'not tested: an empty cell');
      assert.match(table.about.pairing, /^paired: 3 samples of donor in both conditions; 2 units of a sample in one condition only left out; each type tested over the pairs holding its cells, a type in fewer than 3 not tested \(test: too few pairs\); mean proportions and log2_ratio are over the pairs' samples, as the test reads them$/);
    } else {
      assert.equal(header.includes('n_pairs'), false, 'no pairs unpaired');
    }
    // A label with a comma stays one cell.
    assert.ok(lines.some(line => line[0] === 'Mono, classical'));
  });
}

test('without a condition the CSV is the counts per unit', () => {
  const composition = { ...pairedComposition({ paired: false }), test: null, conditions: [] };
  const ui = Object.create(CompositionUI.prototype);
  ui._lastResult = { composition };
  const file = ui.tableFile();
  assert.equal(file.name, 'composition_counts');
  assert.equal(file.csv.split('\n')[0], 'cell_type,D1 · Liver,D1 · Spleen,D2 · Liver,D2 · Spleen,D3 · Liver,D3 · Spleen,D4,D5');
});
