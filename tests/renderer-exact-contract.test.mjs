import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  HighPerfRenderer,
  SpatialIndex,
} from '../assets/js/rendering/high-perf-renderer.js';
import {
  HighlightRenderer,
  HighlightTools,
} from '../assets/js/rendering/highlight-renderer.js';
import {
  buildOverlayContext,
} from '../assets/js/rendering/overlays/overlay-context.js';
import {
  OverlayManager,
} from '../assets/js/rendering/overlays/overlay-manager.js';
import {
  VelocityOverlay,
} from '../assets/js/rendering/overlays/velocity/velocity-overlay.js';
import {
  SmokeRenderer,
} from '../assets/js/rendering/smoke-cloud/smoke-renderer.js';
import * as smokeDensity from '../assets/js/rendering/smoke-cloud/smoke-density.js';
import {
  rasterizePointsWebgl,
} from '../assets/js/app/ui/modules/figure-export/utils/webgl-point-rasterizer.js';
import {
  assertCropRect01,
} from '../assets/js/app/ui/modules/figure-export/utils/crop.js';
import {
  assertFigureExportBatchRequest,
  assertFigureExportSingleRequest,
} from '../assets/js/app/ui/modules/figure-export/figure-export-contract.js';
import {
  GPUTimer,
  HighPerfBenchmark,
  MeshSurfaceSampler,
  PerformanceTracker,
  SyntheticDataGenerator,
} from '../assets/js/dev/benchmark.js';

const renderingRoot = new URL('../assets/js/rendering/', import.meta.url);
const figureExportRoot = new URL(
  '../assets/js/app/ui/modules/figure-export/',
  import.meta.url
);

async function source(relativeUrl, root = renderingRoot) {
  return readFile(new URL(relativeUrl, root), 'utf8');
}

test('spatial indices require an exact supported dimension contract', () => {
  const positions = Float32Array.from([0, 0, 0, 1, 1, 1]);
  const colors = Uint8Array.from([
    255, 0, 0, 255,
    0, 0, 255, 255,
  ]);
  const options = {
    buildLOD: false,
    buildLodNodeMappings: false,
    computeNodeStats: false,
  };

  assert.throws(
    () => new SpatialIndex(positions, colors, undefined, 1000, 8, options),
    /dimensionLevel.*required/i
  );
  assert.throws(
    () => new SpatialIndex(positions, colors, 4, 1000, 8, options),
    /dimensionLevel.*1.*2.*3/i
  );
});

test('renderer quality selection rejects unknown current-contract values', () => {
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    programs: {
      full: { id: 'full' },
      light: { id: 'light' },
      ultralight: { id: 'ultralight' },
    },
    gl: {
      useProgram() {},
    },
  });
  assert.throws(
    () => renderer.setQuality('cinematic'),
    /quality.*full.*light.*ultralight/i
  );

  const highlight = Object.assign(Object.create(HighlightRenderer.prototype), {
    highlightStylesByQuality: {
      full: {},
      light: {},
      ultralight: {},
    },
  });
  assert.throws(
    () => highlight.setQuality('cinematic'),
    /quality.*full.*light.*ultralight/i
  );
});

test('renderer statistics publish only after an exact per-view render update', () => {
  const viewState = {
    stats: {
      visiblePoints: 0,
      lodLevel: -1,
      drawCalls: 0,
      frustumCulled: false,
      cullPercent: 0,
    },
    statsPublished: false,
  };
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    _perViewState: new Map([['live', viewState]]),
    stats: {
      lastFrameTime: 2,
      fps: 60,
      gpuMemoryMB: 1,
    },
  });

  assert.equal(renderer.hasStats('live'), false);
  assert.throws(() => renderer.getStats('live'), /no published render statistics/i);

  renderer._updateStats(viewState, {
    visiblePoints: 6,
    lodLevel: -1,
    drawCalls: 1,
    frustumCulled: false,
    cullPercent: 0,
  });

  assert.equal(renderer.hasStats('live'), true);
  assert.equal(renderer.getStats('live').visiblePoints, 6);
});

