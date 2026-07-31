/**
 * The field action buttons are icon-only and were named by their `title`
 * attribute alone, which also meant two buttons in the same panel answered to
 * the same name (CEL-AUDIT-0086). This measures the computed name in the
 * running browser, which is the only place the ambiguity was visible.
 */

import { expect, test } from '@playwright/test';
import { dismissWelcome } from './helpers/welcome.mjs';

const PREPARED_DATASET_URL =
  '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F' +
  '&dataset=current-ui-prepared&acceptance=icon-button-names-ci';

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

test('every field action button answers to exactly one name', async ({ page }) => {
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 points');

  for (const [id, name] of Object.entries(FIELD_ACTION_NAMES)) {
    await expect(page.locator(`#${id}`)).toHaveAccessibleName(name);
    // A name that resolves to two controls is not a name a screen-reader or
    // voice-control user can act on.
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
  }

  // The group label existed already but sat on a bare <div>, where naming is
  // prohibited, so it named nothing.
  for (const name of FIELD_ACTION_GROUPS) {
    await expect(page.getByRole('group', { name, exact: true })).toHaveCount(1);
  }
});

test('the sidebar toggle keeps the name and state its module publishes', async ({
  page
}) => {
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);

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
