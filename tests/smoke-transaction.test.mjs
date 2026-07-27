import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildDensityTextureGPU,
} from '../assets/js/rendering/smoke-cloud/smoke-density.js';
import { SmokeRenderer } from '../assets/js/rendering/smoke-cloud/smoke-renderer.js';
import {
  viewContextViewerSyncMethods,
} from '../assets/js/app/state/managers/view-context-viewer-sync.js';

test('GPU smoke density never synchronizes a volume through product readback', async () => {
  const source = await readFile(
    new URL(
      '../assets/js/rendering/smoke-cloud/smoke-density.js',
      import.meta.url,
    ),
    'utf8',
  );
  assert.doesNotMatch(source, /\bgl\.readPixels\s*\(/);
});

test('GPU smoke density rejects invalid positions before touching WebGL', () => {
  const gl = new Proxy({}, {
    get(_target, property) {
      throw new Error(`WebGL must not be touched during preflight: ${String(property)}`);
    },
  });
  assert.throws(
    () => buildDensityTextureGPU(
      gl,
      new Float32Array([Number.NaN, 0, 0]),
      { gridSize: 8 },
    ),
    /component 0 must be finite/,
  );
  assert.throws(
    () => buildDensityTextureGPU(
      gl,
      new Float32Array([2, 2, 2]),
      { gridSize: 8 },
    ),
    /at least one visible point inside.*\[-1, 1\]/,
  );
});

test('GPU smoke density rejects scalar contracts before scanning point contents', () => {
  const gl = new Proxy({}, {
    get(_target, property) {
      throw new Error(`WebGL must not be touched during preflight: ${String(property)}`);
    },
  });
  const positionsWithInvalidContent = new Float32Array([Number.NaN, 0, 0]);

  assert.throws(
    () => buildDensityTextureGPU(
      gl,
      positionsWithInvalidContent,
      { gridSize: 129 },
    ),
    /gridSize.*8 through 128/i,
  );
  assert.throws(
    () => buildDensityTextureGPU(
      gl,
      positionsWithInvalidContent,
      { gamma: Number.MIN_VALUE, gridSize: 8 },
    ),
    /gamma.*normal Float32/i,
  );
  assert.throws(
    () => buildDensityTextureGPU(
      gl,
      positionsWithInvalidContent,
      { gamma: Number.MAX_VALUE, gridSize: 8 },
    ),
    /gamma.*normal Float32/i,
  );
  assert.throws(
    () => buildDensityTextureGPU(
      gl,
      positionsWithInvalidContent,
      { gridSize: 8, surprise: true },
    ),
    /option "surprise" is unknown/i,
  );
});

test('smoke density source retains dataset arrays without an O(n) position copy', () => {
  const positions = new Float32Array([
    -0.5, 0, 0.5,
    0.5, 0, -0.5,
  ]);
  const alpha = new Float32Array([1, 0]);
  const outlierQuantiles = new Float32Array([0.2, -1]);
  const source = viewContextViewerSyncMethods.getSmokeDensitySource.call({
    categoryTransparency: alpha,
    getCurrentOutlierThreshold() {
      return 0.75;
    },
    isOutlierFilterEnabledForActiveField() {
      return true;
    },
    outlierQuantilesArray: outlierQuantiles,
    pointCount: 2,
    positionsArray: positions,
  });

  assert.equal(Object.isFrozen(source), true);
  assert.strictEqual(source.positions, positions);
  assert.strictEqual(source.alpha, alpha);
  assert.strictEqual(source.outlierQuantiles, outlierQuantiles);
  assert.equal(source.outlierThreshold, 0.75);
});

test('an all-hidden smoke source settles empty before touching WebGL', () => {
  const gl = new Proxy({}, {
    get(_target, property) {
      throw new Error(`WebGL must not be touched for an empty source: ${String(property)}`);
    },
  });
  const result = buildDensityTextureGPU(
    gl,
    new Float32Array([
      -0.5, 0, 0.5,
      0.5, 0, -0.5,
    ]),
    {
      gridSize: 8,
      visibility: {
        alpha: new Float32Array([0, 0]),
        outlierQuantiles: null,
        outlierThreshold: null,
      },
    },
  );
  assert.equal(result, null);
});

function createFakeGl() {
  let nextId = 1;
  let texture2dBinding = null;
  let texture3dBinding = null;
  let framebufferBinding = null;
  let unpackAlignment = 4;
  let error = 0;
  const textures = new Set();
  const framebuffers = new Set();
  const deletedTextures = [];
  const deletedFramebuffers = [];

  const gl = {
    NO_ERROR: 0,
    TEXTURE_2D: 0x0DE1,
    TEXTURE_3D: 0x806F,
    TEXTURE_BINDING_2D: 0x8069,
    TEXTURE_BINDING_3D: 0x806A,
    FRAMEBUFFER: 0x8D40,
    FRAMEBUFFER_BINDING: 0x8CA6,
    FRAMEBUFFER_COMPLETE: 0x8CD5,
    FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8CD6,
    FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT: 0x8CD7,
    FRAMEBUFFER_INCOMPLETE_DIMENSIONS: 0x8CD9,
    FRAMEBUFFER_UNSUPPORTED: 0x8CDD,
    COLOR_ATTACHMENT0: 0x8CE0,
    UNPACK_ALIGNMENT: 0x0CF5,
    RGBA: 0x1908,
    RED: 0x1903,
    R8: 0x8229,
    UNSIGNED_BYTE: 0x1401,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TEXTURE_WRAP_R: 0x8072,
    LINEAR: 0x2601,
    LINEAR_MIPMAP_LINEAR: 0x2703,
    CLAMP_TO_EDGE: 0x812F,
    framebufferStatus: 0x8CD5,
    failTexture3dUpload: false,
    failTexture2dUpload: false,
    createTexture() {
      const texture = { kind: 'texture', id: nextId++ };
      textures.add(texture);
      return texture;
    },
    deleteTexture(texture) {
      textures.delete(texture);
      deletedTextures.push(texture);
      if (texture2dBinding === texture) texture2dBinding = null;
      if (texture3dBinding === texture) texture3dBinding = null;
    },
    bindTexture(target, texture) {
      if (target === gl.TEXTURE_2D) texture2dBinding = texture;
      else if (target === gl.TEXTURE_3D) texture3dBinding = texture;
      else throw new TypeError(`unexpected texture target ${target}`);
    },
    createFramebuffer() {
      const framebuffer = { kind: 'framebuffer', id: nextId++ };
      framebuffers.add(framebuffer);
      return framebuffer;
    },
    deleteFramebuffer(framebuffer) {
      framebuffers.delete(framebuffer);
      deletedFramebuffers.push(framebuffer);
      if (framebufferBinding === framebuffer) framebufferBinding = null;
    },
    bindFramebuffer(target, framebuffer) {
      assert.equal(target, gl.FRAMEBUFFER);
      framebufferBinding = framebuffer;
    },
    framebufferTexture2D() {},
    checkFramebufferStatus() {
      return gl.framebufferStatus;
    },
    texImage2D() {
      if (gl.failTexture2dUpload) {
        throw new Error('synthetic smoke target upload failure');
      }
    },
    texImage3D() {
      if (gl.failTexture3dUpload) {
        throw new Error('synthetic smoke volume upload failure');
      }
    },
    texParameteri() {},
    generateMipmap() {},
    pixelStorei(parameter, value) {
      assert.equal(parameter, gl.UNPACK_ALIGNMENT);
      unpackAlignment = value;
    },
    getParameter(parameter) {
      if (parameter === gl.TEXTURE_BINDING_2D) return texture2dBinding;
      if (parameter === gl.TEXTURE_BINDING_3D) return texture3dBinding;
      if (parameter === gl.FRAMEBUFFER_BINDING) return framebufferBinding;
      if (parameter === gl.UNPACK_ALIGNMENT) return unpackAlignment;
      throw new TypeError(`unexpected parameter ${parameter}`);
    },
    getError() {
      const value = error;
      error = gl.NO_ERROR;
      return value;
    },
    _state: {
      textures,
      framebuffers,
      deletedTextures,
      deletedFramebuffers,
      get texture2dBinding() {
        return texture2dBinding;
      },
      get texture3dBinding() {
        return texture3dBinding;
      },
      get framebufferBinding() {
        return framebufferBinding;
      },
      get unpackAlignment() {
        return unpackAlignment;
      },
    },
  };
  return gl;
}

function createRendererState(gl) {
  const renderer = Object.create(SmokeRenderer.prototype);
  renderer.gl = gl;
  renderer.textureInfo = null;
  renderer.volumeMin = new Float32Array([-1, -1, -1]);
  renderer.volumeMax = new Float32Array([1, 1, 1]);
  renderer.density = 8;
  renderer.noiseScale = 1;
  renderer.warpStrength = 0.2;
  renderer.stepMultiplier = 2.8;
  renderer.animationSpeed = 1;
  renderer.detailLevel = 3.8;
  renderer.lightAbsorption = 1.5;
  renderer.scatterStrength = 0;
  renderer.edgeSoftness = 0.3;
  renderer.directLight = 0.06;
  renderer.lightSamples = 6;
  renderer.resolutionScale = 0.5;
  renderer.framebuffer = null;
  renderer.colorTex = null;
  renderer.targetWidth = 0;
  renderer.targetHeight = 0;
  return renderer;
}

function createVolume(overrides = {}) {
  return {
    boundsMax: [1, 1, 1],
    boundsMin: [-1, -1, -1],
    data: new Float32Array(8 ** 3),
    gridSize: 8,
    ...overrides,
  };
}

test('smoke parameter patches preflight completely before committing', () => {
  const renderer = createRendererState(createFakeGl());
  assert.throws(
    () => renderer.setParams({ density: 2, lightSamples: 1.5 }),
    /lightSamples must be an integer/,
  );
  assert.equal(renderer.density, 8);
  assert.equal(renderer.lightSamples, 6);

  renderer.setParams({ density: 2, lightSamples: 4 });
  assert.equal(renderer.density, 2);
  assert.equal(renderer.lightSamples, 4);
});

test('smoke volume validation and upload failures preserve the published volume', () => {
  const gl = createFakeGl();
  const renderer = createRendererState(gl);
  const existing = gl.createTexture();
  renderer.textureInfo = { texture: existing, gridSize: 8, is3D: true };

  assert.throws(
    () => renderer.setVolume(createVolume({ boundsMin: [2, -1, -1] })),
    /boundsMin\[0\] must be smaller/,
  );
  assert.equal(gl._state.textures.size, 1);
  assert.equal(renderer.textureInfo.texture, existing);

  gl.failTexture3dUpload = true;
  assert.throws(
    () => renderer.setVolume(createVolume()),
    /synthetic smoke volume upload failure/,
  );
  assert.equal(renderer.textureInfo.texture, existing);
  assert.equal(gl._state.textures.size, 1);
  assert.equal(gl._state.texture3dBinding, null);
  assert.equal(gl._state.unpackAlignment, 4);

  gl.failTexture3dUpload = false;
  renderer.setVolume(createVolume());
  assert.equal(renderer.hasVolume(), true);
  assert.notEqual(renderer.textureInfo.texture, existing);
});

test('clearing smoke volume releases the exact texture and is idempotent', () => {
  const gl = createFakeGl();
  const renderer = createRendererState(gl);
  const existing = gl.createTexture();
  renderer.textureInfo = { texture: existing, gridSize: 8, is3D: true };
  gl.bindTexture(gl.TEXTURE_3D, existing);

  renderer.clearVolume();

  assert.equal(renderer.textureInfo, null);
  assert.equal(renderer.hasVolume(), false);
  assert.equal(gl._state.textures.has(existing), false);
  assert.deepEqual(gl._state.deletedTextures, [existing]);
  assert.equal(gl._state.texture3dBinding, null);

  renderer.clearVolume();
  assert.equal(renderer.hasVolume(), false);
  assert.deepEqual(gl._state.deletedTextures, [existing]);
});

test('float smoke accumulation explicitly requires both WebGL extensions', () => {
  const requestedExtensions = [];
  const gl = {
    isContextLost() {
      return false;
    },
    getExtension(name) {
      requestedExtensions.push(name);
      return name === 'EXT_color_buffer_float' ? {} : null;
    },
  };

  assert.throws(
    () => buildDensityTextureGPU(
      gl,
      new Float32Array([0, 0, 0]),
      { gridSize: 8 },
    ),
    /requires EXT_float_blend/,
  );
  assert.deepEqual(requestedExtensions, [
    'EXT_color_buffer_float',
    'EXT_float_blend',
  ]);
});

test('smoke render-target replacement is atomic on incomplete or failed GPU state', () => {
  const gl = createFakeGl();
  const renderer = createRendererState(gl);
  const existingTexture = gl.createTexture();
  const existingFramebuffer = gl.createFramebuffer();
  renderer.colorTex = existingTexture;
  renderer.framebuffer = existingFramebuffer;
  renderer.targetWidth = 100;
  renderer.targetHeight = 50;

  gl.framebufferStatus = gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
  assert.throws(
    () => renderer.ensureRenderTarget(400, 200),
    /INCOMPLETE_ATTACHMENT/,
  );
  assert.equal(renderer.colorTex, existingTexture);
  assert.equal(renderer.framebuffer, existingFramebuffer);
  assert.equal(renderer.targetWidth, 100);
  assert.equal(renderer.targetHeight, 50);

  gl.framebufferStatus = gl.FRAMEBUFFER_COMPLETE;
  renderer.ensureRenderTarget(400, 200);
  assert.notEqual(renderer.colorTex, existingTexture);
  assert.notEqual(renderer.framebuffer, existingFramebuffer);
  assert.equal(renderer.targetWidth, 200);
  assert.equal(renderer.targetHeight, 100);
  assert.equal(gl._state.textures.has(existingTexture), false);
  assert.equal(gl._state.framebuffers.has(existingFramebuffer), false);
});
