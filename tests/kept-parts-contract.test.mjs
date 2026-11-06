/**
 * The parts of remote files kept in this browser across visits
 * (`assets/js/formats/io/kept-parts.js`), as an opening reads them: through
 * `openDatasetStore` (`data/anndata/open.js`) and the byte reader
 * (`formats/io/byte-reader.js`), over a faked host, with the origin-private
 * file system on disk (`helpers/opfs-on-disk.mjs`).
 *
 * - A later visit (a new store, reader and byte reader, new locks: the page
 *   and its worker anew, the same storage) of the same version fetches no
 *   byte read before: the structure, the embedding, the obs column, the
 *   genes. Whatever the version names (a content name, or a size with a
 *   modification time): one rule.
 * - Opening another version removes what is kept of the old one, every
 *   kind, and reads the new one's bytes.
 * - A damaged kept page is caught by its CRC-32: the batch is removed, the
 *   bytes fetched again, the values exact.
 * - A file that changes on its host while open is refused with the reopen
 *   message, and every kept copy of it is forgotten.
 * - A file with no version keeps nothing; no credential is ever filed.
 * - The listing has one `parts` item per file with what it saves; it is
 *   removed on its own; work under way removes parts first.
 * - The byte reader treats kept bytes as present: none is requested, a
 *   partly kept read fetches only the rest, two ranges are never merged
 *   across kept bytes.
 * - A Zarr store folder on a web host: its objects are kept across visits
 *   only under a version that names its content (the commit its provider
 *   reads it at); a later visit fetches only the metadata; another commit
 *   makes the old objects stale; an object fetched again with another
 *   validator than the one kept with it is refused as changed and every
 *   kept copy forgotten. A folder with no content name keeps nothing
 *   across visits (its metadata's validators do not cover its objects).
 * - Nothing is kept of a source on this machine or a notebook kernel, nor
 *   of a served store; an opening whose version cannot be told removes
 *   nothing kept.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
// The plans asserted here weigh this machine's speed: held at rest (`helpers/machine-at-rest.mjs`).
import './helpers/machine-at-rest.mjs';
import { fileURLToPath } from 'node:url';

import { opfsOnDisk, createLocks } from './helpers/opfs-on-disk.mjs';
import { openDatasetStore } from '../assets/js/data/anndata/open.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import {
  TRANSCODED_DIRECTORY,
  keepDownload,
  openKeptJournal,
  parseKeptJournal,
  keptAtAddress,
  listKeptStores,
  makeRoomForRetry,
  removeKeptStores,
} from '../assets/js/data/anndata/transcode/space.js';
import { writeVersion } from '../assets/js/data/sources/identity.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { bytesByteSource, httpByteSource } from '../assets/js/formats/io/byte-source.js';
import { flushKeptParts, keptPartsOf, withKeptParts } from '../assets/js/formats/io/kept-parts.js';
import { until } from './helpers/until.mjs';
import { zippedStoreEntries } from './helpers/zarr-corpus.mjs';

const FIXTURE = new URL('./fixtures/gene-read/cellxgene-shaped.h5ad', import.meta.url);
const BYTES = new Uint8Array(readFileSync(FIXTURE));
const URL_OF_FILE = 'https://host.test/data/lung.h5ad';
const MODIFIED = 'Tue, 27 Oct 2026 10:00:00 GMT';

/**
 * A host serving `bytes()` with ranges, its ETag `etag()` and Last-Modified
 * date: every request and every byte of every answer counted.
 */
function host(t, { bytes = () => BYTES, etag = () => '"v1"' } = {}) {
  const original = globalThis.fetch;
  const log = { requests: 0, bytes: 0, urls: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (init.signal?.aborted) throw init.signal.reason;
    const range = new Headers(init.headers ?? {}).get('Range');
    const body = bytes();
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    log.requests++;
    log.urls.push(url);
    const headers = { ETag: etag(), 'Last-Modified': MODIFIED, 'Accept-Ranges': 'bytes' };
    if (match === null) {
      log.bytes += body.length;
      return new Response(body.slice(), { status: 200, headers: { ...headers, 'Content-Length': String(body.length) } });
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), body.length - 1);
    log.bytes += end - start + 1;
    return new Response(body.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': String(end - start + 1) },
    });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return log;
}

