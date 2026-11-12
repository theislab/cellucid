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
import { booleanAttribute, group, numericDataset, stringDataset, writeHdf5 } from '../assets/js/formats/hdf5/writer.js';
import { StoreNotLoadedError } from '../assets/js/formats/store.js';
import { ANNDATA_OPENING_PATHS } from '../assets/js/data/anndata/elements.js';
import { lookup3, fletcher32 } from '../assets/js/formats/hdf5/checksum.js';
import { FILTER, unfilter } from '../assets/js/formats/hdf5/filters.js';
import { byteUnshuffle } from '../assets/js/formats/io/shuffle.js';
import { lzfDecompress } from '../assets/js/formats/hdf5/lzf.js';
import { readHeapObjects } from '../assets/js/formats/hdf5/fractal-heap.js';
import { swapBytes } from '../assets/js/formats/io/byte-order.js';
import { gatheredArray, runsOfPositions } from '../assets/js/data/anndata/views/cell-subset.js';
import { DecodedChunks } from '../assets/js/data/anndata/decoded-chunks.js';
import { firstGeneReadCost, linkReadMs } from '../assets/js/data/anndata/subsample-plan.js';

import { virtualTime } from './helpers/virtual-time.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(here, 'fixtures', 'hdf5');
const fixture = name => new Uint8Array(readFileSync(path.join(CORPUS, name)));

