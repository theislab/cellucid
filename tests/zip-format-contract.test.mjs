/**
 * The ZIP reader (assets/js/formats/zip): lazy, ranged, parallel reading of
 * entries through a byte reader, and every safety check of an archive that
 * may be damaged or hostile.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import {
  ZipFormatError,
  ZipUnsupportedError,
  crc32,
  entryMap,
  openZipArchive,
  singleRootFolder,
} from '../assets/js/formats/zip/index.js';
import { openZarr, zipStore } from '../assets/js/formats/zarr/index.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function asBytes(value) {
  return typeof value === 'string' ? encoder.encode(value) : value;
}

function u16(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset).setUint16(offset, value, true);
}
function u32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(offset, value >>> 0, true);
}
function u64(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset).setBigUint64(offset, BigInt(value), true);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Build an archive. Each entry: {name, content, method, flags, localName,
 * localExtra, centralExtra, crc, declaredSize, declaredCompressedSize,
 * externalAttributes, versionMadeBy, nameBytes}.
 */
function buildZip(entries, { comment = '', eocdDisk = 0, prefix = new Uint8Array(0) } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dataOffsets = [];
  for (const entry of entries) {
    const nameBytes = entry.nameBytes ?? encoder.encode(entry.name);
    const localName = entry.localName === undefined ? nameBytes : encoder.encode(entry.localName);
    const content = asBytes(entry.content ?? '');
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0x0800;
    const compressed = entry.compressed ?? (method === 8 ? new Uint8Array(deflateRawSync(content)) : content);
    const checksum = entry.crc ?? crc32(content);
    const compressedSize = entry.declaredCompressedSize ?? compressed.length;
    const size = entry.declaredSize ?? content.length;
    const localExtra = entry.localExtra ?? new Uint8Array(0);
    const centralExtra = entry.centralExtra ?? new Uint8Array(0);
    const descriptor = (flags & 0x0008) !== 0;

    const local = new Uint8Array(30 + localName.length + localExtra.length);
    u32(local, 0, 0x04034b50);
    u16(local, 4, 20);
    u16(local, 6, flags);
    u16(local, 8, method);
    u32(local, 14, descriptor ? 0 : checksum);
    u32(local, 18, descriptor ? 0 : compressedSize);
    u32(local, 22, descriptor ? 0 : size);
    u16(local, 26, localName.length);
    u16(local, 28, localExtra.length);
    local.set(localName, 30);
    local.set(localExtra, 30 + localName.length);
    const parts = [local, compressed];
    if (descriptor) {
      const tail = new Uint8Array(16);
      u32(tail, 0, 0x08074b50);
      u32(tail, 4, checksum);
      u32(tail, 8, compressedSize);
      u32(tail, 12, size);
      parts.push(tail);
    }
    locals.push(...parts);
    dataOffsets.push(prefix.length + offset + local.length);

    const central = new Uint8Array(46 + nameBytes.length + centralExtra.length);
    u32(central, 0, 0x02014b50);
    u16(central, 4, entry.versionMadeBy ?? 0x0314);
    u16(central, 6, 20);
    u16(central, 8, flags);
    u16(central, 10, method);
    u32(central, 16, checksum);
    u32(central, 20, compressedSize);
    u32(central, 24, size);
    u16(central, 28, nameBytes.length);
    u16(central, 30, centralExtra.length);
    u32(central, 38, entry.externalAttributes ?? 0o100644 << 16);
    u32(central, 42, offset);
    central.set(nameBytes, 46);
    central.set(centralExtra, 46 + nameBytes.length);
    centrals.push(central);
    offset += parts.reduce((sum, part) => sum + part.length, 0);
  }
  const localBytes = concat(locals);
  const centralBytes = concat(centrals);
  const commentBytes = encoder.encode(comment);
  const end = new Uint8Array(22 + commentBytes.length);
  u32(end, 0, 0x06054b50);
  u16(end, 4, eocdDisk);
  u16(end, 8, entries.length);
  u16(end, 10, entries.length);
  u32(end, 12, centralBytes.length);
  u32(end, 16, localBytes.length);
  u16(end, 20, commentBytes.length);
  end.set(commentBytes, 22);
  return { bytes: concat([prefix, localBytes, centralBytes, end]), dataOffsets };
}

