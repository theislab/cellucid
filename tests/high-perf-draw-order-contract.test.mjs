/**
 * The renderer draws each geometry from a store kept in its tree's draw
 * order (see "DRAW ORDER" in high-perf-renderer.js):
 *
 * - full detail is one `drawArrays` over every point, a reduced level one
 *   `drawArrays` prefix;
 * - frustum culling draws runs of tree leaves as at most
 *   `MAX_CULLED_DRAW_RANGES` ranges, one `multiDrawArraysWEBGL` call where the
 *   engine has it and one `drawArrays` a range where it does not, and never
 *   uploads a per-point index: a steady frame and a camera move upload
 *   nothing;
 * - a store adopts its tree order in the frame that needs it, on the GPU, positions and
 *   every colour stream of the views drawing it together;
 * - views drawing one geometry draw it through the same permutation.
 */
import { DEFAULT_CELL_PRIORITY, OPEN_ORDER_PRIORITY } from '../assets/js/data/cell-priority.js';
import { DRAW_BAND_POINTS, lodLadder } from '../assets/js/rendering/high-perf/draw-order.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import {
  HighPerfRenderer,
  RendererConfig,
} from '../assets/js/rendering/high-perf-renderer.js';
import { createCpuPermuter } from './helpers/cpu-permuter.mjs';
import { bufferOf, pointStoreOver, vertexArrayOver } from './helpers/point-stores.mjs';
import { PointStore } from '../assets/js/rendering/high-perf/point-store-segments.js';
import { StoreOrder } from '../assets/js/rendering/high-perf/store-order.js';
import { buildSpatialTreeJob } from '../assets/js/rendering/high-perf/spatial-tree-job.js';
import { planLinearTexture } from '../assets/js/rendering/linear-texture.js';

const MAX_RANGES = 256;
const LIVE_STORE_FOR_TEST = Object.freeze({ kind: 'live' });
// `STORE_ORDER_POINTS_PER_FRAME` in high-perf-renderer.js.
const STORE_ORDER_BUDGET_FOR_TEST = 2 ** 21;

function silenceCalculationNotifications(t) {
  const notifications = getNotificationCenter();
  const previous = {
    completeCalculation: notifications.completeCalculation,
    failCalculation: notifications.failCalculation,
    hasNotification: notifications.hasNotification,
    startCalculation: notifications.startCalculation,
  };
  Object.assign(notifications, {
    completeCalculation() {},
    failCalculation() {},
    hasNotification: () => true,
    startCalculation: () => 'draw-order-contract',
  });
  t.after(() => Object.assign(notifications, previous));
}

/**
 * A WebGL2 double that keeps every buffer's bytes and records uploads,
 * draws, and which textures each draw saw on units 0 and 1.
 */
function createGl({ multiDraw = false } = {}) {
  let nextId = 1;
  const bound = new Map();
  const stores = new Map();
  const units = new Map();
  let activeUnit = 0x84c0;
  let currentVao = null;
  const live = { buffers: new Set(), textures: new Set(), vertexArrays: new Set() };
  const calls = [];
  const draws = [];
  const handle = (kind, set) => {
    const value = Object.freeze({ id: `${kind}-${nextId++}`, kind });
    set.add(value);
    return value;
  };
  const drawSnapshot = () => ({
    vao: currentVao,
    unit0: units.get(0x84c0) ?? null,
    unit1: units.get(0x84c1) ?? null,
  });
  const extension = {
    multiDrawArraysWEBGL(mode, firsts, firstsOffset, counts, countsOffset, drawCount) {
      draws.push({
        kind: 'multi',
        firsts: Array.from(firsts.subarray(firstsOffset, firstsOffset + drawCount)),
        counts: Array.from(counts.subarray(countsOffset, countsOffset + drawCount)),
        ...drawSnapshot(),
      });
    },
  };
  const gl = {
    ARRAY_BUFFER: 0x8892,
    BLEND: 0x0be2,
    CLAMP_TO_EDGE: 0x812f,
    COPY_READ_BUFFER: 0x8f36,
    COPY_WRITE_BUFFER: 0x8f37,
    DEPTH_TEST: 0x0b71,
    DYNAMIC_DRAW: 0x88e8,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    FUNC_ADD: 0x8006,
    MAX_TEXTURE_SIZE: 0x0d33,
    NEAREST: 0x2600,
    NO_ERROR: 0,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    POINTS: 0,
    R32UI: 0x8236,
    RED_INTEGER: 0x8d94,
    SRC_ALPHA: 0x0302,
    STATIC_DRAW: 0x88e4,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE_2D: 0x0de1,
    TEXTURE_2D_ARRAY: 0x8c1a,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    UNSIGNED_INT: 0x1405,
    activeTexture(unit) { activeUnit = unit; },
    bindBuffer(target, buffer) { bound.set(target, buffer); },
    bindTexture(_target, texture) { units.set(activeUnit, texture); },
    bindVertexArray(vao) { currentVao = vao; },
    blendEquation() {},
    blendFuncSeparate() {},
    bufferData(target, size) {
      const buffer = bound.get(target);
      calls.push({ kind: 'bufferData', buffer, size });
      stores.set(buffer, new Uint8Array(size));
    },
    bufferSubData(target, offset, data, srcOffset = 0, length) {
      const buffer = bound.get(target);
      const count = length ?? data.length - srcOffset;
      calls.push({ kind: 'bufferSubData', buffer, bytes: count * data.BYTES_PER_ELEMENT });
      stores.get(buffer).set(
        new Uint8Array(data.buffer, data.byteOffset + srcOffset * data.BYTES_PER_ELEMENT, count * data.BYTES_PER_ELEMENT),
        offset,
      );
    },
    getBufferSubData(target, srcByteOffset, out, dstOffset = 0, length) {
      const bytes = stores.get(bound.get(target));
      const count = length ?? out.length - dstOffset;
      new Uint8Array(out.buffer, out.byteOffset + dstOffset * out.BYTES_PER_ELEMENT, count * out.BYTES_PER_ELEMENT)
        .set(bytes.subarray(srcByteOffset, srcByteOffset + count * out.BYTES_PER_ELEMENT));
    },
    copyBufferSubData(readTarget, writeTarget, readOffset, writeOffset, size) {
      const from = bound.get(readTarget);
      const to = bound.get(writeTarget);
      calls.push({ kind: 'copy', from, to, size });
      stores.get(to).set(stores.get(from).subarray(readOffset, readOffset + size), writeOffset);
    },
    createBuffer() { return handle('buffer', live.buffers); },
    createTexture() { return handle('texture', live.textures); },
    createVertexArray() { return handle('vao', live.vertexArrays); },
    deleteBuffer(buffer) { calls.push({ kind: 'deleteBuffer', buffer }); live.buffers.delete(buffer); stores.delete(buffer); },
    deleteTexture(texture) { calls.push({ kind: 'deleteTexture', texture }); live.textures.delete(texture); },
    deleteVertexArray(vao) { live.vertexArrays.delete(vao); },
    disable() {},
    drawArrays(_mode, first, count) {
      draws.push({ kind: 'arrays', first, count, ...drawSnapshot() });
    },
    drawElements() {
      assert.fail('draw-ordered stores never draw through an element buffer');
    },
    enable() {},
    getError() { return 0; },
    // Fences pass at once: a check made in a later frame finds no error.
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    SYNC_STATUS: 0x9114,
    SIGNALED: 0x9119,
    fenceSync() { return {}; },
    getSyncParameter() { return 0x9119; },
    deleteSync() {},
    flush() {},
    getExtension(name) {
      return name === 'WEBGL_multi_draw' && multiDraw ? extension : null;
    },
    getParameter() { return 4096; },
    isBuffer(buffer) { return live.buffers.has(buffer); },
    isTexture(texture) { return live.textures.has(texture); },
    isVertexArray(vao) { return live.vertexArrays.has(vao); },
    texImage2D() { calls.push({ kind: 'texImage2D', texture: units.get(activeUnit) }); },
    texStorage2D() { calls.push({ kind: 'texImage2D', texture: units.get(activeUnit) }); },
    texParameteri() {},
    texSubImage2D(_target, _level, _x, _y, _w, _h, _format, _type, data) {
      calls.push({ kind: 'texSubImage2D', texture: units.get(activeUnit), data: Uint32Array.from(data) });
    },
    // Linear textures (rendering/linear-texture.js) are 2D arrays.
    texStorage3D() { calls.push({ kind: 'texImage2D', texture: units.get(activeUnit) }); },
    texSubImage3D(_target, _level, _x, _y, _z, w, h, _d, _format, _type, data, srcOffset = 0) {
      calls.push({
        kind: 'texSubImage2D',
        texture: units.get(activeUnit),
        data: Uint32Array.from(data.subarray(srcOffset, srcOffset + w * h)),
      });
    },
    uniform2i() {},
    uniform1f() {},
    uniform1i() {},
    uniform3fv() {},
    uniformMatrix4fv() {},
    useProgram() {},
    enableVertexAttribArray() {},
    disableVertexAttribArray() {},
    vertexAttribPointer() {},
    _state: { calls, draws, live, stores },
  };
  return gl;
}

