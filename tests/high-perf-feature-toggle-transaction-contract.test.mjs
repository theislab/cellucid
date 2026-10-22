import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { isContextLostError } from '../assets/js/rendering/gl-errors.js';
import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';
import {
  BottleneckAnalyzer,
} from '../assets/js/dev/benchmark.js';

function makeViewState() {
  return {
    lastFrustumMVP: new Float32Array(16),
    // The cull state's reusable scratch: leaf runs and draw ranges.
    cull: {
      tree: { id: 'spatial-owner' },
      drawOrder: { id: 'draw-order' },
      runs: new Uint32Array(256),
      runCount: 3,
      gaps: new Uint32Array(0),
      stack: [],
      band: 2,
      starts: new Int32Array(256),
      counts: new Int32Array(256),
      rangeCount: 4,
      elementCount: 7,
    },
    lastDimensionLevel: 3,
    lastLodLevel: 2,
    prevLodLevel: 2,
    frustumPlanes: Array.from(
      { length: 6 },
      () => new Float32Array(4),
    ),
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
  const liveOrder = Object.freeze({ id: 'live-draw-order' });
  const spatialIndices = new Map([[1, unrelatedSpatial]]);
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
      _liveOrder: liveOrder,
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
    liveOrder,
    unrelatedSpatial,
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

test('turning LOD or culling on builds nothing on the main thread', () => {
  for (const method of ['setAdaptiveLOD', 'setFrustumCulling']) {
    const fixture = makeToggleRenderer({ pointCount: 50_000, forceLODLevel: -1 });
    fixture.renderer._invalidateViewStateRecord = () => {};
    const build = fixture.renderer._getOrBuildSpatialIndexForDimension;
    fixture.renderer._getOrBuildSpatialIndexForDimension = () => assert.fail(`${method} must not build a tree`);
    fixture.renderer._requestSpatialIndex = () => assert.fail(`${method} must not even request one: the next frame does`);
    fixture.renderer[method](true);
    fixture.renderer._getOrBuildSpatialIndexForDimension = build;
    assert.strictEqual(fixture.renderer.spatialIndices, fixture.spatialIndices);
    assert.strictEqual(fixture.renderer.spatialIndices.get(1), fixture.unrelatedSpatial);
    // The live store keeps the draw order it holds until a tree lands.
    assert.strictEqual(fixture.renderer._liveOrder, fixture.liveOrder);
  }
});

test('feature toggles are idempotent before retirement or cache invalidation', () => {
  const adaptive = makeToggleRenderer({ adaptiveLOD: true });
  const frustum = makeToggleRenderer({ frustumCulling: false });
  for (const [fixture, method, value] of [
    [adaptive, 'setAdaptiveLOD', true],
    [frustum, 'setFrustumCulling', false],
  ]) {
    let invalidations = 0;
    fixture.renderer._invalidateViewStateRecord = () => {
      invalidations += 1;
    };
    fixture.renderer.clearAllViewState = () => {
      throw new Error('idempotent toggle must not retire view owners');
    };
    fixture.renderer[method](value);
    assert.equal(invalidations, 0);
    assert.strictEqual(
      fixture.renderer._perViewState.get('live'),
      fixture.viewState,
    );
  }
});

test('successful toggles invalidate semantics in place, keeping the cull scratch', () => {
  const fixture = makeToggleRenderer({ pointCount: 0 });
  const cull = fixture.viewState.cull;
  const runs = cull.runs;
  const starts = cull.starts;
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
  // Keys dropped, scratch kept: the next frame re-culls into the same arrays.
  assert.strictEqual(fixture.viewState.cull, cull);
  assert.strictEqual(cull.runs, runs);
  assert.strictEqual(cull.starts, starts);
  assert.equal(cull.tree, null);
  assert.equal(cull.drawOrder, null);
  assert.equal(cull.band, -1);
  assert.equal(cull.rangeCount, 0);
  assert.strictEqual(fixture.viewState.frustumPlanes, frustumPlanes);
  assert.equal(fixture.viewState.lastFrustumMVP, null);
  assert.equal(fixture.viewState.statsPublished, false);

  fixture.renderer.setFrustumCulling(true);
  assert.equal(fixture.renderer.useFrustumCulling, true);
  assert.strictEqual(
    fixture.renderer._perViewState.get('live'),
    fixture.viewState,
  );
  assert.strictEqual(fixture.viewState.cull, cull);
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
  // Quality is absent from the restore list because the analysis never changes
  // it (CEL-0235); restoring something untouched would be dead code that hides
  // a future arm reintroducing the perturbation.
  assert.deepEqual(calls.slice(-3), [
    ['lod', true],
    ['force', 2],
    ['frustum', false],
  ]);
  assert.ok(!calls.some(([name]) => name === 'quality'));
});

test('bottleneck CPU phases never disturb shader quality and restore forced LOD after adaptive toggles', async () => {
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

  const phases = await analyzer._runCPUPhaseAnalysis({ testFrames: 24 });

  // Every arm runs at the quality the user already chose. The shader-quality
  // sweep was removed with CEL-0235: this harness times the interval between
  // `requestAnimationFrame` callbacks, which cannot resolve a fragment-shader
  // difference in either direction, and the three qualities measure the same
  // on instrumentation that can. Switching quality to time it only perturbed
  // what was on screen.
  assert.deepEqual(
    samples,
    Array.from(
      { length: 4 },
      () => ({
        activeQuality: 'light',
        renderQuality: 'light',
      }),
    ),
    'every CPU phase arm must retain the original shader quality',
  );
  assert.equal(
    phases.shaderComplexity,
    undefined,
    'no shader-quality phase result may survive',
  );
  assert.equal(phases.shaderQuality, undefined);
  assert.ok(
    !calls.some(([name]) => name === 'quality'),
    `setQuality must never be called; got ${JSON.stringify(calls)}`,
  );
  assert.equal(renderer.useAdaptiveLOD, true);
  assert.equal(renderer.forceLODLevel, 3);
  assert.equal(renderer.useFrustumCulling, false);
  assert.equal(renderer.activeQuality, 'light');
  assert.deepEqual(calls.slice(-3), [
    ['lod', true],
    ['force', 3],
    ['frustum', false],
  ]);
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
  assert.deepEqual(calls.slice(-3), [
    ['lod', true],
    ['force', 2],
    ['frustum', false],
  ]);
  assert.ok(!calls.some(([name]) => name === 'quality'));
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
      renderer: {
        activeQuality: 'light',
        getViewPositionDimension: viewId => {
          assert.equal(viewId, 'live');
          return 2;
        },
      },
    },
  );
  const params = analyzer._getDefaultRenderParams();
  assert.equal(params.quality, 'light');
  assert.equal(
    params.dimensionLevel,
    2,
    'the analyzer renders the live data in its own dimension',
  );
  assert.equal(params.viewId, 'benchmark');
  assert.equal(params.useAlphaTexture, false);
  assert.equal(params.autoFog, true);
  assert.equal(params.overrideBounds, null);
  assert.equal(params.viewportWidth, 640);
  assert.equal(params.viewportHeight, 480);
});

