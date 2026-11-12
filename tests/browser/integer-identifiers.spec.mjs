/**
 * An obs column of 64-bit integers past 2^53 (F116, owner decision
 * 2026-11-11) is read as the exact text of each value: listed with the
 * numbers until its first load finds such a value, it then moves to the
 * categorical fields, is colored by its categories, and its legend says why
 * in one line, the reason in full on the line's tooltip
 * (`fixtures/integer-identifiers.h5ad`: `donor_id`, unsigned 64-bit, four of
 * its five values past 2^53). A 64-bit column within 2^53 (`n_counts`) stays
 * a continuous field. A categorical's empty and blank categories (`tissue`)
 * are shown as `(empty)` and `(blank)`, quietly, in the legend and in the
 * active filters (R9D-8).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { chooseFiles } from './helpers/file-input.mjs';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'integer-identifiers.h5ad');
const IDS = ['1152921504606846987', '1152921504606846998', '4611686018427387937', '7', '9223372036854775852'];

test('a column of identifiers past 2^53 opens as a text column with its exact values, saying why', async ({ page }) => {
  test.setTimeout(120_000);
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });

  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=browser-ci`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await chooseFiles(page.locator('#user-data-file-input'), fixturePath);
  await expect(page.locator('#dataset-name')).toHaveText('Integer identifiers');

  const optionsOf = id => page.locator(`#${id} option`).allTextContents();
  // Nothing is read to list a field: the integer column is listed with the numbers.
  await expect.poll(() => optionsOf('continuous-field')).toContain('donor_id');
  expect(await optionsOf('categorical-field')).not.toContain('donor_id');

  await page.locator('#continuous-field').selectOption({ label: 'donor_id' });
  // Its first load finds identifiers: it is a categorical field now, and the one shown.
  await expect.poll(() => optionsOf('categorical-field')).toContain('donor_id');
  expect(await optionsOf('continuous-field')).not.toContain('donor_id');
  await expect(page.locator('#categorical-field option:checked')).toHaveText('donor_id');
  await expect(page.locator('#legend .legend-label-main')).toHaveText([...IDS].sort());
  const note = page.locator('#legend .legend-cells-note');
  await expect(note).toHaveText('IDs past 2^53, read as text.');
  await expect(note).toHaveAttribute('title', /whole numbers past 2\^53, which are identifiers/);

  const state = await page.evaluate(() => {
    const { state } = window._comparisonModule;
    const field = state.obsData.fields.find(item => item.key === 'donor_id');
    return { kind: field.kind, categories: [...field.categories], colored: state.getFieldForView?.(state.activeViewId)?.key ?? null };
  });
  expect(state.kind).toBe('category');
  expect(state.categories).toEqual([...IDS].sort());
  expect(state.colored).toBe('donor_id');

  // A 64-bit column within 2^53 stays numbers.
  await page.locator('#continuous-field').selectOption({ label: 'n_counts' });
  await expect(page.locator('#continuous-field option:checked')).toHaveText('n_counts');
  expect(await optionsOf('categorical-field')).not.toContain('n_counts');

  expect(browserErrors).toEqual([]);
});

test('categories with no name are shown as (empty) and (blank), quietly, and named so in the filters', async ({ page }) => {
  test.setTimeout(120_000);
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=browser-ci`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await chooseFiles(page.locator('#user-data-file-input'), fixturePath);
  await expect(page.locator('#dataset-name')).toHaveText('Integer identifiers');

  await page.locator('#categorical-field').selectOption({ label: 'tissue' });
  const labels = page.locator('#legend .legend-label-main');
  await expect(labels).toHaveText(['(empty)', '(blank)', 'lung']);
  await expect(labels.nth(0)).toHaveClass(/is-unnamed/);
  await expect(labels.nth(1)).toHaveClass(/is-unnamed/);
  await expect(labels.nth(2)).not.toHaveClass(/is-unnamed/);
  await page.locator('#legend .legend-item').nth(0).locator('.legend-checkbox').uncheck();
  await expect(page.locator('#active-filters')).toContainText('(empty)');
  // The value itself is unchanged.
  expect(await page.evaluate(() => window._comparisonModule.state.obsData.fields.find(field => field.key === 'tissue').categories)).toEqual(['', ' ', 'lung']);
  expect(browserErrors).toEqual([]);
});
