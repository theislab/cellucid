import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';

/**
 * Alpha-texture publication cost contract.
 *
 * Hiding eight cells out of ten million uploaded the entire 10.01 MB alpha
 * texture, because the publication compared every byte but then re-sent all of
 * them. These tests pin two things at once:
 *
 *  - the resident texture image is byte-identical to what a full upload would
 *    have produced, for every filter shape; and
 *  - the number of bytes actually sent is proportional to the rows that moved.
 *
 * The GL double here models real texture memory: `texSubImage2D` writes into a
 * simulated image, so a wrong offset, a wrong row count or a wrong source
 * offset corrupts it and the identity assertions fail. Nothing here measures
 * time.
 */

const PIXEL_UNPACK_PARAMETERS = Object.freeze([
  'UNPACK_ALIGNMENT',
  'UNPACK_ROW_LENGTH',
  'UNPACK_IMAGE_HEIGHT',
  'UNPACK_SKIP_PIXELS',
  'UNPACK_SKIP_ROWS',
  'UNPACK_SKIP_IMAGES',
]);

function createTextureMemoryGl(maxTextureSize) {
  let nextId = 1;
  let boundTexture = null;
  let boundPixelUnpackBuffer = null;
  let pendingError = 0;
  const unpack = new Map();
  const images = new Map();
  const uploads = [];
  const counters = { getErrorCalls: 0, texImage2D: 0, texSubImage2D: 0 };
  const fail = { texSubImageAt: null };

  const gl = {
    CLAMP_TO_EDGE: 0x812f,
    INVALID_OPERATION: 0x0502,
    MAX_TEXTURE_SIZE: 0x0d33,
    NEAREST: 0x2600,
    NO_ERROR: 0,
    PIXEL_UNPACK_BUFFER: 0x88ec,
    PIXEL_UNPACK_BUFFER_BINDING: 0x88ef,
    R8: 0x8229,
    RED: 0x1903,
    TEXTURE_2D: 0x0de1,
    UNPACK_ALIGNMENT: 0x0cf5,
    UNPACK_IMAGE_HEIGHT: 0x806e,
    UNPACK_ROW_LENGTH: 0x0cf2,
    UNPACK_SKIP_IMAGES: 0x806d,
    UNPACK_SKIP_PIXELS: 0x0cf4,
    UNPACK_SKIP_ROWS: 0x0cf3,
    UNSIGNED_BYTE: 0x1401,

    bindBuffer(target, buffer) {
      assert.equal(target, this.PIXEL_UNPACK_BUFFER);
      boundPixelUnpackBuffer = buffer;
    },
    bindTexture(target, texture) {
      assert.equal(target, this.TEXTURE_2D);
      boundTexture = texture;
    },
    createTexture() {
      const handle = Object.freeze({ id: `texture-${nextId++}` });
      return handle;
    },
    deleteTexture(handle) {
      images.delete(handle);
    },
    getError() {
      counters.getErrorCalls++;
      const error = pendingError;
      pendingError = this.NO_ERROR;
      return error;
    },
    getParameter(parameter) {
      if (parameter === this.MAX_TEXTURE_SIZE) return maxTextureSize;
      if (parameter === this.PIXEL_UNPACK_BUFFER_BINDING) {
        return boundPixelUnpackBuffer;
      }
      if (unpack.has(parameter)) return unpack.get(parameter);
      throw new TypeError(`unexpected WebGL parameter ${parameter}`);
    },
    isTexture(handle) {
      return images.has(handle);
    },
    pixelStorei(parameter, value) {
      if (!unpack.has(parameter)) {
        throw new TypeError(`unexpected pixel-store parameter ${parameter}`);
      }
      unpack.set(parameter, value);
    },
    texImage2D(
      target, level, internalFormat, width, height, border, format, type, data,
    ) {
      counters.texImage2D++;
      assert.equal(target, this.TEXTURE_2D);
      assert.equal(level, 0);
      assert.equal(border, 0);
      assert.equal(internalFormat, this.R8);
      assert.equal(format, this.RED);
      assert.equal(type, this.UNSIGNED_BYTE);
      assert.ok(boundTexture, 'texImage2D requires a bound texture');
      const image = new Uint8Array(width * height);
      if (data !== null) {
        assert.equal(data.length, width * height);
        image.set(data);
      }
      images.set(boundTexture, { height, image, width });
    },
    texParameteri() {},
    texSubImage2D(
      target, level, xOffset, yOffset, width, height, format, type, data,
      srcOffset = 0,
    ) {
      counters.texSubImage2D++;
      assert.equal(target, this.TEXTURE_2D);
      assert.equal(level, 0);
      assert.equal(format, this.RED);
      assert.equal(type, this.UNSIGNED_BYTE);
      const resident = images.get(boundTexture);
      assert.ok(resident, 'texSubImage2D requires an allocated texture');
      // Everything this renderer sends is full rows at neutral unpack state.
      assert.equal(unpack.get(this.UNPACK_ALIGNMENT), 1);
      assert.equal(unpack.get(this.UNPACK_ROW_LENGTH), 0);
      assert.equal(unpack.get(this.UNPACK_SKIP_PIXELS), 0);
      assert.equal(unpack.get(this.UNPACK_SKIP_ROWS), 0);
      assert.equal(boundPixelUnpackBuffer, null);
      assert.ok(
        xOffset >= 0 && yOffset >= 0
        && xOffset + width <= resident.width
        && yOffset + height <= resident.height,
        `region ${xOffset},${yOffset} ${width}x${height} escapes the texture`,
      );
      assert.ok(
        srcOffset + width * height <= data.length,
        'source range escapes the supplied buffer',
      );
      uploads.push({ bytes: width * height, height, width, xOffset, yOffset });
      if (counters.texSubImage2D === fail.texSubImageAt) {
        pendingError = this.INVALID_OPERATION;
        return;
      }
      for (let row = 0; row < height; row++) {
        const source = srcOffset + row * width;
        const destination = (yOffset + row) * resident.width + xOffset;
        resident.image.set(data.subarray(source, source + width), destination);
      }
    },

    _counters: counters,
    _fail: fail,
    _image(texture) {
      const resident = images.get(texture);
      return resident === undefined ? null : resident.image;
    },
    _uploads: uploads,
  };

  for (const name of PIXEL_UNPACK_PARAMETERS) unpack.set(gl[name], 0);
  unpack.set(gl.UNPACK_ALIGNMENT, 4);
  return gl;
}

