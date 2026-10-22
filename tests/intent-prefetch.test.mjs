/**
 * Prefetch on intent: an option kept under the pointer or active for the dwell
 * is loaded once, sweeping past options starts nothing, moving on cancels the
 * load in flight, and a failed prefetch stays silent (choosing the option
 * loads and reports it).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createIntentPrefetcher } from '../assets/js/app/utils/intent-prefetch.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('only an option that stays intended is prefetched, and moving on cancels it', async () => {
  const calls = [];
  const prefetcher = createIntentPrefetcher((key, signal) => {
    calls.push({ key, signal });
    return new Promise(() => {});
  }, 20);
  prefetcher.intend('a');
  prefetcher.intend('b');
  prefetcher.intend('b');
  await wait(60);
  assert.deepEqual(calls.map(call => call.key), ['b']);
  assert.equal(prefetcher.current(), 'b');
  prefetcher.intend('c');
  assert.equal(calls[0].signal.aborted, true);
  await wait(60);
  assert.deepEqual(calls.map(call => call.key), ['b', 'c']);
  prefetcher.cancel();
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(prefetcher.current(), undefined);
});

test('a failing prefetch raises nothing', async () => {
  const prefetcher = createIntentPrefetcher(async () => { throw new Error('offline'); }, 5);
  let unhandled = null;
  const onUnhandled = reason => { unhandled = reason; };
  process.on('unhandledRejection', onUnhandled);
  try {
    prefetcher.intend('x');
    await wait(40);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(unhandled, null);
});
