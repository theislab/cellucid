/**
 * A Web Lock or storage request the browser refuses reaches its caller.
 *
 * `navigator.locks.request` rejects without running its callback when the
 * browser refuses it (a document that is not fully active, a context denied
 * storage). A wrapper that waits for the callback to say "granted" and never
 * looks at that rejection stays pending forever: the opening that asked for
 * a kept index, a converted store or a whole download waits with nothing on
 * screen, and it never goes on to keep its data in memory instead.
 *
 * - `holdLock` (`data/anndata/transcode/space.js`) is the one way a lock is
 *   held past its request: granted, it resolves with `release`; refused, it
 *   rejects with the browser's reason.
 * - Each holder falls back on a refusal: the gene index and the converted
 *   store are kept in memory, a whole download is gathered in memory, a kept
 *   store is not found, and the page's hold on a kept store is let go.
 * - No call of the origin-private file system, storage or Web Locks in
 *   `assets/js` leaves its promise unobserved: each is awaited, returned, or
 *   given a rejection handler.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openIndexFiles } from '../assets/js/data/column-store-placement.js';
import {
  TRANSCODED_DIRECTORY,
  findKeptStores,
  holdLock,
  holdTranscodedStore,
  identityDigest,
  keepDownload,
  openTranscodeSpace,
} from '../assets/js/data/anndata/transcode/space.js';
import { createLocks, opfsOnDisk } from './helpers/opfs-on-disk.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REFUSAL = () => new DOMException('The lock request was refused.', 'SecurityError');

/** Web Locks that refuse every request, as the browser does: the callback never runs. */
function refusingLocks() {
  const asked = [];
  return {
    asked,
    request(name, options, callback) {
      asked.push({ name, mode: (typeof options === 'object' ? options.mode : undefined) ?? 'exclusive' });
      return Promise.reject(REFUSAL());
    },
  };
}

function refusedDisk(t) {
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  const locks = refusingLocks();
  disk.environment.navigator.locks = locks;
  return { disk, locks };
}

async function* piecesOf(bytes, size) {
  for (let at = 0; at < bytes.length; at += size) yield bytes.slice(at, at + size);
}

test('holdLock resolves with release once granted, rejects when refused, and holds nothing without Web Locks', async () => {
  const locks = createLocks();
  const release = await holdLock(locks, 'probe', { mode: 'shared' });
  assert.equal(locks.held.get('probe')?.mode, 'shared', 'held until released');
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(locks.held.has('probe'), false, 'released');

  await assert.rejects(holdLock(refusingLocks(), 'probe'), { name: 'SecurityError' });
  // A request that throws as it is made rejects the same way.
  await assert.rejects(holdLock({ request() { throw REFUSAL(); } }, 'probe'), { name: 'SecurityError' });

  const none = await holdLock(undefined, 'probe');
  assert.equal(typeof none, 'function');
  none();
});

test('a refused lock keeps the gene index in memory', async t => {
  const { disk, locks } = refusedDisk(t);
  assert.equal(await openIndexFiles(['values', 'rows'], disk.environment), null);
  assert.deepEqual(locks.asked.map(item => item.mode), ['exclusive'], 'the index directory was asked for');
});

test('a refused lock keeps a converted store in memory', async t => {
  const { disk, locks } = refusedDisk(t);
  const space = await openTranscodeSpace({ kind: 'file', name: 'refused.rds', size: 4, lastModified: 1 }, { environment: disk.environment });
  assert.equal(space.kind, 'memory');
  assert.deepEqual(locks.asked.map(item => item.mode), ['shared']);
});

