import { expect, test } from './helpers/test.mjs';

import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}` +
  '&dataset=current-ui-prepared&acceptance=application-retirement-ci';

test.beforeEach(async ({ page }) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
});

test('a persisted pagehide preserves the live application generation', async ({
  page,
}) => {
  const proof = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    window.dispatchEvent(new PageTransitionEvent('pagehide', {
      persisted: true,
    }));
    return {
      disposed: viewer.isDisposed(),
      pointCount: viewer.getPointCount(),
    };
  });

  expect(proof).toEqual({
    disposed: false,
    pointCount: 120,
  });
});

test('an ordinary pagehide owns one complete application teardown', async ({
  page,
}) => {
  const proof = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const dispose = window._cellucidDispose;
    if (typeof dispose !== 'function') {
      throw new Error('Application retirement owner is unavailable.');
    }

    window.dispatchEvent(new PageTransitionEvent('pagehide', {
      persisted: false,
    }));
    const firstTask = dispose();
    const secondTask = dispose();
    await firstTask;

    let guardedError = null;
    try {
      viewer.getPointCount();
    } catch (error) {
      guardedError = {
        name: error?.name ?? null,
        message: error?.message ?? String(error),
      };
    }
    return {
      disposed: viewer.isDisposed(),
      guardedError,
      sameTask: firstTask === secondTask,
      settled: viewer.isDisposalSettled(),
    };
  });

  expect(proof.sameTask).toBe(true);
  expect(proof.disposed).toBe(true);
  expect(proof.settled).toBe(true);
  expect(proof.guardedError?.name).toMatch(/Error/);
  expect(proof.guardedError?.message).toMatch(/dispose\(\)/i);
});
