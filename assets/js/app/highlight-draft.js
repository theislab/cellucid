/**
 * @fileoverview A draft of the highlights made on a dataset, kept in this
 * browser, so a reload, a closed tab or a crashed page does not lose an
 * hour of selections that no saved session holds.
 *
 * - **Kept**: shortly after the highlights change (`highlight:changed`,
 *   `page:changed`), the pages and their groups are written, per dataset, to
 *   this browser's IndexedDB: each group's label, kind, whether it is on, and
 *   its cells as a cell set of original positions (`encodeCellSet`, the
 *   bytes a session stores), so a draft made on one subsample is read on
 *   another. No highlight left: the draft is removed. Highlights a session
 *   file holds -- just saved (`sessionSaving`) or restored
 *   (`sessionRestored`) -- are no draft either: theirs is removed, until
 *   they change.
 * - **Offered**: when the same dataset opens again with no highlight yet, a
 *   notification offers to restore the draft ("Restore"); it is never
 *   restored by itself. Cells of the draft that are not open now are left
 *   out, and the notification says how many.
 * - **Listed**: Session › Open data › Stored › Manage… lists every draft by
 *   its dataset's name, size and when it was last saved, and removes the
 *   ones chosen (`listHighlightDrafts`, `removeHighlightDrafts`,
 *   `onHighlightDraftsChange`).
 * - A per-viewer convenience: nothing leaves this browser, a browser that
 *   keeps no IndexedDB (a private window) keeps no draft, and every storage
 *   failure only means no draft. A highlight made from a category or a value
 *   range comes back as a selection of the same cells and label.
 *
 * @module app/highlight-draft
 */

import { createCellIdentity, decodeCellSet, encodeCellSet } from '../data/cell-identity.js';
import { formatCountOf } from '../utils/format-units.js';
import { indexedDbKeyValueStore } from '../utils/indexed-db-store.js';

const DB_NAME = 'cellucid-highlight-drafts';
const STORE_NAME = 'drafts';
/** The layout of a draft record. */
const DRAFT_VERSION = 1;
/** How long after the last change a draft is written. */
const SAVE_DELAY_MS = 1000;
/** The group kinds a draft restores as they were; any other as a selection. */
const DIRECT_KINDS = new Set(['annotation', 'combined', 'knn', 'lasso', 'proximity']);

/** The page's draft store, opened once (null without IndexedDB). */
let pageStore;
function defaultStore() {
  if (pageStore === undefined) pageStore = indexedDbKeyValueStore(DB_NAME, STORE_NAME);
  return pageStore;
}

/** Whoever lists the drafts hears when one is written or removed (`onHighlightDraftsChange`). */
const draftListeners = new Set();

/**
 * Hear when a draft is written or removed in this page (the Session panel's
 * Stored row and dialog). Returns what stops it.
 *
 * @param {() => void} listener
 * @returns {() => void}
 */
export function onHighlightDraftsChange(listener) {
  draftListeners.add(listener);
  return () => draftListeners.delete(listener);
}

function announceDrafts() {
  for (const listener of draftListeners) {
    try {
      listener();
    } catch {
      // A listener's failure is its own.
    }
  }
}

/** The bytes a draft takes: its cell sets and the text of the rest. */
function draftBytes(record) {
  let bytes = 0;
  const text = JSON.stringify(record, (key, value) => {
    if (ArrayBuffer.isView(value)) {
      bytes += value.byteLength;
      return null;
    }
    return value;
  });
  return bytes + (text?.length ?? 0);
}

/** Whether two drafts' pages hold the same names, groups, labels, kinds, switches and cells. */
function samePages(a, b) {
  if (a.length !== b.length) return false;
  return a.every((page, p) => {
    const other = b[p];
    if (page.name !== other.name || page.groups.length !== other.groups.length) return false;
    return page.groups.every((group, g) => {
      const twin = other.groups[g];
      if (group.label !== twin.label || group.type !== twin.type || group.enabled !== twin.enabled) return false;
      if (group.cells.byteLength !== twin.cells.byteLength) return false;
      for (let i = 0; i < group.cells.byteLength; i++) if (group.cells[i] !== twin.cells[i]) return false;
      return true;
    });
  });
}

/**
 * Every draft kept in this browser, most recently saved first: `key` (the
 * dataset's id, what `removeHighlightDrafts` takes), its dataset's `name`
 * (null when the draft did not record one), how many highlights it holds,
 * the bytes it takes and when it was last saved. Empty without IndexedDB;
 * never throws.
 *
 * @param {import('../utils/indexed-db-store.js').KeyValueStore|null} [store]
 * @returns {Promise<Array<{key: string, name: string|null, highlights: number, bytes: number, savedAt: number}>>}
 */
