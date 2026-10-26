/**
 * The Zarr reader (assets/js/formats/zarr) gives zarr-python's answer, value
 * for value, for every store of the conformance corpus
 * (scripts/generate-zarr-conformance-corpus.py, tests/fixtures/zarr): Zarr v2
 * and v3 cases covering every element type, codec, layout, fill value and
 * sharding case, and AnnData stores written by anndata in both formats,
 * compressed and not (cellucid-r's viewer serves its store uncompressed). Each
 * store is read as a folder, as a ZIP archive and from a (simulated) web host.
 */
import assert from 'node:assert/strict';
import { openAsBlob, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { blobByteSource } from '../assets/js/formats/io/byte-source.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { openZipArchive } from '../assets/js/formats/zip/index.js';
import {
  ZarrFormatError,
  ZarrUnsupportedError,
  directoryStore,
  httpStore,
  memoryStore,
  openZarr,
  zipStore,
} from '../assets/js/formats/zarr/index.js';
import { isArrayNode, isGroup } from '../assets/js/formats/store.js';

import { ZARR_CORPUS as FIXTURES, corpusEntries, corpusFolder } from './helpers/zarr-corpus.mjs';
const STORES = ['v2/cases.zarr', 'v3/cases.zarr', 'anndata/v2.zarr', 'anndata/v3.zarr', 'anndata/v3-sharded.zarr',
  'anndata/v2-uncompressed.zarr', 'anndata/v3-uncompressed.zarr'];

// ---------------------------------------------------------------------------
// Opening a corpus store through each backend.

async function openFolder(store, options) {
  return openZarr(directoryStore(await corpusFolder(store)), options);
}

async function openZip(store, options) {
  const file = await openAsBlob(path.join(FIXTURES, `${store}.zip`));
  const archive = await openZipArchive(createByteReader(blobByteSource(file, { name: `${path.basename(store)}.zip` })));
  return openZarr(zipStore(archive), options);
}

/** A fetch serving a folder like a static web host (GET, HEAD, single ranges, 404). */
function hostFetch(entries, { log = null, latencyMs = 0 } = {}) {
  return async (url, init = {}) => {
    const relative = decodeURIComponent(new URL(url).pathname.replace(/^\/host\//, ''));
    log?.push({ url: relative, range: init.headers?.Range ?? null, method: init.method ?? 'GET' });
    if (latencyMs > 0) await new Promise(resolve => setTimeout(resolve, latencyMs));
    const bytes = entries.get(relative);
    if (bytes === undefined) return new Response(null, { status: 404 });
    if ((init.method ?? 'GET') === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'Content-Length': String(bytes.length) } });
    }
    const range = init.headers?.Range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start;
      let end;
      if (match[1] === '') {
        start = Math.max(0, bytes.length - Number(match[2]));
        end = bytes.length;
      } else {
        start = Number(match[1]);
        end = match[2] === '' ? bytes.length : Number(match[2]) + 1;
      }
      return new Response(bytes.subarray(start, end), { status: 206 });
    }
    return new Response(bytes, { status: 200 });
  };
}

async function openHttp(store, options) {
  return openZarr(httpStore('https://example.test/host/', { fetch: hostFetch(await corpusEntries(store)) }), options);
}

// ---------------------------------------------------------------------------
// Comparing values with the expected encoding.

function expectedNumber(value) {
  if (value === 'NaN') return NaN;
  if (value === 'Infinity') return Infinity;
  if (value === '-Infinity') return -Infinity;
  return value;
}

function decodeAttr(value) {
  if (Array.isArray(value)) return value.map(decodeAttr);
  if (value !== null && typeof value === 'object') {
    if ('$bigint' in value) return BigInt(value.$bigint);
    if ('$float' in value) return expectedNumber(value.$float);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeAttr(item)]));
  }
  return value;
}