/** The remote file a link source describes (`describeRemoteFile`), at `version`. */
function remoteFile(version, { url = URL_OF_FILE, key = 'url:lung', size = BYTES.length, name = 'lung.h5ad' } = {}) {
  return { url, size, name, identity: Object.freeze({ kind: 'remote', key, version }) };
}

/** A new visit: the page and its worker are gone, their locks with them. */
function newVisit(disk) {
  disk.environment.navigator.locks = createLocks();
}

/**
 * One opening, as the reader worker makes it: the store opened, the cells,
 * the embedding, the obs column and genes read; the store closed (what it
 * kept completed). Returns the values read.
 */
async function visit(disk, file, { genes = [3, 7], embedding = true, obs = true } = {}) {
  newVisit(disk);
  const opened = await openDatasetStore({ source: { file }, fromLink: true }, {
    decodedChunkCacheBytes: 0,
    transcoding: { environment: disk.environment, tab: 'tab' },
  });
  const reader = new AnnDataReader();
  await reader.open(opened.root, { format: opened.readerFormat, name: opened.name, link: opened.link, decodedBudget: opened.decodedBudget });
  const values = {};
  try {
    if (embedding) values.embedding = plain(await reader.readObsmColumns('X_umap', [0, 1]));
    if (obs) values.obs = plain(await reader.getObsField('cell_type'));
    for (const gene of genes) values[`gene${gene}`] = Array.from(await reader.getMatrixColumn('X', gene));
  } finally {
    reader.close();
  }
  await settled(disk);
  return values;
}

/** A value read, as plain JSON (typed arrays as arrays). */
const plain = value => JSON.stringify(value, (key, item) => (ArrayBuffer.isView(item) ? Array.from(item) : item));

/**
 * Whether no kept journal is being written: each holds its directory's
 * exclusive writing lock (`space.js` `openKeptJournal`) from before its
 * directory is made until it is closed, and only a closed journal is read
 * by the next reader.
 */
const noneWritten = disk => ![...disk.environment.navigator.locks.held.keys()].some(name => name.endsWith('#writing'));

/**
 * Every kept directory complete (a manifest), and none still being written:
 * the closed reader's journal is closed once every write it asked for is
 * made (`flushKeptParts` waits for them, on the disk's own threads), not
 * after a pause.
 */
async function settled(disk) {
  await flushKeptParts();
  await until(() => noneWritten(disk) && directories(disk).every(item => item.manifest !== null), 'the kept parts completed');
}

function directories(disk) {
  const parent = path.join(disk.root, TRANSCODED_DIRECTORY);
  let names;
  try {
    names = readdirSync(parent);
  } catch {
    return [];
  }
  return names.filter(name => statSync(path.join(parent, name)).isDirectory()).map(name => {
    let manifest = null;
    try {
      manifest = JSON.parse(readFileSync(path.join(parent, name, 'manifest.json'), 'utf8'));
    } catch {
      manifest = null;
    }
    return { name, folder: path.join(parent, name), manifest };
  });
}

const partsOf = disk => directories(disk).filter(item => item.manifest?.kind === 'parts');

/** The ranges a kept journal of parts holds (`space.js` `openKeptJournal`): `{key, start, length}` each. */
function journalRanges(folder) {
  const records = new Uint8Array(readFileSync(path.join(folder, 'j.bin')));
  return parseKeptJournal(records, statSync(path.join(folder, 'd.bin')).size).ranges;
}

