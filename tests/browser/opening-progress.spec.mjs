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
  // The opening's panel is gone, and with no dataset shown the empty viewer
  // says so in its place a quarter of a second later (`drawEmpty`,
  // `EMPTY_AFTER_MS`). The moment between the two, the overlay hidden, is not
  // waited for: a slow runner looks after it has passed (Windows Chromium).
  await expect(overlay.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await expect(page.locator('.opening-overlay[data-state="empty"] .opening-title')).toHaveText('No dataset open');
  await expect(overlay.getByRole('button', { name: 'Show Open data' })).toBeVisible();
  await expect(
    page.locator('#notification-center .notification-info').filter({ hasText: `Opening ${FIXTURE} was canceled.` }),
  ).toHaveCount(1);
  release();
  // Cellucid starts without the dataset, its controls live.
  await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready');
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-cells')).not.toHaveText('120');
  await expect(page.locator('#notification-center .notification-error')).toHaveCount(0);
});

test('a file opened while a dataset is shown is a notification with Cancel, closed with its outcome; a refused file\'s card goes when the next opening begins', async ({ page }) => {
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
  await expect(page.locator('#notification-center .notification-success').filter({ hasText: /Opened .+: 120 cells/ })).toHaveCount(1);
  // The overlay is for the empty viewer only.
  await expect(page.locator('.opening-overlay')).toBeHidden();
  await expect(page.locator('#dataset-cells')).toHaveText('120');

  await test.step('a refused file\'s card goes when the next opening begins, so it never reads as the dataset shown failing', async () => {
    // The card of the opening above is closed, so the one counted below is the next opening's.
    await page.evaluate(async () => {
      const { getNotificationCenter } = await import('/assets/js/app/notification-center.js');
      getNotificationCenter().dismissAll();
    });
    await expect(page.locator('#notification-center .notification')).toHaveCount(0);
    const errors = page.locator('#notification-center .notification-error');
    await chooseFiles(page.locator('#user-data-file-input'), {
      name: 'damaged.loom', mimeType: 'application/octet-stream', buffer: Buffer.from('not an HDF5 file at all'),
    });
    await expect(errors.filter({ hasText: 'not a valid HDF5 file' })).toHaveCount(1);
    // A file of a kind Cellucid does not open is refused before any opening
    // begins; its card goes the same way.
    await chooseFiles(page.locator('#user-data-file-input'), {
      name: 'table.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n'),
    });
    await expect(errors.filter({ hasText: 'is not a file Cellucid can open' })).toHaveCount(1);
    await chooseFiles(page.locator('#user-data-file-input'), ARCHIVE_FILE);
    await expect(page.locator('#notification-center .notification-success').filter({ hasText: /Opened .+: 120 cells/ })).toHaveCount(1);
    await expect(errors).toHaveCount(0);
  });
});
