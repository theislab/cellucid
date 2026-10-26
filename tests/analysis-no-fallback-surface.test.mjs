import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { DataLayer } from '../assets/js/app/analysis/data/data-layer.js';
import { ComparisonModule } from '../assets/js/app/analysis/comparison-module.js';
import { markerMatrix } from '../assets/js/app/analysis/genes-panel/expression-matrix-builder.js';
import { GenesPanelController } from '../assets/js/app/analysis/genes-panel/genes-panel-controller.js';
import {
  ERROR_MESSAGES as GENES_PANEL_ERROR_MESSAGES,
  formatError,
} from '../assets/js/app/analysis/genes-panel/constants.js';
import { benjaminiHochbergAdjusted } from '../assets/js/app/analysis/stats/statistical-tests.js';
import { MarkerCache } from '../assets/js/app/analysis/genes-panel/marker-cache.js';
import { ClusteringEngine } from '../assets/js/app/analysis/genes-panel/clustering-engine.js';
import { BasePlot } from '../assets/js/app/analysis/plots/plot-base.js';
import { LayoutEngine } from '../assets/js/app/analysis/plots/layout-engine.js';
import geneHeatmapDefinition from '../assets/js/app/analysis/plots/types/gene-heatmap.js';
import { waitForAvailableSlot } from '../assets/js/app/analysis/shared/concurrency-utils.js';
import { MemoryMonitor } from '../assets/js/app/analysis/shared/memory-monitor.js';
import { cleanupAnalysisResources } from '../assets/js/app/analysis/shared/resource-cleanup.js';
import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';
import { createRunTuner } from '../assets/js/app/analysis/shared/run-tuner.js';
import { runGeneStream } from '../assets/js/app/analysis/shared/gene-stream-runner.js';
import { getDataSourceManager } from '../assets/js/data/data-source-manager.js';

const ANALYSIS_ROOT = new URL('../assets/js/app/analysis/', import.meta.url);

async function analysisSource(path) {
  return readFile(new URL(path, ANALYSIS_ROOT), 'utf8');
}

test('analysis fallback, retry, coercion, and compatibility shims are absent from current surfaces', async () => {
  const paths = [
    'data/data-layer.js',
    'data/gene-route.js',
    'compute/data-worker.js',
    'genes-panel/clustering-engine.js',
    'genes-panel/constants.js',
    'genes-panel/genes-panel-controller.js',
    'genes-panel/marker-cache.js',
    'genes-panel/marker-discovery-engine.js',
    'plots/layout-engine.js',
    'plots/plot-base.js',
    'plots/plotly-hints.js',
    'plots/types/gene-heatmap.js',
    'shared/concurrency-utils.js',
    'shared/dom-utils.js',
    'shared/gene-stream-runner.js',
    'shared/memory-monitor.js',
    'shared/plot-theme.js',
    'shared/resource-cleanup.js',
    'ui/analysis-types/de-analysis-ui.js',
    'ui/components/options.js',
  ];
  const forbidden = /\bfallback\b|fall(?:ing)?\s+back|\bretry\b|\bcoerc(?:e|ion)\b|\blegacy\b|back-compat|api compatibility|best.?effort|skip failed genes?|ignore (?:cleanup|release) (?:errors?|failures?)/i;

  for (const path of paths) {
    const source = await analysisSource(path);
    assert.doesNotMatch(source, forbidden, `${path} contains an obsolete alternate contract`);
  }

  const [hints, options] = await Promise.all([
    analysisSource('plots/plotly-hints.js'),
    analysisSource('ui/components/options.js'),
  ]);
  assert.doesNotMatch(hints, /detachPlotlyHints|\bdetach:/);
  assert.doesNotMatch(options, /coerceSelectValue|parseFloat\(input\.value\)|!!value/);

  const performanceForm = await analysisSource('shared/dom-utils.js');
  assert.doesNotMatch(
    performanceForm,
    /pointCount\s*=\s*[^;\n]*\|\||geneCount\s*=\s*[^;\n]*\|\||getValue\([^)]*\)\s*\|\||parseInt\(/,
  );

  const [markerEngine, markerWorker] = await Promise.all([
    analysisSource('genes-panel/marker-discovery-engine.js'),
    analysisSource('compute/data-worker.js'),
  ]);
  assert.doesNotMatch(
    markerEngine,
    /clampInt|safeP|geneList\s*\|\||poolSize:\s*1|log2FoldChange\s*\|\|\s*0/,
  );
  assert.doesNotMatch(
    markerWorker,
    /useApproxWilcox|histBins|Math\.min\(values\.length,\s*cellGroupIndex\.length\)/,
  );
});

