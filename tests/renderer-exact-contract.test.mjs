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

test('per-view state rejects a null GPU index-buffer allocation before publication', () => {
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      gl: {
        createBuffer() {
          return null;
        },
      },
      _perViewState: new Map(),
    },
  );

  assert.throws(
    () => renderer._getViewState('allocation-failure'),
    /could not allocate.*per-view index buffer/i,
  );
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

test('snapshot buffers publish owned bounds before live position identity can change', async () => {
  const rendererSource = await source('high-perf-renderer.js');
  assert.match(
    rendererSource,
    /snapshotBounds\s*=\s*HighPerfRenderer\.computeBoundsFromPositions\(positions\)/
  );
  assert.match(
    rendererSource,
    /positions:\s*new Float32Array\(sourcePositions\)/
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
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    pointCount: 0,
    _alphaTexture: null,
    _alphaTexData: new Uint8Array(),
    _alphaTexWidth: 0,
    _alphaTexHeight: 0,
    _useAlphaTexture: false,
    _currentAlphas: null,
  });
  const alphas = new Float32Array();

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
  const nextPositions = Float32Array.from([
    -1, 0, 0,
    1, 0, 0,
  ]);
  let published = null;
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    pointCount: 2,
    _colors: Uint8Array.from([
      1, 2, 3, 255,
      4, 5, 6, 255,
    ]),
    _currentAlphas: alphas,
    _alphaTexture: { id: 'alpha-texture' },
    _alphaTexWidth: 2,
    _useAlphaTexture: true,
    _bufferDirty: false,
    _dirtyLodDimensions: new Set(),
    lodBuffersByDimension: new Map(),
    spatialIndices: new Map(),
    _needsSpatialIndex() {
      return false;
    },
    loadData(positions, colors, options) {
      published = { colors, options, positions };
    },
  });

  renderer.updateColors(nextColors);

  assert.strictEqual(renderer.getCurrentAlphas(), alphas);
  assert.equal(renderer.isAlphaTextureActive(), true);

  renderer.updatePositions(nextPositions, 3);

  assert.strictEqual(published.positions, nextPositions);
  assert.strictEqual(published.colors, nextColors);
  assert.strictEqual(published.options.alphaValues, alphas);
  assert.equal(published.options.dimensionLevel, 3);
});

