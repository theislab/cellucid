/**
 * A categorical made from a selection shows its labels, keeps them through
 * dimension switches, and gets them back exactly from a saved session.
 *
 * Positions are normalized in place as each layout loads, so no raw
 * coordinates are resident once the app is running. User-defined centroids
 * were computed only from raw coordinates: a new field had no centroids (no
 * labels), and switching the view's dimension while it was active threw "Raw
 * 2D positions are unavailable for centroid computation". This spec drives the
 * real application on a dataset with 1D, 2D and 3D layouts, and checks every
 * label against means of the normalized coordinates computed here,
 * independently of the application.
 *
 * The session is restored into a fresh page, where the field is new: the
 * restore's UI settlement used to sync the field selectors before rebuilding
 * them, so restoring a session whose active field was user-defined failed with
 * "Active categorical field is absent from its rendered selector".
 */

import { readFile } from 'node:fs/promises';
import { expect, test } from './helpers/test.mjs';

import { readBundle } from '../../assets/js/app/session/bundle/reader.js';
import { gzipDecompress } from '../../assets/js/app/session/codecs/gzip.js';
import { serveSyntheticCatalog } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const ROOT = appUrl('/tests/browser/fixtures/generated-user-defined-centroids/');
const DATASET_ID = 'user-defined-centroids';
const CELL_COUNT = 12;
const FIELD_KEY = 'regions';
// Cells 0-5 and 6-9 are selected; 10 and 11 fall into the uncovered category.
const SELECTIONS = Object.freeze([
  Object.freeze({ label: 'left', cells: Object.freeze([0, 1, 2, 3, 4, 5]) }),
  Object.freeze({ label: 'right', cells: Object.freeze([6, 7, 8, 9]) }),
]);
const UNCOVERED_LABEL = 'rest';
const CATEGORIES = Object.freeze(['left', 'right', 'rest']);

/** Raw coordinates of each layout: unround, and a different shape per layout. */
function rawLayout(dimension) {
  const values = new Float32Array(CELL_COUNT * dimension);
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    for (let axis = 0; axis < dimension; axis++) {
      values[cell * dimension + axis] =
        Math.sin(cell * 1.7 + axis * 0.9 + dimension) * (3.5 + axis * 2.25)
        + (cell % 4) * 0.37 * (axis + 1)
        + dimension * 10;
    }
  }
  return values;
}

const RAW = Object.freeze({ 1: rawLayout(1), 2: rawLayout(2), 3: rawLayout(3) });

/**
 * The viewer's normalization, written out here: centre each axis on its
 * mid-range and scale the largest range to [-1, 1], stored as Float32.
 */
function normalized(dimension) {
  const raw = RAW[dimension];
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  for (let axis = 0; axis < dimension; axis++) {
    min[axis] = Infinity;
    max[axis] = -Infinity;
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      const value = raw[cell * dimension + axis];
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  const center = min.map((low, axis) => 0.5 * (low + max[axis]));
  const range = Math.max(...max.map((high, axis) => high - min[axis])) || 1;
  const scale = 2 / range;
  return Float32Array.from(raw, (value, index) => (
    (value - center[index % dimension]) * scale
  ));
}

function categoryOf(cell) {
  const index = SELECTIONS.findIndex(({ cells }) => cells.includes(cell));
  return index === -1 ? SELECTIONS.length : index;
}

/** Expected centroid buffer (x, y, z per category) of one dimension. */
function expectedCentroids(dimension) {
  const positions = normalized(dimension);
  const sums = CATEGORIES.map(() => [0, 0, 0]);
  const counts = CATEGORIES.map(() => 0);
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    const category = categoryOf(cell);
    counts[category] += 1;
    for (let axis = 0; axis < dimension; axis++) {
      sums[category][axis] += positions[cell * dimension + axis];
    }
  }
  return sums.flatMap((sum, category) => sum.map(total => total / counts[category]));
}

function expectClose(actual, expected, label) {
  expect(actual, label).toHaveLength(expected.length);
  for (let index = 0; index < expected.length; index++) {
    expect(
      Math.abs(actual[index] - expected[index]),
      `${label}: coordinate ${index} is ${actual[index]}, expected ${expected[index]}`,
    ).toBeLessThan(1e-6);
  }
}