test('plot metadata and ranges require exact scientific ownership', () => {
  assert.equal(
    BasePlot.getVariableName([{
      variableInfo: { name: 'Exact variable' },
    }]),
    'Exact variable',
  );
  assert.throws(
    () => BasePlot.getVariableName([]),
    /variableInfo\.name|variable name/i,
  );
  assert.throws(
    () => BasePlot.getVariableName([{ variableInfo: {} }]),
    /variableInfo\.name|variable name/i,
  );
  assert.throws(
    () => BasePlot.getGlobalRange([{ values: [NaN, Infinity] }]),
    /finite.*value|numeric.*value/i,
  );
});

test('layout identities and color maps are exact instead of substituted', () => {
  const engine = new LayoutEngine({
    pageCount: 2,
    pageIds: ['page-a', 'page-b'],
    pageNames: ['Page A', 'Page B'],
    syncXAxis: true,
    syncYAxis: true,
    colorScheme: ['#111111', '#222222'],
    customColors: new Map(),
  });

  assert.throws(
    () => engine.getSubplotGrid('unknown-layout'),
    /unknown layout mode.*unknown-layout/i,
  );
  assert.throws(
    () => engine.getPageColor('unknown-page'),
    /unknown page.*unknown-page/i,
  );
  assert.throws(
    () => LayoutEngine.createColorScale('unknown-colormap'),
    /unknown colormap.*unknown-colormap/i,
  );
  assert.throws(
    () => new LayoutEngine({
      pageCount: 2,
      pageIds: ['only-one-id'],
      pageNames: ['Page A', 'Page B'],
    }),
    /pageIds.*pageCount/i,
  );
});

test('marker p-value correction rejects malformed scientific values', () => {
  const dense = benjaminiHochbergAdjusted(Float64Array.from([0.01, 0.04, 0.03]));
  assert.ok(dense.adjustedPValues instanceof Float64Array);
  // scipy.stats.false_discovery_control([0.01, 0.04, 0.03], method='bh')
  assert.deepEqual(Array.from(dense.adjustedPValues), [0.03, 0.04, 0.04]);
  assert.equal(dense.testedCount, 3);
  assert.equal(dense.untestableCount, 0);

  // A probability outside [0, 1] is a defect and still fails loudly.
  assert.throws(
    () => benjaminiHochbergAdjusted(Float64Array.from([0.01, 1.2])),
    /p-value.*between 0 and 1/i,
  );

  // NaN is not a defect: it is the marker worker's word for a group that could
  // not be tested for that gene. Such a gene is not in the family, so it leaves
  // the denominator alone and comes back NaN rather than fabricated.
  const partial = benjaminiHochbergAdjusted(
    Float64Array.from([0.01, NaN, 0.04, NaN, 0.03]),
  );
  assert.equal(partial.testedCount, 3);
  assert.equal(partial.untestableCount, 2);
  assert.ok(Number.isNaN(partial.adjustedPValues[1]));
  assert.ok(Number.isNaN(partial.adjustedPValues[3]));
  // The denominator is 3, not 5:
  // scipy.stats.false_discovery_control([0.01, 0.04, 0.03], method='bh')
  //   -> [0.03, 0.04, 0.04]
  assert.deepEqual(
    [partial.adjustedPValues[0], partial.adjustedPValues[2], partial.adjustedPValues[4]],
    [0.03, 0.04, 0.04],
  );
});

