/**
 * A panel's header controls stand beside its summary, never inside it.
 *
 * Every sidebar panel and analysis window is a `<details>`, and a `<summary>`
 * is itself the disclosure button. The undock, dock, copy and close buttons
 * used to be appended inside the summary: a button nested in a button, which
 * assistive technology announces poorly (axe: `nested-interactive`), and whose
 * clicks and keys also reached the toggle underneath. They now live in the
 * panel frame's action bar (`dockable-accordions.js`, `_accordion.css`), laid
 * over the right end of the summary row.
 *
 * This drives the real app: the whole document is swept for interactive
 * content inside any summary in every state a panel can be in, and the moved
 * controls are exercised by keyboard and pointer.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { tabKey } from './helpers/dialog-keys.mjs';
import { expectFloatingSettled, openCollapsedPanels } from './helpers/panels.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=panel-header-controls-ci';


const PANEL = 'visualization-section';
const OTHER_PANEL = 'coloring-filtering-section';

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  return errors;
}

async function openDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
}

function frameOf(page, panelId) {
  return page.locator(`.accordion-panel:has(> #${panelId})`);
}

function control(page, panelId, className) {
  return frameOf(page, panelId).locator(
    `> .accordion-panel-actions > .${className}`,
  );
}

/** Every interactive or focusable element inside any summary in the page. */
function nestedInteractive(page) {
  return page.evaluate(() => {
    const INTERACTIVE = [
      'a[href]', 'area[href]', 'button', 'input', 'select', 'textarea',
      'details', 'iframe', 'embed', 'object', 'label',
      'audio[controls]', 'video[controls]',
      '[tabindex]', '[contenteditable]:not([contenteditable="false"])',
      '[role="button"]', '[role="link"]', '[role="checkbox"]',
      '[role="menuitem"]', '[role="switch"]', '[role="tab"]',
    ].join(', ');
    return [...document.querySelectorAll('summary')].flatMap(summary =>
      [...summary.querySelectorAll(INTERACTIVE)].map(element => {
        const owner = summary.closest('details');
        return `${owner?.id || owner?.className}: `
          + `${element.tagName.toLowerCase()}.${element.className}`;
      }));
  });
}

function toggleCounter(page, panelId) {
  return page.evaluate((id) => {
    const details = document.getElementById(id);
    const counter = { count: 0 };
    details.addEventListener('toggle', () => { counter.count += 1; });
    window.__panelToggleCounts ??= {};
    window.__panelToggleCounts[id] = counter;
  }, panelId);
}

/**
 * `toggle` is dispatched from a task queued on the DOM manipulation task
 * source, so every pending one has arrived once a sentinel `<details>`
 * opened after them has had its own `toggle` (same task source, in order).
 */
function toggles(page, panelId) {
  return page.evaluate(async (id) => {
    const sentinel = document.createElement('details');
    sentinel.hidden = true;
    document.body.append(sentinel);
    const toggled = new Promise(resolve => sentinel.addEventListener('toggle', resolve, { once: true }));
    sentinel.open = true;
    await toggled;
    sentinel.remove();
    return window.__panelToggleCounts[id].count;
  }, panelId);
}

/** Header geometry: the control sits on the summary row, at its right end. */
function headerGeometry(page, panelId, className) {
  return page.evaluate(({ id, cls }) => {
    const details = document.getElementById(id);
    const summary = details.querySelector(':scope > summary');
    const button = details.parentElement
      .querySelector(`:scope > .accordion-panel-actions > .${cls}`);
    const range = document.createRange();
    const text = [...summary.childNodes]
      .find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    range.selectNodeContents(text);
    const s = summary.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    const t = range.getBoundingClientRect();
    const padding = parseFloat(getComputedStyle(summary).paddingRight);
    return {
      verticalCentreOffset: Math.abs(
        (b.top + b.bottom) / 2 - (s.top + s.bottom - 1) / 2,
      ),
      rightInset: s.right - b.right,
      padding,
      titleClearance: b.left - t.right,
      hitAtButton: document.elementFromPoint(
        (b.left + b.right) / 2,
        (b.top + b.bottom) / 2,
      ) === button,
    };
  }, { id: panelId, cls: className });
}

