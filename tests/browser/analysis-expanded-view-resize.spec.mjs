/**
 * The expanded view (`analysis/ui/components/modal.js`) resizes from every
 * edge and corner by mouse, finger and keyboard, moves by its header with any
 * pointer, maximizes on a header double-click, keeps a content-derived least
 * size, remembers its size and splits per analysis, and fills a phone screen
 * with a touch grip on its split.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=analysis-expanded-view-resize-ci';
const MODAL_URL = '/assets/js/app/analysis/ui/components/modal.js';

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

/**
 * Open an expanded view the way an analysis does: from a control inside the
 * docked Detailed analysis, so its sizes are Detailed's.
 */
async function openView(page) {
  await page.evaluate(async url => {
    const { createAnalysisModal, openModal } = await import(url);
    const region = document.querySelector('.analysis-mode-content[data-mode="detailed"]');
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.className = 'spec-opener';
    opener.textContent = 'Open';
    region.hidden = false;
    region.appendChild(opener);
    opener.focus();
    const modal = createAnalysisModal();
    window.__specModal = modal;
    openModal(modal);
  }, MODAL_URL);
  const content = page.locator('.analysis-modal.open .analysis-modal-content');
  await expect(content).toBeVisible();
  // The open transition scales the box; measure once it is over.
  await expect.poll(() => content.evaluate(element => getComputedStyle(element).transform))
    .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
  return content;
}

async function closeView(page) {
  await page.keyboard.press('Escape');
  await expect(page.locator('.analysis-modal')).toHaveCount(0);
}

function layout(content) {
  return content.evaluate(element => ({
    left: element.offsetLeft,
    top: element.offsetTop,
    width: element.offsetWidth,
    height: element.offsetHeight,
    options: element.querySelector('.analysis-modal-options').offsetWidth,
    footer: element.querySelector('.analysis-modal-footer-area').offsetHeight
  }));
}

test('every edge and corner resizes by mouse; the header moves it; the least size is the content\'s', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openDataset(page);
  const content = await openView(page);
  await expect(content.locator('> .analysis-modal-edge-resize')).toHaveCount(8);
  const start = await layout(content);

  const drag = async (edge, dx, dy) => {
    const handle = await content.locator(`> .analysis-modal-edge-resize-${edge}`).boundingBox();
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 6 });
    await page.mouse.up();
  };
  await drag('nw', -40, -30);
  const grown = await layout(content);
  expect(grown.left).toBe(start.left - 40);
  expect(grown.top).toBe(start.top - 30);
  expect(grown.width).toBe(start.width + 40);
  expect(grown.height).toBe(start.height + 30);

  // Shrinking stops at the content's least size, not at a fixed 600 × 500.
  await drag('se', -2000, -2000);
  const least = await layout(content);
  expect(least.width).toBeLessThan(600);
  expect(least.width).toBeGreaterThanOrEqual(450);
  expect(least.height).toBeLessThan(500);

  // The header moves it.
  const header = await content.locator('.analysis-modal-header').boundingBox();
  await page.mouse.move(header.x + 40, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + 140, header.y + header.height / 2 + 60, { steps: 6 });
  await page.mouse.up();
  const moved = await layout(content);
  expect(moved.left).toBe(least.left + 100);
  expect(moved.top).toBe(least.top + 60);

  // A double-click on the header fills the window; again restores.
  await content.locator('.analysis-modal-header').dblclick();
  const viewport = page.viewportSize();
  const full = await layout(content);
  expect([full.left, full.top, full.width, full.height]).toEqual([8, 8, viewport.width - 16, viewport.height - 16]);
  await content.locator('.analysis-modal-header').dblclick();
  expect(await layout(content)).toEqual(moved);
  expect(errors).toEqual([]);
});

test('a finger moves the view and resizes it (pointer events)', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openDataset(page);
  const content = await openView(page);
  const start = await layout(content);
  await content.locator('> .analysis-modal-edge-resize-e').evaluate(element => {
    const rect = element.getBoundingClientRect();
    const fire = (type, dx) => element.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 21, pointerType: 'touch', isPrimary: true,
      button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: rect.left + rect.width / 2 + dx, clientY: rect.top + rect.height / 2,
    }));
    fire('pointerdown', 0);
    for (let step = 1; step <= 4; step++) fire('pointermove', step * 15);
    fire('pointerup', 60);
  });
  await expect.poll(async () => (await layout(content)).width).toBe(start.width + 60);
  expect(errors).toEqual([]);
});

test('keyboard: the corner and the splitters move by arrow keys and report their values', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openDataset(page);
  const content = await openView(page);
  const start = await layout(content);
  const corner = content.locator('> .analysis-modal-edge-resize-se');
  await expect(corner).toHaveAttribute('tabindex', '0');
  await expect(corner).toHaveAttribute('role', 'separator');
  await corner.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  const keyed = await layout(content);
  expect(keyed.width).toBe(start.width + 16);
  expect(keyed.height).toBe(start.height + 64);
  await expect(corner).toHaveAttribute('aria-valuetext', `${keyed.width} × ${keyed.height} pixels`);

  const splitter = content.locator('.analysis-modal-body > .analysis-modal-resizer-vertical');
  await expect(splitter).toHaveAttribute('aria-orientation', 'vertical');
  await splitter.focus();
  await page.keyboard.press('ArrowLeft');
  expect((await layout(content)).options).toBe(keyed.options + 16);
  await expect(splitter).toHaveAttribute('aria-valuenow', String(keyed.options + 16));
  const footer = content.locator('> .analysis-modal-resizer-horizontal');
  await footer.focus();
  await page.keyboard.press('ArrowUp');
  expect((await layout(content)).footer).toBe(keyed.footer + 16);
  expect(errors).toEqual([]);
});

test('the next view of the same analysis opens at the size and splits last given', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openDataset(page);
  let content = await openView(page);
  const corner = content.locator('> .analysis-modal-edge-resize-se');
  await corner.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await content.locator('.analysis-modal-body > .analysis-modal-resizer-vertical').focus();
  await page.keyboard.press('Shift+ArrowLeft');
  const given = await layout(content);
  const remembered = await page.evaluate(async () => {
    const { analysisViewSizes } = await import('/assets/js/app/analysis/shared/analysis-view-sizes.js');
    return analysisViewSizes.expandedViewSize('detailed');
  });
  expect(remembered).toMatchObject({ width: given.width, height: given.height, optionsWidth: given.options });
  await closeView(page);
  content = await openView(page);
  const reopened = await layout(content);
  expect([reopened.width, reopened.height, reopened.options, reopened.footer])
    .toEqual([given.width, given.height, given.options, given.footer]);
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the view fills the screen, edges hidden, with a 24 px grip on its split', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openDataset(page);
    const content = await openView(page);
    const box = await content.boundingBox();
    expect([box.x, box.y, box.width, box.height]).toEqual([0, 0, 390, 844]);
    await expect(content.locator('> .analysis-modal-edge-resize-se')).toBeHidden();
    const grip = content.locator('> .analysis-modal-resizer-horizontal');
    await expect(grip).toBeVisible();
    expect(Math.round((await grip.boundingBox()).height)).toBe(24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
  });
});