function nullUniforms() {
  return Object.fromEntries([
    'u_alphaTex', 'u_alphaLayout', 'u_fogColor', 'u_fogScale', 'u_fogNear',
    'u_halfDir', 'u_invCenterShade', 'u_coverageFloor', 'u_lightDir',
    'u_lightingStrength', 'u_lodIndexTex', 'u_lodIndexTexWidth',
    'u_modelViewMatrix', 'u_mvpMatrix', 'u_pointSize', 'u_projectionMatrix',
    'u_sizeAttenuation', 'u_useAlphaTex', 'u_orderedSlots', 'u_pointScale',
  ].map(name => [name, null]));
}

function makeCloud(pointCount, seed = 3) {
  let state = seed;
  const random = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 2 ** 32;
  };
  const positions = new Float32Array(pointCount * 2);
  const colors = new Uint8Array(pointCount * 4);
  for (let id = 0; id < pointCount; id++) {
    positions[id * 2] = random() * 4 - 2;
    positions[id * 2 + 1] = random() * 4 - 2;
    colors[id * 4] = id & 0xff;
    colors[id * 4 + 1] = (id >> 8) & 0xff;
    colors[id * 4 + 2] = (id >> 16) & 0xff;
    colors[id * 4 + 3] = 255;
  }
  return { positions, colors };
}

function createRenderer(gl, {
  pointCount = 4_000,
  lod = false,
  frustum = false,
  maxPointsPerNode = 32,
  segmentPoints = null,
} = {}) {
  const { positions, colors } = makeCloud(pointCount);
  let positionBuffer;
  let colorBuffer;
  if (segmentPoints === null) {
    positionBuffer = pointStoreOver(gl, gl.createBuffer(), pointCount, 8);
    colorBuffer = pointStoreOver(gl, gl.createBuffer(), pointCount, 4);
    gl._state.stores.set(bufferOf(positionBuffer), new Uint8Array(positions.buffer.slice(0)));
    gl._state.stores.set(bufferOf(colorBuffer), new Uint8Array(colors.buffer.slice(0)));
  } else {
    // Stores of several segments, as a publication allocates them.
    const allocate = (refusal, run) => run();
    positionBuffer = new PointStore(gl, segmentPoints);
    positionBuffer.allocate(pointCount, 8, gl.STATIC_DRAW, allocate, 'test positions');
    positionBuffer.write(positions);
    colorBuffer = new PointStore(gl, segmentPoints);
    colorBuffer.allocate(pointCount, 4, gl.DYNAMIC_DRAW, allocate, 'test colours');
    colorBuffer.write(colors);
  }
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    gl,
    _permuter: createCpuPermuter(gl),
    options: {
      ...RendererConfig,
      LOD_MAX_DEPTH: 8,
      LOD_MAX_POINTS_PER_NODE: maxPointsPerNode,
      ...(segmentPoints === null ? {} : { STORE_SEGMENT_POINTS: segmentPoints }),
    },
    useAdaptiveLOD: lod,
    useFrustumCulling: frustum,
    forceLODLevel: -1,
    activeProgram: {},
    activeQuality: 'full',
    programs: { full: {}, fullNoDepth: {} },
    uniformLocations: new Map([['full', nullUniforms()], ['fullNoDepth', nullUniforms()]]),
    buffers: { positions: positionBuffer, colors: colorBuffer },
    vao: vertexArrayOver(gl, positionBuffer, colorBuffer, 2),
    pointCount,
    currentDimensionLevel: 2,
    fogNear: 0,
    fogFar: 10,
    stats: {
      cullPercent: 0, drawCalls: 0, fps: 0, frustumCulled: false,
      gpuMemoryMB: 0, lastFrameTime: 0, lodLevel: -1, visiblePoints: 0,
    },
    _positions: positions,
    _colors: colors,
    _cellPriority: DEFAULT_CELL_PRIORITY,
    _positionGpuByteLength: positions.byteLength,
    _colorGpuByteLength: colors.byteLength,
    _colorsDirty: false,
    _liveOrder: null,
    _liveColorOrder: null,
    _liveGeometryGeneration: 1,
    _nextGeometryGeneration: 2,
    _alphaTexture: null,
    _alphaTexWidth: 0,
    _useAlphaTexture: false,
    _dummyLodIndexTexture: gl.createTexture(),
    _dummyLodIndexTextureByteLength: 4,
    _firstRenderDone: true,
    _perViewState: new Map(),
    _pendingDataRetirements: new Set(),
    _pendingSnapshotRetirements: new Set(),
    _snapshotGeometryPools: new Map(),
    _validatedSpatialIndices: new WeakSet(),
    snapshotBuffers: new Map(),
    spatialIndices: new Map(),
  });
  return { renderer, positions, colors };
}

function matrix(scale = 1, x = 0, y = 0) {
  return Float32Array.from([
    scale, 0, 0, 0,
    0, scale, 0, 0,
    0, 0, 1, 0,
    x, y, 0, 1,
  ]);
}

function params(viewId, { mvp = matrix(0.5), forceLOD = -1 } = {}) {
  const identity = matrix();
  return {
    autoFog: false,
    cameraDistance: 4,
    cameraPosition: Float32Array.from([0, 0, 4]),
    dimensionLevel: 2,
    fogColor: Float32Array.from([0, 0, 0]),
    fogDensity: 0,
    forceLOD,
    fov: Math.PI / 4,
    lightDir: Float32Array.from([0, 0, 1]),
    lightingStrength: 0,
    modelMatrix: identity,
    mvpMatrix: mvp,
    overrideBounds: null,
    pointSize: 2,
    projectionMatrix: identity,
    quality: 'full',
    sizeAttenuation: 0,
    useAlphaTexture: false,
    viewId,
    viewMatrix: identity,
    viewportHeight: 600,
    viewportWidth: 800,
  };
}

const UPLOAD_KINDS = new Set(['bufferData', 'bufferSubData', 'copy', 'texImage2D', 'texSubImage2D']);
function uploadsSince(gl, mark) {
  return gl._state.calls.slice(mark).filter(call => UPLOAD_KINDS.has(call.kind));
}

/** Source ids a frame drew, through the store's draw order. */
function drawnIds(renderer, draws) {
  const indices = renderer._liveOrder.drawOrder.indices;
  const ids = new Set();
  for (const draw of draws) {
    const ranges = draw.kind === 'multi'
      ? draw.firsts.map((first, range) => [first, draw.counts[range]])
      : [[draw.first, draw.count]];
    for (const [first, count] of ranges) {
      for (let slot = first; slot < first + count; slot++) ids.add(indices[slot]);
    }
  }
  return ids;
}

