/**
 * A file or folder opened from this computer reopens with one click (audit
 * ST-19): where the browser hands the page a handle (Chromium, a page not in
 * a frame), it is kept in IndexedDB under its dataset's id with what it held
 * (a file's size and modification time, a folder's digest of every file's);
 * a reopen asks the browser for leave to read it unless given, and refuses,
 * saying to choose it again with Open…, when leave is refused, when it is
 * gone or when it changed (a gone or changed one is forgotten). The Stored
 * dialog lists and forgets them; a tab notes which local dataset it shows,
 * in its own sessionStorage, so its reload can offer it. Browsers without
 * handles keep and offer nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { isExplainedFailure } from '../assets/js/data/data-source.js';
import {
  forgetLocalFiles,
  heldBy,
  keepLocalFile,
  keptLocalFile,
  listLocalFiles,
  localHandlesAvailable,
  onLocalFilesChange,
  readKeptLocalFile,
  readPermissionOf,
  rememberTabDataset,
  tabLocalDataset,
} from '../assets/js/app/local-file-handles.js';

function mapStore() {
  const map = new Map();
  return {
    map,
    get: async key => map.get(key),
    // Handles are structured-cloneable; a fake one is kept as it is.
    put: async (key, value) => { map.set(key, value); },
    delete: async key => { map.delete(key); },
    entries: async () => [...map].map(([key, value]) => ({ key, value })),
  };
}

/** A file handle over `file()`, its permission `state` and what a request answers. */
function fileHandle(name, file, { state = 'granted', answer = 'granted' } = {}) {
  const handle = {
    kind: 'file',
    name,
    requests: 0,
    state,
    async queryPermission({ mode }) {
      assert.equal(mode, 'read');
      return handle.state;
    },
    async requestPermission({ mode }) {
      assert.equal(mode, 'read');
      handle.requests++;
      handle.state = answer;
      return answer;
    },
    getFile: async () => file(),
  };
  return handle;
}

function folderHandle(name, files, permission = {}) {
  const handle = fileHandle(name, null, permission);
  handle.kind = 'directory';
  delete handle.getFile;
  handle.values = async function* values() {
    for (const [fileName, file] of Object.entries(files())) {
      yield { kind: 'file', name: fileName, getFile: async () => file };
    }
  };
  return handle;
}

const T0 = 1_700_000_000_000;
const fileOf = (name, size, lastModified = T0) => new File([new Uint8Array(size)], name, { lastModified });

test('handles are kept only where the browser gives them: Chromium pickers, not in a frame, with IndexedDB', () => {
  const view = { showOpenFilePicker() {}, showDirectoryPicker() {}, indexedDB: {} };
  view.top = view;
  assert.equal(localHandlesAvailable(view), true);
  assert.equal(localHandlesAvailable({ ...view, top: view }), false, 'a page inside a frame');
  const firefox = { indexedDB: {} };
  firefox.top = firefox;
  assert.equal(localHandlesAvailable(firefox), false);
  assert.equal(localHandlesAvailable(globalThis), false);
  assert.equal(localHandlesAvailable(null), false);
});

test('a file is kept under its dataset\'s id with its size and modification time, and read again as it was', async () => {
  const store = mapStore();
  const heard = [];
  const stop = onLocalFilesChange(() => heard.push('changed'));
  try {
    const file = fileOf('cells.h5ad', 12);
    const handle = fileHandle('cells.h5ad', () => file);
    assert.equal(await keepLocalFile('h5ad_cells_1a2b3c4d', { handle: Promise.resolve(handle), files: [file], kind: 'file' }, store), true);
    const record = await keptLocalFile('h5ad_cells_1a2b3c4d', store);
    assert.equal(record.kind, 'file');
    assert.equal(record.name, 'cells.h5ad');
    assert.deepEqual(record.held, { size: 12, lastModified: T0 });
    assert.equal(record.handle, handle);
    assert.equal(heard.length, 1);
    assert.equal(await readPermissionOf(record), 'granted');
    const files = await readKeptLocalFile('h5ad_cells_1a2b3c4d', record, { store });
    assert.equal(files.length, 1);
    assert.equal(files[0], file);
    assert.equal(handle.requests, 0, 'leave already given is not asked again');
  } finally {
    stop();
  }
});