export async function listHighlightDrafts(store = defaultStore()) {
  if (store === null) return [];
  let entries;
  try {
    entries = await store.entries();
  } catch {
    return [];
  }
  return entries
    .filter(({ key, value }) => typeof key === 'string' && value?.version === DRAFT_VERSION && Array.isArray(value.pages))
    .map(({ key, value }) => ({
      key,
      name: typeof value.name === 'string' && value.name !== '' ? value.name : null,
      highlights: value.pages.reduce((sum, page) => sum + (page.groups?.length ?? 0), 0),
      bytes: draftBytes(value),
      savedAt: Number.isFinite(value.savedAt) ? value.savedAt : 0,
    }))
    .sort((a, b) => b.savedAt - a.savedAt || (a.key < b.key ? -1 : 1));
}

/**
 * Remove the drafts of the datasets `keys` (null: every draft). Resolves to
 * how many were removed; never throws.
 *
 * @param {Iterable<string>|null} keys
 * @param {import('../utils/indexed-db-store.js').KeyValueStore|null} [store]
 * @returns {Promise<number>}
 */
export async function removeHighlightDrafts(keys, store = defaultStore()) {
  if (store === null) return 0;
  let removed = 0;
  try {
    const wanted = keys === null ? (await store.entries()).map(entry => entry.key) : [...keys];
    for (const key of wanted) {
      await store.delete(key);
      removed++;
    }
  } catch {
    // What could not be removed stays listed.
  }
  if (removed > 0) announceDrafts();
  return removed;
}

/**
 * Keep a draft of the highlights of the dataset shown, and offer it back.
 *
 * @param {Object} options
 * @param {Object} options.state - DataState
 * @param {Object} options.notifications - The notification center
 * @param {() => string|null} options.datasetKey - What names the dataset shown (its id), null when none
 * @param {() => string|null} [options.datasetName] - The dataset's name, recorded so the Stored dialog can say whose draft it is
 * @param {import('../utils/indexed-db-store.js').KeyValueStore|null} [options.store]
 * @param {(save: () => void, ms: number) => unknown} [options.schedule]
 * @param {(handle: unknown) => void} [options.cancel]
 * @returns {{datasetOpened: () => Promise<void>, flush: () => Promise<void>, dispose: () => void}}
 */
