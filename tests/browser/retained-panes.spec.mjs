import { expect, test } from './helpers/test.mjs';

import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=retained-panes-ci`;

/**
 * Retained panes (viewer.js): in a grid, a pane whose scene and camera did not
 * change keeps the pixels it drew, so dragging the camera of one pane of four
 * redraws one pane, and the image is exactly what a full redraw draws.
 */
test('a camera drag in one pane redraws only that pane, and the image equals a full redraw', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');

  for (let kept = 0; kept < 3; kept++) {
    const before = await page.evaluate(() => window._cellucidViewer.getSnapshotViews().length);
    await page.evaluate(() => document.getElementById('split-keep-view-btn').click());
    await expect.poll(() => page.evaluate(() => window._cellucidViewer.getSnapshotViews().length)).toBe(before + 1);
  }
  await page.evaluate(() => {
    const select = document.getElementById('view-layout-mode');
    select.value = 'grid';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getViewLayout().mode)).toBe('grid');
  // Linked cameras move every view of one representation together; unlinked,
  // a drag moves one pane's camera.
  await page.evaluate(() => window._cellucidViewer.setCamerasLocked(false));


  // Count point-pass draws in each animation frame (its timeline time, the
  // same for every callback of one frame): one a pane drawn. A drag moves
  // the camera in as many frames as the host draws while the pointer moves,
  // more than the moves on a slow one, so it is the draws of each frame that
  // are counted, not the moves.
  await page.evaluate(() => {
    const proto = WebGL2RenderingContext.prototype;
    const original = proto.drawArrays;
    const viewer = window._cellucidViewer;
    const pointCount = viewer.getPointCount();
    // A point-pass draw is one of the renderer's point programs' (the GPU
    // gather of a tree's draw order draws as many points with its own).
    const pointPrograms = new Set(Object.values(viewer.getHPRenderer().programs));
    window.__pointDraws = new Map();
    proto.drawArrays = function (mode, first, count) {
      if (mode === this.POINTS && first === 0 && count === pointCount
        && pointPrograms.has(this.getParameter(this.CURRENT_PROGRAM))) {
        const frame = document.timeline.currentTime;
        window.__pointDraws.set(frame, (window.__pointDraws.get(frame) ?? 0) + 1);
      }
      return original.apply(this, arguments);
    };
  });
  const frames = count => page.evaluate(n => new Promise(resolve => {
    const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  }), count);
  const settle = async () => {
    await expect.poll(
      () => page.evaluate(() => window._cellucidViewer.getFrameScheduleState().settled),
      { timeout: 30_000 },
    ).toBe(true);
    await frames(6);
  };
  await settle();

  // The first pane's rectangle in client coordinates.
  const pane = await page.evaluate(() => {
    const canvas = document.getElementById('glcanvas');
    const rect = canvas.getBoundingClientRect();
    const layout = window._cellucidViewer.getPresentedLayout();
    const first = layout.panes[0];
    const scale = rect.width / canvas.width;
    return {
      x: rect.left + (first.viewportX + first.viewportWidth / 2) * scale,
      y: rect.bottom - (first.viewportY + first.viewportHeight / 2) * scale,
    };
  });
  // Press first (a press may move focus, which redraws every pane once),
  // and count from when that redraw is over: the frame loop has settled.
  await page.mouse.move(pane.x, pane.y);
  await page.mouse.down();
  await settle();
  await page.evaluate(() => { window.__pointDraws.clear(); });
  for (let step = 1; step <= 8; step++) {
    await page.mouse.move(pane.x + step * 6, pane.y + step * 2);
    await frames(1);
  }
  const dragDraws = await page.evaluate(() => [...window.__pointDraws.values()]);
  await page.mouse.up();
  await settle();

  // Exactly one pane a frame drawn while dragging (the camera of one pane
  // moved); never four.
  expect(dragDraws.length).toBeGreaterThan(0);
  expect(new Set(dragDraws)).toEqual(new Set([1]));

  const capture = () => page.evaluate(() => {
    const gl = window._cellucidViewer.getGLContext();
    const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let hash = 2166136261;
    for (let index = 0; index < pixels.length; index++) hash = Math.imul(hash ^ pixels[index], 16777619);
    return hash >>> 0;
  });
  const retained = await capture();
  // A public call redraws every pane; nothing on screen changes.
  await page.evaluate(() => window._cellucidViewer.resume());
  await settle();
  const full = await capture();
  expect(full).toBe(retained);
  expect(pageErrors).toEqual([]);
});