function createAlphaRenderer(pointCount, maxTextureSize) {
  const gl = createTextureMemoryGl(maxTextureSize);
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _alphaTexData: null,
      _alphaTexHeight: 0,
      _alphaTexStagingData: null,
      _alphaTexWidth: 0,
      _alphaTexture: null,
      _alphaTextureByteLength: 0,
      _dummyLodIndexTexture: null,
      _dummyLodIndexTextureByteLength: 0,
      _interleavedGpuByteLength: 0,
      _lodIndexTexturesByDimension: new Map(),
      _lodResourceOwnersByDimension: new Map(),
      _pendingDataRetirements: new Set(),
      _pendingSnapshotRetirements: new Set(),
      _perViewState: new Map(),
      _useAlphaTexture: false,
      buffers: {},
      gl,
      lodBuffersByDimension: new Map(),
      pointCount,
      snapshotBuffers: new Map(),
      stats: { gpuMemoryMB: 0 },
    },
  );
  renderer._createAlphaTexture(pointCount);
  return { gl, renderer };
}

/** Exactly the R8 image a full-texture upload of `alphas` would leave behind. */
function expectedImage(alphas, width, height) {
  const image = new Uint8Array(width * height).fill(255);
  for (let index = 0; index < alphas.length; index++) {
    image[index] = Math.round(alphas[index] * 255);
  }
  return image;
}

function shapes(pointCount) {
  const all = value => Float32Array.from({ length: pointCount }, () => value);
  const hide = predicate => Float32Array.from(
    { length: pointCount },
    (_, index) => (predicate(index) ? 0 : 1),
  );
  return {
    contiguousRun: hide(index => index >= 9 && index < 21),
    everything: all(0),
    firstCell: hide(index => index === 0),
    half: hide(index => index % 2 === 0),
    lastCell: hide(index => index === pointCount - 1),
    nothing: all(1),
    oneCell: hide(index => index === 13),
    sparseScatter: hide(index => index % 11 === 4),
    twoDistantCells: hide(index => index === 2 || index === pointCount - 3),
  };
}

