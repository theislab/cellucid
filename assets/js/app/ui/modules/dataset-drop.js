/**
 * @fileoverview Open a dataset by dropping it onto the viewer.
 *
 * A drag that carries files shows one overlay across the whole viewer. A drop
 * of exactly one file or one folder whose name a format of
 * `data/input-formats.js` names (any file, folder or archive the registry
 * lists) is opened through the same reader as the matching file input — the
 * caller's `openDataset` — so it is validated, reported and superseded
 * exactly as a picked file is. A dropped folder's files are listed
 * concurrently (`data/local-folder.js`), and where the browser gives the
 * item's handle (Chromium) it travels with the drop, to be kept for a
 * one-click reopen (`app/library/local-file-handles.js`). A library file of
 * My datasets (`.cellucid-library`, `CELLUCID_FILES`) goes to its Import; a
 * session file is refused with the sentence saying what it is and where it
 * goes. Anything else is refused with a message that says what can be
 * dropped.
 *
 * The browser's own reaction to a dropped file is to navigate to it, which
 * would leave the application. `ui/core/file-drop-guard.js`, a classic script
 * that runs before any module, cancels that for the whole document from the
 * first paint; this module adds the opening. Keyboard and screen-reader users
 * keep the Session panel's Open… menu (File… and Folder…), which reaches
 * the same readers.
 *
 * @module ui/modules/dataset-drop
 */

import { cellucidFileOfName, fileFormatOfName, openableNamePhrases } from '../../../data/input-formats.js';
import { readFolderEntry, readFolderHandle } from '../../../data/local-folder.js';
import { formatCountOf } from '../../../utils/format-units.js';

/**
 * Set on the root element while a drop opens a dataset. The guard reads it to
 * decide whether a file drag is offered as a copy or refused.
 */
export const DATASET_DROP_READY_ATTRIBUTE = 'datasetDrop';
const DATASET_DROP_READY_VALUE = 'ready';

/** How long a drag may go without a `dragover` before the overlay retires. */
const DRAG_IDLE_MS = 250;

const WHAT_CAN_BE_DROPPED = (() => {
  const phrases = openableNamePhrases().map(phrase => `one ${phrase}`);
  return `Drop ${phrases.length > 1 ? `${phrases.slice(0, -1).join(', ')}, or ${phrases.at(-1)}` : phrases[0]}.`;
})();

/**
 * @param {DataTransfer|null|undefined} dataTransfer
 * @returns {boolean} Whether the drag carries files from outside the page.
 */
export function carriesFiles(dataTransfer) {
  const types = dataTransfer?.types;
  return types != null && Array.from(types).includes('Files');
}

function refusal(message) {
  return Object.freeze({ kind: 'refused', message });
}

/**
 * How one local file arrives, by what its name says it is
 * (`data/input-formats.js`): `file` (a file that is the container itself, an
 * `.h5ad`) or `zip` (a ZIP archive holding a store, a `.zarr.zip`); null for
 * a name no format has. The picked-file input and a drop share it; the
 * reader then decides from the content.
 *
 * @param {File} file
 * @returns {'file'|'zip'|null}
 */
export function localFileLayout(file) {
  const named = typeof file?.name === 'string' ? fileFormatOfName(file.name) : null;
  return named === null ? null : named.layout;
}

/**
 * The browser's handle of a dropped item, asked for inside the `drop` event
 * as its items are: a promise answering it, or null (an item the browser has
 * no handle for, or a browser without them).
 *
 * @param {DataTransferItem|null} item
 * @returns {Promise<FileSystemHandle|null>|null}
 */
function droppedHandleOf(item) {
  if (typeof item?.getAsFileSystemHandle !== 'function') return null;
  try {
    return Promise.resolve(item.getAsFileSystemHandle()).then(found => found ?? null, () => null);
  } catch {
    return null;
  }
}

/**
 * Decide what a drop is. It must run inside the `drop` event: the items of a
 * DataTransfer are readable only while that event is dispatched.
 *
 * `readFiles` yields what was dropped (a folder's every file, listed
 * concurrently, `data/local-folder.js`, through its handle where the drop
 * gave one; `signal` stops the listing).
 * `handle` is the browser's handle of the dropped file or folder where it
 * gives one (Chromium's `getAsFileSystemHandle`), so it can be kept for a
 * reopen (`app/library/local-file-handles.js`); null elsewhere, and its promise
 * answers null when the browser has none for this item.
 *
 * @param {DataTransfer} dataTransfer
 * @returns {Readonly<
 *   {kind: 'file'|'zip'|'folder', label: string,
 *     readFiles: (options?: {signal?: AbortSignal|null}) => Promise<ArrayLike<File>>,
 *     handle: Promise<FileSystemHandle|null>|null} |
 *   {kind: 'library', label: string, file: File} |
 *   {kind: 'refused', message: string}
 * >} `library`: a library file of My datasets, to import
 */
