/**
 * Connectivity edges keep the graph on the CPU as loaded (plus its edges as
 * ordered records) and send each pane only its K shown edges, one 12-byte
 * record each, with the endpoints' positions read on the GPU from one
 * position texture a geometry (rendering/connectivity-edge-layer.js).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONNECTIVITY_DEFAULT_VISIBLE_TARGET,
  CONNECTIVITY_RECORD_BYTES,
  createConnectivityEdgeLayer,
} from '../assets/js/rendering/connectivity-edge-layer.js';
import { createConnectivityEdgeOrder } from '../assets/js/rendering/connectivity-edge-selection.js';
import { connectivityEdgesFromPairs, edgeListOf } from './helpers/connectivity-edges.mjs';

function createFakeGl() {
  let next = 1;
  const live = { buffers: new Set(), vaos: new Set(), programs: new Set(), textures: new Set(), feedbacks: new Set() };
  const stores = new Map();
  const textures = new Map();
  const bound = { array: null, vao: null, texture: null, unit: 0 };
  const calls = { bufferData: 0, bufferSubData: 0, texSubImage3D: 0, draws: [], gathers: [], lastSubData: null };
  const gl = {
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    UNSIGNED_INT: 0x1405,
    TRIANGLE_STRIP: 5,
    NO_ERROR: 0,
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    BLEND: 5,
    FUNC_ADD: 6,
    SRC_ALPHA: 7,
    ONE_MINUS_SRC_ALPHA: 8,
    ONE: 9,
    TEXTURE0: 0x84c0,
    TEXTURE_2D_ARRAY: 0x8c1a,
    TEXTURE_BINDING_2D_ARRAY: 0x8c1d,
    ACTIVE_TEXTURE: 0x84e0,
    UNPACK_ALIGNMENT: 0x0cf5,
    PIXEL_UNPACK_BUFFER: 0x88ec,
    PIXEL_UNPACK_BUFFER_BINDING: 0x88ef,
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    R32F: 0x822e,
    RG32F: 0x8230,
    RGB32F: 0x8815,
    RED: 0x1903,
    RG: 0x8227,
    RGB: 0x1907,
    createShader: () => ({ id: next++ }),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader() {},
    createProgram() {
      const program = { id: next++ };
      live.programs.add(program);
      return program;
    },
    attachShader() {},
    detachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram(program) { live.programs.delete(program); },
    getUniformLocation: (_program, name) => name,
    getError: () => 0,
    getParameter(name) {
      if (name === gl.MAX_TEXTURE_SIZE) return 64;
      if (name === gl.MAX_ARRAY_TEXTURE_LAYERS) return 256;
      if (name === gl.ACTIVE_TEXTURE) return gl.TEXTURE0 + bound.unit;
      if (name === gl.TEXTURE_BINDING_2D_ARRAY) return bound.texture;
      if (name === gl.UNPACK_ALIGNMENT) return 4;
      return null;
    },
    createBuffer() {
      const buffer = { id: next++ };
      live.buffers.add(buffer);
      return buffer;
    },
    deleteBuffer(buffer) { live.buffers.delete(buffer); stores.delete(buffer); },
    bindBuffer(target, buffer) { if (target === gl.ARRAY_BUFFER) bound.array = buffer; },
    bufferData(_target, data) {
      calls.bufferData++;
      stores.set(bound.array, typeof data === 'number' ? new Uint32Array(data / 4) : new Uint32Array(Float32Array.from(data).buffer));
    },
    bufferSubData(_target, offset, data, srcOffset, length) {
      calls.bufferSubData++;
      stores.get(bound.array).set(data.subarray(srcOffset, srcOffset + length), offset / 4);
      calls.lastSubData = bound.array;
    },
    createVertexArray() {
      const vao = { id: next++ };
      live.vaos.add(vao);
      return vao;
    },
    deleteVertexArray(vao) { live.vaos.delete(vao); },
    bindVertexArray(vao) { bound.vao = vao; },
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    vertexAttribIPointer() {},
    vertexAttribDivisor() {},
    createTexture() {
      const texture = { id: next++ };
      live.textures.add(texture);
      return texture;
    },
    deleteTexture(texture) { live.textures.delete(texture); textures.delete(texture); },
    activeTexture(unit) { bound.unit = unit - gl.TEXTURE0; },
    bindTexture(_target, texture) { bound.texture = texture; },
    texParameteri() {},
    pixelStorei() {},
    texStorage3D(_target, _levels, format, width, height, depth) {
      textures.set(bound.texture, { format, width, height, depth, values: [] });
    },
    createTransformFeedback() { const feedback = { id: next++ }; live.feedbacks.add(feedback); return feedback; },
    deleteTransformFeedback(feedback) { live.feedbacks.delete(feedback); },
    transformFeedbackVaryings(_program, varyings) { calls.varyings = varyings; },
    bindTransformFeedback() {},
    bindBufferRange(_target, _index, buffer, offset, size) { bound.feedbackBuffer = buffer; bound.feedbackBytes = size; },
    bindBufferBase(_target, _index, buffer) { bound.feedbackBuffer = buffer; },
    beginTransformFeedback() { bound.capturing = true; },
    endTransformFeedback() { bound.capturing = false; },
    disable() {},
    // A gather point writes its record's two cells' texels and its strength
    // bits, as the gather shader does.
    drawArrays(_mode, first, count) {
      calls.gathers.push({ vao: bound.vao, count, texture: bound.texture });
    },
    texSubImage3D(_target, _level, x, y, layer, width, height, depth, _format, _type, data, offset) {
      calls.texSubImage3D++;
      textures.get(bound.texture).values.push(Array.from(data.subarray(offset, offset + width * height * 3)));
    },
    useProgram() {},
    enable() {},
    blendEquation() {},
    blendFuncSeparate() {},
    uniformMatrix4fv() {},
    uniform1i() {},
    uniform2i() {},
    uniform2f() {},
    uniform1f() {},
    uniform3fv() {},
    drawArraysInstanced(mode, first, count, instances) {
      calls.draws.push({ vao: bound.vao, texture: bound.texture, count, instances });
    },
  };
  return { gl, live, stores, textures, calls };
}

function makeGraph(cellCount, edgeCount, seed = 3) {
  let state = seed;
  const nextRandom = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const pairs = new Set();
  while (pairs.size < edgeCount) {
    const a = nextRandom() % cellCount;
    const b = nextRandom() % cellCount;
    if (a !== b) pairs.add(Math.min(a, b) * cellCount + Math.max(a, b));
  }
  const sorted = Array.from(pairs).sort((x, y) => x - y);
  return connectivityEdgesFromPairs(
    sorted.map(key => Math.floor(key / cellCount)),
    sorted.map(key => key % cellCount),
    cellCount,
    sorted.map((_key, index) => 1 + (index % 7)),
  );
}

const FRAME = Object.freeze({
  mvpMatrix: new Float32Array(16),
  modelViewMatrix: new Float32Array(16),
  widthPx: 100,
  heightPx: 100,
  lineWidth: 1,
  lineColor: new Float32Array(3),
  lineAlpha: 1,
  fogDensity: 0,
  fogNear: 0,
  fogFar: 1,
});

function setup({ cellCount = 400, edgeCount = 3000, dimension = 3 } = {}) {
  const fake = createFakeGl();
  const graph = makeGraph(cellCount, edgeCount);
  const geometry = {
    positions: Float32Array.from({ length: cellCount * dimension }, (_value, index) => index * 0.5 - 7),
    dimension,
    generation: 1,
  };
  const jobs = [];
  const counts = [];
  const retained = new Set();
  const layer = createConnectivityEdgeLayer({
    gl: fake.gl,
    getViewGeometry: () => geometry,
    retainsPositions: positions => retained.has(positions),
    onVisibleCount: (viewId, stats) => counts.push([viewId, stats.visibleCount]),
    schedule: callback => { jobs.push(callback); return callback; },
    cancel: handle => { const index = jobs.indexOf(handle); if (index >= 0) jobs.splice(index, 1); },
  });
  layer.setGraph(graph);
  layer.addView('live');
  const runJobs = () => { while (jobs.length > 0) jobs.shift()(); };
  return { ...fake, graph, geometry, layer, jobs, runJobs, counts, retained };
}

/** The selection records last uploaded (the gather writes the instance records on the GPU). */
function records(fake) {
  return fake.stores.get(fake.calls.lastSubData);
}

