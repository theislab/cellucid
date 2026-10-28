import assert from 'node:assert/strict';
import test from 'node:test';

import {
  joinPerCellCSV,
  perCellCSVHeader,
  perCellCSVRows,
  splitPerCellRows,
  toCSVCell
} from '../assets/js/app/analysis/compute/csv-export.js';
import { executeOperation } from '../assets/js/app/analysis/compute/operation-handlers.js';
import { OperationType } from '../assets/js/app/analysis/compute/operations.js';

// The text the export is defined as: one string per row, joined with "\n".
function joinedPageData(pageData, variableName) {
  const rows = [`page,cell_index,${toCSVCell(variableName)}`];
  for (const pd of pageData) {
    const pageName = toCSVCell(pd.pageName);
    for (let i = 0; i < pd.labels.length; i++) {
      rows.push([pageName, toCSVCell(pd.cellIndices?.[i] ?? i), toCSVCell(pd.labels[i])].join(','));
    }
  }
  return rows.join('\n');
}

function joinedScores(pageData) {
  const rows = ['page,set,cell_index,score'];
  for (const pd of pageData) {
    pd.values.forEach((value, i) => {
      if (Number.isFinite(value)) {
        rows.push([toCSVCell(pd.pageName), toCSVCell(pd.setName), toCSVCell(pd.cellIndices?.[i] ?? i), toCSVCell(value)].join(','));
      }
    });
  }
  return rows.join('\n');
}

/** The file as the analysis workers write it: rows split into ranges, joined. */
async function written(layout, pages, variableName, parts) {
  const ranges = splitPerCellRows(pages, parts);
  const rows = ranges.map(range => executeOperation(OperationType.COMPUTE_CSV_EXPORT, { layout, pages: range }).rows);
  return joinPerCellCSV(perCellCSVHeader(layout, variableName), rows).text();
}

test('per-cell CSV bytes equal the joined rows however the rows are split', async () => {
  const n = 300_000;
  const values = Float32Array.from({ length: n }, (_, i) => (i % 101 === 0 ? NaN : Math.fround(i / 7 - 3)));
  const cellIndices = Uint32Array.from({ length: n }, (_, i) => i * 3);
  const categories = ['T cell', 'B "naive"', 'NK, CD56', 'Mono\nclassical', 'Ä-ß ü'];
  const codes = Uint8Array.from({ length: 4000 }, (_, i) => (i % 13 === 0 ? 255 : i % categories.length));
  const pages = [
    { pageName: 'Page, "one"', values, cellIndices, labels: Array.from(values) },
    {
      pageName: 'Categorical',
      values: codes,
      categories,
      missingCode: 255,
      labels: Array.from(codes, code => (code === 255 ? null : categories[code]))
    },
    { pageName: 'Strings without indices', values: ['a', null, 'b,c'], labels: ['a', null, 'b,c'] }
  ];
  const expected = joinedPageData(pages, 'gene "X"');
  for (const parts of [1, 2, 7, 8]) {
    assert.equal(await written('page-data', pages, 'gene "X"', parts), expected, `${parts} parts`);
  }

  // Signature scores skip non-finite scores; a range may hold none.
  const scores = [
    { pageName: 'A', setName: 'T cells', values, cellIndices },
    { pageName: 'B', setName: 'T cells', values: Float32Array.of(NaN, 1.5), cellIndices: Uint32Array.of(3, 9) },
    { pageName: 'C', setName: 'B, cells', values: Float32Array.of(NaN), cellIndices: Uint32Array.of(1) },
  ];
  for (const parts of [1, 3, 8]) {
    assert.equal(await written('signature-scores', scores, undefined, parts), joinedScores(scores), `${parts} parts`);
  }
  assert.equal(await written('page-data', [], 'v', 8), 'page,cell_index,v');
});

test('the CSV export operation writes the lines of its rows, and refuses unknown layouts', async () => {
  const pages = [{ pageName: 'P', values: Float32Array.of(1, 2), cellIndices: Uint32Array.of(4, 9) }];
  const { rows } = executeOperation(OperationType.COMPUTE_CSV_EXPORT, { layout: 'page-data', pages });
  assert.equal(await rows.text(), 'P,4,1\nP,9,2');
  const scores = executeOperation(OperationType.COMPUTE_CSV_EXPORT, {
    layout: 'signature-scores',
    pages: pages.map(page => ({ ...page, setName: 'S' })),
  });
  assert.equal(await scores.rows.text(), 'P,S,4,1\nP,S,9,2');
  assert.throws(
    () => executeOperation(OperationType.COMPUTE_CSV_EXPORT, { layout: 'other', pages }),
    /Unknown CSV export layout/
  );
  assert.throws(() => perCellCSVHeader('page-data'), /variable name/);
});

