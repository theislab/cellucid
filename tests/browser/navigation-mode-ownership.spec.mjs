// Who owns the navigation mode: the dimension rule, or the user?
//
// The viewer selects Orbit for a 3-D embedding and Planar for 1-D and 2-D, and
// keeps re-selecting it every time the dimension changes — until the user picks
// a mode themselves, after which their choice is preserved. These specs pin
// both halves of that rule and, in particular, that a mode *published* by
// something other than the user (a dataset's advertised starting state, the
// Reset Camera button) does not silently end the coupling.
//
// The published-state spec builds its bundle with the application's own writer
// rather than a hand-assembled one, so the fixture cannot drift away from the
// format the reader accepts.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const FIXTURE_ROOT = appUrl('/tests/browser/fixtures/generated-dimensions/');
const DATASET_ID = 'deterministic-dimensions';
const DATASET_NAME = 'Deterministic dimension fixture';
const CELL_COUNT = 12;
const FIELD_KEY = 'lineage';
const CATEGORIES = Object.freeze(['Progenitor', 'Differentiated']);
const STATE_FILENAME = 'default.cellucid-session';

const identity = {
  version: 2,
  id: DATASET_ID,
  name: DATASET_NAME,
  description: 'Exact synthetic fixture for navigation-mode ownership',
  created_at: '2026-07-31T00:00:00Z',
  cellucid_data_version: '0.0.9',
  stats: {
    n_cells: CELL_COUNT,
    n_genes: 1,
    n_obs_fields: 1,
    n_categorical_fields: 1,
    n_continuous_fields: 0,
    has_connectivity: false,
    n_edges: null,
  },
  embeddings: {
    available_dimensions: [1, 2, 3],
    default_dimension: 3,
    files: {
      '1d': 'points_1d.bin',
      '2d': 'points_2d.bin',
      '3d': 'points_3d.bin',
    },
  },
  obs_fields: [{
    key: FIELD_KEY,
    kind: 'category',
    n_categories: CATEGORIES.length,
  }],
  export_settings: {
    compression: null,
    var_quantization: null,
    obs_continuous_quantization: null,
    obs_categorical_dtype: 'uint8',
  },
  source: {
    name: 'Cellucid browser CI',
  },
};

function centroidsFor(dimension) {
  return CATEGORIES.map((category, categoryIndex) => ({
    category,
    position: Array.from(
      { length: dimension },
      (unused, axis) => (categoryIndex === 0 ? -0.5 : 0.5) + axis * 0.1,
    ),
    n_points: CELL_COUNT / CATEGORIES.length,
  }));
}

const obsManifest = {
  _format: 'compact_v1',
  n_points: CELL_COUNT,
  centroid_outlier_quantile: null,
  latent_key: null,
  compression: null,
  _obsSchemas: {
    categorical: {
      codesPathPattern: 'obs/{index}.codes.{ext}',
      outlierPathPattern: null,
      outlierExt: null,
      outlierDtype: null,
      outlierQuantized: false,
    },
  },
  _continuousFields: [],
  _categoricalFields: [[
    0,
    FIELD_KEY,
    CATEGORIES,
    'uint8',
    255,
    { 1: centroidsFor(1), 2: centroidsFor(2), 3: centroidsFor(3) },
  ]],
};

// A session bundle fingerprints the var inventory as well as obs, so the
// fixture publishes one gene rather than none.
const GENE_KEY = 'Marker1';
const varManifest = {
  _format: 'compact_v1',
  n_points: CELL_COUNT,
  var_gene_id_column: 'gene_name',
  compression: null,
  quantization: 8,
  _varSchema: {
    kind: 'continuous',
    pathPattern: 'var/{index}.values.u8',
    ext: 'u8',
    dtype: 'uint8',
    quantized: true,
    quantizationBits: 8,
  },
  fields: [[0, GENE_KEY, 0, 1]],
};

const geneBytes = Buffer.from(
  Array.from({ length: CELL_COUNT }, (unused, index) => index * 20),
);

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

function positionBytes(dimension) {
  const buffer = Buffer.alloc(
    CELL_COUNT * dimension * Float32Array.BYTES_PER_ELEMENT,
  );
  for (let index = 0; index < CELL_COUNT; index++) {
    for (let axis = 0; axis < dimension; axis++) {
      buffer.writeFloatLE(
        POINTS[index][axis],
        ((index * dimension) + axis) * 4,
      );
    }
  }
  return buffer;
}

const codeBytes = Buffer.from(
  Array.from({ length: CELL_COUNT }, (unused, index) => index % 2),
);

const BUNDLE_MAGIC = 'CELLUCID_SESSION\n';

// The exact static profile a dataset may advertise as its starting state, in
// order — see PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE in
// `assets/js/app/session/session-serializer.js`. An interactive Save State
// writes these plus chunks a published default must not carry (a camera path,
// an analysis cache inventory), so the fixture keeps exactly this set.
const PUBLISHED_DEFAULT_CHUNK_IDS = Object.freeze([
  'core/field-overlays',
  'core/state',
  'ui/dockable-layout',
  'analysis/windows',
  'highlights/meta',
]);

