import { expect, test } from './helpers/test.mjs';

import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui`;

test('a module that fails to download says so instead of starting forever', async ({
  page,
}) => {
  // Any module of the graph will do; one deep in it shows that a nested
  // dependency, not only main.js itself, reaches the watch.
  await page.route('**/assets/js/utils/deadline.js', route => route.abort());
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });

  const status = page.locator('#data-source-status');
  await expect(status).toHaveText(
    'Cellucid could not load its code: a request for one of its files failed. ' +
      'Check the network connection, then reload this page.',
  );
  await expect(status).toHaveAttribute('role', 'alert');
  await expect(status).toHaveClass(/\berror\b/);
  await expect(page.locator('html')).toHaveAttribute(
    'data-code-load-failed',
    'true',
  );
});

test('a page whose code loads never reports a code-load failure', async ({
  page,
}) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  await expect(page.locator('html')).not.toHaveAttribute(
    'data-code-load-failed',
    /.*/,
  );
});