test('a handle that is not of what was read, or cannot be asked about, is not kept', async () => {
  const store = mapStore();
  const file = fileOf('cells.zarr', 0);
  // A dropped folder whose item the browser handed as a file.
  assert.equal(await keepLocalFile('x', { handle: fileHandle('cells.zarr', () => file), files: [file], kind: 'folder' }, store), false);
  assert.equal(await keepLocalFile('x', { handle: Promise.resolve(null), files: [file], kind: 'file' }, store), false);
  assert.equal(await keepLocalFile('x', { handle: Promise.reject(new Error('no handle')), files: [file], kind: 'file' }, store), false);
  assert.equal(await keepLocalFile('x', { handle: { kind: 'file', name: 'a' }, files: [file], kind: 'file' }, store), false);
  assert.equal(await keepLocalFile('x', { handle: fileHandle('a', () => file), files: [file] , kind: 'file' }, null), false);
  assert.equal(store.map.size, 0);
});

test('a reopen asks for leave inside the click; refused, it says to choose the file again and keeps the handle', async () => {
  const store = mapStore();
  const file = fileOf('cells.h5ad', 3);
  const handle = fileHandle('cells.h5ad', () => file, { state: 'prompt', answer: 'denied' });
  await keepLocalFile('id', { handle, files: [file], kind: 'file' }, store);
  const record = await keptLocalFile('id', store);
  assert.equal(await readPermissionOf(record), 'prompt');
  await assert.rejects(readKeptLocalFile('id', record, { store }), error => {
    assert.equal(isExplainedFailure(error), true);
    assert.equal(error.details.reopen, 'refused');
    assert.equal(error.message, 'Reading "cells.h5ad" was not allowed. Choose it with Open… › File… to open it.');
    return true;
  });
  assert.equal(handle.requests, 1);
  assert.notEqual(await keptLocalFile('id', store), null);

  const allowed = fileHandle('cells.h5ad', () => file, { state: 'prompt', answer: 'granted' });
  await keepLocalFile('id', { handle: allowed, files: [file], kind: 'file' }, store);
  assert.deepEqual(await readKeptLocalFile('id', await keptLocalFile('id', store), { store }), [file]);
  assert.equal(allowed.requests, 1);
});

test('a file gone or changed since is not reopened under its dataset\'s name, and is forgotten', async () => {
  const store = mapStore();
  let current = fileOf('cells.h5ad', 3);
  const handle = fileHandle('cells.h5ad', () => {
    if (current === null) throw new DOMException('A requested file or directory could not be found.', 'NotFoundError');
    return current;
  });
  await keepLocalFile('id', { handle, files: [current], kind: 'file' }, store);
  current = fileOf('cells.h5ad', 3, T0 + 1000);
  await assert.rejects(readKeptLocalFile('id', await keptLocalFile('id', store), { store }), error => {
    assert.equal(error.details.reopen, 'changed');
    assert.equal(error.message, '"cells.h5ad" changed since it was opened here. Choose it with Open… › File… to open it as it is now.');
    return true;
  });
  assert.equal(await keptLocalFile('id', store), null);

  await keepLocalFile('id', { handle, files: [current], kind: 'file' }, store);
  current = null;
  await assert.rejects(readKeptLocalFile('id', await keptLocalFile('id', store), { store }), error => {
    assert.equal(error.details.reopen, 'gone');
    assert.match(error.message, /^"cells\.h5ad" is no longer where it was opened from \(moved, renamed or deleted\)\. Choose it with Open… › File… where it is now\.$/);
    assert.equal(error.cause.name, 'NotFoundError');
    return true;
  });
  assert.equal(await keptLocalFile('id', store), null);
});

