/**
 * Gene reads go through the one read scheduler:
 * - a gene the user waits for (`high`) starts at once, and a long run's next
 *   read (`bulk`) waits until it has arrived;
 * - a prefetch the user then chooses is raised, not read twice;
 * - a replaced dataset releases every read it held;
 * - a gene of a matrix stored cell by cell is said to cost the whole matrix
 *   before it is read, and the person can stop it; a failed gene says why.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { FieldLoadingMethods, isFieldLoadCancelledError } from '../assets/js/app/state/managers/field/loading.js';

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

/** The notification center, recorded: every call and its arguments, and the cancel handlers given. */
function recordNotifications(t) {
  const notifications = getNotificationCenter();
  const names = ['loading', 'complete', 'fail', 'dismiss', 'hasNotification'];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  const calls = [];
  const live = new Set();
  let next = 0;
  notifications.loading = (message, options = {}) => {
    const id = options.id ?? `n${++next}`;
    live.add(id);
    calls.push({ name: 'loading', id, message, options });
    return id;
  };
  for (const name of ['complete', 'fail', 'dismiss']) {
    notifications[name] = (id, message) => {
      live.delete(id);
      calls.push({ name, id, message });
    };
  }
  notifications.hasNotification = id => live.has(id);
  t.after(() => {
    for (const [name, method] of originals) notifications[name] = method;
  });
  return calls;
}

test('a gene stored cell by cell is said to cost the whole matrix before it is read, and Cancel stops its read', async t => {
  const calls = recordNotifications(t);
  const reads = [];
  const loader = (descriptor, options) => {
    const read = deferred();
    reads.push({ signal: options.signal, read });
    options.signal.addEventListener('abort', () => read.reject(options.signal.reason));
    return read.promise;
  };
  loader.readPlan = async () => ({
    label: 'X',
    cellMajor: true,
    built: false,
    scan: { storedBytes: 4.7 * 2 ** 30, valueBytes: 1 },
    index: { passes: 1, placement: 'memory', refusal: null, secondPassStoredBytes: null },
    bytesPerSecond: 2 ** 20,
  });
  const state = geneState(['SFTPC'], loader);
  const load = state.ensureVarFieldLoaded(0, { priority: 'high' });
  load.catch(() => {});
  await tick();
  await tick();
  const [first, plan] = calls.filter(call => call.name === 'loading');
  assert.equal(first.message, 'Loading gene: SFTPC');
  assert.equal(typeof first.options.onCancel, 'function', 'the load can be cancelled');
  assert.equal(plan.id, first.id, 'the cost is said in the same notification');
  assert.match(plan.message, /^Loading gene: SFTPC\. X is stored cell by cell, so the first gene reads every cell's entries: 4\.7 GB \(~1 h 20 min at the measured 1\.0 MB\/s\)\. Later genes read the gene index it builds\.$/);
  first.options.onCancel();
  await assert.rejects(load, error => isFieldLoadCancelledError(error));
  assert.equal(reads[0].signal.aborted, true, 'the read itself was stopped');
  assert.deepEqual(calls.at(-1), { name: 'complete', id: first.id, message: 'Stopped loading gene: SFTPC' });
});

test('a gene that cannot be read says why, in its notification', async t => {
  const calls = recordNotifications(t);
  const state = geneState(['EPCAM'], () => Promise.reject(new Error('Sparse X indices chunk 12 could not be decoded: incorrect header check')));
  await assert.rejects(state.ensureVarFieldLoaded(0, { priority: 'high' }), /incorrect header check/);
  assert.deepEqual(calls.at(-1).message, 'Failed to load gene: EPCAM: Sparse X indices chunk 12 could not be decoded: incorrect header check');
});