const bitsOf = value => new Uint32Array(Float32Array.of(value).buffer)[0];

test('a pane draws exactly the first K edges of the order, each record holding its endpoint cells and strength', () => {
  const fake = setup({ dimension: 2 });
  const { layer, graph } = fake;
  layer.setVisibleTarget(250);
  layer.refresh('live');
  assert.equal(layer.draw('live', FRAME), 250);
  const order = createConnectivityEdgeOrder(graph.nEdges);
  const stored = records(fake);
  for (let index = 0; index < 250; index++) {
    const edge = order.at(index);
    assert.deepEqual(
      Array.from(stored.subarray(index * 3, index * 3 + 3)),
      [edgeListOf(graph).sources[edge], edgeListOf(graph).destinations[edge], bitsOf((1 + (edge % 7)) / 7)],
    );
  }
  assert.equal(fake.calls.draws.at(-1).count, 4);
  assert.equal(fake.calls.draws.at(-1).instances, 250);
  // One gather point an edge, reading the geometry's position texture.
  assert.equal(fake.calls.gathers.at(-1).count, 250);
  assert.deepEqual(fake.calls.varyings, ['v_source', 'v_destination', 'v_strength']);
});

test('the positions texture holds the pane geometry bit for bit, one texel a cell', () => {
  const fake = setup({ cellCount: 150, edgeCount: 600, dimension: 3 });
  const { layer, geometry } = fake;
  layer.refresh('live');
  layer.draw('live', FRAME);
  assert.equal(fake.textures.size, 1);
  const [texture] = fake.textures.values();
  assert.equal(texture.format, fake.gl.RGB32F);
  // 150 cells in rows of 64 texels: two full rows, then the partial last row.
  assert.deepEqual([texture.width, texture.height, texture.depth], [64, 3, 1]);
  assert.deepEqual(texture.values.flat(), Array.from(geometry.positions));
});

