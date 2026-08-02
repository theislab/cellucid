import { expect, test } from './helpers/test.mjs';

import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=presented-state-events-ci`;

test('camera motion publishes one bounded burst and unsubscribe is exact', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );

  await page.evaluate(async () => {
    const waitForFrames = count => new Promise(resolve => {
      const advance = () => {
        if (count <= 0) {
          resolve();
          return;
        }
        count -= 1;
        requestAnimationFrame(advance);
      };
      requestAnimationFrame(advance);
    });
    const events = [];
    const unsubscribe =
      window._cellucidViewer.onPresentedViewStateChanged(event => {
        events.push(event);
      });
    Object.defineProperty(window, '__presentedStateAcceptance', {
      configurable: true,
      value: {
        events,
        unsubscribe,
        waitForFrames,
      },
    });
    // Establish the subscriber's scalar frame baseline before motion.
    await waitForFrames(3);
  });

  // Match cinematic playback: publish a different exact camera state on
  // successive animation frames. This must still be one observer burst.
  await page.evaluate(async () => {
    const acceptance = window.__presentedStateAcceptance;
    const viewer = window._cellucidViewer;
    const initial = viewer.getCameraState();
    for (let step = 1; step <= 8; step += 1) {
      await acceptance.waitForFrames(1);
      viewer.setCameraState({
        navigationMode: initial.navigationMode,
        orbit: {
          radius: initial.orbit.radius,
          targetRadius: initial.orbit.targetRadius,
          theta: initial.orbit.theta + (step * 0.01),
          phi: initial.orbit.phi,
          target: [...initial.orbit.target],
        },
        freefly: {
          position: [...initial.freefly.position],
          yaw: initial.freefly.yaw + (step * 0.01),
          pitch: initial.freefly.pitch,
        },
      });
    }
  });

  await expect.poll(
    () => page.evaluate(() => (
      window.__presentedStateAcceptance.events.filter(
        event => event.reason === 'camera-settled',
      ).length
    )),
  ).toBe(1);

  const burst = await page.evaluate(() => (
    window.__presentedStateAcceptance.events
      .map(event => ({
        frozen: Object.isFrozen(event),
        generation: event.generation,
        keys: Object.keys(event).sort(),
        reason: event.reason,
        viewId: event.viewId,
      }))
  ));
  expect(burst).toHaveLength(2);
  expect(burst.map(event => event.reason)).toEqual([
    'camera-changing',
    'camera-settled',
  ]);
  expect(burst[0].generation).toBeLessThan(burst[1].generation);
  for (const event of burst) {
    expect(event.frozen).toBe(true);
    expect(event.keys).toEqual(['generation', 'reason', 'viewId']);
    expect(event.viewId).toBe('live');
  }

  const unsubscribeProof = await page.evaluate(async () => {
    const acceptance = window.__presentedStateAcceptance;
    acceptance.unsubscribe();
    acceptance.unsubscribe();
    const eventCount = acceptance.events.length;
    const viewer = window._cellucidViewer;
    viewer.setCameraState(viewer.getCameraState());
    await acceptance.waitForFrames(12);
    return {
      after: acceptance.events.length,
      before: eventCount,
    };
  });
  expect(unsubscribeProof.after).toBe(unsubscribeProof.before);
  expect(pageErrors).toEqual([]);
});
