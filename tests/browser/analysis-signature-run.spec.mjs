/**
 * Gene signature, end to end: typing and pasting genes never runs (Run
 * does); a pasted list split on newlines and commas; a gene the dataset
 * lacks shown as "not found" and left out; two sets scored together; the
 * module score (scanpy score_genes) and UCell.
 */
import { expect, test } from './helpers/test.mjs';
import { anndataZarrZip, fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET = 'analysis-signature';
const ROOT = appUrl('/tests/browser/fixtures/generated-analysis-signature/');
const GROUPS = ['A', 'B', 'C', 'D', 'tiny', 'small'];
const SIZES = [120, 100, 80, 60, 4, 9];
const CELLS = SIZES.reduce((sum, size) => sum + size, 0);
const GENES = Array.from({ length: 12 }, (_, gene) => `G${gene}`);

/** Gene g marks group floor(g / 2); every other value is low with zeros. */
function fixture() {
  const codes = new Int8Array(CELLS);
  let cell = 0;
  SIZES.forEach((size, group) => { for (let i = 0; i < size; i++) codes[cell++] = group; });
  const X = new Float32Array(CELLS * GENES.length);
  for (let c = 0; c < CELLS; c++) {
    for (let g = 0; g < GENES.length; g++) {
      const marker = Math.floor(g / 2) === codes[c];
      X[c * GENES.length + g] = marker
        ? (c % 5 === 0 ? 0 : 2 + (c % 7) / 4)
        : (c % 3 === 0 ? 0.25 * ((c + g) % 4) : 0);
    }
  }
  return anndataZarrZip({
    cells: CELLS,
    genes: [...GENES],
    X,
    obs: { cluster: { categories: [...GROUPS], codes } },
    obsm: {
      X_umap: { data: Float32Array.from({ length: CELLS * 2 }, (_, i) => Math.sin(i * 0.37) * 4), columns: 2 },
    },
    uns: { cellucid: { schema: 1, id: DATASET, name: 'Gene signature fixture' } },
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

function observeProductErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function openSignature(page) {
  await serve(page);
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await page.waitForFunction(count => window._comparisonModule?.state?.pointCount === count, CELLS);
  await page.evaluate(() => { document.getElementById('page-analysis-section').open = true; });
  const header = page.locator('#analysis-header-signature');
  await header.scrollIntoViewIfNeeded();
  await header.click();
  const panel = page.locator('#analysis-panel-signature');
  await expect(panel).toBeVisible();
  return panel;
}

/** A page of the A and B cells, selected for the signature. */
async function pageOfAandB(page) {
  return page.evaluate(async () => {
    const cm = window._comparisonModule;
    const state = cm.state;
    await cm.dataLayer.ensureObsFieldLoaded('cluster');
    const fieldIndex = state.obsData.fields.findIndex(field => field.key === 'cluster');
    const created = state.createHighlightPage('A and B');
    state.switchToPage(created.id);
    state.addHighlightFromCategory(fieldIndex, 0, 'obs');
    state.addHighlightFromCategory(fieldIndex, 1, 'obs');
    return created.id;
  });
}

function lastRaw(page) {
  return page.evaluate(() => {
    const result = window._comparisonModule.getUI('signature')._lastResult;
    if (result === null) return null;
    return {
      method: result.raw.method,
      sets: result.raw.sets.map(set => ({
        name: set.name,
        genes: set.genes,
        unmatched: set.unmatched,
        controls: set.controlGenes.length,
        cells: set.pages[0].scores.length,
        min: Math.min(...set.pages[0].scores),
        max: Math.max(...set.pages[0].scores),
        meanA: set.pages[0].scores.slice(0, 120).reduce((sum, value) => sum + value, 0) / 120,
        meanB: set.pages[0].scores.slice(120).reduce((sum, value) => sum + value, 0) / 100,
      })),
    };
  });
}

async function run(panel) {
  const button = panel.getByRole('button', { name: 'Run gene signature' });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toHaveText('Run');
  await expect(panel.locator('.js-plotly-plot')).toBeVisible();
}

test('typing and pasting never run; Run scores the found genes and names the rest', async ({ page }) => {
  const errors = observeProductErrors(page);
  const panel = await openSignature(page);
  const pageId = await pageOfAandB(page);
  await page.evaluate(id => window._comparisonModule.openAnalysis('signature', { selectedPages: [id] }), pageId);
  const run_ = panel.getByRole('button', { name: 'Run gene signature' });
  await expect(run_).toBeDisabled();
  await expect(panel.locator('.analysis-run-reason')).toHaveText('Add genes to a set');

  const input = panel.getByRole('combobox', { name: 'Add genes to Set 1' });
  await input.fill('g0');
  await input.press('Enter');
  // A pasted list: newlines and commas, a gene the dataset lacks.
  await input.evaluate(element => {
    // A paste as the browser delivers it. The clipboard text is given to the
    // event directly: Firefox leaves a script-made DataTransfer empty.
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: type => (type === 'text/plain' ? 'G1,\nNOPE1\n' : '') },
    });
    element.dispatchEvent(event);
  });
  await expect(panel.locator('.gene-chip')).toHaveCount(3);
  await expect(panel.locator('.gene-chip-missing')).toHaveText(/NOPE1/);
  expect(await page.evaluate(() => window._comparisonModule.getUI('signature')._lastResult)).toBeNull();

  await run(panel);
  const raw = await lastRaw(page);
  expect(raw.sets).toHaveLength(1);
  expect(raw.sets[0].genes).toEqual(['G0', 'G1']);
  expect(raw.sets[0].unmatched).toEqual(['NOPE1']);
  expect(raw.sets[0].cells).toBe(220);
  // G0 and G1 mark A: the A cells score higher.
  expect(raw.sets[0].meanA).toBeGreaterThan(raw.sets[0].meanB);
  await expect(panel.locator('.analysis-result-header .analysis-chip', { hasText: '1 not found' })).toBeVisible();

  // Editing the genes leaves the result stale; nothing runs.
  await input.fill('G2');
  await input.press('Enter');
  await expect(panel.locator('.analysis-stale-chip')).toBeVisible();
  expect((await lastRaw(page)).sets[0].genes).toEqual(['G0', 'G1']);
  expect(errors).toEqual([]);
});

test('two sets with the module score, then UCell', async ({ page }) => {
  const errors = observeProductErrors(page);
  const panel = await openSignature(page);
  const pageId = await pageOfAandB(page);
  await page.evaluate(id => window._comparisonModule.openAnalysis('signature', {
    selectedPages: [id],
    options: {
      geneSets: [{ name: 'A genes', genes: ['G0', 'G1'] }, { name: 'B genes', genes: ['G2', 'G3'] }],
      method: 'module',
      controlSize: 4,
      bins: 3,
    },
  }), pageId);
  await run(panel);
  let raw = await lastRaw(page);
  expect(raw.method).toBe('module');
  expect(raw.sets.map(set => set.name)).toEqual(['A genes', 'B genes']);
  expect(raw.sets.every(set => set.controls > 0)).toBe(true);
  expect(raw.sets[0].meanA).toBeGreaterThan(raw.sets[0].meanB);
  expect(raw.sets[1].meanB).toBeGreaterThan(raw.sets[1].meanA);

  await page.evaluate(() => {
    const ui = window._comparisonModule.getUI('signature');
    ui._setOptions({ ...ui._options, method: 'ucell', maxRank: 6 });
  });
  await run(panel);
  raw = await lastRaw(page);
  expect(raw.method).toBe('ucell');
  for (const set of raw.sets) {
    expect(set.min).toBeGreaterThanOrEqual(0);
    expect(set.max).toBeLessThanOrEqual(1);
  }
  expect(raw.sets[0].meanA).toBeGreaterThan(raw.sets[0].meanB);
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('genes are added by touch typing and the editor fits the width', async ({ page }) => {
    const errors = observeProductErrors(page);
    await serve(page);
    await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await page.waitForFunction(count => window._comparisonModule?.state?.pointCount === count, CELLS);
    if (await page.locator('#sidebar').evaluate(sidebar => sidebar.classList.contains('hidden'))) {
      await page.locator('#sidebar-toggle').click();
    }
    const pageId = await pageOfAandB(page);
    await page.evaluate(() => { document.getElementById('page-analysis-section').open = true; });
    const header = page.locator('#analysis-header-signature');
    await header.scrollIntoViewIfNeeded();
    await header.click();
    const panel = page.locator('#analysis-panel-signature');
    await page.evaluate(id => window._comparisonModule.openAnalysis('signature', { selectedPages: [id] }), pageId);
    const input = panel.getByRole('combobox', { name: 'Add genes to Set 1' });
    await input.tap();
    await input.fill('G0, G1, NOPE1');
    await input.press('Enter');
    await expect(panel.locator('.gene-chip')).toHaveCount(3);
    const overflowing = await panel.evaluate(root => {
      const right = root.getBoundingClientRect().right;
      return [...root.querySelectorAll('*')]
        .filter(element => element.getClientRects().length > 0 && element.getBoundingClientRect().right > right + 1)
        .map(element => element.className || element.localName);
    });
    expect(overflowing).toEqual([]);
    await run(panel);
    expect((await lastRaw(page)).sets[0].genes).toEqual(['G0', 'G1']);
    expect(errors).toEqual([]);
  });
});
