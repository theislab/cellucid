/**
 * What a file that cannot be read in parts leaves in this browser, across
 * visits (`data/anndata/transcode/space.js`, `session.js`), with the
 * origin-private file system and Web Locks a worker has (on disk here,
 * `helpers/opfs-on-disk.mjs`):
 *
 * - a store is filed under its source's identity; one whose identity names
 *   its version (a local file's modification time, a remote file's ETag or
 *   provider revision) is kept for later visits: the start-up sweep leaves
 *   it, and a later visit opens it without reading the file; one known only
 *   by its size (a host that reports no version) is kept for the tab only;
 * - a kept store is checked before it is opened: its revision, its full
 *   identity and every file it lists at its size; one that fails is removed
 *   and the file is read again;
 * - room is made under the browser's real quota, least recently opened
 *   first, never removing a store a tab holds; `clearKeptStores` removes
 *   every store no tab holds;
 * - a file a host serves only whole is kept as it arrives, never gathered
 *   in memory, found again by its identity, and removed once a store made
 *   from it is kept;
 * - the revision is raised whenever the transcoders change
 *   (`KEPT_STORE_REVISION`, pinned below with a digest of their sources).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { TRANSCODERS } from '../assets/js/data/anndata/transcode/index.js';
import {
  KEPT_STORE_REVISION,
  TRANSCODED_DIRECTORY,
  identityDigest,
  clearKeptStores,
  findKeptDownload,
  holdTranscodedStore,
  keepDownload,
  keptStoreManifest,
  keptStoresUsage,
  keptWhere,
  openTranscodeSpace,
  persistsAcrossVisits,
  releaseKeptDownload,
  forgetKeptCopy,
  sweepAbandonedTranscodes,
} from '../assets/js/data/anndata/transcode/space.js';
import { CHECK_PAGE_BYTES, KeptCopyDamage, pageChecksumsOf } from '../assets/js/formats/io/page-checks.js';
import { READ_IN_PARTS_INSTEAD, wholeDownloadNote, wholeReadNote } from '../assets/js/data/whole-read-notice.js';
import { describeKeptStores } from '../assets/js/app/ui/modules/kept-stores-line.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { blobByteSource, bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { openZipArchive } from '../assets/js/formats/zip/index.js';
import { createLocks, opfsOnDisk } from './helpers/opfs-on-disk.mjs';
import { codeDigest, sourceClosure } from './helpers/code-digest.mjs';

const archive = await openZipArchive(createByteReader(bytesByteSource(new Uint8Array(readFileSync(new URL('./fixtures/rds/corpus.zip', import.meta.url))), { name: 'corpus.zip' })));
const fileOf = async (name, lastModified = 1) => new File([(await archive.entry(`rds/${name}`).read()).slice()], name, { lastModified });

function counted() {
  const reads = { bytes: 0 };
  const byteReaderOf = file => {
    const reader = createByteReader(blobByteSource(file));
    return { ...reader, read: (offset, length, options) => { reads.bytes += length; return reader.read(offset, length, options); } };
  };
  return { reads, byteReaderOf };
}

const parentOf = root => path.join(root, TRANSCODED_DIRECTORY);
const directories = root => {
  try {
    return readdirSync(parentOf(root)).sort();
  } catch {
    return [];
  }
};
const manifestOf = (root, directory) => JSON.parse(readFileSync(path.join(parentOf(root), directory, 'manifest.json'), 'utf8'));

/** Bytes under a folder: what the browser's estimate counts as used. */
function usage(folder) {
  let total = 0;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const target = path.join(folder, entry.name);
    total += entry.isDirectory() ? usage(target) : statSync(target).size;
  }
  return total;
}

/** A browser with `quota` bytes of storage, its usage what is on disk. */
function withQuota(disk, quota) {
  disk.environment.navigator.storage.estimate = async () => ({ quota, usage: usage(disk.root) });
}

/** Another tab holds a directory open (a shared lock it never lets go in the test). */
function holdAsAnotherTab(disk, directory) {
  disk.environment.navigator.locks.request(`${TRANSCODED_DIRECTORY}/${directory}`, { mode: 'shared' }, () => new Promise(() => {}));
}

