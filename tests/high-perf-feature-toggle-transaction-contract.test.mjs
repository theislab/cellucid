import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';
import {
  BottleneckAnalyzer,
  HighPerfBenchmark,
} from '../assets/js/dev/benchmark.js';

function makeViewState() {
  return {
    lastFrustumMVP: new Float32Array(16),
    cachedCulledCount: 7,
    cachedVisibleIndices: new Uint32Array([0, 1]),
    cachedLodVisibleIndices: new Uint32Array([0]),
    cachedLodLevel: 2,
    cachedLodDimension: 3,
    cachedLodIsCulled: true,
    cachedVisibleNodes: [{ id: 'accepted' }],
    cachedVisibleSpatialOwner: { id: 'spatial-owner' },
    cachedVisibleSpatialRoot: { id: 'spatial-root' },
    cachedLodMappingGeneration: { id: 'mapping' },
    visibleNodesScratch: [{ id: 'scratch' }],
    visibleNodesSpare: [],
    lastDimensionLevel: 3,
    lastLodLevel: 2,
    prevLodLevel: 2,
    lastVisibleCount: 7,
    indexBuffer: Object.freeze({ id: 'view-ebo' }),
    indexBufferSize: 7,
    indexBufferByteLength: 64,
    usePreCachedIndexBuffer: true,
    preCachedIndexBuffer: Object.freeze({ id: 'lod-ebo' }),
    preCachedGenerationToken: Object.freeze({}),
    preCachedSpatialOwner: Object.freeze({}),
    frustumPlanes: Array.from(
      { length: 6 },
      () => new Float32Array(4),
    ),
    visibleIndicesBuffer: new Uint32Array(32),
    visibleIndicesCapacity: 32,
    visibleLodIndicesBuffer: new Uint32Array(16),
    visibleLodIndicesCapacity: 16,
    stats: {
      lastFrameTime: 4,
      fps: 250,
      visiblePoints: 7,
      lodLevel: 2,
      drawCalls: 1,
      frustumCulled: true,
      cullPercent: 30,
    },
    statsPublished: true,
  };
}

function makeToggleRenderer({
  adaptiveLOD = false,
  frustumCulling = false,
  forceLODLevel = 4,
  pointCount = 1,
} = {}) {
  const viewState = makeViewState();
  const unrelatedSpatial = Object.freeze({ id: 'unrelated-spatial' });
  const unrelatedLod = Object.freeze([{ id: 'unrelated-lod' }]);
  const unrelatedTextures = Object.freeze([{ id: 'unrelated-texture' }]);
  const unrelatedOwner = Object.freeze({ id: 'unrelated-owner' });
  const spatialIndices = new Map([[1, unrelatedSpatial]]);
  const lodBuffersByDimension = new Map([[1, unrelatedLod]]);
  const lodIndexTextures = new Map([[1, unrelatedTextures]]);
  const lodOwners = new Map([[1, unrelatedOwner]]);
  const perViewState = new Map([['live', viewState]]);
  const stats = {
    lastFrameTime: 4,
    fps: 250,
    visiblePoints: 7,
    lodLevel: 2,
    gpuMemoryMB: 3,
    drawCalls: 1,
    frustumCulled: true,
    cullPercent: 30,
  };
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      useAdaptiveLOD: adaptiveLOD,
      useFrustumCulling: frustumCulling,
      forceLODLevel,
      pointCount,
      _positions: pointCount > 0
        ? new Float32Array(pointCount * 3)
        : null,
      _colors: pointCount > 0
        ? new Uint8Array(pointCount * 4)
        : null,
      currentDimensionLevel: 3,
      spatialIndices,
      lodBuffersByDimension,
      _lodIndexTexturesByDimension: lodIndexTextures,
      _lodResourceOwnersByDimension: lodOwners,
      snapshotBuffers: new Map(),
      _snapshotGeometryPools: new Map(),
      _liveGeometryGeneration: 1,
      _perViewState: perViewState,
      stats,
      options: {
        LOD_MAX_POINTS_PER_NODE: 1000,
        LOD_MAX_DEPTH: 8,
      },
    },
  );
  return {
    renderer,
    viewState,
    spatialIndices,
    lodBuffersByDimension,
    lodIndexTextures,
    lodOwners,
    unrelatedSpatial,
    unrelatedLod,
    unrelatedTextures,
    unrelatedOwner,
    perViewState,
    stats,
  };
}

