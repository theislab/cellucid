import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';
import { createCpuPermuter } from './helpers/cpu-permuter.mjs';
import { bufferOf, pointStoreOver, vaoOf } from './helpers/point-stores.mjs';
import { planLinearTexture } from '../assets/js/rendering/linear-texture.js';

const MIB = 1024 * 1024;

function copyBytes(view) {
  return Uint8Array.from(
    new Uint8Array(
      view.buffer,
      view.byteOffset,
      view.byteLength,
    )
  );
}

function createTrackingGl(maxTextureSize = 4) {
  let nextId = 1;
  let arrayBufferBinding = null;
  let pixelUnpackBufferBinding = null;
  let vertexArrayBinding = null;
  let activeTextureUnit = 0;
  let pendingError = 0;
  let bufferUploadCount = 0;
  let maxTextureSizeQueryCount = 0;
  let textureUploadCount = 0;
  const textureBindings = new Map();
  const unpackState = new Map();
  const live = {
    buffers: new Set(),
    textures: new Set(),
    vertexArrays: new Set(),
  };
  const deleted = {
    buffers: [],
    textures: [],
    vertexArrays: [],
  };
  const bufferBytes = new Map();
  const textureBytes = new Map();
  const textureDimensions = new Map();
  const freshTextures = new Set();
  const textureUploads = [];
  const uniformCalls = [];
  const vertexAttribCalls = [];
  const fail = {
    bufferUploads: new Set(),
    deleteBufferBefore: false,
    deleteTextureBefore: false,
    deleteTextureThenThrow: false,
    deleteVertexArrayBefore: false,
    textureUploads: new Set(),
  };

  const createHandle = kind => {
    const handle = Object.freeze({
      id: `${kind}-${nextId++}`,
      kind,
    });
    if (kind === 'buffer') live.buffers.add(handle);
    if (kind === 'texture') live.textures.add(handle);
    if (kind === 'vao') live.vertexArrays.add(handle);
    return handle;
  };

  const requireTextureBinding = () => {
    const texture = textureBindings.get(activeTextureUnit) ?? null;
    assert.ok(texture, 'texture upload requires one bound texture');
    assert.equal(live.textures.has(texture), true);
    return texture;
  };

  const maybeRejectTextureUpload = () => {
    textureUploadCount += 1;
    if (fail.textureUploads.has(textureUploadCount)) {
      return true;
    }
    return false;
  };

  const gl = {
    ARRAY_BUFFER: 0x8892,
    CLAMP_TO_EDGE: 0x812f,
    CURRENT_PROGRAM: 0x8b8d,
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
    RED: 0x1903,
    STATIC_DRAW: 0x88e4,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE_2D: 0x0de1,
    TEXTURE_2D_ARRAY: 0x8c1a,
    TEXTURE_BINDING_2D: 0x8069,
    TEXTURE_BINDING_2D_ARRAY: 0x8c1d,
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

    activeTexture(unit) {
      assert.ok(unit === this.TEXTURE0 || unit === this.TEXTURE1);
      activeTextureUnit = unit - this.TEXTURE0;
    },
    bindBuffer(target, buffer) {
      if (target === this.ARRAY_BUFFER) {
        arrayBufferBinding = buffer;
        return;
      }
      if (target === this.PIXEL_UNPACK_BUFFER) {
        pixelUnpackBufferBinding = buffer;
        return;
      }
      if (target === this.ELEMENT_ARRAY_BUFFER) return;
      throw new TypeError(`unexpected buffer target ${target}`);
    },
    bindTexture(target, texture) {
      assert.ok(target === this.TEXTURE_2D || target === this.TEXTURE_2D_ARRAY);
      if (texture !== null) {
        assert.equal(
          live.textures.has(texture),
          true,
          'cannot bind an unknown texture'
        );
      }
      textureBindings.set(activeTextureUnit, texture);
    },
    bindVertexArray(vao) {
      if (vao !== null) {
        assert.equal(live.vertexArrays.has(vaoOf(vao)), true);
      }
      vertexArrayBinding = vao;
    },
    bufferData(target, source) {
      assert.equal(target, this.ARRAY_BUFFER);
      assert.ok(arrayBufferBinding);
      bufferUploadCount += 1;
      if (fail.bufferUploads.has(bufferUploadCount)) {
        throw new Error('synthetic snapshot buffer upload failure');
      }
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
      bufferBytes.set(arrayBufferBinding, Uint8Array.from(bytes));
    },
    bufferSubData(target, dstByteOffset, source, sourceOffset = 0, length) {
      assert.equal(target, this.ARRAY_BUFFER);
      assert.ok(arrayBufferBinding);
      const store = bufferBytes.get(bufferOf(arrayBufferBinding));
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
    createBuffer() {
      return createHandle('buffer');
    },
    createTexture() {
      return createHandle('texture');
    },
    createVertexArray() {
      return createHandle('vao');
    },
    deleteBuffer(handle) {
      if (fail.deleteBufferBefore) {
        throw new Error('synthetic pre-delete buffer failure');
      }
      live.buffers.delete(handle);
      bufferBytes.delete(handle);
      deleted.buffers.push(handle);
      if (arrayBufferBinding === handle) arrayBufferBinding = null;
    },
    deleteTexture(handle) {
      if (fail.deleteTextureBefore) {
        throw new Error('synthetic pre-delete texture failure');
      }
      live.textures.delete(handle);
      textureBytes.delete(handle);
      textureDimensions.delete(handle);
      deleted.textures.push(handle);
      for (const [unit, binding] of textureBindings) {
        if (binding === handle) textureBindings.set(unit, null);
      }
      if (fail.deleteTextureThenThrow) {
        throw new Error('synthetic post-delete texture wrapper failure');
      }
    },
    deleteVertexArray(handle) {
      if (fail.deleteVertexArrayBefore) {
        throw new Error('synthetic pre-delete vertex-array failure');
      }
      live.vertexArrays.delete(handle);
      deleted.vertexArrays.push(handle);
      if (vertexArrayBinding === handle) vertexArrayBinding = null;
    },
    enableVertexAttribArray() {
      assert.ok(vertexArrayBinding);
    },
    getError() {
      const error = pendingError;
      pendingError = this.NO_ERROR;
      return error;
    },
    getParameter(parameter) {
      if (parameter === this.MAX_TEXTURE_SIZE) {
        maxTextureSizeQueryCount += 1;
        return maxTextureSize;
      }
      if (parameter === this.PIXEL_UNPACK_BUFFER_BINDING) {
        return pixelUnpackBufferBinding;
      }
      if (parameter === this.TEXTURE_BINDING_2D || parameter === this.TEXTURE_BINDING_2D_ARRAY) {
        return textureBindings.get(activeTextureUnit) ?? null;
      }
      if (parameter === this.MAX_ARRAY_TEXTURE_LAYERS) return 256;
      if (parameter === this.CURRENT_PROGRAM) return null;
      if (unpackState.has(parameter)) {
        return unpackState.get(parameter);
      }
      throw new TypeError(`unexpected WebGL parameter ${parameter}`);
    },
    isBuffer(handle) {
      return live.buffers.has(bufferOf(handle));
    },
    isTexture(handle) {
      return live.textures.has(handle);
    },
    isVertexArray(handle) {
      return live.vertexArrays.has(vaoOf(handle));
    },
    pixelStorei(parameter, value) {
      assert.equal(unpackState.has(parameter), true);
      unpackState.set(parameter, value);
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
      assert.equal(target, this.TEXTURE_2D);
      const texture = requireTextureBinding();
      const rejected = maybeRejectTextureUpload();
      textureUploads.push({
        data: copyBytes(data),
        height,
        kind: 'texImage2D',
        rejected,
        texture,
        width,
      });
      if (rejected) throw new TypeError('WebGL rejected the texture upload.');
      assert.equal(level, 0);
      assert.equal(internalFormat, this.R8);
      assert.equal(border, 0);
      assert.equal(format, this.RED);
      assert.equal(type, this.UNSIGNED_BYTE);
      assert.equal(data.byteLength, width * height);
      textureBytes.set(texture, copyBytes(data));
      textureDimensions.set(texture, { height, width });
    },
    texParameteri() {},
    // Linear textures (rendering/linear-texture.js): storage, then a first
    // whole-image write (recorded as the creating upload) or a later update.
    texStorage3D(target, levels, internalFormat, width, height, depth) {
      assert.equal(target, this.TEXTURE_2D_ARRAY);
      assert.equal(levels, 1);
      assert.equal(internalFormat, this.R8);
      assert.equal(depth, 1, 'these fixtures fit one layer');
      const texture = requireTextureBinding();
      textureDimensions.set(texture, { height, width });
      freshTextures.add(texture);
    },
    texSubImage3D(
      target, level, xOffset, yOffset, zOffset, width, height, depth, format, type, data, srcOffset = 0,
    ) {
      assert.equal(target, this.TEXTURE_2D_ARRAY);
      const texture = requireTextureBinding();
      const region = copyBytes(data).subarray(srcOffset, srcOffset + width * height);
      const kind = freshTextures.has(texture) ? 'texImage2D' : 'texSubImage2D';
      const rejected = maybeRejectTextureUpload();
      textureUploads.push({ data: region, height, kind, rejected, texture, width });
      if (rejected) {
        // Rows written into a texture fail synchronously or not at all
        // (WebGL throws for arguments it rejects); nothing is read back.
        throw new TypeError('WebGL rejected the R8 texSubImage3D upload.');
      }
      assert.equal(level, 0);
      // Whole rows: a fresh texture is written whole, an accepted one in the
      // row regions that moved.
      const dimensions = textureDimensions.get(texture);
      assert.equal([xOffset, zOffset, depth].join(), '0,0,1');
      assert.equal(width, dimensions.width);
      assert.ok(yOffset >= 0 && yOffset + height <= dimensions.height);
      if (freshTextures.has(texture)) {
        assert.deepEqual({ height, width }, dimensions);
      }
      assert.equal(format, this.RED);
      assert.equal(type, this.UNSIGNED_BYTE);
      const image = textureBytes.get(texture) ?? new Uint8Array(dimensions.width * dimensions.height);
      const next = image.slice();
      next.set(region, yOffset * width);
      textureBytes.set(texture, next);
      freshTextures.delete(texture);
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
      assert.equal(target, this.TEXTURE_2D);
      const texture = requireTextureBinding();
      const rejected = maybeRejectTextureUpload();
      textureUploads.push({
        data: copyBytes(data),
        height,
        kind: 'texSubImage2D',
        rejected,
        texture,
        width,
      });
      if (rejected) throw new TypeError('WebGL rejected the texture upload.');
      assert.equal(level, 0);
      assert.equal(xOffset, 0);
      assert.equal(yOffset, 0);
      assert.equal(format, this.RED);
      assert.equal(type, this.UNSIGNED_BYTE);
      assert.deepEqual(
        textureDimensions.get(texture),
        { height, width },
      );
      assert.equal(data.byteLength, width * height);
      textureBytes.set(texture, copyBytes(data));
    },
    uniform1f(location, value) {
      uniformCalls.push({ kind: 'uniform1f', location, value });
    },
    uniform1i(location, value) {
      uniformCalls.push({ kind: 'uniform1i', location, value });
    },
    uniform2i(location, x, y) {
      uniformCalls.push({ kind: 'uniform2i', location, value: [x, y] });
    },
    useProgram() {},
    vertexAttribPointer(
      index,
      size,
      type,
      normalized,
      stride,
      offset,
    ) {
      assert.ok(vertexArrayBinding);
      assert.ok(arrayBufferBinding);
      vertexAttribCalls.push({
        buffer: arrayBufferBinding,
        index,
        normalized,
        offset,
        size,
        stride,
        type,
        vao: vertexArrayBinding,
      });
    },

    _state: {
      bufferBytes,
      deleted,
      fail,
      live,
      textureBindings,
      textureBytes,
      textureDimensions,
      textureUploads,
      uniformCalls,
      vertexAttribCalls,
      get activeTextureUnit() {
        return activeTextureUnit;
      },
      get bufferUploadCount() {
        return bufferUploadCount;
      },
      get maxTextureSizeQueryCount() {
        return maxTextureSizeQueryCount;
      },
      get textureUploadCount() {
        return textureUploadCount;
      },
    },
  };

  for (const [parameter, value] of [
    [gl.UNPACK_ALIGNMENT, 4],
    [gl.UNPACK_ROW_LENGTH, 0],
    [gl.UNPACK_IMAGE_HEIGHT, 0],
    [gl.UNPACK_SKIP_PIXELS, 0],
    [gl.UNPACK_SKIP_ROWS, 0],
    [gl.UNPACK_SKIP_IMAGES, 0],
  ]) {
    unpackState.set(parameter, value);
  }
  return gl;
}

function configureAccounting(renderer) {
  Object.assign(renderer, {
    _alphaTexHeight: 0,
    _alphaTexWidth: 0,
    _alphaTexture: null,
    _alphaTextureByteLength: 0,
    _dummyLodIndexTexture: null,
    _dummyLodIndexTextureByteLength: 0,
    _colorGpuByteLength: 0,
    _positionGpuByteLength: 0,
    _pendingDataRetirements: new Set(),
    _pendingProgramRetirements: new Set(),
    _pendingProgramUnbind: false,
    _pendingShaderRetirements: new Set(),
    _pendingSnapshotRetirements: new Set(),
    _perViewState: new Map(),
    buffers: {
      colors: null,
      positions: null,
    },
    stats: { gpuMemoryMB: 0 },
  });
}

function makePointData(pointCount) {
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);
  const alphas = new Uint8Array(pointCount);
  for (let index = 0; index < pointCount; index++) {
    positions[index * 3] = index + 0.25;
    positions[index * 3 + 1] = -index - 0.5;
    positions[index * 3 + 2] = index * 2 + 0.75;
    colors[index * 4] = 10 + index;
    colors[index * 4 + 1] = 30 + index;
    colors[index * 4 + 2] = 50 + index;
    colors[index * 4 + 3] = 5 + index * 50;
    alphas[index] = index % 2;
  }
  return { alphas, colors, positions };
}