/** A new visit: the page and its workers are gone, their locks with them. */
function newVisit(disk) {
  disk.environment.navigator.locks = createLocks();
}

async function* piecesOf(bytes, size = 3) {
  for (let at = 0; at < bytes.length; at += size) yield bytes.slice(at, at + size);
}

test('a store of a file whose identity names its version is kept for later visits; one known by its size only for the tab', async t => {
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  assert.equal(persistsAcrossVisits({ kind: 'file', name: 'a.rds', size: 4, lastModified: 1 }), true);
  assert.equal(persistsAcrossVisits({ kind: 'file', name: 'a.rds', size: 4, lastModified: null }), false);
  assert.equal(persistsAcrossVisits({ kind: 'remote', key: 'geo:x', version: '"etag-1"' }), true);
  assert.equal(persistsAcrossVisits({ kind: 'remote', key: 'served:x', version: 'size:4' }), false, 'a viewer host may serve another object under the same name and size');
  assert.equal(persistsAcrossVisits({ kind: 'url', url: 'https://x/a.rds', size: 4 }), false);
  assert.equal(persistsAcrossVisits({ kind: 'matrix-market', files: [{ kind: 'file', lastModified: 1 }, { kind: 'remote', version: 'size:2' }] }), false);
  assert.equal(persistsAcrossVisits({ download: { kind: 'remote', version: 'md5:x' } }), true);
  assert.deepEqual(await keptWhere({ kind: 'file', lastModified: 1 }, disk.environment), { kept: 'opfs', persistent: true });
  assert.deepEqual(await keptWhere({ kind: 'file', lastModified: 1 }, { navigator: {} }), { kept: 'memory', persistent: false });

  const file = await fileOf('seurat5_gzip.rds');
  const first = counted();
  const one = await TRANSCODERS.rds.transcode({ file }, { byteReaderOf: first.byteReaderOf, environment: disk.environment });
  assert.equal(one.conversion.persistent, true);
  const [kept] = directories(disk.root);
  const manifest = manifestOf(disk.root, kept);
  assert.equal(manifest.revision, KEPT_STORE_REVISION);
  assert.equal(manifest.persist, true);
  assert.equal(manifest.whole, true);
  assert.equal(manifest.key, await identityDigest({ kind: 'file', name: 'seurat5_gzip.rds', size: file.size, lastModified: 1 }));
  assert.equal(manifest.identity, undefined, 'the manifest names the identity by its digest only');
  for (const [name, size] of Object.entries(manifest.blobs)) assert.equal(statSync(path.join(parentOf(disk.root), kept, name)).size, size);

  // The next visit: nobody holds it, the sweep leaves it, and it opens without the file.
  newVisit(disk);
  await sweepAbandonedTranscodes(disk.environment);
  assert.deepEqual(directories(disk.root), [kept]);
  const again = counted();
  const two = await TRANSCODERS.rds.transcode({ file }, { byteReaderOf: again.byteReaderOf, environment: disk.environment });
  assert.equal(again.reads.bytes, 0, 'no byte of the file is read on the later visit');
  assert.deepEqual({ ...two.conversion, notes: [] }, { kept: 'opfs', persistent: true, whole: true, reused: true, notes: [] });

  // A changed file (another modification time) is another file.
  const changed = counted();
  await TRANSCODERS.rds.transcode({ file: await fileOf('seurat5_gzip.rds', 2) }, { byteReaderOf: changed.byteReaderOf, environment: disk.environment });
  assert.ok(changed.reads.bytes >= file.size);
  assert.equal(directories(disk.root).length, 2);

  // A file known by its size only: kept for its tab, swept on the next visit.
  newVisit(disk);
  const loose = await fileOf('seurat5_xz.rds');
  const byteReaderOf = item => createByteReader(blobByteSource(item, { identity: { kind: 'remote', key: 'served:seu', version: `size:${item.size}` } }));
  const events = [];
  const served = await TRANSCODERS.rds.transcode({ file: loose }, { byteReaderOf, environment: disk.environment, onStore: event => events.push(event), tab: 'tab-a' });
  assert.equal(served.conversion.persistent, false);
  assert.equal(directories(disk.root).length, 3);
  // While tab A holds it, tab B does not open it: it reads the file itself.
  holdAsAnotherTab(disk, events.at(-1).directory);
  const inB = await TRANSCODERS.rds.transcode({ file: loose }, {
    byteReaderOf: item => createByteReader(blobByteSource(item, { identity: { kind: 'remote', key: 'served:seu', version: `size:${item.size}` } })),
    environment: disk.environment, tab: 'tab-b',
  });
  assert.equal(inB.conversion.reused, false);
  // Tab A opens its own again.
  const inA = await TRANSCODERS.rds.transcode({ file: loose }, { byteReaderOf, environment: disk.environment, tab: 'tab-a' });
  assert.equal(inA.conversion.reused, true);
  newVisit(disk);
  await sweepAbandonedTranscodes(disk.environment);
  assert.equal(directories(disk.root).length, 2);
  assert.ok(!directories(disk.root).includes(events.at(-1).directory));
});

