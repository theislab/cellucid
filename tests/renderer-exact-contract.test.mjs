import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';
import { SpatialIndex } from '../assets/js/rendering/high-perf/spatial-index.js';
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
  DEFAULT_SYNTHETIC_SEED,
  GPUTimer,
  MeshSurfaceSampler,
  PerformanceTracker,
  SyntheticDataGenerator,
} from '../assets/js/dev/benchmark.js';
import { createCpuPermuter } from './helpers/cpu-permuter.mjs';

const renderingRoot = new URL('../assets/js/rendering/', import.meta.url);
const figureExportRoot = new URL(
  '../assets/js/app/ui/modules/figure-export/',
  import.meta.url
);

async function source(relativeUrl, root = renderingRoot) {
  return readFile(new URL(relativeUrl, root), 'utf8');
}

/**
 * Every source file the high-performance renderer is assembled from, so that a
 * "this pattern must not exist" assertion cannot be evaded by moving the code
 * into one of the renderer's own modules. Enumerates the directory rather than
 * naming files, so a module added later is covered without editing this test.
 */
async function highPerfRendererSources() {
  const moduleRoot = new URL('high-perf/', renderingRoot);
  const names = (await readdir(moduleRoot))
    .filter(name => name.endsWith('.js'))
    .sort();
  const parts = [await source('high-perf-renderer.js')];
  for (const name of names) {
    parts.push(await readFile(new URL(name, moduleRoot), 'utf8'));
  }
  return parts.join('\n');
}

test('spatial indices require an exact supported dimension contract', () => {
  const positions = Float32Array.from([0, 0, 0, 1, 1, 1]);
  const colors = Uint8Array.from([
    255, 0, 0, 255,
    0, 0, 255, 255,
  ]);
  const options = {
    buildLOD: false,
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
      sculpted: { id: 'sculpted' },
    },
    gl: {
      useProgram() {},
    },
  });
  assert.throws(
    () => renderer.setQuality('cinematic'),
    /quality.*full.*sculpted.*light.*ultralight/i
  );

  const highlight = Object.assign(Object.create(HighlightRenderer.prototype), {
    highlightStylesByQuality: {
      full: {},
      light: {},
      ultralight: {},
      sculpted: {},
    },
  });
  assert.throws(
    () => highlight.setQuality('cinematic'),
    /quality.*full.*sculpted.*light.*ultralight/i
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

test('per-view state is CPU state: creating it touches no WebGL object', () => {
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      gl: new Proxy({}, {
        get(_target, property) {
          throw new Error(`per-view state must not reach gl.${String(property)}`);
        },
      }),
      _perViewState: new Map(),
    },
  );

  const viewState = renderer._getViewState('cpu-only');
  assert.equal(renderer._perViewState.get('cpu-only'), viewState);
  // Culling keeps leaf runs and draw ranges, never per-point indices.
  assert.ok(viewState.cull.runs instanceof Uint32Array);
  assert.ok(viewState.cull.starts instanceof Int32Array);
  assert.equal(Object.hasOwn(viewState, 'indexBuffer'), false);
  renderer.clearViewState('cpu-only');
  assert.equal(renderer._perViewState.size, 0);
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

test('snapshot buffers publish owned bounds and adopt published positions without copying them', async () => {
  const rendererSource = await source('high-perf-renderer.js');
  assert.match(
    rendererSource,
    /snapshotBounds\s*=\s*HighPerfRenderer\.computeBoundsFromPositions\(\s*positions,\s*exactDimensionLevel\s*\)/
  );
  // A published positions array is never written after publication, so a
  // snapshot geometry is that array: a copy would duplicate every coordinate.
  assert.match(rendererSource, /positions:\s*sourcePositions,/);
  assert.doesNotMatch(
    rendererSource,
    /new Float32Array\(sourcePositions\)/
  );
  assert.match(rendererSource, /bounds:\s*snapshotBounds/);
  assert.doesNotMatch(
    rendererSource,
    /const customBounds = hasCustomPositions\s*\?\s*HighPerfRenderer\.computeBoundsFromPositions/
  );
});

test('high-performance data entry points do not clamp or default dimensions', async () => {
  const rendererSource = await highPerfRendererSources();

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
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    pointCount: 0,
    _alphaTexture: null,
    _alphaTexData: new Uint8Array(),
    _alphaTexWidth: 0,
    _alphaTexHeight: 0,
    _useAlphaTexture: false,
    _currentAlphas: null,
  });
  const alphas = new Uint8Array();

  renderer.updateAlphas(alphas);

  assert.equal(renderer.getCurrentAlphas(), alphas);
  assert.equal(renderer._useAlphaTexture, false);
  assert.equal(renderer._alphaTexture, null);
});

