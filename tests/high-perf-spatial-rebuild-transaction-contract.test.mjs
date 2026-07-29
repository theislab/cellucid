import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getNotificationCenter,
} from '../assets/js/app/notification-center.js';
import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';

const CURRENT_DIMENSION = 2;
const ALL_DIMENSIONS = Object.freeze([1, 2, 3]);

function makePositions(pointCount) {
  const positions = new Float32Array(pointCount * 3);
  for (let index = 0; index < pointCount; index++) {
    const offset = index * 3;
    positions[offset] = ((index % 101) - 50) / 25;
    positions[offset + 1] =
      ((Math.floor(index / 101) % 101) - 50) / 25;
    positions[offset + 2] = ((index * 17) % 29) / 100;
  }
  return positions;
}

function makeColors(pointCount) {
  const colors = new Uint8Array(pointCount * 4);
  for (let index = 0; index < pointCount; index++) {
    const offset = index * 4;
    colors[offset] = (index * 13) & 0xff;
    colors[offset + 1] = (index * 29) & 0xff;
    colors[offset + 2] = (index * 47) & 0xff;
    colors[offset + 3] = 255;
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
  Object.assign(notifications, {
    completeCalculation() {},
    failCalculation() {},
    hasNotification: () => true,
    startCalculation: () => `spatial-transaction-${nextId++}`,
  });
  t.after(() => Object.assign(notifications, previous));
}

function captureDimensionPublication(renderer, dimensionLevel) {
  return {
    spatialIndex: renderer.spatialIndices?.get(dimensionLevel),
    owner:
      renderer._lodResourceOwnersByDimension?.get(dimensionLevel),
    lodBuffers:
      renderer.lodBuffersByDimension?.get(dimensionLevel),
    lodTextures:
      renderer._lodIndexTexturesByDimension?.get(dimensionLevel),
    boundingSphere: renderer._boundingSphere,
    forceLODLevel: renderer.forceLODLevel,
    perViewState: renderer._perViewState,
  };
}

function createTrackingGl() {
  let nextId = 1;
  let boundArrayBuffer = null;
  let boundElementBuffer = null;
  let boundTexture = null;
  let observer = null;
  let failNextBufferAllocation = false;
  const live = {
    buffers: new Set(),
    textures: new Set(),
    vertexArrays: new Set(),
  };
  const events = [];

  const adopt = (kind, liveSet, label = null) => {
    const handle = Object.freeze({
      id: label ?? `${kind}-${nextId++}`,
      kind,
    });
    liveSet.add(handle);
    return handle;
  };
  const remove = (kind, handle, liveSet) => {
    const event = {
      handle,
      kind,
      publication: observer === null ? null : observer(),
    };
    events.push(event);
    liveSet.delete(handle);
  };

  const gl = {
    ARRAY_BUFFER: 0x8892,
    CLAMP_TO_EDGE: 0x812f,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    FLOAT: 0x1406,
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
    bufferData(target) {
      if (target === this.ARRAY_BUFFER) {
        assert.notEqual(boundArrayBuffer, null);
      } else {
        assert.equal(target, this.ELEMENT_ARRAY_BUFFER);
        assert.notEqual(boundElementBuffer, null);
      }
    },
    createBuffer() {
      if (failNextBufferAllocation) {
        failNextBufferAllocation = false;
        return null;
      }
      return adopt('buffer', live.buffers);
    },
    createTexture() {
      return adopt('texture', live.textures);
    },
    createVertexArray() {
      return adopt('vertex-array', live.vertexArrays);
    },
    deleteBuffer(handle) {
      remove('buffer', handle, live.buffers);
    },
    deleteTexture(handle) {
      remove('texture', handle, live.textures);
    },
    deleteVertexArray(handle) {
      remove('vertex-array', handle, live.vertexArrays);
    },
    enableVertexAttribArray() {},
    getError() {
      return this.NO_ERROR;
    },
    getParameter(parameter) {
      assert.equal(parameter, this.MAX_TEXTURE_SIZE);
      return 4096;
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
    texImage2D(target) {
      assert.equal(target, this.TEXTURE_2D);
      assert.notEqual(boundTexture, null);
    },
    texSubImage2D(target, _level, _x, _y, _width, _height, _format, _type, data) {
      assert.equal(target, this.TEXTURE_2D);
      assert.notEqual(boundTexture, null);
      assert.ok(data instanceof Uint32Array);
    },
    texParameteri(target) {
      assert.equal(target, this.TEXTURE_2D);
      assert.notEqual(boundTexture, null);
    },
    vertexAttribPointer() {},

    _adoptBuffer(label) {
      return adopt('buffer', live.buffers, label);
    },
    _adoptTexture(label) {
      return adopt('texture', live.textures, label);
    },
    _adoptVertexArray(label) {
      return adopt('vertex-array', live.vertexArrays, label);
    },
    _failNextBufferAllocation() {
      failNextBufferAllocation = true;
    },
    _observe(callback) {
      observer = callback;
    },
    _state: {
      events,
      live,
    },
  };
  return gl;
}

function createOldSpatialIndex(
  positions,
  dimensionLevel,
  boundingSphere,
) {
  return {
    dimensionLevel,
    lodLevels: [],
    pointCount: positions.length / 3,
    positions,
    getBoundingSphere() {
      return boundingSphere;
    },
  };
}

function createOldLodPublication(
  gl,
  dimensionLevel,
  spatialIndex,
  mainVao,
  mainBuffer,
) {
  const compactBuffer =
    gl._adoptBuffer(`old-${dimensionLevel}d-compact-buffer`);
  const compactVao =
    gl._adoptVertexArray(`old-${dimensionLevel}d-compact-vao`);
  const originalIndexBuffer =
    gl._adoptBuffer(`old-${dimensionLevel}d-index-buffer`);
  const indexTexture =
    gl._adoptTexture(`old-${dimensionLevel}d-index-texture`);
  const generationToken = Object.freeze({
    name: `old-${dimensionLevel}d-generation`,
  });
  const owner = {
    compactBuffer,
    compactByteLength: 32,
    compactVao,
    dimensionLevel,
    generationToken,
    gpuByteLength: 48,
    liveGeometryGeneration: 4,
    maximumIndices: Uint32Array.from([1, 0]),
    pointCount: spatialIndex.pointCount,
    spatialIndex,
    topologyOwner: {
      indexTexture,
      indexTextureByteLength: 8,
      originalIndexBuffer,
      originalIndexByteLength: 8,
      textureHeight: 1,
      textureWidth: 2,
    },
  };
  const lodBuffers = [
    {
      buffer: compactBuffer,
      depth: 0,
      generationToken,
      isFullDetail: false,
      originalIndexBuffer,
      originalIndexCount: 2,
      pointCount: 2,
      sizeMultiplier: 1.5,
      vao: compactVao,
    },
    {
      buffer: mainBuffer,
      depth: 17,
      generationToken: null,
      isFullDetail: true,
      originalIndexBuffer: null,
      originalIndexCount: 0,
      pointCount: spatialIndex.pointCount,
      sizeMultiplier: 1,
      vao: mainVao,
    },
  ];
  const lodTextures = [
    {
      generationToken,
      height: 1,
      texture: indexTexture,
      width: 2,
    },
    {
      generationToken: null,
      height: 0,
      texture: null,
      width: 0,
    },
  ];
  return {
    handles: new Set([
      compactBuffer,
      compactVao,
      originalIndexBuffer,
      indexTexture,
    ]),
    lodBuffers,
    lodTextures,
    owner,
  };
}

function createViewState(gl, id, borrowedOwner) {
  return {
    id,
    cachedLodDimension: CURRENT_DIMENSION,
    cachedLodLevel: 3,
    cachedLodVisibleIndices: Uint32Array.from([0, 1]),
    cachedVisibleIndices: Uint32Array.from([0, 1]),
    indexBuffer: gl._adoptBuffer(`${id}-view-index-buffer`),
    indexBufferSize: 8,
    preCachedGenerationToken: borrowedOwner.generationToken,
    preCachedIndexBuffer:
      borrowedOwner.topologyOwner.originalIndexBuffer,
    preCachedSpatialOwner: borrowedOwner.spatialIndex,
    usePreCachedIndexBuffer: true,
  };
}

function createFixture({
  pointCount,
  staleCurrentSpatialIndex,
}) {
  const gl = createTrackingGl();
  const renderer = Object.create(HighPerfRenderer.prototype);
  const positions = makePositions(pointCount);
  const colors = makeColors(pointCount);
  const mainBuffer = gl._adoptBuffer('main-interleaved-buffer');
  const mainVao = gl._adoptVertexArray('main-vao');
  const oldBoundingSphere = Object.freeze({
    center: [0, 0, 0],
    radius: 99,
  });

  const spatialIndices = new Map();
  const owners = new Map();
  const lodBuffersByDimension = new Map();
  const lodTexturesByDimension = new Map();
  const oldPublications = new Map();
  for (const dimensionLevel of ALL_DIMENSIONS) {
    const oldPositions =
      dimensionLevel === CURRENT_DIMENSION &&
      staleCurrentSpatialIndex
        ? positions.slice()
        : positions;
    const spatialIndex = createOldSpatialIndex(
      oldPositions,
      dimensionLevel,
      oldBoundingSphere,
    );
    const publication = createOldLodPublication(
      gl,
      dimensionLevel,
      spatialIndex,
      mainVao,
      mainBuffer,
    );
    spatialIndices.set(dimensionLevel, spatialIndex);
    owners.set(dimensionLevel, publication.owner);
    lodBuffersByDimension.set(
      dimensionLevel,
      publication.lodBuffers,
    );
    lodTexturesByDimension.set(
      dimensionLevel,
      publication.lodTextures,
    );
    oldPublications.set(dimensionLevel, {
      ...publication,
      spatialIndex,
    });
  }

  const currentOwner =
    oldPublications.get(CURRENT_DIMENSION).owner;
  const perViewState = new Map([
    ['live', createViewState(gl, 'live', currentOwner)],
    ['snapshot-a', createViewState(gl, 'snapshot-a', currentOwner)],
  ]);

  Object.assign(renderer, {
    gl,
    options: {
      LOD_MAX_DEPTH: 2,
      LOD_MAX_POINTS_PER_NODE: pointCount,
    },
    useAdaptiveLOD: true,
    useFrustumCulling: true,
    forceLODLevel: 3,
    vao: mainVao,
    buffers: {
      alphas: null,
      colors: null,
      interleaved: mainBuffer,
      positions: mainBuffer,
    },
    _alphaTexture: null,
    _alphaTexWidth: 0,
    _alphaTexHeight: 0,
    _alphaTexData: null,
    _useAlphaTexture: false,
    _currentAlphas: null,
    _lodIndexTexturesByDimension: lodTexturesByDimension,
    _lodResourceOwnersByDimension: owners,
    spatialIndices,
    lodBuffersByDimension,
    currentDimensionLevel: CURRENT_DIMENSION,
    _liveGeometryGeneration: 4,
    _nextGeometryGeneration: 5,
    pointCount,
    _positions: positions,
    _colors: colors,
    _firstRenderDone: true,
    _boundingSphere: oldBoundingSphere,
    _bufferDirty: false,
    _dirtyLodDimensions: new Set(ALL_DIMENSIONS),
    _interleavedArrayBuffer: null,
    _interleavedPositionView: null,
    _interleavedColorView: null,
    _lodArrayBuffers: null,
    _perViewState: perViewState,
    _pendingDataRetirements: new Set(),
    _pendingSnapshotRetirements: new Set(),
    _snapshotGeometryPools: new Map(),
    _validatedLodNodeMappings: new WeakMap(),
    _validatedSpatialIndices: new WeakSet(),
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
  gl._observe(
    () => captureDimensionPublication(
      renderer,
      CURRENT_DIMENSION,
    ),
  );

  return {
    gl,
    oldBoundingSphere,
    oldPublications,
    perViewState,
    renderer,
  };
}

function captureExactState(fixture) {
  const { renderer } = fixture;
  return {
    boundingSphere: renderer._boundingSphere,
    dirtyLodDimensions: renderer._dirtyLodDimensions,
    forceLODLevel: renderer.forceLODLevel,
    perViewState: renderer._perViewState,
    dimensions: new Map(
      ALL_DIMENSIONS.map(dimensionLevel => [
        dimensionLevel,
        captureDimensionPublication(renderer, dimensionLevel),
      ]),
    ),
  };
}

function assertExactStatePreserved(fixture, before) {
  const { gl, oldPublications, renderer } = fixture;
  assert.strictEqual(renderer._boundingSphere, before.boundingSphere);
  assert.strictEqual(
    renderer._dirtyLodDimensions,
    before.dirtyLodDimensions,
  );
  assert.equal(renderer.forceLODLevel, before.forceLODLevel);
  assert.strictEqual(renderer._perViewState, before.perViewState);

  for (const dimensionLevel of ALL_DIMENSIONS) {
    const expected = before.dimensions.get(dimensionLevel);
    assert.equal(
      renderer.spatialIndices.get(dimensionLevel) ===
        expected.spatialIndex,
      true,
      `${dimensionLevel}D CPU spatial ownership changed on failure`,
    );
    assert.equal(
      renderer._lodResourceOwnersByDimension.get(dimensionLevel) ===
        expected.owner,
      true,
      `${dimensionLevel}D GPU ownership changed on failure`,
    );
    assert.equal(
      renderer.lodBuffersByDimension.get(dimensionLevel) ===
        expected.lodBuffers,
      true,
      `${dimensionLevel}D LOD metadata changed on failure`,
    );
    assert.equal(
      renderer._lodIndexTexturesByDimension.get(dimensionLevel) ===
        expected.lodTextures,
      true,
      `${dimensionLevel}D LOD texture metadata changed on failure`,
    );
    for (
      const handle of
      oldPublications.get(dimensionLevel).handles
    ) {
      const liveSet = handle.kind === 'buffer'
        ? gl._state.live.buffers
        : handle.kind === 'texture'
          ? gl._state.live.textures
          : gl._state.live.vertexArrays;
      assert.equal(
        liveSet.has(handle),
        true,
        `${handle.id} must remain live after rejected replacement`,
      );
      assert.equal(
        gl._state.events.some(event => event.handle === handle),
        false,
        `${handle.id} must never enter retirement on failure`,
      );
    }
  }
}

function oldRetirementEvents(fixture, dimensions) {
  const handles = new Set();
  for (const dimensionLevel of dimensions) {
    for (
      const handle of
      fixture.oldPublications.get(dimensionLevel).handles
    ) {
      handles.add(handle);
    }
  }
  return fixture.gl._state.events.filter(
    event => handles.has(event.handle),
  );
}

function assertRetiredOnlyAfterCandidate(
  fixture,
  candidateSpatialIndex,
  dimensions,
  { allowUntouched = false } = {},
) {
  for (const dimensionLevel of dimensions) {
    const oldPublication =
      fixture.oldPublications.get(dimensionLevel);
    const events = oldRetirementEvents(
      fixture,
      [dimensionLevel],
    );
    if (allowUntouched && dimensionLevel !== CURRENT_DIMENSION) {
      assert.equal(
        events.length === 0 || events.length === 4,
        true,
        `${dimensionLevel}D must be either retained whole or retired whole`,
      );
      if (events.length === 0) {
        assert.equal(
          fixture.renderer.spatialIndices.get(dimensionLevel) ===
            oldPublication.spatialIndex,
          true,
        );
        assert.equal(
          fixture.renderer
            ._lodResourceOwnersByDimension
            .get(dimensionLevel) === oldPublication.owner,
          true,
        );
        assert.equal(
          fixture.renderer.lodBuffersByDimension.get(
            dimensionLevel,
          ) === oldPublication.lodBuffers,
          true,
        );
        assert.equal(
          fixture.renderer
            ._lodIndexTexturesByDimension
            .get(dimensionLevel) === oldPublication.lodTextures,
          true,
        );
        continue;
      }
    } else {
      assert.equal(
        events.length,
        4,
        'every detached old generation handle retires exactly once',
      );
    }

    for (const event of events) {
      assert.equal(
        event.publication.spatialIndex === candidateSpatialIndex,
        true,
        `${event.handle.id} retired before the candidate CPU owner was authoritative`,
      );
      assert.equal(
        event.publication.owner?.spatialIndex ===
          candidateSpatialIndex,
        true,
        `${event.handle.id} retired before the candidate GPU owner was authoritative`,
      );
      assert.notStrictEqual(
        event.publication.lodBuffers,
        fixture.oldPublications.get(CURRENT_DIMENSION).lodBuffers,
      );
      assert.notStrictEqual(
        event.publication.lodTextures,
        fixture.oldPublications.get(CURRENT_DIMENSION).lodTextures,
      );
    }
  }
}

test('failed stale getSpatialIndex replacement preserves every exact publication surface', t => {
  replaceCalculationNotifications(t);
  const fixture = createFixture({
    pointCount: 64,
    staleCurrentSpatialIndex: true,
  });
  const before = captureExactState(fixture);
  fixture.gl._failNextBufferAllocation();

  assert.throws(
    () => fixture.renderer.getSpatialIndexForDimension(
      CURRENT_DIMENSION,
    ),
    /could not allocate.*compact LOD point buffer/i,
  );

  assertExactStatePreserved(fixture, before);
  assert.equal(fixture.renderer._pendingDataRetirements.size, 0);
});

test('successful stale getSpatialIndex replacement publishes CPU and GPU candidates before retirement', t => {
  replaceCalculationNotifications(t);
  const fixture = createFixture({
    pointCount: 64,
    staleCurrentSpatialIndex: true,
  });
  const untouchedDimensions = new Map(
    [1, 3].map(dimensionLevel => [
      dimensionLevel,
      captureDimensionPublication(
        fixture.renderer,
        dimensionLevel,
      ),
    ]),
  );

  const candidate =
    fixture.renderer.getSpatialIndexForDimension(CURRENT_DIMENSION);

  assert.equal(
    fixture.renderer.spatialIndices.get(CURRENT_DIMENSION) ===
      candidate,
    true,
  );
  assert.equal(
    fixture.renderer
      ._lodResourceOwnersByDimension
      .get(CURRENT_DIMENSION)
      .spatialIndex === candidate,
    true,
  );
  assertRetiredOnlyAfterCandidate(
    fixture,
    candidate,
    [CURRENT_DIMENSION],
  );
  for (const dimensionLevel of [1, 3]) {
    const expected = untouchedDimensions.get(dimensionLevel);
    assert.strictEqual(
      fixture.renderer.spatialIndices.get(dimensionLevel),
      expected.spatialIndex,
    );
    assert.strictEqual(
      fixture.renderer
        ._lodResourceOwnersByDimension
        .get(dimensionLevel),
      expected.owner,
    );
    assert.strictEqual(
      fixture.renderer.lodBuffersByDimension.get(dimensionLevel),
      expected.lodBuffers,
    );
    assert.strictEqual(
      fixture.renderer
        ._lodIndexTexturesByDimension
        .get(dimensionLevel),
      expected.lodTextures,
    );
  }
});

test('failed rebuildSpatialIndex preserves CPU/GPU generations, bounds, views, and forceLOD', t => {
  replaceCalculationNotifications(t);
  const fixture = createFixture({
    pointCount: 10_001,
    staleCurrentSpatialIndex: false,
  });
  const before = captureExactState(fixture);
  fixture.gl._failNextBufferAllocation();

  assert.throws(
    () => fixture.renderer.rebuildSpatialIndex(),
    /could not allocate.*compact LOD point buffer/i,
  );

  assertExactStatePreserved(fixture, before);
  assert.equal(fixture.renderer._pendingDataRetirements.size, 0);
});

test('successful rebuildSpatialIndex commits a complete candidate before retiring any old dimension', t => {
  replaceCalculationNotifications(t);
  const fixture = createFixture({
    pointCount: 10_001,
    staleCurrentSpatialIndex: false,
  });

  fixture.renderer.rebuildSpatialIndex();

  const candidate =
    fixture.renderer.spatialIndices.get(CURRENT_DIMENSION);
  assert.ok(candidate);
  assert.equal(
    candidate !==
      fixture.oldPublications.get(CURRENT_DIMENSION).spatialIndex,
    true,
  );
  assert.equal(
    fixture.renderer
      ._lodResourceOwnersByDimension
      .get(CURRENT_DIMENSION)
      .spatialIndex === candidate,
    true,
  );
  assertRetiredOnlyAfterCandidate(
    fixture,
    candidate,
    ALL_DIMENSIONS,
    { allowUntouched: true },
  );
  assert.notStrictEqual(
    fixture.renderer._boundingSphere,
    fixture.oldBoundingSphere,
  );
  assert.equal(fixture.renderer.forceLODLevel, -1);
  assert.equal(fixture.renderer._perViewState.size, 0);
  assert.equal(fixture.renderer._pendingDataRetirements.size, 0);
});
