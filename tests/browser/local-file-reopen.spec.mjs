/**
 * A file or folder opened from this computer reopens with one click (audit
 * ST-19), where the browser hands the page a handle of it (Chromium): after
 * a reload of the tab that showed it, and when a session saved on it is
 * loaded. The click on **Reopen <name>** is what lets the browser ask for
 * leave to read it again; a session whose file the browser already lets be
 * read opens it without asking. Firefox and WebKit give no handle: Open…
 * uses the file inputs as before, and nothing is kept, offered or said.
 *
 * File… is answered with a file of the origin-private file system holding
 * the fixture (`helpers/local-file-pickers.mjs`). Leave to read it is the
 * browser's to give. Chromium keeps it across a reload of the tab (measured:
 * a real dropped folder's handle is `granted` after a reload); here it is
 * withheld after the reload, as in a new browser session, so it is asked for
 * in the click, granted, and recorded with whether the page had the click's
 * user activation then. A dropped folder is a real directory drop
 * (Chromium's `Input.dispatchDragEvent`), whose real handle is read again.
 * The handles kept are listed by My datasets (`my-datasets.spec.mjs`).
 */
import path from 'node:path';
import { expect, test } from './helpers/test.mjs';
import {
  H5AD,
  H5AD_PATH,
  START,
  ZARR_FOLDER,
  expectNoFailureAnnounced,
  expectSettledOn,
  openStarted,
  chooseSessionFile,
  readRecord,
} from './helpers/dataset-loading.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels, openSessionSectionsOnLoad } from './helpers/panels.mjs';
import { answerPickers as answerPickersWith, pickWithFileItem } from './helpers/local-file-pickers.mjs';
import { appUrl } from './helpers/origins.mjs';
import { clickSaveSession } from './helpers/session-buttons.mjs';

// Cells to open, Genes read for and the data mapping are in the Session
// panel's sections, collapsed by default: open, as a viewer who opened them.
test.beforeEach(async ({ page }) => {
  await openSessionSectionsOnLoad(page);
});

const CHROMIUM_ONLY = 'Only Chromium gives a page handles of the files it opens';
const WITHOUT_HANDLES = 'Chromium gives handles: its own tests cover it';
const NAME = path.basename(H5AD_PATH);
const RELOAD_OFFER = `"${NAME}" was open in this tab before the page was reloaded.`;
const SESSION_OFFER = `This session was saved on "${NAME}", opened from this computer.`;

/** File… answered with the fixture's file of the origin-private file system. */
function answerPickers(page) {
  return answerPickersWith(page, { name: NAME, url: appUrl('/tests/browser/fixtures/current-ui-smoke.h5ad') });
}

async function reload(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expectSettledOn(page, START);
}

/** The handles kept (`listLocalFiles`): the files of this computer reopened with one click. */
function keptHandles(page) {
  return page.evaluate(async () => (await import('/assets/js/app/library/local-file-handles.js')).listLocalFiles());
}

/** One handle is kept, and My datasets lists its file, to reopen with one click. */
async function expectFileToReopen(page) {
  await expect.poll(async () => (await keptHandles(page)).length).toBe(1);
  await expect.poll(() => page.evaluate(async () => {
    const { listMyDatasets } = await import('/assets/js/app/library/my-datasets.js');
    return (await listMyDatasets()).filter(entry => entry.source.kind === 'file').map(entry => entry.source.name);
  })).toHaveLength(1);
}

function offer(page, text) {
  return page.locator('#notification-center .notification').filter({ hasText: text });
}

/** How many restores were announced as complete in this page. */
async function restores(page) {
  const { notifications } = await readRecord(page);
  return new Set(notifications.filter(entry => /Session fully restored/.test(entry.text)).map(entry => entry.id)).size;
}