/** A one-entry ZIP64 archive (sizes and offsets in the ZIP64 extra fields and end record). */
function buildZip64(name, content) {
  const nameBytes = encoder.encode(name);
  const payload = asBytes(content);
  const checksum = crc32(payload);
  const localExtra = new Uint8Array(20);
  u16(localExtra, 0, 1);
  u16(localExtra, 2, 16);
  u64(localExtra, 4, payload.length);
  u64(localExtra, 12, payload.length);
  const local = new Uint8Array(30 + nameBytes.length + localExtra.length);
  u32(local, 0, 0x04034b50);
  u16(local, 4, 45);
  u16(local, 6, 0x0800);
  u32(local, 14, checksum);
  u32(local, 18, 0xffffffff);
  u32(local, 22, 0xffffffff);
  u16(local, 26, nameBytes.length);
  u16(local, 28, localExtra.length);
  local.set(nameBytes, 30);
  local.set(localExtra, 30 + nameBytes.length);
  const localBytes = concat([local, payload]);
  const centralExtra = new Uint8Array(28);
  u16(centralExtra, 0, 1);
  u16(centralExtra, 2, 24);
  u64(centralExtra, 4, payload.length);
  u64(centralExtra, 12, payload.length);
  u64(centralExtra, 20, 0);
  const central = new Uint8Array(46 + nameBytes.length + centralExtra.length);
  u32(central, 0, 0x02014b50);
  u16(central, 4, 0x032d);
  u16(central, 6, 45);
  u16(central, 8, 0x0800);
  u32(central, 16, checksum);
  u32(central, 20, 0xffffffff);
  u32(central, 24, 0xffffffff);
  u16(central, 28, nameBytes.length);
  u16(central, 30, centralExtra.length);
  u32(central, 42, 0xffffffff);
  central.set(nameBytes, 46);
  central.set(centralExtra, 46 + nameBytes.length);
  const zip64End = new Uint8Array(56);
  u32(zip64End, 0, 0x06064b50);
  u64(zip64End, 4, 44);
  u16(zip64End, 12, 45);
  u16(zip64End, 14, 45);
  u64(zip64End, 24, 1);
  u64(zip64End, 32, 1);
  u64(zip64End, 40, central.length);
  u64(zip64End, 48, localBytes.length);
  const locator = new Uint8Array(20);
  u32(locator, 0, 0x07064b50);
  u64(locator, 8, localBytes.length + central.length);
  u32(locator, 16, 1);
  const end = new Uint8Array(22);
  u32(end, 0, 0x06054b50);
  u16(end, 8, 0xffff);
  u16(end, 10, 0xffff);
  u32(end, 12, 0xffffffff);
  u32(end, 16, 0xffffffff);
  return concat([localBytes, central, zip64End, locator, end]);
}

/** A memory source that records every request the byte reader makes. */
function recorded(bytes, policy = {}) {
  const base = bytesByteSource(bytes, { name: 'test.zip', policy });
  const calls = [];
  const source = {
    ...base,
    calls,
    async read(offset, length, options) {
      calls.push([offset, length]);
      return base.read(offset, length, options);
    },
  };
  return source;
}

async function open(bytes, options) {
  return openZipArchive(createByteReader(bytesByteSource(bytes, { name: 'test.zip' })), options);
}

const text = bytes => decoder.decode(bytes);

