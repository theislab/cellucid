/**
 * The origin-private file system and Web Locks a dedicated worker (or a
 * page) has, for Node: directories and files on disk under one temporary
 * folder, files written through synchronous access handles (a worker) or
 * writable streams (a page), and shared/exclusive locks with `ifAvailable`. Enough for the transcode space
 * (`assets/js/data/anndata/transcode/space.js`) to run as it does in a
 * browser.
 */
import { closeSync, mkdirSync, mkdtempSync, openAsBlob, openSync, readdirSync, readSync, rmSync, statSync, writeSync, ftruncateSync, fsyncSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function notFound(name) {
  return new DOMException(`'${name}' was not found.`, 'NotFoundError');
}

/** A writable stream over one file, as a page's `createWritable()` gives. */
function writableStream(file) {
  const fd = openSync(file, 'r+');
  ftruncateSync(fd, 0);
  let at = 0;
  let closed = false;
  return {
    async write(data) {
      const view = data instanceof Uint8Array ? data : new Uint8Array(data);
      at += writeSync(fd, view, 0, view.length, at);
    },
    async close() {
      if (!closed) closeSync(fd);
      closed = true;
    },
    async abort() {
      if (!closed) closeSync(fd);
      closed = true;
    },
  };
}

function fileHandle(file, name, handles) {
  const handle = {
    kind: 'file',
    name,
    async createSyncAccessHandle() {
      const fd = openSync(file, 'r+');
      let closed = false;
      return {
        write(view, { at = 0 } = {}) {
          return writeSync(fd, view, 0, view.length, at);
        },
        read(buffer, { at = 0 } = {}) {
          return readSync(fd, buffer, 0, buffer.length, at);
        },
        truncate(size) {
          ftruncateSync(fd, size);
        },
        getSize() {
          return statSync(file).size;
        },
        flush() {
          fsyncSync(fd);
        },
        close() {
          if (!closed) closeSync(fd);
          closed = true;
        },
      };
    },
    async getFile() {
      const blob = await openAsBlob(file);
      return new File([blob], name, { lastModified: statSync(file).mtimeMs });
    },
    async createWritable() {
      return writableStream(file);
    },
  };
  // A worker has synchronous access handles; a page writable streams; a
  // page of Safari before 26 neither.
  if (handles !== 'worker') delete handle.createSyncAccessHandle;
  if (handles !== 'page') delete handle.createWritable;
  return handle;
}

function directoryHandle(folder, name, handles) {
  return {
    kind: 'directory',
    name,
    async getDirectoryHandle(child, { create = false } = {}) {
      const target = path.join(folder, child);
      try {
        if (!statSync(target).isDirectory()) throw notFound(child);
      } catch (error) {
        if (error instanceof DOMException) throw error;
        if (!create) throw notFound(child);
        mkdirSync(target);
      }
      return directoryHandle(target, child, handles);
    },
    async getFileHandle(child, { create = false } = {}) {
      const target = path.join(folder, child);
      try {
        statSync(target);
      } catch {
        if (!create) throw notFound(child);
        closeSync(openSync(target, 'w'));
      }
      return fileHandle(target, child, handles);
    },
    async removeEntry(child, { recursive = false } = {}) {
      rmSync(path.join(folder, child), { recursive, force: false });
    },
    async *entries() {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const target = path.join(folder, entry.name);
        yield [entry.name, entry.isDirectory() ? directoryHandle(target, entry.name, handles) : fileHandle(target, entry.name, handles)];
      }
    },
  };
}

/** Web Locks: shared and exclusive, granted in order, `ifAvailable`. */
export function createLocks() {
  const held = new Map();
  const waiting = [];
  const compatible = (name, mode) => {
    const current = held.get(name);
    return current === undefined || (mode === 'shared' && current.mode === 'shared');
  };
  const take = (name, mode) => {
    const current = held.get(name);
    if (current === undefined) held.set(name, { mode, count: 1 });
    else current.count++;
  };
  const give = name => {
    const current = held.get(name);
    if (--current.count === 0) held.delete(name);
    for (let i = 0; i < waiting.length; i++) {
      const item = waiting[i];
      if (compatible(item.name, item.mode)) {
        waiting.splice(i--, 1);
        item.grant();
      }
    }
  };
  return {
    held,
    request(name, options, callback) {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      const mode = options.mode ?? 'exclusive';
      const run = () => {
        take(name, mode);
        return Promise.resolve().then(() => callback({ name, mode })).finally(() => give(name));
      };
      if (compatible(name, mode)) return run();
      if (options.ifAvailable) return Promise.resolve().then(() => callback(null));
      return new Promise((resolve, reject) => waiting.push({ name, mode, grant: () => run().then(resolve, reject) }));
    },
  };
}

/**
 * An environment whose `navigator` has OPFS (on disk) and Web Locks.
 *
 * @param {{handles?: 'worker'|'page'|'none', root?: string|null}} [options] - How its files are
 *   written: synchronous access handles (a dedicated worker, the default),
 *   writable streams (a page), or neither (a page of Safari before 26);
 *   `root`: the folder the storage is in (else a new temporary one)
 * @returns {{environment: Object, root: string, cleanup: () => void}}
 */
export function opfsOnDisk({ handles = 'worker', root: given = null } = {}) {
  // A folder given is kept (a later process opens the same storage: a later visit).
  const root = given ?? mkdtempSync(path.join(tmpdir(), 'cellucid-opfs-'));
  mkdirSync(root, { recursive: true });
  const environment = {
    navigator: {
      storage: {
        getDirectory: async () => directoryHandle(root, '', handles),
        estimate: async () => ({ quota: 1e12, usage: 0 }),
      },
      locks: createLocks(),
    },
  };
  // The same storage and locks as another context sees them: the page and
  // its reader worker write the same files, one way each.
  const as = other => ({
    navigator: {
      storage: { ...environment.navigator.storage, getDirectory: async () => directoryHandle(root, '', other) },
      get locks() {
        return environment.navigator.locks;
      },
    },
  });
  return { environment, root, as, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
