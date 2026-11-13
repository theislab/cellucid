/**
 * Gray for zero (the legend's switch, `DataState.setContinuousZeroGray`):
 * off by default, a gene's 0 is drawn in the color scale's lowest color,
 * opaque, like any value; on, its zeros are the no-value gray drawn
 * beneath the expressing cells (`BENEATH_ALPHA_BYTE`). The switch is
 * offered for a gene with no negative value only, sits above Log color
 * scale, and is saved in the session and restored. The Session panel's
 * Subsampling and Data mapping sections start collapsed, with a summary,
 * and stay as this viewer left them across a reload. The color rules are
 * held by `tests/legend-continuous-filter-independence.test.mjs`; this is
 * the app, in each engine.
 */

import { readFile } from 'node:fs/promises';
import { expect, test } from './helpers/test.mjs';
import { serveSyntheticCatalog } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { waitForDatasetReady } from './helpers/dataset-ready.mjs';
import { openPhoneSheet } from './helpers/panels.mjs';
import { clickSaveSession, clickLoadSession } from './helpers/session-buttons.mjs';

const DATASET = 'zero-gray';
const ROOT = appUrl('/tests/browser/fixtures/generated-zero-gray/');
const CELLS = 60;
const GENES = Object.freeze(['COUNTS', 'SCALED']);
/** Dense, cells x genes: counts with zeros on every third cell; scaled values with negatives. */
const X = Float32Array.from({ length: CELLS * GENES.length }, (_, index) => {
  const cell = Math.floor(index / GENES.length);
  return index % GENES.length === 0 ? (cell % 3 === 0 ? 0 : 1 + (cell % 7)) : (cell % 5) - 2;
});

async function chooseGene(page, name) {
  const search = page.locator('#gene-expression-search');
  await search.click();
  await search.fill(name);
  await search.press('Enter');
  await expect.poll(() => page.evaluate(gene => {
    const state = window._cellucidState;
    const field = state.varData?.fields?.[state.activeVarFieldIndex];
    return state.activeFieldSource === 'var' && field?.key === gene && field.loaded === true;
  }, name)).toBe(true);
}

/** The alpha byte (the layer) of each zero cell of the live view's colors. */
function zeroLayers(page) {
  return page.evaluate(cells => {
    const colors = window._cellucidState.colorsArray;
    const layers = new Set();
    for (let cell = 0; cell < cells; cell += 3) layers.add(colors[cell * 4 + 3]);
    return [...layers];
  }, CELLS);
}

test('gray for zero and the Session panel\'s sections, each kept as this viewer left it', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await serveSyntheticCatalog(page, ROOT, {
    id: DATASET,
    name: 'Zero gray fixture',
    cells: CELLS,
    genes: [...GENES],
    X,
    obsm: { X_umap: { data: Float32Array.from({ length: CELLS * 2 }, (_, index) => Math.cos(index * 0.37) * 4), columns: 2 } },
  });
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await waitForDatasetReady(page, CELLS);
  await openPhoneSheet(page);

  await test.step('the Session panel: Stored above Subsampling and Data mapping, collapsed with a summary, kept as this viewer left them', async () => {
    // The order of the panel's blocks.
    const ids = await page.evaluate(() => [...document.querySelectorAll('#session-section > .accordion-content > [id]')].map(node => node.id));
    // (Share… and Load… of the history are the State panel's: `session-state-controls`.)
    expect(ids).toEqual(['dataset-facts', 'open-data-controls', 'kept-stores-line', 'reading-section', 'data-mapping-controls']);
    // Collapsed, each says what it holds.
    for (const toggle of ['#reading-toggle', '#data-mapping-toggle']) await expect(page.locator(toggle)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#subsample-slider')).toBeHidden();
    await expect(page.locator('#reading-summary')).toHaveText('100% cells');
    await expect(page.locator('#data-mapping-summary')).toHaveText(/^1 embedding · /);
    // Opened, its summary is the content's to say.
    await page.locator('#reading-toggle').click();
    await expect(page.locator('#subsample-slider')).toBeVisible();
    await expect(page.locator('#reading-summary')).toBeHidden();
    // Kept across a reload in this browser (never in the address).
    expect(page.url()).not.toContain('reading');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await waitForDatasetReady(page, CELLS);
    await openPhoneSheet(page);
    await expect(page.locator('#reading-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#data-mapping-toggle')).toHaveAttribute('aria-expanded', 'false');
    // A way to the data mapping (the outlier filter's Choose latent space, the gene names' choice) opens it.
    await page.evaluate(async () => {
      const { expandSessionSection } = await import('/assets/js/app/ui/modules/session-sections.js');
      expandSessionSection(document, 'dataMapping');
    });
    await expect(page.locator('#data-mapping-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#data-mapping-disclosure')).toBeVisible();
  });

  await test.step('gray for zero: off by default, on draws zeros gray beneath, offered for counts only, saved in the session', async () => {
    await chooseGene(page, 'COUNTS');
    const zeroSwitch = page.locator('#legend .legend-zero-gray-switch');
    await expect(zeroSwitch).toBeVisible();
    await expect(zeroSwitch).toHaveAttribute('aria-checked', 'false');
    // Above Log color scale and Rescale to range, in that order.
    const order = await page.locator('#legend .switch .switch-label').allTextContents();
    expect(order.slice(0, 3)).toEqual(['Gray for zero', 'Log color scale', 'Rescale to range']);
    // No sentence about gray under the color bar.
    await expect(page.locator('#legend')).not.toContainText('not expressed');
    // Off: the zeros are colored, opaque.
    expect(await zeroLayers(page)).toEqual([255]);
    await zeroSwitch.click();
    await expect(zeroSwitch).toHaveAttribute('aria-checked', 'true');
    expect(await zeroLayers(page)).toEqual([254]);
    // On a log scale 0 has no logarithm: gray either way, the switch has nothing to change.
    await page.locator('#legend .switch', { hasText: 'Log color scale' }).click();
    await expect(zeroSwitch).toBeDisabled();
    await page.locator('#legend .switch', { hasText: 'Log color scale' }).click();
    await expect(zeroSwitch).toBeEnabled();

    // Scaled data (negative values): 0 is a value, no switch.
    await chooseGene(page, 'SCALED');
    await expect(zeroSwitch).toBeHidden();

    // Back to the counts: the switch is the gene's own, still on; saved and restored.
    await chooseGene(page, 'COUNTS');
    await expect(zeroSwitch).toHaveAttribute('aria-checked', 'true');
    const downloadPromise = page.waitForEvent('download');
    await clickSaveSession(page);
    const sessionPath = testInfo.outputPath('zero-gray.cellucid-session');
    await (await downloadPromise).saveAs(sessionPath);
    const bytes = await readFile(sessionPath);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await waitForDatasetReady(page, CELLS);
    await openPhoneSheet(page);
    const chooserPromise = page.waitForEvent('filechooser');
    await clickLoadSession(page);
    await (await chooserPromise).setFiles({ name: 'zero-gray.cellucid-session', mimeType: 'application/octet-stream', buffer: bytes });
    await expect.poll(() => page.evaluate(() => {
      const state = window._cellucidState;
      return state.activeFieldSource === 'var' ? state.varData.fields[state.activeVarFieldIndex]?._zeroGray ?? null : null;
    }), { timeout: 60_000 }).toBe(true);
    await expect(page.locator('#legend .legend-zero-gray-switch')).toHaveAttribute('aria-checked', 'true');
    expect(await zeroLayers(page)).toEqual([254]);
    expect(errors).toEqual([]);
  });
});
