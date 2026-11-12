/**
 * Every label of gene values names the values they are in (F152, plan
 * `expression-values-plan.md` §2): with Data mapping › Expression values on,
 * a gene's values are "Ins1 · log1p(norm.)" wherever they are shown, plotted
 * or exported — the legend, the figure legend, the cell card, a gene's range
 * filter and range highlight, Detailed (axes, summary, CSV), Correlation
 * (axes, hover, CSV), the dot plot (color bar, CSV), the marker heatmap
 * (color bar) and the DE table's means. One helper builds the label
 * (`data/expression-transform.js` `geneValueLabel`); an analysis names the
 * values its run read (its result's `values` record), not the setting now,
 * so a stale result keeps its own units. Obs fields and genes made in the
 * app are never transformed: their labels stay bare.
 *
 * The source contract at the end finds a label of gene values built without
 * the helper.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RAW_VALUES, geneValueLabel, valuesRecord } from '../assets/js/data/expression-transform.js';
import { DataLayer } from '../assets/js/app/analysis/data/data-layer.js';
import { BasePlot } from '../assets/js/app/analysis/plots/plot-base.js';
import { PlotFactory } from '../assets/js/app/analysis/plots/plot-factory.js';
import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';
import { correlationResultsToCSV } from '../assets/js/app/analysis/shared/analysis-utils.js';
import scatterplot from '../assets/js/app/analysis/plots/types/scatterplot.js';
import geneHeatmap from '../assets/js/app/analysis/plots/types/gene-heatmap.js';
import { DotplotUI, dotplotPlotData } from '../assets/js/app/analysis/ui/analysis-types/dotplot-ui.js';
import { DEAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/de-analysis-ui.js';
import { collectViewFilters } from '../assets/js/app/state/managers/filter-manager.js';
import { planLegend } from '../assets/js/app/ui/modules/figure-export/components/legend-builder.js';
import { annotationGroupName } from '../assets/js/app/ui/modules/highlight/annotation-cells.js';

const NORM_LOG = Object.freeze({ normalize: true, log1p: true });
const LOG = Object.freeze({ normalize: false, log1p: true });
const NORM = Object.freeze({ normalize: true, log1p: false });

test('geneValueLabel: the name with the units of values not as stored; a transform or a result\'s record', () => {
  assert.equal(geneValueLabel('Ins1', null), 'Ins1');
  assert.equal(geneValueLabel('Ins1', RAW_VALUES), 'Ins1');
  assert.equal(geneValueLabel('Ins1', NORM_LOG), 'Ins1 · log1p(norm.)');
  assert.equal(geneValueLabel('Ins1', NORM), 'Ins1 · norm.');
  assert.equal(geneValueLabel('Ins1', LOG), 'Ins1 · log1p');
  // A result's record (`valuesRecord`) names the same units.
  assert.equal(geneValueLabel('Mean expression', valuesRecord(NORM_LOG, { source: "obs['total_counts']" })), 'Mean expression · log1p(norm.)');
  assert.equal(geneValueLabel('Mean expression', valuesRecord(RAW_VALUES, null)), 'Mean expression');
  // Nothing is guessed: no values given is refused, not shown as stored.
  assert.throws(() => geneValueLabel('Ins1', undefined), /transform/);
  assert.throws(() => geneValueLabel('Ins1', 'log1p'), /transform/);
  assert.throws(() => geneValueLabel('', null), /names its values/);
});

// ---------------------------------------------------------------------------
// Detailed: a gene's pages name the values they were read in

const N = 64;

/** A DataLayer over one gene `G1` (and an obs field), the Expression values shown `shown`. */
function geneLayer({ shown, userDefined = false }) {
  const layer = Object.create(DataLayer.prototype);
  const dense = Float32Array.from({ length: N }, (_, i) => (i % 4 === 0 ? i : 0));
  const indices = [];
  const values = [];
  dense.forEach((value, cell) => { if (value !== 0) { indices.push(cell); values.push(value); } });
  const gene = { key: 'G1', kind: 'continuous', loaded: false, values: null, ...(userDefined ? { _isUserDefined: true } : {}) };
  const obs = { key: 'age', kind: 'continuous', loaded: true, values: Float32Array.from({ length: N }, (_, i) => i) };
  layer.state = {
    obsData: { fields: [obs] },
    varData: { fields: [gene] },
    getShownExpressionTransform: () => shown,
    getExpressionTransform: () => shown,
    readVarSparseColumn: async () => ({ length: N, indices: Uint32Array.from(indices), values: Float32Array.from(values) }),
  };
  layer._datasetGeneration = 0;
  layer._destroyed = false;
  layer._notifications = null;
  layer._fieldLoadLifecycle = new AbortController();
  layer.getVariableInfo = type => (type === 'gene_expression'
    ? { key: 'G1', name: 'G1', kind: 'continuous', _fieldIndex: 0, _isGene: true }
    : { key: 'age', name: 'age', kind: 'continuous', _fieldIndex: 0 });
  layer._getGeneFieldIndexMap = () => new Map([['G1', 0]]);
  layer.getPageInfo = pageId => ({ id: pageId, name: pageId });
  layer._getVersionedCellIndices = () => Uint32Array.from({ length: N }, (_, i) => i);
  layer._ensureFieldLoaded = async () => {};
  return { layer, dense };
}