test('a refused lock gathers a whole download in memory', async t => {
  const { disk, locks } = refusedDisk(t);
  const bytes = Uint8Array.from({ length: 64 }, (_, i) => i);
  const kept = await keepDownload(
    { kind: 'remote', key: 'example:refused.h5ad', version: '"etag-1"' },
    piecesOf(bytes, 16),
    { name: 'refused.h5ad', size: bytes.length, environment: disk.environment },
  );
  assert.equal(kept.kept, 'memory');
  assert.deepEqual(new Uint8Array(await kept.file.arrayBuffer()), bytes);
  assert.deepEqual(locks.asked.map(item => item.mode), ['shared']);
  assert.deepEqual(readdirSync(path.join(disk.root, TRANSCODED_DIRECTORY)), [], 'nothing is written to the storage');
});

test('a refused lock finds no kept store, and the page lets its hold go', async t => {
  const { disk, locks } = refusedDisk(t);
  const identity = { kind: 'file', name: 'kept.rds', size: 4, lastModified: 1 };
  const directory = `${(await identityDigest(identity)).slice(0, 24)}-kept`;
  mkdirSync(path.join(disk.root, TRANSCODED_DIRECTORY, directory), { recursive: true });
  assert.deepEqual(await findKeptStores(identity, disk.environment), []);
  assert.deepEqual(locks.asked.map(item => item.mode), ['shared'], 'the candidate was asked for');

  // Settles, and is asked again next time rather than remembered as held.
  await holdTranscodedStore(directory, disk.environment);
  await holdTranscodedStore(directory, disk.environment);
  assert.equal(locks.asked.filter(item => item.name.endsWith(directory)).length, 3);
});

// ---------------------------------------------------------------------------
// Every storage and lock call observes its promise.
// ---------------------------------------------------------------------------

const PROMISED_CALL = /\b(?:locks\.request|\.getDirectory|\.getDirectoryHandle|\.getFileHandle|\.createSyncAccessHandle|\.createWritable|\.removeEntry|storage\.estimate|storage\.persisted|storage\.persist)\(/g;

function sources(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sources(location));
    else if (/\.m?js$/.test(entry.name)) found.push(location);
  }
  return found;
}

/** `source` with its comments blanked (line numbers kept). */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '))
    .replace(/^(\s*)\/\/.*$/gm, '$1');
}

/** Each call in `source` whose promise is neither awaited, returned nor given a handler. */
function unobservedCalls(source) {
  const found = [];
  for (const match of source.matchAll(PROMISED_CALL)) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    const before = source.slice(source.lastIndexOf('\n', match.index) + 1, match.index);
    const next = /^\s*\.(\w+)\(/.exec(source.slice(end + 1))?.[1] ?? null;
    const observed =
      /\b(?:await|return)\s+[\w$.?()\s]*$/.test(before) || // awaited or returned (through a member chain)
      /=>\s*[\w$.?]*$/.test(before) || // an arrow's result
      next === 'catch' || next === 'then' || next === 'finally';
    if (!observed) found.push(source.slice(0, match.index).split('\n').length);
  }
  return found;
}

test('the check finds a storage or lock call whose rejection nobody sees', () => {
  assert.deepEqual(unobservedCalls('new Promise(granted => {\n  locks.request(name, () => granted());\n});'), [2]);
  assert.deepEqual(unobservedCalls('root.removeEntry(name);'), [1]);
  for (const observed of [
    'await locks.request(name, async lock => {});',
    'return navigator.storage.getDirectory();',
    'const remove = () => parent.removeEntry(name).catch(() => {});',
    'locks.request(name, options, callback).catch(refused);',
    'const file = await (await folder.getFileHandle(MANIFEST)).getFile();',
  ]) {
    assert.deepEqual(unobservedCalls(observed), [], observed);
  }
});

test('no storage or lock call of the application leaves its promise unobserved', () => {
  const found = [];
  for (const file of sources(path.join(ROOT, 'assets', 'js'))) {
    for (const line of unobservedCalls(withoutComments(readFileSync(file, 'utf8')))) {
      found.push(`${path.relative(ROOT, file)}:${line}`);
    }
  }
  assert.deepEqual(found, [], 'hold a lock with holdLock; await, return or handle every other call');
});
