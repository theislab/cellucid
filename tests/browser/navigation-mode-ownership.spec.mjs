// Who owns the navigation mode: the dimension rule, or the user?
//
// The viewer selects Orbit for a 3-D embedding and Planar for 1-D and 2-D, and
// keeps re-selecting it every time a view's dimension changes — until the user
// picks another mode for that view in that dimension, which the view keeps
// whenever it shows that dimension again. These specs pin
// both halves of that rule and, in particular, that a mode *published* by
// something other than the user (a dataset's advertised starting state, the
// Reset Camera button) does not silently end the coupling.
//
// The published-state spec builds its starting view with the application's
// own writer and publish step (`helpers/session-files.mjs`) rather than a
// hand-assembled file, so the fixture cannot drift away from the format the
// reader accepts.

import { startingViewBytes } from './helpers/session-files.mjs';
import { readFile } from 'node:fs/promises';

import {
  closePageWithApplicationRetirement,
  expect,
  test,
} from './helpers/test.mjs';

import { serveSyntheticCatalog } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { clickSaveSession } from './helpers/session-buttons.mjs';

const FIXTURE_ROOT = appUrl('/tests/browser/fixtures/generated-dimensions/');
const DATASET_ID = 'deterministic-dimensions';
const DATASET_NAME = 'Deterministic dimension fixture';
const CELL_COUNT = 12;
const FIELD_KEY = 'lineage';
const CATEGORIES = Object.freeze(['Progenitor', 'Differentiated']);
const GENE_KEY = 'Marker1';

