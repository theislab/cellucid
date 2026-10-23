/**
 * @fileoverview Open a dataset by dropping it onto the viewer.
 *
 * A drag that carries files shows one overlay across the whole viewer. A drop
 * of exactly one H5AD file, one AnnData Zarr store folder or one Zarr ZIP
 * archive is opened through the same reader as the matching file input — the
 * caller's `openDataset` — so it is validated, reported and superseded
 * exactly as a picked file is. Anything else is refused with a message that
 * says what can be dropped.
 *
 * The browser's own reaction to a dropped file is to navigate to it, which
 * would leave the application. `ui/core/file-drop-guard.js`, a classic script
 * that runs before any module, cancels that for the whole document from the
 * first paint; this module adds the opening. Keyboard and screen-reader users
 * keep the H5AD, Zarr ZIP and Zarr folder buttons, which reach the same
 * readers.
 *
 * @module ui/modules/dataset-drop
 */

import { isH5adFile } from '../../../data/h5ad.js';
import { isZarrZipArchive } from '../../../data/local-user-source.js';

/**
 * Set on the root element while a drop opens a dataset. The guard reads it to
 * decide whether a file drag is offered as a copy or refused.
 */
export const DATASET_DROP_READY_ATTRIBUTE = 'datasetDrop';
const DATASET_DROP_READY_VALUE = 'ready';

/** How long a drag may go without a `dragover` before the overlay retires. */
const DRAG_IDLE_MS = 250;

const WHAT_CAN_BE_DROPPED =
  'Drop one .h5ad file, one .zarr folder, or one .zarr.zip archive.';

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

function readDirectoryBatch(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function readEntryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/**
 * List every file under a dropped folder, each carrying the path a folder
 * input would give it (`<folder>/<path inside>`), which is what the Zarr
 * folder reader takes. Hidden files (`.zgroup`, `.zarray`, `.zattrs`,
 * `.zmetadata`) are listed like any other.
 *
 * @param {FileSystemDirectoryEntry} root
 * @returns {Promise<File[]>}
 */
export async function readDroppedFolder(root) {
  const files = [];
  const pending = [[root, root.name]];
  while (pending.length > 0) {
    const [directory, directoryPath] = pending.shift();
    const reader = directory.createReader();
    // readEntries() answers in batches until it answers with none.
    for (;;) {
      const batch = await readDirectoryBatch(reader);
      if (batch.length === 0) break;
      for (const entry of batch) {
        const entryPath = `${directoryPath}/${entry.name}`;
        if (entry.isDirectory) {
          pending.push([entry, entryPath]);
        } else if (entry.isFile) {
          const file = await readEntryFile(entry);
          Object.defineProperty(file, 'webkitRelativePath', {
            configurable: true,
            enumerable: true,
            value: entryPath
          });
          files.push(file);
        }
      }
    }
  }
  return files;
}

/**
 * Decide what a drop is. It must run inside the `drop` event: the items of a
 * DataTransfer are readable only while that event is dispatched.
 *
 * @param {DataTransfer} dataTransfer
 * @returns {Readonly<
 *   {kind: 'h5ad'|'zarr-zip'|'zarr-folder', label: string,
 *     readFiles: () => Promise<ArrayLike<File>>} |
 *   {kind: 'refused', message: string}
 * >}
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
      `${count} items were dropped; Cellucid opens one at a time.`
    );
  }

  const item = items === null ? null : items[0];
  const entry = typeof item?.webkitGetAsEntry === 'function'
    ? item.webkitGetAsEntry()
    : null;
  if (entry?.isDirectory) {
    // A folder is read as an AnnData Zarr store; one that is not is refused
    // by the reader, which says what it lacks.
    return Object.freeze({
      kind: 'zarr-folder',
      label: entry.name,
      readFiles: () => readDroppedFolder(entry)
    });
  }

  const file = item === null ? looseFiles[0] : item.getAsFile();
  if (file === null || file === undefined) {
    return refusal(`The dropped item could not be read. ${WHAT_CAN_BE_DROPPED}`);
  }
  const readFiles = async () => [file];
  if (isH5adFile(file)) {
    return Object.freeze({ kind: 'h5ad', label: file.name, readFiles });
  }
  if (isZarrZipArchive(file)) {
    return Object.freeze({ kind: 'zarr-zip', label: file.name, readFiles });
  }
  return refusal(`"${file.name}" is not a file Cellucid can open. ${WHAT_CAN_BE_DROPPED}`);
}

/**
 * Make the whole viewer a drop target for datasets.
 *
 * @param {object} options
 * @param {Document} options.documentOwner
 * @param {HTMLElement} options.overlay Shown while files are dragged over the page.
 * @param {(drop: {kind: string, label: string,
 *   readFiles: () => Promise<ArrayLike<File>>}) => void} options.openDataset
 * @param {(message: string) => void} options.refuse
 * @returns {() => void} Retires the drop target.
 */
export function initDatasetDrop({ documentOwner, overlay, openDataset, refuse }) {
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
  if (typeof openDataset !== 'function' || typeof refuse !== 'function') {
    throw new TypeError('Dataset drop requires openDataset and refuse.');
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