test('Detailed: a gene\'s pages carry the values they were read in, and every label of them names it', async () => {
  const { layer, dense } = geneLayer({ shown: LOG });
  const pages = await layer._fetchDataForPages({ type: 'gene_expression', variableKey: 'G1', pageIds: ['all'], silent: true });
  assert.deepEqual(pages[0].variableInfo.values, { normalize: false, log1p: true, totals: null });
  // The values are those named: ln(1 + x).
  assert.equal(pages[0].values[4], Math.fround(Math.log1p(dense[4])));
  assert.equal(BasePlot.getValueLabel(pages), 'G1 · log1p');
  // Box/violin and histogram/density axes, the distribution CSV.
  const box = PlotFactory.configureDistributionAxes({}, { pageData: pages, options: {} });
  assert.equal(box.yaxis.title, 'G1 · log1p');
  const histogram = PlotFactory.configureHistogramAxes({}, { pageData: pages, options: {} });
  assert.equal(histogram.xaxis.title, 'G1 · log1p');
  assert.equal(PlotFactory.exportDistributionCSV(pages).metadata.variable, 'G1 · log1p');
});

test('Detailed: an obs field and a gene made in the app keep a bare label', async () => {
  const obs = await geneLayer({ shown: NORM_LOG }).layer._fetchDataForPages({ type: 'continuous_obs', variableKey: 'age', pageIds: ['all'], silent: true });
  assert.equal(Object.hasOwn(obs[0].variableInfo, 'values'), false);
  assert.equal(BasePlot.getValueLabel(obs), 'age');
  const copy = await geneLayer({ shown: LOG, userDefined: true }).layer._fetchDataForPages({ type: 'gene_expression', variableKey: 'G1', pageIds: ['all'], silent: true });
  assert.equal(copy[0].variableInfo.values, null);
  assert.equal(BasePlot.getValueLabel(copy), 'G1');
});

// ---------------------------------------------------------------------------
// Correlation

function correlationLayer(values) {
  return {
    async getDataForPages(request) {
      const gene = request.type === 'gene_expression';
      return [{
        pageId: request.pageIds[0],
        pageName: 'Page A',
        variableInfo: { name: request.variableKey, kind: 'continuous', ...(gene ? { values } : {}) },
        values: Float32Array.from([1, 2, 3, 5]),
        cellIndices: Uint32Array.from([0, 1, 2, 3]),
        cellCount: 4,
      }];
    },
  };
}

test('Correlation: each axis is named with the values its variable was read in (axes, hover, CSV)', async () => {
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = correlationLayer(valuesRecord(NORM_LOG, { source: "obs['total_counts']" }));
  analysis._computeManager = { async init() {}, async execute() { return { correlation: 1, pValue: 0, sampleSize: 4 }; } };
  const [page] = await analysis.correlationAnalysis({
    varX: { type: 'gene_expression', key: 'Ins1' },
    varY: { type: 'continuous_obs', key: 'age' },
    pageIds: ['page-A'],
    method: 'pearson',
  });
  assert.equal(page.xLabel, 'Ins1 · log1p(norm.)');
  assert.equal(page.yLabel, 'age');
  assert.equal(page.xVariable, 'Ins1', 'the variable itself stays by key');
  const exported = scatterplot.exportCSV([page], {});
  assert.equal(exported.metadata.xVariable, 'Ins1 · log1p(norm.)');
  const csv = correlationResultsToCSV([page], {
    method: 'pearson', variableX: { type: 'gene_expression', key: 'Ins1' }, variableY: { type: 'continuous_obs', key: 'age' },
  }).split('\n');
  assert.equal(csv[0], 'page,method,x_type,x_key,x_label,y_type,y_key,y_label,r,r_squared,p_value,n');
  assert.match(csv[1], /^Page A,pearson,gene_expression,Ins1,Ins1 · log1p\(norm\.\),continuous_obs,age,age,/);
  // A page without its labels is refused, never drawn with a bare key.
  assert.throws(() => scatterplot.exportCSV([{ ...page, xLabel: undefined }], {}), /xLabel/);
});

