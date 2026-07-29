import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateEdgeTextureDimensions,
  drainExactTextureRetirements,
  encodeEdgeVisibilityByte,
  runExactEdgeTextureUpload,
} from '../assets/js/rendering/viewer.js';

function adjacentFloat32(value, direction) {
  const floats = new Float32Array(1);
  const bits = new Uint32Array(floats.buffer);
  floats[0] = value;
  bits[0] += direction;
  return floats[0];
}

function createUnpackGl() {
  const gl = {
    NO_ERROR: 0,
    INVALID_OPERATION: 0x0502,
    TEXTURE_2D: 0x0de1,
    TEXTURE_BINDING_2D: 0x8069,
    PIXEL_UNPACK_BUFFER: 0x88ec,
    PIXEL_UNPACK_BUFFER_BINDING: 0x88ef,
    UNPACK_ALIGNMENT: 0x0cf5,
    UNPACK_ROW_LENGTH: 0x0cf2,
    UNPACK_IMAGE_HEIGHT: 0x806e,
    UNPACK_SKIP_PIXELS: 0x0cf4,
    UNPACK_SKIP_ROWS: 0x0cf3,
    UNPACK_SKIP_IMAGES: 0x806d,
  };
  const sentinelTexture = Object.freeze({ id: 'sentinel-texture' });
  const sentinelPbo = Object.freeze({ id: 'sentinel-pbo' });
  let boundTexture = sentinelTexture;
  let boundPbo = sentinelPbo;
  let pendingError = gl.NO_ERROR;
  const pixelStore = new Map([
    [gl.UNPACK_ALIGNMENT, 8],
    [gl.UNPACK_ROW_LENGTH, 19],
    [gl.UNPACK_IMAGE_HEIGHT, 23],
    [gl.UNPACK_SKIP_PIXELS, 3],
    [gl.UNPACK_SKIP_ROWS, 5],
    [gl.UNPACK_SKIP_IMAGES, 7],
  ]);
  Object.assign(gl, {
    bindBuffer(target, buffer) {
      assert.equal(target, this.PIXEL_UNPACK_BUFFER);
      boundPbo = buffer;
    },
    bindTexture(target, texture) {
      assert.equal(target, this.TEXTURE_2D);
      boundTexture = texture;
    },
    getError() {
      const error = pendingError;
      pendingError = this.NO_ERROR;
      return error;
    },
    getParameter(parameter) {
      if (parameter === this.TEXTURE_BINDING_2D) return boundTexture;
      if (parameter === this.PIXEL_UNPACK_BUFFER_BINDING) {
        return boundPbo;
      }
      if (pixelStore.has(parameter)) return pixelStore.get(parameter);
      throw new TypeError(`Unexpected GL parameter ${parameter}.`);
    },
    pixelStorei(parameter, value) {
      assert.equal(pixelStore.has(parameter), true);
      pixelStore.set(parameter, value);
    },
    _setError(error) {
      pendingError = error;
    },
    _snapshot() {
      return {
        boundPbo,
        boundTexture,
        pixelStore: new Map(pixelStore),
      };
    },
  });
  return {
    candidateTexture: Object.freeze({ id: 'candidate-texture' }),
    gl,
    sentinelPbo,
    sentinelTexture,
  };
}

test('binary R8 visibility is exactly equivalent at the Float32 threshold', () => {
  const below = adjacentFloat32(0.5, -1);
  const above = adjacentFloat32(0.5, 1);
  assert.ok(below < 0.5);
  assert.ok(above > 0.5);

  for (const value of [0, -0, below]) {
    assert.equal(encodeEdgeVisibilityByte(value), 0);
  }
  for (const value of [0.5, above, 1]) {
    assert.equal(encodeEdgeVisibilityByte(value), 255);
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => encodeEdgeVisibilityByte(value),
      /finite Float32/
    );
  }
  for (const value of [
    -1.401298464324817e-45,
    adjacentFloat32(1, 1),
  ]) {
    assert.throws(
      () => encodeEdgeVisibilityByte(value),
      /between 0 and 1/
    );
  }
});