test('lists entries and reads stored and deflated entries, checked', async () => {
  const big = new Uint8Array(100_000).map((_, i) => (i * 7) & 0xff);
  const { bytes } = buildZip([
    { name: 'pbmc.zarr/', content: '' },
    { name: 'pbmc.zarr/.zgroup', content: '{"zarr_format":2}' },
    { name: 'pbmc.zarr/X/0.0', content: big, method: 8 },
  ], { comment: 'a false footer PK\u0005\u0006 inside the comment' });
  const archive = await open(bytes);
  assert.deepEqual(archive.entries.map(entry => entry.path), ['pbmc.zarr/.zgroup', 'pbmc.zarr/X/0.0']);
  assert.equal(archive.comment, 'a false footer PK\u0005\u0006 inside the comment');
  const chunk = archive.entry('pbmc.zarr/X/0.0');
  assert.equal(chunk.size, 100_000);
  assert.equal(chunk.method, 8);
  assert.ok(chunk.compressedSize < chunk.size);
  assert.deepEqual(await chunk.read(), big);
  assert.equal(text(await archive.entry('pbmc.zarr/.zgroup').read()), '{"zarr_format":2}');
  assert.equal(archive.entry('pbmc.zarr/absent'), null);
});

test('opening reads only the end of the file; entries are read when asked for', async () => {
  const { bytes } = buildZip(Array.from({ length: 40 }, (_, i) => ({ name: `s.zarr/c/${i}`, content: new Uint8Array(20_000).fill(i) })));
  const source = recorded(bytes);
  const archive = await openZipArchive(createByteReader(source));
  assert.equal(source.calls.length, 1, 'one read: the tail, holding the central directory');
  assert.equal(source.calls[0][0] + source.calls[0][1], bytes.length);
  assert.equal(archive.entries.length, 40);
  assert.equal(source.calls.length, 1, 'listing reads nothing');
});

/** Stored bytes after the entries under test, so they lie before the end an archive's opening reads (and serves entries from). */
const TAIL_FILLER = { name: 'zz/filler', content: new Uint8Array(300 * 1024) };

test('each entry is one range (header and data together); entries read together are merged', async () => {
  const { bytes } = buildZip([...Array.from({ length: 30 }, (_, i) => ({ name: `c/${i}`, content: new Uint8Array(3000).fill(i) })), TAIL_FILLER]);
  const source = recorded(bytes, { mergeGapBytes: 64 * 1024, maxRequestBytes: 8 * 1024 * 1024 });
  const archive = await openZipArchive(createByteReader(source));
  source.calls.length = 0;
  const one = await archive.entry('c/5').read();
  assert.equal(one[0], 5);
  assert.equal(source.calls.length, 1, 'a single entry is one request');
  source.calls.length = 0;
  const all = await Promise.all(archive.entries.filter(entry => entry.path.startsWith('c/')).map(entry => entry.read()));
  all.forEach((value, i) => assert.equal(value[2999], i));
  assert.equal(source.calls.length, 1, 'thirty neighbouring entries are one merged request');
  source.calls.length = 0;
  // Far apart entries go out in parallel, not one after another.
  const { bytes: apart } = buildZip([...Array.from({ length: 30 }, (_, i) => ({ name: `c/${i}`, content: new Uint8Array(100_000).fill(i) })), TAIL_FILLER]);
  const sparse = recorded(apart, { mergeGapBytes: 0, maxRequestBytes: 8 * 1024 * 1024, concurrency: 8 });
  const sparseArchive = await openZipArchive(createByteReader(sparse));
  sparse.calls.length = 0;
  await Promise.all([0, 10, 20].map(i => sparseArchive.entry(`c/${i}`).read()));
  assert.equal(sparse.calls.length, 3);
});

test('an archive no longer than the end read at open is read once; entries in that end cost no request', async () => {
  const { bytes } = buildZip(Array.from({ length: 30 }, (_, i) => ({ name: `c/${i}`, content: new Uint8Array(3000).fill(i) })));
  const source = recorded(bytes);
  const archive = await openZipArchive(createByteReader(source));
  const all = await Promise.all(archive.entries.map(entry => entry.read()));
  all.forEach((value, i) => assert.equal(value[2999], i));
  assert.equal(await archive.entry('c/7').readRange(10, 5).then(range => range[0]), 7);
  assert.deepEqual(source.calls, [[0, bytes.length]]);
});

