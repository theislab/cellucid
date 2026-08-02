/**
 * Every self-contained data-loading path reaches a rendered dataset.
 *
 * "Rendered" here means the viewer reports the exact point count, the sidebar
 * publishes the exact cell and gene counts, and a categorical legend paints one
 * entry per category. A quiet console is not the acceptance.
 *
 * The prepared fixtures under `fixtures/demo-custom-exports/` are a byte copy of
 * the published `theislab/cellucid-demo-custom-datasets` export tree, so this
 * exercises the reference layout a user publishes for themselves: 1D, 2D and 3D
 * embeddings, connectivity, and vector fields.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { APP_ORIGIN, appUrl, sampleUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const fixturesDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);
const h5adFixturePath = path.join(fixturesDirectory, 'current-ui-smoke.h5ad');
const zarrFixturePath = path.join(
  fixturesDirectory,
  'current-ui-smoke.zarr.zip',
);
const demoExportsDirectory = path.join(
  fixturesDirectory,
  'demo-custom-exports',
);

const SAME_ORIGIN_DEMO_EXPORTS = appUrl(
  '/tests/browser/fixtures/demo-custom-exports/',
);
const CROSS_ORIGIN_DEMO_EXPORTS = sampleUrl(
  '/tests/browser/fixtures/demo-custom-exports/',
);

const DEMO_DATASETS = Object.freeze([
  Object.freeze({
    id: 'synthetic-trajectory-1d',
    name: 'Synthetic trajectory — 1D',
    cells: 48,
    genes: 6,
    dimension: '1',
    navigation: 'planar',
    categoricalField: 'stage',
    legendEntries: 4,
  }),
  Object.freeze({
    id: 'synthetic-cell-types-2d',
    name: 'Synthetic cell-type islands — 2D',
    cells: 72,
    genes: 8,
    dimension: '2',
    navigation: 'planar',
    categoricalField: 'cell_type',
    legendEntries: 3,
  }),
  Object.freeze({
    id: 'synthetic-development-3d',
    name: 'Synthetic branching development — 3D',
    cells: 96,
    genes: 10,
    dimension: '3',
    navigation: 'orbit',
    categoricalField: 'lineage',
    legendEntries: 2,
  }),
]);

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  return errors;
}

async function expectRenderedDataset(page, dataset) {
  await expect(page.locator('#dataset-name')).toHaveText(dataset.name);
  await expect(page.locator('#dataset-cells')).toHaveText(String(dataset.cells));
  await expect(page.locator('#dataset-genes')).toHaveText(String(dataset.genes));
  await expect(page.locator('#filter-count')).toHaveText(
    `Showing all ${dataset.cells} points`,
  );
  await expect(page.locator('#dimension-select')).toHaveValue(
    dataset.dimension,
  );
  await expect(page.locator('#navigation-mode')).toHaveValue(
    dataset.navigation,
  );
  await expect
    .poll(() => page.evaluate(
      () => window._cellucidViewer.getPointCount(),
    ))
    .toBe(dataset.cells);
  await page
    .locator('#categorical-field')
    .selectOption({ label: dataset.categoricalField });
  await expect(page.locator('.legend-item')).toHaveCount(dataset.legendEntries);
}

for (const dataset of DEMO_DATASETS) {
  test(
    `a published prepared export renders through the sample catalog: ${dataset.id}`,
    async ({ page }) => {
      const errors = observeProductErrors(page);
      const url = new URL('/', APP_ORIGIN);
      url.searchParams.set('exportsBaseUrl', SAME_ORIGIN_DEMO_EXPORTS);
      url.searchParams.set('dataset', dataset.id);
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
      await dismissWelcome(page);

      await expectRenderedDataset(page, dataset);
      expect(errors).toEqual([]);
    },
  );
}

test('a cross-origin prepared export catalog renders the same dataset', async ({
  page,
}) => {
  const errors = observeProductErrors(page);
  const dataset = DEMO_DATASETS[1];
  const url = new URL('/', APP_ORIGIN);
  url.searchParams.set('exportsBaseUrl', CROSS_ORIGIN_DEMO_EXPORTS);
  url.searchParams.set('dataset', dataset.id);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);

  await expectRenderedDataset(page, dataset);
  expect(errors).toEqual([]);
});

test('the sample-dataset selector switches between prepared exports', async ({
  page,
}) => {
  const errors = observeProductErrors(page);
  const first = DEMO_DATASETS[1];
  const second = DEMO_DATASETS[2];
  const url = new URL('/', APP_ORIGIN);
  url.searchParams.set('exportsBaseUrl', SAME_ORIGIN_DEMO_EXPORTS);
  url.searchParams.set('dataset', first.id);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expectRenderedDataset(page, first);

  for (const candidate of DEMO_DATASETS) {
    await expect(
      page.locator(
        `#dataset-select option[value="dataset:local-demo:${candidate.id}"]`,
      ),
    ).toHaveCount(1);
  }
  await page
    .locator('#dataset-select')
    .selectOption(`dataset:local-demo:${second.id}`);
  await expectRenderedDataset(page, second);
  expect(errors).toEqual([]);
});

/**
 * The sample-catalog dropdown probes every registered source, and `local-demo`
 * is always registered. Without an explicit base URL that probe leaves the
 * machine for the published production catalog, so every test that is not
 * itself about the catalog pins it at the local fixture tree.
 */
function localCatalogUrl() {
  const url = new URL('/', APP_ORIGIN);
  url.searchParams.set('exportsBaseUrl', SAME_ORIGIN_DEMO_EXPORTS);
  return url.toString();
}

test('a prepared directory chosen in the browser renders without a server', async ({
  page,
}) => {
  const errors = observeProductErrors(page);
  const dataset = DEMO_DATASETS[2];
  await page.goto(localCatalogUrl(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expectRenderedDataset(page, DEMO_DATASETS[1]);

  await page
    .locator('#user-data-file-input')
    .setInputFiles(path.join(demoExportsDirectory, dataset.id));

  await expectRenderedDataset(page, dataset);
  expect(errors).toEqual([]);
});

test('a direct .h5ad file chosen in the browser renders', async ({ page }) => {
  const errors = observeProductErrors(page);
  await page.goto(localCatalogUrl(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expectRenderedDataset(page, DEMO_DATASETS[1]);

  await page.locator('#user-data-h5ad-input').setInputFiles(h5adFixturePath);

  await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  await expect(page.locator('#dataset-genes')).toHaveText('6');
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing all 120 points',
  );
  await expect
    .poll(() => page.evaluate(
      () => window._cellucidViewer.getPointCount(),
    ))
    .toBe(120);
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('a portable Zarr ZIP archive chosen in the browser renders', async ({
  page,
}) => {
  const errors = observeProductErrors(page);
  await page.goto(localCatalogUrl(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expectRenderedDataset(page, DEMO_DATASETS[1]);

  await page
    .locator('#user-data-zarr-archive-input')
    .setInputFiles(zarrFixturePath);

  await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  await expect(page.locator('#dataset-genes')).toHaveText('6');
  await expect
    .poll(() => page.evaluate(
      () => window._cellucidViewer.getPointCount(),
    ))
    .toBe(120);
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  expect(errors).toEqual([]);
});
