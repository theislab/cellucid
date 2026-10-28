/**
 * One rule for every piece of work the readers share between reads
 * (`formats/io/abort.js`, `SharedWork`): it is cancelled only once every read
 * waiting for it withdrew, and a read whose own signal did not fire never
 * sees another read's AbortError. Checked here for each kind of shared work,
 * with a byte source held until both reads wait on the same work, the first
 * then cancelled:
 *
 * - Zarr: a chunk decoded whole, a part of an uncompressed chunk read alone,
 *   and the inner chunks of a shard (with its index);
 * - HDF5: a chunk index read as it is needed (its leaves), a group of chunks
 *   fetched and decoded together, a table of chunks;
 * - the byte reader's merged requests and a web host's merged ranges.
 *
 * Each read waiting alone, when cancelled, stops the work, and the next read
 * reads it anew rather than joining work that was stopped.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { array, group, shardedEntries, zarrEntries } from './helpers/anndata-store.mjs';
import { memoryStore, openZarr } from '../assets/js/formats/zarr/index.js';
import { httpStore } from '../assets/js/formats/zarr/stores/http.js';
import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { openHdf5 } from '../assets/js/formats/hdf5/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const hdf5Fixture = name => new Uint8Array(readFileSync(path.join(here, 'fixtures', 'hdf5', name)));
const turns = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
const cancelled = () => new DOMException('cancelled', 'AbortError');

/** A gate every read of the store waits at until `open()`; reads honour their signal. */
function gate() {
  let opened = false;
  let waiters = [];
  return {
    open() {
      opened = true;
      for (const resolve of waiters) resolve();
      waiters = [];
    },
    close() {
      opened = false;
    },
    pass(signal) {
      if (opened) return Promise.resolve();
      return new Promise((resolve, reject) => {
        waiters.push(resolve);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
}

/** A memory Zarr store whose reads wait at `held` and are counted by key and range. */
function heldStore(entries, held) {
  const base = memoryStore(entries);
  const reads = [];
  return {
    reads,
    store: Object.freeze({
      ...base,
      async get(key, options = {}) {
        await held.pass(options.signal);
        reads.push(key);
        return base.get(key, options);
      },
      async getRanges(key, ranges, options = {}) {
        await held.pass(options.signal);
        reads.push(`${key}@${ranges.map(range => range.suffix ?? `${range.offset}+${range.length}`).join(',')}`);
        return base.getRanges(key, ranges, options);
      },
    }),
  };
}

/**
 * Two reads of `selection` through `read`: the first cancelled once both
 * wait, the second never; then one read alone, cancelled, and one after it.
 */
async function cancelOneOfTwo(read, selection, expected, held, reads) {
  const first = new AbortController();
  const a = read(selection, { signal: first.signal });
  await turns();
  const b = read(selection, { signal: new AbortController().signal });
  await turns();
  first.abort(cancelled());
  await assert.rejects(a, error => error.message === 'cancelled', 'the cancelled read gets its own reason');
  held.open();
  assert.deepEqual(Array.from(await b), expected, 'the other read gets its values, not the AbortError');
  const once = reads.slice();
  assert.equal(new Set(once).size, once.length, `nothing was read twice: ${once.join(' ')}`);

  // Alone, cancelled: the work stops; the next read reads it anew.
  held.close();
  reads.length = 0;
  return once;
}

test('Zarr: a chunk shared by two reads is decoded once, and cancelling one never fails the other', async () => {
  const values = Float32Array.from({ length: 64 }, (_, i) => i);
  const layouts = {
    // Whole chunks, decoded (zlib).
    compressed: { entries: zarrEntries(group({ x: array(values, { chunks: [16], compressed: true }) })), selection: [[20, 40]] },
    // A part of an uncompressed chunk, read alone (it leaves more than a request costs unread).
    part: { entries: zarrEntries(group({ x: array(Float32Array.from({ length: 8192 }, (_, i) => i), { chunks: [8192] }) })), selection: [[10, 20]] },
    // Inner chunks of shards, with their indexes.
    sharded: { entries: shardedEntries(group({ x: array(values, { chunks: [8] }) }), { factor: 4 }).entries, selection: [[4, 44]] },
  };
  for (const [name, { entries, selection }] of Object.entries(layouts)) {
    const held = gate();
    const { store, reads } = heldStore(entries, held);
    held.open();
    const root = await openZarr(store, { decodedChunkCacheBytes: 0 });
    const x = root.get('x');
    const expected = Array.from(await x.read(selection));
    held.close();
    reads.length = 0;
    await cancelOneOfTwo((sel, options) => x.read(sel, options), selection, expected, held, reads);
    const alone = new AbortController();
    const lone = x.read(selection, { signal: alone.signal });
    await turns();
    alone.abort(cancelled());
    await assert.rejects(lone, error => error.message === 'cancelled');
    held.open();
    assert.deepEqual(Array.from(await x.read(selection)), expected, `${name}: read anew after the work every read left`);
  }
});

test('HDF5: chunk index leaves, chunk groups and the chunk table shared by two reads; cancelling one never fails the other', async () => {
  for (const name of ['many_chunks/btree_levels_gzip', 'many_chunks/btree_levels']) {
    const held = gate();
    const base = bytesByteSource(hdf5Fixture('default-format.h5'), { name: 'held.h5' });
    const reads = [];
    let counting = false;
    const source = Object.freeze({
      size: base.size, name: base.name, identity: base.identity, policy: base.policy,
      async read(offset, length, options = {}) {
        if (counting) reads.push(`${offset}+${length}`);
        await held.pass(options.signal);
        return base.read(offset, length, options);
      },
    });
    held.open();
    const reference = await openHdf5(createByteReader(base));
    const selection = [[8000, 10000]];
    const expected = Array.from(await reference.get(name).read(selection));
    // Opened, nothing of the dataset read yet: its table, leaves and chunks are read by the two reads.
    const root = await openHdf5(createByteReader(source));
    const node = root.get(name);
    held.close();
    counting = true;
    await cancelOneOfTwo((sel, options) => node.read(sel, options), selection, expected, held, reads);
    const alone = new AbortController();
    const lone = node.read([[12000, 14000]], { signal: alone.signal });
    await turns();
    alone.abort(cancelled());
    await assert.rejects(lone, error => error.message === 'cancelled');
    held.open();
    assert.deepEqual(Array.from(await node.read([[12000, 14000]])), Array.from(await reference.get(name).read([[12000, 14000]])),
      `${name}: read anew after the work every read left`);
    root.close();
    reference.close();
  }
});

test('a web host: ranges merged into one request serve the reads left when one is cancelled', async () => {
  const body = Uint8Array.from({ length: 4096 }, (_, i) => i % 251);
  const held = gate();
  let requests = 0;
  const fetchStub = async (url, init = {}) => {
    const range = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? init.headers?.range ?? '');
    requests++;
    await held.pass(init.signal);
    const [start, end] = range === null ? [0, body.length - 1] : [Number(range[1]), Number(range[2])];
    return new Response(body.slice(start, end + 1), {
      status: range === null ? 200 : 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': String(end - start + 1) },
    });
  };
  const store = httpStore('https://host.example/s.zarr/', { fetch: fetchStub });
  const first = new AbortController();
  const a = store.getRanges('x/0', [{ offset: 0, length: 100 }], { signal: first.signal });
  const b = store.getRanges('x/0', [{ offset: 120, length: 100 }], { signal: new AbortController().signal });
  await turns();
  assert.equal(requests, 1, 'one request for both reads');
  first.abort(cancelled());
  await assert.rejects(a, error => error.message === 'cancelled');
  held.open();
  assert.deepEqual(Array.from((await b)[0]), Array.from(body.subarray(120, 220)));
  assert.equal(requests, 1);
});

test('the byte reader: a request merged for two reads goes on for the one left', async () => {
  const bytes = Uint8Array.from({ length: 1 << 16 }, (_, i) => i % 253);
  const base = bytesByteSource(bytes, { name: 'merged.bin' });
  const held = gate();
  let requests = 0;
  const source = Object.freeze({
    size: base.size, name: base.name, identity: base.identity, policy: base.policy,
    async read(offset, length, options = {}) {
      requests++;
      await held.pass(options.signal);
      return base.read(offset, length, options);
    },
  });
  const reader = createByteReader(source);
  const first = new AbortController();
  const a = reader.read(1000, 100, { signal: first.signal });
  const b = reader.read(1000, 100, { signal: new AbortController().signal });
  await turns();
  first.abort(cancelled());
  await assert.rejects(a, error => error.message === 'cancelled');
  held.open();
  assert.deepEqual(Array.from(await b), Array.from(bytes.subarray(1000, 1100)));
  assert.equal(requests, 1, 'one request, not asked again');
});