test('recoloring preserves the exact alpha generation through a position publication', () => {
  const alphas = Float32Array.from([0, 0.75]);
  const nextColors = Uint8Array.from([
    10, 20, 30, 255,
    40, 50, 60, 255,
  ]);
  // Another representation of the same two cells, in 2D.
  const nextPositions = Float32Array.from([
    -1, 0,
    1, 0,
  ]);
  let nextId = 1;
  const live = new Set();
  const deleted = [];
  const uploads = [];
  let bound = null;
  const gl = {
    ARRAY_BUFFER: 0x8892,
    FLOAT: 0x1406,
    NO_ERROR: 0,
    STATIC_DRAW: 0x88e4,
    UNSIGNED_BYTE: 0x1401,
    createBuffer() { const handle = { id: nextId++ }; live.add(handle); return handle; },
    createVertexArray() { const handle = { id: nextId++, vao: true }; live.add(handle); return handle; },
    bindBuffer(_target, buffer) { bound = buffer; },
    bindVertexArray() {},
    bufferData(_target, data) { uploads.push({ buffer: bound, data }); },
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    getError() { return 0; },
    deleteBuffer(handle) { live.delete(handle); deleted.push(handle); },
    deleteVertexArray(handle) { live.delete(handle); deleted.push(handle); },
    deleteTexture(handle) { live.delete(handle); deleted.push(handle); },
  };
  const colorBuffer = gl.createBuffer();
  const positionBuffer = gl.createBuffer();
  const vao = gl.createVertexArray();
  const alphaTexture = { id: 'alpha-texture' };
  const previousPositions = Float32Array.from([-1, 0, 0, 1, 0, 0]);
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    gl,
    pointCount: 2,
    vao,
    buffers: { positions: positionBuffer, colors: colorBuffer },
    _positionGpuByteLength: previousPositions.byteLength,
    _colorGpuByteLength: 8,
    _positions: previousPositions,
    currentDimensionLevel: 3,
    _liveGeometryGeneration: 1,
    _nextGeometryGeneration: 2,
    _colors: Uint8Array.from([
      1, 2, 3, 255,
      4, 5, 6, 255,
    ]),
    _currentAlphas: alphas,
    _alphaTexture: alphaTexture,
    _alphaTexWidth: 2,
    _alphaTexHeight: 1,
    _useAlphaTexture: true,
    _colorsDirty: false,
    _liveOrder: null,
    _liveColorOrder: null,
    spatialIndices: new Map(),
    _perViewState: new Map(),
    _snapshotGeometryPools: new Map(),
    _pendingDataRetirements: new Set(),
    _pendingSnapshotRetirements: new Set(),
    snapshotBuffers: new Map(),
    stats: { gpuMemoryMB: 0 },
    _needsSpatialIndex() {
      return false;
    },
    loadData() {
      assert.fail('a position publication keeps per-cell owners; it is not a dataset load');
    },
  });

  renderer.updateColors(nextColors);

  assert.strictEqual(renderer.getCurrentAlphas(), alphas);
  assert.equal(renderer.isAlphaTextureActive(), true);

  renderer.updatePositions(nextPositions, 2);

  // Colour, alpha and the pending recolor survive unchanged; only the
  // position stream is new.
  assert.strictEqual(renderer._colors, nextColors);
  assert.strictEqual(renderer.buffers.colors, colorBuffer);
  assert.strictEqual(renderer._alphaTexture, alphaTexture);
  assert.strictEqual(renderer.getCurrentAlphas(), alphas);
  assert.equal(renderer.isAlphaTextureActive(), true);
  assert.equal(renderer._colorsDirty, true, 'the deferred recolor upload is still pending');
  assert.strictEqual(renderer._positions, nextPositions);
  assert.equal(renderer.currentDimensionLevel, 2);
  assert.notEqual(renderer.buffers.positions, positionBuffer);
  assert.deepEqual(uploads.map(upload => upload.data), [nextPositions]);
  assert.equal(deleted.includes(colorBuffer), false);
  assert.equal(deleted.includes(alphaTexture), false);
  assert.equal(deleted.includes(vao), true);
  // The 3D geometry the live view left is retained for reuse.
  assert.equal(deleted.includes(positionBuffer), false);
  const retained = renderer._snapshotGeometryPools.get(1);
  assert.equal(retained.positions, previousPositions);
  assert.equal(retained.positionBuffer, positionBuffer);
  assert.equal(retained.refCount, 0);
});

