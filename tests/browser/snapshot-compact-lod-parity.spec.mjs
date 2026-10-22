/**
 * A kept view draws a reduced level exactly as the live view draws it.
 *
 * Both draw the level's prefix of the geometry's stored draw order (the
 * snapshot from its own colour store, gathered into the same order), so a
 * snapshot of the live view, at the same reduced level and camera, must
 * produce the live view's pixels byte for byte -- with and without frustum
 * culling, and with translucent points, whose blend order would expose any
 * change in draw order. No path draws through an element buffer.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { pixelParityVerdict } from './helpers/pixel-parity.mjs';

const FIXTURE_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}` +
  '&dataset=current-ui-prepared&acceptance=snapshot-compact-lod-parity-ci';
// Large enough that the spatial index builds a deep ladder of reduced levels.
const POINT_COUNT = 60_000;
const REDUCED_LEVEL = 6;

test('a snapshot draws a reduced LOD level with the live view pixels and no element-buffer gather', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await page.locator('#benchmark-section > summary').click();
  await page.locator('#benchmark-count').fill(String(POINT_COUNT));
  await page.locator('#benchmark-pattern').selectOption('atlas');
  await page.locator('#benchmark-run').click();
  await expect
    .poll(() => page.evaluate(() => window._cellucidState.pointCount), {
      timeout: 120_000,
    })
    .toBe(POINT_COUNT);
  await page.locator('#split-keep-view-btn').click();
  await expect
    .poll(() => page.evaluate(
      () => window._cellucidViewer.getSnapshotViews().length,
    ))
    .toBe(1);

  const result = await page.evaluate(async ({ pointCount, level }) => {
    const viewer = window._cellucidViewer;
    const gl = viewer.getGLContext();
    const snapshotId = viewer.getSnapshotViews()[0].id;
    const frames = count => new Promise(resolve => {
      const step = () => (count-- <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    const draws = { arrays: 0, elements: 0 };
    const drawArrays = gl.drawArrays;
    const drawElements = gl.drawElements;
    // Point draws only: the grid and other overlays draw other primitives.
    gl.drawArrays = function countedDrawArrays(...args) {
      if (args[0] === gl.POINTS) draws.arrays += 1;
      return drawArrays.apply(this, args);
    };
    gl.drawElements = function countedDrawElements(...args) {
      if (args[0] === gl.POINTS) draws.elements += 1;
      return drawElements.apply(this, args);
    };

    // A scattered per-point visibility pattern makes any wrong source-order
    // alpha lookup visible in the pixels (a wrong index hides or shows a
    // different point). Both views receive the same alpha, and the same camera.
    const alpha = new Uint8Array(pointCount);
    for (let index = 0; index < pointCount; index++) {
      alpha[index] = (((index * 2654435761) >>> 0) % 1000) < 700 ? 1 : 0;
    }
    viewer.updateTransparency(alpha);
    viewer.updateSnapshotAttributes(snapshotId, { transparency: alpha });
    viewer.setPointSize(6);
    viewer.setAdaptiveLOD(true);
    viewer.setForceLOD(level);

    // Pixels are compared only once nothing is still animating: a backdrop
    // crossfade (a 3-D dataset replacing a 2-D one moves the studio surface
    // from dots to floor) would otherwise differ between the two captures.
    const settled = async () => {
      for (let attempt = 0; attempt < 600; attempt += 1) {
        // Settled, not merely still: a frame still owed (a draw order that
        // waits its turn to be adopted, one a frame) asks for another frame
        // without an animation, and a capture taken before it compares a
        // pane drawn in its previous order.
        if (viewer.getFrameScheduleState().settled) return;
        await frames(1);
      }
      throw new Error(`Scene never settled: ${JSON.stringify(viewer.getFrameScheduleState())}`);
    };
    // The snapshot takes the live camera only once the live camera is final:
    // publishing the synthetic dataset starts a zoom that eases toward its
    // target over frames, and a copy taken mid-ease (seconds of frames on a
    // slow renderer, microseconds on hardware) gave the two views cameras
    // that differed in the last digits and a handful of edge pixels.
    await settled();
    viewer.setViewCameraState(snapshotId, viewer.getViewCameraState('live'));
    const cameraOf = viewId => JSON.stringify(viewer.getViewCameraState(viewId));
    if (cameraOf(snapshotId) !== cameraOf('live')) {
      throw new Error(`The snapshot did not take the live camera: ${cameraOf(snapshotId)} vs ${cameraOf('live')}`);
    }
    const capture = async (viewId, culling) => {
      viewer.setFrustumCulling(culling);
      viewer.setViewLayout('single', viewId);
      await frames(4);
      // The LOD levels are built off the main thread; until they land a view
      // draws full detail (level -1) and has nothing left to animate, so a
      // settled scene is no sign the forced level is drawn. On a macOS WebKit
      // runner the live capture came before the levels did.
      const levelDeadline = performance.now() + 120_000;
      while (viewer.getRendererStats(viewId).lodLevel !== level) {
        if (performance.now() > levelDeadline) {
          throw new Error(`"${viewId}" never drew LOD level ${level}.`);
        }
        await frames(1);
      }
      await settled();
      draws.arrays = 0;
      draws.elements = 0;
      // One more invalidated frame, counted alone.
      viewer.setPointSize(6);
      await frames(1);
      const counted = { ...draws };
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const stats = viewer.getRendererStats(viewId);
      return {
        camera: cameraOf(viewId),
        counted,
        lodLevel: stats.lodLevel,
        pixels,
        visiblePoints: stats.visiblePoints,
        width,
      };
    };
    // Every mismatch, with where it is and by how much, so a failure says
    // whether a point moved (a camera or order difference: whole points,
    // large deltas) or the rasterizer rounded an edge differently.
    const compare = (left, right, width) => {
      let mismatched = 0;
      let lit = 0;
      let maxDelta = 0;
      const first = [];
      for (let index = 0; index < left.length; index += 4) {
        if (left[index + 3] !== 0) lit += 1;
        let delta = 0;
        for (let channel = 0; channel < 4; channel++) {
          delta = Math.max(delta, Math.abs(left[index + channel] - right[index + channel]));
        }
        if (delta === 0) continue;
        mismatched += 1;
        maxDelta = Math.max(maxDelta, delta);
        if (first.length < 8) {
          const pixel = index / 4;
          first.push([pixel % width, Math.floor(pixel / width), [...left.subarray(index, index + 4)], [...right.subarray(index, index + 4)]]);
        }
      }
      return { lit, mismatched, maxDelta, first };
    };

    const out = {};
    for (const culling of [false, true]) {
      const live = await capture('live', culling);
      const snapshot = await capture(snapshotId, culling);
      out[culling ? 'culled' : 'direct'] = {
        ...compare(live.pixels, snapshot.pixels, live.width),
        camerasMatch: live.camera === snapshot.camera,
        cameras: live.camera === snapshot.camera ? null : { live: live.camera, snapshot: snapshot.camera },
        liveLod: live.lodLevel,
        liveVisible: live.visiblePoints,
        snapshotDraws: snapshot.counted,
        snapshotLod: snapshot.lodLevel,
        snapshotVisible: snapshot.visiblePoints,
      };
    }
    gl.drawArrays = drawArrays;
    gl.drawElements = drawElements;
    return out;
  }, { pointCount: POINT_COUNT, level: REDUCED_LEVEL });

  for (const mode of ['direct', 'culled']) {
    const outcome = result[mode];
    expect(outcome.liveLod).toBe(REDUCED_LEVEL);
    expect(outcome.snapshotLod).toBe(REDUCED_LEVEL);
    expect(outcome.snapshotVisible).toBe(outcome.liveVisible);
    expect(outcome.liveVisible).toBeLessThan(POINT_COUNT);
    expect(outcome.lit).toBeGreaterThan(1_000);
    // The two views were drawn with the same camera, to the digit.
    expect(outcome.camerasMatch, `${mode}: ${JSON.stringify(outcome.cameras)}`).toBe(true);
    // Same data, same camera, same order: the picture may differ only by the
    // rasterizer's last bit (helpers/pixel-parity.mjs).
    expect(pixelParityVerdict(outcome, mode)).toBeNull();
  }
  // Without culling a reduced level is one sequential draw of the stored
  // prefix: the snapshot issues no indexed point draw at all.
  expect(result.direct.snapshotDraws.elements).toBe(0);
  expect(result.direct.snapshotDraws.arrays).toBeGreaterThan(0);
});
