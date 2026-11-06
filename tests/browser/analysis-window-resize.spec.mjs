/**
 * Floating analysis windows resize from any edge or corner — by mouse, by
 * finger and by keyboard — snap to the lines around them, maximize, move by
 * Alt+Arrow, remember the size per analysis, and round-trip their box and
 * open state through the session (`app/dockable-accordions/*`,
 * `analysis/ui/analysis-window-manager.js`): what a window shows is the
 * `analysis` state domain's (`state/domains/analysis.js`), its box, its fold
 * and the sizes remembered per analysis are the `layout` domain's
 * (`layout.analysis`, `state/domains/layout.js`). No fabricated cap: a window
 * grows to the viewport.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { expectFloatingSettled, openCollapsedPanels } from './helpers/panels.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=analysis-window-resize-ci';
const WINDOW = '#floating-panels-root > .accordion-panel.analysis-window-frame';
const ACTIONS_URL = '/assets/js/app/actions/index.js';
const VALUE_PARTS_URL = '/assets/js/app/history/value-parts.js';

/**
 * A state domain's value (`analysis`, `layout`) as a session file keeps it:
 * its JSON skeleton and its arrays (`app/history/value-parts.js`), read back.
 */
function storedDomain(page, domain) {
  return page.evaluate(async ({ urls, domain: id }) => {
    const { getStateDomains } = await import(urls.actions);
    const { joinValue, splitValue } = await import(urls.parts);
    const arrays = new Map();
    const value = await getStateDomains().owner(id).capture();
    const skeleton = JSON.parse(JSON.stringify(await splitValue(value, arrays)));
    return joinValue(skeleton, digest => arrays.get(digest));
  }, { urls: { actions: ACTIONS_URL, parts: VALUE_PARTS_URL }, domain });
}

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

/** Copy one analysis row into a window and wait for its lift to settle. */
async function copyWindow(page, mode = 'simple') {
  const before = await page.locator(WINDOW).count();
  await page.locator(`.analysis-mode[data-mode="${mode}"] .analysis-mode-copy-btn`).click({ force: true });
  await expect(page.locator(WINDOW)).toHaveCount(before + 1);
  const frame = page.locator(WINDOW).nth(before);
  await expectFloatingSettled(frame);
  return frame;
}

function box(frame) {
  return frame.evaluate(element => {
    const read = name => Number.parseFloat(element.style.getPropertyValue(name));
    return { left: read('--pos-x'), top: read('--pos-y'), width: read('--pos-width'), height: read('--pos-height') };
  });
}

function handle(frame, edge) {
  return frame.locator(`> .accordion-resize-handle[data-edge="${edge}"]`);
}

async function dragHandle(page, frame, edge, dx, dy, { steps = 8 } = {}) {
  const target = await handle(frame, edge).boundingBox();
  const x = target.x + target.width / 2;
  const y = target.y + target.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps });
  await page.mouse.up();
}

