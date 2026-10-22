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
import assert from 'node:assert/strict';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import {
  HighPerfRenderer,
  RendererConfig,
} from '../assets/js/rendering/high-perf-renderer.js';
import { createCpuPermuter } from './helpers/cpu-permuter.mjs';
import { buildSpatialTreeJob } from '../assets/js/rendering/high-perf/spatial-tree-job.js';
import { planLinearTexture } from '../assets/js/rendering/linear-texture.js';

const MAX_RANGES = 256;

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
    'u_sizeAttenuation', 'u_useAlphaTex', 'u_useLodIndexTex', 'u_pointScale',
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
} = {}) {
  const { positions, colors } = makeCloud(pointCount);
  const positionBuffer = gl.createBuffer();
  const colorBuffer = gl.createBuffer();
  gl._state.stores.set(positionBuffer, new Uint8Array(positions.buffer.slice(0)));
  gl._state.stores.set(colorBuffer, new Uint8Array(colors.buffer.slice(0)));
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    gl,
    _permuter: createCpuPermuter(gl),
    options: {
      ...RendererConfig,
      LOD_MAX_DEPTH: 8,
      LOD_MAX_POINTS_PER_NODE: maxPointsPerNode,
    },
    useAdaptiveLOD: lod,
    useFrustumCulling: frustum,
    forceLODLevel: -1,
    activeProgram: {},
    activeQuality: 'full',
    programs: { full: {}, fullNoDepth: {} },
    uniformLocations: new Map([['full', nullUniforms()], ['fullNoDepth', nullUniforms()]]),
    buffers: { positions: positionBuffer, colors: colorBuffer },
    vao: gl.createVertexArray(),
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
  assert.strictEqual(renderer._liveColorOrder, renderer._liveOrder.drawOrder);
  assert.equal(renderer._perViewState.get('live').lodConverging, false, 'no frames kept alive for the adoption');
  // One GPU pass for the positions (2 words a point), one for the colours.
  assert.equal(renderer._permuter.wordWrites[2], 1);
  assert.equal(renderer._permuter.wordWrites[1], 1);
  // The frame drew from the ordered store.
  assert.equal(gl._state.draws.length - mark, 1);

  const indices = renderer._liveOrder.drawOrder.indices;
  const storedPositions = new Float32Array(gl._state.stores.get(livePositions).buffer);
  const storedColors = gl._state.stores.get(liveColors);
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

  const colorBuffer = gl.createBuffer();
  gl._state.stores.set(colorBuffer, new Uint8Array(3_000 * 4));
  const alphaTexData = new Uint8Array(3_000).fill(255);
  const snapshot = {
    alphaTexData,
    alphaTexHeight: 1,
    alphaTexPlan: planLinearTexture(3_000, 4096, 256),
    alphaTexWidth: 3_000,
    alphaTexture: gl.createTexture(),
    alphaTextureByteLength: alphaTexData.byteLength,
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
    vao: gl.createVertexArray(),
  };
  renderer.snapshotBuffers.set('kept', snapshot);

  let mark = gl._state.calls.length;
  renderer.renderWithSnapshot('kept', params('kept'));
  const snapshotDraw = gl._state.draws.at(-1);
  assert.strictEqual(snapshotDraw.vao, snapshot.vao);
  assert.strictEqual(snapshotDraw.unit1, liveDraw.unit1, 'one geometry, one permutation');
  assert.strictEqual(snapshotDraw.unit0, snapshot.alphaTexture, 'its own source-order alpha');
  assert.strictEqual(snapshot.colorOwner.order, renderer._liveOrder.drawOrder);
  const regather = uploadsSince(gl, mark);
  // The view's colours in the new order live in the store it now draws; the
  // source-order store it left is kept for its order, not rewritten.
  const orderedStore = snapshot.colorOwner.buffer;
  assert.ok(
    regather.length > 0 && regather.every(call => call.buffer === orderedStore),
    'only the view\'s own colour store is written',
  );
  assert.ok(gl._state.live.buffers.has(colorBuffer), 'the store for the order it left is kept');
  const stored = gl._state.stores.get(orderedStore);
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
    order: { drawOrder: { indices: new Uint32Array(4) }, texture: permutation, byteLength: 16, width: 4, height: 1 },
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
    [['bufferSubData', renderer.buffers.colors, pointCount * 4]],
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
  renderer._buildSpatialTreeJob = (positions, dimensionLevel, buildLOD, onDone, onError) => {
    jobs.push({ positions, dimensionLevel, buildLOD, onDone, onError });
  };
  const land = job => job.onDone(buildSpatialTreeJob({
    positions: job.positions,
    dimensionLevel: job.dimensionLevel,
    buildLOD: job.buildLOD,
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
  const retired = { drawOrder: { indices: new Uint32Array(4) }, texture: gl.createTexture(), byteLength: 16, width: 4, height: 1 };
  const kept = { indices: new Uint32Array(4) };
  renderer._liveColorCache.set(retired.drawOrder, { buffer: keptBuffer, byteLength: 16, source: renderer._colors, lastUsed: 0 });
  renderer._liveColorCache.set(kept, { buffer: otherBuffer, byteLength: 16, source: renderer._colors, lastUsed: 0 });
  assert.equal(renderer.getKeptColorBytes(), 32);

  renderer._retireDrawOrderRecord(retired);
  renderer._drainDataRetirements();

  assert.equal(renderer.getKeptColorBytes(), 16, 'only the store for a live order stays kept');
  assert.equal(gl._state.live.buffers.has(keptBuffer), false);
  assert.equal(gl._state.live.buffers.has(otherBuffer), true);
});