// ---------------------------------------------------------------------------
// Dot plot, marker heatmap, DE table

function dotSummary(values) {
  const genes = ['Ins1', 'Gcg'];
  const groups = ['Alpha', 'Beta'];
  const cells = genes.length * groups.length;
  return {
    groupBy: 'cell_type', matrix: 'mapped', matrixLabel: 'X', bins: 2,
    range: new Float64Array(genes.length * 2).map((_, i) => (i % 2 === 0 ? 0 : 4)),
    histogram: new Uint32Array(cells * 2).fill(1), cells: 'all', cutoff: 0,
    genes, geneSets: [{ name: '', start: 0, end: 2 }], groups, sizes: [5, 5],
    sum: Float64Array.from({ length: cells }, (_, i) => i + 1),
    expressing: Uint32Array.from({ length: cells }, () => 3),
    sumExpressing: Float64Array.from({ length: cells }, (_, i) => i + 1),
    measured: new Uint32Array(cells).fill(5), unmatched: [], counts: true, values,
  };
}

const DOT_DISPLAY = { plot: 'dot', swapAxes: false, scale: 'none', meanOnlyExpressing: false, colorMap: 'Reds', maxDotSize: 'auto', groupOrder: 'field' };

test('Dot plot: the color bar and the CSV\'s means name the values the run read', () => {
  const record = valuesRecord(NORM_LOG, { source: "obs['total_counts']" });
  assert.equal(dotplotPlotData(dotSummary(record), DOT_DISPLAY, 20).colorLabel, 'Mean expression · log1p(norm.)');
  assert.equal(dotplotPlotData(dotSummary(record), { ...DOT_DISPLAY, scale: 'z' }, 20).colorLabel, 'Mean, z per gene · log1p(norm.)');
  assert.equal(dotplotPlotData(dotSummary(null), DOT_DISPLAY, 20).colorLabel, 'Mean expression');
  const ui = Object.create(DotplotUI.prototype);
  ui._lastResult = { summary: dotSummary(record) };
  ui._requireOptions = () => DOT_DISPLAY;
  assert.equal(ui.tableFile().csv.split('\n')[0], 'group,gene,gene_group,mean · log1p(norm.),fraction_expressing,n_cells,n_measured');
  ui._lastResult = { summary: dotSummary(null) };
  assert.equal(ui.tableFile().csv.split('\n')[0], 'group,gene,gene_group,mean,fraction_expressing,n_cells,n_measured');
});

test('Marker heatmap: the color bar names the values of the means it shows', () => {
  const matrix = { genes: ['Ins1'], groupNames: ['Beta'], values: Float32Array.of(1), nRows: 1, nCols: 1, transform: 'zscore' };
  const options = { colorscale: 'RdBu', showValues: false, reverseColorscale: true, rangeMode: 'auto', zmin: -3, zmax: 3, showRowDendrogram: false, showColDendrogram: false };
  const [trace] = geneHeatmap.buildTraces({ matrix, clustering: null, values: valuesRecord(LOG, null) }, options);
  assert.equal(trace.colorbar.title.text, 'z-score · log1p');
  const [bare] = geneHeatmap.buildTraces({ matrix: { ...matrix, transform: 'none' }, clustering: null, values: null }, options);
  assert.equal(bare.colorbar.title.text, 'Expression');
});

test('DE table: the groups\' means name the values the run read', () => {
  const ui = Object.create(DEAnalysisUI.prototype);
  ui.dataLayer = { state: { varData: { fields: [] } } };
  const row = { gene: 'Ins1', score: 1, log2FoldChange: 1, pValue: 0.01, adjustedPValue: 0.02, pctA: 50, pctB: 10, auroc: 0.7, meanA: 2, meanB: 1, nA: 5, nB: 5 };
  ui._lastResult = { full: { results: [row], summary: { values: valuesRecord(NORM, { source: "obs['total_counts']" }) } } };
  assert.match(ui.tableFile().csv.split('\n')[0], /,auroc,mean_a · norm\.,mean_b · norm\.,n_a,n_b$/);
  ui._lastResult = { full: { results: [row], summary: { values: null } } };
  assert.match(ui.tableFile().csv.split('\n')[0], /,auroc,mean_a,mean_b,n_a,n_b$/);
});

// ---------------------------------------------------------------------------
// The views: filters, the figure legend

