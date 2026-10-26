/**
 * A privacy blocker refusing the analytics modules must not stop Cellucid.
 *
 * EasyPrivacy refuses `/analytics/tracker.js`; while it was a static import,
 * the refusal aborted the whole module graph and the page showed "Cellucid
 * could not load its code". The request is refused here the way a blocker
 * refuses it, and the app must start, load the dataset and stay usable.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=blocked-analytics';

test('the app starts and works when a blocker refuses the analytics modules', async ({
  page,
}) => {
  const refused = [];
  await page.route('**/assets/js/analytics/**', route => {
    refused.push(new URL(route.request().url()).pathname);
    return route.abort('blockedbyclient');
  });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  expect(refused.length).toBeGreaterThan(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-code-load-failed', 'true');
  await expect(page.locator('#categorical-field')).toBeEnabled();
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('#categorical-field')).toHaveValue(/./);
  expect(pageErrors).toEqual([]);
});
