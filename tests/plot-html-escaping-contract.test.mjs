/**
 * Contract: dataset-supplied strings never reach Plotly's HTML parser raw.
 *
 * Plotly parses a small HTML subset (`<b> <i> <a> <br> <span style>`) in every
 * text-bearing field: axis and colorbar titles, tick labels, category
 * coordinates, trace names, annotation text, and hover templates. Gene names,
 * obs field names, and obs category values all come from the dataset, and page
 * names come from the session file, so all of them are untrusted input.
 *
 * The app's CSP has no `'unsafe-inline'` in `script-src`, so this is not script
 * execution. `style-src` does allow inline styles, so an unescaped
 * `<span style=...>` defaces a plot and an unescaped `<a href>` injects a link.
 *
 * Plot modules are imported dynamically so the `window` stub below is installed
 * before `plotly-loader.js` evaluates.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Minimal Plotly stub: `loadPlotly()` short-circuits when `window.Plotly`
// exists, which lets `scatterplot.render()` run headlessly and hand us the
// traces and layout it would have drawn.
/** @type {Array<{ traces: Object[], layout: Object }>} */
const plotlyCalls = [];
globalThis.window = {
  addEventListener() {},
  Plotly: {
    newPlot(container, traces, layout) {
      plotlyCalls.push({ traces, layout });
      return Promise.resolve(container);
    }
  }
};

// Hostile-but-plausible dataset strings.
const HOSTILE_GENE = '<span style="color:red">X</span>';
const HOSTILE_GENE_ESCAPED =
  '&lt;span style=&quot;color:red&quot;&gt;X&lt;/span&gt;';
const HOSTILE_FIELD = 'cell "type"\'s';
const HOSTILE_FIELD_ESCAPED = 'cell &quot;type&quot;&#39;s';
const HOSTILE_CATEGORY = 'T cell<br>injected';
const HOSTILE_CATEGORY_ESCAPED = 'T cell&lt;br&gt;injected';
const HOSTILE_PAGE = 'Page <a href="https://evil.example">1</a>';
const HOSTILE_PAGE_ESCAPED =
  'Page &lt;a href=&quot;https://evil.example&quot;&gt;1&lt;/a&gt;';

const PLOT_TYPES = new URL('../assets/js/app/analysis/plots/types/', import.meta.url);

function loadPlotType(name) {
  return import(new URL(`${name}.js`, PLOT_TYPES)).then(module => module.default);
}

function categoricalPage(pageName = HOSTILE_PAGE) {
  return {
    pageId: 'page-1',
    pageName,
    cellCount: 3,
    values: [HOSTILE_CATEGORY, 'B cell', HOSTILE_CATEGORY],
    cellIndices: Uint32Array.from([0, 1, 2]),
    variableInfo: { name: HOSTILE_FIELD, kind: 'category' }
  };
}

function continuousPage(pageName = HOSTILE_PAGE) {
  return {
    pageId: 'page-1',
    pageName,
    cellCount: 4,
    values: [1, 2, 3, 4],
    cellIndices: Uint32Array.from([0, 1, 2, 3]),
    variableInfo: { name: HOSTILE_FIELD, kind: 'continuous' }
  };
}

/**
 * Assert a rendered string carries the escaped form and no live markup.
 * `<br>` and `<b>` are allowed only when the plot builder itself wrote them
 * as separators around already-escaped values, so the check is on the hostile
 * payloads specifically.
 */
function assertEscaped(actual, escapedExpectation, rawPayload) {
  assert.equal(typeof actual, 'string', 'expected a string field');
  assert.ok(
    actual.includes(escapedExpectation),
    `expected escaped ${JSON.stringify(escapedExpectation)} in ${JSON.stringify(actual)}`
  );
  assert.ok(
    !actual.includes(rawPayload),
    `raw markup ${JSON.stringify(rawPayload)} reached Plotly in ${JSON.stringify(actual)}`
  );
}

test('the canonical escape helper covers all five characters and is attribute-safe', async () => {
  const { escapeHtml } = await import('../assets/js/app/utils/dom-utils.js');

  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  // Ampersand first, so no entity is produced by escaping an escape.
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  // Attribute context: neither quote style can terminate the attribute.
  const attribute = `data-id="${escapeHtml('a" onerror="alert(1)')}"`;
  assert.ok(!attribute.includes('" onerror'));
  assert.equal(attribute, 'data-id="a&quot; onerror=&quot;alert(1)"');
});

