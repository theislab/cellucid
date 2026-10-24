/**
 * The Zarr reader is efficient in requests, bytes and work: reads touch only
 * the chunks they need, go out together (merged where neighbours, parallel
 * otherwise), share chunks between concurrent reads, keep partly used
 * decoded chunks for the next read, and read sharded arrays by range.
 * Sources here record every request and add latency, as a web host would.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { crc32, openZipArchive } from '../assets/js/formats/zip/index.js';
import { httpStore, memoryStore, openZarr, zipStore } from '../assets/js/formats/zarr/index.js';

import { corpusEntries } from './helpers/zarr-corpus.mjs';
const encoder = new TextEncoder();
const json = value => encoder.encode(JSON.stringify(value));

/** A ZIP of stored entries, in order; returns the bytes and each entry's span. */
function storedZip(entries) {
  const parts = [];
  const centrals = [];
  const spans = new Map();
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = encoder.encode(name);
    const local = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(local.buffer);
    const checksum = crc32(content);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint32(14, checksum, true);
    view.setUint32(18, content.length, true);
    view.setUint32(22, content.length, true);
    view.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    parts.push(local, content);
    spans.set(name, [offset, offset + local.length + content.length]);
    const central = new Uint8Array(46 + nameBytes.length);
    const cview = new DataView(central.buffer);
    cview.setUint32(0, 0x02014b50, true);
    cview.setUint16(4, 0x0314, true);
    cview.setUint16(6, 20, true);
    cview.setUint16(8, 0x0800, true);
    cview.setUint32(16, checksum, true);
    cview.setUint32(20, content.length, true);
    cview.setUint32(24, content.length, true);
    cview.setUint16(28, nameBytes.length, true);
    cview.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length + content.length;
  }
  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const eview = new DataView(end.buffer);
  eview.setUint32(0, 0x06054b50, true);
  eview.setUint16(8, entries.length, true);
  eview.setUint16(10, entries.length, true);
  eview.setUint32(12, centralSize, true);
  eview.setUint32(16, offset, true);
  const all = [...parts, ...centrals, end];
  const bytes = new Uint8Array(all.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of all) {
    bytes.set(p, at);
    at += p.length;
  }
  return { bytes, spans };
}

/**
 * A source with latency that records requests, how many run at once, and
 * whether one ever started beyond the concurrency of the link it is read over
 * (`source.link`, once a reader is made for it).
 */
function remoteSource(bytes, { latencyMs = 20, policy = {} } = {}) {
  const base = bytesByteSource(bytes, { name: 'remote.zarr.zip', policy: { blockBytes: 64 * 1024, mergeGapBytes: 64 * 1024, maxRequestBytes: 8 * 1024 * 1024, concurrency: 6, cacheBytes: 64 * 1024 * 1024, ...policy } });
  let inFlight = 0;
  const source = {
    ...base,
    calls: [],
    maxInFlight: 0,
    link: null,
    beyondLink: 0,
    async read(offset, length, options) {
      source.calls.push([offset, offset + length]);
      inFlight++;
      source.maxInFlight = Math.max(source.maxInFlight, inFlight);
      if (source.link !== null && inFlight > source.link.concurrency) source.beyondLink++;
      await new Promise(resolve => setTimeout(resolve, latencyMs));
      inFlight--;
      return base.read(offset, length, options);
    },
  };
  return source;
}

/**
 * A 2-D int32 array of 100 x 50 chunks (5000 chunks of 20 x 20), zlib
 * compressed, in a stored ZIP, chunks in row-major key order.
 */
