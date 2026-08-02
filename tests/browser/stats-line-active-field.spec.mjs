// The statistics line names the active field, and it is `sr-only`: a sighted
// user reads the legend instead and never sees it, so when it falls behind, the
// only person misinformed is the one using a screen reader, and nothing on
// screen contradicts it.
//
// It fell behind because it was republished from refresh lists rather than from
// a signal, and the lists drifted. Two kept views can carry two different
// active fields — `setActiveView` saves and restores each view's own
// `activeFieldIndex` — so switching between them is an active-field change, and
// the switch path published the legend without publishing the line beside it.
//
// This walks the real path: colour a view, keep it, colour the live view with a
// different field, and switch back. The line must name the field of the view
// being looked at, every time.

import { expect, test } from '@playwright/test';
import { sampleUrl } from './helpers/origins.mjs';

const SAMPLE_ROOT = sampleUrl('/tests/browser/fixtures/exports/');

function launchUrl() {
  return (
    `/?exportsBaseUrl=${encodeURIComponent(SAMPLE_ROOT)}` +
    '&acceptance=stats-line-active-field'
  );
}

async function activeViewId(page) {
  return page.evaluate(() => window._cellucidState.getActiveViewId());
}

test('the statistics line names the active field of the view being shown', async ({
  page,
}) => {
  const browserErrors = [];
  page.on('pageerror', error => {
    browserErrors.push(error.stack || error.message);
  });

  await page.goto(launchUrl(), { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Choose a Dataset/ }).click();
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );

  const stats = page.locator('#stats');
  await expect(stats).toHaveText('Points: 120 • Field: None');

  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  await expect(stats).toHaveText(
    'Points: 120 • Field: cell_type (category) • Centroids: 3',
  );

  // Keep the coloured view. The kept view becomes active and carries the field
  // it was kept with.
  await page.locator('#split-keep-view-btn').click();
  await expect.poll(() => activeViewId(page)).toBe('snap_1');
  await expect(page.locator('.split-badge')).toHaveCount(2);
  await expect(stats).toHaveText(
    'Points: 120 • Field: cell_type (category) • Centroids: 3',
  );

  // Back to the live view and colour it with a different field, so the two
  // views disagree about what is being shown.
  await page.locator('.split-badge').first().click();
  await expect.poll(() => activeViewId(page)).toBe('live');
  await page.locator('#continuous-field').selectOption({ label: 'score' });
  await expect(stats).toHaveText('Points: 120 • Field: score (continuous)');

  // Switching back must re-announce the kept view's own field. Publishing the
  // legend without the line beside it is what left this reading "score" over a
  // plot coloured by cell type.
  await page.locator('.split-badge').nth(1).click();
  await expect.poll(() => activeViewId(page)).toBe('snap_1');
  await expect(page.locator('.legend-item')).toHaveCount(3);
  await expect(stats).toHaveText(
    'Points: 120 • Field: cell_type (category) • Centroids: 3',
  );

  // And once more in the other direction, so the assertion above cannot pass by
  // the line simply never changing.
  await page.locator('.split-badge').first().click();
  await expect.poll(() => activeViewId(page)).toBe('live');
  await expect(stats).toHaveText('Points: 120 • Field: score (continuous)');

  expect(browserErrors).toEqual([]);
});
