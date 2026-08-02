import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';
import { SpatialIndex } from '../assets/js/rendering/high-perf/spatial-index.js';

const DIMENSION = 2;
const FULL_POINT_COUNT = 41;
const REDUCED_PREFIX = Uint32Array.from([
  37, 2, 30, 0, 15, 29, 3, 40, 8, 22,
  1, 34, 12, 26, 5, 18, 39, 10, 31,
]);
const REDUCED_COUNTS = Object.freeze(
  Array.from({ length: 17 }, (_value, index) => index + 3),
);

function cloneUpload(data) {
  if (data instanceof ArrayBuffer) {
    return data.slice(0);
  }
  if (ArrayBuffer.isView(data)) {
    return new data.constructor(data);
  }
  return data;
}

function countIdentity(values, expected) {
  return values.filter(value => value === expected).length;
}

function createTrackingGl() {
  let nextId = 1;
  let boundArrayBuffer = null;
  let boundElementBuffer = null;
  let boundTexture = null;
  let pendingError = 0;

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
  const contents = {
    buffers: new Map(),
    textures: new Map(),
  };
  const textureShapes = new Map();
  const deleteAttempts = {
    buffers: [],
    textures: [],
    vertexArrays: [],
  };
  const uploads = [];
  const fail = {
    createBufferAt: null,
    createTextureAt: null,
    createVertexArrayAt: null,
    deleteBuffers: new Map(),
    deleteTextures: new Map(),
    deleteVertexArrays: new Map(),
    preflightError: false,
    stickyAfterUpload: false,
    throwBufferTarget: null,
    throwTextureUpload: false,
  };
  const limits = {
    maxTextureSize: 4096,
  };

  const makeHandle = (kind, label = null) => {
    const handle = Object.freeze({
      id: label ?? `${kind}-${nextId++}`,
      kind,
    });
    if (kind === 'buffer') live.buffers.add(handle);
    if (kind === 'texture') live.textures.add(handle);
    if (kind === 'vao') live.vertexArrays.add(handle);
    return handle;
  };

  const deleteHandle = (
    handle,
    attempts,
    failures,
    liveHandles,
  ) => {
    attempts.push(handle);
    const behavior = failures.get(handle) ?? null;
    if (behavior === 'before') {
      throw new Error(`synthetic pre-delete failure for ${handle.id}`);
    }
    liveHandles.delete(handle);
    if (behavior === 'after') {
      throw new Error(`synthetic post-delete failure for ${handle.id}`);
    }
  };

  const recordUpload = (
    kind,
    target,
    data,
    usage = null,
    details = {},
  ) => {
    uploads.push({
      buffer: target === gl.ARRAY_BUFFER
        ? boundArrayBuffer
        : target === gl.ELEMENT_ARRAY_BUFFER
          ? boundElementBuffer
          : null,
      data: cloneUpload(data),
      kind,
      sourceBuffer: data instanceof ArrayBuffer
        ? data
        : ArrayBuffer.isView(data)
          ? data.buffer
          : null,
      sourceByteLength:
        data instanceof ArrayBuffer || ArrayBuffer.isView(data)
          ? data.byteLength
          : 0,
      sourceByteOffset: ArrayBuffer.isView(data)
        ? data.byteOffset
        : 0,
      target,
      texture: kind.startsWith('tex') ? boundTexture : null,
      usage,
      ...details,
    });
    if (fail.stickyAfterUpload) {
      pendingError = gl.INVALID_OPERATION;
    }
  };

  const gl = {
    ARRAY_BUFFER: 0x8892,
    CLAMP_TO_EDGE: 0x812f,
    DYNAMIC_DRAW: 0x88e8,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    FLOAT: 0x1406,
    INVALID_OPERATION: 0x0502,
    MAX_TEXTURE_SIZE: 0x0d33,
    NEAREST: 0x2600,
    NO_ERROR: 0,
    R32UI: 0x8236,
    RED_INTEGER: 0x8d94,
    STATIC_DRAW: 0x88e4,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    UNSIGNED_BYTE: 0x1401,
    UNSIGNED_INT: 0x1405,

    bindBuffer(target, buffer) {
      if (target === this.ARRAY_BUFFER) boundArrayBuffer = buffer;
      if (target === this.ELEMENT_ARRAY_BUFFER) {
        boundElementBuffer = buffer;
      }
    },
    bindTexture(target, texture) {
      assert.equal(target, this.TEXTURE_2D);
      boundTexture = texture;
    },
    bindVertexArray() {},
    bufferData(target, data, usage) {
      if (fail.throwBufferTarget === target) {
        throw new Error(
          `synthetic ${target === this.ARRAY_BUFFER ? 'array' : 'element'} upload failure`,
        );
      }
      recordUpload('bufferData', target, data, usage);
      const buffer = target === this.ARRAY_BUFFER
        ? boundArrayBuffer
        : boundElementBuffer;
      if (!fail.stickyAfterUpload && buffer !== null) {
        // A numeric argument sizes a zero-filled store, exactly as WebGL does.
        contents.buffers.set(
          buffer,
          typeof data === 'number'
            ? new ArrayBuffer(data)
            : cloneUpload(data),
        );
      }
    },
    bufferSubData(target, offset, data, srcOffset = 0, length) {
      if (fail.throwBufferTarget === target) {
        throw new Error(
          `synthetic ${target === this.ARRAY_BUFFER ? 'array' : 'element'} upload failure`,
        );
      }
      recordUpload('bufferSubData', target, data, null, { offset });
      const buffer = target === this.ARRAY_BUFFER
        ? boundArrayBuffer
        : boundElementBuffer;
      if (fail.stickyAfterUpload || buffer === null) return;
      // A sub-range write updates the existing store in place; it never
      // replaces it, and it never writes past its end.
      const store = contents.buffers.get(buffer);
      assert.ok(
        store instanceof ArrayBuffer,
        'bufferSubData requires an allocated data store',
      );
      const source = new Uint8Array(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
      const count = length ?? source.byteLength - srcOffset;
      assert.ok(
        offset + count <= store.byteLength,
        'bufferSubData must stay inside the allocated data store',
      );
      new Uint8Array(store).set(
        source.subarray(srcOffset, srcOffset + count),
        offset,
      );
    },
    createBuffer() {
      const ordinal = creates.buffers.length + 1;
      if (fail.createBufferAt === ordinal) return null;
      const handle = makeHandle('buffer');
      creates.buffers.push(handle);
      return handle;
    },
    createTexture() {
      const ordinal = creates.textures.length + 1;
      if (fail.createTextureAt === ordinal) return null;
      const handle = makeHandle('texture');
      creates.textures.push(handle);
      return handle;
    },
    createVertexArray() {
      const ordinal = creates.vertexArrays.length + 1;
      if (fail.createVertexArrayAt === ordinal) return null;
      const handle = makeHandle('vao');
      creates.vertexArrays.push(handle);
      return handle;
    },
    deleteBuffer(handle) {
      try {
        deleteHandle(
          handle,
          deleteAttempts.buffers,
          fail.deleteBuffers,
          live.buffers,
        );
      } finally {
        if (!live.buffers.has(handle)) contents.buffers.delete(handle);
      }
    },
    deleteTexture(handle) {
      try {
        deleteHandle(
          handle,
          deleteAttempts.textures,
          fail.deleteTextures,
          live.textures,
        );
      } finally {
        if (!live.textures.has(handle)) {
          contents.textures.delete(handle);
          textureShapes.delete(handle);
        }
      }
    },
    deleteVertexArray(handle) {
      deleteHandle(
        handle,
        deleteAttempts.vertexArrays,
        fail.deleteVertexArrays,
        live.vertexArrays,
      );
    },
    enableVertexAttribArray() {},
    getError() {
      if (fail.preflightError) {
        fail.preflightError = false;
        return this.INVALID_OPERATION;
      }
      const error = pendingError;
      pendingError = this.NO_ERROR;
      return error;
    },
    getParameter(parameter) {
      assert.equal(parameter, this.MAX_TEXTURE_SIZE);
      return limits.maxTextureSize;
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
    texImage2D(
      target,
      _level,
      _internalFormat,
      _width,
      _height,
      _border,
      _format,
      _type,
      data,
    ) {
      recordUpload(
        'texImage2D',
        target,
        data,
        null,
        { height: _height, width: _width },
      );
      if (!fail.stickyAfterUpload && boundTexture !== null) {
        textureShapes.set(boundTexture, {
          height: _height,
          width: _width,
        });
        contents.textures.set(
          boundTexture,
          data === null
            ? new Uint32Array(_width * _height)
            : cloneUpload(data),
        );
      }
    },
    texSubImage2D(
      target,
      _level,
      xOffset,
      yOffset,
      width,
      height,
      _format,
      _type,
      data,
    ) {
      if (fail.throwTextureUpload) {
        throw new Error('synthetic index-texture upload failure');
      }
      recordUpload(
        'texSubImage2D',
        target,
        data,
        null,
        {
          height,
          width,
          xOffset,
          yOffset,
        },
      );
      if (!fail.stickyAfterUpload && boundTexture !== null) {
        const shape = textureShapes.get(boundTexture);
        assert.ok(shape);
        const accepted =
          contents.textures.get(boundTexture)?.slice() ??
          new Uint32Array(shape.width * shape.height);
        for (let row = 0; row < height; row++) {
          accepted.set(
            data.subarray(row * width, (row + 1) * width),
            (yOffset + row) * shape.width + xOffset,
          );
        }
        contents.textures.set(boundTexture, accepted);
      }
    },
    texParameteri() {},
    vertexAttribPointer() {},

    _adoptBuffer(label) {
      return makeHandle('buffer', label);
    },
    _adoptTexture(label) {
      return makeHandle('texture', label);
    },
    _adoptVertexArray(label) {
      return makeHandle('vao', label);
    },
    _state: {
      creates,
      contents,
      deleteAttempts,
      fail,
      limits,
      live,
      textureShapes,
      uploads,
    },
  };

  return gl;
}

function createPointData() {
  const positions = new Float32Array(FULL_POINT_COUNT * 3);
  const colors = new Uint8Array(FULL_POINT_COUNT * 4);
  for (let index = 0; index < FULL_POINT_COUNT; index++) {
    positions[index * 3] = index + 0.125;
    positions[index * 3 + 1] = -index - 0.25;
    positions[index * 3 + 2] = index * 2 + 0.5;
    colors[index * 4] = index + 1;
    colors[index * 4 + 1] = index + 31;
    colors[index * 4 + 2] = index + 61;
    colors[index * 4 + 3] = 255 - index;
  }
  return { colors, positions };
}

function createSpatialIndex(
  positions,
  colors,
  {
    dimensionLevel = DIMENSION,
    prefix = REDUCED_PREFIX,
    reducedCounts = REDUCED_COUNTS,
  } = {},
) {
  const lodLevels = reducedCounts.map((pointCount, depth) => ({
    depth,
    indices: prefix.slice(0, pointCount),
    isFullDetail: false,
    pointCount,
    sizeMultiplier: 1 + (reducedCounts.length - depth) * 0.1,
  }));
  lodLevels.push({
    colors,
    depth: lodLevels.length,
    isFullDetail: true,
    pointCount: FULL_POINT_COUNT,
    positions,
    sizeMultiplier: 1,
  });
  return {
    colors,
    dimensionLevel,
    lodLevels,
    pointCount: FULL_POINT_COUNT,
    positions,
  };
}

function createRendererFixture() {
  const gl = createTrackingGl();
  const { colors, positions } = createPointData();
  const spatialIndex = createSpatialIndex(positions, colors);
  const mainBuffer = gl._adoptBuffer('main-buffer');
  const mainVao = gl._adoptVertexArray('main-vao');
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      gl,
      pointCount: FULL_POINT_COUNT,
      _positions: positions,
      _colors: colors,
      vao: mainVao,
      buffers: {
        alphas: null,
        colors: null,
        interleaved: mainBuffer,
        positions: null,
      },
      lodBuffersByDimension: new Map(),
      _lodIndexTexturesByDimension: new Map(),
      spatialIndices: new Map([[DIMENSION, spatialIndex]]),
      _dirtyLodDimensions: new Set(),
      _lodArrayBuffers: null,
      _pendingDataRetirements: new Set(),
      _pendingSnapshotRetirements: new Set(),
      stats: {
        gpuMemoryMB: 0,
      },
    },
  );

  return {
    colors,
    gl,
    mainBuffer,
    mainVao,
    positions,
    renderer,
    spatialIndex,
  };
}