test('a folder is kept with the digest of every file\'s path, size and time, and refused when any of them changed', async () => {
  const store = mapStore();
  const at = (name, size, time = T0) => {
    const file = fileOf(name, size, time);
    Object.defineProperty(file, 'webkitRelativePath', { value: `cells.zarr/${name}` });
    return file;
  };
  let contents = { '.zgroup': fileOf('.zgroup', 1), '.zmetadata': fileOf('.zmetadata', 9) };
  const handle = folderHandle('cells.zarr', () => contents);
  // As a picked folder lists them: in any order.
  const picked = [at('.zmetadata', 9), at('.zgroup', 1)];
  assert.equal(await keepLocalFile('zarr_cells', { handle, files: picked, kind: 'folder' }, store), true);
  const record = await keptLocalFile('zarr_cells', store);
  assert.equal(record.kind, 'folder');
  assert.equal(record.held.files, 2);
  assert.deepEqual(record.held, await heldBy('folder', [at('.zgroup', 1), at('.zmetadata', 9)]));
  const files = await readKeptLocalFile('zarr_cells', record, { store });
  assert.deepEqual(files.map(file => file.webkitRelativePath), ['cells.zarr/.zgroup', 'cells.zarr/.zmetadata']);

  contents = { ...contents, '.zmetadata': fileOf('.zmetadata', 10) };
  await assert.rejects(readKeptLocalFile('zarr_cells', record, { store }), error => {
    assert.equal(error.details.reopen, 'changed');
    assert.match(error.message, /Choose it with Open… › Folder… to open it as it is now\.$/);
    return true;
  });
  assert.equal(await keptLocalFile('zarr_cells', store), null);
});

test('the kept files are listed, most recently opened first, and forgotten by key or all at once', async () => {
  const store = mapStore();
  const file = fileOf('a.h5ad', 1);
  await keepLocalFile('a', { handle: fileHandle('a.h5ad', () => file), files: [file], kind: 'file' }, store);
  store.map.get('a').openedAt = T0;
  await keepLocalFile('b', { handle: folderHandle('b.zarr', () => ({})), files: [], kind: 'folder' }, store);
  store.map.get('b').openedAt = T0 + 1;
  // Records of another layout, or values that are not records, are not listed.
  store.map.set('c', { version: 99 });
  assert.deepEqual(await listLocalFiles(store), [
    { key: 'b', name: 'b.zarr', kind: 'folder', openedAt: T0 + 1 },
    { key: 'a', name: 'a.h5ad', kind: 'file', openedAt: T0 },
  ]);
  assert.equal(await keptLocalFile('c', store), null);
  assert.equal(await forgetLocalFiles(['a'], store), 1);
  assert.deepEqual((await listLocalFiles(store)).map(entry => entry.key), ['b']);
  assert.equal(await forgetLocalFiles(null, store), 2);
  assert.deepEqual(await listLocalFiles(store), []);
  assert.deepEqual(await listLocalFiles(null), []);
  const failing = { ...mapStore(), entries: async () => { throw new Error('blocked'); } };
  assert.deepEqual(await listLocalFiles(failing), []);
  assert.equal(await forgetLocalFiles(null, failing), 0);
});

test('a tab notes the local dataset it shows, in its own storage, and forgets it when another is shown', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  assert.equal(tabLocalDataset(storage), null);
  rememberTabDataset({ sourceType: 'local-user', datasetId: 'h5ad_cells_1a2b3c4d' }, storage);
  assert.equal(tabLocalDataset(storage), 'h5ad_cells_1a2b3c4d');
  rememberTabDataset({ sourceType: 'local-demo', datasetId: 'suo' }, storage);
  assert.equal(tabLocalDataset(storage), null);
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
  rememberTabDataset({ sourceType: 'local-user', datasetId: 'x' }, blocked);
  assert.equal(tabLocalDataset(blocked), null);
  assert.equal(tabLocalDataset(null), null);
});
