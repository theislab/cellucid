/**
 * Progressive subsampled reading, in the app (`anndata/prefix-column-index.js`).
 *
 * - A gene of a subsample's cell-major matrix shows on a sample of the open
 *   cells before its index is built: its first colours come with the cells
 *   not read yet in the missing colour (NaN), then the whole gene.
 * - Raising the subsample in place (Cells to open, same method and seed)
 *   keeps the gene index of the cells already open: the next gene shows
 *   on at least those cells from its first colours. (That only the new
 *   cells are indexed is held exactly by `tests/progressive-subsample.test.mjs`.)
 *
 * Fixture: a synthetic `.zarr.zip` of 2,400 cells whose CSR `X` holds 600
 * values a cell, so a subsample's index spans several segments.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { anndataZarrZip, fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const CELLS = 2400;
const GENES = 700;
const PER_CELL = 600;

function wideDataset() {
  const data = new Float32Array(CELLS * PER_CELL);
  const indices = new Int32Array(CELLS * PER_CELL);
  const indptr = new Int32Array(CELLS + 1);
  for (let cell = 0; cell < CELLS; cell++) {
    // Six hundred distinct genes a cell, from an offset of its own.
    const genes = Array.from({ length: PER_CELL }, (_, j) => (cell * 37 + j) % GENES).sort((a, b) => a - b);
    genes.forEach((gene, j) => {
      indices[cell * PER_CELL + j] = gene;
      data[cell * PER_CELL + j] = 1 + ((cell * 7 + gene) % 13);
    });
    indptr[cell + 1] = (cell + 1) * PER_CELL;
  }
  return anndataZarrZip({
    cells: CELLS,
    genes: Array.from({ length: GENES }, (_, g) => `g${g}`),
    X: { data, indices, indptr },
    obsm: { X_umap: { data: Float32Array.from({ length: CELLS * 2 }, (_, i) => Math.sin(i) * 10), columns: 2 } },
  });
}

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

/** Record every partial colouring of a gene: how many open cells it was shown on. */
async function recordPartials(page) {
  await page.evaluate(() => {
    const state = window._cellucidState;
    window.__partials = [];
    const show = state.showPartialVarField.bind(state);
    state.showPartialVarField = (index, values) => {
      let shown = 0;
      for (const value of values) if (!Number.isNaN(value)) shown++;
      window.__partials.push(shown);
      return show(index, values);
    };
  });
}

async function chooseGene(page, name) {
  const search = page.locator('#gene-expression-search');
  await search.click();
  await search.fill(name);
  await search.press('Enter');
  await expect.poll(() => page.evaluate(gene => {
    const state = window._cellucidState;
    return state.activeFieldSource === 'var' && state.varData.fields[state.activeVarFieldIndex]?.key === gene;
  }, name), { timeout: 60_000 }).toBe(true);
}

test('a subsample\'s gene fills in as its cells are read, and raising the subsample keeps the index of the cells open', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectBrowserErrors(page);
  const url = `${SAMPLE_ORIGIN}/progressive/wide.zarr.zip`;
  const bytes = wideDataset();
  await page.route(url, route => fulfillFile(route, bytes));
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(url)}&cells=1000&sample=uniform&seed=3`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 60_000 }).toBe(1000);
  await openCollapsedPanels(page);

  // The open cells are in priority order: open cell i is the i-th lowest rank.
  const ordered = await page.evaluate(async () => {
    const { priorityOrder } = await import('/assets/js/data/subsample.js');
    const identity = window._cellucidState.cellIdentity;
    const open = Array.from(identity.toOriginal(Uint32Array.from({ length: identity.n }, (_, i) => i)));
    const spec = { method: 'uniform', nObs: identity.nOriginal, k: identity.n, seed: 3 };
    return JSON.stringify(open) === JSON.stringify(Array.from(priorityOrder(spec, identity.kept)));
  });
  expect(ordered).toBe(true);

  // A first gene: its index of the 1,000 cells is built for it.
  await recordPartials(page);
  await chooseGene(page, 'g5');
  const gene5 = await page.evaluate(() => {
    const state = window._cellucidState;
    const values = state.varData.fields[state.activeVarFieldIndex].values;
    return { length: values.length, missing: Array.from(values).filter(Number.isNaN).length };
  });
  expect(gene5).toEqual({ length: 1000, missing: 0 });

  // Raised in place to 2,000 cells, the same method and seed.
  await page.locator('#subsample-percent').fill(String((100 * 2000) / CELLS));
  await expect(page.locator('#subsample-count')).toHaveText('2,000 of 2,400 cells');
  await page.locator('#subsample-method').selectOption('uniform');
  await page.locator('#subsample-seed').fill('3');
  await page.locator('#subsample-apply').click();
  await expect.poll(() => page.evaluate(() => window._cellucidState.pointCount), { timeout: 60_000 }).toBe(2000);
  // The 1,000 open before are the first 1,000 now.
  const prefix = await page.evaluate(async () => {
    const { subsampleUniform } = await import('/assets/js/data/subsample.js');
    const identity = window._cellucidState.cellIdentity;
    const first = Array.from(identity.toOriginal(Uint32Array.from({ length: 1000 }, (_, i) => i))).sort((a, b) => a - b);
    return JSON.stringify(first) === JSON.stringify(Array.from(subsampleUniform(identity.nOriginal, 1000, 3)));
  });
  expect(prefix).toBe(true);

  // The next gene shows on no fewer than the 1,000 cells indexed already
  // (all at once when the index of the new cells, built ahead from a local
  // link, is done before it is asked for), then on every open cell.
  await recordPartials(page);
  await chooseGene(page, 'g9');
  const partials = await page.evaluate(() => window.__partials);
  for (const shown of partials) expect(shown).toBeGreaterThanOrEqual(1000);
  const gene9 = await page.evaluate(() => {
    const state = window._cellucidState;
    const values = state.varData.fields[state.activeVarFieldIndex].values;
    return { length: values.length, missing: Array.from(values).filter(Number.isNaN).length };
  });
  expect(gene9).toEqual({ length: 2000, missing: 0 });

  expect(errors).toEqual([]);
});
