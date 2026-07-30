import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VelocityOverlay,
} from '../assets/js/rendering/overlays/velocity/velocity-overlay.js';
import {
  FULLSCREEN_VS,
} from '../assets/js/rendering/overlays/velocity/velocity-shaders.js';

function createFramebufferGl(extensionSupport) {
  const requestedExtensions = [];
  const textureFormats = [];
  const textureParameters = [];
  const deletedFramebuffers = [];
  const deletedTextures = [];
  let nextId = 1;
  let activeTexture = 0x84c0;
  let textureBinding = null;
  let pixelUnpackBuffer = null;
  let drawFramebuffer = null;
  let readFramebuffer = null;
  let viewport = [0, 0, 16, 16];
  let scissorBox = [0, 0, 16, 16];
  let scissorEnabled = false;
  let colorMask = [true, true, true, true];

  const gl = {
    ACTIVE_TEXTURE: 0x84e0,
    COLOR_WRITEMASK: 0x0c23,
    DRAW_FRAMEBUFFER: 0x8ca9,
    DRAW_FRAMEBUFFER_BINDING: 0x8ca6,
    READ_FRAMEBUFFER: 0x8ca8,
    READ_FRAMEBUFFER_BINDING: 0x8caa,
    PIXEL_UNPACK_BUFFER: 0x88ec,
    PIXEL_UNPACK_BUFFER_BINDING: 0x88ef,
    SCISSOR_BOX: 0x0c10,
    SCISSOR_TEST: 0x0c11,
    TEXTURE_BINDING_2D: 0x8069,
    VIEWPORT: 0x0ba2,
    NO_ERROR: 0,
    RGBA16F: 0x881a,
    RGBA32F: 0x8814,
    RGBA8: 0x8058,
    RGBA: 0x1908,
    HALF_FLOAT: 0x140b,
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    activeTexture(value) {
      activeTexture = value;
    },
    getExtension(name) {
      requestedExtensions.push(name);
      return extensionSupport[name] === true ? { name } : null;
    },
    createTexture() {
      return { kind: 'texture', id: nextId++ };
    },
    bindBuffer(target, value) {
      assert.equal(target, this.PIXEL_UNPACK_BUFFER);
      pixelUnpackBuffer = value;
    },
    bindTexture(_target, value) {
      textureBinding = value;
    },
    texStorage2D(_target, _levels, internalFormat) {
      textureFormats.push(internalFormat);
    },
    texParameteri(_target, parameter, value) {
      textureParameters.push([parameter, value]);
    },
    createFramebuffer() {
      return { kind: 'framebuffer', id: nextId++ };
    },
    bindFramebuffer(target, value) {
      if (target === this.FRAMEBUFFER) {
        drawFramebuffer = value;
        readFramebuffer = value;
      } else if (target === this.DRAW_FRAMEBUFFER) {
        drawFramebuffer = value;
      } else if (target === this.READ_FRAMEBUFFER) {
        readFramebuffer = value;
      }
    },
    framebufferTexture2D() {},
    checkFramebufferStatus() {
      return gl.FRAMEBUFFER_COMPLETE;
    },
    deleteFramebuffer(framebuffer) {
      deletedFramebuffers.push(framebuffer);
    },
    deleteTexture(texture) {
      deletedTextures.push(texture);
    },
    getError() {
      return this.NO_ERROR;
    },
    getParameter(parameter) {
      if (parameter === this.ACTIVE_TEXTURE) return activeTexture;
      if (parameter === this.COLOR_WRITEMASK) return colorMask.slice();
      if (parameter === this.DRAW_FRAMEBUFFER_BINDING) {
        return drawFramebuffer;
      }
      if (parameter === this.PIXEL_UNPACK_BUFFER_BINDING) {
        return pixelUnpackBuffer;
      }
      if (parameter === this.READ_FRAMEBUFFER_BINDING) {
        return readFramebuffer;
      }
      if (parameter === this.SCISSOR_BOX) return scissorBox.slice();
      if (parameter === this.TEXTURE_BINDING_2D) return textureBinding;
      if (parameter === this.VIEWPORT) return viewport.slice();
      throw new RangeError(`Unexpected WebGL parameter ${parameter}.`);
    },
    isEnabled(capability) {
      assert.equal(capability, this.SCISSOR_TEST);
      return scissorEnabled;
    },
    colorMask(...value) {
      colorMask = value;
    },
    disable(capability) {
      assert.equal(capability, this.SCISSOR_TEST);
      scissorEnabled = false;
    },
    enable(capability) {
      assert.equal(capability, this.SCISSOR_TEST);
      scissorEnabled = true;
    },
    scissor(...value) {
      scissorBox = value;
    },
    viewport(...value) {
      viewport = value;
    },
  };

  return {
    deletedFramebuffers,
    deletedTextures,
    gl,
    requestedExtensions,
    textureFormats,
    textureParameters,
  };
}