test('performance tracking distinguishes slow visible frames from suspension gaps', () => {
  const tracker = new PerformanceTracker({ warmupFrames: 0 });
  tracker.start();

  tracker.lastTime = performance.now() - 1500;
  const slowVisibleStats = tracker.recordFrame();
  assert.equal(slowVisibleStats.samples, 1);
  assert.ok(slowVisibleStats.maxFrameTime > 1000);

  tracker.pause();
  tracker.lastTime = performance.now() - 5000;
  const pausedStats = tracker.recordFrame();
  assert.equal(pausedStats.samples, 1);
  assert.equal(pausedStats.maxFrameTime, slowVisibleStats.maxFrameTime);

  const beforeResume = performance.now();
  tracker.resume();
  const afterResume = performance.now();
  assert.ok(tracker.lastTime >= beforeResume);
  assert.ok(tracker.lastTime <= afterResume);

  tracker.lastTime = Number.NEGATIVE_INFINITY;
  const nonFiniteStats = tracker.recordFrame();
  assert.equal(nonFiniteStats.samples, 1);
});

test('renderer frame timing remains owned by the view that produced it', () => {
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    _perViewState: new Map([
      ['live', {
        stats: {
          visiblePoints: 6,
          lodLevel: -1,
          drawCalls: 1,
          frustumCulled: false,
          cullPercent: 0,
          lastFrameTime: 2,
          fps: 500,
        },
        statsPublished: true,
      }],
      ['snap_1', {
        stats: {
          visiblePoints: 3,
          lodLevel: 0,
          drawCalls: 2,
          frustumCulled: true,
          cullPercent: 50,
          lastFrameTime: 8,
          fps: 125,
        },
        statsPublished: true,
      }],
    ]),
    stats: {
      lastFrameTime: 99,
      fps: 10,
      gpuMemoryMB: 1,
    },
  });

  assert.equal(renderer.getStats('live').lastFrameTime, 2);
  assert.equal(renderer.getStats('live').fps, 500);
  assert.equal(renderer.getStats('snap_1').lastFrameTime, 8);
  assert.equal(renderer.getStats('snap_1').fps, 125);
  const aggregate = renderer.getAggregatedStats();
  assert.equal(aggregate.lastFrameTime, 10);
  assert.equal(aggregate.fps, 100);
  assert.deepEqual(
    aggregate.views.map(({ viewId, lastFrameTime, fps }) => ({
      viewId,
      lastFrameTime,
      fps,
    })),
    [
      { viewId: 'live', lastFrameTime: 2, fps: 500 },
      { viewId: 'snap_1', lastFrameTime: 8, fps: 125 },
    ]
  );
});

test('snapshot buffers publish owned bounds before live position identity can change', async () => {
  const rendererSource = await source('high-perf-renderer.js');
  assert.match(
    rendererSource,
    /const snapshotBounds = HighPerfRenderer\.computeBoundsFromPositions\(positions\)/
  );
  assert.match(rendererSource, /bounds:\s*snapshotBounds/);
  assert.doesNotMatch(
    rendererSource,
    /const customBounds = hasCustomPositions\s*\?\s*HighPerfRenderer\.computeBoundsFromPositions/
  );
});

test('high-performance data entry points do not clamp or default dimensions', async () => {
  const rendererSource = await source('high-perf-renderer.js');

  assert.doesNotMatch(
    rendererSource,
    /dimensionLevel\s*=\s*3|Math\.max\(1,\s*Math\.min\(3,\s*dimensionLevel\)\)/
  );
  assert.doesNotMatch(
    rendererSource,
    /Invalid quality[\s\S]{0,120}using "full"/
  );
});

test('an exact empty scene publishes empty alpha state without a synthetic texture', () => {
  let cacheInvalidations = 0;
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    pointCount: 0,
    _alphaTexture: null,
    _alphaTexData: new Uint8Array(),
    _alphaTexWidth: 0,
    _alphaTexHeight: 0,
    _useAlphaTexture: false,
    _currentAlphas: null,
    invalidateLodVisibilityCache() {
      cacheInvalidations += 1;
    },
  });
  const alphas = new Float32Array();

  renderer.updateAlphas(alphas);

  assert.equal(renderer.getCurrentAlphas(), alphas);
  assert.equal(renderer._useAlphaTexture, false);
  assert.equal(renderer._alphaTexture, null);
  assert.equal(cacheInvalidations, 1);
});

