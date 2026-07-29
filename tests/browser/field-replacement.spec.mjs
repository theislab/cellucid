import { expect, test } from '@playwright/test';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=field-replacement-ci';

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      errors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return errors;
}

function makeCodes(categoryCount, pointCount = 120) {
  return Buffer.from(
    Uint8Array.from(
      { length: pointCount },
      (_value, index) => index % categoryCount,
    ),
  );
}

function makeOutliers(pointCount = 120) {
  const bytes = Buffer.alloc(pointCount * Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < pointCount; index++) {
    bytes.writeFloatLE((index % 100) / 100, index * Float32Array.BYTES_PER_ELEMENT);
  }
  return bytes;
}

function categoricalEntry(key, categoryCount) {
  const categories = Array.from(
    { length: categoryCount },
    (_value, index) => `${key}-${index + 1}`,
  );
  const centroids = categories.map((category, index) => ({
    category,
    position: [index / categoryCount, -index / categoryCount],
    n_points: 120 / categoryCount,
  }));
  return [
    key,
    categories,
    'uint8',
    255,
    { '2': centroids },
  ];
}

async function installDifferentCardinalityFields(page) {
  await page.route('**/current-ui-prepared/dataset_identity.json', async route => {
    const response = await route.fetch();
    const identity = await response.json();
    identity.stats.n_obs_fields = 4;
    identity.stats.n_categorical_fields = 3;
    identity.obs_fields.push(
      { key: 'large_category', kind: 'category', n_categories: 5 },
      { key: 'small_category', kind: 'category', n_categories: 4 },
    );
    await route.fulfill({ response, json: identity });
  });

  await page.route('**/current-ui-prepared/obs_manifest.json', async route => {
    const response = await route.fetch();
    const manifest = await response.json();
    manifest._categoricalFields.push(
      categoricalEntry('large_category', 5),
      categoricalEntry('small_category', 4),
    );
    await route.fulfill({ response, json: manifest });
  });

  for (const [key, count] of [
    ['large_category', 5],
    ['small_category', 4],
  ]) {
    await page.route(
      `**/current-ui-prepared/obs/${key}.codes.u8`,
      route => route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: makeCodes(count),
      }),
    );
    await page.route(
      `**/current-ui-prepared/obs/${key}.outliers.f32`,
      route => route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: makeOutliers(),
      }),
    );
  }
}

test('categorical coloring replacement commits one exact legend generation', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await installDifferentCardinalityFields(page);
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);

  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');

  await page.locator('#categorical-field').selectOption({ label: 'large_category' });
  await expect(page.locator('.legend-item')).toHaveCount(5);

  await page.locator('#categorical-field').selectOption({ label: 'small_category' });
  await expect(page.locator('.legend-item')).toHaveCount(4);
  await expect(page.locator('.legend-label-main')).toHaveText([
    'small_category-1',
    'small_category-2',
    'small_category-3',
    'small_category-4',
  ]);

  await page.locator('#categorical-field').selectOption({ label: 'large_category' });
  await expect(page.locator('.legend-item')).toHaveCount(5);

  await page.locator('#continuous-field').selectOption({ label: 'score' });
  await expect(page.locator('.legend-item')).toHaveCount(0);
  await expect(page.locator('.legend-filter')).toHaveCount(1);

  expect(productErrors).toEqual([]);
});

test('dataset replacement cancels stale field editors before same-index reuse', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );

  await page.locator('#categorical-field').selectOption({
    label: 'cell_type',
  });
  await expect(page.locator('#rename-categorical-field')).toBeEnabled();
  await page.locator('#rename-categorical-field').click();
  const editor = page.locator('.inline-rename-input');
  await expect(editor).toHaveCount(1);
  const staleEditor = await editor.elementHandle();
  expect(staleEditor).not.toBeNull();

  await page.locator('#dataset-select').selectOption('__none__');
  await expect(page.locator('#dataset-name')).toHaveText('—');
  await expect(page.locator('.inline-rename-input')).toHaveCount(0);

  await page.locator('#dataset-select').selectOption(
    'dataset:local-demo:current-ui-prepared',
  );
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
  await staleEditor.evaluate(input => {
    input.value = 'stale_replacement_name';
    input.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      key: 'Enter',
    }));
  });

  await expect(
    page.locator('#categorical-field option', { hasText: 'cell_type' }),
  ).toHaveCount(1);
  await expect(
    page.locator('#categorical-field option', {
      hasText: 'stale_replacement_name',
    }),
  ).toHaveCount(0);
  expect(productErrors).toEqual([]);
});
