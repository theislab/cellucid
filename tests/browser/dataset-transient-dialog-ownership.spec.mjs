/**
 * A dataset replaced under an open category editor or confirmation retires
 * it: what it would have done is never applied to the dataset shown after,
 * even one with the same fields at the same indices.
 *
 * - The inline category editor is no dialog: the person replaces the dataset
 *   from the picker beside it.
 * - A confirmation is modal: the rest of the page is inert while it is open,
 *   so the person answers or closes it first. The dataset changes under it
 *   when an agent opens one (`dataset.open`), here the same file again as a
 *   link: the confirmation closes, and its stale button does nothing.
 */
import { expect, test } from './helpers/test.mjs';
import { openDatasetAsAgent } from './helpers/agent-dataset-open.mjs';
import { dispatchAppDrag } from './helpers/app-drag.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { outOfReach } from './helpers/dialog-keys.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=dataset-transient-ownership-ci`;
const DATASET_OPTION = 'dataset:local-demo:current-ui';
// The catalog's own file, opened as a link: a new dataset with the same fields.
const SAME_FILE_LINK = `${SAMPLE_ORIGIN}/tests/browser/fixtures/catalog/current-ui.h5ad`;

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
    'Current UI fixture',
  );
}

/** The person closes the dataset and opens it again from the picker. */
async function replaceFromPicker(page) {
  await page.locator('#dataset-select').selectOption('__none__');
  await expect(page.locator('#dataset-name')).toHaveText('No dataset open');
  await page.locator('#dataset-select').selectOption(DATASET_OPTION);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
}

/**
 * An agent opens the same file as a link while a confirmation is open; the
 * confirmation closes, so the page is the person's again.
 */
async function replaceUnderConfirmation(page) {
  await expect(page.locator('dialog.confirm-dialog')).toHaveCount(1);
  // The premise: the picker is out of the person's reach under the dialog.
  expect(await outOfReach(page.locator('#dataset-select'))).toBe(true);
  const priorGeneration = await page.evaluate(
    () => window._cellucidState.getDatasetGeneration(),
  );
  // An address the agent was not given in this tab is asked of the person first (F121); the question
  // is answered over the open dialog, never left waiting under it (R9H-16).
  const opening = openDatasetAsAgent(page, { name: SAME_FILE_LINK });
  const card = page.locator('#agent-presence .agent-confirm');
  await expect(card).toHaveAttribute('data-asking', 'unseen-link');
  expect(await outOfReach(card)).toBe(false);
  await card.locator('.agent-confirm-allow').click();
  const opened = await opening;
  expect(opened.outcome).toMatchObject({
    name: 'Current UI fixture',
    kind: 'link',
    already_open: false,
  });
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  expect(await page.evaluate(
    () => window._cellucidState.getDatasetGeneration(),
  )).toBeGreaterThan(priorGeneration);
  await expect(page.locator('dialog.confirm-dialog')).toHaveCount(0);
  expect(await outOfReach(page.locator('#dataset-select'))).toBe(false);
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

  await replaceFromPicker(page);
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

  await replaceUnderConfirmation(page);
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

  await replaceUnderConfirmation(page);
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
    .locator('#deleted-fields-accordion-item .disclosure-header')
    .click();
  await page
    .locator('button[data-action="purge-field"][data-source="obs"]')
    .click();
  await expect(page.locator('.confirm-dialog-title')).toHaveText(
    'Delete "score" for good?',
  );
  const staleConfirm = await page
    .locator('.confirm-dialog-confirm')
    .elementHandle();
  expect(staleConfirm).not.toBeNull();

  await replaceUnderConfirmation(page);
  await page.locator('#continuous-field').selectOption({ label: 'score' });
  await page.locator('#delete-continuous-field').click();
  await page.locator('.confirm-dialog-confirm').click();
  // The deletion has landed (its purge button is listed) before the state is read:
  // reading it straight after the click raced the deletion on WebKit.
  await expect(
    page.locator('button[data-action="purge-field"][data-source="obs"]'),
  ).toHaveCount(1);
  const before = await readObsFieldContract(page);
  await staleConfirm.evaluate(button => button.click());

  expect(await readObsFieldContract(page)).toEqual(before);
  expect(productErrors).toEqual([]);
});