function createRenderer({
  alphas = undefined,
  maxTextureSize = 4,
  pointCount = 5,
} = {}) {
  const gl = createTrackingGl(maxTextureSize);
  const renderer = Object.create(HighPerfRenderer.prototype);
  const pointData = makePointData(pointCount);
  const exactAlphas = alphas === undefined
    ? pointData.alphas
    : alphas;
  Object.assign(renderer, {
    gl,
    _permuter: createCpuPermuter(gl),
    pointCount,
    _positions: pointData.positions,
    currentDimensionLevel: 3,
    _liveGeometryGeneration: 1,
    _nextGeometryGeneration: 2,
    _snapshotGeometryPools: new Map(),
    snapshotBuffers: new Map(),
    forceLODLevel: -1,
    useAdaptiveLOD: false,
    useFrustumCulling: false,
  });
  configureAccounting(renderer);
  // The live publication's VBO, which a snapshot of the live generation
  // borrows. It is owned outside the snapshot storage under test, so it is not
  // one of the tracking context's handles.
  renderer.buffers = {
    positions: pointStoreOver(gl, Object.freeze({ kind: 'buffer', id: 'live-positions' }), pointCount, 12),
    colors: null,
  };
  renderer._positionGpuByteLength = pointData.positions.byteLength;
  renderer.createSnapshotBuffer(
    'snap_1',
    pointData.colors,
    exactAlphas,
    pointData.positions,
    3,
    'live',
  );
  return {
    alphas: exactAlphas,
    colors: pointData.colors,
    gl,
    positions: pointData.positions,
    renderer,
    snapshot: renderer.snapshotBuffers.get('snap_1'),
  };
}