function createColormapGl({
  deleteFailures = 0,
  deleteThenThrow = false,
  initialBinding,
  initialPixelUnpackBuffer,
  uploadError = 0,
}) {
  const candidate = { kind: 'candidate-colormap' };
  const deleteAttempts = [];
  const deletedTextures = [];
  const liveTextures = new Set([candidate]);
  if (initialBinding !== null) liveTextures.add(initialBinding);
  const uploads = [];
  let remainingDeleteFailures = deleteFailures;
  let textureBinding = initialBinding;
  let pixelUnpackBuffer = initialPixelUnpackBuffer;
  let unpackAlignment = 4;
  let nextError = 0;
  const gl = {
    CLAMP_TO_EDGE: 0x812f,
    LINEAR: 0x2601,
    NO_ERROR: 0,
    PIXEL_UNPACK_BUFFER: 0x88ec,
    PIXEL_UNPACK_BUFFER_BINDING: 0x88ef,
    RGB: 0x1907,
    RGB8: 0x8051,
    TEXTURE_2D: 0x0de1,
    TEXTURE_BINDING_2D: 0x8069,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    UNPACK_ALIGNMENT: 0x0cf5,
    UNSIGNED_BYTE: 0x1401,
    bindBuffer(target, value) {
      assert.equal(target, this.PIXEL_UNPACK_BUFFER);
      pixelUnpackBuffer = value;
    },
    bindTexture(target, value) {
      assert.equal(target, this.TEXTURE_2D);
      textureBinding = value;
    },
    createTexture() {
      return candidate;
    },
    deleteTexture(texture) {
      deleteAttempts.push(texture);
      if (remainingDeleteFailures > 0) {
        remainingDeleteFailures--;
        if (deleteThenThrow) {
          liveTextures.delete(texture);
          deletedTextures.push(texture);
        }
        throw new Error('Injected colormap texture deletion failure.');
      }
      liveTextures.delete(texture);
      deletedTextures.push(texture);
    },
    getError() {
      const value = nextError;
      nextError = this.NO_ERROR;
      return value;
    },
    getParameter(parameter) {
      if (parameter === this.TEXTURE_BINDING_2D) return textureBinding;
      if (parameter === this.UNPACK_ALIGNMENT) return unpackAlignment;
      if (parameter === this.PIXEL_UNPACK_BUFFER_BINDING) {
        return pixelUnpackBuffer;
      }
      throw new RangeError(`Unexpected WebGL parameter ${parameter}.`);
    },
    isTexture(texture) {
      return liveTextures.has(texture);
    },
    pixelStorei(parameter, value) {
      assert.equal(parameter, this.UNPACK_ALIGNMENT);
      unpackAlignment = value;
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
      uploads.push({
        border,
        data,
        format,
        height,
        internalFormat,
        level,
        pixelUnpackBuffer,
        target,
        texture: textureBinding,
        type,
        unpackAlignment,
        width,
      });
      nextError = uploadError;
    },
    texParameteri() {},
  };
  return {
    candidate,
    deleteAttempts,
    deletedTextures,
    gl,
    readState: () => ({
      pixelUnpackBuffer,
      textureBinding,
      unpackAlignment,
    }),
    uploads,
  };
}

test('velocity colormap replacement stages under hostile unpack state and restores logical binding ownership', () => {
  const existing = { kind: 'existing-colormap' };
  const callerPbo = { kind: 'caller-pbo' };
  const fixture = createColormapGl({
    initialBinding: existing,
    initialPixelUnpackBuffer: callerPbo,
  });
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    config: { colormapId: 'viridis' },
    gl: fixture.gl,
    _colormapTexture: existing,
  });

  overlay._updateColormap();

  assert.equal(overlay._colormapTexture, fixture.candidate);
  assert.deepEqual(fixture.deletedTextures, [existing]);
  assert.equal(fixture.uploads.length, 1);
  assert.equal(fixture.uploads[0].texture, fixture.candidate);
  assert.equal(fixture.uploads[0].pixelUnpackBuffer, null);
  assert.equal(fixture.uploads[0].unpackAlignment, 1);
  assert.ok(fixture.uploads[0].data instanceof Uint8Array);
  assert.equal(fixture.uploads[0].data.length, 256 * 3);
  assert.deepEqual(fixture.readState(), {
    pixelUnpackBuffer: callerPbo,
    textureBinding: fixture.candidate,
    unpackAlignment: 4,
  });
});

