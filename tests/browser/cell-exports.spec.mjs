/**
 * The export buttons on a file opened in the browser (`.h5ad` and Zarr ZIP):
 * the highlighted cells as an obs-name CSV and as an `.h5ad` subset, and the
 * categorical field chosen in its select as a CSV, whose button is live as
 * soon as the field is chosen. The `.h5ad` written is opened by Cellucid
 * itself: its cells are the highlighted ones, its genes the dataset's.
 *
 * Fixture: `data-mapping-full` (300 cells; `raw.X` of 8 genes, which the
 * file opens on).
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { chooseFiles } from './helpers/file-input.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const START_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=data-mapping-groups-ci`;
const CELLS = 300;
const PICKED = Array.from({ length: 12 }, (_, i) => i * 7);

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function saveDownload(page, button, testInfo) {
  const download = page.waitForEvent('download');
  await page.locator(button).click();
  const file = await download;
  const saved = testInfo.outputPath(file.suggestedFilename());
  await file.saveAs(saved);
  return saved;
}

for (const name of ['data-mapping-full.h5ad', 'data-mapping-full.zarr.zip']) {
  test(`${name}: the highlighted cells and a field export, and the .h5ad opens with those cells`, async ({ page }, testInfo) => {
    const errors = collectBrowserErrors(page);
    await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
    await openCollapsedPanels(page);
    await chooseFiles(page.locator('#user-data-file-input'), path.join(FIXTURES, name));
    await expect(page.locator('#dataset-name')).toHaveText('data-mapping-full');
    const genes = await page.evaluate(async () => {
      const state = window._cellucidState;
      await state.whenGenesListed();
      return state.getVarAxisGeneCount();
    });

    await page.evaluate(cells => {
      const state = window._cellucidState;
      state.ensureHighlightPage();
      state.addHighlightDirect({ type: 'annotation', label: 'picked', cellIndices: Uint32Array.from(cells) });
    }, PICKED);
    await expect(page.locator('#export-highlights-h5ad')).toBeVisible();

    // A header and a kind row, then one row per open cell; the picked ones true.
    const csv = readFileSync(await saveDownload(page, '#export-highlights-csv', testInfo), 'utf8').trim().split('\n');
    expect(csv.length).toBe(2 + CELLS);
    expect(csv.filter(line => line.endsWith(',true')).length).toBe(PICKED.length);

    // The field chosen in its select exports at once.
    await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
    await expect(page.locator('#export-categorical-field')).toBeEnabled();
    const field = readFileSync(await saveDownload(page, '#export-categorical-field', testInfo), 'utf8').trim().split('\n');
    expect(field.length).toBe(2 + CELLS);
    expect(field[0].split(',')[1]).toBe('cell_type');

    // The .h5ad subset opens in Cellucid: the picked cells, every gene.
    const subset = await saveDownload(page, '#export-highlights-h5ad', testInfo);
    await chooseFiles(page.locator('#user-data-file-input'), subset);
    await expect.poll(() => page.evaluate(() => window._cellucidState.pointCount)).toBe(PICKED.length);
    const opened = await page.evaluate(async () => {
      const state = window._cellucidState;
      await state.whenGenesListed();
      return state.getVarAxisGeneCount();
    });
    expect(opened).toBe(genes);
    expect(errors).toEqual([]);
  });
}