test('marker heatmaps encode exact primitive group labels and keep each group\'s colour', () => {
  const stats = {
    genes: ['GENE'],
    groups: [
      { groupId: 'false-group', groupName: false, color: 'var(--color-category-1)' },
      { groupId: 'zero-group', groupName: 0, color: 'var(--color-category-2)' },
    ],
    meanInGroupByGroup: [Float32Array.of(2), Float32Array.of(3)],
  };
  const matrix = markerMatrix(stats, { genes: ['GENE'], groupIndices: [0, 1], transform: 'none' });
  assert.deepEqual(matrix.groupIds, ['false-group', 'zero-group']);
  assert.deepEqual(matrix.groupNames, ['false', '0']);
  assert.deepEqual(matrix.groupColors, ['var(--color-category-1)', 'var(--color-category-2)']);
  assert.deepEqual(Array.from(matrix.values), [2, 3]);
  for (const invalidName of ['', '   ', null, undefined, NaN, Infinity, {}]) {
    assert.throws(
      () => markerMatrix({ ...stats, groups: [{ ...stats.groups[0], groupName: invalidName }, stats.groups[1]] },
        { genes: ['GENE'], groupIndices: [0, 1], transform: 'none' }),
      /group.*name.*(?:empty|string|finite|boolean)/i,
    );
  }
  assert.throws(
    () => markerMatrix(stats, { genes: ['UNTESTED'], groupIndices: [0, 1], transform: 'none' }),
    /was not tested/,
  );
});

test('DataLayer active-page access never substitutes the first page', () => {
  const layer = Object.create(DataLayer.prototype);
  layer.state = {
    getHighlightPages() {
      return [{ id: 'first-page' }];
    },
  };

  assert.throws(
    () => layer.getActiveHighlightPageId(),
    /getActivePageId.*required|active page.*owner/i,
  );

  layer.state.getActivePageId = () => null;
  assert.equal(layer.getActiveHighlightPageId(), null);
});

test('gene heatmap ranges are exact or terminal', () => {
  const data = {
    matrix: {
      values: Float32Array.from([1, 2, 3, 4]),
      genes: ['A', 'B'],
      groupNames: ['G1', 'G2'],
      nRows: 2,
      nCols: 2,
      transform: 'zscore',
    },
  };
  const baseOptions = {
    colorscale: 'RdBu',
    showValues: false,
    reverseColorscale: true,
    showRowDendrogram: false,
    showColDendrogram: false,
  };

  assert.throws(
    () => geneHeatmapDefinition.buildTraces(
      data,
      { ...baseOptions, rangeMode: 'invented', zmin: -3, zmax: 3 },
    ),
    /rangeMode|color range/i,
  );
  assert.throws(
    () => geneHeatmapDefinition.buildTraces(
      data,
      { ...baseOptions, rangeMode: 'fixed', zmin: undefined, zmax: 3 },
    ),
    /zmin.*zmax|fixed.*range/i,
  );
  assert.throws(
    () => geneHeatmapDefinition.buildTraces(
      data,
      { ...baseOptions, rangeMode: 'fixed', zmin: 3, zmax: 3 },
    ),
    /zmin.*less than.*zmax|fixed.*range/i,
  );

  const [zScoreTrace] = geneHeatmapDefinition.buildTraces(
    data,
    { ...baseOptions, rangeMode: 'zscore', zmin: 2, zmax: 4 },
  );
  assert.equal(zScoreTrace.zmin, -3);
  assert.equal(zScoreTrace.zmax, 3);
  assert.equal(zScoreTrace.zauto, false);
});

test('gene heatmap CSV rows preserve every prototype-named group column', () => {
  const groupNames = Object.getOwnPropertyNames(Object.prototype);
  const exported = geneHeatmapDefinition.exportCSV({
    matrix: {
      genes: ['GENE'],
      groupNames,
      values: Float32Array.from(
        groupNames.map((_, index) => index + 0.25),
      ),
      nRows: 1,
      nCols: groupNames.length,
      transform: 'none',
    },
  });

  assert.deepEqual(exported.columns, ['gene', ...groupNames]);
  assert.equal(Object.getPrototypeOf(exported.rows[0]), Object.prototype);
  assert.deepEqual(Object.keys(exported.rows[0]), ['gene', ...groupNames]);
  for (const [index, groupName] of groupNames.entries()) {
    assert.equal(Object.hasOwn(exported.rows[0], groupName), true, groupName);
    assert.equal(
      exported.rows[0][groupName],
      (index + 0.25).toFixed(4),
      groupName,
    );
  }
});

