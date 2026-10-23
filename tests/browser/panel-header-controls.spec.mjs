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
import { expectFloatingSettled, openCollapsedPanels } from './helpers/panels.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=panel-header-controls-ci';

const DOCKABLE_REGISTRY_URL = '/assets/js/app/dockable-accordions-registry.js';
const DOCKABLE_CONTRIBUTOR_URL =
  '/assets/js/app/session/contributors/dockable-layout.js';

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

/** `toggle` is dispatched from a queued task, so let pending ones arrive. */
function toggles(page, panelId) {
  return page.evaluate(async (id) => {
    await new Promise(resolve => setTimeout(resolve, 50));
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
    .click({ force: true });
  const analysisWindow = page.locator(
    '#floating-panels-root > .accordion-panel.analysis-window-frame',
  );
  await expect(analysisWindow).toHaveCount(1);
  await expect(analysisWindow.locator('> .accordion-panel-actions > button'))
    .toHaveCount(2);

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
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
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

test('the floating layout round-trips through the session contributor', async ({
  page,
}) => {
  await openDataset(page);
  await control(page, PANEL, 'accordion-undock-btn').click();
  await control(page, OTHER_PANEL, 'accordion-undock-btn').click();
  await page.evaluate(id => { document.getElementById(id).open = false; }, OTHER_PANEL);

  const capture = () => page.evaluate(async ({ registryUrl, contributorUrl }) => {
    const { getDockableAccordions } = await import(registryUrl);
    const contributor = await import(contributorUrl);
    return contributor.capture({
      dockableAccordions: getDockableAccordions(),
    })[0].payload;
  }, { registryUrl: DOCKABLE_REGISTRY_URL, contributorUrl: DOCKABLE_CONTRIBUTOR_URL });

  const saved = await capture();
  expect(saved.panels.map(panel => [panel.id, panel.open]).sort()).toEqual(
    [[OTHER_PANEL, false], [PANEL, true]].sort(),
  );

  // Dock everything by its buttons, then restore.
  await control(page, PANEL, 'accordion-dock-btn').click();
  await control(page, OTHER_PANEL, 'accordion-dock-btn').click();
  await expect(page.locator('#floating-panels-root > .accordion-panel'))
    .toHaveCount(0);
  expect((await capture()).panels).toEqual([]);

  await page.evaluate(async ({ registryUrl, contributorUrl, value }) => {
    const { getDockableAccordions } = await import(registryUrl);
    const contributor = await import(contributorUrl);
    contributor.restore(
      { dockableAccordions: getDockableAccordions() },
      null,
      value,
    );
  }, {
    registryUrl: DOCKABLE_REGISTRY_URL,
    contributorUrl: DOCKABLE_CONTRIBUTOR_URL,
    value: saved,
  });

  expect(await capture()).toEqual(saved);
  for (const id of [PANEL, OTHER_PANEL]) {
    await expect(frameOf(page, id)).toHaveClass(/\baccordion-floating\b/);
    await expect(control(page, id, 'accordion-dock-btn')).toBeVisible();
    await expect(control(page, id, 'accordion-undock-btn')).toBeHidden();
  }
  await expect(page.locator(`#${OTHER_PANEL}`)).not.toHaveAttribute('open', '');
  expect(await nestedInteractive(page)).toEqual([]);

  // The restored panels dock back by their buttons into their own slots.
  await control(page, OTHER_PANEL, 'accordion-dock-btn').click();
  await control(page, PANEL, 'accordion-dock-btn').click();
  const order = await page.evaluate(() =>
    [...document.querySelector('#sidebar .accordion').children]
      .map(child => child.querySelector(':scope > details.accordion-section')?.id));
  expect(order.indexOf(PANEL)).toBeLessThan(order.indexOf(OTHER_PANEL));
  expect(order.indexOf(PANEL)).toBe(1);
});
