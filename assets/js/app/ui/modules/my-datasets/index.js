/**
 * @fileoverview My datasets in Session › Open data: the menu of the five
 * most recent (`menu.js`) and All… (`dialog.js`), drawn from the list this
 * browser keeps (`app/library/my-datasets.js`), the saved states of
 * histories (`app/history/current.js`, `autosave.js`), the files of this
 * computer whose handle is kept (`app/library/local-file-handles.js`) and
 * what the Stored machinery keeps (`data/anndata/transcode/space.js`).
 *
 * Opening a dataset of the list runs inside the person's click:
 *
 * - a sample, a link or a server opens through its connection
 *   (`openDatasetSource`), a file or folder of this computer through its
 *   kept handle (`reopenLocalFile`: the browser asks for leave to read it
 *   then, unless given); either with the cells it was last open with when
 *   they were chosen (`reopenRequestOf`, the next opening's request,
 *   withdrawn when the opening ends without taking it);
 * - a file or folder this browser keeps no handle of is chosen again: the
 *   click opens Open… › File… (or Folder…), and says which to choose;
 * - Continue opens the dataset (a file through its handle, in the click),
 *   then its latest saved state (`openSavedState`, which opens a dataset
 *   first when another is shown), so the history is put back at once,
 *   never offered.
 *
 * All… also writes and reads library files (`app/library/library-file.js`):
 * Export downloads a `.cellucid-library` of the datasets and saved states
 * ticked; Import adds those of one beside what is kept. A library file
 * dropped on the page or chosen in Open… › File… is imported the same way
 * (`importLibraryFile`), in All….
 *
 * What the list shows follows every change: a dataset recorded or
 * forgotten, another dataset shown, a handle kept or forgotten, and, while
 * All… is open, a saved state written or removed, the history shown and
 * what is stored.
 *
 * @module ui/modules/my-datasets
 */

import {
  forgetMyDatasets, listMyDatasets, myDatasets, onMyDatasetsChange, reopenRequestOf,
} from '../../../library/my-datasets.js';
import { listLocalFiles, localHandlesAvailable, onLocalFilesChange } from '../../../library/local-file-handles.js';
import { listSavedStates, onSavedStatesChange } from '../../../history/autosave.js';
import { LIBRARY_FILE_EXTENSION, exportLibrary, importLibrary } from '../../../library/library-file.js';
import { downloadBlob } from '../../../utils/download.js';
import { getSavedHistories, subscribeCurrentHistory } from '../../../history/current.js';
import { keptStoragePlace, listKeptStores, onKeptStoresChange } from '../../../../data/anndata/transcode/space.js';
import { setNextCellSubsetRequest, withdrawNextCellSubsetRequest } from '../../../../data/cell-subset-policy.js';
import { getNotificationCenter } from '../../../notification-center.js';
import { initMyDatasetsMenu } from './menu.js';
import { createMyDatasetsDialog } from './dialog.js';
import { datasetKind, reopenWay } from './model.js';
import { PLACES } from '../../place-names.js';
import { resolveMyDataset } from '../../../actions/targets/datasets.js';

/**
 * Open a dataset of the list with `open`, the cells it was last open with
 * the next opening's request when another dataset is shown
 * (`reopenRequestOf`): withdrawn when the opening ends without taking it.
 * `open` is called at once (inside a person's click, a file's leave to read
 * it is asked in it). The list's own Open and an agent's `dataset.open`
 * (`dataset-open-action.js`) both open this way.
 *
 * @template T
 * @param {{openCells: Object|null}} entry
 * @param {boolean} opensAnother - another dataset is shown now
 * @param {() => Promise<T>} open
 * @returns {Promise<T>}
 */
export async function openWithLastCells(entry, opensAnother, open) {
  const request = opensAnother ? reopenRequestOf(entry.openCells) : null;
  const held = request === null ? null : setNextCellSubsetRequest(request);
  try {
    return await open();
  } finally {
    if (held !== null) withdrawNextCellSubsetRequest(held);
  }
}

/** The page's My datasets' import of a library file, while it is initialised. */
let pageImport = null;