test('a file picked with File… is offered back after a reload, and its click reopens it', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', CHROMIUM_ONLY);
  await answerPickers(page);
  const productErrors = await openStarted(page);
  await pickWithFileItem(page);
  await expectSettledOn(page, H5AD);
  await expectFileToReopen(page);

  await reload(page);
  const reopen = offer(page, RELOAD_OFFER);
  await expect(reopen).toHaveCount(1);
  await reopen.getByRole('button', { name: `Reopen ${NAME}` }).click();
  await expectSettledOn(page, H5AD);
  // Asked once, for reading, inside the click.
  expect(await page.evaluate(() => window.__reopenAsked)).toEqual([{ mode: 'read', inClick: true }]);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

test('a session saved on a picked file reopens it with one click, then applies; once allowed, without one', async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', CHROMIUM_ONLY);
  await answerPickers(page);
  const productErrors = await openStarted(page);
  await pickWithFileItem(page);
  await expectSettledOn(page, H5AD);
  const download = page.waitForEvent('download');
  await clickSaveSession(page);
  const sessionPath = testInfo.outputPath('picked.cellucid-session');
  await (await download).saveAs(sessionPath);

  await reload(page);
  await chooseSessionFile(page, sessionPath);
  const reopen = offer(page, SESSION_OFFER);
  await expect(reopen).toHaveCount(1);
  // Nothing is applied before the file is open.
  await expectSettledOn(page, START);
  await reopen.getByRole('button', { name: `Reopen ${NAME}` }).click();
  await expectSettledOn(page, H5AD);
  await expect.poll(() => restores(page)).toBe(1);
  // The reload's offer of the same file leaves once it is open.
  await expect(offer(page, RELOAD_OFFER)).toHaveCount(0);
  expect(await page.evaluate(() => window.__reopenAsked)).toEqual([{ mode: 'read', inClick: true }]);

  // Another dataset open, the browser already lets the file be read: the
  // session opens it without asking, then applies.
  await page.locator('#dataset-select').selectOption(START.select);
  await expectSettledOn(page, START);
  await chooseSessionFile(page, sessionPath);
  await expectSettledOn(page, H5AD);
  await expect.poll(() => restores(page)).toBe(2);
  expect(await page.evaluate(() => window.__reopenAsked)).toHaveLength(1);
  await expect(offer(page, SESSION_OFFER)).toHaveCount(0);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

test('a real folder dropped on the viewer keeps its handle, and a session reads the folder again through it', async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', CHROMIUM_ONLY);
  const productErrors = await openStarted(page);
  const client = await page.context().newCDPSession(page);
  const box = await page.locator('#glcanvas').boundingBox();
  const data = { items: [], files: [ZARR_FOLDER.path], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await client.send('Input.dispatchDragEvent', {
      type, x: box.x + box.width / 2, y: box.y + box.height / 2, data,
    });
  }
  await expectSettledOn(page, ZARR_FOLDER);
  await openCollapsedPanels(page);
  await expectFileToReopen(page);
  const download = page.waitForEvent('download');
  await clickSaveSession(page);
  const sessionPath = testInfo.outputPath('dropped.cellucid-session');
  await (await download).saveAs(sessionPath);

  await page.locator('#dataset-select').selectOption(START.select);
  await expectSettledOn(page, START);
  await chooseSessionFile(page, sessionPath);
  // Dropped in this page, the folder may be read: no click is asked for.
  await expectSettledOn(page, ZARR_FOLDER);
  await expect.poll(() => restores(page)).toBe(1);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});

test('without handles, Open… uses the file inputs and a reload offers nothing', async ({ page, browserName }) => {
  test.skip(browserName === 'chromium', WITHOUT_HANDLES);
  const productErrors = await openStarted(page);
  await openCollapsedPanels(page);
  await page.locator('#user-data-open-btn').click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#user-data-file-item').click();
  await (await chooser).setFiles(H5AD_PATH);
  await expectSettledOn(page, H5AD);
  await expect.poll(() => keptHandles(page)).toEqual([]);

  await reload(page);
  // The page says nothing of a feature this browser lacks.
  await expect(page.locator('#notification-center')).not.toContainText('Reopen');
  await expect(page.locator('#notification-center')).not.toContainText('was open in this tab');
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});
