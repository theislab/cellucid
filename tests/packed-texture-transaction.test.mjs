import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOrUpdatePackedFloatTexture,
  createOrUpdatePackedUintTexture,
} from '../assets/js/rendering/overlays/shared/packed-texture.js';

function createFakeGl() {
  let nextId = 1;
  let binding = null;
  let unpackAlignment = 4;
  let pixelUnpackBuffer = null;
  let error = 0;
  let isTextureCalls = 0;
  const textures = new Set();
  const deleted = [];
  const uploads = [];
  const gl = {
    NO_ERROR: 0,
    MAX_TEXTURE_SIZE: 0x0D33,
    TEXTURE_BINDING_2D: 0x8069,
    UNPACK_ALIGNMENT: 0x0CF5,
    PIXEL_UNPACK_BUFFER: 0x88EC,
    PIXEL_UNPACK_BUFFER_BINDING: 0x88EF,
    TEXTURE_2D: 0x0DE1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812F,
    R32F: 0x822E,
    RG32F: 0x8230,
    RGB32F: 0x8815,
    RGBA32F: 0x8814,
    R32UI: 0x8236,
    RED: 0x1903,
    RG: 0x8227,
    RGB: 0x1907,
    RGBA: 0x1908,
    RED_INTEGER: 0x8D94,
    FLOAT: 0x1406,
    UNSIGNED_INT: 0x1405,
    failUpload: false,
    failDeleteTexture: null,
    deleteThenThrowTexture: null,
    throwIsTextureAt: -1,
    createTexture() {
      const texture = { id: nextId++ };
      textures.add(texture);
      return texture;
    },
    isTexture(texture) {
      isTextureCalls += 1;
      if (isTextureCalls === gl.throwIsTextureAt) {
        throw new Error('synthetic texture ownership inspection failure');
      }
      return textures.has(texture);
    },
    deleteTexture(texture) {
      if (texture === gl.failDeleteTexture) {
        throw new Error(
          'synthetic packed-texture retirement failure'
        );
      }
      textures.delete(texture);
      deleted.push(texture);
      if (binding === texture) binding = null;
      if (texture === gl.deleteThenThrowTexture) {
        throw new Error(
          'synthetic post-delete packed-texture wrapper failure'
        );
      }
    },
    bindTexture(target, texture) {
      assert.equal(target, gl.TEXTURE_2D);
      if (texture !== null && !textures.has(texture)) {
        throw new TypeError('binding unknown texture');
      }
      binding = texture;
    },
    bindBuffer(target, buffer) {
      assert.equal(target, gl.PIXEL_UNPACK_BUFFER);
      pixelUnpackBuffer = buffer;
    },
    getParameter(parameter) {
      if (parameter === gl.MAX_TEXTURE_SIZE) return 4;
      if (parameter === gl.TEXTURE_BINDING_2D) return binding;
      if (parameter === gl.UNPACK_ALIGNMENT) return unpackAlignment;
      if (parameter === gl.PIXEL_UNPACK_BUFFER_BINDING) {
        return pixelUnpackBuffer;
      }
      throw new TypeError(`unexpected parameter ${parameter}`);
    },
    getError() {
      const published = error;
      error = gl.NO_ERROR;
      return published;
    },
    pixelStorei(parameter, value) {
      assert.equal(parameter, gl.UNPACK_ALIGNMENT);
      unpackAlignment = value;
    },
    texParameteri() {},
    texImage2D(...args) {
      uploads.push({
        kind: 'allocate',
        args,
        pixelUnpackBuffer
      });
    },
    texSubImage2D(...args) {
      if (gl.failUpload) {
        throw new Error('synthetic packed-texture upload failure');
      }
      uploads.push({
        kind: 'row',
        args,
        pixelUnpackBuffer
      });
    },
    _state: {
      deleted,
      textures,
      uploads,
      get binding() {
        return binding;
      },
      get unpackAlignment() {
        return unpackAlignment;
      },
      get pixelUnpackBuffer() {
        return pixelUnpackBuffer;
      },
    },
  };
  return gl;
}

