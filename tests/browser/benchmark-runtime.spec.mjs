import { expect, test } from '@playwright/test';
import { dismissWelcome } from './helpers/welcome.mjs';

test('GLB benchmark publishes one complete state generation', async ({
  page
}, testInfo) => {
  const browserErrors = [];
  let benchmarkModulePublications = 0;
  let publishBenchmarkModuleRequest;
  const benchmarkModuleRequested = new Promise(resolve => {
    publishBenchmarkModuleRequest = resolve;
  });
  let releaseBenchmarkModule;
  const benchmarkModuleRelease = new Promise(resolve => {
    releaseBenchmarkModule = resolve;
  });

  await page.addInitScript(() => {
    localStorage.setItem('CELLUCID_DEBUG', 'true');
  });
  await page.route('**/assets/js/dev/benchmark.js', async route => {
    publishBenchmarkModuleRequest();
    await benchmarkModuleRelease;
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
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=benchmark-runtime-ci',
    { waitUntil: 'domcontentloaded' }
  );
  await dismissWelcome(page);
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing all 120 points'
  );

  await page.locator('#benchmark-section > summary').click();
  await expect(page.locator('#benchmark-section')).toHaveAttribute('open', '');
  await benchmarkModuleRequested;
  await page.locator('#benchmark-count').fill('1000');
  await page.locator('#benchmark-pattern').selectOption('glb');
  await page.locator('#benchmark-run').click();
  releaseBenchmarkModule();

  await expect.poll(
    () => page.evaluate(() => window._cellucidState.pointCount)
  ).toBe(1000);
  expect(benchmarkModulePublications).toBe(1);
  await expect(page.locator('#bench-points')).toHaveText('1K');
  await expect.poll(async () => Number.parseFloat(
    await page.locator('#bench-fps').textContent()
  )).toBeGreaterThan(0);

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
