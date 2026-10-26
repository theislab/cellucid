/**
 * The highlight pulse draws only the layer over the points.
 *
 * In Full quality highlights pulse, and every pulse frame used to draw the
 * whole pane, every point included. While they pulse, each pane's base layer
 * (backdrop, grid, points, overlays) is kept and reused
 * (`rendering/pulse-layer-cache.js`): a frame that only moves the pulse draws
 * the highlights, edges, centroids and the orbit anchor over a copy of the
 * kept base. Such a frame must be the frame drawn whole, pixel for pixel: the
 * pulse is pinned to one phase, and the same frame is captured drawn whole and
 * drawn over the kept base, in one view and in a grid of two.
 *
 * With antialiasing on the scene target keeps every sample between frames,
 * and a pulse frame draws again only the samples the rings cover, which the
 * ring pass of the frame before marked in the stencil
 * (`rendering/pulse-sample-mask.js`). The pulse is pinned to one phase, then
 * moved to another without touching the base, and the frame drawn that way
 * must be the frame drawn whole at the second phase, pixel for pixel.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { loadSyntheticDataset } from './helpers/synthetic-dataset.mjs';
import { pixelParityVerdict } from './helpers/pixel-parity.mjs';

const FIXTURE_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}` +
  '&dataset=current-ui&acceptance=highlight-pulse-layer-parity-ci';
const POINT_COUNT = 40_000;

async function loadAtlas(page) {
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await loadSyntheticDataset(page, { pointCount: POINT_COUNT, pattern: 'atlas' });
}

/** Capture the frame drawn whole, then over the kept base, at one pulse phase. */
function compareLayers(page) {
  return page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const gl = viewer.getGLContext();
    const frames = count => new Promise(resolve => {
      const step = () => (count-- <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    const capture = async caching => {
      viewer.setPulseLayerCaching(caching);
      // Frames until a pulse frame has reused the base (pulse-only frames are
      // paced: ambient-frame-pacing.js); then the next one is captured.
      const startReused = viewer.getPulseLayerStats().basesReused;
      for (let attempt = 0; attempt < 600; attempt += 1) {
        await frames(1);
        if (!caching || viewer.getPulseLayerStats().basesReused >= startReused + 3) break;
      }
      if (!caching) await frames(6);
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return { pixels, width };
    };
    const whole = await capture(false);
    const before = viewer.getPulseLayerStats();
    const layered = await capture(true);
    const after = viewer.getPulseLayerStats();
    let lit = 0;
    let mismatched = 0;
    let maxDelta = 0;
    const first = [];
    for (let index = 0; index < whole.pixels.length; index += 4) {
      if (whole.pixels[index + 3] !== 0) lit += 1;
      let delta = 0;
      for (let channel = 0; channel < 4; channel++) {
        delta = Math.max(delta, Math.abs(whole.pixels[index + channel] - layered.pixels[index + channel]));
      }
      if (delta === 0) continue;
      mismatched += 1;
      maxDelta = Math.max(maxDelta, delta);
      if (first.length < 8) {
        const pixel = index / 4;
        first.push([pixel % whole.width, Math.floor(pixel / whole.width),
          [...whole.pixels.subarray(index, index + 4)], [...layered.pixels.subarray(index, index + 4)]]);
      }
    }
    return {
      lit,
      mismatched,
      maxDelta,
      first,
      reused: after.basesReused - before.basesReused,
      drawn: after.basesDrawn - before.basesDrawn,
    };
  });
}

test('a pulse frame over the kept base is the frame drawn whole', async ({ page }) => {
  test.setTimeout(300_000);
  await loadAtlas(page);
  await page.evaluate(pointCount => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    // The kept base serves single-sampled frames (pulse-layer-cache.js).
    viewer.setAntialiasing(false);
    viewer.setAdaptiveLOD(false);
    viewer.setHighlightAnimationTime(12.375);
    const cells = new Uint32Array(Math.floor(pointCount / 13));
    for (let i = 0; i < cells.length; i++) cells[i] = i * 13;
    state.addHighlightDirect({ type: 'annotation', label: 'pulse', cellIndices: cells });
  }, POINT_COUNT);
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getFrameScheduleState().lastCause)).toBe('highlight');

  const single = await compareLayers(page);
  expect(single.drawn).toBeGreaterThanOrEqual(1);
  expect(single.reused).toBeGreaterThanOrEqual(3);
  expect(single.lit).toBeGreaterThan(1_000);
  expect(pixelParityVerdict(single, 'one view: kept base vs whole frame')).toBeNull();

  // A grid of two views: each pane keeps its own base.
  await page.evaluate(() => document.getElementById('split-keep-view-btn').click());
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getSnapshotViews().length)).toBe(1);
  await page.waitForTimeout(500);
  const grid = await compareLayers(page);
  expect(grid.drawn).toBeGreaterThanOrEqual(2);
  expect(grid.reused).toBeGreaterThanOrEqual(3);
  expect(pixelParityVerdict(grid, 'grid: kept bases vs whole frame')).toBeNull();
});

/**
 * With antialiasing on: the frame drawn whole at `phase`, against the frame
 * drawn under the rings after the pulse moved from `from` to `phase`.
 */