/**
 * The R8 image a kept view's texture holds for its transparency: 255 for a
 * shown cell, 0 for a hidden one, 255 for every cell when it is null and for
 * the padding past the last cell. The colours' alpha byte is never read.
 */
function expectedAlphaBytes(alphas, pointCount, texelCount) {
  const result = new Uint8Array(texelCount);
  result.fill(255);
  if (alphas !== null) {
    for (let index = 0; index < pointCount; index++) {
      result[index] = alphas[index] * 255;
    }
  }
  return result;
}

/**
 * Every typed array reachable from the renderer's own fields and its kept
 * views' records holding an entry a cell, except the arrays a view was
 * published with (kept by reference) and the bounded row scratch: none may
 * exist, so no CPU copy of an image is held. (Row marks, an entry or two a
 * texture row, are not a copy.)
 */
function heldImageSizedArrays(renderer) {
  const published = new Set();
  for (const snapshot of renderer.snapshotBuffers.values()) {
    published.add(snapshot.alphas);
    published.add(snapshot.colors);
    published.add(snapshot.positions);
  }
  const found = [];
  const visit = (owner, path) => {
    for (const [key, value] of Object.entries(owner)) {
      if (!ArrayBuffer.isView(value) || published.has(value) || value === renderer._alphaRows) continue;
      for (const snapshot of renderer.snapshotBuffers.values()) {
        if (value.length >= snapshot.pointCount) found.push(`${path}.${key}`);
      }
    }
  };
  visit(renderer, 'renderer');
  for (const [id, snapshot] of renderer.snapshotBuffers) visit(snapshot, id);
  return found;
}

/** A snapshot colour store holds its RGBA8 colours as they are, 4 bytes a point. */
function expectedStoreBytes(colors) {
  return Uint8Array.from(colors);
}

function snapshotIdentity(snapshot) {
  return {
    alphas: snapshot.alphas,
    alphaTexture: snapshot.alphaTexture,
    buffer: snapshot.buffer,
    geometryGeneration: snapshot.geometryGeneration,
    positions: snapshot.positions,
    vao: snapshot.vao,
  };
}

function configureForDispose(renderer) {
  Object.assign(renderer, {
    _boundingSphere: null,
    _colorsDirty: false,
    _colors: null,
    _currentAlphas: null,
    _firstRenderDone: false,
    _useAlphaTexture: false,
    _validatedSpatialIndices: new WeakSet(),
    activeProgram: null,
    currentDimensionLevel: 3,
    programs: {
      full: null,
      light: null,
      ultralight: null,
    },
    spatialIndices: new Map(),
    uniformLocations: new Map(),
    vao: null,
  });
}

