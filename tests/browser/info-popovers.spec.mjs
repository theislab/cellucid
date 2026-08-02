import { expect, test } from '@playwright/test';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const PREPARED_DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=info-popovers-ci`;

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      errors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return errors;
}

async function expectInsideViewport(locator, page) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.y).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 8);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 8);
}

test('compact information popovers are accessible, exclusive, and viewport-safe', async ({
  page
}, testInfo) => {
  const productErrors = observeProductErrors(page);
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );

  await page.locator('#theme-select').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(
    () => page.locator('.sidebar-brand').evaluate(element => (
      getComputedStyle(element).backgroundColor
    ))
  ).toBe('rgb(255, 255, 255)');
  await page.locator('#theme-select').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  const semantics = await page.locator('button.info-btn').evaluateAll(buttons => (
    buttons.map(button => {
      const popover = document.getElementById(
        button.getAttribute('aria-controls')
      );
      return {
        buttonTag: button.localName,
        type: button.getAttribute('type'),
        label: button.getAttribute('aria-label'),
        expanded: button.getAttribute('aria-expanded'),
        hasPopup: button.getAttribute('aria-haspopup'),
        popoverExists: popover !== null,
        popoverRole: popover?.getAttribute('role') || null,
        labelledBy: popover?.getAttribute('aria-labelledby') || null,
        triggerId: button.id,
        hidden: popover?.hidden ?? null
      };
    })
  ));
  expect(semantics.length).toBeGreaterThan(18);
  for (const pair of semantics) {
    expect(pair).toEqual({
      buttonTag: 'button',
      type: 'button',
      label: expect.stringMatching(/\S/),
      expanded: 'false',
      hasPopup: 'dialog',
      popoverExists: true,
      popoverRole: 'dialog',
      labelledBy: pair.triggerId,
      triggerId: pair.triggerId,
      hidden: true
    });
  }

  const localButton = page.locator('#user-data-info-btn');
  const localPopover = page.locator('#user-data-info-tooltip');
  await localButton.click();
  await expect(localButton).toHaveAttribute('aria-expanded', 'true');
  await expect(localPopover).toBeVisible();
  await expect(localPopover).toBeFocused();
  await expect(localPopover).toContainText(
    'Zarr ZIP: Load a .zarr.zip or .zip archive'
  );
  expect(
    await localPopover.evaluate(popover => popover.parentElement === document.body)
  ).toBe(true);
  await expectInsideViewport(localPopover, page);

  await page.keyboard.press('Tab');
  await expect(localPopover.locator('a')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(localPopover).toBeHidden();
  await expect(localButton).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#user-data-h5ad-btn')).toBeFocused();

  await localButton.click();
  await expect(localPopover).toBeVisible();
  await page.locator('#remote-info-btn').focus();
  await expect(localPopover).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(page.locator('#remote-info-tooltip')).toBeVisible();
  await expect(page.locator('body > #remote-info-tooltip')).toHaveCount(1);
  await page.locator('#glcanvas').click({ position: { x: 900, y: 500 } });
  await expect(page.locator('#remote-info-tooltip')).toBeHidden();

  const sessionButton = page.locator('#session-state-info-btn');
  await sessionButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#session-state-info-tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#session-state-info-tooltip')).toBeHidden();
  await expect(sessionButton).toBeFocused();

  const communityButton = page.getByRole('button', {
    name: 'About community annotation'
  });
  await page.locator('#community-annotation-section > summary').click();
  await expect(page.locator('#community-annotation-section')).toHaveAttribute('open', '');
  await communityButton.click();
  await expect(page.locator('#community-annotation-info-1')).toBeVisible();
  await expect(page.locator('#community-annotation-info-1')).toContainText(
    'Connect an annotation repo'
  );
  await page.keyboard.press('Escape');
  await expect(communityButton).toBeFocused();

  await page.locator('#benchmark-section > summary').click();
  await expect(page.locator('#benchmark-section')).toHaveAttribute('open', '');
  await page.locator('#benchmark-info-btn').evaluate(button => {
    const scroller = document.querySelector('.sidebar-scroll');
    const scrollerRect = scroller.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    scroller.scrollTop += buttonRect.bottom - scrollerRect.bottom + 12;
  });
  await expect.poll(
    () => page.locator('#benchmark-info-btn').evaluate(button => {
      const scrollerRect = document
        .querySelector('.sidebar-scroll')
        .getBoundingClientRect();
      return button.getBoundingClientRect().bottom <= scrollerRect.bottom - 8;
    })
  ).toBe(true);
  await page.locator('#benchmark-info-btn').click();
  const benchmarkPopover = page.locator('#benchmark-info-tooltip');
  await expect(benchmarkPopover).toBeVisible();
  await expect(benchmarkPopover).toHaveAttribute('data-placement', 'above');
  await expectInsideViewport(benchmarkPopover, page);

  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    document.querySelector('.sidebar-scroll').scrollTop = 0;
  });
  await expect(page.locator('#notification-center .notification')).toHaveCount(0);
  await localButton.click();
  await expect(localPopover).toBeVisible();
  const screenshotPath = testInfo.outputPath(
    `compact-information-${testInfo.project.name}.png`
  );
  await page.screenshot({ path: screenshotPath });
  await testInfo.attach(`compact-information-${testInfo.project.name}.png`, {
    path: screenshotPath,
    contentType: 'image/png'
  });

  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 700 });
  await localButton.click();
  await expect(localPopover).toBeVisible();
  await expectInsideViewport(localPopover, page);
  await page.keyboard.press('Escape');

  const webglError = await page.locator('#glcanvas').evaluate(canvas => (
    canvas.getContext('webgl2').getError()
  ));
  await page.evaluate(() => {
    const event = new Event('pagehide');
    Object.defineProperty(event, 'persisted', { value: true });
    window.dispatchEvent(event);
  });
  await localButton.click();
  await expect(localPopover).toBeVisible();
  await page.keyboard.press('Escape');

  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await localButton.click();
  await expect(localPopover).toBeHidden();
  await expect(localButton).toHaveAttribute('aria-expanded', 'false');

  expect(webglError).toBe(0);
  expect(productErrors).toEqual([]);
});
