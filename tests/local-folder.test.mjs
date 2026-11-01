/**
 * A folder of this computer is listed concurrently (audit ST-9): as many
 * calls in flight as pays, found by doubling while the calls answered per
 * millisecond rise by at least half, then back to the last level that paid;
 * every directory walked at once, one directory's batches in turn; the files
 * returned sorted by path whatever order they arrived in; Cancel stops it;
 * an entry that cannot be read fails it, named. A dropped folder's entries
 * and a folder's handle are listed alike.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { isExplainedFailure } from '../assets/js/data/data-source.js';
import { ConcurrencySearch, readFolderEntry, readFolderHandle } from '../assets/js/data/local-folder.js';

const later = (ms, value) => new Promise(resolve => setTimeout(() => resolve(value), ms));

/**
 * A dropped folder's entry over `tree` ({name: tree|bytes}), whose calls
 * answer after `delay(path)` ms; `calls` records what is in flight.
 */
function folderEntry(name, tree, { delay = () => 0, batch = 100, calls = { inFlight: 0, most: 0, files: 0, listings: new Map() } } = {}) {
  const enter = () => {
    calls.inFlight++;
    calls.most = Math.max(calls.most, calls.inFlight);
  };
  const leave = () => { calls.inFlight--; };
  const entryOf = (entryName, value, path) => {
    if (value instanceof Uint8Array) {
      return {
        isFile: true,
        isDirectory: false,
        name: entryName,
        file(ok, fail) {
          enter();
          calls.files++;
          later(delay(path)).then(() => {
            leave();
            if (value.length === 0) fail(new DOMException('A requested file or directory could not be found.', 'NotFoundError'));
            else ok(new File([value], entryName));
          });
        },
      };
    }
    return {
      isFile: false,
      isDirectory: true,
      name: entryName,
      createReader() {
        const children = Object.entries(value).map(([childName, child]) => entryOf(childName, child, `${path}/${childName}`));
        let at = 0;
        let pending = false;
        return {
          readEntries(ok) {
            // A reader answers one call at a time.
            assert.equal(pending, false, `${path} was asked for two batches at once`);
            pending = true;
            enter();
            calls.listings.set(path, (calls.listings.get(path) ?? 0) + 1);
            later(delay(path)).then(() => {
              pending = false;
              leave();
              ok(children.slice(at, at + batch));
              at += batch;
            });
          },
        };
      },
    };
  };
  return entryOf(name, tree, name);
}

const bytes = n => new Uint8Array(n).fill(1);

test('the files come back sorted by path, each with its path, whatever order they arrive in', async () => {
  const tree = { '.zgroup': bytes(1), X: { '.zarray': bytes(1) }, obs: {} };
  for (let i = 0; i < 300; i++) tree.X[`${i}.0`] = bytes(2);
  for (let i = 0; i < 40; i++) tree.obs[`c${i}`] = { '.zarray': bytes(1), 0: bytes(3) };
  // Later files answer first.
  const root = folderEntry('cells.zarr', tree, { delay: path => (path.length * 7) % 5 });
  const files = await readFolderEntry(root);
  const paths = files.map(file => file.webkitRelativePath);
  assert.equal(paths.length, 2 + 300 + 80);
  assert.deepEqual(paths, [...paths].sort());
  assert.ok(paths.includes('cells.zarr/.zgroup'));
  assert.ok(paths.includes('cells.zarr/obs/c7/.zarray'));
  assert.equal(files.find(file => file.webkitRelativePath === 'cells.zarr/X/12.0').size, 2);
});

test('calls in flight double while the calls answered per millisecond rise by half, then settle on the last level that paid', () => {
  // A disk that answers up to eight calls at once in 1 ms each: at level c,
  // a call is answered every 1 / min(c, 8) ms.
  let now = 0;
  const search = new ConcurrencySearch({ clock: () => now });
  const levels = [search.concurrency];
  for (let i = 0; i < 10_000 && !search.settled; i++) {
    search.waiting(100);
    now += 1 / Math.min(search.concurrency, 8);
    search.completed();
    if (search.concurrency !== levels.at(-1)) levels.push(search.concurrency);
  }
  assert.deepEqual(levels, [1, 2, 4, 8, 16, 8]);
  assert.equal(search.settled, true);
  // A window with no backlog says nothing.
  const idle = new ConcurrencySearch({ clock: () => now });
  idle.waiting(0);
  for (let i = 0; i < 10; i++) idle.completed();
  assert.equal(idle.concurrency, 1);
});

test('slow calls run concurrently, every directory walked at once, one directory\'s batches in turn', async () => {
  const calls = { inFlight: 0, most: 0, files: 0, listings: new Map() };
  const tree = {};
  for (let d = 0; d < 32; d++) {
    tree[`d${d}`] = {};
    for (let i = 0; i < 150; i++) tree[`d${d}`][`f${i}`] = bytes(1);
  }
  const root = folderEntry('wide', tree, { delay: () => 2, batch: 100, calls });
  const files = await readFolderEntry(root);
  assert.equal(files.length, 32 * 150);
  assert.ok(calls.most > 1, `at most ${calls.most} call in flight`);
  // Each directory of 150 entries answered two batches and the empty one.
  for (let d = 0; d < 32; d++) assert.equal(calls.listings.get(`wide/d${d}`), 3);
});

test('Cancel stops the listing where it is', async () => {
  const calls = { inFlight: 0, most: 0, files: 0, listings: new Map() };
  const tree = {};
  for (let i = 0; i < 2000; i++) tree[`f${i}`] = bytes(1);
  const root = folderEntry('big', tree, { delay: () => 1, calls });
  const stop = new AbortController();
  const listing = readFolderEntry(root, { signal: stop.signal });
  await later(15);
  stop.abort();
  await assert.rejects(listing, error => error.name === 'AbortError');
  const asked = calls.files;
  await later(20);
  assert.ok(asked < 2000, `${asked} files were asked for before Cancel`);
  // Nothing more is asked for once stopped.
  assert.ok(calls.files - asked <= calls.most);
  await assert.rejects(readFolderEntry(root, { signal: stop.signal }), error => error.name === 'AbortError');
});

test('an entry that cannot be read fails the listing, naming it', async () => {
  const root = folderEntry('cells.zarr', { X: { '0.0': bytes(1), '1.0': new Uint8Array(0) } });
  await assert.rejects(readFolderEntry(root), error => {
    assert.equal(isExplainedFailure(error), true);
    assert.match(error.message, /^"cells\.zarr\/X\/1\.0" could not be read \(it was moved or deleted since the folder was chosen\)\. Open the folder again\.$/);
    assert.equal(error.cause.name, 'NotFoundError');
    return true;
  });
});

test('a folder\'s handle is listed as a dropped folder\'s entry is', async () => {
  const fileHandle = (name, size) => ({ kind: 'file', name, getFile: async () => new File([bytes(size)], name) });
  const directoryHandle = (name, children) => ({
    kind: 'directory',
    name,
    async *values() {
      for (const child of children) {
        await later(0);
        yield child;
      }
    },
  });
  const root = directoryHandle('cells.zarr', [
    fileHandle('.zmetadata', 4),
    directoryHandle('obs', [fileHandle('.zattrs', 1), directoryHandle('cell_type', [fileHandle('0', 2)])]),
    fileHandle('.zgroup', 1),
  ]);
  const files = await readFolderHandle(root);
  assert.deepEqual(files.map(file => file.webkitRelativePath), [
    'cells.zarr/.zgroup',
    'cells.zarr/.zmetadata',
    'cells.zarr/obs/.zattrs',
    'cells.zarr/obs/cell_type/0',
  ]);
});