/** Open a fixture with its whole tree loaded (`load`), as these tests navigate all of it. */
function open(bytes, options = {}) {
  return openHdf5(createByteReader(bytesByteSource(bytes, { name: 'test.h5' })), { load: [''], ...options });
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
    error => error instanceof Hdf5FormatError && /Chunk \[0\] of \/bomb/.test(error.message) && /more than the 4,096 bytes/.test(error.message)
  );
  assert.ok(produced < 1024 * 1024, `inflated ${produced} bytes of a ${bombSize}-byte bomb`);

  // Deflate twice: the outer stream may restore at most what DEFLATE can
  // make of the chunk (zlib's compressBound), and the bomb is larger.
  produced = 0;
  await assert.rejects(
    unfilter(new Uint8Array(deflateSync(bomb)), [deflate, deflate], 0, chunkBytes, 'Chunk [0] of /bomb'),
    error => error instanceof Hdf5FormatError && /more than the 4,110 bytes/.test(error.message)
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
    const root = await openHdf5(recorder.reader(), { load: [''] });
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

/* ---------- a lazy tree ---------- */

/**
 * An `.h5ad` of `cells` cells with `columns` categorical obs columns (each a
 * group of codes and categories). Its X is a MiB, so its metadata (written
 * after the data) lies past the head an opening reads first, as a large
 * file's does.
 */
async function annDataWithColumns(columns, cells = 64) {
  const encoding = (type, version) => ({ 'encoding-type': type, 'encoding-version': version });
  const obsColumns = Array.from({ length: columns }, (_, c) => [`c${c}`, group({ ...encoding('categorical', '0.2.0'), ordered: booleanAttribute(false) }, [
    ['categories', stringDataset(['a', 'b', 'c'], encoding('string-array', '0.2.0'))],
    ['codes', numericDataset('int8', [cells], Int8Array.from({ length: cells }, (_, i) => (i + c) % 3), encoding('array', '0.2.0'))],
  ])]);
  const names = Array.from({ length: cells }, (_, i) => `cell${i}`);
  const root = group(encoding('anndata', '0.1.0'), [
    ['obs', group({ ...encoding('dataframe', '0.2.0'), _index: '_index', 'column-order': obsColumns.map(([name]) => name) }, [
      ['_index', stringDataset(names, encoding('string-array', '0.2.0'))],
      ...obsColumns,
    ])],
    ['var', group({ ...encoding('dataframe', '0.2.0'), _index: '_index', 'column-order': [] }, [
      ['_index', stringDataset(['g0', 'g1'], encoding('string-array', '0.2.0'))],
    ])],
    ['X', numericDataset('float32', [cells, 4096], new Float32Array(cells * 4096), encoding('array', '0.2.0'))],
    ['obsm', group(encoding('dict', '0.1.0'), [
      ['X_umap', numericDataset('float32', [cells, 2], new Float32Array(cells * 2), encoding('array', '0.2.0'))],
    ])],
    ['uns', group(encoding('dict', '0.1.0'), [
      ['notes', group(encoding('dict', '0.1.0'), Array.from({ length: columns }, (_, c) => [`n${c}`, stringDataset([`note ${c}`], encoding('string-array', '0.2.0'))]))],
    ])],
  ]);
  return new Uint8Array(await writeHdf5(root).arrayBuffer());
}

test('opening an .h5ad reads its structure, never the parts of its columns: objects, requests and rounds do not grow with what waits', async () => {
  const opened = async columns => {
    // Nothing merged: objects in other blocks cost their own requests, as
    // objects scattered through a large remote file do. (A block holds the
    // largest header, a group of 65 links, so a header is one read.)
    const recorder = recordingSource(await annDataWithColumns(columns), { policy: { blockBytes: 4096, mergeGapBytes: 0 } });
    const root = await openHdf5(recorder.reader(), { load: ANNDATA_OPENING_PATHS });
    return { root, recorder, objects: root.stats().open.objects, requests: recorder.log.length, rounds: recorder.rounds() };
  };
  // Both wide enough that their headers span many blocks (a narrow file's
  // all arrive with the first ones read).
  const few = await opened(64);
  const many = await opened(256);
  // Each column more is one object at open (its group: name, kind,
  // encoding), never its codes and categories; uns's entries wait too.
  assert.equal(many.objects - few.objects, 192, `${few.objects} → ${many.objects} objects`);
  assert.ok(many.requests - few.requests <= 192, `${few.requests} → ${many.requests} requests`);
  // The rounds are the tree's depth: root, obs's links, its columns, their attributes' heap.
  assert.equal(many.rounds, few.rounds, `${few.rounds} → ${many.rounds} rounds`);
  const { root, recorder } = many;
  const obs = root.get('obs');
  assert.deepEqual(obs.keys().length, 257);
  const column = obs.get('c7');
  assert.equal(column.attrs['encoding-type'], 'categorical');
  assert.equal(column.loaded, false);
  assert.throws(() => column.keys(), StoreNotLoadedError);
  assert.throws(() => root.get('obs/c7/codes'), StoreNotLoadedError);
  assert.throws(() => root.get('uns/notes').has('n0'), StoreNotLoadedError);
  // A column loads when read: its group's links and its parts, in a few
  // dependent rounds, nothing else.
  recorder.reset();
  await root.load(['obs/c7']);
  assert.equal(column.loaded, true);
  assert.deepEqual(column.keys(), ['categories', 'codes']);
  assert.deepEqual(Array.from(await root.get('obs/c7/codes').read()).slice(0, 4), [1, 2, 0, 1]);
  assert.ok(root.stats().objects === many.objects + 2, `${root.stats().objects} objects after one column`);
  // Loading what is loaded reads nothing; the whole tree, the rest once.
  recorder.reset();
  await root.load(['obs/c7', { path: 'obs', depth: 1 }]);
  assert.equal(recorder.log.length, 0);
  await root.load();
  // The rest: every column's two parts and uns's 256 entries, each once.
  assert.equal(root.stats().objects, many.objects + 2 * 256 + 256);
  few.root.close();
  root.close();
});

test('loads asked for at once share their reads, stop only when every asker withdrew, and a cancelled one is read again', async () => {
  const recorder = recordingSource(await annDataWithColumns(8), { policy: { blockBytes: 512, mergeGapBytes: 0 } });
  const root = await openHdf5(recorder.reader());
  assert.deepEqual(root.keys(), ['X', 'obs', 'obsm', 'uns', 'var']);
  recorder.reset();
  const stop = new AbortController();
  const cancelled = root.load(['obs'], { signal: stop.signal });
  const kept = root.load(['obs/c1']);
  stop.abort();
  await assert.rejects(cancelled, error => error.name === 'AbortError');
  await kept;
  const shared = recorder.log.length;
  assert.equal(root.get('obs/c1/codes').shape[0], 64);
  // The cancelled load's own objects (the other columns' parts) are read when asked again.
  await root.load(['obs']);
  assert.equal(root.get('obs/c5/categories').shape[0], 3);
  const offsets = recorder.log.map(entry => entry.offset);
  assert.equal(new Set(offsets).size, offsets.length, 'no block read twice');
  assert.ok(shared > 0);
  root.close();
  // A closed file loads nothing more.
  await assert.rejects(root.get('uns').load(), /closed/);
});

test('loading follows soft links and hard-link cycles: what a link leads to loads with the group holding it', async () => {
  const root = await openHdf5(createByteReader(bytesByteSource(fixture('default-format.h5'), { name: 'test.h5' })));
  // Opening loads the root to depth 1, and with it the way to each of its
  // soft links' targets: they resolve, their targets' children wait.
  assert.ok(root.keys().includes('soft_link'));
  assert.equal(root.get('soft_link').kind, 'array');
  assert.equal(root.get('soft_link').path, '/soft_link');
  assert.equal(root.get('soft_to_group').kind, 'group');
  // (/nested/deeper is on the way to soft_link's target, so it is open.)
  assert.equal(root.get('soft_to_group').loaded, true);
  assert.equal(root.get('dangling'), null);
  // A soft link through which a path goes: its target loads to the depth asked.
  await root.load(['soft_to_group']);
  assert.ok(root.get('soft_to_group/deepest/leaf') !== null);
  await root.load([{ path: 'nested', depth: 1 }]);
  assert.equal(root.get('nested/relative_link').kind, 'array');
  // A hard-link cycle: one load visits each object once and ends.
  if (root.keys().includes('cycle')) {
    await root.load(['cycle']);
    assert.equal(root.get('cycle').loaded, true);
  }
  root.close();
});

/* ---------- bytes fetched ---------- */

test('a chunk-aligned range of a 5000-chunk dataset fetches only its chunks', async () => {
  const recorder = recordingSource(fixture('default-format.h5'), { latencyMs: 0 });
  const root = await openHdf5(recorder.reader(), { load: [''] });
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

test('what a many-leaf chunked dataset stores is known without reading its chunk index\'s leaves', async () => {
  for (const name of ['many_chunks/btree_levels', 'many_chunks/btree_levels_gzip']) {
    const recorder = recordingSource(fixture('default-format.h5'), { latencyMs: 0 });
    const root = await openHdf5(recorder.reader(), { load: [''] });
    const node = root.get(name);
    const table = await node.reader.chunkTable(null);
    recorder.reset();
    // A whole dataset, and a range of it: estimated from the keys of the
    // leaves' parents (each leaf's first chunk), no request made.
    const estimate = await node.storedBytes();
    const rangeEstimate = await node.storedBytes([[400, 440]]);
    assert.equal(recorder.log.length, 0, `${name}: ${recorder.log.length} requests to know what it stores`);
    assert.equal(table.count, 0, `${name}: no leaf was read`);
    await node.read();
    const exact = await node.storedBytes();
    assert.equal(table.count, 5000);
    assert.equal(await node.storedBytes([[400, 440]]), Array.from({ length: 10 }, (_, k) => table.size[table.find(100 + k)]).reduce((a, b) => a + b, 0));
    if (name.endsWith('gzip')) {
      assert.ok(Math.abs(estimate - exact) <= 0.25 * exact, `${name}: estimate ${estimate}, stored ${exact}`);
      assert.ok(rangeEstimate > 0);
    } else {
      // Unfiltered chunks all store their full size: the estimate is exact.
      assert.equal(estimate, exact);
      assert.equal(rangeEstimate, 10 * 4 * 2);
    }
    root.close();
  }
});

test('reads that go on in row order find the next leaves of the chunk index read ahead: one round trip each, not two', async () => {
  // Six requests at once: the rest of the tree's leaves are too many to
  // follow every read in one wave of background requests.
  const latencyMs = 10;
  const recorder = recordingSource(fixture('default-format.h5'), { latencyMs, policy: { concurrency: 6 } });
  const root = await openHdf5(recorder.reader(), { load: [''] });
  const node = root.get('many_chunks/btree_levels_gzip');
  const table = await node.reader.chunkTable(null);
  // Rows in file order, a leaf's worth (2K chunks of 4 rows) at a time, as
  // a slab scan or a subsample's waves read them; each read after the first
  // two finds its leaves read ahead, and waits one round trip, for its chunks.
  const leafRows = 2 * 32 * 4;
  for (let k = 0; k < 8; k++) {
    const started = recorder.time.now();
    const values = await node.read([[k * leafRows, (k + 1) * leafRows]]);
    const waited = recorder.time.now() - started;
    assert.equal(values[1], (k * leafRows + 1) * 3);
    if (k >= 2) assert.ok(waited <= latencyMs, `read ${k} waited ${waited} ms: ${waited / latencyMs} round trips`);
  }
  // A read elsewhere reads nothing ahead.
  const before = table.count;
  await node.read([[15000, 15004]]);
  await recorder.time.sleep(5 * latencyMs);
  assert.ok(table.count - before <= 2 * 64, `${table.count - before} entries placed for a read elsewhere`);
  root.close();
});

test('reads asked for in one task wait for the chunk index leaves of all of them, then fetch their chunks together', async () => {
  // Two reads far apart, each needing its own leaf, asked for together; the
  // second leaf answers late. Every chunk request of the task goes out at
  // once when both leaves are in, not the first read's as soon as its own.
  const bytes = fixture('default-format.h5');
  const base = bytesByteSource(bytes, { name: 'burst.h5', policy: { concurrency: 100 } });
  const time = virtualTime();
  const log = [];
  let reads = 0;
  let first = Infinity;
  const source = {
    size: base.size,
    name: base.name,
    identity: base.identity,
    policy: base.policy,
    async read(offset, length, options) {
      const n = reads++;
      log.push({ at: time.now(), n });
      await time.sleep(n === first + 1 ? 50 : 5);
      return base.read(offset, length, options);
    },
  };
  const root = await openHdf5(createByteReader(source, { clock: time.now }), { load: [''] });
  const node = root.get('many_chunks/btree_levels_gzip');
  await node.reader.chunkTable(null);
  first = reads;
  const answered = [];
  const [one, two] = await Promise.all([[8000, 8004], [19_000, 19_004]].map((range, k) => node.read([range]).then(values => {
    answered[k] = time.now();
    return values;
  })));
  assert.equal(one[1], 8001 * 3);
  assert.equal(two[1], 19_001 * 3);
  const [leafOne, leafTwo, ...rest] = log.filter(entry => entry.n >= first);
  assert.equal(leafOne.at, leafTwo.at, 'the two leaves are asked for together');
  // The late leaf is in at `late`: both reads' chunks go then, together, and
  // neither read is answered before they arrive. (The other leaves, read
  // ahead in the background once the first leaf is in, go before it.)
  const late = leafTwo.at + 50;
  // (A chunk a request before held in a gap it fetched is answered from it:
  // at least one request then.)
  const chunks = rest.filter(entry => entry.at >= late);
  assert.ok(chunks.length >= 1 && chunks.every(entry => entry.at === late),
    `chunk requests at ${chunks.map(entry => entry.at)}, the late leaf in at ${late}`);
  // Neither is answered before the late leaf; one whose chunk a request
  // before held in a gap it fetched is answered then, the other once its
  // chunk arrives.
  assert.ok(answered.every(at => at === late || at >= late + 5), `reads answered at ${answered}, the late leaf in at ${late}, the chunks at ${late + 5}`);
  assert.ok(answered.some(at => at >= late + 5), `reads answered at ${answered}: none waited for a chunk`);
  root.close();
});

test('a read cancelled while it finds its chunks leaves no unobserved rejection behind', async () => {
  const unobserved = [];
  const onUnhandled = reason => unobserved.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const name of ['many_chunks/btree_levels_gzip', 'many_chunks/btree_levels']) {
      const recorder = recordingSource(fixture('default-format.h5'), { latencyMs: 1, policy: { concurrency: 6 } });
      const root = await openHdf5(recorder.reader(), { load: [''] });
      const node = root.get(name);
      await node.reader.chunkTable(null);
      for (let k = 0; k < 4; k++) {
        const controller = new AbortController();
        // Aborted while the leaves of the chunk index it needs are read: the
        // read then goes on to its chunks with a signal already aborted.
        recorder.onRead = () => controller.abort();
        const reading = node.read([[k * 4000, k * 4000 + 2000]], { signal: controller.signal });
        // A read its cached bytes answered made no request, and was not aborted.
        await reading.then(
          () => assert.equal(controller.signal.aborted, false),
          error => assert.equal(error.name, 'AbortError')
        );
        recorder.onRead = null;
      }
      // Every fetch released settles; none of them is anybody's failure. On
      // the source's clock, which moves only once the process is idle: a
      // sleep far past any chain of its requests wakes once all of them,
      // and what each led to, are done.
      await recorder.time.sleep(10_000);
      assert.deepEqual(Array.from(await node.read([[0, 3]])), name.endsWith('gzip') ? [0, 3, 6] : [0, 1, 2]);
      root.close();
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unobserved, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('the first rows of a many-leaf chunked dataset wait for one leaf of its chunk index, not all of them', async () => {
  const recorder = recordingSource(fixture('default-format.h5'), { latencyMs: 1 });
  const root = await openHdf5(recorder.reader(), { load: [''] });
  const node = root.get('many_chunks/btree_levels');
  recorder.reset();
  const started = recorder.time.now();
  const values = await node.read([[0, 40]]);
  const waited = recorder.time.now() - started;
  const asked = recorder.log.length;
  assert.deepEqual(Array.from(values), Array.from({ length: 40 }, (_, i) => i));
  // What it waited for: the index above its rows, one round trip. The other
  // leaves are read ahead once its own is in, in the background
  // (`chunk-index.js`), and nobody waits for them.
  assert.ok(asked <= 3, `${asked} index node reads (root, the leaf)`);
  assert.equal(waited, 1, `${waited} round trips`);
  const table = await node.reader.chunkTable(null);
  await recorder.time.sleep(10);
  assert.equal(table.count, 5000, 'the other leaves are read ahead');
  assert.ok(recorder.log.length > asked, 'after it');
  root.close();
});

test('a chunk B-tree is read from its root as reads need it: making its table and pricing the whole dataset read one node, whatever its chunk count', async () => {
  // One request at a time: no level below the root is one wave of the link,
  // so nothing below it is read until a read needs it. (Reading every leaf's
  // parent with the table cost a 2.26M-chunk atlas X 562 nodes, 13.5 s over
  // S3, before its first view.)
  const recorder = recordingSource(fixture('default-format.h5'), { latencyMs: 1, policy: { concurrency: 1 } });
  const root = await openHdf5(recorder.reader(), { load: [''] });
  const node = root.get('many_chunks/btree_levels');
  recorder.reset();
  const table = await node.reader.chunkTable(null);
  const made = recorder.log.length;
  assert.ok(made <= 1, `${made} index node reads to make the table (at most the root, which the opening may hold)`);
  // The whole dataset priced from the root's keys: no request.
  const stored = await node.storedBytes(undefined);
  assert.ok(stored > 0, 'a stored size');
  assert.equal(recorder.log.length, made, 'pricing the dataset reads no node');
  assert.equal(table.covered(0, 0), false);
  // Its first rows read the nodes on their path: one node a level below the
  // root, then their leaf, then their chunk.
  const priced = table.indexReadsFor([[0, 9]]);
  // Runs on one path count its nodes once (a gene sample's blocks a few chunks apart).
  assert.deepEqual(table.indexReadsFor([[0, 2], [5, 6], [9, 9]]), priced);
  recorder.reset();
  const values = await node.read([[0, 40]]);
  assert.deepEqual(Array.from(values), Array.from({ length: 40 }, (_, i) => i));
  assert.deepEqual(priced, { nodes: 2, levels: 2, steps: [1, 1] }, 'priced: a node below the root, then a leaf, one after the other');
  assert.ok(recorder.log.length <= 3, `${recorder.log.length} reads (a node below the root, the leaf, the chunks)`);
  assert.equal(table.covered(0, 9), true);
  assert.deepEqual(table.indexReadsFor([[0, 9]]), { nodes: 0, levels: 0, steps: [] }, 'nothing more to read for them');
  // Rows elsewhere read their own path, not every node of the level.
  recorder.reset();
  const far = await node.read([[19_000, 19_004]]);
  assert.equal(far[1], 19_001);
  assert.ok(recorder.log.length <= 3, `${recorder.log.length} reads for rows elsewhere`);
  root.close();
});

test('a gene sample\'s first gene is priced with its chunk-index reads: the priced time is the measured one within the floor model\'s tolerance', async () => {
  // A CSR matrix whose pointers and indices are chunked arrays found through
  // version 1 chunk B-trees of three levels (5,000 chunks each), its first
  // gene read for two blocks of cells far apart, over a link of 100 ms
  // round trips and no bandwidth limit: its time is its dependent round
  // trips. Each array's index levels not read yet are read one after the
  // other before its chunks, and the entries only once the pointers say
  // where they lie: four trips, where pricing chunk runs alone said one (on
  // an 11.4M-cell CELLxGENE atlas, 311 of the first gene's 539 requests were
  // chunk B-tree nodes, and revisits ran 2-6% past the 20 s target).
  const latencyMs = 100;
  const recorder = recordingSource(fixture('default-format.h5'), { latencyMs });
  const file = await openHdf5(recorder.reader(), { load: [''] });
  const pointers = file.get('many_chunks/btree_levels');
  const entries = file.get('many_chunks/btree_levels_gzip');
  const nRows = pointers.shape[0] - 1;
  const members = { indptr: pointers, indices: entries, data: pointers };
  const X = Object.freeze({
    kind: 'group',
    path: '/X',
    name: 'X',
    attrs: { 'encoding-type': 'csr_matrix', 'encoding-version': '0.1.0', shape: [nRows, 60_000] },
    keys: () => Object.keys(members).sort(),
    has: key => Object.hasOwn(members, key),
    get: key => members[key] ?? null,
  });
  const root = Object.freeze({ kind: 'group', path: '/', name: '', attrs: {}, keys: () => ['X'], has: key => key === 'X', get: key => (key === 'X' ? X : null) });
  const cost = await firstGeneReadCost(root, nRows, { valuesOnDemand: true, decodedChunkBytes: 1e9 });
  const blocks = [[100, 120], [15_000, 15_020]];
  const rows = { count: blocks.length, starts: blocks.map(([start]) => start), ends: blocks.map(([, end]) => end) };
  const priced = cost(rows);
  const link = { latencyMs, bytesPerMs: 1e12, shapingConcurrency: 10_000 };
  // The first gene's reads, as the reader makes them: each block's pointers,
  // then its entries (indices, and values read by range beside them).
  recorder.reset();
  const start = recorder.time.now();
  const read = await Promise.all(blocks.map(([from, to]) => pointers.read([[from, to + 1]])));
  await Promise.all(read.flatMap(block => [entries.read([[block[0], block[block.length - 1]]]), pointers.read([[block[0], block[block.length - 1]]])]));
  const measuredMs = recorder.time.now() - start;
  const pricedMs = linkReadMs(priced, link);
  // The pointers' leaf, their chunks, the entries' leaf, their chunks (the
  // level below the root is one wave of the link: read with the table).
  assert.equal(priced.steps.length, 4, `steps ${priced.steps}`);
  assert.ok(measuredMs <= 1.1 * pricedMs + 20 && pricedMs <= 1.1 * measuredMs + 20, `priced ${pricedMs} ms against ${measuredMs} ms measured`);
  // The index nodes are priced as requests, each once.
  assert.ok(Math.abs(priced.requests - recorder.log.length) <= 1, `${priced.requests} requests priced, ${recorder.log.length} made`);
  file.close();
});

/** Row runs (`readRows`) of one-dimensional selections. */
const runsOf = selections => ({
  count: selections.length,
  starts: selections.map(([[from]]) => from),
  ends: selections.map(([[, to]]) => to),
});

test('a string column read in pieces loads each piece\'s heap collections as its references arrive while the link has room, and gathers them while requests queue', async () => {
  // Three pieces of a column whose strings fill three global heap
  // collections, their references a request each, arriving one after
  // another. With room on the link (a multiplexed one), each piece's
  // collection is asked for as its references arrive: one union after
  // every piece made the link idle meanwhile (100M cells at a 1% share
  // over 20 ms HTTP/2: 87.7 s against 71.8 s). With every request queued
  // (six a host over HTTP/1.1, a host's request budget), what arrives
  // meanwhile is gathered into one plan: a request, not one a piece
  // (10M cells over 150 ms HTTP/1.1: 77.0 s against 84.6 s).
  const perCollection = 65_535;
  const strings = Array.from({ length: 3 * perCollection }, (_, i) => `c${i}`);
  const bytes = new Uint8Array(await writeHdf5(group({}, [['names', stringDataset(strings)]])).arrayBuffer());
  const pieces = [0, 1, 2].map(c => [[c * perCollection, c * perCollection + 2000]]);
  const isHeap = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4)) === 'GCOL';
  const measured = async concurrency => {
    const base = bytesByteSource(bytes, { name: 'names.h5', policy: { concurrency, mergeGapBytes: 0, blockBytes: 512 } });
    const log = [];
    const time = virtualTime();
    const source = {
      size: base.size,
      name: base.name,
      identity: base.identity,
      policy: base.policy,
      async read(offset, length, options) {
        const entry = { heap: isHeap(offset), start: time.now(), end: null };
        log.push(entry);
        // Further into the file, slower: the pieces' references arrive one after another.
        await time.sleep(2 + 3 * Math.floor(offset / 500_000));
        entry.end = time.now();
        return base.read(offset, length, options);
      },
    };
    const reader = createByteReader(source, { clock: time.now });
    const root = await openHdf5(reader, { load: [''] });
    reader.clear();
    log.length = 0;
    const values = await root.get('names').readRows(runsOf(pieces));
    assert.deepEqual(values, pieces.flatMap(([[from, to]]) => strings.slice(from, to)));
    root.close();
    return { heap: log.filter(entry => entry.heap), references: log.filter(entry => !entry.heap) };
  };
  const roomy = await measured(10_000);
  assert.equal(roomy.references.length, 3);
  assert.deepEqual(roomy.heap.map(entry => entry.start), roomy.references.map(entry => entry.end), 'each collection asked for as its piece arrived');
  const queued = await measured(1);
  assert.equal(queued.heap.length, 1, 'the collections gathered into one plan while requests queued');
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
    const root = await openHdf5(recorder.reader(), { load: [''] });
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
  const root = await openHdf5(recorder.reader(), { load: [''] });
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
  const root = await openHdf5(recorder.reader(), { load: [''] });
  const node = root.get('shapes/dense_2d_row_chunks'); // 64 x 9, chunks 16 x 9
  await node.read([[0, 64], [0, 1]]);
  recorder.reset();
  for (let j = 1; j < 9; j++) await node.read([[0, 64], [j, j + 1]]);
  assert.equal(recorder.log.length, 0, 'no request after the first column');
  assert.ok(root.stats().decodedCache.hits >= 8 * 4);
  root.close();
});

/* ---------- ownership, cancellation, closing, accounting ---------- */

test('part of an unfiltered chunk is fetched as its own bytes, not the whole chunk', async () => {
  const recorder = recordingSource(fixture('default-format.h5'), { latencyMs: 0 });
  const reader = recorder.reader();
  const root = await openHdf5(reader, { load: [''] });
  const node = root.get('chunked/le_f4'); // 4-byte elements, unfiltered chunks of 64
  await node.reader.chunkTable(null);
  const reference = await open(fixture('default-format.h5')).then(async other => {
    const values = Array.from(await other.get('chunked/le_f4').read([[0, 256]]));
    other.close();
    return values;
  });
  recorder.log.length = 0;
  // From the file, not from metadata blocks cached at open.
  reader.clear();
  assert.deepEqual(Array.from(await node.read([[10, 20]])), reference.slice(10, 20));
  assert.deepEqual(recorder.log.map(read => read.length), [40], 'ten elements, not the chunk\'s 256 bytes');
  // A selection over two chunks fetches the two runs, which touch: one request.
  recorder.log.length = 0;
  // From the file, not from metadata blocks cached at open.
  reader.clear();
  assert.deepEqual(Array.from(await node.read([[60, 70]])), reference.slice(60, 70));
  assert.deepEqual(recorder.log.map(read => read.length), [40]);
  assert.equal(await node.storedBytes([[60, 70]]), 40);
  // A whole chunk is still read whole.
  recorder.log.length = 0;
  // From the file, not from metadata blocks cached at open.
  reader.clear();
  assert.deepEqual(Array.from(await node.read([[64, 128]])), reference.slice(64, 128));
  assert.deepEqual(recorder.log.map(read => read.length), [256]);
  root.close();
});

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
  const root = await openHdf5(recorder.reader(), { load: [''] });
  const node = root.get('chunk_index/extensible_array_gzip');
  const already = new AbortController();
  already.abort();
  await assert.rejects(node.read(undefined, { signal: already.signal }), { name: 'AbortError' });
  const controller = new AbortController();
  // Canceled while its first request is in flight.
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
  const root = await openHdf5(reader, { load: [''] });
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
  const root = await openHdf5(reader, { load: [''] });
  // A compressed chunk is fetched whole and decoded once for every read of it.
  const chunked = root.get('gzip/le_f8'); // chunks of 100
  await chunked.reader.chunkTable(null);
  // The chunk is read from the file, not from metadata blocks cached at open.
  reader.clear();
  const reference = await open(fixture('default-format.h5')).then(async other => {
    const values = Array.from(await other.get('gzip/le_f8').read([[0, 100]]));
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

test('the decoded-chunk cache keeps owned copies', async () => {
  // The cache itself (formats/io/byte-cache.js, shared with Zarr) is tested
  // in zarr-format-efficiency.test.mjs. A chunk read as part of one larger request is kept as its own bytes, not
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
  const { ByteBudget } = await import('../assets/js/formats/hdf5/byte-budget.js');
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

test('a string column\'s rows read together (a subsample\'s kept rows, chunk by chunk) load its global heap in fewer rounds than a piece at a time', async () => {
  // obs/_index: 300 strings in 18 gzip chunks of 17 rows, their bytes in global heap collections.
  const bytes = new Uint8Array(readFileSync(path.join(here, 'fixtures', 'subsample', 'csr-gzip-earliest.h5ad')));
  const expected = await (await open(bytes)).get('obs/_index').read();
  const boxes = Array.from({ length: 18 }, (_, c) => [[c * 17, Math.min(300, (c + 1) * 17)]]);
  const kept = expected.map((_, row) => row).filter(row => row % 7 === 3);
  /** The requests and dependent rounds `read` makes after opening (nothing held from the opening). */
  const measured = async read => {
    const recorder = recordingSource(bytes, { policy: { concurrency: 6, mergeGapBytes: 0, blockBytes: 512 } });
    const reader = recorder.reader();
    const root = await openHdf5(reader, { decodedChunkCacheBytes: 0, load: [''] });
    reader.clear();
    recorder.reset();
    const value = await read(root.get('obs/_index'));
    return { value, requests: recorder.log.length, rounds: recorder.rounds() - Math.min(...recorder.log.map(entry => entry.round)) + 1 };
  };
  const together = await measured(node => node.readRows(runsOf(boxes)));
  assert.deepEqual(together.value.flat(), expected);
  // A piece at a time, each piece's heap loads after its own chunk: a heap round more.
  const apart = await measured(node => Promise.all(boxes.map(box => node.read(box))));
  assert.deepEqual(apart.value.flat(), expected);
  // (A piece read apart may find its collections in a gap a request before
  // fetched: never fewer rounds than together.)
  assert.ok(together.rounds <= apart.rounds, `together ${together.rounds} rounds, apart ${apart.rounds}`);
  // The view of kept rows reads its chunks' pieces together: as few rounds and requests.
  const view = await measured(node => gatheredArray(node, runsOfPositions(Uint32Array.from(kept)), {
    mergeGapBytes: () => 0,
    chunks: new DecodedChunks(1 << 24),
  }).read());
  assert.deepEqual(view.value, kept.map(row => expected[row]));
  // As few rounds; its heap loads go out as its pieces arrive while the
  // link has room (`HeapStream`), each collection read only as far as the
  // kept rows need, so a piece arriving later that needs one further costs
  // that collection's rest (one request each of the column's 3 collections
  // at most), never one a piece as read apart.
  assert.equal(view.rounds, together.rounds);
  assert.ok(view.requests <= apart.requests + 3, `view ${view.requests} requests, apart ${apart.requests}`);
});
