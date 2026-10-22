/**
 * A dataset dropped onto the viewer opens through the same path as the file
 * inputs, anything else is refused with a message, and a dropped file never
 * makes the browser leave the page.
 *
 * Drags are synthetic: each test builds a real `DataTransfer` holding real
 * fixture bytes and dispatches `dragenter`, `dragover` and `drop` on the
 * viewer. A synthetic drop carries no file-system entries, so the folder case
 * gives its one item the directory entry a real folder drop would carry,
 * built from the fixture files.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './helpers/test.mjs';
import {
  H5AD,
  H5AD_PATH,
  START,
  TRAJECTORY,
  demoExportsDirectory,
  expectNeverPublished,
  expectNoFailureAnnounced,
  expectSettledOn,
  observePage,
  openStarted,
  openWithHeldStart,
  readRecord,
  releaseAndDrain,
  startUrl,
} from './helpers/dataset-loading.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const OVERLAY = '#dataset-drop-overlay';

async function filePayload(filePath, name = path.basename(filePath)) {
  return { name, base64: (await readFile(filePath)).toString('base64') };
}

async function folderPayload(directory) {
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
async function createDrag(page, { files = [], folder = null }) {
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
async function dragAndDrop(page, dataTransfer, { drop = true } = {}) {
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

test('a dropped .h5ad file opens like a picked one', async ({ page }) => {
  const productErrors = await openStarted(page);
  const drag = await createDrag(page, { files: [await filePayload(H5AD_PATH)] });
  const outcome = await dragAndDrop(page, drag);
  expect(outcome.over.every(event => event.defaultPrevented)).toBe(true);
  expect(outcome.dropTargetReady).toBe(true);
  expect(outcome.overlayShown).toBe(true);
  expect(outcome.dropped.defaultPrevented).toBe(true);
  await expect(page.locator(OVERLAY)).toBeHidden();
  await expectSettledOn(page, H5AD);
  const { notifications } = await readRecord(page);
  expect(
    notifications.filter(entry => /User data ready: 120 cells/.test(entry.text)),
  ).toHaveLength(1);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

test('a dropped prepared export folder opens like a picked one', async ({ page }) => {
  const productErrors = await openStarted(page);
  const drag = await createDrag(page, {
    folder: {
      name: TRAJECTORY.id,
      files: await folderPayload(path.join(demoExportsDirectory, TRAJECTORY.id)),
    },
  });
  await dragAndDrop(page, drag);
  await expectSettledOn(page, { ...TRAJECTORY, select: /^dataset:local-user:/ });
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

test('a file dropped while the startup dataset loads replaces it', async ({ page }) => {
  const { held, productErrors } = await openWithHeldStart(page);
  const drag = await createDrag(page, { files: [await filePayload(H5AD_PATH)] });
  await dragAndDrop(page, drag);
  await expectSettledOn(page, H5AD);
  await releaseAndDrain(page, held);
  await expectSettledOn(page, H5AD);
  await expectNeverPublished(page, START.name);
  expect(productErrors).toEqual([]);
});

for (const { title, payload, message } of [
  {
    title: 'a file that is not a dataset',
    payload: async () => ({
      files: [{ name: 'notes.txt', base64: Buffer.from('hello').toString('base64') }],
    }),
    message: /"notes\.txt" is not a file Cellucid can open/,
  },
  {
    title: 'two files at once',
    payload: async () => ({
      files: [
        await filePayload(H5AD_PATH),
        await filePayload(H5AD_PATH, 'second.h5ad'),
      ],
    }),
    message: /2 items were dropped; Cellucid opens one at a time/,
  },
]) {
  test(`${title} is refused with a message and nothing changes`, async ({ page }) => {
    const productErrors = await openStarted(page);
    const drag = await createDrag(page, await payload());
    const outcome = await dragAndDrop(page, drag);
    expect(outcome.dropped.defaultPrevented).toBe(true);
    await expect(
      page.locator('#notification-center .notification[data-type="error"]')
        .filter({ hasText: message }),
    ).toHaveCount(1);
    await expect(page.locator(OVERLAY)).toBeHidden();
    await expectSettledOn(page, START);
    expect(productErrors).toEqual([]);
  });
}

test('the overlay leaves when the drag does', async ({ page }) => {
  await openStarted(page);
  const drag = await createDrag(page, { files: [await filePayload(H5AD_PATH)] });
  const outcome = await dragAndDrop(page, drag, { drop: false });
  expect(outcome.overlayShown).toBe(true);
  await expect(page.locator(OVERLAY)).toBeVisible();
  // No more dragover: the pointer left the window or the drag was abandoned.
  await expect(page.locator(OVERLAY)).toBeHidden();
  await expectSettledOn(page, START);
});

test('before the data controls exist a dropped file is refused and never navigates', async ({
  page,
}) => {
  const productErrors = await observePage(page);
  // Hold the catalog, so the interface and its drop target are not built yet.
  let releaseCatalog = () => {};
  const catalogHeld = new Promise(resolve => {
    releaseCatalog = resolve;
  });
  await page.route(/\/demo-custom-exports\/datasets\.json/, async route => {
    await catalogHeld;
    await route.continue().catch(() => {});
  });
  await page.goto(startUrl(), { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#data-source-status')).toContainText(
    'Starting Cellucid',
  );
  const address = page.url();
  const drag = await createDrag(page, { files: [await filePayload(H5AD_PATH)] });
  const early = await dragAndDrop(page, drag);
  // Cancelled at the document, offered as "none", and nothing opens.
  expect(early.over.every(event => event.defaultPrevented)).toBe(true);
  expect(early.dropTargetReady).toBe(false);
  expect(early.overlayShown).toBe(false);
  expect(early.dropped.defaultPrevented).toBe(true);
  expect(page.url()).toBe(address);

  releaseCatalog();
  await dismissWelcome(page);
  await expectSettledOn(page, START);
  const ready = await dragAndDrop(
    page,
    await createDrag(page, { files: [await filePayload(H5AD_PATH)] }),
    { drop: false },
  );
  expect(ready.dropTargetReady).toBe(true);
  expect(ready.overlayShown).toBe(true);
  expect(page.url()).toBe(address);
  expect(productErrors).toEqual([]);
});
