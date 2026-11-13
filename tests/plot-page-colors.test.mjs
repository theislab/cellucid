import assert from 'node:assert/strict';
import test from 'node:test';

import { PlotFactory } from '../assets/js/app/analysis/plots/plot-factory.js';
import { BasePlot } from '../assets/js/app/analysis/plots/plot-base.js';
import { getPageColor } from '../assets/js/app/utils/page-colors.js';

test('a page is drawn in the color its data carries, whatever its place among the pages drawn', () => {
  // Plots color a page by its data, not by pick order: pages CD4 T (red swatch) and Page 1
  // (blue swatch), picked in that order, are drawn red and blue.
  const pageData = [
    { pageId: 'cd4', pageName: 'CD4 T', pageColor: '#dc2626', values: Float32Array.of(1, 2) },
    { pageId: 'nk', pageName: 'Page 1', pageColor: '#2563eb', values: Float32Array.of(3, 4) },
  ];
  const traces = PlotFactory.createTraces({
    pageData,
    options: {},
    layoutEngine: null,
    traceBuilder: (pd, color) => ({ name: pd.pageName, color }),
  });
  assert.deepEqual(traces.map(trace => [trace.name, trace.color]), [['CD4 T', '#dc2626'], ['Page 1', '#2563eb']]);
  // Without one, the palette by place, as before.
  assert.equal(BasePlot.colorOfPage({ pageId: 'x' }, null, 1), getPageColor(1));
});
