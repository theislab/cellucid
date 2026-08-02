import { expect, test } from './helpers/test.mjs';

test('invalid explicit remote intent stops on one visible startup failure', async ({
  page
}, testInfo) => {
  const pageErrors = [];
  const failedResponses = [];
  page.on('pageerror', error => {
    pageErrors.push(error.stack || error.message);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      failedResponses.push(`${response.status()}: ${response.url()}`);
    }
  });

  await page.goto('/?remote=', { waitUntil: 'domcontentloaded' });
  const failure = page.locator('#cellucid-startup-failure');
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute('role', 'alert');
  await expect(failure).toContainText('Cellucid could not start');
  await expect(failure).toContainText(
    'Startup URL parameter "remote" must be one non-empty exact value.'
  );
  await expect(failure).toHaveCount(1);
  await expect(page.locator('#dataset-cells')).not.toHaveText('120');
  await page.screenshot({
    path: testInfo.outputPath(
      `startup-failure-${testInfo.project.name}.png`
    ),
    fullPage: true
  });

  expect(pageErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});
