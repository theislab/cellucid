/**
 * @fileoverview Every file of a folder on this computer, as a folder input
 * lists them: each `File` carries its path below the folder's parent
 * (`webkitRelativePath`, `<folder>/<path inside>`), which is what the folder
 * readers take, and hidden files (`.zgroup`, `.zattrs`, `.zarray`,
 * `.zmetadata`) are listed like any other. The folder is a dropped folder's
 * entry (`FileSystemDirectoryEntry`, every engine: `readFolderEntry`) or a
 * folder's handle (`FileSystemDirectoryHandle`, Chromium: a folder chosen
 * with its folder picker, dropped, or reopened from this browser,
 * `app/library/local-file-handles.js`: `readFolderHandle`).
 *
 * Each file, and each batch of a directory's entries, costs the browser a
 * round trip to its file system (`entry.file()`, `handle.getFile()`,
 * `readEntries`, which answers about 100 entries at a time in Chromium), and
 * the store folder of a large dataset holds 10^5 to 10^6 files. They are
 * asked for concurrently, as many at once as pays, found as a multiplexed
 * link finds its concurrency (`formats/io/link.js`): from one call in
 * flight, doubled while the calls answered per millisecond rise by at least
 * half, then back to the last level that paid, where it stays. Every
 * directory is walked at once. One directory's batches come in turn (its
 * reader answers one call at a time), each before any file still waiting, so
 * a large directory keeps the files to ask for coming while it is listed.
 * The files are returned sorted by path, whatever order they arrived in.
 *
 * What it gains is the engine's (measured on 22,000-file and 6,272-file
 * Zarr folders): WebKit answers each file on a background thread, so its
 * listing takes about 0.73 of the time; Chromium's file system answers one
 * call at a time however many are asked (its handles are the faster way,
 * read where a drop gives one, `ui/modules/dataset-drop.js`); Firefox
 * answers a file in microseconds, with nothing to overlap.
 *
 * @module data/local-folder
 */

import { DataSourceErrorCode, explainedFailure } from './data-source.js';
import { abortReason, onAbort } from '../utils/abort.js';

/**
 * How many calls to have in flight, measured: from one, doubled while the
 * calls completed per millisecond with calls waiting, over a window of two
 * waves at a level, rise by at least half of what doubling could give
 * (`formats/io/link.js`, the same rule for a multiplexed link); when they do
 * not, back to the last level that paid, for good.
 */
export class ConcurrencySearch {
  /** @param {{clock?: () => number}} [options] - `clock`: milliseconds */
  constructor({ clock = () => performance.now() } = {}) {
    this._clock = clock;
    /** Calls to have in flight at once. */
    this.concurrency = 1;
    this._settled = false;
    this._previousRate = null;
    /** When the window at this level began (null: no window), and the calls completed in it. */
    this._since = null;
    this._completed = 0;
  }

  /** Whether the concurrency has stopped changing. */
  get settled() {
    return this._settled;
  }

  /**
   * Calls waiting for a slot (`count`), as the caller sees them each time it
   * starts calls: a level is weighed only while some wait.
   *
   * @param {number} count
   */
  waiting(count) {
    if (this._settled) return;
    if (count > 0) {
      if (this._since === null) {
        this._since = this._clock();
        this._completed = 0;
      }
    } else {
      // The backlog ended before the window filled: that window says nothing.
      this._since = null;
    }
  }

  /** One call completed. */
  completed() {
    if (this._settled || this._since === null) return;
    this._completed++;
    // Two waves of calls at this level: one is too noisy.
    if (this._completed < 2 * this.concurrency) return;
    const rate = this._completed / Math.max(1e-6, this._clock() - this._since);
    this._since = null;
    if (this._previousRate === null || rate >= 1.5 * this._previousRate) {
      this._previousRate = rate;
      this.concurrency *= 2;
    } else {
      // Doubling did not pay: back to the last level that did.
      this.concurrency = Math.max(1, this.concurrency / 2);
      this._settled = true;
    }
  }
}

/** A dropped folder's entries (`FileSystemEntry`). */
const ENTRY_ACCESS = Object.freeze({
  // readEntries() answers in batches until it answers with none.
  batches(directory) {
    const reader = directory.createReader();
    return () => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  },
  isDirectory: entry => entry.isDirectory === true,
  isFile: entry => entry.isFile === true,
  file: entry => new Promise((resolve, reject) => entry.file(resolve, reject)),
});

/** A folder's handles (`FileSystemHandle`): its iterator answers one child at a time. */
const HANDLE_ACCESS = Object.freeze({
  batches(directory) {
    const children = directory.values();
    return async () => {
      const next = await children.next();
      return next.done ? [] : [next.value];
    };
  },
  isDirectory: handle => handle.kind === 'directory',
  isFile: handle => handle.kind === 'file',
  file: handle => handle.getFile(),
});