test('bar plot escapes page names and category axis coordinates', async () => {
  const barplot = await loadPlotType('barplot');
  const pageData = [categoricalPage()];

  const traces = barplot.buildTraces(pageData, barplot.defaultOptions, null);
  assert.equal(traces.length, 1);
  assertEscaped(traces[0].name, HOSTILE_PAGE_ESCAPED, HOSTILE_PAGE);
  assert.ok(traces[0].x.includes(HOSTILE_CATEGORY_ESCAPED));
  assert.ok(!traces[0].x.includes(HOSTILE_CATEGORY));

  // The hovertemplate substitutes %{x} from the same array, so escaping the
  // coordinates covers the hover box too.
  assertEscaped(traces[0].hovertemplate, HOSTILE_PAGE_ESCAPED, HOSTILE_PAGE);
});

test('distribution traces escape page names in the legend and on the category axis', async () => {
  const boxplot = await loadPlotType('boxplot');
  const violinplot = await loadPlotType('violinplot');
  const pageData = [continuousPage()];

  for (const definition of [boxplot, violinplot]) {
    const traces = definition.buildTraces(pageData, definition.defaultOptions, null);
    assert.equal(traces.length, 1, `${definition.id} produced one trace`);
    assertEscaped(traces[0].name, HOSTILE_PAGE_ESCAPED, HOSTILE_PAGE);
    for (const coordinate of traces[0].x) {
      assertEscaped(coordinate, HOSTILE_PAGE_ESCAPED, HOSTILE_PAGE);
    }

    const layout = definition.buildLayout(pageData, definition.defaultOptions);
    assertEscaped(layout.yaxis.title, HOSTILE_FIELD_ESCAPED, HOSTILE_FIELD);
  }
});

test('horizontal distribution axes escape the value axis title', async () => {
  const boxplot = await loadPlotType('boxplot');
  const options = { ...boxplot.defaultOptions, orientation: 'horizontal' };

  const layout = boxplot.buildLayout([continuousPage()], options);
  assertEscaped(layout.xaxis.title, HOSTILE_FIELD_ESCAPED, HOSTILE_FIELD);
});

test('density plot escapes the page name and the variable axis title', async () => {
  const densityplot = await loadPlotType('densityplot');
  const pageData = [continuousPage()];

  const traces = densityplot.buildTraces(pageData, densityplot.defaultOptions, null);
  assertEscaped(traces[0].name, HOSTILE_PAGE_ESCAPED, HOSTILE_PAGE);

  const layout = densityplot.buildLayout(pageData, densityplot.defaultOptions);
  assertEscaped(layout.xaxis.title, HOSTILE_FIELD_ESCAPED, HOSTILE_FIELD);
});

test('histogram escapes the page name and the variable axis title', async () => {
  const histogram = await loadPlotType('histogram');
  const pageData = [continuousPage()];

  const traces = histogram.buildTraces(pageData, histogram.defaultOptions, null);
  assertEscaped(traces[0].name, HOSTILE_PAGE_ESCAPED, HOSTILE_PAGE);

  const layout = histogram.buildLayout(pageData, histogram.defaultOptions);
  assertEscaped(layout.xaxis.title, HOSTILE_FIELD_ESCAPED, HOSTILE_FIELD);
});

test('categorical heatmap escapes both axis coordinate arrays', async () => {
  const heatmap = await loadPlotType('heatmap');
  const pageData = [categoricalPage()];

  const traces = heatmap.buildTraces(pageData, heatmap.defaultOptions);
  assert.deepEqual(traces[0].x, [HOSTILE_PAGE_ESCAPED]);
  assert.ok(traces[0].y.includes(HOSTILE_CATEGORY_ESCAPED));
  assert.ok(!traces[0].y.includes(HOSTILE_CATEGORY));

  // Values written by the plot itself stay unescaped literals.
  assert.equal(traces[0].colorbar.title.text, '%');
  for (const row of traces[0].text) {
    for (const cell of row) {
      assert.match(cell, /^[\d.]+%$/);
    }
  }
});

test('pie plot escapes slice labels and the trace name', async () => {
  const pieplot = await loadPlotType('pieplot');
  const pageData = [categoricalPage()];

  const traces = pieplot.buildTraces(pageData, pieplot.defaultOptions);
  assert.ok(traces[0].labels.includes(HOSTILE_CATEGORY_ESCAPED));
  assert.ok(!traces[0].labels.includes(HOSTILE_CATEGORY));
  assertEscaped(traces[0].name, HOSTILE_PAGE_ESCAPED, HOSTILE_PAGE);
});

