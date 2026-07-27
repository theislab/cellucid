import { expect, test } from '@playwright/test';
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
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=analysis-worker-ci',
    { waitUntil: 'domcontentloaded' }
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );

  const proof = await page.evaluate(async () => {
    const { createWorkerPool } = await import(
      '/assets/js/app/analysis/compute/worker-pool.js'
    );
    const pool = createWorkerPool({
      poolSize: 1,
      defaultTimeout: 10_000
    });
    try {
      await pool.init();
      const result = await pool.execute(
        'COMPUTE_STATS',
        { values: new Float32Array([1, 2, 3, 4]) },
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
    count: 4,
    min: 1,
    max: 4,
    mean: 2.5,
    median: 2.5,
    std: Math.sqrt(1.25),
    q1: 2,
    q3: 4,
    iqr: 2,
    sum: 10,
    variance: 1.25
  });
  expect(proof.stats).toEqual({
    poolSize: 1,
    state: 'ready',
    failure: null,
    busyWorkers: 0,
    idleWorkers: 1,
    pendingRequests: 0,
    queuedTasks: 0
  });
  expect(browserErrors).toEqual([]);
});
