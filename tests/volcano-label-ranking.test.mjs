/**
 * A volcano plot labels, and its CSV lists, the genes the result's own table
 * ranks first: where p-values tie -- on hundreds of thousands of cells many
 * underflow to 0 -- the stronger test statistic comes first, before the
 * larger fold change.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import volcanoPlotDefinition, { buildVolcanoFigure } from '../assets/js/app/analysis/plots/types/volcanoplot.js';

const options = overrides => ({
  ...volcanoPlotDefinition.defaultOptions,
  pValueThreshold: 0.05,
  foldChangeThreshold: 1,
  useAdjustedPValue: true,
  labelTopN: 2,
  highlightGenes: [],
  ...overrides,
});

const deResults = {
  results: [
    // Every p-value underflowed to 0: only the statistic tells them apart.
    { gene: 'HBE1', pValue: 0, adjustedPValue: 0, log2FoldChange: -10, score: -120 },
    { gene: 'KLF1', pValue: 0, adjustedPValue: 0, log2FoldChange: -9.5, score: -110 },
    { gene: 'KLRD1', pValue: 0, adjustedPValue: 0, log2FoldChange: 5, score: 544 },
    { gene: 'PRF1', pValue: 0, adjustedPValue: 0, log2FoldChange: 5.3, score: 521 },
    // A finite p-value ranks after every p = 0, whatever its statistic.
    { gene: 'GZMH', pValue: 1e-200, adjustedPValue: 1e-200, log2FoldChange: 5.1, score: 30 },
  ],
};

test('tied p-values are labelled by the stronger test statistic, as the table ranks them', () => {
  const figure = buildVolcanoFigure(deResults, options(), { width: 900, height: 600 });
  const labelled = (figure.layout.annotations ?? []).map(note => note.text).filter(text => deResults.results.some(row => row.gene === text));
  assert.deepEqual(labelled.sort(), ['KLRD1', 'PRF1']);
});

test('the CSV lists tied p-values by the stronger test statistic', () => {
  const rows = volcanoPlotDefinition.exportCSV(deResults, options()).rows.map(row => row.gene);
  assert.deepEqual(rows, ['KLRD1', 'PRF1', 'HBE1', 'KLF1', 'GZMH']);
});

test('a result without a statistic keeps the fold-change tie-break', () => {
  const plain = { results: deResults.results.map(({ score: _score, ...row }) => row) };
  const figure = buildVolcanoFigure(plain, options(), { width: 900, height: 600 });
  const labelled = (figure.layout.annotations ?? []).map(note => note.text).filter(text => plain.results.some(row => row.gene === text));
  assert.deepEqual(labelled.sort(), ['HBE1', 'KLF1']);
});

test('an infinite test statistic (a pseudobulk t with no spread) ranks strongest; an unavailable one last', () => {
  // The score reader accepts ±∞: a pseudobulk DE with one must not fail ("score for CD3E must be
  // a finite number or unavailable").
  const results = {
    results: [
      { gene: 'FINITE', pValue: 0, adjustedPValue: 0, log2FoldChange: 9, score: 500 },
      { gene: 'NONE', pValue: 0, adjustedPValue: 0, log2FoldChange: 9.9, score: null },
      { gene: 'INF', pValue: 0, adjustedPValue: 0, log2FoldChange: 1, score: Number.POSITIVE_INFINITY },
      { gene: 'NEGINF', pValue: 0, adjustedPValue: 0, log2FoldChange: -1, score: Number.NEGATIVE_INFINITY },
    ],
  };
  const rows = volcanoPlotDefinition.exportCSV(results, options()).rows.map(row => row.gene);
  assert.deepEqual(rows, ['INF', 'NEGINF', 'FINITE', 'NONE']);
  assert.doesNotThrow(() => buildVolcanoFigure(results, options(), { width: 900, height: 600 }));
  assert.throws(() => volcanoPlotDefinition.exportCSV({ results: [{ ...results.results[0], score: '5' }] }, options()), /score for FINITE must be a number/);
});

test('with p = 0 genes the y axis reads round values, none crowding the +∞ band', () => {
  // Ticks at quarters of the top would read 80.2, 160, 241, 321, and 321 would overlap "+∞".
  const finite = { gene: 'MID', pValue: 1e-321, adjustedPValue: 1e-321, log2FoldChange: 2, score: 40 };
  const figure = buildVolcanoFigure({ results: [...deResults.results, finite] }, options(), { width: 900, height: 600 });
  const { tickvals, ticktext } = figure.layout.yaxis;
  assert.equal(ticktext.at(-1), '+∞');
  const finiteTicks = tickvals.slice(0, -1);
  for (const value of finiteTicks) {
    const step = finiteTicks[1] - finiteTicks[0];
    assert.ok(Number.isInteger(Math.round(value / step)) && Math.abs(value / step - Math.round(value / step)) < 1e-9, `${value} is a whole step`);
  }
  assert.ok([1, 2, 5].includes(Number((finiteTicks[1] / 10 ** Math.floor(Math.log10(finiteTicks[1]))).toPrecision(3))), `step ${finiteTicks[1]} is 1, 2 or 5 × 10^n`);
  assert.ok(finiteTicks.at(-1) <= tickvals.at(-1) * 0.9, 'the last finite tick keeps clear of +∞');
  assert.ok(ticktext.slice(0, -1).every(text => !/\.\d/.test(text) || Number(text) < 10), `round labels: ${ticktext}`);
});
