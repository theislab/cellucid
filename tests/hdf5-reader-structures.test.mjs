/**
 * The HDF5 reader's tricky structures and its efficiency contract.
 *
 * - Structures: lookup3 and Fletcher-32 checksums (and corruption caught),
 *   shuffle, LZF, DEFLATE bounded by the chunk size (a decompression bomb
 *   refused), fractal heap tiny IDs, paged extensible arrays with
 *   unwritten pages, huge dense attributes.
 * - Round trips: opening a file costs a number of sequential request rounds
 *   bounded by the depth of its tree, not its number of objects (measured
 *   with a byte source that answers after a delay and records, for each
 *   request, how many rounds of requests had to finish before it was made).
 * - Bytes: a chunk-aligned range of a 5000-chunk dataset fetches only its
 *   chunks; concurrent reads share fetches and decodes; sequential column
 *   reads reuse decoded chunks.
 * - Ownership: a result is the caller's own (transferable) buffer.
 * - Cancellation, closing, activity accounting.
 *
 * The values themselves are checked against the HDF5 library in
 * hdf5-reader-conformance.test.mjs.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { ReadActivity } from '../assets/js/formats/io/activity.js';
import { openHdf5, Hdf5FormatError } from '../assets/js/formats/hdf5/index.js';
import { lookup3, fletcher32 } from '../assets/js/formats/hdf5/checksum.js';
import { FILTER, unfilter } from '../assets/js/formats/hdf5/filters.js';
import { byteUnshuffle } from '../assets/js/formats/io/shuffle.js';
import { lzfDecompress } from '../assets/js/formats/hdf5/lzf.js';
import { readHeapObjects } from '../assets/js/formats/hdf5/fractal-heap.js';
import { swapBytes } from '../assets/js/formats/hdf5/decode.js';

import { virtualTime } from './helpers/virtual-time.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(here, 'fixtures', 'hdf5');
const fixture = name => new Uint8Array(readFileSync(path.join(CORPUS, name)));

function open(bytes, options = {}) {
  return openHdf5(createByteReader(bytesByteSource(bytes, { name: 'test.h5' })), options);
}

/**
 * A byte source that answers after `latencyMs` and records the requests. A
 * request's round is one more than the highest round finished before it was
 * made: the length of the chain of round trips it waited for. The latency is
 * on a virtual clock (`time`, `helpers/virtual-time.mjs`), which moves only
 * once every request the reader would make at this instant has been made: the
 * rounds count dependent waves exactly, however long the machine takes
 * between two sibling requests. `onRead` hears each request as it is made.
 */
function recordingSource(bytes, { latencyMs = 2, policy = {} } = {}) {
  const base = bytesByteSource(bytes, { name: 'recorded.h5', policy: { concurrency: 10_000, ...policy } });
  const log = [];
  const time = virtualTime();
  let finishedRound = 0;
  const recorder = {
    log,
    time,
    onRead: null,
  };
  const source = {
    size: base.size,
    name: base.name,
    identity: base.identity,
    policy: base.policy,
    async read(offset, length, options) {
      const round = finishedRound + 1;
      log.push({ offset, length, round });
      recorder.onRead?.();
      await time.sleep(latencyMs);
      finishedRound = Math.max(finishedRound, round);
      return base.read(offset, length, options);
    },
  };
  return Object.assign(recorder, {
    source: Object.freeze(source),
    /** A byte reader of the source, measuring its link on the source's clock. */
    reader: () => createByteReader(recorder.source, { clock: time.now }),
    rounds: () => log.reduce((max, entry) => Math.max(max, entry.round), 0),
    reset() {
      log.length = 0;
    },
  });
}

/* ---------- structures ---------- */