function bigStore() {
  const rows = 2000;
  const cols = 1000;
  const chunk = 20;
  const entries = [
    ['.zgroup', json({ zarr_format: 2 })],
    ['m/.zarray', json({ zarr_format: 2, shape: [rows, cols], chunks: [chunk, chunk], dtype: '<i4', compressor: { id: 'zlib', level: 1 }, fill_value: 0, filters: null, order: 'C' })],
  ];
  for (let i = 0; i < rows / chunk; i++) {
    for (let j = 0; j < cols / chunk; j++) {
      const values = new Int32Array(chunk * chunk);
      for (let r = 0; r < chunk; r++) for (let c = 0; c < chunk; c++) values[r * chunk + c] = (i * chunk + r) * cols + j * chunk + c;
      entries.push([`m/${i}.${j}`, new Uint8Array(deflateSync(new Uint8Array(values.buffer)))]);
    }
  }
  return { ...storedZip(entries), rows, cols, chunk };
}

const BIG = bigStore();

async function openRemote(options = {}) {
  const source = remoteSource(BIG.bytes, options);
  const reader = createByteReader(source);
  source.link = reader.link;
  const archive = await openZipArchive(reader);
  const root = await openZarr(zipStore(archive));
  return { source, root };
}

test('a 5000-chunk remote array opens in a few requests', async () => {
  const { source, root } = await openRemote();
  // The tail (footer + central directory) and the two metadata files.
  assert.ok(source.calls.length <= 4, `${source.calls.length} requests to open`);
  assert.deepEqual(root.get('m').shape, [BIG.rows, BIG.cols]);
});

test('a range read touches only its chunks, in merged parallel requests', async () => {
  const { source, root } = await openRemote({ policy: { mergeGapBytes: 0 } });
  source.calls.length = 0;
  source.maxInFlight = 0;
  const started = performance.now();
  // Rows 100..160, columns 300..400: chunk rows 5..7, chunk columns 15..19 (15 chunks).
  const box = await root.get('m').read([[100, 160], [300, 400]]);
  const elapsed = performance.now() - started;
  assert.equal(box.length, 60 * 100);
  assert.equal(box[0], 100 * BIG.cols + 300);
  assert.equal(box[box.length - 1], 159 * BIG.cols + 399);
  const needed = [];
  for (let i = 5; i <= 7; i++) for (let j = 15; j <= 19; j++) needed.push(BIG.spans.get(`m/${i}.${j}`));
  // Every byte fetched lies between the first and the last needed chunk entry.
  const first = Math.min(...needed.map(([a]) => a));
  const last = Math.max(...needed.map(([, b]) => b));
  for (const [start, end] of source.calls) {
    assert.ok(start >= first && end <= last, `request [${start}, ${end}) is within the needed chunks`);
  }
  // Chunks 15..19 of one chunk row are neighbours in the archive: at most one
  // request per chunk row; on this link (round trips, no bandwidth cost) the
  // rows' gaps are worth fetching too, so they may be one request.
  assert.ok(source.calls.length <= 3, `${source.calls.length} requests`);
  assert.ok(elapsed < 20 * 3, `took ${elapsed.toFixed(0)} ms: not three round trips in a row`);
});

test('a column read of a 5000-chunk array goes out at once and decodes only its 100 chunks', async () => {
  const { source, root } = await openRemote({ policy: { mergeGapBytes: 0 } });
  source.calls.length = 0;
  source.maxInFlight = 0;
  const started = performance.now();
  const column = await root.get('m').read([[0, BIG.rows], [777, 778]]);
  const elapsed = performance.now() - started;
  assert.equal(column.length, BIG.rows);
  assert.equal(column[1999], 1999 * BIG.cols + 777);
  assert.equal(root.stats().chunksDecoded, 100);
  // At most a request per chunk; on this link (round trips, little bandwidth
  // cost) neighbouring chunks' gaps are fetched with them, so far fewer
  // requests go out. Whether the gaps pay depends on the bandwidth measured
  // while the archive opened: when they do not, the hundred requests go out
  // together. None starts beyond the link's concurrency, which begins at the
  // policy's six and, on a source that answers many at once, doubles while
  // that pays (`link.js`).
  assert.ok(source.calls.length <= 100, `${source.calls.length} requests`);
  assert.equal(source.beyondLink, 0, 'never more requests in flight than the link allows');
  // Not 100 round trips in a row, nor 17 waves of six.
  assert.ok(elapsed < 100 * 20 / 2, `took ${elapsed.toFixed(0)} ms`);
});

