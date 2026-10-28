/**
 * Replacing the live tree is a CPU publication. The live position store keeps
 * the draw order it holds -- complete and consistent -- until the next render
 * adopts the new tree's order (`_ensureLiveDrawOrder`), and only that adoption
 * retires the old permutation texture, after the new one is accepted. A failed
 * build therefore changes nothing a frame can observe.
 */
import { StoreOrder } from '../assets/js/rendering/high-perf/store-order.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getNotificationCenter,
} from '../assets/js/app/notification-center.js';
import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';
import { SpatialIndex } from '../assets/js/rendering/high-perf/spatial-index.js';
import { createCpuPermuter } from './helpers/cpu-permuter.mjs';

const DIMENSION = 2;

function makePositions(pointCount) {
  const positions = new Float32Array(pointCount * DIMENSION);
  for (let index = 0; index < pointCount; index++) {
    const offset = index * DIMENSION;
    positions[offset] = ((index % 101) - 50) / 25;
    positions[offset + 1] = ((Math.floor(index / 101) % 101) - 50) / 25;
  }
  return positions;
}

function makeColors(pointCount) {
  const colors = new Uint8Array(pointCount * 4);
  for (let index = 0; index < pointCount; index++) {
    colors[index * 4] = (index * 13) & 0xff;
    colors[index * 4 + 3] = 255;
  }
  return colors;
}

function replaceCalculationNotifications(t) {
  const notifications = getNotificationCenter();
  const previous = {
    completeCalculation: notifications.completeCalculation,
    failCalculation: notifications.failCalculation,
    hasNotification: notifications.hasNotification,
    startCalculation: notifications.startCalculation,
  };
  let nextId = 1;
  const settled = [];
  Object.assign(notifications, {
    completeCalculation(id) { settled.push(['complete', id]); },
    failCalculation(id) { settled.push(['fail', id]); },
    hasNotification: () => true,
    startCalculation: () => `spatial-transaction-${nextId++}`,
  });
  t.after(() => Object.assign(notifications, previous));
  return settled;
}

function createTrackingGl() {
  let nextId = 1;
  const live = { buffers: new Set(), textures: new Set() };
  const deleted = [];
  const writes = [];
  const adopt = (kind, set, label) => {
    const handle = Object.freeze({ id: label ?? `${kind}-${nextId++}`, kind });
    set.add(handle);
    return handle;
  };
  return {
    ARRAY_BUFFER: 0x8892,
    CLAMP_TO_EDGE: 0x812f,
    COPY_READ_BUFFER: 0x8f36,
    COPY_WRITE_BUFFER: 0x8f37,
    DYNAMIC_DRAW: 0x88e8,
    STATIC_DRAW: 0x88e4,
    MAX_TEXTURE_SIZE: 0x0d33,
    NEAREST: 0x2600,
    NO_ERROR: 0,
    R32UI: 0x8236,
    RED_INTEGER: 0x8d94,
    TEXTURE_2D: 0x0de1,
    TEXTURE_2D_ARRAY: 0x8c1a,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    UNSIGNED_INT: 0x1405,
    bindBuffer() {},
    bindTexture() {},
    bufferData() { writes.push({ kind: 'allocate' }); },
    bufferSubData(target, offset, data) { writes.push({ kind: 'buffer', offset, bytes: data.byteLength }); },
    copyBufferSubData() { writes.push({ kind: 'copy' }); },
    createBuffer() { return adopt('buffer', live.buffers); },
    createTexture() { return adopt('texture', live.textures); },
    deleteBuffer(handle) { deleted.push(handle); live.buffers.delete(handle); },
    deleteTexture(handle) { deleted.push(handle); live.textures.delete(handle); },
    deleteVertexArray(handle) { deleted.push(handle); },
    getError() { return this.NO_ERROR; },
    getParameter() { return 4096; },
    isBuffer(handle) { return live.buffers.has(handle); },
    isTexture(handle) { return live.textures.has(handle); },
    isVertexArray() { return false; },
    texImage2D() { writes.push({ kind: 'texture' }); },
    texStorage2D() { writes.push({ kind: 'texture' }); },
    texParameteri() {},
    texSubImage2D() { writes.push({ kind: 'texture' }); },
    texStorage3D() { writes.push({ kind: 'texture' }); },
    texSubImage3D() { writes.push({ kind: 'texture' }); },
    _adoptBuffer(label) { return adopt('buffer', live.buffers, label); },
    _adoptTexture(label) { return adopt('texture', live.textures, label); },
    _state: { deleted, live, writes },
  };
}

