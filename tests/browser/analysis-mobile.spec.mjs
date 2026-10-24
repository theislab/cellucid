/**
 * Analysis on a phone: every analysis row is reachable at a finger's size,
 * the page never scrolls sideways, and a floating analysis window is a bottom
 * sheet (`app/dockable-accordions/sheets.js`) — full width, 40% / 75% / 100%
 * of the screen by its 24 px grip, collapsed by a tap on its header, one
 * sheet shown with a tab strip for the others — that turns back into a
 * window, at its own place and size, when the screen is wider than 720 px.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { expectFloatingSettled, openCollapsedPanels } from './helpers/panels.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=analysis-mobile-ci';
const WINDOW = '#floating-panels-root > .accordion-panel.analysis-window-frame';
const MODES = ['genesPanel', 'differential', 'dotplot', 'signature', 'composition', 'simple', 'detailed', 'correlation'];

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function openDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
}

function noSidewaysScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

/** The copy button may lie under an open sheet, so it is pressed directly. */
async function copy(page, mode) {
  await page.locator(`.analysis-mode[data-mode="${mode}"] .analysis-mode-copy-btn`).dispatchEvent('click');
}

test('every analysis row is reachable at a finger\'s size, in three groups', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openDataset(page);
  const headings = await page.locator('.analysis-mode-section .section-title').allTextContents();
  expect(headings).toEqual(['Genes', 'Cells', 'Explore']);
  for (const mode of MODES) {
    const header = page.locator(`#analysis-header-${mode}`);
    await header.scrollIntoViewIfNeeded();
    const box = await header.boundingBox();
    // Sub-pixel layout can draw 36 px as 35.99997.
    expect(Math.round(box.height), mode).toBeGreaterThanOrEqual(36);
    expect(box.x + box.width, mode).toBeLessThanOrEqual(390);
  }
  expect(await noSidewaysScroll(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('a window is a bottom sheet with snap heights, a grip, a collapsing header and tabs', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openDataset(page);
  await copy(page, 'simple');
  const first = page.locator(WINDOW).first();
  await expect(first).toHaveClass(/\bfloating-sheet\b/);
  await expect(first).toHaveClass(/\bsheet-active\b/);
  await expectFloatingSettled(first);
  const sheet = await first.boundingBox();
  expect(sheet.x).toBe(0);
  expect(sheet.width).toBe(390);
  expect(Math.round(sheet.y + sheet.height)).toBe(844);
  expect(Math.abs(sheet.height - 844 * 0.75)).toBeLessThanOrEqual(2);
  await expect(first.locator('> .accordion-resize-handle').first()).toBeHidden();

  const grip = first.locator('> .floating-sheet-grip');
  expect(Math.round((await grip.boundingBox()).height)).toBe(24);
  await expect(grip).toHaveAttribute('aria-valuenow', '75');
  // A tap steps up; from the top it goes round to the smallest.
  await grip.tap();
  await expect(grip).toHaveAttribute('aria-valuenow', '100');
  await expect.poll(async () => Math.round((await first.boundingBox()).height)).toBe(844);
  await grip.tap();
  await expect(grip).toHaveAttribute('aria-valuenow', '40');
  // Arrow keys on the grip.
  await grip.focus();
  await page.keyboard.press('ArrowUp');
  await expect(grip).toHaveAttribute('aria-valuenow', '75');

  // A drag on the grip settles on the nearest height.
  await grip.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const fire = (type, y) => element.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 5, pointerType: 'touch', isPrimary: true,
      button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: rect.left + rect.width / 2, clientY: y,
    }));
    fire('pointerdown', rect.top + 5);
    for (let step = 1; step <= 5; step++) fire('pointermove', rect.top + 5 + step * 60);
    fire('pointerup', 844 * 0.62);
  });
  await expect(grip).toHaveAttribute('aria-valuenow', '40');

  // A tap on the header collapses the sheet to it.
  await first.locator('> details > summary').tap();
  await expect(first.locator('> details')).not.toHaveAttribute('open', '');
  const collapsed = await first.boundingBox();
  expect(collapsed.height).toBeLessThan(120);
  expect(Math.round(collapsed.y + collapsed.height)).toBe(844);
  await first.locator('> details > summary').tap();
  await expect(first.locator('> details')).toHaveAttribute('open', '');

  // A second window: one sheet shows, the tab strip names both.
  await copy(page, 'detailed');
  await expect(page.locator(WINDOW)).toHaveCount(2);
  const second = page.locator(WINDOW).nth(1);
  await expect(second).toHaveClass(/\bsheet-active\b/);
  await expect(first).toBeHidden();
  const tabs = second.locator('> .floating-sheet-tabs [role="tab"]');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await tabs.nth(0).tap();
  await expect(first).toBeVisible();
  await expect(second).toBeHidden();
  await expect(first.locator('> .floating-sheet-tabs [role="tab"]').nth(0)).toHaveAttribute('aria-selected', 'true');
  expect(await noSidewaysScroll(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('turning the phone to a screen wider than 720 px gives the window back its place and size', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openDataset(page);
  await copy(page, 'simple');
  const frame = page.locator(WINDOW).first();
  await expect(frame).toHaveClass(/\bfloating-sheet\b/);
  const own = await frame.evaluate(element => ({
    left: Number.parseFloat(element.style.getPropertyValue('--pos-x')),
    width: Number.parseFloat(element.style.getPropertyValue('--pos-width'))
  }));
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(frame).not.toHaveClass(/\bfloating-sheet\b/);
  await expect(frame.locator('> .floating-sheet-grip')).toBeHidden();
  // Measured once the frame has settled at its own box.
  await expect.poll(async () => {
    const drawn = await frame.boundingBox();
    return Math.abs(drawn.x - own.left) <= 1 && Math.abs(drawn.width - Math.min(own.width, 844 - 16)) <= 1;
  }).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(frame).toHaveClass(/\bfloating-sheet\b/);
  expect(errors).toEqual([]);
});
