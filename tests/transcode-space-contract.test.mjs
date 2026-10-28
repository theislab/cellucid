/**
 * Where a single-stream file's store lives (`data/anndata/transcode/space.js`,
 * `session.js`), with the origin-private file system and Web Locks a worker
 * has (on disk here, `helpers/opfs-on-disk.mjs`):
 *
 * - one pass writes one directory, told `writing` then `complete`, and its
 *   store reads exactly as the same file's store kept in memory;
 * - only what the store refers to is kept (a payload kept while the file
 *   streamed and not used is deleted), and the manifest is written last;
 * - the same file opened again finds the complete directory and reads none
 *   of the file;
 * - a refused file, a stopped pass and a full browser storage leave no
 *   directory behind; the start-up sweep removes directories nobody holds.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { TRANSCODERS } from '../assets/js/data/anndata/transcode/index.js';
import { TRANSCODED_DIRECTORY, holdTranscodedStore, openTranscodeSpace, sweepAbandonedTranscodes } from '../assets/js/data/anndata/transcode/space.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { blobByteSource, bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { openZipArchive } from '../assets/js/formats/zip/index.js';
import { opfsOnDisk } from './helpers/opfs-on-disk.mjs';

const archive = await openZipArchive(createByteReader(bytesByteSource(new Uint8Array(readFileSync(new URL('./fixtures/rds/corpus.zip', import.meta.url))), { name: 'corpus.zip' })));
const fileOf = async name => new File([(await archive.entry(`rds/${name}`).read()).slice()], name, { lastModified: 1 });

function counted() {
  const reads = { bytes: 0 };
  const byteReaderOf = file => {
    const reader = createByteReader(blobByteSource(file));
    return {
      ...reader,
      read: (offset, length, options) => {
        reads.bytes += length;
        return reader.read(offset, length, options);
      },
    };
  };
  return { reads, byteReaderOf };
}

async function allKeys(store) {
  const out = new Map();
  for (const key of store.list().sort()) out.set(key, await store.get(key));
  return out;
}

const directories = root => {
  try {
    return readdirSync(path.join(root, TRANSCODED_DIRECTORY));
  } catch {
    return [];
  }
};

test('one pass writes one kept directory whose store reads as the store kept in memory', async t => {
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  const file = await fileOf('seurat5_gzip.rds');
  const events = [];
  const { byteReaderOf } = counted();
  const kept = await TRANSCODERS.rds.transcode({ file }, { byteReaderOf, environment: disk.environment, onStore: event => events.push(event) });
  const memory = await TRANSCODERS.rds.transcode({ file }, { byteReaderOf, memory: true });
  assert.deepEqual(events.map(event => event.state), ['writing', 'complete']);
  assert.equal(events[0].directory, events[1].directory);
  const [directory] = directories(disk.root);
  assert.equal(directory, events[0].directory);
  const files = readdirSync(path.join(disk.root, TRANSCODED_DIRECTORY, directory)).sort();
  const manifest = JSON.parse(readFileSync(path.join(disk.root, TRANSCODED_DIRECTORY, directory, 'manifest.json'), 'utf8'));
  // Each file it refers to, with its page checksums (`formats/io/page-checks.js`).
  const blobs = Object.keys(manifest.blobs);
  assert.deepEqual(Object.keys(manifest.checks.files).sort(), blobs.sort(), 'every kept file is checked');
  assert.deepEqual(files, [...blobs, ...blobs.map(name => `${name}.sums`), 'manifest.json', 'used'].sort(), 'only what the store refers to is kept');
  assert.deepEqual(await allKeys(kept.store), await allKeys(memory.store));
});

test('the same file opened again reads its kept store, not the file', async t => {
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  const file = await fileOf('seurat5_xz.rds');
  const first = counted();
  const one = await TRANSCODERS.rds.transcode({ file }, { byteReaderOf: first.byteReaderOf, environment: disk.environment });
  assert.ok(first.reads.bytes >= file.size);
  const again = counted();
  const events = [];
  const two = await TRANSCODERS.rds.transcode({ file }, { byteReaderOf: again.byteReaderOf, environment: disk.environment, onStore: event => events.push(event) });
  assert.equal(again.reads.bytes, 0, 'no byte of the file is read again');
  assert.deepEqual(events.map(event => event.state), ['complete']);
  assert.equal(directories(disk.root).length, 1);
  assert.deepEqual(await allKeys(two.store), await allKeys(one.store));
});

test('a save() file of several objects keeps them all in one pass; a later choice reads what was kept', async t => {
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  const file = await fileOf('two_objects.rda');
  const first = counted();
  const picked = await TRANSCODERS.rda.transcode({ file }, { byteReaderOf: first.byteReaderOf, environment: disk.environment, choose: async () => 0 });
  assert.equal(picked.object.name, 'seu');
  const again = counted();
  const other = await TRANSCODERS.rda.transcode({ file }, { byteReaderOf: again.byteReaderOf, environment: disk.environment, choose: async ({ options }) => options.findIndex(label => label.startsWith('sce')) });
  assert.equal(other.object.name, 'sce');
  assert.equal(again.reads.bytes, 0);
});

test('a refused file, a stopped pass and a full storage leave no directory', async t => {
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  const { byteReaderOf } = counted();
  await assert.rejects(
    TRANSCODERS.rds.transcode({ file: await fileOf('seurat5_noembedding.rds') }, { byteReaderOf, environment: disk.environment }),
    { reason: 'no-embedding' }
  );
  assert.deepEqual(directories(disk.root), []);

  const controller = new AbortController();
  controller.abort(new DOMException('Stopped.', 'AbortError'));
  await assert.rejects(
    TRANSCODERS.rds.transcode({ file: await fileOf('seurat5_gzip.rds') }, { byteReaderOf, environment: disk.environment, signal: controller.signal }),
    { name: 'AbortError' }
  );
  assert.deepEqual(directories(disk.root), []);

  // What a pass keeps is checked against what the browser says it has left.
  disk.environment.navigator.storage.estimate = async () => ({ quota: 4000, usage: 0 });
  const space = await openTranscodeSpace({ kind: 'file', name: 'big' }, { environment: disk.environment });
  await assert.rejects(space.put(new Uint8Array(5000)), error => error.details?.reason === 'storage-full' && /storage has room/.test(error.message));
  await space.discard();
  assert.deepEqual(directories(disk.root), []);
});

test('a payload the parser gives back is deleted at once and no longer counts against the storage left', async t => {
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  disk.environment.navigator.storage.estimate = async () => ({ quota: 3000, usage: 0 });
  const space = await openTranscodeSpace({ kind: 'file', name: 'layers' }, { environment: disk.environment });
  const keep = async bytes => {
    const writer = await space.sink.open(bytes);
    writer.write(new Uint8Array(bytes));
    return writer.close();
  };
  const counts = await keep(1000);
  const scaled = await keep(1500);
  const folder = path.join(disk.root, TRANSCODED_DIRECTORY, space.directory);
  assert.ok(readdirSync(folder).includes(scaled.store));
  // Refused before anything is written, and the refusal is not counted.
  await assert.rejects(space.sink.open(1000), error => error.details?.reason === 'storage-full');
  await space.sink.release(scaled);
  assert.ok(!readdirSync(folder).includes(scaled.store), 'deleted at once, not when the store is complete');
  const data = await keep(1900);
  const readers = await space.finish({}, new Set([counts.store, data.store]));
  assert.deepEqual([...readers.keys()].sort(), [counts.store, data.store].sort());
  await space.discard();

  const memory = await openTranscodeSpace(null, { memory: true });
  const writer = memory.sink.open(4);
  writer.write(Uint8Array.of(1, 2));
  writer.write(Uint8Array.of(3, 4));
  const region = writer.close();
  assert.deepEqual(Array.from(await memory.read(region)), [1, 2, 3, 4]);
  memory.sink.release(region);
  await assert.rejects(memory.read(region), /missing/);
});

test('the start-up sweep removes directories nobody holds and keeps the held ones', async t => {
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  const { byteReaderOf } = counted();
  const events = [];
  // A pass whose reader still runs holds its directory; a crashed tab's
  // directory is held by nobody.
  await TRANSCODERS.rds.transcode({ file: await fileOf('seurat5_gzip.rds') }, { byteReaderOf, environment: disk.environment, onStore: event => events.push(event) });
  mkdirSync(path.join(disk.root, TRANSCODED_DIRECTORY, 'crashed-tab'));
  writeFileSync(path.join(disk.root, TRANSCODED_DIRECTORY, 'crashed-tab', 'p0.bin'), new Uint8Array(8));
  holdTranscodedStore(events.at(-1).directory, disk.environment);
  await new Promise(resolve => setTimeout(resolve, 10));
  await sweepAbandonedTranscodes(disk.environment);
  assert.deepEqual(directories(disk.root), [events.at(-1).directory]);
  // No OPFS: nothing to do, nothing thrown.
  await sweepAbandonedTranscodes({ navigator: {} });
});