test('every filter shape leaves a byte-identical alpha texture', () => {
  // Identity guard: it passes against the unchanged renderer too. It is what
  // makes a region-addressed upload provable rather than plausible.
  const pointCount = 47;
  const { gl, renderer } = createAlphaRenderer(pointCount, 8);
  const width = renderer._alphaTexWidth;
  const height = renderer._alphaTexHeight;
  assert.equal(width, 8);
  assert.equal(height, 6);

  const catalogue = shapes(pointCount);
  const names = Object.keys(catalogue);
  // Every ordered pair of shapes, so each transition is exercised from a
  // different resident generation.
  for (const from of names) {
    for (const to of names) {
      renderer._updateAlphaTexture(catalogue[from]);
      const beforeHash = createHash('sha256')
        .update(gl._image(renderer._alphaTexture))
        .digest('hex');
      assert.equal(
        beforeHash,
        createHash('sha256')
          .update(expectedImage(catalogue[from], width, height))
          .digest('hex'),
        `resident image after ${from}`,
      );

      renderer._updateAlphaTexture(catalogue[to]);
      assert.deepEqual(
        Array.from(gl._image(renderer._alphaTexture)),
        Array.from(expectedImage(catalogue[to], width, height)),
        `resident image after ${from} -> ${to}`,
      );
      assert.deepEqual(
        Array.from(renderer._alphaTexData),
        Array.from(expectedImage(catalogue[to], width, height)),
        `accepted CPU generation after ${from} -> ${to}`,
      );
    }
  }
});

test('the alpha publication uploads only the rows that moved', () => {
  const pointCount = 47;
  const { gl, renderer } = createAlphaRenderer(pointCount, 8);
  const width = renderer._alphaTexWidth;
  const height = renderer._alphaTexHeight;
  const catalogue = shapes(pointCount);

  const publish = alphas => {
    gl._uploads.length = 0;
    const changed = renderer._updateAlphaTexture(alphas);
    const bytes = gl._uploads.reduce((total, up) => total + up.bytes, 0);
    return { bytes, changed, uploads: gl._uploads.slice() };
  };

  // Start from a known all-opaque generation.
  publish(catalogue.nothing);

  // One cell at index 13 is in row 1 of an 8-wide texture: one row, not six.
  const one = publish(catalogue.oneCell);
  assert.equal(one.changed, true);
  assert.deepEqual(one.uploads, [
    { bytes: width, height: 1, width, xOffset: 0, yOffset: 1 },
  ]);

  // Two distant cells (2 and 44) are rows 0 and 5: two single-row regions, not
  // the six rows that span them.
  publish(catalogue.nothing);
  const two = publish(catalogue.twoDistantCells);
  assert.deepEqual(two.uploads, [
    { bytes: width, height: 1, width, xOffset: 0, yOffset: 0 },
    { bytes: width, height: 1, width, xOffset: 0, yOffset: 5 },
  ]);

  // A contiguous run of twelve cells starting at 9 covers rows 1..2.
  publish(catalogue.nothing);
  const run = publish(catalogue.contiguousRun);
  assert.deepEqual(run.uploads, [
    { bytes: width * 2, height: 2, width, xOffset: 0, yOffset: 1 },
  ]);

  // A change touching every row is one full-texture region, exactly as before.
  publish(catalogue.nothing);
  const everything = publish(catalogue.everything);
  assert.deepEqual(everything.uploads, [
    { bytes: width * height, height, width, xOffset: 0, yOffset: 0 },
  ]);

  // A publication that moves no byte still sends nothing at all.
  const idle = publish(catalogue.everything);
  assert.equal(idle.changed, false);
  assert.deepEqual(idle.uploads, []);
  assert.equal(idle.bytes, 0);
});

test('a scattered selection never sends more than the full texture', () => {
  const pointCount = 4096;
  const { gl, renderer } = createAlphaRenderer(pointCount, 64);
  const full = renderer._alphaTexWidth * renderer._alphaTexHeight;
  assert.equal(renderer._alphaTexWidth, 64);
  assert.equal(renderer._alphaTexHeight, 64);

  const opaque = new Float32Array(pointCount).fill(1);
  renderer._updateAlphaTexture(opaque);

  // Every row dirty but with clean rows nowhere: the region set degenerates to
  // the whole texture rather than to sixty-four separate calls.
  const everyRow = Float32Array.from(
    { length: pointCount },
    (_, index) => (index % 64 === 7 ? 0 : 1),
  );
  gl._uploads.length = 0;
  renderer._updateAlphaTexture(everyRow);
  const bytes = gl._uploads.reduce((total, up) => total + up.bytes, 0);
  assert.ok(
    bytes <= full,
    `scattered publication sent ${bytes} bytes for a ${full}-byte texture`,
  );
  assert.deepEqual(
    Array.from(gl._image(renderer._alphaTexture)),
    Array.from(expectedImage(everyRow, 64, 64)),
  );
});

