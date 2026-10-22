/**
 * Connectivity edges hold the graph on the CPU as loaded and send each pane
 * only its K shown edges, one 28-byte instance record each
 * (rendering/connectivity-edge-layer.js).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONNECTIVITY_DEFAULT_VISIBLE_TARGET,
  CONNECTIVITY_INSTANCE_FLOATS,
  createConnectivityEdgeLayer,
} from '../assets/js/rendering/connectivity-edge-layer.js';
import {
  createConnectivityEdgeOrder,
  selectVisibleConnectivityEdges,
} from '../assets/js/rendering/connectivity-edge-selection.js';

function createFakeGl() {
  let next = 1;
  const live = { buffers: new Set(), vaos: new Set(), programs: new Set() };
  const stores = new Map();
  const bound = { array: null, vao: null };
  const calls = { bufferData: 0, bufferSubData: 0, draws: [] };
  const gl = {
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
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
    createBuffer() {
      const buffer = { id: next++ };
      live.buffers.add(buffer);
      return buffer;
    },
    deleteBuffer(buffer) { live.buffers.delete(buffer); stores.delete(buffer); },
    bindBuffer(_target, buffer) { bound.array = buffer; },
    bufferData(_target, data) {
      calls.bufferData++;
      stores.set(bound.array, typeof data === 'number' ? new Float32Array(data / 4) : Float32Array.from(data));
    },
    bufferSubData(_target, offset, data, srcOffset, length) {
      calls.bufferSubData++;
      stores.get(bound.array).set(data.subarray(srcOffset, srcOffset + length), offset / 4);
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
    vertexAttribDivisor() {},
    useProgram() {},
    enable() {},
    blendEquation() {},
    blendFuncSeparate() {},
    uniformMatrix4fv() {},
    uniform2f() {},
    uniform1f() {},
    uniform3fv() {},
    drawArraysInstanced(mode, first, count, instances) {
      calls.draws.push({ vao: bound.vao, count, instances });
    },
  };
  return { gl, live, stores, calls };
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
  return {
    sources: Uint32Array.from(sorted, key => Math.floor(key / cellCount)),
    destinations: Uint32Array.from(sorted, key => key % cellCount),
    weights: Float64Array.from(sorted, (_key, index) => 1 + (index % 7)),
    nEdges: sorted.length,
    nCells: cellCount,
  };
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
  const layer = createConnectivityEdgeLayer({
    gl: fake.gl,
    getViewGeometry: () => geometry,
    onVisibleCount: (viewId, stats) => counts.push([viewId, stats.visibleCount]),
    schedule: callback => { jobs.push(callback); return callback; },
    cancel: handle => { const index = jobs.indexOf(handle); if (index >= 0) jobs.splice(index, 1); },
  });
  layer.setGraph(graph);
  layer.addView('live');
  const runJobs = () => { while (jobs.length > 0) jobs.shift()(); };
  return { ...fake, graph, geometry, layer, jobs, runJobs, counts };
}

/** The instance store of the only pane drawn (the largest store; the quad is 8 floats). */
function records(fake) {
  let largest = null;
  for (const store of fake.stores.values()) {
    if (largest === null || store.length > largest.length) largest = store;
  }
  return largest;
}

test('a pane draws exactly the first K edges of the order, each record holding its endpoints and strength', () => {
  const fake = setup({ dimension: 2 });
  const { layer, graph, geometry } = fake;
  layer.setVisibleTarget(250);
  layer.refresh('live');
  assert.equal(layer.draw('live', FRAME), 250);
  const order = createConnectivityEdgeOrder(graph.nEdges);
  const stored = records(fake);
  const maxWeight = Math.max(...graph.weights);
  for (let index = 0; index < 250; index++) {
    const edge = order.at(index);
    const out = index * CONNECTIVITY_INSTANCE_FLOATS;
    const s = graph.sources[edge] * 2;
    const d = graph.destinations[edge] * 2;
    assert.deepEqual(
      Array.from(stored.subarray(out, out + 7)),
      [
        geometry.positions[s], geometry.positions[s + 1], 0,
        geometry.positions[d], geometry.positions[d + 1], 0,
        Math.fround(graph.weights[edge] / maxWeight),
      ],
    );
  }
  assert.deepEqual(fake.calls.draws.at(-1), { vao: fake.calls.draws.at(-1).vao, count: 4, instances: 250 });
});