function hex(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

/** One value as the reader returns it, in the expected encoding. */
function encode(value, dtype) {
  switch (dtype.kind) {
    case 'compound':
      return dtype.fields.map((field, i) => {
        const part = value[i];
        if (field.shape.length > 0) return Array.from(part, item => encode(item, field.dtype));
        return encode(part, field.dtype);
      });
    case 'opaque':
      return hex(value);
    case 'int':
    case 'uint':
      return typeof value === 'bigint' ? String(value) : value;
    case 'float':
      if (Number.isNaN(value)) return 'NaN';
      if (value === Infinity) return 'Infinity';
      if (value === -Infinity) return '-Infinity';
      return value;
    default:
      return value;
  }
}

/** The elements of a read result, encoded. */
function encodeAll(result, dtype, count) {
  if (dtype.kind === 'opaque') {
    const size = dtype.bytes;
    return Array.from({ length: count }, (_, i) => hex(result.subarray(i * size, (i + 1) * size)));
  }
  return Array.from(result, value => encode(value, dtype));
}

function sameValue(actual, expected, where) {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${where}: expected a list`);
    assert.equal(actual.length, expected.length, `${where}: length`);
    expected.forEach((item, i) => sameValue(actual[i], item, `${where}[${i}]`));
    return;
  }
  if (typeof expected === 'number' && typeof actual === 'number') {
    // -0 and 0 compare equal in the expected JSON (Python writes -0.0 as -0.0, both fine).
    assert.ok(actual === expected || (Number.isNaN(actual) && Number.isNaN(expected)), `${where}: ${actual} !== ${expected}`);
    return;
  }
  assert.deepEqual(actual, expected, where);
}

/** The expected values of a box of a C-order array. */
function expectedBox(values, shape, selection) {
  const out = [];
  const strides = shape.map((_, axis) => shape.slice(axis + 1).reduce((a, b) => a * b, 1));
  const visit = (axis, offset) => {
    if (axis === shape.length) {
      out.push(values[offset]);
      return;
    }
    for (let i = selection[axis][0]; i < selection[axis][1]; i++) visit(axis + 1, offset + i * strides[axis]);
  };
  visit(0, 0);
  return out;
}

/** A deterministic pseudo-random generator (mulberry32). */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function expectedOf(store) {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${store}.expected.json`), 'utf8'));
}

/** Check every node of an opened store against zarr-python's reading. */
async function conforms(root, store) {
  const expected = expectedOf(store);
  assert.equal(root.zarrFormat, expected.zarr_format);
  const next = random(7);
  for (const [nodePath, want] of Object.entries(expected.nodes)) {
    const node = nodePath === '/' ? root : root.get(nodePath);
    assert.ok(node, `${store}${nodePath} exists`);
    assert.equal(node.path, nodePath);
    assert.equal(node.kind, want.kind, `${nodePath}: kind`);
    sameValue(node.attrs, decodeAttr(want.attrs), `${nodePath}: attrs`);
    assert.ok(Object.isFrozen(node.attrs), `${nodePath}: attrs are frozen`);
    assert.equal(node.attributeType('anything'), null);
    if (want.kind === 'group') {
      assert.ok(isGroup(node));
      const children = Object.keys(expected.nodes)
        .filter(other => other !== nodePath && other.startsWith(nodePath === '/' ? '/' : `${nodePath}/`) &&
          !other.slice(nodePath === '/' ? 1 : nodePath.length + 1).includes('/'))
        .map(other => other.slice(other.lastIndexOf('/') + 1))
        .sort();
      assert.deepEqual([...node.keys()], children, `${nodePath}: keys`);
      continue;
    }
    assert.ok(isArrayNode(node));
    assert.deepEqual(node.shape, want.shape, `${nodePath}: shape`);
    assert.deepEqual(node.chunks, want.chunks, `${nodePath}: chunks`);
    const count = want.shape.reduce((a, b) => a * b, 1);
    if (want.error !== undefined) {
      await assert.rejects(node.read(), error => {
        assert.ok(error instanceof ZarrFormatError || error instanceof ZarrUnsupportedError, `${nodePath}: ${error}`);
        assert.match(error.message, new RegExp(want.error, 'i'));
        return true;
      });
      if (want.partial) {
        const values = await node.read(want.partial.selection);
        assert.deepEqual(Array.from(values), want.partial.values);
      }
      continue;
    }
    if ('fill' in want) {
      const fill = node.fillValue;
      sameValue(fill === null ? null : encode(fill, node.dtype), want.fill, `${nodePath}: fill`);
    }
    const whole = await node.read();
    const values = want.shape.length === 0
      ? [encode(whole, node.dtype)]
      : encodeAll(whole, node.dtype, count);
    sameValue(values, want.values, `${store}${nodePath}: values`);
    if (want.shape.length > 0 && count > 0) {
      for (let k = 0; k < 3; k++) {
        const selection = want.shape.map(extent => {
          const a = Math.floor(next() * extent);
          const b = a + 1 + Math.floor(next() * (extent - a));
          return [a, b];
        });
        const box = await node.read(selection);
        const boxCount = selection.reduce((n, [a, b]) => n * (b - a), 1);
        sameValue(encodeAll(box, node.dtype, boxCount), expectedBox(want.values, want.shape, selection), `${store}${nodePath}${JSON.stringify(selection)}`);
      }
    }
  }
}

