/**
 * Frustum culling only skips work: a culled frame is the unculled frame.
 *
 * Points are stored in the draw order of their tree, and a culled frame draws
 * ranges of that storage in storage order, so it blends translucent points in
 * exactly the order the unculled frame does. (The store adopts its tree's
 * order once, when the tree first exists; from then on the order is the same
 * with culling on or off, which is what this compares.)
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { loadSyntheticDataset } from './helpers/synthetic-dataset.mjs';
import { pixelParityVerdict } from './helpers/pixel-parity.mjs';

const FIXTURE_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}` +
  '&dataset=current-ui&acceptance=frustum-culling-parity-ci';
// Large enough that the spatial index splits the cloud into many leaves.
const POINT_COUNT = 60_000;

test('a culled frame draws exactly the pixels of an unculled one', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await loadSyntheticDataset(page, { pointCount: POINT_COUNT, pattern: 'atlas' });

  const result = await page.evaluate(async pointCount => {
    const viewer = window._cellucidViewer;
    const gl = viewer.getGLContext();
    const frames = count => new Promise(resolve => {
      const step = () => (count-- <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    // Pixels are compared only once nothing is still animating: a backdrop
    // crossfade (a 3-D dataset replacing a 2-D one moves the studio surface
    // from dots to floor) would otherwise differ between the two captures.
    const settled = async () => {
      // Settled, not merely still: a frame still owed (a draw order that
      // waits its turn to be adopted, one a frame) asks for another frame
      // without an animation, and a capture taken before it compares a
      // pane drawn in its previous order. Frame by frame, as long as the
      // renderer takes: the test's timeout is the fence.
      while (!viewer.getFrameScheduleState().settled) await frames(1);
    };
    const capture = async culling => {
      viewer.setAdaptiveLOD(false);
      viewer.setFrustumCulling(culling);
      viewer.setPointSize(6);
      // Each change asks for its frame: the scene is not settled until the
      // frames showing them are drawn.
      await settled();
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    // A scattered hidden/shown pattern makes any culling path that reads the
    // wrong point's transparency visible in the pixels.
    viewer.updateTransparency(
      Uint8Array.from({ length: pointCount }, (_, index) => (index % 3 === 0 ? 0 : 1))
    );
    // Build the tree and let the store adopt its order first. The tree is
    // built in a worker, so it lands whenever it lands: a frame drawn before
    // the store adopted its order overlaps translucent points in another
    // order, and comparing it with one drawn after measures the adoption,
    // not culling. Culling runs only on an adopted order, so wait for it
    // (the store asks for its own frames once the tree lands), as long as
    // the worker takes: a count of frames ran out on a slow runner ("The
    // live store never adopted its tree order", Linux Firefox, push run of
    // 2026-10-31), and a clock is the same guess in other units.
    await capture(true);
    const adopted = () => viewer.getHPRenderer().getStats('live').frustumCulled === true
      && viewer.isPresentedGeometrySettled();
    while (!adopted()) await frames(1);
    await settled();
    const unculled = await capture(false);
    const culled = await capture(true);
    let mismatched = 0;
    let lit = 0;
    let maxDelta = 0;
    const first = [];
    const width = gl.drawingBufferWidth;
    for (let index = 0; index < unculled.length; index += 4) {
      if (unculled[index + 3] !== 0) lit += 1;
      let delta = 0;
      for (let channel = 0; channel < 4; channel++) {
        delta = Math.max(delta, Math.abs(unculled[index + channel] - culled[index + channel]));
      }
      if (delta === 0) continue;
      mismatched += 1;
      maxDelta = Math.max(maxDelta, delta);
      if (first.length < 8) {
        const pixel = index / 4;
        first.push([pixel % width, Math.floor(pixel / width), [...unculled.subarray(index, index + 4)], [...culled.subarray(index, index + 4)]]);
      }
    }
    const stats = viewer.getHPRenderer().getStats('live');
    return { lit, mismatched, maxDelta, first, culled: stats.frustumCulled === true };
  }, POINT_COUNT);

  expect(result.culled).toBe(true);
  expect(result.lit).toBeGreaterThan(1_000);
  // Same points, same camera, culled or not: the picture may differ only by
  // the rasterizer's last bit (helpers/pixel-parity.mjs).
  expect(pixelParityVerdict(result, 'culled vs unculled')).toBeNull();
});
