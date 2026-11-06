/**
 * @fileoverview The files and folders opened from this computer, kept as the
 * browser's handles, so that a reload, or a session saved on one, reopens it
 * with one click instead of the file dialog.
 *
 * - **Kept**: where the browser hands the page a handle — Chromium-based
 *   browsers, in a page that is not inside a frame: a file or folder chosen
 *   with Open… (its pickers, `showOpenFilePicker` and `showDirectoryPicker`)
 *   or dropped (`getAsFileSystemHandle`) — once its dataset opened, in this
 *   browser's IndexedDB under the dataset's id: the handle (the browser's
 *   reference to the file, usable by this site in this browser only), its
 *   name, whether it is a file or a folder, what it held (a file's size and
 *   modification time; a folder's file count and a digest of every file's
 *   path, size and modification time) and when it was opened. No path is
 *   written, and nothing of the content.
 * - **Reopened**: the person's click asks the browser for leave to read it
 *   (`requestPermission`, which needs that click; asked only when not
 *   already given), then the file, or the folder's files, are read as a
 *   picked one's. One that is gone, or changed since (its size or
 *   modification time, a folder's any file's), is not reopened under that
 *   dataset's name: the failure says to choose it again with Open…, and the
 *   handle is forgotten (`readKeptLocalFile`).
 * - **Listed**: by My datasets, as the datasets they open
 *   (`my-datasets.js`, which forgets a dataset's handle with it); the Stored
 *   dialog counts them in My datasets' row and forgets them with the list
 *   (`listLocalFiles`, `forgetLocalFiles`, `onLocalFilesChange`).
 * - **This tab's**: which local dataset this tab shows is in its
 *   sessionStorage, so its reload knows what to offer (`rememberTabDataset`,
 *   `tabLocalDataset`); never in the address.
 * - Elsewhere (Firefox, Safari, a page in a frame) no handle is given:
 *   nothing is kept, offered or said. Every storage failure only means no
 *   handle is kept.
 *
 * @module app/library/local-file-handles
 */

import { DataSourceErrorCode, explainedFailure } from '../../data/data-source.js';
import { readFolderHandle } from '../../data/local-folder.js';
import { indexedDbKeyValueStore } from '../../utils/indexed-db-store.js';
import { whileWaitingOnPerson } from '../../utils/person-wait.js';
import { isCancellation } from '../../utils/abort.js';

const DB_NAME = 'cellucid-local-files';
const STORE_NAME = 'handles';
/** The layout of a kept handle's record. */
const RECORD_VERSION = 1;
/** This tab's local dataset, in its sessionStorage. */
const TAB_KEY = 'cellucid:tab-local-dataset';

/**
 * @typedef {{version: number, kind: 'file'|'folder', name: string, handle: FileSystemHandle,
 *   held: {size: number, lastModified: number}|{files: number, digest: string}, openedAt: number}} KeptLocalFile
 */

/**
 * Whether this page is given handles of what is picked or dropped, to keep:
 * a page that is not inside a frame, in a browser with the file pickers and
 * IndexedDB (Chromium-based browsers).
 *
 * @param {Window|typeof globalThis|null} [view]
 * @returns {boolean}
 */
export function localHandlesAvailable(view = globalThis) {
  return typeof view?.showOpenFilePicker === 'function'
    && typeof view.showDirectoryPicker === 'function'
    && view.top === view
    && view.indexedDB != null;
}

/** The page's handle store, opened once (null without IndexedDB). */
let pageStore;
function defaultStore() {
  if (pageStore === undefined) pageStore = indexedDbKeyValueStore(DB_NAME, STORE_NAME);
  return pageStore;
}

/** Whoever lists the handles hears when one is kept or forgotten (`onLocalFilesChange`). */
const listeners = new Set();

/**
 * Hear when a handle is kept or forgotten in this page (My datasets, the
 * Stored dialog). Returns what stops it.
 *
 * @param {() => void} listener
 * @returns {() => void}
 */
export function onLocalFilesChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A listener's failure is its own.
    }
  }
}

function pathOf(file) {
  return typeof file?.webkitRelativePath === 'string' && file.webkitRelativePath !== ''
    ? file.webkitRelativePath
    : String(file?.name ?? '');
}