for (const store of STORES) {
  test(`${store}: a picked folder reads as zarr-python reads it`, async () => {
    await conforms(await openFolder(store), store);
  });
  test(`${store}: a ZIP archive reads as zarr-python reads it`, async () => {
    await conforms(await openZip(store), store);
  });
  test(`${store}: a web host (consolidated metadata) reads as zarr-python reads it`, async () => {
    await conforms(await openHttp(store), store);
  });
}

test('a listed store reads the same with consolidated metadata ignored', async () => {
  await conforms(await openFolder('v2/cases.zarr', { consolidated: false }), 'v2/cases.zarr');
  await conforms(await openFolder('v3/cases.zarr', { consolidated: false }), 'v3/cases.zarr');
});

// ---------------------------------------------------------------------------
// The contract's shape of things.

test('element types follow the store contract', async () => {
  const v2 = await openFolder('v2/cases.zarr');
  const v3 = await openFolder('v3/cases.zarr');
  const dtype = (root, name) => root.get(name).dtype;
  assert.deepEqual(dtype(v2, 'dtypes/int16_be'), { kind: 'int', name: 'int16', bytes: 2, littleEndian: false });
  assert.deepEqual(dtype(v2, 'dtypes/float16_le'), { kind: 'float', name: 'float16', bytes: 2, littleEndian: true });
  assert.deepEqual(dtype(v2, 'dtypes/bool'), { kind: 'bool', name: 'bool', bytes: 1, littleEndian: null });
  assert.deepEqual(dtype(v2, 'dtypes/vlen_utf8'), { kind: 'string', name: 'string', bytes: null, littleEndian: null, variable: true, encoding: 'utf-8' });
  assert.deepEqual(dtype(v2, 'dtypes/bytes6'), { kind: 'string', name: 'string', bytes: 6, littleEndian: null, variable: false, encoding: 'ascii' });
  assert.deepEqual(dtype(v2, 'dtypes/unicode_le'), { kind: 'string', name: 'string', bytes: 16, littleEndian: null, variable: false, encoding: 'utf-8' });
  assert.deepEqual(dtype(v2, 'dtypes/void3'), { kind: 'opaque', name: 'opaque', bytes: 3, littleEndian: null });
  assert.equal(dtype(v2, 'dtypes/datetime').name, 'int64');
  const struct = dtype(v2, 'hand/struct_subarray');
  assert.equal(struct.kind, 'compound');
  assert.deepEqual(struct.fields.map(field => [field.name, field.offset, field.dtype.name, [...field.shape]]),
    [['id', 0, 'int32', []], ['xy', 4, 'float32', [2]]]);
  assert.deepEqual(dtype(v3, 'dtypes/int64_big_endian'), { kind: 'int', name: 'int64', bytes: 8, littleEndian: false });
  assert.equal(dtype(v3, 'dtypes/string').variable, true);
});

test('values come back in the contract types', async () => {
  const root = await openFolder('v2/cases.zarr');
  assert.ok((await root.get('dtypes/int64_be').read()) instanceof BigInt64Array);
  assert.ok((await root.get('dtypes/uint64').read()) instanceof BigUint64Array);
  assert.ok((await root.get('dtypes/float16_be').read()) instanceof Float32Array);
  assert.ok((await root.get('dtypes/float64_le').read()) instanceof Float64Array);
  assert.ok((await root.get('dtypes/bool').read()) instanceof Uint8Array);
  assert.ok(Array.isArray(await root.get('dtypes/vlen_utf8').read()));
  assert.equal(await root.get('layout/scalar').read(), 3.25);
  assert.deepEqual(await root.get('dtypes/int16_le').read([[2, 4]]), Int16Array.of(-300, 2100));
});

test('readField reads one member of a compound array, array members flattened', async () => {
  const root = await openFolder('v2/cases.zarr');
  const struct = root.get('hand/struct_subarray');
  assert.deepEqual(await struct.readField('id'), Int32Array.of(1, 2, 3));
  assert.deepEqual(await struct.readField('xy', [[1, 3]]), Float32Array.of(2.5, 3.5, 4.5, 5.5));
  const v3 = await openFolder('v3/cases.zarr');
  assert.deepEqual(await v3.get('fill/struct_fill').readField('b'), Float32Array.of(0.5, 0.25, 1.5, 1.5, 1.5));
  await assert.rejects(struct.readField('missing'), /no field 'missing'/);
  assert.equal(root.get('dtypes/int8').readField, undefined);
});

