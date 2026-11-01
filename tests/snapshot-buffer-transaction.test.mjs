import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getNotificationCenter,
} from '../assets/js/app/notification-center.js';
import { HighPerfRenderer } from '../assets/js/rendering/high-perf-renderer.js';
import { createCpuPermuter } from './helpers/cpu-permuter.mjs';
import { bufferOf, pointStoreOver, vaoOf } from './helpers/point-stores.mjs';
import { SegmentedVertexArray } from '../assets/js/rendering/high-perf/point-store-segments.js';
import { planLinearTexture } from '../assets/js/rendering/linear-texture.js';

/**
 * The same cells' `dimension`-D embedding: the first `dimension` components of
 * each XYZ fixture point. A view publishes exactly that many per point.
 */
function embeddingPositions(xyz, dimension) {
  const pointCount = xyz.length / 3;
  const positions = new Float32Array(pointCount * dimension);
  for (let point = 0; point < pointCount; point++) {
    for (let axis = 0; axis < dimension; axis++) {
      positions[point * dimension + axis] = xyz[point * 3 + axis];
    }
  }
  return positions;
}

function createFakeGl() {
  let nextId = 1;
  let arrayBufferBinding = null;
  let textureBinding = null;
  let vertexArrayBinding = null;
  const buffers = new Set();
  const textures = new Set();
  const vertexArrays = new Set();
  const deletedBuffers = [];
  const deletedTextures = [];
  const deletedVertexArrays = [];
  const bufferDeleteAttempts = [];
  const textureDeleteAttempts = [];
  const vertexArrayDeleteAttempts = [];
  const bufferBytes = new Map();
  const textureBytes = new Map();
  const textureDims = new Map();
  const vertexAttributes = new Map();
  let bufferCreateCount = 0;
  let textureCreateCount = 0;
  let vertexArrayCreateCount = 0;
  let vertexAttribPointerCount = 0;
  let uploadCount = 0;
  let textureUploadCount = 0;

  const gl = {
    NO_ERROR: 0,
    ARRAY_BUFFER: 0x8892,
    CLAMP_TO_EDGE: 0x812f,
    MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
    NEAREST: 0x2600,
    R8: 0x8229,
    RED: 0x1903,
    STATIC_DRAW: 0x88E4,
    TEXTURE_2D: 0x0de1,
    TEXTURE_2D_ARRAY: 0x8c1a,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    failUpload: false,
    failUploadAt: -1,
    failBufferAllocationAt: -1,
    failVertexArrayAllocationAt: -1,
    failVertexAttribPointerAt: -1,
    failDeleteBuffer: false,
    failDeleteTexture: false,
    failDeleteVertexArray: false,
    createBuffer() {
      bufferCreateCount++;
      if (bufferCreateCount === gl.failBufferAllocationAt) {
        return null;
      }
      const buffer = { kind: 'buffer', id: nextId++ };
      buffers.add(buffer);
      return buffer;
    },
    createTexture() {
      textureCreateCount++;
      const texture = { kind: 'texture', id: nextId++ };
      textures.add(texture);
      return texture;
    },
    createVertexArray() {
      vertexArrayCreateCount++;
      if (
        vertexArrayCreateCount ===
        gl.failVertexArrayAllocationAt
      ) {
        return null;
      }
      const vertexArray = { kind: 'vertex-array', id: nextId++ };
      vertexArrays.add(vertexArray);
      vertexAttributes.set(vertexArray, new Map());
      return vertexArray;
    },
    bindBuffer(target, buffer) {
      assert.equal(target, gl.ARRAY_BUFFER);
      arrayBufferBinding = buffer;
    },
    bindTexture(target, texture) {
      assert.ok(target === gl.TEXTURE_2D || target === gl.TEXTURE_2D_ARRAY);
      textureBinding = texture;
    },
    bindVertexArray(vertexArray) {
      vertexArrayBinding = vertexArray;
    },
    bufferData(target, source) {
      assert.equal(target, gl.ARRAY_BUFFER);
      uploadCount++;
      if (gl.failUpload || uploadCount === gl.failUploadAt) {
        throw new Error('synthetic snapshot upload failure');
      }
      assert.ok(arrayBufferBinding);
      if (typeof source === 'number') {
        // A sizing allocation; the store is filled by bufferSubData.
        bufferBytes.set(arrayBufferBinding, new Uint8Array(source));
        return;
      }
      const bytes = source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(
            source.buffer,
            source.byteOffset,
            source.byteLength,
          );
      bufferBytes.set(
        arrayBufferBinding,
        Uint8Array.from(bytes),
      );
    },
    bufferSubData(target, dstByteOffset, source, sourceOffset = 0, length) {
      assert.equal(target, gl.ARRAY_BUFFER);
      assert.ok(arrayBufferBinding);
      const store = bufferBytes.get(arrayBufferBinding);
      assert.ok(store, 'bufferSubData writes inside a sized store');
      const width = source.BYTES_PER_ELEMENT;
      const count = length ?? (source.length - sourceOffset);
      store.set(
        new Uint8Array(
          source.buffer,
          source.byteOffset + sourceOffset * width,
          count * width,
        ),
        dstByteOffset,
      );
    },
    texImage2D(
      target,
      level,
      internalFormat,
      width,
      height,
      border,
      format,
      type,
      source,
    ) {
      assert.equal(target, gl.TEXTURE_2D);
      assert.equal(level, 0);
      assert.equal(internalFormat, gl.R8);
      assert.equal(border, 0);
      assert.equal(format, gl.RED);
      assert.equal(type, gl.UNSIGNED_BYTE);
      assert.ok(textureBinding);
      assert.equal(source.byteLength, width * height);
      textureUploadCount++;
      textureBytes.set(
        textureBinding,
        Uint8Array.from(source),
      );
    },
    texSubImage2D(
      target,
      level,
      xOffset,
      yOffset,
      width,
      height,
      format,
      type,
      source,
    ) {
      assert.equal(target, gl.TEXTURE_2D);
      assert.equal(level, 0);
      assert.equal(xOffset, 0);
      assert.equal(yOffset, 0);
      assert.equal(format, gl.RED);
      assert.equal(type, gl.UNSIGNED_BYTE);
      assert.ok(textureBinding);
      assert.equal(source.byteLength, width * height);
      textureUploadCount++;
      textureBytes.set(
        textureBinding,
        Uint8Array.from(source),
      );
    },
    // Linear textures (rendering/linear-texture.js) are 2D arrays.
    texStorage3D(target, levels, internalFormat, width, height, depth) {
      assert.equal(target, gl.TEXTURE_2D_ARRAY);
      assert.equal(levels, 1);
      assert.equal(internalFormat, gl.R8);
      assert.ok(textureBinding);
      textureBytes.set(textureBinding, new Uint8Array(width * height * depth));
      textureDims.set(textureBinding, { width, height });
    },
    texSubImage3D(
      target, level, xOffset, yOffset, zOffset, width, height, depth, format, type, source, srcOffset = 0,
    ) {
      assert.equal(target, gl.TEXTURE_2D_ARRAY);
      assert.equal(level, 0);
      assert.equal(depth, 1);
      assert.equal(format, gl.RED);
      assert.equal(type, gl.UNSIGNED_BYTE);
      assert.ok(textureBinding);
      const store = textureBytes.get(textureBinding);
      const dims = textureDims.get(textureBinding);
      assert.ok(store, 'texSubImage3D writes inside allocated storage');
      textureUploadCount++;
      for (let row = 0; row < height; row++) {
        const from = srcOffset + row * width;
        store.set(
          source.subarray(from, from + width),
          ((zOffset * dims.height) + yOffset + row) * dims.width + xOffset,
        );
      }
    },
    texParameteri() {},
    enableVertexAttribArray(index) {
      assert.ok(vertexArrayBinding);
      const attributes = vertexAttributes.get(vertexArrayBinding);
      attributes.set(index, {
        ...(attributes.get(index) ?? {}),
        enabled: true,
      });
    },
    vertexAttribPointer(
      index,
      size,
      type,
      normalized,
      stride,
      offset
    ) {
      vertexAttribPointerCount++;
      if (
        vertexAttribPointerCount ===
        gl.failVertexAttribPointerAt
      ) {
        throw new Error(
          'synthetic vertex-attribute publication failure'
        );
      }
      assert.ok(vertexArrayBinding);
      assert.ok(arrayBufferBinding);
      const attributes = vertexAttributes.get(vertexArrayBinding);
      attributes.set(index, {
        ...(attributes.get(index) ?? {}),
        buffer: arrayBufferBinding,
        normalized,
        offset,
        size,
        stride,
        type,
      });
    },
    deleteBuffer(buffer) {
      bufferDeleteAttempts.push(buffer);
      if (gl.failDeleteBuffer) {
        throw new Error(`synthetic buffer retirement failure ${buffer.id}`);
      }
      buffers.delete(buffer);
      bufferBytes.delete(buffer);
      deletedBuffers.push(buffer);
      if (arrayBufferBinding === buffer) arrayBufferBinding = null;
    },
    deleteTexture(texture) {
      textureDeleteAttempts.push(texture);
      if (gl.failDeleteTexture) {
        throw new Error(
          `synthetic texture retirement failure ${texture.id}`
        );
      }
      textures.delete(texture);
      textureBytes.delete(texture);
      deletedTextures.push(texture);
      if (textureBinding === texture) textureBinding = null;
    },
    deleteVertexArray(vertexArray) {
      vertexArrayDeleteAttempts.push(vertexArray);
      if (gl.failDeleteVertexArray) {
        throw new Error(
          `synthetic vertex-array retirement failure ${vertexArray.id}`
        );
      }
      vertexArrays.delete(vertexArray);
      vertexAttributes.delete(vertexArray);
      deletedVertexArrays.push(vertexArray);
      if (vertexArrayBinding === vertexArray) vertexArrayBinding = null;
    },
    getError() {
      return gl.NO_ERROR;
    },
    getParameter(parameter) {
      if (parameter === gl.MAX_ARRAY_TEXTURE_LAYERS) return 256;
      assert.equal(parameter, gl.MAX_TEXTURE_SIZE);
      return 4096;
    },
    isBuffer(buffer) {
      return buffers.has(buffer);
    },
    isTexture(texture) {
      return textures.has(texture);
    },
    isVertexArray(vertexArray) {
      return vertexArrays.has(vertexArray);
    },
    _state: {
      buffers,
      textures,
      vertexArrays,
      deletedBuffers,
      deletedTextures,
      deletedVertexArrays,
      bufferDeleteAttempts,
      textureDeleteAttempts,
      bufferBytes,
      textureBytes,
      vertexAttributes,
      vertexArrayDeleteAttempts,
      get bufferCreateCount() {
        return bufferCreateCount;
      },
      get uploadCount() {
        return uploadCount;
      },
      get textureCreateCount() {
        return textureCreateCount;
      },
      get textureUploadCount() {
        return textureUploadCount;
      },
      get vertexArrayCreateCount() {
        return vertexArrayCreateCount;
      },
      get vertexAttribPointerCount() {
        return vertexAttribPointerCount;
      },
      get arrayBufferBinding() {
        return arrayBufferBinding;
      },
      get vertexArrayBinding() {
        return vertexArrayBinding;
      },
      get textureBinding() {
        return textureBinding;
      },
    },
  };
  return gl;
}