/**
 * Turn an interactive session bundle into the narrower published-default
 * profile a dataset may advertise.
 *
 * The bytes still come from the application's own writer; only chunks outside
 * the published profile are dropped, and the container is re-framed with the
 * documented `[magic][u32 manifest length][manifest][u32 length + chunk]…`
 * layout.
 *
 * @param {Buffer} bundle
 * @returns {Buffer}
 */
function toPublishedDefault(bundle) {
  expect(bundle.subarray(0, BUNDLE_MAGIC.length).toString('utf8'))
    .toBe(BUNDLE_MAGIC);
  let offset = BUNDLE_MAGIC.length;
  const manifestLength = bundle.readUInt32LE(offset);
  offset += 4;
  const manifest = JSON.parse(
    bundle.subarray(offset, offset + manifestLength).toString('utf8'),
  );
  offset += manifestLength;

  const kept = [];
  const keptChunks = [];
  for (const entry of manifest.chunks) {
    const chunkLength = bundle.readUInt32LE(offset);
    offset += 4;
    const chunk = bundle.subarray(offset, offset + chunkLength);
    offset += chunkLength;
    if (!PUBLISHED_DEFAULT_CHUNK_IDS.includes(entry.id)) {
      continue;
    }
    kept.push(entry);
    keptChunks.push(chunk);
  }
  expect(offset).toBe(bundle.byteLength);
  expect(kept.map(entry => entry.id)).toEqual(PUBLISHED_DEFAULT_CHUNK_IDS);

  const manifestBytes = Buffer.from(
    JSON.stringify({ ...manifest, chunks: kept }),
    'utf8',
  );
  const parts = [Buffer.from(BUNDLE_MAGIC, 'utf8')];
  const manifestHeader = Buffer.alloc(4);
  manifestHeader.writeUInt32LE(manifestBytes.byteLength, 0);
  parts.push(manifestHeader, manifestBytes);
  for (const chunk of keptChunks) {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(chunk.byteLength, 0);
    parts.push(header, chunk);
  }
  return Buffer.concat(parts);
}

/**
 * Serve the fixture, optionally advertising a published starting state.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Buffer|null} publishedState Exact `.cellucid-session` bytes, or null.
 */