test('lookup3 and Fletcher-32 give the reference values', () => {
  const text = new TextEncoder().encode('Four score and seven years ago');
  assert.equal(lookup3(new Uint8Array(0)), 0xdeadbeef);
  assert.equal(lookup3(text), 0x17770551);
  assert.equal(lookup3(text, 1), 0xcd628161);
  // Fletcher-32 over 16-bit big-endian words: "abcde" -> sums 0x6162 + 0x6364 + 0x6500.
  const sum1 = (0x6162 + 0x6364 + 0x6500) % 0xffff;
  const sum2 = (0x6162 + (0x6162 + 0x6364) + (0x6162 + 0x6364 + 0x6500)) % 0xffff;
  assert.equal(fletcher32(new TextEncoder().encode('abcde')), ((sum2 << 16) | sum1) >>> 0);
});

test('shuffle is undone byte plane by byte plane, trailing bytes kept', () => {
  const elements = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]); // three 4-byte elements
  const shuffled = new Uint8Array(14);
  for (let b = 0; b < 4; b++) for (let i = 0; i < 3; i++) shuffled[b * 3 + i] = elements[i * 4 + b];
  shuffled[12] = 99;
  shuffled[13] = 98;
  assert.deepEqual(Array.from(byteUnshuffle(shuffled, 4)), [...elements, 99, 98]);
  const words = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  swapBytes(words, 4);
  assert.deepEqual(Array.from(words), [4, 3, 2, 1, 8, 7, 6, 5]);
  swapBytes(words, 8);
  assert.deepEqual(Array.from(words), [5, 6, 7, 8, 1, 2, 3, 4]);
});

test('LZF: literals and overlapping back references; corrupt streams refused', () => {
  // "abc" as a literal run, then 6 bytes copied from 3 back (overlapping).
  const stream = new Uint8Array([2, 0x61, 0x62, 0x63, (4 << 5) | 0, 2]);
  assert.equal(new TextDecoder().decode(lzfDecompress(stream, 9)), 'abcabcabc');
  assert.equal(lzfDecompress(stream, 10), null, 'short output');
  assert.equal(lzfDecompress(new Uint8Array([(1 << 5) | 0, 9]), 3), null, 'reference before the start');
});

test('a DEFLATE chunk that inflates past its chunk size is refused without inflating it in full', async t => {
  // Count every byte the decompressor hands out.
  const Native = globalThis.DecompressionStream;
  let produced = 0;
  globalThis.DecompressionStream = class CountingDecompressionStream {
    constructor(format) {
      const inner = new Native(format);
      this.writable = inner.writable;
      this.readable = inner.readable.pipeThrough(new TransformStream({
        transform(piece, controller) {
          produced += piece.length;
          controller.enqueue(piece);
        },
      }));
    }
  };
  t.after(() => {
    globalThis.DecompressionStream = Native;
  });

  const chunkBytes = 4096;
  const bombSize = 256 * 1024 * 1024;
  // 256 MiB of zeros: about 256 KiB once deflated.
  const bomb = new Uint8Array(deflateSync(Buffer.alloc(bombSize), { level: 9 }));
  const deflate = { id: FILTER.DEFLATE, clientData: [6] };

  // Deflate alone: the stream must restore exactly the chunk's bytes.
  await assert.rejects(
    unfilter(bomb, [deflate], 0, chunkBytes, 'Chunk [0] of /bomb'),
    error => error instanceof Hdf5FormatError && /Chunk \[0\] of \/bomb/.test(error.message) && /more than the 4096 bytes/.test(error.message)
  );
  assert.ok(produced < 1024 * 1024, `inflated ${produced} bytes of a ${bombSize}-byte bomb`);

  // Deflate twice: the outer stream may restore at most what DEFLATE can
  // make of the chunk (zlib's compressBound), and the bomb is larger.
  produced = 0;
  await assert.rejects(
    unfilter(new Uint8Array(deflateSync(bomb)), [deflate, deflate], 0, chunkBytes, 'Chunk [0] of /bomb'),
    error => error instanceof Hdf5FormatError && /more than the 4110 bytes/.test(error.message)
  );
  assert.ok(produced < 1024 * 1024, `inflated ${produced} bytes of a ${bomb.length}-byte inner stream`);

  // The same filters on honest data still decode.
  const values = Uint8Array.from({ length: chunkBytes }, (_, i) => i % 251);
  assert.deepEqual(await unfilter(new Uint8Array(deflateSync(values)), [deflate], 0, chunkBytes, 'chunk'), values);
  assert.deepEqual(await unfilter(new Uint8Array(deflateSync(deflateSync(values))), [deflate, deflate], 0, chunkBytes, 'chunk'), values);
});

