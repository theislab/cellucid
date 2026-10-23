/**
 * On a phone the sidebar fills the screen, so its close control must stay on
 * screen too.
 *
 * The mobile layout makes the sidebar the full viewport width and used to
 * place the open-state toggle beside it — one pixel past the right edge — so a
 * phone user saw only the menu and had no way to reach the plot behind it.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { expectFloatingSettled } from './helpers/panels.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=mobile-layout-ci';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

function topmostAt(page, selectorAtPoint) {
  return page.evaluate(({ selector, at }) => {
    const element = document.querySelector(selector);
    const box = element.getBoundingClientRect();
    const x = at === 'viewport-center' ? innerWidth / 2 : box.x + box.width / 2;
    const y = at === 'viewport-center' ? innerHeight / 2 : box.y + box.height / 2;
    const hit = document.elementFromPoint(x, y);
    return hit === element || element.contains(hit);
  }, selectorAtPoint);
}

test('a phone can close the full-screen sidebar and reach the plot', async ({
  page,
}) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );

  const sidebar = page.locator('#sidebar');
  const toggle = page.locator('#sidebar-toggle');
  await expect(sidebar).not.toHaveClass(/\bhidden\b/);
  await expect(toggle).toHaveAttribute('aria-label', 'Hide sidebar');

  const viewport = page.viewportSize();
  const openBox = await toggle.boundingBox();
  expect(openBox.x).toBeGreaterThanOrEqual(0);
  expect(openBox.y).toBeGreaterThanOrEqual(0);
  expect(openBox.x + openBox.width).toBeLessThanOrEqual(viewport.width);
  expect(
    await topmostAt(page, { selector: '#sidebar-toggle', at: 'element' }),
    'the close control is not covered by the sidebar',
  ).toBe(true);

  // The control sits in its own strip and covers no sidebar content.
  const firstContentTop = await page.evaluate(() => {
    const rendered = [...document.querySelector('#sidebar').children].find(
      child => {
        const style = getComputedStyle(child);
        return style.display !== 'none' && style.position !== 'absolute';
      },
    );
    return rendered.getBoundingClientRect().top;
  });
  expect(firstContentTop).toBeGreaterThanOrEqual(openBox.y + openBox.height);

  await toggle.click();
  await expect(sidebar).toHaveClass(/\bhidden\b/);
  await expect(toggle).toHaveAttribute('aria-label', 'Show sidebar');
  await expect.poll(
    () => topmostAt(page, { selector: '#glcanvas', at: 'viewport-center' }),
    { message: 'the plot is reachable once the sidebar is closed' },
  ).toBe(true);

  await toggle.click();
  await expect(sidebar).not.toHaveClass(/\bhidden\b/);
  const reopenedBox = await toggle.boundingBox();
  expect(reopenedBox.x + reopenedBox.width).toBeLessThanOrEqual(viewport.width);
});

test('a phone gets fingertip-sized icon controls', async ({ page }) => {
  // The icon-only controls are drawn for a cursor: 16px field actions and
  // legend buttons, 20px panel buttons, 10px page swatches. On a touch screen
  // they are drawn 36px square (swatches and checkboxes 16-20px), and the
  // boxed ones reach a 42px hit area past that (ui-type-and-touch.spec.mjs);
  // the desktop layout keeps its density, which `ui-visual-consistency.spec.mjs`
  // covers.
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches))
    .toBe(true);
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);

  const sizes = await page.evaluate(() => {
    const measure = selector => [...document.querySelectorAll(selector)]
      .filter(element => element.getClientRects().length > 0)
      .map(element => {
        const box = element.getBoundingClientRect();
        return { selector, width: box.width, height: box.height };
      });
    return [
      ...measure('.field-actions > .icon-btn'),
      ...measure('.legend-rename-btn'),
      ...measure('.legend-delete-btn'),
      ...measure(
        '.accordion-panel:has(> #session-section) > .accordion-panel-actions'
        + ' > .accordion-undock-btn',
      ),
      ...measure('.disclosure-header-row > .accordion-copy-btn'),
      ...measure('.highlight-page-add-btn'),
    ];
  });
  expect(sizes.length).toBeGreaterThan(10);
  for (const size of sizes) {
    expect(size.width, size.selector).toBeGreaterThanOrEqual(36);
    expect(size.height, size.selector).toBeGreaterThanOrEqual(36);
  }

  const swatch = await page.locator('.legend-swatch').first().boundingBox();
  expect(swatch.width).toBeGreaterThanOrEqual(20);
  const pageSwatch = await page.locator('.highlight-page-color').first()
    .boundingBox();
  expect(pageSwatch.width).toBeGreaterThanOrEqual(16);

  // The larger tab buttons must not squeeze the page name out of its tab.
  await page.locator('#add-highlight-page').click();
  await expect(page.locator('.highlight-page-tab')).toHaveCount(2);
  for (const name of await page.locator('.highlight-page-tab-name').all()) {
    const fits = await name.evaluate(
      element => element.scrollWidth <= element.clientWidth + 1
        && element.clientWidth > 0,
    );
    expect(fits).toBe(true);
  }
  for (const control of await page.locator(
    '.highlight-page-tab-combine, .highlight-page-tab-delete',
  ).all()) {
    const box = await control.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.height).toBeGreaterThanOrEqual(24);
  }
});

test('a screen without hover shows the controls that wait for one', async ({
  page,
}) => {
  // The analysis copy buttons sat at 35% opacity and the page-tab buttons at
  // 50% until a pointer hovered them, so on a phone they looked disabled for
  // good; the plot toolbar was invisible until hovered.
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  expect(await page.evaluate(() => matchMedia('(hover: none)').matches))
    .toBe(true);
  const opacities = await page.evaluate(() =>
    [...document.querySelectorAll(
      '.disclosure-header-row > .accordion-copy-btn,'
      + ' .highlight-page-tab-combine, .highlight-page-tab-delete',
    )].map(element => Number(getComputedStyle(element).opacity)));
  expect(opacities.length).toBeGreaterThan(5);
  for (const opacity of opacities) expect(opacity).toBeGreaterThanOrEqual(0.9);
});

test('a finger moves a floating panel by its header', async ({ page }) => {
  // Floating panels ignored touch: once undocked on a touch screen a panel
  // could be docked back but never moved or resized, because the drag handlers
  // returned early for every touch pointer.
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  const panel = page.locator('.accordion-panel:has(> #shortcuts-section)');
  await panel.locator('> .accordion-panel-actions > .accordion-undock-btn').click();
  // The start position is read once the lift, which scales the frame, is over.
  await expectFloatingSettled(panel);
  // Close the full-screen sidebar so the panel has room to move.
  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#sidebar')).toHaveClass(/\bhidden\b/);

  const before = await panel.boundingBox();
  await page.evaluate(() => {
    const summary = document.querySelector('#shortcuts-section > summary');
    const box = summary.getBoundingClientRect();
    const start = { x: box.left + 40, y: box.top + box.height / 2 };
    const fire = (type, dx, dy) => summary.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      pointerType: 'touch',
      isPrimary: true,
      button: type === 'pointermove' ? -1 : 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: start.x + dx,
      clientY: start.y + dy,
    }));
    fire('pointerdown', 0, 0);
    // Undocking leaves the panel against the bottom edge; drag it upward.
    for (let step = 1; step <= 6; step++) fire('pointermove', step * 4, step * -25);
    fire('pointerup', 24, -150);
  });
  await expect.poll(async () => (await panel.boundingBox()).y)
    .toBeLessThan(before.y - 100);
  expect(await page.evaluate(() => getComputedStyle(
    document.querySelector('#shortcuts-section > summary'),
  ).touchAction)).toBe('none');
});

test('a swipe that starts on a notification still reaches the sidebar menu', async ({
  page,
}) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  // An error stays until dismissed, so it is on screen for the whole check.
  await page.evaluate(async () => {
    const { getNotificationCenter } = await import(
      '/assets/js/app/notification-center.js'
    );
    getNotificationCenter().error('Mobile layout probe notification');
  });
  const card = page.locator('.notification', {
    hasText: 'Mobile layout probe notification',
  });
  await expect(card).toBeVisible();
  // Measure once the card has finished sliding in.
  await expect(card).toHaveClass(/notification-enter/);
  await expect.poll(() => card.evaluate(element => getComputedStyle(element).transform))
    .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
  const hits = await card.evaluate(element => {
    const box = element.getBoundingClientRect();
    const body = document.elementFromPoint(box.left + box.width / 3, box.top + box.height / 2);
    const button = element.querySelector('button');
    const buttonBox = button.getBoundingClientRect();
    const onButton = document.elementFromPoint(
      buttonBox.left + buttonBox.width / 2,
      buttonBox.top + buttonBox.height / 2,
    );
    return {
      bodyReachesSidebar: Boolean(body?.closest('#sidebar')),
      buttonStillHit: onButton === button || button.contains(onButton),
    };
  });
  // The card's body passes the finger to the menu under it; its dismiss
  // button still takes the tap.
  expect(hits).toEqual({ bodyReachesSidebar: true, buttonStillHit: true });

  const scroller = page.locator('.sidebar-scroll');
  const before = await scroller.evaluate(element => element.scrollTop);
  const box = await card.boundingBox();
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => scroller.evaluate(element => element.scrollTop))
    .toBeGreaterThan(before);
});

test('the full-screen menu closes before the first dataset has loaded', async ({
  page,
}) => {
  // Hold every export request, so the first dataset cannot finish loading
  // while the menu is tried: its ✕ is the only way to the plot on a phone.
  let releaseCatalog;
  const catalogHeld = new Promise(resolve => { releaseCatalog = resolve; });
  await page.route('**/tests/browser/fixtures/catalog/**', async route => {
    await catalogHeld;
    await route.continue().catch(() => {});
  });
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  const sidebar = page.locator('#sidebar');
  await expect(sidebar).not.toHaveClass(/\bhidden\b/);
  await expect(page.locator('#dataset-name')).not.toHaveText(
    'Current UI fixture',
  );
  await page.locator('#sidebar-toggle').tap();
  await expect(sidebar).toHaveClass(/\bhidden\b/);
  await page.locator('#sidebar-toggle').tap();
  await expect(sidebar).not.toHaveClass(/\bhidden\b/);
  releaseCatalog();
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
});

test('the selection bar hides while the full-screen menu is open', async ({
  page,
}) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  const bar = page.locator('#select-bar');
  await expect(page.locator('#sidebar')).not.toHaveClass(/\bhidden\b/);
  await expect(bar).toBeHidden();
  await page.locator('#sidebar-toggle').tap();
  await expect(page.locator('#sidebar')).toHaveClass(/\bhidden\b/);
  await expect(bar).toBeVisible();
  // With Select mode off it is only the switch, centred at the bottom.
  await expect(page.locator('#select-bar-hint')).toBeHidden();
  await expect(page.locator('#select-bar-combine')).toBeHidden();
  // The bar is placed from the viewer's presented layout, which is published
  // on the frame after the menu closes; until then the shown switch row may
  // still be growing to its final width.
  const viewport = page.viewportSize();
  let box;
  await expect.poll(async () => {
    box = await page.locator('.select-bar-card').boundingBox();
    return Math.abs(box.x + box.width / 2 - viewport.width / 2);
  }).toBeLessThan(2);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(box.width).toBeLessThan(viewport.width / 2);
});
