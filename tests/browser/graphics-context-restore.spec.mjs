import { expect, test } from './helpers/test.mjs';
import { expectDownloadNamed } from './helpers/downloads.mjs';

import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { waitForPageAtRest } from './helpers/dataset-ready.mjs';
import { expectPerformance, recordFrameCost } from './helpers/frame-cost-log.mjs';
import { labelProgramsBySource, recordSubmissions } from './helpers/gl-submissions.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=graphics-context-restore-ci`;

/**
 * A browser that takes the WebGL context away (GPU process crash or reset,
 * driver timeout, memory pressure) and gives it back: the viewer makes every
 * GPU object again from what it holds on the CPU (`restoreLostGraphics`,
 * rendering/viewer.js), and sets again what it had set on the context itself,
 * whose every value is back at its initial one: the clear color of the
 * background, the backdrop look. WEBGL_lose_context stands in for the
 * browser.
 *
 * The frames compared are steady frames of the highlight's pulse on both
 * sides, and what each submitted to the GPU is asserted equal before their
 * pixels (`helpers/gl-submissions.mjs`): the frame right after a restore is
 * drawn whole, a later pulse frame of a multisampled scene draws again only
 * under the rings (`pulse-sample-mask.js`), and the frame read once can stand on
 * one side for the other (a pixel off by one).
 */

async function openWithKeptViewAndHighlights(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await openCollapsedPanels(page);
  await page.evaluate(() => document.getElementById('split-keep-view-btn').click());
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getSnapshotViews().length)).toBe(1);
  await page.evaluate(() => {
    const select = document.getElementById('view-layout-mode');
    select.value = 'grid';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const state = window._cellucidState;
    const cells = Uint32Array.from({ length: 40 }, (_, index) => index * 3);
    state.addHighlightDirect({ type: 'annotation', label: 'restore', cellIndices: cells });
    // A pinned pulse phase: the rings draw the same at every capture.
    window._cellucidViewer.setHighlightAnimationTime(0.25);
  });
}

/**
 * Nothing but the (pinned) highlight pulse still changes the frame, the last
 * change has been drawn, and every view is on its final geometry (trees
 * adopted). The cause of the last frame drawn says nothing of a frame still
 * owed: right after a restore it is still the pulse of the frames before the
 * loss, the restored context has drawn nothing yet, and a capture then reads
 * every pixel back as 0 (Linux WebKit).
 */
async function settle(page) {
  await expect.poll(
    () => page.evaluate(() => {
      const viewer = window._cellucidViewer;
      const schedule = viewer.getFrameScheduleState();
      const onlyThePulse = schedule.animationCause === 'highlight' && !schedule.invalidated && !schedule.canvasResized;
      return (schedule.settled || onlyThePulse) && viewer.isPresentedGeometrySettled();
    }),
    { timeout: 60_000 },
  ).toBe(true);
}

/**
 * What the canvas shows in a steady frame of the pulse, with each pane's
 * camera and what the frame submitted, kept in the page.
 */
function capture(page, name) {
  return page.evaluate(async key => {
    const viewer = window._cellucidViewer;
    const gl = viewer.getGLContext();
    const submissions = window.__submissions;
    await submissions.steadyPulseFrame(submissions.frames);
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const pixels = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    window.__restoreCaptures ??= {};
    window.__restoreCaptures[key] = {
      width,
      height,
      pixels,
      submitted: submissions.last,
      panes: viewer.getPresentedLayout().panes.map(pane => ({
        viewId: pane.viewId,
        rect: [pane.viewportX, pane.viewportY, pane.viewportWidth, pane.viewportHeight],
        camera: viewer.getViewCameraState(pane.viewId),
      })),
    };
    const state = window._cellucidState;
    // What decides the order the cells are drawn in.
    const status = viewer.debugRendererStatus();
    return {
      drawn: {
        adaptiveLOD: status.useAdaptiveLOD,
        frustumCulling: status.useFrustumCulling,
        forceLOD: status.forceLODLevel,
        drawOrder: status.drawOrder,
      },
      views: viewer.getSnapshotViews().map(view => view.id),
      highlighted: state.getTotalHighlightedCellCount(),
      filtered: state.getFilteredCount(),
      field: state.getActiveField()?.key ?? null,
    };
  }, name);
}

/** The first difference between what two captures' frames submitted, or null. */
function submittedDifference(page, left, right) {
  return page.evaluate(([a, b]) => window.__submissions.difference(
    window.__restoreCaptures[a].submitted,
    window.__restoreCaptures[b].submitted,
  ), [left, right]);
}