test('snapshot creation publishes exact source-order R8 ownership and accounts 30M multiview bytes', (t) => {
  const explicit = createRenderer();
  const {
    alphas,
    colors,
    gl,
    renderer,
    snapshot,
  } = explicit;
  const expected = expectedAlphaBytes(
    alphas,
    renderer.pointCount,
    snapshot.alphaTexWidth * snapshot.alphaTexHeight,
  );

  assert.ok(snapshot.alphaTexture);
  assert.equal(snapshot.alphaTextureByteLength, expected.byteLength);
  // The published transparency is kept by reference and is what the
  // texture holds; no CPU copy of the image exists, per view or shared.
  assert.strictEqual(snapshot.alphas, alphas);
  assert.equal(Object.hasOwn(snapshot, 'alphaTexData'), false);
  assert.equal(Object.hasOwn(renderer, '_snapshotAlphaStagingData'), false);
  assert.deepEqual(heldImageSizedArrays(renderer), []);
  assert.deepEqual(
    gl._state.textureBytes.get(snapshot.alphaTexture),
    expected,
  );
  assert.deepEqual(
    gl._state.bufferBytes.get(bufferOf(snapshot.buffer)),
    expectedStoreBytes(colors),
    'a snapshot colour store is RGBA8 on a 4-byte stride; its alpha is the one R8 owner, and the store\'s alpha byte is never read',
  );
  assert.equal(snapshot.bufferByteLength, renderer.pointCount * 4);
  const colorAttribute = gl._state.vertexAttribCalls
    .filter(call => call.vao === vaoOf(snapshot.vao) && call.index === 1)
    .at(-1);
  assert.deepEqual(
    colorAttribute,
    {
      buffer: bufferOf(snapshot.buffer),
      index: 1,
      normalized: true,
      offset: 0,
      size: 4,
      stride: 4,
      type: gl.UNSIGNED_BYTE,
      vao: vaoOf(snapshot.vao),
    },
  );
  // In source order the colours are the store's bytes: one direct upload,
  // no permute pass and no point-sized scratch beside the snapshot.
  assert.equal(Object.hasOwn(renderer, '_snapshotColorStagingData'), false);
  assert.equal(renderer._permuter.wordWrites[1], 0);
  assert.equal(
    renderer.stats.gpuMemoryMB * MIB,
    snapshot.positions.byteLength +
      snapshot.bufferByteLength +
      snapshot.alphaTextureByteLength,
  );

  const inherited = createRenderer({ alphas: null });
  assert.equal(inherited.snapshot.alphas, null);
  assert.deepEqual(
    inherited.gl._state.textureBytes.get(inherited.snapshot.alphaTexture),
    expectedAlphaBytes(
      null,
      inherited.renderer.pointCount,
      inherited.snapshot.alphaTexWidth *
        inherited.snapshot.alphaTexHeight,
    ),
    'null transparency shows every cell; the colours\' alpha byte is never read',
  );
  assert.deepEqual(
    inherited.gl._state.bufferBytes.get(
      bufferOf(inherited.snapshot.buffer)
    ),
    expectedStoreBytes(inherited.colors),
  );

  const pointCount = 30_000_000;
  const viewCount = 8;
  const maxTextureSize = 16_384;
  const width = Math.min(pointCount, maxTextureSize);
  const height = Math.ceil(pointCount / width);
  const alphaTextureBytes = width * height;
  const positionBytes =
    pointCount * 3 * Float32Array.BYTES_PER_ELEMENT;
  const perViewColorBytes =
    pointCount * 4 * Uint8Array.BYTES_PER_ELEMENT;
  const scaled = Object.create(HighPerfRenderer.prototype);
  configureAccounting(scaled);
  scaled.pointCount = pointCount;
  scaled._snapshotGeometryPools = new Map([
    [1, {
      dimension: 3,
      generation: 1,
      positionBuffer: { id: 'shared-position' },
      positionBufferByteLength: positionBytes,
      positions: null,
      refCount: viewCount,
      spatialIndices: new Map(),
    }],
  ]);
  scaled.snapshotBuffers = new Map(
    Array.from({ length: viewCount }, (_, index) => [
      `snap_${index + 1}`,
      {
        alphaTexture: { id: `alpha-${index + 1}` },
        alphaTextureByteLength: alphaTextureBytes,
        buffer: { id: `color-${index + 1}` },
        bufferByteLength: perViewColorBytes,
        pointCount,
      },
    ])
  );
  const expectedGpuBytes =
    positionBytes +
    viewCount * (perViewColorBytes + alphaTextureBytes);
  assert.equal(scaled._refreshGpuMemoryStats(), expectedGpuBytes);
  assert.equal(
    scaled.stats.gpuMemoryMB * MIB,
    expectedGpuBytes,
  );
  const physicalPaddingBytes =
    viewCount * (alphaTextureBytes - pointCount);
  assert.ok(
    physicalPaddingBytes >= 0 &&
      physicalPaddingBytes < viewCount * maxTextureSize,
    'physical R8 padding is bounded by less than one texture row per view',
  );
  t.diagnostic(
    `eight 30M-point views account ${expectedGpuBytes.toLocaleString()} ` +
    `GPU bytes (${physicalPaddingBytes.toLocaleString()} bounded texture-` +
    `padding bytes above the unchanged 4N/view payload); no CPU copy of ` +
    `any view's R8 image is held (each keeps its published transparency ` +
    `by reference), where a padded copy a view plus a shared staging copy ` +
    `held ${((viewCount + 1) * alphaTextureBytes).toLocaleString()} bytes`,
  );
});

test('alpha-only updates perform one R8 upload without color, position, VAO, or geometry churn', () => {
  const {
    gl,
    renderer,
    snapshot,
  } = createRenderer();
  assert.equal(typeof renderer.updateSnapshotAlphas, 'function');
  const before = snapshotIdentity(snapshot);
  const beforeBufferUploads = gl._state.bufferUploadCount;
  const beforeCapabilityQueries =
    gl._state.maxTextureSizeQueryCount;
  const beforeTextureUploads = gl._state.textureUploadCount;
  const replacement = Uint8Array.from([
    1,
    0,
    1,
    1,
    0,
  ]);

  assert.equal(
    renderer.updateSnapshotAlphas('snap_1', replacement),
    true,
  );
  assert.deepEqual(
    snapshotIdentity(snapshot),
    {
      ...before,
      alphas: replacement,
    },
    'the accepted transparency is the published array, by reference',
  );
  assert.equal(gl._state.bufferUploadCount, beforeBufferUploads);
  assert.equal(
    gl._state.maxTextureSizeQueryCount,
    beforeCapabilityQueries,
    'alpha-only publication reuses the accepted layout without a synchronous capability query',
  );
  assert.equal(
    gl._state.textureUploadCount,
    beforeTextureUploads + 1,
  );
  assert.deepEqual(
    gl._state.textureBytes.get(snapshot.alphaTexture),
    expectedAlphaBytes(
      replacement,
      renderer.pointCount,
      snapshot.alphaTexPlan.texels,
    ),
  );
  assert.deepEqual(heldImageSizedArrays(renderer), []);

  const uploadsBeforeNoop = gl._state.textureUploadCount;
  const sameQuantizedGeneration = Uint8Array.from(replacement);
  assert.equal(
    renderer.updateSnapshotAlphas(
      'snap_1',
      sameQuantizedGeneration
    ),
    false,
    'an update that moves no byte says so, so the viewer skips its visibility work',
  );
  assert.equal(
    gl._state.textureUploadCount,
    uploadsBeforeNoop,
  );
  assert.equal(
    gl._state.maxTextureSizeQueryCount,
    beforeCapabilityQueries,
    'a quantized no-op also performs no synchronous capability query',
  );
  assert.deepEqual(snapshotIdentity(snapshot), {
    ...before,
    alphas: sameQuantizedGeneration,
  });

  const uploadsBeforeInvalid = gl._state.textureUploadCount;
  const invalid = replacement.slice();
  invalid[3] = 2;
  assert.throws(
    () => renderer.updateSnapshotAlphas('snap_1', invalid),
    /alpha.*index 3|index 3.*alpha/i,
  );
  assert.equal(
    gl._state.textureUploadCount,
    uploadsBeforeInvalid,
  );
  assert.strictEqual(snapshot.alphas, sameQuantizedGeneration);
});

