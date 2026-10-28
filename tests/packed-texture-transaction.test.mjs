import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOrUpdatePackedFloatTexture,
  createOrUpdatePackedUintTexture,
  createOrUpdatePackedVisibilityTexture,
} from '../assets/js/rendering/overlays/shared/packed-texture.js';

function createFakeGl() {
  let nextId = 1;
  let binding = null;
  let unpackAlignment = 4;
  let pixelUnpackBuffer = null;
  let error = 0;
  let getErrorCalls = 0;
  const textures = new Set();
  const deleted = [];
  const uploads = [];
  const gl = {
    NO_ERROR: 0,
    MAX_TEXTURE_SIZE: 0x0D33,
    MAX_ARRAY_TEXTURE_LAYERS: 0x88FF,
    TEXTURE_BINDING_2D_ARRAY: 0x8C1D,
    TEXTURE_2D_ARRAY: 0x8C1A,
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
    R8UI: 0x8232,
    UNSIGNED_BYTE: 0x1401,
    RED: 0x1903,
    RG: 0x8227,
    RGB: 0x1907,
    RGBA: 0x1908,
    RED_INTEGER: 0x8D94,
    FLOAT: 0x1406,
    UNSIGNED_INT: 0x1405,
    failUpload: false,
    contextLost: false,
    createTexture() {
      const texture = { id: nextId++ };
      textures.add(texture);
      return texture;
    },
    isTexture(texture) {
      return textures.has(texture);
    },
    isContextLost() {
      return gl.contextLost;
    },
    deleteTexture(texture) {
      textures.delete(texture);
      deleted.push(texture);
      if (binding === texture) binding = null;
    },
    bindTexture(target, texture) {
      // Packed per-cell textures are linear textures (2D arrays).
      assert.equal(target, gl.TEXTURE_2D_ARRAY);
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
      if (parameter === gl.MAX_ARRAY_TEXTURE_LAYERS) return 256;
      if (parameter === gl.TEXTURE_BINDING_2D_ARRAY) return binding;
      if (parameter === gl.UNPACK_ALIGNMENT) return unpackAlignment;
      if (parameter === gl.PIXEL_UNPACK_BUFFER_BINDING) {
        return pixelUnpackBuffer;
      }
      throw new TypeError(`unexpected parameter ${parameter}`);
    },
    getError() {
      getErrorCalls += 1;
      const published = error;
      error = gl.NO_ERROR;
      return published;
    },
    raise(code) {
      error = code;
    },
    pixelStorei(parameter, value) {
      assert.equal(parameter, gl.UNPACK_ALIGNMENT);
      unpackAlignment = value;
    },
    texParameteri() {},
    texStorage3D(...args) {
      uploads.push({
        kind: 'allocate',
        args,
        pixelUnpackBuffer
      });
    },
    // (target, level, x, y, layer, width, rows, depth, format, type, data, srcOffset)
    texSubImage3D(...args) {
      if (gl.failUpload) {
        throw new Error('synthetic packed-texture upload failure');
      }
      const [, , , , , width, rows, , format, , data, srcOffset = 0] = args;
      const components = format === gl.RGB ? 3 : format === gl.RG ? 2 : format === gl.RGBA ? 4 : 1;
      uploads.push({
        kind: 'row',
        args,
        width,
        values: data.subarray(srcOffset, srcOffset + width * rows * components),
        pixelUnpackBuffer
      });
    },
    _state: {
      get getErrorCalls() {
        return getErrorCalls;
      },
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

function publish(gl, texture, values) {
  return createOrUpdatePackedFloatTexture(gl, {
    components: 1,
    data: Float32Array.from(values),
    itemCount: values.length,
    texture,
    allocationCheck: 'now',
  });
}

test('a packed texture of the same shape is rewritten in place without reading the error queue', () => {
  const gl = createFakeGl();
  const first = publish(gl, null, [1, 2, 3, 4, 5]);
  assert.equal(gl._state.getErrorCalls, 1);
  const allocations = gl._state.uploads.filter(entry => entry.kind === 'allocate').length;

  const second = publish(gl, first, [6, 7, 8, 9, 10]);

  assert.equal(second, first);
  assert.equal(gl._state.getErrorCalls, 1, 'an in-place rewrite reads no error');
  assert.equal(
    gl._state.uploads.filter(entry => entry.kind === 'allocate').length,
    allocations,
    'an in-place rewrite allocates nothing'
  );
  assert.deepEqual(gl._state.deleted, []);
  assert.deepEqual(
    gl._state.uploads.slice(-2).map(entry => [...entry.values]),
    [[6, 7, 8, 9], [10]]
  );
});

test('a new shape allocates once, reads the error queue once, and leaves the replaced texture to its owner', () => {
  const gl = createFakeGl();
  const priorPixelUnpackBuffer = { id: 'prior-pixel-unpack-buffer' };
  const first = publish(gl, null, [1, 2, 3]);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, first.texture);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, priorPixelUnpackBuffer);

  const second = publish(gl, first, [1, 2, 3, 4, 5]);

  assert.notEqual(second.texture, first.texture);
  assert.equal(gl.isTexture(first.texture), true);
  assert.equal(gl.isTexture(second.texture), true);
  assert.equal(gl._state.getErrorCalls, 2);
  assert.equal(gl._state.binding, first.texture);
  assert.equal(gl._state.unpackAlignment, 4);
  assert.equal(gl._state.pixelUnpackBuffer, priorPixelUnpackBuffer);
  assert.equal(
    gl._state.uploads.every(entry => entry.pixelUnpackBuffer === null),
    true
  );
});

test('a refused allocation is deleted and the replaced texture stays published', () => {
  const gl = createFakeGl();
  const first = publish(gl, null, [1, 2, 3]);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, first.texture);
  const texStorage3D = gl.texStorage3D;
  gl.texStorage3D = (...args) => {
    texStorage3D(...args);
    gl.raise(0x0505);
  };

  assert.throws(() => publish(gl, first, [1, 2, 3, 4, 5]), /0x505/);

  assert.equal(gl.isTexture(first.texture), true);
  assert.equal(gl._state.textures.size, 1);
  assert.equal(gl._state.deleted.length, 1);
  assert.notEqual(gl._state.deleted[0], first.texture);
  assert.equal(gl._state.binding, first.texture);
  assert.equal(gl._state.unpackAlignment, 4);
});