test('high-performance rendering has no legacy alpha or global-view path', async () => {
  const rendererSource = await source('high-perf-renderer.js');

  assert.doesNotMatch(
    rendererSource,
    /backwards compatibility|legacy fallback|global cache fallback/i
  );
  assert.doesNotMatch(
    rendererSource,
    /getLodVisibilityArray\([^)]*viewId\s*=\s*undefined/
  );
  assert.doesNotMatch(
    rendererSource,
    /if\s*\(\s*!this\._useAlphaTexture\s*\)[\s\S]{0,600}bufferSubData/
  );
});

test('highlight rendering owns exact view inputs and one visibility API', async () => {
  const highlightSource = await source('highlight-renderer.js');

  assert.doesNotMatch(
    highlightSource,
    /_viewPositions|_viewId|API compatibility|global positions as fallback/i
  );
  assert.doesNotMatch(
    highlightSource,
    /getCombinedVisibilityForView[\s\S]{0,180}getLodVisibilityArray/
  );
  assert.doesNotMatch(
    highlightSource,
    /viewPositions\s*\|\||String\(viewId\s*\|\|/
  );
});

test('highlight LOD synchronization calls one exact per-view renderer contract', () => {
  const positions = Float32Array.from([0, 0, 0]);
  const transparency = Float32Array.from([1]);
  const highlightData = Uint8Array.from([255]);
  const calls = [];
  const tools = Object.assign(Object.create(HighlightTools.prototype), {
    highlightArray: highlightData,
    hpRenderer: {
      getLodVisibilityArray(viewId, dimensionLevel) {
        calls.push(['visibility', viewId, dimensionLevel]);
        return null;
      },
      getCurrentLODLevel(viewId) {
        calls.push(['level', viewId]);
        return -1;
      },
    },
    highlightRenderer: {
      _computeTransparencyFingerprint: () => 'visible',
      needsRefresh: () => true,
      rebuildBuffer(...args) {
        calls.push(['rebuild', ...args]);
      },
    },
    _lastUsedPositionsMap: new Map(),
    _lastPositionFingerprintMap: new Map(),
    _lastTransparencyFingerprintMap: new Map(),
  });

  tools.syncHighlightBufferForLod(
    positions,
    'live',
    transparency,
    2
  );

  assert.deepEqual(calls[0], ['visibility', 'live', 2]);
  assert.deepEqual(calls[1], ['level', 'live']);
  assert.equal(calls[2][0], 'rebuild');
  assert.equal(calls[2][5], 'live');
  assert.equal(calls[2][6], transparency);
});

test('viewer position access never substitutes another view', async () => {
  const viewerSource = await source('viewer.js');

  assert.doesNotMatch(
    viewerSource,
    /viewPositionsCache\.get\([^)]*\)\s*\|\|\s*positionsArray/
  );
  assert.doesNotMatch(
    viewerSource,
    /if\s*\(\s*!viewId\s*\)\s*return\s+positionsArray/
  );
  assert.doesNotMatch(
    viewerSource,
    /const\s+vid\s*=\s*viewId\s*\|\||cached\?\.cameraDistance\s*\?\?\s*radius/
  );
  assert.doesNotMatch(
    viewerSource,
    /_renderAllViews\.find\([^;]+?\)\s*\|\|\s*_renderAllViews\[0\]/
  );
});

