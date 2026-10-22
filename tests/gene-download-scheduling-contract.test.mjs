/**
 * Gene downloads go through the one download scheduler and the per-load
 * payload cache:
 * - a gene the user waits for (`high`) starts at once, and a long run's next
 *   download (`bulk`) waits until it has arrived;
 * - a prefetch the user then chooses is raised, not downloaded twice;
 * - the browser is told the urgency (`priority` on the fetch);
 * - a gene evicted from memory is decoded again from the bytes its dataset
 *   load already downloaded, without a request, identically.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { FieldLoadingMethods } from '../assets/js/app/state/managers/field/loading.js';
import { createVarFieldLoader } from '../assets/js/data/data-loaders.js';
import { getNotificationCenter } from '../assets/js/app/notification-center.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function geneState(keys, loader) {
  const fields = keys.map(key => ({ key, kind: 'continuous', loaded: false }));
  return Object.assign(Object.create(FieldLoadingMethods.prototype), {
    _datasetGeneration: 1,
    _fieldDataCache: new Map(),
    _obsFieldDescriptors: Object.freeze([]),
    _varFieldDataCache: new Map(),
    _varFieldDescriptors: Object.freeze(fields.map(f => ({ ...f }))),
    fieldLoader: null,
    obsData: { fields: [] },
    pointCount: 2,
    varData: { fields },
    varFieldLoader: loader,
  });
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('a gene the user waits for holds back the next download of a long run', async () => {
  const started = [];
  const loads = new Map();
  const loader = (descriptor, options) => {
    started.push({ key: descriptor.key, priority: options.priority });
    const load = deferred();
    loads.set(descriptor.key, load);
    return load.promise;
  };
  const state = geneState(['bulk1', 'chosen', 'bulk2'], loader);
  const first = state.ensureVarFieldLoaded(0, { silent: true, priority: 'bulk' });
  await tick();
  const chosen = state.ensureVarFieldLoaded(1, { silent: true, priority: 'high' });
  const second = state.ensureVarFieldLoaded(2, { silent: true, priority: 'bulk' });
  await tick();
  assert.deepEqual(started.map(s => s.key), ['bulk1', 'chosen'], 'bulk2 waits for the chosen gene');
  loads.get('chosen').resolve({ values: Float32Array.of(1, 2) });
  await chosen;
  await tick();
  assert.deepEqual(started.map(s => s.key), ['bulk1', 'chosen', 'bulk2']);
  loads.get('bulk1').resolve({ values: Float32Array.of(3, 4) });
  loads.get('bulk2').resolve({ values: Float32Array.of(5, 6) });
  await Promise.all([first, second]);
  assert.deepEqual(started.map(s => s.priority), ['bulk', 'high', 'bulk']);
});

test('a queued prefetch the user chooses starts at once, once', async () => {
  const started = [];
  const loads = new Map();
  const loader = descriptor => {
    started.push(descriptor.key);
    const load = deferred();
    loads.set(descriptor.key, load);
    return load.promise;
  };
  const state = geneState(['busy', 'prefetched'], loader);
  const busy = state.ensureVarFieldLoaded(0, { silent: true, priority: 'normal' });
  const prefetch = state.ensureVarFieldLoaded(1, { silent: true, priority: 'low' });
  await tick();
  assert.deepEqual(started, ['busy']);
  const chosen = state.ensureVarFieldLoaded(1, { silent: true, priority: 'high' });
  await tick();
  assert.deepEqual(started, ['busy', 'prefetched']);
  loads.get('prefetched').resolve({ values: Float32Array.of(1, 2) });
  loads.get('busy').resolve({ values: Float32Array.of(3, 4) });
  const [a, b] = await Promise.all([prefetch, chosen, busy]);
  assert.strictEqual(a, b);
  assert.equal(started.length, 2);
});

test('the var loader tells the browser the urgency and decodes an evicted gene from its own download', async t => {
  const previous = globalThis.fetch;
  const requests = [];
  const values = Float32Array.of(0.5, -2, 7.25);
  const body = gzipSync(Buffer.from(values.buffer));
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), priority: init?.priority });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/gzip', 'content-length': String(body.byteLength) },
    });
  };
  t.after(() => {
    globalThis.fetch = previous;
  });
  const loader = createVarFieldLoader('https://example.test/var_manifest.json', { pointCount: 3 });
  const field = {
    key: 'G', kind: 'continuous', valuesPath: 'var/0.values.f32.gz', valuesDtype: 'float32', quantized: false,
  };
  const first = await loader(field, { priority: 'high' });
  const again = await loader(field, { priority: 'bulk' });
  const prefetch = await loader({ ...field, valuesPath: 'var/1.values.f32.gz' }, { priority: 'low' });
  assert.deepEqual(requests.map(r => [r.url.split('/').pop(), r.priority]), [
    ['0.values.f32.gz', 'high'],
    ['1.values.f32.gz', 'low'],
  ]);
  for (const loaded of [first, again, prefetch]) {
    assert.deepEqual([...loaded.values], [...values]);
  }
  assert.notStrictEqual(first.values, again.values, 'each load decodes its own copy');
});

test('a gene the user waits for reports its download a percent at a time', async t => {
  const previous = globalThis.fetch;
  const body = new Uint8Array(4096).fill(7);
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < 64; i++) controller.enqueue(body.subarray(i * 64, (i + 1) * 64));
      controller.close();
    },
  }), { status: 200, headers: { 'content-length': String(body.byteLength) } });
  t.after(() => {
    globalThis.fetch = previous;
  });
  const loader = createVarFieldLoader('https://example.test/var_manifest.json', { pointCount: 1024 });
  const updates = [];
  await loader(
    { key: 'G', kind: 'continuous', valuesPath: 'var/0.values.f32', valuesDtype: 'float32', quantized: false },
    { priority: 'high', onProgress: (loaded, total) => updates.push([loaded, total]) }
  );
  assert.equal(updates.length, 64);
  assert.deepEqual(updates.at(-1), [4096, 4096]);
});

test('a gene the user waits for fills its own loading notification', async t => {
  // The notification centre's own option contract runs; only drawing is
  // replaced, as there is no page here.
  const notifications = getNotificationCenter();
  const updates = [];
  const replaced = {
    loading: () => 'gene-notification',
    complete: () => {},
    fail: () => {},
    _updateNotification: (id, options) => updates.push([id, options.progress]),
  };
  const originals = Object.fromEntries(Object.keys(replaced).map(name => [name, notifications[name]]));
  Object.assign(notifications, replaced);
  t.after(() => Object.assign(notifications, originals));
  const loader = (descriptor, options) => {
    for (const loaded of [0, 1024, 1500, 4096]) options.onProgress(loaded, 4096);
    return Promise.resolve({ values: Float32Array.of(1, 2) });
  };
  const state = geneState(['chosen'], loader);
  await state.ensureVarFieldLoaded(0, { priority: 'high' });
  assert.deepEqual(updates, [
    ['gene-notification', 0],
    ['gene-notification', 25],
    ['gene-notification', 36],
    ['gene-notification', 100],
  ]);
});

test('a replaced dataset releases every download it held, even one that never settles', async () => {
  // Generation 1: the user waits for a gene whose read never returns (a
  // stalled file read). It is a foreground download, which holds back long
  // runs' downloads while it is in flight.
  const stalled = { signal: null };
  const state = geneState(['old'], (descriptor, options) => {
    stalled.signal = options.signal;
    return new Promise(() => {});
  });
  const waiting = state.ensureVarFieldLoaded(0, { silent: true, priority: 'high' });
  waiting.catch(() => {});
  await tick();
  assert.ok(stalled.signal instanceof AbortSignal);
  assert.equal(stalled.signal.aborted, false);

  // The dataset is replaced: a new generation, new fields, a new loader.
  const started = [];
  const fields = [{ key: 'new', kind: 'continuous', loaded: false }];
  Object.assign(state, {
    _datasetGeneration: 2,
    _varFieldDescriptors: Object.freeze(fields.map(f => ({ ...f }))),
    varData: { fields },
    varFieldLoader: descriptor => {
      started.push(descriptor.key);
      return Promise.resolve({ values: Float32Array.of(1, 2) });
    },
  });

  // A long run's download on the new dataset starts at once: nothing of the
  // old dataset counts as in flight.
  await state.ensureVarFieldLoaded(0, { silent: true, priority: 'bulk' });
  assert.deepEqual(started, ['new']);
  // The stalled download was aborted, and its waiter released.
  assert.equal(stalled.signal.aborted, true);
  await assert.rejects(waiting);
});