function requireAtomicPublicationSeam(renderer) {
  assert.equal(
    typeof renderer._createLODResourcesForDimension,
    'function',
    'HighPerfRenderer must expose one atomic per-dimension LOD resource publication seam',
  );
}

function publishFixture(fixture) {
  requireAtomicPublicationSeam(fixture.renderer);
  fixture.renderer._createLODResourcesForDimension(
    DIMENSION,
    fixture.spatialIndex,
  );
}

function resetGlActivity(gl) {
  gl._state.creates.buffers.length = 0;
  gl._state.creates.textures.length = 0;
  gl._state.creates.vertexArrays.length = 0;
  gl._state.deleteAttempts.buffers.length = 0;
  gl._state.deleteAttempts.textures.length = 0;
  gl._state.deleteAttempts.vertexArrays.length = 0;
  gl._state.uploads.length = 0;
  Object.assign(gl._state.fail, {
    createBufferAt: null,
    createTextureAt: null,
    createVertexArrayAt: null,
    preflightError: false,
    stickyAfterUpload: false,
    throwBufferTarget: null,
    throwTextureUpload: false,
  });
  gl._state.fail.deleteBuffers.clear();
  gl._state.fail.deleteTextures.clear();
  gl._state.fail.deleteVertexArrays.clear();
}

function objectContainsIdentity(value, expected, seen = new Set()) {
  if (value === expected) return true;
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    seen.has(value)
  ) {
    return false;
  }
  seen.add(value);
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      if (
        objectContainsIdentity(key, expected, seen) ||
        objectContainsIdentity(entry, expected, seen)
      ) {
        return true;
      }
    }
    return false;
  }
  if (value instanceof Set) {
    for (const entry of value) {
      if (objectContainsIdentity(entry, expected, seen)) return true;
    }
    return false;
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return false;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (objectContainsIdentity(value[key], expected, seen)) return true;
  }
  return false;
}

function findGenerationOwner(renderer, dimensionLevel, generationToken) {
  const matches = [];
  for (const value of Object.values(renderer)) {
    if (!(value instanceof Map)) continue;
    const candidate = value.get(dimensionLevel);
    if (
      candidate !== null &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      candidate.generationToken === generationToken
    ) {
      matches.push(candidate);
    }
  }
  assert.equal(
    matches.length,
    1,
    'one explicit per-dimension owner record must match the metadata generation token',
  );
  return matches[0];
}

function findTopologyOwner(owner, originalIndexBuffer, indexTexture) {
  const matches = [];
  const visit = (value, seen = new Set()) => {
    if (
      value === null ||
      typeof value !== 'object' ||
      seen.has(value) ||
      !objectContainsIdentity(value, originalIndexBuffer) ||
      !objectContainsIdentity(value, indexTexture)
    ) {
      return;
    }
    seen.add(value);
    const children = value instanceof Map
      ? Array.from(value.values())
      : value instanceof Set
        ? Array.from(value)
        : ArrayBuffer.isView(value) || value instanceof ArrayBuffer
          ? []
          : Object.values(value);
    const matchingChildren = children.filter(child => (
      child !== null &&
      typeof child === 'object' &&
      objectContainsIdentity(child, originalIndexBuffer) &&
      objectContainsIdentity(child, indexTexture)
    ));
    if (matchingChildren.length === 0) {
      matches.push(value);
      return;
    }
    for (const child of matchingChildren) visit(child, seen);
  };
  for (const value of Object.values(owner)) {
    visit(value);
  }
  assert.equal(
    matches.length,
    1,
    'reused EBO/texture topology must have one explicit nested owner',
  );
  return matches[0];
}

