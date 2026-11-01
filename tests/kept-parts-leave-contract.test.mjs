/**
 * What a reader fetched of a remote file is kept as it arrives
 * (`formats/io/kept-parts.js`, a journal: `space.js` `openKeptJournal`),
 * whatever the visit's length: a tab closed at once, a worker ended or a
 * browser that crashes right after a read loses none of it, and a later
 * visit fetches none of it again; nothing waits for the reads to go quiet
 * or for a page event (`flushKeptParts` only asks the disk to hold what is
 * written). A file whose reads name no version (Google Drive's public
 * reads) is used on a later visit only as far as its provider confirmed the
 * version still held. Its own file: `flushKeptParts` reaches every reader
 * of the realm, so no other test's kept parts may be open in it.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { opfsOnDisk, createLocks } from './helpers/opfs-on-disk.mjs';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { httpByteSource } from '../assets/js/formats/io/byte-source.js';
import { confirmFileVersion, flushKeptParts, keptPartsOf, withKeptParts } from '../assets/js/formats/io/kept-parts.js';
import { parseKeptJournal } from '../assets/js/data/anndata/transcode/space.js';
import { ResponseClock } from '../assets/js/formats/io/link.js';
import { until } from './helpers/until.mjs';

const BYTES = new Uint8Array(1 << 16).map((_, i) => (i * 13) % 251);

/** A host serving `BYTES` with ranges and a strong ETag. */
function host(t) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers ?? {}).get('Range')).map(Number);
    return new Response(BYTES.slice(start, end + 1), {
      status: 206,
      headers: { ETag: '"v1"', 'Content-Range': `bytes ${start}-${end}/${BYTES.length}`, 'Content-Length': String(end - start + 1) },
    });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

function remoteFile(version) {
  return { url: 'https://host.test/data/lung.h5ad', size: BYTES.length, name: 'lung.h5ad', etag: '"v1"', identity: Object.freeze({ kind: 'remote', key: 'url:lung', version }) };
}

/** The kept directories on the disk, with their manifests (null: not complete). */
function manifests(disk) {
  const parent = path.join(disk.root, 'cellucid-transcoded');
  let names = [];
  try {
    names = readdirSync(parent);
  } catch {
    return [];
  }
  return names.map(name => {
    try {
      return JSON.parse(readFileSync(path.join(parent, name, 'manifest.json'), 'utf8'));
    } catch {
      return null;
    }
  });
}

/** A host serving `BYTES` with ranges and a strong ETag, counting what it is asked for (`asked`). */
function countingHost(t) {
  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const range = new Headers(init.headers ?? {}).get('Range');
    asked.push(range);
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range).map(Number);
    return new Response(BYTES.slice(start, end + 1), {
      status: 206,
      headers: { ETag: '"v1"', 'Content-Range': `bytes ${start}-${end}/${BYTES.length}`, 'Content-Length': String(end - start + 1) },
    });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return asked;
}

/** The bytes the parts journals on the disk hold now. */
function keptJournalBytes(disk) {
  const parent = path.join(disk.root, 'cellucid-transcoded');
  let names = [];
  try {
    names = readdirSync(parent);
  } catch {
    // Not made yet.
  }
  let bytes = 0;
  for (const name of names) {
    try {
      const folder = path.join(parent, name);
      if (JSON.parse(readFileSync(path.join(folder, 'manifest.json'), 'utf8')).kind !== 'parts') continue;
      const records = new Uint8Array(readFileSync(path.join(folder, 'j.bin')));
      bytes += parseKeptJournal(records, readFileSync(path.join(folder, 'd.bin')).length).ranges.reduce((sum, range) => sum + range.length, 0);
    } catch {
      // Not a journal (yet).
    }
  }
  return bytes;
}

/**
 * The bytes the parts journals on the disk hold, once they hold at least
 * `atLeast` (asked again until they do: they are written in the background,
 * on the disk's own threads).
 */
async function journalBytes(disk, atLeast) {
  let bytes = 0;
  await until(() => (bytes = keptJournalBytes(disk)) >= atLeast, `${atLeast} bytes kept in journals`);
  return bytes;
}

/** Whether no journal is being written: each holds its writing lock until it is closed (`space.js` `openKeptJournal`). */
const noneWritten = disk => ![...disk.environment.navigator.locks.held.keys()].some(name => name.endsWith('#writing'));

