/**
 * The open cells grown or cut in place, in the app (`app/open-cells-resize.js`).
 *
 * - Apply with a larger or smaller share of the same method and seed shows
 *   the cells in place: no new dataset is published, the camera, the field
 *   shown, its filter and the highlights stay, the cells open before keep
 *   their positions bit for bit, and the colors and visibility are, byte for
 *   byte, what opening at that share directly shows after the same actions.
 *   A category highlight takes the cells added in its category, as opening
 *   them would; a lasso keeps its cells.
 * - A text column (its categories found by its first load) shown through a
 *   chain of resizes stays shown, read under the categories it was found
 *   with, and lands where opening directly lands.
 * - A share over a link whose round trips cost anything opens in one step,
 *   even where showing a cell is slow (`data/opening-cost.js`), and lands
 *   where opening at the share directly lands.
 * - An opening reads each embedding row once, in one step or (blocks) with
 *   the step that puts the cells in their order, and nothing after it ends.
 *
 * Fixture: a synthetic `.zarr.zip` of 2,400 cells with a categorical field
 * and a text column (`helpers/share-dataset.mjs`).
 *
 * Every test runs on the fixture's device (`helpers/device.mjs`): the link,
 * the decoding rate and the order time the reader plans from are held, so
 * genes are read for every open cell and a share opens in its own priority
 * order on any runner. What a slow link does to Apply (genes read for a
 * sample, the share read anew) is `held-machine.spec.mjs`'s.
 */

import { closeContextWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { SHARE_CELLS as CELLS, shareDataset as dataset } from './helpers/share-dataset.mjs';
import { openCollapsedPanels, openSessionSectionsOnLoad } from './helpers/panels.mjs';
import { waitForPageAtRest } from './helpers/dataset-ready.mjs';

// Cells to open, Genes read for and the data mapping are in the Session
// panel's sections, collapsed by default: open, as a viewer who opened them.
test.beforeEach(async ({ page }) => {
  await openSessionSectionsOnLoad(page);
});

const URL_OF_FILE = `${SAMPLE_ORIGIN}/open-cells-in-place/cells.zarr.zip`;

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

/** Color by `field`, hide its first category, and make a lasso and a category highlight group. */
async function act(page, field = 'cluster') {
  // The file's own opening is over first: it is colored by its first coloring
  // (`first-coloring.js`: cluster) before its history begins, and the state
  // set below through the page's internals takes no place in the dispatcher's
  // order. Set while the opening is still under way, it is overwritten by
  // the first coloring landing after it (macOS WebKit: the field shown is
  // cluster, not the note chosen here).
  await page.waitForFunction(() => window._cellucidHistories?.current()?.active != null, null, { timeout: 120_000 });
  await page.evaluate(async key => {
    const state = window._cellucidState;
    const index = state.obsData.fields.findIndex(item => item.key === key);
    await state.ensureFieldLoaded(index);
    // The codes the groups below are made from (evidence, `shown`).
    const loaded = state.obsData.fields[index];
    window.__codesAtAct = ArrayBuffer.isView(loaded.codes) ? Array.from(loaded.codes.subarray(0, 32)) : null;
    state.setActiveField(index);
    state.setVisibilityForCategory(state.obsData.fields[index], 0, false);
    state.ensureHighlightPage();
    // The same cells at any size: those of them that are open.
    state.addHighlightDirect({ type: 'lasso', label: 'picked', cellIndices: Uint32Array.from([1, 4, 9, 300].filter(cell => cell < state.pointCount)) });
    // A category clicked: every visible cell of it.
    state.addHighlightFromCategory(index, 2, 'obs');
  }, field);
}

/**
 * At rest: nothing but the highlight pulse asks for frames (`waitForPageAtRest`).
 * Waiting for `settled` here never ends: these pages hold a highlight, whose
 * pulse draws every frame, and the loop runs out only after its 600 frames,
 * which is the whole test's budget on a software-GL runner (measured:
 * 38_decisions_testing_and_hosted_runners.md).
 */
const settle = page => waitForPageAtRest(page);

/**
 * Wait until the opening's work is over: a progressive opening has stopped
 * growing (the Cells to open line says so, `#subsample-notice[data-state]`,
 * set as the growth ends or is stopped: `open-cells-resize.js`), and the
 * page is at rest (`waitForPageAtRest`: startup published, the gene list
 * listed, the scene settled). Nothing the opening started can then open
 * other cells or read an embedding again.
 */
async function openingDone(page) {
  await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready', { timeout: 120_000 });
  await expect(page.locator('#subsample-notice')).not.toHaveAttribute('data-state', 'growing', { timeout: 120_000 });
  await waitForPageAtRest(page, { timeout: 60_000 });
}

async function shown(page) {
  return page.evaluate(() => {
    const state = window._cellucidState;
    const viewer = window._cellucidViewer;
    const active = state.obsData.fields[state.activeFieldIndex] ?? null;
    return {
      n: state.pointCount,
      field: active?.key ?? null,
      // Which categories are shown, as the state gives them (`getLegendModel`).
      hidden: active?.kind === 'category' ? Array.from(state.getLegendModel(active).visible) : null,
      groups: state.getHighlightPages().flatMap(page => page.highlightedGroups.map(group => `${group.type} ${group.label}:${Array.from(group.cellIndices).join(',')}`)),
      camera: viewer.getCameraState(),
      positions: Array.from(state.positionsArray),
      colors: Array.from(state.colorsArray),
      transparency: Array.from(state.categoryTransparency),
      digest: state.cellIdentity.digest,
      // What a difference between two pages is made of (on Windows Firefox a page
      // opened at 250 cells directly held a category group of other cells than its
      // colors; not
      // reproduced elsewhere): the open order's first cells, the shown
      // field's first codes, and how far startup had come.
      evidence: {
        order: Array.from(state.cellIdentity.openOrder ?? state.cellIdentity.kept ?? []).slice(0, 16),
        codes: active?.kind === 'category' && ArrayBuffer.isView(active.codes) ? Array.from(active.codes.subarray(0, 32)) : null,
        startupPhase: document.documentElement.dataset.startupPhase ?? null,
        codesAtAct: window.__codesAtAct ?? null,
      },
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
  const phaseAtAct = await page.evaluate(() => document.documentElement.dataset.startupPhase ?? null);
  await act(page, field);
  await settle(page);
  const state = await shown(page);
  state.evidence.phaseAtAct = phaseAtAct;
  await closeContextWithApplicationRetirement(context);
  return state;
}

/** Both pages' evidence, for an assertion that compares them. */
function evidenceOf(inPlace, opened) {
  return `in place ${JSON.stringify(inPlace.evidence)}; opened directly ${JSON.stringify(opened.evidence)}`;
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
  expect(raised.groups, evidenceOf(raised, openedAt1500)).toEqual(openedAt1500.groups);
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
  expect(lowered.groups, evidenceOf(lowered, openedAt250)).toEqual(openedAt250.groups);
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

test('a share over a link with round trips opens in one step, every cell asked for at once and every embedding row read once, even where showing them is slow', async ({ browser }) => {
  test.setTimeout(240_000);
  // Showing a cell costs 2 ms on this device (the fixture's held
  // opening cost): 2,000 cells take 4 s, which would make a first view of
  // the cells that take a second.
  const context = await browser.newContext({ device: { openingMsPerCell: 2 } });
  const page = await context.newPage();
  const errors = collectBrowserErrors(page);
  await page.addInitScript(() => {
    // Every count of open cells the state takes, as it takes it. Sampled
    // once a frame, a step no frame ran during is missed: on hosted Linux
    // and macOS WebKit the first count seen can be 992, the step after a first
    // view of about 500.
    window.__counts = [];
    const note = count => {
      if (count > 0 && window.__counts.at(-1) !== count) window.__counts.push(count);
    };
    let shownState;
    Object.defineProperty(window, '_cellucidState', {
      configurable: true,
      get: () => shownState,
      set(state) {
        shownState = state;
        let count = state.pointCount;
        note(count);
        Object.defineProperty(state, 'pointCount', {
          configurable: true,
          enumerable: true,
          get: () => count,
          set(value) {
            count = value;
            note(value);
          },
        });
      },
    });
  });
  await recordEmbeddingReads(page);
  await open(page, '&cells=2000&sample=uniform&seed=3');
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 120_000 }).toBe(2000);
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0)).toBe(2000);
  const counts = await page.evaluate(() => window.__counts);
  // A share over a link whose round trips cost anything opens whole
  // (`data/anndata/progressive-open.js`, `planProgressiveOpening`): growing
  // it reads the same bytes in more readings, each a round trip, so all its
  // cells would be shown later than one reading shows them (a share never
  // costs more than everything). The loopback host is
  // such a link, so the cells asked for open in one step.
  expect(counts).toEqual([2000]);

  await test.step('a progressive opening (uniform) reads each embedding row once: a finished growth reads none again, for every embedding shown', async () => {
    await expectEachEmbeddingRowReadOnce(page);
  });
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

/**
 * Record every embedding read the page asks the reader worker for, with the
 * cells shown when it was asked, and every read of an embedding the reader
 * worker makes, whatever asked. Installed before the page opens.
 */
async function recordEmbeddingReads(page) {
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
}

/**
 * Once the opening is over: every embedding row was read once, a whole read
 * happened only before the first view, and the reader worker read an
 * embedding only when the page asked, each read saying what it read.
 */
async function expectEachEmbeddingRowReadOnce(page) {
  // The growth is over (its last step, and for blocks the step that puts
  // the cells in their order, have read what they read), and so is the rest
  // of the opening.
  await openingDone(page);
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
}

test('a progressive opening (blocks) reads each embedding row once: a finished growth reads none again, for every embedding shown', async ({ browser }) => {
  test.setTimeout(240_000);
  // Showing a cell costs 2 ms on this device (the fixture's held
  // opening cost): 2,000 cells take 4 s. Blocks open in their own order, and
  // a second step puts the cells in theirs.
  const context = await browser.newContext({ device: { openingMsPerCell: 2 } });
  const page = await context.newPage();
  const errors = collectBrowserErrors(page);
  await recordEmbeddingReads(page);
  await open(page, '&cells=2000&sample=blocks&seed=3&block=100');
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 120_000 }).toBe(2000);
  await expectEachEmbeddingRowReadOnce(page);
  await closeContextWithApplicationRetirement(context);
  expect(errors).toEqual([]);
});