test('renderer control source keeps UI controls coherent when synchronous preparation rejects', async () => {
  // The renderer controls are owned by `ui/modules/render-controls`, not by the
  // bootstrap: a session is restored by dispatching each control's own event,
  // and their listeners have to already exist when that happens (CEL-0129).
  const controlsSource = await readFile(
    new URL(
      '../assets/js/app/ui/modules/render-controls.js',
      import.meta.url,
    ),
    'utf8',
  );
  const controlsStart = controlsSource.indexOf(
    '  listen(hpFrustumCullingCheckbox,',
  );
  const controlsEnd = controlsSource.indexOf(
    '\n  applyPointSizeFromSlider();\n  updateLightingStrength();',
    controlsStart,
  );
  assert.notEqual(controlsStart, -1);
  assert.notEqual(controlsEnd, -1);
  const controls = controlsSource.slice(controlsStart, controlsEnd);

  assert.match(
    controls,
    /hpFrustumCullingCheckbox\.checked\s*=\s*previousEnabled/,
  );
  assert.match(
    controls,
    /hpLodEnabledCheckbox\.checked\s*=\s*previousEnabled/,
  );
  assert.match(
    controls,
    /hpLodForceInput\.value\s*=\s*previousForcedValue/,
  );
  // The forced-LOD row and its readout are derived from the value the renderer
  // accepted rather than from a snapshot of whatever the markup happened to
  // show, so a rollback cannot restore a state the renderer never held.
  assert.equal(
    (controls.match(/\n\s*syncForcedLodUi\(\);/g) ?? []).length,
    4,
    'every forced-LOD outcome re-derives the row and readout',
  );
  assert.match(
    controlsSource,
    /getNotificationCenter\(\)\.error\(/,
  );
});

test('live and snapshot render paths reach the GPU through the one draw seam', async () => {
  const rendererSource = await readFile(
    new URL(
      '../assets/js/rendering/high-perf-renderer.js',
      import.meta.url,
    ),
    'utf8',
  );
  for (const [start, end] of [
    ['  render(params', '  _validateSpatialOwnerOnce('],
    ['  renderWithSnapshot(id, params', '\n  }\n'],
  ]) {
    const from = rendererSource.indexOf(start);
    assert.notEqual(from, -1, start);
    const to = rendererSource.indexOf(end, from + start.length);
    assert.notEqual(to, -1, end);
    const body = rendererSource.slice(from, to);
    // One `_drawPoints` call issues every draw; the pass itself never draws
    // or uploads.
    assert.equal(body.match(/this\._drawPoints\(/g)?.length, 1, start);
    assert.doesNotMatch(body, /\.draw(Arrays|Elements)\(|bufferData\(|bufferSubData\(/, start);
  }
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
    positions: Object.freeze({ id: 'point-position-buffer' }),
    colors: Object.freeze({ id: 'point-color-buffer' }),
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
  assert.equal(renderer.buffers.positions, null);
  assert.equal(renderer.buffers.colors, null);
  assert.equal(renderer._alphaTexture, null);
  assert.equal(renderer._dummyLodIndexTexture, null);
  assert.equal(renderer.spatialIndices.size, 0);
  assert.equal(renderer._liveOrder, null);
  assert.equal(renderer._liveColorOrder, null);
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
      isContextLostError(error) && /context was lost/i.test(error.message)
    ),
  );
  assert.throws(
    () => renderer.setAdaptiveLOD(true),
    error => isContextLostError(error),
  );

  renderer.dispose();
  renderer.dispose();
  assert.equal(renderer._disposed, true);
  assert.equal(glObservations, 0);
});