test('eight handles resize by mouse; only the dragged edges move; no 500 px cap', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openDataset(page);
  const frame = await copyWindow(page);
  await expect(frame.locator('> .accordion-resize-handle')).toHaveCount(8);

  const start = await box(frame);
  await dragHandle(page, frame, 'se', 90, 70);
  const grown = await box(frame);
  expect(grown.left).toBe(start.left);
  expect(grown.top).toBe(start.top);
  expect(grown.width).toBeGreaterThan(start.width + 60);
  expect(grown.height).toBeGreaterThan(start.height + 40);

  // The left edge moves left; the right edge stays where it was.
  const right = grown.left + grown.width;
  await dragHandle(page, frame, 'w', -50, 0);
  const left = await box(frame);
  expect(left.left).toBeLessThan(grown.left - 30);
  expect(Math.abs(left.left + left.width - right)).toBeLessThanOrEqual(1);

  // Taller than 500 px: the only limit is the viewport. The window first
  // moves to the top (Alt+Shift+ArrowUp, 64 px a press); a pointer leaving
  // the page sends no moves, so the drag ends just inside it.
  await frame.locator('> details > summary').focus();
  for (let press = 0; press < 12; press++) await page.keyboard.press('Alt+Shift+ArrowUp');
  expect((await box(frame)).top).toBe(8);
  const bottom = await handle(frame, 's').boundingBox();
  await dragHandle(page, frame, 's', 0, page.viewportSize().height - 2 - (bottom.y + bottom.height / 2));
  const tall = await box(frame);
  const viewport = page.viewportSize();
  expect(tall.height).toBeGreaterThan(500);
  expect(tall.top + tall.height).toBeLessThanOrEqual(viewport.height - 8);
  const drawn = await frame.boundingBox();
  expect(Math.abs(drawn.height - tall.height)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('a finger resizes from an edge (pointer events, touch-action none)', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openDataset(page);
  const frame = await copyWindow(page);
  const start = await box(frame);
  expect(await handle(frame, 'e').evaluate(element => getComputedStyle(element).touchAction)).toBe('none');
  await handle(frame, 'e').evaluate(element => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const fire = (type, dx) => element.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 11, pointerType: 'touch', isPrimary: true,
      button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: x + dx, clientY: y,
    }));
    fire('pointerdown', 0);
    for (let step = 1; step <= 5; step++) fire('pointermove', step * 13);
    fire('pointerup', 65);
  });
  await expect.poll(async () => (await box(frame)).width).toBeGreaterThan(start.width + 40);
  expect(errors).toEqual([]);
});

test('keyboard: handles join the Tab order inside the window, arrows resize, Alt+Arrow moves', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openDataset(page);
  const frame = await copyWindow(page);
  const east = handle(frame, 'e');
  await expect(east).toHaveAttribute('tabindex', '-1');
  await frame.locator('> details > summary').focus();
  await expect(east).toHaveAttribute('tabindex', '0');
  await expect(east).toHaveAttribute('role', 'separator');
  await expect(east).toHaveAttribute('aria-label', 'Resize window from its right edge');

  await east.focus();
  const start = await box(frame);
  await page.keyboard.press('ArrowRight');
  expect((await box(frame)).width).toBe(start.width + 16);
  await page.keyboard.press('Shift+ArrowRight');
  expect((await box(frame)).width).toBe(start.width + 80);
  await expect(east).toHaveAttribute('aria-valuenow', String(start.width + 80));
  await expect(east).toHaveAttribute('aria-valuetext', `${start.width + 80} × ${start.height} pixels`);
  // The size shows while it changes.
  await expect(frame.locator('> .floating-size-readout')).toHaveText(`${start.width + 80} × ${start.height}`);
  await page.keyboard.press('Home');
  const least = await box(frame);
  expect(least.width).toBe(Number(await east.getAttribute('aria-valuemin')));

  // Alt+Arrow moves the window, 16 px a press.
  await page.keyboard.press('Alt+ArrowDown');
  expect((await box(frame)).top).toBe(least.top + 16);
  expect(await page.evaluate(() => document.getElementById('keyboard-move-live-region')?.textContent))
    .toContain('Window moved');
  // Focus leaving the window takes the handles out of the Tab order again.
  await page.evaluate(() => document.activeElement.blur());
  await expect(east).toHaveAttribute('tabindex', '-1');
  expect(errors).toEqual([]);
});