test('a local extra field longer than the central one costs one more read, and still reads right', async () => {
  const { bytes } = buildZip([
    { name: 'a', content: 'first entry', localExtra: new Uint8Array(300).fill(0x41).map((v, i) => (i < 4 ? [0xca, 0xfe, 0x28, 0x01][i] : v)) },
    { name: 'b', content: 'second entry' },
  ]);
  const archive = await open(bytes);
  assert.equal(text(await archive.entry('a').read()), 'first entry');
  assert.equal(text(await archive.entry('b').read()), 'second entry');
  assert.equal(text(await archive.entry('a').readRange(6, 5)), 'entry');
});

test('ranges of a stored entry read only those bytes; of a deflated entry, the whole entry once', async () => {
  const content = new Uint8Array(50_000).map((_, i) => i & 0xff);
  const { bytes } = buildZip([
    { name: 'stored', content },
    { name: 'deflated', content, method: 8 },
  ]);
  const source = recorded(bytes, { mergeGapBytes: 0 });
  const archive = await openZipArchive(createByteReader(source));
  source.calls.length = 0;
  const part = await archive.entry('stored').readRange(40_000, 100);
  assert.deepEqual(part, content.subarray(40_000, 40_100));
  assert.ok(source.calls.every(([, length]) => length < 1000), 'no read of the whole entry');
  assert.deepEqual(await archive.entry('deflated').readRange(10, 5), content.subarray(10, 15));
  await assert.rejects(archive.entry('stored').readRange(49_999, 2), RangeError);
});

test('ZIP64 archives, data descriptors and bytes before the archive are read', async () => {
  const zip64 = await open(buildZip64('zip64.zarr/.zgroup', '{"zarr_format":2}'));
  assert.equal(text(await zip64.entry('zip64.zarr/.zgroup').read()), '{"zarr_format":2}');

  const described = await open(buildZip([{ name: 'd', content: 'streamed', method: 8, flags: 0x0808 }]).bytes);
  assert.equal(text(await described.entry('d').read()), 'streamed');

  const prefixed = await open(buildZip([{ name: 'p', content: 'after a stub' }], { prefix: encoder.encode('#!/bin/sh\nexit 0\n') }).bytes);
  assert.equal(text(await prefixed.entry('p').read()), 'after a stub');

  // An archive held in a view into a larger buffer reads from the view's bytes only.
  const { bytes } = buildZip([{ name: 'v.zarr/.zgroup', content: '{"zarr_format":2}' }]);
  const padded = new Uint8Array(bytes.length + 11).fill(0x50);
  padded.set(bytes, 7);
  const viewed = await open(padded.subarray(7, 7 + bytes.length));
  assert.equal(text(await viewed.entry('v.zarr/.zgroup').read()), '{"zarr_format":2}');
});

test('names: UTF-8 with or without the flag, code page 437 otherwise, NFC-normalised', async () => {
  const archive = await open(buildZip([
    { name: 'café', content: '1', flags: 0 },
    { name: 'x', nameBytes: Uint8Array.of(0x82, 0x2e, 0x74), content: '2', flags: 0 },
    { name: 'cafe\u0301/a', content: '3' },
  ]).bytes);
  assert.deepEqual(archive.entries.map(entry => entry.path), ['café', 'é.t', 'café/a']);
  const marked = buildZip([{ name: 'x', nameBytes: Uint8Array.of(0xff, 0xfe), content: '', flags: 0x0800 }]).bytes;
  await assert.rejects(open(marked), /marked UTF-8/);
});

test('entry maps address a zipped folder by paths inside it, without macOS metadata', async () => {
  const archive = await open(buildZip([
    { name: '.DS_Store', content: 'finder' },
    { name: 'experiment.zarr/.zgroup', content: '{"zarr_format":2}' },
    { name: 'experiment.zarr/.DS_Store', content: 'finder' },
    { name: '__MACOSX/experiment.zarr/._.zgroup', content: 'fork' },
    { name: 'experiment.zarr/x/.zarray', content: '{}' },
  ]).bytes);
  assert.equal(singleRootFolder(archive), 'experiment.zarr');
  assert.deepEqual([...entryMap(archive, 'experiment.zarr/').keys()], ['.zgroup', 'x/.zarray']);
  const store = zipStore(archive);
  assert.equal(store.name, 'experiment.zarr');
  assert.deepEqual(store.list(), ['.zgroup', 'x/.zarray']);
  const rootless = zipStore(await open(buildZip([{ name: '.zgroup', content: '{"zarr_format":2}' }]).bytes));
  assert.deepEqual(rootless.list(), ['.zgroup']);
  assert.equal(rootless.name, 'test');
});

