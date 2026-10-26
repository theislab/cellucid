/**
 * Synthetic drags for the dataset drop target (`ui/modules/dataset-drop.js`):
 * a real `DataTransfer` holding real fixture bytes, dispatched on the viewer.
 * A synthetic drop carries no file-system entries, so a folder's one item is
 * given the directory entry a real folder drop would carry, built from the
 * fixture files (hidden ones included, as a dropped folder lists them).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chooseDirectory } from './directory-upload.mjs';

export async function filePayload(filePath, name = path.basename(filePath)) {
  return { name, base64: (await readFile(filePath)).toString('base64') };
}

export async function folderPayload(directory) {
  const files = [];
  const walk = async (absolute, relative) => {
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const entryPath = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(absolute, entry.name), entryPath);
      } else {
        files.push({
          path: entryPath,
          base64: (await readFile(path.join(absolute, entry.name)))
            .toString('base64'),
        });
      }
    }
  };
  await walk(directory, path.basename(directory));
  return files;
}

/**
 * Build a DataTransfer in the page. `files` become its file items; with
 * `folder`, its single item answers `webkitGetAsEntry()` with a directory
 * entry over those files, as a dropped folder does.
 */
export async function createDrag(page, { files = [], folder = null }) {
  return page.evaluateHandle(({ files, folder }) => {
    const decode = base64 => Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const dataTransfer = new DataTransfer();
    for (const file of files) {
      dataTransfer.items.add(new File([decode(file.base64)], file.name));
    }
    if (folder !== null) {
      const root = { name: folder.name, children: new Map() };
      for (const file of folder.files) {
        const parts = file.path.split('/').slice(1);
        let node = root;
        for (const part of parts.slice(0, -1)) {
          if (!node.children.has(part)) {
            node.children.set(part, { name: part, children: new Map() });
          }
          node = node.children.get(part);
        }
        const name = parts.at(-1);
        node.children.set(name, { name, file: new File([decode(file.base64)], name) });
      }
      const toEntry = node => (node.file !== undefined
        ? {
            isFile: true,
            isDirectory: false,
            name: node.name,
            file: ok => ok(node.file),
          }
        : {
            isFile: false,
            isDirectory: true,
            name: node.name,
            createReader() {
              let listed = false;
              return {
                readEntries(ok) {
                  ok(listed ? [] : [...node.children.values()].map(toEntry));
                  listed = true;
                },
              };
            },
          });
      // An item wrapper is created afresh on every read of `items`, so the
      // folder's entry is answered by the prototype for its placeholder file.
      dataTransfer.items.add(new File([new Uint8Array()], folder.name));
      const entry = toEntry(root);
      const nativeEntry = DataTransferItem.prototype.webkitGetAsEntry;
      DataTransferItem.prototype.webkitGetAsEntry = function webkitGetAsEntry() {
        const file = this.getAsFile();
        if (file !== null && file.name === folder.name && file.size === 0) {
          return entry;
        }
        return nativeEntry === undefined ? null : nativeEntry.call(this);
      };
    }
    return dataTransfer;
  }, { files, folder });
}

/** Drag over the viewer, then drop; returns whether the page cancelled it. */
export async function dragAndDrop(page, dataTransfer, { drop = true } = {}) {
  return page.evaluate(({ dataTransfer, drop }) => {
    const target = document.getElementById('glcanvas');
    const fire = type => {
      const event = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      target.dispatchEvent(event);
      return { defaultPrevented: event.defaultPrevented };
    };
    const over = [fire('dragenter'), fire('dragover')];
    const overlayShown = !document.getElementById('dataset-drop-overlay').hidden;
    // Whether the drop target offers a copy (the guard offers "none" until it
    // is ready). A synthetic DataTransfer does not keep `dropEffect`, so the
    // readiness the guard reads is reported instead.
    const dropTargetReady = document.documentElement.dataset.datasetDrop === 'ready';
    const dropped = drop ? fire('drop') : null;
    return { over, overlayShown, dropTargetReady, dropped };
  }, { dataTransfer, drop });
}


/**
 * Open a Zarr store folder the way a person can in this engine: WebKit's
 * folder dialog leaves out hidden files, where a Zarr v2 store keeps its
 * metadata, so there the folder is dropped on the page; elsewhere it is
 * chosen with Open… › Folder….
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} browserName
 * @param {string} directory
 */
export async function openZarrFolder(page, browserName, directory) {
  if (browserName === 'webkit') {
    const drag = await createDrag(page, {
      folder: { name: path.basename(directory), files: await folderPayload(directory) },
    });
    await dragAndDrop(page, drag);
    return;
  }
  await chooseDirectory(page.locator('#user-data-folder-input'), directory);
}