test('a recolor is gathered into the live draw order once, at its flush, retrying after a refusal', () => {
  let boundBuffer = null;
  let rejectUpload = false;
  let getErrorCalls = 0;
  const uploads = [];
  const gl = {
    ARRAY_BUFFER: 0x8892,
    INVALID_OPERATION: 0x0502,
    NO_ERROR: 0,
    bindBuffer(target, buffer) {
      assert.equal(target, this.ARRAY_BUFFER);
      boundBuffer = buffer;
    },
    bufferData() {
      assert.fail('a recolor rewrites the accepted color store in place');
    },
    bufferSubData(target, offset, data, srcOffset, length) {
      assert.equal(target, this.ARRAY_BUFFER);
      assert.equal(offset, 0);
      assert.ok(data instanceof Uint32Array, 'gathered one RGBA8 word a point (the GPU pass, stood in for)');
      if (rejectUpload) {
        // A write into accepted storage fails synchronously or not at all.
        throw new TypeError('WebGL rejected the colour upload.');
      }
      const bytes = new Uint8Array(data.buffer, data.byteOffset + srcOffset * 4, length * 4);
      const rgba = [];
      for (let index = 0; index < length; index++) {
        rgba.push(Array.from(bytes.subarray(index * 4, index * 4 + 4)));
      }
      uploads.push({ buffer: boundBuffer, rgba });
    },
    getError() {
      getErrorCalls += 1;
      return this.NO_ERROR;
    },
    isContextLost: () => false,
  };
  const colors = Uint8Array.from([
    10, 11, 12, 13,
    20, 21, 22, 23,
    30, 31, 32, 33,
  ]);
  const drawOrder = Object.freeze({ indices: Uint32Array.from([2, 0, 1]), pointCount: 3 });
  const colorBuffer = { id: 'live-colors' };
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    gl,
    buffers: { colors: colorBuffer, positions: { id: 'live-positions' } },
    pointCount: 3,
    currentDimensionLevel: 3,
    _colorGpuByteLength: colors.byteLength,
    _colors: new Uint8Array(colors.length),
    _colorsDirty: false,
    _liveOrder: { drawOrder, texture: { id: 'live-order' }, width: 3, height: 1 },
    _liveColorOrder: drawOrder,
    spatialIndices: new Map(),
  });
  renderer._permuter = createCpuPermuter(gl);

  renderer.updateColors(colors);
  assert.equal(renderer._colorsDirty, true, 'the upload is deferred to the next render');
  assert.deepEqual(uploads, []);

  // A dimension the live view does not show has nothing to flush.
  renderer.flushBufferUpdates(2);
  assert.equal(renderer._colorsDirty, true);

  rejectUpload = true;
  assert.throws(() => renderer.flushBufferUpdates(3), /rejected the colour upload/);
  assert.equal(renderer._colorsDirty, true, 'a rejected upload stays dirty');
  assert.deepEqual(uploads, []);

  rejectUpload = false;
  renderer.flushBufferUpdates(3);
  assert.deepEqual(uploads, [{
    buffer: colorBuffer,
    rgba: [
      [30, 31, 32, 33],
      [10, 11, 12, 13],
      [20, 21, 22, 23],
    ],
  }]);
  assert.equal(renderer._colorsDirty, false);
  assert.strictEqual(renderer._liveColorOrder, drawOrder);

  // Already in order and clean: the next frame uploads nothing.
  renderer._ensureLiveColorsInOrder();
  assert.equal(uploads.length, 1);
  // Rewriting an accepted store reads no WebGL error back.
  assert.equal(getErrorCalls, 0);
});