test('successful velocity colormap replacement retains failed old-texture retirement for retry', () => {
  const existing = { kind: 'existing-colormap' };
  const fixture = createColormapGl({
    deleteFailures: 1,
    initialBinding: existing,
    initialPixelUnpackBuffer: null,
  });
  let reportedFailures = null;
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    config: {
      colormapId: 'viridis',
      particleCapacity: 500_000,
    },
    gl: fixture.gl,
    _colormapTexture: existing,
    _disposed: false,
    _initialized: true,
    _reportDerivedRetirementFailures(failures) {
      reportedFailures = failures;
    },
  });

  overlay._updateColormap();

  assert.equal(overlay._colormapTexture, fixture.candidate);
  assert.deepEqual(fixture.deleteAttempts, [existing]);
  assert.deepEqual(fixture.deletedTextures, []);
  assert.equal(reportedFailures.length, 1);
  assert.match(reportedFailures[0].message, /deletion failure/);
  assert.deepEqual(
    Array.from(overlay._pendingColormapTextureDeletes),
    [existing],
  );
  assert.equal(fixture.readState().textureBinding, fixture.candidate);

  overlay.setConfig('colormapId', 'viridis');

  assert.deepEqual(fixture.deleteAttempts, [existing, existing]);
  assert.deepEqual(fixture.deletedTextures, [existing]);
  assert.equal(overlay._pendingColormapTextureDeletes.size, 0);
  assert.equal(fixture.readState().textureBinding, fixture.candidate);
});

test('velocity colormap retirement converges when a wrapper deletes then throws', () => {
  const existing = { kind: 'existing-colormap' };
  const fixture = createColormapGl({
    deleteFailures: 1,
    deleteThenThrow: true,
    initialBinding: existing,
    initialPixelUnpackBuffer: null,
  });
  let reportedFailures = Symbol('not-called');
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    config: { colormapId: 'viridis' },
    gl: fixture.gl,
    _colormapTexture: existing,
    _reportDerivedRetirementFailures(failures) {
      reportedFailures = failures;
    },
  });

  overlay._updateColormap();

  assert.equal(overlay._colormapTexture, fixture.candidate);
  assert.deepEqual(fixture.deleteAttempts, [existing]);
  assert.deepEqual(fixture.deletedTextures, [existing]);
  assert.equal(reportedFailures, null);
  assert.equal(overlay._pendingColormapTextureDeletes.size, 0);
  assert.equal(fixture.readState().textureBinding, fixture.candidate);
});

test('failed velocity colormap upload preserves the published texture, caller state, and config', () => {
  const existing = { kind: 'existing-colormap' };
  const callerTexture = { kind: 'caller-texture' };
  const callerPbo = { kind: 'caller-pbo' };
  const fixture = createColormapGl({
    initialBinding: callerTexture,
    initialPixelUnpackBuffer: callerPbo,
    uploadError: 0x0502,
  });
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    config: {
      colormapId: 'viridis',
      particleCapacity: 500_000,
    },
    gl: fixture.gl,
    _colormapTexture: existing,
    _disposed: false,
    _fboByView: new Map(),
    _initialized: true,
  });

  assert.throws(
    () => overlay.setConfig('colormapId', 'plasma'),
    /colormap upload failed with WebGL error 0x502/,
  );

  assert.equal(overlay.config.colormapId, 'viridis');
  assert.equal(overlay._colormapTexture, existing);
  assert.deepEqual(fixture.deletedTextures, [fixture.candidate]);
  assert.deepEqual(fixture.readState(), {
    pixelUnpackBuffer: callerPbo,
    textureBinding: callerTexture,
    unpackAlignment: 4,
  });
});

test('failed velocity colormap upload retains a candidate whose cleanup fails', () => {
  const existing = { kind: 'existing-colormap' };
  const callerTexture = { kind: 'caller-texture' };
  const callerPbo = { kind: 'caller-pbo' };
  const fixture = createColormapGl({
    deleteFailures: 1,
    initialBinding: callerTexture,
    initialPixelUnpackBuffer: callerPbo,
    uploadError: 0x0502,
  });
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    config: {
      colormapId: 'viridis',
      particleCapacity: 500_000,
    },
    gl: fixture.gl,
    _colormapTexture: existing,
    _disposed: false,
    _fboByView: new Map(),
    _initialized: true,
  });

  assert.throws(
    () => overlay.setConfig('colormapId', 'plasma'),
    error => (
      error instanceof AggregateError &&
      error.errors.some(
        nested => /colormap upload failed/.test(nested.message),
      ) &&
      error.errors.some(
        nested => /deletion failure/.test(nested.message),
      )
    ),
  );

  assert.equal(overlay.config.colormapId, 'viridis');
  assert.equal(overlay._colormapTexture, existing);
  assert.deepEqual(fixture.deleteAttempts, [fixture.candidate]);
  assert.deepEqual(fixture.deletedTextures, []);
  assert.deepEqual(
    Array.from(overlay._pendingColormapTextureDeletes),
    [fixture.candidate],
  );
  assert.deepEqual(fixture.readState(), {
    pixelUnpackBuffer: callerPbo,
    textureBinding: callerTexture,
    unpackAlignment: 4,
  });

  assert.equal(overlay._flushPendingColormapTextureDeletes(), null);
  assert.deepEqual(
    fixture.deleteAttempts,
    [fixture.candidate, fixture.candidate],
  );
  assert.deepEqual(fixture.deletedTextures, [fixture.candidate]);
  assert.equal(overlay._pendingColormapTextureDeletes.size, 0);
});