for (const [label, version] of [
  ['a content name (a census build)', 'census:2025-11-10'],
  ['a size and a modification time', writeVersion({ size: BYTES.length, lastModified: MODIFIED, etag: '"v1"' })],
]) {
  test(`${label}: a later visit fetches no byte read before (structure, embedding, obs column, genes)`, async t => {
    const disk = opfsOnDisk();
    t.after(() => disk.cleanup());
    const log = host(t);
    const first = await visit(disk, remoteFile(version));
    assert.ok(log.bytes > 0, 'the first visit downloads');
    const kept = partsOf(disk);
    assert.ok(kept.length > 0, 'its parts are kept');
    const keptBytes = kept.reduce((sum, { folder }) => sum + journalRanges(folder).reduce((total, range) => total + range.length, 0), 0);
    assert.ok(keptBytes >= log.bytes, `every fetched byte is kept (${keptBytes} of ${log.bytes})`);

    // Something is kept at the file's address (any version): its probe asks only the version.
    assert.equal(await keptAtAddress({ kind: 'remote', key: 'url:lung' }, disk.environment), true);
    assert.equal(await keptAtAddress({ kind: 'remote', key: 'url:other' }, disk.environment), false);

    const before = { ...log };
    const again = await visit(disk, remoteFile(version));
    assert.deepEqual(again, first, 'the same values');
    assert.equal(log.requests - before.requests, 0, 'no request');
    assert.equal(log.bytes - before.bytes, 0, 'no byte downloaded');

    // A third visit reading a gene not read before fetches only that gene's bytes.
    const third = await visit(disk, remoteFile(version), { genes: [3, 11], embedding: false, obs: false });
    assert.deepEqual(third.gene3, first.gene3);
    assert.ok(log.bytes - before.bytes < BYTES.length / 4, 'a new gene fetches only its own bytes');
  });
}

test('opening another version removes every kept copy of the old one and reads the new one', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  let tag = '"v1"';
  const log = host(t, { etag: () => tag });
  const old = writeVersion({ size: BYTES.length, lastModified: MODIFIED, etag: '"v1"' });
  await visit(disk, remoteFile(old));
  const oldDirectories = partsOf(disk).map(item => item.name);
  assert.ok(oldDirectories.length > 0);
  tag = '"v2"';
  const renewed = writeVersion({ size: BYTES.length, lastModified: 'Wed, 28 Oct 2026 10:00:00 GMT', etag: '"v2"' });
  const before = log.bytes;
  await visit(disk, remoteFile(renewed));
  assert.ok(log.bytes - before > 0, 'the new version is downloaded');
  const left = new Set(directories(disk).map(item => item.name));
  assert.deepEqual(oldDirectories.filter(name => left.has(name)), [], 'the old version is removed');
  assert.ok(partsOf(disk).length > 0, 'the new version is kept');
});

test('a damaged kept page is caught: its batch is removed, the bytes fetched again, the values exact', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const log = host(t);
  const version = 'census:1';
  const first = await visit(disk, remoteFile(version));
  for (const { folder } of partsOf(disk)) {
    const file = path.join(folder, 'd.bin');
    const bytes = readFileSync(file);
    for (let at = 0; at < bytes.length; at += 997) bytes[at] ^= 0xff;
    writeFileSync(file, bytes);
  }
  const damaged = new Set(partsOf(disk).map(item => item.name));
  const before = log.bytes;
  const again = await visit(disk, remoteFile(version));
  assert.deepEqual(again, first, 'exact values');
  assert.ok(log.bytes - before > 0, 'the damaged bytes are fetched again');
  const manifests = directories(disk).filter(item => damaged.has(item.name) && item.manifest !== null);
  assert.deepEqual(manifests, [], 'the damaged batches are forgotten');
});

test('a file that changes on its host while open is refused with the reopen message; every kept copy of it, every kind, is forgotten', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  newVisit(disk);
  const large = new Uint8Array(4 << 20).map((_, i) => (i * 7) % 256);
  const rewrittenLarge = new Uint8Array(4 << 20).map((_, i) => (i * 11) % 256);
  let tag = '"v1"';
  host(t, { bytes: () => (tag === '"v1"' ? large : rewrittenLarge), etag: () => tag });
  const file = { ...remoteFile('census:1', { size: large.length }), etag: '"v1"' };
  // Another kind kept of the same file (a download), as an earlier visit leaves it.
  await keepDownload(file.identity, (async function* pieces() { yield large.subarray(0, 1000); })(), { name: file.name, url: file.url, environment: disk.environment });
  const parts = keptPartsOf(file, { environment: disk.environment, tab: 'tab' });
  const reader = createByteReader(withKeptParts(httpByteSource(file), parts));
  assert.deepEqual(await reader.read(0, 1000), large.subarray(0, 1000));
  await parts.flush();
  assert.ok(directories(disk).some(item => item.manifest?.kind === 'parts'), 'what was read is kept');
  // The host now serves another version under the same address, while the file is open.
  tag = '"v2"';
  await assert.rejects(() => reader.read(3 << 20, 1000), /changed on the host while it was open; open it again/);
  await parts.close();
  // Forgotten as the change is found, on the disk's own threads: until it is.
  await until(() => directories(disk).every(item => item.manifest === null), 'every kept copy of the file, every kind, forgotten');
  // Nothing more of it is kept in this reading.
  assert.deepEqual(await reader.read(2 << 20, 10).catch(error => error.code), 'changed');
});