test('an uncompressed AnnData store reads as the same values as the compressed one', async () => {
  // The store cellucid-r serves from memory declares no compressor and no
  // shuffle; every array of it must read as the same AnnData, in both formats.
  for (const format of ['v2', 'v3']) {
    const compressed = await openFolder(`anndata/${format}.zarr`);
    const plain = await openFolder(`anndata/${format}-uncompressed.zarr`);
    const arrays = [];
    const walk = (node, prefix) => {
      for (const name of node.keys()) {
        const child = node.get(name);
        if (isArrayNode(child)) arrays.push(`${prefix}${name}`);
        else if (isGroup(child)) walk(child, `${prefix}${name}/`);
      }
    };
    walk(compressed, '');
    assert.ok(arrays.includes('X/data') && arrays.includes('obs/cell_type/codes'), format);
    for (const name of arrays) {
      const a = compressed.get(name);
      const b = plain.get(name);
      assert.ok(b, `${format} ${name}`);
      assert.deepEqual([b.dtype, b.shape, b.chunks], [a.dtype, a.shape, a.chunks], `${format} ${name}`);
      assert.deepEqual(await b.read(), await a.read(), `${format} ${name}`);
    }
  }
});

test('navigation is synchronous and paths are relative or absolute', async () => {
  const root = await openFolder('anndata/v2.zarr');
  const obs = root.get('obs');
  assert.equal(obs.get('cell_type/codes').path, '/obs/cell_type/codes');
  assert.equal(root.get('/obs/cell_type').name, 'cell_type');
  assert.equal(root.get('obs/absent'), null);
  assert.equal(root.has('obsm/X_umap'), true);
  assert.equal(root.get('obsm/X_umap/0'), null);
  assert.equal(root.path, '/');
  assert.equal(root.name, '');
  assert.throws(() => root.get('../x'), /'\.\.'/);
});

// ---------------------------------------------------------------------------
// Results belong to the caller.

test('a result owns its buffer: transferring it leaves later reads and the cache intact', async () => {
  const root = await openFolder('v3/cases.zarr');
  for (const name of ['codecs/zstd', 'layout/cube', 'dtypes/float32']) {
    const array = root.get(name);
    const whole = await array.read();
    const again = await array.read();
    const part = await array.read(array.shape.map(extent => [0, Math.max(1, extent - 1)]));
    for (const result of [whole, again, part]) {
      assert.equal(result.byteOffset, 0);
      assert.equal(result.byteLength, result.buffer.byteLength);
    }
    const reference = Array.from(again);
    structuredClone(whole, { transfer: [whole.buffer] });
    assert.equal(whole.length, 0, 'the first result is detached');
    assert.deepEqual(Array.from(again), reference, 'the second result is intact');
    const third = await array.read();
    assert.deepEqual(Array.from(third), reference, 'the cache is intact');
    structuredClone(part, { transfer: [part.buffer] });
    assert.deepEqual(Array.from(await array.read()), reference);
  }
});

test('a chunk read whole is a copy when another read shares it', async () => {
  const root = await openFolder('v3/cases.zarr');
  const array = root.get('dtypes/int32');
  // One chunk-exact read and one partial read of the same chunk at once.
  const [exact, partial] = await Promise.all([array.read([[0, 3]]), array.read([[1, 2]])]);
  structuredClone(exact, { transfer: [exact.buffer] });
  assert.deepEqual(Array.from(partial), [70000]);
  assert.deepEqual(Array.from(await array.read([[0, 3]])), [0, 70000, -70000]);
});

// ---------------------------------------------------------------------------
// Refusals and edge cases built in memory.

const encoder = new TextEncoder();
const json = value => encoder.encode(JSON.stringify(value));

function v2Store(meta, chunks, extra = {}) {
  return memoryStore({
    '.zgroup': json({ zarr_format: 2 }),
    'a/.zarray': json({ zarr_format: 2, shape: [4], chunks: [2], dtype: '<i4', compressor: null, fill_value: 0, filters: null, order: 'C', ...meta }),
    ...Object.fromEntries(Object.entries(chunks).map(([key, bytes]) => [`a/${key}`, bytes])),
    ...extra,
  });
}