test('velocity HDR targets explicitly enable every float capability before selection', () => {
  const fixture = createFramebufferGl({
    EXT_color_buffer_float: true,
    OES_texture_float_linear: true,
    EXT_float_blend: true,
  });
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    gl: fixture.gl,
    _textureFormat: null,
  });

  const format = overlay._detectTextureFormat();

  assert.equal(format.internal, fixture.gl.RGBA16F);
  assert.deepEqual(fixture.requestedExtensions, [
    'EXT_color_buffer_float',
    'OES_texture_float_linear',
    'EXT_float_blend',
  ]);
  assert.equal(
    fixture.textureParameters.filter(
      ([parameter, value]) =>
        parameter === fixture.gl.TEXTURE_MIN_FILTER &&
        value === fixture.gl.LINEAR
    ).length,
    1
  );
  assert.equal(
    fixture.textureParameters.filter(
      ([parameter, value]) =>
        parameter === fixture.gl.TEXTURE_MAG_FILTER &&
        value === fixture.gl.LINEAR
    ).length,
    1
  );
});

test('velocity selects the exact filterable blendable target contract', () => {
  const fixture = createFramebufferGl({
    EXT_color_buffer_float: true,
    OES_texture_float_linear: false,
    EXT_float_blend: true,
  });
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    gl: fixture.gl,
    _textureFormat: null,
  });

  const format = overlay._detectTextureFormat();

  assert.equal(format.internal, fixture.gl.RGBA8);
  assert.deepEqual(fixture.textureFormats, [fixture.gl.RGBA8]);
});

test('velocity format probing retains exact failed cleanup ownership for retry', () => {
  const fixture = createFramebufferGl({
    EXT_color_buffer_float: true,
    OES_texture_float_linear: true,
    EXT_float_blend: true,
  });
  const deleteTexture = fixture.gl.deleteTexture.bind(fixture.gl);
  let failedTexture = null;
  let failOnce = true;
  fixture.gl.deleteTexture = texture => {
    if (failOnce) {
      failOnce = false;
      failedTexture = texture;
      throw new Error('Injected format-probe cleanup failure.');
    }
    deleteTexture(texture);
  };
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    gl: fixture.gl,
    _pendingFBORetirements: new Set(),
    _residentFBOBytes: 0n,
    _textureFormat: null,
  });

  assert.throws(
    () => overlay._detectTextureFormat(),
    /format-probe cleanup was incomplete/,
  );

  assert.equal(overlay._textureFormat, null);
  assert.equal(overlay._pendingFBORetirements.size, 1);
  assert.equal(overlay._residentFBOBytes, 16n * 8n);
  const pending = Array.from(overlay._pendingFBORetirements)[0];
  assert.equal(pending.trail[0], failedTexture);
  assert.equal(pending.trailFramebuffers[0], null);
  assert.equal(pending.trailTextureBytes[0], 16n * 8n);

  overlay._flushPendingFBORetirements();

  assert.equal(overlay._pendingFBORetirements.size, 0);
  assert.equal(overlay._residentFBOBytes, 0n);
  assert.deepEqual(fixture.deletedTextures, [failedTexture]);
});