test('a file with no version keeps nothing; no credential is ever filed', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const log = host(t);
  await visit(disk, remoteFile(`size:${BYTES.length}`));
  assert.deepEqual(directories(disk), [], 'nothing kept of a file known by its size alone');
  const before = log.bytes;
  await visit(disk, remoteFile(`size:${BYTES.length}`));
  assert.ok(log.bytes - before > 0, 'read again');

  const signed = `${URL_OF_FILE}?X-Amz-Signature=SECRETSIGNATURE&X-Amz-Credential=SECRETCRED&token=SECRETTOKEN`;
  await visit(disk, remoteFile('census:1', { url: signed, key: `url:${encodeURIComponent(signed)}` }));
  const kept = partsOf(disk);
  assert.ok(kept.length > 0);
  const filed = [];
  const walk = folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      filed.push(entry.name);
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.name.endsWith('.json')) filed.push(readFileSync(target, 'utf8'));
    }
  };
  walk(path.join(disk.root, TRANSCODED_DIRECTORY));
  assert.ok(filed.every(text => !/SECRET/.test(text)), 'no credential in a directory name or a manifest');
  assert.ok(kept.every(({ manifest }) => manifest.about.host === 'host.test' && manifest.about.name === 'lung.h5ad'), 'its name and host, never its link');
});

test('the listing has one parts item per file with what it saves, removable on its own; work under way removes parts first', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const log = host(t);
  await visit(disk, remoteFile('census:1'));
  await visit(disk, remoteFile('census:1', { key: 'url:other', url: 'https://host.test/data/other.h5ad', name: 'other.h5ad' }), { genes: [] });
  newVisit(disk);
  const items = (await listKeptStores(disk.environment)).filter(item => item.kind === 'parts');
  assert.equal(items.length, 2, 'one item per file');
  for (const item of items) {
    assert.ok(item.saves > 0 && item.bytes >= item.saves, `${item.name}: saves ${item.saves} of ${item.bytes}`);
    assert.equal(item.held, 'none');
    assert.equal(item.host, 'host.test');
  }
  assert.ok(items.reduce((sum, item) => sum + item.saves, 0) >= log.bytes, 'together they save what was downloaded');
  const lung = items.find(item => item.name === 'lung.h5ad');
  assert.deepEqual(await removeKeptStores([lung.id], disk.environment), { removed: 1, held: 0 });
  assert.deepEqual((await listKeptStores(disk.environment)).filter(item => item.kind === 'parts').map(item => item.name), ['other.h5ad']);
  // Work under way (a conversion) makes room from the parts, the cheapest to make again.
  assert.ok(await makeRoomForRetry(disk.environment, 1) > 0);
  assert.deepEqual((await listKeptStores(disk.environment)).filter(item => item.kind === 'parts'), []);
});

/** Kept parts that hold `held` (sorted `[start, end)` pairs) of a source, read from `bytes`. */
function keptStub(bytes, held) {
  const touches = (start, end) => held.some(([from, to]) => from < end && to > start);
  const missing = (start, end) => {
    const out = [];
    let at = start;
    for (const [from, to] of held) {
      if (to <= at || from >= end) continue;
      if (from > at) out.push([at, from]);
      at = Math.max(at, to);
    }
    if (at < end) out.push([at, end]);
    return out;
  };
  const reads = [];
  return {
    reads,
    loaded: true,
    ready: Promise.resolve(),
    touches,
    missing,
    async read(offset, length) {
      reads.push([offset, offset + length]);
      return bytes.slice(offset, offset + length);
    },
    bytesToFetch: (start, end) => missing(start, end).reduce((sum, [from, to]) => sum + to - from, 0),
    close: async () => {},
  };
}

