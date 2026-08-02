/**
 * The full-detail interleaved point store is filled through one fixed staging
 * block, never through a client-side duplicate of the vertex buffer.
 *
 * The duplicate it replaces was one `ArrayBuffer` of `pointCount * 16` bytes
 * retained for the dataset's lifetime — 16 bytes a point of resident memory
 * holding a second copy of what `bufferData` had already uploaded. These tests
 * pin the replacement: the GPU store is sized first and then filled chunk by
 * chunk, and the bytes that reach the GPU are identical to the ones a single
 * whole-buffer `bufferData` would have carried — including when the point count
 * is not a multiple of the chunk size, which is the off-by-one this design
 * invites.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';

const CHUNK_POINTS = 65_536;
const POINT_BYTES = 16;

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

/**
 * The reference interleaving, written the way the renderer used to write it:
 * one whole-buffer pack followed by one `bufferData`.
 */
function referenceInterleaving(positions, colors) {
  const pointCount = positions.length / 3;
  const buffer = new ArrayBuffer(pointCount * POINT_BYTES);
  const positionView = new Float32Array(buffer);
  const colorView = new Uint8Array(buffer);
  for (let index = 0; index < pointCount; index++) {
    const floatOffset = index * 4;
    const byteOffset = index * POINT_BYTES + 12;
    positionView[floatOffset] = positions[index * 3];
    positionView[floatOffset + 1] = positions[index * 3 + 1];
    positionView[floatOffset + 2] = positions[index * 3 + 2];
    colorView[byteOffset] = colors[index * 4];
    colorView[byteOffset + 1] = colors[index * 4 + 1];
    colorView[byteOffset + 2] = colors[index * 4 + 2];
    colorView[byteOffset + 3] = colors[index * 4 + 3];
  }
  return new Uint8Array(buffer);
}

/**
 * A WebGL2 double that models a buffer's data store the way the real one
 * behaves: `bufferData` with a byte length allocates a zero-filled store, and
 * `bufferSubData` writes into it at an offset instead of replacing it.
 */