test('fullscreen velocity passes own an enabled attribute-zero array', () => {
  const calls = [];
  const vao = { kind: 'vao' };
  const buffer = { kind: 'buffer' };
  const callerVao = { kind: 'caller-vao' };
  const callerBuffer = { kind: 'caller-buffer' };
  let boundVao = callerVao;
  let boundArrayBuffer = callerBuffer;
  const gl = {
    ARRAY_BUFFER: 0x8892,
    ARRAY_BUFFER_BINDING: 0x8894,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    VERTEX_ARRAY_BINDING: 0x85b5,
    createVertexArray() {
      calls.push(['createVertexArray']);
      return vao;
    },
    createBuffer() {
      calls.push(['createBuffer']);
      return buffer;
    },
    bindVertexArray(value) {
      boundVao = value;
      calls.push(['bindVertexArray', value]);
    },
    bindBuffer(target, value) {
      assert.equal(target, this.ARRAY_BUFFER);
      boundArrayBuffer = value;
      calls.push(['bindBuffer', target, value]);
    },
    bufferData(target, data, usage) {
      calls.push(['bufferData', target, Array.from(data), usage]);
    },
    enableVertexAttribArray(location) {
      calls.push(['enableVertexAttribArray', location]);
    },
    vertexAttribPointer(location, size, type, normalized, stride, offset) {
      calls.push([
        'vertexAttribPointer',
        location,
        size,
        type,
        normalized,
        stride,
        offset,
      ]);
    },
    getParameter(parameter) {
      if (parameter === this.ARRAY_BUFFER_BINDING) {
        return boundArrayBuffer;
      }
      if (parameter === this.VERTEX_ARRAY_BINDING) return boundVao;
      throw new RangeError(`Unexpected WebGL parameter ${parameter}.`);
    },
    deleteVertexArray() {},
    deleteBuffer() {},
  };
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    gl,
    _fullscreenVAO: null,
    _fullscreenAttrib0Buffer: null,
  });

  overlay._createFullscreenGeometry();

  assert.equal(overlay._fullscreenVAO, vao);
  assert.equal(overlay._fullscreenAttrib0Buffer, buffer);
  assert.ok(
    calls.some(
      call =>
        call[0] === 'bufferData' &&
        call[1] === gl.ARRAY_BUFFER &&
        call[2].join(',') === '0,1,2,3' &&
        call[3] === gl.STATIC_DRAW
    )
  );
  assert.ok(
    calls.some(
      call =>
        call[0] === 'vertexAttribPointer' &&
        call[1] === 0 &&
        call[2] === 1 &&
        call[3] === gl.FLOAT
    )
  );
  assert.ok(
    calls.some(
      call => call[0] === 'enableVertexAttribArray' && call[1] === 0
    )
  );
  assert.equal(boundVao, callerVao);
  assert.equal(boundArrayBuffer, callerBuffer);
});

test('fullscreen velocity shader actively consumes attribute zero', () => {
  assert.match(
    FULLSCREEN_VS,
    /layout\s*\(\s*location\s*=\s*0\s*\)\s*in\s+float\s+a_vertexId/
  );
  assert.match(FULLSCREEN_VS, /positions\s*\[\s*int\s*\(\s*a_vertexId\s*\)\s*\]/);
  assert.doesNotMatch(FULLSCREEN_VS, /gl_VertexID/);
});

test('velocity sampler initialization restores the exact caller program', () => {
  const callerProgram = { kind: 'caller-program' };
  const updateProgram = { kind: 'velocity-update-program' };
  const renderProgram = { kind: 'velocity-render-program' };
  const writes = [];
  let currentProgram = callerProgram;
  const gl = {
    CURRENT_PROGRAM: 0x8b8d,
    getParameter(parameter) {
      assert.equal(parameter, this.CURRENT_PROGRAM);
      return currentProgram;
    },
    uniform1i(location, value) {
      writes.push({ location, program: currentProgram, value });
    },
    useProgram(program) {
      currentProgram = program;
    },
  };
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    gl,
    _programRender: renderProgram,
    _programUpdate: updateProgram,
    _uniformsRender: {
      u_alphaTex: { kind: 'alpha-location' },
      u_colormapTex: { kind: 'colormap-location' },
    },
    _uniformsUpdate: {
      u_positionTex: { kind: 'position-location' },
      u_spawnTableTex: { kind: 'spawn-location' },
      u_velocityTex: { kind: 'velocity-location' },
    },
  });

  overlay._bindSamplers();

  assert.equal(currentProgram, callerProgram);
  assert.deepEqual(
    writes.map(({ program, value }) => [program, value]),
    [
      [updateProgram, 0],
      [updateProgram, 1],
      [updateProgram, 2],
      [renderProgram, 1],
      [renderProgram, 3],
    ],
  );
});

