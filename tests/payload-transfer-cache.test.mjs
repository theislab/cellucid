/**
 * Downloaded gene payloads kept for one dataset load: one download per
 * payload however many callers ask, copies out, a byte budget, LRU eviction for
 * downloads that may evict, admission only while there is room otherwise, and
 * a cancelled download that never fails a caller who still wants it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { PayloadTransferCache } from '../assets/js/data/payload-transfer-cache.js';

const transfer = (fill, size = 4) => ({ bytes: new Uint8Array(size).fill(fill), gzipOutputBytes: size * 3 });

function downloads() {
  const calls = [];
  const start = (key, fill, size) => () => {
    calls.push(key);
    return Promise.resolve(transfer(fill, size));
  };
  return { calls, start };
}

test('one download serves every caller, each with its own copy', async () => {
  const cache = new PayloadTransferCache(100);
  const { calls, start } = downloads();
  const [a, b] = await Promise.all([
    cache.fetch('g', { evict: true }, null, start('g', 1)),
    cache.fetch('g', { evict: false }, null, start('g', 1)),
  ]);
  const c = await cache.fetch('g', { evict: true }, null, start('g', 1));
  assert.deepEqual(calls, ['g']);
  assert.notStrictEqual(a.bytes, b.bytes);
  // Decoding transfers a copy to a worker; the kept bytes stay usable.
  structuredClone(a.bytes.buffer, { transfer: [a.bytes.buffer] });
  assert.deepEqual([...c.bytes], [1, 1, 1, 1]);
  assert.equal(c.gzipOutputBytes, 12);
});

test('a download ahead of decoding is kept without a copy out', async () => {
  const cache = new PayloadTransferCache(100);
  const { calls, start } = downloads();
  assert.deepEqual(await cache.fetch('g', { evict: true, decode: false }, null, start('g', 2)), { kept: true, byteLength: 4 });
  const decoded = await cache.fetch('g', { evict: false }, null, start('g', 2));
  assert.deepEqual([...decoded.bytes], [2, 2, 2, 2]);
  assert.deepEqual(calls, ['g']);
});

test('downloads that may evict drop the least recently used; others need room', async () => {
  const cache = new PayloadTransferCache(12);
  const { start } = downloads();
  await cache.fetch('a', { evict: true }, null, start('a', 1));
  await cache.fetch('b', { evict: true }, null, start('b', 2));
  await cache.fetch('c', { evict: false }, null, start('c', 3));
  await cache.fetch('a', { evict: true }, null, start('a', 1));
  await cache.fetch('d', { evict: true }, null, start('d', 4));
  assert.deepEqual(['a', 'b', 'c', 'd'].map(k => cache.has(k)), [true, false, true, true], 'b was least recently used');
  for (const key of ['e', 'f']) await cache.fetch(key, { evict: false }, null, start(key, 5));
  assert.deepEqual(['e', 'f'].map(k => cache.has(k)), [false, false], 'a full cache keeps a long run\'s first genes');
  assert.equal(cache.byteLength, 12);
  await cache.fetch('big', { evict: true }, null, start('big', 9, 13));
  assert.equal(cache.has('big'), false, 'a payload larger than the budget is never kept');
});

test('a caller whose shared download was cancelled by another downloads again', async () => {
  const cache = new PayloadTransferCache(100);
  let attempts = 0;
  const first = new AbortController();
  const startFirst = () => new Promise((_, reject) => {
    attempts++;
    first.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
  });
  const firstCall = cache.fetch('g', { evict: true }, first.signal, startFirst);
  const second = cache.fetch('g', { evict: true }, null, () => {
    attempts++;
    return Promise.resolve(transfer(7));
  });
  await Promise.resolve();
  first.abort();
  await assert.rejects(firstCall, error => error.name === 'AbortError');
  assert.deepEqual([...(await second).bytes], [7, 7, 7, 7]);
  assert.equal(attempts, 2);
  await assert.rejects(cache.fetch('x', { evict: 'yes' }, null, startFirst), /boolean/);
});
