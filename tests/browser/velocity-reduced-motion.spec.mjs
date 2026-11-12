/**
 * F103: under `prefers-reduced-motion: reduce` the velocity overlay draws a
 * still picture of the flow (`stillFlowTrace`, velocity-overlay.js) and the
 * viewer requests no further frame once it is drawn; the picture is the same
 * every time it is traced (a camera moved away and back, the flow resumed and
 * stilled again); clearing the preference resumes the flow at once.
 */
import { createHash } from 'node:crypto';

import { closeContextWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { sceneQuietness } from './helpers/frame-scheduling.mjs';
import {
  VECTOR_DATASET,
  expectVelocityBuilt,
  listVectorDataset,
  watchVelocityBuild,
} from './helpers/vector-catalog.mjs';

const VIEWPORT = { width: 1440, height: 1000 };
// The middle of the plot, clear of the sidebar and the notification stack.
const CANVAS_CLIP = { x: 480, y: 240, width: 520, height: 420 };

async function canvasHash(page) {
  const buffer = await page.screenshot({ clip: CANVAS_CLIP });
  return createHash('sha256').update(buffer).digest('hex');
}

async function frames(page, count) {
  await page.evaluate(n => new Promise(resolve => {
    const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  }), count);
}

/** Settled, and the last frame asked for no next one, over several frames. */
async function stopped(page, message) {
  await expect.poll(() => sceneQuietness(page), { message, timeout: 60_000 }).toBe('quiet');
  const armed = () => page.evaluate(() => window._cellucidViewer.getFrameScheduleState().frameArmed);
  await frames(page, 2);
  expect(await armed(), `${message}: no frame requested`).toBe(false);
  await frames(page, 6);
  expect(await armed(), `${message}: still none`).toBe(false);
}

test('under reduced motion the velocity overlay is a still, repeatable picture that requests no frames', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: VIEWPORT });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  try {
    await listVectorDataset(page);
    await page.goto(
      `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=${VECTOR_DATASET.id}&acceptance=velocity-reduced-motion`,
      { waitUntil: 'domcontentloaded' },
    );
    await dismissWelcome(page);
    await openCollapsedPanels(page);
    await expect(page.locator('#dataset-name')).toHaveText(VECTOR_DATASET.name);
    await page.mouse.move(2, VIEWPORT.height - 2);
    await stopped(page, 'the plot before the overlay');
    const withoutOverlay = await canvasHash(page);

    await watchVelocityBuild(page);
    await page.locator('#velocity-overlay-enabled').check();
    await expectVelocityBuilt(page);
    await page.mouse.move(2, VIEWPORT.height - 2);
    await stopped(page, 'the still picture');
    const picture = await canvasHash(page);
    expect(picture, 'the still picture is drawn').not.toBe(withoutOverlay);
    expect(
      await page.evaluate(() => window._cellucidViewer.getFrameScheduleState().animationCause),
    ).toBeNull();

    // A camera moved away and back traces the picture again: the same one.
    const camera = await page.evaluate(() => window._cellucidViewer.getCameraState());
    await page.evaluate(() => {
      const viewer = window._cellucidViewer;
      // A zoom: the fixture's 2D view is Planar, where an orbit angle moves
      // nothing.
      const state = viewer.getCameraState();
      state.orbit.radius *= 1.4;
      state.orbit.targetRadius = state.orbit.radius;
      viewer.setCameraState(state);
    });
    await stopped(page, 'the picture for another camera');
    const turned = await canvasHash(page);
    expect(turned, 'another camera, another view of the picture').not.toBe(picture);
    await page.evaluate(state => window._cellucidViewer.setCameraState(state), camera);
    await stopped(page, 'the picture back at the first camera');
    expect(await canvasHash(page), 'the same picture, traced again').toBe(picture);

    // Clearing the preference resumes the flow at once; asking again stills
    // it into the same picture, whatever the flow did meanwhile.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(
      () => page.evaluate(() => window._cellucidViewer.getFrameScheduleState().animationCause),
      { message: 'the flow animates without the preference' },
    ).toBe('overlay-flow');
    await frames(page, 30);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stopped(page, 'stilled again');
    expect(await canvasHash(page), 'the same picture after the flow ran').toBe(picture);

    expect(errors).toEqual([]);
  } finally {
    await closeContextWithApplicationRetirement(context);
  }
});
