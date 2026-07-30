import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';

function createVaoAwareGl() {
  let currentVao = null;
  let defaultElementBuffer = null;
  let activeTextureUnit = 0x84c0;
  const vaoElementBuffers = new Map();
  const liveBuffers = new Set();
  const liveTextures = new Set();
  const textureBindings = new Map();
  const deletedBuffers = new Set();
  const zombieBuffers = new Set();
  const events = [];
  const draws = [];
  const cleanupErrors = new Map();
  let nextDrawError = null;
  const throwCleanupError = kind => {
    const error = cleanupErrors.get(kind);
    if (error === undefined) return;
    cleanupErrors.delete(kind);
    throw error;
  };

  const elementBufferForCurrentVao = () => (
    currentVao === null
      ? defaultElementBuffer
      : vaoElementBuffers.get(currentVao) ?? null
  );
  const isVaoReference = buffer => {
    for (const attached of vaoElementBuffers.values()) {
      if (attached === buffer) return true;
    }
    return false;
  };
  const settleDetachedZombie = buffer => {
    if (
      buffer !== null &&
      zombieBuffers.has(buffer) &&
      !isVaoReference(buffer) &&
      defaultElementBuffer !== buffer
    ) {
      zombieBuffers.delete(buffer);
      liveBuffers.delete(buffer);
    }
  };

  const gl = {
    ELEMENT_ARRAY_BUFFER: 0x8893,
    POINTS: 0,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE_2D: 0x0de1,
    UNSIGNED_INT: 0x1405,

    activeTexture(textureUnit) {
      assert.ok(
        textureUnit === this.TEXTURE0 ||
          textureUnit === this.TEXTURE1,
      );
      activeTextureUnit = textureUnit;
    },
    bindTexture(target, texture) {
      assert.equal(target, this.TEXTURE_2D);
      assert.ok(
        texture === null || liveTextures.has(texture),
        'renderer must bind an adopted texture handle',
      );
      textureBindings.set(activeTextureUnit, texture);
      if (texture === null) {
        throwCleanupError(
          activeTextureUnit === this.TEXTURE1
            ? 'texture1'
            : 'texture0',
        );
      }
    },
    bindVertexArray(vao) {
      events.push({ kind: 'bindVertexArray', vao });
      currentVao = vao;
      if (vao === null) throwCleanupError('vertex-array');
    },
    bindBuffer(target, buffer) {
      assert.equal(target, this.ELEMENT_ARRAY_BUFFER);
      const previous = elementBufferForCurrentVao();
      events.push({
        buffer,
        kind: 'bindElementBuffer',
        vao: currentVao,
      });
      if (currentVao === null) {
        defaultElementBuffer = buffer;
      } else {
        vaoElementBuffers.set(currentVao, buffer);
      }
      if (previous !== buffer) settleDetachedZombie(previous);
      if (buffer === null) throwCleanupError('element-buffer');
    },
    deleteBuffer(buffer) {
      deletedBuffers.add(buffer);
      if (
        isVaoReference(buffer) ||
        defaultElementBuffer === buffer
      ) {
        zombieBuffers.add(buffer);
      } else {
        liveBuffers.delete(buffer);
      }
    },
    drawElements(mode, count, type, offset) {
      const buffer = elementBufferForCurrentVao();
      const draw = {
        buffer,
        count,
        deleted: deletedBuffers.has(buffer),
        kind: 'drawElements',
        mode,
        offset,
        type,
        vao: currentVao,
      };
      events.push(draw);
      draws.push(draw);
      if (nextDrawError !== null) {
        const error = nextDrawError;
        nextDrawError = null;
        throw error;
      }
    },
    drawArrays(mode, first, count) {
      const draw = {
        count,
        first,
        kind: 'drawArrays',
        mode,
        vao: currentVao,
      };
      events.push(draw);
      draws.push(draw);
      if (nextDrawError !== null) {
        const error = nextDrawError;
        nextDrawError = null;
        throw error;
      }
    },
    useProgram() {},

    _adoptBuffer(id) {
      const buffer = Object.freeze({ id, kind: 'buffer' });
      liveBuffers.add(buffer);
      return buffer;
    },
    _adoptVao(id) {
      return Object.freeze({ id, kind: 'vao' });
    },
    _adoptTexture(id) {
      const texture = Object.freeze({ id, kind: 'texture' });
      liveTextures.add(texture);
      return texture;
    },
    _state: {
      deletedBuffers,
      draws,
      events,
      liveBuffers,
      liveTextures,
      textureBindings,
      vaoElementBuffers,
      zombieBuffers,
      get activeTextureUnit() {
        return activeTextureUnit;
      },
      get currentVao() {
        return currentVao;
      },
      failNextDraw(error) {
        nextDrawError = error;
      },
      failNextCleanup(kind, error) {
        assert.ok(
          kind === 'element-buffer' ||
            kind === 'vertex-array' ||
            kind === 'texture1' ||
            kind === 'texture0',
        );
        cleanupErrors.set(kind, error);
      },
    },
  };
  return gl;
}

