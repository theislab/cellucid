import { expect, test } from '@playwright/test';
import { dismissWelcome } from './helpers/welcome.mjs';

test('volumetric smoke completes its exact GPU density and noise path', async ({ page }) => {
  const browserErrors = [];
  let publishNoiseReady;
  const noiseReady = new Promise(resolve => {
    publishNoiseReady = resolve;
  });

  page.on('console', message => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
    if (message.text().includes('[SmokeRenderer] Cloud noise textures ready')) {
      publishNoiseReady();
    }
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      browserErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=renderer-smoke-ci',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');

  const renderMode = page.locator('#render-mode');
  await expect(renderMode).toHaveValue('points');
  await renderMode.selectOption('smoke');
  await expect(renderMode).toHaveValue('smoke');
  await noiseReady;
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));

  const webglError = await page.locator('#glcanvas').evaluate(canvas => (
    canvas.getContext('webgl2').getError()
  ));
  expect(webglError).toBe(0);
  expect(browserErrors).toEqual([]);
});

test('projectiles use the published full-resolution collision index', async ({ page }) => {
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      browserErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=renderer-projectile-ci',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');

  await page.locator('#navigation-mode').selectOption('free');
  await expect(page.locator('#navigation-mode')).toHaveValue('free');
  await page.locator('#projectiles-enabled').check();
  await page.waitForFunction(
    () => window._cellucidViewer.isProjectileSpatialIndexReady(),
  );

  const bounds = await page.locator('#glcanvas').boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(
    bounds.x + bounds.width * 0.75,
    bounds.y + bounds.height * 0.5,
  );
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(750);

  const webglError = await page.locator('#glcanvas').evaluate(canvas => (
    canvas.getContext('webgl2').getError()
  ));
  expect(webglError).toBe(0);
  expect(browserErrors).toEqual([]);
});

test('spatial-index construction failures settle every owned notification', async ({
  page,
}) => {
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      browserErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=renderer-spatial-failure-ci',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');

  const result = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const originalTime = console.time;
    console.time = (label) => {
      if (label === 'Quadtree build') {
        throw new Error('synthetic spatial-index construction failure');
      }
      return originalTime.call(console, label);
    };
    try {
      return await new Promise((resolve) => {
        viewer.setProjectilesEnabled(true, resolve);
      });
    } finally {
      console.time = originalTime;
    }
  });

  expect(result).toEqual({
    status: 'error',
    message:
      'Projectile preparation failed: synthetic spatial-index construction failure',
  });
  await expect(page.locator('.notification-loading')).toHaveCount(0);
  await expect(page.locator('.notification-error')).toContainText(
    '2D Quadtree failed: synthetic spatial-index construction failure',
  );
  const webglError = await page.locator('#glcanvas').evaluate(canvas => (
    canvas.getContext('webgl2').getError()
  ));
  expect(webglError).toBe(0);
  expect(browserErrors).toEqual([]);
});