test('no summary in the app contains an interactive element, in any panel state', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);

  expect(await nestedInteractive(page)).toEqual([]);
  // Every sidebar panel stands in a frame with its controls beside it.
  const unframed = await page.evaluate(() =>
    [...document.querySelectorAll('#sidebar details.accordion-section')]
      .filter(details => !details.parentElement.matches('.accordion-panel'))
      .map(details => details.id));
  expect(unframed).toEqual([]);

  // Every panel open.
  await page.evaluate(() => {
    for (const details of document.querySelectorAll('details.accordion-section')) {
      details.open = true;
    }
  });
  expect(await nestedInteractive(page)).toEqual([]);

  // An analysis window copied out of the Analysis panel.
  await page.locator('#analysis-header-genesPanel').click();
  await page
    .locator('.analysis-mode[data-mode="genesPanel"] .analysis-mode-copy-btn')
    .click();
  const analysisWindow = page.locator(
    '#floating-panels-root > .accordion-panel.analysis-window-frame',
  );
  await expect(analysisWindow).toHaveCount(1);
  // Copy, maximize and close.
  await expect(analysisWindow.locator('> .accordion-panel-actions > button'))
    .toHaveCount(3);

  // A sidebar panel floating, then collapsed while floating.
  await control(page, PANEL, 'accordion-undock-btn').click();
  await expect(frameOf(page, PANEL)).toHaveClass(/\baccordion-floating\b/);
  expect(await nestedInteractive(page)).toEqual([]);
  await page.evaluate(id => { document.getElementById(id).open = false; }, PANEL);
  expect(await nestedInteractive(page)).toEqual([]);
  await expect(control(page, PANEL, 'accordion-dock-btn')).toBeVisible();

  // The analysis window's own controls still work from their new home.
  await analysisWindow
    .locator('> .accordion-panel-actions > .accordion-close-btn')
    .click();
  await expect(analysisWindow).toHaveCount(0);

  expect(productErrors).toEqual([]);
});

test('the header controls sit at the right end of the summary row, docked and floating', async ({
  page,
}) => {
  await openDataset(page);
  await frameOf(page, PANEL).scrollIntoViewIfNeeded();

  for (const state of ['docked', 'floating']) {
    const cls = state === 'docked' ? 'accordion-undock-btn' : 'accordion-dock-btn';
    const geometry = await headerGeometry(page, PANEL, cls);
    expect(geometry.verticalCentreOffset, state).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.rightInset - geometry.padding), state)
      .toBeLessThanOrEqual(1);
    expect(geometry.titleClearance, state).toBeGreaterThan(0);
    expect(geometry.hitAtButton, state).toBe(true);
    if (state === 'docked') {
      await control(page, PANEL, 'accordion-undock-btn').click();
      // Measured once the lift is over: it scales the whole frame.
      await expectFloatingSettled(frameOf(page, PANEL));
    }
  }
});

test('a panel toggles from the keyboard, and Tab reaches its controls next to it', async ({
  page,
  browserName,
}) => {
  // WebKit, like Safari, tabs through buttons only with Option held.
  const tab = tabKey(browserName);
  await openDataset(page);
  const details = page.locator(`#${PANEL}`);
  const summary = details.locator('> summary');
  const undock = control(page, PANEL, 'accordion-undock-btn');

  await expect(details).toHaveAttribute('open', '');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(details).not.toHaveAttribute('open', '');
  await page.keyboard.press('Space');
  await expect(details).toHaveAttribute('open', '');
  await expect(summary).toBeFocused();

  // The action bar precedes the card: Shift+Tab from the toggle reaches the
  // panel's own undock control, and Tab returns to the toggle.
  await page.keyboard.press(`Shift+${tab}`);
  await expect(undock).toBeFocused();
  await expect(undock).toHaveAttribute(
    'aria-label',
    'Undock Visualization panel into a floating window',
  );
  await page.keyboard.press(tab);
  await expect(summary).toBeFocused();
});