test('full-detail recolor reads no error back, and a lost context refuses it before any upload', () => {
  let uploads = 0;
  let getErrorCalls = 0;
  let lost = true;
  const gl = {
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88e8,
    INVALID_OPERATION: 0x0502,
    NO_ERROR: 0,
    bindBuffer() {},
    bufferData() {
      uploads += 1;
    },
    bufferSubData() {
      uploads += 1;
    },
    getError() {
      getErrorCalls += 1;
      return this.NO_ERROR;
    },
    isContextLost: () => lost,
  };
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    gl,
    buffers: {
      colors: { id: 'full-detail-colors' },
      positions: { id: 'full-detail-positions' },
    },
    pointCount: 2,
    _liveOrder: null,
    _colorGpuByteLength: 8,
    _positions: Float32Array.from([
      -1, 0, 0,
      1, 0, 0,
    ]),
    _colors: Uint8Array.from([
      10, 11, 12, 13,
      20, 21, 22, 23,
    ]),
  });

  assert.throws(
    () => renderer._publishLiveColors(),
    error => error.name === 'WebGLContextLostError',
  );
  assert.equal(uploads, 0);
  lost = false;
  renderer._publishLiveColors();
  assert.equal(uploads, 1);
  assert.equal(getErrorCalls, 0);
});

test('a draw order adopted after a recolor gathers the latest renderer color generation', () => {
  // A GL double that keeps each buffer's bytes, so the test reads what the
  // live stores hold once the adoption is published, however it is staged.
  let nextId = 1;
  const bound = new Map();
  const stores = new Map();
  const gl = {
    ARRAY_BUFFER: 0x8892,
    CLAMP_TO_EDGE: 0x812f,
    COPY_READ_BUFFER: 0x8f36,
    COPY_WRITE_BUFFER: 0x8f37,
    DYNAMIC_DRAW: 0x88e8,
    MAX_TEXTURE_SIZE: 0x0d33,
    NEAREST: 0x2600,
    NO_ERROR: 0,
    R32UI: 0x8236,
    RED_INTEGER: 0x8d94,
    STATIC_DRAW: 0x88e4,
    TEXTURE_2D: 0x0de1,
    TEXTURE_2D_ARRAY: 0x8c1a,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    UNSIGNED_INT: 0x1405,
    bindBuffer(target, buffer) {
      bound.set(target, buffer);
    },
    bindTexture() {},
    bufferData(target, size) {
      stores.set(bound.get(target), new Uint8Array(size));
    },
    bufferSubData(target, offset, data, srcOffset = 0, length) {
      const count = length ?? data.length - srcOffset;
      const bytes = new Uint8Array(
        data.buffer,
        data.byteOffset + srcOffset * data.BYTES_PER_ELEMENT,
        count * data.BYTES_PER_ELEMENT,
      );
      stores.get(bound.get(target)).set(bytes, offset);
    },
    copyBufferSubData(readTarget, writeTarget, readOffset, writeOffset, size) {
      const from = stores.get(bound.get(readTarget));
      stores.get(bound.get(writeTarget)).set(from.subarray(readOffset, readOffset + size), writeOffset);
    },
    createBuffer() {
      return { id: nextId++ };
    },
    createTexture() {
      return { id: 'draw-order' };
    },
    deleteBuffer() {},
    deleteTexture() {},
    getError() {
      return this.NO_ERROR;
    },
    getParameter() {
      return 4096;
    },
    isBuffer() {
      return false;
    },
    isTexture() {
      return false;
    },
    texImage2D() {},
    texStorage2D() {},
    texParameteri() {},
    texSubImage2D() {},
    texStorage3D() {},
    texSubImage3D() {},
  };
  // A 2D embedding: two components per point.
  const positions = Float32Array.from([
    -1, 0,
    7, 8,
  ]);
  const positionBuffer = { id: 'main-positions' };
  const colorBuffer = { id: 'main-colors' };
  stores.set(positionBuffer, new Uint8Array(positions.byteLength));
  stores.set(colorBuffer, new Uint8Array(8));
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    gl,
    pointCount: 2,
    currentDimensionLevel: 2,
    buffers: { colors: colorBuffer, positions: positionBuffer },
    _colorGpuByteLength: 8,
    _colors: Uint8Array.from([
      10, 11, 12, 13,
      20, 21, 22, 23,
    ]),
    _colorsDirty: false,
    _liveOrder: null,
    _liveColorOrder: null,
    _positions: positions,
    _pendingDataRetirements: new Set(),
    _pendingSnapshotRetirements: new Set(),
    _snapshotGeometryPools: new Map(),
    snapshotBuffers: new Map(),
    spatialIndices: new Map(),
    stats: { gpuMemoryMB: 0 },
  });
  renderer._permuter = createCpuPermuter(gl);
  const drawOrder = Object.freeze({ indices: Uint32Array.from([1, 0]), pointCount: 2 });
  const tree = { ensureDrawOrder: () => drawOrder };

  renderer.updateColors(Uint8Array.from([
    50, 51, 52, 53,
    60, 61, 62, 63,
  ]));
  const record = renderer._ensureStoreDrawOrder({ kind: 'live' }, tree);
  renderer._ensureLiveColorsInOrder();

  assert.strictEqual(renderer._liveOrder, record);
  assert.strictEqual(record.drawOrder, drawOrder);
  assert.deepEqual(
    Array.from(new Float32Array(stores.get(positionBuffer).buffer)),
    [7, 8, -1, 0],
  );
  assert.deepEqual(
    Array.from(stores.get(colorBuffer)),
    [60, 61, 62, 63, 50, 51, 52, 53],
  );
  assert.strictEqual(renderer._liveColorOrder, drawOrder);
  assert.equal(renderer._colorsDirty, false);
});

