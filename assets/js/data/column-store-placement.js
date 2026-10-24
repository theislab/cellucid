/**
 * @fileoverview Where the AnnData reader worker keeps a gene-column index:
 * the memory budget it may use (a residency policy, never a limit on what
 * can be opened) and the disk it spills to (the origin-private file system,
 * through synchronous access handles, available in dedicated workers).
 *
 * Each index owns one OPFS directory under `cellucid-column-index/`, held by
 * a Web Lock for as long as the reader lives. A directory whose lock nobody
 * holds belongs to a closed or crashed tab and is removed when the app
 * starts (`sweepAbandonedIndexes`) and again before a new index is written,
 * so a crashed tab's spill never lingers on disk.
 *
 * @module data/column-store-placement
 */

import { createColumnStoreFactory } from './sparse-column-index.js';
import { residencyBudgetBytes } from './memory-budget.js';

const INDEX_DIRECTORY = 'cellucid-column-index';
/**
 * The memory one column index may hold before it spills to disk: the
 * `columnIndex` residency budget (a share of the reported device memory).
 *
 * @param {Object} [environment]
 * @returns {number}
 */
export function columnIndexMemoryBudget(environment = globalThis) {
  return residencyBudgetBytes('columnIndex', environment);
}

function lockName(directory) {
  return `${INDEX_DIRECTORY}/${directory}`;
}

async function removeAbandonedIndexes(parent, locks) {
  if (typeof parent.entries !== 'function' || typeof locks?.request !== 'function') return;
  for await (const [name] of parent.entries()) {
    // ifAvailable grants the lock only when no live reader holds it.
    await locks.request(lockName(name), { ifAvailable: true }, async lock => {
      if (lock !== null) await parent.removeEntry(name, { recursive: true }).catch(() => {});
    });
  }
}

/**
 * Remove every index directory no live reader holds (a closed or crashed
 * tab's spill). Run when the app starts; it never throws, and does nothing
 * where there is no OPFS or no index directory.
 *
 * @param {Object} [environment]
 * @returns {Promise<void>}
 */
export async function sweepAbandonedIndexes(environment = globalThis) {
  const storage = environment?.navigator?.storage;
  if (typeof storage?.getDirectory !== 'function') return;
  try {
    const root = await storage.getDirectory();
    let parent;
    try {
      parent = await root.getDirectoryHandle(INDEX_DIRECTORY);
    } catch {
      // No index was ever spilled from this origin.
      return;
    }
    await removeAbandonedIndexes(parent, environment.navigator.locks);
  } catch {
    // A storage failure leaves the spill for the next start or index.
  }
}

/**
 * Open synchronous access handles for one new index, or null when this
 * context has no usable OPFS.
 *
 * @param {string[]} names
 * @param {Object} [environment]
 * @returns {Promise<Object|null>}
 */
export async function openIndexFiles(names, environment = globalThis) {
  const storage = environment?.navigator?.storage;
  const locks = environment?.navigator?.locks;
  if (typeof storage?.getDirectory !== 'function') return null;
  try {
    const root = await storage.getDirectory();
    const parent = await root.getDirectoryHandle(INDEX_DIRECTORY, { create: true });
    await removeAbandonedIndexes(parent, locks);
    const directory = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let releaseLock = () => {};
    if (typeof locks?.request === 'function') {
      await new Promise(acquired => {
        locks.request(lockName(directory), () => new Promise(release => {
          releaseLock = release;
          acquired();
        }));
      });
    }
    const folder = await parent.getDirectoryHandle(directory, { create: true });
    const handles = {};
    for (const name of names) {
      const file = await folder.getFileHandle(name, { create: true });
      if (typeof file.createSyncAccessHandle !== 'function') {
        releaseLock();
        return null;
      }
      handles[name] = await file.createSyncAccessHandle();
    }
    handles.release = () => {
      parent.removeEntry(directory, { recursive: true })
        .catch(() => {})
        .finally(() => releaseLock());
    };
    return handles;
  } catch {
    return null;
  }
}

/**
 * The store factory the reader worker's indexes use.
 *
 * @returns {Object}
 */
export function createWorkerColumnStoreFactory() {
  return createColumnStoreFactory({
    memoryBudgetBytes: columnIndexMemoryBudget(),
    openDiskFiles: names => openIndexFiles(names),
  });
}
