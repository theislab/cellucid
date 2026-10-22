import { expect, test } from './helpers/test.mjs';

import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { pixelParityVerdict } from './helpers/pixel-parity.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=kept-views-memory-ci`;

/**
 * Any number of kept views (there is no view-count ceiling), and memory, not
 * a count, decides what stays on the GPU: when an allocation is refused, the
 * colour stores and R8 textures of kept views that are not presented are
 * released first, and each is rebuilt from its own colours and alpha bytes
 * when it is shown again, drawing exactly what it drew before.
 */
test('six kept views draw in a grid, and views released under memory pressure come back exactly', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');

  const keepView = async () => {
    const before = await page.evaluate(() => window._cellucidViewer.getSnapshotViews().length);
    await page.evaluate(() => document.getElementById('split-keep-view-btn').click());
    await expect.poll(() => page.evaluate(() => window._cellucidViewer.getSnapshotViews().length)).toBe(before + 1);
  };
  const setLayout = mode => page.evaluate(value => {
    const select = document.getElementById('view-layout-mode');
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, mode);
  const settled = () => expect.poll(
    () => page.evaluate(() => window._cellucidViewer.getFrameScheduleState().settled),
    { timeout: 30_000 },
  ).toBe(true);
  // What the canvas shows, kept in the page, and where two captures differ:
  // pane by pane, how many pixels, by how much, and the first few, so a
  // difference names the pane it is in and what moved.
  const capture = name => page.evaluate(key => {
    const viewer = window._cellucidViewer;
    const gl = viewer.getGLContext();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const pixels = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    window.__keptViewCaptures ??= {};
    window.__keptViewCaptures[key] = {
      width,
      height,
      pixels,
      panes: viewer.getPresentedLayout().panes.map(pane => ({
        viewId: pane.viewId,
        // Framebuffer viewport, bottom-origin like readPixels.
        rect: [pane.viewportX, pane.viewportY, pane.viewportWidth, pane.viewportHeight],
        // The camera the pane was drawn with, to the digit: a pane whose
        // camera moved between captures differs for that reason, not for
        // the rebuild of its stores.
        camera: viewer.getViewCameraState(pane.viewId),
      })),
    };
  }, name);
  const differences = (left, right) => page.evaluate(([a, b]) => {
    const before = window.__keptViewCaptures[a];
    const after = window.__keptViewCaptures[b];
    if (before.width !== after.width || before.height !== after.height) {
      return [{ canvas: [before.width, before.height, after.width, after.height] }];
    }
    if (JSON.stringify(before.panes) !== JSON.stringify(after.panes)) {
      return [{ layout: [before.panes, after.panes] }];
    }
    const found = [];
    for (const pane of before.panes) {
      const [x0, y0, width, height] = pane.rect;
      let count = 0;
      let maxDelta = 0;
      const first = [];
      for (let y = y0; y < y0 + height; y++) {
        for (let x = x0; x < x0 + width; x++) {
          const offset = (y * before.width + x) * 4;
          let delta = 0;
          for (let channel = 0; channel < 4; channel++) {
            delta = Math.max(delta, Math.abs(before.pixels[offset + channel] - after.pixels[offset + channel]));
          }
          if (delta === 0) continue;
          count++;
          maxDelta = Math.max(maxDelta, delta);
          if (first.length < 4) {
            first.push([x, y, [...before.pixels.subarray(offset, offset + 4)], [...after.pixels.subarray(offset, offset + 4)]]);
          }
        }
      }
      if (count > 0) found.push({ viewId: pane.viewId, lit: width * height, mismatched: count, maxDelta, first });
    }
    return found;
  }, [left, right]);
  const released = () => page.evaluate(() => [
    ...window._cellucidViewer.getHPRenderer().snapshotBuffers.values(),
  ].filter(snapshot => snapshot.storesReleased === true).length);
  // What each kept view holds on the GPU: its colour store and R8 alpha
  // texture read back and hashed, and whether its store is in its geometry's
  // draw order. A pixel difference after the rebuild then says whether the
  // renderer rebuilt different bytes or drew the same bytes differently.
  const storeFingerprints = () => page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const gl = viewer.getGLContext();
    const renderer = viewer.getHPRenderer();
    const hash = bytes => {
      let h = 2166136261 ^ bytes.length;
      for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619);
      return h >>> 0;
    };
    const out = {};
    const framebuffer = gl.createFramebuffer();
    const previousFramebuffer = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    try {
      for (const snapshot of renderer.snapshotBuffers.values()) {
        if (snapshot.storesReleased === true || !snapshot.buffer) {
          out[snapshot.id] = { released: true };
          continue;
        }
        const colors = new Uint8Array(snapshot.bufferByteLength);
        gl.bindBuffer(gl.ARRAY_BUFFER, snapshot.buffer);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, colors);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        const plan = snapshot.alphaTexPlan;
        const alpha = new Uint8Array(plan.width * plan.rows);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
        gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, snapshot.alphaTexture, 0, 0);
        gl.readPixels(0, 0, plan.width, plan.rows, gl.RED, gl.UNSIGNED_BYTE, alpha);
        const geometry = renderer._snapshotGeometryPools?.get(snapshot.geometryGeneration) ?? null;
        const expectedOrder = geometry === null || snapshot.geometryGeneration === renderer._liveGeometryGeneration
          ? (renderer._liveOrder?.drawOrder ?? null)
          : (geometry.order?.drawOrder ?? null);
        out[snapshot.id] = {
          colorBytes: colors.length,
          colorHash: hash(colors),
          alphaHash: hash(alpha),
          storeInGeometryOrder: (snapshot.colorOwner?.order ?? null) === expectedOrder,
          glError: gl.getError(),
        };
      }
    } finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousFramebuffer);
      gl.deleteFramebuffer(framebuffer);
    }
    return out;
  });

  // Five kept views: more than the four views there used to be room for.
  for (let index = 0; index < 5; index++) await keepView();
  await setLayout('grid');
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getPresentedLayout().panes.length)).toBe(6);
  await settled();
  await capture('grid-before');
  const storesBefore = await storeFingerprints();
  // The same scene drawn again draws the same pixels: the baseline that
  // makes the comparison after the release mean something on this GPU.
  await page.evaluate(() => window._cellucidViewer.setFrameInvalidationTracing(false));
  await settled();
  await capture('grid-redrawn');
  expect(await differences('grid-before', 'grid-redrawn')).toEqual([]);

  // Show one view alone: the other four kept views are dormant. The next
  // store allocated is refused once, as a device out of memory refuses it,
  // while the shown view republishes the same colours and visibility (a
  // store replacement, which allocates).
  await setLayout('single');
  await settled();
  await page.evaluate(() => {
    // The first store sized reports OUT_OF_MEMORY when its allocation is
    // checked; the retry after the release succeeds.
    const proto = WebGL2RenderingContext.prototype;
    const { bufferData, getError } = proto;
    let pending = false;
    proto.bufferData = function (...args) {
      proto.bufferData = bufferData;
      pending = true;
      return bufferData.apply(this, args);
    };
    proto.getError = function () {
      if (pending) {
        pending = false;
        proto.getError = getError;
        return this.OUT_OF_MEMORY;
      }
      return getError.call(this);
    };
    const viewer = window._cellucidViewer;
    const shown = viewer.getPresentedLayout().panes[0].viewId;
    viewer.updateSnapshotAttributes(shown, {
      colors: Uint8Array.from(viewer.getViewColors(shown)),
      transparency: Uint8Array.from(viewer.getViewTransparency(shown)),
    });
  });
  await settled();
  expect(await released()).toBe(4);
  expect(pageErrors).toEqual([]);

  // Show the grid again: every released view is rebuilt from its own
  // colours and alpha bytes and draws exactly what it drew before.
  await setLayout('grid');
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getPresentedLayout().panes.length)).toBe(6);
  await settled();
  expect(await released()).toBe(0);
  await capture('grid-after');
  const storesAfter = await storeFingerprints();
  const pixelDifferences = await differences('grid-before', 'grid-after');
  // The rebuilt stores hold the bytes the released ones held, in the same
  // order: a view that draws differently with identical GPU data names the
  // rasterizer, not the rebuild.
  expect(storesAfter).toEqual(storesBefore);
  // With the stores, cameras and viewports proven identical, the picture may
  // differ only by the rasterizer's last bit (helpers/pixel-parity.mjs).
  for (const pane of pixelDifferences) {
    expect(pixelParityVerdict(pane, `pane ${pane.viewId}`)).toBeNull();
  }
  expect(pageErrors).toEqual([]);
});
