import { expect, test } from './helpers/test.mjs';

import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { loadSyntheticDataset } from './helpers/synthetic-dataset.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { setSimulatedGpu } from './helpers/device.mjs';
import { waitForPageAtRest } from './helpers/dataset-ready.mjs';
import { expectPerformance, performanceState, recordFrameCost } from './helpers/frame-cost-log.mjs';

/**
 * Level of detail and frustum culling turn on when the GPU's share of a
 * frame of every cell is measured too slow for interaction, and stay on
 * only if the frames drawn with them are measured faster
 * (`rendering/full-detail-frame-cost.js`, `render-controls.js`), end to end:
 * the viewer arms the measurement when it publishes cells, samples frames
 * drawn with both off, the render controls turn on what can draw fewer
 * cells, and the frames drawn with them decide.
 *
 * The GPU is the fixture's (`helpers/device.mjs`): its timer reports each
 * frame's GPU time exactly, whatever the runner's own GPU takes. A flat
 * time (every frame `GPU_MS`) gains nothing from drawing fewer cells; a
 * time that follows the cells the live view drew (`perThousandCellsMs`)
 * does. Every verdict is therefore exact, the same on every runner: with
 * fences that signal at a simulated time, the runner's software GL and late
 * polls would decide (a frame measured 150 ms faster called no faster; a flat
 * 60 ms measured faster on Linux and not on a Mac;
 * measured: 38_decisions_testing_and_hosted_runners.md).
 */

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=full-detail-frame-cost-ci`;
// Far above any frame's own script on any runner, so a frame lasts its GPU
// time exactly (a frame lasts the longer of the two, `full-detail-frame-cost.js`).
const GPU_MS = 500;

test.describe(`on a GPU that takes ${GPU_MS} ms a frame`, () => {
  test.use({ device: { gpu: { frameMs: GPU_MS } } });

  test('a slow frame of 120 cells all in view is not measured; zoomed in so cells leave it, culling is tried and, no faster, turned off again', async ({ page }) => {
    const reports = async () => (await readReports()).map(report => report.kind);
    const readReports = await recordFrameCost(page);
    await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    // 120 cells are below the ladder's first count (every level is every
    // cell), and the opening's framing holds every cell: nothing the page
    // could turn on would draw fewer, so no frame is asked for to measure it
    // (on a GPU that takes seconds a frame those frames are most of an
    // opening's time).
    await expect.poll(reports, { timeout: 60_000 }).toContain('nothing-fewer');
    expect(await reports()).not.toContain('too-slow');
    // The opening done, its published view applied, before the camera is
    // set: a camera set while the sample's own view is still to come is
    // undone by it, and the zoomed framing is never measured.
    await waitForPageAtRest(page);
    expect(await performanceState(page)).toEqual({ lod: false, culling: false, tip: '' });
    // Zoomed in, cells leave the view: the framing is measured, culling is
    // tried, and a flat GPU time gains nothing from it.
    await page.evaluate(() => {
      const viewer = window._cellucidViewer;
      const camera = structuredClone(viewer.getCameraState());
      camera.orbit.radius *= 0.1;
      camera.orbit.targetRadius = camera.orbit.radius;
      viewer.setCameraState(camera);
    });
    await expectPerformance(page, {
      lod: false,
      culling: false,
      tip: `Every cell drawn: frustum culling measured ${GPU_MS} ms a frame against ${GPU_MS} ms without, no faster here. Measured again when the view moves.`,
    });
  });
});

test('level of detail turned on by a caller ends the opening\'s measurement; the next publication is measured', async ({ page }) => {
  test.setTimeout(240_000);
  await recordFrameCost(page);
  // The start dataset is drawn on the fixture's fast GPU: nothing is
  // turned on.
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  // A caller of the viewer turns level of detail on at a forced level, and
  // the GPU turns slow; the next opening is drawn at that level.
  await setSimulatedGpu(page, { frameMs: GPU_MS });
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    viewer.setAdaptiveLOD(true);
    viewer.setForceLOD(0);
  });
  await loadSyntheticDataset(page, { pointCount: 40_000, pattern: 'atlas' });
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getCurrentLODLevel('live')), { timeout: 60_000 }).toBe(0);
  // Nothing is measured: the scene settles with no measurement armed.
  const unmeasured = () => page.evaluate(() => {
    const schedule = window._cellucidViewer.getFrameScheduleState();
    return schedule.settled && schedule.frameCostPhase === null;
  });
  await expect.poll(unmeasured).toBe(true);
  expect(await performanceState(page)).toEqual({ lod: false, culling: false, tip: '' });
  expect(await page.evaluate(() => window._cellucidViewer.getCurrentLODLevel('live'))).toBe(0);
  // Turned off again by the caller: still the caller's opening, not measured.
  await page.evaluate(() => window._cellucidViewer.setAdaptiveLOD(false));
  await expect.poll(unmeasured).toBe(true);
  expect(await performanceState(page)).toEqual({ lod: false, culling: false, tip: '' });
  // The next publication of cells (here another representation of them) is
  // measured: both are tried, and a flat GPU time gains nothing from them.
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    viewer.updatePositions(viewer.getPositions().slice(), viewer.getViewDimension('live'));
  });
  await expectPerformance(page, {
    lod: false,
    culling: false,
    tip: `Every cell drawn: level of detail and frustum culling measured ${GPU_MS} ms a frame against ${GPU_MS} ms without, no faster here. Measured again when the view moves.`,
  });
});

test.describe('on a GPU whose time follows the cells drawn', () => {
  // 10 ms and 5 ms a thousand cells: the 120-cell start dataset is fast
  // (nothing tried), 200,000 cells take 1,010 ms, and the reduced level the
  // view settles on (adaptive: at least an eighth of the cells) gains.
  test.use({ device: { gpu: { frameMs: 10, perThousandCellsMs: 5 } } });

  test('a slow frame of 200,000 cells turns both on, and they stay where they make frames faster', async ({ page }) => {
    test.setTimeout(240_000);
    await recordFrameCost(page);
    await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await loadSyntheticDataset(page, { pointCount: 200_000, pattern: 'atlas' });
    await expectPerformance(page, {
      lod: true,
      culling: true,
      tip: expect.stringMatching(/^Turned on for this dataset: a frame of every cell took 1010 ms on this device, over the 33 ms that keeps moving the view smooth, and \d+ ms with level of detail and frustum culling\. Turn either off to draw every cell\.$/),
    }, { timeout: 120_000 });
  });
});
