/**
 * Keyboard paths found by the accessibility lens (2026-11-11), held where
 * they show: in the running browser.
 *
 * - LF-5: Tab in an open menu moved focus to the page's first stop (the
 *   plot): an open menu is moved to the end of the page so no panel clips
 *   it, and the browser's Tab went on from there. The menu now hands focus
 *   back to its opener first; Tab goes to the control after the opener,
 *   Shift+Tab to the one before it.
 * - LF-6: the history search's Filter said its menu was closed while open;
 *   the shared menu owns its button's `aria-expanded` and `aria-controls`.
 * - LF-1: the legend's color swatches took focus with no visible ring (an
 *   invisible color input laid over the swatch); the swatch draws it.
 * - LF-4: `?` with the sidebar hidden opened the shortcuts inside the hidden,
 *   inert sidebar; it shows the sidebar and moves focus to the panel.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { waitForPageAtRest } from './helpers/dataset-ready.mjs';
import { tabKey } from './helpers/dialog-keys.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}` +
  '&dataset=current-ui&acceptance=keyboard-menus-and-focus-ci';

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function openApp(page) {
  const errors = observeProductErrors(page);
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await waitForPageAtRest(page);
  return errors;
}

const activeId = page => page.evaluate(() => document.activeElement?.id ?? '');

test('Tab and Shift+Tab leave an open menu to the controls beside its button', async ({ page }) => {
  const errors = await openApp(page);
  const open = page.locator('#user-data-open-btn');
  await expect(open).toBeEnabled();
  // The stops on either side of Open…, as the page orders them.
  await open.focus();
  await page.keyboard.press('Tab');
  const after = await activeId(page);
  await open.focus();
  await page.keyboard.press('Shift+Tab');
  const before = await activeId(page);
  expect(after).not.toBe('');
  expect(before).not.toBe('');

  for (const [key, expected] of [['Tab', after], ['Shift+Tab', before]]) {
    await open.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#user-data-open-menu')).toBeVisible();
    await expect(open).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#user-data-open-menu [role="menuitem"]').first()).toBeFocused();
    await page.keyboard.press(key);
    await expect(page.locator('#user-data-open-menu')).toBeHidden();
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(await activeId(page), `${key} from the open menu`).toBe(expected);
  }
  expect(errors).toEqual([]);
});

test('a menu built for the moment states itself open on its button and returns focus', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => { document.getElementById('state-section').open = true; });
  const search = page.locator('#history-search-btn');
  await expect(search).toBeEnabled();
  await search.click();
  const filter = page.locator('#history-filter-btn');
  await expect(filter).toBeVisible();
  await filter.focus();
  await page.keyboard.press('Enter');
  const menu = page.locator('.popup-menu[role="menu"]');
  await expect(menu).toBeVisible();
  await expect(filter).toHaveAttribute('aria-expanded', 'true');
  const menuId = await menu.getAttribute('id');
  expect(menuId).toBeTruthy();
  await expect(filter).toHaveAttribute('aria-controls', menuId);
  await expect(menu.locator('.open-menu-item').first()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(menu.locator('.open-menu-item').last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(filter).toBeFocused();
  await expect(filter).toHaveAttribute('aria-expanded', 'false');
  await expect(filter).not.toHaveAttribute('aria-controls', /./);

  // Tab: closed, and focus goes on from Filter, not to the top of the page.
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
  expect(await activeId(page)).not.toBe('glcanvas');
  expect(await page.evaluate(() => document.getElementById('history-filter-btn')
    .compareDocumentPosition(document.activeElement) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
  expect(errors).toEqual([]);
});

test('a legend color swatch shows the focus ring its invisible input cannot', async ({ page, browserName }) => {
  const errors = await openApp(page);
  await page.evaluate(() => { document.getElementById('coloring-filtering-section').open = true; });
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  const checkbox = page.locator('.legend-item').first().locator('input[type="checkbox"]');
  const input = page.locator('.legend-item').first().locator('.legend-color-input');
  await checkbox.focus();
  if (browserName === 'webkit') {
    // WebKit leaves an <input type="color"> out of the Tab order, Option held
    // or not (measured on macOS and Linux: Tab goes from the checkbox to the
    // label): the key moves focus as the keyboard does, and the input is then
    // focused after it, still a keyboard focus (`:focus-visible`).
    await page.keyboard.press(tabKey(browserName));
    await input.focus();
  } else {
    await page.keyboard.press('Tab');
  }
  await expect(input).toBeFocused();
  const ring = await page.locator('.legend-item').first().locator('.legend-swatch').evaluate(swatch => {
    const style = getComputedStyle(swatch);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(ring).toEqual({ style: 'solid', width: 2 });
  // A pointer focus draws no ring (`:focus-visible` only).
  await page.locator('#glcanvas').focus();
  const idle = await page.locator('.legend-item').first().locator('.legend-swatch')
    .evaluate(swatch => getComputedStyle(swatch).outlineStyle);
  expect(idle).toBe('none');
  expect(errors).toEqual([]);
});

test('? shows a hidden sidebar and moves focus to the keyboard shortcuts', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('#glcanvas').focus();
  await page.keyboard.press('h');
  await expect(page.locator('#sidebar')).toHaveClass(/\bhidden\b/);
  await page.keyboard.press('?');
  await expect(page.locator('#sidebar')).not.toHaveClass(/\bhidden\b/);
  await expect(page.locator('#shortcuts-section')).toHaveAttribute('open', '');
  await expect(page.locator('#shortcuts-section > summary')).toBeFocused();
  await expect(page.locator('#shortcuts-section > summary')).toBeInViewport();
  expect(errors).toEqual([]);
});
