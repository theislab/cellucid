/**
 * A gene in two gene sets is a column in each, as in scanpy (`dotplot-ui.js`
 * builds one column per entry). The plot draws every layout (dots, matrix
 * cells, violins) at one numeric position per entry: a category axis keyed by
 * the gene's name folded the repeated gene into one column, so the plot showed
 * one column fewer than its genes and the second set's dots and bracket sat on
 * the wrong genes (lane-analyst L3-1).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

// The plot measures its names before drawing (`plots/text-measure.js`): a
// stand-in page whose text is 6 px a character and whose lines are 12 px.
const element = () => ({
  style: {},
  setAttribute() {},
  appendChild() {},
  getContext: () => ({ font: '', measureText: text => ({ width: String(text).length * 6 }) }),
  getBoundingClientRect: () => ({ width: 0, height: 12 })
});
globalThis.document ??= { createElement: element, createElementNS: element, body: element() };

const { default: dotplotDefinition } = await import('../assets/js/app/analysis/plots/types/dotplot.js');
const { dotplotPlotData } = await import('../assets/js/app/analysis/ui/analysis-types/dotplot-ui.js');

const VIEWPORT = { width: 900, height: 500 };

function summaryWithRepeatedGene() {
  const genes = ['Cyr61', 'Anxa2', 'Anxa2', 'Gsta3'];
  const groups = ['Ductal', 'Ngn3 low EP', 'Beta'];
  const cells = genes.length * groups.length;
  const bins = 4;
  return {
    groupBy: 'clusters',
    matrix: 'mapped',
    matrixLabel: 'X',
    bins,
    range: new Float64Array(genes.length * 2).map((_, i) => (i % 2 === 0 ? 0 : 10)),
    histogram: new Uint32Array(cells * bins).fill(1),
    cells: 'all',
    cutoff: 0,
    genes,
    geneSets: [{ name: 'Ductal', start: 0, end: 2 }, { name: 'Ngn3 low EP', start: 2, end: 4 }],
    groups,
    sizes: [10, 10, 10],
    sum: Float64Array.from({ length: cells }, (_, i) => i + 1),
    expressing: Uint32Array.from({ length: cells }, (_, i) => 1 + (i % 9)),
    sumExpressing: Float64Array.from({ length: cells }, (_, i) => i + 1),
    measured: new Uint32Array(cells).fill(10),
    unmatched: [],
    // The values the run read (`valuesRecord`): as stored.
    counts: true,
    values: null
  };
}

function display(layout, swap = false) {
  return { plot: layout, swapAxes: swap, scale: 'none', meanOnlyExpressing: false, colorMap: 'Reds', maxDotSize: 'auto', groupOrder: 'field' };
}

for (const layout of ['dot', 'matrix', 'violin']) {
  for (const swap of [false, true]) {
    test(`${layout}${swap ? ' (swapped)' : ''}: a gene in two sets is drawn in two columns`, () => {
      const data = dotplotPlotData(summaryWithRepeatedGene(), display(layout, swap), 40);
      assert.deepEqual(data.genes, ['Cyr61', 'Anxa2', 'Anxa2', 'Gsta3']);
      const traces = dotplotDefinition.buildTraces(data, {}, null, VIEWPORT);
      const plotted = dotplotDefinition.buildLayout(data, {}, null, VIEWPORT);
      const geneAxis = swap ? plotted.yaxis : plotted.xaxis;
      const groupAxis = swap ? plotted.xaxis : plotted.yaxis;
      // One tick per entry, the repeated gene named at each.
      assert.deepEqual(geneAxis.ticktext, ['Cyr61', 'Anxa2', 'Anxa2', 'Gsta3']);
      assert.deepEqual(geneAxis.tickvals, [0, 1, 2, 3]);
      assert.equal(geneAxis.type, 'linear');
      assert.deepEqual(groupAxis.tickvals, [0, 1, 2]);
      if (layout === 'violin') return;
      // Every gene × group is at its own position.
      const positions = new Set();
      if (layout === 'matrix') {
        const [trace] = traces;
        for (let d = 0; d < trace.y.length; d++) {
          for (let a = 0; a < trace.x.length; a++) positions.add(`${trace.x[a]},${trace.y[d]}`);
        }
      } else {
        const [trace] = traces;
        trace.x.forEach((x, i) => positions.add(`${x},${trace.y[i]}`));
      }
      assert.equal(positions.size, data.genes.length * data.groups.length);
      // The row names sit on their rows.
      const rowNames = plotted.annotations.filter(a => a.yref === 'y' && a.xref === 'paper' && a.x === 0);
      assert.deepEqual(rowNames.map(a => a.y), (swap ? data.genes : data.groups).map((_, i) => i));
    });
  }
}
