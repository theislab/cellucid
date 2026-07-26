import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { DataLayer } from '../assets/js/app/analysis/data/data-layer.js';
import { StreamingGeneLoader } from '../assets/js/app/analysis/data/streaming-gene-loader.js';
import { ComparisonModule } from '../assets/js/app/analysis/comparison-module.js';
import { ExpressionMatrixBuilder } from '../assets/js/app/analysis/genes-panel/expression-matrix-builder.js';
import { GenesPanelController } from '../assets/js/app/analysis/genes-panel/genes-panel-controller.js';
import { benjaminiHochberg } from '../assets/js/app/analysis/genes-panel/marker-discovery-engine.js';
import { MarkerCache } from '../assets/js/app/analysis/genes-panel/marker-cache.js';
import { ClusteringEngine } from '../assets/js/app/analysis/genes-panel/clustering-engine.js';
import { BasePlot } from '../assets/js/app/analysis/plots/plot-base.js';
import { LayoutEngine } from '../assets/js/app/analysis/plots/layout-engine.js';
import geneHeatmapDefinition from '../assets/js/app/analysis/plots/types/gene-heatmap.js';
import {
  AnalysisError,
  formatErrorForUser,
  getErrorMessage,
  wrapAsync,
} from '../assets/js/app/analysis/shared/error-utils.js';
import { waitForAvailableSlot } from '../assets/js/app/analysis/shared/concurrency-utils.js';
import { getPerformanceFormValues } from '../assets/js/app/analysis/shared/dom-utils.js';
import { createMemoryMonitor } from '../assets/js/app/analysis/shared/memory-monitor.js';
import { PerformanceConfig } from '../assets/js/app/analysis/shared/performance-config.js';
import { cleanupAnalysisResources } from '../assets/js/app/analysis/shared/resource-cleanup.js';
import {
  computeQuickDifferentialExpression,
  computeVarianceScore,
} from '../assets/js/app/analysis/stats/quick-stats.js';
import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';
import { getDataSourceManager } from '../assets/js/data/data-source-manager.js';

const ANALYSIS_ROOT = new URL('../assets/js/app/analysis/', import.meta.url);

async function analysisSource(path) {
  return readFile(new URL(path, ANALYSIS_ROOT), 'utf8');
}