/** Where two captures differ, pane by pane (the first few pixels named). */
function differences(page, left, right) {
  return page.evaluate(([a, b]) => {
    const before = window.__restoreCaptures[a];
    const after = window.__restoreCaptures[b];
    if (before.width !== after.width || before.height !== after.height) {
      return [{ canvas: [before.width, before.height, after.width, after.height] }];
    }
    const layout = capture => capture.panes;
    if (JSON.stringify(layout(before)) !== JSON.stringify(layout(after))) {
      return [{ layout: [before.panes, after.panes] }];
    }
    const found = [];
    for (const pane of before.panes) {
      const [x0, y0, width, height] = pane.rect;
      let count = 0;
      const first = [];
      for (let y = y0; y < y0 + height; y++) {
        for (let x = x0; x < x0 + width; x++) {
          const at = (y * before.width + x) * 4;
          for (let c = 0; c < 4; c++) {
            if (before.pixels[at + c] !== after.pixels[at + c]) {
              count += 1;
              if (first.length < 4) first.push({ x, y, before: Array.from(before.pixels.subarray(at, at + 4)), after: Array.from(after.pixels.subarray(at, at + 4)) });
              break;
            }
          }
        }
      }
      if (count > 0) found.push({ viewId: pane.viewId, count, first });
    }
    return found;
  }, [left, right]);
}

/** Lose the context through WEBGL_lose_context; resolves once the viewer has fenced it. */
function loseContext(page) {
  return page.evaluate(async () => {
    const canvas = document.querySelector('#glcanvas');
    const gl = window._cellucidViewer.getGLContext();
    const extension = gl.getExtension('WEBGL_lose_context');
    if (extension === null) throw new Error('WEBGL_lose_context is unavailable.');
    window.__loseContext = extension;
    const lost = new Promise(resolve => canvas.addEventListener('webglcontextlost', resolve, { once: true }));
    extension.loseContext();
    await lost;
  });
}

/**
 * The app's graphics-reset dialog (`app/graphics-reset-session.js`; the
 * renderer only reports the phases): its words and shown buttons, or
 * null while closed. It is modal and keeps Escape: the page behind is inert.
 */
function notice(page) {
  return page.evaluate(() => {
    const dialog = document.getElementById('graphics-reset-dialog');
    if (dialog === null || !dialog.open || !dialog.matches(':modal')) return null;
    const buttons = [...dialog.querySelectorAll('button')]
      .filter(button => !button.hidden)
      .map(button => button.textContent);
    return { text: dialog.textContent, buttons, focused: document.activeElement?.textContent ?? null };
  });
}

for (const background of ['studio', 'black']) {
test(`a lost context is restored in place: the same pixels, kept views, highlights and filters (${background} background)`, async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(labelProgramsBySource);
  await openWithKeptViewAndHighlights(page);
  // Black has nothing drawn over the clear color: the background is the
  // context's clear color itself.
  await page.locator('#background-select').selectOption(background);
  await settle(page);
  await page.evaluate(recordSubmissions);
  const before = await capture(page, 'before');
  expect(before.views).toHaveLength(1);
  expect(before.highlighted).toBe(40);

  await loseContext(page);
  expect(await page.evaluate(() => window._cellucidViewer.isContextLost())).toBe(true);
  // Restoring: the captured session is offered, Reload is not.
  const restoring = await notice(page);
  expect(restoring.buttons).toEqual(['Save session']);
  expect(restoring.text).toMatch(/Restoring them/);
  expect(restoring.focused).toBe('Save session');
  // Escape leaves it open: nothing behind it can be used until the graphics are back.
  await page.keyboard.press('Escape');
  expect(await notice(page)).not.toBe(null);

  await page.evaluate(async () => {
    const canvas = document.querySelector('#glcanvas');
    const restored = new Promise(resolve => canvas.addEventListener('webglcontextrestored', resolve, { once: true }));
    window.__loseContext.restoreContext();
    await restored;
  });
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.isContextLost())).toBe(false);
  expect(await notice(page)).toBe(null);
  await settle(page);
  const after = await capture(page, 'after');
  expect(after).toEqual(before);
  // The same draws with the same programs, ranges, viewports and uniforms.
  expect(await submittedDifference(page, 'before', 'after'), 'what the two frames submitted').toBeNull();
  expect(await differences(page, 'before', 'after')).toEqual([]);

  // The restored renderer works on: a click picks a cell, a new kept view is drawn.
  await page.evaluate(() => document.getElementById('split-keep-view-btn').click());
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getSnapshotViews().length)).toBe(2);
  await settle(page);
  expect(pageErrors).toEqual([]);
});
}

