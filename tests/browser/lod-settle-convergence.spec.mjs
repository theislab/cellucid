/**
 * Adaptive LOD keeps the scene drawing until it has converged, on its own
 * account.
 *
 * Hysteresis moves a view's LOD one level per drawn frame, so a camera jump
 * across several levels takes several frames to show its final level. The
 * viewer used to cover that with a blanket floor of twelve frames after every
 * change; it now names the convergence as a frame cause (`'lod'`) and the
 * floor covers only the frame that shows the change. This spec jumps the
 * camera far out in one step and checks that the scene keeps drawing for the
 * LOD, settles, and settles at the level the camera asks for: drawing more
 * frames from there changes nothing.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { loadSyntheticDataset } from './helpers/synthetic-dataset.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const FIXTURE_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}` +
  '&dataset=current-ui&acceptance=lod-settle-convergence-ci';
// Large enough that the spatial index builds a deep ladder of reduced levels.
const POINT_COUNT = 60_000;

test('a camera jump keeps drawing until the adaptive LOD reaches its level, then goes quiet', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await loadSyntheticDataset(page, { pointCount: POINT_COUNT, pattern: 'atlas' });

  const result = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const frames = count => new Promise(resolve => {
      const step = () => (count-- <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    const settled = async () => {
      for (let attempt = 0; attempt < 900; attempt += 1) {
        const state = viewer.getFrameScheduleState();
        if (state.settled && state.animationCause === null) return;
        await frames(1);
      }
      throw new Error(`Scene never settled: ${JSON.stringify(viewer.getFrameScheduleState())}`);
    };
    viewer.setAdaptiveLOD(true);
    // The LOD levels are built off the main thread, and until they land the
    // view draws full detail (level -1) with nothing left to draw: the scene
    // is settled while the build runs. On a software-GL runner it was still
    // running when the near level was read, so the near level was -1 and the
    // comparison below meaningless. The landed tree draws a frame of its own
    // (`onAsyncTreeReady`); wait for that level.
    const buildDeadline = performance.now() + 120_000;
    while (viewer.getCurrentLODLevel('live') < 0) {
      if (performance.now() > buildDeadline) {
        throw new Error('The live view never drew an adaptive LOD level.');
      }
      await frames(1);
    }
    await settled();
    const nearLevel = viewer.getCurrentLODLevel('live');

    // Jump far out in a single step: no zoom easing, so only the LOD's own
    // stepping can keep the scene drawing past the floor.
    const camera = structuredClone(viewer.getViewCameraState('live'));
    camera.orbit.radius *= 12;
    camera.orbit.targetRadius = camera.orbit.radius;
    viewer.setViewCameraState('live', camera);

    const causes = new Set();
    for (let attempt = 0; attempt < 900; attempt += 1) {
      await frames(1);
      const state = viewer.getFrameScheduleState();
      if (state.animationCause !== null) causes.add(state.animationCause);
      if (state.settled && state.animationCause === null) break;
    }
    const settledLevel = viewer.getCurrentLODLevel('live');

    // Drawing on from the settled state must not move the level: the scene
    // stopped at the fixed point, not partway.
    viewer.setPointSize(3);
    await frames(6);
    await settled();
    return {
      causes: [...causes],
      nearLevel,
      settledLevel,
      levelAfterMoreFrames: viewer.getCurrentLODLevel('live'),
    };
  });

  // More than one level apart, so reaching it took several frames.
  expect(
    result.nearLevel - result.settledLevel,
    'a far camera draws a level several steps coarser',
  ).toBeGreaterThan(1);
  expect(result.causes).toContain('lod');
  expect(result.levelAfterMoreFrames).toBe(result.settledLevel);
});