test('GPU memory is K records a pane plus one position texture a geometry; a camera move uploads and gathers nothing', () => {
  const fake = setup({ cellCount: 2000, edgeCount: 20_000 });
  const { layer } = fake;
  layer.setVisibleTarget(1000);
  layer.refresh('live');
  layer.draw('live', FRAME);
  assert.equal(CONNECTIVITY_RECORD_BYTES, 12);
  const memory = layer.describeMemory();
  // 12 bytes of selection record and 28 of instance record an edge.
  assert.equal(memory.panes[0].gpuBytes, 1000 * 40);
  assert.equal(memory.positionTextureBytes, 64 * 32 * 3 * 4);
  assert.equal(memory.gpuBytes, 1000 * 40 + memory.positionTextureBytes);
  const before = { ...fake.calls, draws: fake.calls.draws.length, gathers: fake.calls.gathers.length };
  layer.draw('live', FRAME);
  layer.draw('live', FRAME);
  assert.equal(fake.calls.bufferData, before.bufferData);
  assert.equal(fake.calls.bufferSubData, before.bufferSubData);
  assert.equal(fake.calls.texSubImage3D, before.texSubImage3D);
  assert.equal(fake.calls.gathers.length, before.gathers);
});

test('a filter re-selects the first K visible edges; the visible count is reported once known', () => {
  const fake = setup();
  const { layer, graph, runJobs, counts } = fake;
  layer.setVisibleTarget(100);
  const transparency = Uint8Array.from({ length: graph.nCells }, (_value, cell) => (cell % 3 === 0 ? 0 : 1));
  layer.publishVisibility('live', { transparency, admissionLevels: null, lodLevel: -1 });
  const stats = layer.refresh('live');
  assert.equal(stats.current, true);
  const order = createConnectivityEdgeOrder(graph.nEdges);
  let visible = 0;
  const shown = [];
  for (let rank = 0; rank < graph.nEdges; rank++) {
    const edge = order.at(rank);
    if (transparency[edgeListOf(graph).sources[edge]] && transparency[edgeListOf(graph).destinations[edge]]) {
      visible++;
      if (shown.length < 100) shown.push(edge);
    }
  }
  assert.equal(stats.shownCount, shown.length);
  layer.draw('live', FRAME);
  const stored = records(fake);
  shown.forEach((edge, index) => {
    assert.equal(stored[index * 3], edgeListOf(graph).sources[edge]);
    assert.equal(stored[index * 3 + 1], edgeListOf(graph).destinations[edge]);
  });
  assert.ok(stats.visibleCount === null || stats.visibleCount === visible);
  assert.deepEqual(counts, [], 'the count is reported off the interactive path');
  runJobs();
  assert.deepEqual(counts, [['live', visible]]);
  assert.equal(layer.getStats('live').visibleCount, visible);
});

