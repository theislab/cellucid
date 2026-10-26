import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

test('analysis worker pool initializes and computes the exact result', async ({ page }) => {
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
    `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=analysis-worker-ci`,
    { waitUntil: 'domcontentloaded' }
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture'
  );

  const proof = await page.evaluate(async () => {
    const { WorkerPool } = await import(
      '/assets/js/app/analysis/compute/worker-pool.js'
    );
    const pool = new WorkerPool({
      poolSize: 1,
      defaultTimeout: 10_000
    });
    try {
      await pool.init();
      const result = await pool.execute(
        'COMPUTE_CORRELATION',
        {
          xValues: new Float32Array([1, 2, 3, 4]),
          yValues: new Float32Array([2, 4, 6, 8])
        },
        { transfer: false }
      );
      return {
        result,
        stats: pool.getStats()
      };
    } finally {
      pool.terminate();
    }
  });

  expect(proof.result).toEqual({
    r: 1,
    rSquared: 1,
    pValue: 0,
    n: 4,
    method: 'pearson',
    slope: 2,
    intercept: 0
  });
  // Each task type's measured queue and run times (the run tuner reads them).
  const { taskTiming, ...stats } = proof.stats;
  expect(Object.keys(taskTiming)).toEqual(['COMPUTE_CORRELATION']);
  expect(taskTiming.COMPUTE_CORRELATION.count).toBe(1);
  expect(taskTiming.COMPUTE_CORRELATION.queueMs).toBeGreaterThanOrEqual(0);
  expect(taskTiming.COMPUTE_CORRELATION.runMs).toBeGreaterThanOrEqual(0);
  expect(stats).toEqual({
    poolSize: 1,
    state: 'ready',
    failure: null,
    busyWorkers: 0,
    idleWorkers: 1,
    pendingRequests: 0,
    queuedTasks: 0,
    // No task was cancelled, so no worker was replaced.
    replacedWorkers: 0,
    lastReplacementMs: null
  });
  expect(browserErrors).toEqual([]);
});
