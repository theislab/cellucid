/**
 * The decoded chunks a subsample's view reads through
 * (`data/anndata/decoded-chunks.js`): shared decodes, kept by recency within
 * the store's decoded-chunk budget, which the store's own cache shares
 * (`formats/io/decoded-budget.js`), held by every opening reading through
 * them and none kept once the last lets go; a decode shared by several reads
 * stops only once every one of them withdrew.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DecodedChunks } from '../assets/js/data/anndata/decoded-chunks.js';

const block = n => new Float32Array(n);

test('a chunk is decoded once while kept; concurrent asks share its decode', async () => {
  const chunks = new DecodedChunks(1024);
  let decodes = 0;
  const decode = () => { decodes++; return Promise.resolve(block(16)); };
  const [a, b] = await Promise.all([chunks.get('x|0', decode), chunks.get('x|0', decode)]);
  assert.equal(a, b);
  assert.equal(await chunks.get('x|0', decode), a);
  assert.equal(decodes, 1);
  assert.equal(chunks.decoded, 1);
  assert.equal(chunks.bytes, 64);
});

test('the least recently used chunks go first, within the budget; one chunk over it serves its read and is not kept', async () => {
  const chunks = new DecodedChunks(128);
  await chunks.get('a', async () => block(16));
  await chunks.get('b', async () => block(16));
  await chunks.get('a', async () => assert.fail('kept'));
  await chunks.get('c', async () => block(16));
  assert.equal(chunks.bytes, 128);
  let decoded = false;
  await chunks.get('b', async () => { decoded = true; return block(16); });
  assert.equal(decoded, true, 'b, the least recently used, went');
  const big = await chunks.get('d', async () => block(64));
  assert.equal(big.length, 64);
  assert.ok(chunks.bytes <= 128);
});

test('a failed decode is not kept; chunks let go keep nothing more', async () => {
  const chunks = new DecodedChunks(1024);
  await assert.rejects(chunks.get('a', async () => { throw new Error('refused'); }), /refused/);
  assert.equal((await chunks.get('a', async () => block(4))).length, 4);
  chunks.release();
  assert.equal(chunks.held, false);
  assert.equal(chunks.bytes, 0);
  let decodes = 0;
  await chunks.get('a', async () => { decodes++; return block(4); });
  await chunks.get('a', async () => { decodes++; return block(4); });
  assert.equal(decodes, 2);
});

test('the store\'s own decoded-chunk caches and the reader\'s chunks hold one budget together, never twice it', async () => {
  const { DecodedBudget } = await import('../assets/js/formats/io/decoded-budget.js');
  const { ByteCache } = await import('../assets/js/formats/io/byte-cache.js');
  {
    const budget = new DecodedBudget(128);
    // A Zarr store's or an HDF5 file's own cache (one class for both).
    const store = new ByteCache(budget);
    const chunks = new DecodedChunks(budget);
    for (const key of ['s1', 's2', 's3', 's4']) store.set(key, block(4), 16);
    assert.equal(store.bytes, 64);
    for (const key of ['c1', 'c2', 'c3', 'c4']) await chunks.get(key, async () => block(4));
    assert.equal(budget.heldBytes, 128, 'both hold their share of one budget');
    // More of the reader's: its own least recently used go first.
    await chunks.get('c5', async () => block(4));
    assert.equal(budget.heldBytes, 128);
    assert.equal(store.bytes, 64, 'the store\'s cache keeps what it had');
    await chunks.get('c2', async () => assert.fail('c2 is kept'));
    let decoded = false;
    await chunks.get('c1', async () => { decoded = true; return block(4); });
    assert.ok(decoded, 'c1, its oldest, went');
    // A chunk larger than what the reader holds takes room from the store's cache.
    await chunks.get('big', async () => block(24));
    assert.ok(budget.heldBytes <= 128, `${budget.heldBytes} bytes held`);
    assert.ok(store.bytes < 64, 'the store\'s oldest went once the reader\'s own were not enough');
    // Let go (the store's last opening closed): it holds nothing and counts nothing.
    chunks.release();
    assert.equal(budget.heldBytes, store.bytes);
    store.set('s5', block(4), 16);
    assert.ok(budget.heldBytes <= 128);
  }
});

test('a cleared set of chunks keeps reading and keeping', async () => {
  const chunks = new DecodedChunks(1024);
  await chunks.get('a', async () => block(4));
  chunks.clear();
  assert.equal(chunks.bytes, 0);
  let decodes = 0;
  await chunks.get('a', async () => { decodes++; return block(4); });
  await chunks.get('a', async () => { decodes++; return block(4); });
  assert.equal(decodes, 1);
});

test('a decode shared by two reads goes on when one is cancelled: the other gets the chunk, never an AbortError', async () => {
  const chunks = new DecodedChunks(1024);
  let decodes = 0;
  let decodeSignal = null;
  let finish;
  const decode = ({ signal }) => {
    decodes++;
    decodeSignal = signal;
    return new Promise((resolve, reject) => {
      finish = resolve;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const cancelled = new AbortController();
  const first = chunks.get('x|0', decode, { signal: cancelled.signal });
  const second = chunks.get('x|0', decode, { signal: new AbortController().signal });
  const third = chunks.get('x|0', decode, {});
  cancelled.abort(new DOMException('first canceled', 'AbortError'));
  await assert.rejects(first, error => error.message === 'first canceled');
  assert.equal(decodeSignal.aborted, false, 'the others still wait: the decode goes on');
  finish(block(4));
  assert.equal((await second).length, 4);
  assert.equal(await third, await second);
  assert.equal(decodes, 1);
  assert.equal(chunks.bytes, 16, 'kept for the next read');

  // Every read withdrew: the decode stops, and the next read decodes anew.
  const a = new AbortController();
  const b = new AbortController();
  const both = [chunks.get('y|0', decode, { signal: a.signal }), chunks.get('y|0', decode, { signal: b.signal })];
  const stopped = decodeSignal;
  a.abort();
  b.abort();
  await Promise.allSettled(both);
  assert.equal(stopped.aborted, true, 'nobody waits: the decode stops');
  const again = chunks.get('y|0', decode, { signal: new AbortController().signal });
  assert.notEqual(decodeSignal, stopped, 'a later read starts it anew rather than joining the stopped one');
  finish(block(2));
  assert.equal((await again).length, 2);
});

test('chunks held by several openings go only when the last lets go', async () => {
  const chunks = new DecodedChunks(1024);
  await chunks.get('a', async () => block(4));
  assert.equal(chunks.retain(), chunks);
  chunks.retain();
  chunks.release();
  chunks.release();
  assert.equal(chunks.held, true, 'one opening still holds them');
  await chunks.get('a', async () => assert.fail('still kept'));
  chunks.release();
  assert.equal(chunks.held, false);
  assert.equal(chunks.bytes, 0);
  chunks.release();
  assert.throws(() => chunks.retain(), /not held again/);
});

test('a subsample\'s view: a read cancelled never fails another read of the same rows through the store\'s chunks', async () => {
  const { gatheredArray, runsOfPositions } = await import('../assets/js/data/anndata/views/cell-subset.js');
  // A chunked 1-D array of 100 rows in 10-row chunks whose read honors its signal.
  let reads = 0;
  const real = {
    kind: 'array', path: 'obs/x', name: 'x', attrs: {}, attributeType: () => null,
    shape: [100], dtype: { kind: 'float', size: 4 }, chunks: [10], partialChunks: false, fillValue: 0,
    async storedBytes() { return 40; },
    read([[a, b]], { signal } = {}) {
      reads++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(Float32Array.from({ length: b - a }, (_, i) => a + i)), 20);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    },
  };
  const kept = runsOfPositions(Uint32Array.from([1, 2, 3, 15, 55]));
  const chunks = new DecodedChunks(1 << 20);
  const one = gatheredArray(real, kept, { mergeGapBytes: () => 0, chunks });
  const other = gatheredArray(real, kept, { mergeGapBytes: () => 0, chunks });
  const cancelled = new AbortController();
  const first = one.read([[0, 5]], { signal: cancelled.signal });
  const second = other.read([[0, 5]], {});
  setTimeout(() => cancelled.abort(new DOMException('cancelled', 'AbortError')), 5);
  await assert.rejects(first, error => error.name === 'AbortError');
  assert.deepEqual(Array.from(await second), [1, 2, 3, 15, 55]);
  assert.equal(reads, 3, 'each chunk read once, for both reads');
});

test('decoded chunks stay while nothing asks for their room, and every store\'s go when the memory model trims them, oldest first', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { DecodedBudget, heldDecodedBytes, trimDecodedChunks } = await import('../assets/js/formats/io/decoded-budget.js');
  const { WORKER_IDLE_MS } = await import('../assets/js/workers/idle-retirement.js');
  const { ByteCache } = await import('../assets/js/formats/io/byte-cache.js');
  const budget = new DecodedBudget(1024);
  // A Zarr store's and an HDF5 file's caches on one budget.
  const zarr = new ByteCache(budget);
  const hdf5 = new ByteCache(budget);
  const chunks = new DecodedChunks(budget);
  zarr.set('z', block(4), 16);
  hdf5.set('h', block(4), 16);
  await chunks.get('c', async () => block(4));
  // No clock lets them go: a gene read after a pause next to the last one
  // decodes nothing again.
  t.mock.timers.tick(100 * WORKER_IDLE_MS);
  assert.equal(budget.heldBytes, 48, 'kept however long nothing is read');
  assert.ok(heldDecodedBytes() >= 48, 'counted with every open store\'s');
  // A budget read whenever it is used follows the share as it changes.
  let share = 1024;
  const following = new DecodedBudget(() => share);
  const other = new ByteCache(following);
  other.set('o1', block(4), 16);
  other.set('o2', block(4), 16);
  share = 16;
  other.set('o3', block(4), 16);
  assert.equal(following.heldBytes, 16, 'kept within the budget as it is now');
  // The memory model trims them (the share shrank, the page is hidden).
  assert.equal(trimDecodedChunks(0), 'decoded chunks');
  assert.equal(budget.heldBytes, 0, 'every cache let its chunks go');
  assert.equal(heldDecodedBytes(), 0);
  assert.equal(zarr.get('z'), undefined);
  assert.equal(hdf5.get('h'), undefined);
  assert.equal(trimDecodedChunks(0), null, 'nothing more to let go');
  let decoded = false;
  await chunks.get('c', async () => { decoded = true; return block(4); });
  assert.equal(decoded, true, 'a chunk asked for after is decoded again');
  // A store's structure (shard indexes) is not decoded chunks: never counted or trimmed.
  const indexes = new ByteCache(new DecodedBudget(1024, { structure: true }));
  indexes.set('shard', block(4), 16);
  trimDecodedChunks(0);
  assert.ok(indexes.get('shard'));
});