test('requested clustering never becomes an unclustered result', async () => {
  // Clustering past the memory budget is refused, with the measured reason
  // and what to change, before anything is allocated; it is never returned
  // in input order as if it were clustered.
  const engine = new ClusteringEngine();
  const matrix = { values: new Float32Array(1001 * 2), nRows: 1001, nCols: 2 };
  await assert.rejects(
    engine.clusterMatrix({
      matrix,
      clusterRows: true,
      clusterCols: false,
      distance: 'euclidean',
      linkage: 'average',
      memoryBudgetBytes: 2 ** 20,
    }),
    {
      name: 'RangeError',
      message: 'Clustering 1,001 genes needs about 4 MB of memory, more than the 1 MB ' +
        'this device gives an analysis. Show fewer genes, or turn clustering of genes off.',
    },
  );
  // The same 1,001 rows within the budget are clustered (no fixed row count).
  const clustered = await engine.clusterMatrix({
    matrix: { ...matrix, values: Float32Array.from({ length: 1001 * 2 }, (_, i) => (i * 7919) % 101) },
    clusterRows: true,
    clusterCols: false,
    distance: 'euclidean',
    linkage: 'average',
    memoryBudgetBytes: 512 * 2 ** 20,
  });
  assert.equal(clustered.rowOrder.length, 1001);
  assert.notEqual(clustered.rowDendrogram, null);
});

test('marker caches require one exact dataset identity', () => {
  assert.throws(
    () => new MarkerCache({
      maxCategories: 3,
    }),
    /datasetId.*required|dataset identity/i,
  );
  assert.throws(
    () => new MarkerCache({
      maxCategories: 3,
      identity: { key: '   ' },
    }),
    /datasetId.*non-empty|dataset identity/i,
  );

  const manager = getDataSourceManager();
  const previousDatasetId = manager.activeDatasetId;
  const controller = Object.create(GenesPanelController.prototype);
  controller.dataLayer = { state: { pointCount: 123, getDataMapping: () => ({ expression: 'X', geneNames: 'index' }) } };
  try {
    manager.activeDatasetId = null;
    assert.throws(
      () => controller._getCacheIdentity(),
      /active dataset.*required|datasetId.*required/i,
    );
    manager.activeDatasetId = 'exact-dataset';
    assert.match(controller._getCacheIdentity().key, /"exact-dataset"/);
  } finally {
    manager.activeDatasetId = previousDatasetId;
  }
});

test('unsupported heap measurement stays explicitly unavailable without guessed decisions', () => {
  const monitor = new MemoryMonitor();
  const usage = monitor.getMemoryUsage();
  if (!usage.available) {
    assert.equal(usage.usedJSHeapSize, null);
    assert.equal(usage.totalJSHeapSize, null);
    assert.equal(usage.jsHeapSizeLimit, null);
  }
  assert.equal(typeof monitor.checkBatchFeasibility, 'undefined');
  assert.equal(typeof monitor.suggestBatchSize, 'undefined');
});

test('streaming gene loads and analysis cleanup preserve exact failures', async () => {
  const loadFailure = new Error('exact streamed gene load failure');
  await assert.rejects(
    runGeneStream({
      dataLayer: {
        state: { pointCount: 4 },
        async readGeneColumn() {
          throw loadFailure;
        },
      },
      genes: ['FAILED_GENE'],
      tuner: createRunTuner({ poolSize: 1, cellCount: 4, budgetBytes: () => 2 ** 27 }),
      route: null,
      dispatch: () => assert.fail('a failed gene must never disappear from the requested stream'),
      onResult: () => assert.fail('a failed gene has no result'),
    }),
    error => error === loadFailure,
  );

  const cleanupFailure = new Error('exact analysis cleanup failure');
  assert.throws(
    () => cleanupAnalysisResources({
      dataLayer: {
        performCacheCleanup() {
          throw cleanupFailure;
        }
      },
      clearSourceCaches: false,
      dataLayerCleanup: 'expired',
    }),
    error => error === cleanupFailure,
  );

  const resetFailure = new Error('exact dataset reset failure');
  const comparison = Object.create(ComparisonModule.prototype);
  comparison._analysisWindowManager = {
    closeAll() {
      throw resetFailure;
    },
  };
  comparison._modeToggleContainer = null;
  comparison._uiManager = null;
  comparison.dataLayer = { resetForDatasetReload() {} };
  comparison.onPagesChanged = () => {};
  comparison._datasetReloadResetCount = 0;
  assert.throws(
    () => comparison.resetForDatasetReload({ reason: 'dataset-reload' }),
    error => error === resetFailure,
  );

  const concurrencyFailure = new Error('exact concurrent task failure');
  await assert.rejects(
    waitForAvailableSlot(
      new Set([Promise.reject(concurrencyFailure)]),
      1,
    ),
    error => error === concurrencyFailure,
  );
});

