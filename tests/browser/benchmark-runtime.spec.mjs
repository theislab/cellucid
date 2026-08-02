import {
  closeContextWithApplicationRetirement,
  expect,
  test,
} from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const VIEWPORT = { width: 1440, height: 1000 };
const HARNESS_MODULE_PATH = '/assets/js/app/ui/modules/benchmark/index.js';

test.describe.serial('GLB benchmark runtime publication', () => {
  let context = null;
  let page = null;
  let browserErrors = null;
  let workerRequested = null;
  let publishWorkerRequest = null;
  let resolveWorkerRelease = null;
  let workerReleased = false;
  let workerRequests = 0;
  let harnessModuleRequests = 0;

  function releaseWorkerOnce() {
    if (workerReleased) return;
    workerReleased = true;
    resolveWorkerRelease?.();
  }

  test.beforeAll(async ({ browser }) => {
    // The benchmark sequence deliberately spans two independently timed user
    // operations while retaining the exact same live application and worker
    // route. No default context may exist beside that explicit owner.
    expect(browser.contexts()).toHaveLength(0);
    context = await browser.newContext({ viewport: VIEWPORT });
    page = await context.newPage();
    browserErrors = [];

    workerRequested = new Promise(resolve => {
      publishWorkerRequest = resolve;
    });
    const workerRelease = new Promise(resolve => {
      resolveWorkerRelease = resolve;
    });

    await page.route('**/generation-worker.js', async route => {
      workerRequests += 1;
      publishWorkerRequest();
      await workerRelease;
      await route.continue();
    });
    page.on('request', request => {
      if (new URL(request.url()).pathname === HARNESS_MODULE_PATH) {
        harnessModuleRequests += 1;
      }
    });
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
      `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=benchmark-runtime-ci`,
      { waitUntil: 'domcontentloaded' }
    );
    await dismissWelcome(page);
    await expect(page.locator('#filter-count')).toHaveText(
      'Showing all 120 points'
    );
  });

  test.afterAll(async () => {
    // If an assertion failed before the intercepted worker was released, do
    // not strand its route while the application is being retired.
    releaseWorkerOnce();
    if (context !== null) {
      await closeContextWithApplicationRetirement(context);
    }
  });

  test('the real benchmark panel becomes ready from smoke mode', async () => {
    if (page === null || browserErrors === null) {
      throw new Error('GLB benchmark runtime owner was not initialized.');
    }

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
    // The published module namespace is the production readiness boundary.
    // A debug-console message is observability, not a synchronization API, and
    // its delivery lagged behind the ready panel on hosted Firefox.
    await expect
      .poll(() => page.evaluate(
        () => typeof window._cellucidBenchmarkHarness
      ))
      .toBe('object');

    expect(harnessModuleRequests).toBe(1);
    expect(browserErrors).toEqual([]);
  });

  test('GLB benchmark publishes one complete state generation', async ({}, testInfo) => {
    if (
      page === null ||
      browserErrors === null ||
      workerRequested === null
    ) {
      throw new Error('GLB benchmark publication owner was not initialized.');
    }

    await page.locator('#benchmark-count').fill('1000');
    await page.locator('#benchmark-pattern').selectOption('glb');
    try {
      await page.locator('#benchmark-run').click();
      await workerRequested;
      expect(await page.evaluate(() => window._cellucidState.pointCount)).toBe(120);
      releaseWorkerOnce();

      await expect.poll(
        () => page.evaluate(() => window._cellucidState.pointCount)
      ).toBe(1000);
    } finally {
      releaseWorkerOnce();
    }

    await expect(page.locator('#render-mode')).toHaveValue('points');
    await expect(page.locator('#points-controls')).toHaveClass(/visible/);
    await expect(page.locator('#smoke-controls')).not.toHaveClass(/visible/);
    await expect(page.locator('#split-keep-view-btn')).toBeEnabled();
    await expect(page.locator('#view-layout-mode')).toBeEnabled();
    expect(workerRequests).toBe(1);
    expect(harnessModuleRequests).toBe(1);
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
});