test('an archive that holds no Zarr store is refused in plain words', async () => {
  const archive = await open(buildZip([{ name: 'notes/readme.txt', content: 'hello' }]).bytes);
  assert.throws(() => zipStore(archive), /does not hold a Zarr store/);
  const two = await open(buildZip([{ name: 'a.zarr/.zgroup', content: '{}' }, { name: 'b.zarr/.zgroup', content: '{}' }]).bytes);
  assert.throws(() => zipStore(two), /does not hold a Zarr store/);
});

test('a Zarr store opens from an archive', async () => {
  const meta = JSON.stringify({ zarr_format: 2, shape: [2], chunks: [2], dtype: '<f4', compressor: null, fill_value: 0, filters: null, order: 'C' });
  const archive = await open(buildZip([
    { name: 'tiny.zarr/.zgroup', content: '{"zarr_format":2}' },
    { name: 'tiny.zarr/v/.zarray', content: meta, method: 8 },
    { name: 'tiny.zarr/v/0', content: new Uint8Array(Float32Array.of(3.5, -1).buffer) },
  ]).bytes);
  const root = await openZarr(zipStore(archive));
  assert.deepEqual(await root.get('v').read(), Float32Array.of(3.5, -1));
});

for (const [label, name] of [
  ['parent traversal', 'bad.zarr/../escape'],
  ['absolute path', '/bad.zarr/.zgroup'],
  ['drive path', 'C:/bad.zarr/.zgroup'],
  ['backslash path', 'bad.zarr\\..\\.zgroup'],
  ['empty segment', 'bad.zarr//.zgroup'],
  ['control character', 'bad\u0001.zarr/.zgroup'],
]) {
  test(`refuses an archive with a ${label}`, async () => {
    await assert.rejects(open(buildZip([{ name, content: '{}' }]).bytes), /unsafe entry path/);
  });
}

test('refuses duplicates, overlaps, encryption, other methods, links, several disks and impossible sizes', async () => {
  const refuse = async (entries, pattern, Type = ZipFormatError, options) => {
    await assert.rejects(open(buildZip(entries, options).bytes), error => error instanceof Type && pattern.test(error.message));
  };
  await refuse([{ name: 'd/.zgroup', content: '{}' }, { name: 'd/.zgroup', content: '{}' }], /two entries named/);
  await refuse([{ name: 'e', content: '{}', flags: 0x0801 }], /encrypted/, ZipUnsupportedError);
  await refuse([{ name: 'm', content: '{}', method: 12 }], /compression method 12/, ZipUnsupportedError);
  await refuse([{ name: 'l', content: 'target', externalAttributes: 0o120777 << 16 }], /symbolic link/, ZipUnsupportedError);
  await refuse([{ name: 'k', content: '{}' }], /several files/, ZipUnsupportedError, { eocdDisk: 1 });
  await refuse([{ name: 's', content: '{}', declaredSize: 100 }], /two different sizes/);
  await refuse([{ name: 'b', content: 'x', method: 8, declaredSize: 100 * 1024 * 1024 }], /more than DEFLATE can produce/);
  await refuse([{ name: 'big', content: 'x', declaredSize: 10_000, declaredCompressedSize: 10_000 }], /more bytes than the archive holds/);

  // Two central records pointing into the same bytes.
  const { bytes } = buildZip([{ name: 'a', content: 'aaaaaaaaaa' }, { name: 'b', content: 'bbbbbbbbbb' }]);
  const view = new DataView(bytes.buffer);
  const central = bytes.length - 22 - (46 + 1) * 2;
  view.setUint32(central + 46 + 1 + 42, 5, true);
  await assert.rejects(open(bytes), /overlap/);
});