test('color-only and position-only updates preserve independent snapshot owners', async (t) => {
  await t.test('color-only preserves alpha and geometry', () => {
    const {
      gl,
      renderer,
      snapshot,
    } = createRenderer();
    assert.equal(typeof renderer.updateSnapshotColors, 'function');
    const before = snapshotIdentity(snapshot);
    const geometry = renderer._snapshotGeometryPools.get(
      snapshot.geometryGeneration
    );
    const positionBuffer = geometry.positionBuffer;
    const beforeBufferUploads = gl._state.bufferUploadCount;
    const beforeTextureUploads = gl._state.textureUploadCount;
    const replacement = Uint8Array.from(
      { length: renderer.pointCount * 4 },
      (_, index) => (index * 17 + 3) & 0xff,
    );

    assert.equal(
      renderer.updateSnapshotColors('snap_1', replacement),
      true,
    );
    // The view alone owns its store: the colours are gathered into it in
    // place, with no new buffer or vertex array.
    assert.strictEqual(snapshot.buffer, before.buffer);
    assert.strictEqual(snapshot.vao, before.vao);
    assert.strictEqual(snapshot.colors, replacement);
    assert.strictEqual(snapshot.alphaTexture, before.alphaTexture);
    assert.strictEqual(snapshot.alphas, before.alphas);
    assert.strictEqual(snapshot.positions, before.positions);
    assert.equal(
      snapshot.geometryGeneration,
      before.geometryGeneration,
    );
    assert.strictEqual(
      renderer._snapshotGeometryPools.get(
        snapshot.geometryGeneration
      ),
      geometry,
    );
    assert.strictEqual(geometry.positionBuffer, positionBuffer);
    assert.deepEqual(
      gl._state.bufferBytes.get(bufferOf(snapshot.buffer)),
      expectedStoreBytes(replacement),
    );
    assert.equal(
      gl._state.bufferUploadCount,
      beforeBufferUploads,
      'an in-place recolour allocates no store',
    );
    assert.equal(
      gl._state.textureUploadCount,
      beforeTextureUploads,
    );
  });

  await t.test('position-only preserves color and alpha', () => {
    const {
      gl,
      renderer,
      snapshot,
    } = createRenderer();
    const before = snapshotIdentity(snapshot);
    const beforeColorBytes = Uint8Array.from(
      gl._state.bufferBytes.get(bufferOf(snapshot.buffer))
    );
    const beforeBufferUploads = gl._state.bufferUploadCount;
    const beforeTextureUploads = gl._state.textureUploadCount;
    const replacement = snapshot.positions.slice();
    replacement[0] += 10;

    assert.equal(
      renderer.updateSnapshotPositions('snap_1', replacement, 3),
      true,
    );
    assert.strictEqual(snapshot.buffer, before.buffer);
    assert.strictEqual(snapshot.alphaTexture, before.alphaTexture);
    assert.strictEqual(snapshot.alphas, before.alphas);
    assert.notStrictEqual(snapshot.vao, before.vao);
    assert.notStrictEqual(snapshot.positions, before.positions);
    assert.notEqual(
      snapshot.geometryGeneration,
      before.geometryGeneration,
    );
    assert.deepEqual(
      gl._state.bufferBytes.get(bufferOf(snapshot.buffer)),
      beforeColorBytes,
    );
    assert.equal(
      gl._state.bufferUploadCount,
      beforeBufferUploads + 1,
      'position-only publication uploads only the new position VBO',
    );
    assert.equal(
      gl._state.textureUploadCount,
      beforeTextureUploads,
    );
  });
});