test('an unsupported codec opens the store and refuses only that array, naming the codec', async () => {
  const root = await openZarr(v2Store({ compressor: { id: 'lzma' } }, { 0: new Uint8Array(8) }));
  const array = root.get('a');
  await assert.rejects(array.read(), error => error instanceof ZarrUnsupportedError && error.feature === 'codec lzma' && /lzma/.test(error.message));
  const custom = await openZarr(v2Store({ compressor: { id: 'imagecodecs_jpeg2k' } }, {}));
  await assert.rejects(custom.get('a').read(), /imagecodecs_jpeg2k/);
});

test('malformed metadata is a ZarrFormatError', async () => {
  await assert.rejects(openZarr(v2Store({ order: 'X' }, {})), ZarrFormatError);
  await assert.rejects(openZarr(v2Store({ chunks: [0] }, {})), ZarrFormatError);
  await assert.rejects(openZarr(v2Store({ dtype: '<i4', fill_value: 'seven' }, {})), ZarrFormatError);
  await assert.rejects(openZarr(memoryStore({ '.zgroup': encoder.encode('{not json') })), /not valid JSON/);
  await assert.rejects(openZarr(memoryStore({ 'x/readme.txt': encoder.encode('x') })), /not a Zarr store/);
  await assert.rejects(openZarr(v2Store({}, {}, { 'a/.zgroup': json({ zarr_format: 2 }) })), /both an array/);
  await assert.rejects(openZarr(v2Store({ dtype: '|O' }, {})), /string codec/);
});

test('a chunk that decodes to the wrong size is refused, never padded or cut', async () => {
  const root = await openZarr(v2Store({}, { 0: new Uint8Array(4), 1: new Uint8Array(12) }));
  await assert.rejects(root.get('a').read(), /decodes to 4 bytes, not the 8/);
});

test('attributes keep 64-bit integers exact and read bare NaN', async () => {
  const root = await openZarr(memoryStore({
    '.zgroup': json({ zarr_format: 2 }),
    '.zattrs': encoder.encode('{"big": 9223372036854775807, "small": -9007199254740993, "nan": NaN, "inf": -Infinity, "f": 1.5e300, "s": "9223372036854775807"}'),
  }));
  assert.equal(root.attrs.big, 9223372036854775807n);
  assert.equal(root.attrs.small, -9007199254740993n);
  assert.ok(Number.isNaN(root.attrs.nan));
  assert.equal(root.attrs.inf, -Infinity);
  assert.equal(root.attrs.f, 1.5e300);
  assert.equal(root.attrs.s, '9223372036854775807');
});

test('implicit parent groups are opened, and keys sort by code point', async () => {
  const root = await openZarr(memoryStore({
    '.zgroup': json({ zarr_format: 2 }),
    'a/b/.zgroup': json({ zarr_format: 2 }),
    'Z/.zgroup': json({ zarr_format: 2 }),
    'é/.zgroup': json({ zarr_format: 2 }),
  }));
  assert.deepEqual([...root.keys()], ['Z', 'a', 'é']);
  assert.equal(root.get('a').kind, 'group');
  assert.deepEqual(root.get('a').attrs, {});
  assert.deepEqual([...root.get('a').keys()], ['b']);
});

test('a web host without consolidated metadata is refused with a plain explanation', async () => {
  const fetch = async url => (new URL(url).pathname.endsWith('/.zgroup')
    ? new Response(JSON.stringify({ zarr_format: 2 }), { status: 200 })
    : new Response(null, { status: 404 }));
  await assert.rejects(openZarr(httpStore('https://example.test/s.zarr', { fetch })), /consolidated metadata/);
});

test('an address with no Zarr store at all says so, not that metadata is unconsolidated', async () => {
  // A wrong path or branch, or GitHub Pages without .nojekyll hiding every dot-file.
  const fetch = async () => new Response(null, { status: 404 });
  await assert.rejects(
    openZarr(httpStore('https://example.test/s.zarr', { fetch })),
    error => /no Zarr store is at this address/.test(error.message) && /\.nojekyll/.test(error.message)
  );
});