export function createHighlightDraft({
  state,
  notifications,
  datasetKey,
  datasetName = () => null,
  store = defaultStore(),
  schedule = (save, ms) => setTimeout(save, ms),
  cancel = handle => clearTimeout(handle),
}) {
  let pending = null;
  let restoring = false;
  /** Every highlight change seen, counted: a session save holds the highlights only if none came during it. */
  let revision = 0;
  /** The highlights a session file saved or restored here holds (`holdInSession`), or null. */
  let held = null;
  /** The notification offering the draft back while it stands, or null. */
  let offer = null;
  /** The dataset a draft offer or the latest change belongs to. */
  let shownKey = null;

  /** The draft record of the highlights shown now, or null with no dataset or cells. */
  function currentRecord() {
    const key = datasetKey();
    const identity = state.cellIdentity;
    if (key === null || identity === null || identity === undefined) return null;
    const pages = state.getHighlightPages();
    const activeId = state.getActivePageId();
    return {
      key,
      record: {
        version: DRAFT_VERSION,
        name: datasetName() ?? null,
        savedAt: Date.now(),
        nObs: identity.nOriginal,
        active: Math.max(0, pages.findIndex(page => page.id === activeId)),
        pages: pages.map(page => ({
          name: page.name,
          groups: page.highlightedGroups.map(group => {
            const originals = identity.toOriginal(group.cellIndices).sort();
            return {
              label: group.label,
              type: group.type,
              enabled: group.enabled !== false,
              cells: encodeCellSet(createCellIdentity({ nObs: identity.nOriginal, kept: originals })),
            };
          }),
        })),
      },
    };
  }

  async function write() {
    pending = null;
    if (store === null) return;
    const current = currentRecord();
    if (current === null) return;
    const { key, record } = current;
    try {
      // Nothing highlighted, or exactly what a session file holds: no draft.
      if (record.pages.every(page => page.groups.length === 0) || heldBySession(key, record)) await store.delete(key);
      else await store.put(key, record);
      announceDrafts();
    } catch {
      // No draft is kept: the page goes on without one.
    }
  }

  /** Whether `record` holds the highlights a session file saved or restored here holds. */
  function heldBySession(key, record) {
    return held !== null && held.key === key && held.nObs === record.nObs && samePages(held.pages, record.pages);
  }

  /**
   * The highlights shown when `current` was taken are held by a session
   * file: the draft of them goes, and a later write of the same highlights
   * keeps none. A change after that writes a draft again.
   */
  async function holdInSession(current) {
    if (pending !== null) {
      cancel(pending);
      pending = null;
    }
    // A draft offered while the session was opened is no longer the work to restore.
    if (offer !== null) {
      notifications.dismiss?.(offer);
      offer = null;
    }
    if (current === null) return;
    held = { key: current.key, nObs: current.record.nObs, pages: current.record.pages };
    if (store === null) return;
    try {
      await store.delete(current.key);
      announceDrafts();
    } catch {
      // The draft stays; it is offered only while nothing is highlighted.
    }
  }

  function changed() {
    if (restoring || store === null) return;
    revision++;
    // A change while another dataset's draft was offered is of this one.
    shownKey = datasetKey();
    if (pending !== null) cancel(pending);
    pending = schedule(() => { void write(); }, SAVE_DELAY_MS);
  }

  function restore(record) {
    const identity = state.cellIdentity;
    restoring = true;
    let dropped = 0;
    try {
      record.pages.forEach((draftPage, index) => {
        const existing = state.getHighlightPages();
        const page = index === 0 && existing.length > 0 ? existing[0] : state.createHighlightPage(draftPage.name);
        if (index === 0 && existing.length > 0) state.renameHighlightPage(page.id, draftPage.name);
        state.switchToPage(page.id);
        for (const group of draftPage.groups) {
          const kept = decodeCellSet(group.cells, record.nObs).kept ?? Uint32Array.from({ length: record.nObs }, (_, i) => i);
          const { positions, dropped: missing } = identity.fromOriginal(kept);
          dropped += missing;
          if (positions.length === 0) continue;
          const made = state.addHighlightDirect({
            cellIndices: positions,
            label: group.label,
            type: DIRECT_KINDS.has(group.type) ? group.type : 'annotation',
          });
          if (!group.enabled) state.toggleHighlightEnabled(made.id, false);
        }
      });
      const pages = state.getHighlightPages();
      state.switchToPage(pages[Math.min(record.active, pages.length - 1)].id);
    } finally {
      restoring = false;
    }
    return dropped;
  }

  async function datasetOpened() {
    if (pending !== null) {
      cancel(pending);
      pending = null;
    }
    const key = datasetKey();
    shownKey = key;
    if (store === null || key === null) return;
    let record;
    try {
      record = await store.get(key);
    } catch {
      return;
    }
    const identity = state.cellIdentity;
    if (
      record === undefined || record === null || record.version !== DRAFT_VERSION
      || identity === null || identity === undefined || record.nObs !== identity.nOriginal
      || shownKey !== key
      // Highlights made or restored since: the draft is theirs now.
      || state.getHighlightPages().some(page => page.highlightedGroups.length > 0)
    ) {
      return;
    }
    const groups = record.pages.reduce((sum, page) => sum + page.groups.length, 0);
    const when = new Date(record.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    offer = notifications.show({
      type: 'info',
      category: 'highlight',
      message: `${formatCountOf(groups, 'highlight')} from ${when} on this dataset ${groups === 1 ? 'was' : 'were'} not saved in a session.`,
      duration: 20000,
      action: {
        label: 'Restore',
        run: () => {
          offer = null;
          if (datasetKey() !== key || state.cellIdentity?.nOriginal !== record.nObs) return;
          const dropped = restore(record);
          changed();
          if (dropped > 0) {
            notifications.info(`Left out ${formatCountOf(dropped, 'cell')} of the restored highlights: not open now.`, { category: 'highlight' });
          }
        },
      },
    });
  }

  state.on('highlight:changed', changed);
  state.on('page:changed', changed);

  return {
    datasetOpened,
    /**
     * A session is being saved (downloaded, or handed to the notebook):
     * call the function returned once it is. The highlights shown now are
     * then held by that file and their draft goes, unless they changed
     * while it was being written.
     *
     * @returns {() => Promise<void>}
     */
    sessionSaving() {
      const at = revision;
      const current = currentRecord();
      return async () => {
        if (revision !== at || current === null || datasetKey() !== current.key) return;
        await holdInSession(current);
      };
    },
    /** A session file was restored: the highlights shown are its own, so their draft goes. */
    sessionRestored() {
      return holdInSession(currentRecord());
    },
    /** Write a change still waiting now (tests; leaving the page). */
    async flush() {
      if (pending === null) return;
      cancel(pending);
      await write();
    },
    dispose() {
      if (pending !== null) cancel(pending);
      pending = null;
      state.off?.('highlight:changed', changed);
      state.off?.('page:changed', changed);
    },
  };
}
