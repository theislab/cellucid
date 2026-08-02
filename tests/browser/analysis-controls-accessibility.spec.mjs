/**
 * Every control in the Analysis panel must be operable and announced — in the
 * sidebar and in a copied floating window alike.
 *
 * These assertions come from defects found by driving the running app:
 *
 * - The accordion headers' `aria-controls` pointed at ids the UI manager had
 *   already overwritten, so the relationship resolved to nothing.
 * - The page chips ("Page 1", "Rest of Page 1") were `<div>`s with a click
 *   listener: choosing which pages an analysis runs over was impossible without
 *   a mouse and announced no role, name or selected state.
 * - The collapsible "Performance Settings" and "Clustering" sections were
 *   `<div>`s with a click listener too, hiding every control inside them from
 *   keyboard users.
 * - Selects built by the shared form helpers had no accessible name at all.
 * - The multi-select popup is appended to `<body>`, so sequential focus never
 *   reached it and Escape left focus stranded.
 * - Copying an analysis mode into a floating window produced duplicate element
 *   ids, so the copy's label toggled the sidebar's checkbox.
 * - The lazily built analysis controls joined the session UI-control inventory,
 *   which made a session unrestorable unless the same analysis panel happened
 *   to be open.
 * - Rebuilding the form when an accordion reopened discarded every choice made
 *   in it.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const PREPARED_DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=analysis-controls-ci`;

const MODES = Object.freeze([
  'simple',
  'detailed',
  'correlation',
  'differential',
  'signature',
  'genesPanel'
]);

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
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );
}

const panelFor = mode => `.analysis-accordion-content[data-mode="${mode}"]`;

async function openMode(page, mode) {
  const header = page.locator(`#analysis-header-${mode}`);
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator(panelFor(mode))).toBeVisible();
  return header;
}

/** Names every visible, enabled control in `root`, in document order. */
function readControlNames(page, selector) {
  return page.evaluate(sel => {
    const root = document.querySelector(sel);
    if (root === null) throw new Error(`Missing analysis root: ${sel}`);
    const FOCUSABLE =
      'a[href], button, input, select, textarea, summary,'
      + ' [tabindex]:not([tabindex="-1"])';
    const named = element => {
      const explicit = element.getAttribute('aria-label');
      if (typeof explicit === 'string' && explicit.trim().length > 0) return true;
      const labelledBy = element.getAttribute('aria-labelledby');
      if (typeof labelledBy === 'string' && labelledBy.trim().length > 0) {
        return labelledBy.split(/\s+/).every(
          id => (document.getElementById(id)?.textContent ?? '').trim().length > 0
        );
      }
      if (element.labels && element.labels.length > 0) {
        return [...element.labels].some(
          label => label.textContent.trim().length > 0
        );
      }
      // Roles whose name may come from their contents.
      const role = element.getAttribute('role');
      if (element.tagName === 'BUTTON' || role === 'button' || element.tagName === 'SUMMARY') {
        return element.textContent.trim().length > 0
          || element.title.trim().length > 0;
      }
      return element.title.trim().length > 0;
    };
    return [...root.querySelectorAll(FOCUSABLE)]
      .filter(element => {
        if (element.disabled) return false;
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      })
      .map(element => ({
        description: `${element.tagName.toLowerCase()}`
          + `${element.name ? `[name=${element.name}]` : ''}`
          + `${element.className ? `.${String(element.className).split(' ')[0]}` : ''}`,
        named: named(element)
      }));
  }, selector);
}

test('every analysis accordion header controls a region that exists', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);

  const relationships = await page.evaluate(() =>
    [...document.querySelectorAll('.analysis-accordion .analysis-accordion-header')]
      .filter(header => header.id.startsWith('analysis-header-'))
      .map(header => ({
        header: header.id,
        controls: header.getAttribute('aria-controls'),
        resolves:
          document.getElementById(header.getAttribute('aria-controls') ?? '') !== null
      }))
  );
  expect(relationships).toHaveLength(MODES.length);
  for (const relationship of relationships) {
    expect(relationship.controls, relationship.header).toBe(
      `analysis-panel-${relationship.header.replace('analysis-header-', '')}`
    );
    expect(relationship.resolves, relationship.header).toBe(true);
  }
  expect(productErrors).toEqual([]);
});