test('a store that is one array opens as that array', async () => {
  const store = memoryStore({
    '.zarray': json({ zarr_format: 2, shape: [3], chunks: [3], dtype: '<u1', compressor: null, fill_value: 0, filters: null, order: 'C' }),
    0: Uint8Array.of(4, 5, 6),
  });
  const root = await openZarr(store);
  assert.equal(root.kind, 'array');
  assert.deepEqual(await root.read(), Uint8Array.of(4, 5, 6));
  assert.equal(typeof root.stats, 'function');
});

test('a closed store refuses reads', async () => {
  const root = await openFolder('v2/cases.zarr');
  root.close();
  await assert.rejects(root.get('dtypes/int8').read(), /closed/);
});

test('a read can be aborted', async () => {
  const root = await openHttp('v3/cases.zarr');
  const controller = new AbortController();
  const pending = root.get('codecs/gzip').read(undefined, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  // A later read is not affected.
  assert.equal((await root.get('codecs/gzip').read()).length, 1200);
});

test('storedBytes is the stored size of the chunks a selection touches', async () => {
  const root = await openFolder('v2/cases.zarr');
  const array = root.get('codecs/zstd');
  const sizes = [...await corpusEntries('v2/cases.zarr')]
    .filter(([key]) => key.startsWith('codecs/zstd/') && !key.split('/').at(-1).startsWith('.'))
    .map(([key, bytes]) => [key.slice('codecs/zstd/'.length), bytes.length]);
  const total = sizes.reduce((sum, [, size]) => sum + size, 0);
  assert.equal(await array.storedBytes(), total);
  const first = sizes.find(([name]) => name === '0.0')[1];
  assert.equal(await array.storedBytes([[0, 1], [0, 1]]), first);
  assert.equal(await array.storedBytes([[0, 0]]), 0);
  // Absent chunks cost nothing.
  const fill = root.get('fill/int_fill_7');
  assert.equal(await fill.storedBytes([[3, 10]]), 0);
  // A web host does not know a chunk's size before fetching it; a sharded
  // array's cost comes from its shard index, exactly.
  const remote = await openHttp('v3/cases.zarr');
  assert.equal(await remote.get('codecs/zstd').storedBytes(), null);
  const local = await openFolder('v3/cases.zarr');
  assert.equal(await remote.get('sharding/end_index').storedBytes([[0, 4], [0, 5]]),
    await local.get('sharding/end_index').storedBytes([[0, 4], [0, 5]]));
  assert.ok(await local.get('sharding/end_index').storedBytes([[0, 4], [0, 5]]) > 0);
});

test('activity hears about fetched and decoded chunks', async () => {
  const root = await openHttp('v3/cases.zarr');
  const seen = { bytes: 0, requests: 0, chunks: 0, decodedBytes: 0 };
  const activity = {
    fetched(bytes, requests) { seen.bytes += bytes; seen.requests += requests; },
    decoded(chunks, bytes) { seen.chunks += chunks; seen.decodedBytes += bytes; },
  };
  await root.get('codecs/zstd').read(undefined, { activity });
  assert.equal(seen.requests, 9);
  assert.ok(seen.bytes > 0);
  assert.equal(seen.chunks, 9);
  assert.equal(seen.decodedBytes, 9 * 16 * 12 * 4);
});

test('a folder selection may be File objects with relative paths, or carry Windows separators', async () => {
  const files = [...await corpusFolder('v2/cases.zarr')].map(([relative, blob]) => {
    const file = new File([blob], relative.split('/').pop());
    Object.defineProperty(file, 'webkitRelativePath', { value: relative });
    return file;
  });
  const fromList = await openZarr(directoryStore(files));
  assert.deepEqual(await fromList.get('dtypes/int8').read([[0, 3]]), Int8Array.of(0, 1, -1));
  const windows = new Map([...await corpusFolder('v2/cases.zarr')].map(([relative, blob]) => [relative.replace(/\//g, '\\'), blob]));
  const fromWindows = await openZarr(directoryStore(windows));
  assert.equal(fromWindows.get('dtypes/int8').shape[0], 7);
  assert.throws(() => directoryStore(new Map([['notes/readme.txt', new Blob(['x'])]])), /does not hold a Zarr store/);
});

test('a directory store reports what it fetched', async () => {
  const seen = { bytes: 0, requests: 0 };
  const root = await openFolder('v2/cases.zarr');
  await root.get('codecs/zstd').read(undefined, { activity: { fetched(bytes, requests) { seen.bytes += bytes; seen.requests += requests; } } });
  assert.equal(seen.requests, 9);
  assert.equal(seen.bytes, await root.get('codecs/zstd').storedBytes());
});