for (const [method, flag] of [
  ['setAdaptiveLOD', 'useAdaptiveLOD'],
  ['setFrustumCulling', 'useFrustumCulling'],
]) {
  test(`${method} requires one exact boolean before observing renderer state`, () => {
    const { renderer } = makeToggleRenderer();
    let pointCountReads = 0;
    Object.defineProperty(renderer, 'pointCount', {
      configurable: true,
      get() {
        pointCountReads += 1;
        return 1;
      },
    });

    for (const invalid of [0, 1, null, undefined, 'true', new Boolean(true)]) {
      assert.throws(
        () => renderer[method](invalid),
        /boolean/i,
      );
    }
    assert.equal(pointCountReads, 0);
    assert.equal(renderer[flag], false);
  });
}

test('adaptive LOD preparation failure preserves every published semantic and ownership identity', () => {
  const fixture = makeToggleRenderer();
  const failure = new Error('injected LOD preparation failure');
  fixture.renderer._prepareSpatialIndicesForFeature = needsLOD => {
    assert.equal(needsLOD, true);
    assert.equal(fixture.renderer.useAdaptiveLOD, false);
    throw failure;
  };

  assert.throws(
    () => fixture.renderer.setAdaptiveLOD(true),
    error => error === failure,
  );
  assert.equal(fixture.renderer.useAdaptiveLOD, false);
  assert.equal(fixture.renderer.forceLODLevel, 4);
  assert.strictEqual(fixture.renderer.stats, fixture.stats);
  assert.deepEqual(fixture.renderer.stats, {
    lastFrameTime: 4,
    fps: 250,
    visiblePoints: 7,
    lodLevel: 2,
    gpuMemoryMB: 3,
    drawCalls: 1,
    frustumCulled: true,
    cullPercent: 30,
  });
  assert.strictEqual(fixture.renderer._perViewState, fixture.perViewState);
  assert.strictEqual(
    fixture.renderer._perViewState.get('live'),
    fixture.viewState,
  );
  assert.equal(fixture.viewState.statsPublished, true);
  assert.strictEqual(fixture.renderer.spatialIndices, fixture.spatialIndices);
  assert.strictEqual(
    fixture.renderer.spatialIndices.get(1),
    fixture.unrelatedSpatial,
  );
  assert.strictEqual(
    fixture.renderer.lodBuffersByDimension,
    fixture.lodBuffersByDimension,
  );
  assert.strictEqual(
    fixture.renderer.lodBuffersByDimension.get(1),
    fixture.unrelatedLod,
  );
  assert.strictEqual(
    fixture.renderer._lodIndexTexturesByDimension,
    fixture.lodIndexTextures,
  );
  assert.strictEqual(
    fixture.renderer._lodIndexTexturesByDimension.get(1),
    fixture.unrelatedTextures,
  );
  assert.strictEqual(
    fixture.renderer._lodResourceOwnersByDimension,
    fixture.lodOwners,
  );
  assert.strictEqual(
    fixture.renderer._lodResourceOwnersByDimension.get(1),
    fixture.unrelatedOwner,
  );
});

test('frustum preparation failure preserves flags, statistics, and reusable view owners', () => {
  const fixture = makeToggleRenderer({ forceLODLevel: -1 });
  const failure = new Error('injected frustum preparation failure');
  fixture.renderer._prepareSpatialIndicesForFeature = needsLOD => {
    assert.equal(needsLOD, false);
    assert.equal(fixture.renderer.useFrustumCulling, false);
    throw failure;
  };
  const indexBuffer = fixture.viewState.indexBuffer;
  const visibleIndicesBuffer = fixture.viewState.visibleIndicesBuffer;

  assert.throws(
    () => fixture.renderer.setFrustumCulling(true),
    error => error === failure,
  );
  assert.equal(fixture.renderer.useFrustumCulling, false);
  assert.equal(fixture.renderer.forceLODLevel, -1);
  assert.strictEqual(fixture.renderer.stats, fixture.stats);
  assert.equal(fixture.renderer.stats.frustumCulled, true);
  assert.equal(fixture.renderer.stats.cullPercent, 30);
  assert.strictEqual(
    fixture.renderer._perViewState.get('live'),
    fixture.viewState,
  );
  assert.strictEqual(fixture.viewState.indexBuffer, indexBuffer);
  assert.strictEqual(
    fixture.viewState.visibleIndicesBuffer,
    visibleIndicesBuffer,
  );
  assert.equal(fixture.viewState.statsPublished, true);
});