test('fractal heap tiny IDs carry their object inside', async () => {
  const normal = new Uint8Array([0x20 | 2, 7, 8, 9, 0, 0, 0, 0]);
  const [tiny] = await readHeapObjects({ name: 'x' }, { idLength: 8, hugeDirect: true, address: 0 }, [normal]);
  assert.deepEqual(Array.from(tiny), [7, 8, 9]);
  const extended = new Uint8Array(24);
  extended[0] = 0x20;
  extended[1] = 19; // 20 bytes
  for (let i = 0; i < 20; i++) extended[2 + i] = i;
  const [long] = await readHeapObjects({ name: 'x' }, { idLength: 24, hugeDirect: true, address: 0 }, [extended]);
  assert.deepEqual(Array.from(long), Array.from({ length: 20 }, (_, i) => i));
});

test('huge attributes (huge fractal heap objects) and dense links load', async () => {
  const root = await open(fixture('latest-format.h5'));
  assert.equal(root.attrs['column-order'].length, 9000);
  assert.equal(root.attrs['column-order'][8999], 'column_08999');
  assert.equal(root.attrs.huge_numeric.length, 40000);
  assert.equal(root.attrs.huge_numeric[39999], 39999);
  assert.equal(root.get('dense_links').keys().length, 2500);
  assert.deepEqual(root.get('tracked_order').keys(), ['alpha', 'beta', 'mid', 'zeta']);
  root.close();
});

test('a paged extensible array reads unwritten pages as the fill value', async () => {
  const root = await open(fixture('latest-format.h5'));
  const node = root.get('chunk_index/extensible_array_paged');
  assert.equal(node.hdf5.chunkIndex, 'extensible-array');
  const values = await node.read();
  for (let i = 0; i < values.length; i++) {
    const written = i < 132_000 || (i >= 135_000 && i < 136_000);
    if (values[i] !== (written ? i % 251 : 7)) assert.fail(`element ${i} is ${values[i]}`);
  }
  assert.deepEqual(Array.from(await node.read([[131_990, 132_010]])), [
    ...Array.from({ length: 10 }, (_, k) => (131_990 + k) % 251), ...new Array(10).fill(7),
  ]);
  root.close();
});

test('corruption is caught: a chunk failing Fletcher-32, a metadata checksum', async () => {
  const bytes = fixture('default-format.h5');
  const root = await open(bytes);
  const node = root.get('fletcher32/le_i4');
  const table = await node.reader.chunkTable(null);
  const chunkAddress = table.address[table.find(0)];
  root.close();
  const corrupt = bytes.slice();
  corrupt[chunkAddress + 5] ^= 0xff;
  const damaged = await open(corrupt);
  await assert.rejects(damaged.get('fletcher32/le_i4').read([[0, 10]]), error => error instanceof Hdf5FormatError && /Fletcher-32|corrupt/.test(error.message));
  // The other chunks still read.
  assert.equal((await damaged.get('fletcher32/le_i4').read([[300, 310]])).length, 10);

  const latest = fixture('latest-format.h5');
  const header = Buffer.from(latest).indexOf('OHDR', 1000);
  latest[header + 12] ^= 0x01;
  await assert.rejects(open(latest), error => error instanceof Hdf5FormatError && /checksum/.test(error.message));
});

/* ---------- round trips ---------- */