function createRenderer() {
  const gl = createFakeGl();
  const renderer = Object.create(HighPerfRenderer.prototype);
  const positions = new Float32Array([
    -1, 0, 0,
    1, 0, 0,
  ]);
  // A snapshot's colour store is RGBA8, 4 bytes a point like the live one.
  const rgb = new Uint8Array([
    255, 0, 0, 255,
    0, 0, 255, 255,
  ]);
  // The image a view with every cell shown (null transparency) holds.
  const alphaImage = new Uint8Array([255, 255]);
  const positionBuffer = gl.createBuffer();
  const buffer = gl.createBuffer();
  const alphaTexture = gl.createTexture();
  const vao = gl.createVertexArray();
  const snapshotPositions = positions.slice();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, snapshotPositions, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, rgb, gl.STATIC_DRAW);
  gl.bindTexture(gl.TEXTURE_2D, alphaTexture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R8,
    2,
    1,
    0,
    gl.RED,
    gl.UNSIGNED_BYTE,
    alphaImage,
  );
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(
    1,
    4,
    gl.UNSIGNED_BYTE,
    true,
    4,
    0
  );
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  // The renderer's stores and vertex arrays are segmented
  // (point-store-segments.js): one segment each here.
  const positionStore = pointStoreOver(gl, positionBuffer, 2, 12);
  const colorStore = pointStoreOver(gl, buffer, 2, 4);
  const vertexArray = new SegmentedVertexArray(gl);
  vertexArray.vaos = [vao];
  vertexArray.segments = [{ first: 0, count: 2 }];

  // `snap_1` was kept from live generation 1. The live view has since been
  // republished as generation 2 with its own position VBO, so the snapshot's
  // pool record owns generation 1's VBO outright; a snapshot of the current
  // live generation borrows the live VBO instead.
  // The live VBO belongs to the live publication, outside the snapshot
  // ownership under test, so it is not one of the fake context's tracked
  // handles: snapshot tests count and retire only snapshot-owned storage.
  const livePositions = positions.slice();
  const livePositionBuffer = pointStoreOver(gl, Object.freeze({
    kind: 'buffer',
    id: 'live-positions',
  }), 2, 12);

  renderer.gl = gl;
  renderer._permuter = createCpuPermuter(gl);
  renderer.pointCount = 2;
  renderer._positions = livePositions;
  renderer.buffers = { positions: livePositionBuffer, colors: null };
  renderer._positionGpuByteLength = livePositions.byteLength;
  renderer.currentDimensionLevel = 3;
  renderer._liveGeometryGeneration = 2;
  renderer._nextGeometryGeneration = 3;
  renderer.useAdaptiveLOD = false;
  renderer.useFrustumCulling = false;
  renderer.forceLODLevel = -1;
  renderer._perViewState = new Map();
  renderer.snapshotBuffers = new Map([
    ['snap_1', {
      alphas: null,
      alphaTexHeight: 1,
      alphaTexWidth: 2,
      alphaTexture,
      alphaTexPlan: planLinearTexture(alphaImage.length, 16384, 256),
      alphaTextureByteLength: alphaImage.byteLength,
      id: 'snap_1',
      vao: vertexArray,
      buffer: colorStore,
      bufferByteLength: rgb.byteLength,
      colorOwner: {
        buffer: colorStore,
        byteLength: rgb.byteLength,
        pointCount: 2,
        refCount: 1,
      },
      pointCount: 2,
      positions: snapshotPositions,
      geometryGeneration: 1,
      bounds: HighPerfRenderer.computeBoundsFromPositions(snapshotPositions, 3),
      spatialIndex: null,
      dimensionLevel: 3,
    }],
  ]);
  renderer._snapshotGeometryPools = new Map([
    [1, {
      dimension: 3,
      generation: 1,
      positions: snapshotPositions,
      positionBuffer: positionStore,
      positionBufferByteLength:
        snapshotPositions.byteLength,
      refCount: 1,
      spatialIndices: new Map(),
    }],
  ]);
  return { gl, renderer };
}

/** RGBA of what a view draws: its store's colour and its transparency's R8 byte. */
function snapshotRgba(renderer, snapshot) {
  const store = renderer.gl._state.bufferBytes.get(bufferOf(snapshot.buffer));
  assert.ok(store instanceof Uint8Array);
  assert.ok(snapshot.alphas === null || snapshot.alphas instanceof Uint8Array);
  const colors = new Uint8Array(snapshot.pointCount * 4);
  for (let index = 0; index < snapshot.pointCount; index++) {
    colors[index * 4] = store[index * 4];
    colors[index * 4 + 1] = store[index * 4 + 1];
    colors[index * 4 + 2] = store[index * 4 + 2];
    colors[index * 4 + 3] = snapshot.alphas === null ? 255 : snapshot.alphas[index] * 255;
  }
  return colors;
}

/** The bytes a snapshot's RGBA8 colour store holds for `colors`. */
function storeFromRgba(colors) {
  assert.ok(colors instanceof Uint8Array);
  assert.equal(colors.length % 4, 0);
  return Uint8Array.from(colors);
}

function copyBytes(view) {
  return Uint8Array.from(
    new Uint8Array(
      view.buffer,
      view.byteOffset,
      view.byteLength,
    )
  );
}

function replaceCalculationNotifications(overrides) {
  const notifications = getNotificationCenter();
  const previous = {
    completeCalculation: notifications.completeCalculation,
    failCalculation: notifications.failCalculation,
    hasNotification: notifications.hasNotification,
    startCalculation: notifications.startCalculation,
  };
  Object.assign(notifications, {
    hasNotification: () => true,
    ...overrides,
  });
  return () => Object.assign(notifications, previous);
}

