import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';

const DIMENSION = 2;
const MIB = 1024 * 1024;
const UINT_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const PIXEL_UNPACK_PARAMETERS = Object.freeze([
  'UNPACK_ALIGNMENT',
  'UNPACK_ROW_LENGTH',
  'UNPACK_IMAGE_HEIGHT',
  'UNPACK_SKIP_PIXELS',
  'UNPACK_SKIP_ROWS',
  'UNPACK_SKIP_IMAGES',
]);

function createTrackingGl(maxTextureSize = 4) {
  let nextId = 1;
  let boundArrayBuffer = null;
  let boundElementBuffer = null;
  let boundPixelUnpackBuffer = null;
  let boundTexture = null;
  let pendingError = 0;
  let texSubImageCount = 0;

  const unpack = new Map();
  const live = {
    buffers: new Set(),
    textures: new Set(),
    vertexArrays: new Set(),
  };
  const creates = {
    buffers: [],
    textures: [],
    vertexArrays: [],
  };
  const deletes = {
    buffers: [],
    textures: [],
    vertexArrays: [],
  };
  const bufferUploads = [];
  const textureOperations = [];
  const fail = {
    deleteTextureBefore: false,
    stickyTexSubImageAt: null,
  };

  const makeHandle = kind => {
    const handle = Object.freeze({
      id: `${kind}-${nextId++}`,
      kind,
    });
    if (kind === 'buffer') live.buffers.add(handle);
    if (kind === 'texture') live.textures.add(handle);
    if (kind === 'vao') live.vertexArrays.add(handle);
    return handle;
  };

  const snapshotUnpack = () => ({
    alignment: unpack.get(gl.UNPACK_ALIGNMENT),
    imageHeight: unpack.get(gl.UNPACK_IMAGE_HEIGHT),
    pixelUnpackBuffer: boundPixelUnpackBuffer,
    rowLength: unpack.get(gl.UNPACK_ROW_LENGTH),
    skipImages: unpack.get(gl.UNPACK_SKIP_IMAGES),
    skipPixels: unpack.get(gl.UNPACK_SKIP_PIXELS),
    skipRows: unpack.get(gl.UNPACK_SKIP_ROWS),
  });

  const gl = {
    ARRAY_BUFFER: 0x8892,
    CLAMP_TO_EDGE: 0x812f,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    FLOAT: 0x1406,
    INVALID_OPERATION: 0x0502,
    MAX_TEXTURE_SIZE: 0x0d33,
    NEAREST: 0x2600,
    NO_ERROR: 0,
    PIXEL_UNPACK_BUFFER: 0x88ec,
    PIXEL_UNPACK_BUFFER_BINDING: 0x88ef,
    R8: 0x8229,
    R32UI: 0x8236,
    RED: 0x1903,
    RED_INTEGER: 0x8d94,
    STATIC_DRAW: 0x88e4,
    TEXTURE_2D: 0x0de1,
    TEXTURE_BINDING_2D: 0x8069,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    UNPACK_ALIGNMENT: 0x0cf5,
    UNPACK_IMAGE_HEIGHT: 0x806e,
    UNPACK_ROW_LENGTH: 0x0cf2,
    UNPACK_SKIP_IMAGES: 0x806d,
    UNPACK_SKIP_PIXELS: 0x0cf4,
    UNPACK_SKIP_ROWS: 0x0cf3,
    UNSIGNED_BYTE: 0x1401,
    UNSIGNED_INT: 0x1405,

    bindBuffer(target, buffer) {
      if (target === this.ARRAY_BUFFER) {
        boundArrayBuffer = buffer;
      } else if (target === this.ELEMENT_ARRAY_BUFFER) {
        boundElementBuffer = buffer;
      } else if (target === this.PIXEL_UNPACK_BUFFER) {
        boundPixelUnpackBuffer = buffer;
      } else {
        throw new TypeError(`unexpected buffer target ${target}`);
      }
    },
    bindTexture(target, texture) {
      assert.equal(target, this.TEXTURE_2D);
      boundTexture = texture;
    },
    bindVertexArray() {},
    bufferData(target, data, usage) {
      bufferUploads.push({
        buffer: target === this.ARRAY_BUFFER
          ? boundArrayBuffer
          : boundElementBuffer,
        data,
        target,
        usage,
      });
    },
    createBuffer() {
      const handle = makeHandle('buffer');
      creates.buffers.push(handle);
      return handle;
    },
    createTexture() {
      const handle = makeHandle('texture');
      creates.textures.push(handle);
      return handle;
    },
    createVertexArray() {
      const handle = makeHandle('vao');
      creates.vertexArrays.push(handle);
      return handle;
    },
    deleteBuffer(handle) {
      deletes.buffers.push(handle);
      live.buffers.delete(handle);
    },
    deleteTexture(handle) {
      deletes.textures.push(handle);
      if (fail.deleteTextureBefore) {
        throw new Error('synthetic pre-delete texture failure');
      }
      live.textures.delete(handle);
    },
    deleteVertexArray(handle) {
      deletes.vertexArrays.push(handle);
      live.vertexArrays.delete(handle);
    },
    enableVertexAttribArray() {},
    getError() {
      const error = pendingError;
      pendingError = this.NO_ERROR;
      return error;
    },
    getParameter(parameter) {
      if (parameter === this.MAX_TEXTURE_SIZE) {
        return maxTextureSize;
      }
      if (parameter === this.PIXEL_UNPACK_BUFFER_BINDING) {
        return boundPixelUnpackBuffer;
      }
      if (parameter === this.TEXTURE_BINDING_2D) {
        return boundTexture;
      }
      if (unpack.has(parameter)) return unpack.get(parameter);
      throw new TypeError(`unexpected WebGL parameter ${parameter}`);
    },
    isBuffer(handle) {
      return live.buffers.has(handle);
    },
    isTexture(handle) {
      return live.textures.has(handle);
    },
    isVertexArray(handle) {
      return live.vertexArrays.has(handle);
    },
    pixelStorei(parameter, value) {
      if (!unpack.has(parameter)) {
        throw new TypeError(`unexpected pixel-store parameter ${parameter}`);
      }
      unpack.set(parameter, value);
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
      data,
    ) {
      textureOperations.push({
        border,
        data,
        format,
        height,
        internalFormat,
        kind: 'texImage2D',
        level,
        state: snapshotUnpack(),
        target,
        texture: boundTexture,
        type,
        width,
      });
    },
    texStorage2D(target, levels, internalFormat, width, height) {
      textureOperations.push({
        data: null,
        height,
        internalFormat,
        kind: 'texStorage2D',
        level: 0,
        levels,
        state: snapshotUnpack(),
        target,
        texture: boundTexture,
        width,
      });
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
      data,
    ) {
      texSubImageCount += 1;
      textureOperations.push({
        data,
        format,
        height,
        kind: 'texSubImage2D',
        level,
        state: snapshotUnpack(),
        target,
        texture: boundTexture,
        type,
        width,
        xOffset,
        yOffset,
      });
      if (texSubImageCount === fail.stickyTexSubImageAt) {
        pendingError = this.INVALID_OPERATION;
      }
    },
    texParameteri() {},
    vertexAttribPointer() {},

    _adoptBuffer() {
      return makeHandle('buffer');
    },
    _adoptTexture() {
      return makeHandle('texture');
    },
    _adoptVertexArray() {
      return makeHandle('vao');
    },
    _setUnpackState({
      alignment,
      imageHeight,
      pixelUnpackBuffer,
      rowLength,
      skipImages,
      skipPixels,
      skipRows,
    }) {
      boundPixelUnpackBuffer = pixelUnpackBuffer;
      unpack.set(this.UNPACK_ALIGNMENT, alignment);
      unpack.set(this.UNPACK_IMAGE_HEIGHT, imageHeight);
      unpack.set(this.UNPACK_ROW_LENGTH, rowLength);
      unpack.set(this.UNPACK_SKIP_IMAGES, skipImages);
      unpack.set(this.UNPACK_SKIP_PIXELS, skipPixels);
      unpack.set(this.UNPACK_SKIP_ROWS, skipRows);
    },
    _state: {
      bufferUploads,
      creates,
      deletes,
      fail,
      live,
      snapshotUnpack,
      textureOperations,
      get texSubImageCount() {
        return texSubImageCount;
      },
    },
  };

  gl._setUnpackState({
    alignment: 4,
    imageHeight: 0,
    pixelUnpackBuffer: null,
    rowLength: 0,
    skipImages: 0,
    skipPixels: 0,
    skipRows: 0,
  });
  return gl;
}

