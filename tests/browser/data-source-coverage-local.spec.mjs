/**
 * Every self-contained data-loading path reaches a rendered dataset.
 *
 * "Rendered" here means the viewer reports the exact point count, the sidebar
 * publishes the exact cell and gene counts, and a categorical legend paints one
 * entry per category. A quiet console is not the acceptance.
 *
 * The catalog under `fixtures/demo-catalog/` holds the synthetic datasets of
 * `theislab/cellucid-demo-custom-datasets` as zipped Zarr stores -- the
 * layouts a user publishes for themselves: 1D, 2D and 3D embeddings,
 * connectivity, and vector arrays -- and `fixtures/forms-catalog/` the 1D one
 * in every form a catalog lists (`.h5ad`, `.zarr.zip`, Zarr store folder)
 * (`scripts/generate-browser-catalog-fixtures.py`).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { openZarrFolder } from './helpers/dataset-drop.mjs';
import { APP_ORIGIN, appUrl, sampleUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const fixturesDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);
const h5adFixturePath = path.join(fixturesDirectory, 'current-ui-smoke.h5ad');
const zarrFixturePath = path.join(
  fixturesDirectory,
  'current-ui-smoke.zarr.zip',
);
const zarrFolderPath = path.join(
  fixturesDirectory,
  'forms-catalog',
  'forms-zarr.zarr',
);
const FORMS_CATALOG = appUrl('/tests/browser/fixtures/forms-catalog/');

const SAME_ORIGIN_DEMO_CATALOG = appUrl(
  '/tests/browser/fixtures/demo-catalog/',
);
const CROSS_ORIGIN_DEMO_CATALOG = sampleUrl(
  '/tests/browser/fixtures/demo-catalog/',
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
    `Showing all ${dataset.cells} cells`,
  );
  // The representation the view opens on is of the dataset's default dimension.
  await expect(page.locator('#view-representation-select option:checked')).toHaveText(
    new RegExp(` · ${dataset.dimension}D$`),
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
    `a published dataset renders through the sample catalog: ${dataset.id}`,
    async ({ page }) => {
      const errors = observeProductErrors(page);
      const url = new URL('/', APP_ORIGIN);
      url.searchParams.set('sampleCatalog', SAME_ORIGIN_DEMO_CATALOG);
      url.searchParams.set('dataset', dataset.id);
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
      await dismissWelcome(page);
      await openCollapsedPanels(page);

      await expectRenderedDataset(page, dataset);
      expect(errors).toEqual([]);
    },
  );
}

test('a cross-origin dataset catalog renders the same dataset', async ({
  page,
}) => {
  const errors = observeProductErrors(page);
  const dataset = DEMO_DATASETS[1];
  const url = new URL('/', APP_ORIGIN);
  url.searchParams.set('sampleCatalog', CROSS_ORIGIN_DEMO_CATALOG);
  url.searchParams.set('dataset', dataset.id);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);

  await expectRenderedDataset(page, dataset);
  expect(errors).toEqual([]);
});

test('the sample-dataset selector switches between datasets', async ({
  page,
}) => {
  const errors = observeProductErrors(page);
  const first = DEMO_DATASETS[1];
  const second = DEMO_DATASETS[2];
  const url = new URL('/', APP_ORIGIN);
  url.searchParams.set('sampleCatalog', SAME_ORIGIN_DEMO_CATALOG);
  url.searchParams.set('dataset', first.id);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
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
  url.searchParams.set('sampleCatalog', SAME_ORIGIN_DEMO_CATALOG);
  return url.toString();
}

for (const form of ['forms-h5ad', 'forms-zarr-zip', 'forms-zarr']) {
  test(`a catalog dataset renders whatever form it is listed in: ${form}`, async ({
    page,
  }) => {
    const errors = observeProductErrors(page);
    const url = new URL('/', APP_ORIGIN);
    url.searchParams.set('sampleCatalog', FORMS_CATALOG);
    url.searchParams.set('dataset', form);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await openCollapsedPanels(page);
    // The trajectory dataset under each form's own id and name.
    await expectRenderedDataset(page, {
      ...DEMO_DATASETS[0],
      name: {
        'forms-h5ad': 'Forms — .h5ad',
        'forms-zarr-zip': 'Forms — Zarr ZIP',
        'forms-zarr': 'Forms — Zarr folder',
      }[form],
    });
    expect(errors).toEqual([]);
  });
}

test('a Zarr store folder chosen in the browser renders without a server', async ({
  page,
  browserName,
}) => {
  const errors = observeProductErrors(page);
  await page.goto(localCatalogUrl(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expectRenderedDataset(page, DEMO_DATASETS[1]);

  // The folder picker hands over the store's hidden metadata files
  // (`.zgroup`, `.zattrs`, `.zmetadata`) with the rest.
  // WebKit's folder dialog leaves out a v2 store's hidden metadata, so there
  // the folder is dropped on the page, as a Safari user does.
  await openZarrFolder(page, browserName, zarrFolderPath);

  await expectRenderedDataset(page, { ...DEMO_DATASETS[0], name: 'Forms — Zarr folder' });
  await expect(page.locator('#dataset-select')).toHaveValue(
    '__dataset_unlisted__',
  );
  expect(errors).toEqual([]);
});

test('a direct .h5ad file chosen in the browser renders', async ({ page }) => {
  const errors = observeProductErrors(page);
  await page.goto(localCatalogUrl(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expectRenderedDataset(page, DEMO_DATASETS[1]);

  await page.locator('#user-data-file-input').setInputFiles(h5adFixturePath);

  await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  await expect(page.locator('#dataset-genes')).toHaveText('6');
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing all 120 cells',
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
  await openCollapsedPanels(page);
  await expectRenderedDataset(page, DEMO_DATASETS[1]);

  await page
    .locator('#user-data-file-input')
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