test('velocity simulation restores transform-feedback state after draw failure', () => {
  const drawFailure = new Error('synthetic transform-feedback draw failure');
  let rasterizerDiscard = false;
  let transformFeedback = null;
  let vertexArray = null;
  let transformFeedbackActive = false;
  let transformFeedbackBuffer = null;
  let endCalls = 0;
  const gl = {
    POINTS: 0,
    RASTERIZER_DISCARD: 0x8c89,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE2: 0x84c2,
    TEXTURE_2D: 0x0de1,
    TRANSFORM_FEEDBACK: 0x8e22,
    TRANSFORM_FEEDBACK_BUFFER: 0x8c8e,
    activeTexture() {},
    beginTransformFeedback() {
      transformFeedbackActive = true;
    },
    bindBufferBase(_target, _index, value) {
      transformFeedbackBuffer = value;
    },
    bindTexture() {},
    bindTransformFeedback(_target, value) {
      transformFeedback = value;
    },
    bindVertexArray(value) {
      vertexArray = value;
    },
    disable(capability) {
      assert.equal(capability, this.RASTERIZER_DISCARD);
      rasterizerDiscard = false;
    },
    drawArrays() {
      throw drawFailure;
    },
    enable(capability) {
      assert.equal(capability, this.RASTERIZER_DISCARD);
      rasterizerDiscard = true;
    },
    endTransformFeedback() {
      endCalls += 1;
      transformFeedbackActive = false;
    },
    uniform1f() {},
    uniform1i() {},
    useProgram() {},
  };
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    gl,
    _programUpdate: { id: 'update-program' },
    _transformFeedback: { id: 'transform-feedback' },
    _uniformsUpdate: {
      u_dropChanceFast: {},
      u_dropChanceSlow: {},
      u_dt: {},
      u_forceRespawn: {},
      u_lifetime: {},
      u_positionTexWidth: {},
      u_spawnTableSize: {},
      u_spawnTableWidth: {},
      u_speedMultiplier: {},
      u_time: {},
      u_turbulence: {},
      u_velocityBlend: {},
      u_velocityTexWidth: {},
    },
    config: {
      dropRate: 0,
      dropRateBump: 0,
      lifetime: 1,
      speedMultiplier: 1,
      turbulence: 0,
    },
  });
  const particleState = {
    activeParticleCount: 2,
    buffers: [{ id: 'read-buffer' }, { id: 'write-buffer' }],
    currentBuffer: 0,
    forceRespawn: true,
    lastAdvancedFrameId: -1,
    vaos: [{ id: 'read-vao' }, { id: 'write-vao' }],
  };

  assert.throws(
    () => overlay._simulate(
      0.016,
      { frameId: 1, time: 1 },
      { texture: {}, width: 2 },
      { texture: {}, width: 2 },
      { tableSize: 2, tableWidth: 2, textureInfo: { texture: {} } },
      particleState,
    ),
    error => error === drawFailure,
  );
  assert.equal(endCalls, 1);
  assert.equal(transformFeedbackActive, false);
  assert.equal(transformFeedbackBuffer, null);
  assert.equal(rasterizerDiscard, false);
  assert.equal(transformFeedback, null);
  assert.equal(vertexArray, null);
  assert.equal(particleState.currentBuffer, 0);
  assert.equal(particleState.forceRespawn, true);
  assert.equal(particleState.lastAdvancedFrameId, -1);
});