test('a newer visibility supersedes a running count; every cell visible counts without a pass', () => {
  const fake = setup();
  const { layer, graph, runJobs, counts, jobs } = fake;
  runJobs();
  layer.setVisibleTarget(10);
  layer.publishVisibility('live', {
    transparency: Uint8Array.from({ length: graph.nCells }, (_value, cell) => cell % 2), admissionLevels: null, lodLevel: -1,
  });
  layer.refresh('live');
  assert.equal(jobs.length, 1);
  layer.publishVisibility('live', {
    transparency: new Uint8Array(graph.nCells).fill(1), admissionLevels: null, lodLevel: -1,
  });
  assert.equal(jobs.length, 0, 'the superseded count is cancelled');
  assert.equal(layer.refresh('live').visibleCount, graph.nEdges);
  runJobs();
  assert.deepEqual(counts, [['live', graph.nEdges]]);
});

test('a geometry change uploads the new positions once and no records, and gathers again; the selection is kept', () => {
  const fake = setup();
  const { layer, geometry, retained } = fake;
  layer.setVisibleTarget(50);
  layer.refresh('live');
  layer.draw('live', FRAME);
  const uploads = fake.calls.bufferSubData;
  const first = geometry.positions;
  const [firstTexture] = fake.textures.keys();
  retained.add(first);
  geometry.positions = geometry.positions.map(value => value * 2);
  geometry.generation = 2;
  layer.draw('live', FRAME);
  assert.equal(fake.calls.bufferSubData, uploads, 'selection records do not depend on positions');
  assert.equal(fake.textures.size, 2, 'the first texture stays while the renderer holds its geometry');
  const second = [...fake.textures.keys()].find(texture => texture !== firstTexture);
  assert.equal(fake.calls.gathers.at(-1).texture, second);
  assert.deepEqual(fake.textures.get(second).values.flat(), Array.from(geometry.positions));
  // Back to the first positions: nothing is uploaded.
  const textureUploads = fake.calls.texSubImage3D;
  geometry.positions = first;
  layer.draw('live', FRAME);
  assert.equal(fake.calls.texSubImage3D, textureUploads);
  assert.equal(fake.calls.gathers.at(-1).texture, firstTexture);
  // Once the renderer lets go of a geometry no pane draws, its texture goes.
  retained.delete(first);
  geometry.positions = first.map(value => value * 3);
  layer.draw('live', FRAME);
  assert.equal(fake.textures.has(firstTexture), false);
  assert.equal(fake.textures.has(second), false);
  assert.equal(fake.textures.size, 1);
});

test('panes are independent; deleting a pane or clearing frees its GPU objects', () => {
  const fake = setup();
  const { layer } = fake;
  layer.addView('snap_1');
  layer.setVisibleTarget(20);
  layer.refresh('live');
  layer.refresh('snap_1');
  layer.draw('live', FRAME);
  layer.draw('snap_1', FRAME);
  assert.equal(fake.live.vaos.size, 4, 'a gather and a draw vertex array a pane');
  assert.equal(fake.live.textures.size, 1, 'panes over one geometry share its texture');
  layer.deleteView('snap_1');
  assert.equal(fake.live.vaos.size, 2);
  assert.equal(fake.live.textures.size, 1);
  layer.clear();
  assert.equal(fake.live.vaos.size, 0);
  assert.equal(fake.live.textures.size, 0);
  assert.equal(layer.hasGraph(), false);
  layer.dispose();
  assert.equal(fake.live.buffers.size, 0);
  assert.equal(fake.live.programs.size, 0);
  assert.equal(fake.live.feedbacks.size, 0);
});

test('the graph is kept as the reader worker built it, records already in draw order', () => {
  const fake = setup({ edgeCount: 5000 });
  const { layer, graph, jobs } = fake;
  const recordsBefore = graph.records.slice();
  // No background ordering: nothing is scheduled by publishing a graph.
  assert.equal(jobs.length, 0);
  layer.setVisibleTarget(5000);
  layer.refresh('live');
  layer.draw('live', FRAME);
  assert.deepEqual(graph.records, recordsBefore, 'the records are never rewritten');
  const memory = layer.describeMemory();
  // 12 bytes of record and 8 of neighbours an edge, two offsets a cell.
  assert.equal(memory.graphBytes, graph.nEdges * 20 + (graph.nCells + 1) * 8);
});

test('a new graph shows the default K, and a pane draws on its first frame without a refresh', () => {
  const fake = setup({ edgeCount: 3000 });
  const { layer } = fake;
  assert.equal(CONNECTIVITY_DEFAULT_VISIBLE_TARGET, 250_000);
  assert.equal(layer.getVisibleTarget(), 3000, 'min(edges, the default)');
  // Never refreshed: the first draw selects.
  assert.equal(layer.draw('live', FRAME), 3000);
  layer.addView('snap_1');
  assert.equal(layer.draw('snap_1', FRAME), 3000);
});
