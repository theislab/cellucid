/**
 * @fileoverview My datasets: the datasets opened in this browser, most
 * recently opened first, each with how it opens again and what it is.
 *
 * - **Kept**: in this browser's IndexedDB (database `cellucid-library`,
 *   object store `datasets`), one record per dataset, keyed by its identity
 *   (`DataSourceManager.getCurrentIdentityId()`, the id sessions and saved
 *   states key on, so a dataset's saved histories are found by it). Nothing
 *   leaves the browser; no server and no account are involved.
 * - **What a record holds** (`LIBRARY_RECORD_VERSION`): the dataset's name;
 *   where it opens from (`session/dataset-source-record.js`: a sample, a
 *   link in its public form, a Cellucid server, a file or folder of this
 *   computer by name); for a link, its provider and whether what it carried
 *   to grant access was left out (the access itself never is kept:
 *   `data/sources/link-credentials.js`); its format, layout, file name, host
 *   and size (`data/anndata-storage.js`); the cells and genes of the file;
 *   the cells it was last open with (`openCells`: how many, the subsample
 *   specification when one was chosen, whether the device fit chose them);
 *   when it was first and last opened, and how many times.
 * - **Recorded** (`recordDatasetOpened`) by the page once a dataset is
 *   published, counted as an opening (`counted`), and again, uncounted,
 *   when the same dataset is read on other cells (Cells to open, a
 *   progressive opening's growth), which only updates a dataset already
 *   listed. The startup's default sample is not an opening the person
 *   chose and is not recorded (`app/dataset/reload.js`). A notebook's dataset
 *   (a viewer host) is not listed: it is served to that notebook's viewer
 *   only and cannot be opened again from here (`captureDatasetSourceRecord`
 *   names no source for it).
 * - **Opened again** (`reopenRequestOf`) with the cells it was last open
 *   with when they were chosen (a subsample of a method, size and seed),
 *   else as the tab opens datasets now (`data/cell-subset-policy.js`).
 * - **Forgotten** (`forgetMyDatasets`): the record, and for a file or folder
 *   the browser's handle of it (`local-file-handles.js`); its saved states
 *   (`app/history/autosave.js`) only when asked.
 * - A page whose browser gives it no IndexedDB (or one it cannot open)
 *   keeps the list for this page only (`lasting` false), and says so.
 *
 * @module app/library/my-datasets
 */

import { indexedDbKeyValueStore } from '../../utils/indexed-db-store.js';
import { assertDatasetSourceRecord, captureDatasetSourceRecord } from '../session/dataset-source-record.js';
import { requireSubsampleSpec } from '../../data/subsample.js';
import { forgetLocalFiles } from './local-file-handles.js';
import { listSavedStates, removeSavedStates } from '../history/autosave.js';
import { createListenerSet } from '../../utils/listener-set.js';

const DB_NAME = 'cellucid-library';
const STORE_NAME = 'datasets';

/** The layout of a record; a record of another layout is not listed. */
export const LIBRARY_RECORD_VERSION = 1;

/** How many of the most recent datasets the menu offers; the rest are in All…. */
export const RECENT_DATASETS = 5;

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isText(value) {
  return typeof value === 'string' && value !== '';
}

