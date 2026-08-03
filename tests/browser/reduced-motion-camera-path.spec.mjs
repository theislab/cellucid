import { createHash } from 'node:crypto';
import {
  closeContextWithApplicationRetirement,
  expect,
  test,
} from './helpers/test.mjs';
import {
  APP_ORIGIN,
  ENCODED_EXPORTS_BASE_URL,
} from './helpers/origins.mjs';

const PREPARED_DATASET_URL =
  `${APP_ORIGIN}/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=reduced-motion-camera-path-ci`;

const VIEWPORT = { width: 1440, height: 1000 };
const CANVAS_CLIP = { x: 420, y: 260, width: 480, height: 380 };
const SAMPLE_COUNT = 8;
const SAMPLE_INTERVAL_MS = 150;
// Sampling a frame is a full-viewport screenshot, and on a hosted runner with no
// GPU one costs far more than the 150 ms between samples. The path has to still
// be playing while all eight are taken, or every sample lands after the end,
// they all hash identically, and "it animated" reads as "it did not" — which is
// exactly how this failed on hosted macOS Firefox while passing everywhere else.
// Eight seconds leaves room for a screenshot an order of magnitude slower than
// on developer hardware, and the transport poll below allows thirty.
const PATH_DURATION_SECONDS = 8;

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      errors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return errors;
}

async function hashCanvas(page) {
  const buffer = await page.screenshot({ clip: CANVAS_CLIP });
  return createHash('sha256').update(buffer).digest('hex');
}

async function waitForViewerPaint(page) {
  // Camera publication is synchronous; the viewer consumes it on a later
  // animation frame. Two boundaries cover both the viewer frame and the
  // compositor handoff before a screenshot observes the result.
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

/**
 * Build a two-keyframe path with a known duration, then park the camera away
 * from both keyframes so "reached the end" is distinguishable from "stayed put".
 */
async function preparePath(page) {
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );

  await page.locator('#cinematic-camera-section').evaluate(element => {
    if (!(element instanceof HTMLDetailsElement)) {
      throw new TypeError('Camera Path section must be details');
    }
    element.open = true;
  });

  await page.locator('#cinematic-save-btn').click();
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const state = viewer.getCameraState();
    state.orbit.theta += 1.4;
    state.orbit.phi = 1.1;
    state.orbit.radius *= 1.9;
    state.orbit.targetRadius = state.orbit.radius;
    viewer.setCameraState(state);
  });
  await page.locator('#cinematic-save-btn').click();
  await expect(page.locator('.cinematic-keyframe-item')).toHaveCount(2);

  // Compare playback with the actual state captured by the production store,
  // rather than merely comparing the two preference modes with one another.
  // That proves both modes reach the saved endpoint even if they were ever to
  // regress in the same way.
  const expectedFinalCamera = await page.evaluate(() => {
    const keyframes = window._cellucidUi.cinematicCamera
      .getKeyframeStore()
      .getAll();
    if (keyframes.length !== 2) {
      throw new Error('Reduced-motion path must own exactly two keyframes.');
    }
    const endpoint = keyframes[1];
    return {
      navigationMode: endpoint.navigationMode,
      orbit: endpoint.orbit,
      freefly: endpoint.freefly,
    };
  });

  await page.locator('#cinematic-set-all-duration').fill(
    String(PATH_DURATION_SECONDS)
  );
  await page.locator('#cinematic-set-all-btn').click();

  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const state = viewer.getCameraState();
    state.orbit.theta -= 2.6;
    state.orbit.phi = 0.45;
    state.orbit.radius *= 0.35;
    state.orbit.targetRadius = state.orbit.radius;
    viewer.setCameraState(state);
  });
  await waitForViewerPaint(page);
  return expectedFinalCamera;
}

async function playAndMeasure(page, reducedMotion) {
  const idle = new Set();
  idle.add(await hashCanvas(page));
  await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  idle.add(await hashCanvas(page));

  const playButton = page.locator('.cinematic-play-btn');
  // Keep the auto-hiding transport bar interactive.
  await page.mouse.move(VIEWPORT.width - 120, VIEWPORT.height / 2);
  await expect(playButton).toBeEnabled();
  await playButton.click();
  // Reduced motion completes synchronously and never enters the playback
  // frame loop. Ordinary playback must remain active here. Assert that
  // semantic state separately from pixels, then wait until the synchronous
  // endpoint publication has reached the real canvas before sampling it.
  await expect(playButton).toHaveAttribute(
    'title',
    reducedMotion ? 'Play' : 'Pause',
  );
  await waitForViewerPaint(page);

  const framesWhilePlaying = new Set();
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    framesWhilePlaying.add(await hashCanvas(page));
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }

  await expect
    .poll(() => playButton.getAttribute('title'), { timeout: 30_000 })
    .toBe('Play');
  await page.waitForTimeout(300);

  return {
    finalCamera: await page.evaluate(
      () => window._cellucidViewer.getCameraState()
    ),
    framesWhilePlaying: framesWhilePlaying.size,
    idleFrames: idle.size,
  };
}

const PREFERENCE_CASES = Object.freeze([
  Object.freeze({
    preference: 'no-preference',
    reducedMotion: false,
    title: 'camera path animates without a reduced-motion preference',
  }),
  Object.freeze({
    preference: 'reduce',
    reducedMotion: true,
    title: 'camera path completes without animation for reduced motion',
  }),
]);

// Each preference owns a full real dataset bootstrap and GPU playback. Keeping
// them as separate contracts gives each independent operation the repository's
// normal timeout fence; combining both made the second operation inherit time
// already consumed by the first on hosted macOS Firefox.
for (const scenario of PREFERENCE_CASES) {
  test(scenario.title, async ({ browser }) => {
    // The browser-only fixture must stay lazy: this contract owns the one
    // context whose media preference it is proving.
    expect(browser.contexts()).toHaveLength(0);
    const context = await browser.newContext({
      reducedMotion: scenario.preference,
      viewport: VIEWPORT,
    });
    const page = await context.newPage();
    try {
      const errors = observeProductErrors(page);
      const expectedFinalCamera = await preparePath(page);
      expect(
        await page.evaluate(
          () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
        )
      ).toBe(scenario.reducedMotion);

      const measurement = await playAndMeasure(
        page,
        scenario.reducedMotion,
      );

      // Idle is still: any distinct frame measured below belongs to playback.
      expect(measurement.idleFrames).toBe(1);
      if (scenario.reducedMotion) {
        expect(measurement.framesWhilePlaying).toBe(1);
      } else {
        expect(measurement.framesWhilePlaying).toBeGreaterThan(1);
      }

      // Both execution paths must land on the exact state saved as keyframe 2.
      expect(measurement.finalCamera).toEqual(expectedFinalCamera);
      expect(errors).toEqual([]);
    } finally {
      await closeContextWithApplicationRetirement(context);
    }
  });
}