test('overlay contexts require exact per-view render state', () => {
  const matrix = new Float32Array(16);
  const renderParams = {
    mvpMatrix: matrix,
    viewMatrix: matrix,
    modelMatrix: matrix,
    projectionMatrix: matrix,
    viewportWidth: 640,
    viewportHeight: 480,
    fov: Math.PI / 4,
    sizeAttenuation: 1,
    fogDensity: 0,
    fogColor: [1, 1, 1],
    cameraPosition: [0, 0, 3],
    cameraDistance: 3,
    useAlphaTexture: false,
  };
  const hpRenderer = {
    getAlphaTexture: () => null,
    getAlphaTextureWidth: () => 0,
    isAlphaTextureActive: () => false,
    getFogNear: () => 0,
    getFogFar: () => 10,
    getCurrentLODLevel: () => -1,
    getCurrentLodIndices: () => null,
  };

  assert.throws(
    () => buildOverlayContext({
      gl: {},
      viewId: 'live',
      renderParams,
      timeSeconds: 1,
      deltaTimeSeconds: 1 / 60,
      isSnapshot: false,
      hpRenderer,
      getViewPositions: () => new Float32Array(),
      getViewTransparency: () => new Float32Array(),
    }),
    /dimensionLevel.*required/i
  );
});

test('overlay registration requires the complete current lifecycle', () => {
  const manager = new OverlayManager({});

  assert.throws(
    () => manager.register({ id: 'partial-overlay' }),
    /init.*update.*render.*dispose/i
  );
});

test('velocity configuration rejects coercion instead of normalizing it', () => {
  assert.throws(
    () => new VelocityOverlay({}, { particleCount: '15000' }),
    /particleCount.*number/i
  );
  assert.throws(
    () => new VelocityOverlay({}, { bloomEnabled: 'false' }),
    /bloomEnabled.*boolean/i
  );
});

test('smoke exposes one GPU density implementation and no compatibility alias', () => {
  assert.equal(
    Object.hasOwn(smokeDensity, 'buildDensityVolume'),
    false,
    'CPU density substitution must not remain public'
  );
  assert.equal(
    SmokeRenderer.prototype.setHalfResolution,
    undefined,
    'setHalfResolution is a deleted compatibility API'
  );
});