function makeParams(viewId = 'view') {
  return {
    dimensionLevel: 2,
    fogColor: [0, 0, 0],
    fogDensity: 0,
    fov: 1,
    lightDir: [0, 0, 1],
    lightingStrength: 0,
    modelMatrix: new Float32Array(16),
    mvpMatrix: new Float32Array(16),
    pointSize: 1,
    projectionMatrix: new Float32Array(16),
    sizeAttenuation: 0,
    viewId,
    viewMatrix: new Float32Array(16),
    viewportHeight: 100,
  };
}

function makeUniforms() {
  return {
    u_alphaTex: null,
    u_alphaTexWidth: null,
    u_fogColor: null,
    u_fogDensity: null,
    u_fogFar: null,
    u_fogNear: null,
    u_fov: null,
    u_invAlphaTexWidth: null,
    u_invLodIndexTexWidth: null,
    u_lightDir: null,
    u_lightingStrength: null,
    u_lodIndexTex: null,
    u_lodIndexTexWidth: null,
    u_modelMatrix: null,
    u_mvpMatrix: null,
    u_pointSize: null,
    u_projectionMatrix: null,
    u_sizeAttenuation: null,
    u_useAlphaTex: null,
    u_useLodIndexTex: null,
    u_viewMatrix: null,
    u_viewportHeight: null,
  };
}

function makeRenderer(gl) {
  const program = Object.freeze({ id: 'program' });
  return Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      gl,
      activeProgram: program,
      activeQuality: 'full',
      uniformLocations: new Map([['full', makeUniforms()]]),
      stats: { cullPercent: 0, frustumCulled: false },
      spatialIndices: new Map(),
      _dummyLodIndexTexture: gl._adoptTexture('dummy'),
      _validatedLodNodeMappings: new WeakMap(),
      _validatedSpatialIndices: new WeakSet(),
      _updateStats() {},
      _bindAlphaTexture() {},
      _checkFrustumCacheValid() {
        return false;
      },
    },
  );
}

function makeSnapshot(gl, vao, id = 'snapshot') {
  return {
    alphaTexData: Uint8Array.of(255),
    alphaTexHeight: 1,
    alphaTexWidth: 1,
    alphaTexture: gl._adoptTexture(`${id}-alpha`),
    alphaTextureByteLength: 1,
    id,
    pointCount: 1,
    vao,
  };
}

function makeViewState(indexBuffer) {
  return {
    cachedCulledCount: 1,
    cachedLodDimension: 2,
    cachedLodIsCulled: true,
    cachedLodLevel: 0,
    cachedLodVisibleIndices: Uint32Array.of(0),
    cachedVisibleIndices: Uint32Array.of(0),
    indexBuffer,
    indexBufferSize: 1,
    lastVisibleCount: 1,
    stats: {
      lastFrameTime: 0,
      fps: 0,
      visiblePoints: 0,
      lodLevel: -1,
      drawCalls: 0,
      frustumCulled: false,
      cullPercent: 0,
    },
    statsPublished: false,
    usePreCachedIndexBuffer: false,
    preCachedIndexBuffer: null,
  };
}