/** Depth of the group tree (root = 1), following each hard link once. */
function treeDepth(group, seen = new Set()) {
  let deepest = 0;
  for (const key of group.keys()) {
    let child;
    try {
      child = group.get(key);
    } catch {
      continue;
    }
    if (child === null) continue;
    const id = child.hdf5?.address ?? child.info.address;
    if (seen.has(id)) continue;
    seen.add(id);
    deepest = Math.max(deepest, child.kind === 'group' ? treeDepth(child, seen) : 0);
  }
  return 1 + deepest;
}

for (const name of ['default-format.h5', 'latest-format.h5', 'v18-format.h5', 'shared-messages.h5', 'btree-k.h5']) {
  test(`opening ${name} takes round trips bounded by tree depth, not object count`, async () => {
    // Small metadata blocks, nothing merged: every structure costs its own
    // request, as metadata scattered through a large remote file would.
    const recorder = recordingSource(fixture(name), { policy: { blockBytes: 512, mergeGapBytes: 0 } });
    const root = await openHdf5(recorder.reader());
    const depth = treeDepth(root);
    const objects = root.stats().open.objects;
    const rounds = recorder.rounds();
    // Per level: the object header, its continuation, the group's index (B-tree
    // levels or heap + name index), attributes' heaps; plus the superblock.
    assert.ok(rounds <= 2 + 6 * depth, `${rounds} rounds for depth ${depth}`);
    if (objects > 200) assert.ok(rounds < objects / 10, `${rounds} rounds for ${objects} objects`);
    root.close();
  });
}

/* ---------- bytes fetched ---------- */

test('a chunk-aligned range of a 5000-chunk dataset fetches only its chunks', async () => {
  const recorder = recordingSource(fixture('default-format.h5'), { latencyMs: 0 });
  const root = await openHdf5(recorder.reader());
  const node = root.get('many_chunks/btree_levels');
  // Reading a range first reads the chunk index's leaves holding its chunks.
  await node.read([[400, 440]]);
  const table = await node.reader.chunkTable(null);
  assert.ok(table.count > 0 && table.count < 5000, `the chunk B-tree's leaves are read as needed (${table.count} of 5000 entries)`);
  recorder.reset();
  const values = await node.read([[400, 440]]);
  assert.deepEqual(Array.from(values), Array.from({ length: 40 }, (_, i) => 400 + i));
  const fetched = recorder.log.reduce((sum, entry) => sum + entry.length, 0);
  const expected = Array.from({ length: 10 }, (_, k) => table.size[table.find(100 + k)]).reduce((a, b) => a + b, 0);
  assert.equal(await node.storedBytes([[400, 440]]), expected);
  assert.ok(fetched <= expected + 9 * 64, `fetched ${fetched} bytes for ${expected} bytes of chunks`);
  assert.ok(recorder.log.length <= 2, `${recorder.log.length} requests`);
  const all = await node.read();
  assert.deepEqual(Array.from(all.subarray(0, 5)), [0, 1, 2, 3, 4]);
  assert.equal(table.count, 5000, 'a whole read has read every leaf');
  root.close();
});

test('the first rows of a many-leaf chunked dataset wait for one leaf of its chunk index, not all of them', async () => {
  const recorder = recordingSource(fixture('default-format.h5'), { latencyMs: 1 });
  const root = await openHdf5(recorder.reader());
  const node = root.get('many_chunks/btree_levels');
  recorder.reset();
  const values = await node.read([[0, 40]]);
  assert.deepEqual(Array.from(values), Array.from({ length: 40 }, (_, i) => i));
  const leafReads = recorder.log.filter(entry => entry.length < 4096).length;
  const table = await node.reader.chunkTable(null);
  assert.ok(table.count <= 2 * 64, `${table.count} chunk entries read for the first 10 chunks`);
  assert.ok(leafReads <= 3, `${leafReads} index node reads (root, the leaf)`);
  root.close();
});