test('snapshots of the live generation borrow its array and VBO, which pass to the pool when it retires', () => {
  const { gl, renderer } = createRenderer();
  const colors = snapshotRgba(
    renderer,
    renderer.snapshotBuffers.get('snap_1'),
  );
  const liveBuffer = renderer.buffers.positions;
  const uploadsBefore = gl._state.uploadCount;

  renderer.createSnapshotBuffer(
    'snap_2',
    colors,
    null,
    renderer._positions,
    3,
    'live',
  );
  renderer.createSnapshotBuffer(
    'snap_3',
    colors,
    null,
    renderer._positions,
    3,
    'live',
  );

  const first = renderer.snapshotBuffers.get('snap_2');
  const second = renderer.snapshotBuffers.get('snap_3');
  const geometry = renderer._snapshotGeometryPools.get(
    renderer._liveGeometryGeneration
  );
  // No copy on either side: the same array, the live publication's VBO, and
  // one RGB upload per view as the only buffer uploads.
  assert.equal(first.positions, renderer._positions);
  assert.equal(second.positions, renderer._positions);
  assert.equal(geometry.positions, renderer._positions);
  assert.equal(geometry.positionBuffer, liveBuffer);
  assert.equal(geometry.borrowsLivePositionBuffer, true);
  assert.equal(geometry.refCount, 2);
  assert.equal(gl._state.uploadCount, uploadsBefore + 2);
  for (const snapshot of [first, second]) {
    assert.equal(
      gl._state.vertexAttributes.get(vaoOf(snapshot.vao)).get(0).buffer,
      bufferOf(liveBuffer),
    );
  }

  // While the live publication holds it, the last snapshot never deletes it.
  renderer.deleteSnapshotBuffer('snap_3');
  assert.equal(geometry.refCount, 1);
  assert.equal(gl._state.bufferDeleteAttempts.includes(bufferOf(liveBuffer)), false);

  // Retiring the live publication hands its borrowed VBO to the pool instead
  // of deleting it under the remaining snapshot.
  const retirement = renderer._queueDataRetirement({
    buffers: { positions: liveBuffer, colors: null },
    currentDimensionLevel: 3,
    pointCount: 2,
  });
  assert.equal(
    retirement.buffers.some(entry => entry.handle === liveBuffer),
    false,
  );
  assert.equal(geometry.borrowsLivePositionBuffer, false);
  assert.equal(geometry.positionBuffer, liveBuffer);
  assert.deepEqual(renderer._drainDataRetirements(), []);
  assert.equal(gl._state.bufferDeleteAttempts.includes(bufferOf(liveBuffer)), false);

  // Now the pool owns it. When its last snapshot goes it is retained for
  // reuse, and only eviction deletes it -- exactly once.
  renderer.deleteSnapshotBuffer('snap_2');
  assert.equal(
    renderer._snapshotGeometryPools.get(geometry.generation),
    geometry,
  );
  assert.equal(geometry.refCount, 0);
  assert.equal(geometry.retained, true);
  assert.equal(gl._state.bufferDeleteAttempts.includes(bufferOf(liveBuffer)), false);
  renderer.evictRetainedGeometry(Infinity);
  assert.equal(
    renderer._snapshotGeometryPools.has(geometry.generation),
    false,
  );
  assert.equal(
    gl._state.bufferDeleteAttempts.filter(
      handle => handle === bufferOf(liveBuffer)
    ).length,
    1,
  );
});

test('geometry-generation certificates remain exact across live and snapshot replacement lifecycles', () => {
  const { gl, renderer } = createRenderer();
  const first = renderer.snapshotBuffers.get('snap_1');
  const oldGeometry = renderer._snapshotGeometryPools.get(1);
  const oldPositionBuffer = oldGeometry.positionBuffer;

  // `snap_1` was kept from generation 1; live has since been republished.
  assert.equal(renderer.getViewGeometryGeneration('live'), 2);
  assert.equal(renderer.getViewGeometryGeneration('snap_1'), 1);
  assert.throws(
    () => renderer.getViewGeometryGeneration('missing'),
    /does not exist/,
  );

  renderer.createSnapshotBuffer(
    'snap_2',
    snapshotRgba(renderer, first),
    null,
    first.positions,
    3,
    'snap_1',
  );
  assert.equal(renderer.getViewGeometryGeneration('snap_2'), 1);
  assert.equal(oldGeometry.refCount, 2);
  assert.equal(gl._state.buffers.has(bufferOf(oldPositionBuffer)), true);

  const second = renderer.snapshotBuffers.get('snap_2');
  renderer.createSnapshotBuffer(
    'snap_3',
    snapshotRgba(renderer, second),
    null,
    second.positions,
    3,
    'snap_2',
  );
  assert.equal(renderer.getViewGeometryGeneration('snap_3'), 1);
  assert.equal(oldGeometry.refCount, 3);
  assert.equal(
    renderer._snapshotGeometryPools.get(1).positionBuffer,
    oldPositionBuffer,
  );

  renderer.updateSnapshotPositions(
    'snap_1',
    embeddingPositions(first.positions, 2),
    2,
  );
  const replacementGeneration =
    renderer.getViewGeometryGeneration('snap_1');
  assert.equal(replacementGeneration, 3);
  assert.equal(renderer.getViewGeometryGeneration('live'), 2);
  // Adopted, not copied: the published 2D array is the new geometry.
  assert.equal(
    renderer._snapshotGeometryPools.get(replacementGeneration).positions,
    renderer.snapshotBuffers.get('snap_1').positions,
  );
  assert.equal(renderer.getViewGeometryGeneration('snap_2'), 1);
  assert.equal(renderer.getViewGeometryGeneration('snap_3'), 1);
  assert.equal(oldGeometry.refCount, 2);

  renderer.deleteSnapshotBuffer('snap_2');
  renderer.deleteSnapshotBuffer('snap_3');
  // No view shows generation 1 now: it is retained, not a view's generation.
  assert.equal(renderer._snapshotGeometryPools.get(1).refCount, 0);
  assert.equal(gl._state.buffers.has(bufferOf(oldPositionBuffer)), true);
  // Switching snap_1 back to those positions reuses the retained geometry:
  // the same generation, no new upload.
  const uploadsBeforeReuse = gl._state.uploadCount;
  renderer.updateSnapshotPositions('snap_1', first.positions === oldGeometry.positions
    ? first.positions
    : oldGeometry.positions, 3);
  assert.equal(renderer.getViewGeometryGeneration('snap_1'), 1);
  assert.equal(oldGeometry.refCount, 1);
  assert.equal(oldGeometry.retained, false);
  assert.equal(
    gl._state.uploadCount,
    uploadsBeforeReuse,
    'a retained representation is shown again without uploading its positions',
  );
  // And back: the 2D generation is reused in turn.
  renderer.updateSnapshotPositions(
    'snap_1',
    renderer._snapshotGeometryPools.get(replacementGeneration).positions,
    2,
  );
  assert.equal(renderer.getViewGeometryGeneration('snap_1'), replacementGeneration);
  assert.equal(gl._state.uploadCount, uploadsBeforeReuse);
  renderer.evictRetainedGeometry(Infinity);
  assert.equal(renderer._snapshotGeometryPools.has(1), false);
  assert.equal(gl._state.buffers.has(bufferOf(oldPositionBuffer)), false);
  assert.equal(
    renderer.getViewGeometryGeneration('snap_1'),
    replacementGeneration,
  );
  assert.throws(
    () => renderer.getViewGeometryGeneration('snap_2'),
    /does not exist/,
  );

  renderer._positions = null;
  renderer._liveGeometryGeneration = 0;
  assert.throws(
    () => renderer.getViewGeometryGeneration('live'),
    /no published geometry generation/,
  );
});

