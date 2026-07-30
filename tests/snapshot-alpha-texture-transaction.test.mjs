import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';

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
      pendingError = gl.INVALID_OPERATION;
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
      assert.equal(target, this.TEXTURE_2D);
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
        assert.equal(live.vertexArrays.has(vao), true);
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
      const bytes = source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(
            source.buffer,
            source.byteOffset,
            source.byteLength,
          );
      bufferBytes.set(arrayBufferBinding, Uint8Array.from(bytes));
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
      if (parameter === this.TEXTURE_BINDING_2D) {
        return textureBindings.get(activeTextureUnit) ?? null;
      }
      if (parameter === this.CURRENT_PROGRAM) return null;
      if (unpackState.has(parameter)) {
        return unpackState.get(parameter);
      }
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
      if (rejected) return;
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
      if (rejected) return;
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
    _alphaTexData: null,
    _alphaTexHeight: 0,
    _alphaTexStagingData: null,
    _alphaTexWidth: 0,
    _alphaTexture: null,
    _alphaTextureByteLength: 0,
    _dummyLodIndexTexture: null,
    _dummyLodIndexTextureByteLength: 0,
    _interleavedGpuByteLength: 0,
    _lodIndexTexturesByDimension: new Map(),
    _lodResourceOwnersByDimension: new Map(),
    _pendingDataRetirements: new Set(),
    _pendingProgramRetirements: new Set(),
    _pendingProgramUnbind: false,
    _pendingShaderRetirements: new Set(),
    _pendingSnapshotRetirements: new Set(),
    _perViewState: new Map(),
    buffers: {
      alphas: null,
      colors: null,
      interleaved: null,
      positions: null,
    },
    stats: { gpuMemoryMB: 0 },
  });
}

function makePointData(pointCount) {
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);
  const alphas = new Float32Array(pointCount);
  for (let index = 0; index < pointCount; index++) {
    positions[index * 3] = index + 0.25;
    positions[index * 3 + 1] = -index - 0.5;
    positions[index * 3 + 2] = index * 2 + 0.75;
    colors[index * 4] = 10 + index;
    colors[index * 4 + 1] = 30 + index;
    colors[index * 4 + 2] = 50 + index;
    colors[index * 4 + 3] = 5 + index * 50;
    alphas[index] = index / (pointCount - 1);
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
    pointCount,
    _positions: pointData.positions,
    _liveGeometryGeneration: 1,
    _nextGeometryGeneration: 2,
    _snapshotAlphaStagingData: null,
    _snapshotColorStagingData: null,
    _snapshotGeometryPools: new Map(),
    snapshotBuffers: new Map(),
    forceLODLevel: -1,
    useAdaptiveLOD: false,
    useFrustumCulling: false,
  });
  configureAccounting(renderer);
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

function expectedAlphaBytes(alphas, colors, texelCount) {
  const result = new Uint8Array(texelCount);
  result.fill(255);
  for (let index = 0; index < colors.length / 4; index++) {
    result[index] = alphas === null
      ? colors[index * 4 + 3]
      : Math.round(alphas[index] * 255);
  }
  return result;
}

function expectedRgbBytes(colors) {
  const pointCount = colors.length / 4;
  const result = new Uint8Array(pointCount * 3);
  for (let index = 0; index < pointCount; index++) {
    result[index * 3] = colors[index * 4];
    result[index * 3 + 1] = colors[index * 4 + 1];
    result[index * 3 + 2] = colors[index * 4 + 2];
  }
  return result;
}

