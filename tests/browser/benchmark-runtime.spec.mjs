import { expect, test } from '@playwright/test';

test('GLB benchmark publishes one complete state generation', async ({
  page
}, testInfo) => {
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
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=benchmark-runtime-ci',
    { waitUntil: 'domcontentloaded' }
  );
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing all 120 points'
  );

  await page.locator('#benchmark-section > summary').click();
  await expect(page.locator('#benchmark-section')).toHaveAttribute('open', '');
  await page.locator('#benchmark-count').fill('1000');
  await page.locator('#benchmark-pattern').selectOption('glb');
  await page.locator('#benchmark-run').click();

  await expect.poll(
    () => page.evaluate(() => window._cellucidState.pointCount)
  ).toBe(1000);
  await expect(page.locator('#bench-points')).toHaveText('1K');
  await expect(page.locator('#bench-fps')).not.toHaveText('-');

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
