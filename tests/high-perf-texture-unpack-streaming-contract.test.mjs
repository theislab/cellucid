import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
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
    rejectTexSubImageAt: null,
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
    MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
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
    TEXTURE_2D_ARRAY: 0x8c1a,
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
      assert.ok(target === this.TEXTURE_2D || target === this.TEXTURE_2D_ARRAY);
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
    bufferSubData() {},
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
      if (parameter === this.MAX_ARRAY_TEXTURE_LAYERS) return 256;
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
      if (texSubImageCount === fail.rejectTexSubImageAt) {
        // Rows written into a texture fail synchronously or not at all
        // (WebGL throws for arguments it rejects); nothing is read back.
        throw new TypeError('WebGL rejected the texSubImage upload.');
      }
    },
    // Linear textures (rendering/linear-texture.js) are 2D arrays: storage,
    // then rows addressed into the caller's array by offset.
    texStorage3D(target, levels, internalFormat, width, height, depth) {
      textureOperations.push({
        data: null,
        depth,
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
    texSubImage3D(
      target,
      level,
      xOffset,
      yOffset,
      zOffset,
      width,
      height,
      depth,
      format,
      type,
      data,
      srcOffset = 0,
    ) {
      texSubImageCount += 1;
      textureOperations.push({
        data,
        depth,
        format,
        height,
        kind: 'texSubImage2D',
        level,
        srcOffset,
        state: snapshotUnpack(),
        target,
        texture: boundTexture,
        type,
        width,
        xOffset,
        yOffset,
        zOffset,
      });
      if (texSubImageCount === fail.rejectTexSubImageAt) {
        // Rows written into a texture fail synchronously or not at all
        // (WebGL throws for arguments it rejects); nothing is read back.
        throw new TypeError('WebGL rejected the texSubImage upload.');
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
  // A DIMENSION-D embedding: DIMENSION components per point.
  const positions = new Float32Array(pointCount * DIMENSION);
  const colors = new Uint8Array(pointCount * 4);
  for (let index = 0; index < pointCount; index++) {
    positions[index * DIMENSION] = index + 0.25;
    positions[index * DIMENSION + 1] = -index - 0.5;
    colors[index * 4] = index + 1;
    colors[index * 4 + 1] = index + 31;
    colors[index * 4 + 2] = index + 61;
    colors[index * 4 + 3] = 255 - index;
  }
  return { colors, positions };
}

function makeRendererFixture({
  maxTextureSize = 4,
  // A draw order over 13 points: three full rows of a 4-wide texture and a
  // one-texel terminal row.
  drawIndices = Uint32Array.from([
    12, 2, 9, 0, 7, 3, 11, 1, 8, 5, 4, 10, 6,
  ]),
  pointCount = 13,
} = {}) {
  const gl = createTrackingGl(maxTextureSize);
  const { colors, positions } = makePointData(pointCount);
  const drawOrder = Object.freeze({ indices: drawIndices, pointCount });
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _alphaTexHeight: 0,
      _alphaTexWidth: 0,
      _alphaTexture: null,
      _alphaTextureByteLength: 0,
      _colors: colors,
      _dummyLodIndexTexture: null,
      _dummyLodIndexTextureByteLength: 0,
      _colorGpuByteLength: 0,
      _positionGpuByteLength: 0,
      _liveGeometryGeneration: 17,
      _liveOrder: null,
      _pendingDataRetirements: new Set(),
      _pendingSnapshotRetirements: new Set(),
      _perViewState: new Map(),
      _positions: positions,
      _snapshotGeometryPools: new Map(),
      currentDimensionLevel: DIMENSION,
      _useAlphaTexture: false,
      buffers: {
        colors: gl._adoptBuffer(),
        positions: gl._adoptBuffer(),
      },
      gl,
      pointCount,
      snapshotBuffers: new Map(),
      spatialIndices: new Map(),
      stats: { gpuMemoryMB: 0 },
      vao: gl._adoptVertexArray(),
    },
  );
  return {
    colors,
    drawIndices,
    drawOrder,
    gl,
    positions,
    renderer,
  };
}

// Row length and image height are never set by the app (asserted below):
// they stay 0, so the uploads neither read nor change them.
function makeHostileUnpackState(label) {
  return Object.freeze({
    alignment: 8,
    imageHeight: 0,
    pixelUnpackBuffer: Object.freeze({
      id: `${label}-pixel-unpack-buffer`,
    }),
    rowLength: 0,
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

test('draw-order R32UI staging allocates without a padded host duplicate and streams the order itself', () => {
  const fixture = makeRendererFixture();
  const hostileState = makeHostileUnpackState('order-success');
  fixture.gl._setUnpackState(hostileState);

  const record = fixture.renderer._createStoreOrder(
    fixture.drawOrder,
    'test draw order',
  );

  const textureOperations =
    fixture.gl._state.textureOperations.filter(
      operation => operation.texture === record.texture,
    );
  const allocations = findR32uiAllocation(textureOperations);
  const rowUploads = textureOperations.filter(
    operation => operation.kind === 'texSubImage2D',
  );

  assert.equal(allocations.length, 1);
  assert.equal(allocations[0].width, 4);
  assert.equal(allocations[0].height, 4);
  assert.equal(
    allocations[0].data,
    null,
    'R32UI storage must not receive a padded width*height Uint32Array duplicate',
  );
  assert.equal(allocations[0].depth, 1);
  // The complete rows go up in one call and the terminal row at its exact
  // width, both addressed into the order itself: no scratch at all.
  assert.equal(rowUploads.length, 2);
  const [fullRows, terminalRow] = rowUploads;
  for (const upload of rowUploads) {
    assertNeutralUploadState(upload, 4);
    assert.equal(upload.xOffset, 0);
    assert.equal(upload.zOffset, 0);
    assert.strictEqual(
      upload.data,
      fixture.drawIndices,
      'rows must be read from the draw order itself',
    );
  }
  assert.equal(fullRows.yOffset, 0);
  assert.equal(fullRows.height, 3);
  assert.equal(fullRows.srcOffset, 0);
  assert.equal(terminalRow.yOffset, 3);
  assert.equal(terminalRow.height, 1);
  assert.equal(terminalRow.width, 1);
  assert.equal(terminalRow.srcOffset, 12);
  assertExactUnpackState(
    fixture.gl._state.snapshotUnpack(),
    hostileState,
  );

  const textureBytes = 4 * 4 * UINT_BYTES;
  assert.equal(record.byteLength, textureBytes);
  assert.equal(record.plan.width, 4);
  assert.equal(record.plan.rowsPerLayer, 4);
  fixture.renderer._liveOrder = record;
  fixture.renderer._refreshGpuMemoryStats();
  assertExactKnownGpuBytes(fixture.renderer, textureBytes);
});

test('failed streamed R32UI replacement rolls back publication, restores unpack state, and byte-accounts a retry-owned texture exactly', () => {
  const fixture = makeRendererFixture();
  const accepted = fixture.renderer._createStoreOrder(
    fixture.drawOrder,
    'accepted draw order',
  );
  fixture.renderer._liveOrder = accepted;
  fixture.renderer._refreshGpuMemoryStats();
  const acceptedBytes = accepted.byteLength;

  const replacement = Object.freeze({
    indices: Uint32Array.from([1, 11, 4, 9, 0, 12, 3, 8, 5, 2, 6, 10, 7]),
    pointCount: 13,
  });
  const hostileState = makeHostileUnpackState('order-failure');
  fixture.gl._setUnpackState(hostileState);
  fixture.gl._state.fail.rejectTexSubImageAt =
    fixture.gl._state.texSubImageCount + 2;
  fixture.gl._state.fail.deleteTextureBefore = true;

  assert.throws(
    () => fixture.renderer._createStoreOrder(
      replacement,
      'replacement draw order',
    ),
    /WebGL|texture|cleanup|publication|upload/i,
  );

  assert.strictEqual(fixture.renderer._liveOrder, accepted);
  assert.equal(fixture.gl._state.live.textures.has(accepted.texture), true);
  assertExactUnpackState(
    fixture.gl._state.snapshotUnpack(),
    hostileState,
  );
  assert.equal(fixture.renderer._pendingDataRetirements.size, 1);

  const candidateTexture = fixture.gl._state.creates.textures.at(-1);
  assert.notStrictEqual(candidateTexture, accepted.texture);
  assert.equal(fixture.gl._state.live.textures.has(candidateTexture), true);
  assert.equal(
    fixture.gl._state.live.buffers.size,
    2,
    'only the two live streams may remain live',
  );

  const candidateTextureBytes = 4 * 4 * UINT_BYTES;
  fixture.renderer._refreshGpuMemoryStats();
  assertExactKnownGpuBytes(
    fixture.renderer,
    acceptedBytes + candidateTextureBytes,
  );

  fixture.gl._state.fail.deleteTextureBefore = false;
  assert.deepEqual(fixture.renderer._drainDataRetirements(), []);
  assert.equal(fixture.renderer._pendingDataRetirements.size, 0);
  assert.equal(fixture.gl._state.live.textures.has(candidateTexture), false);
  fixture.renderer._refreshGpuMemoryStats();
  assertExactKnownGpuBytes(fixture.renderer, acceptedBytes);
});

test('odd-width multi-row R8 creation and update use alignment 1, neutral unpack addressing, and restore caller state', () => {
  const pointCount = 5;
  const gl = createTrackingGl(3);
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _alphaTexHeight: 0,
      _alphaTexWidth: 0,
      _alphaTexture: null,
      _alphaTextureByteLength: 0,
      _dummyLodIndexTexture: null,
      _dummyLodIndexTextureByteLength: 0,
      _colorGpuByteLength: 0,
      _positionGpuByteLength: 0,
      _pendingDataRetirements: new Set(),
      _pendingSnapshotRetirements: new Set(),
      _perViewState: new Map(),
      _useAlphaTexture: false,
      buffers: {},
      gl,
      pointCount,
      snapshotBuffers: new Map(),
      stats: { gpuMemoryMB: 0 },
    },
  );
  const hostileState = makeHostileUnpackState('alpha');
  gl._setUnpackState(hostileState);

  renderer._createAlphaTexture(pointCount);

  // A power-of-two width: 2 (the largest at most MAX_TEXTURE_SIZE = 3).
  assert.equal(renderer._alphaTexWidth, 2);
  assert.equal(renderer._alphaTexHeight, 3);
  // No CPU image of the texture is kept (the accepted bytes are the
  // published values themselves).
  assert.equal(renderer._alphaTexData, undefined);
  assertExactKnownGpuBytes(renderer, 6);
  const allocation = gl._state.textureOperations.find(
    operation => (
      operation.kind === 'texStorage2D' &&
      operation.internalFormat === gl.R8
    ),
  );
  assert.ok(allocation);
  const createUpload = gl._state.textureOperations.find(
    operation => operation.kind === 'texSubImage2D' && operation.texture === allocation.texture,
  );
  assert.ok(createUpload);
  assert.equal(createUpload.width, 2);
  assert.equal(createUpload.height, 3);
  assertNeutralUploadState(createUpload, 1);
  assertExactUnpackState(gl._state.snapshotUnpack(), hostileState);

  gl._state.textureOperations.length = 0;
  renderer._updateAlphaTexture(
    Uint8Array.from([0, 1, 0, 1, 0]),
  );
  const updateUpload = gl._state.textureOperations.find(
    operation => operation.kind === 'texSubImage2D',
  );
  assert.ok(updateUpload);
  assert.equal(updateUpload.width, 2);
  assert.equal(updateUpload.height, 3);
  assertNeutralUploadState(updateUpload, 1);
  assertExactUnpackState(gl._state.snapshotUnpack(), hostileState);
  assert.deepEqual(
    Array.from(updateUpload.data.subarray(updateUpload.srcOffset, updateUpload.srcOffset + 6)),
    [0, 255, 0, 255, 0, 255],
  );
  assert.equal(renderer._useAlphaTexture, true);
  const acceptedAlphaData = renderer._currentAlphas;
  const acceptedAlphaBytes = Array.from(acceptedAlphaData);
  const acceptedAlphaTexture = renderer._alphaTexture;

  const failureState = Object.freeze({
    ...makeHostileUnpackState('alpha-failure'),
    alignment: 2,
    rowLength: 23,
  });
  gl._setUnpackState(failureState);
  gl._state.fail.rejectTexSubImageAt =
    gl._state.texSubImageCount + 1;
  assert.throws(
    () => renderer._updateAlphaTexture(
      Uint8Array.from([1, 0, 1, 0, 1]),
    ),
    /WebGL|alpha|publication/i,
  );
  assert.equal(renderer._currentAlphas, acceptedAlphaData);
  assert.deepEqual(
    Array.from(renderer._currentAlphas),
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

test('no app code sets UNPACK_ROW_LENGTH or UNPACK_IMAGE_HEIGHT, so uploads never read them back', async () => {
  // Reading either is a synchronous GPU-process round trip in Chrome; the
  // uploads rely on both staying at their default 0.
  const root = new URL('../assets/js/', import.meta.url);
  const files = (await readdir(root, { recursive: true })).filter(name => name.endsWith('.js'));
  for (const name of files) {
    const source = await readFile(new URL(name, root), 'utf8');
    assert.doesNotMatch(source, /pixelStorei\(\s*gl\.UNPACK_(ROW_LENGTH|IMAGE_HEIGHT)/, name);
    assert.doesNotMatch(source, /getParameter\(\s*gl\.UNPACK_(ROW_LENGTH|IMAGE_HEIGHT)/, name);
  }
});
