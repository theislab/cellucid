import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';

function makeRenderer() {
  return Object.create(HighPerfRenderer.prototype);
}

function makeViewState() {
  return {
    lastDimensionLevel: undefined,
    lastFrustumMVP: null,
  };
}

function makeIdentityMatrix(ArrayType = Float32Array) {
  const matrix = new ArrayType(16);
  matrix[0] = 1;
  matrix[5] = 1;
  matrix[10] = 1;
  matrix[15] = 1;
  return matrix;
}

test('every finite MVP element change invalidates frustum visibility while stable matrices remain allocation-free', (t) => {
  const renderer = makeRenderer();
  const viewState = makeViewState();
  const baseline = makeIdentityMatrix(Float64Array);
  baseline[12] = 0.1;

  assert.equal(
    renderer._checkFrustumCacheValid(
      baseline,
      viewState,
      3,
    ),
    true,
  );
  assert.ok(viewState.lastFrustumMVP instanceof Float64Array);
  const acceptedCache = viewState.lastFrustumMVP;

  assert.equal(
    renderer._checkFrustumCacheValid(
      baseline.slice(),
      viewState,
      3,
    ),
    false,
  );
  assert.strictEqual(viewState.lastFrustumMVP, acceptedCache);

  const tinyMotion = baseline.slice();
  tinyMotion[12] += 1e-6;
  assert.ok(
    (tinyMotion[12] - baseline[12]) ** 2 < 0.0005,
    'fixture must be below the retired squared-difference threshold',
  );
  assert.equal(
    renderer._checkFrustumCacheValid(
      tinyMotion,
      viewState,
      3,
    ),
    true,
  );
  assert.strictEqual(viewState.lastFrustumMVP, acceptedCache);
  assert.equal(viewState.lastFrustumMVP[12], tinyMotion[12]);

  let invalidations = 0;
  const startedAt = performance.now();
  for (let iteration = 0; iteration < 100_000; iteration++) {
    if (
      renderer._checkFrustumCacheValid(
        tinyMotion,
        viewState,
        3,
      )
    ) {
      invalidations++;
    }
  }
  const elapsedMs = performance.now() - startedAt;
  assert.equal(invalidations, 0);
  assert.strictEqual(viewState.lastFrustumMVP, acceptedCache);
  t.diagnostic(
    `100,000 exact stable-matrix cache checks: ${elapsedMs.toFixed(2)}ms; ` +
    `${(elapsedMs * 1e6 / 100_000).toFixed(1)}ns/check; zero allocations/invalidations`,
  );

  const source =
    HighPerfRenderer.prototype
      ._checkFrustumCacheValid
      .toString();
  assert.doesNotMatch(source, /0\.0005|sumSqDiff/);
});

test('sub-threshold camera motion recomputes a point exactly across a frustum boundary', () => {
  const renderer = makeRenderer();
  const viewState = makeViewState();
  const boundaryNode = {
    bounds: {
      minX: 1,
      maxX: 1,
      minY: 0,
      maxY: 0,
      minZ: 0,
      maxZ: 0,
    },
  };
  const baseline = makeIdentityMatrix();
  const tinyMotion = baseline.slice();
  tinyMotion[12] = 1e-6;
  let cachedVisibility = null;
  let classifications = 0;

  const renderBoundary = matrix => {
    if (
      renderer._checkFrustumCacheValid(
        matrix,
        viewState,
        2,
      )
    ) {
      // For an MVP x translation t, the exact right clip plane at this
      // boundary is -x + (1 - t) >= 0.
      const rightPlane =
        Float32Array.of(-1, 0, 0, 1 - matrix[12]);
      cachedVisibility = renderer._classifyNodeVisibility(
        boundaryNode.bounds,
        [rightPlane],
      );
      classifications++;
    }
    return cachedVisibility;
  };

  assert.equal(renderBoundary(baseline), 'inside');
  assert.equal(renderBoundary(tinyMotion), 'outside');
  assert.equal(
    renderBoundary(tinyMotion.slice()),
    'outside',
  );
  assert.equal(
    classifications,
    2,
    'stable frames reuse visibility, but the tiny boundary crossing must recompute',
  );
});

test('non-finite MVP rejection is atomic across matrix and dimension cache keys', () => {
  const renderer = makeRenderer();
  const viewState = makeViewState();
  const accepted = makeIdentityMatrix();
  renderer._checkFrustumCacheValid(
    accepted,
    viewState,
    2,
  );
  const acceptedCache = viewState.lastFrustumMVP;
  const acceptedValues = Array.from(acceptedCache);

  const invalid = accepted.slice();
  invalid[7] = Number.NaN;
  assert.throws(
    () => renderer._checkFrustumCacheValid(
      invalid,
      viewState,
      3,
    ),
    /MVP\[7\].*finite/,
  );
  assert.strictEqual(viewState.lastFrustumMVP, acceptedCache);
  assert.deepEqual(
    Array.from(viewState.lastFrustumMVP),
    acceptedValues,
  );
  assert.equal(viewState.lastDimensionLevel, 2);
});
