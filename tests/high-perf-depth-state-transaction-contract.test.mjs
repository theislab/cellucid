import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';

function identityMatrix() {
  const matrix = new Float32Array(16);
  matrix[0] = 1;
  matrix[5] = 1;
  matrix[10] = 1;
  matrix[15] = 1;
  return matrix;
}

function makeParams(
  viewId,
  dimensionLevel,
  lod,
) {
  return {
    autoFog: false,
    cameraDistance: 3,
    cameraPosition: Float32Array.of(0, 0, 3),
    dimensionLevel,
    fogColor: new Float32Array(3),
    fogDensity: 0,
    forceLOD: lod ? 0 : -1,
    fov: 1,
    lightDir: Float32Array.of(0, 0, 1),
    lightingStrength: 0,
    modelMatrix: identityMatrix(),
    mvpMatrix: identityMatrix(),
    overrideBounds: null,
    pointSize: 1,
    projectionMatrix: identityMatrix(),
    quality: 'full',
    sizeAttenuation: 1,
    useAlphaTexture: false,
    viewId,
    viewMatrix: identityMatrix(),
    viewportHeight: 480,
    viewportWidth: 640,
  };
}

function makeDepthGl() {
  let depthEnabled = true;
  const events = [];
  const blendPublications = {
    enable: 0,
    equation: 0,
    function: 0,
  };
  return {
    BLEND: 0x0be2,
    DEPTH_TEST: 0x0b71,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    FUNC_ADD: 0x8006,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    SRC_ALPHA: 0x0302,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE_2D: 0x0de1,
    activeTexture(textureUnit) {
      assert.ok(
        textureUnit === this.TEXTURE0 ||
        textureUnit === this.TEXTURE1,
      );
    },
    bindBuffer(target, handle) {
      assert.equal(target, this.ELEMENT_ARRAY_BUFFER);
      assert.equal(handle, null);
    },
    bindTexture(target, handle) {
      assert.equal(target, this.TEXTURE_2D);
      assert.equal(handle, null);
    },
    bindVertexArray(handle) {
      assert.equal(handle, null);
    },
    blendEquation(equation) {
      assert.equal(equation, this.FUNC_ADD);
      blendPublications.equation++;
    },
    blendFuncSeparate(sourceRgb, destinationRgb, sourceAlpha, destinationAlpha) {
      assert.equal(sourceRgb, this.SRC_ALPHA);
      assert.equal(destinationRgb, this.ONE_MINUS_SRC_ALPHA);
      assert.equal(sourceAlpha, this.ONE);
      assert.equal(destinationAlpha, this.ONE_MINUS_SRC_ALPHA);
      blendPublications.function++;
    },
    disable(capability) {
      assert.equal(capability, this.DEPTH_TEST);
      depthEnabled = false;
      events.push('disable');
    },
    enable(capability) {
      if (capability === this.BLEND) {
        blendPublications.enable++;
        return;
      }
      assert.equal(capability, this.DEPTH_TEST);
      depthEnabled = true;
      events.push('enable');
    },
    get depthEnabled() {
      return depthEnabled;
    },
    blendPublications,
    events,
    useProgram() {
      throw new Error('synthetic point render failure');
    },
  };
}

function makeViewState() {
  return {
    frustumPlanes: Array.from(
      { length: 6 },
      () => new Float32Array(4),
    ),
    frustumPlaneScratch: Array.from(
      { length: 6 },
      () => new Float32Array(4),
    ),
    lastFrustumBounds: null,
    lastFrustumMVP: null,
    lastDimensionLevel: undefined,
    lastLodLevel: -1,
    prevLodLevel: undefined,
    stats: {},
  };
}