function hostOf(url) {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * A subsample specification as a plain object (checked: exactly its
 * method's keys), or null when it is not one.
 */
function plainSpec(spec) {
  try {
    const checked = requireSubsampleSpec(spec);
    return checked.method === 'spatial' ? { ...checked, columns: [...checked.columns] } : { ...checked };
  } catch {
    return null;
  }
}

/**
 * The cells an opening holds, as a record keeps them: how many are open
 * (`cells`) of the file's (`of`), the subsample specification (`spec`;
 * null: every cell) and whether the device fit chose them (`fitted`). A
 * progressive opening is recorded as the cells it grows to
 * (`growth.final`), a step of a share grown from few chunks as its share.
 *
 * @param {Object|null} subset - `AnnDataFileSource.getCellSubset()`
 * @returns {{cells: number, of: number, spec: Object|null, fitted: boolean}|null}
 */
export function openCellsOf(subset) {
  if (subset === null || subset === undefined || !isCount(subset.nObs)) return null;
  const every = { cells: subset.nObs, of: subset.nObs, spec: null, fitted: false };
  const final = subset.growth?.final ?? null;
  if (final !== null) {
    const spec = final.mode === 'all' ? null : plainSpec(final.spec);
    return spec === null ? every : { cells: spec.k, of: subset.nObs, spec, fitted: final.autoFit != null };
  }
  if (subset.kept === null || subset.kept === undefined || subset.spec == null) return every;
  const spec = plainSpec(subset.chunks != null && isCount(subset.chunks.target) ? { ...subset.spec, k: subset.chunks.target } : subset.spec);
  return spec === null ? every : { cells: spec.k, of: subset.nObs, spec, fitted: subset.autoFit != null };
}

/**
 * The request a dataset of the list opens with again
 * (`setNextCellSubsetRequest`): the subsample it was last open with, when
 * one was chosen (its method, size, seed and settings); null when every
 * cell was open or the device fit chose them, so it opens as the tab opens
 * datasets now. Not strict: a dataset that lost the field or embedding its
 * subsample was of opens its file's default method, saying so.
 *
 * @param {{spec: Object|null, fitted: boolean}|null} openCells
 * @returns {Readonly<Object>|null}
 */
export function reopenRequestOf(openCells) {
  if (openCells === null || openCells === undefined || openCells.spec === null || openCells.fitted) return null;
  const spec = plainSpec(openCells.spec);
  if (spec === null) return null;
  const { nObs: _nObs, ...request } = spec;
  return Object.freeze({ mode: 'subsample', ...request, strict: false });
}

function storageFacts(storage) {
  if (storage === null || storage === undefined || !isText(storage.format)) return null;
  return {
    format: storage.format,
    zarrVersion: storage.zarrVersion === 2 || storage.zarrVersion === 3 ? storage.zarrVersion : null,
    layout: storage.layout === 'zip' || storage.layout === 'folder' ? storage.layout : 'file',
    remote: storage.remote === true,
    name: isText(storage.name) ? storage.name : null,
    host: storage.remote === true ? hostOf(storage.url) : null,
    bytes: isCount(storage.bytes) ? storage.bytes : null,
  };
}

/**
 * What the list keeps of the dataset shown, read from the data source
 * manager: its identity, name, where it opens from, its storage, cells and
 * genes and the cells open. Null when nothing names how to open it again
 * (a notebook's dataset, nothing shown). Never throws.
 *
 * @param {Object|null} dataSourceManager
 * @returns {Object|null}
 */
export function shownDatasetFacts(dataSourceManager) {
  try {
    if (dataSourceManager === null || dataSourceManager === undefined) return null;
    const id = dataSourceManager.getCurrentIdentityId?.() ?? null;
    const source = captureDatasetSourceRecord(dataSourceManager);
    if (!isText(id) || source === null) return null;
    const metadata = dataSourceManager.getCurrentMetadata?.() ?? null;
    const sourceType = dataSourceManager.getCurrentSourceType();
    const annData = dataSourceManager.getSource?.(sourceType)?.getAnnDataSource?.(dataSourceManager.getCurrentDatasetId()) ?? null;
    const subset = annData?.getCellSubset?.() ?? null;
    let link = null;
    if (source.kind === 'link') {
      const active = dataSourceManager.activeSource ?? null;
      const info = active?.getConnectionInfo?.() ?? null;
      const read = typeof active?.getAddressLocator === 'function' ? active.getAddressLocator() : null;
      link = {
        provider: isText(info?.provider) ? info.provider : null,
        // Only whether the link carried something that grants access, never what.
        accessLeftOut: isText(read) && read !== source.locator,
      };
    }
    const stats = metadata?.stats ?? null;
    return {
      id,
      name: isText(metadata?.name) ? metadata.name : source.dataset,
      source,
      link,
      storage: storageFacts(annData?.describeStorage?.() ?? null),
      cells: isCount(subset?.nObs) ? subset.nObs : isCount(stats?.n_cells) ? stats.n_cells : null,
      genes: isCount(stats?.n_genes) ? stats.n_genes : null,
      openCells: openCellsOf(subset),
    };
  } catch {
    return null;
  }
}

/**
 * The record of a dataset opened now (`counted`) or read again on other
 * cells (not counted: only a dataset already listed is updated; null when
 * it is not).
 *
 * @param {Object|null} previous - its record, or null
 * @param {Object} facts - `shownDatasetFacts`
 * @param {{at: number, counted: boolean}} options
 * @returns {Object|null}
 */
export function nextRecord(previous, facts, { at, counted }) {
  if (previous === null && !counted) return null;
  return {
    version: LIBRARY_RECORD_VERSION,
    id: facts.id,
    name: facts.name,
    source: facts.source,
    link: facts.link,
    storage: facts.storage,
    cells: facts.cells,
    genes: facts.genes,
    // Read on other cells than recorded: those, whatever the recorded ones.
    openCells: facts.openCells ?? previous?.openCells ?? null,
    firstOpenedAt: previous?.firstOpenedAt ?? at,
    lastOpenedAt: counted || previous === null ? at : previous.lastOpenedAt,
    openCount: (previous?.openCount ?? 0) + (counted ? 1 : 0),
  };
}

/**
 * A stored record as the list shows it, checked (they are read back from
 * storage another version may have written), or null when it is not one.
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {Object|null}
 */
export function readRecord(key, value) {
  if (value === null || typeof value !== 'object' || value.version !== LIBRARY_RECORD_VERSION) return null;
  if (!isText(key) || value.id !== key || !isText(value.name)) return null;
  try {
    assertDatasetSourceRecord(value.source, 'My datasets source');
  } catch {
    return null;
  }
  if (value.source === null) return null;
  const link = value.link ?? null;
  if (link !== null && (typeof link !== 'object' || typeof link.accessLeftOut !== 'boolean'
    || (link.provider !== null && !isText(link.provider)))) return null;
  const storage = value.storage ?? null;
  if (storage !== null && (typeof storage !== 'object' || !isText(storage.format))) return null;
  for (const count of ['cells', 'genes']) if (value[count] !== null && !isCount(value[count])) return null;
  const open = value.openCells ?? null;
  let openCells = null;
  if (open !== null) {
    if (typeof open !== 'object' || !isCount(open.cells) || !isCount(open.of) || typeof open.fitted !== 'boolean') return null;
    const spec = open.spec === null ? null : plainSpec(open.spec);
    if (open.spec !== null && spec === null) return null;
    openCells = { cells: open.cells, of: open.of, spec, fitted: open.fitted };
  }
  if (!Number.isFinite(value.firstOpenedAt) || !Number.isFinite(value.lastOpenedAt)
    || !Number.isSafeInteger(value.openCount) || value.openCount < 0) return null;
  return Object.freeze({
    version: LIBRARY_RECORD_VERSION,
    id: value.id,
    name: value.name,
    source: Object.freeze({ ...value.source }),
    link: link === null ? null : Object.freeze({ provider: link.provider, accessLeftOut: link.accessLeftOut }),
    storage: storage === null ? null : Object.freeze({ ...storage }),
    cells: value.cells,
    genes: value.genes,
    openCells: openCells === null ? null : Object.freeze(openCells),
    firstOpenedAt: value.firstOpenedAt,
    lastOpenedAt: value.lastOpenedAt,
    openCount: value.openCount,
  });
}

function memoryStore() {
  const map = new Map();
  return {
    get: async key => map.get(key),
    put: async (key, value) => { map.set(key, structuredClone(value)); },
    delete: async key => { map.delete(key); },
    entries: async () => [...map].map(([key, value]) => ({ key, value })),
  };
}

/**
 * My datasets over one key-value store (`indexedDbKeyValueStore`, or a
 * stand-in with its interface in tests). A store that cannot be opened (no
 * IndexedDB, or one the browser refuses this page) leaves the list in this
 * page's memory: `lasting` is false from then on. Writes run one at a time
 * in a page; nothing throws.
 *
 * @param {{store?: import('../../utils/indexed-db-store.js').KeyValueStore|null, now?: () => number}} [options]
 */
export function createLibrary({ store = null, now = Date.now } = {}) {
  const memory = memoryStore();
  let kept = store;
  /** Whether the browser's store answered once: a later failure is that write's, not the store's. */
  let reached = false;
  const listeners = createListenerSet('My datasets');
  let queue = Promise.resolve();

  function announce() {
    listeners.notify();
  }

  /** Run `work` on the store in use; a browser store that never answered gives way to memory. */
  async function onStore(work) {
    if (kept !== null) {
      try {
        const result = await work(kept);
        reached = true;
        return result;
      } catch (error) {
        if (reached) throw error;
        console.warn('[My datasets] This browser keeps no list of datasets for this site; it is kept for this page only:', error);
        kept = null;
      }
    }
    return work(memory);
  }

  function serial(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  async function list() {
    let entries;
    try {
      entries = await onStore(target => target.entries());
    } catch {
      return [];
    }
    return entries
      .map(({ key, value }) => readRecord(key, value))
      .filter(record => record !== null)
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  return Object.freeze({
    /** Whether the list outlives this page (false: kept in its memory only). */
    get lasting() {
      return kept !== null;
    },
    list,
    /**
     * Record the dataset `facts` describes: opened now (`counted`), or read
     * again on other cells. Resolves to its record (null when nothing was
     * recorded); never throws.
     *
     * @param {Object} facts - `shownDatasetFacts`
     * @param {{counted: boolean}} options
     */
    record(facts, { counted }) {
      return serial(async () => {
        try {
          const record = await onStore(async target => {
            const previous = readRecord(facts.id, await target.get(facts.id) ?? null);
            const next = nextRecord(previous, facts, { at: now(), counted });
            if (next !== null) await target.put(facts.id, next);
            return next;
          });
          if (record !== null) announce();
          return record === null ? null : readRecord(record.id, record);
        } catch (error) {
          console.warn('[My datasets] The dataset could not be kept in the list:', error);
          return null;
        }
      });
    },
    /**
     * Add the datasets `records` (each as `readRecord` gives it, checked
     * again here) that the list does not hold: a dataset it holds is never
     * replaced, whatever its record says. What a library file's import adds
     * (`library-file.js`). Resolves to the ids added, those already listed
     * (`present`) and those that could not be kept (`failed`: not a record,
     * or a write the browser refused); never throws.
     *
     * @param {Iterable<Object>} records
     * @returns {Promise<{added: string[], present: string[], failed: string[]}>}
     */
    add(records) {
      const wanted = [...records];
      return serial(async () => {
        const added = [];
        const present = [];
        const failed = [];
        for (const candidate of wanted) {
          const record = readRecord(candidate?.id, candidate);
          if (record === null) {
            failed.push(String(candidate?.id ?? ''));
            continue;
          }
          try {
            const kept = await onStore(async target => {
              if (await target.get(record.id) !== undefined) return false;
              await target.put(record.id, record);
              return true;
            });
            (kept ? added : present).push(record.id);
          } catch (error) {
            console.warn('[My datasets] A dataset could not be added to the list:', error);
            failed.push(record.id);
          }
        }
        if (added.length > 0) announce();
        return { added, present, failed };
      });
    },
    /**
     * Forget the datasets `ids` (null: every one). Resolves to how many were
     * forgotten; never throws.
     *
     * @param {Iterable<string>|null} ids
     */
    forget(ids) {
      return serial(async () => {
        let forgotten = 0;
        try {
          await onStore(async target => {
            const wanted = ids === null ? (await target.entries()).map(entry => entry.key) : [...ids];
            for (const id of wanted) {
              if (await target.get(id) === undefined) continue;
              await target.delete(id);
              forgotten++;
            }
          });
        } catch (error) {
          console.warn('[My datasets] A dataset could not be forgotten:', error);
        }
        if (forgotten > 0) announce();
        return forgotten;
      });
    },
    /**
     * Hear whenever a dataset is recorded or forgotten in this page.
     *
     * @param {() => void} listener
     * @returns {() => void}
     */
    onChange(listener) {
      return listeners.add(listener);
    },
  });
}

/** The page's list, opened once. */
let pageLibrary;

/** @returns {ReturnType<typeof createLibrary>} */
export function myDatasets() {
  pageLibrary ??= createLibrary({ store: indexedDbKeyValueStore(DB_NAME, STORE_NAME) });
  return pageLibrary;
}

/**
 * Record the dataset shown (`shownDatasetFacts`): opened now (`counted`),
 * or read again on other cells (only a dataset listed is updated). Never
 * throws.
 *
 * @param {Object|null} dataSourceManager
 * @param {{counted: boolean, library?: ReturnType<typeof createLibrary>}} options
 * @returns {Promise<Object|null>}
 */
export async function recordDatasetOpened(dataSourceManager, { counted, library = myDatasets() }) {
  const facts = shownDatasetFacts(dataSourceManager);
  return facts === null ? null : library.record(facts, { counted });
}

/**
 * Every dataset of the list, most recently opened first; never throws.
 *
 * @param {ReturnType<typeof createLibrary>} [library]
 */
export function listMyDatasets(library = myDatasets()) {
  return library.list();
}

/**
 * Hear when a dataset is recorded or forgotten in this page.
 *
 * @param {() => void} listener
 * @param {ReturnType<typeof createLibrary>} [library]
 * @returns {() => void}
 */
export function onMyDatasetsChange(listener, library = myDatasets()) {
  return library.onChange(listener);
}

/**
 * Forget the datasets `ids` (null: every one) and, for a file or folder,
 * the browser's handle of it; their saved states too only with
 * `savedStates`. Resolves to what was forgotten and removed; never throws.
 *
 * @param {Iterable<string>|null} ids
 * @param {{savedStates?: boolean, library?: ReturnType<typeof createLibrary>,
 *   forgetHandles?: (keys: string[]|null) => Promise<number>,
 *   listSaved?: () => Promise<Array<{id: string, dataset: {id: string|null}}>>,
 *   removeSaved?: (ids: string[]) => Promise<number>}} [options]
 * @returns {Promise<{datasets: number, handles: number, savedStates: number}>}
 */
export async function forgetMyDatasets(ids, {
  savedStates = false, library = myDatasets(), forgetHandles = forgetLocalFiles,
  listSaved = listSavedStates, removeSaved = removeSavedStates,
} = {}) {
  const wanted = ids === null ? null : new Set(ids);
  const chosen = (await library.list()).filter(entry => wanted === null || wanted.has(entry.id));
  const datasets = await library.forget(chosen.map(entry => entry.id));
  // Every handle with the whole list; else those of the files forgotten.
  const handleKeys = chosen.filter(entry => entry.source.kind === 'file').map(entry => entry.source.dataset);
  const handles = wanted === null ? await forgetHandles(null) : handleKeys.length > 0 ? await forgetHandles(handleKeys) : 0;
  let removed = 0;
  if (savedStates) {
    const of = new Set(chosen.map(entry => entry.id));
    const states = (await listSaved()).filter(state => of.has(state.dataset?.id));
    if (states.length > 0) removed = await removeSaved(states.map(state => state.id));
  }
  return { datasets, handles, savedStates: removed };
}
