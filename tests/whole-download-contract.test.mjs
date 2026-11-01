/**
 * A remote file whose host serves no parts of it (`data/whole-download.js`),
 * from a link or a dataset catalog alike, with this browser's storage (on
 * disk here, `helpers/opfs-on-disk.mjs`):
 *
 * - the first opening downloads it whole into the storage as it arrives,
 *   saying so up front (the step with its size, the note with why, how much
 *   and that it is kept), its bytes counted into the Transfers log;
 * - a later opening of a format read in place opens the kept download and
 *   downloads nothing;
 * - a format that is one stream (an R object) is transcoded under the
 *   remote file's identity; once its store is kept the download is removed,
 *   and a later opening downloads nothing at all: the store opens alone.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { afterWholeFileOpened, downloadReason, keptCopyOf, wholeFileOf } from '../assets/js/data/whole-download.js';
import { TRANSCODERS } from '../assets/js/data/anndata/transcode/index.js';
import { TRANSCODED_DIRECTORY } from '../assets/js/data/anndata/transcode/space.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { blobByteSource, bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { openZipArchive } from '../assets/js/formats/zip/index.js';
import { createLocks, opfsOnDisk } from './helpers/opfs-on-disk.mjs';

const archive = await openZipArchive(createByteReader(bytesByteSource(new Uint8Array(readFileSync(new URL('./fixtures/rds/corpus.zip', import.meta.url))), { name: 'corpus.zip' })));
const RDS = new Uint8Array((await archive.entry('rds/seurat5_gzip.rds').read()).slice());

/** This page's navigator, with the on-disk storage, for the test. */
function withStorage(t, handles = 'page') {
  const disk = opfsOnDisk({ handles });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: disk.environment.navigator, configurable: true, writable: true });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    disk.cleanup();
  });
  return disk;
}

/** A host that serves `bytes` whole only, counting what it sends. */
function wholeOnlyHost(t, bytes) {
  const served = { requests: 0, bytes: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    served.requests++;
    served.bytes += bytes.length;
    return new Response(bytes.slice(), { status: 200, headers: { 'Content-Length': String(bytes.length) } });
  };
  t.after(() => { globalThis.fetch = original; });
  return served;
}

const resource = name => Object.freeze({
  url: `https://ftp.example.org/geo/${name}`,
  name,
  size: RDS.length,
  identity: Object.freeze({ kind: 'remote', key: `geo:GSE1/${name}`, version: '"v1"' }),
});

const directories = root => {
  try {
    return readdirSync(path.join(root, TRANSCODED_DIRECTORY));
  } catch {
    return [];
  }
};

test('a file its host serves only whole is downloaded into storage once, said up front, then opened from there', async t => {
  const disk = withStorage(t);
  const served = wholeOnlyHost(t, RDS);
  const steps = [];
  const notes = [];
  const opening = { step: text => steps.push(text), notice: text => notes.push(text) };
  const file = await wholeFileOf(resource('atlas.h5ad'), { format: 'h5ad', opening });
  assert.equal(served.requests, 1);
  assert.deepEqual(new Uint8Array(await file.downloaded.arrayBuffer()), RDS);
  assert.equal(file.size, RDS.length);
  assert.deepEqual(file.identity, resource('atlas.h5ad').identity, 'read under the remote file\'s identity');
  assert.deepEqual(steps, [`Downloading the whole file (22 KB): ${downloadReason(resource('atlas.h5ad'))}`]);
  assert.match(notes[0], /^ftp\.example\.org serves this file only whole \(its host does not serve parts of files\): all 22 KB of it is downloaded once before it opens, and kept in this browser, so opening it again downloads nothing\./);

  // A later visit: kept, so nothing is downloaded.
  disk.environment.navigator.locks = createLocks();
  const again = await wholeFileOf(resource('atlas.h5ad'), { format: 'h5ad', opening });
  assert.equal(served.requests, 1, 'nothing downloaded again');
  assert.deepEqual(new Uint8Array(await again.downloaded.arrayBuffer()), RDS);
});