function makePointData(pointCount) {
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);
  for (let index = 0; index < pointCount; index++) {
    positions[index * 3] = index + 0.25;
    positions[index * 3 + 1] = -index - 0.5;
    positions[index * 3 + 2] = index * 2 + 0.75;
    colors[index * 4] = index + 1;
    colors[index * 4 + 1] = index + 31;
    colors[index * 4 + 2] = index + 61;
    colors[index * 4 + 3] = 255 - index;
  }
  return { colors, positions };
}

function makeSpatialIndex(
  positions,
  colors,
  maximumIndices,
) {
  const reducedCounts = [3, 7, maximumIndices.length];
  const lodLevels = reducedCounts.map((pointCount, depth) => ({
    depth,
    indices: maximumIndices.subarray(0, pointCount),
    isFullDetail: false,
    pointCount,
    sizeMultiplier: 2 - depth * 0.25,
  }));
  lodLevels.push({
    colors,
    depth: reducedCounts.length,
    isFullDetail: true,
    pointCount: positions.length / 3,
    positions,
    sizeMultiplier: 1,
  });
  return {
    colors,
    dimensionLevel: DIMENSION,
    lodLevels,
    pointCount: positions.length / 3,
    positions,
  };
}

function makeRendererFixture({
  maxTextureSize = 4,
  maximumIndices = Uint32Array.from([
    12, 2, 9, 0, 7, 3, 11, 1, 8, 5,
  ]),
  pointCount = 13,
} = {}) {
  const gl = createTrackingGl(maxTextureSize);
  const { colors, positions } = makePointData(pointCount);
  const spatialIndex = makeSpatialIndex(
    positions,
    colors,
    maximumIndices,
  );
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _alphaTexData: null,
      _alphaTexHeight: 0,
      _alphaTexWidth: 0,
      _alphaTexture: null,
      _alphaTextureByteLength: 0,
      _colors: colors,
      _dirtyLodDimensions: new Set(),
      _dummyLodIndexTexture: null,
      _dummyLodIndexTextureByteLength: 0,
      _interleavedGpuByteLength: 0,
      _liveGeometryGeneration: 17,
      _lodArrayBuffers: null,
      _lodIndexTexturesByDimension: new Map(),
      _lodResourceOwnersByDimension: new Map(),
      _pendingDataRetirements: new Set(),
      _pendingSnapshotRetirements: new Set(),
      _perViewState: new Map(),
      _positions: positions,
      _useAlphaTexture: false,
      buffers: {
        alphas: null,
        colors: null,
        interleaved: gl._adoptBuffer(),
        positions: null,
      },
      gl,
      lodBuffersByDimension: new Map(),
      pointCount,
      snapshotBuffers: new Map(),
      spatialIndices: new Map([[DIMENSION, spatialIndex]]),
      stats: { gpuMemoryMB: 0 },
      vao: gl._adoptVertexArray(),
    },
  );
  return {
    colors,
    gl,
    maximumIndices,
    positions,
    renderer,
    spatialIndex,
  };
}

