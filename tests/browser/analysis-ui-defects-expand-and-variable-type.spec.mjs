/**
 * Two analysis-panel defects found by driving the running app.
 *
 * CEL-0057 — Detailed's "Variable:" type select discarded the first
 * interaction. Choosing a different type snapped the select back to "None" and
 * emptied the panel; choosing the same option a second time was obeyed. The
 * type lives in the selector component, but the panel rebuilt that component
 * from a config that cannot express "type chosen, variable not chosen yet", so
 * the rebuild seeded it with nothing.
 *
 * CEL-0058 — Correlation's expanded view was a bare click listener on the
 * preview `<div>`: no role, no name, `tabindex="-1"`. Every other analysis mode
 * offers a real `.analysis-expand-btn`, so in Correlation alone the expanded
 * view was unreachable by keyboard and unannounced.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const PREPARED_DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=analysis-ui-defects-ci`;

const panelFor = mode => `.analysis-accordion-content[data-mode="${mode}"]`;

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

async function openMode(page, mode) {
  const header = page.locator(`#analysis-header-${mode}`);
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator(panelFor(mode))).toBeVisible();
  return header;
}

const DETAILED = panelFor('detailed');
const typeSelect = page => page.locator(`${DETAILED} select[id$="detailed-type"]`);
const variableSelect = page =>
  page.locator(`${DETAILED} select[id$="-categorical"], ${DETAILED} select[id$="-continuous"]`);

test('CEL-0057: the Variable type select obeys the first interaction, both directions', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);
  await openMode(page, 'detailed');

  // Establish a complete selection: categorical obs -> cell_type.
  await typeSelect(page).selectOption('categorical');
  await expect(typeSelect(page)).toHaveValue('categorical');
  await variableSelect(page).selectOption('cell_type');
  await expect(variableSelect(page)).toHaveValue('cell_type');
  await expect(
    page.locator(`${DETAILED} select[id$="analysis-plot-type"]`)
  ).toBeVisible();

  // categorical -> continuous, first interaction.
  await typeSelect(page).selectOption('continuous');
  await expect(
    typeSelect(page),
    'switching categorical -> continuous must be kept, not reset to None'
  ).toHaveValue('continuous');
  // The dependent variable select is rebuilt for the new type and is empty.
  await expect(page.locator(`${DETAILED} select[id$="-continuous"]`)).toHaveValue('-1');

  // Finish the selection so the reverse direction starts from a complete one.
  await page.locator(`${DETAILED} select[id$="-continuous"]`).selectOption('score');
  await expect(page.locator(`${DETAILED} select[id$="-continuous"]`)).toHaveValue('score');

  // continuous -> categorical, first interaction.
  await typeSelect(page).selectOption('categorical');
  await expect(
    typeSelect(page),
    'switching continuous -> categorical must be kept, not reset to None'
  ).toHaveValue('categorical');
  await expect(page.locator(`${DETAILED} select[id$="-categorical"]`)).toHaveValue('-1');

  // continuous -> gene, the third direction the selector offers.
  await page.locator(`${DETAILED} select[id$="-categorical"]`).selectOption('cell_type');
  await typeSelect(page).selectOption('gene');
  await expect(typeSelect(page)).toHaveValue('gene');
  await expect(page.locator(`${DETAILED} input[id$="-gene-search"]`)).toBeVisible();

  expect(productErrors).toEqual([]);
});

test('CEL-0058: every analysis preview offers the same keyboard-operable Expand button', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);

  // Correlation: pick X and Y, wait for the preview, then check the control.
  await openMode(page, 'correlation');
  const correlation = panelFor('correlation');
  await page.locator(`${correlation} select[id$="-x-type"]`).selectOption('continuous');
  await page.locator(`${correlation} select[id$="-x-continuous"]`).selectOption('score');
  await page.locator(`${correlation} select[id$="-y-type"]`).selectOption('gene');
  const geneSearch = page.locator(`${correlation} input[id$="-y-gene-search"]`);
  await geneSearch.click();
  await geneSearch.fill('GAPDH');
  await page.locator('.dropdown-item', { hasText: 'GAPDH' }).first().click();

  const expand = page.locator(`${correlation} .analysis-expand-btn`);
  await expect(expand, 'Correlation must offer a real Expand button').toHaveCount(1);
  await expect(expand).toBeVisible();

  // It reaches the accessibility tree as a named button, not as a bare div.
  await expect(expand).toHaveRole('button');
  await expect(expand).toHaveAccessibleName(/Expand/);

  // In the tab order: a native button with no negative tabindex. (Asserted on
  // the element rather than by walking Tab, because WebKit leaves buttons out
  // of sequential navigation unless the OS setting is on.)
  expect(await expand.evaluate(el => ({
    tag: el.tagName,
    tabIndex: el.tabIndex,
    explicit: el.getAttribute('tabindex')
  }))).toEqual({ tag: 'BUTTON', tabIndex: 0, explicit: null });

  // Operable from the keyboard alone, with both keys a button answers to.
  await expand.focus();
  await expect(expand).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.analysis-modal').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.analysis-modal')).toHaveCount(0);
  await expand.focus();
  await page.keyboard.press(' ');
  await expect(page.locator('.analysis-modal').first()).toBeVisible();
  await page.keyboard.press('Escape');

  // The preview is no longer a mouse-only pseudo control.
  const preview = page.locator(`${correlation} .analysis-preview-container`);
  await expect(preview).not.toHaveAttribute('title', /Click to open/);
  await expect(preview).toHaveCSS('cursor', 'auto');

  expect(productErrors).toEqual([]);
});

test('CEL-0058: collapsible analysis settings are built as real disclosure controls', async ({
  page
}) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);
  await openMode(page, 'genesPanel');

  const headers = page.locator(`${panelFor('genesPanel')} .analysis-perf-header`);
  await expect(headers).toHaveCount(2);

  for (let index = 0; index < 2; index++) {
    const header = headers.nth(index);
    await expect(header).toHaveRole('button');
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    const regionId = await header.getAttribute('aria-controls');
    const region = page.locator(`[id="${regionId}"]`);
    await expect(region).toBeHidden();

    // One key press, one toggle: the caret and the announced state agree.
    await header.focus();
    await page.keyboard.press('Enter');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(region).toBeVisible();
    await expect(header.locator('.analysis-perf-toggle')).toHaveText('▲');
    await page.keyboard.press(' ');
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(region).toBeHidden();
    await expect(header.locator('.analysis-perf-toggle')).toHaveText('▼');
  }

  expect(productErrors).toEqual([]);
});