test('an upload failure deletes the candidate and restores the unpack state', () => {
  const gl = createFakeGl();
  const existing = publish(gl, null, [1, 2]);
  const priorPixelUnpackBuffer = { id: 'prior-pixel-unpack-buffer' };
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, existing.texture);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, priorPixelUnpackBuffer);
  gl.failUpload = true;

  assert.throws(
    () => createOrUpdatePackedFloatTexture(gl, {
      components: 3,
      data: new Float32Array(15),
      itemCount: 5,
      texture: existing,
      allocationCheck: 'now',
    }),
    /synthetic packed-texture upload failure/,
  );

  assert.equal(gl.isTexture(existing.texture), true);
  assert.equal(gl._state.binding, existing.texture);
  assert.equal(gl._state.unpackAlignment, 4);
  assert.equal(gl._state.pixelUnpackBuffer, priorPixelUnpackBuffer);
  assert.equal(gl._state.textures.size, 1);
});

test('a lost context refuses an in-place rewrite by name', () => {
  const gl = createFakeGl();
  const visibility = createOrUpdatePackedVisibilityTexture(gl, {
    data: Uint8Array.from([1, 0, 1]),
    itemCount: 3,
    texture: null,
    allocationCheck: 'now',
  });
  gl.contextLost = true;
  assert.throws(
    () => createOrUpdatePackedVisibilityTexture(gl, {
      data: Uint8Array.from([0, 1, 1]),
      itemCount: 3,
      texture: visibility,
      allocationCheck: 'now',
    }),
    error => error.name === 'WebGLContextLostError',
  );
});

test('a packed uint table is shaped for its capacity and keeps its storage when refilled with fewer items', () => {
  const gl = createFakeGl();
  const full = createOrUpdatePackedUintTexture(gl, {
    capacity: 6,
    data: Uint32Array.from([3, 1, 4, 1, 5, 9]),
    itemCount: 6,
    texture: null,
    allocationCheck: 'now',
  });
  assert.deepEqual([full.plan.width, full.plan.rows, full.plan.layers], [4, 2, 1]);

  const partial = createOrUpdatePackedUintTexture(gl, {
    capacity: 6,
    data: Uint32Array.from([2, 7, 1]),
    itemCount: 3,
    texture: full,
    allocationCheck: 'now',
  });

  assert.equal(partial, full);
  assert.equal(gl._state.getErrorCalls, 1);
  assert.deepEqual(
    gl._state.uploads
      .filter(entry => entry.kind === 'row')
      .map(entry => entry.width),
    [4, 2, 3],
  );
  assert.throws(
    () => createOrUpdatePackedUintTexture(gl, {
      capacity: 2,
      data: Uint32Array.from([2, 7, 1]),
      itemCount: 3,
      texture: null,
      allocationCheck: 'now',
    }),
    /capacity must be a safe integer of at least 3/,
  );
});

test('packed texture validation rejects before allocating GPU state', () => {
  const gl = createFakeGl();
  assert.throws(
    () => createOrUpdatePackedFloatTexture(gl, {
      components: 3,
      data: new Float32Array(3),
      itemCount: 2,
      texture: null,
      allocationCheck: 'now',
    }),
    /exactly 6 values/,
  );
  assert.equal(gl._state.textures.size, 0);
  assert.equal(gl._state.uploads.length, 0);
});

test('an allocation checked by its caller reads nothing, so several share one read', () => {
  const gl = createFakeGl();
  const visibility = createOrUpdatePackedVisibilityTexture(gl, {
    allocationCheck: 'caller',
    data: Uint8Array.from([1, 0, 1]),
    itemCount: 3,
    texture: null,
  });
  const table = createOrUpdatePackedUintTexture(gl, {
    allocationCheck: 'caller',
    capacity: 4,
    data: Uint32Array.from([0, 2]),
    itemCount: 2,
    texture: null,
  });
  assert.equal(gl._state.getErrorCalls, 0);
  assert.equal(gl.isTexture(visibility.texture), true);
  assert.equal(gl.isTexture(table.texture), true);
  assert.throws(
    () => createOrUpdatePackedVisibilityTexture(gl, {
      allocationCheck: 'later',
      data: Uint8Array.from([1]),
      itemCount: 1,
      texture: null,
    }),
    /allocationCheck must be exactly 'now' or 'caller'/,
  );
});

test('a packed texture holds more items than MAX_TEXTURE_SIZE squared, in layers', () => {
  // MAX_TEXTURE_SIZE 4 caps a 2D texture at 16 items; a linear texture of
  // 4-texel rows stacks them in layers of 4 rows.
  const gl = createFakeGl();
  const values = Array.from({ length: 37 }, (_, index) => index + 0.5);
  const texture = publish(gl, null, values);
  assert.deepEqual([texture.plan.width, texture.plan.rowsPerLayer, texture.plan.layers], [4, 4, 3]);
  const written = gl._state.uploads.filter(entry => entry.kind === 'row').flatMap(entry => [...entry.values]);
  assert.deepEqual(written, values);
});