// The dataset has no genes on purpose: saving a session on a dataset without
// genes used to fail for want of a var inventory.
async function installFixture(page) {
  await serveSyntheticCatalog(page, ROOT, {
    id: DATASET_ID,
    name: 'User-defined centroid fixture',
    description: 'Exact synthetic browser fixture with 1D, 2D and 3D layouts',
    cells: CELL_COUNT,
    obsm: Object.fromEntries([1, 2, 3].map(dimension => [
      `X_umap_${dimension}d`,
      { data: RAW[dimension], columns: dimension },
    ])),
  });
}

function observeErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      errors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return errors;
}

async function openDataset(page) {
  await page.goto(
    `/?sampleCatalog=${encodeURIComponent(ROOT)}`
      + `&dataset=${DATASET_ID}&acceptance=user-defined-centroids-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-cells')).toHaveText(String(CELL_COUNT));
  await expect(page.locator('#view-representation-select option:checked')).toHaveText(/ · 3D$/);
}

/** What the live view draws for the active field right now. */
function readLiveCentroids(page) {
  return page.evaluate(() => {
    const state = window._cellucidState;
    const labels = [
      ...document.querySelectorAll('#label-layer .centroid-label[data-view-id="live"]'),
    ].map(element => element.textContent);
    return {
      dimension: state.getViewDimensionLevel('live'),
      count: state.centroidCount,
      positions: Array.from(state.centroidPositions ?? []),
      labels,
    };
  });
}

async function switchDimension(page, dimension) {
  // The "Shows" picker lists each dimension's representations under its group.
  const option = page
    .locator(`#view-representation-select optgroup[label="${dimension}D"] option`)
    .first();
  await page.locator('#view-representation-select').selectOption(await option.getAttribute('value'));
  await expect.poll(
    () => page.evaluate(() => window._cellucidState.getViewDimensionLevel('live')),
  ).toBe(dimension);
}

async function expectLabelsAt(page, dimension) {
  const drawn = await readLiveCentroids(page);
  expect(drawn.dimension).toBe(dimension);
  expect(drawn.count, 'a category label for every category').toBe(CATEGORIES.length);
  expect(drawn.labels).toEqual(CATEGORIES);
  expectClose(drawn.positions, expectedCentroids(dimension), `${dimension}D labels`);
  return drawn.positions;
}

/** The active field's stored centroids, per layout, as plain data. */
function readStoredCentroids(page) {
  return page.evaluate(fieldKey => {
    const state = window._cellucidState;
    const field = state.obsData.fields.find(
      candidate => candidate.key === fieldKey && candidate._isDeleted !== true
    );
    return {
      byLayout: Object.fromEntries(
        [...field.centroidsByLayout].sort(([a], [b]) => a.localeCompare(b))
      ),
      normalized: [...field._normalizedLayouts].sort(),
    };
  }, FIELD_KEY);
}

/** Save through the Session panel; a failed save fails here, with its error. */
async function saveSession(page, errors, sessionPath) {
  const errorCount = errors.length;
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const failure = new Promise(resolve => {
    const check = () => {
      if (errors.length > errorCount) resolve(null);
      else setTimeout(check, 50);
    };
    check();
  });
  const download = await Promise.race([downloadPromise, failure]);
  expect(download, `saving the session failed: ${errors.slice(errorCount).join('\n')}`)
    .not.toBe(null);
  await download.saveAs(sessionPath);
}

async function readFieldOverlays(sessionPath) {
  const bytes = await readFile(sessionPath);
  const { chunkStream } = await readBundle(
    new Blob([bytes]),
    { signal: null, onProgress: null },
  );
  for await (const chunk of chunkStream) {
    if (chunk.meta.id !== 'core/field-overlays') continue;
    const raw = await gzipDecompress(chunk.bytes, {
      maxOutputBytes: chunk.meta.uncompressedBytes,
      signal: null,
    });
    return JSON.parse(new TextDecoder().decode(raw));
  }
  throw new Error('The session has no field-overlays chunk.');
}

test('a categorical from a selection keeps exact labels across dimensions and sessions', async (
  { page },
  testInfo,
) => {
  test.setTimeout(180_000);
  const errors = observeErrors(page);
  await installFixture(page);
  await openDataset(page);

  // Two highlight pages built from selections, turned into a categorical by
  // the same DataState entry point the Category Builder's Create button calls.
  await page.evaluate(({ fieldKey, selections, uncoveredLabel }) => {
    const state = window._cellucidState;
    const pages = selections.map(({ label, cells }) => {
      const highlightPage = state.createHighlightPage(label);
      state.switchToPage(highlightPage.id);
      state.addHighlightDirect({ type: 'lasso', label, cellIndices: Uint32Array.from(cells) });
      return { pageId: highlightPage.id, label };
    });
    state.createCategoricalFromPages({
      key: fieldKey,
      pages,
      uncoveredLabel,
      overlapStrategy: 'first',
      overlapLabel: '',
      intersectionLabels: {},
    });
  }, { fieldKey: FIELD_KEY, selections: SELECTIONS, uncoveredLabel: UNCOVERED_LABEL });

  await page.locator('#categorical-field').selectOption({ label: FIELD_KEY });
  await expect(page.locator('#categorical-field option:checked')).toHaveText(FIELD_KEY);
  await page.locator('#toggle-centroid-points').check();
  await page.locator('#toggle-centroid-labels').check();

  const drawnBefore = {};
  drawnBefore[3] = await expectLabelsAt(page, 3);
  for (const dimension of [2, 1, 3]) {
    await switchDimension(page, dimension);
    drawnBefore[dimension] = await expectLabelsAt(page, dimension);
  }
  expect(errors, 'no dimension switch may raise an error').toEqual([]);

  const storedBefore = await readStoredCentroids(page);
  expect(Object.keys(storedBefore.byLayout))
    .toEqual(['X_umap_1d', 'X_umap_2d', 'X_umap_3d']);
  expect(storedBefore.normalized)
    .toEqual(['X_umap_1d', 'X_umap_2d', 'X_umap_3d']);

  const sessionPath = testInfo.outputPath('user-defined-centroids.cellucid-session');
  await saveSession(page, errors, sessionPath);

  const overlays = await readFieldOverlays(sessionPath);
  expect(overlays.userDefinedFields).toHaveLength(1);
  // A session stores the field's codes, never its centroids: the record is
  // the definition alone, and centroids are recomputed from the codes on
  // restore.
  expect(Object.keys(overlays.userDefinedFields[0]).sort()).toEqual([
    'categories',
    'codesLength',
    'codesType',
    'createdAt',
    'id',
    'intersectionLabels',
    'isDeleted',
    'isPurged',
    'key',
    'kind',
    'operation',
    'overlapLabel',
    'overlapStrategy',
    'source',
    'sourceField',
    'sourcePages',
    'uncoveredLabel',
  ]);

  // A fresh page, so nothing but the session file carries the centroids. A
  // session restores only onto the dimension it was saved in, the dataset's
  // default 3D here.
  await openDataset(page);
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(sessionPath);
  await expect.poll(async () => (
    errors.length > 0
      ? errors.join('\n')
      : page.locator('#categorical-field option:checked').textContent()
  )).toBe(FIELD_KEY);
  await expect.poll(
    () => page.evaluate(() => window._cellucidState.getViewDimensionLevel('live')),
  ).toBe(3);

  // Restoring the codes recomputes centroids for every resident layout (only
  // the restored 3D layout on this fresh page), and they equal the ones the
  // field had before saving.
  expect(await readStoredCentroids(page)).toEqual({
    byLayout: { X_umap_3d: storedBefore.byLayout.X_umap_3d },
    normalized: ['X_umap_3d'],
  });
  for (const dimension of [3, 2, 1, 3]) {
    await switchDimension(page, dimension);
    const drawn = await readLiveCentroids(page);
    expect(drawn.labels).toEqual(CATEGORIES);
    expect(
      drawn.positions,
      `${dimension}D labels land exactly where they were before saving`,
    ).toEqual(drawnBefore[dimension]);
  }
  // Each layout a view switched to computed its centroids from the restored
  // codes, landing on exactly what the field held before saving.
  expect(await readStoredCentroids(page)).toEqual(storedBefore);
  expect(errors, 'saving and restoring raise no error').toEqual([]);
});
