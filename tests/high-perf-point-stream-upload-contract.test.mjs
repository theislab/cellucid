/**
 * Point positions and colors are two separate vertex streams.
 *
 * In source order each stream is published straight from the published typed
 * array — Float32 XYZ at 12 bytes a point, RGBA8 at 4 — so nothing is repacked
 * and no client-side copy of either exists. A recolor rewrites only the color
 * stream, in place; the positions beside it are never re-sent. A geometry with
 * a tree stores its points in the tree's draw order, gathered on the GPU
 * through the order's permutation texture (`GpuPermuter`; a CPU stand-in
 * writes the same bytes here), in one pass a store and with no CPU staging;
 * the bytes must be identical to a whole-buffer gather at counts around the
 * old 65,536-point chunk edge too.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';
import { createCpuPermuter } from './helpers/cpu-permuter.mjs';
import { bufferOf, vaoOf } from './helpers/point-stores.mjs';
import { SegmentedVertexArray } from '../assets/js/rendering/high-perf/point-store-segments.js';
import { StoreOrder } from '../assets/js/rendering/high-perf/store-order.js';

const CHUNK_POINTS = 65_536;

/** Point counts around, on, and far from the chunk boundary. */
const POINT_COUNTS = Object.freeze([
  1,
  CHUNK_POINTS - 1,
  CHUNK_POINTS,
  CHUNK_POINTS + 1,
  2 * CHUNK_POINTS,
  2 * CHUNK_POINTS + 7,
]);

function makePositions(pointCount) {
  const positions = new Float32Array(pointCount * 3);
  for (let index = 0; index < pointCount; index++) {
    positions[index * 3] = index * 0.5 - 1;
    positions[index * 3 + 1] = 2 - index * 0.25;
    positions[index * 3 + 2] = (index % 97) * 0.125;
  }
  return positions;
}

function makeColors(pointCount) {
  const colors = new Uint8Array(pointCount * 4);
  for (let index = 0; index < pointCount; index++) {
    colors[index * 4] = index % 251;
    colors[index * 4 + 1] = (index * 7) % 253;
    colors[index * 4 + 2] = (index * 13) % 249;
    colors[index * 4 + 3] = (index * 3) % 256;
  }
  return colors;
}

/** A deterministic gather order over `[0, pointCount)`, standing in for a draw order. */
/** A store holding the order `indices` whole, as `_createStoreOrder` returns it. */
function makeRecord(indices) {
  return new StoreOrder({
    pointCount: indices.length,
    target: { indices, pointCount: indices.length },
    adopted: indices.length,
    base: null,
    baseEnd: indices.length,
    map: { texture: {}, plan: null, byteLength: indices.length * 4 },
    ranked: false,
  });
}

function makeOrder(count, pointCount) {
  const order = new Uint32Array(count);
  for (let slot = 0; slot < count; slot++) {
    order[slot] = (slot * 7919 + 13) % pointCount;
  }
  return order;
}