test('every control in every analysis panel has an accessible name', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);

  for (const mode of MODES) {
    const header = await openMode(page, mode);
    const controls = await readControlNames(page, panelFor(mode));
    expect(controls.length, `${mode} exposes at least one control`)
      .toBeGreaterThan(0);
    expect(
      controls.filter(control => !control.named).map(c => c.description),
      `unnamed controls in ${mode}`
    ).toEqual([]);
    await header.click();
  }
  expect(productErrors).toEqual([]);
});

test('page chips are operable and announced without a mouse', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);
  await openMode(page, 'detailed');

  const chips = page.locator(`${panelFor('detailed')} .analysis-page-tab`);
  await expect(chips).toHaveCount(2);

  // The empty page cannot be selected and says so.
  const empty = chips.first();
  await expect(empty).toHaveAttribute('role', 'button');
  await expect(empty).toHaveAttribute('aria-disabled', 'true');
  await expect(empty).toHaveAttribute('tabindex', '-1');
  await expect(empty).toHaveAccessibleName(/no cells, cannot be selected/);

  // The populated page is a toggle button carrying its cell count.
  const populated = chips.nth(1);
  await expect(populated).toHaveAttribute('role', 'button');
  await expect(populated).toHaveAttribute('tabindex', '0');
  await expect(populated).toHaveAccessibleName(/120 cells/);
  await expect(populated).toHaveAttribute('aria-pressed', 'true');

  await populated.focus();
  await page.keyboard.press('Enter');
  const afterEnter = page.locator(`${panelFor('detailed')} .analysis-page-tab`).nth(1);
  await expect(afterEnter).toHaveAttribute('aria-pressed', 'false');
  // Toggling rebuilds the chips; focus must land back on the same chip.
  await expect(afterEnter).toBeFocused();

  await page.keyboard.press(' ');
  const afterSpace = page.locator(`${panelFor('detailed')} .analysis-page-tab`).nth(1);
  await expect(afterSpace).toHaveAttribute('aria-pressed', 'true');
  await expect(afterSpace).toBeFocused();

  // The colour picker is a separate, individually named control.
  await expect(
    page.locator(`${panelFor('detailed')} .analysis-page-color-input`)
  ).toHaveAccessibleName(/^Colour for /);

  expect(productErrors).toEqual([]);
});

test('collapsible settings sections open from the keyboard', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);
  await openMode(page, 'genesPanel');

  const headers = page.locator(`${panelFor('genesPanel')} .analysis-perf-header`);
  await expect(headers).toHaveCount(2);

  for (let index = 0; index < 2; index++) {
    const header = headers.nth(index);
    await expect(header).toHaveAttribute('role', 'button');
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    const regionId = await header.getAttribute('aria-controls');
    expect(regionId).toBeTruthy();
    const region = page.locator(`[id="${regionId}"]`);
    await expect(region).toBeHidden();

    await header.focus();
    await page.keyboard.press('Enter');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(region).toBeVisible();

    await page.keyboard.press(' ');
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(region).toBeHidden();
  }

  // The Quick Insights page-selection disclosure follows the same contract.
  await page.locator('#analysis-header-genesPanel').click();
  await openMode(page, 'simple');
  const insights = page.locator(
    `${panelFor('simple')} .insights-collapsible-header`
  );
  await expect(insights).toHaveAttribute('role', 'button');
  await expect(insights).toHaveAttribute('aria-expanded', 'false');
  await expect(insights).toHaveAccessibleName(/^Page Selection/);
  await insights.focus();
  await page.keyboard.press('Enter');
  await expect(insights).toHaveAttribute('aria-expanded', 'true');

  expect(productErrors).toEqual([]);
});

test('the multi-select popup takes focus, keeps it, and hands it back', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);
  await openMode(page, 'simple');

  const trigger = page.getByRole('button', { name: 'Choose composition fields' });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');

  const panel = page.locator('.multi-select-dropdown-panel.open');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.multi-select-dropdown-search')).toBeFocused();

  // Tab cycles inside the popup instead of walking back into the sidebar.
  for (let step = 0; step < 6; step++) {
    await page.keyboard.press('Tab');
    await expect
      .poll(() => page.evaluate(
        () => document.activeElement?.closest('.multi-select-dropdown-panel') !== null
      ))
      .toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();

  expect(productErrors).toEqual([]);
});

