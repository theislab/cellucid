/**
 * A share of a column of variable-length strings (the obs index, a text
 * column; HDF5 global heaps, Zarr vlen-utf8 chunks) costs about its share:
 *
 * - bytes: each byte in flight is fetched once (the byte reader's requests
 *   in flight are shared, never fetched again in a gap), a share never reads
 *   more than every row, and a larger share never less than a smaller one;
 * - memory: the heap collections a read loads are let go once its rows are
 *   decoded (none kept in the file's cache), and what a read keeps per chunk
 *   is the chunk as stored (references, or items with their offsets),
 *   counted at what it holds;
 * - CPU: only the rows asked for are decoded to strings;
 * - and the values are those of the whole column, bit for bit.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { openHdf5 } from '../assets/js/formats/hdf5/index.js';
import { group, stringDataset, writeHdf5 } from '../assets/js/formats/hdf5/writer.js';
import { memoryStore, openZarr } from '../assets/js/formats/zarr/index.js';
import { VlenItems } from '../assets/js/formats/zarr/codecs/vlen.js';
import { gatheredArray, runsOfPositions } from '../assets/js/data/anndata/views/cell-subset.js';
import { DecodedChunks } from '../assets/js/data/anndata/decoded-chunks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const encoder = new TextEncoder();
const macrotask = () => new Promise(resolve => setImmediate(resolve));

function pattern(length) {
  return Uint8Array.from({ length }, (_, i) => (i * 7 + 3) & 0xff);
}

/** A byte source that logs each request and answers once released. */
function gatedSource(bytes, policy) {
  const base = bytesByteSource(bytes, { name: 'gated', policy });
  const calls = [];
  let open = null;
  let gate = new Promise(resolve => { open = resolve; });
  return {
    calls,
    release() { open(); },
    source: {
      ...base,
      async read(offset, length, options = {}) {
        calls.push([offset, length]);
        await gate;
        return base.read(offset, length, options);
      },
    },
  };
}

/** A byte source over `bytes` recording every request's range. */
function recordedSource(bytes, policy) {
  const base = bytesByteSource(bytes, { name: 'recorded', policy });
  const log = [];
  return {
    log,
    source: {
      ...base,
      async read(offset, length, options = {}) {
        log.push([offset, offset + length]);
        await macrotask();
        return base.read(offset, length, options);
      },
    },
  };
}

/** Bytes fetched more than once among `ranges` (their sum less their union). */
function fetchedTwice(ranges) {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  let twice = 0;
  let end = -Infinity;
  for (const [start, stop] of sorted) {
    if (start < end) twice += Math.min(stop, end) - start;
    end = Math.max(end, stop);
  }
  return twice;
}

const sum = ranges => ranges.reduce((total, [start, stop]) => total + stop - start, 0);

/** Every `step`-th row of `n` from `offset`: a uniform share's kept rows. */
const everyNth = (n, step, offset = 0) => Uint32Array.from({ length: Math.ceil((n - offset) / step) }, (_, i) => offset + i * step).filter(row => row < n);

test('a read of bytes a request in flight carries waits for it: each byte in flight is fetched once', async () => {
  const bytes = pattern(20_000);
  const gated = gatedSource(bytes, { blockBytes: 1024, mergeGapBytes: 0, maxRequestBytes: 1 << 20, concurrency: 4, cacheBytes: 8192 });
  const reader = createByteReader(gated.source);
  const first = reader.read(0, 1000);
  await macrotask();
  assert.deepEqual(gated.calls, [[0, 1000]]);
  // Planned apart while the first is on its way: the bytes it carries are not asked again.
  const overlapping = reader.read(500, 1000);
  const inside = reader.read(200, 100);
  await macrotask();
  assert.deepEqual(gated.calls, [[0, 1000], [1000, 500]], 'only the bytes no request carries');
  gated.release();
  assert.deepEqual(await first, bytes.subarray(0, 1000));
  assert.deepEqual(await overlapping, bytes.subarray(500, 1500));
  assert.deepEqual(await inside, bytes.subarray(200, 300));
});