function assertDrawDetached(gl, expectedVao, expectedBuffer) {
  const { draws, events, vaoElementBuffers } = gl._state;
  const draw = draws.at(-1);
  assert.equal(draw.vao, expectedVao);
  assert.equal(draw.buffer, expectedBuffer);
  assert.equal(draw.deleted, false);

  const drawEventIndex = events.lastIndexOf(draw);
  const detachIndex = events.findIndex(
    (event, index) => (
      index > drawEventIndex &&
      event.kind === 'bindElementBuffer' &&
      event.vao === expectedVao &&
      event.buffer === null
    ),
  );
  const vaoReleaseIndex = events.findIndex(
    (event, index) => (
      index > drawEventIndex &&
      event.kind === 'bindVertexArray' &&
      event.vao === null
    ),
  );
  assert.ok(
    detachIndex > drawEventIndex,
    'draw path must clear its VAO-local element buffer after drawing',
  );
  assert.ok(
    vaoReleaseIndex > detachIndex,
    'element buffer must be cleared while the draw VAO remains bound',
  );
  assert.equal(vaoElementBuffers.get(expectedVao) ?? null, null);
}

test('all five indexed renderer paths detach their VAO-local EBO before releasing the VAO', async t => {
  const cases = [
    {
      name: 'live full-detail plus frustum',
      run(renderer, gl, vao, ebo) {
        renderer.vao = vao;
        renderer.pointCount = 1;
        const spatialIndex = {
          root: {},
          validatePointCount() {
            return { valid: true };
          },
        };
        const viewState = makeViewState(ebo);
        viewState.cachedLodLevel = -1;
        viewState.cachedLodIsCulled = false;
        viewState.cachedLodMappingGeneration = null;
        viewState.cachedVisibleNodes = [spatialIndex.root];
        viewState.cachedVisibleSpatialOwner = spatialIndex;
        viewState.cachedVisibleSpatialRoot = spatialIndex.root;
        renderer._renderWithFrustumCulling(
          makeParams('live'),
          [],
          viewState,
          spatialIndex,
        );
      },
    },
    {
      name: 'live reduced LOD plus frustum',
      run(renderer, gl, vao, ebo) {
        const lod = {
          isFullDetail: false,
          pointCount: 1,
          sizeMultiplier: 1,
          vao,
        };
        const generationToken = Object.freeze({});
        const spatialIndex = {
          _lodNodeMapping: { generationToken },
          _validateLodNodeMapping() {
            return generationToken;
          },
          countLodMappedIndices() {
            return 1;
          },
          writeLodMappedIndices(_visibleNodes, _lodLevel, target) {
            target[0] = 0;
            return 1;
          },
          root: {
            indices: Uint32Array.of(0),
          },
        };
        const viewState = makeViewState(ebo);
        viewState.cachedVisibleNodes = [spatialIndex.root];
        viewState.cachedVisibleSpatialOwner = spatialIndex;
        viewState.cachedVisibleSpatialRoot = spatialIndex.root;
        viewState.cachedLodMappingGeneration =
          generationToken;
        renderer._renderLODWithFrustumCulling(
          0,
          makeParams('live'),
          [],
          viewState,
          spatialIndex,
          [lod],
        );
      },
    },
    {
      name: 'snapshot full-detail plus frustum',
      run(renderer, gl, vao, ebo) {
        const spatialIndex = { root: {} };
        const viewState = makeViewState(ebo);
        viewState.cachedLodLevel = -1;
        viewState.cachedLodIsCulled = false;
        viewState.cachedLodMappingGeneration = null;
        viewState.cachedVisibleNodes = [spatialIndex.root];
        viewState.cachedVisibleSpatialOwner = spatialIndex;
        viewState.cachedVisibleSpatialRoot = spatialIndex.root;
        renderer._renderSnapshotWithFrustumCulling(
          makeSnapshot(gl, vao, 'snapshot-full-frustum'),
          makeParams('snapshot-full-frustum'),
          [],
          viewState,
          1,
          false,
          spatialIndex,
        );
      },
    },
    {
      name: 'snapshot reduced LOD with borrowed EBO',
      run(renderer, gl, vao, ebo) {
        const indices = Uint32Array.of(0);
        const spatialIndex = {
          lodLevels: [{
            indices,
            isFullDetail: false,
            sizeMultiplier: 1,
          }],
        };
        renderer.spatialIndices.set(2, spatialIndex);
        const viewState = makeViewState(gl._adoptBuffer('unused-view-ebo'));
        viewState.cachedLodIsCulled = false;
        viewState.usePreCachedIndexBuffer = true;
        viewState.preCachedIndexBuffer = ebo;
        renderer._renderSnapshotWithLOD(
          makeSnapshot(gl, vao, 'snapshot-lod'),
          0,
          makeParams('snapshot-lod'),
          viewState,
          false,
          spatialIndex,
          [{
            originalIndexBuffer: ebo,
            originalIndexCount: 1,
          }],
        );
      },
    },
    {
      name: 'snapshot reduced LOD plus frustum',
      run(renderer, gl, vao, ebo) {
        const indices = Uint32Array.of(0);
        const generationToken = Object.freeze({});
        const root = {
          bounds: {
            minX: 0,
            maxX: 0,
            minY: 0,
            maxY: 0,
            minZ: 0,
            maxZ: 0,
          },
          indices,
        };
        const spatialIndex = {
          root,
          lodLevels: [
            {
              indices,
              isFullDetail: false,
              pointCount: 1,
              sizeMultiplier: 1,
            },
            {
              isFullDetail: true,
              pointCount: 1,
            },
          ],
          _lodNodeMapping: {
            generationToken,
            maximumIndices: indices,
          },
          ensureLodNodeMappings() {},
          _validateLodNodeMapping() {
            return generationToken;
          },
        };
        const viewState = makeViewState(ebo);
        viewState.cachedVisibleNodes = [root];
        viewState.cachedVisibleSpatialOwner = spatialIndex;
        viewState.cachedVisibleSpatialRoot = root;
        viewState.cachedLodMappingGeneration = generationToken;
        renderer._renderSnapshotLODWithFrustumCulling(
          makeSnapshot(gl, vao, 'snapshot-lod-frustum'),
          0,
          makeParams('snapshot-lod-frustum'),
          [],
          viewState,
          false,
          spatialIndex,
          [],
          false,
        );
      },
    },
  ];

  for (const renderCase of cases) {
    await t.test(renderCase.name, () => {
      const gl = createVaoAwareGl();
      const renderer = makeRenderer(gl);
      const vao = gl._adoptVao(`${renderCase.name}-vao`);
      const ebo = gl._adoptBuffer(`${renderCase.name}-ebo`);

      renderCase.run(renderer, gl, vao, ebo);

      assertDrawDetached(gl, vao, ebo);

      const alphaTexture =
        gl._adoptTexture(`${renderCase.name}-live-alpha`);
      const lodTexture =
        gl._adoptTexture(`${renderCase.name}-live-lod-index`);
      renderer._bindAlphaTexture = exactGl => {
        exactGl.activeTexture(exactGl.TEXTURE0);
        exactGl.bindTexture(exactGl.TEXTURE_2D, alphaTexture);
        exactGl.activeTexture(exactGl.TEXTURE1);
        exactGl.bindTexture(exactGl.TEXTURE_2D, lodTexture);
      };
      const drawFailure =
        new Error(`${renderCase.name} synthetic draw failure`);
      gl._state.failNextDraw(drawFailure);
      assert.throws(
        () => renderCase.run(renderer, gl, vao, ebo),
        error => error === drawFailure,
      );
      assert.equal(gl._state.currentVao, null);
      assert.equal(
        gl._state.vaoElementBuffers.get(vao) ?? null,
        null,
      );
      assert.equal(
        gl._state.textureBindings.get(gl.TEXTURE0) ?? null,
        null,
      );
      assert.equal(
        gl._state.textureBindings.get(gl.TEXTURE1) ?? null,
        null,
      );
      assert.equal(gl._state.activeTextureUnit, gl.TEXTURE0);
    });
  }
});