function createRenderFlowStateFixture() {
  const savedFramebuffer = { id: 'saved-framebuffer' };
  const flowFramebuffer = { id: 'flow-framebuffer' };
  let framebuffer = savedFramebuffer;
  let blend = true;
  let blendDestination = 0x0303;
  let blendSource = 0x0302;
  let depthTest = true;
  let depthWrite = true;
  let vertexArray = null;
  let scissorEnabled = true;
  let scissorBox = [37, 41, 640, 480];
  let viewport = [37, 41, 640, 480];
  let colorMask = [true, true, true, true];
  let blendEquation = 0x8006;
  let clearCalls = 0;
  let fadeCalls = 0;
  const gl = {
    BLEND: 0x0be2,
    COLOR: 0x1800,
    DEPTH_TEST: 0x0b71,
    DEPTH_WRITEMASK: 0x0b72,
    FRAMEBUFFER: 0x8d40,
    FRAMEBUFFER_BINDING: 0x8ca6,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    SRC_ALPHA: 0x0302,
    SCISSOR_TEST: 0x0c11,
    FUNC_ADD: 0x8006,
    bindFramebuffer(target, value) {
      assert.equal(target, this.FRAMEBUFFER);
      framebuffer = value;
    },
    bindVertexArray(value) {
      vertexArray = value;
    },
    blendFunc(source, destination) {
      blendSource = source;
      blendDestination = destination;
    },
    blendFuncSeparate(
      sourceRgb,
      destinationRgb,
      sourceAlpha,
      destinationAlpha,
    ) {
      assert.equal(sourceAlpha, this.ONE);
      assert.equal(destinationAlpha, this.ONE_MINUS_SRC_ALPHA);
      blendSource = sourceRgb;
      blendDestination = destinationRgb;
    },
    blendEquation(value) {
      blendEquation = value;
    },
    colorMask(...value) {
      colorMask = value;
    },
    clearBufferfv(target, drawBuffer, value) {
      assert.equal(target, this.COLOR);
      assert.equal(drawBuffer, 0);
      assert.deepEqual(Array.from(value), [0, 0, 0, 0]);
      clearCalls++;
    },
    depthMask(value) {
      depthWrite = value;
    },
    disable(capability) {
      if (capability === this.DEPTH_TEST) {
        depthTest = false;
        return;
      }
      if (capability === this.BLEND) {
        blend = false;
        return;
      }
      if (capability === this.SCISSOR_TEST) {
        scissorEnabled = false;
        return;
      }
      throw new RangeError(`Unexpected WebGL capability ${capability}.`);
    },
    enable(capability) {
      if (capability === this.DEPTH_TEST) {
        depthTest = true;
        return;
      }
      if (capability === this.BLEND) {
        blend = true;
        return;
      }
      if (capability === this.SCISSOR_TEST) {
        scissorEnabled = true;
        return;
      }
      throw new RangeError(`Unexpected WebGL capability ${capability}.`);
    },
    getParameter(parameter) {
      if (parameter === this.FRAMEBUFFER_BINDING) return framebuffer;
      if (parameter === this.DEPTH_WRITEMASK) return depthWrite;
      throw new RangeError(`Unexpected WebGL parameter ${parameter}.`);
    },
    isEnabled(capability) {
      if (capability === this.DEPTH_TEST) return depthTest;
      if (capability === this.BLEND) return blend;
      if (capability === this.SCISSOR_TEST) return scissorEnabled;
      throw new RangeError(`Unexpected WebGL capability ${capability}.`);
    },
    scissor(...value) {
      scissorBox = value;
    },
    viewport(...value) {
      viewport = value;
    },
  };
  const fbos = {
    bloom: [{}, {}],
    fbo: flowFramebuffer,
    trail: [{}, {}],
    trailFramebuffers: [flowFramebuffer, flowFramebuffer],
    bloomEnabled: false,
    height: 480,
    trailClearPending: false,
    trailIdx: 0,
    width: 640,
  };
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    gl,
    config: {
      bloomEnabled: false,
      bloomStrength: 0,
    },
    _ensureFBOs() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, flowFramebuffer);
      return fbos;
    },
    _passFade() {
      fadeCalls++;
      gl.bindFramebuffer(gl.FRAMEBUFFER, flowFramebuffer);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
    },
    _passRenderParticles() {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    },
    _passComposite() {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.depthMask(true);
    },
  });
  return {
    fbos,
    get clearCalls() {
      return clearCalls;
    },
    get fadeCalls() {
      return fadeCalls;
    },
    gl,
    overlay,
    readState: () => ({
      blend: gl.isEnabled(gl.BLEND),
      blendDestination,
      blendEquation,
      blendSource,
      colorMask,
      depthTest: gl.isEnabled(gl.DEPTH_TEST),
      depthWrite: gl.getParameter(gl.DEPTH_WRITEMASK),
      framebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING),
      scissorBox,
      scissorEnabled,
      vertexArray,
      viewport,
    }),
    savedFramebuffer,
    context: {
      deltaTime: 1 / 60,
      outputFramebuffer: savedFramebuffer,
      scissorEnabled: true,
      viewportHeight: 480,
      viewportWidth: 640,
      viewportX: 37,
      viewportY: 41,
    },
  };
}

test('velocity flow consumes repeated history invalidations with one deferred clear', () => {
  const fixture = createRenderFlowStateFixture();
  fixture.fbos.trailClearPending = true;
  // Repeated hot input only republishes the same pending generation bit.
  fixture.overlay._scheduleTrailClear = (
    VelocityOverlay.prototype._scheduleTrailClear
  );
  fixture.overlay._fboByView = new Map([['live', fixture.fbos]]);
  fixture.overlay._scheduleTrailClear('live');
  fixture.overlay._scheduleTrailClear('live');

  fixture.overlay._renderFlow(
    fixture.context,
    {},
    'live',
    { cameraMotionAmount: 0 },
    {},
  );

  assert.equal(fixture.clearCalls, 1);
  assert.equal(fixture.fadeCalls, 0);
  assert.equal(fixture.fbos.trailClearPending, false);

  fixture.overlay._renderFlow(
    fixture.context,
    {},
    'live',
    { cameraMotionAmount: 0 },
    {},
  );

  assert.equal(fixture.clearCalls, 1);
  assert.equal(fixture.fadeCalls, 1);
});

test('velocity flow restores framebuffer and depth state after success', () => {
  const fixture = createRenderFlowStateFixture();
  const stateBefore = fixture.readState();

  fixture.overlay._renderFlow(
    fixture.context,
    {},
    'live',
    { cameraMotionAmount: 0 },
    {},
  );

  assert.deepEqual(fixture.readState(), stateBefore);
  assert.equal(fixture.fbos.trailIdx, 1);
});

