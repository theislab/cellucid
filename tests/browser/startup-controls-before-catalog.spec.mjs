/**
 * Opening a file of one's own never waits for the sample catalog.
 *
 * Startup asks the sample catalog for its default dataset, and awaits the
 * answer only once the interface is live (`app/main.js`, `defaultSample`):
 * Open…, the link bar and a drop work from the first moment on a network
 * where the catalog is slow or blocked, and a dataset chosen while the
 * catalog answers is the one that opens; the default sample is then not
 * loaded over it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { chooseFiles } from './helpers/file-input.mjs';

const H5AD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'current-ui-smoke.h5ad');

/** Hold the sample catalog's answer until `release()`. */
async function holdCatalog(page) {
  let release = () => {};
  const held = new Promise(resolve => {
    release = resolve;
  });
  let asked = false;
  await page.route('**/tests/browser/fixtures/catalog/datasets.json', async route => {
    asked = true;
    await held;
    await route.fallback();
  });
  return { release, asked: () => asked };
}

test('with the sample catalog held, the data controls are live and a file chosen then is what opens', async ({ page }) => {
  const catalog = await holdCatalog(page);
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect.poll(catalog.asked).toBe(true);

  await test.step('the data controls are live while the sample catalog has not answered', async () => {
    await expect(page.locator('#user-data-open-btn')).toBeEnabled();
    await expect(page.locator('#data-address')).toBeEnabled();
    await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'catalog');
  });

  await test.step('a file chosen while the sample catalog answers is what opens, not the default sample', async () => {
    await chooseFiles(page.locator('#user-data-file-input'), H5AD);
    await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');

    catalog.release();
    await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready');
    await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
    await expect(page.locator('#dataset-cells')).toHaveText('120');
  });
});