/**
 * Import a library file chosen outside All… (dropped on the page, or in
 * Open… › File…, `dataset-connections.js`): All… opens, and imports it as
 * its Import… does, saying in its status line what was added.
 *
 * @param {File} file
 */
export function importLibraryFile(file) {
  if (pageImport !== null) {
    pageImport(file);
    return;
  }
  getNotificationCenter().error(`${file.name} could not be imported: this page shows no ${PLACES.myDatasets.name}.`, { category: 'data' });
}

/** What the status line says of a list kept for this page only, or until the window closes. */
export const KEPT_FOR_THIS_PAGE = 'Kept for this page only: this window keeps nothing for this site.';
export const KEPT_UNTIL_WINDOW_CLOSES = 'Kept only until this window closes.';

/**
 * @param {{
 *   menu: {root: HTMLElement, button: HTMLButtonElement, menu: HTMLElement, status: HTMLElement},
 *   dialog: {dialog: HTMLDialogElement, filter: HTMLInputElement, status: HTMLElement, list: HTMLElement, empty: HTMLElement},
 *   fileItem: HTMLButtonElement, folderItem: HTMLButtonElement,
 * }} dom - `fileItem`/`folderItem`: Open…'s File… and Folder…, which choose a file again
 * @param {{
 *   currentId: () => string|null,
 *   onDatasetChange: (listener: () => void) => (() => void),
 *   openDatasetSource: (record: Object) => Promise<boolean>,
 *   reopenLocalFile: (datasetId: string) => Promise<boolean>,
 *   openSavedState: (id: string) => Promise<boolean>,
 *   library?: ReturnType<typeof myDatasets>,
 *   view?: Window,
 *   now?: () => number,
 * }} options - `currentId`: the identity of the dataset shown; `onDatasetChange`: be told when
 *   another is shown; the openers are the dataset controls' and the session controls'
 * @returns {{openAll: (opener?: HTMLElement|null) => void, refresh: () => Promise<void>, destroy: () => void}}
 */
