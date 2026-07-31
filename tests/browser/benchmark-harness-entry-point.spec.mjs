/**
 * Reachability proof for the render benchmark harness (CEL-AUDIT-0094).
 *
 * `benchmark-harness.spec.mjs` exercises what the harness can measure; it
 * reaches the module by importing its URL directly from test code, which says
 * nothing about whether a person running the application can get to it. This
 * spec is the other half: open the Performance Benchmark panel the way a user
 * does, and prove the harness is then constructible against the live viewer
 * and the live canvas.
 *
 * It is deliberately not a measurement. The window is 45 frames on the 120
 * point fixture and no number it produces may be recorded.
 */

import { expect, test } from '@playwright/test';
import { dismissWelcome } from './helpers/welcome.mjs';

const FIXTURE_URL =
  '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F' +
  '&dataset=current-ui-prepared&acceptance=benchmark-harness-entry-point-ci';

test('opening the benchmark panel makes the harness constructible', async ({
  page
}) => {
  test.setTimeout(300_000);
  const browserErrors = [];
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });

  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 points');

  // The harness is lazy: it must not be on the page before the panel is used.
  expect(
    await page.evaluate(() => typeof window._cellucidBenchmarkHarness)
  ).toBe('undefined');

  await page.locator('#benchmark-section > summary').click();
  await expect(page.locator('#benchmark-section')).toHaveAttribute('open', '');
  await expect
    .poll(() => page.evaluate(() => typeof window._cellucidBenchmarkHarness))
    .toBe('object');

  const outcome = await page.evaluate(async () => {
    const harnessModule = window._cellucidBenchmarkHarness;
    const viewer = window._cellucidViewer;
    const canvas = document.getElementById('glcanvas');
    const gl = canvas.getContext('webgl2');

    // Nothing may be installed on the live context before the harness is
    // explicitly created.
    const instrumentedBeforeCreate = harnessModule.INSTRUMENTED_METHOD_NAMES
      .filter(name => Object.hasOwn(gl, name));

    const harness = harnessModule.createBenchmarkHarness({ viewer, canvas });
    try {
      const instrumentedAfterCreate = harnessModule.INSTRUMENTED_METHOD_NAMES
        .filter(name => Object.hasOwn(gl, name));

      const runner = harness.runner;
      const layout = await runner.applyConfiguration({
        viewCount: 1,
        lod: false,
        frustumCulling: false,
        forceLodLevel: -1,
        regime: 'static'
      });
      const summary = await runner.runWindow({
        regime: 'static',
        path: runner.createPathFromCurrentCamera(),
        warmupFrames: 5,
        measureFrames: 45
      });

      return {
        instrumentedBeforeCreate,
        instrumentedAfterCreate,
        maskedRendererPresent: typeof harness.identity.maskedRenderer === 'string',
        backingStorePixels: harness.identity.canvas.backingStorePixels,
        rasterizerKind: harness.rasterizer.kind,
        baselineKey: harness.baselineKey(),
        runnerMethods: [
          'applyConfiguration',
          'createPathFromCurrentCamera',
          'runWindow',
          'runMatrix'
        ].filter(name => typeof runner[name] === 'function'),
        layout,
        samples: summary.samples,
        medianFrameTimeMs: summary.frameTimeMs.median,
        p99FrameTimeMs: summary.frameTimeMs.p99,
        p99Reported: summary.percentileSupport.p99.reported
      };
    } finally {
      harness.dispose();
    }
  });

  expect(outcome.instrumentedBeforeCreate).toEqual([]);
  expect(outcome.instrumentedAfterCreate.length).toBeGreaterThan(0);
  expect(outcome.maskedRendererPresent).toBe(true);
  expect(outcome.backingStorePixels).toBeGreaterThan(0);
  expect(['hardware', 'software', 'unknown']).toContain(outcome.rasterizerKind);
  expect(outcome.baselineKey).toMatch(/^[a-z0-9-]+$/);
  expect(outcome.runnerMethods).toEqual([
    'applyConfiguration',
    'createPathFromCurrentCamera',
    'runWindow',
    'runMatrix'
  ]);
  expect(outcome.samples).toBe(45);
  expect(outcome.medianFrameTimeMs).toBeGreaterThan(0);
  // 45 frames cannot support a p99, and the recorder withholds it rather than
  // inventing one. That is what keeps this spec a reachability proof.
  expect(outcome.p99Reported).toBe(false);
  expect(outcome.p99FrameTimeMs).toBeNull();

  // `dispose()` has to give the product its own context methods back, or every
  // session that opened the panel would keep counting uploads for ever.
  const instrumentedAfterDispose = await page.evaluate(() => {
    const gl = document.getElementById('glcanvas').getContext('webgl2');
    return window._cellucidBenchmarkHarness.INSTRUMENTED_METHOD_NAMES
      .filter(name => Object.hasOwn(gl, name));
  });
  expect(instrumentedAfterDispose).toEqual([]);

  expect(browserErrors).toEqual([]);
});