test('failed alpha, color, and position publications preserve accepted owners and retry exactly', async (t) => {
  await t.test('one failed R8 upload restores accepted bytes', () => {
    const {
      gl,
      renderer,
      snapshot,
    } = createRenderer();
    const before = snapshotIdentity(snapshot);
    const accepted = snapshot.alphas;
    const acceptedImage = expectedAlphaBytes(
      accepted,
      renderer.pointCount,
      snapshot.alphaTexPlan.texels,
    );
    const nextUpload = gl._state.textureUploadCount + 1;
    gl._state.fail.textureUploads.add(nextUpload);
    const replacement = Uint8Array.from([
      1, 0, 1, 0, 1,
    ]);

    assert.throws(
      () => renderer.updateSnapshotAlphas(
        'snap_1',
        replacement
      ),
      /WebGL|alpha|texture/i,
    );
    assert.deepEqual(snapshotIdentity(snapshot), before);
    assert.strictEqual(snapshot.alphas, accepted);
    assert.deepEqual(
      gl._state.textureBytes.get(snapshot.alphaTexture),
      acceptedImage,
      'the restoration rewrites the touched rows from the accepted array',
    );
    assert.equal(
      gl._state.textureUploadCount,
      nextUpload + 1,
      'failure is followed by one exact restoration upload',
    );

    gl._state.fail.textureUploads.clear();
    assert.equal(
      renderer.updateSnapshotAlphas('snap_1', replacement),
      true,
    );
  });

  await t.test('double R8 failure detaches poisoned texture and retries from the accepted array', () => {
    const {
      gl,
      renderer,
      snapshot,
    } = createRenderer();
    const accepted = snapshot.alphas;
    const poisonedTexture = snapshot.alphaTexture;
    const nextUpload = gl._state.textureUploadCount + 1;
    gl._state.fail.textureUploads.add(nextUpload);
    gl._state.fail.textureUploads.add(nextUpload + 1);
    const replacement = Uint8Array.from([
      0, 1, 1, 0, 1,
    ]);

    assert.throws(
      () => renderer.updateSnapshotAlphas(
        'snap_1',
        replacement
      ),
      error => error instanceof AggregateError,
    );
    assert.equal(snapshot.alphaTexture, null);
    assert.equal(snapshot.alphaTextureByteLength, 0);
    assert.strictEqual(snapshot.alphas, accepted);
    assert.equal(gl._state.live.textures.has(poisonedTexture), false);

    gl._state.fail.textureUploads.clear();
    assert.equal(
      renderer.updateSnapshotAlphas('snap_1', replacement),
      true,
    );
    assert.ok(snapshot.alphaTexture);
    assert.notStrictEqual(snapshot.alphaTexture, poisonedTexture);
    assert.strictEqual(snapshot.alphas, replacement);
    assert.deepEqual(
      gl._state.textureBytes.get(snapshot.alphaTexture),
      expectedAlphaBytes(replacement, renderer.pointCount, snapshot.alphaTexPlan.texels),
      'the recovered texture is rebuilt from the accepted array, then the moved rows are sent',
    );
  });

  await t.test('color and position upload failures leave all accepted handles intact', () => {
    const {
      gl,
      renderer,
      snapshot,
    } = createRenderer();
    const colorBefore = snapshotIdentity(snapshot);
    const colorsBefore = snapshot.colors;
    // A write into the accepted store fails synchronously (WebGL throws for
    // arguments it rejects) and writes nothing.
    const bufferSubData = gl.bufferSubData;
    gl.bufferSubData = () => {
      throw new TypeError('WebGL rejected the colour store write.');
    };
    assert.throws(
      () => renderer.updateSnapshotColors(
        'snap_1',
        new Uint8Array(renderer.pointCount * 4)
      ),
      /rejected the colour store write/,
    );
    gl.bufferSubData = bufferSubData;
    assert.deepEqual(snapshotIdentity(snapshot), colorBefore);
    assert.strictEqual(snapshot.colors, colorsBefore, 'the accepted colours stay published');

    gl._state.fail.bufferUploads.clear();
    const positionBefore = snapshotIdentity(snapshot);
    const replacementPositions = snapshot.positions.slice();
    replacementPositions[0] += 1;
    gl._state.fail.bufferUploads.add(
      gl._state.bufferUploadCount + 1
    );
    assert.throws(
      () => renderer.updateSnapshotPositions(
        'snap_1',
        replacementPositions,
        3,
      ),
      /synthetic snapshot buffer upload failure/,
    );
    assert.deepEqual(snapshotIdentity(snapshot), positionBefore);

    gl._state.fail.bufferUploads.clear();
    assert.equal(
      renderer.updateSnapshotPositions(
        'snap_1',
        replacementPositions,
        3,
      ),
      true,
    );
  });
});

