/**
 * Opening another dataset rewrites the whole Session panel from that dataset:
 * after a sample, a file from this computer leaves nothing of the sample in
 * the Dataset box, the sample list, the Data mapping group or the panel's
 * prose.
 */
import { expect, test } from './helpers/test.mjs';
import {
  H5AD,
  H5AD_PATH,
  START,
  UNLISTED_OPTION,
  expectSettledOn,
  openStarted,
} from './helpers/dataset-loading.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

test('a file opened after a sample leaves nothing of the sample in the Session panel', async ({ page }) => {
  const productErrors = await openStarted(page);
  await openCollapsedPanels(page);
  const card = page.locator('#dataset-info');
  await expect(card).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#dataset-origin')).toContainText(' · ');
  await expect(page.locator('#dataset-select')).toHaveValue(START.select);
  await expect(page.locator('label[for="dataset-select"]')).toHaveText('Sample dataset');

  // The sample's details, opened, to see that they are replaced.
  await page.locator('#dataset-details .disclosure-header').click();
  await expect(page.locator('#dataset-details-list')).toContainText('Cells');

  await page.locator('#user-data-file-input').setInputFiles(H5AD_PATH);
  await expectSettledOn(page, H5AD);

  // The Dataset box describes the file, and only the file.
  await expect(page.locator('#dataset-name')).toHaveText(H5AD.name);
  await expect(page.locator('#dataset-origin')).toHaveText('h5ad file · this computer');
  await expect(page.locator('#dataset-read')).toBeHidden();
  await expect(card).not.toContainText(START.name);
  await expect(page.locator('#dataset-details-list')).not.toContainText(START.name);
  // Each dataset starts with its Details closed.
  await expect(page.locator('#dataset-details .disclosure-header')).toHaveAttribute('aria-expanded', 'false');

  // The sample list offers samples; the open file is not one of them.
  await expect(page.locator('#dataset-select')).toHaveValue(UNLISTED_OPTION);
  await expect(page.locator('#dataset-select option:checked')).toHaveText('—');
  await expect(page.locator('#dataset-select option[value^="dataset:local-user:"]')).toHaveCount(0);

  // Data mapping is collapsed for the new dataset, and nothing else in the
  // panel still names the sample.
  await expect(page.locator('#data-mapping-disclosure > .disclosure-header-row > .disclosure-header')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#dataset-facts')).not.toContainText(START.name);
  await expect(page.locator('#data-mapping-controls')).not.toContainText(START.embedding);
  await expect(page.locator('#transfers-block')).toHaveCount(0);
  expect(productErrors).toEqual([]);
});