test('reading a dense matrix column by column decodes each chunk once (decoded-chunk cache)', async () => {
  const { root } = await openRemote({ latencyMs: 0 });
  const matrix = root.get('m');
  for (let column = 0; column < 20; column++) {
    const values = await matrix.read([[0, BIG.rows], [column, column + 1]]);
    assert.equal(values[5], 5 * BIG.cols + column);
  }
  const stats = root.stats();
  assert.equal(stats.chunksDecoded, 100, 'twenty columns of one chunk column decode its 100 chunks once');
  assert.equal(stats.cacheHits, 19 * 100);
});

test('a zero cache budget keeps nothing between reads', async () => {
  const source = remoteSource(BIG.bytes, { latencyMs: 0 });
  const root = await openZarr(zipStore(await openZipArchive(createByteReader(source))), { decodedChunkCacheBytes: 0 });
  await root.get('m').read([[0, 40], [0, 1]]);
  await root.get('m').read([[0, 40], [1, 2]]);
  assert.equal(root.stats().chunksDecoded, 4);
  assert.equal(root.stats().cachedChunkBytes, 0);
});

test('500 concurrent disjoint reads fetch and decode each shared chunk once', async () => {
  const { source, root } = await openRemote({ latencyMs: 5 });
  source.calls.length = 0;
  const matrix = root.get('m');
  // 500 one-row ranges inside the first 25 chunk rows of chunk column 3:
  // every read needs part of one chunk, 20 reads share each chunk.
  const reads = Array.from({ length: 500 }, (_, k) => matrix.read([[k, k + 1], [60, 70]]));
  const results = await Promise.all(reads);
  results.forEach((values, k) => assert.equal(values[0], k * BIG.cols + 60));
  const stats = root.stats();
  assert.equal(stats.chunksDecoded, 25, 'each of the 25 chunks decoded once');
  assert.equal(stats.chunksDecoded + stats.sharedChunks + stats.cacheHits, 500);
  const fetched = new Set(source.calls.map(([start]) => start));
  assert.ok(source.calls.length <= 25, `${source.calls.length} requests for 25 chunks`);
  assert.equal(fetched.size, source.calls.length, 'no range fetched twice');
});

test('concurrent reads of a sharded array on a web host share shard indexes and merge inner chunks', async () => {
  const entries = await corpusEntries('v3/cases.zarr');
  const log = [];
  const fetch = async (url, init = {}) => {
    const relative = decodeURIComponent(new URL(url).pathname.replace(/^\/host\//, ''));
    log.push({ key: relative, range: init.headers?.Range ?? null });
    const bytes = entries.get(relative);
    if (bytes === undefined) return new Response(null, { status: 404 });
    const range = init.headers?.Range;
    if (!range) return new Response(bytes, { status: 200 });
    const [, a, b] = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = a === '' ? bytes.length - Number(b) : Number(a);
    const end = a === '' ? bytes.length : Number(b) + 1;
    return new Response(bytes.subarray(start, end), { status: 206 });
  };
  const root = await openZarr(httpStore('https://example.test/host/', { fetch }));
  log.length = 0;
  const array = root.get('sharding/end_index');
  // Shard (0, 0) holds rows 0..8, columns 0..10 as 2 x 2 inner chunks.
  const [left, right, whole] = await Promise.all([
    array.read([[0, 8], [0, 5]]),
    array.read([[0, 8], [5, 10]]),
    array.read([[0, 8], [0, 10]]),
  ]);
  assert.equal(left[0], 0);
  assert.equal(right[0], 5);
  assert.equal(whole[79], 7 * 20 + 9);
  const shardRequests = log.filter(entry => entry.key === 'sharding/end_index/c/0/0');
  assert.equal(shardRequests.filter(entry => entry.range?.startsWith('bytes=-')).length, 1, 'the index is read once');
  assert.equal(shardRequests.length, 2, 'one index read and one merged read of the four inner chunks');
  // A later read reuses the cached index.
  log.length = 0;
  await array.read([[4, 8], [5, 10]]);
  assert.ok(log.every(entry => !entry.range?.startsWith('bytes=-')));
});

test('a host that refuses suffix ranges is read with HEAD, once it has refused', async () => {
  const entries = await corpusEntries('v3/cases.zarr');
  const log = [];
  const fetch = async (url, init = {}) => {
    const relative = decodeURIComponent(new URL(url).pathname.replace(/^\/host\//, ''));
    const range = init.headers?.Range ?? null;
    log.push({ key: relative, range, method: init.method ?? 'GET' });
    if (range?.startsWith('bytes=-')) throw new TypeError('Failed to fetch (CORS preflight refused)');
    const bytes = entries.get(relative);
    if (bytes === undefined) return new Response(null, { status: 404 });
    if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'Content-Length': String(bytes.length) } });
    if (!range) return new Response(bytes, { status: 200 });
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range);
    return new Response(bytes.subarray(Number(a), Number(b) + 1), { status: 206 });
  };
  const root = await openZarr(httpStore('https://example.test/host/', { fetch }));
  const array = root.get('sharding/end_index');
  const values = await array.read();
  assert.equal(values[24 * 20 - 1], 24 * 20 - 1);
  const suffixes = log.filter(entry => entry.range?.startsWith('bytes=-'));
  assert.equal(suffixes.length >= 1 && suffixes.length <= 6, true, 'suffix ranges stop after the first refusals');
  assert.ok(log.some(entry => entry.method === 'HEAD'));
});