/**
 * What a file or folder held when it was read: a file's size and
 * modification time; a folder's file count and the SHA-256 of every file's
 * path, size and modification time, a line each in path order (a folder of
 * 10^6 files takes about 0.4 s, measured in Node).
 *
 * @param {'file'|'folder'} kind
 * @param {ArrayLike<File>} files
 * @returns {Promise<KeptLocalFile['held']>}
 */
export async function heldBy(kind, files) {
  const list = Array.from(files);
  if (kind === 'file') return { size: list[0].size, lastModified: list[0].lastModified };
  // A path never holds U+0000, so each line reads back one way.
  const lines = list.map(file => `${pathOf(file)}\u0000${file.size}\u0000${file.lastModified}`).sort();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lines.join('\n'))));
  return { files: lines.length, digest: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') };
}

function sameHeld(a, b) {
  return Object.keys(b).length === Object.keys(a).length && Object.keys(b).every(key => a[key] === b[key]);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && value.version === RECORD_VERSION
    && (value.kind === 'file' || value.kind === 'folder') && typeof value.name === 'string'
    && typeof value.handle?.queryPermission === 'function' && value.held !== null && typeof value.held === 'object';
}

/**
 * Keep the handle of the file or folder the dataset `datasetId` was opened
 * from (`files`: what was read of it). A handle that is not of what was
 * read (another kind), or that the browser cannot be asked about, is not
 * kept. Resolves whether it was kept; never throws.
 *
 * @param {string} datasetId
 * @param {{handle: FileSystemHandle|Promise<FileSystemHandle|null>|null, files: ArrayLike<File>, kind: 'file'|'folder'}} opened
 * @param {import('../../utils/indexed-db-store.js').KeyValueStore|null} [store]
 * @returns {Promise<boolean>}
 */
export async function keepLocalFile(datasetId, { handle, files, kind }, store = defaultStore()) {
  if (store === null || typeof datasetId !== 'string' || datasetId === '') return false;
  try {
    const resolved = await handle;
    if (resolved?.kind !== (kind === 'folder' ? 'directory' : 'file')
      || typeof resolved.queryPermission !== 'function'
      || typeof resolved.requestPermission !== 'function'
      || (kind === 'file' && files.length !== 1)) {
      return false;
    }
    await store.put(datasetId, {
      version: RECORD_VERSION,
      kind,
      name: resolved.name,
      handle: resolved,
      held: await heldBy(kind, files),
      openedAt: Date.now(),
    });
  } catch {
    return false;
  }
  announce();
  return true;
}

/**
 * The handle kept for the dataset `datasetId`, or null; never throws.
 *
 * @param {string} datasetId
 * @param {import('../../utils/indexed-db-store.js').KeyValueStore|null} [store]
 * @returns {Promise<KeptLocalFile|null>}
 */
export async function keptLocalFile(datasetId, store = defaultStore()) {
  if (store === null || typeof datasetId !== 'string') return null;
  try {
    const record = await store.get(datasetId);
    return isRecord(record) ? record : null;
  } catch {
    return null;
  }
}

/**
 * Whether the browser lets the page read a kept file or folder now: without
 * asking (`granted`: chosen or dropped in this page, or allowed on every
 * visit), only by asking the person (`prompt`), or not (`denied`).
 *
 * @param {KeptLocalFile} record
 * @returns {Promise<'granted'|'prompt'|'denied'>}
 */
export async function readPermissionOf(record) {
  try {
    return await record.handle.queryPermission({ mode: 'read' });
  } catch {
    return 'denied';
  }
}

/** The failure of a reopen, saying why and what to do: choose it again. */
function reopenFailure(reason, record, cause = null) {
  const choose = `Choose it with Open… › ${record.kind === 'folder' ? 'Folder…' : 'File…'}`;
  const said = {
    refused: [`Reading "${record.name}" was not allowed. ${choose} to open it.`, DataSourceErrorCode.PERMISSION_DENIED],
    gone: [`"${record.name}" is no longer where it was opened from (moved, renamed or deleted). ${choose} where it is now.`, DataSourceErrorCode.FILE_NOT_FOUND],
    changed: [`"${record.name}" changed since it was opened here. ${choose} to open it as it is now.`, DataSourceErrorCode.VALIDATION_ERROR],
  }[reason];
  const error = explainedFailure(said[0], said[1], 'local-user', { reopen: reason });
  if (cause !== null) error.cause = cause;
  return error;
}

