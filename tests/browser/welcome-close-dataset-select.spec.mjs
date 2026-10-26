/**
 * Closing onboarding never activates the Sample dataset dropdown.
 *
 * A plain start still opens the catalog's default sample behind the welcome
 * dialog. Whichever way the dialog is closed, the dropdown is left alone: it
 * is not focused, so it neither looks chosen nor opens on the next key press.
 * "Choose a dataset" opens the Session panel and focuses its heading instead.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';

const PLAIN_START_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}` +
  '&acceptance=welcome-close-dataset-select';
const CATALOG_DEFAULT = 'dataset:local-demo:current-ui';
const DOCS_ORIGIN = 'https://docs.cellucid.com';

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  return errors;
}

async function openPlainStart(page) {
  await page.goto(PLAIN_START_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#welcome-modal')).toBeVisible();
}

/** The catalog default is open and the dropdown shows it, untouched. */
async function expectDefaultLoadedAndSelectInactive(page) {
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  const datasetSelect = page.locator('#dataset-select');
  await expect(datasetSelect).toBeEnabled();
  await expect(datasetSelect).toHaveValue(CATALOG_DEFAULT);
  await expect(datasetSelect).not.toBeFocused();
  expect(
    await datasetSelect.evaluate(
      select => select.matches(':focus, :focus-visible, :active'),
    ),
  ).toBe(false);
  expect(
    await page.evaluate(() => document.activeElement?.id ?? null),
  ).not.toBe('dataset-select');
}

test('Choose a dataset opens the Session panel without activating the dropdown', async ({
  page,
}) => {
  const errors = observeProductErrors(page);
  await openPlainStart(page);
  // Collapsed, so opening it is observable.
  await page.locator('#session-section').evaluate(section => {
    section.open = false;
  });

  // Chosen before the default sample has finished loading: nothing queued
  // for later may move focus into the dropdown when the catalog arrives.
  await page.locator('#welcome-demo-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expect(page.locator('#session-section')).toHaveAttribute('open', '');
  // A pointer user's focus is not moved: nothing on the page is ringed.
  await expect(page.locator('#session-section > summary')).not.toBeFocused();

  await expectDefaultLoadedAndSelectInactive(page);
  await expect(page.locator('#session-section > summary')).not.toBeFocused();
  expect(errors).toEqual([]);
});

test('Choose a dataset from the keyboard leaves the dropdown inactive', async ({
  page,
}) => {
  const errors = observeProductErrors(page);
  await openPlainStart(page);
  await page.keyboard.press('Tab');
  await expect(page.locator('#welcome-demo-btn')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expect(page.locator('#session-section > summary')).toBeFocused();

  await expectDefaultLoadedAndSelectInactive(page);
  // The next key press does not land in the dropdown either.
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#dataset-select')).toHaveValue(CATALOG_DEFAULT);
  expect(errors).toEqual([]);
});

test('Escape closes onboarding without activating the dropdown', async ({
  page,
}) => {
  const errors = observeProductErrors(page);
  await openPlainStart(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expectDefaultLoadedAndSelectInactive(page);
  expect(errors).toEqual([]);
});

test('the backdrop closes onboarding without activating the dropdown', async ({
  page,
}) => {
  const errors = observeProductErrors(page);
  await openPlainStart(page);
  await page.locator('#welcome-modal .welcome-backdrop').click({
    position: { x: 8, y: 8 },
  });
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expectDefaultLoadedAndSelectInactive(page);
  expect(errors).toEqual([]);
});

test('Learn more leaves the dropdown inactive before and after closing', async ({
  page,
  context,
}) => {
  const errors = observeProductErrors(page);
  await context.route(`${DOCS_ORIGIN}/**`, route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>Docs</title>',
  }));
  await openPlainStart(page);

  const popupPromise = page.waitForEvent('popup');
  await page.locator('#welcome-modal').getByRole('link', {
    name: /Learn more/,
  }).click();
  const popup = await popupPromise;
  await popup.close();
  await page.bringToFront();

  // The link opens the documentation beside the app; the dialog stays.
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await expect(page.locator('#dataset-select')).not.toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expectDefaultLoadedAndSelectInactive(page);
  expect(errors).toEqual([]);
});
