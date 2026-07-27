import { expect, test } from '@playwright/test';
import { dismissWelcome } from './helpers/welcome.mjs';

const CURRENT_UI_DATASET =
  '/tests/browser/fixtures/exports/current-ui-prepared/';

function createVelocityBytes(nCells) {
  const bytes = Buffer.alloc(
    nCells * 2 * Float32Array.BYTES_PER_ELEMENT,
  );
  for (let index = 0; index < nCells; index++) {
    bytes.writeFloatLE(0.01, index * 2 * 4);
    bytes.writeFloatLE((index % 3) * 0.0025, ((index * 2) + 1) * 4);
  }
  return bytes;
}

test('volumetric smoke completes its exact GPU density and noise path', async ({ page }) => {
  const browserErrors = [];
  let publishDensityReady;
  const densityReady = new Promise(resolve => {
    publishDensityReady = resolve;
  });
  let publishNoiseReady;
  const noiseReady = new Promise(resolve => {
    publishNoiseReady = resolve;
  });

  page.on('console', message => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
    if (
      message.text().includes(
        '[SmokeRenderer] Created 3D density texture (32³)',
      )
    ) {
      publishDensityReady();
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
  await page.locator('#smoke-grid').evaluate(input => {
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#noise-resolution').evaluate(input => {
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#smoke-grid-display')).toHaveText('32³');
  await expect(page.locator('#noise-resolution-display')).toHaveText('32³');

  const renderMode = page.locator('#render-mode');
  await expect(renderMode).toHaveValue('points');
  await renderMode.selectOption('smoke');
  await expect(renderMode).toHaveValue('smoke');
  await Promise.all([densityReady, noiseReady]);
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));

  const webglError = await page.locator('#glcanvas').evaluate(canvas => (
    canvas.getContext('webgl2').getError()
  ));
  expect(webglError).toBe(0);
  expect(browserErrors).toEqual([]);
});

test('smoke owns an empty filtered view without errors or stale density', async ({
  browserName,
  page,
}) => {
  const productErrors = [];
  const browserDiagnostics = [];
  page.on('console', message => {
    if (
      message.type() === 'warning' &&
      /GL Driver Message .*GPU stall due to ReadPixels/.test(message.text())
    ) {
      browserDiagnostics.push(message.text());
    } else if (message.type() === 'error' || message.type() === 'warning') {
      productErrors.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    productErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      productErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=smoke-empty-filter',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
  await page.locator('#smoke-grid').evaluate(input => {
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#smoke-grid-display')).toHaveText('32³');
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });

  const legend = page.locator('#legend');
  await legend.getByRole('button', { name: 'Hide All', exact: true }).click();
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing 0 of 120 points',
  );

  const renderMode = page.locator('#render-mode');
  await renderMode.selectOption('smoke');
  await expect(renderMode).toHaveValue('smoke');
  await expect(page.locator('#smoke-controls')).toHaveClass(/visible/);
  await expect(page.locator('#points-controls')).not.toHaveClass(/visible/);
  expect(await page.evaluate(
    () => window._cellucidViewer.hasSmokeVolume(),
  )).toBe(false);

  await legend.getByRole('button', { name: 'Show All', exact: true }).click();
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing all 120 points',
  );
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.hasSmokeVolume()),
  ).toBe(true);

  await legend.getByRole('button', { name: 'Hide All', exact: true }).click();
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing 0 of 120 points',
  );
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.hasSmokeVolume()),
  ).toBe(false);
  await renderMode.selectOption('points');
  await renderMode.selectOption('smoke');
  await expect(renderMode).toHaveValue('smoke');
  await expect(page.locator('#smoke-controls')).toHaveClass(/visible/);
  expect(await page.evaluate(
    () => window._cellucidViewer.hasSmokeVolume(),
  )).toBe(false);

  const webglError = await page.locator('#glcanvas').evaluate(canvas => (
    canvas.getContext('webgl2').getError()
  ));
  expect(webglError).toBe(0);
  expect(productErrors).toEqual([]);
  expect(
    browserDiagnostics.every(message =>
      /GL Driver Message .*GPU stall due to ReadPixels/.test(message),
    ),
  ).toBe(true);
  expect(browserDiagnostics.length).toBeLessThanOrEqual(4);
  if (browserName !== 'chromium') {
    expect(browserDiagnostics).toEqual([]);
  }
});

test('every visible velocity slider endpoint reaches the GPU unchanged', async ({
  browserName,
  page,
}) => {
  const browserErrors = [];
  const browserDiagnostics = [];
  page.on('console', message => {
    if (
      message.type() === 'warning' &&
      /GL Driver Message .*GPU stall due to ReadPixels/.test(message.text())
    ) {
      browserDiagnostics.push(message.text());
    } else if (message.type() === 'error' || message.type() === 'warning') {
      browserErrors.push(`console ${message.type()}: ${message.text()}`);
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

  await page.route(
    `**${CURRENT_UI_DATASET}dataset_identity.json`,
    async route => {
      const response = await route.fetch();
      const identity = await response.json();
      identity.vector_fields = {
        default_field: 'velocity_umap',
        fields: {
          velocity_umap: {
            label: 'velocity_umap',
            basis: 'umap',
            available_dimensions: [2],
            default_dimension: 2,
            files: {
              '2d': 'vectors/velocity_umap_2d.bin',
            },
          },
        },
      };
      await route.fulfill({ response, json: identity });
    },
  );
  await page.route(
    `**${CURRENT_UI_DATASET}vectors/velocity_umap_2d.bin`,
    route => route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: createVelocityBytes(120),
    }),
  );

  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=velocity-slider-endpoints',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
  await expect(page.locator('#velocity-overlay-enabled')).toBeEnabled();
  await page.locator('#velocity-overlay-enabled').check();
  await expect(
    page.getByText('Velocity overlay ready', { exact: true }),
  ).toBeVisible();

  const endpoints = [
    ['#velocity-speed', '5'],
    ['#velocity-lifetime', '10'],
    ['#velocity-size', '0.5'],
    ['#velocity-intensity', '0.05'],
    ['#velocity-exposure', '0.1'],
  ];
  for (const [selector, value] of endpoints) {
    await page.locator(selector).evaluate((input, nextValue) => {
      input.value = nextValue;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await expect(page.locator(selector)).toHaveValue(value);
  }

  await expect(page.locator('#velocity-speed-display')).toHaveText('0.05×');
  await expect(page.locator('#velocity-lifetime-display')).toHaveText('0.1s');
  await expect(page.locator('#velocity-size-display')).toHaveText('0.5');
  await expect(page.locator('#velocity-intensity-display')).toHaveText('0.05');
  await expect(page.locator('#velocity-exposure-display')).toHaveText('0.10');
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));

  const webglError = await page.locator('#glcanvas').evaluate(canvas => (
    canvas.getContext('webgl2').getError()
  ));
  expect(webglError).toBe(0);
  expect(browserErrors).toEqual([]);
  expect(
    browserDiagnostics.every(message =>
      /GL Driver Message .*GPU stall due to ReadPixels/.test(message),
    ),
  ).toBe(true);
  expect(browserDiagnostics.length).toBeLessThanOrEqual(4);
  if (browserName !== 'chromium') {
    expect(browserDiagnostics).toEqual([]);
  }
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