test('the byte reader plans around kept bytes: none requested, partly kept reads fetch the rest, no merge across kept bytes', async () => {
  const bytes = new Uint8Array(1 << 20).map((_, i) => i % 251);
  const base = bytesByteSource(bytes, { name: 'f' });
  const requested = [];
  const kept = keptStub(bytes, [[1000, 5000], [10_000, 10_100]]);
  const source = Object.freeze({
    ...base,
    policy: { ...base.policy, mergeGapBytes: 1 << 16, blockBytes: 4096 },
    kept,
    read: async (offset, length, options) => {
      requested.push([offset, offset + length]);
      return base.read(offset, length, options);
    },
  });
  const reader = createByteReader(source);
  // Wholly kept: read from the kept parts, no request.
  assert.deepEqual(await reader.read(1200, 300), bytes.slice(1200, 1500));
  assert.deepEqual(requested, []);
  // Partly kept: only the bytes not kept are requested.
  assert.deepEqual(await reader.read(4000, 2000), bytes.slice(4000, 6000));
  assert.deepEqual(requested, [[5000, 6000]]);
  requested.length = 0;
  // Two reads either side of kept bytes, within the merge gap: never one request across them.
  const [left, right] = await Promise.all([reader.read(9000, 500), reader.read(10_200, 300)]);
  assert.deepEqual(left, bytes.slice(9000, 9500));
  assert.deepEqual(right, bytes.slice(10_200, 10_500));
  assert.ok(requested.every(([start, end]) => end <= 10_000 || start >= 10_100), `no request spans the kept bytes: ${JSON.stringify(requested)}`);
  // A metadata read whose block holds kept bytes is read exactly.
  requested.length = 0;
  await reader.read(5100, 100, { cache: true });
  assert.deepEqual(requested, [[5100, 5200]]);
  // What a range still costs.
  assert.equal(reader.bytesToFetch(0, 12_000), 12_000 - 4000 - 100);
  assert.equal(reader.stats().keptReads >= 2, true);
});

const FOLDER_URL = 'https://host.test/data/lung.zarr/';
const FOLDER_ZIP = fileURLToPath(new URL('./fixtures/gene-read/cellxgene-shaped.zarr.zip', import.meta.url));

/** A web host serving a Zarr store folder: each object with its own ETag (`tagOf(key)`), the metadata with `modified()`. */
async function folderHost(t, { tagOf = key => `"${key}-1"`, modified = () => MODIFIED } = {}) {
  const entries = await zippedStoreEntries(FOLDER_ZIP);
  const original = globalThis.fetch;
  const log = { requests: [], bytes: 0 };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (init.signal?.aborted) throw init.signal.reason;
    const key = decodeURIComponent(url.slice(FOLDER_URL.length));
    log.requests.push(key);
    const body = entries.get(key);
    if (body === undefined) return new Response('not found', { status: 404 });
    const headers = { ETag: tagOf(key), 'Last-Modified': modified(), 'Content-Length': String(body.length) };
    if ((init.method ?? 'GET') === 'HEAD') return new Response(null, { status: 200, headers });
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers ?? {}).get('Range') ?? '');
    if (range !== null) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), body.length - 1);
      log.bytes += end - start + 1;
      return new Response(body.slice(start, end + 1), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': String(end - start + 1) } });
    }
    log.bytes += body.length;
    return new Response(body.slice(), { status: 200, headers });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return log;
}

const COMMIT = `hf:${'a'.repeat(40)}`;

async function folderVisit(disk, { genes = [3, 7], version = COMMIT } = {}) {
  newVisit(disk);
  const source = { url: FOLDER_URL, name: 'lung.zarr', ...(version === null ? {} : { version }) };
  const opened = await openDatasetStore({ source, fromLink: true }, {
    decodedChunkCacheBytes: 0,
    transcoding: { environment: disk.environment, tab: 'tab' },
  });
  const reader = new AnnDataReader();
  await reader.open(opened.root, { format: opened.readerFormat, name: opened.name, link: opened.link, decodedBudget: opened.decodedBudget });
  const values = {};
  try {
    values.embedding = plain(await reader.readObsmColumns('X_umap', [0, 1]));
    for (const gene of genes) values[`gene${gene}`] = Array.from(await reader.getMatrixColumn('X', gene));
  } finally {
    reader.close();
  }
  return { values, opened };
}

/**
 * Wait until every kept batch of the folder is complete: its reader's
 * journal is closed once its reads are quiet (the link's retransmission
 * timeout; a store keeps its journal open past the reader), seen as its
 * writing lock let go. A directory is made only once that lock is held, so
 * one complete directory and no lock is a closed journal, never one not yet
 * begun.
 */