test('a plan never fetches a gap across bytes in flight, and a request another read joined outlives the read that asked for it', async () => {
  const bytes = pattern(20_000);
  const gated = gatedSource(bytes, { blockBytes: 1024, mergeGapBytes: 10_000, maxRequestBytes: 1 << 20, concurrency: 8, cacheBytes: 8192 });
  const reader = createByteReader(gated.source);
  const stop = new AbortController();
  const asker = reader.read(2000, 100, { signal: stop.signal });
  asker.catch(() => {});
  await macrotask();
  // Either side of the request in flight: within the merge gap, yet two requests.
  const left = reader.read(1900, 50);
  const right = reader.read(2150, 50);
  const joiner = reader.read(2050, 20);
  await macrotask();
  assert.deepEqual(gated.calls, [[2000, 100], [1900, 50], [2150, 50]]);
  // The read that asked for [2000, 2100) withdraws; the one that joined still gets its bytes.
  stop.abort();
  await assert.rejects(asker);
  gated.release();
  assert.deepEqual(await joiner, bytes.subarray(2050, 2070));
  assert.deepEqual(await left, bytes.subarray(1900, 1950));
  assert.deepEqual(await right, bytes.subarray(2150, 2200));
  assert.equal(gated.calls.length, 3);
});

/**
 * Read `rows` of a string column through a subsample's view, on a fresh
 * reader of `bytes`: the values, the requests made, what the file's cache
 * and the view's decoded chunks hold after.
 */
async function readShare(bytes, arrayPath, rows, policy) {
  const recorded = recordedSource(bytes, policy);
  const reader = createByteReader(recorded.source);
  const root = await openHdf5(reader, { load: [''] });
  reader.clear();
  recorded.log.length = 0;
  const node = root.get(arrayPath);
  // Collections the opening keeps (attributes in the heap) are the opening's.
  const heapKeys = () => [...node.tree.file.cache.entries.keys()].filter(key => String(key).startsWith('gcol:'));
  const opened = new Set(heapKeys());
  const chunks = new DecodedChunks(1 << 26);
  const values = await gatheredArray(node, runsOfPositions(rows), { mergeGapBytes: () => policy.mergeGapBytes, chunks }).read();
  const heapCached = heapKeys().filter(key => !opened.has(key));
  root.close();
  return { values, log: recorded.log, heapCached, keptBytes: chunks.bytes };
}

for (const [label, make, arrayPath, policy] of [
  ['an HDF5 column stored in one piece', async () => {
    const strings = Array.from({ length: 30_000 }, (_, i) => `cell-${i}-${'x'.repeat(i % 23)}`);
    return { strings, bytes: new Uint8Array(await writeHdf5(group({}, [['names', stringDataset(strings)]])).arrayBuffer()) };
  }, 'names', { blockBytes: 512, mergeGapBytes: 256, maxRequestBytes: 1 << 20, concurrency: 6, cacheBytes: 1 << 16 }],
  ['an HDF5 column in gzip chunks (an .h5ad obs index)', async () => {
    const bytes = new Uint8Array(readFileSync(path.join(here, 'fixtures', 'subsample', 'csr-gzip-earliest.h5ad')));
    const reader = createByteReader(bytesByteSource(bytes, { name: 'whole' }));
    const strings = await (await openHdf5(reader, { load: [''] })).get('obs/_index').read();
    return { strings, bytes };
  }, 'obs/_index', { blockBytes: 512, mergeGapBytes: 0, maxRequestBytes: 1 << 20, concurrency: 6, cacheBytes: 1 << 16 }],
]) {
  test(`${label}: a share reads its rows exactly, each byte once, never more than every row nor less than a smaller share, and keeps no heap collection it loaded`, async () => {
    const { strings, bytes } = await make();
    const n = strings.length;
    let previous = 0;
    const read = [];
    for (const step of [997, 97, 7, 1]) {
      const rows = everyNth(n, step, 3 % step);
      const share = await readShare(bytes, arrayPath, rows, policy);
      assert.deepEqual(share.values, Array.from(rows, row => strings[row]), `1 in ${step}: the column's own values`);
      assert.equal(fetchedTwice(share.log), 0, `1 in ${step}: no byte fetched twice`);
      assert.deepEqual(share.heapCached, [], `1 in ${step}: no global heap collection kept after the read`);
      const fetched = sum(share.log);
      assert.ok(fetched >= previous, `1 in ${step}: ${fetched} bytes, fewer than the smaller share's ${previous}`);
      previous = fetched;
      read.push(fetched);
    }
    const every = read[read.length - 1];
    for (const fetched of read) assert.ok(fetched <= every, `${fetched} bytes for a share, ${every} for every row`);
  });
}

