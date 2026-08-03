import {
  closeContextWithApplicationRetirement,
  expect,
  test,
} from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const VIEWPORT = { width: 1440, height: 1000 };
const HARNESS_MODULE_PATH = '/assets/js/app/ui/modules/benchmark/index.js';
const PERFORMANCE_TRACKER_MODULE_PATH =
  '/assets/js/app/ui/modules/benchmark/performance-tracker.js';
const SUPPORT_MODULE_PATH = '/assets/js/dev/benchmark.js';
const PROCESS_INTENSIVE = Object.freeze({
  tag: '@browser-process-intensive',
});
const MINIMUM_SMOKE_COST_CONTROLS = Object.freeze([
  'cloud-resolution',
  'noise-resolution',
  'smoke-grid',
  'smoke-steps',
]);

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
  let performanceTrackerModuleRequests = 0;
  let supportModuleRequests = 0;

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
      const pathname = new URL(request.url()).pathname;
      if (pathname === HARNESS_MODULE_PATH) {
        harnessModuleRequests += 1;
      } else if (pathname === PERFORMANCE_TRACKER_MODULE_PATH) {
        performanceTrackerModuleRequests += 1;
      } else if (pathname === SUPPORT_MODULE_PATH) {
        supportModuleRequests += 1;
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
    // The filter count publishes dataset readiness before the linear bootstrap
    // reaches the benchmark listeners. Use the benchmark control's production
    // admission boundary before changing render mode; otherwise a slow native
    // GPU can make this test race initial publication with an unrelated user
    // operation that the test is not intended to cover.
    await expect(page.locator('#benchmark-run')).toBeEnabled();
    expect(harnessModuleRequests).toBe(0);
    expect(performanceTrackerModuleRequests).toBe(0);
    expect(supportModuleRequests).toBe(0);
    expect(
      await page.evaluate(() => typeof window._cellucidBenchmarkHarness)
    ).toBe('undefined');
  });

  test.afterAll(async () => {
    // If an assertion failed before the intercepted worker was released, do
    // not strand its route while the application is being retired.
    releaseWorkerOnce();
    if (context !== null) {
      await closeContextWithApplicationRetirement(context);
    }
  });

  test('the real benchmark panel becomes ready from smoke mode', PROCESS_INTENSIVE, async () => {
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
    // This is a module-publication contract, not a smoke throughput test. Use
    // every real minimum-cost control: grid size bounds density construction,
    // while ray steps and offscreen resolution bound the full-screen work that
    // otherwise monopolizes a software/native Firefox main thread. The old
    // test changed only grid size, which does not reduce fragment count.
    await page.evaluate(controlIds => {
      for (const id of controlIds) {
        const input = document.getElementById(id);
        if (!(input instanceof HTMLInputElement)) {
          throw new Error(`Missing smoke cost control: ${id}`);
        }
        input.value = '0';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, MINIMUM_SMOKE_COST_CONTROLS);
    for (const id of MINIMUM_SMOKE_COST_CONTROLS) {
      await expect(page.locator(`#${id}`)).toHaveValue('0');
    }
    await page.locator('#render-mode').selectOption('smoke');
    await expect(page.locator('#render-mode')).toHaveValue('smoke');
    await expect(page.locator('#smoke-controls')).toHaveClass(/visible/);
    await expect(page.locator('#points-controls')).not.toHaveClass(/visible/);
    await expect(page.locator('#split-keep-view-btn')).toBeDisabled();

    await page.locator('#benchmark-section > summary').click();
    await expect(page.locator('#benchmark-section')).toHaveAttribute('open', '');
    // Visible live statistics are the production readiness boundary. The
    // configuration-matrix harness has a separate reachability suite and must
    // not hold this UI or synthetic generation hostage while its larger graph
    // is parsed. Its request still starts exactly once from the same activation.
    await expect(page.locator('#benchmark-stats')).toBeVisible();
    await expect(page.locator('#bench-points')).toHaveText('120');
    await expect.poll(async () => ({
      browserErrors: [...browserErrors],
      harnessModuleRequests,
      performanceTrackerModuleRequests,
      supportModuleRequests,
    })).toEqual({
      browserErrors: [],
      harnessModuleRequests: 1,
      performanceTrackerModuleRequests: 1,
      supportModuleRequests: 0,
    });
  });

  test('GLB benchmark publishes one complete state generation', PROCESS_INTENSIVE, async ({}, testInfo) => {
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
