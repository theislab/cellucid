/**
 * The field action buttons are icon-only: named by their `title` attribute
 * alone, two buttons in the same panel would answer to the same name. This
 * measures the computed name in the running browser, which is the only place
 * the ambiguity is visible.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const PREPARED_DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}` +
  '&dataset=current-ui&acceptance=icon-button-names-ci';

const FIELD_ACTION_NAMES = Object.freeze({
  'copy-categorical-field': 'Duplicate the selected categorical obs field',
  'rename-categorical-field': 'Rename the selected categorical obs field',
  'delete-categorical-field': 'Delete the selected categorical obs field',
  'clear-categorical-field': 'Clear the categorical obs selection',
  'copy-continuous-field': 'Duplicate the selected continuous obs field',
  'rename-continuous-field': 'Rename the selected continuous obs field',
  'delete-continuous-field': 'Delete the selected continuous obs field',
  'clear-continuous-field': 'Clear the continuous obs selection',
  'copy-gene-expression': 'Duplicate the selected gene expression field',
  'rename-gene-expression': 'Rename the selected gene expression field',
  'delete-gene-expression': 'Delete the selected gene expression field',
  'clear-gene-expression': 'Clear the gene expression selection'
});

const FIELD_ACTION_GROUPS = Object.freeze([
  'Categorical field actions',
  'Continuous field actions',
  'Gene expression actions'
]);

test('every field action button answers to exactly one name, and the sidebar toggle keeps its name and state', async ({ page }) => {
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');

  for (const [id, name] of Object.entries(FIELD_ACTION_NAMES)) {
    await expect(page.locator(`#${id}`)).toHaveAccessibleName(name);
    // A name that resolves to two controls is not a name a screen-reader or
    // voice-control user can act on.
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
  }

  // The group label is on an element that may be named: naming is prohibited on
  // a bare <div>, where it would name nothing.
  for (const name of FIELD_ACTION_GROUPS) {
    await expect(page.getByRole('group', { name, exact: true })).toHaveCount(1);
  }
  await test.step('the sidebar toggle keeps the name and state its module publishes', async () => {
    const toggle = page.locator('#sidebar-toggle');
    await expect(toggle).toHaveAccessibleName('Hide sidebar');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await toggle.click();
    await expect(toggle).toHaveAccessibleName('Show sidebar');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    await expect(toggle).toHaveAccessibleName('Hide sidebar');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});