test('a copied analysis window owns its own controls', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);
  await openMode(page, 'genesPanel');

  await page
    .locator('.analysis-accordion-item[data-mode="genesPanel"] .analysis-accordion-copy-btn')
    .click({ force: true });
  const floating = page.locator('#floating-panels-root .analysis-window-panel');
  await expect(floating).toHaveCount(1);
  await expect(floating.locator('input[name="useCache"]')).toBeVisible();

  const duplicateIds = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
    return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  });
  expect(duplicateIds).toEqual([]);

  // Clicking the copy's label must operate the copy's checkbox, not the
  // sidebar's.
  const crosstalk = await page.evaluate(() => {
    const sidebarBox = document
      .querySelector('#sidebar')
      .querySelector('input[name="useCache"]');
    const floatingBox = document
      .querySelector('#floating-panels-root')
      .querySelector('input[name="useCache"]');
    const floatingLabel = document
      .querySelector('#floating-panels-root')
      .querySelector(`label[for="${CSS.escape(floatingBox.id)}"]`);
    const before = { sidebar: sidebarBox.checked, floating: floatingBox.checked };
    floatingLabel.click();
    return {
      before,
      after: { sidebar: sidebarBox.checked, floating: floatingBox.checked }
    };
  });
  expect(crosstalk.before).toEqual({ sidebar: true, floating: true });
  expect(crosstalk.after).toEqual({ sidebar: true, floating: false });

  const controls = await readControlNames(
    page,
    '#floating-panels-root .analysis-window-panel'
  );
  expect(
    controls.filter(control => !control.named).map(control => control.description),
    'unnamed controls in the copied window'
  ).toEqual([]);

  expect(productErrors).toEqual([]);
});

test('analysis panels never change the session UI-control inventory', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);

  const captureInventory = () => page.evaluate(async () => {
    const { createUiControlSerializer } = await import(
      '/assets/js/app/state-serializer/ui-controls.js'
    );
    return createUiControlSerializer({
      sidebar: document.getElementById('sidebar')
    }).collectUIControls();
  });

  const beforeControls = await captureInventory();
  for (const mode of MODES) {
    await openMode(page, mode);
  }
  const afterControls = await captureInventory();
  expect(Object.keys(afterControls).sort()).toEqual(
    Object.keys(beforeControls).sort()
  );

  // A session captured with the analysis panels closed still restores while
  // they are open.
  const validation = await page.evaluate(async payload => {
    const { createUiControlSerializer } = await import(
      '/assets/js/app/state-serializer/ui-controls.js'
    );
    try {
      createUiControlSerializer({
        sidebar: document.getElementById('sidebar')
      }).validateUIControls(payload);
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: `${error.name}: ${error.message}` };
    }
  }, beforeControls);
  expect(validation).toEqual({ ok: true, error: null });

  expect(productErrors).toEqual([]);
});

test('analysis settings survive collapsing and reopening the panel', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);
  await openMode(page, 'genesPanel');

  const form = panelFor('genesPanel');
  await page.locator(`${form} select[name="mode"]`).selectOption('ranked');
  await page.locator(`${form} select[name="method"]`).selectOption('ttest');
  await page.locator(`${form} input[name="useCache"]`).uncheck();

  const expectCarried = async () => {
    await expect(page.locator(`${form} select[name="mode"]`)).toHaveValue('ranked');
    await expect(page.locator(`${form} select[name="method"]`)).toHaveValue('ttest');
    await expect(page.locator(`${form} input[name="useCache"]`)).not.toBeChecked();
    // 'ranked' hides the clustering section; the mode and the sections agree.
    await expect(page.locator(`${form} .cluster-params`)).toHaveClass(/hidden/);
  };
  await expectCarried();

  await page.locator('#analysis-header-genesPanel').click();
  await openMode(page, 'genesPanel');
  await expectCarried();

  await page.locator('#analysis-header-correlation').click();
  await page.locator('#analysis-header-genesPanel').click();
  await expect(page.locator(`#analysis-header-genesPanel`)).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expectCarried();

  expect(productErrors).toEqual([]);
});