test('GPU memory is K records a pane, whatever the graph size; a camera move uploads nothing', () => {
  const fake = setup({ cellCount: 2000, edgeCount: 20_000 });
  const { layer } = fake;
  layer.setVisibleTarget(1000);
  layer.refresh('live');
  layer.draw('live', FRAME);
  assert.equal(layer.describeMemory().gpuBytes, 1000 * 28);
  const before = { ...fake.calls, draws: fake.calls.draws.length };
  layer.draw('live', FRAME);
  layer.draw('live', FRAME);
  assert.equal(fake.calls.bufferData, before.bufferData);
  assert.equal(fake.calls.bufferSubData, before.bufferSubData);
});

test('a filter re-selects the first K visible edges; the visible count lands later, in slices', () => {
  const fake = setup();
  const { layer, graph, runJobs, counts } = fake;
  layer.setVisibleTarget(100);
  const transparency = Uint8Array.from({ length: graph.nCells }, (_value, cell) => (cell % 3 === 0 ? 0 : 1));
  const visibility = { transparency, admissionLevels: null, lodLevel: -1 };
  layer.publishVisibility('live', visibility);
  const stats = layer.refresh('live');
  assert.equal(stats.current, true);
  assert.equal(stats.visibleCount, null, 'the count is not on the interactive path');
  const expected = new Uint32Array(100);
  const selected = selectVisibleConnectivityEdges(
    createConnectivityEdgeOrder(graph.nEdges), graph.sources, graph.destinations, visibility, 100, expected,
  );
  assert.equal(stats.shownCount, selected);
  runJobs();
  let visible = 0;
  for (let edge = 0; edge < graph.nEdges; edge++) {
    if (transparency[graph.sources[edge]] && transparency[graph.destinations[edge]]) visible++;
  }
  assert.deepEqual(counts, [['live', visible]]);
  assert.equal(layer.getStats('live').visibleCount, visible);
});

test('a newer visibility supersedes a running count; every cell visible counts without a pass', () => {
  const fake = setup();
  const { layer, graph, runJobs, counts, jobs } = fake;
  layer.setVisibleTarget(10);
  layer.publishVisibility('live', {
    transparency: new Uint8Array(graph.nCells).fill(0), admissionLevels: null, lodLevel: -1,
  });
  layer.refresh('live');
  assert.equal(jobs.length, 1);
  layer.publishVisibility('live', {
    transparency: new Uint8Array(graph.nCells).fill(1), admissionLevels: null, lodLevel: -1,
  });
  assert.equal(jobs.length, 0, 'the superseded count is cancelled');
  layer.refresh('live');
  runJobs();
  assert.deepEqual(counts, [['live', graph.nEdges]]);
});

test('a geometry change re-gathers records from the new positions; the selection is kept', () => {
  const fake = setup();
  const { layer, geometry } = fake;
  layer.setVisibleTarget(50);
  layer.refresh('live');
  layer.draw('live', FRAME);
  const uploads = fake.calls.bufferSubData;
  geometry.positions = geometry.positions.map(value => value * 2);
  geometry.generation = 2;
  layer.draw('live', FRAME);
  assert.equal(fake.calls.bufferSubData, uploads + 1);
  const stored = records(fake);
  const order = createConnectivityEdgeOrder(fake.graph.nEdges);
  const edge = order.at(0);
  assert.equal(stored[0], geometry.positions[fake.graph.sources[edge] * 3]);
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
  assert.equal(fake.live.vaos.size, 2);
  layer.deleteView('snap_1');
  assert.equal(fake.live.vaos.size, 1);
  layer.clear();
  assert.equal(fake.live.vaos.size, 0);
  assert.equal(layer.hasGraph(), false);
  layer.dispose();
  assert.equal(fake.live.buffers.size, 0);
  assert.equal(fake.live.programs.size, 0);
});

test('the layer keeps no shuffled copy and no per-edge GPU storage', () => {
  const fake = setup({ edgeCount: 5000 });
  const { layer, graph } = fake;
  const sourcesBefore = graph.sources.slice();
  layer.setVisibleTarget(5000);
  layer.refresh('live');
  layer.draw('live', FRAME);
  assert.deepEqual(graph.sources, sourcesBefore, 'endpoints are never reordered');
  const memory = layer.describeMemory();
  assert.equal(memory.graphBytes, graph.nEdges * 12);
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
