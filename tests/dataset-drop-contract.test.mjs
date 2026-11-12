import assert from 'node:assert/strict';
import test from 'node:test';

import {
  carriesFiles,
  describeDatasetDrop,
} from '../assets/js/app/ui/modules/dataset-drop.js';
import { readFolderEntry } from '../assets/js/data/local-folder.js';
import { cellucidFileOfName } from '../assets/js/data/input-formats.js';

function fileItem(name, entry = null) {
  const file = new File([new Uint8Array([1])], name);
  return {
    kind: 'file',
    getAsFile: () => file,
    webkitGetAsEntry: () => entry,
  };
}

function directoryEntry(name, children) {
  return {
    isDirectory: true,
    isFile: false,
    name,
    createReader() {
      let listed = false;
      return {
        readEntries(ok) {
          ok(listed ? [] : children);
          listed = true;
        },
      };
    },
  };
}

function fileEntry(name) {
  const file = new File([new Uint8Array([2])], name);
  return { isDirectory: false, isFile: true, name, file: ok => ok(file) };
}

function transfer(items) {
  return { items, files: [], types: ['Files'] };
}

test('only drags that carry files are the drop target\'s', () => {
  assert.equal(carriesFiles({ types: ['Files'] }), true);
  assert.equal(carriesFiles({ types: ['text/plain'] }), false);
  assert.equal(carriesFiles(null), false);
});

test('one H5AD file, one Zarr ZIP or one Zarr folder is opened by its own reader', async () => {
  const h5ad = describeDatasetDrop(transfer([fileItem('Cells.H5AD')]));
  assert.equal(h5ad.kind, 'file');
  assert.equal(h5ad.label, 'Cells.H5AD');
  assert.equal((await h5ad.readFiles())[0].name, 'Cells.H5AD');

  const zarr = describeDatasetDrop(transfer([fileItem('cells.zarr.zip')]));
  assert.equal(zarr.kind, 'zip');

  // A folder is read as an AnnData Zarr store, hidden metadata files and all.
  const folder = describeDatasetDrop(transfer([
    fileItem('cells.zarr', directoryEntry('cells.zarr', [
      fileEntry('.zgroup'),
      fileEntry('.zmetadata'),
      directoryEntry('obs', [fileEntry('.zattrs')]),
    ])),
  ]));
  assert.equal(folder.kind, 'folder');
  assert.equal(folder.label, 'cells.zarr');
  const files = await folder.readFiles();
  assert.deepEqual(
    files.map(file => file.webkitRelativePath).sort(),
    ['cells.zarr/.zgroup', 'cells.zarr/.zmetadata', 'cells.zarr/obs/.zattrs'],
  );
});

test('anything else is refused with a message that says what can be dropped', () => {
  for (const [items, pattern] of [
    [[], /Nothing that can be opened was dropped/],
    [[fileItem('a.h5ad'), fileItem('b.h5ad')], /2 items were dropped/],
    [[fileItem('notes.txt')], /"notes\.txt" is not a file Cellucid can open\. Drop one \.h5ad file, one \.loom file, .*one \.zarr folder, one Cell Ranger outs\/ folder, .*or one \.zarr\.zip archive\./],
  ]) {
    const drop = describeDatasetDrop(transfer(items));
    assert.equal(drop.kind, 'refused');
    assert.match(drop.message, pattern);
  }
});

test('a folder is listed across every batch its reader answers', async () => {
  let batches = 0;
  const root = {
    isDirectory: true,
    isFile: false,
    name: 'big',
    createReader() {
      return {
        readEntries(ok) {
          batches += 1;
          ok(batches === 1 ? [fileEntry('a')] : batches === 2 ? [fileEntry('b')] : []);
        },
      };
    },
  };
  const files = await readFolderEntry(root);
  assert.deepEqual(files.map(file => file.webkitRelativePath), ['big/a', 'big/b']);
  assert.equal(batches, 3);
});

test('a dropped folder is read through its handle where the drop gives one, else through its entries', async () => {
  const handleOf = (name, children) => ({
    kind: 'directory',
    name,
    async *values() {
      for (const [childName, size] of children) {
        yield { kind: 'file', name: childName, getFile: async () => new File([new Uint8Array(size)], childName) };
      }
    },
  });
  const entry = directoryEntry('cells.zarr', [fileEntry('.zgroup')]);
  const item = (handle) => ({
    kind: 'file',
    getAsFile: () => new File([], 'cells.zarr'),
    webkitGetAsEntry: () => entry,
    getAsFileSystemHandle: () => Promise.resolve(handle),
  });
  // Chromium: the handle, asked for inside the drop event.
  const withHandle = describeDatasetDrop(transfer([item(handleOf('cells.zarr', [['.zgroup', 1], ['.zmetadata', 2]]))]));
  assert.equal(withHandle.kind, 'folder');
  assert.equal((await withHandle.handle).kind, 'directory');
  assert.deepEqual(
    (await withHandle.readFiles()).map(file => file.webkitRelativePath),
    ['cells.zarr/.zgroup', 'cells.zarr/.zmetadata'],
  );
  // A synthetic drop's item answers no handle (Chromium resolves undefined): its entries.
  const without = describeDatasetDrop(transfer([item(undefined)]));
  assert.equal(await without.handle, null);
  assert.deepEqual((await without.readFiles()).map(file => file.webkitRelativePath), ['cells.zarr/.zgroup']);
  // A browser without handles: none asked for.
  const plain = describeDatasetDrop(transfer([fileItem('cells.zarr', entry)]));
  assert.equal(plain.handle, null);
});

test('a library file dropped goes to My datasets\' Import; a session file goes to its load (L25-8)', () => {
  const library = describeDatasetDrop(transfer([fileItem('Backup.cellucid-library')]));
  assert.equal(library.kind, 'library');
  assert.equal(library.label, 'Backup.cellucid-library');
  assert.equal(library.file.name, 'Backup.cellucid-library');
  const session = describeDatasetDrop(transfer([fileItem('cellucid-session-2026.cellucid-session')]));
  assert.equal(session.kind, 'session');
  assert.equal(session.label, 'cellucid-session-2026.cellucid-session');
  assert.equal(session.file.name, 'cellucid-session-2026.cellucid-session');
});
