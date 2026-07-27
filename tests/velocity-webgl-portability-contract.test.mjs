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
  let nextId = 1;

  const gl = {
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
    getExtension(name) {
      requestedExtensions.push(name);
      return extensionSupport[name] === true ? { name } : null;
    },
    createTexture() {
      return { kind: 'texture', id: nextId++ };
    },
    bindTexture() {},
    texImage2D(_target, _level, internalFormat) {
      textureFormats.push(internalFormat);
    },
    texParameteri(_target, parameter, value) {
      textureParameters.push([parameter, value]);
    },
    createFramebuffer() {
      return { kind: 'framebuffer', id: nextId++ };
    },
    bindFramebuffer() {},
    framebufferTexture2D() {},
    checkFramebufferStatus() {
      return gl.FRAMEBUFFER_COMPLETE;
    },
    deleteFramebuffer() {},
    deleteTexture() {},
  };

  return {
    gl,
    requestedExtensions,
    textureFormats,
    textureParameters,
  };
}

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

test('fullscreen velocity passes own an enabled attribute-zero array', () => {
  const calls = [];
  const vao = { kind: 'vao' };
  const buffer = { kind: 'buffer' };
  const gl = {
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    createVertexArray() {
      calls.push(['createVertexArray']);
      return vao;
    },
    createBuffer() {
      calls.push(['createBuffer']);
      return buffer;
    },
    bindVertexArray(value) {
      calls.push(['bindVertexArray', value]);
    },
    bindBuffer(target, value) {
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
});

test('fullscreen velocity shader actively consumes attribute zero', () => {
  assert.match(
    FULLSCREEN_VS,
    /layout\s*\(\s*location\s*=\s*0\s*\)\s*in\s+float\s+a_vertexId/
  );
  assert.match(FULLSCREEN_VS, /positions\s*\[\s*int\s*\(\s*a_vertexId\s*\)\s*\]/);
  assert.doesNotMatch(FULLSCREEN_VS, /gl_VertexID/);
});