test('a recolor flushes each resident dimension only when that dimension renders', () => {
  let boundBuffer = null;
  let rejectedBuffer = null;
  let webglError = 0;
  const uploads = [];
  const gl = {
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88e8,
    INVALID_OPERATION: 0x0502,
    NO_ERROR: 0,
    bindBuffer(target, buffer) {
      assert.equal(target, this.ARRAY_BUFFER);
      boundBuffer = buffer;
    },
    bufferData(target, data, usage) {
      assert.equal(target, this.ARRAY_BUFFER);
      assert.equal(usage, this.DYNAMIC_DRAW);
      if (boundBuffer === rejectedBuffer) {
        webglError = this.INVALID_OPERATION;
        return;
      }
      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(
          data.buffer,
          data.byteOffset,
          data.byteLength,
        );
      const floats = new Float32Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );
      const positions = [];
      const rgba = [];
      for (let index = 0; index < bytes.length / 16; index++) {
        positions.push(Array.from(floats.subarray(index * 4, index * 4 + 3)));
        const byteOffset = index * 16 + 12;
        rgba.push(Array.from(bytes.subarray(byteOffset, byteOffset + 4)));
      }
      uploads.push({ buffer: boundBuffer, positions, rgba });
    },
    getError() {
      const error = webglError;
      webglError = this.NO_ERROR;
      return error;
    },
  };
  const colors = Uint8Array.from([
    10, 11, 12, 13,
    20, 21, 22, 23,
    30, 31, 32, 33,
  ]);
  const makeLevel = indices => ({
    indices: Uint32Array.from(indices),
    isFullDetail: false,
    pointCount: indices.length,
  });
  const positions = Float32Array.from([
    2, 0, 0,
    0, 0, 1,
    -2, 0, 0,
  ]);
  const makeSpatialIndex = (dimensionLevel, indices) => {
    const reduced = makeLevel(indices);
    return {
      dimensionLevel,
      pointCount: 3,
      positions,
      lodLevels: [
        reduced,
        {
          isFullDetail: true,
          pointCount: 3,
          positions,
        },
      ],
    };
  };
  const buffer2d = { id: 'lod-2d' };
  const buffer3d = { id: 'lod-3d' };
  const vao2d = { id: 'vao-2d' };
  const vao3d = { id: 'vao-3d' };
  const ebo2d = { id: 'ebo-2d' };
  const ebo3d = { id: 'ebo-3d' };
  const spatial2d = makeSpatialIndex(2, [2, 0]);
  const spatial3d = makeSpatialIndex(3, [1]);
  const token2d = Object.freeze({});
  const token3d = Object.freeze({});
  const makeMetadata = (
    spatialIndex,
    buffer,
    vao,
    ebo,
    generationToken,
  ) => [
    {
      buffer,
      generationToken,
      isFullDetail: false,
      originalIndexBuffer: ebo,
      originalIndexCount:
        spatialIndex.lodLevels[0].pointCount,
      pointCount: spatialIndex.lodLevels[0].pointCount,
      vao,
    },
    {
      isFullDetail: true,
      originalIndexBuffer: null,
      originalIndexCount: 0,
      pointCount: 3,
    },
  ];
  const makeOwner = (
    spatialIndex,
    buffer,
    vao,
    ebo,
    generationToken,
  ) => ({
    compactBuffer: buffer,
    compactByteLength:
      spatialIndex.lodLevels[0].pointCount * 16,
    compactVao: vao,
    generationToken,
    gpuByteLength: 0,
    liveGeometryGeneration: undefined,
    maximumIndices: spatialIndex.lodLevels[0].indices,
    pointCount: 3,
    spatialIndex,
    topologyOwner: {
      originalIndexBuffer: ebo,
    },
  });
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    gl,
    pointCount: 3,
    currentDimensionLevel: 3,
    _positions: positions,
    _colors: new Uint8Array(colors.length),
    _bufferDirty: false,
    _dirtyLodDimensions: new Set(),
    _lodArrayBuffers: null,
    spatialIndices: new Map([
      [2, spatial2d],
      [3, spatial3d],
    ]),
    lodBuffersByDimension: new Map([
      [2, makeMetadata(
        spatial2d,
        buffer2d,
        vao2d,
        ebo2d,
        token2d,
      )],
      [3, makeMetadata(
        spatial3d,
        buffer3d,
        vao3d,
        ebo3d,
        token3d,
      )],
    ]),
    _lodResourceOwnersByDimension: new Map([
      [2, makeOwner(
        spatial2d,
        buffer2d,
        vao2d,
        ebo2d,
        token2d,
      )],
      [3, makeOwner(
        spatial3d,
        buffer3d,
        vao3d,
        ebo3d,
        token3d,
      )],
    ]),
  });

  renderer.updateColors(colors);
  assert.deepEqual([...renderer._dirtyLodDimensions], [2, 3]);
  assert.equal(renderer._bufferDirty, true);
  // This contract isolates per-dimension LOD publication. The full-detail
  // generation has an independent sticky-WebGL-error regression below.
  renderer._bufferDirty = false;

  rejectedBuffer = buffer2d;
  assert.throws(
    () => renderer.flushBufferUpdates(2),
    /WebGL error 0x502/,
  );
  assert.equal(renderer._dirtyLodDimensions.has(2), true);
  assert.equal(renderer._dirtyLodDimensions.has(3), true);
  assert.deepEqual(uploads, []);

  rejectedBuffer = null;
  renderer.flushBufferUpdates(2);

  assert.deepEqual(uploads, [
    {
      buffer: buffer2d,
      positions: [
        [-2, 0, 0],
        [2, 0, 0],
      ],
      rgba: [
        [30, 31, 32, 33],
        [10, 11, 12, 13],
      ],
    },
  ]);
  assert.equal(renderer._dirtyLodDimensions.has(2), false);
  assert.equal(renderer._dirtyLodDimensions.has(3), true);

  renderer.flushBufferUpdates(3);

  assert.deepEqual(uploads, [
    {
      buffer: buffer2d,
      positions: [
        [-2, 0, 0],
        [2, 0, 0],
      ],
      rgba: [
        [30, 31, 32, 33],
        [10, 11, 12, 13],
      ],
    },
    {
      buffer: buffer3d,
      positions: [
        [0, 0, 1],
      ],
      rgba: [
        [20, 21, 22, 23],
      ],
    },
  ]);
  assert.equal(renderer._dirtyLodDimensions.size, 0);
});

test('full-detail recolor rejects sticky WebGL errors before O(N) packing', () => {
  let bufferDataCalls = 0;
  const gl = {
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88e8,
    INVALID_OPERATION: 0x0502,
    NO_ERROR: 0,
    bindBuffer() {},
    bufferData() {
      bufferDataCalls += 1;
    },
    getError() {
      return this.INVALID_OPERATION;
    },
  };
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    gl,
    buffers: { interleaved: { id: 'full-detail' } },
    pointCount: 2,
    _positions: Float32Array.from([
      -1, 0, 0,
      1, 0, 0,
    ]),
    _colors: Uint8Array.from([
      10, 11, 12, 13,
      20, 21, 22, 23,
    ]),
    _interleavedArrayBuffer: null,
    _interleavedPositionView: null,
    _interleavedColorView: null,
  });

  assert.throws(
    () => renderer._rebuildInterleavedBuffer(),
    /WebGL error 0x502/,
  );
  assert.equal(renderer._interleavedArrayBuffer, null);
  assert.equal(renderer._interleavedPositionView, null);
  assert.equal(renderer._interleavedColorView, null);
  assert.equal(bufferDataCalls, 0);
});