test('a column of variable-length strings fetches each byte once', async () => {
  const noOverlap = (log, what) => {
    const ranges = log.map(entry => [entry.offset, entry.offset + entry.length]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) {
      assert.ok(ranges[i][0] >= ranges[i - 1][1], `${what}: requests ${ranges[i - 1]} and ${ranges[i]} overlap`);
    }
  };
  for (const name of ['text/vlen_utf8', 'text/vlen_utf8_chunked_gzip']) {
    const recorder = recordingSource(fixture('default-format.h5'), { latencyMs: 0 });
    const root = await openHdf5(recorder.reader());
    const node = root.get(name);
    await node.storedBytes();
    // Part of a column first: its heap collection is read in part ...
    recorder.reset();
    assert.deepEqual(await node.read([[136, 140]]), ['naïve T', '日本語', 'x'.repeat(300), 'end']);
    noOverlap(recorder.log, `${name} rows 136-140`);
    const partBytes = recorder.log.filter(entry => entry.length > 64).map(entry => [entry.offset, entry.offset + entry.length]);
    // ... and the whole column then fetches only the rest of it.
    recorder.reset();
    const values = await node.read();
    assert.equal(values[4], '日本語');
    assert.equal(values[139], 'end');
    noOverlap(recorder.log, name);
    for (const entry of recorder.log) {
      for (const [start, end] of partBytes) {
        assert.ok(entry.offset >= end || entry.offset + entry.length <= start || entry.length <= 2240,
          `${name}: heap bytes ${start}-${end} fetched again`);
      }
    }
    root.close();
  }
});

test('concurrent reads share each chunk: fetched and decoded once', async () => {
  const recorder = recordingSource(fixture('default-format.h5'), { latencyMs: 1 });
  const root = await openHdf5(recorder.reader());
  const node = root.get('shapes/dense_2d_chunked_edges'); // 101 x 23, chunks 10 x 4, gzip
  await node.reader.chunkTable(null);
  const full = await node.storedBytes();
  const reference = await node.read();
  root.get('shapes/dense_2d_chunked_edges').reader.file.cache.clear();
  recorder.reset();
  const activity = new ReadActivity({ label: 'columns', kind: 'genes' });
  const columns = await Promise.all(Array.from({ length: 23 }, (_, j) => node.read([[0, 101], [j, j + 1]], { activity })));
  columns.forEach((column, j) => {
    assert.deepEqual(Array.from(column), Array.from({ length: 101 }, (_, i) => reference[i * 23 + j]));
  });
  assert.equal(activity.chunks, 66, 'each of the 11 x 6 chunks decoded once');
  const fetched = recorder.log.reduce((sum, entry) => sum + entry.length, 0);
  assert.ok(fetched <= full, `fetched ${fetched} bytes; the chunks hold ${full}`);

  // 500 disjoint ranges of a 5000-chunk gzip dataset, all at once.
  const many = root.get('many_chunks/btree_levels_gzip');
  const ranges = Array.from({ length: 500 }, (_, k) => [[k * 40, k * 40 + 40]]);
  const manyActivity = new ReadActivity({ label: 'ranges', kind: 'genes' });
  const results = await Promise.all(ranges.map(selection => many.read(selection, { activity: manyActivity })));
  results.forEach((values, k) => assert.equal(values[39], (k * 40 + 39) * 3));
  assert.equal(manyActivity.chunks, 5000);
  root.close();
});

test('sequential column reads reuse decoded chunks', async () => {
  const recorder = recordingSource(fixture('default-format.h5'), { latencyMs: 0 });
  const root = await openHdf5(recorder.reader());
  const node = root.get('shapes/dense_2d_row_chunks'); // 64 x 9, chunks 16 x 9
  await node.read([[0, 64], [0, 1]]);
  recorder.reset();
  for (let j = 1; j < 9; j++) await node.read([[0, 64], [j, j + 1]]);
  assert.equal(recorder.log.length, 0, 'no request after the first column');
  assert.ok(root.stats().decodedCache.hits >= 8 * 4);
  root.close();
});

