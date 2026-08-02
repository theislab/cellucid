import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

/**
 * A dataset either ships a neighbour graph or it does not, and that fact
 * cannot change while the dataset is published. The renderer asks main.js for
 * KNN edges whenever KNN mode is entered and again on every Alt+drag, so the
 * absence has to be announced once per dataset generation — not once per
 * gesture — and it has to be armed again by the next dataset.
 */

const PREPARED_DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}`
  + '&dataset=current-ui-prepared&acceptance=knn-missing-connectivity-warning-ci';

const MISSING_GRAPH_MESSAGE = 'No neighbor graph available for this dataset';

const h5adFixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'current-ui-smoke.h5ad',
);

/**
 * Record every warning the app publishes, so the assertions below count
 * emissions rather than surviving DOM nodes. Toasts auto-dismiss after five
 * seconds and the centre caps itself at five visible items, so a live-DOM
 * count alone would hide exactly the stacking this test exists to catch.
 */
async function recordPublishedWarnings(page) {
  await page.evaluate(async () => {
    const { getNotificationCenter } = await import(
      '/assets/js/app/notification-center.js'
    );
    const center = getNotificationCenter();
    if (Object.hasOwn(center, '__recordedWarnings')) {
      throw new Error('Warning recorder was installed twice.');
    }
    const published = [];
    const original = center.warning;
    center.__recordedWarnings = published;
    center.warning = function recordWarning(message, options = {}) {
      published.push(message);
      return original.call(this, message, options);
    };
  });
}

const publishedWarnings = page => page.evaluate(async () => {
  const { getNotificationCenter } = await import(
    '/assets/js/app/notification-center.js'
  );
  return [...getNotificationCenter().__recordedWarnings];
});

/**
 * Toasts the user can actually see right now, excluding ones animating out.
 *
 * Every caller reads this immediately rather than through a retrying matcher:
 * a warning auto-dismisses after five seconds, so a retrying "exactly one"
 * assertion would eventually be satisfied by a stack of three draining away.
 */
const visibleMissingGraphToasts = page => page.locator(
  '#notification-center .notification-warning:not(.notification-exit)',
).filter({ hasText: MISSING_GRAPH_MESSAGE }).count();

async function openPreparedDataset(page) {
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing all 120 points',
  );
  // The fixture ships no connectivity, which is why the controls stay hidden.
  await expect(page.locator('#connectivity-controls')).toBeHidden();
}

async function findCellPoints(page, limit) {
  const points = await page.evaluate(max => {
    const viewer = window._cellucidViewer;
    const found = [];
    for (let y = 40; y < 980; y += 5) {
      for (let x = 340; x < 1430; x += 5) {
        if (viewer.pickCellAtScreen(x, y) >= 0) {
          found.push({ x, y });
          if (found.length >= max) return found;
        }
      }
    }
    return found;
  }, limit);
  expect(points.length).toBe(limit);
  return points;
}

async function altClick(page, point) {
  await page.mouse.move(point.x, point.y);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.mouse.move(point.x + 40, point.y + 40);
}

const enterKnnMode = page => page
  .locator('.highlight-mode-btn[data-mode="knn"]')
  .click();

const dismissEveryNotification = page => page.evaluate(async () => {
  const { getNotificationCenter } = await import(
    '/assets/js/app/notification-center.js'
  );
  getNotificationCenter().dismissAll();
});

test(
  'a dataset with no neighbour graph says so once, not once per gesture',
  async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    await openPreparedDataset(page);
    await recordPublishedWarnings(page);
    expect(await publishedWarnings(page)).toEqual([]);

    // Entering KNN mode is the first request for the absent capability.
    await enterKnnMode(page);
    await expect.poll(() => publishedWarnings(page)).toEqual([
      MISSING_GRAPH_MESSAGE,
    ]);
    expect(await visibleMissingGraphToasts(page)).toBe(1);

    // Every Alt+click asks the renderer for the same absent capability again.
    const points = await findCellPoints(page, 3);
    await altClick(page, points[0]);
    await altClick(page, points[1]);
    // The one toast may already have auto-dismissed here, so this bounds the
    // stack rather than pinning it; the emission log below is what pins it.
    expect(await visibleMissingGraphToasts(page)).toBeLessThanOrEqual(1);
    expect(await publishedWarnings(page)).toEqual([MISSING_GRAPH_MESSAGE]);

    // Rapid repetition must not stack either.
    for (const point of [points[2], points[0], points[1], points[2]]) {
      await page.mouse.move(point.x, point.y);
      await page.keyboard.down('Alt');
      await page.mouse.down();
      await page.mouse.up();
      await page.keyboard.up('Alt');
    }
    expect(await publishedWarnings(page)).toEqual([MISSING_GRAPH_MESSAGE]);

    // Leaving and re-entering the mode, and re-pressing the already active
    // mode button, are all further requests for the same unchanged fact.
    await page.locator('.highlight-mode-btn[data-mode="lasso"]').click();
    await enterKnnMode(page);
    await enterKnnMode(page);
    expect(await publishedWarnings(page)).toEqual([MISSING_GRAPH_MESSAGE]);
    expect(await visibleMissingGraphToasts(page)).toBeLessThanOrEqual(1);

    // Dismissing the toast does not re-arm it: the dataset has not changed.
    await dismissEveryNotification(page);
    expect(await visibleMissingGraphToasts(page)).toBe(0);
    await altClick(page, points[0]);
    expect(await visibleMissingGraphToasts(page)).toBe(0);
    expect(await publishedWarnings(page)).toEqual([MISSING_GRAPH_MESSAGE]);

    expect(pageErrors).toEqual([]);
  },
);

test(
  'the next dataset arms the missing neighbour graph warning again',
  async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    await openPreparedDataset(page);
    await recordPublishedWarnings(page);

    await enterKnnMode(page);
    await expect.poll(() => publishedWarnings(page)).toEqual([
      MISSING_GRAPH_MESSAGE,
    ]);
    const firstPoints = await findCellPoints(page, 1);
    await altClick(page, firstPoints[0]);
    expect(await publishedWarnings(page)).toEqual([MISSING_GRAPH_MESSAGE]);

    // A new dataset is a new generation, even when it also lacks the graph.
    await page.locator('#user-data-h5ad-input').setInputFiles(h5adFixturePath);
    await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
    await expect(page.locator('#connectivity-controls')).toBeHidden();
    // Clear the board so the toast counted below can only be a new one.
    await dismissEveryNotification(page);

    await enterKnnMode(page);
    await expect.poll(() => publishedWarnings(page)).toEqual([
      MISSING_GRAPH_MESSAGE,
      MISSING_GRAPH_MESSAGE,
    ]);
    expect(await visibleMissingGraphToasts(page)).toBe(1);

    // ...and it is once per generation on the new dataset too.
    const nextPoints = await findCellPoints(page, 2);
    await altClick(page, nextPoints[0]);
    await altClick(page, nextPoints[1]);
    expect(await publishedWarnings(page)).toEqual([
      MISSING_GRAPH_MESSAGE,
      MISSING_GRAPH_MESSAGE,
    ]);

    expect(pageErrors).toEqual([]);
  },
);

test(
  'a reload starts the missing neighbour graph warning over',
  async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    await openPreparedDataset(page);
    await recordPublishedWarnings(page);
    await enterKnnMode(page);
    await expect.poll(() => publishedWarnings(page)).toEqual([
      MISSING_GRAPH_MESSAGE,
    ]);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await expect(page.locator('#dataset-name')).toHaveText(
      'Current UI prepared fixture',
    );
    await recordPublishedWarnings(page);
    expect(await publishedWarnings(page)).toEqual([]);

    await enterKnnMode(page);
    await expect.poll(() => publishedWarnings(page)).toEqual([
      MISSING_GRAPH_MESSAGE,
    ]);
    expect(await visibleMissingGraphToasts(page)).toBe(1);

    expect(pageErrors).toEqual([]);
  },
);
