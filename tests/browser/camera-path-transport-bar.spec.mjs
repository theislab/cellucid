import { expect, test } from '@playwright/test';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const PREPARED_DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=camera-transport-ci`;

/* transport-bar.js hides the bar after this much inactivity. The assertions
   below deliberately straddle it instead of restating the constant. */
const HIDE_DELAY_MS = 10_000;

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

async function openCameraPathWithTwoKeyframes(page) {
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );
  await page.locator('#cinematic-camera-section > summary').click();
  await page.locator('#cinematic-save-btn').click();
  await page.locator('#cinematic-save-btn').click();
  await expect(page.locator('.cinematic-keyframe-item')).toHaveCount(2);
  await expect(page.locator('.cinematic-transport-bar')).toHaveCount(1);
}

test('the transport bar occupies a bounded strip and leaves the rest of the viewport clickable', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await openCameraPathWithTwoKeyframes(page);
  await expect(page.locator('.cinematic-transport-bar')).toHaveClass(/visible/);

  const layout = await page.evaluate(() => {
    const bar = document.querySelector('.cinematic-transport-bar');
    const inner = document.querySelector('.cinematic-transport-inner');
    const barBox = bar.getBoundingClientRect();
    const innerBox = inner.getBoundingClientRect();
    const sidebar = document.getElementById('sidebar').getBoundingClientRect();
    return {
      trackWidth: barBox.width,
      barWidth: innerBox.width,
      barLeft: innerBox.left,
      barRight: innerBox.right,
      barTop: innerBox.top,
      barHeight: innerBox.height,
      sidebarRight: sidebar.right,
      viewportWidth: window.innerWidth
    };
  });

  // The visible bar is a bounded strip, not the full viewport width.
  expect(layout.barWidth).toBeLessThanOrEqual(620);
  expect(layout.barWidth).toBeLessThan(layout.trackWidth);
  expect(layout.barWidth).toBeLessThan(layout.viewportWidth * 0.6);
  // It never overlaps the sidebar.
  expect(layout.barLeft).toBeGreaterThan(layout.sidebarRight);

  // The positioning track spans the viewport so the bar can centre inside it.
  // It must stay transparent to the pointer, or it swallows canvas clicks.
  const hitTests = await page.evaluate((box) => {
    const y = Math.round(box.barTop + box.barHeight / 2);
    const at = (x) => {
      const element = document.elementFromPoint(Math.round(x), y);
      return element === null
        ? null
        : {
          id: element.id,
          classes: element.getAttribute('class'),
          insideBar: element.closest('.cinematic-transport-bar') !== null
        };
    };
    return {
      rightOfBar: at(box.barRight + 30),
      leftOfBar: at(box.barLeft - 30),
      onBar: at(box.barLeft + 15)
    };
  }, layout);

  expect(hitTests.rightOfBar.insideBar).toBe(false);
  expect(hitTests.leftOfBar.insideBar).toBe(false);
  expect(hitTests.onBar.insideBar).toBe(true);

  expect(productErrors).toEqual([]);
});

test('sidebar work keeps the transport bar alive, and idle time still retires it', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await openCameraPathWithTwoKeyframes(page);

  const sidebarPoint = await page.evaluate(() => {
    const box = document.getElementById('cinematic-save-btn').getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  });

  // Working in the sidebar is activity: the Camera Path accordion that feeds
  // this bar lives there. Poking it well past the old 3 s deadline must not
  // let the bar disappear.
  const bar = page.locator('.cinematic-transport-bar');
  for (let step = 0; step < 4; step += 1) {
    await page.mouse.move(sidebarPoint.x + step, sidebarPoint.y + step);
    await page.waitForTimeout(2000);
    await expect(bar).toHaveClass(/visible/);
  }

  // A pointer resting on the bar itself holds it open indefinitely.
  await page.locator('.cinematic-transport-inner').hover();
  await page.waitForTimeout(HIDE_DELAY_MS + 2000);
  await expect(bar).toHaveClass(/visible/);

  // Move the pointer off every surface and let it go idle. It must survive
  // well past the old 3 s delay and then retire.
  await page.mouse.move(
    Math.round(page.viewportSize().width / 2),
    page.viewportSize().height - 20
  );
  await page.waitForTimeout(4000);
  await expect(bar).toHaveClass(/visible/);
  await expect(bar).not.toHaveClass(/visible/, { timeout: HIDE_DELAY_MS + 5000 });

  expect(productErrors).toEqual([]);
});

test('the Camera Path navigation block drives the viewer and mirrors Compare Views', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );
  await page.locator('#cinematic-camera-section > summary').click();

  // Driving the Camera Path select changes the live navigation mode and the
  // Compare Views select follows. These controls are wired, not decorative.
  for (const mode of ['orbit', 'free', 'planar']) {
    await page.locator('#cinematic-nav-mode').selectOption(mode);
    await expect(page.locator('#navigation-mode')).toHaveValue(mode);
    await expect(page.locator('#cinematic-nav-mode')).toHaveValue(mode);
  }

  // And the reverse: the Compare Views select updates the Camera Path mirror.
  for (const mode of ['orbit', 'free', 'planar']) {
    await page.locator('#navigation-mode').selectOption(mode);
    await expect(page.locator('#cinematic-nav-mode')).toHaveValue(mode);
  }

  // Each mode reveals exactly its own sub-panel inside the accordion.
  const panels = {
    orbit: '#cinematic-orbit-controls',
    planar: '#cinematic-planar-controls',
    free: '#cinematic-freefly-controls'
  };
  for (const mode of Object.keys(panels)) {
    await page.locator('#cinematic-nav-mode').selectOption(mode);
    for (const [other, selector] of Object.entries(panels)) {
      await expect(page.locator(selector)).toHaveCSS(
        'display',
        other === mode ? 'block' : 'none'
      );
    }
  }

  // Every sub-control reaches the viewer: the show-orbit-anchor checkbox is
  // the one the "dead controls" report singled out.
  await page.locator('#cinematic-nav-mode').selectOption('orbit');
  const anchor = page.locator('#cinematic-show-orbit-anchor');
  await expect(anchor).toBeChecked();
  await anchor.uncheck();
  await expect(anchor).not.toBeChecked();
  await anchor.check();

  // The camera-path info popover explains camera paths and sits with the
  // Save Keyframe control, not with the navigation block.
  await expect(
    page.locator('#cinematic-navigation-controls #camera-path-info-btn')
  ).toHaveCount(0);
  await page.locator('#camera-path-info-btn').click();
  await expect(page.locator('#camera-path-info-tooltip')).toContainText(
    'Save at least two positions'
  );

  expect(productErrors).toEqual([]);
});