function insideClip(positions, mvp) {
  const inside = [];
  for (let id = 0; id < positions.length / 2; id++) {
    const x = mvp[0] * positions[id * 2] + mvp[12];
    const y = mvp[5] * positions[id * 2 + 1] + mvp[13];
    if (Math.abs(x) <= 1 && Math.abs(y) <= 1) inside.push(id);
  }
  return inside;
}

test('a culled frame draws node ranges covering every visible point, and a steady frame or a camera move uploads nothing', t => {
  silenceCalculationNotifications(t);
  for (const multiDraw of [false, true]) {
    const gl = createGl({ multiDraw });
    const { renderer, positions } = createRenderer(gl, { frustum: true, pointCount: 6_000 });

    // First frame: the tree is built and the store adopts its order.
    const zoomed = matrix(1.6, 0.4, -0.2);
    renderer.render(params('live', { mvp: zoomed }));
    assert.ok(renderer._liveOrder !== null, 'the store holds the tree\'s order');
    assert.equal(renderer._liveOrder.drawOrder, renderer.spatialIndices.get(2).drawOrder);

    // Steady frame: the same camera re-draws the accepted ranges, uploading nothing.
    let mark = gl._state.calls.length;
    let drawMark = gl._state.draws.length;
    renderer.render(params('live', { mvp: zoomed }));
    assert.deepEqual(uploadsSince(gl, mark), [], 'a steady culled frame uploads nothing');
    const steadyDraws = gl._state.draws.slice(drawMark);
    const covered = drawnIds(renderer, steadyDraws);
    for (const id of insideClip(positions, zoomed)) {
      assert.ok(covered.has(id), `visible point ${id} must be drawn`);
    }
    assert.ok(covered.size < positions.length / 2, 'culling drops points outside the frustum');
    if (multiDraw) {
      assert.equal(steadyDraws.length, 1, 'one multi-draw call');
      assert.equal(steadyDraws[0].kind, 'multi');
      assert.ok(steadyDraws[0].firsts.length <= 1024);
    } else {
      assert.ok(steadyDraws.every(draw => draw.kind === 'arrays'));
      assert.ok(steadyDraws.length <= MAX_RANGES);
    }

    // Camera move: re-cull with zero uploads; the new frustum's points are drawn.
    const moved = matrix(1.6, -0.5, 0.3);
    mark = gl._state.calls.length;
    drawMark = gl._state.draws.length;
    renderer.render(params('live', { mvp: moved }));
    assert.deepEqual(uploadsSince(gl, mark), [], 'a camera move re-culls without uploading');
    const movedCovered = drawnIds(renderer, gl._state.draws.slice(drawMark));
    for (const id of insideClip(positions, moved)) {
      assert.ok(movedCovered.has(id), `visible point ${id} must be drawn after the move`);
    }
  }
});

test('ranges never exceed the cap, merging leaf runs across their smallest gaps', t => {
  silenceCalculationNotifications(t);
  const gl = createGl({ multiDraw: false });
  // Many small leaves and a frustum that cuts the cloud into many runs.
  const { renderer, positions } = createRenderer(gl, {
    frustum: true,
    lod: true,
    pointCount: 30_000,
    maxPointsPerNode: 8,
  });
  const mvp = matrix(3, 0.13, 0.07);
  renderer.render(params('live', { mvp, forceLOD: 0 }));
  renderer.render(params('live', { mvp }));
  const mark = gl._state.draws.length;
  renderer.render(params('live', { mvp }));
  const draws = gl._state.draws.slice(mark);
  const viewState = renderer._perViewState.get('live');
  assert.ok(viewState.cull.runCount > 1, 'the fixture yields several leaf runs');
  assert.ok(draws.length <= MAX_RANGES, `${draws.length} ranges`);
  assert.equal(draws.length, viewState.cull.rangeCount);
  const covered = drawnIds(renderer, draws);
  const level = renderer.spatialIndices.get(2).lodLevels[viewState.lastLodLevel];
  const admitted = level.isFullDetail ? null : new Set(level.indices);
  for (const id of insideClip(positions, mvp)) {
    if (admitted === null || admitted.has(id)) {
      assert.ok(covered.has(id), `admitted visible point ${id} must be drawn`);
    }
  }
});

test('full detail draws every stored point, a reduced level its prefix', t => {
  silenceCalculationNotifications(t);
  const gl = createGl();
  const { renderer } = createRenderer(gl, { lod: true, pointCount: 5_000 });

  // A forced level draws that level's prefix of the store.
  let mark = gl._state.draws.length;
  renderer.render(params('live', { forceLOD: 3 }));
  renderer.render(params('live', { forceLOD: 3 }));
  const tree = renderer.spatialIndices.get(2);
  let draws = gl._state.draws.slice(mark).slice(-1);
  assert.deepEqual(
    draws.map(draw => [draw.kind, draw.first, draw.count]),
    [['arrays', 0, tree.lodLevels[3].pointCount]],
  );
  // The store's prefix holds exactly the level's points.
  assert.deepEqual(
    new Set(renderer._liveOrder.drawOrder.indices.subarray(0, tree.lodLevels[3].pointCount)),
    new Set(tree.lodLevels[3].indices),
  );

  // Full detail: one draw of every point.
  renderer.useAdaptiveLOD = false;
  const alphaTexture = gl.createTexture();
  Object.assign(renderer, {
    _alphaTexture: alphaTexture,
    _alphaTexPlan: planLinearTexture(5_000, 4096, 256),
    _useAlphaTexture: true,
  });
  mark = gl._state.draws.length;
  renderer.render(params('live'));
  draws = gl._state.draws.slice(mark);
  assert.deepEqual(draws.map(draw => [draw.kind, draw.first, draw.count]), [['arrays', 0, 5_000]]);
  // Source-order alpha is read through the order's permutation.
  assert.strictEqual(draws[0].unit0, alphaTexture);
  assert.strictEqual(draws[0].unit1, renderer._liveOrder.texture);
});

test('the store adopts its tree order in the frame that needs it: positions and colours together, gathered on the GPU', t => {
  silenceCalculationNotifications(t);
  const gl = createGl();
  const pointCount = 140_000;
  const { renderer, positions, colors } = createRenderer(gl, { lod: true, pointCount, maxPointsPerNode: 1000 });
  const livePositions = renderer.buffers.positions;
  const liveColors = renderer.buffers.colors;

  const mark = gl._state.draws.length;
  renderer.render(params('live'));
  assert.ok(renderer._liveOrder !== null, 'adopted in the first frame');
  assert.strictEqual(renderer._liveColorOrder, renderer._liveOrder);
  assert.equal(renderer._perViewState.get('live').lodConverging, false, 'no frames kept alive for the adoption');
  // One GPU pass for the positions (2 words a point), one for the colours.
  assert.equal(renderer._permuter.wordWrites[2], 1);
  assert.equal(renderer._permuter.wordWrites[1], 1);
  // The frame drew from the ordered store.
  assert.equal(gl._state.draws.length - mark, 1);

  const indices = renderer._liveOrder.drawOrder.indices;
  const storedPositions = new Float32Array(gl._state.stores.get(bufferOf(livePositions)).buffer);
  const storedColors = gl._state.stores.get(bufferOf(liveColors));
  for (const slot of [0, 1, 77_777, pointCount - 1]) {
    const id = indices[slot];
    assert.equal(storedPositions[slot * 2], positions[id * 2]);
    assert.equal(storedPositions[slot * 2 + 1], positions[id * 2 + 1]);
    assert.deepEqual(
      Array.from(storedColors.subarray(slot * 4, slot * 4 + 4)),
      Array.from(colors.subarray(id * 4, id * 4 + 4)),
    );
  }
  // No staging is left behind: the stores were rewritten in place.
  renderer._refreshGpuMemoryStats();
  assert.equal(
    Math.round(renderer.stats.gpuMemoryMB * 1024 * 1024),
    pointCount * 12 + renderer._liveOrder.byteLength + 4,
  );
});

