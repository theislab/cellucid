/**
 * A figure exported from a subsample says it is one: its provenance (the SVG's
 * `cellucid:json` and `dc:description`) names the open cells, the dataset's,
 * how they were chosen and the cell-set digest the Session panel shows. A
 * figure of every cell makes no such claim.
 *
 * Fixture: `data-mapping-full.h5ad` (300 cells), opened at 40 %, uniform, seed 7.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { chooseFiles } from './helpers/file-input.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FILE = path.join(FIXTURES, 'data-mapping-full.h5ad');
const START_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=subsample-figure-provenance';

function decodeXmlText(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

async function exportSvg(page, testInfo, label) {
  await page.getByLabel('Download format').selectOption('svg');
  await page.getByLabel('SVG point strategy').selectOption('full-vector');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#figure-export-btn').click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  const outputPath = testInfo.outputPath(`${label}.svg`);
  await download.saveAs(outputPath);
  const svg = await readFile(outputPath, 'utf8');
  const json = JSON.parse(decodeXmlText(svg.match(/<cellucid:json>([\s\S]+?)<\/cellucid:json>/)[1]));
  const description = decodeXmlText(svg.match(/<dc:description>([\s\S]*?)<\/dc:description>/)[1]);
  return { json, description };
}

test('a figure of a subsample names its cells; a figure of every cell does not', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await openCollapsedPanels(page);
  await chooseFiles(page.locator('#user-data-file-input'), FILE);
  await expect.poll(() => page.evaluate(() => window._cellucidState.pointCount)).toBe(300);

  await page.locator('#figure-export-section > summary').click();
  await expect(page.locator('#figure-export-section')).toHaveAttribute('open', '');
  await page.getByRole('button', { name: /^Download\b/ }).click();

  const whole = await exportSvg(page, testInfo, 'every-cell');
  expect(whole.json.dataset.cells).toBeNull();
  expect(whole.description).not.toContain('Cells:');

  await page.locator('#subsample-percent').fill('40');
  await page.locator('#subsample-method').selectOption('uniform');
  await page.locator('#subsample-seed').fill('7');
  await page.locator('#subsample-apply').click();
  await expect.poll(() => page.evaluate(() => window._cellucidState.pointCount), { timeout: 30_000 }).toBe(120);
  const digest = await page.evaluate(() => window._cellucidState.cellIdentity.digest);

  const share = await exportSvg(page, testInfo, 'subsample');
  expect(share.json.dataset.cells).toEqual({ open: 120, of: 300, method: 'uniform, seed 7', digest });
  expect(share.description).toContain(`Cells: a subsample, 120 of 300 (uniform, seed 7; cell set ${digest})`);
  expect(errors).toEqual([]);
});