test('smoke failures are visible and never route to a CPU implementation', async () => {
  const densitySource = await source('smoke-cloud/smoke-density.js');
  const rendererSource = await source('smoke-cloud/smoke-renderer.js');

  assert.doesNotMatch(
    densitySource,
    /falling back to CPU|CPU fallback|buildDensityVolume\(positions/
  );
  assert.doesNotMatch(
    rendererSource,
    /noiseGenerationFailed|loading\/fallback state/i
  );
});

test('shader-accurate rasterization rejects incomplete export state', () => {
  assert.throws(
    () => rasterizePointsWebgl({
      positions: Float32Array.from([0, 0, 0]),
      colors: Uint8Array.from([255, 255, 255, 255]),
      renderState: null,
      outputWidthPx: 100,
      outputHeightPx: 100,
      pointSizePx: 4,
    }),
    /renderState.*required|missing.*renderState/i
  );
});

test('figure export never changes format, strategy, backend, or fidelity', async () => {
  const [
    engineSource,
    uiSource,
    warningSource,
    rasterizerSource,
    pngSource,
    svgSource,
  ] = await Promise.all([
    source('figure-export-engine.js', figureExportRoot),
    source('figure-export-ui.js', figureExportRoot),
    source('components/fidelity-warning-dialog.js', figureExportRoot),
    source('utils/webgl-point-rasterizer.js', figureExportRoot),
    source('renderers/png-renderer.js', figureExportRoot),
    source('renderers/svg-renderer.js', figureExportRoot),
  ]);

  assert.doesNotMatch(
    engineSource,
    /strategy\s*===\s*['"]raster['"]\s*\?\s*['"]png['"]|datasetName:\s*['"]Synthetic['"]/
  );
  assert.doesNotMatch(
    uiSource,
    /strategy adjusted|fall back to flat circles|value:\s*['"]raster['"]|value\s*=\s*['"]hybrid['"]/i
  );
  assert.doesNotMatch(warningSource, /Export anyway/i);
  assert.doesNotMatch(
    rasterizerSource,
    /OffscreenCanvas|falling back to CPU|use flat circles/i
  );
  assert.doesNotMatch(
    pngSource,
    /WebGL rasterizer returned null[\s\S]{0,100}Canvas2D flat circles/i
  );
  assert.doesNotMatch(
    svgSource,
    /xlink:href|xmlns:xlink|rasterizer returned null[\s\S]{0,180}vector circles/i
  );
});

test('figure export crop state rejects aliases, coercion, and repair', () => {
  assert.deepEqual(
    assertCropRect01({
      enabled: true,
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
    }),
    {
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
    }
  );
  assert.equal(assertCropRect01(null), null);

  for (const invalid of [
    { enabled: true, x: '0.1', y: 0.2, width: 0.3, height: 0.4 },
    { enabled: true, x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    { enabled: true, x: -0.1, y: 0.2, width: 0.3, height: 0.4 },
    { enabled: true, x: 0.8, y: 0.2, width: 0.3, height: 0.4 },
    { enabled: false, x: 0, y: 0, width: 1, height: 1 },
  ]) {
    assert.throws(
      () => assertCropRect01(invalid),
      /crop/i
    );
  }
});

test('figure export requests publish one complete current contract', () => {
  const base = {
    width: 1200,
    height: 900,
    exportAllViews: false,
    title: '',
    includeAxes: true,
    includeLegend: true,
    legendPosition: 'right',
    xLabel: 'X',
    yLabel: 'Y',
    background: 'viewer',
    backgroundColor: '#ffffff',
    fontFamily: 'Arial, sans-serif',
    fontSizePx: 12,
    legendFontSizePx: 12,
    tickFontSizePx: 12,
    axisLabelFontSizePx: 12,
    titleFontSizePx: 15,
    centroidLabelFontSizePx: 12,
    crop: null,
    showOrientation: true,
    depthSort3d: true,
    emphasizeSelection: false,
    selectionMutedOpacity: 0.15,
    strategy: null,
    optimizedTargetCount: null,
  };
  const single = { ...base, format: 'png', dpi: 300 };
  assert.equal(assertFigureExportSingleRequest(single), single);

  const batch = {
    ...base,
    strategy: 'hybrid',
    jobs: [
      { format: 'svg', dpi: null },
      { format: 'png', dpi: 300 },
    ],
  };
  assert.equal(assertFigureExportBatchRequest(batch), batch);

  for (const invalid of [
    { ...single, width: '1200' },
    { ...single, includeAxes: 1 },
    { ...single, selectionMutedOpacity: 1.1 },
    { ...single, crop: { enabled: false, x: 0, y: 0, width: 1, height: 1 } },
    { ...single, strategy: 'hybrid' },
    { ...single, legacyFormat: 'png' },
  ]) {
    assert.throws(
      () => assertFigureExportSingleRequest(invalid),
      /figure export|crop/i
    );
  }
  assert.throws(
    () => assertFigureExportBatchRequest({
      ...base,
      strategy: 'hybrid',
      jobs: [{ format: 'svg', dpi: 300 }],
    }),
    /dpi.*null|SVG.*dpi/i
  );
  assert.throws(
    () => assertFigureExportBatchRequest({
      ...batch,
      dpi: 300,
    }),
    /exactly/i
  );
});

test('renderer benchmark consumers request one exact per-view statistics owner', async () => {
  const benchmarkSource = await source('dev/benchmark.js', new URL('../assets/js/', import.meta.url));
  assert.doesNotMatch(
    benchmarkSource,
    /this\.renderer\.getStats\(\)/
  );
  assert.doesNotMatch(
    benchmarkSource,
    /this\.viewer\.getRendererStats\(\)/
  );
  assert.doesNotMatch(
    benchmarkSource,
    /backward compatibility|legacy-compatible|legacy format|fall(?:s)? back|fallback|getExtension\(['"]EXT_disjoint_timer_query['"]\)|window\.(?:SyntheticDataGenerator|PerformanceTracker|HighPerfBenchmark|BenchmarkConfig|BenchmarkReporter|BenchmarkExporter|BottleneckAnalyzer|startLiveMonitor|stopLiveMonitor|analyzeBottleneck|hideMetrics)/i
  );
  assert.doesNotMatch(
    benchmarkSource,
    /export\s+(?:class\s+BenchmarkExporter|\{\s*formatNumber\s*\})/
  );
});

test('GLB surface sampling writes exact caller-owned buffers', () => {
  const sampler = new MeshSurfaceSampler(
    Float32Array.from([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ]),
    null
  );
  const sampledPosition = new Float32Array(3);
  const sampledNormal = new Float32Array(3);
  const originalRandom = Math.random;
  const values = [0.5, 0.2, 0.3];
  Math.random = () => values.shift();
  try {
    sampler.sampleInto(
      sampledPosition,
      0,
      sampledNormal,
      0
    );
  } finally {
    Math.random = originalRandom;
  }

  assert.ok(Math.abs(sampledPosition[0] - 0.2) < 1e-6);
  assert.ok(Math.abs(sampledPosition[1] - 0.3) < 1e-6);
  assert.equal(sampledPosition[2], 0);
  assert.deepEqual(Array.from(sampledNormal), [0, 0, 1]);
  assert.throws(
    () => sampler.sampleInto(
      new Float32Array(2),
      0,
      sampledNormal,
      0
    ),
    /three writable values/
  );
  assert.throws(
    () => new MeshSurfaceSampler(
      Float32Array.from([
        0, 0, 0,
        0, 0, 0,
        0, 0, 0,
      ]),
      null
    ),
    /non-degenerate triangle/
  );
});

test('GLB URL generation shares one exact browser fetch per asset', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(
    globalThis,
    'window'
  );
  const previousFetch = Object.getOwnPropertyDescriptor(
    globalThis,
    'fetch'
  );
  const originalFromGLB = SyntheticDataGenerator.fromGLB;
  const buffer = new ArrayBuffer(16);
  const observedBuffers = [];
  let fetchCalls = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        href: 'https://viewer.test/?acceptance=glb-cache'
      }
    }
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (_url, options) => {
      fetchCalls += 1;
      assert.deepEqual(options, { cache: 'default' });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async arrayBuffer() {
          return buffer;
        }
      };
    }
  });
  SyntheticDataGenerator.fromGLB = (count, receivedBuffer) => {
    observedBuffers.push(receivedBuffer);
    return { count };
  };

  try {
    const url = `assets/test-${process.pid}-${Date.now()}.glb`;
    const [first, second] = await Promise.all([
      SyntheticDataGenerator.fromGLBUrl(10, url),
      SyntheticDataGenerator.fromGLBUrl(20, url),
    ]);
    assert.deepEqual(first, { count: 10 });
    assert.deepEqual(second, { count: 20 });
    assert.equal(fetchCalls, 1);
    assert.deepEqual(observedBuffers, [buffer, buffer]);
  } finally {
    SyntheticDataGenerator.fromGLB = originalFromGLB;
    if (previousWindow === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, 'window', previousWindow);
    if (previousFetch === undefined) delete globalThis.fetch;
    else Object.defineProperty(globalThis, 'fetch', previousFetch);
  }
});