test('a later live dimension failure cannot publish an earlier staged LOD generation', () => {
  const fixture = makeToggleRenderer();
  const positions = fixture.renderer._positions;
  const live3d = {
    positions,
    dimensionLevel: 3,
    pointCount: 1,
    lodLevels: [{ isFullDetail: true }],
  };
  const live2d = {
    positions,
    dimensionLevel: 2,
    pointCount: 1,
    lodLevels: [{ isFullDetail: true }],
  };
  const acceptedSpatialIndices = new Map([
    [3, live3d],
    [2, live2d],
  ]);
  const acceptedOwners = fixture.renderer._lodResourceOwnersByDimension;
  const acceptedBuffers = fixture.renderer.lodBuffersByDimension;
  const acceptedTextures =
    fixture.renderer._lodIndexTexturesByDimension;
  const stagedOwner = { id: 'staged-3d-owner' };
  const stagedBuffers = [{ id: 'staged-3d-buffers' }];
  const stagedTextures = [{ id: 'staged-3d-textures' }];
  const failure = new Error('injected second-dimension failure');
  const queuedRetirements = [];

  fixture.renderer.spatialIndices = acceptedSpatialIndices;
  fixture.renderer.snapshotBuffers = new Map([
    ['live-backed-2d', {
      dimensionLevel: 2,
    }],
  ]);
  fixture.renderer._snapshotUsesLiveGeometry = () => true;
  fixture.renderer._ensureLodResourcesForDimension = (
    dimensionLevel,
    spatialIndex,
    deferPublication,
  ) => {
    assert.equal(deferPublication, true);
    if (dimensionLevel === 2) throw failure;
    assert.strictEqual(spatialIndex, live3d);
    return {
      dimensionLevel,
      spatialIndex,
      candidateOwner: stagedOwner,
      candidateLodBuffers: stagedBuffers,
      candidateIndexTextures: stagedTextures,
      previousOwner: null,
      previousLodBuffers: null,
      previousIndexTextures: null,
    };
  };
  fixture.renderer._queueDataRetirement = retirement => {
    queuedRetirements.push(retirement);
  };
  fixture.renderer._drainDataRetirements = () => [];

  assert.throws(
    () => fixture.renderer._prepareSpatialIndicesForFeature(true),
    error => error === failure,
  );
  assert.strictEqual(
    fixture.renderer.spatialIndices,
    acceptedSpatialIndices,
  );
  assert.strictEqual(
    fixture.renderer._lodResourceOwnersByDimension,
    acceptedOwners,
  );
  assert.strictEqual(
    fixture.renderer.lodBuffersByDimension,
    acceptedBuffers,
  );
  assert.strictEqual(
    fixture.renderer._lodIndexTexturesByDimension,
    acceptedTextures,
  );
  assert.equal(queuedRetirements.length, 1);
  assert.strictEqual(
    queuedRetirements[0].lodResourceOwnersByDimension.get(3),
    stagedOwner,
  );
});

test('feature toggles are idempotent before preparation, retirement, or cache invalidation', () => {
  const adaptive = makeToggleRenderer({ adaptiveLOD: true });
  const frustum = makeToggleRenderer({ frustumCulling: false });
  for (const [fixture, method, value] of [
    [adaptive, 'setAdaptiveLOD', true],
    [frustum, 'setFrustumCulling', false],
  ]) {
    let preparations = 0;
    let invalidations = 0;
    fixture.renderer._prepareSpatialIndicesForFeature = () => {
      preparations += 1;
    };
    fixture.renderer._invalidateViewStateRecord = () => {
      invalidations += 1;
    };
    fixture.renderer.clearAllViewState = () => {
      throw new Error('idempotent toggle must not retire view owners');
    };
    fixture.renderer[method](value);
    assert.equal(preparations, 0);
    assert.equal(invalidations, 0);
    assert.strictEqual(
      fixture.renderer._perViewState.get('live'),
      fixture.viewState,
    );
  }
});

