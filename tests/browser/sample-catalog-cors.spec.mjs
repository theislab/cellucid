import { expect, test } from '@playwright/test';

const CORS_SAMPLE_ROOT =
  'http://127.0.0.1:4174/tests/browser/fixtures/exports/';
const CORS_SAMPLE_SELECTION =
  'dataset:local-demo:current-ui-prepared';

function launchUrl(exportsBaseUrl, acceptance) {
  return (
    `/?exportsBaseUrl=${encodeURIComponent(exportsBaseUrl)}` +
    `&acceptance=${acceptance}`
  );
}

test('direct CORS catalog startup adopts its explicit default sample', async ({ page }) => {
  const browserErrors = [];
  const sampleRequests = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('request', request => {
    if (request.url().startsWith(CORS_SAMPLE_ROOT)) {
      sampleRequests.push({
        method: request.method(),
        url: request.url(),
      });
    }
  });

  await page.goto(
    launchUrl(CORS_SAMPLE_ROOT, 'sample-cors-catalog'),
    { waitUntil: 'domcontentloaded' },
  );
  await page.getByRole('button', { name: /Choose a Dataset/ }).click();

  const datasetSelect = page.locator('#dataset-select');
  await expect(
    datasetSelect.locator(`option[value="${CORS_SAMPLE_SELECTION}"]`),
  ).toHaveText(/Current UI prepared fixture/);
  await expect(datasetSelect).toHaveValue(CORS_SAMPLE_SELECTION);
  await expect(datasetSelect).toBeFocused();
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing all 120 points',
  );
  await expect(page.locator('#dimension-select')).toHaveValue('2');
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');
  const categoryBuilderToggle = page.locator(
    '#cat-builder-accordion-item > .analysis-accordion-header',
  );
  await expect(categoryBuilderToggle).toBeEnabled();
  await expect(categoryBuilderToggle).toHaveAttribute(
    'aria-disabled',
    'false',
  );
  await expect(page.locator('#cat-builder-dropzone')).toHaveAttribute(
    'aria-disabled',
    'false',
  );
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(
    await page.evaluate(() => window._cellucidViewer.getPointCount()),
  ).toBe(120);
  expect(sampleRequests.every(request => request.method === 'GET')).toBe(true);
  expect(
    sampleRequests.filter(
      request => request.url === `${CORS_SAMPLE_ROOT}datasets.json`,
    ),
  ).toHaveLength(1);
  for (const requiredUrl of [
    `${CORS_SAMPLE_ROOT}current-ui-prepared/dataset_identity.json`,
    `${CORS_SAMPLE_ROOT}current-ui-prepared/points_2d.bin`,
    `${CORS_SAMPLE_ROOT}current-ui-prepared/obs_manifest.json`,
  ]) {
    expect(sampleRequests.some(request => request.url === requiredUrl)).toBe(true);
  }
  expect(browserErrors).toEqual([]);
});

test('a failed direct CORS catalog is visible, terminal, and selects no science', async ({ page }) => {
  const missingRoot =
    'http://127.0.0.1:4174/tests/browser/fixtures/missing-exports/';
  const catalogRequests = [];
  page.on('request', request => {
    if (request.url() === `${missingRoot}datasets.json`) {
      catalogRequests.push(request.url());
    }
  });

  await page.goto(
    launchUrl(missingRoot, 'sample-cors-failure'),
    { waitUntil: 'domcontentloaded' },
  );
  await page.getByRole('button', { name: /Choose a Dataset/ }).click();

  const datasetSelect = page.locator('#dataset-select');
  await expect(datasetSelect.locator('option')).toHaveText(
    /Failed to load dataset catalog:.*Resource not found/i,
  );
  await expect(page.locator('.notification-error')).toContainText(
    /Failed to load dataset catalog:.*Resource not found/i,
  );
  await expect(page.locator('#dataset-name')).toHaveText('—');
  await expect(page.locator('#stats')).toHaveText('Points: 0 • Field: None');
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(
    await page.evaluate(() => window._cellucidViewer.getPointCount()),
  ).toBe(0);
  expect(catalogRequests).toHaveLength(1);
});