test('30M allocation arithmetic proves pooled RGB32F and R8 savings', () => {
  const pointCount = 30_000_000;
  const [width, height] = calculateEdgeTextureDimensions(
    pointCount,
    16_384
  );
  assert.deepEqual([width, height], [5478, 5477]);
  const texels = width * height;
  assert.equal(texels, 30_003_006);

  const sharedPositionBytes = texels * 3 * Float32Array.BYTES_PER_ELEMENT;
  const oldVisibilityCpuAndGpuBytes =
    texels * 2 * Float32Array.BYTES_PER_ELEMENT;
  const r8VisibilityCpuAndGpuBytes =
    texels * 2 * Uint8Array.BYTES_PER_ELEMENT;

  assert.equal(
    sharedPositionBytes,
    360_036_072,
    'each additional same-generation view avoids one padded RGB32F texture'
  );
  assert.equal(
    oldVisibilityCpuAndGpuBytes - r8VisibilityCpuAndGpuBytes,
    180_018_036
  );
  assert.equal(
    r8VisibilityCpuAndGpuBytes * 4,
    oldVisibilityCpuAndGpuBytes
  );
});

test('edge upload transaction neutralizes and restores every unpack owner', () => {
  const fixture = createUnpackGl();
  const before = fixture.gl._snapshot();
  runExactEdgeTextureUpload(
    fixture.gl,
    fixture.candidateTexture,
    'hostile unpack proof',
    () => {
      const during = fixture.gl._snapshot();
      assert.strictEqual(
        during.boundTexture,
        fixture.candidateTexture
      );
      assert.equal(during.boundPbo, null);
      assert.equal(
        during.pixelStore.get(fixture.gl.UNPACK_ALIGNMENT),
        1
      );
      for (const parameter of [
        fixture.gl.UNPACK_ROW_LENGTH,
        fixture.gl.UNPACK_IMAGE_HEIGHT,
        fixture.gl.UNPACK_SKIP_PIXELS,
        fixture.gl.UNPACK_SKIP_ROWS,
        fixture.gl.UNPACK_SKIP_IMAGES,
      ]) {
        assert.equal(during.pixelStore.get(parameter), 0);
      }
    }
  );
  const after = fixture.gl._snapshot();
  assert.strictEqual(after.boundTexture, fixture.sentinelTexture);
  assert.strictEqual(after.boundPbo, fixture.sentinelPbo);
  assert.deepEqual(after.pixelStore, before.pixelStore);

  assert.throws(
    () => runExactEdgeTextureUpload(
      fixture.gl,
      fixture.candidateTexture,
      'hostile upload failure',
      () => {
        fixture.gl._setError(fixture.gl.INVALID_OPERATION);
      }
    ),
    /WebGL error/
  );
  const afterFailure = fixture.gl._snapshot();
  assert.strictEqual(
    afterFailure.boundTexture,
    fixture.sentinelTexture
  );
  assert.strictEqual(afterFailure.boundPbo, fixture.sentinelPbo);
  assert.deepEqual(afterFailure.pixelStore, before.pixelStore);
  assert.equal(fixture.gl.getError(), fixture.gl.NO_ERROR);
});

test('texture retirement retries pre-delete failures but settles delete-then-throw', () => {
  const beforeDelete = Object.freeze({ id: 'before-delete' });
  const afterDelete = Object.freeze({ id: 'after-delete' });
  const live = new Set([beforeDelete, afterDelete]);
  const attempts = new Map();
  const gl = {
    deleteTexture(texture) {
      attempts.set(texture, (attempts.get(texture) ?? 0) + 1);
      if (texture === beforeDelete && attempts.get(texture) === 1) {
        throw new Error('synthetic pre-delete failure');
      }
      live.delete(texture);
      if (texture === afterDelete) {
        throw new Error('synthetic delete-then-throw wrapper');
      }
    },
    isTexture(texture) {
      return live.has(texture);
    },
  };
  const pending = new Set([beforeDelete, afterDelete]);

  const firstFailures = drainExactTextureRetirements(gl, pending);
  assert.equal(firstFailures.length, 1);
  assert.match(firstFailures[0].message, /pre-delete/);
  assert.deepEqual(Array.from(pending), [beforeDelete]);
  assert.equal(live.has(afterDelete), false);

  assert.deepEqual(drainExactTextureRetirements(gl, pending), []);
  assert.equal(pending.size, 0);
  assert.equal(live.size, 0);
  assert.equal(attempts.get(beforeDelete), 2);
  assert.equal(attempts.get(afterDelete), 1);
});