/* ---------- ownership, cancellation, closing, accounting ---------- */

test('results are the caller\'s own: transferring one leaves the next read and the cache intact', async () => {
  const root = await open(fixture('default-format.h5'));
  const chunked = root.get('chunked/le_f4'); // chunks of 64
  const first = await chunked.read([[0, 64]]);
  const copy = Array.from(first);
  assert.equal(first.byteOffset, 0);
  assert.equal(first.byteLength, first.buffer.byteLength);
  structuredClone(first, { transfer: [first.buffer] });
  assert.equal(first.length, 0, 'the first result was transferred');
  const second = await chunked.read([[0, 64]]);
  assert.deepEqual(Array.from(second), copy);
  const third = await chunked.read([[0, 10]]);
  assert.deepEqual(Array.from(third), copy.slice(0, 10));
  const owned = [
    await root.get('enum/numpy_bool').read(),
    await root.get('enum/enum_u1').read(),
    await root.get('chunked/le_f2').read(),
    await root.get('gzip_shuffle/be_f8').read([[100, 200]]),
    await root.get('compound/compound_array_vlen').readField('embedding'),
    await root.get('compound/compound').readField('n', [[2, 5]]),
  ];
  for (const value of owned) {
    assert.equal(value.byteOffset, 0);
    assert.equal(value.byteLength, value.buffer.byteLength);
  }
  assert.equal(owned[4].length, 60, 'an array member reads row-major, 3 values per row');
  root.close();
});

test('reads can be aborted; other reads of the same chunks still complete', async () => {
  const recorder = recordingSource(fixture('latest-format.h5'), { latencyMs: 5 });
  const root = await openHdf5(recorder.reader());
  const node = root.get('chunk_index/extensible_array_gzip');
  const already = new AbortController();
  already.abort();
  await assert.rejects(node.read(undefined, { signal: already.signal }), { name: 'AbortError' });
  const controller = new AbortController();
  // Cancelled while its first request is in flight.
  recorder.onRead = () => {
    recorder.onRead = null;
    controller.abort();
  };
  const aborted = node.read([[0, 4000]], { signal: controller.signal });
  const kept = node.read([[0, 4000]]);
  await assert.rejects(aborted, { name: 'AbortError' });
  assert.equal((await kept).length, 4000);
  root.close();
  await assert.rejects(node.read([[0, 4]]), /closed/);
});

test('activities count what a read fetched and decoded', async () => {
  const reader = createByteReader(bytesByteSource(fixture('default-format.h5'), { name: 'default-format.h5' }));
  const root = await openHdf5(reader);
  // The data is read from the file, not from metadata blocks cached at open.
  reader.clear();
  const activity = new ReadActivity({ label: 'gzip column', kind: 'field' });
  await root.get('gzip/le_f8').read([[0, 1000]], { activity });
  assert.ok(activity.requests >= 1);
  assert.ok(activity.bytesFetched > 0);
  assert.equal(activity.chunks, 10);
  assert.equal(activity.decodedBytes, 10 * 100 * 8);
  const stats = root.stats();
  assert.ok(stats.open.objects > 400);
  assert.ok(stats.reader.requests >= 1);
  root.close();
});