test('an entry is checked before its bytes are returned', async () => {
  const mismatch = await open(buildZip([{ name: 'safe', localName: 'evil', content: '{}' }]).bytes);
  await assert.rejects(mismatch.entry('safe').read(), /local header name/);

  const damaged = buildZip([{ name: 'c', content: '{"zarr_format":2}' }]);
  damaged.bytes[damaged.dataOffsets[0]] ^= 0xff;
  await assert.rejects((await open(damaged.bytes)).entry('c').read(), /CRC-32/);
  // With checking turned off, the bytes are returned as stored.
  const unchecked = await open(damaged.bytes, { verifyCrc: false });
  assert.equal((await unchecked.entry('c').read()).length, 17);

  const sizes = buildZip([{ name: 'z', content: 'abcdef' }]);
  new DataView(sizes.bytes.buffer).setUint32(22, 5, true); // local uncompressed size
  await assert.rejects((await open(sizes.bytes)).entry('z').read(), /contradicts the central directory/);
});

test('a DEFLATE stream that inflates past its declared size is stopped there', async () => {
  const content = new Uint8Array(1_000_000);
  const compressed = new Uint8Array(deflateRawSync(content));
  const archive = await open(buildZip([{ name: 'bomb', content, compressed, method: 8, declaredSize: 1000, crc: crc32(content.subarray(0, 1000)) }]).bytes);
  await assert.rejects(archive.entry('bomb').read(), error => error instanceof ZipFormatError && /more than the 1000 bytes/.test(error.message));
  const short = await open(buildZip([{ name: 'short', content: 'abc', method: 8, declaredSize: 4, crc: 0 }]).bytes);
  await assert.rejects(short.entry('short').read(), /decompresses to 3 bytes, not the 4/);
});

test('a browser without DecompressionStream gets a plain explanation for deflated entries', async () => {
  const archive = await open(buildZip([{ name: 'd', content: 'x', method: 8 }]).bytes);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'DecompressionStream');
  Object.defineProperty(globalThis, 'DecompressionStream', { value: undefined, configurable: true, writable: true });
  try {
    await assert.rejects(archive.entry('d').read(), /cannot decompress.*current browser/);
  } finally {
    Object.defineProperty(globalThis, 'DecompressionStream', descriptor);
  }
});

test('not a ZIP archive', async () => {
  await assert.rejects(open(encoder.encode('short')), /too short/);
  await assert.rejects(open(new Uint8Array(1000)), /not a ZIP archive/);
});

test('CRC-32 matches the reference values', () => {
  assert.equal(crc32(encoder.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  const data = new Uint8Array(1001).map((_, i) => (i * 31) & 0xff);
  assert.equal(crc32(data.subarray(500), crc32(data.subarray(0, 500))), crc32(data));
});

test('signal and activity reach every read of the byte reader, through the archive and a Zarr store', async () => {
  const meta = JSON.stringify({ zarr_format: 2, shape: [4], chunks: [2], dtype: '<u1', compressor: null, fill_value: 0, filters: null, order: 'C' });
  const { bytes } = buildZip([
    { name: '.zgroup', content: '{"zarr_format":2}' },
    { name: 'a/.zarray', content: meta },
    { name: 'a/0', content: Uint8Array.of(1, 2) },
    { name: 'a/1', content: Uint8Array.of(3, 4) },
    TAIL_FILLER,
  ]);
  const inner = createByteReader(bytesByteSource(bytes, { name: 'test.zip' }));
  const seen = [];
  const reader = { ...inner, read: (offset, length, options = {}) => { seen.push(options); return inner.read(offset, length, options); } };
  const activity = { fetched() {}, planned() {} };
  const signal = new AbortController().signal;
  const archive = await openZipArchive(reader, { activity, signal });
  const root = await openZarr(zipStore(archive), { activity, signal });
  assert.deepEqual(await root.get('a').read(undefined, { activity, signal }), Uint8Array.of(1, 2, 3, 4));
  await archive.entry('a/0').readRange(0, 1, { activity, signal });
  assert.ok(seen.length >= 4);
  for (const options of seen) {
    assert.equal(options.activity, activity);
    assert.equal(options.signal, signal);
  }
});
