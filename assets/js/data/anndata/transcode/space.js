/**
 * Where a transcoded store's bytes live: one directory of the origin-private
 * file system (OPFS) per transcoded file, written through synchronous access
 * handles (dedicated workers have them), or memory where this browser has no
 * OPFS (a Firefox private window), with no other bound than memory itself.
 *
 * **Lifetime (kept for the tab's life).** A directory is
 * `cellucid-transcoded/<identity>-<random>`, `<identity>` a digest of the
 * source file's identity (name, size, modification time; a remote file's
 * URL and version). Whoever uses it holds a shared Web Lock named after it:
 * the reader worker while it writes and reads it, and the page, once the
 * pass completed, until the tab closes (`holdTranscodedStore`). A directory
 * nobody holds belongs to a closed or crashed tab, or to a pass that was
 * cancelled, and is removed: when the app starts (`sweepAbandonedTranscodes`),
 * before a new pass begins, and at once after a cancelled pass
 * (`removeTranscodedStore`, which waits for the stopped worker's lock to
 * go). Opening the same file again in the same tab finds its complete
 * directory (`manifest.json` is written last) and reads it without a second
 * pass (`findKeptStore`).
 *
 * Kept payloads arrive while the file streams, each into a file of its own
 * (`p<n>.bin`), so one that turns out not to be wanted is deleted: at once
 * when the parser gives it back (a Seurat v5 layer that is `scale.data`,
 * known only by the layer names that follow it), else when the store is
 * complete (what the transcoder did not use); arrays the transcoder derives
 * (codes, masks, converted columns) go to one file (`d.bin`) appended to.
 *
 * @module data/anndata/transcode/space
 */

import { blobReader } from '../../../formats/zarr/stores/mapped.js';
import { formatBytes } from '../../../utils/format-units.js';

export const TRANSCODED_DIRECTORY = 'cellucid-transcoded';
const MANIFEST = 'manifest.json';
const DERIVED = 'd.bin';

function lockName(directory) {
  return `${TRANSCODED_DIRECTORY}/${directory}`;
}

