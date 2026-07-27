import { expect, test } from '@playwright/test';

const DEFAULT_STARTUP_URL =
  '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&acceptance=startup-defaults-ci';

test('every startup shows onboarding and adopts the catalog default with exact UI defaults', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.removeItem('cellucid_viewer_background');
  });
  await page.goto(DEFAULT_STARTUP_URL, { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#welcome-modal')).toBeVisible();
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');
  await expect(page.locator('#dataset-select')).toHaveValue(
    'dataset:local-demo:current-ui-prepared',
  );
  await expect(page.locator('#cinematic-camera-section')).not.toHaveAttribute('open', '');
  await expect(page.locator('#community-annotation-section')).not.toHaveAttribute('open', '');
  await expect(page.locator('html')).toHaveAttribute('data-viewer-background', 'grid');
  await expect(page.locator('#background-select')).toHaveValue('grid');
  await expect(page.locator('#cinematic-autoplay')).not.toBeChecked();

  const buildIdentity = await page.evaluate(() => ({
    meta: document
      .querySelector('meta[name="cellucid-web-build-id"]')
      ?.getAttribute('content'),
    footer: document.getElementById('web-build-version')?.textContent,
  }));
  expect(buildIdentity.meta).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  expect(buildIdentity.footer).toBe(buildIdentity.meta);

  await page.keyboard.press('Escape');
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#welcome-modal')).toBeVisible();
});
