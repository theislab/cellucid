// Abort listeners: an `abort` event is dispatched once, when a signal aborts,
// and never again, so a listener added to a signal that has already aborted
// never runs and the work it was meant to stop runs to its end. Every site
// under assets/js waits on a signal through `onAbort` (`utils/abort.js`),
// which answers a stopped signal at once; this pins the rule and the helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { abortListenerCount, abortWaiterCount, awaitWithSignal, onAbort } from '../assets/js/utils/abort.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = path.join(root, 'assets', 'js');
const HELPER = path.join('assets', 'js', 'utils', 'abort.js');

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(m?js)$/.test(entry.name) ? [full] : [];
  });
}

/** A signal whose listeners are counted, as the DOM keeps them. */
function countedSignal() {
  const controller = new AbortController();
  const { signal } = controller;
  const listeners = new Set();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, options) => {
    if (type === 'abort') listeners.add(listener);
    add(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === 'abort') listeners.delete(listener);
    remove(type, listener, options);
  };
  return { controller, signal, listeners };
}

test('no abort listener is added or removed outside onAbort (utils/abort.js)', () => {
  // Any spelling: a quote of either kind, a template, a line break after `(`.
  const pattern = /\b(?:add|remove)EventListener\s*\(\s*(['"`])abort\1/g;
  const offenders = [];
  for (const file of sources(scripts)) {
    const relative = path.relative(root, file);
    if (relative === HELPER) continue;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      offenders.push(`${relative}:${line}`);
    }
  }
  assert.deepEqual(offenders, [], 'wait on a signal with onAbort (utils/abort.js), which answers a stopped signal at once');
});

test('no local copy of awaitWithSignal is kept (untilAborted and the like)', () => {
  const offenders = [];
  for (const file of sources(scripts)) {
    const text = readFileSync(file, 'utf8');
    if (/function\s+untilAborted\s*\(/.test(text)) offenders.push(path.relative(root, file));
  }
  assert.deepEqual(offenders, []);
});

test('onAbort on a signal that has already aborted calls back at once, once, and keeps nothing', () => {
  const { controller, signal, listeners } = countedSignal();
  controller.abort(new DOMException('stopped', 'AbortError'));
  const calls = [];
  const stop = onAbort(signal, () => calls.push('called'));
  assert.deepEqual(calls, ['called'], 'called before onAbort returned');
  assert.equal(typeof stop, 'function');
  stop();
  stop();
  assert.deepEqual(calls, ['called'], 'the remover never calls back');
  assert.equal(listeners.size, 0, 'no listener is added to a stopped signal');
  assert.equal(abortWaiterCount(signal), 0);
  signal.dispatchEvent(new Event('abort'));
  assert.deepEqual(calls, ['called'], 'once');
});

test('onAbort on a signal aborted later calls back once, in registration order', () => {
  const { controller, signal, listeners } = countedSignal();
  const calls = [];
  onAbort(signal, () => calls.push(1));
  onAbort(signal, () => calls.push(2));
  assert.deepEqual(calls, []);
  assert.equal(listeners.size, 1, 'one listener per signal, however many wait');
  controller.abort();
  assert.deepEqual(calls, [1, 2]);
  signal.dispatchEvent(new Event('abort'));
  assert.deepEqual(calls, [1, 2], 'once');
  assert.equal(abortWaiterCount(signal), 0);
});

test('onAbort removed before the abort never calls back, and leaves no listener', () => {
  const { controller, signal, listeners } = countedSignal();
  const calls = [];
  const stop = onAbort(signal, () => calls.push('called'));
  assert.equal(listeners.size, 1);
  stop();
  assert.equal(listeners.size, 0);
  assert.equal(abortListenerCount(signal), 0);
  controller.abort();
  assert.deepEqual(calls, []);
});

test('onAbort keeps no callback of settled work on a long-lived signal', () => {
  const { controller, signal, listeners } = countedSignal();
  // Thousands of requests come and go under one dataset-long signal.
  for (let i = 0; i < 10_000; i++) {
    const stop = onAbort(signal, () => assert.fail('a settled request is never called back'));
    stop();
  }
  assert.equal(abortWaiterCount(signal), 0);
  assert.equal(listeners.size, 0);
  // Some still waiting: one listener, and each is called back.
  let called = 0;
  const waiting = Array.from({ length: 100 }, () => onAbort(signal, () => called++));
  assert.equal(listeners.size, 1);
  assert.equal(abortWaiterCount(signal), 100);
  waiting.slice(0, 50).forEach(stop => stop());
  controller.abort();
  assert.equal(called, 50);
  assert.equal(abortWaiterCount(signal), 0);
});

test('a callback registered while the signal\'s abort is being dispatched is called at once', () => {
  const controller = new AbortController();
  const calls = [];
  onAbort(controller.signal, () => {
    calls.push('first');
    onAbort(controller.signal, () => calls.push('during'));
  });
  controller.abort();
  assert.deepEqual(calls, ['first', 'during']);
});

test('onAbort without a signal waits for nothing', () => {
  let called = false;
  for (const signal of [null, undefined]) {
    const stop = onAbort(signal, () => {
      called = true;
    });
    assert.equal(typeof stop, 'function');
    stop();
  }
  assert.equal(called, false);
});

test('a throwing callback does not keep the others from running', () => {
  const controller = new AbortController();
  const calls = [];
  const reported = [];
  onAbort(controller.signal, () => {
    throw new Error('one listener fails');
  });
  onAbort(controller.signal, () => calls.push('next'));
  // Reported as every listener's failure is (`utils/listener-set.js`).
  const consoleError = console.error;
  console.error = (message, error) => reported.push(error.message);
  try {
    controller.abort();
  } finally {
    console.error = consoleError;
  }
  assert.deepEqual(calls, ['next']);
  assert.deepEqual(reported, ['one listener fails']);
});

test('awaitWithSignal rejects at once for a stopped signal and observes the work', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('stopped', 'AbortError'));
  let unhandled = null;
  const onUnhandled = reason => {
    unhandled = reason;
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(awaitWithSignal(Promise.reject(new Error('late failure')), controller.signal), { name: 'AbortError' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unhandled, null);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
