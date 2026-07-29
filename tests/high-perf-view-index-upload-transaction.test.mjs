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