test('successful toggles invalidate semantics in place without retiring EBO or scratch owners', () => {
  const fixture = makeToggleRenderer({ pointCount: 0 });
  const indexBuffer = fixture.viewState.indexBuffer;
  const visibleIndicesBuffer = fixture.viewState.visibleIndicesBuffer;
  const visibleLodIndicesBuffer =
    fixture.viewState.visibleLodIndicesBuffer;
  const frustumPlanes = fixture.viewState.frustumPlanes;
  fixture.renderer.clearAllViewState = () => {
    throw new Error('feature toggles must not retire view state');
  };

  fixture.renderer.setAdaptiveLOD(true);
  assert.equal(fixture.renderer.useAdaptiveLOD, true);
  assert.strictEqual(
    fixture.renderer._perViewState.get('live'),
    fixture.viewState,
  );
  assert.strictEqual(fixture.viewState.indexBuffer, indexBuffer);
  assert.strictEqual(
    fixture.viewState.visibleIndicesBuffer,
    visibleIndicesBuffer,
  );
  assert.strictEqual(
    fixture.viewState.visibleLodIndicesBuffer,
    visibleLodIndicesBuffer,
  );
  assert.strictEqual(fixture.viewState.frustumPlanes, frustumPlanes);
  assert.equal(fixture.viewState.statsPublished, false);

  fixture.renderer.setFrustumCulling(true);
  assert.equal(fixture.renderer.useFrustumCulling, true);
  assert.strictEqual(
    fixture.renderer._perViewState.get('live'),
    fixture.viewState,
  );
  assert.strictEqual(fixture.viewState.indexBuffer, indexBuffer);
  assert.equal(fixture.renderer.stats.frustumCulled, false);
  assert.equal(fixture.renderer.stats.cullPercent, 0);
});

test('bottleneck CPU phase analysis restores exact public renderer state after failure', async () => {
  const failure = new Error('injected measurement failure');
  const calls = [];
  const renderer = {
    useAdaptiveLOD: true,
    useFrustumCulling: false,
    activeQuality: 'light',
    forceLODLevel: 2,
    setAdaptiveLOD(value) {
      calls.push(['lod', value]);
      this.useAdaptiveLOD = value;
      if (!value) this.forceLODLevel = -1;
    },
    setFrustumCulling(value) {
      calls.push(['frustum', value]);
      this.useFrustumCulling = value;
    },
    setQuality(value) {
      calls.push(['quality', value]);
      this.activeQuality = value;
    },
    setForceLOD(value) {
      calls.push(['force', value]);
      this.forceLODLevel = value;
    },
  };
  const analyzer = Object.assign(
    Object.create(BottleneckAnalyzer.prototype),
    {
      renderer,
      _getDefaultRenderParams() {
        return {};
      },
      async _measureFrameTimes() {
        if (calls.some(([kind, value]) => (
          kind === 'frustum' && value === true
        ))) {
          throw failure;
        }
        return [1, 2, 3];
      },
    },
  );

  await assert.rejects(
    analyzer._runCPUPhaseAnalysis({ testFrames: 24 }),
    error => error === failure,
  );
  assert.equal(renderer.useAdaptiveLOD, true);
  assert.equal(renderer.useFrustumCulling, false);
  assert.equal(renderer.activeQuality, 'light');
  assert.equal(renderer.forceLODLevel, 2);
  assert.deepEqual(calls.slice(-4), [
    ['lod', true],
    ['force', 2],
    ['frustum', false],
    ['quality', 'light'],
  ]);
});

