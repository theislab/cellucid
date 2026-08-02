import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';

function createFixture(mode = 'success') {
  const NO_ERROR = 0;
  const INVALID_OPERATION = 0x0502;
  const errors =
    mode === 'preflight'
      ? [INVALID_OPERATION]
      : mode === 'sticky'
        ? [NO_ERROR, INVALID_OPERATION]
        : [NO_ERROR, NO_ERROR];
  const indexBuffer = Object.freeze({ kind: 'index-buffer' });
  const accepted = Uint32Array.from([9, 8]);
  const events = [];
  const gl = {
    NO_ERROR,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    DYNAMIC_DRAW: 0x88e8,
    bindVertexArray(value) {
      events.push(['vao', value]);
    },
    bindBuffer(target, value) {
      events.push(['buffer', target, value]);
    },
    bufferData(target, value, usage) {
      events.push(['upload', target, value, usage]);
      if (mode === 'throw') {
        throw new Error('synthetic upload failure');
      }
      if (mode === 'success') {
        accepted.set(value);
      }
    },
    getError() {
      return errors.shift() ?? NO_ERROR;
    },
  };
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    { gl },
  );
  const viewState = {
    cachedCulledCount: 2,
    cachedLodDimension: 2,
    cachedLodIsCulled: true,
    cachedLodLevel: 4,
    cachedVisibleIndices: Uint32Array.from([9, 8]),
    indexBuffer,
    indexBufferSize: 2,
    lastFrustumMVP: new Float32Array(16),
    preCachedGenerationToken: Object.freeze({}),
    preCachedIndexBuffer: Object.freeze({}),
    preCachedSpatialOwner: Object.freeze({}),
    stats: {
      cullPercent: 12,
      drawCalls: 1,
      fps: 60,
      frustumCulled: true,
      lastFrameTime: 16,
      lodLevel: 4,
      visiblePoints: 2,
    },
    usePreCachedIndexBuffer: true,
  };
  return { accepted, events, gl, renderer, viewState };
}

/**
 * A recording fixture for the per-frame republication counters.
 *
 * `_uploadToViewIndexBuffer` runs once per view on every frame of camera
 * motion. The counters this fixture records are the ones the browser harness
 * records for a real frame (`gl-upload-counter.js`: element-buffer store
 * allocations, element-buffer sub-updates, and `getError` synchronous stalls),
 * so a regression here is the same regression the harness would measure.
 */
function createRepublicationFixture() {
  const NO_ERROR = 0;
  const counters = {
    elementBufferStoreAllocations: 0,
    elementBufferStoreAllocationBytes: 0,
    elementBufferSubUpdates: 0,
    syncStalls: 0,
  };
  const ELEMENT_ARRAY_BUFFER = 0x8893;
  const gl = {
    NO_ERROR,
    ELEMENT_ARRAY_BUFFER,
    DYNAMIC_DRAW: 0x88e8,
    bindVertexArray() {},
    bindBuffer() {},
    bufferData(target, source) {
      if (target !== ELEMENT_ARRAY_BUFFER) return;
      counters.elementBufferStoreAllocations++;
      counters.elementBufferStoreAllocationBytes += source.byteLength;
    },
    bufferSubData(target) {
      if (target !== ELEMENT_ARRAY_BUFFER) return;
      counters.elementBufferSubUpdates++;
    },
    getError() {
      counters.syncStalls++;
      return NO_ERROR;
    },
  };
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    { gl },
  );
  const viewState = {
    cachedCulledCount: 0,
    cachedLodDimension: -1,
    cachedLodIsCulled: false,
    cachedLodLevel: -1,
    cachedVisibleIndices: null,
    indexBuffer: Object.freeze({ kind: 'index-buffer' }),
    indexBufferSize: 0,
    indexBufferByteLength: 0,
    indexBufferVerifiedByteLength: 0,
    lastFrustumMVP: null,
    preCachedGenerationToken: null,
    preCachedIndexBuffer: null,
    preCachedSpatialOwner: null,
    stats: null,
    usePreCachedIndexBuffer: false,
  };
  return { counters, gl, renderer, viewState };
}