function makeHostileUnpackState(label) {
  return Object.freeze({
    alignment: 8,
    imageHeight: 19,
    pixelUnpackBuffer: Object.freeze({
      id: `${label}-pixel-unpack-buffer`,
    }),
    rowLength: 17,
    skipImages: 5,
    skipPixels: 3,
    skipRows: 7,
  });
}

function assertExactUnpackState(actual, expected) {
  assert.deepEqual(actual, expected);
}

function assertNeutralUploadState(operation, alignment) {
  assert.equal(
    operation.state.pixelUnpackBuffer,
    null,
    `${operation.kind} must use the ArrayBufferView overload, not a caller PBO`,
  );
  assert.equal(operation.state.alignment, alignment);
  assert.equal(operation.state.rowLength, 0);
  assert.equal(operation.state.imageHeight, 0);
  assert.equal(operation.state.skipPixels, 0);
  assert.equal(operation.state.skipRows, 0);
  assert.equal(operation.state.skipImages, 0);
}

function assertExactKnownGpuBytes(renderer, expected) {
  assert.ok(
    Math.abs(renderer.stats.gpuMemoryMB * MIB - expected) < 1e-9,
    `expected ${expected} known GPU bytes; received ${renderer.stats.gpuMemoryMB * MIB}`,
  );
}