test('packed float replacement preserves the published texture on upload failure', () => {
  const gl = createFakeGl();
  const existing = gl.createTexture();
  const priorPixelUnpackBuffer = { id: 'prior-pixel-unpack-buffer' };
  gl.bindTexture(gl.TEXTURE_2D, existing);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, priorPixelUnpackBuffer);
  gl.failUpload = true;

  assert.throws(
    () => createOrUpdatePackedFloatTexture(gl, {
      components: 3,
      data: new Float32Array(15),
      itemCount: 5,
      texture: existing,
    }),
    /synthetic packed-texture upload failure/,
  );

  assert.equal(gl.isTexture(existing), true);
  assert.equal(gl._state.binding, existing);
  assert.equal(gl._state.unpackAlignment, 4);
  assert.equal(
    gl._state.pixelUnpackBuffer,
    priorPixelUnpackBuffer
  );
  assert.equal(gl._state.textures.size, 1);
  assert.equal(gl._state.deleted.length, 1);
  assert.notEqual(gl._state.deleted[0], existing);
  assert.equal(
    gl._state.uploads.every(
      entry => entry.pixelUnpackBuffer === null
    ),
    true
  );
});

test('packed uint replacement commits once and preserves the binding role', () => {
  const gl = createFakeGl();
  const existing = gl.createTexture();
  const priorPixelUnpackBuffer = { id: 'prior-pixel-unpack-buffer' };
  gl.bindTexture(gl.TEXTURE_2D, existing);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, priorPixelUnpackBuffer);

  const published = createOrUpdatePackedUintTexture(gl, {
    data: Uint32Array.from([3, 1, 4, 1, 5]),
    itemCount: 5,
    texture: existing,
  });

  assert.equal(gl.isTexture(existing), false);
  assert.equal(gl.isTexture(published.texture), true);
  assert.equal(gl._state.binding, published.texture);
  assert.equal(gl._state.unpackAlignment, 4);
  assert.equal(
    gl._state.pixelUnpackBuffer,
    priorPixelUnpackBuffer
  );
  assert.equal(
    gl._state.uploads.every(
      entry => entry.pixelUnpackBuffer === null
    ),
    true
  );
  assert.deepEqual(
    gl._state.uploads
      .filter((entry) => entry.kind === 'row')
      .map((entry) => entry.args[4]),
    [4, 1],
  );
});

test('packed replacement rolls back when retiring the existing texture fails', () => {
  const gl = createFakeGl();
  const existing = gl.createTexture();
  const priorPixelUnpackBuffer = { id: 'prior-pixel-unpack-buffer' };
  gl.bindTexture(gl.TEXTURE_2D, existing);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, priorPixelUnpackBuffer);
  gl.failDeleteTexture = existing;

  assert.throws(
    () => createOrUpdatePackedUintTexture(gl, {
      data: Uint32Array.from([2, 7, 1, 8]),
      itemCount: 4,
      texture: existing,
    }),
    /synthetic packed-texture retirement failure/,
  );

  assert.equal(gl.isTexture(existing), true);
  assert.equal(gl._state.binding, existing);
  assert.equal(gl._state.unpackAlignment, 4);
  assert.equal(
    gl._state.pixelUnpackBuffer,
    priorPixelUnpackBuffer
  );
  assert.equal(gl._state.textures.size, 1);
  assert.equal(gl._state.deleted.length, 1);
  assert.notEqual(gl._state.deleted[0], existing);
});

test('packed replacement remains published when a wrapper throws after deleting the old texture', () => {
  const gl = createFakeGl();
  const existing = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, existing);
  gl.deleteThenThrowTexture = existing;

  const published = createOrUpdatePackedUintTexture(gl, {
    data: Uint32Array.from([2, 7, 1, 8]),
    itemCount: 4,
    texture: existing,
  });

  assert.equal(gl.isTexture(existing), false);
  assert.equal(gl.isTexture(published.texture), true);
  assert.equal(gl._state.binding, published.texture);
  assert.equal(gl._state.textures.size, 1);
  assert.deepEqual(gl._state.deleted, [existing]);
});

test('ambiguous packed retirement inspection still cleans the unpublished candidate', () => {
  const gl = createFakeGl();
  const existing = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, existing);
  gl.failDeleteTexture = existing;
  gl.throwIsTextureAt = 2;

  assert.throws(
    () => createOrUpdatePackedUintTexture(gl, {
      data: Uint32Array.from([2, 7, 1, 8]),
      itemCount: 4,
      texture: existing,
    }),
    /candidate cleanup was attempted/,
  );

  assert.equal(gl.isTexture(existing), true);
  assert.equal(gl._state.textures.size, 1);
  assert.equal(gl._state.deleted.length, 1);
  assert.notEqual(gl._state.deleted[0], existing);
});

test('packed texture validation rejects before allocating GPU state', () => {
  const gl = createFakeGl();
  assert.throws(
    () => createOrUpdatePackedFloatTexture(gl, {
      components: 3,
      data: new Float32Array(3),
      itemCount: 2,
      texture: null,
    }),
    /exactly 6 values/,
  );
  assert.equal(gl._state.textures.size, 0);
  assert.equal(gl._state.uploads.length, 0);
});