test('same-generation snapshots share positions and a color-only update rewrites only its own store', (t) => {
  const { gl, renderer } = createRenderer();
  const firstColors = new Uint8Array([
    1, 2, 3, 4,
    5, 6, 7, 8,
  ]);
  const secondColors = new Uint8Array([
    11, 12, 13, 14,
    15, 16, 17, 18,
  ]);
  const replacementColors = new Uint8Array([
    21, 22, 23, 24,
    25, 26, 27, 28,
  ]);

  const firstAlphas = Uint8Array.of(0, 1);
  renderer.createSnapshotBuffer(
    'snap_2',
    firstColors,
    firstAlphas,
    renderer._positions,
    3,
    'live',
  );
  const first = renderer.snapshotBuffers.get('snap_2');
  // Kept by reference: the texture holds the published transparency.
  assert.strictEqual(first.alphas, firstAlphas);
  const geometry = renderer._snapshotGeometryPools.get(
    first.geometryGeneration
  );
  const firstGpuBytes = Uint8Array.from(
    gl._state.bufferBytes.get(bufferOf(first.buffer)),
  );
  assert.deepEqual(
    firstGpuBytes,
    storeFromRgba(firstColors),
  );
  assert.deepEqual(
    gl._state.textureBytes.get(first.alphaTexture),
    new Uint8Array([0, 255]),
  );

  renderer.createSnapshotBuffer(
    'snap_3',
    secondColors,
    null,
    renderer._positions,
    3,
    'live',
  );
  const second = renderer.snapshotBuffers.get('snap_3');
  const secondGpuBytes = Uint8Array.from(
    gl._state.bufferBytes.get(bufferOf(second.buffer)),
  );
  assert.deepEqual(
    gl._state.bufferBytes.get(bufferOf(first.buffer)),
    firstGpuBytes,
    'packing the next view must not mutate the first GPU copy',
  );
  assert.deepEqual(
    secondGpuBytes,
    storeFromRgba(secondColors),
  );
  assert.deepEqual(
    gl._state.textureBytes.get(second.alphaTexture),
    new Uint8Array([255, 255]),
    'null transparency shows every cell; the colours\' alpha byte is never read',
  );
  assert.equal(
    renderer._snapshotGeometryPools.get(
      second.geometryGeneration
    ),
    geometry,
  );
  // Both borrow the live publication's own VBO; neither uploads positions.
  assert.equal(geometry.positionBuffer, renderer.buffers.positions);
  assert.equal(geometry.positions, renderer._positions);
  for (const snapshot of [first, second]) {
    const attributes =
      gl._state.vertexAttributes.get(vaoOf(snapshot.vao));
    assert.deepEqual(attributes.get(0), {
      buffer: bufferOf(geometry.positionBuffer),
      enabled: true,
      normalized: false,
      offset: 0,
      size: 3,
      stride: 12,
      type: gl.FLOAT,
    });
    assert.deepEqual(attributes.get(1), {
      buffer: bufferOf(snapshot.buffer),
      enabled: true,
      normalized: true,
      offset: 0,
      size: 4,
      stride: 4,
      type: gl.UNSIGNED_BYTE,
    });
  }
  assert.equal(
    renderer._snapshotGeometryPools.get(
      renderer._liveGeometryGeneration
    ).refCount,
    2,
    'both added views must share the live geometry',
  );

  const uploadCountBeforeReplacement =
    gl._state.uploadCount;
  const textureUploadCountBeforeReplacement =
    gl._state.textureUploadCount;
  const acceptedAlphaTexture = first.alphaTexture;
  const acceptedAlphas = first.alphas;
  const acceptedAlphaImage = Uint8Array.from(
    gl._state.textureBytes.get(first.alphaTexture),
  );
  const sharedPositionBuffer = geometry.positionBuffer;
  const firstBufferBefore = first.buffer;
  const firstVaoBefore = first.vao;
  const buffersCreatedBefore = gl._state.bufferCreateCount;
  renderer.updateSnapshotColors(
    'snap_2',
    replacementColors,
  );
  assert.deepEqual(
    gl._state.bufferBytes.get(bufferOf(second.buffer)),
    secondGpuBytes,
    'snapshot replacement must not mutate a sibling GPU copy',
  );
  assert.deepEqual(
    gl._state.bufferBytes.get(bufferOf(first.buffer)),
    storeFromRgba(replacementColors),
  );
  // The view alone owns its store, already in the order it draws with: the
  // colours are gathered into it in place, allocating nothing.
  assert.equal(first.buffer, firstBufferBefore);
  assert.equal(first.vao, firstVaoBefore);
  assert.equal(gl._state.bufferCreateCount, buffersCreatedBefore);
  assert.equal(
    gl._state.uploadCount,
    uploadCountBeforeReplacement,
    'an in-place recolour allocates no store',
  );
  assert.equal(
    gl._state.textureUploadCount,
    textureUploadCountBeforeReplacement,
    'RGB-only replacement must not upload or replace snapshot R8 state',
  );
  assert.equal(first.alphaTexture, acceptedAlphaTexture);
  assert.strictEqual(first.alphas, acceptedAlphas);
  assert.deepEqual(gl._state.textureBytes.get(first.alphaTexture), acceptedAlphaImage);
  assert.equal(
    geometry.positionBuffer,
    sharedPositionBuffer,
  );

  for (const method of [
    HighPerfRenderer.prototype.createSnapshotBuffer,
    HighPerfRenderer.prototype.updateSnapshotBuffer,
  ]) {
    assert.doesNotMatch(
      method.toString(),
      /new ArrayBuffer/,
    );
  }
  // The 12N position store is the live publication's own: snapshots add only
  // their RGBA8 and R8 stores.
  const pointCount = 30_000_000;
  const interleavedEightViewBytes =
    8 * pointCount * 16;
  const splitEightViewBytes =
    pointCount * 12 +
    8 * pointCount * 4 +
    8 * pointCount;
  const avoidedDuplicateBytes =
    interleavedEightViewBytes - splitEightViewBytes;
  assert.equal(avoidedDuplicateBytes, 2_280_000_000);
  t.diagnostic(
    `eight same-geometry 30M-point snapshots use ` +
    `${splitEightViewBytes.toLocaleString()} bytes instead of ` +
    `${interleavedEightViewBytes.toLocaleString()}, saving ` +
    `${avoidedDuplicateBytes.toLocaleString()} bytes ` +
    `(${(avoidedDuplicateBytes / 1024 / 1024).toFixed(3)} MiB)`,
  );
});

test('snapshot deletion retains exact failed handles for retry without releasing geometry twice', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const positionBuffer =
    renderer._snapshotGeometryPools.get(
      snapshot.geometryGeneration
    ).positionBuffer;
  gl.failDeleteBuffer = true;
  gl.failDeleteVertexArray = true;

  assert.throws(
    () => renderer.deleteSnapshotBuffer('snap_1'),
    error => (
      error instanceof AggregateError &&
      error.errors.length === 1 &&
      /detached.*retirement remains pending/i.test(error.message)
    ),
  );
  assert.equal(renderer.snapshotBuffers.has('snap_1'), false);
  assert.equal(renderer._snapshotGeometryPools.size, 1);
  assert.equal(
    renderer._snapshotGeometryPools.get(
      snapshot.geometryGeneration
    ).refCount,
    1,
  );
  assert.equal(gl._state.buffers.has(bufferOf(snapshot.buffer)), true);
  assert.equal(gl._state.textures.has(snapshot.alphaTexture), true);
  assert.equal(gl._state.buffers.has(bufferOf(positionBuffer)), true);
  assert.equal(gl._state.vertexArrays.has(vaoOf(snapshot.vao)), true);
  assert.equal(renderer._pendingSnapshotRetirements.size, 1);

  // A live VAO is a hard barrier: neither color nor geometry storage was
  // attempted, and the detached ID remains the exact retry surface.
  assert.equal(gl._state.bufferDeleteAttempts.length, 0);
  gl.failDeleteBuffer = false;
  gl.failDeleteVertexArray = false;
  assert.equal(renderer.deleteSnapshotBuffer('snap_1'), undefined);
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  // The geometry is released exactly once -- to retention, not deletion.
  const retained = renderer._snapshotGeometryPools.get(snapshot.geometryGeneration);
  assert.equal(retained.refCount, 0);
  assert.equal(retained.retained, true);
  assert.equal(gl._state.bufferDeleteAttempts.includes(bufferOf(positionBuffer)), false);
  renderer.evictRetainedGeometry(Infinity);
  assert.equal(renderer._snapshotGeometryPools.size, 0);
  assert.equal(
    gl._state.bufferDeleteAttempts.filter(
      handle => handle === bufferOf(snapshot.buffer)
    ).length,
    1,
  );
  assert.equal(
    gl._state.bufferDeleteAttempts.filter(
      handle => handle === bufferOf(positionBuffer)
    ).length,
    1,
  );
  assert.equal(
    gl._state.vertexArrayDeleteAttempts.filter(
      handle => handle === vaoOf(snapshot.vao)
    ).length,
    2,
  );
  assert.deepEqual(
    gl._state.deletedBuffers,
    [bufferOf(snapshot.buffer), bufferOf(positionBuffer)]
  );
  assert.deepEqual(
    gl._state.deletedTextures,
    [snapshot.alphaTexture],
  );
  assert.deepEqual(gl._state.deletedVertexArrays, [vaoOf(snapshot.vao)]);
});

test('delete-all continues detaching snapshots after a retirement failure', () => {
  const { gl, renderer } = createRenderer();
  const colors = snapshotRgba(
    renderer,
    renderer.snapshotBuffers.get('snap_1')
  );
  renderer.createSnapshotBuffer(
    'snap_2',
    colors,
    null,
    renderer._positions,
    3,
    'live',
  );
  gl.failDeleteBuffer = true;

  // Only the two colour buffers fail: the position storage is retained for
  // reuse, not deleted, when its last view goes.
  assert.throws(
    () => renderer.deleteAllSnapshotBuffers(),
    error => (
      error instanceof AggregateError &&
      error.errors.length === 2
    ),
  );
  assert.equal(renderer.snapshotBuffers.size, 0);
  assert.equal(renderer._snapshotGeometryPools.size, 2);
  assert.ok(
    [...renderer._snapshotGeometryPools.values()].every(geometry => geometry.refCount === 0),
  );
  assert.equal(gl._state.vertexArrays.size, 0);
  assert.equal(gl._state.buffers.size, 3);
  assert.equal(gl._state.textures.size, 0);
  assert.equal(renderer._pendingSnapshotRetirements.size, 2);

  gl.failDeleteBuffer = false;
  renderer.deleteAllSnapshotBuffers();
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  assert.equal(gl._state.buffers.size, 1, 'the retained position storage survives');
  renderer.evictRetainedGeometry(Infinity);
  assert.equal(renderer._snapshotGeometryPools.size, 0);
  assert.equal(gl._state.buffers.size, 0);
  assert.equal(gl._state.deletedBuffers.length, 3);
  assert.equal(gl._state.deletedTextures.length, 2);
  assert.equal(gl._state.deletedVertexArrays.length, 2);
});