test('a view of the live geometry draws through the live permutation, its colours regathered once', t => {
  silenceCalculationNotifications(t);
  const gl = createGl();
  const { renderer, positions, colors } = createRenderer(gl, { lod: true, pointCount: 3_000 });
  Object.assign(renderer, {
    _alphaTexture: gl.createTexture(),
    _alphaTexPlan: planLinearTexture(3_000, 4096, 256),
    _useAlphaTexture: true,
  });
  renderer.render(params('live'));
  const liveDraw = gl._state.draws.at(-1);
  assert.strictEqual(liveDraw.unit1, renderer._liveOrder.texture);

  const colorBuffer = pointStoreOver(gl, gl.createBuffer(), 3_000, 4);
  gl._state.stores.set(bufferOf(colorBuffer), new Uint8Array(3_000 * 4));
  const snapshot = {
    // Every cell shown; the texture holds the published transparency.
    alphas: null,
    alphaTexHeight: 1,
    alphaTexPlan: planLinearTexture(3_000, 4096, 256),
    alphaTexWidth: 3_000,
    alphaTexture: gl.createTexture(),
    alphaTextureByteLength: 3_000,
    bounds: HighPerfRenderer.computeBoundsFromPositions(positions, 2),
    buffer: colorBuffer,
    bufferByteLength: 3_000 * 4,
    colorOwner: { buffer: colorBuffer, byteLength: 3_000 * 4, pointCount: 3_000, refCount: 1, order: null },
    colors,
    dimensionLevel: 2,
    geometryGeneration: 1,
    id: 'kept',
    pointCount: 3_000,
    positions,
    spatialIndex: null,
    vao: vertexArrayOver(gl, renderer.buffers.positions, colorBuffer, 2),
  };
  renderer.snapshotBuffers.set('kept', snapshot);

  let mark = gl._state.calls.length;
  renderer.renderWithSnapshot('kept', params('kept'));
  const snapshotDraw = gl._state.draws.at(-1);
  assert.strictEqual(snapshotDraw.vao, snapshot.vao.vaos[0]);
  assert.strictEqual(snapshotDraw.unit1, liveDraw.unit1, 'one geometry, one permutation');
  assert.strictEqual(snapshotDraw.unit0, snapshot.alphaTexture, 'its own source-order alpha');
  assert.strictEqual(snapshot.colorOwner.order, renderer._liveOrder);
  const regather = uploadsSince(gl, mark);
  // The view's colours in the new order live in the store it now draws; the
  // source-order store it left is kept for its order, not rewritten.
  const orderedStore = snapshot.colorOwner.buffer;
  assert.ok(
    regather.length > 0 && regather.every(call => call.buffer === bufferOf(orderedStore)),
    'only the view\'s own colour store is written',
  );
  assert.ok(gl._state.live.buffers.has(bufferOf(colorBuffer)), 'the store for the order it left is kept');
  const stored = gl._state.stores.get(bufferOf(orderedStore));
  const indices = renderer._liveOrder.drawOrder.indices;
  for (const slot of [0, 1500, 2999]) {
    assert.deepEqual(
      Array.from(stored.subarray(slot * 4, slot * 4 + 4)),
      Array.from(colors.subarray(indices[slot] * 4, indices[slot] * 4 + 4)),
    );
  }

  mark = gl._state.calls.length;
  renderer.renderWithSnapshot('kept', params('kept'));
  assert.deepEqual(uploadsSince(gl, mark), [], 'colours already in order are not regathered');
});

test('evicting a retained geometry deletes its permutation texture with its store', () => {
  const gl = createGl();
  const { renderer } = createRenderer(gl);
  const positionBuffer = gl.createBuffer();
  const permutation = gl.createTexture();
  renderer._snapshotGeometryPools.set(7, {
    generation: 7,
    dimension: 2,
    positions: new Float32Array(8),
    positionBuffer,
    positionBufferByteLength: 32,
    borrowsLivePositionBuffer: false,
    order: new StoreOrder({
      pointCount: 4,
      target: { indices: new Uint32Array(4), pointCount: 4 },
      adopted: 4,
      base: null,
      baseEnd: 4,
      map: { texture: permutation, plan: null, byteLength: 16 },
      ranked: false,
    }),
    refCount: 0,
    retained: true,
    lastUsed: 0,
    spatialIndices: new Map(),
  });
  assert.equal(renderer.getRetainedGeometryBytes(), 32 + 16);

  const freed = renderer.evictRetainedGeometry(Infinity);

  assert.equal(freed, 32 + 16);
  assert.equal(renderer._snapshotGeometryPools.size, 0);
  assert.equal(gl._state.live.buffers.has(positionBuffer), false);
  assert.equal(gl._state.live.textures.has(permutation), false);
});

// ---------------------------------------------------------------------------
// Cost budget (the regression check behind the renderer benchmarks): what an
// ordered store costs in GPU bytes a point, and what a recolour sends.
// ---------------------------------------------------------------------------

test('LOD and culling keep no second copy: a 2D store costs 8 + 4 + 4 bytes a point on the GPU', t => {
  silenceCalculationNotifications(t);
  const gl = createGl();
  const pointCount = 6_000;
  const { renderer } = createRenderer(gl, { lod: true, frustum: true, pointCount });
  renderer.render(params('live'));
  assert.ok(renderer._liveOrder !== null);
  renderer._refreshGpuMemoryStats();
  const permutationBytes = renderer._liveOrder.plan.texels * 4;
  // Positions (x, y Float32) + RGBA8 colours + the R32UI permutation, plus
  // the 4-byte dummy texture: nothing scales with the LOD level count or the
  // culled node count.
  assert.equal(
    Math.round(renderer.stats.gpuMemoryMB * 1024 * 1024),
    pointCount * 8 + pointCount * 4 + permutationBytes + 4,
  );
  assert.ok(
    permutationBytes < pointCount * 4 + renderer._liveOrder.plan.width * 4,
    'the permutation is one word a point, row-padded',
  );
});