test('a web host store never has more requests in flight than its concurrency', async () => {
  const meta = { zarr_format: 2, shape: [400], chunks: [4], dtype: '<u1', compressor: null, fill_value: 0, filters: null, order: 'C' };
  const files = new Map([['.zgroup', json({ zarr_format: 2 })], ['a/.zarray', json(meta)]]);
  for (let i = 0; i < 100; i++) files.set(`a/${i}`, Uint8Array.of(i, i, i, i));
  files.set('.zmetadata', json({ zarr_consolidated_format: 1, metadata: { '.zgroup': { zarr_format: 2 }, 'a/.zarray': meta } }));
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = async url => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 2));
    inFlight--;
    const key = new URL(url).pathname.slice('/s/'.length);
    const bytes = files.get(key);
    return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes, { status: 200 });
  };
  const root = await openZarr(httpStore('https://example.test/s/', { fetch, concurrency: 8 }));
  const values = await root.get('a').read();
  assert.equal(values[399], 99);
  assert.equal(maxInFlight, 8);
});

test('the memory store and small reads stay exact', async () => {
  const meta = { zarr_format: 2, shape: [6], chunks: [3], dtype: '<i2', compressor: null, fill_value: 0, filters: null, order: 'C' };
  const root = await openZarr(memoryStore({ '.zgroup': json({ zarr_format: 2 }), 'a/.zarray': json(meta), 'a/0': new Uint8Array(Int16Array.of(1, 2, 3).buffer) }));
  assert.deepEqual(await root.get('a').read(), Int16Array.of(1, 2, 3, 0, 0, 0));
  assert.equal(await root.get('a').storedBytes(), 6);
});

/** A one-chunk array `a` of four bytes, whose chunk fetch waits for `gate` and fails `failures` times. */
function gatedStore({ failures = 0 } = {}) {
  const base = memoryStore({
    '.zgroup': json({ zarr_format: 2 }),
    'a/.zarray': json({ zarr_format: 2, shape: [4], chunks: [4], dtype: '<u1', compressor: null, fill_value: 0, filters: null, order: 'C' }),
    'a/0': Uint8Array.of(1, 2, 3, 4),
  });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let fetches = 0;
  let remaining = failures;
  const store = {
    ...base,
    async get(key, options) {
      if (key === 'a/0') {
        fetches++;
        await gate;
        if (remaining > 0) {
          remaining--;
          throw new Error('chunk fetch failed');
        }
      }
      return base.get(key, options);
    },
    getMany(keys, options) {
      return Promise.all(keys.map(key => store.get(key, options)));
    },
  };
  return { store, release, fetches: () => fetches };
}