test('an edge snaps to another window and shows a guide; maximize and restore', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openDataset(page);
  const first = await copyWindow(page);
  const second = await copyWindow(page, 'detailed');
  // Put the second window to the right of the first, apart from it.
  const a = await box(first);
  await second.evaluate((element, x) => element.style.setProperty('--pos-x', `${x}px`), a.left + a.width + 200);
  await second.evaluate((element, y) => element.style.setProperty('--pos-y', `${y}px`), a.top);
  const b = await box(second);

  // Drag the first window's right edge to 7 px short of the second's left.
  const target = await handle(first, 'e').boundingBox();
  const x = target.x + target.width / 2;
  const y = target.y + target.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (b.left - (a.left + a.width)) - 7, y, { steps: 10 });
  await expect(page.locator('#floating-panels-root > .floating-snap-guide[data-axis="x"]')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('#floating-panels-root > .floating-snap-guide[data-axis="x"]')).toBeHidden();
  const snapped = await box(first);
  expect(snapped.left + snapped.width).toBe(b.left);

  // Maximize fills the free area beside the sidebar; again restores.
  const maximize = first.locator('> .accordion-panel-actions > .accordion-maximize-btn');
  await expect(maximize).toHaveAttribute('aria-pressed', 'false');
  await maximize.click();
  await expect(maximize).toHaveAttribute('aria-pressed', 'true');
  await expect(maximize).toHaveAttribute('aria-label', 'Restore window size');
  const sidebar = await page.locator('#sidebar').boundingBox();
  const viewport = page.viewportSize();
  const full = await box(first);
  expect(full.left).toBe(Math.round(sidebar.x + sidebar.width + 8));
  expect(full.top).toBe(8);
  expect(full.left + full.width).toBe(viewport.width - 8);
  expect(full.height).toBe(viewport.height - 16);
  await maximize.click();
  await expect.poll(() => box(first)).toEqual(snapped);
  // A double-click on the header does the same.
  await first.locator('> details > summary').dblclick();
  await expect(maximize).toHaveAttribute('aria-pressed', 'true');
  await expect(first.locator('> details')).toHaveAttribute('open', '');
  await first.locator('> details > summary').dblclick();
  expect(await box(first)).toEqual(snapped);
  expect(errors).toEqual([]);
});

test('a new window opens at the size the last one of its analysis was given; sessions keep box, open state and sizes, in the order the windows opened', async ({ page }) => {
  // What each window shows is the analysis domain's; its place and the sizes, the layout's.
  const errors = observeProductErrors(page);
  await openDataset(page);
  const first = await copyWindow(page);
  await dragHandle(page, first, 'se', 70, 110);
  const given = await box(first);
  const second = await copyWindow(page);
  const opened = await box(second);
  expect([opened.width, opened.height]).toEqual([given.width, given.height]);

  // Collapse the first (a press also raises it); then save.
  await first.locator('> details > summary').click();
  await expect(first.locator('> details')).not.toHaveAttribute('open', '');
  const saved = await storedDomain(page, 'analysis');
  expect(Object.keys(saved).sort()).toEqual(['docked', 'windows']);
  expect(saved.windows).toHaveLength(2);
  expect(saved.windows.every(entry => !Object.hasOwn(entry, 'rect') && !Object.hasOwn(entry, 'open'))).toBe(true);
  const layout = await storedDomain(page, 'layout');
  const places = layout.analysis;
  expect(Object.keys(places).sort()).toEqual(['sizes', 'windows']);
  expect(places.sizes.window.simple).toEqual({ width: given.width, height: given.height });
  expect(places.windows).toHaveLength(2);
  const collapsed = places.windows.find(entry => entry.open === false);
  // The saved box is the window's own, not the header-high box it draws.
  expect(collapsed.rect).toEqual(given);
  // In the order they opened; which is in front is not state (a press raises a window).
  expect(places.windows.map(entry => entry.open)).toEqual([false, true]);
  expect(places.windows.every(entry => Object.keys(entry).sort().join() === 'open,rect')).toBe(true);

  // Close everything, forget the sizes, restore.
  await page.evaluate(async () => {
    const manager = window._comparisonModule.getAnalysisWindowManager();
    await manager.closeAll();
    manager.importViewSizes({ window: {}, expandedView: {} });
  });
  await expect(page.locator(WINDOW)).toHaveCount(0);
  // As the history restores them: the analyses first, then the layout puts each window back.
  await page.evaluate(async ({ url, analysis, layout: arranged }) => {
    const { getStateDomains } = await import(url);
    await getStateDomains().owner('analysis').restore(analysis);
    await getStateDomains().owner('layout').restore(arranged);
  }, { url: ACTIONS_URL, analysis: saved, layout });
  await expect(page.locator(WINDOW)).toHaveCount(2);
  expect((await storedDomain(page, 'analysis')).windows.map(({ modeId }) => modeId)).toEqual(saved.windows.map(({ modeId }) => modeId));
  expect((await storedDomain(page, 'layout')).analysis).toEqual(places);
  expect(errors).toEqual([]);
});
