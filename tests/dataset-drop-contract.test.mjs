import assert from 'node:assert/strict';
import test from 'node:test';

import {
  carriesFiles,
  describeDatasetDrop,
  readDroppedFolder,
} from '../assets/js/app/ui/modules/dataset-drop.js';

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
  const files = await readDroppedFolder(root);
  assert.deepEqual(files.map(file => file.webkitRelativePath), ['big/a', 'big/b']);
  assert.equal(batches, 3);
});
