import { copyFile, rm, stat, truncate } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'current-ui-smoke.h5ad',
);

// Past the former 512 MiB direct-file ceiling. The tail is a sparse hole
// after HDF5's end of allocation (legal: HDF5 reads only what it addresses),
// so the file costs no disk and the test proves the reader never touches
// bytes it does not need.
const OVERSIZED_BYTES = 600 * 1024 * 1024;

test('an H5AD file far above the former 512 MiB ceiling opens from the file picker', async ({ page }, testInfo) => {
  const oversizedPath = testInfo.outputPath('oversized.h5ad');
  await copyFile(fixturePath, oversizedPath);
  await truncate(oversizedPath, OVERSIZED_BYTES);
  expect((await stat(oversizedPath)).size).toBe(OVERSIZED_BYTES);

  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });

  try {
    await page.goto(
      `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=browser-ci`,
      { waitUntil: 'domcontentloaded' },
    );
    await dismissWelcome(page);
    await openCollapsedPanels(page);
    await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');

    await page.locator('#user-data-h5ad-input').setInputFiles(oversizedPath);

    await expect(page.locator('#dataset-name')).toHaveText('oversized');
    await expect(page.locator('#dataset-cells')).toHaveText('120');
    await expect(page.locator('#dataset-genes')).toHaveText('6');
    await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
    await expect(page.locator('body')).not.toContainText(/512 MiB|use the Cellucid server or prepared format/);
    expect(browserErrors).toEqual([]);
  } finally {
    await rm(oversizedPath, { force: true });
  }
});