test('velocity flow restores framebuffer and depth state after particle failure', () => {
  const fixture = createRenderFlowStateFixture();
  const failure = new Error('particle pass failed');
  const stateBefore = fixture.readState();
  fixture.overlay._passRenderParticles = () => {
    fixture.gl.bindFramebuffer(
      fixture.gl.FRAMEBUFFER,
      { id: 'failed-particle-framebuffer' },
    );
    fixture.gl.enable(fixture.gl.BLEND);
    fixture.gl.blendFunc(fixture.gl.ONE, fixture.gl.ONE);
    fixture.gl.bindVertexArray({ id: 'failed-particle-vao' });
    fixture.gl.depthMask(false);
    throw failure;
  };

  assert.throws(
    () => fixture.overlay._renderFlow(
      fixture.context,
      {},
      'live',
      { cameraMotionAmount: 0 },
      {},
    ),
    error => error === failure,
  );
  assert.deepEqual(fixture.readState(), stateBefore);
  assert.equal(fixture.fbos.trailIdx, 0);
});

test('velocity flow restores framebuffer and depth state after composite failure', () => {
  const fixture = createRenderFlowStateFixture();
  const failure = new Error('composite pass failed');
  const stateBefore = fixture.readState();
  fixture.overlay._passComposite = () => {
    fixture.gl.disable(fixture.gl.BLEND);
    fixture.gl.bindVertexArray({ id: 'failed-composite-vao' });
    fixture.gl.depthMask(false);
    throw failure;
  };

  assert.throws(
    () => fixture.overlay._renderFlow(
      fixture.context,
      {},
      'live',
      { cameraMotionAmount: 0 },
      {},
    ),
    error => error === failure,
  );
  assert.deepEqual(fixture.readState(), stateBefore);
  assert.equal(fixture.fbos.trailIdx, 0);
});

test('velocity flow attempts every restoration and retains the pass failure', () => {
  const fixture = createRenderFlowStateFixture();
  const passFailure = new Error('particle pass failed first');
  const framebufferFailure = new Error('framebuffer restoration failed');
  const depthFailure = new Error('depth restoration failed');
  const originalBindFramebuffer =
    fixture.gl.bindFramebuffer.bind(fixture.gl);
  const originalEnable = fixture.gl.enable.bind(fixture.gl);
  const restorationAttempts = [];

  fixture.overlay._passRenderParticles = () => {
    throw passFailure;
  };
  fixture.gl.bindFramebuffer = (target, value) => {
    if (value === fixture.savedFramebuffer) {
      restorationAttempts.push('framebuffer');
      throw framebufferFailure;
    }
    originalBindFramebuffer(target, value);
  };
  fixture.gl.enable = capability => {
    if (capability === fixture.gl.DEPTH_TEST) {
      restorationAttempts.push('depth');
      throw depthFailure;
    }
    if (capability === fixture.gl.BLEND) {
      restorationAttempts.push('blend');
    }
    originalEnable(capability);
  };
  const originalDepthMask = fixture.gl.depthMask.bind(fixture.gl);
  fixture.gl.depthMask = value => {
    restorationAttempts.push('depth-mask');
    originalDepthMask(value);
  };
  const originalBindVertexArray =
    fixture.gl.bindVertexArray.bind(fixture.gl);
  fixture.gl.bindVertexArray = value => {
    restorationAttempts.push('vertex-array');
    originalBindVertexArray(value);
  };

  assert.throws(
    () => fixture.overlay._renderFlow(
      fixture.context,
      {},
      'live',
      { cameraMotionAmount: 0 },
      {},
    ),
    error => (
      error instanceof AggregateError &&
      error.errors.length === 3 &&
      error.errors[0] === passFailure &&
      error.errors[1] === framebufferFailure &&
      error.errors[2] === depthFailure
    ),
  );
  assert.deepEqual(restorationAttempts, [
    'framebuffer',
    'vertex-array',
    'depth-mask',
    'blend',
    'depth',
  ]);
  assert.deepEqual(fixture.readState(), {
    blend: true,
    blendDestination: fixture.gl.ONE_MINUS_SRC_ALPHA,
    blendEquation: fixture.gl.FUNC_ADD,
    blendSource: fixture.gl.SRC_ALPHA,
    colorMask: [true, true, true, true],
    depthTest: false,
    depthWrite: true,
    framebuffer: { id: 'flow-framebuffer' },
    scissorBox: [37, 41, 640, 480],
    scissorEnabled: true,
    vertexArray: null,
    viewport: [37, 41, 640, 480],
  });
});
