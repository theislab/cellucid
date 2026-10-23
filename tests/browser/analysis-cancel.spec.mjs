/**
 * Every analysis run can be cancelled, and a cancel is a real stop and never a
 * failure (`app/jobs/cancellable-job.js`).
 *
 * The dataset is served over HTTP with every read of it held back while a
 * test says so, so a run is still reading genes when it is cancelled: the
 * running box under the form names the run and offers Cancel; Cancel (there,
 * or in the run's progress notification) stops the reads, leaves a calm
 * "cancelled" box with Run again and no result; Run again then completes.
 */
import { expect, test } from './helpers/test.mjs';
import { anndataZarrZip, fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET = 'analysis-cancel';
const ROOT = appUrl('/tests/browser/fixtures/generated-analysis-cancel/');
const CELLS = 3000;
const GENE_COUNT = 400;
const GENES = Object.freeze(Array.from({ length: GENE_COUNT }, (_, gene) => `GENE${gene + 1}`));
const CATEGORIES = Object.freeze(['alpha', 'beta', 'gamma']);

/** Dense expression (cells x genes), large enough that reading it is a request of its own. */
function expression() {
  return Float32Array.from({ length: CELLS * GENE_COUNT }, (_, index) => {
    const cell = Math.floor(index / GENE_COUNT);
    const gene = index % GENE_COUNT;
    const value = ((cell * 31 + gene * 17) % 23) / 7 + (cell % 3 === gene % 3 ? 2 : 0);
    return value < 1 ? 0 : value;
  });
}

/**
 * Serve the dataset; `hold.ms` holds back each read of the file while set,
 * `hold.held` counts them and `hold.cutOff` counts the reads the page
 * cancelled.
 */
async function serveDataset(page, hold) {
  const bytes = anndataZarrZip({
    cells: CELLS,
    genes: [...GENES],
    X: expression(),
    obs: {
      cell_type: {
        categories: [...CATEGORIES],
        codes: Int8Array.from({ length: CELLS }, (_, cell) => cell % 3),
      },
    },
    obsm: {
      X_umap: {
        data: Float32Array.from({ length: CELLS * 2 }, (_, index) => Math.sin(index * 0.7) * 3),
        columns: 2,
      },
    },
    uns: { cellucid: { schema: 1, id: DATASET, name: 'Analysis cancel fixture' } },
  });
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
    if (hold.ms > 0) {
      hold.held += 1;
      await new Promise(resolve => setTimeout(resolve, hold.ms));
    }
    await fulfillFile(route, bytes).catch(() => {
      // The page let go of the request while it was held.
    });
  });
  page.on('requestfailed', request => {
    if (request.url().endsWith(file)) hold.cutOff += 1;
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

/** Open the dataset with two pages, alpha and beta cells, and open `mode`. */
async function openWithPages(page, mode) {
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`, {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  await page.waitForFunction(count => window._comparisonModule?.state?.pointCount === count, CELLS);
  await page.evaluate(async () => {
    const { state, dataLayer } = window._comparisonModule;
    await dataLayer.ensureObsFieldLoaded('cell_type');
    const fieldIndex = state.obsData.fields.findIndex(field => field.key === 'cell_type');
    for (const [name, code] of [['Alpha cells', 0], ['Beta cells', 1]]) {
      const created = state.createHighlightPage(name);
      state.switchToPage(created.id);
      state.addHighlightFromCategory(fieldIndex, code, 'obs');
    }
  });
  const header = page.locator(`#analysis-header-${mode}`);
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  const panel = page.locator(`#analysis-panel-${mode}`);
  await expect(panel).toBeVisible();
  return panel;
}

test('differential expression: Cancel stops the run, keeps nothing, and Run again completes', async ({ page }) => {
  const errors = observeProductErrors(page);
  const hold = { ms: 0, held: 0, cutOff: 0 };
  await serveDataset(page, hold);
  const panel = await openWithPages(page, 'differential');

  const [pageA, pageB] = await panel.locator('select.page-select').all();
  await pageA.selectOption({ label: 'Alpha cells' });
  await pageB.selectOption({ label: 'Rest of Alpha cells' });
  // What a run costs is said before it starts.
  await expect(panel.locator('.analysis-run-cost')).toHaveText(
    `Tests ${GENE_COUNT} genes in 1,000 vs 2,000 cells.`
  );

  hold.ms = 4000;
  const run = panel.locator('.analysis-run-btn');
  const runLabel = await run.textContent();
  await run.click();
  await expect(run).toHaveText('Running…');
  const status = panel.locator('.job-status');
  await expect(status).toBeVisible();
  await expect(status.locator('.job-status-title')).toHaveText('Differential expression');
  await expect(status.locator('.job-status-plan')).toHaveText(
    `${GENE_COUNT} genes in Alpha cells (1,000 cells) vs Rest of Alpha cells (2,000 cells)`
  );
  await expect(status.locator('.job-status-detail')).toContainText('Testing genes');
  await expect.poll(() => hold.held).toBeGreaterThan(0);

  await status.getByRole('button', { name: 'Cancel' }).click();
  await expect(status.locator('.job-status-title')).toHaveText('Differential expression cancelled');
  await expect(status.locator('.job-status-detail')).toContainText('Nothing was kept');
  await expect(run).toHaveText(runLabel);
  await expect(run).toBeEnabled();
  await expect(panel.locator('.analysis-preview-plot, .js-plotly-plot')).toHaveCount(0);
  // The read under way was stopped, not left to finish for nobody.
  await expect.poll(() => hold.cutOff).toBeGreaterThan(0);
  // A cancel is not an error notification.
  await expect(page.locator('.notification[data-type="error"]')).toHaveCount(0);

  hold.ms = 0;
  await status.getByRole('button', { name: 'Run again' }).click();
  await expect(status).toBeHidden({ timeout: 30_000 });
  await expect(panel.locator('.js-plotly-plot').first()).toBeVisible({ timeout: 30_000 });
  await expect(run).toHaveText(runLabel);

  expect(errors).toEqual([]);
});

test('marker genes: Cancel from the notification stops discovery, keeps nothing, and Run again completes', async ({ page }) => {
  const errors = observeProductErrors(page);
  const hold = { ms: 0, held: 0, cutOff: 0 };
  await serveDataset(page, hold);
  const panel = await openWithPages(page, 'genesPanel');

  await panel.locator('select[name="obsCategory"]').selectOption('cell_type');
  await expect(panel.locator('.analysis-run-cost')).toHaveText(
    `Reads ${GENE_COUNT} genes in 3,000 cells, testing each category of cell_type against the rest.`
  );

  hold.ms = 5000;
  const run = panel.locator('.analysis-run-btn');
  await run.click();
  const status = panel.locator('.job-status');
  await expect(status.locator('.job-status-title')).toHaveText('Marker genes');
  // The run's one progress notification, with its own Cancel.
  const notification = page.locator('.notification', { hasText: 'Marker genes:' });
  await expect(notification).toHaveCount(1, { timeout: 5_000 });
  await notification.locator('[data-role="cancel"]').click();
  await expect(status.locator('.job-status-title')).toHaveText('Marker genes cancelled');
  await expect(notification).toHaveCount(0);
  await expect(run).toBeEnabled();
  await expect(panel.locator('.js-plotly-plot')).toHaveCount(0);

  hold.ms = 0;
  await status.getByRole('button', { name: 'Run again' }).click();
  await expect(status).toBeHidden({ timeout: 30_000 });
  await expect(panel.locator('.js-plotly-plot').first()).toBeVisible({ timeout: 30_000 });

  expect(errors).toEqual([]);
});