async function folderSettled(disk) {
  await until(() => {
    const all = directories(disk);
    return all.length > 0 && all.every(item => item.manifest !== null) && noneWritten(disk);
  }, 'the kept objects completed');
}

test('a Zarr folder read at a commit: a later visit fetches nothing, its metadata and its absent objects included; another commit makes the old objects stale', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const log = await folderHost(t);
  const first = await folderVisit(disk);
  await folderSettled(disk);
  const kept = partsOf(disk);
  assert.ok(kept.length > 0 && kept.every(({ manifest }) => manifest.size === null), 'kept as a folder of objects');
  const objects = new Set(kept.flatMap(({ folder }) => journalRanges(folder).map(range => range.key)));
  assert.ok(objects.has('X/indices/0') && [...objects].some(key => key.startsWith('obsm/X_umap/')), `its objects are kept: ${[...objects].join(', ')}`);
  // Under a version naming its content (the commit the provider reads it
  // at, asked of the provider at every opening) nothing of it changes: its
  // metadata is kept too, and so is what its host answered as absent.
  assert.ok(objects.has('.zmetadata'), 'its metadata is kept');
  const absent = log.requests.filter(key => !objects.has(key) && key !== '.zmetadata');
  assert.equal(first.opened.identity.kind, 'remote', 'a folder whose provider names its content has a version');

  const before = log.requests.length;
  const again = await folderVisit(disk);
  assert.deepEqual(again.values, first.values);
  assert.deepEqual(log.requests.slice(before), [], `nothing asked of the host (absent before: ${absent.join(', ') || 'none'})`);

  // The store at another commit.
  const oldKept = new Set(kept.map(item => item.name));
  const fresh = log.requests.length;
  await folderVisit(disk, { version: `hf:${'b'.repeat(40)}` });
  assert.ok(log.requests.length - fresh > 1, 'the new version is read');
  assert.deepEqual(directories(disk).filter(item => oldKept.has(item.name) && item.manifest !== null), [], 'the old version is stale');
});

test('a Zarr folder read at a commit: an object its host answered as absent is not asked for again by a later visit', async t => {
  const { httpStore } = await import('../assets/js/formats/zarr/stores/http.js');
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const log = await folderHost(t);
  const identity = Object.freeze({ kind: 'remote', key: 'zarr:lung', version: COMMIT });
  const storeOnce = () => {
    newVisit(disk);
    let parts = null;
    const store = httpStore(FOLDER_URL, {
      name: 'lung.zarr',
      keeping: { open: async () => (parts = keptPartsOf({ url: FOLDER_URL, size: null, name: 'lung.zarr', identity }, { environment: disk.environment, tab: 'tab' })) },
    });
    return { store, close: () => parts?.close() };
  };
  const first = storeOnce();
  assert.ok(await first.store.get('.zmetadata') !== null);
  // A chunk the writer left out (every value its fill value): the host answers 404.
  assert.equal(await first.store.get('X/data/99'), null);
  await first.close();
  const before = log.requests.length;
  const later = storeOnce();
  assert.ok(await later.store.get('.zmetadata') !== null);
  assert.equal(await later.store.get('X/data/99'), null, 'still absent');
  assert.deepEqual(log.requests.slice(before), [], 'neither its metadata nor the absent chunk is asked of the host again');
  await later.close();
});

test('a Zarr folder object fetched again with another validator is refused as changed; every kept copy is forgotten', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  let generation = 1;
  await folderHost(t, { tagOf: key => `"${key}-${key === 'X/indices/0' ? generation : 1}"` });
  await folderVisit(disk);
  await folderSettled(disk);
  // The kept copy of one chunk is damaged (it is fetched again), and the
  // host has rewritten that chunk without touching the store's metadata.
  for (const { folder } of partsOf(disk)) {
    const file = path.join(folder, 'd.bin');
    const bytes = readFileSync(file);
    for (let at = 0; at < bytes.length; at += 512) bytes[at] ^= 0xff;
    writeFileSync(file, bytes);
  }
  generation = 2;
  await assert.rejects(() => folderVisit(disk), /changed on the host while it was open/);
  await until(() => directories(disk).every(item => item.manifest === null), 'every kept copy of the store forgotten');
});