/**
 * Read a kept file or folder again for its dataset `datasetId`: ask the
 * browser for leave to read it unless given (inside the person's click: the
 * browser asks only then), then its file, or the folder's every file
 * (`readFolderHandle`). Fails, saying to choose it again with Open…, when
 * leave is refused, when it is gone, or when it changed since it was kept;
 * a gone or changed one's handle is forgotten.
 *
 * @param {string} datasetId
 * @param {KeptLocalFile} record
 * @param {{signal?: AbortSignal|null, store?: import('../../utils/indexed-db-store.js').KeyValueStore|null}} [options]
 * @returns {Promise<File[]>}
 */
export async function readKeptLocalFile(datasetId, record, { signal = null, store = defaultStore() } = {}) {
  if (await readPermissionOf(record) !== 'granted') {
    let answer;
    try {
      answer = await whileWaitingOnPerson(Promise.resolve(record.handle.requestPermission({ mode: 'read' })));
    } catch {
      answer = 'denied';
    }
    if (answer !== 'granted') throw reopenFailure('refused', record);
  }
  let files;
  try {
    files = record.kind === 'file'
      ? [await record.handle.getFile()]
      : await readFolderHandle(record.handle, { signal });
  } catch (cause) {
    if (signal?.aborted || isCancellation(cause)) throw cause;
    await forgetLocalFiles([datasetId], store);
    throw reopenFailure('gone', record, cause);
  }
  if (!sameHeld(await heldBy(record.kind, files), record.held)) {
    await forgetLocalFiles([datasetId], store);
    throw reopenFailure('changed', record);
  }
  return files;
}

/**
 * Every kept handle, most recently opened first: `key` (its dataset's id,
 * what `forgetLocalFiles` takes), its file's or folder's `name`, its `kind`
 * and when it was last opened. Empty without IndexedDB; never throws.
 *
 * @param {import('../../utils/indexed-db-store.js').KeyValueStore|null} [store]
 * @returns {Promise<Array<{key: string, name: string, kind: 'file'|'folder', openedAt: number}>>}
 */
export async function listLocalFiles(store = defaultStore()) {
  if (store === null) return [];
  let entries;
  try {
    entries = await store.entries();
  } catch {
    return [];
  }
  return entries
    .filter(({ key, value }) => typeof key === 'string' && isRecord(value))
    .map(({ key, value }) => ({
      key,
      name: value.name,
      kind: value.kind,
      openedAt: Number.isFinite(value.openedAt) ? value.openedAt : 0,
    }))
    .sort((a, b) => b.openedAt - a.openedAt || (a.key < b.key ? -1 : 1));
}

/**
 * Forget the handles of the datasets `keys` (null: every one). Resolves to
 * how many were forgotten; never throws.
 *
 * @param {Iterable<string>|null} keys
 * @param {import('../../utils/indexed-db-store.js').KeyValueStore|null} [store]
 * @returns {Promise<number>}
 */
export async function forgetLocalFiles(keys, store = defaultStore()) {
  if (store === null) return 0;
  let forgotten = 0;
  try {
    const wanted = keys === null ? (await store.entries()).map(entry => entry.key) : [...keys];
    for (const key of wanted) {
      await store.delete(key);
      forgotten++;
    }
  } catch {
    // What could not be forgotten stays listed.
  }
  if (forgotten > 0) announce();
  return forgotten;
}

function tabStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Note which dataset this tab shows, when it is one opened from this
 * computer (its id), so a reload of the tab can offer it back; any other
 * clears the note. Never throws.
 *
 * @param {{sourceType: string|null, datasetId: string|null}} shown
 * @param {Storage|null} [storage]
 */
export function rememberTabDataset({ sourceType, datasetId }, storage = tabStorage()) {
  try {
    if (sourceType === 'local-user' && typeof datasetId === 'string' && datasetId !== '') {
      storage?.setItem(TAB_KEY, datasetId);
    } else {
      storage?.removeItem(TAB_KEY);
    }
  } catch {
    // No note: a reload offers nothing.
  }
}

/**
 * The id of the dataset opened from this computer that this tab showed
 * last, before it was reloaded; null when it showed another. Never throws.
 *
 * @param {Storage|null} [storage]
 * @returns {string|null}
 */
export function tabLocalDataset(storage = tabStorage()) {
  try {
    const value = storage?.getItem(TAB_KEY) ?? null;
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}