test('gene heatmap escapes gene and group labels on both the trace and the ticks', async () => {
  const geneHeatmap = await loadPlotType('gene-heatmap');
  const data = {
    matrix: {
      values: new Float32Array([1, 2, 3, 4]),
      genes: [HOSTILE_GENE, 'ACTB'],
      groupNames: [HOSTILE_CATEGORY, 'B cell'],
      nRows: 2,
      nCols: 2,
      transform: 'zscore'
    }
  };
  const options = {
    ...geneHeatmap.defaultOptions,
    showRowDendrogram: false,
    showColDendrogram: false
  };

  const traces = geneHeatmap.buildTraces(data, options);
  assert.deepEqual(traces[0].x, [HOSTILE_GENE_ESCAPED, 'ACTB']);
  assert.deepEqual(traces[0].y, [HOSTILE_CATEGORY_ESCAPED, 'B cell']);

  const layout = geneHeatmap.buildLayout(data, options);
  // tickvals address category coordinates, so they must equal the escaped
  // strings the trace publishes or every tick would be dropped.
  assert.deepEqual(layout.xaxis.tickvals, traces[0].x);
  for (const label of layout.xaxis.ticktext) {
    assert.ok(!label.includes('<span'), `raw markup in tick label ${JSON.stringify(label)}`);
  }
  // Truncation runs on the raw label, so the visible length stays correct and
  // no HTML entity is cut in half.
  assert.deepEqual(layout.xaxis.ticktext, ['&lt;span s…/span&gt;', 'ACTB']);
});

test('gene heatmap escapes untruncated sparse tick labels', async () => {
  const geneHeatmap = await loadPlotType('gene-heatmap');
  const genes = Array.from({ length: 60 }, (_, index) => `GENE${index}`);
  genes[0] = HOSTILE_GENE;
  const data = {
    matrix: {
      values: new Float32Array(60),
      genes,
      groupNames: ['A'],
      nRows: 60,
      nCols: 1,
      transform: 'none'
    }
  };
  const options = {
    ...geneHeatmap.defaultOptions,
    showRowDendrogram: false,
    showColDendrogram: false
  };

  const layout = geneHeatmap.buildLayout(data, options);
  assert.equal(layout.xaxis.tickvals[0], HOSTILE_GENE_ESCAPED);
  for (const label of layout.xaxis.ticktext) {
    assert.ok(!label.includes('<span'), `raw markup in tick label ${JSON.stringify(label)}`);
  }
});

test('scatter plot escapes axis titles, trace names, and category legend entries', async () => {
  const scatterplot = await loadPlotType('scatterplot');
  plotlyCalls.length = 0;

  await scatterplot.render(
    [{
      pageId: 'page-1',
      pageName: HOSTILE_PAGE,
      xVariable: HOSTILE_FIELD,
      yVariable: HOSTILE_GENE,
      colorVariable: HOSTILE_FIELD,
      xValues: [1, 2, 3, 4],
      yValues: [2, 3, 4, 5],
      colorValues: [HOSTILE_CATEGORY, HOSTILE_CATEGORY, 'B cell', 'B cell'],
      r: 0.9,
      rSquared: 0.81,
      pValue: 0.001,
      slope: 1,
      intercept: 1
    }],
    { ...scatterplot.defaultOptions },
    {},
    null
  );

  assert.equal(plotlyCalls.length, 1);
  const { traces, layout } = plotlyCalls[0];

  assertEscaped(layout.xaxis.title.text, HOSTILE_FIELD_ESCAPED, HOSTILE_FIELD);
  assertEscaped(layout.yaxis.title.text, HOSTILE_GENE_ESCAPED, HOSTILE_GENE);
  assertEscaped(layout.annotations[0].text, HOSTILE_PAGE_ESCAPED, HOSTILE_PAGE);

  const categoryTrace = traces.find(trace => trace.legendgroup === HOSTILE_CATEGORY);
  assert.ok(categoryTrace, 'expected one trace per colour category');
  assertEscaped(categoryTrace.name, HOSTILE_CATEGORY_ESCAPED, HOSTILE_CATEGORY);

  const trendTrace = traces.find(trace => typeof trace.name === 'string' && trace.name.startsWith('Trend ('));
  assert.ok(trendTrace, 'expected a trend line trace');
  assertEscaped(trendTrace.name, HOSTILE_PAGE_ESCAPED, HOSTILE_PAGE);
});

test('scatter plot escapes the page name on the density and plain marker traces', async () => {
  const scatterplot = await loadPlotType('scatterplot');
  plotlyCalls.length = 0;

  const xValues = Array.from({ length: 40 }, (_, index) => index + 1);
  const yValues = xValues.map(value => value * 2);

  await scatterplot.render(
    [{
      pageId: 'page-1',
      pageName: HOSTILE_PAGE,
      xVariable: HOSTILE_FIELD,
      yVariable: HOSTILE_FIELD,
      xValues,
      yValues
    }],
    { ...scatterplot.defaultOptions, showTrendline: false, showR2: false, densityThreshold: 10 },
    {},
    null
  );

  const { traces } = plotlyCalls[0];
  assert.ok(traces.length >= 2);
  for (const trace of traces) {
    assertEscaped(trace.name, HOSTILE_PAGE_ESCAPED, HOSTILE_PAGE);
  }
});