test('a Zarr folder whose content no version names keeps nothing across visits', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  const log = await folderHost(t);
  const first = await folderVisit(disk, { version: null });
  assert.equal(first.opened.identity.kind, 'url', 'known for this opening only');
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.deepEqual(partsOf(disk), [], 'nothing kept');
  const before = log.requests.length;
  await folderVisit(disk, { version: null });
  assert.ok(log.requests.length - before > 1, 'read again');
});

test('nothing is kept of a source on this machine, a notebook kernel or a served store; a versionless opening removes nothing', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  host(t);
  for (const url of ['http://127.0.0.1:8765/datasets/lung.h5ad', 'http://localhost:8765/lung.h5ad', 'http://[::1]:8765/lung.h5ad']) {
    await visit(disk, remoteFile('census:1', { url }), { genes: [3] });
  }
  // A notebook kernel's files (read through the page that embeds the viewer).
  assert.equal(keptPartsOf(remoteFile('census:1', { url: 'https://host.cellucid.invalid/lung.h5ad' }), { environment: disk.environment }), null);
  await visit(disk, { ...remoteFile('"served-1"'), keptParts: false }, { genes: [3] });
  assert.deepEqual(partsOf(disk), []);
  // Kept under a version, then opened where the version cannot be told (a
  // provider that could not be asked): nothing kept is used, none removed.
  await visit(disk, remoteFile('census:1'));
  const kept = partsOf(disk).map(item => item.name);
  assert.ok(kept.length > 0);
  await visit(disk, remoteFile(`size:${BYTES.length}`));
  assert.deepEqual(partsOf(disk).map(item => item.name).filter(name => kept.includes(name)).sort(), kept.sort());
});

test('a file whose earlier visits kept a hundred thousand ranges opens again in a moment, every range found and exact', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  newVisit(disk);
  const size = 4e9;
  const file = { url: 'https://host.test/data/atlas.h5ad', size, name: 'atlas.h5ad', identity: Object.freeze({ kind: 'remote', key: 'url:atlas', version: 'census:1' }) };
  // Earlier visits' journals, as readers write them: 100,000 ranges of 256
  // bytes in 25 journals, in no order (the order reads fetched them).
  const journals = 25;
  const perJournal = 4000;
  let state = 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  const piece = start => Uint8Array.from({ length: 256 }, (_, i) => (start / 4096 + i) % 251);
  const starts = new Set();
  for (let j = 0; j < journals; j++) {
    const journal = await openKeptJournal({ parts: file.identity, size }, { environment: disk.environment, tab: 'tab', manifest: { kind: 'parts', size } });
    for (let i = 0; i < perJournal; i++) {
      let start;
      do start = (next() % (size / 4096)) * 4096; while (starts.has(start));
      starts.add(start);
      await journal.appendRange('', start, piece(start));
    }
    journal.close();
    journal.release();
  }
  newVisit(disk);
  // Inserted one by one into one sorted array (each a shift of every range
  // after it), this took minutes: found and ordered at once shifts next to none.
  let shifted = 0;
  const splice = Array.prototype.splice;
  // eslint-disable-next-line no-extend-native
  Array.prototype.splice = function counted(start, ...rest) {
    shifted += Math.max(0, this.length - start);
    return splice.call(this, start, ...rest);
  };
  const parts = keptPartsOf(file, { environment: disk.environment, tab: 'tab' });
  try {
    await parts.open();
  } finally {
    // eslint-disable-next-line no-extend-native
    Array.prototype.splice = splice;
  }
  assert.equal(parts.keptBytes(), journals * perJournal * 256, 'every range is found');
  assert.ok(shifted < journals * perJournal, `opening shifted ${shifted} ranges`);
  const sorted = [...starts].sort((a, b) => a - b);
  for (const start of [sorted[0], sorted[777], sorted.at(-1)]) {
    assert.deepEqual(await parts.read(start, 256), piece(start));
    assert.deepEqual(parts.missing(start - 10, start + 266), [[start - 10, start], [start + 256, start + 266]]);
  }
  await parts.close();
});