async function installFixture(page, publishedState = null) {
  const catalogEntry = {
    id: DATASET_ID,
    name: DATASET_NAME,
    path: `${DATASET_ID}/`,
    n_cells: CELL_COUNT,
    n_genes: 1,
  };
  const responses = new Map([
    [
      `${DATASET_ID}/dataset_identity.json`,
      { body: Buffer.from(JSON.stringify(identity)), contentType: 'application/json; charset=utf-8' },
    ],
    [
      `${DATASET_ID}/obs_manifest.json`,
      { body: Buffer.from(JSON.stringify(obsManifest)), contentType: 'application/json; charset=utf-8' },
    ],
    [
      `${DATASET_ID}/obs/0.codes.u8`,
      { body: codeBytes, contentType: 'application/octet-stream' },
    ],
    [
      `${DATASET_ID}/var_manifest.json`,
      { body: Buffer.from(JSON.stringify(varManifest)), contentType: 'application/json; charset=utf-8' },
    ],
    [
      `${DATASET_ID}/var/0.values.u8`,
      { body: geneBytes, contentType: 'application/octet-stream' },
    ],
    [
      `${DATASET_ID}/points_1d.bin`,
      { body: positionBytes(1), contentType: 'application/octet-stream' },
    ],
    [
      `${DATASET_ID}/points_2d.bin`,
      { body: positionBytes(2), contentType: 'application/octet-stream' },
    ],
    [
      `${DATASET_ID}/points_3d.bin`,
      { body: positionBytes(3), contentType: 'application/octet-stream' },
    ],
  ]);

  if (publishedState !== null) {
    catalogEntry.state_manifest = 'state-snapshots.json';
    catalogEntry.state_sha256 = createHash('sha256')
      .update(publishedState)
      .digest('hex');
    responses.set(
      `${DATASET_ID}/state-snapshots.json`,
      {
        body: Buffer.from(JSON.stringify({ states: [STATE_FILENAME] })),
        contentType: 'application/json; charset=utf-8',
      },
    );
    responses.set(
      `${DATASET_ID}/${STATE_FILENAME}`,
      { body: publishedState, contentType: 'application/octet-stream' },
    );
  }

  responses.set(
    'datasets.json',
    {
      body: Buffer.from(JSON.stringify({
        version: 1,
        default: DATASET_ID,
        datasets: [catalogEntry],
      })),
      contentType: 'application/json; charset=utf-8',
    },
  );

  const rootPath = new URL(FIXTURE_ROOT).pathname;
  await page.route(`${FIXTURE_ROOT}**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    const response = responses.get(pathname.slice(rootPath.length));
    if (response === undefined) {
      await route.fulfill({
        status: 404,
        contentType: 'text/plain; charset=utf-8',
        body: `Unexpected fixture request: ${pathname}\n`,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: response.contentType,
      body: response.body,
    });
  });
}

function fixtureUrl(acceptance) {
  return (
    `/?exportsBaseUrl=${encodeURIComponent(FIXTURE_ROOT)}` +
    `&dataset=${DATASET_ID}&acceptance=${acceptance}`
  );
}

async function openFixture(page, acceptance) {
  await page.goto(fixtureUrl(acceptance), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(DATASET_NAME);
  await expect(page.locator('#filter-count')).toHaveText(
    `Showing all ${CELL_COUNT} points`,
  );
}

test('the dimension rule keeps re-selecting a mode nobody chose', async ({
  page,
}) => {
  await installFixture(page);
  await openFixture(page, 'navigation-ownership-default');

  await expect(page.locator('#dimension-select')).toHaveValue('3');
  await expect(page.locator('#navigation-mode')).toHaveValue('orbit');

  // A restore publishing the mode the dimension already implies is not a user
  // choice, so it must not take navigation away from the dimension rule. This
  // is exactly what a dataset's advertised starting state does through
  // `app/session/contributors/core-state.js`.
  await page.evaluate(() => {
    window._cellucidViewer.setNavigationMode('orbit');
  });

  await page.selectOption('#dimension-select', '2');
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');

  await page.selectOption('#dimension-select', '1');
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');

  await page.selectOption('#dimension-select', '3');
  await expect(page.locator('#navigation-mode')).toHaveValue('orbit');
});

test('a mode the user picked survives every later dimension change', async ({
  page,
}) => {
  await installFixture(page);
  await openFixture(page, 'navigation-ownership-explicit');

  // Free-fly is never a dimension default, so choosing it always takes
  // ownership.
  await page.selectOption('#navigation-mode', 'free');
  await expect(page.locator('#navigation-mode')).toHaveValue('free');
  await page.selectOption('#dimension-select', '2');
  await expect(page.locator('#navigation-mode')).toHaveValue('free');
  await page.selectOption('#dimension-select', '1');
  await expect(page.locator('#navigation-mode')).toHaveValue('free');

  // Orbit is the 3-D default but an override at 2-D, so it takes ownership
  // there and survives the move to 1-D.
  await page.selectOption('#dimension-select', '2');
  await page.selectOption('#navigation-mode', 'orbit');
  await page.selectOption('#dimension-select', '1');
  await expect(page.locator('#navigation-mode')).toHaveValue('orbit');

  // Choosing the dimension's own default hands navigation back to the rule.
  await page.selectOption('#navigation-mode', 'planar');
  await page.selectOption('#dimension-select', '3');
  await expect(page.locator('#navigation-mode')).toHaveValue('orbit');
});

test('Reset Camera restores the mode this dimension defaults to', async ({
  page,
}) => {
  await installFixture(page);
  await openFixture(page, 'navigation-ownership-reset');

  await page.selectOption('#dimension-select', '2');
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');

  await page.selectOption('#navigation-mode', 'orbit');
  await expect(page.locator('#navigation-mode')).toHaveValue('orbit');

  // "Reset Camera" restores initial defaults. The initial default for a 2-D
  // embedding is Planar, not the Orbit the page happened to start on before any
  // dataset existed.
  await page.click('#reset-camera-btn');
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');

  // And navigation is back under the dimension rule.
  await page.selectOption('#dimension-select', '3');
  await expect(page.locator('#navigation-mode')).toHaveValue('orbit');
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
    page.click('#save-state-btn'),
  ]);
  const bundle = toPublishedDefault(await readFile(await download.path()));
  expect(bundle.byteLength).toBeGreaterThan(0);
  await page.close();

  // Phase 2 — advertise it as the dataset's starting state and open the
  // dataset the way a first-time visitor does.
  const visitor = await context.newPage();
  await installFixture(visitor, bundle);
  await visitor.goto(
    fixtureUrl('navigation-ownership-published-state'),
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(visitor);
  await expect(visitor.locator('#dataset-name')).toHaveText(DATASET_NAME);

  // The restored field colours the plot, so the statistics line must name it.
  await expect(visitor.locator('#categorical-field'))
    .toHaveValue(/^[0-9]+$/);
  await expect(visitor.locator('#stats')).toContainText(
    `Field: ${FIELD_KEY} (category)`,
  );

  // The starting state pinned Orbit because the dataset opens in 3-D, not
  // because anyone chose Orbit — so 2-D still gets Planar.
  await expect(visitor.locator('#navigation-mode')).toHaveValue('orbit');
  await visitor.selectOption('#dimension-select', '2');
  await expect(visitor.locator('#navigation-mode')).toHaveValue('planar');

  await visitor.close();
});