test('lazily created LOD buffers sample the latest renderer color generation', () => {
  let nextId = 1;
  let boundArrayBuffer = null;
  let boundTexture = null;
  const reducedUploads = [];
  const gl = {
    ARRAY_BUFFER: 0x8892,
    CLAMP_TO_EDGE: 0x812f,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    FLOAT: 0x1406,
    MAX_TEXTURE_SIZE: 0x0d33,
    NEAREST: 0x2600,
    NO_ERROR: 0,
    R32UI: 0x8236,
    RED_INTEGER: 0x8d94,
    STATIC_DRAW: 0x88e4,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    UNSIGNED_BYTE: 0x1401,
    UNSIGNED_INT: 0x1405,
    bindBuffer(target, buffer) {
      if (target === this.ARRAY_BUFFER) boundArrayBuffer = buffer;
    },
    bindTexture(target, texture) {
      assert.equal(target, this.TEXTURE_2D);
      boundTexture = texture;
    },
    bindVertexArray() {},
    bufferData(target, data) {
      if (
        target === this.ARRAY_BUFFER &&
        (
          data instanceof ArrayBuffer ||
          ArrayBuffer.isView(data)
        ) &&
        boundArrayBuffer?.kind === 'reduced'
      ) {
        const sourceBuffer = data instanceof ArrayBuffer
          ? data
          : data.buffer;
        const sourceOffset = data instanceof ArrayBuffer
          ? 0
          : data.byteOffset;
        const sourceLength = data.byteLength;
        const bytes = new Uint8Array(
          sourceBuffer,
          sourceOffset,
          sourceLength,
        );
        const floats = new Float32Array(
          sourceBuffer,
          sourceOffset,
          sourceLength / Float32Array.BYTES_PER_ELEMENT,
        );
        reducedUploads.push({
          position: Array.from(floats.subarray(0, 3)),
          rgba: Array.from(bytes.subarray(12, 16)),
        });
      }
    },
    createBuffer() {
      return { id: nextId++, kind: 'reduced' };
    },
    createTexture() {
      return { id: nextId++, kind: 'texture' };
    },
    createVertexArray() {
      return { id: nextId++, kind: 'vao' };
    },
    deleteBuffer() {},
    deleteTexture() {},
    deleteVertexArray() {},
    enableVertexAttribArray() {},
    getError() {
      return this.NO_ERROR;
    },
    getParameter(parameter) {
      assert.equal(parameter, this.MAX_TEXTURE_SIZE);
      return 4096;
    },
    texImage2D() {
      assert.ok(boundTexture);
    },
    texSubImage2D(
      _target,
      _level,
      _x,
      _y,
      _width,
      _height,
      _format,
      _type,
      data,
    ) {
      assert.ok(boundTexture);
      assert.ok(data instanceof Uint32Array);
    },
    texParameteri() {},
    vertexAttribPointer() {},
  };
  const positions = Float32Array.from([
    -1, 0, 0,
    7, 8, 9,
  ]);
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    gl,
    pointCount: 2,
    vao: { id: 'main-vao' },
    buffers: {
      interleaved: { id: 'main-buffer' },
    },
    _colors: Uint8Array.from([
      10, 11, 12, 13,
      20, 21, 22, 23,
    ]),
    _positions: positions,
    _dirtyLodDimensions: new Set(),
    _lodArrayBuffers: null,
    _lodIndexTexturesByDimension: new Map(),
    _pendingDataRetirements: new Set(),
    _pendingSnapshotRetirements: new Set(),
    lodBuffersByDimension: new Map(),
    spatialIndices: new Map(),
    stats: { gpuMemoryMB: 0 },
  });
  const spatialIndex = {
    dimensionLevel: 2,
    pointCount: 2,
    positions,
    lodLevels: [
      {
        depth: 0,
        indices: Uint32Array.from([1]),
        isFullDetail: false,
        pointCount: 1,
        sizeMultiplier: 1,
      },
      {
        depth: 1,
        isFullDetail: true,
        pointCount: 2,
        positions,
      },
    ],
  };
  renderer.spatialIndices.set(2, spatialIndex);

  renderer._createLODResourcesForDimension(2, spatialIndex);

  assert.deepEqual(reducedUploads, [{
    position: [7, 8, 9],
    rgba: [20, 21, 22, 23],
  }]);
});

test('high-performance rendering has no legacy alpha or global-view path', async () => {
  const rendererSource = await source('high-perf-renderer.js');

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
  const positions = Float32Array.from([0, 0, 0]);
  const transparency = Float32Array.from([1]);
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
    signal: new AbortController().signal,
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