test('benchmark comparisons require current unrounded measurements', () => {
  const benchmark = new HighPerfBenchmark(null);
  const current = {
    results: [{
      name: 'current-contract',
      fps: 54,
      fpsRaw: 54.5,
      avgFrameTime: 18.35,
      stdDev: 0.2,
    }],
  };
  const baseline = {
    results: [{
      name: 'current-contract',
      fps: 60,
      fpsRaw: 60.5,
      avgFrameTime: 16.53,
      stdDev: 0.2,
    }],
  };

  const result = benchmark.compareBenchmarks(baseline, current);
  assert.equal(result.comparisons[0].baseline.fpsRaw, 60.5);
  assert.equal(result.comparisons[0].current.fpsRaw, 54.5);

  assert.throws(
    () => benchmark.compareBenchmarks({
      results: [{ ...baseline.results[0], fpsRaw: undefined }],
    }, current),
    /baseline benchmark.*fpsRaw/i
  );
  assert.throws(
    () => benchmark.compareBenchmarks(baseline, {
      results: [{ ...current.results[0], fpsRaw: undefined }],
    }),
    /current benchmark.*fpsRaw/i
  );
});

test('GPU timing uses only the WebGL2 current extension contract', () => {
  const requested = [];
  const timer = new GPUTimer({
    getExtension(name) {
      requested.push(name);
      return null;
    },
  });
  assert.deepEqual(requested, ['EXT_disjoint_timer_query_webgl2']);
  assert.equal(timer.isAvailable(), false);
});