test('cell_index names a cell by its original position, rows ascending, whatever cells are open and in what order', async () => {
  const { pageInOriginalOrder } = await import('../assets/js/app/analysis/compute/csv-export.js');
  const { createCellIdentity } = await import('../assets/js/data/cell-identity.js');
  const { orderedCellIdentity } = await import('./helpers/ordered-cell-identity.mjs');
  const cellsOf = (page, identity) => {
    const out = pageInOriginalOrder(page, identity);
    return { cells: out.cellIndices === null ? null : [...out.cellIndices], values: [...out.values] };
  };
  // Every cell open in its original order: the rows as they are.
  const whole = createCellIdentity({ nObs: 5 });
  assert.deepEqual(cellsOf({ values: [1, 2, 3, 4, 5] }, whole), { cells: null, values: [1, 2, 3, 4, 5] });
  assert.deepEqual(cellsOf({ values: [1, 2], cellIndices: [3, 4] }, whole), { cells: [3, 4], values: [1, 2] });
  // A subsample: open cell i is original position kept[i].
  const subset = createCellIdentity({ nObs: 10, kept: Uint32Array.of(1, 4, 6, 9) });
  assert.deepEqual(cellsOf({ values: [5, 6, 7, 8] }, subset), { cells: [1, 4, 6, 9], values: [5, 6, 7, 8] });
  assert.deepEqual(cellsOf({ values: ['a', 'b'], cellIndices: Uint32Array.of(3, 0) }, subset), { cells: [1, 9], values: ['b', 'a'] });
  // Every cell open in priority order (open cell i is [4, 0, 3, 1, 2][i]): ascending, values with their cells.
  const priority = orderedCellIdentity({ nObs: 5 });
  assert.deepEqual(cellsOf({ values: [40, 0, 30, 10, 20] }, priority), { cells: null, values: [0, 10, 20, 30, 40] });
  assert.deepEqual(cellsOf({ values: [7, 8], cellIndices: [0, 3] }, priority), { cells: [1, 4], values: [8, 7] });
  // A subsample opened in priority order.
  const ordered = orderedCellIdentity({ nObs: 10, kept: [1, 4, 6, 9] });
  assert.deepEqual(cellsOf({ values: [9, 1, 6, 4] }, ordered), { cells: [1, 4, 6, 9], values: [1, 4, 6, 9] });
  // The rows written are the translated ones.
  const page = pageInOriginalOrder({ pageName: 'P', values: [7, 8], cellIndices: [0, 3] }, priority);
  assert.equal(await perCellCSVRows('page-data', [page]).text(), 'P,1,8\nP,4,7');
  assert.throws(() => pageInOriginalOrder({ values: [] }, null), /cell identity/);
});

test('DE and marker tables name genes by identifier, the shown name beside it when they differ', async () => {
  const { geneNameColumns, markerStatisticsCSV } = await import('../assets/js/app/analysis/compute/csv-export.js');
  // A file whose var index is the shown name: one column, as scanpy writes it.
  const same = geneNameColumns(['CD3E', 'MS4A1'], ['CD3E', 'MS4A1']);
  assert.equal(same.header, 'names');
  assert.equal(same.cells(1), 'MS4A1');
  // A CELLxGENE file: Ensembl ids in the var index, symbols shown.
  const ids = ['ENSG00000198851', 'ENSG00000156738'];
  const both = geneNameColumns(['CD3E', 'MS4A1'], ids);
  assert.equal(both.header, 'names,symbols');
  assert.equal(both.cells(0), 'ENSG00000198851,CD3E');
  assert.throws(() => geneNameColumns(['CD3E'], []), /identifier/);
  const lane = values => [Float32Array.from(values)];
  const csv = await markerStatisticsCSV({
    genes: ['CD3E', 'MS4A1'], ids,
    groups: [{ name: 'T', tested: true, small: false }],
    scores: lane([2, 1]), logfoldchanges: lane([1, 0.5]), pvals: [Float64Array.of(0.01, 0.2)], pvalsAdj: [Float64Array.of(0.02, 0.2)],
    pctIn: lane([50, 10]), pctRef: lane([5, 5]), auroc: lane([0.9, 0.6]),
  }).text();
  const [header, first] = csv.split('\n');
  assert.equal(header, 'group,names,symbols,scores,logfoldchanges,pvals,pvals_adj,pct_nz_group,pct_nz_reference,auroc,small_group,tested');
  assert.match(first, /^T,ENSG00000198851,CD3E,2,/);
});
