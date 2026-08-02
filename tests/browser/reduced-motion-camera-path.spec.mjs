import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
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

  await page.locator('#cinematic-set-all-duration').fill('2');
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
  // `setCameraState` is synchronous, while its pixels belong to the next
  // viewer frame. Wait through two animation boundaries so the first idle
  // screenshot cannot capture the previous camera on a slower renderer.
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function playAndMeasure(page) {
  const idle = new Set();
  idle.add(await hashCanvas(page));
  await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  idle.add(await hashCanvas(page));

  const playButton = page.locator('.cinematic-play-btn');
  // Keep the auto-hiding transport bar interactive.
  await page.mouse.move(VIEWPORT.width - 120, VIEWPORT.height / 2);
  await expect(playButton).toBeEnabled();
  await playButton.click();

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

test('camera path playback honours a reduced-motion preference', async ({
  browser
}) => {
  const measurements = {};
  const errors = {};

  for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({
      reducedMotion,
      viewport: VIEWPORT,
    });
    const page = await context.newPage();
    errors[reducedMotion] = observeProductErrors(page);
    try {
      await preparePath(page);
      expect(
        await page.evaluate(
          () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
        )
      ).toBe(reducedMotion === 'reduce');
      measurements[reducedMotion] = await playAndMeasure(page);
    } finally {
      await context.close();
    }
  }

  // Idle is still: any motion measured below belongs to the camera path.
  expect(measurements['no-preference'].idleFrames).toBe(1);
  expect(measurements.reduce.idleFrames).toBe(1);

  // Without a stated preference the path animates.
  expect(measurements['no-preference'].framesWhilePlaying).toBeGreaterThan(1);

  // With one, it does not animate at all...
  expect(measurements.reduce.framesWhilePlaying).toBe(1);

  // ...and still arrives at the exact camera the animation would have reached.
  expect(measurements.reduce.finalCamera).toEqual(
    measurements['no-preference'].finalCamera
  );

  expect(errors['no-preference']).toEqual([]);
  expect(errors.reduce).toEqual([]);
});