function createFixture({ pointCount, staleTree }) {
  const gl = createTrackingGl();
  const positions = makePositions(pointCount);
  const colors = makeColors(pointCount);
  const oldTree = new SpatialIndex(
    staleTree ? positions.slice() : positions,
    null,
    DIMENSION,
    pointCount,
    2,
    { buildLOD: false },
  );
  oldTree.ensureDrawOrder();
  const oldOrderTexture = gl._adoptTexture('old-draw-order');
  const oldOrder = new StoreOrder({
    pointCount,
    target: oldTree.drawOrder,
    adopted: pointCount,
    base: null,
    baseEnd: pointCount,
    map: { texture: oldOrderTexture, plan: null, byteLength: pointCount * 4 },
    ranked: false,
  });
  const oldBoundingSphere = Object.freeze({ center: [0, 0, 0], radius: 99 });
  const perViewState = new Map([['live', { id: 'live' }], ['snapshot-a', { id: 'snapshot-a' }]]);
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    gl,
    _permuter: createCpuPermuter(gl),
    options: { LOD_MAX_DEPTH: 2, LOD_MAX_POINTS_PER_NODE: pointCount },
    useAdaptiveLOD: true,
    useFrustumCulling: true,
    forceLODLevel: 3,
    buffers: {
      colors: gl._adoptBuffer('main-colors'),
      positions: gl._adoptBuffer('main-positions'),
    },
    currentDimensionLevel: DIMENSION,
    pointCount,
    spatialIndices: new Map([[DIMENSION, oldTree]]),
    _boundingSphere: oldBoundingSphere,
    _colors: colors,
    _liveOrder: oldOrder,
    _liveColorOrder: oldTree.drawOrder,
    _pendingDataRetirements: new Set(),
    _pendingSnapshotRetirements: new Set(),
    _colorGpuByteLength: colors.byteLength,
    _perViewState: perViewState,
    _positions: positions,
    _snapshotGeometryPools: new Map(),
    _validatedSpatialIndices: new WeakSet(),
    snapshotBuffers: new Map(),
    stats: { gpuMemoryMB: 0 },
  });
  return { gl, oldBoundingSphere, oldOrder, oldTree, perViewState, renderer };
}

function assertUntouched(fixture) {
  const { gl, oldBoundingSphere, oldOrder, oldTree, perViewState, renderer } = fixture;
  assert.strictEqual(renderer.spatialIndices.get(DIMENSION), oldTree);
  assert.strictEqual(renderer._liveOrder, oldOrder);
  assert.strictEqual(renderer._boundingSphere, oldBoundingSphere);
  assert.strictEqual(renderer._perViewState, perViewState);
  assert.equal(renderer._perViewState.size, 2);
  assert.equal(renderer.forceLODLevel, 3);
  assert.equal(gl._state.live.textures.has(oldOrder.texture), true);
  assert.deepEqual(gl._state.deleted, []);
  assert.deepEqual(gl._state.writes, [], 'a failed build uploads nothing');
  assert.equal(renderer._pendingDataRetirements.size, 0);
}

test('failed stale spatial-index replacement preserves every exact publication surface', t => {
  const settled = replaceCalculationNotifications(t);
  const fixture = createFixture({ pointCount: 64, staleTree: true });
  // A tree the build refuses (maxDepth must be a positive integer).
  fixture.renderer.options = { LOD_MAX_DEPTH: 0, LOD_MAX_POINTS_PER_NODE: 64 };

  assert.throws(
    () => fixture.renderer._getOrBuildSpatialIndexForDimension(DIMENSION, false),
    /maxDepth must be a positive integer/,
  );
  assertUntouched(fixture);
  assert.deepEqual(settled.map(([kind]) => kind), ['fail']);
});

test('successful stale spatial-index replacement publishes the tree and defers the GPU order to the next render', t => {
  replaceCalculationNotifications(t);
  const fixture = createFixture({ pointCount: 64, staleTree: true });
  const { gl, oldOrder, oldTree, renderer } = fixture;

  const published = renderer._getOrBuildSpatialIndexForDimension(DIMENSION, false);

  assert.notStrictEqual(published, oldTree);
  assert.strictEqual(renderer.spatialIndices.get(DIMENSION), published);
  // Adaptive LOD builds the levels: 64 cells are below the first ladder
  // count, so one level of every cell, in a banded order.
  assert.equal(published.lodLevels.length, 1);
  assert.ok(published.drawOrder.levelBands instanceof Uint8Array);
  // The store still holds the old order, whole: nothing was uploaded or retired.
  assert.strictEqual(renderer._liveOrder, oldOrder);
  assert.deepEqual(gl._state.deleted, []);
  assert.deepEqual(gl._state.writes, []);

  // Adoption rewrites both streams in place on the GPU (one pass a stream:
  // the stand-in's one write each), then retires the old texture (the
  // retired record lets go of its handle). The live stores themselves are kept.
  const oldTexture = oldOrder.texture;
  const adopted = renderer._ensureStoreDrawOrder({ kind: 'live' }, published);
  assert.strictEqual(renderer._liveOrder, adopted);
  assert.strictEqual(adopted.drawOrder, published.drawOrder);
  assert.equal(renderer._permuter.wordWrites[DIMENSION] + renderer._permuter.wordWrites[1], 2);
  assert.deepEqual(
    gl._state.deleted.filter(handle => handle.kind === 'texture'),
    [oldTexture],
  );
  assert.equal(oldOrder.texture, null);
  assert.equal(gl._state.live.buffers.has(renderer.buffers.positions), true);
  assert.equal(gl._state.live.buffers.has(renderer.buffers.colors), true);
  assert.equal(gl._state.live.textures.has(adopted.texture), true);
  // A second adoption of the same order is free.
  const writes = gl._state.writes.length;
  assert.strictEqual(renderer._ensureStoreDrawOrder({ kind: 'live' }, published), adopted);
  assert.equal(gl._state.writes.length, writes);
});