test('A gene\'s range filter names its units; an obs field\'s and a copy\'s stay bare', () => {
  const filtered = key => ({ key, kind: 'continuous', _continuousStats: { min: 0, max: 5 }, _continuousFilter: { min: 1, max: 2 } });
  const view = {
    obsData: { fields: [filtered('age')] },
    varData: { fields: [filtered('Ins1'), { ...filtered('Ins1 copy'), _isUserDefined: true }] },
  };
  const texts = collectViewFilters(view, { geneValues: NORM_LOG }).map(filter => filter.text);
  assert.deepEqual(texts, ['age: 1 – 2', 'Ins1 · log1p(norm.): 1 – 2', 'Ins1 copy: 1 – 2']);
  assert.deepEqual(collectViewFilters(view).map(filter => filter.text), ['age: 1 – 2', 'Ins1: 1 – 2', 'Ins1 copy: 1 – 2']);
});

test('An annotation group drawn on a gene is named by its range in the units of its values', () => {
  const field = { key: 'Ins1', kind: 'continuous', values: Float32Array.of(0.5, 1.25, 2) };
  assert.equal(annotationGroupName(field, [0, 2], NORM_LOG), 'Ins1 · log1p(norm.) 0.5 – 2');
  assert.equal(annotationGroupName(field, [0, 2]), 'Ins1 0.5 – 2');
});

test('The figure legend\'s title names a gene\'s units from the legend model', () => {
  const plan = values => planLegend({
    model: { kind: 'continuous', values, stats: { min: 0, max: 1 }, colorbar: { min: 0, max: 1 }, colormap: { id: 'viridis', label: 'Viridis' } },
    fieldKey: 'Ins1', fontPx: 12, measureText: text => text.length * 6, placement: 'beside', extentPx: 300,
  });
  assert.equal(plan(NORM_LOG).title, 'Ins1 · log1p(norm.)');
  assert.equal(plan(null).title, 'Ins1');
});

// ---------------------------------------------------------------------------
// Source contract: no label of gene values is built without the helper

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'js');

function sources(dir = ROOT) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'vendor') continue;
      out.push(...sources(path));
    } else if (name.endsWith('.js')) {
      out.push(path);
    }
  }
  return out;
}

const HELPER = 'data/expression-transform.js';

/** Where a gene's values are named: each must take the label from `geneValueLabel`. */
const LABEL_BUILDERS = Object.freeze([
  'app/ui/modules/figure-export/components/legend-builder.js',
  'app/ui/modules/cell-info.js',
  'app/analysis/plots/plot-base.js',
  'app/analysis/plots/types/gene-heatmap.js',
  'app/analysis/stats/multi-variable-analysis.js',
  'app/analysis/ui/analysis-types/dotplot-ui.js',
  'app/analysis/ui/analysis-types/de-analysis-ui.js',
  'app/state/managers/filter-manager.js',
  'app/state/managers/highlight-manager.js',
  'app/ui/modules/highlight/annotation-cells.js',
]);

/** Units alone (not a name with units): the legend's "Values: log1p(norm.)" line. */
const UNITS_ONLY = Object.freeze(['app/ui/modules/legend-renderer.js']);

test('source: every place that names gene values takes the label from geneValueLabel', () => {
  const problems = [];
  for (const path of sources()) {
    const rel = relative(ROOT, path).split('\\').join('/');
    if (rel === HELPER) continue;
    const text = readFileSync(path, 'utf8');
    // Units joined to a name by hand: `${name} · ${units}`.
    if (/\$\{[^}]*\}\s·\s\$\{[^}]*(units|\.values|transformUnits)[^}]*\}/.test(text)) problems.push(`${rel}: a name and units joined by hand`);
    if (text.includes('transformUnits(') && !UNITS_ONLY.includes(rel)) problems.push(`${rel}: transformUnits outside the helper (use geneValueLabel)`);
    // A plot naming its variable from the page data's bare name.
    if (/variableInfo\??\.name\b/.test(text) && !['app/analysis/plots/plot-base.js', 'app/analysis/stats/multi-variable-analysis.js'].includes(rel)) {
      problems.push(`${rel}: a variable named by variableInfo.name (use BasePlot.getValueLabel)`);
    }
  }
  for (const rel of LABEL_BUILDERS) {
    if (!/\bgeneValueLabel\(/.test(readFileSync(join(ROOT, rel), 'utf8'))) problems.push(`${rel}: names gene values without geneValueLabel`);
  }
  // The correlation names its axes only by the labels it read.
  const scatter = readFileSync(join(ROOT, 'app/analysis/plots/types/scatterplot.js'), 'utf8');
  if (/escapeHtml\(\s*pageResult\.[xy]Variable/.test(scatter) || /pageResults\[0\]\?\.[xy]Variable/.test(scatter)) {
    problems.push('app/analysis/plots/types/scatterplot.js: an axis named by its variable\'s key');
  }
  assert.deepEqual(problems, []);
});