function snapshotIdentity(snapshot) {
  return {
    alphaTexData: snapshot.alphaTexData,
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
    _bufferDirty: false,
    _colors: null,
    _currentAlphas: null,
    _dirtyLodDimensions: new Set(),
    _firstRenderDone: false,
    _interleavedArrayBuffer: null,
    _interleavedColorView: null,
    _interleavedPositionView: null,
    _useAlphaTexture: false,
    _validatedLodNodeMappings: new WeakMap(),
    _validatedSpatialIndices: new WeakSet(),
    activeProgram: null,
    currentDimensionLevel: 3,
    lodBuffersByDimension: new Map(),
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
    colors,
    snapshot.alphaTexWidth * snapshot.alphaTexHeight,
  );

  assert.ok(snapshot.alphaTexture);
  assert.equal(snapshot.alphaTextureByteLength, expected.byteLength);
  assert.deepEqual(snapshot.alphaTexData, expected);
  assert.notStrictEqual(snapshot.alphaTexData, alphas);
  assert.equal(snapshot.alphas, undefined);
  assert.equal(
    Object.hasOwn(snapshot, 'alphaTexStagingData'),
    false,
    'staging is one renderer-wide owner, never one owner per snapshot',
  );
  assert.deepEqual(
    gl._state.textureBytes.get(snapshot.alphaTexture),
    expected,
  );
  assert.deepEqual(
    gl._state.bufferBytes.get(snapshot.buffer),
    expectedRgbBytes(colors),
    'snapshot color storage contains RGB only; alpha has one canonical R8 owner',
  );
  assert.equal(snapshot.bufferByteLength, renderer.pointCount * 3);
  const colorAttribute = gl._state.vertexAttribCalls
    .filter(call => call.vao === snapshot.vao && call.index === 1)
    .at(-1);
  assert.deepEqual(
    colorAttribute,
    {
      buffer: snapshot.buffer,
      index: 1,
      normalized: true,
      offset: 0,
      size: 3,
      stride: 3,
      type: gl.UNSIGNED_BYTE,
      vao: snapshot.vao,
    },
  );
  assert.ok(
    renderer._snapshotColorStagingData instanceof Uint8Array,
  );
  assert.equal(
    renderer._snapshotColorStagingData.byteLength,
    renderer.pointCount * 3,
  );
  assert.equal(
    renderer.stats.gpuMemoryMB * MIB,
    snapshot.positions.byteLength +
      snapshot.bufferByteLength +
      snapshot.alphaTextureByteLength,
  );

  const inherited = createRenderer({ alphas: null });
  const inheritedExpected = expectedAlphaBytes(
    null,
    inherited.colors,
    inherited.snapshot.alphaTexWidth *
      inherited.snapshot.alphaTexHeight,
  );
  assert.deepEqual(
    inherited.snapshot.alphaTexData,
    inheritedExpected,
    'null alpha derives the exact source RGBA alpha channel',
  );
  assert.deepEqual(
    inherited.gl._state.bufferBytes.get(
      inherited.snapshot.buffer
    ),
    expectedRgbBytes(inherited.colors),
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
    pointCount * 3 * Uint8Array.BYTES_PER_ELEMENT;
  const scaled = Object.create(HighPerfRenderer.prototype);
  configureAccounting(scaled);
  scaled.pointCount = pointCount;
  scaled._snapshotGeometryPools = new Map([
    [1, {
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
  const retainedR8CpuBytes =
    viewCount * alphaTextureBytes + alphaTextureBytes;
  const perSnapshotStagingBytes =
    viewCount * alphaTextureBytes * 2;
  assert.equal(
    perSnapshotStagingBytes - retainedR8CpuBytes,
    (viewCount - 1) * alphaTextureBytes,
  );
  const priorRgbaBudget = viewCount * pointCount * 4;
  const logicalRgbPlusR8Budget =
    viewCount * pointCount * (3 + 1);
  const physicalPaddingBytes =
    viewCount * (alphaTextureBytes - pointCount);
  assert.equal(logicalRgbPlusR8Budget, priorRgbaBudget);
  assert.ok(
    physicalPaddingBytes >= 0 &&
      physicalPaddingBytes < viewCount * maxTextureSize,
    'physical R8 padding is bounded by less than one texture row per view',
  );
  t.diagnostic(
    `eight 30M-point views account ${expectedGpuBytes.toLocaleString()} ` +
    `GPU bytes (${physicalPaddingBytes.toLocaleString()} bounded texture-` +
    `padding bytes above the unchanged 4N/view payload); one shared ` +
    `staging owner avoids ` +
    `${((viewCount - 1) * alphaTextureBytes).toLocaleString()} ` +
    `retained CPU bytes`,
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
  const replacement = Float32Array.from([
    1,
    0.1,
    0.2,
    0.3,
    0.4,
  ]);

  assert.equal(
    renderer.updateSnapshotAlphas('snap_1', replacement),
    true,
  );
  assert.deepEqual(
    snapshotIdentity(snapshot),
    {
      ...before,
      alphaTexData: snapshot.alphaTexData,
    },
  );
  assert.notStrictEqual(snapshot.alphaTexData, before.alphaTexData);
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
    snapshot.alphaTexData.subarray(0, replacement.length),
    Uint8Array.from(replacement, value => Math.round(value * 255)),
  );
  assert.strictEqual(
    renderer._snapshotAlphaStagingData,
    before.alphaTexData,
    'the prior accepted R8 owner becomes the one reusable staging owner',
  );

  const uploadsBeforeNoop = gl._state.textureUploadCount;
  const sameQuantizedGeneration = Float32Array.from(
    snapshot.alphaTexData.subarray(0, replacement.length),
    value => value / 255,
  );
  renderer.updateSnapshotAlphas(
    'snap_1',
    sameQuantizedGeneration
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
    alphaTexData: snapshot.alphaTexData,
  });

  const uploadsBeforeInvalid = gl._state.textureUploadCount;
  const invalid = replacement.slice();
  invalid[3] = Number.NaN;
  assert.throws(
    () => renderer.updateSnapshotAlphas('snap_1', invalid),
    /alpha.*index 3|index 3.*alpha/i,
  );
  assert.equal(
    gl._state.textureUploadCount,
    uploadsBeforeInvalid,
  );
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
    assert.notStrictEqual(snapshot.buffer, before.buffer);
    assert.notStrictEqual(snapshot.vao, before.vao);
    assert.strictEqual(snapshot.alphaTexture, before.alphaTexture);
    assert.strictEqual(snapshot.alphaTexData, before.alphaTexData);
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
      gl._state.bufferBytes.get(snapshot.buffer),
      expectedRgbBytes(replacement),
    );
    assert.equal(
      gl._state.bufferUploadCount,
      beforeBufferUploads + 1,
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
      gl._state.bufferBytes.get(snapshot.buffer)
    );
    const beforeBufferUploads = gl._state.bufferUploadCount;
    const beforeTextureUploads = gl._state.textureUploadCount;
    const replacement = snapshot.positions.slice();
    replacement[0] += 10;

    assert.equal(
      renderer.updateSnapshotPositions('snap_1', replacement, 2),
      true,
    );
    assert.strictEqual(snapshot.buffer, before.buffer);
    assert.strictEqual(snapshot.alphaTexture, before.alphaTexture);
    assert.strictEqual(snapshot.alphaTexData, before.alphaTexData);
    assert.notStrictEqual(snapshot.vao, before.vao);
    assert.notStrictEqual(snapshot.positions, before.positions);
    assert.notEqual(
      snapshot.geometryGeneration,
      before.geometryGeneration,
    );
    assert.deepEqual(
      gl._state.bufferBytes.get(snapshot.buffer),
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
    const accepted = snapshot.alphaTexData.slice();
    const nextUpload = gl._state.textureUploadCount + 1;
    gl._state.fail.textureUploads.add(nextUpload);
    const replacement = Float32Array.from([
      1, 0.8, 0.6, 0.4, 0.2,
    ]);

    assert.throws(
      () => renderer.updateSnapshotAlphas(
        'snap_1',
        replacement
      ),
      /WebGL|alpha|texture/i,
    );
    assert.deepEqual(snapshotIdentity(snapshot), before);
    assert.deepEqual(snapshot.alphaTexData, accepted);
    assert.deepEqual(
      gl._state.textureBytes.get(snapshot.alphaTexture),
      accepted,
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

  await t.test('double R8 failure detaches poisoned texture and retries from accepted CPU bytes', () => {
    const {
      gl,
      renderer,
      snapshot,
    } = createRenderer();
    const accepted = snapshot.alphaTexData.slice();
    const poisonedTexture = snapshot.alphaTexture;
    const nextUpload = gl._state.textureUploadCount + 1;
    gl._state.fail.textureUploads.add(nextUpload);
    gl._state.fail.textureUploads.add(nextUpload + 1);
    const replacement = Float32Array.from([
      0.9, 0.7, 0.5, 0.3, 0.1,
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
    assert.deepEqual(snapshot.alphaTexData, accepted);
    assert.equal(gl._state.live.textures.has(poisonedTexture), false);

    gl._state.fail.textureUploads.clear();
    assert.equal(
      renderer.updateSnapshotAlphas('snap_1', replacement),
      true,
    );
    assert.ok(snapshot.alphaTexture);
    assert.notStrictEqual(snapshot.alphaTexture, poisonedTexture);
  });

  await t.test('color and position upload failures leave all accepted handles intact', () => {
    const {
      gl,
      renderer,
      snapshot,
    } = createRenderer();
    const colorBefore = snapshotIdentity(snapshot);
    gl._state.fail.bufferUploads.add(
      gl._state.bufferUploadCount + 1
    );
    assert.throws(
      () => renderer.updateSnapshotColors(
        'snap_1',
        new Uint8Array(renderer.pointCount * 4)
      ),
      /synthetic snapshot buffer upload failure/,
    );
    assert.deepEqual(snapshotIdentity(snapshot), colorBefore);

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
        2,
      ),
      /synthetic snapshot buffer upload failure/,
    );
    assert.deepEqual(snapshotIdentity(snapshot), positionBefore);

    gl._state.fail.bufferUploads.clear();
    assert.equal(
      renderer.updateSnapshotPositions(
        'snap_1',
        replacementPositions,
        2,
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
        2,
      ),
      true,
    );
    assert.strictEqual(snapshot.colorOwner, colorOwner);
    assert.strictEqual(snapshot.buffer, colorBuffer);
    assert.strictEqual(snapshot.alphaTexture, alphaTexture);
    assert.equal(colorOwner.refCount, 2);
    assert.equal(renderer._pendingSnapshotRetirements.size, 1);

    const secondPositions = snapshot.positions.slice();
    secondPositions[1] += 2;
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
      3 * positionByteLength +
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
    assert.equal(gl._state.live.buffers.has(colorBuffer), true);
    assert.equal(gl._state.live.textures.has(alphaTexture), true);
    assert.equal(renderer._pendingSnapshotRetirements.size, 3);

    gl._state.fail.deleteVertexArrayBefore = false;
    assert.doesNotThrow(
      () => renderer.deleteSnapshotBuffer('snap_1')
    );
    assert.equal(renderer._pendingSnapshotRetirements.size, 0);
    assert.equal(renderer._snapshotGeometryPools.size, 0);
    assert.equal(
      gl._state.deleted.buffers.filter(
        handle => handle === colorBuffer
      ).length,
      1,
      'the last retired VAO releases and deletes the shared RGB VBO exactly once',
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
    assert.equal(renderer._snapshotColorStagingData, null);
    assert.equal(renderer._snapshotAlphaStagingData, null);
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
      snapshot.alphaTextureByteLength,
      'the detached but still-live R8 allocation remains accounted until retry',
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

test('every snapshot draw path binds source-order snapshot alpha, while live override stays explicit', () => {
  const {
    gl,
    renderer,
    snapshot,
  } = createRenderer();
  assert.equal(
    typeof renderer._bindSnapshotAlphaTexture,
    'function',
  );
  const drawMethods = [
    HighPerfRenderer.prototype.renderWithSnapshot,
    HighPerfRenderer.prototype._renderSnapshotWithFrustumCulling,
    HighPerfRenderer.prototype._renderSnapshotWithLOD,
    HighPerfRenderer.prototype._renderSnapshotLODWithFrustumCulling,
  ];
  for (const method of drawMethods) {
    assert.match(
      method.toString(),
      /_bindSnapshotAlphaTexture/,
      `${method.name} must use the exact snapshot-alpha binding path`,
    );
  }

  const dummy = gl.createTexture();
  const liveTexture = gl.createTexture();
  renderer._dummyLodIndexTexture = dummy;
  renderer._dummyLodIndexTextureByteLength = 4;
  renderer._alphaTexture = liveTexture;
  renderer._alphaTextureByteLength = snapshot.alphaTextureByteLength;
  renderer._alphaTexWidth = snapshot.alphaTexWidth;
  renderer._alphaTexHeight = snapshot.alphaTexHeight;
  renderer._useAlphaTexture = true;
  const uniforms = {
    u_alphaTex: 'alpha',
    u_alphaTexWidth: 'alpha-width',
    u_invAlphaTexWidth: 'alpha-inverse-width',
    u_lodIndexTex: 'lod-index',
    u_lodIndexTexWidth: 'lod-width',
    u_invLodIndexTexWidth: 'lod-inverse-width',
    u_useAlphaTex: 'use-alpha',
    u_useLodIndexTex: 'use-lod-index',
  };

  renderer._bindSnapshotAlphaTexture(
    gl,
    uniforms,
    snapshot,
    false,
    3,
  );
  assert.strictEqual(
    gl._state.textureBindings.get(0),
    snapshot.alphaTexture,
  );
  assert.strictEqual(gl._state.textureBindings.get(1), dummy);
  assert.deepEqual(
    gl._state.uniformCalls
      .filter(call => call.location === 'use-lod-index')
      .at(-1),
    {
      kind: 'uniform1i',
      location: 'use-lod-index',
      value: 0,
    },
    'snapshot EBOs contain original IDs, so alpha lookup uses gl_VertexID directly',
  );

  renderer._bindSnapshotAlphaTexture(
    gl,
    uniforms,
    snapshot,
    true,
    3,
  );
  assert.strictEqual(
    gl._state.textureBindings.get(0),
    liveTexture,
    'the live-global alpha texture is used only for an explicit override',
  );
  assert.deepEqual(
    gl._state.uniformCalls
      .filter(call => call.location === 'use-lod-index')
      .at(-1),
    {
      kind: 'uniform1i',
      location: 'use-lod-index',
      value: 0,
    },
  );
});