/**
 * The bytes a kept download and a file's kept parts are stored as, for
 * fixed inputs: their manifests (what changes with every write left out:
 * when, and the directory's random name) and every file they write. Any
 * change of these bytes is a change of what is kept: raise
 * `KEPT_BYTES_REVISION` (`transcode/space.js`), and pin the new revision
 * with its digest here. A release that does not change them keeps every
 * download and every part kept before it.
 */
const KEPT_BYTES_GOLDEN = [
  // Revision 2 (not yet released): parts kept as a journal (`space.js` `openKeptJournal`).
  { revision: 2, digest: 'd749b997afb2fb95f759d1f338bceaf95c07a38557a4ddd84e298bf4b23d36e5' },
];

test('the kept raw bytes revision is raised whenever what they are stored as changes', async t => {
  const { createHash } = await import('node:crypto');
  const { KEPT_BYTES_REVISION } = await import('../assets/js/data/anndata/transcode/space.js');
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  newVisit(disk);
  const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 31 + 7) % 251);
  const identity = { kind: 'remote', key: 'golden:file', version: 'census:golden' };
  // A download, and the parts of a file read in place (three ranges, two of them adjacent).
  await keepDownload(identity, (async function* pieces() { yield bytes.subarray(0, 40_000); yield bytes.subarray(40_000); })(), { name: 'golden.h5ad', url: 'https://host.test/golden.h5ad', environment: disk.environment });
  const parts = keptPartsOf({ url: 'https://host.test/golden.h5ad', size: bytes.length, name: 'golden.h5ad', identity }, { environment: disk.environment, tab: 'tab' });
  await parts.open();
  parts.keep(100, bytes.subarray(100, 20_100));
  parts.keep(20_100, bytes.subarray(20_100, 30_000));
  parts.keep(50_000, bytes.subarray(50_000, 70_000));
  await parts.close();
  const hash = createHash('sha256');
  for (const { manifest, folder } of directories(disk).sort((a, b) => (a.manifest?.kind < b.manifest?.kind ? -1 : 1))) {
    const { createdAt: _createdAt, ...stable } = manifest;
    hash.update(JSON.stringify(stable));
    for (const name of readdirSync(folder).filter(entry => entry !== 'manifest.json' && entry !== 'used').sort()) {
      hash.update(name);
      hash.update(readFileSync(path.join(folder, name)));
    }
  }
  const digest = hash.digest('hex');
  assert.deepEqual({ revision: KEPT_BYTES_REVISION, digest }, KEPT_BYTES_GOLDEN.at(-1),
    'What kept downloads and parts are stored as changed: raise KEPT_BYTES_REVISION in assets/js/data/anndata/transcode/space.js ' +
    '(kept bytes of the earlier revision are then removed, not read), and add a row with the new revision and digest here.');
});

test('reading the open dataset again keeps what is shown only for the same version; a file with no version is the same bytes within its opening only', async t => {
  await import('./helpers/anndata-reader-in-process.mjs');
  const { AnnDataFileSource } = await import('../assets/js/data/anndata-file-source.js');
  const log = host(t);
  const opened = async (file, t2) => {
    const source = new AnnDataFileSource();
    t2.after(() => source._loader?.close());
    await source.loadFile(file);
    return source;
  };
  const sub = k => ({ mode: 'subsample', method: 'blocks', k, seed: 0, blockSize: 10 });

  // A file known by its size alone, read again with more cells within its
  // opening: its store is taken over (no structure read again), and the
  // cells shown stay shown.
  const sized = await opened({ ...remoteFile(`size:${BYTES.length}`) }, t);
  await sized.reopenCells({ cellSubset: sub(100) });
  const before = log.requests;
  const grown = await sized.reopenCells({ cellSubset: sub(200) });
  assert.equal(sized._loader.sameVersion, true, 'the same opening: the same bytes');
  assert.deepEqual(grown.resized, { from: 100, to: 200 }, 'grown in place');
  assert.ok(log.requests - before < 10, `no structure read again (${log.requests - before} requests)`);

  // Its reader worker ended and started again (a page restored from the
  // back/forward cache): the bytes can no longer be told to be the ones
  // shown, so the cells are read anew, not kept beside new values.
  sized._loader._suspend();
  const revived = await sized.reopenCells({ cellSubset: sub(300) });
  assert.equal(sized._loader.sameVersion, false, 'another opening of a file with no version');
  assert.equal(revived.resized, null, 'read anew');
  assert.equal(revived.reordered, false);
});