function bytesOf(view) {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** Byte equality without a diff of megabytes when it fails. */
function cellsEqual(left, right) {
  if (!(left instanceof Uint8Array) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * A WebGL2 double that models a buffer's data store the way the real one
 * behaves: `bufferData` with a byte length allocates a zero-filled store,
 * `bufferData` with a view copies it, and `bufferSubData` writes into the
 * store at a byte offset, counting `srcOffset`/`length` in source elements.
 */
function createStoreTrackingGl({ maxTextureSize = 16_384, maxArrayLayers = 256 } = {}) {
  let nextId = 1;
  let boundArrayBuffer = null;
  let boundVertexArray = null;
  let pendingError = 0;
  const stores = new Map();
  const calls = { bufferData: [], bufferSubData: [], texImage2D: [], texSubImage2D: [] };
  const attributes = new Map();
  const created = { buffers: [], textures: [], vertexArrays: [] };
  const failures = { allocationError: 0 };

  const gl = {
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
    NO_ERROR: 0,
    OUT_OF_MEMORY: 0x0505,
    STATIC_DRAW: 0x88e4,
    UNSIGNED_BYTE: 0x1401,

    bindBuffer(target, buffer) {
      assert.equal(target, gl.ARRAY_BUFFER);
      boundArrayBuffer = buffer;
    },
    bindVertexArray(vao) {
      boundVertexArray = vao;
    },
    bufferData(target, dataOrSize, usage) {
      assert.equal(target, gl.ARRAY_BUFFER);
      assert.notEqual(boundArrayBuffer, null);
      calls.bufferData.push({
        buffer: boundArrayBuffer,
        data: typeof dataOrSize === 'number' ? null : dataOrSize,
        size: typeof dataOrSize === 'number'
          ? dataOrSize
          : dataOrSize.byteLength,
        usage,
      });
      if (failures.allocationError !== 0) {
        pendingError = failures.allocationError;
        return;
      }
      stores.set(
        boundArrayBuffer,
        typeof dataOrSize === 'number'
          ? new Uint8Array(dataOrSize)
          : Uint8Array.from(bytesOf(dataOrSize)),
      );
    },
    bufferSubData(target, dstByteOffset, srcData, srcOffset = 0, length) {
      assert.equal(target, gl.ARRAY_BUFFER);
      const store = stores.get(boundArrayBuffer);
      assert.ok(store instanceof Uint8Array, 'bufferSubData before allocation');
      assert.ok(ArrayBuffer.isView(srcData));
      const elementBytes = srcData.BYTES_PER_ELEMENT;
      const start = srcOffset * elementBytes;
      const count = length === undefined
        ? srcData.byteLength - start
        : length * elementBytes;
      assert.ok(
        dstByteOffset + count <= store.byteLength,
        'bufferSubData writes past the end of the store',
      );
      store.set(bytesOf(srcData).subarray(start, start + count), dstByteOffset);
      calls.bufferSubData.push({
        buffer: boundArrayBuffer,
        dstByteOffset,
        length: count,
        sourceBuffer: srcData.buffer,
      });
    },
    createBuffer() {
      const handle = { id: nextId++, kind: 'buffer' };
      created.buffers.push(handle);
      return handle;
    },
    createTexture() {
      const handle = { id: nextId++, kind: 'texture' };
      created.textures.push(handle);
      return handle;
    },
    createVertexArray() {
      const handle = { id: nextId++, kind: 'vao' };
      created.vertexArrays.push(handle);
      return handle;
    },
    enableVertexAttribArray() {},
    // The draw-order permutation texture (R32UI).
    R32UI: 0x8236,
    RED_INTEGER: 0x8d94,
    UNSIGNED_INT: 0x1405,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    bindTexture() {},
    texParameteri() {},
    texImage2D(target, level, internal, width, height, border, format, type, data) {
      calls.texImage2D.push({ width, height, data });
    },
    texSubImage2D(target, level, x, y, width, height, format, type, data) {
      calls.texSubImage2D.push({ x, y, width, height, data: Uint32Array.from(data) });
    },
    getError() {
      const error = pendingError;
      pendingError = gl.NO_ERROR;
      return error;
    },
    getParameter(parameter) {
      if (parameter === gl.MAX_ARRAY_TEXTURE_LAYERS) return maxArrayLayers;
      assert.equal(parameter, gl.MAX_TEXTURE_SIZE);
      return maxTextureSize;
    },
    vertexAttribPointer(location, size, type, normalized, stride, offset) {
      attributes.set(location, {
        buffer: boundArrayBuffer,
        normalized,
        offset,
        size,
        stride,
        type,
        vao: boundVertexArray,
      });
    },
  };

  return { attributes, calls, created, failures, gl, stores };
}

function createStreamFixture(pointCount, options = {}) {
  const tracker = createStoreTrackingGl(options);
  const positions = makePositions(pointCount);
  const colors = makeColors(pointCount);
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    gl: tracker.gl,
    _permuter: createCpuPermuter(tracker.gl),
    buffers: {
      colors: null,
      positions: null,
    },
    pointCount,
    snapshotBuffers: new Map(),
    stats: { gpuMemoryMB: 0 },
    useAdaptiveLOD: false,
    useFrustumCulling: false,
    vao: new SegmentedVertexArray(tracker.gl),
    _colors: colors,
    _colorGpuByteLength: 0,
    _positionGpuByteLength: 0,
    _positions: positions,
  });
  renderer._refreshGpuMemoryStats = () => 0;
  return { colors, positions, renderer, tracker };
}

test('full detail publishes each stream straight from the published array', () => {
  const pointCount = CHUNK_POINTS + 5;
  const { colors, positions, renderer, tracker } =
    createStreamFixture(pointCount);

  renderer._createPointStreams(positions, colors, 3);

  const positionBuffer = bufferOf(renderer.buffers.positions);
  const colorBuffer = bufferOf(renderer.buffers.colors);
  assert.notEqual(positionBuffer, colorBuffer);
  assert.deepEqual(
    tracker.calls.bufferData.map(call => [call.buffer, call.data, call.size, call.usage]),
    [
      [positionBuffer, null, pointCount * 12, tracker.gl.STATIC_DRAW],
      [colorBuffer, null, pointCount * 4, tracker.gl.DYNAMIC_DRAW],
    ],
    'both stores are sized; their bytes go up when first needed',
  );
  assert.equal(tracker.calls.bufferSubData.length, 0);
  // Each stream crosses once, straight from the published array: the
  // positions when the store is first needed, the colors in the first frame.
  assert.equal(renderer._positionsUploadPending, true);
  renderer._flushPendingPositionUpload();
  assert.equal(renderer._positionsUploadPending, false);
  renderer._flushPendingPositionUpload();
  assert.equal(renderer._colorsDirty, true);
  renderer._publishLiveColors();
  assert.equal(renderer._colorsDirty, false);
  assert.deepEqual(tracker.calls.bufferSubData, [{
    buffer: positionBuffer,
    dstByteOffset: 0,
    length: pointCount * 12,
    sourceBuffer: positions.buffer,
  }, {
    buffer: colorBuffer,
    dstByteOffset: 0,
    length: pointCount * 4,
    sourceBuffer: colors.buffer,
  }]);
  assert.ok(cellsEqual(tracker.stores.get(positionBuffer), bytesOf(positions)));
  assert.ok(cellsEqual(tracker.stores.get(colorBuffer), bytesOf(colors)));
  assert.equal(renderer._positionGpuByteLength, pointCount * 12);
  assert.equal(renderer._colorGpuByteLength, pointCount * 4);
  // Nothing was staged on the client.

  assert.deepEqual(tracker.attributes.get(0), {
    buffer: positionBuffer,
    normalized: false,
    offset: 0,
    size: 3,
    stride: 12,
    type: tracker.gl.FLOAT,
    vao: vaoOf(renderer.vao),
  });
  assert.deepEqual(tracker.attributes.get(1), {
    buffer: colorBuffer,
    normalized: true,
    offset: 0,
    size: 4,
    stride: 4,
    type: tracker.gl.UNSIGNED_BYTE,
    vao: vaoOf(renderer.vao),
  });
});

test('a 2D or 1D embedding publishes only its own components, with no padded axis', () => {
  for (const dimension of [1, 2]) {
    const pointCount = CHUNK_POINTS + 9;
    const { colors, renderer, tracker } = createStreamFixture(pointCount);
    const positions = new Float32Array(pointCount * dimension).map(
      (_, index) => index * 0.25 - 3,
    );
    renderer._positions = positions;
    renderer._createPointStreams(positions, colors, dimension);
    renderer._flushPendingPositionUpload();
    const positionBuffer = bufferOf(renderer.buffers.positions);
    assert.ok(cellsEqual(tracker.stores.get(positionBuffer), bytesOf(positions)));
    assert.equal(
      renderer._positionGpuByteLength,
      pointCount * dimension * 4,
      `${dimension}D full detail costs ${dimension * 4} GPU bytes a point`,
    );
    assert.deepEqual(tracker.attributes.get(0), {
      buffer: positionBuffer,
      normalized: false,
      offset: 0,
      size: dimension,
      stride: dimension * 4,
      type: tracker.gl.FLOAT,
      vao: vaoOf(renderer.vao),
    });

  }
});

test('a full-detail recolor rewrites only the color stream, in place', () => {
  const pointCount = 2 * CHUNK_POINTS + 7;
  const { colors, positions, renderer, tracker } =
    createStreamFixture(pointCount);
  renderer._createPointStreams(positions, colors, 3);
  renderer._flushPendingPositionUpload();
  const acceptedPositions =
    tracker.stores.get(bufferOf(renderer.buffers.positions)).slice();
  assert.ok(cellsEqual(acceptedPositions, bytesOf(positions)));
  tracker.calls.bufferData.length = 0;
  tracker.calls.bufferSubData.length = 0;

  const recolored = makeColors(pointCount).map(
    (value, index) => (value + index) % 256,
  );
  renderer._colors = recolored;
  renderer._publishLiveColors();

  assert.equal(tracker.calls.bufferData.length, 0, 'no reallocation');
  assert.deepEqual(tracker.calls.bufferSubData, [{
    buffer: bufferOf(renderer.buffers.colors),
    dstByteOffset: 0,
    length: pointCount * 4,
    sourceBuffer: recolored.buffer,
  }]);
  assert.deepEqual(
    tracker.stores.get(bufferOf(renderer.buffers.colors)),
    bytesOf(recolored),
  );
  assert.deepEqual(
    tracker.stores.get(bufferOf(renderer.buffers.positions)),
    acceptedPositions,
  );
});

for (const count of POINT_COUNTS) {
  test(
    `ordered colour gather of ${count.toLocaleString('en-US')} points is byte-identical ` +
    'to a whole-buffer gather',
    () => {
      const pointCount = count + 3;
      const { colors, renderer, tracker } = createStreamFixture(pointCount);
      // Colours: one GPU pass over the whole store, byte-identical to a
      // whole-buffer gather, through no CPU staging.
      const colorOrder = makeOrder(pointCount, pointCount);
      const colorStore = tracker.gl.createBuffer();
      tracker.gl.bindBuffer(tracker.gl.ARRAY_BUFFER, colorStore);
      tracker.gl.bufferData(tracker.gl.ARRAY_BUFFER, pointCount * 4, tracker.gl.DYNAMIC_DRAW);
      tracker.gl.bindBuffer(tracker.gl.ARRAY_BUFFER, null);
      renderer._writeOrderedColors(colorStore, colors, makeRecord(colorOrder), 'colors');
      const expectedColors = new Uint8Array(pointCount * 4);
      for (let slot = 0; slot < pointCount; slot++) {
        const point = colorOrder[slot];
        expectedColors.set(colors.subarray(point * 4, point * 4 + 4), slot * 4);
      }
      assert.deepEqual(tracker.stores.get(colorStore), expectedColors);
      assert.equal(renderer._permuter.wordWrites[1], 1);
    },
  );
}

test('an ordered recolor rewrites the accepted color store without reallocating it', () => {
  const pointCount = CHUNK_POINTS + 11;
  const { renderer, tracker } = createStreamFixture(pointCount);
  const record = makeRecord(makeOrder(pointCount, pointCount));
  const order = record.drawOrder.indices;
  const colorStore = tracker.gl.createBuffer();
  tracker.gl.bindBuffer(tracker.gl.ARRAY_BUFFER, colorStore);
  tracker.gl.bufferData(tracker.gl.ARRAY_BUFFER, pointCount * 4, tracker.gl.DYNAMIC_DRAW);
  renderer._writeOrderedColors(colorStore, renderer._colors, record, 'colors');
  tracker.calls.bufferData.length = 0;

  renderer._colors = makeColors(pointCount).map(value => 255 - value);
  renderer._writeOrderedColors(colorStore, renderer._colors, record, 'colors');

  assert.equal(tracker.calls.bufferData.length, 0);
  const store = tracker.stores.get(colorStore);
  for (let slot = 0; slot < order.length; slot++) {
    const point = order[slot];
    assert.deepEqual(
      Array.from(store.subarray(slot * 4, slot * 4 + 4)),
      Array.from(renderer._colors.subarray(point * 4, point * 4 + 4)),
    );
  }
});

test('an ordered colour write refuses an order that does not cover every point', () => {
  const pointCount = 9;
  const { renderer, tracker } = createStreamFixture(pointCount);
  const colorStore = tracker.gl.createBuffer();
  assert.throws(
    () => renderer._writeOrderedColors(colorStore, renderer._colors, makeRecord(makeOrder(5, pointCount)), 'colors'),
    /5 slots for 9 colours/,
  );
});

test('a refused GPU allocation names the dataset it could not store', () => {
  const pointCount = CHUNK_POINTS + 5;
  const { colors, positions, renderer, tracker } =
    createStreamFixture(pointCount);
  tracker.failures.allocationError = tracker.gl.OUT_OF_MEMORY;

  assert.throws(
    () => renderer._createPointStreams(positions, colors, 3),
    error => (
      error instanceof RangeError &&
      error.message.includes(pointCount.toLocaleString('en-US')) &&
      error.message.includes((pointCount * 12).toLocaleString('en-US')) &&
      /0x505/.test(error.message)
    ),
  );
  // A refused allocation is reported before anything else is sent.
  assert.equal(tracker.calls.bufferData.length, 1);
  assert.equal(tracker.calls.bufferSubData.length, 0);
  assert.equal(renderer._positionGpuByteLength, 0);
  assert.equal(renderer._colorGpuByteLength, 0);
});

test('loadData refuses only a dataset the device cannot address, never one above MAX_TEXTURE_SIZE squared', () => {
  // Per-point textures are layered: 8 x 8 texels a layer, two layers here,
  // so 128 points are addressable and 129 are not.
  const maxTextureSize = 8;
  const maxArrayLayers = 2;
  const capacity = maxTextureSize * maxTextureSize * maxArrayLayers;
  const pointCount = capacity + 1;
  const { renderer, tracker } = createStreamFixture(0, { maxTextureSize, maxArrayLayers });
  const positions = makePositions(pointCount);
  const colors = makeColors(pointCount);

  assert.throws(
    () => renderer.loadData(positions, colors, { dimensionLevel: 3 }),
    error => (
      error instanceof RangeError &&
      error.message.includes(pointCount.toLocaleString('en-US')) &&
      /3 texture layers; this GPU allows 2/.test(error.message)
    ),
  );
  // The refusal precedes every allocation: no handle, no upload, no staging.
  assert.equal(tracker.created.buffers.length, 0);
  assert.equal(tracker.created.textures.length, 0);
  assert.equal(tracker.created.vertexArrays.length, 0);
  assert.equal(tracker.calls.bufferData.length, 0);
});

test('color publication refuses an RGBA array that is not word-aligned', () => {
  const pointCount = 3;
  const { positions, renderer, tracker } = createStreamFixture(pointCount);
  const backing = new Uint8Array(pointCount * 4 + 1);
  const unaligned = backing.subarray(1);

  assert.throws(
    () => renderer.loadData(positions, unaligned, { dimensionLevel: 3 }),
    error => (
      error instanceof TypeError &&
      /4-byte boundary/.test(error.message) &&
      /byte offset 1/.test(error.message)
    ),
  );
  assert.throws(
    () => renderer.updateColors(unaligned),
    /4-byte boundary/,
  );
  assert.equal(tracker.created.buffers.length, 0);
});

test('the point-stream upload seams hold no client copy of a vertex store', () => {
  for (const name of [
    '_createPointStreams',
    '_publishLiveColors',
    '_writeOrderedColors',
    '_uploadSnapshotColors',
    '_createStoreOrder',
    '_adoptDrawOrder',
    '_advanceStoreOrder',
    '_ensureStoreDrawOrder',
    '_ensureSnapshotDrawOrder',
  ]) {
    const source = HighPerfRenderer.prototype[name].toString();
    assert.doesNotMatch(
      source,
      /new ArrayBuffer|new (Float32|Uint8|Uint32)Array\(\s*(count|maximumCount|pointCount|this\.pointCount)/,
      `${name} must not allocate a client-side copy of a vertex store`,
    );
  }
});
