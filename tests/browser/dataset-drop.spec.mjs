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
import path from 'node:path';
import { expect, test } from './helpers/test.mjs';
import {
  H5AD,
  H5AD_PATH,
  START,
  ZARR_FOLDER,
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
import {
  createDrag,
  dragAndDrop,
  filePayload,
  folderPayload,
} from './helpers/dataset-drop.mjs';

const OVERLAY = '#dataset-drop-overlay';

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

test('a dropped Zarr store folder opens like a picked one', async ({ page }) => {
  const productErrors = await openStarted(page);
  // Every file of the store, its hidden metadata files (`.zgroup`,
  // `.zattrs`, `.zmetadata`) with the rest, as a real folder drop lists them.
  const files = await folderPayload(ZARR_FOLDER.path);
  expect(files.some(file => file.path.endsWith('/.zmetadata'))).toBe(true);
  const drag = await createDrag(page, {
    folder: { name: path.basename(ZARR_FOLDER.path), files },
  });
  await dragAndDrop(page, drag);
  await expectSettledOn(page, ZARR_FOLDER);
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
  await page.route(/\/demo-catalog\/datasets\.json/, async route => {
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