/** What the browser's refusal to read one entry means, and the failure naming it. */
function unreadable(path, cause) {
  const name = cause?.name ?? '';
  const code = name === 'NotFoundError'
    ? DataSourceErrorCode.FILE_NOT_FOUND
    : name === 'SecurityError' || name === 'NotAllowedError' || name === 'NotReadableError'
      ? DataSourceErrorCode.PERMISSION_DENIED
      : DataSourceErrorCode.FILE_NOT_FOUND;
  const reason = name === 'NotFoundError'
    ? 'it was moved or deleted since the folder was chosen'
    : (typeof cause?.message === 'string' && cause.message !== '' ? cause.message : String(cause));
  const error = explainedFailure(
    `"${path}" could not be read (${reason}). Open the folder again.`,
    code,
    'local-user'
  );
  error.cause = cause;
  return error;
}

/** First in, first out, without moving what waits on every take. */
class TaskQueue {
  constructor() {
    this._tasks = [];
    this._head = 0;
  }

  get size() {
    return this._tasks.length - this._head;
  }

  push(task) {
    this._tasks.push(task);
  }

  take() {
    const task = this._tasks[this._head];
    this._tasks[this._head++] = undefined;
    if (this._head * 2 > this._tasks.length) {
      this._tasks = this._tasks.slice(this._head);
      this._head = 0;
    }
    return task;
  }
}

/**
 * Every file under `root`, sorted by path.
 *
 * @param {Object} root
 * @param {typeof ENTRY_ACCESS} access
 * @param {{signal?: AbortSignal|null, clock?: () => number}} options
 * @returns {Promise<File[]>}
 */
function listFolder(root, access, { signal = null, clock } = {}) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    /** @type {Array<[string, File]>} */
    const listed = [];
    const search = new ConcurrencySearch(clock === undefined ? {} : { clock });
    const batches = new TaskQueue();
    const files = new TaskQueue();
    let running = 0;
    let ended = false;

    // Not aborted yet (checked above): `end` runs only once this is set.
    const stopListening = onAbort(signal, () => end(abortReason(signal)));

    function end(error = null) {
      if (ended) return;
      ended = true;
      stopListening();
      if (error !== null) {
        reject(error);
        return;
      }
      listed.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      resolve(listed.map(([, file]) => file));
    }

    function directory(handle, path) {
      let next = null;
      const readBatch = async () => {
        next ??= access.batches(handle);
        let batch;
        try {
          batch = await next();
        } catch (cause) {
          throw unreadable(path, cause);
        }
        if (batch.length === 0) return;
        for (const child of batch) {
          const childPath = `${path}/${child.name}`;
          if (access.isDirectory(child)) batches.push(directory(child, childPath));
          else if (access.isFile(child)) files.push(fileOf(child, childPath));
        }
        batches.push(readBatch);
      };
      return readBatch;
    }

    function fileOf(handle, path) {
      return () => access.file(handle).then(file => {
        Object.defineProperty(file, 'webkitRelativePath', {
          configurable: true,
          enumerable: true,
          value: path,
        });
        listed.push([path, file]);
      }, cause => {
        throw unreadable(path, cause);
      });
    }

    const settled = () => {
      running--;
      search.completed();
      pump();
    };
    const failed = error => end(error ?? new Error('The folder listing failed.'));

    function pump() {
      if (ended) return;
      while (running < search.concurrency && (batches.size > 0 || files.size > 0)) {
        const task = batches.size > 0 ? batches.take() : files.take();
        running++;
        task().then(settled, failed);
      }
      search.waiting(batches.size + files.size);
      if (running === 0) end();
    }

    batches.push(directory(root, root.name));
    pump();
  });
}

/**
 * Every file under a dropped folder (`FileSystemDirectoryEntry`), sorted by
 * path. `signal` stops it where it is; an entry that cannot be read fails it,
 * named.
 *
 * @param {FileSystemDirectoryEntry} root
 * @param {{signal?: AbortSignal|null, clock?: () => number}} [options]
 * @returns {Promise<File[]>}
 */
export function readFolderEntry(root, options = {}) {
  return listFolder(root, ENTRY_ACCESS, options);
}

/**
 * Every file under a folder's handle (`FileSystemDirectoryHandle`), sorted
 * by path, as `readFolderEntry`.
 *
 * @param {FileSystemDirectoryHandle} root
 * @param {{signal?: AbortSignal|null, clock?: () => number}} [options]
 * @returns {Promise<File[]>}
 */
export function readFolderHandle(root, options = {}) {
  return listFolder(root, HANDLE_ACCESS, options);
}
