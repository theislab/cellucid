/**
 * The one debounce (`utils/debounce.js`, round 9): it replaced 20 written by
 * hand (`clearTimeout(t); t = setTimeout(...)`), each with its own idea of
 * cancel and flush. `tests/one-implementation-contract.test.mjs` finds a new
 * copy.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { debounce } from '../assets/js/utils/debounce.js';

const later = ms => new Promise(resolve => setTimeout(resolve, ms));

test('runs once the calls stop, with the last call\'s arguments', async () => {
  const runs = [];
  const settle = debounce((...args) => runs.push(args), 20);
  settle(1);
  settle(2, 'b');
  assert.equal(settle.pending, true);
  await later(5);
  settle(3, 'c');
  await later(10);
  assert.deepEqual(runs, [], 'each call pushes the run back');
  await later(30);
  assert.deepEqual(runs, [[3, 'c']]);
  assert.equal(settle.pending, false);
});

test('cancel drops the run waiting; flush runs it now; both say whether one was waiting', async () => {
  const runs = [];
  const settle = debounce(value => runs.push(value), 15);
  assert.equal(settle.cancel(), false);
  assert.equal(settle.flush(), false);
  settle('dropped');
  assert.equal(settle.cancel(), true);
  settle('now');
  assert.equal(settle.flush(), true);
  assert.deepEqual(runs, ['now']);
  await later(30);
  assert.deepEqual(runs, ['now'], 'a flushed run does not run again');
});

test('the wait may be a function of the call (a wait the caller measures or names)', async () => {
  const runs = [];
  const settle = debounce((label, _waitMs) => runs.push(label), (_label, waitMs) => waitMs);
  settle('long', 200);
  settle('short', 5);
  await later(30);
  assert.deepEqual(runs, ['short']);
});

test('a run may schedule the next one', async () => {
  const runs = [];
  const settle = debounce(n => {
    runs.push(n);
    if (n < 3) settle(n + 1);
  }, 1);
  settle(1);
  await later(40);
  assert.deepEqual(runs, [1, 2, 3]);
});

test('refuses what is not a function or a wait', () => {
  assert.throws(() => debounce(null, 10), TypeError);
  assert.throws(() => debounce(() => {}, -1), TypeError);
  assert.throws(() => debounce(() => {}, Number.NaN), TypeError);
  assert.throws(() => debounce(() => {}, Infinity), TypeError);
});

test('a canceled or replaced timer\'s callback, called after all, runs nothing', () => {
  const callbacks = [];
  const prior = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  globalThis.setTimeout = callback => callbacks.push(callback);
  globalThis.clearTimeout = () => {};
  try {
    const runs = [];
    const settle = debounce(value => runs.push(value), 10);
    settle('first');
    settle('second');
    settle.cancel();
    for (const callback of callbacks) callback();
    assert.deepEqual(runs, []);
    settle('third');
    callbacks.at(0)();
    callbacks.at(-1)();
    assert.deepEqual(runs, ['third']);
  } finally {
    globalThis.setTimeout = prior.set;
    globalThis.clearTimeout = prior.clear;
  }
});