test('analysis fallback, retry, coercion, and compatibility shims are absent from current surfaces', async () => {
  const paths = [
    'data/data-layer.js',
    'data/streaming-gene-loader.js',
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
    'shared/error-utils.js',
    'shared/concurrency-utils.js',
    'shared/dom-utils.js',
    'shared/memory-monitor.js',
    'shared/plot-theme.js',
    'shared/resource-cleanup.js',
    'stats/quick-stats.js',
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

test('analysis performance settings use exact dataset-aware values', () => {
  PerformanceConfig.resetToDefaults();
  const recommendation = PerformanceConfig.getRecommendedSettings(
    561_947,
    30_000,
  );
  const batchOptions = PerformanceConfig.getBatchSizeOptions(
    561_947,
    30_000,
  );
  assert.deepEqual(
    batchOptions.filter(option => option.selected).map(option => option.value),
    [recommendation.preloadCount],
  );
  assert.ok(batchOptions.every(option => option.value <= 500));

  const fields = new Map([
    ['parallelism', { value: 'auto' }],
    ['batchSize', { value: String(recommendation.preloadCount) }],
    ['memoryBudget', { value: '512' }],
    ['networkConcurrency', { value: '6' }],
  ]);
  const form = {
    querySelector(selector) {
      const match = selector.match(/^\[name="([^"]+)"\]$/);
      return match ? fields.get(match[1]) : null;
    },
  };
  assert.deepEqual(
    getPerformanceFormValues(form),
    {
      parallelism: 'auto',
      batchConfig: {
        preloadCount: recommendation.preloadCount,
        memoryBudgetMB: 512,
        networkConcurrency: 6,
      },
    },
  );

  fields.delete('batchSize');
  assert.throws(
    () => getPerformanceFormValues(form),
    /field "batchSize" is required/i,
  );
  assert.throws(
    () => PerformanceConfig.getRecommendedSettings(0, 30_000),
    /cellCount.*positive/i,
  );
  assert.throws(
    () => PerformanceConfig.applyPreset('unknown-preset'),
    /unknown preset.*unknown-preset/i,
  );
});

test('marker p-value correction rejects malformed scientific values', () => {
  assert.deepEqual(
    Array.from(benjaminiHochberg(Float64Array.from([0.01, 0.04, 0.03]))),
    [0.03, 0.04, 0.04],
  );
  assert.throws(
    () => benjaminiHochberg(Float64Array.from([0.01, 1.2])),
    /p-value.*between 0 and 1/i,
  );
  assert.throws(
    () => benjaminiHochberg(Float64Array.from([0.01, NaN])),
    /p-value.*finite/i,
  );
});

test('custom marker analysis rejects every unknown requested gene', async () => {
  const controller = Object.create(GenesPanelController.prototype);
  controller.dataLayer = {
    getAvailableVariables() {
      return [
        { key: 'KNOWN', name: 'Known' },
      ];
    },
  };
  controller._matrixBuilder = {
    async buildMatrix() {
      assert.fail('matrix construction must not run for an unknown gene');
    },
  };

  await assert.rejects(
    controller._runCustomAnalysis({
      groups: [],
      genes: ['KNOWN', 'UNKNOWN'],
      transform: 'none',
      distance: 'euclidean',
      linkage: 'average',
      clusterRows: false,
      clusterCols: false,
      onProgress: undefined,
      signal: undefined,
    }),
    /requested custom gene.*UNKNOWN.*not found/i,
  );
});

test('expression matrices encode exact primitive group labels and preserve owned colors', () => {
  const builder = new ExpressionMatrixBuilder({ dataLayer: {} });
  const groups = [
    {
      groupId: 'false-group',
      groupName: false,
      color: 'var(--color-category-1)',
    },
    {
      groupId: 'zero-group',
      groupName: 0,
      color: 'var(--color-category-2)',
    },
  ];
  const matrix = builder.buildMatrixFromData({
    genes: ['GENE'],
    groups,
    geneData: new Map([
      ['GENE', new Map([
        ['false-group', Float32Array.from([1, 3])],
        ['zero-group', Float32Array.from([2, 4])],
      ])],
    ]),
    transform: 'none',
  });

  assert.deepEqual(matrix.groupIds, ['false-group', 'zero-group']);
  assert.deepEqual(matrix.groupNames, ['false', '0']);
  assert.deepEqual(
    matrix.groupColors,
    ['var(--color-category-1)', 'var(--color-category-2)'],
  );
  assert.deepEqual(Array.from(matrix.values), [2, 3]);

  const baseGroup = {
    groupId: 'group-a',
    groupName: 'Group A',
    color: 'var(--color-category-1)',
  };
  for (const invalidName of ['', '   ', null, undefined, NaN, Infinity, {}]) {
    assert.throws(
      () => builder.buildMatrixFromData({
        genes: ['GENE'],
        groups: [{ ...baseGroup, groupName: invalidName }],
        geneData: new Map(),
        transform: 'none',
      }),
      /group.*name.*(?:empty|string|finite|boolean)/i,
    );
  }
  assert.throws(
    () => builder.buildMatrixFromData({
      genes: ['GENE'],
      groups: [{ ...baseGroup, color: '' }],
      geneData: new Map(),
      transform: 'none',
    }),
    /group.*color/i,
  );
  assert.throws(
    () => builder.buildMatrixFromData({
      genes: ['GENE'],
      groups: [
        { ...baseGroup, groupId: 'number', groupName: 0 },
        { ...baseGroup, groupId: 'string', groupName: '0' },
      ],
      geneData: new Map(),
      transform: 'none',
    }),
    /duplicate display name/i,
  );
});

test('custom marker analysis returns current metadata without stale validation fields', async () => {
  const controller = Object.create(GenesPanelController.prototype);
  const matrix = {
    genes: ['KNOWN_A', 'KNOWN_B'],
    groupIds: ['group-a'],
    groupNames: ['Group A'],
    groupColors: ['var(--color-category-1)'],
    values: Float32Array.from([1, 2]),
    rawValues: null,
    nRows: 2,
    nCols: 1,
    transform: 'none',
  };
  controller.dataLayer = {
    getAvailableVariables() {
      return [
        { key: 'KNOWN_A', name: 'Known A' },
        { key: 'KNOWN_B', name: 'Known B' },
      ];
    },
  };
  controller._matrixBuilder = {
    async buildMatrix(options) {
      assert.deepEqual(options.genes, ['KNOWN_A', 'KNOWN_B']);
      return matrix;
    },
  };

  const result = await controller._runCustomAnalysis({
    groups: [{
      groupId: 'group-a',
      groupName: 'Group A',
      color: 'var(--color-category-1)',
      cellIndices: Uint32Array.from([0]),
    }],
    genes: ['KNOWN_A', 'KNOWN_B'],
    transform: 'none',
    distance: 'euclidean',
    linkage: 'average',
    clusterRows: false,
    clusterCols: false,
    onProgress: undefined,
    signal: undefined,
  });

  assert.equal(result.markers, null);
  assert.equal(result.matrix, matrix);
  assert.deepEqual(result.metadata, {
    mode: 'custom',
    transform: 'none',
    distance: 'euclidean',
    linkage: 'average',
    geneCount: 2,
    groupCount: 1,
  });
  assert.equal(Object.hasOwn(result.metadata, 'invalidGenes'), false);
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

test('requested clustering never becomes an unclustered result', async () => {
  const engine = new ClusteringEngine();
  await assert.rejects(
    engine.clusterMatrix({
      matrix: {
        values: new Float32Array(501 * 2),
        nRows: 501,
        nCols: 2,
      },
      clusterRows: true,
      clusterCols: false,
      distance: 'euclidean',
      linkage: 'average',
    }),
    /501.*500|clustering.*maximum/i,
  );
});

test('marker caches require one exact dataset identity', () => {
  assert.throws(
    () => new MarkerCache({
      maxCategories: 3,
      maxAgeDays: 7,
      cacheVersion: 1,
    }),
    /datasetId.*required|dataset identity/i,
  );
  assert.throws(
    () => new MarkerCache({
      maxCategories: 3,
      maxAgeDays: 7,
      cacheVersion: 1,
      datasetId: '   ',
    }),
    /datasetId.*non-empty|dataset identity/i,
  );

  const manager = getDataSourceManager();
  const previousDatasetId = manager.activeDatasetId;
  const controller = Object.create(GenesPanelController.prototype);
  controller.dataLayer = { state: { pointCount: 123 } };
  try {
    manager.activeDatasetId = null;
    assert.throws(
      () => controller._getDatasetId(),
      /active dataset.*required|datasetId.*required/i,
    );
    manager.activeDatasetId = 'exact-dataset';
    assert.equal(controller._getDatasetId(), 'exact-dataset');
  } finally {
    manager.activeDatasetId = previousDatasetId;
  }
});

test('error utilities preserve exact errors instead of substituting messages', async () => {
  assert.equal(getErrorMessage('NOT_FOUND'), 'Resource not found');
  assert.throws(
    () => getErrorMessage('UNKNOWN_CODE'),
    /unknown error code.*UNKNOWN_CODE/i,
  );
  assert.throws(
    () => formatErrorForUser(null),
    /error.*required/i,
  );

  const original = new TypeError('exact public failure');
  await assert.rejects(
    wrapAsync(async () => {
      throw original;
    }, 'ExactOperation'),
    error => error === original,
  );

  const analysisError = new AnalysisError('exact analysis failure', 'ANALYSIS_ERROR');
  assert.equal(formatErrorForUser(analysisError), 'exact analysis failure');
});

test('unsupported heap measurement stays explicitly unavailable without guessed decisions', () => {
  const monitor = createMemoryMonitor();
  const usage = monitor.getMemoryUsage();
  if (!usage.available) {
    assert.equal(usage.usedJSHeapSize, null);
    assert.equal(usage.totalJSHeapSize, null);
    assert.equal(usage.jsHeapSizeLimit, null);
  }
  assert.equal(typeof monitor.checkBatchFeasibility, 'undefined');
  assert.equal(typeof monitor.suggestBatchSize, 'undefined');
});

test('quick statistics are deterministic and gene-load failures are terminal', async () => {
  const values = Array.from({ length: 10_000 }, (_, index) => index % 37);
  assert.deepEqual(computeVarianceScore(values), computeVarianceScore(values));

  const loaderFailure = new Error('gene payload failed');
  await assert.rejects(
    computeQuickDifferentialExpression({
      getAvailableVariables() {
        return [{ key: 'GENE', name: 'Gene' }];
      },
      async getDataForPages() {
        throw loaderFailure;
      },
    }, 'page-a', 'page-b', 1),
    error => error === loaderFailure,
  );

  const source = await analysisSource('stats/quick-stats.js');
  assert.doesNotMatch(source, /Math\.random|approximate statistics|skip failed genes/i);
});

test('streaming gene loads and analysis cleanup preserve exact failures', async () => {
  const loadFailure = new Error('exact streamed gene load failure');
  const loader = new StreamingGeneLoader({
    dataLayer: {
      state: { pointCount: 4 },
      async ensureGeneExpressionLoaded() {
        throw loadFailure;
      },
      unloadGeneExpression() {
        return true;
      },
      invalidateVariable() {},
    },
    config: {
      preloadCount: 1,
      networkConcurrency: 1,
      memoryBudgetMB: 128,
    },
  });

  await assert.rejects(
    async () => {
      for await (const _entry of loader.streamGenesRaw(['FAILED_GENE'])) {
        assert.fail('a failed gene must never disappear from the requested stream');
      }
    },
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
  const page = values => ({
    values,
    cellIndices,
    pageName: 'Exact page',
  });
  const dataLayer = {
    async getGeneExpressionSubset() {
      return {
        A: { page: page(Float32Array.from([1, 100, NaN, 4])) },
        B: { page: page(Float32Array.from([3, 0, 5, 6])) },
        C: { page: page(Float32Array.from([2, 10, 7, 8])) },
      };
    },
    clearBulkGeneCache() {},
    performCacheCleanup() {},
  };
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = dataLayer;
  analysis._computeManager = null;
  analysis._notifications = {
    loading() { return 'signature-notification'; },
    complete() {},
    fail() {},
  };

  const [result] = await analysis.computeSignatureScore({
    genes: ['A', 'B', 'C'],
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

test('differential expression requires exact dataset and gene identities', async () => {
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = {
    state: {},
    getAvailableVariables() {
      assert.fail('gene discovery must not run without exact pointCount');
    },
  };
  const options = {
    pageA: 'page-a',
    pageB: 'page-b',
    geneList: null,
    method: 'wilcox',
    minCells: 1,
    parallelism: 'auto',
    batchConfig: {},
  };

  await assert.rejects(
    analysis.differentialExpression(options),
    /exact positive dataset pointCount/i,
  );

  analysis.dataLayer = {
    state: { pointCount: 4 },
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
