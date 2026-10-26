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
