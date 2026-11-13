/**
 * Under `prefers-reduced-motion: reduce` the camera moves only while the
 * person moves it: a drag released fast does not glide on, and a zoom
 * arrives at once (viewer.js `updateInertia`, `updateSmoothZoom`,
 * `updateFreefly`). Without the preference both glide; a change of the
 * setting mid-glide stops it at once.
 */
import { closeContextWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { sceneQuietness } from './helpers/frame-scheduling.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=camera-glide-reduced-motion`;

async function frames(page, count) {
  await page.evaluate(n => new Promise(resolve => {
    const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  }), count);
}

const camera = page => page.evaluate(() => JSON.stringify(window._cellucidViewer.getCameraState()));

/**
 * A fast drag across the canvas, released at once: every event in one task,
 * so the release always lands inside the window that hands it to inertia.
 */
function flick(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('glcanvas');
    const rect = canvas.getBoundingClientRect();
    const x = rect.left + rect.width * 0.6;
    const y = rect.top + rect.height / 2;
    const at = (type, target, dx) => target.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: type === 'mouseup' ? 0 : 1,
      clientX: x + dx, clientY: y,
    }));
    at('mousedown', canvas, 0);
    for (let step = 1; step <= 4; step += 1) at('mousemove', window, step * 24);
    at('mouseup', window, 96);
  });
}

async function open(browser, reducedMotion) {
  const context = await browser.newContext({ reducedMotion, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await expect.poll(() => sceneQuietness(page), { timeout: 60_000 }).toBe('quiet');
  return { context, page };
}

// One opening: the page starts without the preference, is asked for reduced
// motion in the middle of a glide, and stays under it for the second step.
test('a flick glides until reduced motion is asked for; under it nothing glides and a zoom arrives at once', async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await open(browser, 'no-preference');
  try {
    await test.step('without the preference a flick glides on, and asking for reduced motion stops it at once', async () => {
      await flick(page);
      await frames(page, 1);
      const released = await camera(page);
      await frames(page, 4);
      expect(await camera(page), 'the camera glides after the release').not.toBe(released);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await frames(page, 2);
      const stopped = await camera(page);
      await frames(page, 6);
      expect(await camera(page), 'stopped when the setting changed').toBe(stopped);
    });

    await test.step('under reduced motion a flick stops at the release and a zoom arrives at once', async () => {
      await expect.poll(() => sceneQuietness(page), { timeout: 60_000 }).toBe('quiet');
      await flick(page);
      await frames(page, 1);
      const released = await camera(page);
      await frames(page, 8);
      expect(await camera(page), 'no glide after the release').toBe(released);
      expect(
        await page.evaluate(() => window._cellucidViewer.getFrameScheduleState().animationCause) ?? 'nothing',
        'no inertia animates after the release (null: nothing animates)',
      ).not.toMatch(/inertia/);

      // A zoom asked for (its target radius moved): there on the next frame.
      await page.evaluate(() => {
        const viewer = window._cellucidViewer;
        const state = viewer.getCameraState();
        state.orbit.targetRadius = state.orbit.radius * 1.5;
        viewer.setCameraState(state);
      });
      await frames(page, 2);
      const orbit = await page.evaluate(() => window._cellucidViewer.getCameraState().orbit);
      expect(orbit.radius).toBe(orbit.targetRadius);
      await expect.poll(() => sceneQuietness(page), { timeout: 60_000 }).toBe('quiet');
    });
  } finally {
    await closeContextWithApplicationRetirement(context);
  }
});