test('a recolour of an ordered store sends 4 bytes a point once and gathers nothing on the CPU', t => {
  silenceCalculationNotifications(t);
  const gl = createGl();
  const pointCount = 6_000;
  const { renderer } = createRenderer(gl, { lod: true, frustum: true, pointCount });
  renderer.render(params('live'));
  assert.ok(renderer._liveOrder !== null);
  const permuter = renderer._permuter;
  const before = permuter.wordWrites[1];
  const mark = gl._state.calls.length;

  const recolored = new Uint8Array(pointCount * 4).fill(7);
  renderer.updateColors(recolored);
  renderer.render(params('live'));

  // One GPU gather into the store, no reallocation, nothing else uploaded.
  assert.equal(permuter.wordWrites[1] - before, 1);
  const uploads = uploadsSince(gl, mark);
  assert.deepEqual(
    uploads.map(call => [call.kind, call.buffer, call.bytes]),
    [['bufferSubData', bufferOf(renderer.buffers.colors), pointCount * 4]],
    'the stand-in for the GPU pass is the only write, 4 bytes a point',
  );
  // The colour path reads no draw-order index on the CPU: the renderer's
  // colour writers hand the permutation to the GPU.
  for (const name of ['_writeOrderedColors', '_publishLiveColors', '_adoptDrawOrder', '_swapColorStore']) {
    const source = HighPerfRenderer.prototype[name].toString();
    assert.doesNotMatch(source, /colorWords\[|words\[indices|colorView\[/, `${name} must not gather colours on the CPU`);
  }
});

// ---------------------------------------------------------------------------
// Trees are built off the main thread: a frame never builds one.
// ---------------------------------------------------------------------------


/** Replace the worker with a queue the test drains when it chooses. */
function deferTreeBuilds(renderer) {
  const jobs = [];
  renderer._buildSpatialTreeJob = (positions, dimensionLevel, buildLOD, priority, onDone, onError) => {
    jobs.push({ positions, dimensionLevel, buildLOD, priority, onDone, onError });
  };
  const land = job => job.onDone(buildSpatialTreeJob({
    positions: job.positions,
    dimensionLevel: job.dimensionLevel,
    buildLOD: job.buildLOD,
    priority: job.priority,
    maxPointsPerNode: renderer.options.LOD_MAX_POINTS_PER_NODE,
    maxDepth: renderer.options.LOD_MAX_DEPTH,
  }));
  return { jobs, land };
}

test('a frame that needs a tree draws full detail and asks a worker for it once; the tree lands, then is adopted', t => {
  silenceCalculationNotifications(t);
  const gl = createGl();
  const pointCount = 5_000;
  const { renderer } = createRenderer(gl, { lod: true, pointCount });
  const { jobs, land } = deferTreeBuilds(renderer);
  let ready = 0;
  renderer.onAsyncTreeReady = () => { ready += 1; };

  for (let frame = 0; frame < 3; frame++) {
    const mark = gl._state.draws.length;
    renderer.render(params('live'));
    const draws = gl._state.draws.slice(mark);
    assert.deepEqual(draws.map(draw => [draw.first, draw.count]), [[0, pointCount]], 'full detail while building');
    assert.equal(renderer._perViewState.get('live').lodConverging, false, 'waiting for a worker keeps no frames alive');
  }
  assert.equal(jobs.length, 1, 'one build, not one per frame');
  assert.equal(jobs[0].buildLOD, true);
  assert.equal(renderer.spatialIndices.size, 0, 'nothing built on the main thread');

  land(jobs[0]);
  assert.equal(ready, 1, 'the embedder is asked for a frame');
  const tree = renderer.spatialIndices.get(2);
  assert.ok(tree.lodLevels.length > 1);
  renderer.render(params('live'));
  assert.equal(renderer._liveOrder.drawOrder, tree.drawOrder, 'the store adopts the tree it was handed');
});

test('a tree whose positions were replaced before it landed is dropped, never installed', t => {
  silenceCalculationNotifications(t);
  const gl = createGl();
  const { renderer } = createRenderer(gl, { frustum: true, pointCount: 3_000 });
  const { jobs, land } = deferTreeBuilds(renderer);
  let ready = 0;
  renderer.onAsyncTreeReady = () => { ready += 1; };
  renderer.render(params('live'));
  assert.equal(jobs.length, 1);
  renderer._positions = renderer._positions.slice();
  land(jobs[0]);
  assert.equal(renderer.spatialIndices.size, 0);
  assert.equal(ready, 0);
  // The new positions get their own build.
  renderer.render(params('live'));
  assert.equal(jobs.length, 2);
  assert.strictEqual(jobs[1].positions, renderer._positions);
});

test('colour stores kept for an order are deleted when the order is retired', () => {
  const gl = createGl();
  const { renderer } = createRenderer(gl);
  renderer._liveColorCache = new Map();
  const keptBuffer = gl.createBuffer();
  const otherBuffer = gl.createBuffer();
  const storeOrder = (texture, adopted) => new StoreOrder({
    pointCount: 4,
    target: { indices: new Uint32Array(4), pointCount: 4 },
    adopted,
    base: null,
    baseEnd: adopted,
    map: { texture, plan: null, byteLength: 16 },
    ranked: true,
  });
  const retiredTexture = gl.createTexture();
  // Two steps of one order (one slot map), and an order of another store.
  const step = storeOrder(retiredTexture, 2);
  const retired = new StoreOrder({ ...step, adopted: 4, baseEnd: 4, map: step.map });
  const kept = storeOrder(gl.createTexture(), 4);
  renderer._liveColorCache.set(step, { buffer: keptBuffer, byteLength: 16, source: renderer._colors, lastUsed: 0 });
  renderer._liveColorCache.set(kept, { buffer: otherBuffer, byteLength: 16, source: renderer._colors, lastUsed: 0 });
  assert.equal(renderer.getKeptColorBytes(), 32);

  renderer._retireStoreOrder(retired, null);
  renderer._drainDataRetirements();

  assert.equal(renderer.getKeptColorBytes(), 16, 'only the store for a live order stays kept');
  assert.equal(gl._state.live.buffers.has(keptBuffer), false);
  assert.equal(gl._state.live.buffers.has(otherBuffer), true);
  assert.equal(gl._state.live.textures.has(retiredTexture), false);
});

// ---------------------------------------------------------------------------
// Segmented stores (rendering/high-perf/point-store-segments.js): the same
// slots drawn in the same order, whatever the segment size.
// ---------------------------------------------------------------------------

/** The global slots a frame's draws submit, in submission order. */
function drawnSlots(renderer, draws) {
  const segments = renderer.vao.segments;
  const slots = [];
  for (const draw of draws) {
    const segment = renderer.vao.vaos.indexOf(draw.vao);
    assert.ok(segment >= 0, 'every point draw binds one of the store\'s segment VAOs');
    const base = segments[segment].first;
    const ranges = draw.kind === 'multi'
      ? draw.firsts.map((first, range) => [first, draw.counts[range]])
      : [[draw.first, draw.count]];
    for (const [first, count] of ranges) {
      assert.ok(first + count <= segments[segment].count, 'a draw stays inside its segment');
      for (let slot = first; slot < first + count; slot++) slots.push(base + slot);
    }
  }
  return slots;
}

test('a store in many segments draws the slots one store draws, in the same order, and holds the same bytes', t => {
  silenceCalculationNotifications(t);
  const pointCount = 20_000;
  for (const multiDraw of [false, true]) {
    const runs = [null, 1_000, 4_096].map(segmentPoints => {
      const gl = createGl({ multiDraw });
      const { renderer } = createRenderer(gl, { lod: true, frustum: true, pointCount, maxPointsPerNode: 64, segmentPoints });
      const frames = {};
      for (const [name, forceLOD, mvp] of [
        ['full detail', -1, matrix(0.5)],
        ['full detail, culled', -1, matrix(1.7, 0.3, -0.2)],
        ['reduced level', 5, matrix(0.5)],
        ['reduced level, culled', 5, matrix(1.7, 0.3, -0.2)],
      ]) {
        renderer.useFrustumCulling = name.endsWith('culled');
        renderer.render(params('live', { mvp, forceLOD }));
        const mark = gl._state.draws.length;
        renderer.render(params('live', { mvp, forceLOD }));
        frames[name] = drawnSlots(renderer, gl._state.draws.slice(mark));
      }
      const words = new Uint32Array(pointCount * 2);
      renderer.buffers.positions.read(words);
      const colours = new Uint32Array(pointCount);
      renderer.buffers.colors.read(colours);
      return { frames, words, colours, segments: renderer.buffers.positions.segments.length };
    });
    const [whole, ...split] = runs;
    assert.equal(whole.segments, 1);
    for (const run of split) {
      assert.ok(run.segments > 1);
      for (const [name, slots] of Object.entries(whole.frames)) {
        assert.ok(slots.length > 0, name);
        assert.deepEqual(run.frames[name], slots, `${name}, ${run.segments} segments, multi-draw ${multiDraw}`);
      }
      assert.deepEqual(run.words, whole.words, 'positions gathered into the draw order, bit for bit');
      assert.deepEqual(run.colours, whole.colours, 'colours gathered into the draw order, bit for bit');
    }
  }
});

test('a draw order the store cannot adopt is said once, the view draws full detail, and it is tried again when LOD is toggled', t => {
  silenceCalculationNotifications(t);
  const notifications = getNotificationCenter();
  const errors = [];
  const previousError = notifications.error;
  notifications.error = message => { errors.push(String(message)); };
  t.after(() => { notifications.error = previousError; });
  const gl = createGl();
  const pointCount = 5_000;
  const { renderer } = createRenderer(gl, { lod: true, pointCount });
  // The GPU refuses the gather once (an allocation it cannot hold).
  const writeWords = renderer._permuter.writeWords;
  let refusals = 1;
  let gathers = 0;
  renderer._permuter.writeWords = (...args) => {
    gathers += 1;
    if (refusals-- > 0) throw new RangeError('GPU permute could not allocate its source texture (WebGL error 0x505).');
    return writeWords(...args);
  };
  for (let frame = 0; frame < 3; frame++) {
    const mark = gl._state.draws.length;
    renderer.render(params('live', { forceLOD: 3 }));
    const draws = gl._state.draws.slice(mark);
    assert.deepEqual(draws.map(draw => [draw.first, draw.count]), [[0, pointCount]], 'full detail, not a silent level');
    assert.equal(renderer.getStats('live').lodLevel, -1);
  }
  assert.equal(gathers, 1, 'not retried every frame');
  assert.equal(errors.length, 1, 'said once');
  assert.match(errors[0], /Levels of detail and culling are off for the live view: its 5,000 points could not be put in draw order on the GPU \(GPU permute could not allocate/);
  renderer._presentedViewIds = ['live'];
  assert.equal(renderer.isPresentedGeometrySettled(), true, 'the view draws its final picture');
  // Memory released since does not retry it (every deletion counts as a
  // release, the failed attempt's own included); toggling LOD does.
  renderer._releaseEpoch = (renderer._releaseEpoch ?? 0) + 1;
  renderer.render(params('live', { forceLOD: 3 }));
  assert.equal(gathers, 1);
  renderer._assertOperational = () => {};
  renderer.setAdaptiveLOD(false);
  renderer.setAdaptiveLOD(true);
  renderer.render(params('live', { forceLOD: 3 }));
  const tree = renderer.spatialIndices.get(2);
  assert.equal(renderer._liveOrder.drawOrder, tree.drawOrder);
  const mark = gl._state.draws.length;
  renderer.render(params('live', { forceLOD: 3 }));
  assert.deepEqual(gl._state.draws.slice(mark).map(draw => [draw.first, draw.count]), [[0, tree.lodLevels[3].pointCount]]);
  assert.equal(errors.length, 1);
});

// ---------------------------------------------------------------------------
// Levels in rank order (rendering/high-perf/lod-levels.js `RankLevels`,
// rendering/high-perf/store-order.js): a store of cells opened in priority
// order draws its levels at once as prefixes, takes its tree's order band by
// band, and grows or shrinks in place.
// ---------------------------------------------------------------------------

/** A renderer over `pointCount` cells opened in priority order (`OPEN_ORDER_PRIORITY`). */
function createRankRenderer(gl, pointCount, cloud = null) {
  const { renderer, positions, colors } = createRenderer(gl, {
    lod: true, pointCount, maxPointsPerNode: 64, segmentPoints: 4096,
  });
  if (cloud !== null) {
    renderer.buffers.positions.write(cloud.positions);
    renderer.buffers.colors.write(cloud.colors);
    renderer._positions = cloud.positions;
    renderer._colors = cloud.colors;
  }
  Object.assign(renderer, {
    _cellPriority: OPEN_ORDER_PRIORITY,
    _boundingSphere: renderer._computeBoundingSphere(renderer._positions, 2),
    _liveColorCache: new Map(),
    _assertOperational() {},
  });
  return { renderer, positions: cloud?.positions ?? positions, colors: cloud?.colors ?? colors };
}

/** Each slot's source cell must hold that cell's words, in the position and colour stores. */
function assertStoreHolds(renderer, label) {
  const order = renderer._liveOrder;
  const n = renderer.pointCount;
  const positions = new Float32Array(n * 2);
  renderer.buffers.positions.read(positions);
  const colors = new Uint8Array(n * 4);
  renderer.buffers.colors.read(colors);
  for (let slot = 0; slot < n; slot++) {
    const id = order === null ? slot : order.sourceOf(slot);
    if (positions[slot * 2] !== renderer._positions[id * 2] || positions[slot * 2 + 1] !== renderer._positions[id * 2 + 1]
      || colors[slot * 4] !== renderer._colors[id * 4] || colors[slot * 4 + 1] !== renderer._colors[id * 4 + 1]) {
      assert.fail(`${label}: slot ${slot} does not hold cell ${id}`);
    }
  }
}

/** Whether every ladder prefix of the store holds exactly its own ranks. */
function assertLevelsAreRankPrefixes(renderer, label) {
  const order = renderer._liveOrder;
  for (const count of lodLadder(renderer.pointCount)) {
    const seen = new Uint8Array(count);
    for (let slot = 0; slot < count; slot++) {
      const id = order === null ? slot : order.sourceOf(slot);
      assert.ok(id < count && seen[id] === 0, `${label}: the first ${count} slots hold ranks below ${count}`);
      seen[id] = 1;
    }
  }
}

test('cells in rank order draw every level at once, as a prefix of the store, with nothing built or uploaded', t => {
  silenceCalculationNotifications(t);
  const gl = createGl();
  const pointCount = 30_000;
  const { renderer } = createRankRenderer(gl, pointCount);
  // No tree yet (the worker is still building it).
  renderer._requestSpatialIndex = () => {};
  const ladder = lodLadder(pointCount);
  for (const level of [0, 5, ladder.length - 2]) {
    const mark = gl._state.draws.length;
    const uploads = gl._state.calls.length;
    renderer.render(params('live', { forceLOD: level }));
    const slots = drawnSlots(renderer, gl._state.draws.slice(mark));
    assert.equal(slots.length, ladder[level]);
    assert.deepEqual([slots[0], slots.at(-1)], [0, ladder[level] - 1]);
    assert.equal(renderer.getStats('live').lodLevel, level);
    assert.equal(renderer._liveOrder, null, 'no permutation');
    assert.deepEqual(uploadsSince(gl, uploads), [], 'nothing gathered or uploaded');
  }
  assert.equal(renderer.getLODLevelCount(2), ladder.length);
  // The level's cells, as consumers read them: the first ranks.
  const membership = renderer.getCurrentLodMembership('live', 2);
  assert.equal(membership.indices.length, ladder[ladder.length - 2]);
  assert.equal(membership.indices[0], 0);
  assert.equal(membership.slotPrefix, true);
  assert.equal(membership.admissionLevels[ladder[0] - 1], 0);
  assert.equal(membership.admissionLevels[ladder[0]], 1);
});

test('a store takes its tree order band by band; every level draws its own cells at every step', t => {
  silenceCalculationNotifications(t);
  const gl = createGl();
  const pointCount = 30_000;
  const { renderer } = createRankRenderer(gl, pointCount);
  renderer._ensureLiveColorsInOrder();
  const tree = renderer._getOrBuildSpatialIndexForDimension(2, false, true);
  assert.equal(tree.drawOrder.ranked, true);
  let steps = 0;
  while (renderer._liveOrder?.drawOrder !== tree.drawOrder) {
    const { order } = renderer._advanceStoreOrder(LIVE_STORE_FOR_TEST, renderer._liveOrder, tree.drawOrder, 1);
    steps += 1;
    assert.equal(renderer._liveColorOrder, order, 'the colours follow each step');
    assertLevelsAreRankPrefixes(renderer, `step ${steps}`);
    assertStoreHolds(renderer, `step ${steps}`);
  }
  assert.equal(steps, tree.drawOrder.bandCount);
  // Then the tree draws, culled, as a store adopted at once would.
  const mark = gl._state.draws.length;
  renderer.useFrustumCulling = true;
  renderer.render(params('live', { forceLOD: 3, mvp: matrix(1.5) }));
  assert.ok(renderer.getStats('live').frustumCulled);
  assert.ok(gl._state.draws.length > mark);
  // A forced level culled draws at most that level's cells.
  assert.equal(renderer.getStats('live').lodLevel, 3);
  assert.ok(renderer.getStats('live').visiblePoints <= lodLadder(pointCount)[3], String(renderer.getStats('live').visiblePoints));
});

test('a frame moves a bounded number of points; the frames between draw levels by rank', t => {
  silenceCalculationNotifications(t);
  const gl = createGl();
  const { renderer } = createRankRenderer(gl, 30_000);
  let asked = 0;
  renderer.onAsyncTreeReady = () => { asked += 1; };
  renderer._frameAdoptionPoints = 0;
  // A frame whose budget is one band: the store moves one band and asks for
  // the next frame.
  renderer._frameAdoptionPoints = STORE_ORDER_BUDGET_FOR_TEST - 1;
  renderer.render(params('live', { forceLOD: 2 }));
  const order = renderer._liveOrder;
  assert.ok(order !== null && order.complete === false && order.adopted > 0, 'one step taken');
  assert.ok(asked > 0, 'another frame is asked for');
  assert.equal(renderer.getStats('live').lodLevel, 2, 'the level still draws, by rank');
  renderer.beginFrame();
  renderer.render(params('live', { forceLOD: 2 }));
  assert.equal(renderer._liveOrder.complete, true);
});

/** Run frames until the live store holds its tree's order whole. */
function adoptAll(renderer) {
  for (let frame = 0; frame < 100; frame++) {
    renderer.beginFrame();
    renderer.render(params('live', { forceLOD: 1 }));
    const tree = renderer.spatialIndices.get(2);
    if (tree && renderer._liveOrder?.drawOrder === tree.drawOrder) return tree;
  }
  throw new Error('the store never took its tree order');
}

for (const [from, to] of [[20_000, 30_000], [30_000, 12_345], [30_000, 20_000], [12_345, 30_000]]) {
  test(`cells resized in place ${from} -> ${to}: kept slots are not uploaded, and after the tree is adopted the store is a direct open's, byte for byte`, t => {
    silenceCalculationNotifications(t);
    const cloud = makeCloud(Math.max(from, to), 11);
    const prefix = n => ({ positions: cloud.positions.slice(0, n * 2), colors: cloud.colors.slice(0, n * 4) });
    const gl = createGl();
    const { renderer } = createRankRenderer(gl, from, prefix(from));
    adoptAll(renderer);
    const next = prefix(to);
    const mark = gl._state.calls.length;
    const result = renderer.resizeLiveCells(next.positions, next.colors, { dimensionLevel: 2 });
    const written = gl._state.calls.slice(mark).filter(call => call.kind === 'bufferSubData')
      .reduce((sum, call) => sum + call.bytes, 0);
    const alphaWritten = gl._state.calls.slice(mark).filter(call => call.kind === 'texSubImage2D')
      .reduce((sum, call) => sum + call.data.length, 0);
    assert.equal(written, result.storeBytes);
    assert.equal(alphaWritten, result.alphaBytes, 'the alpha texture, a byte a cell, is made anew');
    if (to > from) {
      assert.deepEqual([result.appended, result.rewritten], [to - from, 0]);
      assert.equal(result.storeBytes, (to - from) * 12, 'only the added cells go up');
    } else {
      assert.equal(result.removed, from - to);
      assert.ok(result.rewritten <= DRAW_BAND_POINTS && result.rewritten < to, 'at most the band of the cut is rewritten');
    }
    assert.equal(renderer.pointCount, to);
    // Drawable at once: every level is its own ranks.
    assertStoreHolds(renderer, 'resized');
    assertLevelsAreRankPrefixes(renderer, 'resized');
    // Every band of one gather pass is taken from the store itself, those
    // still in the earlier tree's order (below a cut, or below the cells
    // added) too: only a band wider than a pass reads page memory.
    const pageBands = [];
    const writeWordsRange = renderer._permuter.writeWordsRange;
    renderer._permuter.writeWordsRange = (target, first, end, source, ...rest) => {
      if (ArrayBuffer.isView(source) && end - first <= 4096) pageBands.push([first, end]);
      return writeWordsRange(target, first, end, source, ...rest);
    };
    adoptAll(renderer);
    renderer._permuter.writeWordsRange = writeWordsRange;
    assert.deepEqual(pageBands, [], 'no band of one pass is gathered from page memory');
    assertStoreHolds(renderer, 'adopted');

    const directGl = createGl();
    const direct = createRankRenderer(directGl, to, prefix(to)).renderer;
    adoptAll(direct);
    assert.deepEqual(renderer._liveOrder.target.indices, direct._liveOrder.target.indices);
    const read = (store, n, bytes) => {
      const out = new Uint8Array(n * bytes);
      store.read(out);
      return out;
    };
    assert.deepEqual(read(renderer.buffers.positions, to, 8), read(direct.buffers.positions, to, 8));
    assert.deepEqual(read(renderer.buffers.colors, to, 4), read(direct.buffers.colors, to, 4));
  });
}

test('cells resized while their tree builds in the worker cancel that build; mid-adoption, the store stays drawable and the next tree completes it', async t => {
  silenceCalculationNotifications(t);
  class FakeWorker extends EventTarget {
    static made = [];
    constructor() {
      super();
      this.terminated = false;
      FakeWorker.made.push(this);
    }
    postMessage() {}
    terminate() { this.terminated = true; }
  }
  const previousWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  t.after(() => { globalThis.Worker = previousWorker; });
  const cloud = makeCloud(30_000, 5);
  const prefix = n => ({ positions: cloud.positions.slice(0, n * 2), colors: cloud.colors.slice(0, n * 4) });
  const gl = createGl();
  const { renderer } = createRankRenderer(gl, 20_000, prefix(20_000));
  renderer._permuter = createCpuPermuter(gl);
  renderer.beginFrame();
  renderer.render(params('live', { forceLOD: 2 }));
  await new Promise(resolve => setTimeout(resolve, 0));
  const worker = FakeWorker.made.at(-1);
  assert.ok(worker && !worker.terminated, 'the tree builds in the worker; the frame drew levels by rank');
  assert.equal(renderer.getStats('live').lodLevel, 2);

  // An Apply lands before the tree: the build for the old positions stops.
  const grown = prefix(30_000);
  renderer.resizeLiveCells(grown.positions, grown.colors, { dimensionLevel: 2 });
  assert.equal(worker.terminated, true);
  renderer.beginFrame();
  renderer.render(params('live', { forceLOD: 2 }));
  assert.equal(renderer.getStats('live').lodLevel, 2, 'levels by rank at once after the Apply');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(FakeWorker.made.at(-1) !== worker && !FakeWorker.made.at(-1).terminated, 'a build for the new positions');

  // A store part way through its order when cells are cut, then the next
  // tree's order: drawable at every point, and a direct open's in the end.
  globalThis.Worker = previousWorker;
  renderer._retireSpatialTreeWorker?.();
  const tree = renderer._getOrBuildSpatialIndexForDimension(2, false, true);
  renderer._advanceStoreOrder(LIVE_STORE_FOR_TEST, renderer._liveOrder, tree.drawOrder, 1);
  renderer._advanceStoreOrder(LIVE_STORE_FOR_TEST, renderer._liveOrder, tree.drawOrder, 1);
  assert.equal(renderer._liveOrder.complete, false);
  const cut = prefix(17_000);
  renderer.resizeLiveCells(cut.positions, cut.colors, { dimensionLevel: 2 });
  assertStoreHolds(renderer, 'cut mid-adoption');
  assertLevelsAreRankPrefixes(renderer, 'cut mid-adoption');
  adoptAll(renderer);
  const direct = createRankRenderer(createGl(), 17_000, prefix(17_000)).renderer;
  adoptAll(direct);
  const read = (store, n, bytes) => {
    const out = new Uint8Array(n * bytes);
    store.read(out);
    return out;
  };
  assert.deepEqual(read(renderer.buffers.positions, 17_000, 8), read(direct.buffers.positions, 17_000, 8));
  assert.deepEqual(read(renderer.buffers.colors, 17_000, 4), read(direct.buffers.colors, 17_000, 4));
});

test('a recolour with the same colours in another array sends nothing; the same array rewritten is sent again', t => {
  silenceCalculationNotifications(t);
  const gl = createGl();
  const { renderer, colors } = createRenderer(gl, { pointCount: 5_000 });
  renderer._liveColorCache = new Map();
  renderer.render(params('live'));
  renderer.updateColors(colors.slice());
  assert.equal(renderer._colorsDirty, false, 'equal bytes in a new array: nothing to publish');
  const same = renderer._colors;
  same[0] ^= 1;
  renderer.updateColors(same);
  assert.equal(renderer._colorsDirty, true, 'the same array may have been rewritten: sent again');
  renderer.render(params('live'));
  const changed = renderer._colors.slice();
  changed[4] ^= 1;
  renderer.updateColors(changed);
  assert.equal(renderer._colorsDirty, true);
});

test('a band whose deferred error check fails gives the order up: the store is written again in source order and says so once', t => {
  silenceCalculationNotifications(t);
  const notifications = getNotificationCenter();
  const errors = [];
  const previousError = notifications.error;
  notifications.error = message => { errors.push(String(message)); };
  t.after(() => { notifications.error = previousError; });
  const gl = createGl();
  const { renderer } = createRankRenderer(gl, 30_000);
  renderer._ensureLiveColorsInOrder();
  const tree = renderer._getOrBuildSpatialIndexForDimension(2, false, true);
  // The renderer hands each band its deferred check's failure handler.
  let onError = null;
  const write = renderer._permuter.writeWordsRange;
  renderer._permuter.writeWordsRange = (...args) => {
    onError = args[6]?.onError ?? onError;
    return write(...args);
  };
  renderer._advanceStoreOrder(LIVE_STORE_FOR_TEST, renderer._liveOrder, tree.drawOrder, 1);
  renderer._advanceStoreOrder(LIVE_STORE_FOR_TEST, renderer._liveOrder, tree.drawOrder, 1);
  assert.equal(typeof onError, 'function', 'every band write is checked, later');
  onError(new Error('GPU permute write of slots [1000, 1250): INVALID_OPERATION'));
  assert.equal(renderer._liveOrder, null);
  assert.equal(renderer._colorsDirty, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Culling and the tree's draw order are off for the live view/);
  renderer.render(params('live', { forceLOD: 2 }));
  assertStoreHolds(renderer, 'after the failure');
  assert.equal(renderer._liveOrder, null, 'not tried again until LOD or culling is toggled');
});

test('every CPU reader sees the store as drawn while it takes its order: figure export draw order, LOD indices, velocity and highlight prefixes', async t => {
  silenceCalculationNotifications(t);
  const gl = createGl();
  const pointCount = 30_000;
  const { renderer } = createRankRenderer(gl, pointCount);
  Object.assign(renderer, { _lodSequentialMemberships: new WeakMap(), _lodSpatialOwnerTokens: new WeakMap() });
  renderer._requestSpatialIndex = () => {};
  const ladder = lodLadder(pointCount);
  // Rank phase: a forced level is the first ranks, read without a tree.
  renderer.render(params('live', { forceLOD: 3 }));
  assert.equal(renderer.getViewDrawOrder('live'), null, 'source order: figure export draws by cell');
  const indices = renderer.getCurrentLodIndices('live', 2);
  assert.deepEqual(Array.from(indices), Array.from({ length: ladder[3] }, (_, cell) => cell));
  const sequential = renderer.getCurrentLodSequentialMembership('live', 2);
  assert.strictEqual(sequential.indices, indices, 'velocity and edges read the same prefix');
  const membership = renderer.getCurrentLodMembership('live', 2);
  assert.equal(membership.slotPrefix, true, 'highlights draw the level as the store\'s first slots');
  // Part way through the tree's order: the draw order a figure follows is
  // each slot's cell, and the level is still the first slots.
  delete renderer._requestSpatialIndex;
  const tree = renderer._getOrBuildSpatialIndexForDimension(2, false, true);
  for (let step = 0; step < 4; step++) {
    renderer._advanceStoreOrder(LIVE_STORE_FOR_TEST, renderer._liveOrder, tree.drawOrder, 1);
  }
  const partial = renderer._liveOrder;
  assert.equal(partial.complete, false);
  const drawOrder = renderer.getViewDrawOrder('live');
  for (let slot = 0; slot < pointCount; slot += 997) assert.equal(drawOrder[slot], partial.sourceOf(slot));
  assert.deepEqual(Array.from(drawOrder).sort((a, b) => a - b), Array.from({ length: pointCount }, (_, cell) => cell));
  renderer._perViewState.get('live').lastLodLevel = -1;
  // A frame whose adoption budget is spent: the store stays part way.
  renderer.beginFrame();
  renderer._frameAdoptionPoints = STORE_ORDER_BUDGET_FOR_TEST;
  renderer.render(params('live', { forceLOD: 3 }));
  assert.strictEqual(renderer._liveOrder, partial);
  const level = renderer.getCurrentLodIndices('live', 2);
  assert.deepEqual(Array.from(level), Array.from(drawOrder.subarray(0, ladder[3])), 'the level in the order it is drawn');
  assert.deepEqual(Array.from(level).sort((a, b) => a - b), Array.from({ length: ladder[3] }, (_, cell) => cell));
  // The highlight renderer draws such a level from the store itself.
  const { HighlightRenderer } = await import('../assets/js/rendering/highlight-renderer.js');
  const store = { buffer: renderer.buffers.positions, dimension: 2, positions: renderer._positions, order: partial };
  const slots = HighlightRenderer.prototype._slotStoreFor.call(
    { hpRenderer: { getViewPointStore: () => store } },
    'live', renderer._positions, 2, renderer.getCurrentLodMembership('live', 2),
  );
  assert.deepEqual([slots.order, slots.slots], [partial, ladder[3]]);
});

test('a tree built under a priority the cells no longer have is not adopted: no store takes an order whole when its cells are now in priority order', t => {
  silenceCalculationNotifications(t);
  const gl = createGl();
  const { renderer, positions } = createRenderer(gl, { pointCount: 6_000 });
  Object.assign(renderer, { _liveColorCache: new Map(), _assertOperational() {}, _boundingSphere: renderer._computeBoundingSphere(renderer._positions, 2) });
  // The worker answers when told to: a tree requested for culling only,
  // under the default priority (one band, its order not by open position).
  const builds = [];
  renderer._buildSpatialTreeJob = (pos, dimension, buildLOD, priority, onDone) => builds.push({ pos, dimension, buildLOD, priority, onDone });
  renderer._requestSpatialIndex({ kind: 'live' }, false);
  assert.equal(builds.length, 1);
  // The cells are published in priority order meanwhile.
  renderer.setCellPriority(OPEN_ORDER_PRIORITY);
  // A request now does not join that build: its order could not be taken band by band.
  renderer._requestSpatialIndex({ kind: 'live' }, false);
  assert.equal(builds.length, 2, 'a build under the cells\' priority is asked for');
  const job = priority => buildSpatialTreeJob({
    positions: positions.slice(), dimensionLevel: 2, maxPointsPerNode: 32, maxDepth: 8, buildLOD: false, priority,
  });
  builds[0].onDone(job(builds[0].priority));
  assert.equal(renderer.spatialIndices.size, 0, 'the stale tree is dropped when it lands');
  builds[1].onDone(job(builds[1].priority));
  const tree = renderer.spatialIndices.get(2);
  assert.ok(tree && tree.drawOrder.ranked === true, 'the tree built under the cells\' priority is installed, its order by open position');
});