test('a kept store is filed under what the file is, never its credentials: a link signed again is the same file', async t => {
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  const signed = signature => ({
    kind: 'remote',
    key: `url:${encodeURIComponent(`https://bucket.s3.amazonaws.com/seu.rds?X-Amz-Signature=${signature}&X-Amz-Credential=AKIA123&id=7`)}`,
    version: '"etag-1"',
  });
  assert.equal(await identityDigest(signed('aaa')), await identityDigest(signed('bbb')));
  assert.notEqual(await identityDigest(signed('aaa')), await identityDigest({ ...signed('aaa'), key: signed('aaa').key.replace('id%3D7', 'id%3D8') }), 'a parameter that names the content stays');
  const file = await fileOf('seurat5_gzip.rds');
  const readerFor = signature => item => createByteReader(blobByteSource(item, { identity: signed(signature) }));
  await TRANSCODERS.rds.transcode({ file }, { byteReaderOf: readerFor('aaa'), environment: disk.environment });
  newVisit(disk);
  const again = await TRANSCODERS.rds.transcode({ file }, { byteReaderOf: readerFor('bbb'), environment: disk.environment });
  assert.equal(again.conversion.reused, true);
  const [directory] = directories(disk.root);
  const text = readFileSync(path.join(parentOf(disk.root), directory, 'manifest.json'), 'utf8');
  assert.ok(!/AKIA123|X-Amz|amazonaws|aaa/.test(text), 'no credential, signature or address at rest');
});

/**
 * A complete kept store of `bytes` bytes for `identity`, as a pass leaves
 * one (the corpus' objects are small enough to be held in their manifests,
 * with no file of their own). Its directory.
 */
async function keptStore(disk, identity, bytes) {
  const space = await openTranscodeSpace(identity, { environment: disk.environment });
  const writer = await space.sink.open(bytes);
  writer.write(new Uint8Array(bytes).fill(7));
  const region = writer.close();
  await space.finish({ whole: true, objects: [{ name: '', label: 'x', kind: 'Seurat', version: null, notes: [], entries: {} }] }, new Set([region.store]));
  return space.directory;
}

const identityOf = name => Object.freeze({ kind: 'file', name, size: 1, lastModified: 1 });

