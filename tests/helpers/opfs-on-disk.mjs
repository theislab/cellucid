/**
 * The origin-private file system and Web Locks a dedicated worker has, for
 * Node: directories and files on disk under one temporary folder, files
 * written through synchronous access handles, and shared/exclusive locks
 * with `ifAvailable`. Enough for the transcode space
 * (`assets/js/data/anndata/transcode/space.js`) to run as it does in a
 * browser.
 */
import { closeSync, mkdirSync, mkdtempSync, openAsBlob, openSync, readdirSync, readSync, rmSync, statSync, writeSync, ftruncateSync, fsyncSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function notFound(name) {
  return new DOMException(`'${name}' was not found.`, 'NotFoundError');
}

function fileHandle(file, name) {
  return {
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
      return new File([blob], name);
    },
  };
}

function directoryHandle(folder, name) {
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
      return directoryHandle(target, child);
    },
    async getFileHandle(child, { create = false } = {}) {
      const target = path.join(folder, child);
      try {
        statSync(target);
      } catch {
        if (!create) throw notFound(child);
        closeSync(openSync(target, 'w'));
      }
      return fileHandle(target, child);
    },
    async removeEntry(child, { recursive = false } = {}) {
      rmSync(path.join(folder, child), { recursive, force: false });
    },
    async *entries() {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const target = path.join(folder, entry.name);
        yield [entry.name, entry.isDirectory() ? directoryHandle(target, entry.name) : fileHandle(target, entry.name)];
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
 * @returns {{environment: Object, root: string, cleanup: () => void}}
 */
export function opfsOnDisk() {
  const root = mkdtempSync(path.join(tmpdir(), 'cellucid-opfs-'));
  const environment = {
    navigator: {
      storage: {
        getDirectory: async () => directoryHandle(root, ''),
        estimate: async () => ({ quota: 1e12, usage: 0 }),
      },
      locks: createLocks(),
    },
  };
  return { environment, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