function makeRenderer({
  dimensionLevel,
  frustum,
  lod,
  snapshot,
}) {
  const gl = makeDepthGl();
  const viewId = snapshot ? 'snapshot' : 'live';
  const viewState = makeViewState();
  const dummyLodIndexTexture = Object.freeze({
    id: 'dummy-lod-index-texture',
  });
  const spatialIndex = {
    dimensionLevel,
    ensureLodNodeMappings() {},
    lodLevels: [{
      indices: Uint32Array.of(0),
      isFullDetail: false,
      pointCount: 1,
      sizeMultiplier: 1,
    }],
  };
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _bufferDirty: false,
      _dirtyLodDimensions: new Set(),
      _dummyLodIndexTexture: dummyLodIndexTexture,
      _firstRenderDone: true,
      _lodIndexTexturesByDimension: new Map(),
      _lodResourceOwnersByDimension: new Map(),
      activeProgram: {},
      activeQuality: 'full',
      buffers: {
        interleaved: {},
      },
      forceLODLevel: -1,
      gl,
      lodBuffersByDimension: new Map([
        [dimensionLevel, spatialIndex.lodLevels],
      ]),
      pointCount: 1,
      snapshotBuffers: new Map(),
      spatialIndices: new Map([
        [dimensionLevel, spatialIndex],
      ]),
      stats: {},
      uniformLocations: new Map([
        ['full', {}],
      ]),
      useAdaptiveLOD: false,
      useFrustumCulling: frustum,
      _ensureLodResourcesForDimension() {},
      _getLodBuffersForDimension() {
        return spatialIndex.lodLevels;
      },
      _getOrBuildSpatialIndexForDimension() {
        return spatialIndex;
      },
      _getViewState() {
        return viewState;
      },
      _renderFullDetail() {
        throw new Error('synthetic point render failure');
      },
      _renderLOD() {
        throw new Error('synthetic point render failure');
      },
      _renderLODWithFrustumCulling() {
        throw new Error('synthetic point render failure');
      },
      _renderSnapshotWithFrustumCulling() {
        throw new Error('synthetic point render failure');
      },
      _renderSnapshotWithLOD() {
        throw new Error('synthetic point render failure');
      },
      _renderSnapshotLODWithFrustumCulling() {
        throw new Error('synthetic point render failure');
      },
      _renderWithFrustumCulling() {
        throw new Error('synthetic point render failure');
      },
      _snapshotUsesLiveGeometry() {
        return true;
      },
      extractFrustumPlanes() {
        return [];
      },
    },
  );
  if (snapshot) {
    const alphaTexData = Uint8Array.of(255);
    renderer.snapshotBuffers.set(viewId, {
      alphaTexData,
      alphaTexHeight: 1,
      alphaTexWidth: 1,
      alphaTexture: Object.freeze({
        id: 'snapshot-alpha-texture',
      }),
      alphaTextureByteLength: alphaTexData.byteLength,
      dimensionLevel,
      geometryGeneration: 1,
      id: viewId,
      pointCount: 1,
      vao: {},
    });
    renderer._liveGeometryGeneration = 1;
  }
  return {
    gl,
    params: makeParams(
      viewId,
      dimensionLevel,
      lod,
    ),
    renderer,
    viewId,
  };
}

for (const snapshot of [false, true]) {
  for (const dimensionLevel of [1, 2]) {
    for (const frustum of [false, true]) {
      for (const lod of [false, true]) {
        const owner = snapshot ? 'snapshot' : 'live';
        const path = [
          owner,
          `${dimensionLevel}D`,
          lod ? 'LOD' : 'full',
          frustum ? 'frustum' : 'direct',
        ].join(' ');
        test(`${path} failure restores renderer-owned depth state`, () => {
          const {
            gl,
            params,
            renderer,
            viewId,
          } = makeRenderer({
            dimensionLevel,
            frustum,
            lod,
            snapshot,
          });

          assert.throws(
            () => {
              if (snapshot) {
                renderer.renderWithSnapshot(
                  viewId,
                  params,
                );
              } else {
                renderer.render(params);
              }
            },
            /synthetic point render failure/,
          );
          assert.equal(gl.depthEnabled, true);
          assert.deepEqual(
            gl.events,
            ['disable', 'enable'],
          );
          assert.deepEqual(gl.blendPublications, {
            enable: 1,
            equation: 1,
            function: 1,
          });
        });
      }
    }
  }
}