export function initMyDatasets(dom, {
  currentId, onDatasetChange, openDatasetSource, reopenLocalFile, openSavedState,
  library = myDatasets(), view = globalThis, now = Date.now, actions = null,
}) {
  for (const [name, value] of Object.entries({ currentId, onDatasetChange, openDatasetSource, reopenLocalFile, openSavedState })) {
    if (typeof value !== 'function') throw new TypeError(`My datasets needs ${name}().`);
  }
  if (!dom?.fileItem || !dom?.folderItem) throw new TypeError('My datasets needs Open…\'s File… and Folder….');
  const handlesAvailable = localHandlesAvailable(view);
  /** The datasets whose file's handle is kept, as last read. */
  let handles = new Set();
  let destroyed = false;
  let generation = 0;
  /** Whether this window keeps what the site stores beyond it (asked once: a private window does not). */
  const lastingWindow = keptStoragePlace().then(place => place.available !== false, () => true);
  const way = entry => reopenWay(entry, { handlesAvailable, handles });

  function failed(entry, error) {
    console.error(`[My datasets] Opening ${entry.name} failed:`, error);
    getNotificationCenter().error(`${entry.name} could not be opened from My datasets.`, {
      category: 'data',
      details: error instanceof Error ? error.message : String(error),
    });
  }

  /** Choose a file or folder again with Open…'s own pickers, inside the click, saying which. */
  function chooseAgain(entry) {
    (datasetKind(entry) === 'folder' ? dom.folderItem : dom.fileItem).click();
    getNotificationCenter().info(
      `Choose "${entry.source.name}" to open it again: this browser does not let a page reopen a file by itself.`,
      { category: 'data' }
    );
  }

  /**
   * Open `entry` again (with `state`: then its saved state). Runs inside the
   * person's click: a file's leave to read it is asked in it.
   */
  function reopen(entry, state = null) {
    if (destroyed) return;
    if (way(entry) === 'choose') {
      chooseAgain(entry);
      return;
    }
    const opensAnother = currentId() !== entry.id;
    void openWithLastCells(entry, opensAnother, async () => {
      if (entry.source.kind === 'file' && opensAnother) {
        // In the click: the browser asks for leave to read it now, not after a later await.
        const opened = await reopenLocalFile(entry.source.dataset);
        if (!opened || state === null) return;
      } else if (state === null) {
        await openDatasetSource(entry.source);
        return;
      }
      // Its history at once: the saved state opens its dataset first when another is shown.
      await openSavedState(state.id);
    }).catch(error => failed(entry, error));
  }

  /** Forget, as the row's Forget does: the entry, its file's handle, its saved states only when asked. */
  async function forget(entry, { savedStates }) {
    return forgetMyDatasets([entry.id], { savedStates, library });
  }

  // An agent's, a notebook's or a replay's Forget (`my-datasets.forget`), by the name the list shows.
  const unprovide = actions === null ? () => {} : actions.provide('my-datasets.forget', async ({ name, saved_states: savedStates }) => {
    const entry = resolveMyDataset(name, await listMyDatasets(library), 'my-datasets.forget');
    const forgotten = await forget(entry, { savedStates });
    return { name: entry.name, handles: forgotten.handles, saved_states: forgotten.savedStates };
  });

  const menu = initMyDatasetsMenu(dom.menu, {
    onChoose: entry => reopen(entry),
    onAll: opener => openAll(opener),
  });
  const dialog = createMyDatasetsDialog(dom.dialog, {
    onOpen: (entry, state) => reopen(entry, state),
    onForget: (entry, options) => forget(entry, options),
    onExport: async ({ datasets, savedStates }) => {
      const written = await exportLibrary({ datasets, savedStates, library });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      downloadBlob(written.blob, `cellucid-library-${timestamp}${LIBRARY_FILE_EXTENSION}`);
      return written;
    },
    onImport: file => importLibrary(file, { library }),
  });

  /** The saved states, the history shown marked (`current`). */
  async function savedStates() {
    const published = getSavedHistories();
    try {
      return published === null ? await listSavedStates() : await published.list();
    } catch {
      return [];
    }
  }

  async function refresh() {
    if (destroyed) return;
    const mine = ++generation;
    const all = dialog.isOpen;
    const [entries, saved, local, kept, lastingHere] = await Promise.all([
      listMyDatasets(library),
      all ? savedStates() : Promise.resolve([]),
      handlesAvailable ? listLocalFiles() : Promise.resolve([]),
      all ? listKeptStores().catch(() => []) : Promise.resolve([]),
      lastingWindow,
    ]);
    if (destroyed || mine !== generation) return;
    handles = new Set(local.map(file => file.key));
    const note = !library.lasting ? KEPT_FOR_THIS_PAGE : lastingHere ? '' : KEPT_UNTIL_WINDOW_CLOSES;
    const at = now();
    const id = currentId();
    menu.render({ entries, currentId: id, now: at, way, note });
    if (dialog.isOpen) dialog.render({ entries, saved, kept, currentId: id, way, now: at });
  }

  function openAll(opener = null) {
    if (destroyed) return;
    dialog.open(opener);
    void refresh();
  }

  // Saved states, the history shown (which saved state is its own) and what
  // is stored are drawn by All… alone: read again while it is open (a step
  // writes the autosave, so not at every step otherwise).
  const whileAllOpen = () => {
    if (dialog.isOpen) void refresh();
  };
  const stops = [
    onMyDatasetsChange(() => void refresh(), library),
    onLocalFilesChange(() => void refresh()),
    onDatasetChange(() => void refresh()),
    onSavedStatesChange(whileAllOpen),
    subscribeCurrentHistory(whileAllOpen),
    onKeptStoresChange(whileAllOpen),
  ];
  void refresh();

  const importHere = file => {
    if (destroyed) return;
    openAll();
    void dialog.importFile(file);
  };
  pageImport = importHere;

  return {
    openAll,
    refresh,
    destroy() {
      destroyed = true;
      unprovide();
      if (pageImport === importHere) pageImport = null;
      for (const stop of stops) stop();
      menu.destroy();
      dialog.destroy();
    },
  };
}