/** Hex digest of a source identity: the prefix of its directories. */
export async function identityDigest(identity) {
  const text = JSON.stringify(identity ?? null);
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest.subarray(0, 12)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The storage this browser says it has left, in bytes, or null. */
async function storageLeft(environment) {
  try {
    const estimate = await environment.navigator?.storage?.estimate?.();
    if (!estimate || !(estimate.quota > 0)) return null;
    return Math.max(0, estimate.quota - (estimate.usage ?? 0));
  } catch {
    return null;
  }
}

/** The error a pass stops with when the browser's storage is full. */
export function storageFullError(needed, left) {
  const error = new Error(
    `This browser's storage has room for ${formatBytes(left)} more, and this object needs more than that ` +
    `(${formatBytes(needed)} so far). Free space in the browser (or the disk), or write the object as a ` +
    'Cellucid-ready AnnData once (cellucid.prepare() in Python, cellucid_prepare() in R) and open that, ' +
    'which is read in place.'
  );
  error.code = 'UNSUPPORTED';
  error.details = { explained: true, reason: 'storage-full' };
  return error;
}

async function opfsRoot(environment) {
  const storage = environment?.navigator?.storage;
  if (typeof storage?.getDirectory !== 'function') return null;
  try {
    return await storage.getDirectory();
  } catch {
    return null;
  }
}

async function parentDirectory(root, create) {
  try {
    return await root.getDirectoryHandle(TRANSCODED_DIRECTORY, { create });
  } catch {
    return null;
  }
}

/** Hold a shared lock on one directory until `release()` is called. */
async function holdShared(locks, directory) {
  if (typeof locks?.request !== 'function') return () => {};
  let release = () => {};
  await new Promise(granted => {
    locks.request(lockName(directory), { mode: 'shared' }, () => new Promise(done => {
      release = done;
      granted();
    }));
  });
  return release;
}

async function removeAbandoned(parent, locks) {
  if (typeof parent.entries !== 'function' || typeof locks?.request !== 'function') return;
  const names = [];
  for await (const [name] of parent.entries()) names.push(name);
  for (const name of names) {
    // ifAvailable grants the lock only when nobody holds the directory.
    await locks.request(lockName(name), { ifAvailable: true }, async lock => {
      if (lock !== null) await parent.removeEntry(name, { recursive: true }).catch(() => {});
    });
  }
}

/**
 * Remove every transcoded directory nobody holds. Run when the app starts;
 * never throws, and does nothing without OPFS.
 *
 * @param {Object} [environment]
 */
export async function sweepAbandonedTranscodes(environment = globalThis) {
  try {
    const root = await opfsRoot(environment);
    if (root === null) return;
    const parent = await parentDirectory(root, false);
    if (parent === null) return;
    await removeAbandoned(parent, environment.navigator.locks);
  } catch {
    // A storage failure leaves the directories for the next start.
  }
}

/** The directories this page holds for the tab's life. */
const heldByPage = new Set();

/**
 * The page keeps a completed directory for the tab's life: a shared lock
 * held until the page goes. Idempotent.
 *
 * @param {string} directory
 * @param {Object} [environment]
 */
export function holdTranscodedStore(directory, environment = globalThis) {
  if (typeof directory !== 'string' || heldByPage.has(directory)) return;
  heldByPage.add(directory);
  void holdShared(environment?.navigator?.locks, directory).catch(() => heldByPage.delete(directory));
}

/**
 * Remove one directory a pass left unfinished (Cancel, a failure), once the
 * worker that wrote it has stopped and let its lock go. Never throws.
 *
 * @param {string} directory
 * @param {Object} [environment]
 */
export async function removeTranscodedStore(directory, environment = globalThis) {
  if (typeof directory !== 'string' || heldByPage.has(directory)) return;
  try {
    const root = await opfsRoot(environment);
    if (root === null) return;
    const parent = await parentDirectory(root, false);
    if (parent === null) return;
    const locks = environment.navigator?.locks;
    const remove = () => parent.removeEntry(directory, { recursive: true }).catch(() => {});
    if (typeof locks?.request !== 'function') await remove();
    else await locks.request(lockName(directory), { mode: 'exclusive' }, remove);
  } catch {
    // Left for the next start's sweep.
  }
}

/**
 * The complete store of a file transcoded before in this browser (and still
 * held by a tab), or null: its manifest and blobs, and the lock this reader
 * now holds on it.
 *
 * @param {Object} identity
 * @param {Object} [environment]
 * @returns {Promise<{directory: string, manifest: Object, blobs: Map<string, Object>, release: () => void}|null>}
 */
export async function findKeptStore(identity, environment = globalThis) {
  const root = await opfsRoot(environment);
  if (root === null || identity === null || identity === undefined) return null;
  const parent = await parentDirectory(root, false);
  if (parent === null) return null;
  const prefix = `${await identityDigest(identity)}-`;
  const names = [];
  try {
    for await (const [name, handle] of parent.entries()) if (name.startsWith(prefix) && handle.kind === 'directory') names.push(name);
  } catch {
    return null;
  }
  for (const name of names) {
    const release = await holdShared(environment.navigator?.locks, name);
    try {
      const folder = await parent.getDirectoryHandle(name);
      const manifestFile = await (await folder.getFileHandle(MANIFEST)).getFile();
      const manifest = JSON.parse(await manifestFile.text());
      const blobs = new Map();
      for (const blob of manifest.blobs ?? []) {
        if (blob === 'file') continue;
        blobs.set(blob, blobReader(await (await folder.getFileHandle(blob)).getFile()));
      }
      return { directory: name, manifest, blobs, release };
    } catch {
      release();
    }
  }
  return null;
}

/**
 * @typedef {Object} Region
 * @property {string} store - The blob it is in (`file`: the source file itself)
 * @property {number} offset
 * @property {number} byteLength
 */

/**
 * @typedef {Object} TranscodeSpace
 * @property {'opfs'|'memory'} kind
 * @property {string|null} directory
 * @property {import('../../../formats/rds/parse.js').RdsSink} sink - Where
 *   the parser writes kept payloads (each its own blob)
 * @property {(bytes: Uint8Array) => Promise<Region>} put - Keep derived bytes
 * @property {(region: Region) => Promise<Uint8Array>} read - Read a region back
 * @property {(manifest: Object, used: Set<string>) => Promise<Map<string, Object>>} finish -
 *   Write the manifest (OPFS), delete the blobs not in `used`, and the blob
 *   readers by name
 * @property {() => Promise<void>} discard - Remove everything written (the
 *   reader's lock goes with the worker; a complete store stays held)
 */

/**
 * Open a space for one pass.
 *
 * @param {Object|null} identity - The source file's identity (`byte-source.js`)
 * @param {{environment?: Object, memory?: boolean, onDirectory?: ((directory: string) => void)|null}} [options]
 *   `memory`: keep everything in memory (tests, and where OPFS is absent);
 *   `onDirectory(name)`: told the directory's name before anything is
 *   written to it
 * @returns {Promise<TranscodeSpace>}
 */
export async function openTranscodeSpace(identity, { environment = globalThis, memory = false, onDirectory = null } = {}) {
  const root = memory ? null : await opfsRoot(environment);
  const parent = root === null ? null : await parentDirectory(root, true);
  if (parent !== null) {
    try {
      return await opfsSpace(parent, identity, environment, onDirectory);
    } catch (error) {
      if (error?.code === 'UNSUPPORTED') throw error;
      // No synchronous access handles here: the store is kept in memory.
    }
  }
  return memorySpace();
}

function memorySpace() {
  const blobs = new Map();
  let next = 0;
  const space = {
    kind: 'memory',
    directory: null,
    sink: {
      open() {
        // Each piece is copied once, into a Blob; the payload's Blob is made
        // of those, not a second copy.
        const parts = [];
        return {
          write: view => {
            parts.push(new Blob([view]));
          },
          close: () => {
            const name = `p${next++}`;
            const blob = new Blob(parts);
            blobs.set(name, blob);
            return { store: name, offset: 0, byteLength: blob.size };
          },
        };
      },
      release(region) {
        blobs.delete(region.store);
      },
    },
    async put(bytes) {
      const name = `m${next++}`;
      blobs.set(name, new Blob([bytes]));
      return { store: name, offset: 0, byteLength: bytes.length };
    },
    async read(region) {
      const blob = blobs.get(region.store);
      if (blob === undefined) throw new Error(`The kept bytes '${region.store}' are missing.`);
      return new Uint8Array(await blob.slice(region.offset, region.offset + region.byteLength).arrayBuffer());
    },
    async finish(_manifest, used) {
      const readers = new Map();
      for (const [name, blob] of [...blobs]) {
        if (used.has(name)) readers.set(name, blobReader(blob));
        else blobs.delete(name);
      }
      return readers;
    },
    async discard() {
      blobs.clear();
    },
  };
  return space;
}

async function opfsSpace(parent, identity, environment, onDirectory) {
  const locks = environment.navigator?.locks;
  await removeAbandoned(parent, locks);
  const directory = `${await identityDigest(identity)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const release = await holdShared(locks, directory);
  onDirectory?.(directory);
  let folder;
  let derived;
  try {
    folder = await parent.getDirectoryHandle(directory, { create: true });
    const derivedHandle = await folder.getFileHandle(DERIVED, { create: true });
    if (typeof derivedHandle.createSyncAccessHandle !== 'function') throw new TypeError('No synchronous access handles.');
    derived = await derivedHandle.createSyncAccessHandle();
  } catch (error) {
    release();
    await parent.removeEntry(directory, { recursive: true }).catch(() => {});
    throw error;
  }
  const left = await storageLeft(environment);
  let written = 0;
  let derivedEnd = 0;
  let next = 0;
  const open = new Set([derived]);
  const files = [];
  const charge = bytes => {
    if (left !== null && written + bytes > left) throw storageFullError(written + bytes, left);
    written += bytes;
  };
  const space = {
    kind: 'opfs',
    directory,
    sink: {
      async open(byteLength) {
        // A payload whose length is known is refused before anything of it
        // is written when it cannot fit; what is written is counted as it is.
        if (Number.isFinite(byteLength) && left !== null && written + byteLength > left) {
          throw storageFullError(written + byteLength, left);
        }
        const name = `p${next++}.bin`;
        const handle = await (await folder.getFileHandle(name, { create: true })).createSyncAccessHandle();
        open.add(handle);
        files.push(name);
        let at = 0;
        return {
          write: view => {
            charge(view.length);
            let done = 0;
            while (done < view.length) done += handle.write(view.subarray(done), { at: at + done });
            at += view.length;
          },
          close: () => {
            handle.flush();
            handle.close();
            open.delete(handle);
            return { store: name, offset: 0, byteLength: at };
          },
        };
      },
      async release(region) {
        const at = files.indexOf(region.store);
        if (at < 0) return;
        files.splice(at, 1);
        written -= region.byteLength;
        await folder.removeEntry(region.store).catch(() => {});
      },
    },
    async put(bytes) {
      charge(bytes.length);
      const offset = derivedEnd;
      let done = 0;
      while (done < bytes.length) done += derived.write(bytes.subarray(done), { at: offset + done });
      derivedEnd += bytes.length;
      return { store: DERIVED, offset, byteLength: bytes.length };
    },
    async read(region) {
      if (region.store === DERIVED && open.has(derived)) {
        const out = new Uint8Array(region.byteLength);
        derived.read(out, { at: region.offset });
        return out;
      }
      const file = await (await folder.getFileHandle(region.store)).getFile();
      return new Uint8Array(await file.slice(region.offset, region.offset + region.byteLength).arrayBuffer());
    },
    async finish(manifest, used) {
      for (const handle of open) {
        handle.flush();
        handle.close();
      }
      open.clear();
      const readers = new Map();
      for (const name of [DERIVED, ...files]) {
        if (!used.has(name)) {
          await folder.removeEntry(name).catch(() => {});
          continue;
        }
        readers.set(name, blobReader(await (await folder.getFileHandle(name)).getFile()));
      }
      const handle = await (await folder.getFileHandle(MANIFEST, { create: true })).createSyncAccessHandle();
      const bytes = new TextEncoder().encode(JSON.stringify({ ...manifest, blobs: [...readers.keys()] }));
      handle.write(bytes, { at: 0 });
      handle.truncate(bytes.length);
      handle.flush();
      handle.close();
      return readers;
    },
    async discard() {
      for (const handle of open) {
        try {
          handle.close();
        } catch {
          // Closed already.
        }
      }
      open.clear();
      await parent.removeEntry(directory, { recursive: true }).catch(() => {});
      release();
    },
  };
  return space;
}