function compareMaskedSamples(page, from, phase) {
  return page.evaluate(async ({ from, phase }) => {
    const viewer = window._cellucidViewer;
    const gl = viewer.getGLContext();
    const frames = count => new Promise(resolve => {
      const step = () => (count-- <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    // Frames until `count` more panes were drawn under their rings (pulse-only
    // frames are paced: ambient-frame-pacing.js).
    const maskedFrames = async count => {
      const start = viewer.getPulseLayerStats().panesMasked;
      for (let attempt = 0; attempt < 600; attempt += 1) {
        await frames(1);
        if (viewer.getPulseLayerStats().panesMasked >= start + count) return;
      }
    };
    const read = () => {
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return { pixels, width };
    };
    viewer.setHighlightAnimationTime(phase);
    viewer.setPulseLayerCaching(false);
    await frames(8);
    const whole = read();
    const before = viewer.getPulseLayerStats();
    // Caching on draws one whole frame (the change invalidates it), then
    // frames under the rings: at `from`, and then at `phase`.
    viewer.setHighlightAnimationTime(from);
    viewer.setPulseLayerCaching(true);
    await maskedFrames(3);
    viewer.setHighlightAnimationTime(phase);
    await maskedFrames(3);
    const masked = read();
    const after = viewer.getPulseLayerStats();
    let lit = 0;
    let mismatched = 0;
    let maxDelta = 0;
    const first = [];
    for (let index = 0; index < whole.pixels.length; index += 4) {
      if (whole.pixels[index + 3] !== 0) lit += 1;
      let delta = 0;
      for (let channel = 0; channel < 4; channel++) {
        delta = Math.max(delta, Math.abs(whole.pixels[index + channel] - masked.pixels[index + channel]));
      }
      if (delta === 0) continue;
      mismatched += 1;
      maxDelta = Math.max(maxDelta, delta);
      if (first.length < 8) {
        const pixel = index / 4;
        first.push([pixel % whole.width, Math.floor(pixel / whole.width),
          [...whole.pixels.subarray(index, index + 4)], [...masked.pixels.subarray(index, index + 4)]]);
      }
    }
    return {
      lit,
      mismatched,
      maxDelta,
      first,
      masked: after.panesMasked - before.panesMasked,
      basesDrawn: after.basesDrawn - before.basesDrawn,
      multisampled: viewer.getAntialiasing(),
    };
  }, { from, phase });
}

test('an antialiased pulse frame drawn only under its rings is the frame drawn whole', async ({ page }) => {
  test.setTimeout(300_000);
  await loadAtlas(page);
  const available = await page.evaluate(() => window._cellucidViewer.isAntialiasingAvailable());
  test.skip(!available, 'This device cannot multisample.');
  await page.evaluate(pointCount => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    viewer.setAntialiasing(true);
    viewer.setAdaptiveLOD(false);
    viewer.setHighlightAnimationTime(12.375);
    const cells = new Uint32Array(Math.floor(pointCount / 13));
    for (let i = 0; i < cells.length; i++) cells[i] = i * 13;
    state.addHighlightDirect({ type: 'annotation', label: 'pulse', cellIndices: cells });
  }, POINT_COUNT);
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getFrameScheduleState().lastCause)).toBe('highlight');

  // Two phases far apart in the glow (0.83 and 0.15 of full).
  const report = label => (result => `${label}: ${result.mismatched} of ${result.lit} lit pixels differ, ` +
    `max delta ${result.maxDelta}, first ${JSON.stringify(result.first)}`);
  const single = await compareMaskedSamples(page, 11.6, 12.375);
  expect(single.multisampled).toBe(true);
  expect(single.basesDrawn).toBe(0);
  expect(single.masked).toBeGreaterThanOrEqual(6);
  expect(single.lit).toBeGreaterThan(1_000);
  expect(single.mismatched, report('one view: under the rings vs whole')(single)).toBe(0);

  // A grid of two views: each pane is marked and drawn on its own.
  await page.evaluate(() => document.getElementById('split-keep-view-btn').click());
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getSnapshotViews().length)).toBe(1);
  await page.waitForTimeout(500);
  const grid = await compareMaskedSamples(page, 11.6, 12.375);
  expect(grid.masked).toBeGreaterThanOrEqual(6);
  expect(grid.mismatched, report('grid: under the rings vs whole')(grid)).toBe(0);
});

test('nothing is kept while highlights do not pulse, or while the frame is multisampled', async ({ page }) => {
  test.setTimeout(300_000);
  await loadAtlas(page);
  const stats = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const frames = count => new Promise(resolve => {
      const step = () => (count-- <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    const start = viewer.getPulseLayerStats();
    viewer.setPointSize(5);
    await frames(6);
    const still = viewer.getPulseLayerStats();
    const available = viewer.isAntialiasingAvailable();
    viewer.setAntialiasing(true);
    const cells = Uint32Array.from({ length: 500 }, (_, i) => i * 7);
    window._cellucidState.addHighlightDirect({ type: 'annotation', label: 'msaa', cellIndices: cells });
    await frames(8);
    const multisampled = viewer.getPulseLayerStats();
    return { start, still, multisampled, available };
  });
  expect(stats.still.basesDrawn).toBe(stats.start.basesDrawn);
  if (stats.available) expect(stats.multisampled.basesDrawn).toBe(stats.still.basesDrawn);
});