test('a restored context shows the backdrop look it had, moving by itself as before', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await openWithKeptViewAndHighlights(page);
  const look = 'nebula';
  await page.locator('#background-select').selectOption(look);
  const shown = () => page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const diagnostics = viewer.getBackdropLookDiagnostics();
    const clear = Array.from(viewer.getGLContext().getParameter(WebGL2RenderingContext.COLOR_CLEAR_VALUE), value => Math.round(value * 255));
    return { activeId: diagnostics.activeId, opacity: diagnostics.opacity, queued: diagnostics.jobsQueued, clear };
  });
  await expect.poll(shown, { timeout: 60_000 }).toEqual(expect.objectContaining({ activeId: look, opacity: 1, queued: 0 }));
  const before = await shown();
  // The look moves by itself once asked to (no reduced motion here).
  await page.evaluate(() => window._cellucidViewer.setBackdropAmbientMotion(true));
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getBackdropLookDiagnostics().ambient)).toBe(true);

  await loseContext(page);
  await restoreContext(page);
  // The motion the page asked for comes back with the context.
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getBackdropLookDiagnostics().ambient)).toBe(true);
  // The look bakes again on the restored context and is shown as before, over
  // the same clear color. Waited for still, as before the loss: moving, every
  // frame draws the look again, and on hosted macOS Firefox a frame of it takes
  // about a minute (`helpers/hosted-gl.mjs`), so its
  // fade-in (0.35 s of frames) outlasts any wait there. What is restored is the same either way.
  await page.evaluate(() => window._cellucidViewer.setBackdropAmbientMotion(false));
  await expect.poll(shown, { timeout: 60_000 }).toEqual(before);
  expect(pageErrors).toEqual([]);
});

/** Restore the context lost by `loseContext`; resolves once the viewer has it back. */
async function restoreContext(page) {
  await page.evaluate(async () => {
    const canvas = document.querySelector('#glcanvas');
    const restored = new Promise(resolve => canvas.addEventListener('webglcontextrestored', resolve, { once: true }));
    window.__loseContext.restoreContext();
    await restored;
  });
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.isContextLost())).toBe(false);
}

test.describe('on a GPU that takes 500 ms a frame of every cell and 100 ms a culled one', () => {
  // Times far above any frame's own script on any runner, so each frame
  // lasts its GPU time exactly (a frame lasts the longer of the two,
  // `full-detail-frame-cost.js`).
  test.use({ device: { gpu: { frameMs: 500, culledMs: 100 } } });

  test('a restored context is measured afresh: the page\'s own culling goes off, is turned on again and verified', async ({ page }) => {
    test.setTimeout(180_000);
    // What the viewer reports, with the culling box once the page acted on it.
    const reports = await recordFrameCost(page);
    await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
    // The opening done, its published view applied: a camera set before
    // it is undone by the sample's own view, and the zoomed framing is
    // never measured.
    await waitForPageAtRest(page);
    const kept = {
      culling: true,
      tip: 'Turned on for this dataset: a frame of every cell took 500 ms on this device, over the 33 ms that keeps moving the view smooth, and 100 ms with frustum culling. Turn either off to draw every cell.',
    };
    // Zoomed in, so cells leave the view: culling is tried only where it can
    // leave a cell out (a framing that holds every cell is not measured,
    // `presentedDrawsFewer`, rendering/viewer.js).
    await page.evaluate(() => {
      const viewer = window._cellucidViewer;
      const camera = structuredClone(viewer.getCameraState());
      camera.orbit.radius *= 0.1;
      camera.orbit.targetRadius = camera.orbit.radius;
      viewer.setCameraState(camera);
    });
    await expectPerformance(page, kept);

    const mark = (await reports()).length;
    await loseContext(page);
    await restoreContext(page);
    // The restored context's opening: said first (the choice goes off for it),
    // measured with every cell drawn (too slow: the choice on again), then
    // verified with it on, and kept.
    await expect.poll(async () => (await reports()).slice(mark).map(({ kind, verdict, culling }) => ({ kind, verdict, culling })), { timeout: 60_000 })
      .toEqual([
        { kind: 'measuring', verdict: null, culling: false },
        { kind: 'too-slow', verdict: null, culling: true },
        { kind: 'verified', verdict: 'faster', culling: true },
      ]);
    const openings = (await reports()).slice(mark).map(event => event.opening);
    expect(new Set(openings).size, 'one opening').toBe(1);
    await expectPerformance(page, kept);
  });
});

test('a context that cannot be restored leaves the session saved and offers Reload', async ({ page }) => {
  test.setTimeout(180_000);
  await openWithKeptViewAndHighlights(page);
  await settle(page);
  await loseContext(page);
  const download = page.waitForEvent('download');
  await page.evaluate(async () => {
    const canvas = document.querySelector('#glcanvas');
    // The restored context refuses every vertex array while the viewer
    // rebuilds (its restore runs in the event, before this listener).
    const prototype = WebGL2RenderingContext.prototype;
    const create = prototype.createVertexArray;
    prototype.createVertexArray = () => null;
    const restored = new Promise(resolve => canvas.addEventListener('webglcontextrestored', resolve, { once: true }));
    window.__loseContext.restoreContext();
    await restored;
    prototype.createVertexArray = create;
  });
  const saved = await download;
  await expectDownloadNamed(saved, /^cellucid-session-.*\.cellucid-session$/);
  await expect.poll(() => notice(page)).toEqual(expect.objectContaining({ buttons: ['Save session', 'Reload'] }));
  expect((await notice(page)).text).toMatch(/could not be restored/);
  expect(await page.evaluate(() => window._cellucidViewer.isContextLost())).toBe(true);
});