test('steady per-frame index republication costs no synchronous GL stall', () => {
  const fixture = createRepublicationFixture();
  const widest = new Uint32Array(4096);

  // Frame 1 establishes the store at its widest admitted size and is verified.
  fixture.renderer._uploadToViewIndexBuffer(fixture.viewState, widest);
  assert.equal(
    fixture.counters.syncStalls,
    2,
    'the allocation that establishes the store must still be bracketed',
  );

  // Every later frame of camera motion republishes a different admitted set at
  // or below that size. `gl.getError()` drains the client command buffer to the
  // GPU process and blocks for the answer, so a check here is a pipeline stall
  // per view per frame — measured at 11 ms of wall time per frame at 1 M and at
  // 10 M points. It must not happen.
  for (let frame = 0; frame < 60; frame++) {
    fixture.renderer._uploadToViewIndexBuffer(
      fixture.viewState,
      widest.subarray(0, 1024 + (frame % 512)),
    );
  }

  assert.equal(
    fixture.counters.syncStalls,
    2,
    'republication at or below a verified size must add no getError stall',
  );
  assert.equal(
    fixture.counters.elementBufferStoreAllocations,
    61,
    'each republication is exactly one whole-store bufferData',
  );
  assert.equal(
    fixture.counters.elementBufferSubUpdates,
    0,
    'bufferSubData into the live store forfeits orphaning and measured 3.4x '
    + 'slower at 1 M points; the upload must stay a whole-store replacement',
  );
});

test('a wider index publication is verified again', () => {
  const fixture = createRepublicationFixture();

  fixture.renderer._uploadToViewIndexBuffer(
    fixture.viewState,
    new Uint32Array(16),
  );
  assert.equal(fixture.counters.syncStalls, 2);
  assert.equal(fixture.viewState.indexBufferVerifiedByteLength, 64);

  fixture.renderer._uploadToViewIndexBuffer(
    fixture.viewState,
    new Uint32Array(8),
  );
  assert.equal(fixture.counters.syncStalls, 2, 'a narrower store is trusted');

  fixture.renderer._uploadToViewIndexBuffer(
    fixture.viewState,
    new Uint32Array(17),
  );
  assert.equal(
    fixture.counters.syncStalls,
    4,
    'growing past the verified watermark must be bracketed',
  );
  assert.equal(fixture.viewState.indexBufferVerifiedByteLength, 68);
});

test('invalidation makes the next index publication verify again', () => {
  const fixture = createRepublicationFixture();

  fixture.renderer._uploadToViewIndexBuffer(
    fixture.viewState,
    new Uint32Array(16),
  );
  assert.equal(fixture.counters.syncStalls, 2);

  fixture.renderer._invalidateViewStateRecord(fixture.viewState);
  assert.equal(fixture.viewState.indexBufferVerifiedByteLength, 0);

  fixture.renderer._uploadToViewIndexBuffer(
    fixture.viewState,
    new Uint32Array(4),
  );
  assert.equal(
    fixture.counters.syncStalls,
    4,
    'an abandoned or failed publication must not leave a trusted watermark',
  );
});

test('per-view EBO publication validates WebGL before publishing its count', () => {
  const fixture = createFixture();
  const next = Uint32Array.from([3, 4]);

  fixture.renderer._uploadToViewIndexBuffer(fixture.viewState, next);

  assert.deepEqual(Array.from(fixture.accepted), [3, 4]);
  assert.equal(fixture.viewState.indexBufferSize, 2);
  assert.deepEqual(
    fixture.events.map(event => event[0]),
    ['vao', 'buffer', 'upload', 'buffer'],
  );
  assert.equal(fixture.events.at(-1)[2], null);
});

for (const mode of ['preflight', 'throw', 'sticky']) {
  test(`failed per-view EBO ${mode} publication invalidates semantic caches for retry`, () => {
    const fixture = createFixture(mode);

    assert.throws(
      () => fixture.renderer._uploadToViewIndexBuffer(
        fixture.viewState,
        Uint32Array.from([3, 4, 5]),
      ),
      /WebGL error|synthetic upload failure/,
    );

    assert.deepEqual(
      Array.from(fixture.accepted),
      [9, 8],
      'a rejected replacement must preserve the accepted GPU bytes',
    );
    assert.equal(fixture.viewState.indexBufferSize, 0);
    assert.equal(fixture.viewState.cachedLodLevel, -1);
    assert.equal(fixture.viewState.cachedLodDimension, -1);
    assert.equal(fixture.viewState.cachedVisibleIndices, null);
    assert.equal(fixture.viewState.lastFrustumMVP, null);
    assert.equal(fixture.viewState.usePreCachedIndexBuffer, false);
    assert.equal(fixture.events.at(-1)[2], null);
  });
}