test('dispose retries a failed snapshot VAO without double release or premature pooled-position deletion', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const geometry = renderer._snapshotGeometryPools.get(
    snapshot.geometryGeneration
  );
  const positionBuffer = geometry.positionBuffer;
  Object.assign(renderer, {
    _alphaTexHeight: 0,
    _alphaTexWidth: 0,
    _alphaTexture: null,
    _alphaTextureByteLength: 0,
    _boundingSphere: null,
    _colorsDirty: false,
    _colors: null,
    _currentAlphas: null,
    _dummyLodIndexTexture: null,
    _dummyLodIndexTextureByteLength: 0,
    _firstRenderDone: false,
    _colorGpuByteLength: 0,
    _positionGpuByteLength: 0,
    _pendingProgramRetirements: new Set(),
    _pendingProgramUnbind: false,
    _pendingShaderRetirements: new Set(),
    _useAlphaTexture: false,
    activeProgram: null,
    buffers: {
      colors: null,
      positions: null,
    },
    currentDimensionLevel: 3,
    programs: {
      full: null,
      light: null,
      ultralight: null,
    },
    spatialIndices: new Map(),
    stats: { gpuMemoryMB: 0 },
    uniformLocations: new Map(),
    vao: null,
  });
  gl.failDeleteVertexArray = true;

  assert.throws(
    () => renderer.dispose(),
    error => (
      error instanceof AggregateError &&
      error.errors.length === 1 &&
      /disposal retains/i.test(error.message)
    ),
  );
  assert.equal(renderer.snapshotBuffers.size, 0);
  assert.equal(renderer._pendingSnapshotRetirements.size, 1);
  assert.equal(geometry.refCount, 1);
  assert.equal(
    renderer._snapshotGeometryPools.get(
      geometry.generation
    ),
    geometry,
  );
  assert.equal(gl._state.buffers.has(bufferOf(snapshot.buffer)), true);
  assert.equal(gl._state.textures.has(snapshot.alphaTexture), true);
  assert.equal(gl._state.buffers.has(bufferOf(positionBuffer)), true);

  gl.failDeleteVertexArray = false;
  assert.doesNotThrow(() => renderer.dispose());
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  assert.equal(renderer._snapshotGeometryPools.size, 0);
  assert.equal(gl._state.buffers.size, 0);
  assert.equal(gl._state.textures.size, 0);
  assert.equal(gl._state.vertexArrays.size, 0);
  assert.equal(
    gl._state.vertexArrayDeleteAttempts.filter(
      handle => handle === vaoOf(snapshot.vao)
    ).length,
    2,
  );
  assert.equal(
    gl._state.bufferDeleteAttempts.filter(
      handle => handle === bufferOf(positionBuffer)
    ).length,
    1,
  );
});

test('position upload failure releases newly acquired geometry exactly once without 16N staging', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const before = { ...snapshot };
  const livePool =
    renderer._snapshotGeometryPools.get(snapshot.geometryGeneration);
  gl.failUpload = true;
  assert.throws(
    () => renderer.updateSnapshotPositions(
      'snap_1',
      embeddingPositions(snapshot.positions, 2),
      2,
    ),
    /synthetic snapshot upload failure/,
  );

  assert.deepEqual({ ...snapshot }, before);
  assert.equal(renderer._snapshotGeometryPools.size, 1);
  assert.equal(livePool.refCount, 1);
  assert.equal(gl._state.buffers.size, 2);
  assert.equal(gl._state.vertexArrays.size, 1);
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  for (const method of [
    HighPerfRenderer.prototype.createSnapshotBuffer,
    HighPerfRenderer.prototype.updateSnapshotBuffer,
  ]) {
    assert.doesNotMatch(method.toString(), /new ArrayBuffer/);
  }
});

test('rejected split uploads retain zero accepted GPU bytes across cleanup retry', async (t) => {
  const configureAccounting = renderer => {
    renderer.stats = { gpuMemoryMB: 0 };
    renderer.buffers = {
      colors: null,
      positions: null,
    };
    renderer._positionGpuByteLength = 0;
    renderer._colorGpuByteLength = 0;
    renderer._alphaTexture = null;
    renderer._alphaTextureByteLength = 0;
    renderer._dummyLodIndexTexture = null;
    renderer._dummyLodIndexTextureByteLength = 0;
  };
  const assertActiveBytesOnly = renderer => {
    const snapshot = renderer.snapshotBuffers.get('snap_1');
    const expected =
      renderer.pointCount * 4 +
      snapshot.alphaTextureByteLength +
      renderer.pointCount * 3 * Float32Array.BYTES_PER_ELEMENT;
    assert.equal(
      renderer.stats.gpuMemoryMB * 1024 * 1024,
      expected,
    );
  };

  await t.test('position upload', () => {
    const { gl, renderer } = createRenderer();
    configureAccounting(renderer);
    const snapshot = renderer.snapshotBuffers.get('snap_1');
    gl.failUpload = true;
    gl.failDeleteBuffer = true;

    assert.throws(
      () => renderer.updateSnapshotPositions(
        'snap_1',
        embeddingPositions(snapshot.positions, 2),
        2,
      ),
      error => (
        error instanceof AggregateError &&
        /rollback error/i.test(error.message)
      ),
    );
    assert.equal(renderer._pendingSnapshotRetirements.size, 1);
    const [retirement] =
      renderer._pendingSnapshotRetirements;
    assert.equal(retirement.buffer, null);
    assert.ok(retirement.positionBuffer);
    assert.equal(retirement.positionBufferByteLength, 0);
    assert.equal(retirement.geometryGeneration, null);
    assertActiveBytesOnly(renderer);

    gl.failUpload = false;
    gl.failDeleteBuffer = false;
    assert.deepEqual(
      renderer._drainSnapshotRetirements('snap_1'),
      [],
    );
  });

  await t.test('color upload', () => {
    const { gl, renderer } = createRenderer();
    configureAccounting(renderer);
    const snapshot = renderer.snapshotBuffers.get('snap_1');
    gl.failUpload = true;
    gl.failDeleteBuffer = true;

    // Colours and visibility together replace the colour store (an
    // alpha-free recolour of a store the view alone owns is in place).
    assert.throws(
      () => renderer.updateSnapshotBuffer(
        'snap_1',
        snapshotRgba(renderer, snapshot),
        new Uint8Array(snapshot.pointCount).fill(1),
        snapshot.positions,
        snapshot.dimensionLevel,
      ),
      error => (
        error instanceof AggregateError &&
        /rollback error/i.test(error.message)
      ),
    );
    assert.equal(renderer._pendingSnapshotRetirements.size, 1);
    const [retirement] =
      renderer._pendingSnapshotRetirements;
    assert.ok(retirement.buffer);
    assert.equal(retirement.bufferByteLength, 0);
    assert.equal(retirement.positionBuffer, null);
    assert.equal(retirement.geometryGeneration, null);
    assertActiveBytesOnly(renderer);

    gl.failUpload = false;
    gl.failDeleteBuffer = false;
    assert.deepEqual(
      renderer._drainSnapshotRetirements('snap_1'),
      [],
    );
  });
});

test('null position, color, and VAO allocations roll back exact geometry references', async (t) => {
  await t.test('new position allocation', () => {
    const { gl, renderer } = createRenderer();
    const snapshot = renderer.snapshotBuffers.get('snap_1');
    const before = { ...snapshot };
    gl.failBufferAllocationAt =
      gl._state.bufferCreateCount + 1;

    assert.throws(
      () => renderer.updateSnapshotPositions(
        'snap_1',
        embeddingPositions(snapshot.positions, 2),
        2,
      ),
      /position store could not allocate/,
    );
    assert.deepEqual({ ...snapshot }, before);
    assert.equal(renderer._snapshotGeometryPools.size, 1);
    assert.equal(
      renderer._snapshotGeometryPools.get(1).refCount,
      1,
    );
    assert.equal(gl._state.buffers.size, 2);
    assert.equal(gl._state.vertexArrays.size, 1);
    assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  });

  await t.test('color allocation', () => {
    const { gl, renderer } = createRenderer();
    const snapshot = renderer.snapshotBuffers.get('snap_1');
    const geometry = renderer._snapshotGeometryPools.get(1);
    gl.failBufferAllocationAt =
      gl._state.bufferCreateCount + 1;

    assert.throws(
      () => renderer.createSnapshotBuffer(
        'snap_2',
        snapshotRgba(renderer, snapshot),
        null,
        renderer._positions,
        3,
        'live',
      ),
      /colour store could not allocate/,
    );
    assert.equal(renderer.snapshotBuffers.has('snap_2'), false);
    assert.equal(geometry.refCount, 1);
    assert.equal(gl._state.buffers.size, 2);
    assert.equal(gl._state.vertexArrays.size, 1);
    assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  });

  await t.test('VAO allocation after accepted color upload', () => {
    const { gl, renderer } = createRenderer();
    const snapshot = renderer.snapshotBuffers.get('snap_1');
    const geometry = renderer._snapshotGeometryPools.get(1);
    const uploadsBefore = gl._state.uploadCount;
    gl.failVertexArrayAllocationAt =
      gl._state.vertexArrayCreateCount + 1;

    assert.throws(
      () => renderer.createSnapshotBuffer(
        'snap_2',
        snapshotRgba(renderer, snapshot),
        null,
        renderer._positions,
        3,
        'live',
      ),
      /could not create its vertex array/,
    );
    assert.equal(gl._state.uploadCount, uploadsBefore + 1);
    assert.equal(renderer.snapshotBuffers.has('snap_2'), false);
    assert.equal(geometry.refCount, 1);
    assert.equal(gl._state.buffers.size, 2);
    assert.equal(gl._state.vertexArrays.size, 1);
    assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  });
});