function findR32uiAllocation(operations) {
  return operations.filter(operation => (
    (
      operation.kind === 'texImage2D' ||
      operation.kind === 'texStorage2D'
    ) &&
    operation.internalFormat === 0x8236
  ));
}

test('maximum-prefix R32UI staging allocates without a padded host duplicate and streams exact shared prefix views', () => {
  const fixture = makeRendererFixture();
  const hostileState = makeHostileUnpackState('lod-success');
  fixture.gl._setUnpackState(hostileState);

  fixture.renderer._createLODResourcesForDimension(
    DIMENSION,
    fixture.spatialIndex,
  );

  const owner =
    fixture.renderer._lodResourceOwnersByDimension.get(DIMENSION);
  const topology = owner.topologyOwner;
  const textureOperations =
    fixture.gl._state.textureOperations.filter(
      operation => operation.texture === topology.indexTexture,
    );
  const allocations = findR32uiAllocation(textureOperations);
  const rowUploads = textureOperations.filter(
    operation => operation.kind === 'texSubImage2D',
  );

  assert.equal(allocations.length, 1);
  assert.equal(allocations[0].width, 4);
  assert.equal(allocations[0].height, 3);
  assert.equal(
    allocations[0].data,
    null,
    'R32UI storage must not receive a padded width*height Uint32Array duplicate',
  );
  if (allocations[0].kind === 'texImage2D') {
    assertNeutralUploadState(allocations[0], 4);
  }
  assert.ok(
    rowUploads.length >= 2,
    'complete rows and the short terminal row must be streamed separately',
  );

  const streamed = [];
  let expectedY = 0;
  for (const upload of rowUploads) {
    assertNeutralUploadState(upload, 4);
    assert.equal(upload.xOffset, 0);
    assert.equal(upload.yOffset, expectedY);
    assert.ok(upload.data instanceof Uint32Array);
    assert.strictEqual(
      upload.data.buffer,
      fixture.maximumIndices.buffer,
      'each upload must be a zero-copy view of the exact maximum-prefix owner',
    );
    assert.equal(upload.data.length, upload.width * upload.height);
    assert.ok(upload.width <= 4);
    if (upload.width < 4) {
      assert.equal(upload.height, 1);
      assert.strictEqual(upload, rowUploads.at(-1));
    }
    streamed.push(...upload.data);
    expectedY += upload.height;
  }
  assert.deepEqual(streamed, Array.from(fixture.maximumIndices));
  assert.equal(expectedY, 3);
  assertExactUnpackState(
    fixture.gl._state.snapshotUnpack(),
    hostileState,
  );

  const textureBytes = 4 * 3 * UINT_BYTES;
  const compactBytes = fixture.maximumIndices.length * 16;
  const originalIndexBytes =
    fixture.maximumIndices.length * UINT_BYTES;
  assert.equal(topology.indexTextureByteLength, textureBytes);
  assert.equal(topology.originalIndexByteLength, originalIndexBytes);
  assert.equal(owner.compactByteLength, compactBytes);
  assert.equal(
    owner.gpuByteLength,
    compactBytes + originalIndexBytes + textureBytes,
  );
  assertExactKnownGpuBytes(
    fixture.renderer,
    compactBytes + originalIndexBytes + textureBytes,
  );
});

