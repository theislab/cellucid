/**
 * The payload download scheduler: foreground downloads start at once and hold
 * new background downloads back; one download per URL serves every caller and
 * is cancelled only when every caller has cancelled.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FetchScheduler,
  fetchPriorityHint,
  requirePriority,
} from '../assets/js/data/fetch-scheduler.js';

function manual() {
  const started = [];
  const start = key => (signal, priority) => new Promise((resolve, reject) => {
    const entry = { key, hint: fetchPriorityHint(priority), priority, signal, resolve, reject };
    started.push(entry);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  return { started, start };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('foreground downloads start at once and hold new background ones back', async () => {
  const scheduler = new FetchScheduler();
  const { started, start } = manual();
  const bulkA = scheduler.run({ key: 'a', priority: 'bulk', start: start('a') });
  await tick();
  assert.deepEqual(started.map(s => s.key), ['a'], 'background starts when nothing is in the foreground');
  const chosen = scheduler.run({ key: 'g', priority: 'high', start: start('g') });
  const bulkB = scheduler.run({ key: 'b', priority: 'bulk', start: start('b') });
  const prefetch = scheduler.run({ key: 'p', priority: 'low', start: start('p') });
  const bulkC = scheduler.run({ key: 'c', priority: 'bulk', start: start('c') });
  await tick();
  assert.deepEqual(started.map(s => s.key), ['a', 'g'], 'the running background download keeps going; new ones wait');
  assert.deepEqual(started.map(s => s.hint), ['low', 'high']);
  assert.deepEqual(scheduler.stats, { queued: 3, running: 2, foregroundInFlight: 1 });

  started[1].resolve('gene');
  assert.equal(await chosen, 'gene');
  await tick();
  assert.deepEqual(started.map(s => s.key), ['a', 'g', 'b', 'c', 'p'], 'bulk before low, first come first served');
  for (const entry of started.slice(2)) entry.resolve(entry.key);
  started[0].resolve('a');
  assert.deepEqual(await Promise.all([bulkA, bulkB, bulkC, prefetch]), ['a', 'b', 'c', 'p']);
  assert.deepEqual(scheduler.stats, { queued: 0, running: 0, foregroundInFlight: 0 });
});

test('a request for a payload in flight joins it and raises its priority', async () => {
  const scheduler = new FetchScheduler();
  const { started, start } = manual();
  const hold = scheduler.run({ key: 'busy', priority: 'normal', start: start('busy') });
  const prefetched = scheduler.run({ key: 'x', priority: 'low', start: start('x') });
  await tick();
  assert.deepEqual(started.map(s => s.key), ['busy']);
  // The user chooses the gene that was only prefetched: it starts now, once.
  const chosen = scheduler.run({ key: 'x', priority: 'high', start: start('x-again') });
  await tick();
  assert.deepEqual(started.map(s => s.key), ['busy', 'x']);
  assert.equal(started[1].hint, 'high');
  started[1].resolve('values');
  assert.deepEqual(await Promise.all([prefetched, chosen]), ['values', 'values']);
  started[0].resolve('done');
  await hold;
});

test('a shared download is cancelled only when every caller has cancelled', async () => {
  const scheduler = new FetchScheduler();
  const { started, start } = manual();
  const first = new AbortController();
  const second = new AbortController();
  const a = scheduler.run({ key: 'k', priority: 'high', signal: first.signal, start: start('k') });
  const b = scheduler.run({ key: 'k', priority: 'high', signal: second.signal, start: start('k') });
  await tick();
  assert.equal(started.length, 1);
  first.abort(new DOMException('moved on', 'AbortError'));
  await assert.rejects(a, error => error.name === 'AbortError');
  assert.equal(started[0].signal.aborted, false, 'the other caller still waits');
  second.abort(new DOMException('moved on', 'AbortError'));
  await assert.rejects(b, error => error.name === 'AbortError');
  assert.equal(started[0].signal.aborted, true);
  await tick();
  assert.deepEqual(scheduler.stats, { queued: 0, running: 0, foregroundInFlight: 0 });
});

test('a queued download whose callers all leave never starts', async () => {
  const scheduler = new FetchScheduler();
  const { started, start } = manual();
  const hold = scheduler.run({ key: 'fg', priority: 'high', start: start('fg') });
  const controller = new AbortController();
  const queued = scheduler.run({ key: 'q', priority: 'low', signal: controller.signal, start: start('q') });
  controller.abort(new DOMException('moved on', 'AbortError'));
  await assert.rejects(queued, error => error.name === 'AbortError');
  started[0].resolve(1);
  await hold;
  await tick();
  assert.deepEqual(started.map(s => s.key), ['fg']);
  assert.deepEqual(scheduler.stats, { queued: 0, running: 0, foregroundInFlight: 0 });
});

test('a failure reaches every caller of the shared download, and the key is free again', async () => {
  const scheduler = new FetchScheduler();
  const { started, start } = manual();
  const injected = new Error('404');
  const a = scheduler.run({ key: 'k', priority: 'normal', start: start('k') });
  const b = scheduler.run({ key: 'k', priority: 'bulk', start: start('k') });
  await tick();
  started[0].reject(injected);
  await assert.rejects(a, error => error === injected);
  await assert.rejects(b, error => error === injected);
  const again = scheduler.run({ key: 'k', priority: 'high', start: start('k') });
  await tick();
  assert.equal(started.length, 2);
  started[1].resolve('ok');
  assert.equal(await again, 'ok');
});

test('priorities are exact', () => {
  assert.equal(fetchPriorityHint('high'), 'high');
  assert.equal(fetchPriorityHint('normal'), 'high');
  assert.equal(fetchPriorityHint('bulk'), 'low');
  assert.equal(fetchPriorityHint('low'), 'low');
  assert.throws(() => requirePriority('urgent'), /exactly/);
  assert.throws(() => new FetchScheduler().run({ key: 'k', priority: 'high', start: null }), /start function/);
});

test('raise promotes a queued download without joining it', async () => {
  const scheduler = new FetchScheduler();
  const { started, start } = manual();
  const hold = scheduler.run({ key: 'fg', priority: 'high', start: start('fg') });
  const owner = {};
  const queued = scheduler.run({ key: owner, priority: 'low', start: start('owned') });
  await tick();
  assert.deepEqual(started.map(s => s.key), ['fg']);
  scheduler.raise(owner, 'high');
  scheduler.raise({}, 'high');
  await tick();
  assert.deepEqual(started.map(s => [s.key, s.hint]), [['fg', 'high'], ['owned', 'high']]);
  started[1].resolve('v');
  started[0].resolve('w');
  assert.deepEqual(await Promise.all([queued, hold]), ['v', 'w']);
  assert.throws(() => scheduler.run({ key: '', priority: 'high', start: () => {} }), /key/);
});

test('closing ends every download, queued or running, and refuses new ones', async () => {
  const scheduler = new FetchScheduler();
  const signals = [];
  const never = (signal) => {
    signals.push(signal);
    return new Promise(() => {});
  };
  const running = scheduler.run({ key: 'chosen', priority: 'high', start: never });
  // Waits behind the foreground download.
  const queued = scheduler.run({ key: 'bulk', priority: 'bulk', start: never });
  assert.equal(signals.length, 1);
  const reason = new DOMException('replaced', 'AbortError');
  scheduler.close(reason);
  await assert.rejects(running, error => error === reason);
  await assert.rejects(queued, error => error === reason);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals.length, 1, 'the queued download never started');
  assert.deepEqual(scheduler.stats, { queued: 0, running: 0, foregroundInFlight: 0 });
  await assert.rejects(
    scheduler.run({ key: 'late', priority: 'high', start: never }),
    error => error === reason,
  );
  assert.equal(signals.length, 1);
});