test('what a reader fetched is kept as it arrives: after a visit cut short at once (a tab closed, a crash) a later visit fetches none of it again', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  disk.environment.navigator.locks = createLocks();
  const asked = countingHost(t);
  const file = remoteFile('census:1');
  const parts = keptPartsOf(file, { environment: disk.environment, tab: 'tab' });
  const reader = createByteReader(withKeptParts(httpByteSource(file), parts));
  // A slow link: its retransmission timeout is a minute. Nothing waits for it.
  const slow = new ResponseClock();
  slow.answered(20_000);
  parts.measuredBy(slow);
  assert.ok(slow.timeoutMs >= 60_000);
  assert.deepEqual(await reader.read(0, 1000), BYTES.subarray(0, 1000));
  assert.deepEqual(await reader.read(30_000, 4000), BYTES.subarray(30_000, 34_000));
  assert.ok(await journalBytes(disk, 5000) >= 5000, 'kept at once, before the reads go quiet and without a page event');
  // The visit ends without a word: no flush, no close (the tab closed at
  // once, the browser crashed). Its locks go with it.
  disk.environment.navigator.locks = createLocks();
  const before = asked.length;
  const later = keptPartsOf(file, { environment: disk.environment, tab: 'tab' });
  const again = createByteReader(withKeptParts(httpByteSource(file), later));
  assert.deepEqual(await again.read(0, 1000), BYTES.subarray(0, 1000));
  assert.deepEqual(await again.read(30_000, 4000), BYTES.subarray(30_000, 34_000));
  assert.deepEqual(asked.slice(before), [], 'nothing fetched again');
  await later.close();
});

test('a journal still being written by another reader is left alone; once its reads go quiet (or its writer is gone) another reader reads it', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  disk.environment.navigator.locks = createLocks();
  const asked = countingHost(t);
  const file = remoteFile('census:1');
  const writing = keptPartsOf(file, { environment: disk.environment, tab: 'tab' });
  await createByteReader(withKeptParts(httpByteSource(file), writing)).read(0, 2000);
  await journalBytes(disk, 2000);
  // Another tab opens the file while the first still writes: it does not read a journal that still grows.
  const other = keptPartsOf(file, { environment: disk.environment, tab: 'tab' });
  await other.open();
  assert.equal(other.keptBytes(), 0, 'left to the next opening');
  assert.ok(manifests(disk).some(manifest => manifest?.kind === 'parts'), 'and never removed');
  await other.close();
  // The writer's reads go quiet for its link's timeout (unmeasured: a
  // second): its journal is closed (its writing lock let go), never
  // appended to again, and read by whoever opens the file next, while the
  // writer still lives.
  await until(() => noneWritten(disk), 'the quiet writer\'s journal closed');
  const before = asked.length;
  const later = keptPartsOf(file, { environment: disk.environment, tab: 'tab' });
  await createByteReader(withKeptParts(httpByteSource(file), later)).read(0, 2000);
  assert.deepEqual(asked.slice(before), [], 'its reads went quiet: read from it');
  // The writer reads on: a new journal, and what it kept before is read from its file.
  const again = createByteReader(withKeptParts(httpByteSource(file), writing));
  assert.deepEqual(await again.read(0, 2000), BYTES.subarray(0, 2000));
  await again.read(10_000, 500);
  await writing.close();
  await later.close();
});

test('a file whose reads name no version (Google Drive\'s public reads) is used later only as far as its provider confirmed the version', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  disk.environment.navigator.locks = createLocks();
  const asked = countingHost(t);
  let holds = true;
  let changed = 0;
  const file = remoteFile('md5:aa:4096');
  const confirm = async () => holds;
  const parts = keptPartsOf(file, { environment: disk.environment, tab: 'tab', confirm, onChanged: () => changed++ });
  const reader = createByteReader(withKeptParts(httpByteSource(file), parts));
  await reader.read(0, 1000);
  // Hidden: the provider confirms what was read so far.
  await flushKeptParts();
  // Read after the confirmation, then the visit is cut short: not confirmed.
  await reader.read(8000, 1000);
  await journalBytes(disk, 2000);
  disk.environment.navigator.locks = createLocks();
  const before = asked.length;
  const later = keptPartsOf(file, { environment: disk.environment, tab: 'tab', confirm });
  const again = createByteReader(withKeptParts(httpByteSource(file), later));
  await again.read(0, 1000);
  assert.deepEqual(asked.slice(before), [], 'the confirmed bytes are kept');
  await again.read(8000, 1000);
  assert.equal(asked.length - before, 1, 'those no confirmation followed are fetched again');
  // Replaced on Drive by a file of the same size: its checksum moved.
  holds = false;
  const watched = keptPartsOf(file, { environment: disk.environment, tab: 'tab', confirm, onChanged: () => changed++ });
  await createByteReader(withKeptParts(httpByteSource(file), watched)).read(2000, 1000);
  await watched.flush();
  assert.equal(changed, 1, 'a version that no longer holds is a changed file');
  // Forgotten as the change is found, on the disk's own threads: until it is.
  await until(() => manifests(disk).every(manifest => manifest === null), 'nothing kept under a version that no longer holds');
  await later.close();
  await parts.close();
});