/** One-dimensional Zarr v2 and v3 stores of `strings`, vlen-utf8 in chunks of `chunk`, uncompressed. */
function zarrStores(strings, chunk) {
  const json = value => encoder.encode(JSON.stringify(value));
  const vlen = values => {
    const encoded = values.map(value => encoder.encode(value));
    const out = new Uint8Array(4 + encoded.reduce((total, item) => total + 4 + item.length, 0));
    const view = new DataView(out.buffer);
    view.setUint32(0, values.length, true);
    let at = 4;
    for (const item of encoded) {
      view.setUint32(at, item.length, true);
      out.set(item, at + 4);
      at += 4 + item.length;
    }
    return out;
  };
  const v2 = new Map([
    ['.zgroup', json({ zarr_format: 2 })],
    ['names/.zarray', json({ zarr_format: 2, shape: [strings.length], chunks: [chunk], dtype: '|O', compressor: null, fill_value: 0, filters: [{ id: 'vlen-utf8' }], order: 'C' })],
  ]);
  const v3 = new Map([
    ['zarr.json', json({ zarr_format: 3, node_type: 'group', attributes: {} })],
    ['names/zarr.json', json({
      zarr_format: 3, node_type: 'array', shape: [strings.length], data_type: 'string',
      chunk_grid: { name: 'regular', configuration: { chunk_shape: [chunk] } },
      chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
      fill_value: '', codecs: [{ name: 'vlen-utf8', configuration: {} }], attributes: {},
    })],
  ]);
  for (let c = 0; c * chunk < strings.length; c++) {
    const bytes = vlen(strings.slice(c * chunk, (c + 1) * chunk));
    v2.set(`names/${c}`, bytes);
    v3.set(`names/c/${c}`, bytes);
  }
  return { v2, v3 };
}

test('a Zarr column of strings (v2 and v3) decodes the rows a share asks for and no other, and keeps its chunks as stored', async t => {
  const strings = Array.from({ length: 4000 }, (_, i) => `AAAC${i}-${'ü'.repeat(i % 5)}`);
  const stores = zarrStores(strings, 1000);
  for (const version of ['v2', 'v3']) {
    await t.test(version, async () => {
      const root = await openZarr(memoryStore(stores[version], { name: `names.${version}.zarr` }), { decodedChunkCacheBytes: 0 });
      const node = root.get('names');
      assert.equal(typeof node.readRows, 'function');
      const rows = everyNth(strings.length, 100, 7);
      const at = VlenItems.prototype.at;
      let decoded = 0;
      VlenItems.prototype.at = function counted(i) {
        decoded++;
        return at.call(this, i);
      };
      try {
        const chunks = new DecodedChunks(1 << 26);
        const values = await gatheredArray(node, runsOfPositions(rows), { mergeGapBytes: () => 0, chunks }).read();
        assert.deepEqual(values, Array.from(rows, row => strings[row]));
        assert.equal(decoded, rows.length, 'one string decoded a row asked for');
        // Kept as stored: the chunks' bytes and an offset an item, not a string an item.
        const stored = [...stores[version]].filter(([key]) => /names\/(c\/)?\d+$/.test(key)).reduce((total, [, bytes]) => total + bytes.length, 0);
        assert.equal(chunks.bytes, stored + 4 * (strings.length + 4), `kept ${chunks.bytes} bytes for ${stored} stored`);
        decoded = 0;
        // A read of every row decodes every row, and reads the same values.
        assert.deepEqual(await node.read(), strings);
        assert.equal(decoded, strings.length);
      } finally {
        VlenItems.prototype.at = at;
      }
    });
  }
});