test('snapshot alpha retirement survives hostile cleanup and disposal retry', async (t) => {
  await t.test('repeated position publications retain one RGB owner behind every hostile VAO barrier', () => {
    const {
      gl,
      renderer,
      snapshot,
    } = createRenderer();
    const colorOwner = snapshot.colorOwner;
    const colorBuffer = snapshot.buffer;
    const alphaTexture = snapshot.alphaTexture;
    const positionByteLength = snapshot.positions.byteLength;
    assert.ok(colorOwner);
    assert.equal(colorOwner.refCount, 1);
    gl._state.fail.deleteVertexArrayBefore = true;

    const firstPositions = snapshot.positions.slice();
    firstPositions[0] += 1;
    assert.equal(
      renderer.updateSnapshotPositions(
        'snap_1',
        firstPositions,
        3,
      ),
      true,
    );
    assert.strictEqual(snapshot.colorOwner, colorOwner);
    assert.strictEqual(snapshot.buffer, colorBuffer);
    assert.strictEqual(snapshot.alphaTexture, alphaTexture);
    assert.equal(colorOwner.refCount, 2);
    assert.equal(renderer._pendingSnapshotRetirements.size, 1);

    // The 1D embedding of the same cells: one component per point.
    const secondPositions = new Float32Array(renderer.pointCount).map(
      (_, point) => snapshot.positions[point * 3] + 2,
    );
    assert.equal(
      renderer.updateSnapshotPositions(
        'snap_1',
        secondPositions,
        1,
      ),
      true,
    );
    assert.strictEqual(snapshot.colorOwner, colorOwner);
    assert.strictEqual(snapshot.buffer, colorBuffer);
    assert.strictEqual(snapshot.alphaTexture, alphaTexture);
    assert.equal(colorOwner.refCount, 3);
    assert.equal(renderer._pendingSnapshotRetirements.size, 2);
    assert.equal(
      renderer._refreshGpuMemoryStats(),
      // Two 3D generations plus the 1D one, which costs 4 bytes a point.
      2 * positionByteLength +
        secondPositions.byteLength +
        snapshot.bufferByteLength +
        snapshot.alphaTextureByteLength,
      'one shared RGB handle is counted once while all three position generations remain VAO-reachable',
    );

    assert.throws(
      () => renderer.deleteSnapshotBuffer('snap_1'),
      error => (
        error instanceof AggregateError &&
        /retirement remains pending/i.test(error.message)
      ),
    );
    assert.equal(renderer.snapshotBuffers.size, 0);
    assert.equal(colorOwner.refCount, 3);
    assert.equal(gl._state.live.buffers.has(bufferOf(colorBuffer)), true);
    assert.equal(gl._state.live.textures.has(alphaTexture), true);
    assert.equal(renderer._pendingSnapshotRetirements.size, 3);

    gl._state.fail.deleteVertexArrayBefore = false;
    assert.doesNotThrow(
      () => renderer.deleteSnapshotBuffer('snap_1')
    );
    assert.equal(renderer._pendingSnapshotRetirements.size, 0);
    // Once their last VAO is gone, the three position generations are
    // retained for reuse rather than deleted; eviction deletes them.
    const retained = [...renderer._snapshotGeometryPools.values()];
    assert.equal(retained.length, 3);
    assert.ok(retained.every(geometry => geometry.refCount === 0 && geometry.retained === true));
    // The first generation borrows the live VBO, which stays the live
    // publication's; the two the snapshot uploaded are retained storage.
    const [borrowed, ...owned] = retained;
    assert.equal(borrowed.borrowsLivePositionBuffer, true);
    assert.equal(owned.length, 2);
    assert.ok(owned.every(geometry => gl._state.live.buffers.has(bufferOf(geometry.positionBuffer))));
    assert.equal(
      renderer.getRetainedGeometryBytes(),
      positionByteLength + secondPositions.byteLength,
    );
    renderer.evictRetainedGeometry(Infinity);
    assert.equal(renderer._snapshotGeometryPools.size, 0);
    assert.equal(
      gl._state.deleted.buffers.filter(
        handle => handle === bufferOf(colorBuffer)
      ).length,
      1,
      'the last retired VAO releases and deletes the shared colour VBO exactly once',
    );
    assert.equal(
      gl._state.deleted.textures.filter(
        handle => handle === alphaTexture
      ).length,
      1,
    );
    assert.equal(gl._state.live.buffers.size, 0);
    assert.equal(gl._state.live.textures.size, 0);
    assert.equal(gl._state.live.vertexArrays.size, 0);
  });

  await t.test('delete retries only the still-live texture', () => {
    const {
      gl,
      renderer,
      snapshot,
    } = createRenderer();
    const alphaTexture = snapshot.alphaTexture;
    gl._state.fail.deleteTextureBefore = true;

    assert.throws(
      () => renderer.deleteSnapshotBuffer('snap_1'),
      error => (
        error instanceof AggregateError &&
        /retirement remains pending/i.test(error.message)
      ),
    );
    assert.equal(renderer.snapshotBuffers.has('snap_1'), false);
    assert.equal(gl._state.live.textures.has(alphaTexture), true);
    assert.equal(renderer._pendingSnapshotRetirements.size, 1);
    assert.equal(
      renderer.stats.gpuMemoryMB * MIB,
      renderer._positionGpuByteLength + snapshot.alphaTextureByteLength,
      'the detached but still-live R8 allocation remains accounted until retry, beside the live position store the snapshot borrowed',
    );

    gl._state.fail.deleteTextureBefore = false;
    assert.equal(
      renderer.deleteSnapshotBuffer('snap_1'),
      undefined,
    );
    assert.equal(renderer._pendingSnapshotRetirements.size, 0);
    assert.equal(gl._state.live.textures.has(alphaTexture), false);
  });

  await t.test('dispose detaches state and converges after context-hostile deletion', () => {
    const {
      gl,
      renderer,
      snapshot,
    } = createRenderer();
    const alphaTexture = snapshot.alphaTexture;
    configureForDispose(renderer);
    gl._state.fail.deleteTextureBefore = true;

    assert.throws(
      () => renderer.dispose(),
      error => (
        error instanceof AggregateError &&
        /disposal retains/i.test(error.message)
      ),
    );
    assert.equal(renderer.snapshotBuffers.size, 0);
    assert.equal(gl._state.live.textures.has(alphaTexture), true);
    assert.equal(renderer._pendingSnapshotRetirements.size, 1);
    assert.equal(
      renderer.stats.gpuMemoryMB * MIB,
      snapshot.alphaTextureByteLength,
    );

    gl._state.fail.deleteTextureBefore = false;
    assert.doesNotThrow(() => renderer.dispose());
    assert.equal(renderer._pendingSnapshotRetirements.size, 0);
    assert.equal(renderer._snapshotGeometryPools.size, 0);
    assert.equal(gl._state.live.buffers.size, 0);
    assert.equal(gl._state.live.textures.size, 0);
    assert.equal(gl._state.live.vertexArrays.size, 0);
  });

  await t.test('delete-then-throw texture retirement settles through liveness', () => {
    const {
      gl,
      renderer,
    } = createRenderer();
    gl._state.fail.deleteTextureThenThrow = true;
    assert.doesNotThrow(
      () => renderer.deleteSnapshotBuffer('snap_1')
    );
    assert.equal(renderer._pendingSnapshotRetirements.size, 0);
    assert.equal(gl._state.live.textures.size, 0);
  });
});

test('live point-count replacement is rejected before GL work while snapshots are published', () => {
  const renderer = Object.create(HighPerfRenderer.prototype);
  Object.assign(renderer, {
    gl: {},
    pointCount: 2,
    snapshotBuffers: new Map([
      ['snap_1', { id: 'snap_1' }],
    ]),
    useAdaptiveLOD: false,
    useFrustumCulling: false,
  });
  assert.throws(
    () => renderer.loadData(
      new Float32Array(9),
      new Uint8Array(12),
      { dimensionLevel: 3 },
    ),
    /while snapshot views remain published/i,
  );
});

