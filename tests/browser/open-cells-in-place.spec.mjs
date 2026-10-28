/**
 * The open cells grown or cut in place, in the app (`app/open-cells-resize.js`).
 *
 * - Apply with a larger or smaller share of the same method and seed shows
 *   the cells in place: no new dataset is published, the camera, the field
 *   shown, its filter and the highlights stay, the cells open before keep
 *   their positions bit for bit, and the colours and visibility are, byte for
 *   byte, what opening at that share directly shows after the same actions.
 *   A category highlight takes the cells added in its category, as opening
 *   them would; a lasso keeps its cells.
 * - A text column (its categories found by its first load) shown through a
 *   chain of resizes stays shown, read under the categories it was found
 *   with, and lands where opening directly lands.
 * - A progressive opening (here made so by a measured cost of showing a cell,
 *   `data/opening-cost.js`) shows a first view of fewer cells, grows in place
 *   step by step, and lands where opening at the share directly lands; Apply
 *   while it grows opens exactly Apply's cells.
 * - An opening records what showing a cell costs here (its cells from their
 *   GPU stores to their first frame); Apply in place records nothing.
 *
 * Fixture: a synthetic `.zarr.zip` of 2,400 cells with a categorical field
 * and a text column.
 */

import { closeContextWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { anndataZarrZip, fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const CELLS = 2400;
const GENES = 40;
const URL_OF_FILE = `${SAMPLE_ORIGIN}/open-cells-in-place/cells.zarr.zip`;

function dataset() {
  const perCell = 8;
  const data = new Float32Array(CELLS * perCell);
  const indices = new Int32Array(CELLS * perCell);
  const indptr = new Int32Array(CELLS + 1);
  for (let cell = 0; cell < CELLS; cell++) {
    const genes = Array.from({ length: perCell }, (_, j) => (cell * 7 + j * 3) % GENES).filter((gene, j, all) => all.indexOf(gene) === j).sort((a, b) => a - b);
    genes.forEach((gene, j) => {
      indices[indptr[cell] + j] = gene;
      data[indptr[cell] + j] = 1 + ((cell + gene) % 9);
    });
    indptr[cell + 1] = indptr[cell] + genes.length;
  }
  const end = indptr[CELLS];
  return anndataZarrZip({
    cells: CELLS,
    genes: Array.from({ length: GENES }, (_, g) => `g${g}`),
    X: { data: data.slice(0, end), indices: indices.slice(0, end), indptr },
    obs: {
      cluster: { categories: ['alpha', 'beta', 'gamma', 'delta'], codes: Int8Array.from({ length: CELLS }, (_, i) => (i * 13) % 4) },
      note: Array.from({ length: CELLS }, (_, i) => ['low', 'mid', 'high'][(i * 7) % 3]),
    },
    obsm: { X_umap: { data: Float32Array.from({ length: CELLS * 2 }, (_, i) => Math.sin(i * 0.37) * 10 + (i % 2) * 3), columns: 2 } },
  });
}

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function open(page, query) {
  const bytes = dataset();
  await page.route(URL_OF_FILE, route => fulfillFile(route, bytes));
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(URL_OF_FILE)}${query}`, { waitUntil: 'domcontentloaded' });
}

/** Colour by `field`, hide its first category, and make a lasso and a category highlight group. */
async function act(page, field = 'cluster') {
  await page.evaluate(async key => {
    const state = window._cellucidState;
    const index = state.obsData.fields.findIndex(item => item.key === key);
    await state.ensureFieldLoaded(index);
    state.setActiveField(index);
    state.setVisibilityForCategory(state.obsData.fields[index], 0, false);
    state.ensureHighlightPage();
    // The same cells at any size: those of them that are open.
    state.addHighlightDirect({ type: 'lasso', label: 'picked', cellIndices: Uint32Array.from([1, 4, 9, 300].filter(cell => cell < state.pointCount)) });
    // A category clicked: every visible cell of it.
    state.addHighlightFromCategory(index, 2, 'obs');
  }, field);
}

async function settle(page) {
  await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    for (let i = 0; i < 600 && !viewer.getFrameScheduleState().settled; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  });
}

async function shown(page) {
  return page.evaluate(() => {
    const state = window._cellucidState;
    const viewer = window._cellucidViewer;
    const active = state.obsData.fields[state.activeFieldIndex] ?? null;
    return {
      n: state.pointCount,
      field: active?.key ?? null,
      hidden: active === null ? null : JSON.stringify(active._categoryVisible ?? null),
      groups: state.getHighlightPages().flatMap(page => page.highlightedGroups.map(group => `${group.type} ${group.label}:${Array.from(group.cellIndices).join(',')}`)),
      camera: viewer.getCameraState(),
      positions: Array.from(state.positionsArray),
      colors: Array.from(state.colorsArray),
      transparency: Array.from(state.categoryTransparency),
      digest: state.cellIdentity.digest,
    };
  });
}

/** Count the dataset publications (a new reading starts a new scene) from now on. */
async function countScenes(page) {
  await page.evaluate(() => {
    const state = window._cellucidState;
    window.__scenes = 0;
    const initScene = state.initScene.bind(state);
    state.initScene = (...args) => {
      window.__scenes++;
      return initScene(...args);
    };
  });
}

async function apply(page, cells) {
  await page.locator('#subsample-percent').fill(String((100 * cells) / CELLS));
  await page.locator('#subsample-method').selectOption('uniform');
  await page.locator('#subsample-seed').fill('3');
  await page.locator('#subsample-apply').click();
  await expect.poll(() => page.evaluate(() => window._cellucidState.pointCount), { timeout: 60_000 }).toBe(cells);
  await settle(page);
}

async function directly(browser, cells, field = 'cluster') {
  const context = await browser.newContext();
  const page = await context.newPage();
  await open(page, `&cells=${cells}&sample=uniform&seed=3`);
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 60_000 }).toBe(cells);
  await act(page, field);
  await settle(page);
  const state = await shown(page);
  await closeContextWithApplicationRetirement(context);
  return state;
}

test('Apply of a larger or smaller share of the same method and seed shows the cells in place', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = collectBrowserErrors(page);
  await open(page, '&cells=600&sample=uniform&seed=3');
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 60_000 }).toBe(600);
  await act(page);
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const camera = structuredClone(viewer.getCameraState());
    camera.orbit.theta += 0.5;
    camera.orbit.radius *= 1.3;
    viewer.setCameraState(camera);
  });
  await settle(page);
  const before = await shown(page);
  await openCollapsedPanels(page);
  await countScenes(page);

  // Raised: in place.
  await apply(page, 1500);
  const raised = await shown(page);
  expect(await page.evaluate(() => window.__scenes)).toBe(0);
  expect(raised.camera).toEqual(before.camera);
  expect(raised.field).toBe('cluster');
  expect(raised.hidden).toEqual(before.hidden);
  expect(raised.positions.slice(0, 2 * 600)).toEqual(before.positions);
  const openedAt1500 = await directly(browser, 1500);
  // The lasso keeps its cells; the category group takes the added cells in it.
  expect(raised.groups[0]).toBe(before.groups[0]);
  expect(raised.groups).toEqual(openedAt1500.groups);
  expect(raised.digest).toBe(openedAt1500.digest);
  expect(raised.colors).toEqual(openedAt1500.colors);
  expect(raised.transparency).toEqual(openedAt1500.transparency);

  // Lowered: in place, the group's cell past the end leaves it.
  await apply(page, 250);
  const lowered = await shown(page);
  expect(await page.evaluate(() => window.__scenes)).toBe(0);
  expect(lowered.camera).toEqual(before.camera);
  expect(lowered.groups[0]).toBe('lasso picked:1,4,9');
  expect(lowered.positions).toEqual(before.positions.slice(0, 2 * 250));
  const openedAt250 = await directly(browser, 250);
  expect(lowered.digest).toBe(openedAt250.digest);
  expect(lowered.groups).toEqual(openedAt250.groups);
  expect(lowered.colors).toEqual(openedAt250.colors);
  expect(lowered.transparency).toEqual(openedAt250.transparency);

  // Another seed: a new reading (not the cells open and more).
  await page.locator('#subsample-percent').fill(String((100 * 500) / CELLS));
  await page.locator('#subsample-seed').fill('4');
  await page.locator('#subsample-apply').click();
  await expect.poll(() => page.evaluate(() => window._cellucidState.pointCount), { timeout: 60_000 }).toBe(500);
  expect(await page.evaluate(() => window.__scenes)).toBe(1);

  await closeContextWithApplicationRetirement(context);
  expect(errors).toEqual([]);
});

test('a text column shown through a chain of resizes is read under the categories it was found with', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = collectBrowserErrors(page);
  await open(page, '&cells=300&sample=uniform&seed=3');
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 60_000 }).toBe(300);
  await act(page, 'note');
  await openCollapsedPanels(page);
  await countScenes(page);
  for (const cells of [600, 1200, 900, 1800]) await apply(page, cells);
  const chained = await shown(page);
  expect(await page.evaluate(() => window.__scenes)).toBe(0);
  expect(chained.field).toBe('note');
  await closeContextWithApplicationRetirement(context);
  const opened = await directly(browser, 1800, 'note');
  expect(chained.digest).toBe(opened.digest);
  expect(chained.colors).toEqual(opened.colors);
  expect(chained.transparency).toEqual(opened.transparency);
  // The lasso keeps the cells it was drawn on (300 was not open then); the
  // category group is every visible cell of its category, as opening shows.
  expect(chained.groups[0]).toBe('lasso picked:1,4,9');
  expect(chained.groups[1]).toBe(opened.groups[1]);
  expect(errors).toEqual([]);
});

test('a progressive opening shows a first view of fewer cells and grows in place to the share asked for', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  // Showing a cell measured at 2 ms on this device before: 2,000 cells
  // would take 4 s, so the first view is the cells that take a second.
  await context.addInitScript(() => {
    try {
      localStorage.setItem('cellucid:opening-cost:v2', JSON.stringify({ w: 1, x: 1, y: 2, xx: 1, xy: 2 }));
    } catch {
      // Storage blocked: the test fails below on the first view's size.
    }
  });
  const page = await context.newPage();
  const errors = collectBrowserErrors(page);
  await page.addInitScript(() => {
    window.__counts = [];
    const watch = () => {
      const state = window._cellucidState;
      if (state?.pointCount > 0 && window.__counts.at(-1) !== state.pointCount) window.__counts.push(state.pointCount);
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  await open(page, '&cells=2000&sample=uniform&seed=3');
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 120_000 }).toBe(2000);
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 5_000 }).toBe(2000);
  const counts = await page.evaluate(() => window.__counts);
  // A first view of the cells shown within a second (at most 1,000 ms /
  // 2 ms; the measured link costs a little more), then growing steps to the
  // cells asked for.
  expect(counts[0]).toBeLessThanOrEqual(500);
  expect(counts[0]).toBeGreaterThanOrEqual(Math.ceil(Math.sqrt(2000)));
  // Each step at least doubles the cells (and the time spent), the last is every cell asked for.
  expect(counts.at(-1)).toBe(2000);
  for (let i = 1; i < counts.length - 1; i++) expect(counts[i]).toBeGreaterThanOrEqual(2 * counts[i - 1]);
  await openCollapsedPanels(page);
  await expect(page.locator('#subsample-count')).toHaveText('2,000 of 2,400 cells');
  await act(page);
  await settle(page);
  const grown = await shown(page);
  await closeContextWithApplicationRetirement(context);

  const opened = await directly(browser, 2000);
  expect(grown.digest).toBe(opened.digest);
  expect(grown.colors).toEqual(opened.colors);
  expect(grown.transparency).toEqual(opened.transparency);
  expect(errors).toEqual([]);
});

test('Apply while a progressive opening grows opens exactly Apply\'s cells', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  await context.addInitScript(() => {
    try {
      localStorage.setItem('cellucid:opening-cost:v2', JSON.stringify({ w: 1, x: 1, y: 2, xx: 1, xy: 2 }));
    } catch {
      // Storage blocked: the opening is not progressive and Apply still lands.
    }
  });
  const page = await context.newPage();
  const errors = collectBrowserErrors(page);
  await open(page, '&cells=2000&sample=uniform&seed=3');
  // The first view, while it grows.
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 120_000 }).toBeGreaterThan(0);
  await openCollapsedPanels(page);
  await page.locator('#subsample-percent').fill(String((100 * 777) / CELLS));
  await page.locator('#subsample-method').selectOption('uniform');
  await page.locator('#subsample-seed').fill('3');
  await page.locator('#subsample-apply').click();
  await expect.poll(() => page.evaluate(() => window._cellucidState.pointCount), { timeout: 60_000 }).toBe(777);
  // Nothing after it opens other cells.
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window._cellucidState.pointCount)).toBe(777);
  await act(page);
  await settle(page);
  const applied = await shown(page);
  await closeContextWithApplicationRetirement(context);
  const opened = await directly(browser, 777);
  expect(applied.digest).toBe(opened.digest);
  expect(applied.colors).toEqual(opened.colors);
  expect(errors).toEqual([]);
});

test('an opening records what showing a cell costs here; Apply in place records nothing', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = collectBrowserErrors(page);
  const recorded = () => page.evaluate(() => JSON.parse(localStorage.getItem('cellucid:opening-cost:v2') ?? 'null'));
  await open(page, '&cells=600&sample=uniform&seed=3');
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 60_000 }).toBe(600);
  // The opening's cells, from their GPU stores to their first frame
  // (`data/opening-cost.js`): one record, of the 600 cells.
  await expect.poll(recorded, { timeout: 30_000 }).not.toBeNull();
  const opened = await recorded();
  expect(opened.w).toBe(1);
  expect(opened.x).toBe(600);
  expect(opened.y).toBeGreaterThan(0);
  // Grown and cut in place: not an opening of their cells.
  await openCollapsedPanels(page);
  await countScenes(page);
  await apply(page, 1500);
  await apply(page, 250);
  expect(await page.evaluate(() => window.__scenes)).toBe(0);
  expect(await recorded()).toEqual(opened);
  await closeContextWithApplicationRetirement(context);
  expect(errors).toEqual([]);
});

for (const [method, query] of [['uniform', '&cells=2000&sample=uniform&seed=3'], ['blocks', '&cells=2000&sample=blocks&seed=3&block=100']]) test(`a progressive opening (${method}) reads each embedding row once: a finished growth reads none again, for every embedding shown`, async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  await context.addInitScript(() => {
    try {
      localStorage.setItem('cellucid:opening-cost:v2', JSON.stringify({ w: 1, x: 1, y: 2, xx: 1, xy: 2 }));
    } catch {
      // Storage blocked: the test fails below on the first view's size.
    }
  });
  const page = await context.newPage();
  const errors = collectBrowserErrors(page);
  // Every embedding read the page asks the reader worker for, with the
  // cells shown when it was asked.
  await page.addInitScript(() => {
    window.__embeddingReads = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function postMessage(message, ...rest) {
      const method = message?.method;
      if (method === 'readEmbedding' || method === 'readVectorField' || method === 'readObsmColumns') {
        const args = message.args ?? [];
        const rows = method === 'readEmbedding' ? args[3] : method === 'readVectorField' ? args[4] : null;
        window.__embeddingReads.push({ method, key: args[0], columns: JSON.stringify(args[1]), rows: rows ?? null, shown: window._cellucidState?.pointCount ?? 0 });
      }
      return Reflect.apply(post, this, [message, ...rest]);
    };
    // And every read of an embedding the reader worker makes, whatever asked.
    window.__embeddingActivities = [];
    const Native = Worker;
    window.Worker = class extends Native {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => {
          const data = event.data;
          if (data?.event === 'activity' && data.kind === 'embedding' && data.status !== 'running') {
            window.__embeddingActivities.push({ label: data.label, status: data.status, shown: window._cellucidState?.pointCount ?? 0 });
          }
        });
      }
    };
  });
  await open(page, query);
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 120_000 }).toBe(2000);
  await settle(page);
  // Quiet afterwards: whatever a finished growth starts has had its time.
  await page.waitForTimeout(1500);
  await settle(page);
  const reads = await page.evaluate(() => window.__embeddingReads);
  const activities = await page.evaluate(() => window.__embeddingActivities);
  const byLayout = new Map();
  for (const read of reads.filter(read => read.method === 'readEmbedding')) {
    const key = `${read.key} ${read.columns}`;
    if (!byLayout.has(key)) byLayout.set(key, []);
    byLayout.get(key).push(read);
  }
  expect(byLayout.size).toBeGreaterThan(0);
  for (const [layout, list] of byLayout) {
    // The first view reads its cells whole (before any is shown); each step
    // after it reads only the cells it adds; no row is read twice, and every
    // one is read.
    const covered = new Uint8Array(2000);
    list.forEach((read, index) => {
      if (read.rows === null) expect(read.shown, `${layout}: a whole read happens only before the first view`).toBe(0);
      const [start, end] = read.rows ?? [0, list[index + 1]?.shown ?? 2000];
      for (let cell = start; cell < end; cell++) covered[cell]++;
    });
    expect(Math.max(...covered), `${layout}: a row read twice`).toBe(1);
    expect(Math.min(...covered), `${layout}: a row never read`).toBe(1);
  }
  // The reader worker reads an embedding only when the page asks: once a
  // step, nothing after the last; each read says which open cells it read
  // and what for.
  expect(activities.length).toBe(reads.filter(read => read.method !== 'readVectorField').length);
  expect(activities.every(activity => activity.status === 'done')).toBe(true);
  const embeddingReads = reads.filter(read => read.method === 'readEmbedding');
  embeddingReads.forEach((read, index) => {
    const label = activities[index].label;
    if (read.rows === null) expect(label).toContain('every open cell (embedding)');
    else expect(label).toContain(`open cells ${read.rows[0].toLocaleString('en-US')}–${read.rows[1].toLocaleString('en-US')} (embedding, cells added)`);
  });
  await closeContextWithApplicationRetirement(context);
  expect(errors).toEqual([]);
});