test('a kept store that is not what its manifest says is removed and the file is read again', async t => {
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  const tamper = [
    // A file it lists, cut short.
    (directory, manifest) => writeFileSync(path.join(parentOf(disk.root), directory, Object.keys(manifest.blobs)[0]), new Uint8Array(1)),
    // A file it lists, gone.
    (directory, manifest) => rmSync(path.join(parentOf(disk.root), directory, Object.keys(manifest.blobs)[0])),
    // Written by another revision of the transcoders.
    (directory, manifest) => writeFileSync(path.join(parentOf(disk.root), directory, 'manifest.json'), JSON.stringify({ ...manifest, revision: KEPT_STORE_REVISION - 1 })),
    // Its page checksums gone, or not those of its bytes.
    (directory, manifest) => rmSync(path.join(parentOf(disk.root), directory, `${Object.keys(manifest.blobs)[0]}.sums`)),
    (directory, manifest) => writeFileSync(path.join(parentOf(disk.root), directory, `${Object.keys(manifest.blobs)[0]}.sums`), new Uint8Array(4)),
    (directory, manifest) => writeFileSync(path.join(parentOf(disk.root), directory, 'manifest.json'), JSON.stringify({ ...manifest, checks: undefined })),
    // Filed under this identity's digest's start, but naming another digest.
    (directory, manifest) => writeFileSync(path.join(parentOf(disk.root), directory, 'manifest.json'), JSON.stringify({ ...manifest, key: manifest.key.replace(/.$/, c => (c === '0' ? '1' : '0')) })),
  ];
  for (const [index, damage] of tamper.entries()) {
    const identity = identityOf(`damaged-${index}.rds`);
    const directory = await keptStore(disk, identity, 4096);
    newVisit(disk);
    assert.equal((await keptStoreManifest(identity, disk.environment))?.revision, KEPT_STORE_REVISION, `damage ${index}: whole, it is found`);
    damage(directory, manifestOf(disk.root, directory));
    newVisit(disk);
    assert.equal(await keptStoreManifest(identity, disk.environment), null, `damage ${index}: not opened`);
    assert.ok(!directories(disk.root).includes(directory), `damage ${index}: removed`);
  }
  // A manifest that does not read is an incomplete pass: left to the sweep (another tab may be writing it).
  const identity = identityOf('unfinished.rds');
  const directory = await keptStore(disk, identity, 16);
  writeFileSync(path.join(parentOf(disk.root), directory, 'manifest.json'), '{"revision":');
  newVisit(disk);
  assert.equal(await keptStoreManifest(identity, disk.environment), null);
  await sweepAbandonedTranscodes(disk.environment);
  assert.deepEqual(directories(disk.root), []);

  // Through a transcoder: the file is read again and a new store kept.
  const file = await fileOf('seurat5_bzip2.rds');
  await TRANSCODERS.rds.transcode({ file }, { byteReaderOf: counted().byteReaderOf, environment: disk.environment });
  newVisit(disk);
  const [first] = directories(disk.root);
  writeFileSync(path.join(parentOf(disk.root), first, 'manifest.json'), JSON.stringify({ ...manifestOf(disk.root, first), revision: 0 }));
  const reads = counted();
  const opened = await TRANSCODERS.rds.transcode({ file }, { byteReaderOf: reads.byteReaderOf, environment: disk.environment });
  assert.ok(reads.reads.bytes >= file.size);
  assert.equal(opened.conversion.reused, false);
  assert.equal(directories(disk.root).length, 1);
  assert.notEqual(directories(disk.root)[0], first);
});