test('high-performance rendering has no legacy alpha or global-view path', async () => {
  const rendererSource = await highPerfRendererSources();

  assert.doesNotMatch(
    rendererSource,
    /backwards compatibility|legacy fallback|global cache fallback/i
  );
  assert.doesNotMatch(
    rendererSource,
    /getLodVisibilityArray|getCombinedVisibilityForView|cachedLodVisibility/
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
    /getCombinedVisibilityForView|getLodVisibilityArray|PositionFingerprint/
  );
  assert.doesNotMatch(
    highlightSource,
    /viewPositions\s*\|\||String\(viewId\s*\|\|/
  );
});

test('highlight LOD synchronization calls one exact per-view renderer contract', () => {
  // A 2D view: two position components per point.
  const positions = Float32Array.from([0, 0]);
  const transparency = Uint8Array.from([1]);
  const highlightData = Uint8Array.from([255]);
  const membership = Object.freeze({
    admissionLevels: Uint8Array.from([0]),
    dimensionLevel: 2,
    generationToken: Object.freeze({}),
    indices: Uint32Array.from([0]),
    lodLevel: 0,
    pointCount: 1,
  });
  const calls = [];
  const tools = Object.assign(Object.create(HighlightTools.prototype), {
    highlightArray: highlightData,
    hpRenderer: {
      getViewGeometryGeneration(viewId) {
        calls.push(['geometry', viewId]);
        return 7;
      },
      getCurrentLodMembership(viewId, dimensionLevel) {
        calls.push(['membership', viewId, dimensionLevel]);
        return membership;
      },
    },
    highlightRenderer: {
      _highlightedIndicesCache: [0],
      updateHighlightCache(value) {
        calls.push(['highlight', value]);
      },
      needsRefresh: () => true,
      rebuildBuffer(...args) {
        calls.push(['rebuild', ...args]);
      },
    },
    _transparencyGenerations: new Map([['live', 3]]),
  });

  tools.syncHighlightBufferForLod(
    positions,
    'live',
    transparency,
    2
  );

  assert.deepEqual(calls[0], ['highlight', highlightData]);
  assert.deepEqual(calls[1], ['geometry', 'live']);
  assert.deepEqual(calls[2], ['membership', 'live', 2]);
  assert.equal(calls[3][0], 'rebuild');
  assert.equal(calls[3][3], membership);
  assert.equal(calls[3][4], 'live');
  assert.equal(calls[3][5], transparency);
  assert.equal(calls[3][6], 7);
  assert.equal(calls[3][7], 2);
  assert.equal(calls[3][8], 3);
});

test('highlight drawing forwards the stable per-view render-parameter owner without allocation', () => {
  const drawParams = {
    dimensionLevel: 2,
    mvpMatrix: new Float32Array(16),
    viewId: 'live',
  };
  const calls = [];
  const tools = Object.assign(Object.create(HighlightTools.prototype), {
    highlightRenderer: {
      draw(params) {
        calls.push(params);
      },
    },
  });

  tools.drawHighlights(drawParams);
  tools.drawHighlights(drawParams);

  assert.deepEqual(calls, [drawParams, drawParams]);
  assert.equal(calls[0], drawParams);
  assert.equal(calls[1], drawParams);
});

test('viewer isolates highlight synchronization and drawing before later render passes', async () => {
  const viewerSource = await source('viewer.js');
  const syncIndex = viewerSource.indexOf(
    'highlightTools.syncHighlightBufferForLod('
  );
  const drawIndex = viewerSource.indexOf(
    'highlightTools.drawHighlights(renderParams, timeSeconds)'
  );
  const laterPassIndex = viewerSource.indexOf(
    'drawConnectivityLines(\n      width,\n      height,\n      vid,\n      paneFogNear,\n      paneFogFar',
    drawIndex
  );
  const syncBoundaryIndex = viewerSource.indexOf(
    'reportHighlightRenderFailure(error, vid)',
    syncIndex
  );
  const drawBoundaryIndex = viewerSource.indexOf(
    'reportHighlightRenderFailure(error, vid)',
    syncBoundaryIndex + 1
  );

  assert.ok(syncIndex >= 0);
  assert.ok(syncBoundaryIndex > syncIndex);
  assert.ok(drawIndex > syncBoundaryIndex);
  assert.ok(drawBoundaryIndex > drawIndex);
  assert.ok(laterPassIndex > drawBoundaryIndex);
  assert.doesNotMatch(
    viewerSource,
    /highlightTools\.renderHighlights\(renderParams/
  );
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
      getViewTransparency: () => new Uint8Array(),
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

test('overlay retirement detaches before cleanup and remains retryable', () => {
  const manager = new OverlayManager({});
  let disposeAttempts = 0;
  const overlay = {
    id: 'retryable-overlay',
    priority: 0,
    enabled: true,
    visible: true,
    init() {},
    update() {},
    render() {},
    needsContinuousFrames() { return false; },
    dispose() {
      disposeAttempts += 1;
      if (disposeAttempts === 1) {
        throw new Error('synthetic overlay retirement failure');
      }
    },
  };
  manager.register(overlay);

  assert.throws(
    () => manager.unregister(overlay.id),
    /synthetic overlay retirement failure/
  );
  assert.equal(
    manager.get(overlay.id),
    null,
    'a half-retired overlay must never remain dispatchable'
  );
  assert.equal(manager.hasEnabledOverlays(), false);
  assert.throws(
    () => manager.register(overlay),
    /pending retirement/i,
    'the same retirement-pending instance cannot be republished'
  );
  assert.throws(
    () => manager.register({
      ...overlay,
      dispose() {},
    }),
    /prior owner.*pending retirement/i,
    'a logical ID cannot overlap its failed prior resource owner'
  );

  assert.equal(manager.retryRetirement(overlay.id), true);
  assert.equal(disposeAttempts, 2);
  assert.equal(manager.retryRetirement(overlay.id), false);
});

test('overlay manager disposal attempts every owner and retries only failures', () => {
  const manager = new OverlayManager({});
  const attempts = new Map();
  for (const id of ['first', 'second']) {
    manager.register({
      id,
      priority: 0,
      enabled: true,
      visible: true,
      init() {},
      update() {},
      render() {},
      needsContinuousFrames() { return false; },
      dispose() {
        const attempt = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, attempt);
        if (id === 'first' && attempt === 1) {
          throw new Error('synthetic first overlay failure');
        }
      },
    });
  }

  assert.throws(
    () => manager.dispose(),
    error => (
      error instanceof AggregateError
      && error.errors.some(item => /synthetic first overlay failure/.test(item.message))
    )
  );
  assert.equal(manager.get('first'), null);
  assert.equal(manager.get('second'), null);
  assert.deepEqual(Object.fromEntries(attempts), { first: 1, second: 1 });

  manager.dispose();
  assert.deepEqual(
    Object.fromEntries(attempts),
    { first: 2, second: 1 },
    'successful retirements must not be deleted twice'
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
      dimension: 3,
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
  // One backend: the figure-export worker's OffscreenCanvas, never a page
  // canvas beside it and never a CPU substitute.
  assert.doesNotMatch(
    rasterizerSource,
    /document\.createElement|HTMLCanvasElement|falling back to CPU|use flat circles/i
  );
  assert.match(rasterizerSource, /new OffscreenCanvas\(1, 1\)/);
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
    signal: new AbortController().signal,
    strategy: null,
    optimizedTargetCount: null,
    referenceGrid: null,
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
    /backward compatibility|legacy-compatible|legacy format|fall(?:s)? back|fallback|getExtension\(['"]EXT_disjoint_timer_query['"]\)|window\.(?:SyntheticDataGenerator|PerformanceTracker|BenchmarkReporter|BenchmarkExporter|BottleneckAnalyzer|startLiveMonitor|stopLiveMonitor|analyzeBottleneck|hideMetrics)/i
  );
  assert.doesNotMatch(
    benchmarkSource,
    /export\s+(?:class\s+HighPerfBenchmark|const\s+BenchmarkConfig)\b/
  );
  assert.doesNotMatch(
    benchmarkSource,
    /from '\.\.\/rendering\//
  );
  assert.doesNotMatch(
    benchmarkSource,
    /export\s+(?:class\s+BenchmarkExporter|\{\s*formatNumber\s*\})/
  );
});

test('synthetic generation is reproducible and varies only by declared seed', () => {
  assert.equal(SyntheticDataGenerator.seed, DEFAULT_SYNTHETIC_SEED);
  try {
    const first = SyntheticDataGenerator.uniformRandom(64);
    const second = SyntheticDataGenerator.uniformRandom(64);
    assert.deepEqual(first.positions, second.positions);
    assert.deepEqual(first.colors, second.colors);

    // A generator that consumes the stream before its main loop must still
    // restart it, or the previous call would leak into this one.
    const firstClusters = SyntheticDataGenerator.gaussianClusters(64);
    const secondClusters = SyntheticDataGenerator.gaussianClusters(64);
    assert.deepEqual(firstClusters.positions, secondClusters.positions);

    assert.equal(SyntheticDataGenerator.setSeed(DEFAULT_SYNTHETIC_SEED + 1),
      DEFAULT_SYNTHETIC_SEED + 1);
    const varied = SyntheticDataGenerator.uniformRandom(64);
    assert.notDeepEqual(varied.positions, first.positions);

    SyntheticDataGenerator.setSeed(DEFAULT_SYNTHETIC_SEED);
    assert.deepEqual(SyntheticDataGenerator.uniformRandom(64).positions,
      first.positions);

    for (const invalid of [undefined, null, 1.5, '1', NaN, Infinity]) {
      assert.throws(() => SyntheticDataGenerator.setSeed(invalid), /safe integer/);
    }
    assert.equal(SyntheticDataGenerator.seed, DEFAULT_SYNTHETIC_SEED);
  } finally {
    SyntheticDataGenerator.setSeed(DEFAULT_SYNTHETIC_SEED);
  }
});

test('GLB surface sampling writes exact caller-owned buffers', () => {
  const values = [0.5, 0.2, 0.3];
  const sampler = new MeshSurfaceSampler(
    Float32Array.from([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ]),
    null,
    () => values.shift()
  );
  const sampledPosition = new Float32Array(3);
  const sampledNormal = new Float32Array(3);
  sampler.sampleInto(
    sampledPosition,
    0,
    sampledNormal,
    0
  );

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