test('VAO attribute setup failure deletes the staged VAO before releasing split storage', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const geometry = renderer._snapshotGeometryPools.get(1);
  const deletedBufferCount = gl._state.deletedBuffers.length;
  const deletedVaoCount =
    gl._state.deletedVertexArrays.length;
  gl.failVertexAttribPointerAt =
    gl._state.vertexAttribPointerCount + 1;

  assert.throws(
    () => renderer.createSnapshotBuffer(
      'snap_2',
      snapshotRgba(renderer, snapshot),
      null,
      renderer._positions,
      3,
      'live',
    ),
    /vertex-attribute publication failure/,
  );
  assert.equal(renderer.snapshotBuffers.has('snap_2'), false);
  assert.equal(geometry.refCount, 1);
  assert.equal(gl._state.deletedVertexArrays.length, deletedVaoCount + 1);
  assert.equal(gl._state.deletedBuffers.length, deletedBufferCount + 1);
  assert.equal(gl._state.buffers.size, 2);
  assert.equal(gl._state.vertexArrays.size, 1);
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
});

test('snapshot GPU upload failure preserves the complete published resource set', () => {
  const { gl, renderer } = createRenderer();
  const before = renderer.snapshotBuffers.get('snap_1');
  const beforeRecord = { ...before };
  const replacementColors = new Uint8Array([
    0, 255, 0, 255,
    255, 255, 0, 255,
  ]);
  const acceptedGpuBytes = Uint8Array.from(
    gl._state.bufferBytes.get(bufferOf(before.buffer))
  );
  const geometry = renderer._snapshotGeometryPools.get(
    before.geometryGeneration
  );
  const acceptedPositionBytes = Uint8Array.from(
    gl._state.bufferBytes.get(bufferOf(geometry.positionBuffer))
  );
  gl._state.bufferBytes.set(
    before.buffer,
    Uint8Array.from(acceptedGpuBytes),
  );

  gl.failUpload = true;
  assert.throws(
    () => renderer.updateSnapshotBuffer(
      'snap_1',
      replacementColors,
      null,
      before.positions,
      3
    ),
    /synthetic snapshot upload failure/,
  );

  assert.equal(renderer.snapshotBuffers.get('snap_1'), before);
  assert.deepEqual({ ...before }, beforeRecord);
  assert.equal(gl._state.buffers.has(bufferOf(before.buffer)), true);
  assert.equal(gl._state.vertexArrays.has(vaoOf(before.vao)), true);
  assert.equal(gl._state.buffers.size, 2);
  assert.equal(gl._state.vertexArrays.size, 1);
  assert.deepEqual(
    gl._state.bufferBytes.get(bufferOf(before.buffer)),
    acceptedGpuBytes,
    'failed upload cannot mutate the accepted color GPU store',
  );
  assert.deepEqual(
    gl._state.bufferBytes.get(bufferOf(geometry.positionBuffer)),
    acceptedPositionBytes,
    'a color-only failure must not re-upload positions',
  );
  assert.equal(gl._state.arrayBufferBinding, null);
  assert.equal(gl._state.vertexArrayBinding, null);
});

test('snapshot rollback keeps failed candidate cleanup owned for exact retry', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const before = { ...snapshot };
  const originalBuffer = snapshot.buffer;
  const originalVao = snapshot.vao;
  const positionBuffer =
    renderer._snapshotGeometryPools.get(
      snapshot.geometryGeneration
    ).positionBuffer;
  const replacementColors =
    snapshotRgba(renderer, snapshot);

  gl.failUpload = true;
  gl.failDeleteBuffer = true;
  assert.throws(
    () => renderer.updateSnapshotBuffer(
      'snap_1',
      replacementColors,
      null,
      snapshot.positions,
      3,
    ),
    error => (
      error instanceof AggregateError &&
      /rollback error/i.test(error.message)
    ),
  );

  assert.deepEqual({ ...snapshot }, before);
  assert.equal(renderer._pendingSnapshotRetirements.size, 1);
  assert.equal(gl._state.buffers.has(bufferOf(originalBuffer)), true);
  assert.equal(gl._state.vertexArrays.has(vaoOf(originalVao)), true);
  assert.equal(gl._state.vertexArrays.size, 1);
  const failedCandidate = Array.from(gl._state.buffers).find(
    handle => (
      handle !== bufferOf(originalBuffer) &&
      handle !== bufferOf(positionBuffer)
    )
  );
  assert.ok(failedCandidate);
  assert.equal(
    gl._state.bufferDeleteAttempts.filter(
      handle => handle === bufferOf(failedCandidate)
    ).length,
    1,
  );

  gl.failUpload = false;
  gl.failDeleteBuffer = false;
  assert.deepEqual(renderer._drainSnapshotRetirements('snap_1'), []);
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  assert.equal(gl._state.buffers.size, 2);
  assert.equal(gl._state.buffers.has(bufferOf(originalBuffer)), true);
  assert.equal(
    gl._state.bufferDeleteAttempts.filter(
      handle => handle === bufferOf(failedCandidate)
    ).length,
    2,
  );
});

test('combined snapshot publication swaps colour, R8, and VAO owners exactly once', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const previousBuffer = snapshot.buffer;
  const previousAlphaTexture = snapshot.alphaTexture;
  const previousVao = snapshot.vao;
  const sharedPositionBuffer =
    renderer._snapshotGeometryPools.get(
      snapshot.geometryGeneration
    ).positionBuffer;
  const replacementColors = new Uint8Array([
    0, 255, 0, 255,
    255, 255, 0, 255,
  ]);

  assert.equal(
    renderer.updateSnapshotBuffer(
      'snap_1',
      replacementColors,
      null,
      snapshot.positions,
      3
    ),
    true,
  );

  assert.notEqual(snapshot.buffer, previousBuffer);
  assert.notEqual(snapshot.alphaTexture, previousAlphaTexture);
  assert.notEqual(snapshot.vao, previousVao);
  // Kept by reference, never copied: a published color array is not written,
  // and it is the source of any compact LOD color gather.
  assert.equal(snapshot.colors, replacementColors);
  assert.deepEqual(
    gl._state.bufferBytes.get(bufferOf(snapshot.buffer)),
    new Uint8Array([
      0, 255, 0, 255,
      255, 255, 0, 255,
    ]),
  );
  assert.equal(snapshot.alphas, null);
  assert.deepEqual(
    gl._state.textureBytes.get(snapshot.alphaTexture),
    new Uint8Array([255, 255]),
  );
  assert.equal(gl._state.buffers.has(bufferOf(previousBuffer)), false);
  assert.equal(
    gl._state.textures.has(previousAlphaTexture),
    false,
  );
  assert.equal(gl._state.vertexArrays.has(vaoOf(previousVao)), false);
  assert.deepEqual(gl._state.deletedBuffers, [bufferOf(previousBuffer)]);
  assert.deepEqual(
    gl._state.deletedTextures,
    [previousAlphaTexture],
  );
  assert.deepEqual(gl._state.deletedVertexArrays, [vaoOf(previousVao)]);
  assert.equal(gl._state.buffers.size, 2);
  assert.equal(
    gl._state.buffers.has(bufferOf(sharedPositionBuffer)),
    true
  );
  assert.equal(gl._state.vertexArrays.size, 1);
});