test('gene signature median computes the exact per-cell median', async () => {
  const cellIndices = Uint32Array.from([0, 1, 2, 3]);
  const columns = {
    A: Float32Array.from([1, 100, NaN, 4]),
    // A sparse column: its absent entry (cell 1) is a zero.
    B: { length: 4, indices: Uint32Array.of(0, 2, 3), values: Float32Array.of(3, 5, 6) },
    C: Float32Array.from([2, 10, 7, 8]),
  };
  const dataLayer = {
    state: { pointCount: 4 },
    async readGeneColumns(genes) {
      return genes.map(gene => columns[gene]);
    },
    getPageCells(pageIds) {
      return pageIds.map(pageId => ({ pageId, pageName: 'Exact page', cellIndices }));
    },
    performCacheCleanup() {},
  };
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = dataLayer;
  analysis._computeManager = null;

  const { sets: [{ pages: [result] }] } = await analysis.computeSignatureScore({
    geneSets: [{ name: 'S', genes: ['A', 'B', 'C'] }],
    pageIds: ['page'],
    method: 'median',
  });

  assert.deepEqual(Array.from(result.scores), [2, 10, 6, 6]);
  assert.equal(result.method, 'median');
  assert.deepEqual(
    result.statistics,
    {
      count: 4,
      mean: 6,
      median: 6,
      min: 2,
      max: 10,
      std: Math.sqrt(8),
    },
  );
});

test('gene signature scoring preserves prototype-named gene and page cross-products', async () => {
  const exactNames = Object.getOwnPropertyNames(Object.prototype);
  // Page p is cell p; gene g has the value g + p there.
  const pointCount = exactNames.length;
  const columns = new Map(exactNames.map((gene, geneIndex) => [
    gene,
    Float32Array.from({ length: pointCount }, (_, cell) => geneIndex + cell),
  ]));
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    state: { pointCount },
    async readGeneColumns(genes) {
      return genes.map(gene => columns.get(gene));
    },
    getPageCells(pageIds) {
      return pageIds.map(pageId => ({
        pageId,
        pageName: `Page ${pageId}`,
        cellIndices: Uint32Array.of(exactNames.indexOf(pageId)),
      }));
    },
    performCacheCleanup() {},
  };
  analysis._computeManager = null;

  const { sets: [{ pages: result }] } = await analysis.computeSignatureScore({
    geneSets: [{ name: 'S', genes: exactNames }],
    pageIds: exactNames,
    method: 'mean',
  });

  assert.deepEqual(result.map(page => page.pageId), exactNames);
  for (const [pageIndex, page] of result.entries()) {
    assert.equal(page.pageName, `Page ${exactNames[pageIndex]}`);
    assert.deepEqual(Array.from(page.cellIndices), [pageIndex]);
    assert.deepEqual(Array.from(page.scores), [
      ((exactNames.length - 1) / 2) + pageIndex,
    ]);
    assert.equal(page.genesUsed, exactNames.length);
  }
});

test('differential expression requires exact dataset and gene identities', async () => {
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    state: {},
    getAvailableVariables() {
      assert.fail('gene discovery must not run without exact pointCount');
    },
  };
  const options = {
    groupA: { name: 'A', cells: Uint32Array.of(0, 1) },
    groupB: { name: 'B', cells: Uint32Array.of(2, 3) },
    geneList: null,
    method: 'wilcox',
    minCells: 2,
  };

  await assert.rejects(
    analysis.differentialExpression(options),
    /exact positive dataset pointCount/i,
  );

  analysis.dataLayer = {
    state: { pointCount: 4 },
    resolveExpressionMatrix: () => ({ matrix: 'X', read: null, label: 'Mapped (X)' }),
    async getGeneKeys() { return this.getAvailableVariables('gene_expression').map(gene => gene.key); },
    getAvailableVariables() {
      return [{ key: 'KNOWN_GENE', name: 'Known gene' }];
    },
  };
  await assert.rejects(
    analysis.differentialExpression({
      ...options,
      geneList: ['UNKNOWN_GENE'],
    }),
    /requested differential expression gene not found.*UNKNOWN_GENE/i,
  );
});