test('bottleneck CPU phases measure exact shader labels and restore forced LOD after adaptive toggles', async () => {
  const calls = [];
  const samples = [];
  const renderer = {
    useAdaptiveLOD: true,
    useFrustumCulling: false,
    activeQuality: 'light',
    forceLODLevel: 3,
    setAdaptiveLOD(value) {
      calls.push(['lod', value]);
      this.useAdaptiveLOD = value;
      if (!value) this.forceLODLevel = -1;
    },
    setForceLOD(value) {
      calls.push(['force', value]);
      this.forceLODLevel = value;
    },
    setFrustumCulling(value) {
      calls.push(['frustum', value]);
      this.useFrustumCulling = value;
    },
    setQuality(value) {
      calls.push(['quality', value]);
      this.activeQuality = value;
    },
  };
  const analyzer = Object.assign(
    Object.create(BottleneckAnalyzer.prototype),
    {
      renderer,
      _getDefaultRenderParams() {
        return { quality: 'full' };
      },
      async _measureFrameTimes(_frames, renderParams) {
        samples.push({
          activeQuality: renderer.activeQuality,
          renderQuality: renderParams.quality,
        });
        return [1, 2, 3];
      },
    },
  );

  await analyzer._runCPUPhaseAnalysis({ testFrames: 24 });

  assert.deepEqual(
    samples.slice(0, 4),
    Array.from(
      { length: 4 },
      () => ({
        activeQuality: 'light',
        renderQuality: 'light',
      }),
    ),
    'LOD/frustum phases must retain the original shader quality',
  );
  assert.deepEqual(samples.slice(4), [
    { activeQuality: 'ultralight', renderQuality: 'ultralight' },
    { activeQuality: 'light', renderQuality: 'light' },
    { activeQuality: 'full', renderQuality: 'full' },
  ]);
  assert.equal(renderer.useAdaptiveLOD, true);
  assert.equal(renderer.forceLODLevel, 3);
  assert.equal(renderer.useFrustumCulling, false);
  assert.equal(renderer.activeQuality, 'light');
  assert.deepEqual(calls.slice(-4), [
    ['lod', true],
    ['force', 3],
    ['frustum', false],
    ['quality', 'light'],
  ]);
});

test('benchmark forced LOD publication validates before mutating configuration', () => {
  const benchmark = new HighPerfBenchmark({});
  const calls = [];
  benchmark.config.forceLODLevel = 1;
  benchmark.renderer = {
    setForceLOD(level) {
      calls.push(level);
      if (level === 4) {
        throw new RangeError('synthetic unavailable LOD');
      }
    },
  };

  assert.throws(
    () => benchmark.setForceLODLevel(1.5),
    /integer/,
  );
  assert.throws(
    () => benchmark.setForceLODLevel(-2),
    /-1 or greater/,
  );
  assert.deepEqual(calls, []);
  assert.equal(benchmark.config.forceLODLevel, 1);
  assert.throws(
    () => benchmark.setForceLODLevel(4),
    /synthetic unavailable LOD/,
  );
  assert.equal(benchmark.config.forceLODLevel, 1);
  benchmark.setForceLODLevel(2);
  assert.equal(benchmark.config.forceLODLevel, 2);
  assert.deepEqual(calls, [4, 2]);
});

test('benchmark shader quality validates and publishes only after renderer acceptance', () => {
  const benchmark = new HighPerfBenchmark({});
  const calls = [];
  benchmark.config.shaderQuality = 'light';
  benchmark.renderer = {
    setQuality(quality) {
      calls.push(quality);
      if (quality === 'ultralight') {
        throw new Error('synthetic unavailable shader');
      }
    },
  };

  for (const invalid of [
    undefined,
    null,
    '',
    'medium',
    new String('full'),
  ]) {
    assert.throws(
      () => benchmark.setShaderQuality(invalid),
      /exactly "full", "light", or "ultralight"/,
    );
  }
  assert.deepEqual(calls, []);
  assert.equal(benchmark.config.shaderQuality, 'light');
  assert.throws(
    () => benchmark.setShaderQuality('ultralight'),
    /synthetic unavailable shader/,
  );
  assert.equal(benchmark.config.shaderQuality, 'light');
  benchmark.setShaderQuality('full');
  assert.equal(benchmark.config.shaderQuality, 'full');
  assert.deepEqual(calls, ['ultralight', 'full']);
});

