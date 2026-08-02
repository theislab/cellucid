import { expect, test } from '@playwright/test';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

test('GLB benchmark publishes one complete state generation', async ({
  page
}, testInfo) => {
  const browserErrors = [];
  let benchmarkModulePublications = 0;
  let publishWorkerRequest;
  const workerRequested = new Promise(resolve => {
    publishWorkerRequest = resolve;
  });
  let releaseWorker;
  const workerRelease = new Promise(resolve => {
    releaseWorker = resolve;
  });

  await page.addInitScript(() => {
    localStorage.setItem('CELLUCID_DEBUG', 'true');
  });
  await page.route('**/generation-worker.js', async route => {
    publishWorkerRequest();
    await workerRelease;
    await route.continue();
  });
  page.on('console', message => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
    if (message.text().includes('[Main] Benchmark module lazy-loaded')) {
      benchmarkModulePublications++;
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
    `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=benchmark-runtime-ci`,
    { waitUntil: 'domcontentloaded' }
  );
  await dismissWelcome(page);
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing all 120 points'
  );
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    viewer.hasRendererStats = () => false;
    viewer.getRendererStats = () => {
      throw new Error('Renderer statistics are intentionally unavailable');
    };
  });
  await page.locator('#smoke-grid').evaluate(input => {
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#render-mode').selectOption('smoke');
  await expect(page.locator('#render-mode')).toHaveValue('smoke');
  await expect(page.locator('#smoke-controls')).toHaveClass(/visible/);
  await expect(page.locator('#points-controls')).not.toHaveClass(/visible/);
  await expect(page.locator('#split-keep-view-btn')).toBeDisabled();

  await page.locator('#benchmark-section > summary').click();
  await expect(page.locator('#benchmark-section')).toHaveAttribute('open', '');
  await expect.poll(() => benchmarkModulePublications).toBe(1);
  await page.locator('#benchmark-count').fill('1000');
  await page.locator('#benchmark-pattern').selectOption('glb');
  await page.locator('#benchmark-run').click();
  await workerRequested;
  expect(await page.evaluate(() => window._cellucidState.pointCount)).toBe(120);
  releaseWorker();

  await expect.poll(
    () => page.evaluate(() => window._cellucidState.pointCount)
  ).toBe(1000);
  await expect(page.locator('#render-mode')).toHaveValue('points');
  await expect(page.locator('#points-controls')).toHaveClass(/visible/);
  await expect(page.locator('#smoke-controls')).not.toHaveClass(/visible/);
  await expect(page.locator('#split-keep-view-btn')).toBeEnabled();
  await expect(page.locator('#view-layout-mode')).toBeEnabled();
  expect(benchmarkModulePublications).toBe(1);
  await expect(page.locator('#bench-points')).toHaveText('1K');
  await expect.poll(async () => Number.parseFloat(
    await page.locator('#bench-fps').textContent()
  )).toBeGreaterThan(0);
  await expect(page.locator('#bench-lod')).toHaveText('-');

  const publication = await page.evaluate(() => {
    const state = window._cellucidState;
    const viewer = window._cellucidViewer;
    return {
      pointCount: state.pointCount,
      viewerPointCount: viewer.getPointCount(),
      positions: state.positionsArray.length,
      colors: state.colorsArray.length,
      transparency: state.categoryTransparency.length,
      visibility: state.cellVisibilityMask.length,
      outliers: state.outlierQuantilesArray.length,
      highlights: state.highlightArray.length,
      highlightPages: state.highlightPages.length,
      viewContexts: state.viewContexts.size,
      dimension: state.activeDimensionLevel,
      navigationMode: document.getElementById('navigation-mode').value,
      webglError: document
        .getElementById('glcanvas')
        .getContext('webgl2')
        .getError()
    };
  });
  expect(publication).toEqual({
    pointCount: 1000,
    viewerPointCount: 1000,
    positions: 3000,
    colors: 4000,
    transparency: 1000,
    visibility: 1000,
    outliers: 1000,
    highlights: 1000,
    highlightPages: 1,
    viewContexts: 1,
    dimension: 3,
    navigationMode: 'orbit',
    webglError: 0
  });

  await page.screenshot({
    path: testInfo.outputPath(
      `glb-benchmark-runtime-${testInfo.project.name}.png`
    ),
    fullPage: true
  });
  expect(browserErrors).toEqual([]);
});
