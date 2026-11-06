/**
 * A dataset stored cell by cell (CSR) over a link too slow to read a gene
 * for every cell within the gene-time target opens every cell on the map,
 * and a gene is read for a stated sample of them (`subsample-plan.js`,
 * `genes`): the others are NaN (not read, drawn gray beneath, never 0), the
 * gene's legend says so in one line that links to Session › Subsampling:
 * Genes read for, whose slider at 100 % (its cost said first) reads the
 * rest, after which the gene has a value on every cell and the lines go. The planner's arithmetic, the
 * reader's segments and the analyses' cells are held by
 * `tests/gene-sample-contract.test.mjs`; this is the app, in each engine.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { anndataZarrZip } from './helpers/anndata-zarr-zip.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const CELLS = 2400;
const GENES = 1500;
const PER_CELL = 1200;
/** One shared link: a round trip, then the bytes at this rate (bytes a millisecond), every response after the one before. */
const LATENCY_MS = 40;
const BYTES_PER_MS = 400;

// The link is this spec's subject, and it is measured (`helpers/device.mjs`
// holds it for every other spec): the answers below are held back so the
// reader measures a slow link, and what it then plans is asserted only as
// far as any slow link gives it (genes for a sample of at least 2 cells and
// fewer than all; a runner that answers later measures a slower link and
// reads them for fewer, never for none or for all). The decoding rate, the
// order time and the opening cost stay held.
test.use({ device: { link: 'measured' } });

function atlas() {
  const data = new Float32Array(CELLS * PER_CELL);
  const indices = new Int32Array(CELLS * PER_CELL);
  const indptr = new Int32Array(CELLS + 1);
  for (let cell = 0; cell < CELLS; cell++) {
    for (let j = 0; j < PER_CELL; j++) {
      indices[cell * PER_CELL + j] = (cell + j) % GENES;
      data[cell * PER_CELL + j] = 1 + ((cell * 7 + j) % 13);
    }
    // A row's genes ascend.
    indices.subarray(cell * PER_CELL, (cell + 1) * PER_CELL).sort();
    indptr[cell + 1] = (cell + 1) * PER_CELL;
  }
  return anndataZarrZip({
    cells: CELLS,
    genes: Array.from({ length: GENES }, (_, g) => `g${g}`),
    X: { data, indices, indptr },
    obsm: { X_umap: { data: Float32Array.from({ length: CELLS * 2 }, (_, i) => Math.sin(i) * 10), columns: 2 } },
  });
}

/** The file over one slow shared link, with a version (ETag). */
function serveSlowly(bytes) {
  let free = 0;
  return async route => {
    const request = route.request();
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'ETag, Content-Range, Content-Length',
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
      ETag: '"gene-sample-v1"',
    };
    if (request.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...headers, 'Content-Length': String(bytes.length) }, body: '' });
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? '');
    const start = range === null ? 0 : Number(range[1]);
    const end = range === null ? bytes.length - 1 : Math.min(range[2] === '' ? bytes.length - 1 : Number(range[2]), bytes.length - 1);
    const now = performance.now();
    const at = Math.max(now + LATENCY_MS, free) + (end + 1 - start) / BYTES_PER_MS;
    free = at;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, at - performance.now())));
    if (range === null) return route.fulfill({ status: 200, headers, body: bytes });
    return route.fulfill({ status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }, body: bytes.subarray(start, end + 1) });
  };
}

async function chooseGene(page, name) {
  const search = page.locator('#gene-expression-search');
  await search.click();
  await search.fill(name);
  await search.press('Enter');
  await expect.poll(() => page.evaluate(gene => {
    const state = window._cellucidState;
    const field = state.varData?.fields?.[state.activeVarFieldIndex];
    return state.activeFieldSource === 'var' && field?.key === gene && field.loaded === true;
  }, name), { timeout: 120_000 }).toBe(true);
}

