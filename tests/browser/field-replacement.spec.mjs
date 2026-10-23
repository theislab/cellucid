import { expect, test } from './helpers/test.mjs';
import { serveSyntheticCatalog } from './helpers/anndata-zarr-zip.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const FIELDS_ROOT = appUrl('/tests/browser/fixtures/generated-field-cardinality/');
const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=field-replacement-ci`;

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

const CELLS = 120;

function categorical(key, categoryCount) {
  return {
    categories: Array.from({ length: categoryCount }, (_value, index) => `${key}-${index + 1}`),
    codes: Int8Array.from({ length: CELLS }, (_value, index) => index % categoryCount),
  };
}

/** A dataset with two categorical fields of different cardinality and a continuous one. */
async function installDifferentCardinalityFields(page) {
  await serveSyntheticCatalog(page, FIELDS_ROOT, {
    id: 'field-cardinality',
    name: 'Field cardinality fixture',
    cells: CELLS,
    obs: {
      large_category: categorical('large_category', 5),
      small_category: categorical('small_category', 4),
      score: Float32Array.from({ length: CELLS }, (_value, index) => (index % 100) / 100),
    },
    obsm: {
      X_umap_2d: {
        data: Float32Array.from({ length: CELLS * 2 }, (_value, index) => Math.sin(index * 0.37) * 4),
        columns: 2,
      },
    },
  });
}

test('categorical coloring replacement commits one exact legend generation', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await installDifferentCardinalityFields(page);
  await page.goto(
    `/?sampleCatalog=${encodeURIComponent(FIELDS_ROOT)}&acceptance=field-replacement-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);

  await expect(page.locator('#dataset-name')).toHaveText('Field cardinality fixture');

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
    'Current UI fixture',
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
    'dataset:local-demo:current-ui',
  );
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
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