test('docking and undocking by button never toggles the panel, and focus follows', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);
  const details = page.locator(`#${PANEL}`);
  const undock = control(page, PANEL, 'accordion-undock-btn');
  const dock = control(page, PANEL, 'accordion-dock-btn');
  await toggleCounter(page, PANEL);

  // Keyboard activation of the undock control: an open panel stays open.
  await expect(details).toHaveAttribute('open', '');
  await undock.focus();
  await page.keyboard.press('Enter');
  await expect(frameOf(page, PANEL)).toHaveClass(/\baccordion-floating\b/);
  await expect(details).toHaveAttribute('open', '');
  await expect(dock).toBeFocused();
  await expect(undock).toBeHidden();

  // Space on the dock control docks it, still open.
  await page.keyboard.press('Space');
  await expect(frameOf(page, PANEL)).not.toHaveClass(/\baccordion-floating\b/);
  await expect(details).toHaveAttribute('open', '');
  await expect(undock).toBeFocused();
  await expect(dock).toBeHidden();
  expect(await toggles(page, PANEL)).toBe(0);

  // Pointer: float it, collapse it, dock it by its button — still collapsed.
  await undock.click();
  await expect(dock).toBeFocused();
  await details.locator('> summary').click({ position: { x: 24, y: 10 } });
  await expect(details).not.toHaveAttribute('open', '');
  expect(await toggles(page, PANEL)).toBe(1);
  await dock.click();
  await expect(frameOf(page, PANEL)).not.toHaveClass(/\baccordion-floating\b/);
  await expect(details).not.toHaveAttribute('open', '');
  await expect(undock).toBeFocused();
  // A collapsed docked panel undocks from its header too.
  await undock.click();
  await expect(frameOf(page, PANEL)).toHaveClass(/\baccordion-floating\b/);
  await expect(page.locator('#floating-panels-root > .accordion-panel'))
    .toHaveCount(1);
  await expect(details).toHaveAttribute('open', '');
  expect(await toggles(page, PANEL)).toBe(2); // a torn-off panel opens

  expect(productErrors).toEqual([]);
});

test('Dock all brings every floating section back to its place', async ({
  page,
}) => {
  // F126 (bug hunt): with every section undocked the sidebar stayed a column
  // of logo and footer, and the way back was each window's own dock button.
  const productErrors = observeProductErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDataset(page);
  const sectionOrder = () => page.evaluate(() => [...document.querySelectorAll(
    '#sidebar .accordion > .accordion-panel > details.accordion-section',
  )].map(details => details.id));
  const order = await sectionOrder();
  expect(order.length).toBeGreaterThan(2);
  const dockAll = page.getByRole('button', { name: /^Dock all \d+ panels back into the sidebar$/ });
  await expect(page.locator('#dock-all-panels-btn')).toBeHidden();

  await control(page, PANEL, 'accordion-undock-btn').click();
  await expect(page.locator('#dock-all-panels-btn')).toHaveText('Dock Visualization');
  for (const id of order.filter(id => id !== PANEL)) {
    await control(page, id, 'accordion-undock-btn').click();
  }
  await expect(page.locator('#sidebar .accordion > .accordion-panel')).toHaveCount(0);
  await expect(dockAll).toHaveText(`Dock all ${order.length} panels`);
  // Where the emptied column shows it: below the logo, where the sections begin.
  const placement = await page.evaluate(() => {
    const button = document.getElementById('dock-all-panels-btn');
    // Its words on one line, whole inside the button.
    const words = document.createRange();
    words.selectNodeContents(button);
    const lines = new Set([...words.getClientRects()].map(rect => Math.round(rect.top)));
    const text = words.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    return {
      afterBrand: button.previousElementSibling?.classList.contains('sidebar-brand') === true,
      beforeSections: button.nextElementSibling?.classList.contains('accordion') === true,
      oneLine: lines.size === 1 && text.left >= box.left - 0.5 && text.right <= box.right + 0.5,
    };
  });
  expect(placement).toEqual({ afterBrand: true, beforeSections: true, oneLine: true });

  await dockAll.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#floating-panels-root > .accordion-panel')).toHaveCount(0);
  expect(await sectionOrder()).toEqual(order);
  await expect(page.locator('#dock-all-panels-btn')).toBeHidden();
  await expect(control(page, order[0], 'accordion-undock-btn')).toBeFocused();
  expect(productErrors).toEqual([]);
});

