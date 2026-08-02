import { expect, test } from './helpers/test.mjs';
import { readFile } from 'node:fs/promises';

import { EXPORTS_BASE_URL as FIXTURE_ROOT } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

test('consensus snapshot downloads once and reports the exact success', async ({
  page,
}) => {
  const productErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      productErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    productErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      productErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  await page.addInitScript(() => {
    window._simulate_repo_connected = true;
    window._author_mode = true;
  });

  await page.goto(
    `/?exportsBaseUrl=${encodeURIComponent(FIXTURE_ROOT)}` +
      '&dataset=current-ui-prepared' +
      '&annotations=theislab%2Fcellucid-annotation%40main' +
      '&acceptance=community-consensus-export',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
  await page.getByText('Community Annotation', { exact: true }).click();
  await page.getByRole('button', {
    name: 'CONSENSUS SNAPSHOT + LOCAL CACHE',
  }).click();

  const successNotice = page.getByText(
    'Downloaded cellucid-consensus.json',
    { exact: true },
  );
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    // The product intentionally retires this success toast after 2.2 s. Own
    // its visible interval while the browser download is initiated instead of
    // looking for it after runner-dependent disk I/O has completed.
    expect(successNotice).toBeVisible(),
    page.getByRole('button', { name: 'Download', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('cellucid-consensus.json');
  const path = await download.path();
  expect(path).not.toBeNull();
  const document = JSON.parse(await readFile(path, 'utf8'));
  expect(Object.keys(document).sort()).toEqual([
    'builtAt',
    'consensus',
    'suggestions',
    'version',
  ]);
  expect(document.version).toBe(1);
  expect(Number.isNaN(Date.parse(document.builtAt))).toBe(false);
  expect(document.suggestions).toEqual({});
  expect(document.consensus).toEqual({});

  await expect(page.locator('.notification-error')).toHaveCount(0);
  expect(productErrors).toEqual([]);
});