test('a store replacement keeps an extra geometry ref until its old VAO actually retires', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const oldBuffer = snapshot.buffer;
  const oldVao = snapshot.vao;
  const geometry = renderer._snapshotGeometryPools.get(
    snapshot.geometryGeneration
  );
  const positionBuffer = geometry.positionBuffer;
  gl.failDeleteVertexArray = true;

  // Colours and visibility together replace the store and its vertex array.
  assert.equal(
    renderer.updateSnapshotBuffer(
      'snap_1',
      snapshotRgba(renderer, snapshot),
      new Uint8Array(snapshot.pointCount).fill(1),
      snapshot.positions,
      snapshot.dimensionLevel,
    ),
    true,
  );
  assert.equal(geometry.refCount, 2);
  assert.equal(renderer._pendingSnapshotRetirements.size, 1);
  assert.equal(gl._state.vertexArrays.has(vaoOf(oldVao)), true);
  assert.equal(gl._state.buffers.has(bufferOf(oldBuffer)), true);
  assert.equal(gl._state.buffers.has(bufferOf(positionBuffer)), true);

  assert.throws(
    () => renderer.deleteSnapshotBuffer('snap_1'),
    error => (
      error instanceof AggregateError &&
      error.errors.length === 2
    ),
  );
  assert.equal(renderer.snapshotBuffers.size, 0);
  assert.equal(geometry.refCount, 2);
  assert.equal(
    renderer._snapshotGeometryPools.get(
      geometry.generation
    ),
    geometry,
  );
  assert.equal(gl._state.buffers.has(bufferOf(positionBuffer)), true);

  gl.failDeleteVertexArray = false;
  assert.doesNotThrow(
    () => renderer.deleteSnapshotBuffer('snap_1')
  );
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);
  assert.equal(gl._state.vertexArrays.size, 0);
  // Released by both VAO retry owners, the geometry is retained, then
  // evicted: its storage is deleted only after both VAOs are gone.
  assert.equal(geometry.refCount, 0);
  assert.equal(gl._state.buffers.has(bufferOf(positionBuffer)), true);
  renderer.evictRetainedGeometry(Infinity);
  assert.equal(renderer._snapshotGeometryPools.size, 0);
  assert.equal(gl._state.buffers.size, 0);
  assert.equal(
    gl._state.bufferDeleteAttempts.at(-1),
    bufferOf(positionBuffer),
    'the pooled position VBO retires after both VAO retry owners',
  );
});

test('published snapshot updates stay successful while failed old handles remain retryable', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const previous = { ...snapshot };
  const previousPositionBuffer =
    renderer._snapshotGeometryPools.get(
      previous.geometryGeneration
    ).positionBuffer;
  gl.failDeleteBuffer = true;

  assert.equal(
    renderer.updateSnapshotPositions(
      'snap_1',
      embeddingPositions(snapshot.positions, 2),
      2,
    ),
    true,
  );

  assert.equal(renderer.snapshotBuffers.get('snap_1'), snapshot);
  assert.notEqual(snapshot.geometryGeneration, previous.geometryGeneration);
  assert.notEqual(snapshot.positions, previous.positions);
  assert.equal(snapshot.buffer, previous.buffer);
  assert.equal(snapshot.colorOwner, previous.colorOwner);
  assert.equal(snapshot.alphaTexture, previous.alphaTexture);
  assert.notEqual(snapshot.vao, previous.vao);
  // The 3D geometry no view shows now is retained, not deleted.
  const previousGeometry =
    renderer._snapshotGeometryPools.get(previous.geometryGeneration);
  assert.equal(previousGeometry.refCount, 0);
  assert.equal(previousGeometry.retained, true);
  assert.equal(
    renderer._snapshotGeometryPools.get(
      snapshot.geometryGeneration
    ).refCount,
    1,
  );
  assert.equal(gl._state.buffers.has(bufferOf(previous.buffer)), true);
  assert.equal(gl._state.buffers.has(bufferOf(previousPositionBuffer)), true);
  assert.equal(gl._state.vertexArrays.has(vaoOf(previous.vao)), false);
  assert.equal(renderer._pendingSnapshotRetirements.size, 0);

  // Evicting it while deletion fails leaves it retry-owned, not lost.
  renderer.evictRetainedGeometry(Infinity);
  assert.equal(renderer._snapshotGeometryPools.has(previous.geometryGeneration), false);
  assert.equal(renderer._pendingDataRetirements.size, 1);
  assert.equal(gl._state.buffers.has(bufferOf(previousPositionBuffer)), true);
  gl.failDeleteBuffer = false;
  assert.deepEqual(renderer._drainDataRetirements(), []);
  assert.equal(renderer._pendingDataRetirements.size, 0);
  assert.equal(gl._state.buffers.has(bufferOf(previous.buffer)), true);
  assert.equal(
    gl._state.buffers.has(bufferOf(previousPositionBuffer)),
    false,
  );
  assert.equal(
    gl._state.bufferDeleteAttempts.filter(
      handle => handle === bufferOf(previous.buffer)
    ).length,
    0,
  );
  assert.equal(
    gl._state.bufferDeleteAttempts.filter(
      handle => handle === bufferOf(previousPositionBuffer)
    ).length,
    2,
  );
  assert.equal(
    gl._state.vertexArrayDeleteAttempts.filter(
      handle => handle === vaoOf(previous.vao)
    ).length,
    1,
  );
  renderer.deleteSnapshotBuffer('snap_1');
  renderer.evictRetainedGeometry(Infinity);
  assert.equal(renderer._snapshotGeometryPools.size, 0);
});

test('a snapshot position publication adopts its array as a new geometry generation', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const ownedPositions = snapshot.positions;
  const ownedBounds = snapshot.bounds;
  const ownedBuffer = snapshot.buffer;
  const ownedVao = snapshot.vao;
  const ownedPositionBuffer =
    renderer._snapshotGeometryPools.get(
      snapshot.geometryGeneration
    ).positionBuffer;

  const published = embeddingPositions(snapshot.positions, 2);
  assert.equal(
    renderer.updateSnapshotPositions('snap_1', published, 2),
    true,
  );
  assert.equal(snapshot.dimensionLevel, 2);
  // A published positions array is never written, so it is the geometry.
  assert.strictEqual(snapshot.positions, published);
  assert.notStrictEqual(snapshot.positions, renderer._positions);
  assert.notStrictEqual(snapshot.positions, ownedPositions);
  assert.notStrictEqual(snapshot.bounds, ownedBounds);
  assert.strictEqual(snapshot.buffer, ownedBuffer);
  assert.notStrictEqual(snapshot.vao, ownedVao);
  // The previous 3D geometry is retained for reuse, not deleted.
  assert.deepEqual(gl._state.deletedBuffers, []);
  assert.deepEqual(gl._state.deletedVertexArrays, [vaoOf(ownedVao)]);
  assert.equal(gl._state.buffers.size, 3);
  assert.equal(gl._state.vertexArrays.size, 1);
  assert.equal(renderer._snapshotGeometryPools.get(1).refCount, 0);
  assert.equal(renderer._snapshotGeometryPools.get(1).positionBuffer, ownedPositionBuffer);
  assert.notEqual(snapshot.geometryGeneration, 1);
  assert.equal(
    renderer._snapshotGeometryPools.get(snapshot.geometryGeneration).positions,
    snapshot.positions,
  );
  // Republishing the same array is the same geometry: nothing is uploaded.
  const generation = snapshot.geometryGeneration;
  const uploads = gl._state.uploadCount;
  assert.equal(renderer.updateSnapshotPositions('snap_1', published, 2), true);
  assert.equal(snapshot.geometryGeneration, generation);
  assert.equal(gl._state.uploadCount, uploads);
  renderer.evictRetainedGeometry(Infinity);
  assert.deepEqual(gl._state.deletedBuffers, [bufferOf(ownedPositionBuffer)]);
  assert.equal(renderer._snapshotGeometryPools.has(1), false);
});

test('a snapshot dimension is its position layout and cannot be relabelled over unchanged positions', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  const before = { ...snapshot };

  assert.equal(renderer.getViewPositionDimension('snap_1'), 3);
  assert.throws(
    () => renderer.updateSnapshotPositions('snap_1', snapshot.positions, 2),
    /positions must contain exactly 4 Float32 values/,
  );
  assert.throws(
    () => renderer.rebuildSnapshotSpatialIndex('snap_1', 2),
    /owns 3D positions; a 2D spatial index cannot be built over them/,
  );
  assert.equal(snapshot.dimensionLevel, 3);
  assert.equal(snapshot.positions, before.positions);
  assert.equal(snapshot.geometryGeneration, before.geometryGeneration);
  assert.equal(snapshot.bounds, before.bounds);
  assert.equal(snapshot.buffer, before.buffer);
  assert.equal(snapshot.vao, before.vao);
  assert.equal(snapshot.spatialIndex, null);
  assert.deepEqual(gl._state.deletedBuffers, []);
  assert.deepEqual(gl._state.deletedVertexArrays, []);
});

test('view-state invalidation resets semantic caches without GPU buffer churn', () => {
  const { gl, renderer } = createRenderer();
  const viewState = renderer._getViewState('live');
  const cull = viewState.cull;
  const runs = cull.runs;
  const starts = cull.starts;
  viewState.lastFrustumMVP = new Float32Array(16);
  cull.tree = { id: 'tree' };
  cull.drawOrder = { id: 'draw-order' };
  cull.runCount = 3;
  cull.band = 4;
  cull.rangeCount = 17;
  cull.elementCount = 99;
  viewState.statsPublished = true;
  const bufferCount = gl._state.buffers.size;

  assert.equal(renderer.invalidateViewState('live'), true);

  // Keys dropped, scratch kept for the next cull.
  assert.strictEqual(viewState.cull, cull);
  assert.strictEqual(cull.runs, runs);
  assert.strictEqual(cull.starts, starts);
  assert.equal(cull.tree, null);
  assert.equal(cull.drawOrder, null);
  assert.equal(cull.runCount, 0);
  assert.equal(cull.band, -1);
  assert.equal(cull.rangeCount, 0);
  assert.equal(cull.elementCount, 0);
  assert.equal(viewState.lastFrustumMVP, null);
  assert.equal(Object.hasOwn(viewState, 'cachedLodVisibility'), false);
  assert.equal(Object.hasOwn(viewState, 'indexBuffer'), false);
  assert.equal(viewState.statsPublished, false);
  assert.equal(gl._state.buffers.size, bufferCount);
  assert.deepEqual(gl._state.deletedBuffers, []);
  assert.equal(renderer.invalidateViewState('missing'), false);
});

