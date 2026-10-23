import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const PREPARED_DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=view-focus-camera-ownership`;

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  return errors;
}

function badge(page, pill) {
  return page.locator('.split-badge').filter({
    has: page.locator('.split-badge-pill', { hasText: new RegExp(`^${pill}$`) }),
  });
}

async function openTwoUnlockedPanes(page) {
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('.split-badge')).toHaveCount(2);
  await page.locator('#camera-lock-btn').click();
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.getCamerasLocked()),
  ).toBe(false);
  await badge(page, 1).click();
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.getViewLayout().activeId),
  ).toBe('live');
  return page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const snapshotId = viewer.getSnapshotViews()[0].id;
    return { snapshotId, live: viewer.getCameraState() };
  });
}

async function moveFocusedSnapshotCamera(page) {
  await badge(page, 2).click();
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.getViewLayout().activeId),
  ).not.toBe('live');
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const camera = viewer.getCameraState();
    camera.orbit.theta = (camera.orbit.theta + 1.3) % (Math.PI * 2);
    camera.orbit.radius *= 1.7;
    camera.orbit.targetRadius = camera.orbit.radius;
    viewer.setCameraState(camera);
  });
}

function expectSameOrbit(actual, expected) {
  expect(actual.navigationMode).toBe(expected.navigationMode);
  expect(actual.orbit.theta).toBeCloseTo(expected.orbit.theta, 6);
  expect(actual.orbit.phi).toBeCloseTo(expected.orbit.phi, 6);
  expect(actual.orbit.radius).toBeCloseTo(expected.orbit.radius, 6);
  for (let axis = 0; axis < 3; axis++) {
    expect(actual.orbit.target[axis]).toBeCloseTo(expected.orbit.target[axis], 6);
  }
}

test('removing the focused snapshot with unlocked cameras restores the live camera', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  const { live } = await openTwoUnlockedPanes(page);
  await moveFocusedSnapshotCamera(page);

  await badge(page, 2).locator('.split-badge-remove').click();
  await expect(page.locator('.split-badge')).toHaveCount(1);

  const after = await page.evaluate(() => ({
    camera: window._cellucidViewer.getCameraState(),
    stored: window._cellucidViewer.getViewCameraState('live'),
  }));
  expectSameOrbit(after.camera, live);
  expectSameOrbit(after.stored, live);
  expect(productErrors).toEqual([]);
});

test('clearing snapshots while one is focused restores the live camera', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  const { live } = await openTwoUnlockedPanes(page);
  await moveFocusedSnapshotCamera(page);

  await page.locator('#split-clear-btn').click();
  await expect(page.locator('#split-view-badges-box')).toBeHidden();

  const camera = await page.evaluate(() => window._cellucidViewer.getCameraState());
  expectSameOrbit(camera, live);
  expect(productErrors).toEqual([]);
});

test('a focus change does not carry the outgoing pane inertia into the incoming pane', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  const { snapshotId } = await openTwoUnlockedPanes(page);

  const proof = await page.evaluate(async id => {
    const viewer = window._cellucidViewer;
    const frames = count => new Promise(resolve => {
      const step = remaining => {
        if (remaining === 0) resolve();
        else requestAnimationFrame(() => step(remaining - 1));
      };
      step(count);
    });
    const cameraOf = () => JSON.stringify(viewer.getCameraState());
    // Navigation keys build camera velocity on the focused (live) pane.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd' }));
    await frames(8);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', key: 'd' }));
    const liveBefore = cameraOf();
    await frames(1);
    const liveStillGliding = cameraOf() !== liveBefore;
    viewer.setViewLayout('grid', id);
    const incoming = cameraOf();
    await frames(10);
    return { liveStillGliding, incoming, settled: cameraOf(), mode: viewer.getNavigationMode() };
  }, snapshotId);

  expect(proof.liveStillGliding, JSON.stringify(proof)).toBe(true);
  expect(JSON.parse(proof.settled)).toEqual(JSON.parse(proof.incoming));
  expect(productErrors).toEqual([]);
});