test('a tall floating panel stays inside the screen when the window shrinks', async ({
  page,
}) => {
  // S2 (bug hunt): a window under the sidebar's toggle was capped at the
  // viewport less its margins, so after a shrink its foot ran past the screen
  // by the toggle's height; and a window still in its lift animation
  // (scaled) was measured short and left past the foot.
  const productErrors = observeProductErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDataset(page);
  for (const id of [PANEL, OTHER_PANEL]) {
    await control(page, id, 'accordion-undock-btn').click();
    await expect(frameOf(page, id)).toHaveClass(/\baccordion-floating\b/);
  }
  for (const size of [{ width: 900, height: 700 }, { width: 1280, height: 520 }]) {
    await page.setViewportSize(size);
    for (const id of [PANEL, OTHER_PANEL]) {
      await expect.poll(() => frameOf(page, id).evaluate(frame => Math.round(frame.getBoundingClientRect().bottom)))
        .toBeLessThanOrEqual(size.height - 8);
    }
  }
  expect(productErrors).toEqual([]);
});

test('the floating layout round-trips through the layout state domain', async ({
  page,
}) => {
  await openDataset(page);
  const sidebarOrder = () => page.evaluate(() =>
    [...document.querySelector('#sidebar .accordion').children]
      .map(child => child.querySelector(':scope > details.accordion-section')?.id));
  const slot = (await sidebarOrder()).indexOf(PANEL);
  expect(slot).toBeGreaterThan(0);
  await control(page, PANEL, 'accordion-undock-btn').click();
  await control(page, OTHER_PANEL, 'accordion-undock-btn').click();
  await page.evaluate(id => { document.getElementById(id).open = false; }, OTHER_PANEL);

  // The `layout` domain's value (`app/state/domains/layout.js`), as the history and a session hold it.
  const capture = () => page.evaluate(async () => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    return getStateDomains().owner('layout').capture();
  });

  const saved = await capture();
  expect(saved.panels.map(panel => panel.id)).toEqual([OTHER_PANEL, PANEL].sort());
  expect([saved.sections[PANEL], saved.sections[OTHER_PANEL]]).toEqual([true, false]);

  // Dock everything by its buttons, then restore.
  await control(page, PANEL, 'accordion-dock-btn').click();
  await control(page, OTHER_PANEL, 'accordion-dock-btn').click();
  await expect(page.locator('#floating-panels-root > .accordion-panel'))
    .toHaveCount(0);
  expect((await capture()).panels).toEqual([]);

  await page.evaluate(async value => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    await getStateDomains().owner('layout').restore(value, { signal: null });
  }, saved);

  expect(await capture()).toEqual(saved);
  for (const id of [PANEL, OTHER_PANEL]) {
    await expect(frameOf(page, id)).toHaveClass(/\baccordion-floating\b/);
    await expect(control(page, id, 'accordion-dock-btn')).toBeVisible();
    await expect(control(page, id, 'accordion-undock-btn')).toBeHidden();
  }
  await expect(page.locator(`#${OTHER_PANEL}`)).not.toHaveAttribute('open', '');
  expect(await nestedInteractive(page)).toEqual([]);

  // The restored panels dock back by their buttons into their own slots, the
  // one in front first (which is in front is not part of the layout: a
  // restore floats the panels it adds in the value's order, by id).
  await control(page, PANEL, 'accordion-dock-btn').click();
  await control(page, OTHER_PANEL, 'accordion-dock-btn').click();
  const order = await sidebarOrder();
  expect(order.indexOf(PANEL)).toBeLessThan(order.indexOf(OTHER_PANEL));
  expect(order.indexOf(PANEL)).toBe(slot);
});
