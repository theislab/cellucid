/**
 * Progressive analysis in the app: a run predicted to be slow (this device's
 * measured cost, seeded here) answers first on a uniform sample of the open
 * cells, says so, then refines in place; the final result is exactly the one
 * a single run on every cell gives.
 */
import { closeContextWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { anndataZarrZip, fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET = 'analysis-progressive';
const ROOT = appUrl('/tests/browser/fixtures/generated-analysis-progressive/');
const CELLS = 20_000;
const TYPES = ['T cell', 'B cell', 'Monocyte', 'NK cell'];
const SAMPLES = ['s1', 's2', 's3', 's4', 's5', 's6'];
const CONDITIONS = ['healthy', 'disease'];
const COST_KEY = 'cellucid:analysis-cost:v1';

function fixture() {
  // Stored sorted by cell type, the way atlases often are.
  const type = new Int8Array(CELLS);
  const sample = new Int8Array(CELLS);
  const condition = new Int8Array(CELLS);
  for (let cell = 0; cell < CELLS; cell++) {
    type[cell] = Math.min(TYPES.length - 1, Math.floor((cell / CELLS) * TYPES.length * 1.3));
    sample[cell] = (cell * 7) % SAMPLES.length;
    condition[cell] = sample[cell] >= 3 ? 1 : 0;
  }
  return anndataZarrZip({
    cells: CELLS,
    genes: ['CD3E', 'MS4A1'],
    X: Float32Array.from({ length: CELLS * 2 }, (_, index) => index % 5),
    obs: {
      cell_type: { categories: [...TYPES], codes: type },
      sample_id: { categories: [...SAMPLES], codes: sample },
      condition: { categories: [...CONDITIONS], codes: condition },
    },
    obsm: {
      X_umap: {
        data: Float32Array.from({ length: CELLS * 2 }, (_, index) => Math.sin(index * 0.37) * 4),
        columns: 2,
      },
    },
    uns: { cellucid: { schema: 1, id: DATASET, name: 'Progressive fixture' } },
  });
}

async function serve(page) {
  const bytes = fixture();
  const file = `${DATASET}.zarr.zip`;
  const catalog = JSON.stringify({ schema: 2, default: DATASET, datasets: [{ id: DATASET, path: file }] });
  const prefix = new URL(ROOT).pathname;
  await page.route(`${ROOT}**`, async route => {
    const relative = new URL(route.request().url()).pathname.slice(prefix.length);
    if (relative === 'datasets.json') {
      await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: catalog });
      return;
    }
    if (relative !== file) {
      await route.fulfill({ status: 404, body: `Unexpected fixture request: ${relative}\n` });
      return;
    }
    await fulfillFile(route, bytes);
  });
}

/** Open Composition with this device's measured cost of it seeded. */
async function openComposition(page, cost) {
  await page.addInitScript(({ key, value }) => {
    try { localStorage.setItem(key, value); } catch { /* storage blocked: the default probe */ }
  }, { key: COST_KEY, value: JSON.stringify({ Composition: cost }) });
  await serve(page);
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await page.waitForFunction(count => window._comparisonModule?.state?.pointCount === count, CELLS);
  await page.evaluate(() => { document.getElementById('page-analysis-section').open = true; });
  const header = page.locator('#analysis-header-composition');
  await header.scrollIntoViewIfNeeded();
  await header.click();
  const panel = page.locator('#analysis-panel-composition');
  await expect(panel).toBeVisible();
  await panel.locator('select[name="condition"]').selectOption('condition');
  // Every text the cells-used line shows, in order.
  await page.evaluate(() => {
    const line = document.querySelector('#analysis-panel-composition .analysis-cells-used');
    window.__cellsUsed = [];
    new MutationObserver(() => {
      if (!line.hidden && line.textContent) window.__cellsUsed.push(line.textContent);
    }).observe(line, { childList: true, characterData: true, subtree: true, attributes: true });
  });
  return panel;
}

async function runAndRead(page, panel) {
  const button = panel.getByRole('button', { name: 'Run composition' });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(panel.locator('.analysis-cells-used')).toHaveAttribute('data-cells-used', 'all');
  return page.evaluate(() => ({
    composition: window._comparisonModule.getUI('composition')._lastResult.composition,
    lines: window.__cellsUsed,
  }));
}

test('a slow run answers on a uniform sample first, then refines to exactly the one-pass result', async ({ browser }) => {
  // Measured: 5 s for every cell, all of it per cell. A first pass then takes
  // the cells that fit in a second.
  const slowContext = await browser.newContext();
  const slowPage = await slowContext.newPage();
  const slow = await runAndRead(slowPage, await openComposition(slowPage, [{ cells: CELLS, ms: 5_000 }]));
  await closeContextWithApplicationRetirement(slowContext);
  expect(slow.lines[0]).toMatch(/^First pass: each group's cells in a uniform sample of 20\.0% of the open cells \(about 4,000 of 20,000\) · refining on every cell…$/);
  expect(slow.lines.at(-1)).toBe('Every cell: computed on all cells of its groups (20,000 open cells).');

  // Measured fast: one pass.
  const fastContext = await browser.newContext();
  const fastPage = await fastContext.newPage();
  const fast = await runAndRead(fastPage, await openComposition(fastPage, [{ cells: CELLS, ms: 5 }]));
  await closeContextWithApplicationRetirement(fastContext);
  expect(fast.lines.some(line => line.startsWith('First pass'))).toBe(false);

  expect(slow.composition).toEqual(fast.composition);
  expect(slow.composition.totalCells).toBe(CELLS);
});
