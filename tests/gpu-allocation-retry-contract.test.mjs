/**
 * Memory kept only for speed (geometry of representations no view shows,
 * colour stores kept for switching back) is released when, and only when, an
 * allocation is refused (`HighPerfRenderer._allocateGpu`). Nothing is evicted
 * while an allocation fits, so a switch back stays free whenever memory
 * allows; a refusal releases everything kept and tries once more.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { HighPerfRenderer } from '../assets/js/rendering/high-perf-renderer.js';

function fixture({ keptBytes = 0, refusals = 0 } = {}) {
  const events = [];
  let pendingRefusals = refusals;
  let pendingError = 0;
  const gl = {
    NO_ERROR: 0,
    OUT_OF_MEMORY: 0x0505,
    ARRAY_BUFFER: 0x8892,
    ARRAY_BUFFER_BINDING: 0x8894,
    TEXTURE_2D_ARRAY: 0x8c1a,
    TEXTURE_BINDING_2D_ARRAY: 0x8c1d,
    VERTEX_ARRAY_BINDING: 0x85b5,
    getError() {
      const code = pendingError;
      pendingError = 0;
      return code;
    },
    getParameter(name) {
      if (name === gl.VERTEX_ARRAY_BINDING) return 'vao';
      return name === gl.ARRAY_BUFFER_BINDING ? 'buffer' : 'texture';
    },
    bindVertexArray(vao) { events.push(['bindVertexArray', vao]); },
    bindBuffer(_target, buffer) { events.push(['bindBuffer', buffer]); },
    bindTexture(_target, texture) { events.push(['bindTexture', texture]); },
    isContextLost: () => false,
  };
  let kept = keptBytes;
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    gl,
    getRetainedGeometryBytes: () => kept,
    getKeptColorBytes: () => 0,
    evictRetainedGeometry(headroom) {
      events.push(['evict', headroom]);
      kept = 0;
      return 0;
    },
  });
  const allocate = () => {
    events.push(['allocate']);
    if (pendingRefusals > 0) {
      pendingRefusals -= 1;
      pendingError = gl.OUT_OF_MEMORY;
    }
  };
  return { renderer, events, allocate };
}

test('an allocation that fits evicts nothing', () => {
  const { renderer, events, allocate } = fixture({ keptBytes: 1_000_000 });
  renderer._allocateGpu('refused', allocate);
  assert.deepEqual(events, [['allocate']]);
});

test('a refused allocation releases everything kept, restores the binding, and tries once more', () => {
  const { renderer, events, allocate } = fixture({ keptBytes: 1_000_000, refusals: 1 });
  renderer._allocateGpu('refused', allocate);
  assert.deepEqual(events, [
    ['allocate'],
    ['evict', Infinity],
    ['bindVertexArray', 'vao'],
    ['bindBuffer', 'buffer'],
    ['bindTexture', 'texture'],
    ['allocate'],
  ]);
});

test('a refusal with nothing kept, or a second refusal, names the allocation and the code', () => {
  for (const options of [{ keptBytes: 0, refusals: 1 }, { keptBytes: 5, refusals: 2 }]) {
    const { renderer, allocate } = fixture(options);
    assert.throws(
      () => renderer._allocateGpu('the store could not be allocated', allocate),
      error => error instanceof RangeError && /the store could not be allocated \(WebGL error 0x505\)/.test(error.message),
    );
  }
});

test('no allocation path evicts kept memory ahead of a refusal', () => {
  const source = readFileSync(new URL('../assets/js/rendering/high-perf-renderer.js', import.meta.url), 'utf8');
  // Eviction is the budget's (no argument), a new dataset's (Infinity), or a
  // refusal's (inside `_allocateGpu`); never "make room for N bytes".
  const calls = source.match(/evictRetainedGeometry\(([^)]*)\)/g) ?? [];
  for (const call of calls) {
    assert.match(call, /evictRetainedGeometry\((|Infinity|headroomBytes = 0)\)/, call);
  }
  for (const site of [
    'could not allocate its position buffer',
    'could not allocate the alpha texture',
    'could not allocate its draw-order texture',
    'could not allocate its color buffer',
    'could not allocate its R8 texture',
  ]) {
    assert.ok(source.includes(site), site);
  }
});

test('a failed tree build is retried once memory has been released, not before', async t => {
  const { getNotificationCenter } = await import('../assets/js/app/notification-center.js');
  const center = getNotificationCenter();
  const saved = {
    startCalculation: center.startCalculation,
    failCalculation: center.failCalculation,
    completeCalculation: center.completeCalculation,
    error: center.error,
  };
  center.startCalculation = () => 'n';
  center.failCalculation = () => {};
  center.completeCalculation = () => {};
  center.error = () => {};
  t.after(() => Object.assign(center, saved));

  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    _positions: new Float32Array(30),
    currentDimensionLevel: 3,
    pointCount: 10,
    snapshotBuffers: new Map(),
  });
  let builds = 0;
  renderer._buildSpatialTreeJob = (_positions, _dimension, _lod, _onDone, onError) => {
    builds += 1;
    onError(new Error('the worker could not allocate the tree'));
  };
  const settled = [];
  renderer._requestSpatialIndex({ kind: 'live' }, false, ok => settled.push(ok));
  renderer._requestSpatialIndex({ kind: 'live' }, false, ok => settled.push(ok));
  assert.equal(builds, 1, 'no retry while nothing was released');
  // Deleting any GPU object advances the release epoch.
  renderer._releaseEpoch = (renderer._releaseEpoch ?? 0) + 1;
  renderer._requestSpatialIndex({ kind: 'live' }, false, ok => settled.push(ok));
  assert.equal(builds, 2, 'retried after memory was released');
  assert.deepEqual(settled, [false, false, false]);
  const source = readFileSync(new URL('../assets/js/rendering/high-perf-renderer.js', import.meta.url), 'utf8');
  assert.match(source, /deleteGlObject\(gl, deleteMethod, handle\);\n\s*entry\.handle = null;[\s\S]{0,200}this\._releaseEpoch = /);
});

test('a frame adopts at most one new draw order; the rest wait for the next frame', () => {
  const adopted = [];
  let frames = 0;
  const orders = new Map();
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    onAsyncTreeReady: () => { frames += 1; },
    _storeOrder: store => orders.get(store) ?? null,
    _adoptDrawOrder(store, drawOrder) {
      adopted.push(store);
      const record = { drawOrder };
      orders.set(store, record);
      return record;
    },
  });
  const tree = name => ({ ensureDrawOrder: () => name });
  const stores = ['a', 'b', 'c'];
  renderer.beginFrame();
  const first = stores.map(store => renderer._ensureStoreDrawOrder(store, tree(`order-${store}`)));
  assert.deepEqual(adopted, ['a']);
  assert.deepEqual(first.map(record => record?.drawOrder ?? null), ['order-a', null, null]);
  assert.equal(frames, 2, 'each deferred store asks for another frame');
  renderer.beginFrame();
  stores.forEach(store => renderer._ensureStoreDrawOrder(store, tree(`order-${store}`)));
  renderer.beginFrame();
  stores.forEach(store => renderer._ensureStoreDrawOrder(store, tree(`order-${store}`)));
  assert.deepEqual(adopted, ['a', 'b', 'c']);
  const viewer = readFileSync(new URL('../assets/js/rendering/viewer.js', import.meta.url), 'utf8');
  assert.match(viewer, /function renderSceneFrame\(\) \{\n\s*hpRenderer\.beginFrame\(\);/);
});

test('an error other than OUT_OF_MEMORY is reported, never retried', () => {
  const events = [];
  let pending = 0x0502;
  const gl = {
    NO_ERROR: 0,
    OUT_OF_MEMORY: 0x0505,
    getError() { const code = pending; pending = 0; return code; },
    isContextLost: () => false,
  };
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    gl,
    getRetainedGeometryBytes: () => 1_000,
    getKeptColorBytes: () => 0,
    evictRetainedGeometry() { events.push('evict'); return 0; },
  });
  assert.throws(
    () => renderer._allocateGpu('refused', () => events.push('allocate')),
    /refused \(WebGL error 0x502\)/,
  );
  assert.deepEqual(events, ['allocate']);
});
