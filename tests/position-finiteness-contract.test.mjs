// Fetched coordinate payloads must be finite before anything normalizes them.
//
// `normalizePositions()` derives one centre and one scale from a whole
// embedding buffer, so a non-finite coordinate is never contained to the cell
// that carries it:
//
//   * one NaN x  -> that cell's x stays NaN through the affine transform. The
//                   cell disappears from the view while it still counts in
//                   every legend total, category count, and analysis.
//   * one +Inf x -> maxX becomes Infinity, so scale is 2/Infinity = 0 and
//                   centerX is Infinity. Every finite x becomes (x - Inf) * 0
//                   = NaN and every y/z becomes 0: the entire embedding
//                   collapses onto a degenerate line, silently.
//
// A single 0x7F800000 word anywhere in `points_3d.bin` is enough. The staged
// `local-user://` transaction, the direct h5ad/Zarr adapters, and the in-memory
// DimensionManager already refuse non-finite coordinates at their own ingest
// boundary; these tests hold the remaining decode boundary — the one every
// remotely hosted dataset uses — to the same invariant. Coordinates are
// measured data: a bad payload is refused, never dropped, clamped, or imputed.

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadPointsBinary } from '../assets/js/data/data-loaders.js';
import { createDimensionManager } from '../assets/js/data/dimension-manager.js';
import { normalizePositions } from '../assets/js/rendering/gl-utils.js';

const FLOAT32_BYTES = 4;
const BASE_URL = 'https://untrusted.test/exports/demo/';

function installFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  });
}

function serveBytes(t, bytes, requestedUrls = null) {
  installFetch(t, async url => {
    if (requestedUrls) requestedUrls.push(String(url));
    return new Response(bytes, { status: 200 });
  });
}

/**
 * A clean `n_cells x dimension` payload with one coordinate replaced.
 *
 * @param {number} nCells
 * @param {number} dimension
 * @param {number} flatIndex
 * @param {number} value
 * @returns {Float32Array}
 */
function payloadWith(nCells, dimension, flatIndex, value) {
  const values = new Float32Array(nCells * dimension);
  for (let index = 0; index < values.length; index++) {
    values[index] = index + 1;
  }
  values[flatIndex] = value;
  return values;
}

test('the collapse this guard prevents is real, not hypothetical', () => {
  // Executed against the real normalizePositions so the invariant is anchored
  // to observed behaviour rather than to a claim about it.
  const oneNaN = new Float32Array([0, 0, 0, Number.NaN, 1, 1, 2, 2, 2]);
  normalizePositions(oneNaN);
  assert.equal(Number.isNaN(oneNaN[3]), true, 'the NaN cell vanishes');
  assert.equal(
    [oneNaN[0], oneNaN[6]].every(Number.isFinite),
    true,
    'while its neighbours keep plausible finite coordinates'
  );

  const oneInfinity = new Float32Array([0, 0, 0, Infinity, 1, 1, 2, 2, 2]);
  const transform = normalizePositions(oneInfinity);
  assert.equal(transform.scale, 0, 'one Infinity zeroes the shared scale');
  assert.equal(
    [oneInfinity[0], oneInfinity[3], oneInfinity[6]].every(Number.isNaN),
    true,
    'every cell loses its x, not just the one that carried the Infinity'
  );
  assert.equal(
    [oneInfinity[1], oneInfinity[2], oneInfinity[7], oneInfinity[8]]
      .every(value => value === 0),
    true,
    'and the embedding collapses onto a degenerate line'
  );
});

test('a single non-finite Float32 word is refused at every position of every dimension', async t => {
  const cases = [
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ];

  for (const [valueLabel, value] of cases) {
    for (const dimension of [1, 2, 3]) {
      const nCells = 5;
      const length = nCells * dimension;
      const positionCases = [
        ['first', 0],
        ['middle', Math.floor(length / 2)],
        ['last', length - 1],
      ];

      for (const [positionLabel, flatIndex] of positionCases) {
        const label =
          `${valueLabel} at the ${positionLabel} position of a ${dimension}D payload`;
        await t.test(label, async subtest => {
          const url = `${BASE_URL}points_${dimension}d.bin`;
          serveBytes(
            subtest,
            payloadWith(nCells, dimension, flatIndex, value).buffer
          );

          await assert.rejects(
            loadPointsBinary(url, {
              dimension,
              expectedBytes: length * FLOAT32_BYTES,
            }),
            error => {
              // Exact, not a substring: the message a wet-lab user acts on
              // must name the file and the offending flat index and nothing
              // else, identically across every remotely hosted protocol.
              assert.equal(
                error.message,
                `${url}: position ${flatIndex} is not a finite Float32 value`,
                `${label} must be refused, naming its file and flat index`
              );
              return true;
            }
          );
        });
      }
    }
  }
});

