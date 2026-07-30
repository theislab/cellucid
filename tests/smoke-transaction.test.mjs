import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildDensityTextureGPU,
} from '../assets/js/rendering/smoke-cloud/smoke-density.js';
import {
  MIN_VISIBLE_ALPHA_BYTE,
  POINT_VISIBILITY_THRESHOLD,
} from '../assets/js/rendering/alpha-visibility.js';
import { SmokeRenderer } from '../assets/js/rendering/smoke-cloud/smoke-renderer.js';
import {
  getResolutionScaleFactor,
} from '../assets/js/rendering/smoke-cloud/noise-textures.js';
import {
  MAX_SMOKE_LIGHT_SAMPLES,
  SMOKE_FS_SOURCE,
} from '../assets/js/rendering/shaders/smoke-shaders.js';
import {
  viewContextViewerSyncMethods,
} from '../assets/js/app/state/managers/view-context-viewer-sync.js';

function nextFloat32(value, direction) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  const bits = view.getUint32(0, true);
  view.setUint32(0, bits + direction, true);
  return view.getFloat32(0, true);
}

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

test('smoke preparation admits exactly Float32 alpha values encoding to visible R8 bytes', async () => {
  const byte3Alpha = POINT_VISIBILITY_THRESHOLD;
  const byte2Alpha = nextFloat32(byte3Alpha, -1);
  assert.equal(
    Math.round(byte2Alpha * 255),
    MIN_VISIBLE_ALPHA_BYTE - 1,
  );
  assert.equal(
    Math.round(byte3Alpha * 255),
    MIN_VISIBLE_ALPHA_BYTE,
  );

  const untouchedGl = new Proxy({}, {
    get(_target, property) {
      throw new Error(
        `WebGL must not be touched for R8 byte 2: ${String(property)}`,
      );
    },
  });
  assert.equal(
    buildDensityTextureGPU(
      untouchedGl,
      new Float32Array([0, 0, 0]),
      {
        gridSize: 8,
        visibility: {
          alpha: Float32Array.of(byte2Alpha),
          outlierQuantiles: null,
          outlierThreshold: null,
        },
      },
    ),
    null,
  );

  let contextLossChecks = 0;
  assert.throws(
    () => buildDensityTextureGPU(
      {
        isContextLost() {
          contextLossChecks++;
          return true;
        },
      },
      new Float32Array([0, 0, 0]),
      {
        gridSize: 8,
        visibility: {
          alpha: Float32Array.of(byte3Alpha),
          outlierQuantiles: null,
          outlierThreshold: null,
        },
      },
    ),
    /cannot build while the WebGL2 context is lost/,
  );
  assert.equal(contextLossChecks, 1);

  const source = await readFile(
    new URL(
      '../assets/js/rendering/smoke-cloud/smoke-density.js',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    source,
    /visible = alphaValue >= POINT_VISIBILITY_THRESHOLD;/,
  );
  assert.match(
    source,
    /if \(alpha\[pointIndex\] < POINT_VISIBILITY_THRESHOLD\) continue;/,
  );
});

function createFakeGl() {
  let nextId = 1;
  let texture2dBinding = null;
  let texture3dBinding = null;
  let drawFramebufferBinding = null;
  let readFramebufferBinding = null;
  let pixelUnpackBufferBinding = null;
  let unpackAlignment = 4;
  let error = 0;
  const textures = new Set();
  const framebuffers = new Set();
  const deletedTextures = [];
  const deletedFramebuffers = [];

  const gl = {
    NO_ERROR: 0,
    INVALID_VALUE: 0x0501,
    TEXTURE_2D: 0x0DE1,
    TEXTURE_3D: 0x806F,
    TEXTURE_BINDING_2D: 0x8069,
    TEXTURE_BINDING_3D: 0x806A,
    FRAMEBUFFER: 0x8D40,
    FRAMEBUFFER_BINDING: 0x8CA6,
    DRAW_FRAMEBUFFER: 0x8CA9,
    DRAW_FRAMEBUFFER_BINDING: 0x8CA6,
    READ_FRAMEBUFFER: 0x8CA8,
    READ_FRAMEBUFFER_BINDING: 0x8CAA,
    PIXEL_UNPACK_BUFFER: 0x88EC,
    PIXEL_UNPACK_BUFFER_BINDING: 0x88EF,
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
    texture2dUploadError: 0,
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
    isTexture(texture) {
      return textures.has(texture);
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
      if (drawFramebufferBinding === framebuffer) {
        drawFramebufferBinding = null;
      }
      if (readFramebufferBinding === framebuffer) {
        readFramebufferBinding = null;
      }
    },
    isFramebuffer(framebuffer) {
      return framebuffers.has(framebuffer);
    },
    bindFramebuffer(target, framebuffer) {
      if (target === gl.FRAMEBUFFER) {
        drawFramebufferBinding = framebuffer;
        readFramebufferBinding = framebuffer;
      } else if (target === gl.DRAW_FRAMEBUFFER) {
        drawFramebufferBinding = framebuffer;
      } else if (target === gl.READ_FRAMEBUFFER) {
        readFramebufferBinding = framebuffer;
      } else {
        throw new TypeError(`unexpected framebuffer target ${target}`);
      }
    },
    bindBuffer(target, buffer) {
      assert.equal(target, gl.PIXEL_UNPACK_BUFFER);
      pixelUnpackBufferBinding = buffer;
    },
    framebufferTexture2D() {},
    checkFramebufferStatus() {
      return gl.framebufferStatus;
    },
    texImage2D() {
      if (pixelUnpackBufferBinding !== null) {
        throw new Error(
          'synthetic smoke target upload observed a caller unpack buffer'
        );
      }
      if (gl.failTexture2dUpload) {
        throw new Error('synthetic smoke target upload failure');
      }
      if (gl.texture2dUploadError !== gl.NO_ERROR) {
        error = gl.texture2dUploadError;
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
      if (
        parameter === gl.FRAMEBUFFER_BINDING
        || parameter === gl.DRAW_FRAMEBUFFER_BINDING
      ) {
        return drawFramebufferBinding;
      }
      if (parameter === gl.READ_FRAMEBUFFER_BINDING) {
        return readFramebufferBinding;
      }
      if (parameter === gl.PIXEL_UNPACK_BUFFER_BINDING) {
        return pixelUnpackBufferBinding;
      }
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
        return drawFramebufferBinding;
      },
      get drawFramebufferBinding() {
        return drawFramebufferBinding;
      },
      get readFramebufferBinding() {
        return readFramebufferBinding;
      },
      get pixelUnpackBufferBinding() {
        return pixelUnpackBufferBinding;
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

test('smoke resolution scaling is a pure exact-size contract', () => {
  assert.equal(getResolutionScaleFactor(32), 3);
  assert.equal(getResolutionScaleFactor(128), 0.75);
  assert.equal(getResolutionScaleFactor(32), 3);
  assert.throws(
    () => getResolutionScaleFactor(),
    /resolution must be an integer between 32 and 256/,
  );
  assert.throws(
    () => getResolutionScaleFactor(257),
    /resolution must be an integer between 32 and 256/,
  );
});

test('smoke CPU validation and shader share the exact light-sample ceiling', () => {
  assert.equal(MAX_SMOKE_LIGHT_SAMPLES, 12);
  assert.match(
    SMOKE_FS_SOURCE,
    new RegExp(
      `for \\(int i = 1; i <= ${MAX_SMOKE_LIGHT_SAMPLES}; i\\+\\+\\)`,
    ),
  );

  const renderer = createRendererState(createFakeGl());
  renderer.setParams({ lightSamples: MAX_SMOKE_LIGHT_SAMPLES });
  assert.equal(renderer.lightSamples, MAX_SMOKE_LIGHT_SAMPLES);
  assert.throws(
    () => renderer.setParams({
      lightSamples: MAX_SMOKE_LIGHT_SAMPLES + 1,
    }),
    /lightSamples must be between 1 and 12/,
  );
  assert.equal(renderer.lightSamples, MAX_SMOKE_LIGHT_SAMPLES);

  renderer.setQualityPreset('ultra');
  assert.equal(renderer.lightSamples, MAX_SMOKE_LIGHT_SAMPLES);
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
  const callerReadFramebuffer = gl.createFramebuffer();
  const callerPixelUnpackBuffer = { kind: 'pixel-unpack-buffer' };
  renderer.colorTex = existingTexture;
  renderer.framebuffer = existingFramebuffer;
  renderer.targetWidth = 100;
  renderer.targetHeight = 50;
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, existingFramebuffer);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, callerReadFramebuffer);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, callerPixelUnpackBuffer);

  gl.framebufferStatus = gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
  assert.throws(
    () => renderer.ensureRenderTarget(400, 200),
    /INCOMPLETE_ATTACHMENT/,
  );
  assert.equal(renderer.colorTex, existingTexture);
  assert.equal(renderer.framebuffer, existingFramebuffer);
  assert.equal(renderer.targetWidth, 100);
  assert.equal(renderer.targetHeight, 50);
  assert.equal(gl._state.drawFramebufferBinding, existingFramebuffer);
  assert.equal(gl._state.readFramebufferBinding, callerReadFramebuffer);
  assert.equal(
    gl._state.pixelUnpackBufferBinding,
    callerPixelUnpackBuffer,
  );

  gl.framebufferStatus = gl.FRAMEBUFFER_COMPLETE;
  gl.texture2dUploadError = gl.INVALID_VALUE;
  assert.throws(
    () => renderer.ensureRenderTarget(400, 200),
    /0x501/,
  );
  assert.equal(renderer.colorTex, existingTexture);
  assert.equal(renderer.framebuffer, existingFramebuffer);
  assert.equal(renderer.targetWidth, 100);
  assert.equal(renderer.targetHeight, 50);
  assert.equal(gl._state.drawFramebufferBinding, existingFramebuffer);
  assert.equal(gl._state.readFramebufferBinding, callerReadFramebuffer);
  assert.equal(
    gl._state.pixelUnpackBufferBinding,
    callerPixelUnpackBuffer,
  );
  assert.equal(gl.getError(), gl.NO_ERROR);

  gl.texture2dUploadError = gl.NO_ERROR;
  gl.framebufferStatus = gl.FRAMEBUFFER_COMPLETE;
  renderer.ensureRenderTarget(400, 200);
  assert.notEqual(renderer.colorTex, existingTexture);
  assert.notEqual(renderer.framebuffer, existingFramebuffer);
  assert.equal(renderer.targetWidth, 200);
  assert.equal(renderer.targetHeight, 100);
  assert.equal(gl._state.textures.has(existingTexture), false);
  assert.equal(gl._state.framebuffers.has(existingFramebuffer), false);
  assert.equal(gl._state.drawFramebufferBinding, renderer.framebuffer);
  assert.equal(gl._state.readFramebufferBinding, callerReadFramebuffer);
  assert.equal(
    gl._state.pixelUnpackBufferBinding,
    callerPixelUnpackBuffer,
  );
});

test('first smoke render-target publication preserves default caller bindings', () => {
  const gl = createFakeGl();
  const renderer = createRendererState(gl);

  renderer.ensureRenderTarget(400, 200);

  assert.notEqual(renderer.colorTex, null);
  assert.notEqual(renderer.framebuffer, null);
  assert.equal(renderer.targetWidth, 200);
  assert.equal(renderer.targetHeight, 100);
  assert.equal(gl._state.drawFramebufferBinding, null);
  assert.equal(gl._state.readFramebufferBinding, null);
  assert.equal(gl._state.texture2dBinding, null);
  assert.equal(gl._state.pixelUnpackBufferBinding, null);
  assert.equal(gl.getError(), gl.NO_ERROR);
});

test('native smoke resolution releases its obsolete target once while unchanged scales preserve it', () => {
  const gl = createFakeGl();
  const renderer = createRendererState(gl);
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  renderer.colorTex = texture;
  renderer.framebuffer = framebuffer;
  renderer.targetWidth = 320;
  renderer.targetHeight = 180;

  renderer.setResolutionScale(0.5);
  assert.equal(renderer.colorTex, texture);
  assert.equal(renderer.framebuffer, framebuffer);
  assert.equal(renderer.targetWidth, 320);
  assert.equal(renderer.targetHeight, 180);
  assert.deepEqual(gl._state.deletedTextures, []);
  assert.deepEqual(gl._state.deletedFramebuffers, []);

  renderer.setResolutionScale(1);
  assert.equal(renderer.resolutionScale, 1);
  assert.equal(renderer.colorTex, null);
  assert.equal(renderer.framebuffer, null);
  assert.equal(renderer.targetWidth, 0);
  assert.equal(renderer.targetHeight, 0);
  assert.deepEqual(gl._state.deletedTextures, [texture]);
  assert.deepEqual(gl._state.deletedFramebuffers, [framebuffer]);

  renderer.setResolutionScale(1);
  assert.deepEqual(gl._state.deletedTextures, [texture]);
  assert.deepEqual(gl._state.deletedFramebuffers, [framebuffer]);
});

test('native smoke resolution settles delete-then-throw ownership exactly once', () => {
  const gl = createFakeGl();
  const renderer = createRendererState(gl);
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  renderer.colorTex = texture;
  renderer.framebuffer = framebuffer;
  renderer.targetWidth = 320;
  renderer.targetHeight = 180;
  const originalDeleteFramebuffer = gl.deleteFramebuffer;
  gl.deleteFramebuffer = (resource) => {
    originalDeleteFramebuffer(resource);
    throw new Error('synthetic native framebuffer cleanup failure');
  };

  assert.doesNotThrow(() => renderer.setResolutionScale(1));
  assert.equal(renderer.resolutionScale, 1);
  assert.equal(renderer.colorTex, null);
  assert.equal(renderer.framebuffer, null);
  assert.equal(renderer.targetWidth, 0);
  assert.equal(renderer.targetHeight, 0);
  assert.deepEqual(gl._state.deletedFramebuffers, [framebuffer]);
  assert.deepEqual(gl._state.deletedTextures, [texture]);

  assert.doesNotThrow(() => renderer.setResolutionScale(0.75));
  assert.equal(renderer.resolutionScale, 0.75);
  assert.deepEqual(gl._state.deletedFramebuffers, [framebuffer]);
  assert.deepEqual(gl._state.deletedTextures, [texture]);
});

test('smoke resource retirement retries only resources still live after deletion rejects', () => {
  const gl = createFakeGl();
  const renderer = createRendererState(gl);
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  renderer.colorTex = texture;
  renderer.framebuffer = framebuffer;
  renderer.targetWidth = 320;
  renderer.targetHeight = 180;
  const originalDeleteFramebuffer = gl.deleteFramebuffer;
  let rejectBeforeDeletion = true;
  gl.deleteFramebuffer = (resource) => {
    if (rejectBeforeDeletion) {
      rejectBeforeDeletion = false;
      throw new Error('synthetic live framebuffer cleanup failure');
    }
    originalDeleteFramebuffer(resource);
  };

  assert.throws(
    () => renderer.setResolutionScale(1),
    /synthetic live framebuffer cleanup failure/,
  );
  assert.equal(gl.isFramebuffer(framebuffer), true);
  assert.deepEqual(gl._state.deletedFramebuffers, []);
  assert.deepEqual(gl._state.deletedTextures, [texture]);

  assert.doesNotThrow(() => renderer.setResolutionScale(0.75));
  assert.equal(renderer.resolutionScale, 0.75);
  assert.equal(gl.isFramebuffer(framebuffer), false);
  assert.deepEqual(gl._state.deletedFramebuffers, [framebuffer]);
  assert.deepEqual(gl._state.deletedTextures, [texture]);
});

test('native quality presets release targets through the exact resolution owner', () => {
  for (const preset of ['quality', 'ultra']) {
    const gl = createFakeGl();
    const renderer = createRendererState(gl);
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    renderer.colorTex = texture;
    renderer.framebuffer = framebuffer;
    renderer.targetWidth = 320;
    renderer.targetHeight = 180;

    renderer.setQualityPreset(preset);
    assert.equal(renderer.resolutionScale, 1);
    assert.equal(renderer.colorTex, null);
    assert.equal(renderer.framebuffer, null);
    assert.deepEqual(gl._state.deletedTextures, [texture]);
    assert.deepEqual(gl._state.deletedFramebuffers, [framebuffer]);
  }
});
