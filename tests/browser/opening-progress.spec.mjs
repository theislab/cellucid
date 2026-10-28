import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseFiles } from './helpers/file-input.mjs';

// Every opening is shown from its first moment (data/opening-progress.js,
// app/opening-progress-view.js): over the empty viewer while no dataset is
// shown, as a notification with Cancel while one is. At startup the size
// probe of the linked file is held back, so the opening is still under way
// when it is looked at.
const FIXTURE = `${SAMPLE_ORIGIN}/tests/browser/fixtures/current-ui-smoke.h5ad`;
const PINNED = `sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&`;
const ARCHIVE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'current-ui-smoke.zarr.zip');

/** Hold the probe (`HEAD`) of `url` until the returned release is called. */
async function holdProbe(page, url) {
  let release;
  const released = new Promise(resolve => {
    release = resolve;
  });
  await page.context().route(url, async route => {
    if (route.request().method() === 'HEAD') await released;
    await route.continue();
  });
  return release;
}

test('a link opening at startup is shown over the empty viewer, and Cancel starts without it', async ({ page }) => {
  const release = await holdProbe(page, FIXTURE);
  await page.goto(`/?${PINNED}data=${encodeURIComponent(FIXTURE)}`, { waitUntil: 'domcontentloaded' });

  const overlay = page.locator('.opening-overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('.opening-title')).toHaveText(`Opening ${FIXTURE}`);
  await expect(overlay.locator('.opening-step')).toHaveText(/^Checking current-ui-smoke\.h5ad on /);
  // While nothing has arrived, how long it has waited is said.
  await expect(overlay.locator('.opening-detail')).toHaveText(/\d s$|\d ms$/);

  await overlay.getByRole('button', { name: 'Cancel' }).click();
  await expect(overlay).toBeHidden();
  await expect(
    page.locator('#notification-center .notification-info').filter({ hasText: `Opening ${FIXTURE} was cancelled.` }),
  ).toHaveCount(1);
  release();
  // Cellucid starts without the dataset, its controls live.
  await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready');
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-cells')).not.toHaveText('120');
  await expect(page.locator('#notification-center .notification-error')).toHaveCount(0);
});

test('a file opened while a dataset is shown is a notification with Cancel, closed with its outcome', async ({ page }) => {
  await page.goto(`/?${PINNED}data=${encodeURIComponent(FIXTURE)}`, { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  await expect(page.locator('.opening-overlay')).toBeHidden();

  // Every state the notification center shows, as it shows it: the opening
  // of a small local file can be over between two looks.
  await page.evaluate(() => {
    const seen = [];
    window.__openingNotifications = seen;
    new MutationObserver(() => {
      for (const element of document.querySelectorAll('#notification-center .notification')) {
        seen.push({
          type: element.dataset.type,
          text: element.textContent.replace(/\s+/g, ' ').trim(),
          cancel: element.querySelector('[data-role="cancel"]') !== null,
        });
      }
    }).observe(document.getElementById('notification-center'), {
      subtree: true, childList: true, characterData: true, attributes: true,
    });
  });
  await chooseFiles(page.locator('#user-data-file-input'), ARCHIVE_FILE);
  // Shown while the linked dataset stays on screen, then closed with its outcome.
  await expect.poll(() => page.evaluate(() => {
    const seen = window.__openingNotifications;
    const shown = seen.some(entry => entry.type === 'progress' && entry.text.includes('Opening current-ui-smoke.zarr.zip'));
    return shown && document.querySelector('#notification-center .notification-progress') === null;
  })).toBe(true);
  const seen = await page.evaluate(() => window.__openingNotifications);
  const running = seen.filter(entry => entry.type === 'progress' && entry.text.includes('Opening current-ui-smoke.zarr.zip'));
  expect(running.every(entry => entry.cancel)).toBe(true);
  expect(seen.some(entry => entry.type === 'error')).toBe(false);
  await expect(page.locator('#notification-center .notification-success').filter({ hasText: 'User data ready: 120 cells' })).toHaveCount(1);
  // The overlay is for the empty viewer only.
  await expect(page.locator('.opening-overlay')).toBeHidden();
  await expect(page.locator('#dataset-cells')).toHaveText('120');
});

// A reader that never answers (WebKit once deadlocked its thread inside a
// garbage collection: `formats/io/inflate.js`) leaves an opening with
// nothing moving. After the stall interval of a startup step (60 s) the
// opening says which step it waits on, in its notification and in the
// console; Cancel stays, nothing is stopped for the person. Closing the page
// stops the opening instead of waiting for the reader, so teardown ends.
test('an opening whose reader never answers says what it waits on, and the page still closes', async ({ page }) => {
  test.setTimeout(180_000);
  const stalls = [];
  page.on('console', message => {
    if (message.text().startsWith('[cellucid:opening]')) stalls.push(`${message.type()}: ${message.text()}`);
  });
  await page.goto(`/?${PINNED}data=${encodeURIComponent(FIXTURE)}`, { waitUntil: 'domcontentloaded' });
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-cells')).toHaveText('120');

  await page.evaluate(async () => {
    const { setAnnDataReaderWorkerFactory } = await import('/assets/js/data/anndata-reader-client.js');
    window.__silentReaders = [];
    setAnnDataReaderWorkerFactory(() => {
      const reader = {
        onmessage: null,
        onerror: null,
        asked: [],
        terminated: false,
        postMessage(message) {
          // The ports a reader is handed as it starts (the page's range
          // cache, a widget's host) ask nothing of it.
          if (message?.rangeCachePort !== undefined || message?.hostRequesterPort !== undefined) return;
          this.asked.push(message?.method ?? Object.keys(message ?? {}).join(','));
        },
        terminate() {
          this.terminated = true;
        },
        addEventListener() {},
        removeEventListener() {},
      };
      window.__silentReaders.push(reader);
      return reader;
    });
  });
  await chooseFiles(page.locator('#user-data-file-input'), ARCHIVE_FILE);
  await expect.poll(() => page.evaluate(() => window.__silentReaders.flatMap(reader => reader.asked))).toEqual(['open']);

  const opening = page.locator('#notification-center .notification-progress')
    .filter({ hasText: 'Opening current-ui-smoke.zarr.zip' });
  await expect(opening).toContainText('Nothing has changed for 1 min', { timeout: 90_000 });
  await expect(opening).toContainText('while reading the file.');
  expect(stalls).toEqual([
    'warning: [cellucid:opening] Opening current-ui-smoke.zarr.zip stalled while reading the file: ' +
      'nothing has changed for 1 min 0 s.',
  ]);
  // Still under way: the person decides.
  await expect(opening.locator('[data-role="cancel"]')).toHaveCount(1);
  await expect(page.locator('#dataset-name')).toHaveText('Opening current-ui-smoke.zarr.zip…');

  // The application closes without waiting for the reader: the opening is
  // stopped and its reader ended.
  const closed = await page.evaluate(async () => {
    await window._cellucidDispose();
    return window.__silentReaders.map(reader => reader.terminated);
  });
  expect(closed).toEqual([true]);
});