test('the raw 0x7F800000 word is refused, whatever produced it', async t => {
  // The trigger stated in the field report: an exponent-all-ones float32 word
  // written straight into the file, with no NaN literal anywhere in sight.
  const words = new Uint32Array([0x3f800000, 0x40000000, 0x7f800000, 0x40800000]);
  serveBytes(t, words.buffer);

  await assert.rejects(
    loadPointsBinary(`${BASE_URL}points_2d.bin`, {
      dimension: 2,
      expectedBytes: words.length * FLOAT32_BYTES,
    }),
    /position 2 is not a finite Float32 value/
  );
});

test('non-finite coordinates never reach normalizePositions through DimensionManager', async t => {
  // The genuinely uncovered path: a runtime dimension switch. Only the default
  // dimension is checked by stageDatasetPositionPayload() on first load, so
  // every other advertised embedding arrives here unvalidated.
  const requestedUrls = [];
  const dimensionManager = createDimensionManager({ baseUrl: BASE_URL });
  dimensionManager.initFromMetadata({
    available_dimensions: [2],
    default_dimension: 2,
    files: { '2d': 'points_2d.bin' },
  });

  serveBytes(
    t,
    payloadWith(3, 2, 4, Number.POSITIVE_INFINITY).buffer,
    requestedUrls
  );

  await assert.rejects(
    dimensionManager.getPositions3D(2, { showProgress: false }),
    /points_2d\.bin: position 4 is not a finite Float32 value/,
    'the padding and normalization transaction must never run on this payload'
  );
  assert.deepEqual(requestedUrls, [`${BASE_URL}points_2d.bin`]);
  assert.equal(
    dimensionManager.paddedPositionCache.size,
    0,
    'no normalized buffer may be published from a refused payload'
  );
  assert.equal(
    dimensionManager.positionCache.size,
    0,
    'and no raw buffer may be retained either'
  );
});

test('a clean payload still loads unchanged, compressed shape and all', async t => {
  const clean = Float32Array.of(-1.5, 0, 1.5, 3, 0, -3);
  serveBytes(t, clean.buffer);

  assert.deepEqual(
    Array.from(await loadPointsBinary(`${BASE_URL}points_2d.bin`, {
      dimension: 2,
      expectedBytes: clean.length * FLOAT32_BYTES,
    })),
    [-1.5, 0, 1.5, 3, 0, -3],
    'the guard must not alter, reorder, or copy away a valid payload'
  );
});

test('signed zero and subnormal coordinates are finite and stay accepted', async t => {
  // Number.isFinite(-0) is true and -0 is a legitimate exported coordinate;
  // a guard that reached for a truthiness test instead would reject it.
  const edge = Float32Array.of(-0, 0, 1.401298464324817e-45, 3.4028234663852886e38);
  serveBytes(t, edge.buffer);

  const loaded = await loadPointsBinary(`${BASE_URL}points_2d.bin`, {
    dimension: 2,
    expectedBytes: edge.length * FLOAT32_BYTES,
  });
  assert.equal(Object.is(loaded[0], -0), true);
  assert.equal(loaded[2] > 0, true, 'the smallest subnormal survives');
  assert.equal(loaded[3], 3.4028234663852886e38, 'Float32 max survives');
});

test('an empty advertised payload carries no coordinate to reject', async t => {
  serveBytes(t, new ArrayBuffer(0));

  assert.equal(
    (await loadPointsBinary(`${BASE_URL}points_2d.bin`, {
      dimension: 2,
      expectedBytes: 0,
    })).length,
    0
  );
});

test('a byte length that is not a multiple of 4 is still refused first', async t => {
  // The shape check must keep precedence: a trailing partial word would
  // otherwise be silently dropped by the Float32Array view before any
  // coordinate was examined.
  serveBytes(t, new Uint8Array([0, 0, 128, 127, 0, 0, 127]).buffer);

  await assert.rejects(
    loadPointsBinary(`${BASE_URL}points_2d.bin`, { expectedBytes: null }),
    /byte length must be a multiple of 4/
  );
});