test('every snapshot draw path binds source-order snapshot alpha through its geometry\'s permutation, while live override stays explicit', () => {
  const {
    gl,
    renderer,
    snapshot,
  } = createRenderer();
  // Every snapshot pass draws through the one draw seam, handing it the
  // snapshot's own alpha unless the live override is explicit.
  assert.match(
    HighPerfRenderer.prototype.renderWithSnapshot.toString(),
    /alphaTexture: useAlphaTexture \? this\._alphaTexture : snapshot\.alphaTexture/,
  );
  assert.match(
    HighPerfRenderer.prototype._drawPoints.toString(),
    /this\._bindPointAlpha\(gl, uniforms, draw\.alphaTexture, draw\.alphaPlan, order\)/,
  );

  const dummy = gl.createTexture();
  const liveTexture = gl.createTexture();
  const permutation = gl.createTexture();
  renderer._dummyLodIndexTexture = dummy;
  renderer._dummyLodIndexTextureByteLength = 4;
  const uniforms = {
    u_alphaTex: 'alpha',
    u_alphaLayout: 'alpha-layout',
    u_lodIndexTex: 'lod-index',
    u_lodIndexLayout: 'lod-layout',
    u_useAlphaTex: 'use-alpha',
    u_orderedSlots: 'ordered-slots',
  };
  const lastUniform = location => gl._state.uniformCalls
    .filter(call => call.location === location)
    .at(-1);

  // A geometry still in source order: gl_VertexID is the source index.
  renderer._bindPointAlpha(gl, uniforms, snapshot.alphaTexture, snapshot.alphaTexPlan, null);
  assert.strictEqual(gl._state.textureBindings.get(0), snapshot.alphaTexture);
  assert.strictEqual(gl._state.textureBindings.get(1), dummy);
  assert.deepEqual(lastUniform('ordered-slots'), {
    kind: 'uniform1i',
    location: 'ordered-slots',
    value: 0,
  });

  // A geometry in a draw order: a stored slot below `orderedSlots` maps
  // back to its source index through the order's slot map, so the
  // source-order alpha holds.
  const order = { texture: permutation, plan: planLinearTexture(7, 4, 256), orderedSlots: 7 };
  renderer._bindPointAlpha(gl, uniforms, snapshot.alphaTexture, snapshot.alphaTexPlan, order);
  assert.strictEqual(gl._state.textureBindings.get(0), snapshot.alphaTexture);
  assert.strictEqual(gl._state.textureBindings.get(1), permutation);
  assert.deepEqual(lastUniform('ordered-slots'), {
    kind: 'uniform1i',
    location: 'ordered-slots',
    value: 7,
  });
  // The permutation's layout: width 4 (shift 2), two rows in one layer.
  assert.deepEqual(lastUniform('lod-layout'), {
    kind: 'uniform2i',
    location: 'lod-layout',
    value: [2, 2],
  });

  // The live override binds the live alpha through the same permutation.
  renderer._bindPointAlpha(gl, uniforms, liveTexture, snapshot.alphaTexPlan, order);
  assert.strictEqual(
    gl._state.textureBindings.get(0),
    liveTexture,
    'the live-global alpha texture is used only for an explicit override',
  );
  assert.strictEqual(gl._state.textureBindings.get(1), permutation);
});


test('a snapshot alpha update uploads only the rows that moved', () => {
  const { gl, renderer, snapshot } = createRenderer();
  const width = snapshot.alphaTexPlan.width;
  const rows = snapshot.alphaTexPlan.rows;
  assert.ok(rows > 1, 'the fixture lays its five cells over several rows');
  // Move one cell in the last row only.
  const next = Uint8Array.from(snapshot.alphas);
  const last = 4;
  next[last] = next[last] === 1 ? 0 : 1;
  const uploadsBefore = gl._state.textureUploads.length;
  assert.equal(renderer.updateSnapshotAlphas('snap_1', next), true);
  const uploads = gl._state.textureUploads.slice(uploadsBefore);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].height, 1, 'one row, not the whole texture');
  assert.strictEqual(snapshot.alphas, next);
  assert.deepEqual(
    gl._state.textureBytes.get(snapshot.alphaTexture),
    expectedAlphaBytes(next, renderer.pointCount, snapshot.alphaTexPlan.texels),
    'the resident image is the accepted transparency',
  );
  assert.ok(Math.floor(last / width) === rows - 1);
});

test('a kept view adopts its own transparency owner, so a caller array rewritten in place is still compared with the accepted bytes', () => {
  const { gl, renderer, snapshot } = createRenderer();
  const texels = snapshot.alphaTexPlan.texels;
  // Application state: one array rewritten in place before each publication.
  const state = Uint8Array.from(snapshot.alphas);
  state[0] ^= 1;
  assert.equal(renderer.updateSnapshotAlphas('snap_1', state), true);
  assert.strictEqual(snapshot.alphas, state);
  // The viewer copies the accepted bytes into the view's own owner and hands
  // it back (`updateSnapshotAttributes`).
  const own = Uint8Array.from(state);
  renderer._adoptSnapshotAlphasOwner('snap_1', own);
  assert.strictEqual(snapshot.alphas, own);
  assert.throws(
    () => renderer._adoptSnapshotAlphasOwner('snap_1', new Uint8Array(renderer.pointCount + 1)),
    /one exact Uint8 point array/,
  );
  assert.strictEqual(snapshot.alphas, own);

  state[4] ^= 1;
  const uploadsBefore = gl._state.textureUploads.length;
  assert.equal(
    renderer.updateSnapshotAlphas('snap_1', state),
    true,
    'the in-place rewrite moved a byte of the accepted generation',
  );
  assert.equal(gl._state.textureUploads.length, uploadsBefore + 1);
  assert.deepEqual(
    gl._state.textureBytes.get(snapshot.alphaTexture),
    expectedAlphaBytes(state, renderer.pointCount, texels),
  );
  assert.deepEqual(heldImageSizedArrays(renderer), []);
});

test('a released kept view takes transparency updates by reference and rebuilds its texture from the accepted array', () => {
  const { gl, renderer, snapshot } = createRenderer();
  // Releasing detaches the colour attribute from the view's vertex array.
  gl.disableVertexAttribArray = () => {};
  renderer._presentedViewIds = ['live'];
  renderer._snapshotInOperation = null;
  const texture = snapshot.alphaTexture;
  assert.ok(renderer._releaseDormantSnapshotStores() > 0);
  assert.equal(snapshot.storesReleased, true);
  assert.equal(snapshot.alphaTexture, null);
  assert.equal(gl._state.live.textures.has(texture), false);

  const next = Uint8Array.from(snapshot.alphas, value => value ^ 1);
  const uploadsBefore = gl._state.textureUploads.length;
  assert.equal(renderer.updateSnapshotAlphas('snap_1', next), true);
  assert.equal(gl._state.textureUploads.length, uploadsBefore, 'nothing on the GPU to rewrite');
  assert.strictEqual(snapshot.alphas, next);
  assert.equal(renderer.updateSnapshotAlphas('snap_1', Uint8Array.from(next)), false);

  renderer._restoreSnapshotStores(snapshot);
  assert.equal(snapshot.storesReleased, false);
  assert.ok(snapshot.alphaTexture);
  assert.equal(snapshot.alphaTextureByteLength, snapshot.alphaTexPlan.texels);
  assert.deepEqual(
    gl._state.textureBytes.get(snapshot.alphaTexture),
    expectedAlphaBytes(snapshot.alphas, renderer.pointCount, snapshot.alphaTexPlan.texels),
    'the rebuilt texture is the accepted transparency',
  );
  assert.equal(renderer.isAlphaTextureActiveForView('snap_1'), true);
  assert.deepEqual(heldImageSizedArrays(renderer), []);
});
