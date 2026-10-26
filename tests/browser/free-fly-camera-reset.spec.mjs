import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const PREPARED_DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=free-fly-camera-reset`;

function readPose(page) {
  return page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const state = viewer.getCameraState();
    const { position, yaw, pitch } = state.freefly;
    const forward = [
      Math.cos(pitch) * Math.cos(yaw),
      Math.sin(pitch),
      Math.cos(pitch) * Math.sin(yaw),
    ];
    const toTarget = state.orbit.target.map((value, index) => value - position[index]);
    const length = Math.hypot(...toTarget);
    return {
      mode: viewer.getNavigationMode(),
      alignment: forward.reduce(
        (sum, value, index) => sum + value * (toTarget[index] / length),
        0,
      ),
      theta: state.orbit.theta,
      phi: state.orbit.phi,
      radius: state.orbit.radius,
    };
  });
}

test('R in free-fly frames the data, and Reset Camera gives one framing from every mode', async ({ page }) => {
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');

  await page.locator('#navigation-mode').selectOption('free');
  await expect.poll(async () => (await readPose(page)).mode).toBe('free');
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('r');

  const freeReset = await readPose(page);
  expect(freeReset.mode).toBe('free');
  expect(freeReset.alignment).toBeGreaterThan(0.999999);

  // The button resets the camera and returns to the default navigation mode;
  // coming from free-fly it must land on the same orbit angles as from orbit.
  await page.locator('#reset-camera-btn').click();
  const fromFree = await readPose(page);
  expect(fromFree.mode).not.toBe('free');
  await page.locator('#reset-camera-btn').click();
  const fromDefault = await readPose(page);
  // Free-fly positions are float32 vectors, so the round trip is exact to
  // float32 precision, not float64.
  expect(fromFree.theta).toBeCloseTo(fromDefault.theta, 6);
  expect(fromFree.phi).toBeCloseTo(fromDefault.phi, 6);
  expect(fromFree.radius).toBeCloseTo(fromDefault.radius, 6);
});
