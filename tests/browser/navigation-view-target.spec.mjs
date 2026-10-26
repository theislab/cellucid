import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

// The Navigation panel names the view its settings drive once more than one
// view is open: the camera-focused view, drawn with that view's own number,
// representation and camera ring, and -- while its camera is linked -- the
// views that share it (they show the same representation).

const PREPARED_DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=navigation-view-target`;

function viewBadge(page, pill) {
  return page.locator('#split-view-badges-list .split-badge').filter({
    has: page.locator('.split-badge-pill', { hasText: new RegExp(`^${pill}$`) }),
  });
}

test('Navigation names the view it drives only while several views are open', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');

  const row = page.locator('#navigation-view-target');
  const target = page.locator('#navigation-view-target-badge');
  await expect(row).toBeHidden();

  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('#split-view-badges-list .split-badge')).toHaveCount(2);
  // Cameras start linked, and both views show one representation: the
  // settings drive the focused (kept) view and the view linked to it.
  await expect(row).toBeVisible();
  await expect(target.locator('.split-badge-pill')).toHaveText('2');
  await expect(target).toHaveClass(/active-camera/);
  const shown = await viewBadge(page, '2').locator('.split-badge-label').textContent();
  await expect(target.locator('.split-badge-label')).toHaveText(`${shown} · with view 1`);

  await page.locator('#camera-lock-btn').click();
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.getCamerasLocked()),
  ).toBe(false);
  for (const pill of ['2', '1']) {
    await viewBadge(page, pill).click();
    await expect(target.locator('.split-badge-pill')).toHaveText(pill);
    await expect(target).toHaveClass(/active-camera/);
    const label = await viewBadge(page, pill).locator('.split-badge-label').textContent();
    await expect(target.locator('.split-badge-label')).toHaveText(label);
  }

  await viewBadge(page, '2').locator('.split-badge-remove').click();
  await expect(page.locator('#split-view-badges-list .split-badge')).toHaveCount(1);
  await expect(row).toBeHidden();
  expect(errors).toEqual([]);
});