test('room is made under the real quota, least recently opened first, never from a store a tab holds', async t => {
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  const size = 64 * 1024;
  const made = [];
  for (let index = 0; index < 3; index++) {
    made.push(await keptStore(disk, identityOf(`store-${index}.rds`), size));
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  newVisit(disk);
  // Opening the first again makes the second the least recently opened.
  assert.notEqual(await keptStoreManifest(identityOf('store-0.rds'), disk.environment), null);
  newVisit(disk);
  holdAsAnotherTab(disk, made[2]);
  await new Promise(resolve => setTimeout(resolve, 5));
  // Room for half a store: one has to go for the next.
  withQuota(disk, usage(disk.root) + size / 2);
  await keptStore(disk, identityOf('store-3.rds'), size);
  const left = directories(disk.root);
  assert.ok(!left.includes(made[1]), 'the least recently opened store made room');
  assert.ok(left.includes(made[0]), 'the store opened again stays');
  assert.ok(left.includes(made[2]), 'a store a tab holds stays');
  assert.equal(left.length, 3);

  // Nothing left that may go (every store open in some tab): refused as storage-full.
  newVisit(disk);
  for (const directory of directories(disk.root)) holdAsAnotherTab(disk, directory);
  await new Promise(resolve => setTimeout(resolve, 5));
  withQuota(disk, usage(disk.root) + size / 2);
  await assert.rejects(keptStore(disk, identityOf('store-4.rds'), size), error => error.details?.reason === 'storage-full');
  assert.equal(directories(disk.root).length, 4, 'the refused pass is discarded by its transcoder; here its directory is the fourth');
});

/**
 * A browser whose storage refuses writes past `limit` bytes with a
 * QuotaExceededError while its estimate reports plenty (a Chromium private
 * window: its storage is held in memory and small).
 */
function withRealQuota(disk, limit) {
  const quota = { limit };
  const wrapFile = handle => ({
    ...handle,
    async createSyncAccessHandle() {
      const access = await handle.createSyncAccessHandle();
      return {
        ...access,
        write(view, options) {
          if (usage(disk.root) + view.length > quota.limit) throw new DOMException('The operation failed because it would cause the application to exceed its storage quota.', 'QuotaExceededError');
          return access.write(view, options);
        },
      };
    },
  });
  const wrapDirectory = handle => ({
    ...handle,
    entries: handle.entries,
    getDirectoryHandle: async (...args) => wrapDirectory(await handle.getDirectoryHandle(...args)),
    getFileHandle: async (...args) => wrapFile(await handle.getFileHandle(...args)),
  });
  const getDirectory = disk.environment.navigator.storage.getDirectory;
  disk.environment.navigator.storage.getDirectory = async () => wrapDirectory(await getDirectory());
  disk.environment.navigator.storage.estimate = async () => ({ quota: 4 * 2 ** 30, usage: 0 });
  return quota;
}

test('a write the browser refuses for its quota is said as storage full; the kept stores nobody holds make room, once', async t => {
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  const file = await fileOf('seurat5_gzip.rds');
  // What a pass over it writes, with no bound.
  const measure = opfsOnDisk();
  await TRANSCODERS.rds.transcode({ file: await fileOf('seurat5_gzip.rds', 9) }, { byteReaderOf: counted().byteReaderOf, environment: measure.environment });
  const needs = usage(measure.root);
  measure.cleanup();

  // Nothing kept to remove: refused, explained, nothing left behind.
  const quota = withRealQuota(disk, needs / 2);
  await assert.rejects(
    TRANSCODERS.rds.transcode({ file }, { byteReaderOf: counted().byteReaderOf, environment: disk.environment }),
    error => error.details?.reason === 'storage-full' && /storage for this site is full after .* \(a private window gives a site little\)/.test(error.message)
  );
  assert.deepEqual(directories(disk.root), []);

  // A store kept earlier that nobody holds: removed, and the pass made again.
  quota.limit = Infinity;
  await keptStore(disk, identityOf('old.rds'), 64 * 1024);
  newVisit(disk);
  quota.limit = needs + 32 * 1024;
  const opened = await TRANSCODERS.rds.transcode({ file }, { byteReaderOf: counted().byteReaderOf, environment: disk.environment });
  assert.equal(opened.conversion.reused, false);
  assert.equal(await keptStoreManifest(identityOf('old.rds'), disk.environment), null, 'the old store made room');
  assert.equal(directories(disk.root).length, 1);
});

test('clearing removes every store no tab holds, and the usage says what is kept', async t => {
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  const held = await keptStore(disk, identityOf('a.rds'), 1000);
  await keptStore(disk, identityOf('b.rds'), 3000);
  newVisit(disk);
  holdAsAnotherTab(disk, held);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(await keptStoresUsage(disk.environment), { stores: 2, bytes: 4000, held: 1, indexes: 0, indexBytes: 0, indexesHeld: 0, clearable: 1 });
  assert.deepEqual(await clearKeptStores(disk.environment), { removed: 1, held: 1 });
  assert.deepEqual(directories(disk.root), [held], 'the store a tab holds stays until it closes');
  assert.deepEqual(await keptStoresUsage({ navigator: {} }), { stores: 0, bytes: 0, held: 0, indexes: 0, indexBytes: 0, indexesHeld: 0, clearable: 0 });
  assert.deepEqual(await clearKeptStores({ navigator: {} }), { removed: 0, held: 0 });

  // Open data's Stored line.
  assert.equal(describeKeptStores({ stores: 0, bytes: 0, held: 0 }), '', 'hidden while nothing is kept');
  assert.equal(describeKeptStores({ stores: 1, bytes: 3_145_728, held: 1 }), '1 file kept in this browser (3.0 MB): opened again, it is not read again (in use by an open tab)');
  assert.equal(describeKeptStores({ stores: 3, bytes: 3_221_225_472, held: 0 }), '3 files kept in this browser (3.0 GB): opened again, they are not read again');
  assert.equal(describeKeptStores({ stores: 3, bytes: 1024, held: 2 }), '3 files kept in this browser (1.0 KB): opened again, they are not read again (2 of them in use by open tabs)');
});

test('a file a host serves only whole is kept as it arrives, found again by its identity, and removed once its store is kept', async t => {
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  const bytes = new Uint8Array((await archive.entry('rds/seurat5_gzip.rds').read()).slice());
  const identity = Object.freeze({ kind: 'remote', key: 'geo:GSE1/seu.rds', version: '"etag-7"' });
  const kept = await keepDownload(identity, piecesOf(bytes, 4096), { name: 'seu.rds', size: bytes.length, environment: disk.environment });
  assert.equal(kept.kept, 'opfs');
  assert.equal(kept.persistent, true);
  assert.equal(kept.file.name, 'seu.rds');
  assert.deepEqual(new Uint8Array(await kept.file.arrayBuffer()), bytes);
  const [directory] = directories(disk.root);
  assert.equal(manifestOf(disk.root, directory).kind, 'download');

  // The next visit finds it without downloading.
  newVisit(disk);
  await sweepAbandonedTranscodes(disk.environment);
  const found = await findKeptDownload(identity, 'seu.rds', disk.environment);
  assert.deepEqual(new Uint8Array(await found.file.arrayBuffer()), bytes);
  assert.deepEqual(found.checks.sums, kept.checks.sums, 'its page checksums are found with it');
  assert.equal(await findKeptDownload({ ...identity, version: '"etag-8"' }, 'seu.rds', disk.environment), null, 'another version is another file');

  // Its store is filed under the remote file's identity, so it is found
  // before anything is downloaded; the download then goes.
  const byteReaderOf = file => createByteReader(blobByteSource(file, { identity }));
  await TRANSCODERS.rds.transcode({ file: found.file }, { byteReaderOf, environment: disk.environment });
  const manifest = await keptStoreManifest(identity, disk.environment);
  assert.equal(manifest.whole, true);
  await releaseKeptDownload(identity, disk.environment);
  assert.equal(directories(disk.root).length, 1);
  assert.equal(await findKeptDownload(identity, 'seu.rds', disk.environment), null);

  // A download that fails part way leaves nothing.
  async function* broken() {
    yield bytes.slice(0, 10);
    throw new Error('The connection was reset.');
  }
  await assert.rejects(keepDownload({ ...identity, version: '"etag-9"' }, broken(), { name: 'seu.rds', size: bytes.length, environment: disk.environment }), /reset/);
  assert.equal(directories(disk.root).length, 1);

  // Without storage: one Blob, joined a batch at a time.
  const memory = await keepDownload(identity, piecesOf(bytes, 1000), { name: 'seu.rds', size: bytes.length, environment: { navigator: {} } });
  assert.equal(memory.kept, 'memory');
  assert.equal(memory.checks, null);
  assert.deepEqual(new Uint8Array(await memory.file.arrayBuffer()), bytes);
});

/** Flip one byte of a kept file in place: its size stays, its bytes do not. */
function flipByte(file, at) {
  const bytes = readFileSync(file);
  bytes[at] ^= 0xff;
  writeFileSync(file, bytes);
}

test('a converted store read back from this browser is checked page by page: damaged bytes fail the read, the store is forgotten and converted again', async t => {
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  const file = await fileOf('seurat5_gzip.rds');
  const first = await TRANSCODERS.rds.transcode({ file }, { byteReaderOf: counted().byteReaderOf, environment: disk.environment });
  const keys = first.store.list().filter(key => first.store.storedSize(key) > 0);
  const whole = await first.store.getMany(keys);
  const [directory] = directories(disk.root);
  const manifest = manifestOf(disk.root, directory);
  assert.equal(manifest.checks.pageBytes, CHECK_PAGE_BYTES);
  for (const name of Object.keys(manifest.blobs)) {
    const table = readFileSync(path.join(parentOf(disk.root), directory, `${name}.sums`));
    assert.equal(table.length, 4 * Math.ceil(manifest.blobs[name] / CHECK_PAGE_BYTES), `${name}: one checksum a page`);
  }

  // Unchanged, a later visit reads exactly what was written.
  newVisit(disk);
  const again = await TRANSCODERS.rds.transcode({ file }, { byteReaderOf: counted().byteReaderOf, environment: disk.environment });
  assert.equal(again.conversion.reused, true);
  assert.deepEqual(await again.store.getMany(keys), whole);

  // One byte of the largest kept file flipped (its size unchanged): every
  // read of that page fails as damage, never returns the bytes.
  const [largest] = Object.entries(manifest.blobs).sort((a, b) => b[1] - a[1]);
  flipByte(path.join(parentOf(disk.root), directory, largest[0]), Math.floor(largest[1] / 2));
  newVisit(disk);
  const damaged = await TRANSCODERS.rds.transcode({ file }, { byteReaderOf: counted().byteReaderOf, environment: disk.environment });
  await assert.rejects(damaged.store.getMany(keys), error => error instanceof KeptCopyDamage && /kept in this browser is damaged/.test(error.message));
  // Forgotten: removed once nobody holds it, and the file is read again.
  newVisit(disk);
  await sweepAbandonedTranscodes(disk.environment);
  assert.deepEqual(directories(disk.root), []);
  const reads = counted();
  const converted = await TRANSCODERS.rds.transcode({ file }, { byteReaderOf: reads.byteReaderOf, environment: disk.environment });
  assert.equal(converted.conversion.reused, false);
  assert.ok(reads.reads.bytes >= file.size);
  assert.deepEqual(await converted.store.getMany(keys), whole);
});

test('a file downloaded whole and kept is read through its page checksums: a damaged copy fails as damaged and is downloaded again', async t => {
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  const bytes = new Uint8Array(3 * CHECK_PAGE_BYTES + 123).map((_, i) => (i * 7) & 0xff);
  const identity = Object.freeze({ kind: 'remote', key: 'example:a.h5ad', version: '"etag-1"' });
  const kept = await keepDownload(identity, piecesOf(bytes, 5000), { name: 'a.h5ad', size: bytes.length, environment: disk.environment });
  assert.deepEqual(kept.checks.sums, pageChecksumsOf(bytes), 'taken as it arrived');
  newVisit(disk);
  const found = await findKeptDownload(identity, 'a.h5ad', disk.environment);
  const sourceOf = copy => blobByteSource(copy.file, {
    identity,
    checks: { ...copy.checks, onDamage: () => forgetKeptCopy(copy.checks.directory, disk.environment) },
  });
  // Any range, across page edges, reads exactly.
  const source = sourceOf(found);
  for (const [offset, length] of [[0, 1], [CHECK_PAGE_BYTES - 3, 7], [5, 2 * CHECK_PAGE_BYTES], [bytes.length - 10, 10], [0, bytes.length]]) {
    assert.deepEqual(await source.read(offset, length), bytes.subarray(offset, offset + length));
  }
  await releaseKeptDownload(identity, disk.environment);

  const again = await keepDownload(identity, piecesOf(bytes, 5000), { name: 'a.h5ad', size: bytes.length, environment: disk.environment });
  flipByte(path.join(parentOf(disk.root), again.checks.directory, 'source'), CHECK_PAGE_BYTES + 10);
  newVisit(disk);
  const damaged = await findKeptDownload(identity, 'a.h5ad', disk.environment);
  const reading = sourceOf(damaged);
  assert.deepEqual(await reading.read(0, 100), bytes.subarray(0, 100), 'an undamaged page reads');
  await assert.rejects(reading.read(CHECK_PAGE_BYTES + 5000, 10), error => error.code === 'damaged' && /a\.h5ad kept in this browser is damaged/.test(error.message));
  await new Promise(resolve => setTimeout(resolve, 0));
  newVisit(disk);
  assert.equal(await findKeptDownload(identity, 'a.h5ad', disk.environment), null, 'forgotten: the next open downloads it again');
});

test('the opening says up front that a file cannot be read in parts, how much is read, where it is kept and what reads in parts', () => {
  const pass = wholeReadNote({ format: 'rds', bytes: 1_226_000_000, kept: 'opfs', persistent: true, reused: false });
  assert.equal(pass, 'An R object (.rds) cannot be read in parts: all 1.1 GB of it is read once, and what Cellucid shows of it is ' +
    `kept in this browser, so opening it again takes seconds. ${READ_IN_PARTS_INSTEAD}`);
  assert.match(wholeReadNote({ format: 'mtx', bytes: null, kept: 'opfs', persistent: false, reused: false }),
    /^A MatrixMarket folder cannot be read in parts: all of it is read once, .* kept in this browser until this tab closes\./);
  assert.match(wholeReadNote({ format: 'rda', bytes: 10, kept: 'memory', persistent: false, reused: false }), /kept in memory until this tab closes/);
  assert.equal(wholeReadNote({ format: 'rds', bytes: 10, kept: 'opfs', persistent: true, reused: true }),
    "Opened from this browser's storage, where it was kept when it was first read whole: none of the R object (.rds) is read again.");
  assert.match(wholeDownloadNote({ host: 'ftp.ncbi.nlm.nih.gov', why: 'its host does not serve parts of files', bytes: 524_288_000, kept: 'opfs', persistent: true }),
    /^ftp\.ncbi\.nlm\.nih\.gov serves this file only whole \(its host does not serve parts of files\): all 500 MB of it is downloaded once before it opens, and kept in this browser, so opening it again downloads nothing\./);
  assert.match(READ_IN_PARTS_INSTEAD, /cellucid_prepare\(\) in R, cellucid\.prepare\(\) in Python/);
});

/**
 * The sources whose output a kept store holds: every module the transcoders
 * load (`transcode/index.js` and what it imports, followed through every
 * relative import), and the worker scripts they start. Changing any of them
 * may change what a pass writes, so a store an earlier revision kept must
 * not be read. Left out, with what only they import: `space.js` (it keeps
 * stores and holds the revision; it writes none of their content) and
 * `assets/workers/scripts.js` (the generated names of the worker bundles).
 */
const ENTRY = 'assets/js/data/anndata/transcode/index.js';
const WORKER_SOURCES = ['assets/js/formats/rds/gunzip-worker.js'];
const LEFT_OUT = new Set(['assets/js/data/anndata/transcode/space.js', 'assets/workers/scripts.js']);

/**
 * Every revision's digest of those sources' code without comments
 * (`helpers/code-digest.mjs`), oldest first: a row is added for every change
 * of the transcoders, with the next revision, and never edited.
 */
const REVISIONS = [
  { revision: 1, digest: 'd5db44c7cd83e0bb5a9b702c05fbe738cb20510978574ea39454a9784973d43f' },
];

test('the kept-store revision is raised whenever the transcoders change', () => {
  const root = new URL('..', import.meta.url).pathname;
  const { guarded: files } = sourceClosure(root, [ENTRY, ...WORKER_SOURCES], LEFT_OUT);
  assert.ok(files.includes('assets/js/data/data-mapping.js') && files.includes('assets/js/utils/format-units.js'), 'the imports are followed');
  // Their code, not their comments (`helpers/code-digest.mjs`).
  const digest = codeDigest(root, files);
  REVISIONS.forEach((row, index) => {
    if (index > 0) assert.equal(row.revision, REVISIONS[index - 1].revision + 1, 'one row per revision, in order');
  });
  assert.equal(new Set(REVISIONS.map(row => row.digest)).size, REVISIONS.length, 'every revision has its own sources');
  const last = REVISIONS.at(-1);
  assert.deepEqual({ revision: KEPT_STORE_REVISION, digest }, last,
    'The transcoders changed: raise KEPT_STORE_REVISION in assets/js/data/anndata/transcode/space.js ' +
    '(stores kept by the earlier revision are then removed, not read), and add a row with the new revision and digest here.');
  // A row is never edited: against the committed test, a new digest comes with a new revision.
  let committed = null;
  try {
    committed = execFileSync('git', ['show', 'HEAD:tests/transcode-cache-contract.test.mjs'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    committed = null;
  }
  for (const [, revision, recorded] of committed?.matchAll(/\{ revision: (\d+), digest: '([0-9a-f]{64})' \}/g) ?? []) {
    const row = REVISIONS.find(item => item.revision === Number(revision));
    assert.equal(row?.digest, recorded, `revision ${revision}'s committed digest is kept as it was: a change takes the next revision`);
  }
});