test('failed indexed draws preserve the primary error while completing every later baseline cleanup', async t => {
  const cases = [
    {
      name: 'live full-detail frustum',
      run(renderer, gl, vao, ebo) {
        renderer.vao = vao;
        renderer.pointCount = 1;
        const spatialIndex = {
          root: {},
          validatePointCount() {
            return { valid: true };
          },
        };
        const viewState = makeViewState(ebo);
        viewState.cachedLodLevel = -1;
        viewState.cachedLodIsCulled = false;
        viewState.cachedLodMappingGeneration = null;
        viewState.cachedVisibleNodes = [spatialIndex.root];
        viewState.cachedVisibleSpatialOwner = spatialIndex;
        viewState.cachedVisibleSpatialRoot = spatialIndex.root;
        renderer._renderWithFrustumCulling(
          makeParams('live'),
          [],
          viewState,
          spatialIndex,
        );
      },
    },
    {
      name: 'snapshot full-detail frustum',
      run(renderer, gl, vao, ebo) {
        const spatialIndex = { root: {} };
        const viewState = makeViewState(ebo);
        viewState.cachedLodLevel = -1;
        viewState.cachedLodIsCulled = false;
        viewState.cachedLodMappingGeneration = null;
        viewState.cachedVisibleNodes = [spatialIndex.root];
        viewState.cachedVisibleSpatialOwner = spatialIndex;
        viewState.cachedVisibleSpatialRoot = spatialIndex.root;
        renderer._renderSnapshotWithFrustumCulling(
          makeSnapshot(gl, vao, 'cleanup-failure-snapshot'),
          makeParams('cleanup-failure-snapshot'),
          [],
          viewState,
          1,
          false,
          spatialIndex,
        );
      },
    },
  ];

  for (const renderCase of cases) {
    await t.test(renderCase.name, () => {
      const gl = createVaoAwareGl();
      const renderer = makeRenderer(gl);
      const vao = gl._adoptVao(`${renderCase.name}-vao`);
      const ebo = gl._adoptBuffer(`${renderCase.name}-ebo`);
      const alphaTexture =
        gl._adoptTexture(`${renderCase.name}-live-alpha`);
      const lodTexture =
        gl._adoptTexture(`${renderCase.name}-live-lod-index`);
      renderer._bindAlphaTexture = exactGl => {
        exactGl.activeTexture(exactGl.TEXTURE0);
        exactGl.bindTexture(exactGl.TEXTURE_2D, alphaTexture);
        exactGl.activeTexture(exactGl.TEXTURE1);
        exactGl.bindTexture(exactGl.TEXTURE_2D, lodTexture);
      };
      const primary =
        new Error(`${renderCase.name} primary draw failure`);
      const cleanup =
        new Error(`${renderCase.name} EBO cleanup failure`);
      gl._state.failNextDraw(primary);
      gl._state.failNextCleanup('element-buffer', cleanup);

      assert.throws(
        () => renderCase.run(renderer, gl, vao, ebo),
        error => (
          error instanceof AggregateError &&
          error.errors[0] === primary &&
          error.errors[1] === cleanup
        ),
      );
      assert.equal(gl._state.currentVao, null);
      assert.equal(
        gl._state.vaoElementBuffers.get(vao) ?? null,
        null,
      );
      assert.equal(
        gl._state.textureBindings.get(gl.TEXTURE0) ?? null,
        null,
      );
      assert.equal(
        gl._state.textureBindings.get(gl.TEXTURE1) ?? null,
        null,
      );
      assert.equal(gl._state.activeTextureUnit, gl.TEXTURE0);
    });
  }
});