test('a CSR atlas over a slow link opens every cell, reads a gene for a stated sample, and reads the rest on request', async ({ page }) => {
  test.setTimeout(360_000);
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  const url = `${SAMPLE_ORIGIN}/gene-sample/atlas.zarr.zip`;
  await page.route(url, serveSlowly(atlas()));
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(url)}`, { waitUntil: 'domcontentloaded' });

  // Every cell on the map; genes for a sample of them.
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 120_000 }).toBe(CELLS);
  await expect.poll(() => page.evaluate(() => window._cellucidState.getGeneSample()?.cells ?? null)).not.toBeNull();
  const sample = await page.evaluate(() => window._cellucidState.getGeneSample());
  expect(sample.of).toBe(CELLS);
  expect(sample.cells).toBeGreaterThan(1);
  expect(sample.cells).toBeLessThan(CELLS);
  expect(sample.fit.limit).toBe('geneTime');
  await openCollapsedPanels(page);
  // Genes read for, under Cells to open: the share and its cells, compact (one line at the narrowest panel).
  await expect(page.locator('#gene-read-block')).toBeVisible();
  await expect(page.locator('#gene-read-status')).toHaveText(/^[\d.]+K? of 2\.4K cells$/);
  await expect(page.locator('#subsample-notice')).toBeHidden();
  await expect(page.locator('#reading-summary')).toHaveText(/^100 % cells · genes [\d.]+ %$/);

  // A gene: values on the sample's cells, NaN (not read) on the others.
  await chooseGene(page, 'g5');
  // What is left of the gene time after the first gene reads genes for more
  // cells (`topUpGeneSample`): the sample the gene time sized, measured.
  await expect.poll(() => page.evaluate(() => window._cellucidState.getGeneSampleGrowth()), { timeout: 60_000 }).toBeNull();
  const filled = await page.evaluate(() => window._cellucidState.getGeneSample());
  expect(filled.cells).toBeGreaterThanOrEqual(sample.cells);
  expect(filled.fit.limit).toBe('geneTime');
  const read = await page.evaluate(() => {
    const state = window._cellucidState;
    const values = state.varData.fields[state.activeVarFieldIndex].values;
    const cells = state.getGeneSample().cells;
    let unreadValues = 0;
    let readNaN = 0;
    for (let i = 0; i < values.length; i++) {
      if (i >= cells && !Number.isNaN(values[i])) unreadValues++;
      if (i < cells && Number.isNaN(values[i])) readNaN++;
    }
    return { unreadValues, readNaN };
  });
  expect(read).toEqual({ unreadValues: 0, readNaN: 0 });
  // The legend: one line naming the sample, a link to Genes read for; the states drawn beside their colours.
  const link = page.locator('#legend .legend-gene-read .gene-read-link');
  await expect(link).toHaveText(/^Gene read for [\d.]+K? of 2\.4K cells$/);
  await expect(link).toHaveAttribute('title', new RegExp(`^Gene read for ${filled.cells.toLocaleString('en-US')} of 2,400 cells\\. `));
  await expect(page.locator('#legend').getByRole('button', { name: /Read for/ })).toHaveCount(0);
  // Gray for zero is off by default: the layer line names the faded cells only.
  await expect(page.locator('#legend .legend-layer-note')).toHaveText('Faded: not read');
  await page.locator('#legend .legend-zero-gray-switch').click();
  await expect(page.locator('#legend .legend-layer-note')).toHaveText('Faded: not read · gray: 0');
  // The link opens Subsampling (collapsed here) at Genes read for, its slider focused.
  await page.locator('#reading-toggle').click();
  await expect(page.locator('#reading-toggle')).toHaveAttribute('aria-expanded', 'false');
  await link.click();
  await expect(page.locator('#reading-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#gene-read-slider')).toBeFocused();

  // 100 %, the top of the slider: its cost said before it is read.
  await page.keyboard.press('End');
  await expect(page.locator('#gene-read-percent')).toHaveValue('100');
  await expect(page.locator('#gene-read-status')).toHaveText(/^2\.4K of 2\.4K cells · \d[\d.,]* (KB|MB)(, ~\d.*)?$/);
  await expect(page.locator('#gene-read-action')).toHaveText('Read');

  // Read: the gene then has a value on every cell, and the lines go.
  await page.locator('#gene-read-action').click();
  await expect.poll(() => page.evaluate(() => window._cellucidState.getGeneSample()), { timeout: 240_000 }).toBeNull();
  await expect.poll(() => page.evaluate(() => {
    const state = window._cellucidState;
    return Array.from(state.varData.fields[state.activeVarFieldIndex].values).filter(Number.isNaN).length;
  }), { timeout: 60_000 }).toBe(0);
  await expect(page.locator('#legend .legend-gene-read')).toBeHidden();
  await expect(page.locator('#gene-read-block')).toBeHidden();
  await expect(page.locator('#reading-summary')).toHaveText('100 % cells');
  // A later gene is read for every cell.
  await chooseGene(page, 'g9');
  expect(await page.evaluate(() => {
    const state = window._cellucidState;
    return Array.from(state.varData.fields[state.activeVarFieldIndex].values).filter(Number.isNaN).length;
  })).toBe(0);
  expect(errors).toEqual([]);
});
