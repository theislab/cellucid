import { expect, test } from './helpers/test.mjs';
import { dispatchAppDrag } from './helpers/app-drag.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=dataset-transient-ownership-ci`;
const DATASET_OPTION = 'dataset:local-demo:current-ui-prepared';

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

async function openPreparedDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
}

async function replaceWithFreshPreparedDataset(page) {
  await page.locator('#dataset-select').selectOption('__none__');
  await expect(page.locator('#dataset-name')).toHaveText('—');
  await page.locator('#dataset-select').selectOption(DATASET_OPTION);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
}

async function selectCellType(page) {
  await page.locator('#categorical-field').selectOption({
    label: 'cell_type',
  });
  await expect(page.locator('.legend-item')).toHaveCount(3);
}

async function readObsFieldContract(page) {
  return page.evaluate(() => ({
    generation: window._cellucidState.getDatasetGeneration(),
    fields: window._cellucidState.getFields().map(field => ({
      categories: Array.isArray(field.categories)
        ? [...field.categories]
        : null,
      deleted: field._isDeleted === true,
      key: field.key,
      purged: field._isPurged === true,
    })),
  }));
}

test('dataset replacement retires a category editor before same-index reuse', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await openPreparedDataset(page);
  await selectCellType(page);

  await page.locator('.legend-rename-btn').first().click();
  const editor = page.locator('.inline-rename-input');
  await expect(editor).toHaveCount(1);
  const staleEditor = await editor.elementHandle();
  expect(staleEditor).not.toBeNull();
  const priorGeneration = await page.evaluate(
    () => window._cellucidState.getDatasetGeneration(),
  );

  await replaceWithFreshPreparedDataset(page);
  await selectCellType(page);
  const before = await readObsFieldContract(page);
  expect(before.generation).toBeGreaterThan(priorGeneration);
  await staleEditor.evaluate(input => {
    input.value = 'stale_dataset_category';
    input.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      key: 'Enter',
    }));
  });

  const after = await readObsFieldContract(page);
  expect(after.fields).toEqual(before.fields);
  expect(productErrors).toEqual([]);
});

test('dataset replacement retires category deletion confirmation ownership', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await openPreparedDataset(page);
  await selectCellType(page);

  await page.locator('.legend-delete-btn').first().click();
  await expect(page.locator('.confirm-dialog-title')).toHaveText(
    'Delete category label',
  );
  const staleConfirm = await page
    .locator('.confirm-dialog-confirm')
    .elementHandle();
  expect(staleConfirm).not.toBeNull();

  await replaceWithFreshPreparedDataset(page);
  await selectCellType(page);
  const before = await readObsFieldContract(page);
  await staleConfirm.evaluate(button => button.click());

  expect(await readObsFieldContract(page)).toEqual(before);
  expect(productErrors).toEqual([]);
});

test('dataset replacement retires category merge confirmation ownership', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await openPreparedDataset(page);
  await selectCellType(page);

  const labels = page.locator('.legend-label');
  expect(
    await dispatchAppDrag(
      labels.nth(0),
      page.locator('.legend-item').nth(1),
      {
        expectedDataType: 'application/x-cellucid-category',
      },
    ),
  ).toEqual({
    dataTypes: ['application/x-cellucid-category'],
    dragOverAccepted: true,
    dropAccepted: true,
  });
  await expect(page.locator('.confirm-dialog-title')).toHaveText(
    'Merge categories',
  );
  const staleConfirm = await page
    .locator('.confirm-dialog-confirm')
    .elementHandle();
  expect(staleConfirm).not.toBeNull();

  await replaceWithFreshPreparedDataset(page);
  await selectCellType(page);
  const before = await readObsFieldContract(page);
  await staleConfirm.evaluate(button => button.click());

  expect(await readObsFieldContract(page)).toEqual(before);
  expect(productErrors).toEqual([]);
});

test('dataset replacement retires deleted-field purge confirmation ownership', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await openPreparedDataset(page);

  await page.locator('#continuous-field').selectOption({ label: 'score' });
  await page.locator('#delete-continuous-field').click();
  await page.locator('.confirm-dialog-confirm').click();
  await expect(
    page.locator('button[data-action="purge-field"][data-source="obs"]'),
  ).toHaveCount(1);

  await page
    .locator('#deleted-fields-accordion-item .analysis-accordion-header')
    .click();
  await page
    .locator('button[data-action="purge-field"][data-source="obs"]')
    .click();
  await expect(page.locator('.confirm-dialog-title')).toHaveText(
    'Confirm deletion',
  );
  const staleConfirm = await page
    .locator('.confirm-dialog-confirm')
    .elementHandle();
  expect(staleConfirm).not.toBeNull();

  await replaceWithFreshPreparedDataset(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('.confirm-dialog-overlay')).toHaveCount(0);
  await page.locator('#continuous-field').selectOption({ label: 'score' });
  await page.locator('#delete-continuous-field').click();
  await page.locator('.confirm-dialog-confirm').click();
  const before = await readObsFieldContract(page);
  await staleConfirm.evaluate(button => button.click());

  expect(await readObsFieldContract(page)).toEqual(before);
  expect(productErrors).toEqual([]);
});