const POINTS = Object.freeze([
  [0, 0, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
  [0.7, 0.7, 0.7],
  [-0.7, -0.7, -0.7],
  [0.7, -0.7, 0.7],
  [-0.7, 0.7, -0.7],
  [0.7, 0.7, -0.7],
]);

function positions(dimension) {
  return Float32Array.from(
    { length: CELL_COUNT * dimension },
    (unused, index) => POINTS[Math.floor(index / dimension)][index % dimension],
  );
}

/**
 * Serve the fixture, optionally advertising a published starting state. A
 * session bundle fingerprints the var inventory as well as obs, so the
 * fixture has one gene rather than none.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Buffer|null} publishedState Exact `.cellucid-session` bytes, or null.
 */
async function installFixture(page, publishedState = null) {
  await serveSyntheticCatalog(page, FIXTURE_ROOT, {
    id: DATASET_ID,
    name: DATASET_NAME,
    description: 'Exact synthetic fixture for navigation-mode ownership',
    session: publishedState,
    cells: CELL_COUNT,
    genes: [GENE_KEY],
    X: Float32Array.from({ length: CELL_COUNT }, (unused, index) => index * 20),
    obs: {
      [FIELD_KEY]: {
        categories: [...CATEGORIES],
        codes: Int8Array.from({ length: CELL_COUNT }, (unused, index) => index % 2),
      },
    },
    obsm: Object.fromEntries([1, 2, 3].map(dimension => [
      `X_umap_${dimension}d`,
      { data: positions(dimension), columns: dimension },
    ])),
  });
}

function fixtureUrl(acceptance) {
  return (
    `/?sampleCatalog=${encodeURIComponent(FIXTURE_ROOT)}` +
    `&dataset=${DATASET_ID}&acceptance=${acceptance}`
  );
}

async function openFixture(page, acceptance) {
  await page.goto(fixtureUrl(acceptance), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(DATASET_NAME);
  await expect(page.locator('#filter-count')).toHaveText(
    `Showing all ${CELL_COUNT} cells`,
  );
}

/**
 * Show the representation of one dimension (this fixture has one per
 * dimension) in the selected view, through the "Shows" picker.
 */
async function showDimension(page, dimension) {
  const option = page
    .locator(`#view-representation-select optgroup[label="${dimension}D"] option`)
    .first();
  await page.selectOption('#view-representation-select', await option.getAttribute('value'));
  await expect.poll(
    () => page.evaluate(() => window._cellucidState.getDimensionLevel())
  ).toBe(dimension);
}

test('the dimension rule keeps re-selecting a mode nobody chose; Reset Camera gives it back; a mode the user picked is remembered for its dimension', async ({
  page,
}) => {
  await installFixture(page);
  await openFixture(page, 'navigation-ownership-default');

  await test.step('the dimension rule keeps re-selecting a mode nobody chose', async () => {
    await expect(page.locator('#view-representation-select option:checked'))
      .toHaveText(/ · 3D$/);
    await expect(page.locator('#navigation-mode')).toHaveValue('orbit');

    // A restore publishing the mode the dimension already implies is not a user
    // choice, so it must not take navigation away from the dimension rule. This
    // is exactly what a dataset's starting view does through the `camera` state
    // domain (`app/state/domains/camera.js`).
    await page.evaluate(() => {
      window._cellucidViewer.setNavigationMode('orbit');
    });

    await showDimension(page, 2);
    await expect(page.locator('#navigation-mode')).toHaveValue('planar');

    await showDimension(page, 1);
    await expect(page.locator('#navigation-mode')).toHaveValue('planar');

    await showDimension(page, 3);
    await expect(page.locator('#navigation-mode')).toHaveValue('orbit');
  });

  await test.step('Reset Camera restores the mode this dimension defaults to', async () => {
    await showDimension(page, 2);
    await expect(page.locator('#navigation-mode')).toHaveValue('planar');

    await page.selectOption('#navigation-mode', 'orbit');
    await expect(page.locator('#navigation-mode')).toHaveValue('orbit');

    // "Reset Camera" restores initial defaults. The initial default for a 2-D
    // embedding is Planar, not the Orbit the page happened to start on before any
    // dataset existed.
    await page.click('#reset-camera-btn');
    await expect(page.locator('#navigation-mode')).toHaveValue('planar');

    // And navigation is back under the dimension rule.
    await showDimension(page, 3);
    await expect(page.locator('#navigation-mode')).toHaveValue('orbit');
    await showDimension(page, 2);
    await expect(page.locator('#navigation-mode')).toHaveValue('planar');
  });

  await test.step('a mode the user picked is remembered for the dimension it was picked in', async () => {
    // The step above ends in 2D under the rule: this one starts in 3D.
    await showDimension(page, 3);
    await expect(page.locator('#navigation-mode')).toHaveValue('orbit');

    // Free-fly is never a dimension default, so choosing it in 3D is a choice
    // for 3D: a 2D or 1D representation pans, and 3D flies again.
    await page.selectOption('#navigation-mode', 'free');
    await expect(page.locator('#navigation-mode')).toHaveValue('free');
    await showDimension(page, 2);
    await expect(page.locator('#navigation-mode')).toHaveValue('planar');
    await showDimension(page, 1);
    await expect(page.locator('#navigation-mode')).toHaveValue('planar');
    await showDimension(page, 3);
    await expect(page.locator('#navigation-mode')).toHaveValue('free');

    // Orbit is the 3-D default: choosing it hands 3D back to the rule. In 2D it
    // is a choice for 2D, which 1D does not inherit and 2D keeps.
    await page.selectOption('#navigation-mode', 'orbit');
    await showDimension(page, 2);
    await expect(page.locator('#navigation-mode')).toHaveValue('planar');
    await page.selectOption('#navigation-mode', 'orbit');
    await showDimension(page, 1);
    await expect(page.locator('#navigation-mode')).toHaveValue('planar');
    await showDimension(page, 2);
    await expect(page.locator('#navigation-mode')).toHaveValue('orbit');

    // Choosing the dimension's own default hands navigation back to the rule.
    await page.selectOption('#navigation-mode', 'planar');
    await showDimension(page, 3);
    await expect(page.locator('#navigation-mode')).toHaveValue('orbit');
    await showDimension(page, 2);
    await expect(page.locator('#navigation-mode')).toHaveValue('planar');
  });
});

test('a published starting state reports its field and leaves the dimension rule alone', async ({
  context,
  page,
}) => {
  // Phase 1 — produce a real bundle with the application's own writer.
  await installFixture(page);
  await openFixture(page, 'navigation-ownership-authoring');
  await page.selectOption('#categorical-field', { label: FIELD_KEY });
  await expect(page.locator('#stats')).toContainText(
    `Field: ${FIELD_KEY} (category)`,
  );

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    clickSaveSession(page),
  ]);
  const bundle = await startingViewBytes(await readFile(await download.path()));
  expect(bundle.byteLength).toBeGreaterThan(0);
  await closePageWithApplicationRetirement(page);

  // Phase 2 — advertise it as the dataset's starting state and open the
  // dataset the way a first-time visitor does.
  const visitor = await context.newPage();
  await installFixture(visitor, bundle);
  await visitor.goto(
    fixtureUrl('navigation-ownership-published-state'),
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(visitor);
  await openCollapsedPanels(visitor);
  await expect(visitor.locator('#dataset-name')).toHaveText(DATASET_NAME);

  // The restored field colors the plot, so the statistics line must name it.
  await expect(visitor.locator('#categorical-field'))
    .toHaveValue(/^[0-9]+$/);
  await expect(visitor.locator('#stats')).toContainText(
    `Field: ${FIELD_KEY} (category)`,
  );

  // The starting state pinned Orbit because the dataset opens in 3-D, not
  // because anyone chose Orbit — so 2-D still gets Planar.
  await expect(visitor.locator('#navigation-mode')).toHaveValue('orbit');
  await showDimension(visitor, 2);
  await expect(visitor.locator('#navigation-mode')).toHaveValue('planar');

  await closePageWithApplicationRetirement(visitor);
});