test('a failed chunk read reaches every read waiting on it, is not kept, and the next read reads afresh', async () => {
  const { store, release, fetches } = gatedStore({ failures: 1 });
  const root = await openZarr(store);
  const reads = [root.get('a').read([[0, 2]]), root.get('a').read([[2, 4]])];
  release();
  for (const read of reads) await assert.rejects(read, /chunk fetch failed/);
  assert.equal(fetches(), 1, 'the waiting reads shared one fetch');
  assert.equal(root.stats().cachedChunkBytes, 0, 'a failure is never kept');
  assert.deepEqual(await root.get('a').read([[1, 3]]), Uint8Array.of(2, 3));
  assert.equal(fetches(), 2, 'the next read fetched again');
  assert.deepEqual(await root.get('a').read([[0, 1]]), Uint8Array.of(1));
  assert.equal(fetches(), 2, 'its success is kept');
});

test('a chunk still being read when its store closes is not kept', async () => {
  const { store, release } = gatedStore();
  const root = await openZarr(store);
  const pending = root.get('a').read([[0, 2]]).then(values => values, error => error);
  root.close();
  release();
  await pending;
  assert.equal(root.stats().cachedChunkBytes, 0);
});

test('the decoded-chunk cache keeps to its budget, least recently used first, and never keeps an entry larger than it', async () => {
  const { ByteLru } = await import('../assets/js/formats/zarr/cache.js');
  assert.throws(() => new ByteLru(-1), TypeError);
  const cache = new ByteLru(64);
  cache.set('a', 'A', 16);
  cache.set('b', 'B', 16);
  cache.set('c', 'C', 16);
  assert.equal(cache.get('a'), 'A');
  cache.set('d', 'D', 32);
  assert.deepEqual([...cache.entries.keys()], ['c', 'a', 'd']);
  assert.equal(cache.bytes, 64);
  cache.set('e', 'E', 65);
  assert.equal(cache.get('e'), undefined);
  assert.equal(cache.bytes, 64);
  cache.clear();
  assert.equal(cache.bytes, 0);
  assert.equal(cache.get('c'), undefined);
});

test('a web host store serves a view\'s reads ahead of queued background work, which never takes the last slot', async () => {
  const started = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetch = async url => {
    started.push(new URL(url).pathname);
    await gate;
    return new Response(Uint8Array.of(1, 2, 3), { status: 200 });
  };
  const store = httpStore('https://example.test/s/', { fetch, concurrency: 3 });
  const index = { background: true, fetched() {} };
  const background = [0, 1, 2, 3, 4].map(i => store.get(`b/${i}`, { activity: index }));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(started.length, 2, 'background work leaves one slot free');
  const view = store.get('view', { activity: { background: false, fetched() {} } });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(started.at(-1), '/s/view', 'the view read starts at once, ahead of queued background reads');
  release();
  await Promise.all([...background, view]);
  assert.equal(started.length, 6);
});

test('a web host store counts a range request as planned before its bytes arrive, and as fetched when they do', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetch = async (url, init) => {
    await gate;
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range).map(Number);
    return new Response(new Uint8Array(end - start + 1), { status: 206 });
  };
  const store = httpStore('https://example.test/s/', { fetch });
  const tally = { planned: 0, fetched: 0, background: false };
  const activity = {
    get background() { return tally.background; },
    planned(bytes) { tally.planned += bytes; },
    fetched(bytes) { tally.fetched += bytes; },
  };
  const read = store.getRanges('shard', [{ offset: 0, length: 100 }, { offset: 1_000_000, length: 50 }], { activity });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(tally.planned, 150, 'both ranges are planned before any byte arrives');
  assert.equal(tally.fetched, 0);
  release();
  await read;
  assert.equal(tally.fetched, 150);
});
