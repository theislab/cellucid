/**
 * The device a spec runs on reaches the reader's plans
 * (`helpers/device.mjs`, `assets/js/utils/machine.js`): what the reader
 * plans from is what the spec's device holds, in the page and in every
 * worker, whatever the runner measures.
 *
 * - The device's machine is held on the page and handed to every worker the
 *   page starts (the reader worker, and the decode workers that one
 *   starts).
 * - A plan does not follow what the runner measures: the file's answers
 *   held back 370 ms, as a loaded runner answers a request to itself, open
 *   the same cells in the same order, genes read for every one, and a
 *   share raised with Apply is shown in place. Measured, the same answers
 *   make the link a slow one, genes are read for a sample of the raised
 *   share, and it is read anew: what failed `open-cells-in-place.spec.mjs`
 *   beside other runs (2026-11-06).
 * - A spec about a slow link gives its link through the device: genes are
 *   read for a sample of the raised share, which is then shown as a new
 *   reading (the exception the user guide names,
 *   `b_data_loading/21_subsampled_loading.md` "Changing the share").
 *
 * Fixture: `helpers/share-dataset.mjs`.
 */

import { closeContextWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { deviceOf, machineOf } from './helpers/device.mjs';
import { openCollapsedPanels, openSessionSectionsOnLoad } from './helpers/panels.mjs';
import { waitForPageAtRest } from './helpers/dataset-ready.mjs';
import { SHARE_CELLS, shareDataset } from './helpers/share-dataset.mjs';

const URL_OF_FILE = `${SAMPLE_ORIGIN}/held-machine/cells.zarr.zip`;

/** How long a held-back answer waits: longer than the 278 ms a round trip at which 1,500 cells' first gene passes its time. */
const LATE_MS = 370;

/**
 * Open 600 cells of the file, then raise the share to 1,500 with Apply.
 * `lateMs`: every answer of the file held back this long.
 *
 * @returns {Promise<{held: Object|null, workers: Array<{script: string, held: Object|null}>, opened: Object|null, raised: Object|null, scenes: number}>}
 *   `held`: the machine the page holds; `workers`: each worker's own;
 *   `opened`, `raised`: the gene sample of each opening (null: every open
 *   cell); `scenes`: the datasets published by Apply (0: shown in place)
 */
async function openThenRaise(browser, { device = {}, lateMs = 0 } = {}) {
  const context = await browser.newContext({ device });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await openSessionSectionsOnLoad(page);
  const bytes = shareDataset();
  await page.route(URL_OF_FILE, async route => {
    if (lateMs > 0) await new Promise(resolve => setTimeout(resolve, lateMs));
    await fulfillFile(route, bytes);
  });
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(URL_OF_FILE)}&cells=600&sample=uniform&seed=3`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 60_000 }).toBe(600);
  await waitForPageAtRest(page);
  const held = await page.evaluate(() => window.__cellucidMachineHeld ?? null);
  // What each worker was handed at its start, as its scope holds it: the
  // fragment of its address (`workers/worker-script.js`). That its module
  // begins with it is what the plans below show, and
  // `tests/machine-seam-contract.test.mjs` holds on the module itself.
  const workers = await Promise.all(page.workers().map(async worker => ({
    script: new URL(worker.url()).pathname.split('/').pop(),
    held: await worker.evaluate(() => {
      const mark = '#handed=';
      const fragment = self.location.hash;
      return fragment.startsWith(mark) ? JSON.parse(decodeURIComponent(fragment.slice(mark.length))).machine ?? null : null;
    }),
  })));
  const opened = await page.evaluate(() => window._cellucidState.getGeneSample());
  await openCollapsedPanels(page);
  await page.evaluate(() => {
    const state = window._cellucidState;
    window.__scenes = 0;
    const initScene = state.initScene.bind(state);
    state.initScene = (...args) => {
      window.__scenes++;
      return initScene(...args);
    };
  });
  await page.locator('#subsample-percent').fill(String((100 * 1500) / SHARE_CELLS));
  await page.locator('#subsample-method').selectOption('uniform');
  await page.locator('#subsample-seed').fill('3');
  await page.locator('#subsample-apply').click();
  await expect.poll(() => page.evaluate(() => window._cellucidState.pointCount), { timeout: 60_000 }).toBe(1500);
  await waitForPageAtRest(page);
  const raised = await page.evaluate(() => window._cellucidState.getGeneSample());
  const scenes = await page.evaluate(() => window.__scenes);
  await closeContextWithApplicationRetirement(context);
  expect(errors).toEqual([]);
  return { held, workers, opened, raised, scenes };
}

test('the device\'s machine is held on the page and handed to every worker it starts', async ({ browser }) => {
  test.setTimeout(240_000);
  const machine = machineOf(deviceOf());
  const { held, workers } = await openThenRaise(browser);
  expect(held).toEqual(machine);
  // The reader worker, at least; an engine that shows the workers a worker starts shows the decode workers too.
  expect(workers.map(worker => worker.script)).toContain('anndata-reader-worker.js');
  for (const worker of workers) expect(worker.held, worker.script).toEqual(machine);

  // A spec's own device, and a measure it leaves measured.
  const own = { decodeBytesPerMs: 'measured', orderMadeMs: 5, hardwareConcurrency: 2 };
  const ownMachine = machineOf(deviceOf(own));
  expect(Object.keys(ownMachine)).not.toContain('decodeBytesPerMs');
  const other = await openThenRaise(browser, { device: own });
  expect(other.held).toEqual(ownMachine);
  for (const worker of other.workers) expect(worker.held, worker.script).toEqual(ownMachine);
});

test('a plan does not follow what the runner measures: answers held back open the same cells, genes for every one, a raised share in place', async ({ browser }) => {
  test.setTimeout(240_000);
  // On the fixture's device, with the file's answers on time and held back.
  for (const lateMs of [0, LATE_MS]) {
    const { opened, raised, scenes } = await openThenRaise(browser, { lateMs });
    expect(opened, `answers ${lateMs} ms late: genes for every one of the 600 cells`).toBeNull();
    expect(raised, `answers ${lateMs} ms late: genes for every one of the 1,500 cells`).toBeNull();
    expect(scenes, `answers ${lateMs} ms late: the raised share is shown in place`).toBe(0);
  }
  // Measured, the same held-back answers are a slow link: the raised share's
  // genes are read for a sample, in the file's cell order, and it is read anew.
  const measured = await openThenRaise(browser, { device: { link: 'measured' }, lateMs: LATE_MS });
  expect(measured.held).not.toHaveProperty('link');
  expect(measured.opened).toBeNull();
  expect(measured.raised?.of).toBe(1500);
  expect(measured.raised.cells).toBeLessThan(1500);
  expect(measured.raised.fit.limit).toBe('geneTime');
  expect(measured.scenes).toBe(1);
});

test('a spec about a slow link gives its link through the device: genes for a sample, the raised share read anew', async ({ browser }) => {
  test.setTimeout(240_000);
  const first = await openThenRaise(browser, { device: { link: { latencyMs: 400, bytesPerMs: 32_000 } } });
  expect(first.opened).toBeNull();
  expect(first.raised?.of).toBe(1500);
  expect(first.raised.cells).toBeLessThan(1500);
  expect(first.raised.fit.limit).toBe('geneTime');
  expect(first.scenes).toBe(1);
  // The same link gives the same plan: nothing of it is measured.
  const again = await openThenRaise(browser, { device: { link: { latencyMs: 400, bytesPerMs: 32_000 } }, lateMs: LATE_MS });
  expect(again.raised.cells).toBe(first.raised.cells);
  expect(again.raised.fit.neededMs).toBe(first.raised.fit.neededMs);
  expect(again.scenes).toBe(1);
});