test('a file opened again from its first description is asked for its version first: one request, and a changed one forgets what is kept', async t => {
  const disk = opfsOnDisk();
  t.after(() => disk.cleanup());
  disk.environment.navigator.locks = createLocks();
  host(t);
  const file = remoteFile('census:1');
  // Something kept of it, as a first reading leaves it.
  const parts = keptPartsOf(file, { environment: disk.environment, tab: 'tab' });
  const reader = createByteReader(withKeptParts(httpByteSource(file), parts));
  await reader.read(0, 1000);
  await parts.close();
  assert.ok(manifests(disk).some(manifest => manifest?.kind === 'parts'));
  const asked = [];
  const answering = tag => async (url, init = {}) => {
    asked.push(`${init.method ?? 'GET'} ${new Headers(init.headers ?? {}).get('Range')}`);
    return new Response(BYTES.slice(0, 1), { status: 206, headers: { ETag: tag, 'Content-Range': `bytes 0-0/${BYTES.length}` } });
  };
  await confirmFileVersion(file, { environment: disk.environment, fetch: answering('"v1"') });
  assert.deepEqual(asked, ['GET bytes=0-0'], 'one byte, past everything kept');
  let forgotten = 0;
  await assert.rejects(
    confirmFileVersion(file, { environment: disk.environment, fetch: answering('"v2"'), onChanged: () => forgotten++ }),
    error => error.code === 'changed' && /changed on its host since it was opened; open it again/.test(error.message)
  );
  assert.equal(forgotten, 1);
  assert.deepEqual(manifests(disk).filter(manifest => manifest !== null), [], 'every kept copy of it is forgotten');
  // A source whose reads name no version asks its provider.
  await assert.rejects(confirmFileVersion(file, { environment: disk.environment, access: { confirmVersion: async () => false, target: async () => ({ url: file.url }) } }), { code: 'changed' });
  // A file served only whole asks its host for its validators.
  const head = tag => async () => new Response(null, { status: 200, headers: { ETag: tag } });
  await confirmFileVersion({ ...file, downloaded: new Blob([BYTES]) }, { environment: disk.environment, fetch: head('W/"v1"') });
  await assert.rejects(confirmFileVersion({ ...file, downloaded: new Blob([BYTES]) }, { environment: disk.environment, fetch: head('"v9"') }), { code: 'changed' });
});

test('a reader opened again from an earlier description reads its held bytes from memory first: the old head\'s timing measures nothing', async t => {
  const { openDatasetStore } = await import('../assets/js/data/anndata/open.js');
  const fixture = new Uint8Array(readFileSync(new URL('./fixtures/gene-read/cellxgene-shaped.h5ad', import.meta.url)));
  const asked = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (input, init = {}) => {
    const range = new Headers(init.headers ?? {}).get('Range');
    asked.push(`${init.method ?? 'GET'} ${range}`);
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range).map(Number);
    const last = Math.min(end, fixture.length - 1);
    return new Response(fixture.slice(start, last + 1), { status: 206, headers: { ETag: '"h1"', 'Content-Range': `bytes ${start}-${last}/${fixture.length}` } });
  };
  // The first opening's head: read in half a millisecond (a server on this machine).
  const head = { bytes: fixture.slice(0, 16384), etag: '"h1"', ms: 0.5 };
  const file = { url: 'https://host.test/data/again.h5ad', size: fixture.length, name: 'again.h5ad', etag: '"h1"', head, identity: Object.freeze({ kind: 'remote', key: 'url:again', version: 'size:0' }) };
  const opened = await openDatasetStore({ source: { file } }, { decodedChunkCacheBytes: 0, confirmVersion: true, transcoding: { environment: {} } });
  assert.equal(asked[0], 'GET bytes=0-0', 'its version asked first');
  // The link starts unmeasured (no stale round trip of half a millisecond),
  // so the page's memory is given the link's whole timeout to answer.
  assert.notEqual(opened.link.snapshot().latencyMs, 0.5);
});