test('failed streamed R32UI replacement rolls back publication, restores unpack state, and byte-accounts a retry-owned texture exactly', () => {
  const fixture = makeRendererFixture();
  fixture.renderer._createLODResourcesForDimension(
    DIMENSION,
    fixture.spatialIndex,
  );
  const acceptedOwner =
    fixture.renderer._lodResourceOwnersByDimension.get(DIMENSION);
  const acceptedBuffers =
    fixture.renderer.lodBuffersByDimension.get(DIMENSION);
  const acceptedTextures =
    fixture.renderer._lodIndexTexturesByDimension.get(DIMENSION);
  const acceptedBytes =
    acceptedOwner.gpuByteLength;

  const replacementMaximum = Uint32Array.from([
    1, 11, 4, 9, 0, 12, 3, 8, 5, 2,
  ]);
  const replacement = makeSpatialIndex(
    fixture.positions,
    fixture.colors,
    replacementMaximum,
  );
  const hostileState = makeHostileUnpackState('lod-failure');
  fixture.gl._setUnpackState(hostileState);
  fixture.gl._state.fail.stickyTexSubImageAt =
    fixture.gl._state.texSubImageCount + 2;
  fixture.gl._state.fail.deleteTextureBefore = true;

  assert.throws(
    () => fixture.renderer._createLODResourcesForDimension(
      DIMENSION,
      replacement,
    ),
    /WebGL|texture|cleanup|publication/i,
  );

  assert.strictEqual(
    fixture.renderer._lodResourceOwnersByDimension.get(DIMENSION),
    acceptedOwner,
  );
  assert.strictEqual(
    fixture.renderer.lodBuffersByDimension.get(DIMENSION),
    acceptedBuffers,
  );
  assert.strictEqual(
    fixture.renderer._lodIndexTexturesByDimension.get(DIMENSION),
    acceptedTextures,
  );
  assertExactUnpackState(
    fixture.gl._state.snapshotUnpack(),
    hostileState,
  );
  assert.equal(fixture.renderer._pendingDataRetirements.size, 1);

  const candidateTexture = fixture.gl._state.creates.textures.at(-1);
  assert.notStrictEqual(
    candidateTexture,
    acceptedOwner.topologyOwner.indexTexture,
  );
  assert.equal(fixture.gl._state.live.textures.has(candidateTexture), true);
  assert.equal(
    fixture.gl._state.live.buffers.size,
    3,
    'only main plus the accepted compact VBO/EBO may remain live',
  );
  assert.equal(
    fixture.gl._state.live.vertexArrays.size,
    2,
    'only main plus the accepted compact VAO may remain live',
  );

  const candidateTextureBytes = 4 * 3 * UINT_BYTES;
  assertExactKnownGpuBytes(
    fixture.renderer,
    acceptedBytes + candidateTextureBytes,
  );

  fixture.gl._state.fail.deleteTextureBefore = false;
  assert.deepEqual(fixture.renderer._drainDataRetirements(), []);
  assert.equal(fixture.renderer._pendingDataRetirements.size, 0);
  assert.equal(fixture.gl._state.live.textures.has(candidateTexture), false);
  assertExactKnownGpuBytes(fixture.renderer, acceptedBytes);
});