test('a custom snapshot publishes its positions without building a tree, and a failed build is reported once', () => {
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  renderer._positions = snapshot.positions.slice();
  renderer._liveGeometryGeneration = 2;
  renderer._nextGeometryGeneration = 3;
  renderer.useFrustumCulling = true;
  renderer.options = {
    LOD_MAX_DEPTH: 2,
    LOD_MAX_POINTS_PER_NODE: 0,
  };
  const notifications = [];
  const restoreNotifications = replaceCalculationNotifications({
    completeCalculation() {
      notifications.push('complete');
    },
    failCalculation(id) {
      notifications.push(['fail', id]);
    },
    startCalculation() {
      notifications.push('start');
      return 'spatial-1';
    },
  });

  try {
    // The publication builds nothing: the tree is the first frame's request.
    renderer.updateSnapshotPositions('snap_1', embeddingPositions(snapshot.positions, 2), 2);
    assert.deepEqual(notifications, []);
    // No worker in this environment: the build runs inline, and fails.
    renderer._requestSpatialIndex({ kind: 'snapshot', id: 'snap_1' }, false);
    renderer._requestSpatialIndex({ kind: 'snapshot', id: 'snap_1' }, false);
  } finally {
    restoreNotifications();
  }

  assert.equal(snapshot.spatialIndex ?? null, null);
  assert.deepEqual(notifications, ['start', ['fail', 'spatial-1']], 'reported once, not retried every frame');
});

test('snapshot notification completion failure cannot roll back a valid publication', () => {
  const completionFailure = new Error('synthetic completion failure');
  const { gl, renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  renderer._positions = snapshot.positions.slice();
  renderer._liveGeometryGeneration = 2;
  renderer._nextGeometryGeneration = 3;
  renderer.useFrustumCulling = true;
  renderer.options = {
    LOD_MAX_DEPTH: 2,
    LOD_MAX_POINTS_PER_NODE: 1,
  };
  const previous = { ...snapshot };
  let failureNotifications = 0;
  const restoreNotifications = replaceCalculationNotifications({
    completeCalculation() {
      throw completionFailure;
    },
    failCalculation() {
      failureNotifications++;
    },
    startCalculation() {
      return 'spatial-2';
    },
  });

  try {
    assert.equal(
      renderer.updateSnapshotPositions(
        'snap_1',
        embeddingPositions(snapshot.positions, 2),
        2,
      ),
      true,
    );
  } finally {
    restoreNotifications();
  }

  assert.equal(snapshot.buffer, previous.buffer);
  assert.equal(snapshot.colorOwner, previous.colorOwner);
  assert.equal(snapshot.alphaTexture, previous.alphaTexture);
  assert.notEqual(snapshot.vao, previous.vao);
  assert.notEqual(
    snapshot.geometryGeneration,
    previous.geometryGeneration,
  );
  assert.equal(snapshot.dimensionLevel, 2);
  assert.equal(failureNotifications, 0);
  // The previous 3D position storage is retained for reuse; only its VAO went.
  assert.equal(gl._state.buffers.size, 3);
  assert.equal(gl._state.vertexArrays.size, 1);
  assert.equal(gl._state.deletedBuffers.length, 0);
  assert.equal(gl._state.deletedVertexArrays.length, 1);
  assert.equal(gl._state.deletedVertexArrays[0], vaoOf(previous.vao));
  renderer.evictRetainedGeometry(Infinity);
  assert.equal(gl._state.buffers.size, 2);
  assert.equal(gl._state.deletedBuffers.length, 1);
  assert.notEqual(gl._state.deletedBuffers[0], bufferOf(previous.buffer));
});

test('dismissed snapshot calculation notification is non-authoritative', () => {
  const { renderer } = createRenderer();
  const snapshot = renderer.snapshotBuffers.get('snap_1');
  renderer._positions = snapshot.positions.slice();
  renderer._liveGeometryGeneration = 2;
  renderer._nextGeometryGeneration = 3;
  renderer.useFrustumCulling = true;
  renderer.options = {
    LOD_MAX_DEPTH: 2,
    LOD_MAX_POINTS_PER_NODE: 1,
  };
  let terminalCalls = 0;
  const restoreNotifications = replaceCalculationNotifications({
    completeCalculation() {
      terminalCalls++;
    },
    failCalculation() {
      terminalCalls++;
    },
    hasNotification: () => false,
    startCalculation: () => 'dismissed-spatial',
  });

  try {
    assert.equal(
      renderer.updateSnapshotPositions(
        'snap_1',
        embeddingPositions(snapshot.positions, 2),
        2,
      ),
      true,
    );
  } finally {
    restoreNotifications();
  }

  assert.equal(snapshot.dimensionLevel, 2);
  assert.equal(terminalCalls, 0);
});

test('same-generation snapshots reuse one exact dimension spatial owner', () => {
  const { renderer } = createRenderer();
  const first = renderer.snapshotBuffers.get('snap_1');
  renderer.createSnapshotBuffer(
    'snap_2',
    snapshotRgba(renderer, first),
    null,
    first.positions,
    3,
    'snap_1',
  );
  const second = renderer.snapshotBuffers.get('snap_2');
  assert.equal(first.positions, second.positions);
  assert.equal(first.geometryGeneration, second.geometryGeneration);

  renderer.useFrustumCulling = true;
  renderer.options = {
    LOD_MAX_DEPTH: 2,
    LOD_MAX_POINTS_PER_NODE: 1,
  };
  let starts = 0;
  const restoreNotifications = replaceCalculationNotifications({
    completeCalculation() {},
    failCalculation() {
      throw new Error('shared spatial build unexpectedly failed');
    },
    startCalculation() {
      starts++;
      return `shared-spatial-${starts}`;
    },
  });

  try {
    renderer.rebuildSnapshotSpatialIndex('snap_1', 3);
    renderer.rebuildSnapshotSpatialIndex('snap_2', 3);
  } finally {
    restoreNotifications();
  }

  assert.equal(starts, 1);
  assert.equal(first.spatialIndex, second.spatialIndex);
  assert.equal(first.dimensionLevel, 3);
  assert.equal(second.dimensionLevel, 3);
  assert.equal(
    renderer._snapshotGeometryPools.get(
      first.geometryGeneration
    ).spatialIndices.size,
    1,
  );
});

test('a view switched to positions another view shows shares that geometry; a forced publication does not', () => {
  const { gl, renderer } = createRenderer();
  const first = renderer.snapshotBuffers.get('snap_1');
  renderer.createSnapshotBuffer(
    'snap_2',
    snapshotRgba(renderer, first),
    null,
    renderer._positions,
    3,
    'live',
  );
  const second = renderer.snapshotBuffers.get('snap_2');
  const shared = embeddingPositions(first.positions, 2);

  renderer.updateSnapshotPositions('snap_1', shared, 2);
  const generation = first.geometryGeneration;
  const geometry = renderer._snapshotGeometryPools.get(generation);
  const uploads = gl._state.uploadCount;

  // The second view switches to the representation the first shows: one
  // geometry, one VBO, no upload.
  renderer.updateSnapshotPositions('snap_2', shared, 2);
  assert.equal(second.geometryGeneration, generation);
  assert.equal(geometry.refCount, 2);
  assert.equal(gl._state.uploadCount, uploads);
  assert.equal(
    gl._state.vertexAttributes.get(vaoOf(second.vao)).get(0).buffer,
    bufferOf(geometry.positionBuffer),
  );

  // The live view showing positions a kept view switches to is shared too.
  renderer.updateSnapshotPositions('snap_2', renderer._positions, 3);
  assert.equal(second.geometryGeneration, renderer._liveGeometryGeneration);
  assert.equal(geometry.refCount, 1);
  assert.equal(gl._state.uploadCount, uploads);

  // A forced publication always uploads its own copy.
  renderer.updateSnapshotBuffer(
    'snap_1',
    snapshotRgba(renderer, first),
    null,
    shared,
    2,
    true,
  );
  assert.notEqual(first.geometryGeneration, generation);
  assert.ok(gl._state.uploadCount > uploads);
  // The geometry it left is retained, holding its storage for reuse.
  assert.equal(geometry.refCount, 0);
  assert.equal(geometry.retained, true);
  assert.equal(gl._state.buffers.has(bufferOf(geometry.positionBuffer)), true);
});