test('direct live full-detail and LOD draw failures restore VAO and both texture units', async t => {
  const cases = [
    {
      name: 'full detail',
      run(renderer, params, viewState, vao) {
        renderer.vao = vao;
        renderer.pointCount = 1;
        renderer._renderFullDetail(params, viewState);
      },
    },
    {
      name: 'reduced LOD',
      run(renderer, params, viewState, vao) {
        renderer.lodBuffersByDimension = new Map([
          [2, [{
            isFullDetail: false,
            pointCount: 1,
            sizeMultiplier: 1,
            vao,
          }]],
        ]);
        renderer._renderLOD(0, params, viewState);
      },
    },
  ];

  for (const renderCase of cases) {
    await t.test(renderCase.name, () => {
      const gl = createVaoAwareGl();
      const renderer = makeRenderer(gl);
      const vao = gl._adoptVao(`${renderCase.name}-vao`);
      const alphaTexture =
        gl._adoptTexture(`${renderCase.name}-alpha`);
      const lodTexture =
        gl._adoptTexture(`${renderCase.name}-lod-index`);
      renderer._bindAlphaTexture = exactGl => {
        exactGl.activeTexture(exactGl.TEXTURE0);
        exactGl.bindTexture(exactGl.TEXTURE_2D, alphaTexture);
        exactGl.activeTexture(exactGl.TEXTURE1);
        exactGl.bindTexture(exactGl.TEXTURE_2D, lodTexture);
      };
      const drawFailure =
        new Error(`${renderCase.name} synthetic draw failure`);
      gl._state.failNextDraw(drawFailure);

      assert.throws(
        () => renderCase.run(
          renderer,
          makeParams('live'),
          makeViewState(gl._adoptBuffer(`${renderCase.name}-unused`)),
          vao,
        ),
        error => error === drawFailure,
      );
      assert.equal(gl._state.currentVao, null);
      assert.equal(
        gl._state.textureBindings.get(gl.TEXTURE0) ?? null,
        null,
      );
      assert.equal(
        gl._state.textureBindings.get(gl.TEXTURE1) ?? null,
        null,
      );
      assert.equal(gl._state.activeTextureUnit, gl.TEXTURE0);
    });
  }
});