export function describeDatasetDrop(dataTransfer) {
  const items = dataTransfer.items == null
    ? null
    : Array.from(dataTransfer.items).filter(item => item.kind === 'file');
  const looseFiles = Array.from(dataTransfer.files ?? []);
  const count = items === null ? looseFiles.length : items.length;
  if (count === 0) {
    return refusal(`Nothing that can be opened was dropped. ${WHAT_CAN_BE_DROPPED}`);
  }
  if (count > 1) {
    return refusal(
      `${formatCountOf(count, 'item')} were dropped; Cellucid opens one at a time.`
    );
  }

  const item = items === null ? null : items[0];
  const entry = typeof item?.webkitGetAsEntry === 'function'
    ? item.webkitGetAsEntry()
    : null;
  const handle = droppedHandleOf(item);
  if (entry?.isDirectory) {
    // A folder is read as a store folder; one that is not is refused by the
    // reader, which says what it lacks. Chromium lists a dropped folder
    // faster through its handle than through its entries, whose calls its
    // file system answers one at a time however many are asked at once
    // (measured on real drops, medians of five: 22,023 files in 2.7 s
    // against 4.4 s, `suo.zarr`'s 6,272 in 0.63 s against 1.2 s), so its
    // handle is read where the drop gave one.
    return Object.freeze({
      kind: 'folder',
      label: entry.name,
      readFiles: async ({ signal = null } = {}) => {
        const folder = handle === null ? null : await handle;
        return folder?.kind === 'directory'
          ? readFolderHandle(folder, { signal })
          : readFolderEntry(entry, { signal });
      },
      handle
    });
  }

  const file = item === null ? looseFiles[0] : item.getAsFile();
  if (file === null || file === undefined) {
    return refusal(`The dropped item could not be read. ${WHAT_CAN_BE_DROPPED}`);
  }
  // Cellucid's own files are no dataset: a library file is imported, a session file says where it goes.
  const own = cellucidFileOfName(file.name);
  if (own?.id === 'library') return Object.freeze({ kind: 'library', label: file.name, file });
  if (own !== null) return refusal(own.said);
  const readFiles = async () => [file];
  const layout = localFileLayout(file);
  if (layout !== null) return Object.freeze({ kind: layout, label: file.name, readFiles, handle });
  return refusal(`"${file.name}" is not a file Cellucid can open. ${WHAT_CAN_BE_DROPPED}`);
}

/**
 * Make the whole viewer a drop target for datasets.
 *
 * @param {object} options
 * @param {Document} options.documentOwner
 * @param {HTMLElement} options.overlay Shown while files are dragged over the page.
 * @param {(drop: {kind: string, label: string,
 *   readFiles: (options?: {signal?: AbortSignal|null}) => Promise<ArrayLike<File>>,
 *   handle: Promise<FileSystemHandle|null>|null}) => void} options.openDataset
 * @param {(file: File) => void} options.importLibrary A library file of My datasets dropped: its import.
 * @param {(message: string) => void} options.refuse
 * @returns {() => void} Retires the drop target.
 */
export function initDatasetDrop({ documentOwner, overlay, openDataset, importLibrary, refuse }) {
  if (
    documentOwner === null ||
    typeof documentOwner?.addEventListener !== 'function' ||
    documentOwner.documentElement?.dataset === undefined
  ) {
    throw new TypeError('Dataset drop requires the owning document.');
  }
  if (overlay === null || typeof overlay !== 'object' || !('hidden' in overlay)) {
    throw new TypeError('Dataset drop requires its overlay element.');
  }
  if (typeof openDataset !== 'function' || typeof importLibrary !== 'function' || typeof refuse !== 'function') {
    throw new TypeError('Dataset drop requires openDataset, importLibrary and refuse.');
  }
  const view = documentOwner.defaultView;
  const lifecycle = new AbortController();
  let idleTimer = null;

  const hideOverlay = () => {
    if (idleTimer !== null) {
      view.clearTimeout(idleTimer);
      idleTimer = null;
    }
    overlay.hidden = true;
  };
  // `dragleave` is unreliable at the window edge across engines, while a drag
  // over the page reports `dragover` continuously. The overlay therefore
  // retires shortly after the last one.
  const showOverlay = () => {
    overlay.hidden = false;
    if (idleTimer !== null) view.clearTimeout(idleTimer);
    idleTimer = view.setTimeout(hideOverlay, DRAG_IDLE_MS);
  };

  const onDragOver = event => {
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    showOverlay();
  };
  const onDrop = event => {
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    hideOverlay();
    const drop = describeDatasetDrop(event.dataTransfer);
    if (drop.kind === 'refused') {
      refuse(drop.message);
      return;
    }
    if (drop.kind === 'library') {
      importLibrary(drop.file);
      return;
    }
    openDataset(drop);
  };

  const listenerOptions = { signal: lifecycle.signal };
  documentOwner.addEventListener('dragenter', onDragOver, listenerOptions);
  documentOwner.addEventListener('dragover', onDragOver, listenerOptions);
  documentOwner.addEventListener('drop', onDrop, listenerOptions);
  documentOwner.addEventListener('dragend', hideOverlay, listenerOptions);
  documentOwner.documentElement.dataset[DATASET_DROP_READY_ATTRIBUTE] =
    DATASET_DROP_READY_VALUE;

  return function destroyDatasetDrop() {
    lifecycle.abort();
    hideOverlay();
    delete documentOwner.documentElement.dataset[DATASET_DROP_READY_ATTRIBUTE];
  };
}