function captureDimensionGeneration(renderer, dimensionLevel) {
  const lodBuffers =
    renderer.lodBuffersByDimension.get(dimensionLevel);
  const indexTextures =
    renderer._lodIndexTexturesByDimension.get(dimensionLevel);
  assert.ok(Array.isArray(lodBuffers));
  assert.ok(Array.isArray(indexTextures));
  const reducedBuffers = lodBuffers.filter(level => !level.isFullDetail);
  const reducedTextures = indexTextures.slice(0, -1);
  assert.ok(reducedBuffers.length > 0);
  const generationToken = reducedBuffers[0].generationToken;
  assert.notEqual(generationToken, null);
  assert.equal(typeof generationToken, 'object');
  assert.equal(Object.isFrozen(generationToken), true);
  for (const metadata of [...lodBuffers, ...indexTextures]) {
    for (
      const ownershipFlag of
      [
        'ownsBuffer',
        'ownsVertexArray',
        'ownsOriginalIndexBuffer',
        'ownsTexture',
      ]
    ) {
      assert.equal(
        Object.hasOwn(metadata, ownershipFlag),
        false,
        'LOD metadata arrays are non-owning views',
      );
    }
  }
  for (const metadata of reducedBuffers) {
    assert.strictEqual(metadata.generationToken, generationToken);
  }
  for (const metadata of reducedTextures) {
    assert.strictEqual(metadata.generationToken, generationToken);
  }
  const fullBufferToken =
    lodBuffers.at(-1).generationToken ?? null;
  const fullTextureToken =
    indexTextures.at(-1).generationToken ?? null;
  for (const fullToken of [fullBufferToken, fullTextureToken]) {
    if (fullToken === null) continue;
    assert.notStrictEqual(fullToken, generationToken);
    assert.equal(typeof fullToken, 'object');
    assert.equal(Object.isFrozen(fullToken), true);
  }

  const compactBuffer = reducedBuffers[0].buffer;
  const compactVao = reducedBuffers[0].vao;
  const originalIndexBuffer = reducedBuffers[0].originalIndexBuffer;
  const indexTexture = reducedTextures[0].texture;
  const owner = findGenerationOwner(
    renderer,
    dimensionLevel,
    generationToken,
  );
  for (
    const handle of
    [compactBuffer, compactVao, originalIndexBuffer, indexTexture]
  ) {
    assert.equal(
      objectContainsIdentity(owner, handle),
      true,
      `generation owner must explicitly retain ${handle.id}`,
    );
  }
  const topologyOwner = findTopologyOwner(
    owner,
    originalIndexBuffer,
    indexTexture,
  );
  return {
    compactBuffer,
    compactVao,
    generationToken,
    indexTexture,
    indexTextures,
    lodBuffers,
    originalIndexBuffer,
    owner,
    topologyOwner,
  };
}

function assertStrictReducedPrefixes(spatialIndex) {
  const reduced = spatialIndex.lodLevels.filter(
    level => !level.isFullDetail,
  );
  const maximum = reduced.at(-1).indices;
  for (const level of reduced) {
    assert.ok(level.indices instanceof Uint32Array);
    assert.equal(level.indices.length, level.pointCount);
    assert.deepEqual(
      Array.from(level.indices),
      Array.from(maximum.subarray(0, level.pointCount)),
      `LOD ${level.depth} must preserve the maximum-prefix original-ID order`,
    );
  }
}