test('live full-detail frustum rendering rejects unavailable shader state instead of publishing a blank frame', () => {
  const gl = createVaoAwareGl();
  const renderer = makeRenderer(gl);
  const vao = gl._adoptVao('missing-frustum-program-vao');
  const ebo = gl._adoptBuffer('missing-frustum-program-ebo');
  const spatialIndex = {
    root: {},
    validatePointCount() {
      return { valid: true };
    },
  };
  const viewState = makeViewState(ebo);
  viewState.cachedLodLevel = -1;
  viewState.cachedLodIsCulled = false;
  viewState.cachedLodMappingGeneration = null;
  viewState.cachedVisibleNodes = [spatialIndex.root];
  viewState.cachedVisibleSpatialOwner = spatialIndex;
  viewState.cachedVisibleSpatialRoot = spatialIndex.root;
  renderer.vao = vao;
  renderer.pointCount = 1;
  renderer.activeProgram = null;

  assert.throws(
    () => renderer._renderWithFrustumCulling(
      makeParams('live'),
      [],
      viewState,
      spatialIndex,
    ),
    /full-detail\/frustum shader state is unavailable/,
  );
  assert.equal(gl._state.draws.length, 0);
});

test('snapshot borrowed-EBO replacement neither leaves a zombie nor uploads per-view indices', () => {
  const gl = createVaoAwareGl();
  const renderer = makeRenderer(gl);
  const snapshotVao = gl._adoptVao('snapshot-vao');
  const perViewEbo = gl._adoptBuffer('per-view-ebo');
  const oldBorrowedEbo = gl._adoptBuffer('old-borrowed-ebo');
  const nextBorrowedEbo = gl._adoptBuffer('next-borrowed-ebo');
  const indices = Uint32Array.of(0);
  const spatialIndex = {
    lodLevels: [{
      indices,
      isFullDetail: false,
      sizeMultiplier: 1,
    }],
  };
  renderer.spatialIndices.set(2, spatialIndex);
  const snapshot = makeSnapshot(gl, snapshotVao);

  let perViewUploads = 0;
  renderer._uploadToViewIndexBuffer = () => {
    perViewUploads += 1;
  };
  const viewState = makeViewState(perViewEbo);
  viewState.cachedLodLevel = -1;
  viewState.cachedLodDimension = -1;
  viewState.cachedLodIsCulled = false;

  const oldLevels = [{
    originalIndexBuffer: oldBorrowedEbo,
    originalIndexCount: 1,
  }];
  renderer._renderSnapshotWithLOD(
    snapshot,
    0,
    makeParams('snapshot'),
    viewState,
    false,
    spatialIndex,
    oldLevels,
  );

  assert.equal(perViewUploads, 0);
  const firstDraw = gl._state.draws.at(-1);
  assert.equal(firstDraw.buffer, oldBorrowedEbo);

  // Replacing the topology deletes its old borrowed EBO. If the draw path
  // failed to detach it from the snapshot VAO, WebGL must retain zombie
  // storage even though the handle has been deleted.
  gl.deleteBuffer(oldBorrowedEbo);
  const becameZombieAtReplacement =
    gl._state.zombieBuffers.has(oldBorrowedEbo);

  const nextLevels = [{
    originalIndexBuffer: nextBorrowedEbo,
    originalIndexCount: 1,
  }];
  renderer._renderSnapshotWithLOD(
    snapshot,
    0,
    makeParams('snapshot'),
    viewState,
    false,
    spatialIndex,
    nextLevels,
  );

  assert.equal(
    becameZombieAtReplacement,
    false,
    'the retired borrowed EBO must not remain referenced by the snapshot VAO',
  );
  assert.equal(
    perViewUploads,
    0,
    'switching between borrowed topology EBOs must not upload per-view indices',
  );
  const secondDraw = gl._state.draws.at(-1);
  assert.equal(secondDraw.buffer, nextBorrowedEbo);
  assert.equal(secondDraw.deleted, false);
  assertDrawDetached(gl, snapshotVao, nextBorrowedEbo);
});