test('a failed chunk read reaches every read waiting on it, is not kept, and the next read reads afresh', async () => {
  const base = bytesByteSource(fixture('default-format.h5'), { name: 'failing.h5' });
  let failNext = false;
  let release = () => {};
  let reached = () => {};
  const atFetch = new Promise(resolve => { reached = resolve; });
  const source = Object.freeze({
    size: base.size,
    name: base.name,
    identity: base.identity,
    policy: base.policy,
    async read(offset, length, options) {
      if (failNext) {
        failNext = false;
        const held = new Promise(resolve => { release = resolve; });
        reached();
        await held;
        throw new Error('chunk fetch failed');
      }
      return base.read(offset, length, options);
    },
  });
  const reader = createByteReader(source);
  const root = await openHdf5(reader);
  const chunked = root.get('chunked/le_f4'); // chunks of 64
  await chunked.reader.chunkTable(null);
  // The chunk is read from the file, not from metadata blocks cached at open.
  reader.clear();
  const reference = await open(fixture('default-format.h5')).then(async other => {
    const values = Array.from(await other.get('chunked/le_f4').read([[0, 64]]));
    other.close();
    return values;
  });
  const keptBefore = root.stats().decodedCache.bytes;
  failNext = true;
  const reads = [chunked.read([[0, 10]]), chunked.read([[10, 20]])];
  // Released once the fetch is under way, however long the read takes to get there.
  await atFetch;
  release();
  for (const read of reads) await assert.rejects(read, /chunk fetch failed/);
  assert.equal(root.stats().decodedCache.bytes, keptBefore, 'a failure is never kept');
  assert.deepEqual(Array.from(await chunked.read([[5, 15]])), reference.slice(5, 15));
  assert.ok(root.stats().decodedCache.bytes > keptBefore, 'the success is kept');
  root.close();
});

test('the decoded-chunk cache keeps owned copies, to its budget, least recently used first', async () => {
  const { ByteCache } = await import('../assets/js/formats/hdf5/lru.js');
  assert.throws(() => new ByteCache(-1), TypeError);
  const cache = new ByteCache(64);
  cache.set('a', 'A', 16);
  cache.set('b', 'B', 16);
  cache.set('c', 'C', 16);
  assert.equal(cache.get('a'), 'A');
  cache.set('d', 'D', 32);
  assert.deepEqual([...cache.entries.keys()], ['c', 'a', 'd']);
  assert.equal(cache.bytes, 64);
  assert.equal(cache.set('e', 'E', 65), false, 'an entry larger than the budget is not kept');
  assert.equal(cache.bytes, 64);

  // A chunk read as part of one larger request is kept as its own bytes, not
  // as a view holding the whole request buffer alive.
  const root = await open(fixture('default-format.h5'));
  const chunked = root.get('chunked/le_f4');
  await chunked.read([[0, 200]]);
  const { entries } = chunked.reader.file.cache;
  assert.ok(entries.size > 1);
  for (const { value, bytes } of entries.values()) {
    if (!ArrayBuffer.isView(value)) continue;
    assert.equal(value.byteOffset, 0);
    assert.equal(value.buffer.byteLength, bytes);
  }
  root.close();
});

test('the decode gates serve reads someone waits for before background work, which leaves its reserve free', async () => {
  const { ByteBudget } = await import('../assets/js/formats/hdf5/lru.js');
  const slots = new ByteBudget(4, { waves: false, reserve: 1 });
  const background = [];
  for (let i = 0; i < 6; i++) background.push(slots.acquire(1, true));
  await Promise.resolve();
  assert.equal(slots.held, 3, 'background work holds every slot but the reserve');
  // A read someone waits for starts at once, and goes ahead of queued background work.
  const release = await slots.acquire(1, false);
  assert.equal(slots.held, 4);
  let later = false;
  const queuedView = slots.acquire(1, false).then(give => { later = true; return give; });
  (await background[0])();
  await Promise.resolve();
  assert.equal(later, true, 'the freed slot went to the waiting view read');
  release();
  (await queuedView)();
  // Work that someone starts waiting for is served as theirs.
  let promoted = false;
  const flag = { background: true };
  const gated = new ByteBudget(1, { waves: false });
  const holder = await gated.acquire(1, false);
  const waiting = gated.acquire(1, () => flag.background).then(give => { promoted = true; return give; });
  const other = gated.acquire(1, false);
  flag.background = false;
  holder();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(promoted, false, 'first come, first served among reads someone waits for');
  (await other)();
  (await waiting)();
  assert.equal(promoted, true);
  for (const pending of background.slice(1)) (await pending)();
  assert.equal(slots.held, 0);
});
