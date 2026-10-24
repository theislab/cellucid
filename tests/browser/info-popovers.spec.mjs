import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const PREPARED_DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=info-popovers-ci`;

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
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture'
  );

  await page.locator('#theme-select').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(
    () => page.locator('.sidebar-logo').evaluate(element => (
      getComputedStyle(element).filter
    ))
  ).toBe('invert(1) hue-rotate(180deg)');
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
    'File…: an .h5ad file, or a .zarr.zip archive holding one AnnData Zarr store'
  );
  expect(
    await localPopover.evaluate(popover => popover.parentElement === document.body)
  ).toBe(true);
  await expectInsideViewport(localPopover, page);

  // Tab walks the tip: its close button, then each docs link, then on past
  // the trigger.
  await page.keyboard.press('Tab');
  await expect(localPopover.locator('.info-tip-close')).toBeFocused();
  const links = localPopover.locator('a.info-tip-link');
  await expect(links).toHaveCount(3);
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(link).toHaveAttribute('href', /^https:\/\/docs\.cellucid\.com\/en\/latest\/user_guide\/web_app\/[a-z0-9_/]+\.html#[a-z0-9-]+$/);
    await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
  }
  await page.keyboard.press('Tab');
  await expect(localPopover).toBeHidden();
  await expect(localButton).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#user-data-open-btn')).toBeFocused();

  await localButton.click();
  await expect(localPopover).toBeVisible();
  await page.locator('#data-address-info-btn').focus();
  await expect(localPopover).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(page.locator('#data-address-info-tooltip')).toBeVisible();
  await expect(page.locator('body > #data-address-info-tooltip')).toHaveCount(1);
  await page.locator('#glcanvas').click({ position: { x: 900, y: 500 } });
  await expect(page.locator('#data-address-info-tooltip')).toBeHidden();

  const sessionButton = page.locator('#session-state-info-btn');
  await sessionButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#session-state-info-tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#session-state-info-tooltip')).toBeHidden();
  await expect(sessionButton).toBeFocused();

  // The close button in the tip's title row dismisses it as Escape does.
  await sessionButton.click();
  const sessionPopover = page.locator('#session-state-info-tooltip');
  await expect(sessionPopover.locator('.info-tip-title')).toHaveText('Session file');
  await sessionPopover.locator('.info-tip-close').click();
  await expect(sessionPopover).toBeHidden();
  await expect(sessionButton).toBeFocused();

  const communityButton = page.getByRole('button', {
    name: 'About community annotation'
  });
  await page.locator('#community-annotation-section > summary').click();
  await expect(page.locator('#community-annotation-section')).toHaveAttribute('open', '');
  await communityButton.click();
  await expect(page.locator('#community-annotation-info-1')).toBeVisible();
  await expect(page.locator('#community-annotation-info-1')).toContainText(
    'Connect an annotation repository to start'
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

test('how a control was set and what a tool needs lead their (i) tips, not the sidebar', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');

  // Antialiasing: the sidebar shows the checkbox only; its (i) says how it
  // was chosen, first under the title.
  await expect(page.locator('#antialias-controls .status-line')).toHaveCount(0);
  await page.locator('#antialias-info-btn').click();
  const antialias = page.locator('#antialias-info-tooltip');
  await expect(antialias).toBeVisible();
  const antialiasLine = antialias.locator('.info-tooltip-content > :nth-child(2)');
  await expect(antialiasLine).toHaveId('hp-antialias-status');
  await expect(antialiasLine).toHaveText(/^Chosen automatically: [\d,]+ cells in [123]D\.$/);
  await page.keyboard.press('Escape');
  // Once chosen by hand, the line goes and the tip is only the tip.
  await page.locator('#hp-antialias').click();
  await page.locator('#antialias-info-btn').click();
  await expect(antialias.locator('#hp-antialias-status')).toBeHidden();
  await page.keyboard.press('Escape');

  // Highlighting: nothing under the Tool buttons until a gesture did
  // something; the (i) leads with the tool's gesture or what it needs first.
  const description = page.locator('#highlight-mode-description');
  await expect(description).toBeEmpty();
  await expect(description).toBeHidden();
  await page.locator('#highlight-selection-info-btn').click();
  const selection = page.locator('#highlight-selection-info-tooltip');
  await expect(selection).toBeVisible();
  const hint = selection.locator('.info-tooltip-content > :nth-child(2)');
  await expect(hint).toHaveId('highlight-tool-hint');
  await expect(hint).toHaveText(/^(Alt\+click a cell to select its group\.|Color by a field first \(Coloring & filtering\), then Alt\+click a cell\.)$/);
  await page.keyboard.press('Escape');
  await page.locator('#highlight-mode-lasso').click();
  await page.locator('#highlight-selection-info-btn').click();
  await expect(selection.locator('#highlight-tool-hint')).toHaveText('Alt+draw around cells to select them.');
  await page.keyboard.press('Escape');
  expect(productErrors).toEqual([]);
});