test('one alpha publication costs exactly three synchronous error checks', () => {
  // Identity guard against the obvious way to make a region-addressed upload
  // worse than the full one: three `getError` stalls per region instead of
  // three per publication.
  const pointCount = 47;
  const { gl, renderer } = createAlphaRenderer(pointCount, 8);
  const catalogue = shapes(pointCount);
  renderer._updateAlphaTexture(catalogue.nothing);

  for (const [name, alphas] of Object.entries(catalogue)) {
    renderer._updateAlphaTexture(catalogue.nothing);
    gl._counters.getErrorCalls = 0;
    gl._uploads.length = 0;
    const changed = renderer._updateAlphaTexture(alphas);
    if (!changed) {
      assert.equal(gl._counters.getErrorCalls, 0, `${name} idle publication`);
      continue;
    }
    assert.equal(
      gl._counters.getErrorCalls,
      3,
      `${name} published ${gl._uploads.length} region(s)`,
    );
  }
});

test('a failed multi-region publication restores the accepted image exactly', () => {
  const pointCount = 47;
  const { gl, renderer } = createAlphaRenderer(pointCount, 8);
  const width = renderer._alphaTexWidth;
  const height = renderer._alphaTexHeight;
  const catalogue = shapes(pointCount);

  renderer._updateAlphaTexture(catalogue.nothing);
  renderer._updateAlphaTexture(catalogue.contiguousRun);
  const accepted = renderer._alphaTexData;
  const acceptedBytes = Array.from(accepted);
  const residentBefore = Array.from(gl._image(renderer._alphaTexture));
  assert.deepEqual(
    residentBefore,
    Array.from(expectedImage(catalogue.contiguousRun, width, height)),
  );

  // Fail the very next region upload, whichever region that is.
  gl._fail.texSubImageAt = gl._counters.texSubImage2D + 1;
  assert.throws(
    () => renderer._updateAlphaTexture(catalogue.twoDistantCells),
    /WebGL|alpha|publication/i,
  );
  gl._fail.texSubImageAt = null;

  assert.strictEqual(renderer._alphaTexData, accepted);
  assert.deepEqual(Array.from(renderer._alphaTexData), acceptedBytes);
  assert.deepEqual(
    Array.from(gl._image(renderer._alphaTexture)),
    residentBefore,
    'the resident image must be exactly the accepted generation again',
  );
  assert.equal(renderer._useAlphaTexture, true);

  // And the renderer still publishes correctly afterwards.
  renderer._updateAlphaTexture(catalogue.sparseScatter);
  assert.deepEqual(
    Array.from(gl._image(renderer._alphaTexture)),
    Array.from(expectedImage(catalogue.sparseScatter, width, height)),
  );
});

test('a partial final row is published without disturbing its padding', () => {
  // 47 points in a 8x6 texture leaves one padding byte the renderer never
  // writes. A row-addressed upload must still send it unchanged rather than
  // sending whatever a stale staging buffer happened to hold.
  const pointCount = 47;
  const { gl, renderer } = createAlphaRenderer(pointCount, 8);
  const catalogue = shapes(pointCount);
  renderer._updateAlphaTexture(catalogue.nothing);

  const lastOnly = Float32Array.from(
    { length: pointCount },
    (_, index) => (index === pointCount - 1 ? 0 : 1),
  );
  gl._uploads.length = 0;
  renderer._updateAlphaTexture(lastOnly);
  assert.deepEqual(gl._uploads, [
    { bytes: 8, height: 1, width: 8, xOffset: 0, yOffset: 5 },
  ]);
  const image = gl._image(renderer._alphaTexture);
  assert.equal(image[pointCount - 1], 0);
  assert.equal(image[pointCount], 255, 'padding byte must stay opaque');
  assert.equal(image.length, 48);
});