test('an R object its host serves only whole keeps its store, not its download, and a later visit downloads nothing', async t => {
  const disk = withStorage(t);
  const served = wholeOnlyHost(t, RDS);
  const linked = resource('seu.rds');
  const file = await wholeFileOf(linked, { format: 'rds' });
  assert.equal(served.requests, 1);
  // The reader reads the kept download under the remote file's identity.
  const byteReaderOf = item => createByteReader(blobByteSource(item.downloaded, { name: item.name, identity: item.identity }));
  // The page keeps the download; its reader worker writes the store.
  const opened = await TRANSCODERS.rds.transcode({ file }, { byteReaderOf, environment: disk.as('worker') });
  assert.equal(directories(disk.root).length, 2, 'the download and the store');
  await afterWholeFileOpened([file], { ...opened.conversion, persistent: false });
  assert.equal(directories(disk.root).length, 2, 'a store kept for the tab only leaves the download');
  await afterWholeFileOpened([file], opened.conversion);
  assert.equal(directories(disk.root).length, 1, 'the store alone: the download is no longer needed');

  disk.environment.navigator.locks = createLocks();
  const later = await wholeFileOf(linked, { format: 'rds' });
  assert.equal(served.requests, 1, 'a later visit downloads nothing');
  assert.equal(later.downloaded, undefined, 'the reader opens the kept store, never reading the file');
  const reads = { bytes: 0 };
  const reopened = await TRANSCODERS.rds.transcode({ file: later }, {
    byteReaderOf: () => ({ size: linked.size, identity: linked.identity, link: null, read: async (offset, length) => { reads.bytes += length; throw new Error('read'); } }),
    environment: disk.as('worker'),
  });
  assert.equal(reads.bytes, 0);
  assert.equal(reopened.conversion.reused, true);
});

test('what was kept is found without downloading, and nothing is downloaded when nothing was kept', async t => {
  withStorage(t);
  const served = wholeOnlyHost(t, RDS);
  assert.equal(await keptCopyOf(resource('never.h5ad'), { format: 'h5ad' }), null);
  assert.equal(served.requests, 0, 'a lookup downloads nothing');
});

test('a page that cannot write its storage (Safari before 26) downloads into memory, and says so up front', async t => {
  withStorage(t, 'none');
  wholeOnlyHost(t, RDS);
  const notes = [];
  const file = await wholeFileOf(resource('atlas.h5ad'), { format: 'h5ad', opening: { step: () => {}, notice: text => notes.push(text) } });
  assert.deepEqual(new Uint8Array(await file.downloaded.arrayBuffer()), RDS);
  assert.match(notes[0], /kept in memory until this tab closes/);
});

test('a download the browser refuses for its quota makes room from what nobody holds and is made once more', async t => {
  const disk = withStorage(t);
  const served = wholeOnlyHost(t, RDS);
  // An earlier download, kept and held by nobody.
  await wholeFileOf(resource('old.h5ad'), { format: 'h5ad' });
  disk.environment.navigator.locks = createLocks();
  // Room for the new file only once the old one is gone.
  const writable = disk.environment.navigator.storage.getDirectory;
  let refused = 0;
  disk.environment.navigator.storage.getDirectory = async () => {
    const root = await writable();
    const wrap = handle => ({
      ...handle,
      entries: handle.entries,
      getDirectoryHandle: async (...args) => wrap(await handle.getDirectoryHandle(...args)),
      getFileHandle: async (...args) => {
        const file = await handle.getFileHandle(...args);
        if (typeof file.createWritable !== 'function') return file;
        return {
          ...file,
          createWritable: async () => {
            const stream = await file.createWritable();
            return {
              ...stream,
              write: async data => {
                if (directories(disk.root).length > 1 && args[0] === 'source') {
                  refused++;
                  throw new DOMException('The operation failed because it would cause the application to exceed its storage quota.', 'QuotaExceededError');
                }
                return stream.write(data);
              },
            };
          },
        };
      },
    });
    return wrap(root);
  };
  const file = await wholeFileOf(resource('new.h5ad'), { format: 'h5ad' });
  assert.equal(refused, 1);
  assert.equal(served.requests, 3, 'the old one, then the new one twice');
  assert.deepEqual(new Uint8Array(await file.downloaded.arrayBuffer()), RDS);
  assert.equal(directories(disk.root).length, 1, 'the old download made room');
});