function createStoreTrackingGl({ maxTextureSize = 16_384 } = {}) {
  let nextId = 1;
  let boundArrayBuffer = null;
  let pendingError = 0;
  const stores = new Map();
  const calls = { bufferData: [], bufferSubData: [] };
  const created = { buffers: [], textures: [], vertexArrays: [] };
  const failures = { allocationError: 0 };

  const gl = {
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    MAX_TEXTURE_SIZE: 0x0d33,
    NO_ERROR: 0,
    OUT_OF_MEMORY: 0x0505,
    STATIC_DRAW: 0x88e4,
    UNSIGNED_BYTE: 0x1401,

    bindBuffer(target, buffer) {
      assert.equal(target, gl.ARRAY_BUFFER);
      boundArrayBuffer = buffer;
    },
    bindVertexArray() {},
    bufferData(target, dataOrSize, usage) {
      assert.equal(target, gl.ARRAY_BUFFER);
      assert.notEqual(boundArrayBuffer, null);
      calls.bufferData.push({
        buffer: boundArrayBuffer,
        carriedData: typeof dataOrSize !== 'number',
        size: typeof dataOrSize === 'number'
          ? dataOrSize
          : dataOrSize.byteLength,
        usage,
      });
      if (failures.allocationError !== 0) {
        pendingError = failures.allocationError;
        return;
      }
      if (typeof dataOrSize === 'number') {
        stores.set(boundArrayBuffer, new Uint8Array(dataOrSize));
        return;
      }
      const source = dataOrSize instanceof ArrayBuffer
        ? new Uint8Array(dataOrSize)
        : new Uint8Array(
          dataOrSize.buffer,
          dataOrSize.byteOffset,
          dataOrSize.byteLength,
        );
      stores.set(boundArrayBuffer, Uint8Array.from(source));
    },
    bufferSubData(target, dstByteOffset, srcData, srcOffset, length) {
      assert.equal(target, gl.ARRAY_BUFFER);
      const store = stores.get(boundArrayBuffer);
      assert.ok(store instanceof Uint8Array, 'bufferSubData before allocation');
      assert.ok(ArrayBuffer.isView(srcData));
      const bytes = new Uint8Array(
        srcData.buffer,
        srcData.byteOffset,
        srcData.byteLength,
      );
      const start = srcOffset ?? 0;
      const count = length ?? bytes.byteLength - start;
      assert.ok(
        dstByteOffset + count <= store.byteLength,
        'bufferSubData writes past the end of the store',
      );
      store.set(bytes.subarray(start, start + count), dstByteOffset);
      calls.bufferSubData.push({
        buffer: boundArrayBuffer,
        dstByteOffset,
        length: count,
        sourceByteLength: srcData.byteLength,
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
    getError() {
      const error = pendingError;
      pendingError = gl.NO_ERROR;
      return error;
    },
    getParameter(parameter) {
      assert.equal(parameter, gl.MAX_TEXTURE_SIZE);
      return maxTextureSize;
    },
    vertexAttribPointer() {},
  };

  return { calls, created, failures, gl, stores };
}

function createInterleavedFixture(pointCount, options = {}) {
  const tracker = createStoreTrackingGl(options);
  const positions = makePositions(pointCount);
  const colors = makeColors(pointCount);
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    gl: tracker.gl,
    buffers: {
      alphas: null,
      colors: null,
      interleaved: null,
      positions: null,
    },
    pointCount,
    snapshotBuffers: new Map(),
    stats: { gpuMemoryMB: 0 },
    useAdaptiveLOD: false,
    useFrustumCulling: false,
    vao: { id: 'vao' },
    _colors: colors,
    _interleavedArrayBuffer: null,
    _interleavedChunkBuffer: null,
    _interleavedChunkColorView: null,
    _interleavedChunkPositionView: null,
    _interleavedColorView: null,
    _interleavedGpuByteLength: 0,
    _interleavedPositionView: null,
    _positions: positions,
  });
  renderer._refreshGpuMemoryStats = () => 0;
  return { colors, positions, renderer, tracker };
}

for (const pointCount of POINT_COUNTS) {
  test(
    `interleaved publication of ${pointCount.toLocaleString()} points is ` +
    'byte-identical to a whole-buffer upload',
    () => {
      const { colors, positions, renderer, tracker } =
        createInterleavedFixture(pointCount);

      renderer._createInterleavedBuffer(positions, colors);

      const store = tracker.stores.get(renderer.buffers.interleaved);
      assert.ok(store instanceof Uint8Array);
      assert.equal(store.byteLength, pointCount * POINT_BYTES);
      assert.deepEqual(store, referenceInterleaving(positions, colors));
      assert.equal(
        renderer._interleavedGpuByteLength,
        pointCount * POINT_BYTES,
      );

      // One sizing allocation carrying no data, then exactly one chunk upload
      // per chunk, the last one short whenever the count is not a multiple.
      const expectedChunks = Math.ceil(pointCount / CHUNK_POINTS);
      assert.equal(tracker.calls.bufferData.length, 1);
      assert.equal(tracker.calls.bufferData[0].carriedData, false);
      assert.equal(
        tracker.calls.bufferData[0].size,
        pointCount * POINT_BYTES,
      );
      assert.equal(tracker.calls.bufferSubData.length, expectedChunks);
      assert.equal(
        tracker.calls.bufferSubData.reduce(
          (total, call) => total + call.length,
          0,
        ),
        pointCount * POINT_BYTES,
      );
      assert.equal(
        tracker.calls.bufferSubData.at(-1).length,
        (pointCount - (expectedChunks - 1) * CHUNK_POINTS) * POINT_BYTES,
      );

      // Nothing the size of the dataset survives on the client.
      assert.equal(renderer._interleavedArrayBuffer, null);
      assert.equal(
        renderer._interleavedChunkBuffer.byteLength,
        CHUNK_POINTS * POINT_BYTES,
      );
    },
  );

  test(
    `full-detail recolor of ${pointCount.toLocaleString()} points is ` +
    'byte-identical to a whole-buffer upload',
    () => {
      const { colors, positions, renderer, tracker } =
        createInterleavedFixture(pointCount);
      renderer._createInterleavedBuffer(positions, colors);

      const recolored = makeColors(pointCount).map(
        (value, index) => (value + index) % 256,
      );
      renderer._colors = recolored;
      tracker.calls.bufferData.length = 0;
      tracker.calls.bufferSubData.length = 0;

      renderer._rebuildInterleavedBuffer();

      assert.deepEqual(
        tracker.stores.get(renderer.buffers.interleaved),
        referenceInterleaving(positions, recolored),
      );
      assert.equal(tracker.calls.bufferData[0].usage, tracker.gl.DYNAMIC_DRAW);
      assert.equal(renderer._interleavedArrayBuffer, null);
      assert.equal(
        renderer._interleavedChunkBuffer.byteLength,
        CHUNK_POINTS * POINT_BYTES,
      );
    },
  );
}

test('the staging block is one fixed allocation shared across dataset sizes', () => {
  const small = createInterleavedFixture(3);
  small.renderer._createInterleavedBuffer(small.positions, small.colors);
  const smallScratch = small.renderer._interleavedChunkBuffer;

  const large = createInterleavedFixture(CHUNK_POINTS * 3 + 11);
  large.renderer._createInterleavedBuffer(large.positions, large.colors);

  assert.equal(
    smallScratch.byteLength,
    large.renderer._interleavedChunkBuffer.byteLength,
    'the staging block must not scale with the dataset',
  );
  assert.equal(smallScratch.byteLength, CHUNK_POINTS * POINT_BYTES);

  // Re-publishing reuses the same block rather than allocating another.
  small.renderer._createInterleavedBuffer(small.positions, small.colors);
  assert.strictEqual(
    small.renderer._interleavedChunkBuffer,
    smallScratch,
  );
});

test('a refused GPU allocation names the dataset it could not store', () => {
  const { colors, positions, renderer, tracker } =
    createInterleavedFixture(CHUNK_POINTS + 5);
  tracker.failures.allocationError = tracker.gl.OUT_OF_MEMORY;

  assert.throws(
    () => renderer._createInterleavedBuffer(positions, colors),
    error => (
      error instanceof RangeError &&
      error.message.includes((CHUNK_POINTS + 5).toLocaleString()) &&
      error.message.includes(
        ((CHUNK_POINTS + 5) * POINT_BYTES).toLocaleString(),
      ) &&
      /0x505/.test(error.message)
    ),
  );
  // A refused allocation packs nothing.
  assert.equal(tracker.calls.bufferSubData.length, 0);
  assert.equal(renderer._interleavedGpuByteLength, 0);
});

test('loadData refuses a dataset larger than the device can represent', () => {
  const maxTextureSize = 8;
  const capacity = maxTextureSize * maxTextureSize;
  const pointCount = capacity + 1;
  const { renderer, tracker } = createInterleavedFixture(0, { maxTextureSize });
  const positions = makePositions(pointCount);
  const colors = makeColors(pointCount);

  assert.throws(
    () => renderer.loadData(positions, colors, { dimensionLevel: 3 }),
    error => (
      error instanceof RangeError &&
      error.message.includes(pointCount.toLocaleString()) &&
      error.message.includes(capacity.toLocaleString()) &&
      error.message.includes(`${maxTextureSize}x${maxTextureSize}`)
    ),
  );
  // The refusal precedes every allocation: no handle, no upload, no staging.
  assert.equal(tracker.created.buffers.length, 0);
  assert.equal(tracker.created.textures.length, 0);
  assert.equal(tracker.created.vertexArrays.length, 0);
  assert.equal(tracker.calls.bufferData.length, 0);
  assert.equal(renderer._interleavedChunkBuffer, null);
});

test('the full-detail upload seam holds no client copy of the vertex buffer', async () => {
  const rendererSource = await readFile(
    new URL(
      '../assets/js/rendering/high-perf-renderer.js',
      import.meta.url,
    ),
    'utf8',
  );
  for (const name of [
    '_createInterleavedBuffer',
    '_rebuildInterleavedBuffer',
  ]) {
    const source = HighPerfRenderer.prototype[name].toString();
    assert.doesNotMatch(
      source,
      /new ArrayBuffer/,
      `${name} must not allocate a client-side duplicate of the vertex buffer`,
    );
    assert.doesNotMatch(
      source,
      /_ensureSharedPackingScratch/,
      `${name} must not borrow the point-count-sized compact LOD packing owner`,
    );
  }
  // The staging block's size is a constant, not a function of pointCount.
  assert.match(
    rendererSource,
    /const INTERLEAVED_CHUNK_POINTS = 65_536;/,
  );
});