test('bottleneck RAF render failure rejects and restores exact renderer state', async () => {
  const failure = new Error('synthetic render-contract failure');
  const calls = [];
  const renderer = {
    useAdaptiveLOD: true,
    useFrustumCulling: false,
    activeQuality: 'light',
    forceLODLevel: 2,
    setAdaptiveLOD(value) {
      calls.push(['lod', value]);
      this.useAdaptiveLOD = value;
      if (!value) this.forceLODLevel = -1;
    },
    setForceLOD(value) {
      calls.push(['force', value]);
      this.forceLODLevel = value;
    },
    setFrustumCulling(value) {
      calls.push(['frustum', value]);
      this.useFrustumCulling = value;
    },
    setQuality(value) {
      calls.push(['quality', value]);
      this.activeQuality = value;
    },
    render() {
      throw failure;
    },
  };
  const analyzer = Object.assign(
    Object.create(BottleneckAnalyzer.prototype),
    {
      renderer,
      _getDefaultRenderParams() {
        return { quality: 'full' };
      },
    },
  );
  const rafDescriptor =
    Object.getOwnPropertyDescriptor(
      globalThis,
      'requestAnimationFrame',
    );
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value(callback) {
      queueMicrotask(callback);
      return 1;
    },
    writable: true,
  });
  try {
    await assert.rejects(
      analyzer._runCPUPhaseAnalysis({ testFrames: 4 }),
      error => error === failure,
    );
  } finally {
    if (rafDescriptor === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      Object.defineProperty(
        globalThis,
        'requestAnimationFrame',
        rafDescriptor,
      );
    }
  }

  assert.equal(renderer.useAdaptiveLOD, true);
  assert.equal(renderer.forceLODLevel, 2);
  assert.equal(renderer.useFrustumCulling, false);
  assert.equal(renderer.activeQuality, 'light');
  assert.deepEqual(calls.slice(-4), [
    ['lod', true],
    ['force', 2],
    ['frustum', false],
    ['quality', 'light'],
  ]);
});

test('bottleneck frame sampler rejects synchronous scheduling failures', async () => {
  const failure = new Error('synthetic RAF scheduling failure');
  let renderCalls = 0;
  const analyzer = Object.assign(
    Object.create(BottleneckAnalyzer.prototype),
    {
      renderer: {
        render() {
          renderCalls += 1;
        },
      },
    },
  );
  const rafDescriptor =
    Object.getOwnPropertyDescriptor(
      globalThis,
      'requestAnimationFrame',
    );
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value() {
      throw failure;
    },
    writable: true,
  });
  try {
    await assert.rejects(
      analyzer._measureFrameTimes(1, {}),
      error => error === failure,
    );
  } finally {
    if (rafDescriptor === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      Object.defineProperty(
        globalThis,
        'requestAnimationFrame',
        rafDescriptor,
      );
    }
  }
  assert.equal(renderCalls, 0);
});

test('bottleneck default render parameters satisfy the exact renderer contract', () => {
  const analyzer = Object.assign(
    Object.create(BottleneckAnalyzer.prototype),
    {
      gl: { canvas: { height: 480, width: 640 } },
      renderer: { activeQuality: 'light' },
    },
  );
  const params = analyzer._getDefaultRenderParams();
  assert.equal(params.quality, 'light');
  assert.equal(params.viewId, 'benchmark');
  assert.equal(params.useAlphaTexture, false);
  assert.equal(params.autoFog, true);
  assert.equal(params.overrideBounds, null);
  assert.equal(params.viewportWidth, 640);
  assert.equal(params.viewportHeight, 480);
});