test('every LOD GPU publication call site crosses the one atomic seam', async () => {
  const rendererSource = await readFile(
    new URL(
      '../assets/js/rendering/high-perf-renderer.js',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    rendererSource,
    /_createLODResourcesForDimension\s*\(/,
  );
  assert.doesNotMatch(
    rendererSource,
    /this\._createLODBuffersForDimension\s*\(/,
    'no caller may publish the compact buffers independently',
  );
  assert.doesNotMatch(
    rendererSource,
    /this\._createLODIndexTextures\s*\(/,
    'no caller may publish the original-ID texture independently',
  );
});

test('one exact shared packing owner eliminates the 30M compact cache and shrinks with full detail', async () => {
  const rendererSource = await readFile(
    new URL(
      '../assets/js/rendering/high-perf-renderer.js',
      import.meta.url,
    ),
    'utf8',
  );
  assert.doesNotMatch(rendererSource, /_lodArrayBuffers/);

  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      pointCount: 10,
      _interleavedArrayBuffer: new ArrayBuffer(160),
      _interleavedPositionView: null,
      _interleavedColorView: null,
    },
  );
  const largeScratch = renderer._ensureSharedPackingScratch(
    128,
    'large fixture',
  );
  assert.equal(largeScratch.buffer.byteLength, 160);
  assert.strictEqual(
    largeScratch.buffer,
    renderer._interleavedArrayBuffer,
  );

  renderer.pointCount = 2;
  const smallScratch = renderer._ensureSharedPackingScratch(
    16,
    'small LOD-disabled fixture',
  );
  assert.notStrictEqual(smallScratch.buffer, largeScratch.buffer);
  assert.equal(smallScratch.buffer.byteLength, 32);
  assert.strictEqual(
    smallScratch.positionView.buffer,
    smallScratch.buffer,
  );
  assert.strictEqual(
    smallScratch.colorView.buffer,
    smallScratch.buffer,
  );
  assert.equal(
    Object.hasOwn(renderer, '_lodArrayBuffers'),
    false,
  );

  const thirtyMillion = 30_000_000;
  const maximumReducedCount =
    Math.ceil(thirtyMillion / 1.25);
  assert.equal(maximumReducedCount, 24_000_000);
  assert.equal(
    maximumReducedCount * 16,
    384_000_000,
    'single-scratch ownership removes the former 366.211 MiB compact cache',
  );
  assert.equal(
    thirtyMillion * 16,
    480_000_000,
    'only the exact 457.764 MiB full-detail packing owner remains',
  );
});

test('candidate rollback invalidates overwritten shared scratch while restoring accepted GPU identity', () => {
  const fixture = createRendererFixture();
  const { renderer } = fixture;
  renderer._interleavedArrayBuffer =
    new ArrayBuffer(FULL_POINT_COUNT * 16);
  renderer._interleavedPositionView =
    new Float32Array(renderer._interleavedArrayBuffer);
  renderer._interleavedColorView =
    new Uint8Array(renderer._interleavedArrayBuffer);
  renderer._interleavedColorView.fill(17);
  const previous = renderer._captureDataPublication();

  renderer._installCandidateDataPublication(previous);
  renderer.pointCount = FULL_POINT_COUNT;
  const candidateScratch =
    renderer._ensureSharedPackingScratch(
      REDUCED_PREFIX.length * 16,
      'candidate compact fixture',
    );
  assert.strictEqual(
    candidateScratch.buffer,
    previous.interleavedArrayBuffer,
  );
  candidateScratch.colorView[0] = 99;
  const rejected = renderer._captureDataPublication();

  renderer._restoreDataPublication(previous, {
    invalidateInterleavedCache: true,
  });
  renderer._retireDataPublication(rejected);

  assert.strictEqual(renderer.vao, previous.vao);
  assert.strictEqual(renderer.buffers, previous.buffers);
  assert.equal(renderer._interleavedArrayBuffer, null);
  assert.equal(renderer._interleavedPositionView, null);
  assert.equal(renderer._interleavedColorView, null);
});

test('compact packing owns its client bytes and cannot disturb the accepted main GPU copy', () => {
  const fixture = createRendererFixture();
  fixture.renderer._createInterleavedBuffer(
    fixture.positions,
    fixture.colors,
  );
  // The full-detail store is filled through the fixed staging block, so it
  // allocates no point-count-sized client owner at all.
  assert.equal(
    fixture.renderer._interleavedArrayBuffer instanceof ArrayBuffer,
    false,
  );
  assert.equal(
    fixture.renderer._interleavedChunkBuffer.byteLength,
    65_536 * 16,
  );
  const acceptedMain = fixture.gl._state.contents.buffers.get(
    fixture.mainBuffer,
  );
  assert.ok(acceptedMain instanceof ArrayBuffer);
  const acceptedMainBytes =
    new Uint8Array(acceptedMain.slice(0));

  resetGlActivity(fixture.gl);
  publishFixture(fixture);
  const compactUpload = fixture.gl._state.uploads.find(
    upload => upload.target === fixture.gl.ARRAY_BUFFER,
  );
  assert.ok(compactUpload);
  // The compact generation is the only consumer of the point-count-sized
  // packing owner, and it reaches the GPU as one whole-store upload.
  const sharedScratch =
    fixture.renderer._interleavedArrayBuffer;
  assert.ok(sharedScratch instanceof ArrayBuffer);
  assert.equal(sharedScratch.byteLength, FULL_POINT_COUNT * 16);
  assert.strictEqual(
    compactUpload.sourceBuffer,
    sharedScratch,
  );
  assert.equal(compactUpload.kind, 'bufferData');
  assert.deepEqual(
    new Uint8Array(
      fixture.gl._state.contents.buffers.get(
        fixture.mainBuffer,
      ),
    ),
    acceptedMainBytes,
  );
  assert.notDeepEqual(
    new Uint8Array(
      sharedScratch,
      0,
      REDUCED_PREFIX.length * 16,
    ),
    acceptedMainBytes.subarray(
      0,
      REDUCED_PREFIX.length * 16,
    ),
  );
});

test('in-place recolor documents and immediately validates the normative WebGL bufferData transaction', async () => {
  const rendererSource = await readFile(
    new URL(
      '../assets/js/rendering/high-perf-renderer.js',
      import.meta.url,
    ),
    'utf8',
  );
  const recolorStart = rendererSource.indexOf(
    '_rebuildLODBuffersWithCurrentData(',
  );
  const recolorEnd = rendererSource.indexOf(
    '\n  setFogRange(',
    recolorStart,
  );
  assert.ok(recolorStart >= 0 && recolorEnd > recolorStart);
  const recolorSource = rendererSource.slice(recolorStart, recolorEnd);
  assert.match(
    recolorSource,
    /bufferData[\s\S]{0,500}size is unmodified[\s\S]{0,250}no data is written/i,
    'the recolor seam must retain the WebGL 2 bufferData error guarantee beside the in-place publication',
  );
  assert.match(
    recolorSource,
    /gl\.bufferData\([\s\S]{0,300}requireCleanWebGLState\(/,
    'bufferData must be followed immediately by sticky-error validation',
  );
  assert.doesNotMatch(
    recolorSource,
    /gl\.createBuffer\(|gl\.createVertexArray\(/,
    'the normative bufferData transaction avoids replacement-resource churn',
  );
});

function decodeCompactUpload(
  upload,
  pointCount = REDUCED_PREFIX.length,
) {
  const arrayBuffer = upload instanceof ArrayBuffer
    ? upload
    : upload.buffer;
  const byteOffset = upload instanceof ArrayBuffer
    ? 0
    : upload.byteOffset;
  const byteLength = upload.byteLength;
  const positions = [];
  const colors = [];
  const positionView = new Float32Array(
    arrayBuffer,
    byteOffset,
    byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  const colorView = new Uint8Array(
    arrayBuffer,
    byteOffset,
    byteLength,
  );
  for (
    let compactIndex = 0;
    compactIndex < pointCount;
    compactIndex++
  ) {
    const floatOffset = compactIndex * 4;
    const byteOffset = compactIndex * 16 + 12;
    positions.push(Array.from(
      positionView.subarray(floatOffset, floatOffset + 3),
    ));
    colors.push(Array.from(
      colorView.subarray(byteOffset, byteOffset + 4),
    ));
  }
  return { colors, positions };
}

test('one maximum-prefix GPU generation serves every reduced LOD in one dimension', () => {
  const fixture = createRendererFixture();
  publishFixture(fixture);

  const {
    creates,
    uploads,
  } = fixture.gl._state;
  const lodBuffers =
    fixture.renderer.lodBuffersByDimension.get(DIMENSION);
  const indexTextures =
    fixture.renderer._lodIndexTexturesByDimension.get(DIMENSION);
  const reducedBuffers = lodBuffers.filter(level => !level.isFullDetail);
  const fullDetail = lodBuffers.at(-1);
  const reducedTextures = indexTextures.slice(0, -1);
  const generation = captureDimensionGeneration(
    fixture.renderer,
    DIMENSION,
  );

  assertStrictReducedPrefixes(fixture.spatialIndex);
  assert.equal(reducedBuffers.length, 17);
  assert.equal(lodBuffers.length, fixture.spatialIndex.lodLevels.length);
  assert.equal(indexTextures.length, fixture.spatialIndex.lodLevels.length);
  assert.equal(new Set(reducedBuffers.map(level => level.buffer)).size, 1);
  assert.equal(new Set(reducedBuffers.map(level => level.vao)).size, 1);
  assert.equal(
    new Set(reducedBuffers.map(level => level.originalIndexBuffer)).size,
    1,
  );
  assert.equal(
    new Set(reducedTextures.map(entry => entry.texture)).size,
    1,
  );
  assert.equal(generation.compactBuffer, reducedBuffers[0].buffer);
  assert.equal(generation.compactVao, reducedBuffers[0].vao);
  assert.equal(
    generation.originalIndexBuffer,
    reducedBuffers[0].originalIndexBuffer,
  );
  assert.equal(generation.indexTexture, reducedTextures[0].texture);
  assert.deepEqual(
    reducedTextures.map(entry => [entry.width, entry.height]),
    REDUCED_COUNTS.map(() => [REDUCED_PREFIX.length, 1]),
  );
  assert.deepEqual(
    reducedBuffers.map(level => level.originalIndexCount),
    REDUCED_COUNTS,
  );
  assert.deepEqual(
    reducedBuffers.map(level => level.pointCount),
    REDUCED_COUNTS,
  );

  assert.equal(fullDetail.isFullDetail, true);
  assert.equal(fullDetail.buffer, fixture.mainBuffer);
  assert.equal(fullDetail.vao, fixture.mainVao);
  assert.equal(fullDetail.originalIndexBuffer, null);
  assert.equal(fullDetail.originalIndexCount, 0);
  assert.equal(indexTextures.at(-1).texture, null);

  assert.equal(creates.buffers.length, 2);
  assert.equal(creates.vertexArrays.length, 1);
  assert.equal(creates.textures.length, 1);

  const arrayUploads = uploads.filter(
    upload => upload.target === fixture.gl.ARRAY_BUFFER,
  );
  const elementUploads = uploads.filter(
    upload => upload.target === fixture.gl.ELEMENT_ARRAY_BUFFER,
  );
  const textureAllocations = uploads.filter(
    upload => upload.kind === 'texImage2D',
  );
  const textureUploads = uploads.filter(
    upload => upload.kind === 'texSubImage2D',
  );
  assert.equal(arrayUploads.length, 1);
  assert.equal(elementUploads.length, 1);
  assert.equal(textureAllocations.length, 1);
  assert.equal(textureUploads.length, 1);
  assert.equal(textureAllocations[0].data, null);
  assert.equal(textureAllocations[0].width, REDUCED_PREFIX.length);
  assert.equal(textureAllocations[0].height, 1);
  assert.equal(arrayUploads[0].usage, fixture.gl.STATIC_DRAW);
  assert.equal(elementUploads[0].usage, fixture.gl.STATIC_DRAW);
  assert.strictEqual(
    arrayUploads[0].sourceBuffer,
    fixture.renderer._interleavedArrayBuffer,
  );
  assert.equal(arrayUploads[0].sourceByteOffset, 0);
  assert.equal(
    arrayUploads[0].data.byteLength,
    REDUCED_PREFIX.length * 16,
  );
  assert.equal(
    fixture.renderer._interleavedArrayBuffer.byteLength,
    FULL_POINT_COUNT * 16,
  );
  assert.deepEqual(
    Array.from(elementUploads[0].data),
    Array.from(REDUCED_PREFIX),
  );
  assert.deepEqual(
    Array.from(
      textureUploads[0].data.subarray(0, REDUCED_PREFIX.length),
    ),
    Array.from(REDUCED_PREFIX),
  );

  const compact = decodeCompactUpload(arrayUploads[0].data);
  assert.deepEqual(
    compact.positions,
    Array.from(REDUCED_PREFIX, originalIndex => Array.from(
      fixture.positions.subarray(
        originalIndex * 3,
        originalIndex * 3 + 3,
      ),
    )),
  );
  assert.deepEqual(
    compact.colors,
    Array.from(REDUCED_PREFIX, originalIndex => Array.from(
      fixture.colors.subarray(
        originalIndex * 4,
        originalIndex * 4 + 4,
      ),
    )),
  );
});

test('small-N repeated full-count reduced levels share one valid GPU prefix', () => {
  const pointCount = 8;
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);
  for (let index = 0; index < pointCount; index++) {
    positions[index * 3] = index;
    positions[index * 3 + 1] = -index;
    colors[index * 4] = index;
    colors[index * 4 + 3] = 255;
  }
  const spatialIndex = new SpatialIndex(
    positions,
    colors,
    DIMENSION,
    32,
    4,
    {
      buildLOD: true,
      buildLodNodeMappings: false,
      computeNodeStats: false,
    },
  );
  const gl = createTrackingGl();
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      gl,
      pointCount,
      _positions: positions,
      _colors: colors,
      _dirtyLodDimensions: new Set(),
      _lodArrayBuffers: null,
      _lodIndexTexturesByDimension: new Map(),
      _pendingDataRetirements: new Set(),
      _pendingSnapshotRetirements: new Set(),
      buffers: {
        interleaved: gl._adoptBuffer('small-main-buffer'),
      },
      lodBuffersByDimension: new Map(),
      spatialIndices: new Map([[DIMENSION, spatialIndex]]),
      stats: { gpuMemoryMB: 0 },
      vao: gl._adoptVertexArray('small-main-vao'),
    },
  );

  renderer._createLODResourcesForDimension(
    DIMENSION,
    spatialIndex,
  );

  const metadata =
    renderer.lodBuffersByDimension.get(DIMENSION);
  const reduced = metadata.slice(0, -1);
  assert.equal(reduced.length, 17);
  assert.deepEqual(
    reduced.map(level => level.pointCount),
    Array.from({ length: 17 }, () => pointCount),
  );
  assert.equal(new Set(reduced.map(level => level.buffer)).size, 1);
  assert.equal(
    new Set(reduced.map(level => level.originalIndexBuffer)).size,
    1,
  );
  assert.equal(gl._state.creates.buffers.length, 2);
  assert.equal(gl._state.creates.vertexArrays.length, 1);
  assert.equal(gl._state.creates.textures.length, 1);
});

test('non-prefix LOD input is rejected before allocation and preserves the old generation', () => {
  const fixture = createRendererFixture();
  publishFixture(fixture);
  const accepted = captureDimensionGeneration(
    fixture.renderer,
    DIMENSION,
  );
  resetGlActivity(fixture.gl);
  fixture.spatialIndex.lodLevels[1].indices =
    Uint32Array.from([37, 2, 0, 30]);

  assert.throws(
    () => fixture.renderer._createLODResourcesForDimension(
      DIMENSION,
      fixture.spatialIndex,
    ),
    /LOD|prefix|order/i,
  );
  assert.strictEqual(
    fixture.renderer.lodBuffersByDimension.get(DIMENSION),
    accepted.lodBuffers,
  );
  assert.strictEqual(
    fixture.renderer._lodIndexTexturesByDimension.get(DIMENSION),
    accepted.indexTextures,
  );
  assert.equal(fixture.gl._state.creates.buffers.length, 0);
  assert.equal(fixture.gl._state.creates.vertexArrays.length, 0);
  assert.equal(fixture.gl._state.creates.textures.length, 0);
});

test('LOD texture-capacity failures report the actual clamped width and allocate nothing', () => {
  const fixture = createRendererFixture();
  fixture.gl._state.limits.maxTextureSize = 4;

  assert.throws(
    () => fixture.renderer._createLODResourcesForDimension(
      DIMENSION,
      fixture.spatialIndex,
    ),
    /4x4 R32UI texture capacity/,
  );
  assert.equal(fixture.gl._state.creates.buffers.length, 0);
  assert.equal(fixture.gl._state.creates.vertexArrays.length, 0);
  assert.equal(fixture.gl._state.creates.textures.length, 0);
});

test('recoloring atomically uploads once in place without changing generation identity', () => {
  const fixture = createRendererFixture();
  publishFixture(fixture);
  const accepted = captureDimensionGeneration(
    fixture.renderer,
    DIMENSION,
  );
  resetGlActivity(fixture.gl);

  const nextColors = new Uint8Array(fixture.colors.length);
  for (let index = 0; index < FULL_POINT_COUNT; index++) {
    nextColors[index * 4] = 200 - index;
    nextColors[index * 4 + 1] = 150 - index;
    nextColors[index * 4 + 2] = 100 - index;
    nextColors[index * 4 + 3] = 50 + index;
  }
  fixture.renderer.updateColors(nextColors);
  // This focused contract isolates compact recolor publication from the
  // independent full-detail recolor.
  fixture.renderer._bufferDirty = false;
  fixture.renderer.flushBufferUpdates(DIMENSION);

  const compactUploads = fixture.gl._state.uploads.filter(
    upload => upload.target === fixture.gl.ARRAY_BUFFER,
  );
  assert.equal(
    compactUploads.length,
    1,
    'a recolor must not stage or upload once per reduced level',
  );
  assert.equal(
    compactUploads[0].data.byteLength,
    REDUCED_PREFIX.length * 16,
  );
  assert.equal(compactUploads[0].kind, 'bufferData');
  assert.equal(compactUploads[0].usage, fixture.gl.DYNAMIC_DRAW);
  assert.strictEqual(compactUploads[0].buffer, accepted.compactBuffer);
  assert.equal(
    fixture.gl._state.uploads.some(
      upload => upload.target === fixture.gl.ELEMENT_ARRAY_BUFFER,
    ),
    false,
  );
  assert.equal(
    fixture.gl._state.uploads.some(
      upload => (
        upload.kind === 'texImage2D' ||
        upload.kind === 'texSubImage2D'
      ),
    ),
    false,
  );
  assert.deepEqual(
    decodeCompactUpload(compactUploads[0].data).colors,
    Array.from(REDUCED_PREFIX, originalIndex => Array.from(
      nextColors.subarray(
        originalIndex * 4,
        originalIndex * 4 + 4,
      ),
    )),
  );
  const recolored = captureDimensionGeneration(
    fixture.renderer,
    DIMENSION,
  );
  assert.strictEqual(
    recolored.generationToken,
    accepted.generationToken,
  );
  assert.strictEqual(recolored.compactBuffer, accepted.compactBuffer);
  assert.strictEqual(recolored.compactVao, accepted.compactVao);
  assert.strictEqual(
    recolored.originalIndexBuffer,
    accepted.originalIndexBuffer,
  );
  assert.strictEqual(recolored.indexTexture, accepted.indexTexture);
  assert.strictEqual(recolored.topologyOwner, accepted.topologyOwner);
  assert.equal(fixture.gl._state.creates.buffers.length, 0);
  assert.equal(fixture.gl._state.creates.vertexArrays.length, 0);
  assert.equal(fixture.gl._state.creates.textures.length, 0);
  assert.equal(fixture.gl._state.deleteAttempts.buffers.length, 0);
  assert.equal(fixture.gl._state.deleteAttempts.vertexArrays.length, 0);
  assert.equal(fixture.gl._state.deleteAttempts.textures.length, 0);
  assert.equal(
    fixture.renderer._dirtyLodDimensions.has(DIMENSION),
    false,
  );
});

test('failed in-place recolors preserve accepted bytes, identities, and retryable dirty state', async t => {
  const cases = [
    {
      configure: gl => {
        gl._state.fail.preflightError = true;
      },
      name: 'sticky preflight error',
    },
    {
      configure: gl => {
        gl._state.fail.throwBufferTarget = gl.ARRAY_BUFFER;
      },
      name: 'bufferData throw',
    },
    {
      configure: gl => {
        gl._state.fail.stickyAfterUpload = true;
      },
      name: 'bufferData sticky error',
    },
  ];

  for (const recolorCase of cases) {
    await t.test(recolorCase.name, () => {
      const fixture = createRendererFixture();
      publishFixture(fixture);
      const accepted = captureDimensionGeneration(
        fixture.renderer,
        DIMENSION,
      );
      const acceptedBytes = new Uint8Array(
        fixture.gl._state.contents.buffers.get(
          accepted.compactBuffer,
        ),
      ).slice();
      const acceptedGpuBytes =
        fixture.renderer.stats.gpuMemoryMB * 1024 * 1024;
      resetGlActivity(fixture.gl);

      const nextColors = new Uint8Array(fixture.colors.length);
      nextColors.fill(137);
      fixture.renderer.updateColors(nextColors);
      fixture.renderer._bufferDirty = false;
      recolorCase.configure(fixture.gl);

      assert.throws(
        () => fixture.renderer.flushBufferUpdates(DIMENSION),
      );
      const afterFailure = captureDimensionGeneration(
        fixture.renderer,
        DIMENSION,
      );
      assert.strictEqual(
        afterFailure.generationToken,
        accepted.generationToken,
      );
      assert.strictEqual(
        afterFailure.compactBuffer,
        accepted.compactBuffer,
      );
      assert.strictEqual(afterFailure.compactVao, accepted.compactVao);
      assert.strictEqual(
        afterFailure.topologyOwner,
        accepted.topologyOwner,
      );
      assert.deepEqual(
        new Uint8Array(
          fixture.gl._state.contents.buffers.get(
            accepted.compactBuffer,
          ),
        ),
        acceptedBytes,
      );
      assert.equal(
        fixture.renderer._dirtyLodDimensions.has(DIMENSION),
        true,
      );
      assert.equal(
        fixture.renderer.stats.gpuMemoryMB * 1024 * 1024,
        acceptedGpuBytes,
      );
      assert.equal(fixture.gl._state.creates.buffers.length, 0);
      assert.equal(fixture.gl._state.creates.vertexArrays.length, 0);
      assert.equal(fixture.gl._state.creates.textures.length, 0);
      assert.equal(fixture.gl._state.deleteAttempts.buffers.length, 0);
      assert.equal(
        fixture.gl._state.deleteAttempts.vertexArrays.length,
        0,
      );
      assert.equal(fixture.gl._state.deleteAttempts.textures.length, 0);
      assert.equal(
        fixture.gl._state.uploads.every(
          upload => upload.buffer === accepted.compactBuffer,
        ),
        true,
      );

      Object.assign(fixture.gl._state.fail, {
        preflightError: false,
        stickyAfterUpload: false,
        throwBufferTarget: null,
      });
      fixture.renderer.flushBufferUpdates(DIMENSION);
      const retried = captureDimensionGeneration(
        fixture.renderer,
        DIMENSION,
      );
      assert.strictEqual(
        retried.generationToken,
        accepted.generationToken,
      );
      assert.strictEqual(retried.compactBuffer, accepted.compactBuffer);
      assert.equal(
        fixture.renderer._dirtyLodDimensions.has(DIMENSION),
        false,
      );
      assert.deepEqual(
        decodeCompactUpload(
          fixture.gl._state.contents.buffers.get(
            accepted.compactBuffer,
          ),
        ).colors,
        Array.from(REDUCED_PREFIX, () => [137, 137, 137, 137]),
      );
    });
  }
});

test('candidate failures preserve the complete old per-dimension generation', async t => {
  const cases = [
    {
      configure: gl => {
        gl._state.fail.preflightError = true;
      },
      name: 'sticky preflight error',
    },
    {
      configure: gl => {
        gl._state.fail.createBufferAt = 1;
      },
      name: 'null compact VBO',
    },
    {
      configure: gl => {
        gl._state.fail.createBufferAt = 2;
      },
      name: 'null original-index EBO',
    },
    {
      configure: gl => {
        gl._state.fail.createVertexArrayAt = 1;
      },
      name: 'null compact VAO',
    },
    {
      configure: gl => {
        gl._state.fail.createTextureAt = 1;
      },
      name: 'null index texture',
    },
    {
      configure: gl => {
        gl._state.fail.throwBufferTarget = gl.ARRAY_BUFFER;
      },
      name: 'compact VBO upload throw',
    },
    {
      configure: gl => {
        gl._state.fail.throwBufferTarget = gl.ELEMENT_ARRAY_BUFFER;
      },
      name: 'original-index EBO upload throw',
    },
    {
      configure: gl => {
        gl._state.fail.throwTextureUpload = true;
      },
      name: 'index-texture upload throw',
    },
    {
      configure: gl => {
        gl._state.fail.stickyAfterUpload = true;
      },
      name: 'sticky candidate upload error',
    },
  ];

  for (const candidateCase of cases) {
    await t.test(candidateCase.name, () => {
      const fixture = createRendererFixture();
      publishFixture(fixture);
      const accepted = captureDimensionGeneration(
        fixture.renderer,
        DIMENSION,
      );
      const acceptedBytes =
        fixture.renderer.stats.gpuMemoryMB * 1024 * 1024;
      resetGlActivity(fixture.gl);
      candidateCase.configure(fixture.gl);

      assert.throws(
        () => fixture.renderer._createLODResourcesForDimension(
          DIMENSION,
          fixture.spatialIndex,
        ),
      );
      assert.strictEqual(
        fixture.renderer.lodBuffersByDimension.get(DIMENSION),
        accepted.lodBuffers,
      );
      assert.strictEqual(
        fixture.renderer._lodIndexTexturesByDimension.get(DIMENSION),
        accepted.indexTextures,
      );
      const stillAccepted = captureDimensionGeneration(
        fixture.renderer,
        DIMENSION,
      );
      assert.strictEqual(
        stillAccepted.generationToken,
        accepted.generationToken,
      );
      assert.strictEqual(
        stillAccepted.compactBuffer,
        accepted.compactBuffer,
      );
      assert.strictEqual(
        stillAccepted.compactVao,
        accepted.compactVao,
      );
      assert.strictEqual(
        stillAccepted.originalIndexBuffer,
        accepted.originalIndexBuffer,
      );
      assert.strictEqual(
        stillAccepted.indexTexture,
        accepted.indexTexture,
      );
      assert.equal(
        fixture.gl._state.live.buffers.has(
          accepted.compactBuffer,
        ),
        true,
      );
      assert.equal(
        fixture.gl._state.live.buffers.has(
          accepted.originalIndexBuffer,
        ),
        true,
      );
      assert.equal(
        fixture.gl._state.live.vertexArrays.has(
          accepted.compactVao,
        ),
        true,
      );
      assert.equal(
        fixture.gl._state.live.textures.has(
          accepted.indexTexture,
        ),
        true,
      );
      assert.equal(
        fixture.renderer.stats.gpuMemoryMB * 1024 * 1024,
        acceptedBytes,
      );

      for (const handle of fixture.gl._state.creates.buffers) {
        assert.equal(
          fixture.gl._state.live.buffers.has(handle),
          false,
          `rejected buffer ${handle.id} must remain retry-owned or be deleted`,
        );
      }
      for (const handle of fixture.gl._state.creates.vertexArrays) {
        assert.equal(
          fixture.gl._state.live.vertexArrays.has(handle),
          false,
          `rejected VAO ${handle.id} must remain retry-owned or be deleted`,
        );
      }
      for (const handle of fixture.gl._state.creates.textures) {
        assert.equal(
          fixture.gl._state.live.textures.has(handle),
          false,
          `rejected texture ${handle.id} must remain retry-owned or be deleted`,
        );
      }
    });
  }
});

test('commit is authoritative while old shared handles retire attempt-all and retry exactly', () => {
  const fixture = createRendererFixture();
  publishFixture(fixture);
  const old = captureDimensionGeneration(
    fixture.renderer,
    DIMENSION,
  );
  resetGlActivity(fixture.gl);
  fixture.gl._state.fail.deleteBuffers.set(
    old.compactBuffer,
    'before',
  );
  fixture.gl._state.fail.deleteVertexArrays.set(
    old.compactVao,
    'after',
  );
  fixture.gl._state.fail.deleteTextures.set(
    old.indexTexture,
    'after',
  );

  assert.doesNotThrow(
    () => fixture.renderer._createLODResourcesForDimension(
      DIMENSION,
      fixture.spatialIndex,
    ),
  );
  const candidateBuffers =
    fixture.renderer.lodBuffersByDimension.get(DIMENSION);
  const candidateTextures =
    fixture.renderer._lodIndexTexturesByDimension.get(DIMENSION);
  const candidate = captureDimensionGeneration(
    fixture.renderer,
    DIMENSION,
  );
  assert.notStrictEqual(candidateBuffers, old.lodBuffers);
  assert.notStrictEqual(candidateTextures, old.indexTextures);
  assert.notStrictEqual(
    candidate.generationToken,
    old.generationToken,
  );

  const { deleteAttempts, live } = fixture.gl._state;
  assert.equal(
    countIdentity(deleteAttempts.buffers, old.compactBuffer),
    1,
  );
  assert.equal(
    countIdentity(
      deleteAttempts.buffers,
      old.originalIndexBuffer,
    ),
    1,
  );
  assert.equal(
    countIdentity(deleteAttempts.vertexArrays, old.compactVao),
    1,
  );
  assert.equal(
    countIdentity(deleteAttempts.textures, old.indexTexture),
    1,
  );
  assert.equal(live.buffers.has(old.compactBuffer), true);
  assert.equal(live.buffers.has(old.originalIndexBuffer), false);
  assert.equal(live.vertexArrays.has(old.compactVao), false);
  assert.equal(live.textures.has(old.indexTexture), false);
  assert.equal(
    countIdentity(deleteAttempts.buffers, fixture.mainBuffer),
    0,
    'borrowed full-detail resources must not enter LOD retirement',
  );
  assert.equal(
    countIdentity(deleteAttempts.vertexArrays, fixture.mainVao),
    0,
    'borrowed full-detail resources must not enter LOD retirement',
  );
  const currentBytes =
    FULL_POINT_COUNT * 16 +
    expectedLodOwnerBytes(
      REDUCED_PREFIX.length,
      fixture.gl._state.limits.maxTextureSize,
    );
  assertGpuBytes(
    fixture.renderer,
    currentBytes + REDUCED_PREFIX.length * 16,
  );

  fixture.gl._state.fail.deleteBuffers.delete(
    old.compactBuffer,
  );
  fixture.gl._state.fail.deleteVertexArrays.delete(
    old.compactVao,
  );
  fixture.gl._state.fail.deleteTextures.delete(
    old.indexTexture,
  );
  assert.deepEqual(fixture.renderer._drainDataRetirements(), []);
  assertGpuBytes(fixture.renderer, currentBytes);
  assert.equal(live.buffers.has(old.compactBuffer), false);
  assert.equal(
    countIdentity(deleteAttempts.buffers, old.compactBuffer),
    2,
  );
  assert.equal(
    countIdentity(
      deleteAttempts.buffers,
      old.originalIndexBuffer,
    ),
    1,
  );
  assert.equal(
    countIdentity(deleteAttempts.vertexArrays, old.compactVao),
    1,
    'delete-then-throw must settle through exact liveness inspection',
  );
  assert.equal(
    countIdentity(deleteAttempts.textures, old.indexTexture),
    1,
    'deleted index texture bytes must settle even when deletion throws',
  );

  assert.equal(live.buffers.has(candidate.compactBuffer), true);
  assert.equal(live.buffers.has(candidate.originalIndexBuffer), true);
  assert.equal(live.vertexArrays.has(candidate.compactVao), true);
  assert.equal(live.textures.has(candidate.indexTexture), true);
});

function expectedIndexTextureBytes(pointCount, maxTextureSize) {
  const width = Math.min(pointCount, maxTextureSize);
  const height = Math.ceil(pointCount / width);
  return width * height * Uint32Array.BYTES_PER_ELEMENT;
}

function expectedLodOwnerBytes(pointCount, maxTextureSize) {
  return (
    pointCount * 16 +
    pointCount * Uint32Array.BYTES_PER_ELEMENT +
    expectedIndexTextureBytes(pointCount, maxTextureSize)
  );
}

function assertGpuBytes(renderer, expectedBytes) {
  assert.ok(
    Math.abs(
      renderer.stats.gpuMemoryMB * 1024 * 1024 -
      expectedBytes
    ) < 1e-9,
    `expected ${expectedBytes} exact managed GPU bytes, received ${renderer.stats.gpuMemoryMB * 1024 * 1024}`,
  );
}

function initializeLoadDataFixture() {
  const fixture = createRendererFixture();
  const { renderer } = fixture;
  Object.assign(renderer, {
    options: {},
    useAdaptiveLOD: false,
    useFrustumCulling: false,
    forceLODLevel: -1,
    currentDimensionLevel: DIMENSION,
    _liveGeometryGeneration: 1,
    _nextGeometryGeneration: 2,
    _alphaTexture: null,
    _alphaTexWidth: 0,
    _alphaTexHeight: 0,
    _alphaTexData: null,
    _useAlphaTexture: false,
    _currentAlphas: null,
    _perViewState: new Map(),
    _firstRenderDone: false,
    _boundingSphere: { center: [0, 0, 0], radius: 1 },
    _bufferDirty: false,
    _interleavedArrayBuffer: null,
    _interleavedPositionView: null,
    _interleavedColorView: null,
    _snapshotGeometryPools: new Map(),
    snapshotBuffers: new Map(),
    stats: {
      cullPercent: 0,
      drawCalls: 0,
      fps: 0,
      frustumCulled: false,
      gpuMemoryMB: 0,
      lastFrameTime: 0,
      lodLevel: -1,
      visiblePoints: 0,
    },
  });
  fixture.gl._state.limits.maxTextureSize = 8;
  renderer._createInterleavedBuffer = function createMainBuffer(
    positions,
  ) {
    const byteLength = positions.length / 3 * 16;
    const buffer = this.gl.createBuffer();
    assert.ok(buffer);
    this.buffers.interleaved = buffer;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      new ArrayBuffer(byteLength),
      this.gl.STATIC_DRAW,
    );
    this._interleavedGpuByteLength = byteLength;
  };
  renderer._createAlphaTexture = function createAlphaAndLod(
    pointCount,
  ) {
    this._alphaTexture = this.gl.createTexture();
    assert.ok(this._alphaTexture);
    this._alphaTexWidth = Math.min(
      pointCount,
      this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE),
    );
    this._alphaTexHeight =
      Math.ceil(pointCount / this._alphaTexWidth);
    this._alphaTexData = new Uint8Array(
      this._alphaTexWidth * this._alphaTexHeight,
    );
    this._alphaTextureByteLength = this._alphaTexData.byteLength;
    const spatialIndex = createSpatialIndex(
      this._positions,
      this._colors,
    );
    this.spatialIndices.set(DIMENSION, spatialIndex);
    this._createLODResourcesForDimension(
      DIMENSION,
      spatialIndex,
    );
  };
  renderer._computeBoundingSphere = () => ({
    center: [0, 0, 0],
    radius: 2,
  });
  return fixture;
}

test('loadData reports exact generation-owner bytes without per-level estimates', () => {
  const fixture = initializeLoadDataFixture();
  requireAtomicPublicationSeam(fixture.renderer);
  const next = createPointData();

  fixture.renderer.loadData(next.positions, next.colors, {
    buildSpatialIndex: false,
    dimensionLevel: DIMENSION,
  });

  const alphaBytes =
    fixture.renderer._alphaTexWidth *
    fixture.renderer._alphaTexHeight;
  const expectedBytes =
    FULL_POINT_COUNT * 16 +
    alphaBytes +
    expectedLodOwnerBytes(
      REDUCED_PREFIX.length,
      fixture.gl._state.limits.maxTextureSize,
    );
  assertGpuBytes(fixture.renderer, expectedBytes);
});

test('three-dimension residency converges to one exact byte bound across repeated recolor and publication', () => {
  // The renderer has a real simultaneous 1D/2D/3D multiview requirement, so
  // this contract bounds those three resident owners and deliberately does
  // not invent an eviction policy. A configurable aggregate GPU budget
  // remains a separate product requirement if larger owner sets are added.
  const fixture = createRendererFixture();
  requireAtomicPublicationSeam(fixture.renderer);
  fixture.gl._state.limits.maxTextureSize = 8;
  fixture.renderer._alphaTexture =
    fixture.gl._adoptTexture('alpha-texture');
  fixture.renderer._alphaTexWidth = 4;
  fixture.renderer._alphaTexHeight =
    Math.ceil(FULL_POINT_COUNT / fixture.renderer._alphaTexWidth);

  const baseBytes =
    FULL_POINT_COUNT * 16 +
    fixture.renderer._alphaTexWidth *
      fixture.renderer._alphaTexHeight;
  const oneDimensionalPrefix = Uint32Array.from([
    6, 1, 12, 4, 9, 0,
  ]);
  const threeDimensionalPrefix = Uint32Array.from([
    1, 4, 8, 0, 12, 2, 11,
  ]);
  const dimensionFixtures = new Map([
    [1, {
      prefix: oneDimensionalPrefix,
      spatialIndex: createSpatialIndex(
        fixture.positions,
        fixture.colors,
        {
          dimensionLevel: 1,
          prefix: oneDimensionalPrefix,
          reducedCounts: [2, 4, oneDimensionalPrefix.length],
        },
      ),
    }],
    [DIMENSION, {
      prefix: REDUCED_PREFIX,
      spatialIndex: fixture.spatialIndex,
    }],
    [3, {
      prefix: threeDimensionalPrefix,
      spatialIndex: createSpatialIndex(
        fixture.positions,
        fixture.colors,
        {
          dimensionLevel: 3,
          prefix: threeDimensionalPrefix,
          reducedCounts: [2, 4, threeDimensionalPrefix.length],
        },
      ),
    }],
  ]);
  let exactResidencyBound = baseBytes;
  for (const [dimensionLevel, dimensionFixture] of dimensionFixtures) {
    fixture.renderer.spatialIndices.set(
      dimensionLevel,
      dimensionFixture.spatialIndex,
    );
    fixture.renderer._createLODResourcesForDimension(
      dimensionLevel,
      dimensionFixture.spatialIndex,
    );
    dimensionFixture.byteLength = expectedLodOwnerBytes(
      dimensionFixture.prefix.length,
      fixture.gl._state.limits.maxTextureSize,
    );
    exactResidencyBound += dimensionFixture.byteLength;
  }
  assertGpuBytes(fixture.renderer, exactResidencyBound);
  assert.ok(
    fixture.renderer.stats.gpuMemoryMB <=
      exactResidencyBound / (1024 * 1024),
  );
  assert.equal(fixture.gl._state.live.buffers.size, 7);
  assert.equal(fixture.gl._state.live.textures.size, 4);
  assert.equal(fixture.gl._state.live.vertexArrays.size, 4);

  for (let iteration = 0; iteration < 4; iteration++) {
    const before = new Map(
      Array.from(dimensionFixtures.keys(), dimensionLevel => [
        dimensionLevel,
        captureDimensionGeneration(
          fixture.renderer,
          dimensionLevel,
        ),
      ]),
    );
    const colors = new Uint8Array(fixture.colors.length);
    colors.fill(40 + iteration);
    fixture.renderer.updateColors(colors);
    fixture.renderer._bufferDirty = false;
    resetGlActivity(fixture.gl);
    for (const dimensionLevel of dimensionFixtures.keys()) {
      fixture.renderer.flushBufferUpdates(dimensionLevel);
      const after = captureDimensionGeneration(
        fixture.renderer,
        dimensionLevel,
      );
      assert.strictEqual(
        after.generationToken,
        before.get(dimensionLevel).generationToken,
      );
      assert.strictEqual(
        after.compactBuffer,
        before.get(dimensionLevel).compactBuffer,
      );
      assert.strictEqual(
        after.compactVao,
        before.get(dimensionLevel).compactVao,
      );
      assert.strictEqual(
        after.topologyOwner,
        before.get(dimensionLevel).topologyOwner,
      );
    }
    const compactUploads = fixture.gl._state.uploads.filter(
      upload => upload.target === fixture.gl.ARRAY_BUFFER,
    );
    assert.equal(compactUploads.length, dimensionFixtures.size);
    let uploadIndex = 0;
    for (const dimensionFixture of dimensionFixtures.values()) {
      const upload = compactUploads[uploadIndex++];
      assert.strictEqual(
        upload.sourceBuffer,
        fixture.renderer._interleavedArrayBuffer,
      );
      assert.equal(
        upload.sourceByteLength,
        dimensionFixture.prefix.length * 16,
      );
      const decoded = decodeCompactUpload(
        upload.data,
        dimensionFixture.prefix.length,
      );
      assert.deepEqual(
        decoded.positions,
        Array.from(
          dimensionFixture.prefix,
          originalIndex => Array.from(
            fixture.positions.subarray(
              originalIndex * 3,
              originalIndex * 3 + 3,
            ),
          ),
        ),
      );
      assert.deepEqual(
        decoded.colors,
        Array.from(
          { length: dimensionFixture.prefix.length },
          () => [40 + iteration, 40 + iteration, 40 + iteration, 40 + iteration],
        ),
      );
    }
    assertGpuBytes(fixture.renderer, exactResidencyBound);
    assert.equal(fixture.gl._state.live.buffers.size, 7);
    assert.equal(fixture.gl._state.live.textures.size, 4);
    assert.equal(fixture.gl._state.live.vertexArrays.size, 4);
    assert.equal(fixture.gl._state.creates.buffers.length, 0);
    assert.equal(fixture.gl._state.creates.textures.length, 0);
    assert.equal(fixture.gl._state.creates.vertexArrays.length, 0);
    assert.equal(fixture.gl._state.deleteAttempts.buffers.length, 0);
    assert.equal(fixture.gl._state.deleteAttempts.textures.length, 0);
    assert.equal(
      fixture.gl._state.deleteAttempts.vertexArrays.length,
      0,
    );
  }

  for (let iteration = 0; iteration < 6; iteration++) {
    const dimensionLevel = (iteration % 3) + 1;
    const dimensionFixture = dimensionFixtures.get(dimensionLevel);
    const before = captureDimensionGeneration(
      fixture.renderer,
      dimensionLevel,
    );
    resetGlActivity(fixture.gl);
    fixture.renderer._createLODResourcesForDimension(
      dimensionLevel,
      dimensionFixture.spatialIndex,
    );
    const after = captureDimensionGeneration(
      fixture.renderer,
      dimensionLevel,
    );
    assert.notStrictEqual(
      after.generationToken,
      before.generationToken,
    );
    assert.notStrictEqual(after.compactBuffer, before.compactBuffer);
    assert.notStrictEqual(after.compactVao, before.compactVao);
    assert.notStrictEqual(
      after.originalIndexBuffer,
      before.originalIndexBuffer,
    );
    assert.notStrictEqual(after.indexTexture, before.indexTexture);
    assert.equal(
      fixture.gl._state.live.buffers.has(before.compactBuffer),
      false,
    );
    assert.equal(
      fixture.gl._state.live.buffers.has(
        before.originalIndexBuffer,
      ),
      false,
    );
    assert.equal(
      fixture.gl._state.live.vertexArrays.has(before.compactVao),
      false,
    );
    assert.equal(
      fixture.gl._state.live.textures.has(before.indexTexture),
      false,
    );
    assertGpuBytes(fixture.renderer, exactResidencyBound);
    assert.equal(fixture.gl._state.live.buffers.size, 7);
    assert.equal(fixture.gl._state.live.textures.size, 4);
    assert.equal(fixture.gl._state.live.vertexArrays.size, 4);
  }

  let remainingBytes = exactResidencyBound;
  for (const [dimensionLevel, dimensionFixture] of dimensionFixtures) {
    const generation = captureDimensionGeneration(
      fixture.renderer,
      dimensionLevel,
    );
    resetGlActivity(fixture.gl);
    fixture.renderer._deleteLodResourcesForDimension(dimensionLevel);
    remainingBytes -= dimensionFixture.byteLength;
    assertGpuBytes(fixture.renderer, remainingBytes);
    assert.equal(
      countIdentity(
        fixture.gl._state.deleteAttempts.buffers,
        generation.compactBuffer,
      ),
      1,
    );
    assert.equal(
      countIdentity(
        fixture.gl._state.deleteAttempts.buffers,
        generation.originalIndexBuffer,
      ),
      1,
    );
    assert.equal(
      countIdentity(
        fixture.gl._state.deleteAttempts.vertexArrays,
        generation.compactVao,
      ),
      1,
    );
    assert.equal(
      countIdentity(
        fixture.gl._state.deleteAttempts.textures,
        generation.indexTexture,
      ),
      1,
    );
  }
  assert.equal(remainingBytes, baseBytes);
  assert.equal(fixture.gl._state.live.buffers.size, 1);
  assert.equal(fixture.gl._state.live.textures.size, 1);
  assert.equal(fixture.gl._state.live.vertexArrays.size, 1);
});
