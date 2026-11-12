/**
 * Every analysis run can be canceled, and a cancel is a real stop and never a
 * failure (`app/jobs/cancellable-job.js`).
 *
 * The dataset is served over HTTP with every read of it held back while a
 * test says so, so a run is still reading genes when it is canceled: the
 * running box under the form names the run and offers Cancel; Cancel (there,
 * or in the run's progress notification) stops the reads, leaves a calm
 * "canceled" box with Run again and no result; Run again then completes.
 */
import { expect, test } from './helpers/test.mjs';
import { anndataZarrZip, fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { setSimulatedGpu } from './helpers/device.mjs';
import { waitForPageAtRest } from './helpers/dataset-ready.mjs';

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
 * Serve the dataset; while `hold.gate` is set each read of the file waits
 * until the test releases it (`holdReads`), `hold.held` counts them, and
 * `hold.cutOff` counts the reads the page says it canceled (`(canceled)`). That is the
 * read log's line, not the network event: the reads run in the reader
 * worker, and Firefox reports a worker fetch aborted mid-response as
 * finished, not failed.
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
    if (hold.gate !== null) {
      hold.held += 1;
      await hold.gate.released;
    }
    await fulfillFile(route, bytes).catch(() => {
      // The page let go of the request while it was held.
    });
  });
  page.on('console', message => {
    // A quick read ends in one debug entry with others, a line each.
    hold.cutOff += message.text().match(/^\[cellucid:read\] .*\(canceled\)$/gm)?.length ?? 0;
  });
}

/**
 * Hold every read of the file from here until `releaseReads`: the run is
 * still reading when Cancel is clicked however slow the runner, where a hold
 * of a set time let a slow one finish first.
 */
function holdReads(hold) {
  let release;
  const released = new Promise(resolve => {
    release = resolve;
  });
  hold.gate = { released, release };
}

/** Let the held reads go (each the page let go of already ends there) and read freely again. */
function releaseReads(hold) {
  hold.gate?.release();
  hold.gate = null;
}

function observeProductErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/** Two pages, alpha and beta cells, on the dataset open; then open `mode`. */
async function openWithPagesOpen(page, mode) {
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

/** Open the dataset with two pages, alpha and beta cells, and open `mode`. */
async function openWithPages(page, mode) {
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`, {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await page.waitForFunction(count => window._comparisonModule?.state?.pointCount === count, CELLS);
  return openWithPagesOpen(page, mode);
}

test('differential expression: Cancel stops the run, keeps nothing, and Run again completes', async ({ page }) => {
  const errors = observeProductErrors(page);
  const hold = { gate: null, held: 0, cutOff: 0 };
  await serveDataset(page, hold);
  const panel = await openWithPages(page, 'differential');

  await panel.getByRole('combobox', { name: 'Group A' }).selectOption({ label: 'Alpha cells' });
  await panel.getByRole('combobox', { name: 'Group B' }).selectOption({ label: 'Rest of Alpha cells' });

  holdReads(hold);
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
  await expect(status.locator('.job-status-title')).toHaveText('Differential expression canceled');
  await expect(status.locator('.job-status-detail')).toContainText('Nothing was kept');
  await expect(run).toHaveText(runLabel);
  await expect(run).toBeEnabled();
  await expect(panel.locator('.analysis-preview-plot, .js-plotly-plot')).toHaveCount(0);
  // The read under way was stopped, not left to finish for nobody.
  await expect.poll(() => hold.cutOff).toBeGreaterThan(0);
  // A cancel is not an error notification.
  await expect(page.locator('.notification[data-type="error"]')).toHaveCount(0);

  releaseReads(hold);
  await status.getByRole('button', { name: 'Run again' }).click();
  await expect(status).toBeHidden();
  await expect(panel.locator('.js-plotly-plot').first()).toBeVisible();
  await expect(run).toHaveText(runLabel);

  expect(errors).toEqual([]);
});

test('marker genes: Cancel from the notification stops discovery, keeps nothing, and Run again completes', async ({ page }) => {
  const errors = observeProductErrors(page);
  const hold = { gate: null, held: 0, cutOff: 0 };
  await serveDataset(page, hold);
  const panel = await openWithPages(page, 'genesPanel');

  await panel.getByRole('combobox', { name: 'Group by' }).selectOption('cell_type');

  holdReads(hold);
  const run = panel.locator('.analysis-run-btn');
  await expect(run).toBeEnabled();
  await run.click();
  const status = panel.locator('.job-status');
  await expect(status.locator('.job-status-title')).toHaveText('Marker genes');
  await expect(status.locator('.job-status-plan')).toHaveText(`${GENE_COUNT} genes · 3 of 3 groups tested`);
  // The run's one progress notification, with its own Cancel.
  const notification = page.locator('.notification', { hasText: 'Marker genes:' });
  await expect(notification).toHaveCount(1);
  await notification.locator('[data-role="cancel"]').click();
  await expect(status.locator('.job-status-title')).toHaveText('Marker genes canceled');
  await expect(notification).toHaveCount(0);
  await expect(run).toBeEnabled();
  await expect(panel.locator('.js-plotly-plot')).toHaveCount(0);

  releaseReads(hold);
  await status.getByRole('button', { name: 'Run again' }).click();
  await expect(status).toBeHidden();
  await expect(panel.locator('.js-plotly-plot').first()).toBeVisible();

  expect(errors).toEqual([]);
});

test('Run stays where it is while the page turns level of detail on and off by itself', async ({ page }) => {
  // With level of detail on, the highlight count says how many highlighted
  // cells the level draws, a longer line; it wrapped beside CSV, .h5ad and
  // Clear (Run moved 43 px, Web contracts run 41292953076, Linux WebKit),
  // and the force-level row appeared and went (40 px here before it
  // stayed). The page opens on a fast GPU (the fixture's device), so
  // nothing is turned on until Run is watched; then the GPU takes 500 ms a
  // frame whatever is drawn (far above any frame's own script), and the
  // framing is measured afresh: too slow, the page turns level of detail on
  // (every cell is in view: culling could leave none out) and, measured no
  // faster, off again (`rendering/full-detail-frame-cost.js`).
  const errors = observeProductErrors(page);
  const hold = { gate: null, held: 0, cutOff: 0 };
  await serveDataset(page, hold);
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`, {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await page.waitForFunction(count => window._comparisonModule?.state?.pointCount === count, CELLS);
  const panel = await openWithPagesOpen(page, 'differential');
  await expect(panel.locator('.analysis-run-btn')).toBeVisible();
  // From here, where Run is and what the counts say, every frame.
  await page.evaluate(() => {
    const run = document.querySelector('#analysis-panel-differential .analysis-run-btn');
    const count = document.getElementById('highlight-count');
    const header = count.parentElement;
    const record = window.__runPlaces = { tops: new Set(), counts: new Set(), lod: new Set(), headers: new Set() };
    const tick = () => {
      record.tops.add(Math.round(run.getBoundingClientRect().top * 10) / 10);
      record.headers.add(Math.round(header.getBoundingClientRect().height * 10) / 10);
      record.counts.add(count.textContent);
      record.lod.add(document.getElementById('hp-lod-enabled').checked);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // Opened at full detail, and done with what it started (its published
  // view included): nothing turned on yet.
  await waitForPageAtRest(page);
  expect(await page.locator('#hp-lod-enabled').isChecked()).toBe(false);
  await setSimulatedGpu(page, { frameMs: 500 });
  await page.evaluate(() => window._cellucidViewer.measureFullDetailFrameCost());
  // The page's verdict on its own choice: a flat 500 ms a frame gains
  // nothing, so it is turned off again.
  await expect(page.locator('#hp-performance-status'))
    .toHaveText('Every cell drawn: level of detail measured 500 ms a frame against 500 ms without, no faster here. Measured again when the view moves.', { timeout: 60_000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const places = await page.evaluate(() => ({
    tops: [...window.__runPlaces.tops],
    counts: [...window.__runPlaces.counts],
    lod: [...window.__runPlaces.lod],
    headers: [...window.__runPlaces.headers],
  }));
  // Level of detail was on for a while, and the count said what it drew.
  expect(places.lod).toContain(true);
  expect(places.counts.some(text => / of 1,000 highlighted cells visible$/.test(text))).toBe(true);
  // The count's header kept its height (its line wraps nowhere), and Run
  // stayed put: every panel is open, the force-level row among them.
  expect(places.headers).toHaveLength(1);
  expect(places.tops).toHaveLength(1);
  expect(errors).toEqual([]);
});