test('odd-width multi-row R8 creation and update use alignment 1, neutral unpack addressing, and restore caller state', () => {
  const pointCount = 5;
  const gl = createTrackingGl(3);
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _alphaTexData: null,
      _alphaTexHeight: 0,
      _alphaTexWidth: 0,
      _alphaTexture: null,
      _alphaTextureByteLength: 0,
      _dummyLodIndexTexture: null,
      _dummyLodIndexTextureByteLength: 0,
      _interleavedGpuByteLength: 0,
      _lodIndexTexturesByDimension: new Map(),
      _lodResourceOwnersByDimension: new Map(),
      _pendingDataRetirements: new Set(),
      _pendingSnapshotRetirements: new Set(),
      _perViewState: new Map(),
      _useAlphaTexture: false,
      buffers: {},
      gl,
      lodBuffersByDimension: new Map(),
      pointCount,
      snapshotBuffers: new Map(),
      stats: { gpuMemoryMB: 0 },
    },
  );
  const hostileState = makeHostileUnpackState('alpha');
  gl._setUnpackState(hostileState);

  renderer._createAlphaTexture(pointCount);

  assert.equal(renderer._alphaTexWidth, 3);
  assert.equal(renderer._alphaTexHeight, 2);
  assert.equal(renderer._alphaTexData.length, 6);
  assertExactKnownGpuBytes(renderer, 6);
  const createUpload = gl._state.textureOperations.find(
    operation => (
      operation.kind === 'texImage2D' &&
      operation.internalFormat === gl.R8
    ),
  );
  assert.ok(createUpload);
  assert.equal(createUpload.width, 3);
  assert.equal(createUpload.height, 2);
  assertNeutralUploadState(createUpload, 1);
  assertExactUnpackState(gl._state.snapshotUnpack(), hostileState);

  gl._state.textureOperations.length = 0;
  renderer._updateAlphaTexture(
    Float32Array.from([0, 0.25, 0.5, 0.75, 1]),
  );
  const updateUpload = gl._state.textureOperations.find(
    operation => operation.kind === 'texSubImage2D',
  );
  assert.ok(updateUpload);
  assert.equal(updateUpload.width, 3);
  assert.equal(updateUpload.height, 2);
  assertNeutralUploadState(updateUpload, 1);
  assertExactUnpackState(gl._state.snapshotUnpack(), hostileState);
  assert.deepEqual(
    Array.from(renderer._alphaTexData),
    [0, 64, 128, 191, 255, 255],
  );
  assert.equal(renderer._useAlphaTexture, true);
  const acceptedAlphaData = renderer._alphaTexData;
  const acceptedAlphaBytes = Array.from(acceptedAlphaData);
  const acceptedAlphaTexture = renderer._alphaTexture;

  const failureState = Object.freeze({
    ...makeHostileUnpackState('alpha-failure'),
    alignment: 2,
    rowLength: 23,
  });
  gl._setUnpackState(failureState);
  gl._state.fail.stickyTexSubImageAt =
    gl._state.texSubImageCount + 1;
  assert.throws(
    () => renderer._updateAlphaTexture(
      Float32Array.from([1, 0.75, 0.5, 0.25, 0]),
    ),
    /WebGL|alpha|publication/i,
  );
  assert.equal(renderer._alphaTexData, acceptedAlphaData);
  assert.deepEqual(
    Array.from(renderer._alphaTexData),
    acceptedAlphaBytes,
  );
  assert.equal(renderer._alphaTexture, acceptedAlphaTexture);
  assert.equal(renderer._useAlphaTexture, true);
  assertExactUnpackState(gl._state.snapshotUnpack(), failureState);
});

test('the focused mock covers every WebGL2 unpack row/skip parameter', () => {
  const gl = createTrackingGl();
  for (const name of PIXEL_UNPACK_PARAMETERS) {
    assert.equal(
      Number.isInteger(gl[name]),
      true,
      `${name} must remain in the hostile-state contract`,
    );
  }
});