test('renderer control source keeps UI controls coherent when synchronous preparation rejects', async () => {
  const mainSource = await readFile(
    new URL('../assets/js/app/main.js', import.meta.url),
    'utf8',
  );
  const controlsStart = mainSource.indexOf(
    '    // Frustum culling toggle',
  );
  const controlsEnd = mainSource.indexOf(
    '    if (benchmarkSection)',
    controlsStart,
  );
  assert.notEqual(controlsStart, -1);
  assert.notEqual(controlsEnd, -1);
  const controls = mainSource.slice(controlsStart, controlsEnd);

  assert.match(
    controls,
    /hpFrustumCulling\.checked\s*=\s*previousEnabled/,
  );
  assert.match(
    controls,
    /hpLodEnabled\.checked\s*=\s*previousEnabled/,
  );
  assert.match(
    controls,
    /hpLodForceContainer\.style\.display\s*=\s*previousForceDisplay/,
  );
  assert.match(
    controls,
    /hpLodForce\.value\s*=\s*previousForceValue/,
  );
  assert.match(
    mainSource,
    /notifications\.error\(/,
  );
});

test('render paths do not deep-verify one live LOD generation twice per frame', async () => {
  const rendererSource = await readFile(
    new URL(
      '../assets/js/rendering/high-perf-renderer.js',
      import.meta.url,
    ),
    'utf8',
  );
  const renderStart = rendererSource.indexOf('  render(params');
  const renderEnd = rendererSource.indexOf(
    '  _renderFullDetail(',
    renderStart,
  );
  assert.notEqual(renderStart, -1);
  assert.notEqual(renderEnd, -1);
  const render = rendererSource.slice(renderStart, renderEnd);
  assert.doesNotMatch(
    render,
    /this\._ensureLodResourcesForDimension\(/,
  );

  const snapshotStart = rendererSource.indexOf(
    '  renderWithSnapshot(id, params',
  );
  const snapshotEnd = rendererSource.indexOf(
    '  _renderSnapshotWithFrustumCulling(',
    snapshotStart,
  );
  assert.notEqual(snapshotStart, -1);
  assert.notEqual(snapshotEnd, -1);
  const snapshotRender = rendererSource.slice(
    snapshotStart,
    snapshotEnd,
  );
  assert.doesNotMatch(
    snapshotRender,
    /this\._ensureLodResourcesForDimension\(/,
  );
});

test('context loss terminally detaches all ownership without touching WebGL and makes dispose silent', () => {
  let glObservations = 0;
  const hostileGl = new Proxy({}, {
    get() {
      glObservations += 1;
      throw new Error('lost WebGL context must not be observed');
    },
  });
  const fixture = makeToggleRenderer({
    adaptiveLOD: true,
    frustumCulling: true,
  });
  const renderer = fixture.renderer;
  renderer.gl = hostileGl;
  renderer.programs = {
    full: Object.freeze({ id: 'full-program' }),
    light: Object.freeze({ id: 'light-program' }),
    ultralight: Object.freeze({ id: 'ultralight-program' }),
  };
  renderer.activeProgram = renderer.programs.full;
  renderer.uniformLocations = new Map([['full', {}]]);
  renderer.vao = Object.freeze({ id: 'vao' });
  renderer.buffers = {
    interleaved: Object.freeze({ id: 'point-buffer' }),
    positions: null,
    colors: null,
    alphas: null,
  };
  renderer._alphaTexture = Object.freeze({ id: 'alpha-texture' });
  renderer._dummyLodIndexTexture =
    Object.freeze({ id: 'dummy-texture' });
  renderer.snapshotBuffers.set('snapshot', {
    vao: Object.freeze({ id: 'snapshot-vao' }),
  });
  renderer._snapshotGeometryPools.set(2, {
    positions: new Float32Array(3),
    spatialIndices: new Map(),
  });
  renderer._pendingSnapshotRetirements =
    new Set([{ id: 'snapshot-retirement' }]);
  renderer._pendingDataRetirements =
    new Set([{ id: 'data-retirement' }]);
  renderer._pendingProgramRetirements =
    new Set([{ id: 'program-retirement' }]);
  renderer._pendingShaderRetirements =
    new Set([{ id: 'shader-retirement' }]);
  renderer._pendingProgramUnbind = true;

  assert.equal(renderer.handleContextLost(), true);
  assert.equal(renderer.handleContextLost(), false);
  assert.equal(glObservations, 0);
  assert.equal(renderer.gl, null);
  assert.equal(renderer.activeProgram, null);
  assert.equal(renderer.vao, null);
  assert.equal(renderer.buffers.interleaved, null);
  assert.equal(renderer._alphaTexture, null);
  assert.equal(renderer._dummyLodIndexTexture, null);
  assert.equal(renderer.spatialIndices.size, 0);
  assert.equal(renderer.lodBuffersByDimension.size, 0);
  assert.equal(renderer._lodResourceOwnersByDimension.size, 0);
  assert.equal(renderer._lodIndexTexturesByDimension.size, 0);
  assert.equal(renderer.snapshotBuffers.size, 0);
  assert.equal(renderer._snapshotGeometryPools.size, 0);
  assert.equal(renderer._perViewState.size, 0);
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  assert.equal(renderer._pendingDataRetirements.size, 0);
  assert.equal(renderer._pendingProgramRetirements.size, 0);
  assert.equal(renderer._pendingShaderRetirements.size, 0);
  assert.equal(renderer.pointCount, 0);
  assert.equal(renderer.getPositions(), null);
  assert.throws(
    () => renderer.render({}),
    error => (
      error?.name === 'HighPerfRendererContextLostError' &&
      /context was lost/i.test(error.message)
    ),
  );
  assert.throws(
    () => renderer.setAdaptiveLOD(true),
    error => error?.name === 'HighPerfRendererContextLostError',
  );

  renderer.dispose();
  renderer.dispose();
  assert.equal(renderer._disposed, true);
  assert.equal(glObservations, 0);
});
