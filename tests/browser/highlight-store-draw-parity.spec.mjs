/**
 * Highlights drawn from the view's point store are the highlights drawn from
 * records of their own, pixel for pixel.
 *
 * A highlight of many cells is drawn from the point store the view already
 * holds on the GPU (`rendering/highlight-renderer.js`, `rebuildBuffer`): its
 * positions, with a colour word for every slot written on the GPU from the
 * highlight and visibility bytes, the cells not admitted rejected by the
 * vertex shader. At a reduced level of detail the records are the level's
 * members in the store's own order (the level is the store's first slots),
 * so the two draws submit the same rings in the same order and must give
 * identical pixels. The level is forced, the store has adopted its tree's
 * order before either capture, the pulse is pinned to one phase and every
 * frame is drawn whole.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { loadSyntheticDataset } from './helpers/synthetic-dataset.mjs';

const FIXTURE_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}` +
  '&dataset=current-ui&acceptance=highlight-store-draw-parity-ci';
const POINT_COUNT = 40_000;
// A reduced level (rendering/high-perf/draw-order.js `lodLadder`: 9,306 of
// the 40,000 cells), below the highlights of either test.
const LEVEL = 10;

async function loadAtlas(page) {
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await loadSyntheticDataset(page, { pointCount: POINT_COUNT, pattern: 'atlas' });
}

/** The frame drawn with highlights from records, then from the store. */
function compareDraws(page) {
  return page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const gl = viewer.getGLContext();
    const frames = count => new Promise(resolve => {
      const step = () => (count-- <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    const capture = async fromStore => {
      viewer.setHighlightStoreDrawing(fromStore);
      await frames(8);
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return { pixels, width, storeViews: viewer.getHighlightStoreDrawnViewCount() };
    };
    const records = await capture(false);
    const store = await capture(true);
    let lit = 0;
    let mismatched = 0;
    let maxDelta = 0;
    const first = [];
    for (let index = 0; index < records.pixels.length; index += 4) {
      if (records.pixels[index + 3] !== 0) lit += 1;
      let delta = 0;
      for (let channel = 0; channel < 4; channel++) {
        delta = Math.max(delta, Math.abs(records.pixels[index + channel] - store.pixels[index + channel]));
      }
      if (delta === 0) continue;
      mismatched += 1;
      maxDelta = Math.max(maxDelta, delta);
      if (first.length < 8) {
        const pixel = index / 4;
        first.push([pixel % records.width, Math.floor(pixel / records.width),
          [...records.pixels.subarray(index, index + 4)], [...store.pixels.subarray(index, index + 4)]]);
      }
    }
    return { lit, mismatched, maxDelta, first, recordViews: records.storeViews, storeViews: store.storeViews };
  });
}

for (const [label, every] of [['every cell', 1], ['every other cell', 2]]) {
  test(`highlights of ${label} drawn from the point store are the highlights drawn from records`, async ({ page }) => {
    test.setTimeout(300_000);
    await loadAtlas(page);
    await page.evaluate(({ pointCount, every, level }) => {
      const viewer = window._cellucidViewer;
      viewer.setAntialiasing(false);
      viewer.setAdaptiveLOD(true);
      viewer.setFrustumCulling(false);
      viewer.setForceLOD(level);
      viewer.setPulseLayerCaching(false);
      viewer.setHighlightAnimationTime(12.375);
      const cells = new Uint32Array(Math.ceil(pointCount / every));
      for (let i = 0; i < cells.length; i++) cells[i] = i * every;
      window._cellucidState.addHighlightDirect({ type: 'annotation', label: 'store', cellIndices: cells });
    }, { pointCount: POINT_COUNT, every, level: LEVEL });
    // The tree has landed and the store drawn in its order at the level.
    await expect
      .poll(() => page.evaluate(() => window._cellucidViewer.getCurrentLODLevel('live')), { timeout: 60_000 })
      .toBe(LEVEL);
    // Nothing but the pulse still changes the frame (fades, bakes, levels).
    await expect
      .poll(() => page.evaluate(() => window._cellucidViewer.getFrameScheduleState().lastCause), { timeout: 60_000 })
      .toBe('highlight');
    const result = await compareDraws(page);
    expect(result.recordViews).toBe(0);
    expect(result.storeViews).toBe(1);
    expect(result.lit).toBeGreaterThan(1_000);
    expect(
      result.mismatched,
      `${result.mismatched} of ${result.lit} lit pixels differ, max delta ${result.maxDelta}, first ${JSON.stringify(result.first)}`
    ).toBe(0);
  });
}