test('subplot titles escape page names', async () => {
  const { LayoutEngine } = await import('../assets/js/app/analysis/plots/layout-engine.js');
  const engine = new LayoutEngine({
    pageCount: 2,
    pageIds: ['page-1', 'page-2'],
    pageNames: [HOSTILE_PAGE, HOSTILE_CATEGORY]
  });

  const layout = engine.buildPlotlyLayout('side-by-side', {});
  assert.deepEqual(
    layout.annotations.map(annotation => annotation.text),
    [HOSTILE_PAGE_ESCAPED, HOSTILE_CATEGORY_ESCAPED]
  );
  // The accessor itself stays raw; only the rendered annotation is escaped.
  assert.equal(engine.getPageName(0), HOSTILE_PAGE);
});

test('benign names and internal literals are never double-escaped', async () => {
  const barplot = await loadPlotType('barplot');
  const densityplot = await loadPlotType('densityplot');
  const heatmap = await loadPlotType('heatmap');

  const benignCategorical = {
    pageId: 'page-1',
    pageName: 'Tumour & stroma',
    cellCount: 2,
    values: ['T cell', 'B cell'],
    cellIndices: Uint32Array.from([0, 1]),
    variableInfo: { name: 'cell_type', kind: 'category' }
  };
  const benignContinuous = {
    ...benignCategorical,
    values: [1, 2],
    variableInfo: { name: 'total_counts', kind: 'continuous' }
  };

  const barTraces = barplot.buildTraces([benignCategorical], barplot.defaultOptions, null);
  assert.equal(barTraces[0].name, 'Tumour &amp; stroma');
  assert.ok(!barTraces[0].name.includes('&amp;amp;'));
  assert.deepEqual(barTraces[0].x, ['T cell', 'B cell']);

  const densityLayout = densityplot.buildLayout([benignContinuous], densityplot.defaultOptions);
  assert.equal(densityLayout.xaxis.title, 'total_counts');
  assert.equal(densityLayout.yaxis.title, 'Density');

  const heatmapTraces = heatmap.buildTraces([benignCategorical], heatmap.defaultOptions);
  assert.equal(heatmapTraces[0].hovertemplate, '%{y}<br>%{x}: %{z:.1f}<extra></extra>');
  assert.deepEqual(heatmapTraces[0].y, ['T cell', 'B cell']);

  // Exports keep raw values: CSV is not an HTML sink.
  const csv = barplot.exportCSV([benignCategorical], barplot.defaultOptions);
  assert.ok(csv.columns.includes('Tumour & stroma_count'));
});

test('the cinematic camera keyframe list uses the canonical escape helper only', async () => {
  const source = (
    await readFile(
      new URL('../assets/js/app/ui/modules/cinematic-camera/index.js', import.meta.url),
      'utf8'
    )
  ).replaceAll('\r\n', '\n');

  // The serializer-based duplicate did not escape `"` or `'`, which mattered at
  // the `data-id="..."` attribute call site.
  assert.doesNotMatch(source, /function escapeHtml\b/);
  assert.doesNotMatch(source, /textContent = str/);
  assert.match(
    source,
    /import \{ escapeHtml \} from '\.\.\/\.\.\/\.\.\/utils\/dom-utils\.js';/
  );
  assert.match(source, /data-id="\$\{escapeHtml\(kf\.id\)\}"/);
});

test('no module re-declares a local HTML escape helper', async () => {
  const modules = [
    '../assets/js/app/ui/modules/cinematic-camera/index.js',
    '../assets/js/app/analysis/plots/plot-factory.js',
    '../assets/js/app/analysis/plots/layout-engine.js',
    '../assets/js/app/analysis/plots/types/barplot.js',
    '../assets/js/app/analysis/plots/types/densityplot.js',
    '../assets/js/app/analysis/plots/types/gene-heatmap.js',
    '../assets/js/app/analysis/plots/types/heatmap.js',
    '../assets/js/app/analysis/plots/types/histogram.js',
    '../assets/js/app/analysis/plots/types/pieplot.js',
    '../assets/js/app/analysis/plots/types/scatterplot.js',
    '../assets/js/app/analysis/plots/types/volcanoplot.js'
  ];

  for (const modulePath of modules) {
    const source = await readFile(new URL(modulePath, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /(function|const|let|var)\s+escapeHtml\b/,
      `${modulePath} must import escapeHtml from utils/dom-utils.js, not redefine it`
    );
    assert.match(source, /import \{[^}]*\bescapeHtml\b[^}]*\} from '[^']*utils\/dom-utils\.js';/, modulePath);
  }
});
