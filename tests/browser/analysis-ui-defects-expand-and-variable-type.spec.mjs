/**
 * Two analysis-panel behaviors the controls keep.
 *
 * Detailed's "Variable:" type select obeys the first interaction: choosing a
 * different type keeps it chosen, and does not snap the select back to "None"
 * and empty the panel. The type lives in the selector component, and the panel
 * rebuilds that component from a config that cannot express "type chosen,
 * variable not chosen yet", so the rebuild must seed it with the chosen type.
 *
 * Correlation's expanded view is opened by a real `.analysis-expand-btn`, as in
 * every other analysis mode: a bare click listener on the preview `<div>` (no
 * role, no name, `tabindex="-1"`) leaves the expanded view unreachable by
 * keyboard and unannounced.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const PREPARED_DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=analysis-ui-defects-ci`;

const panelFor = mode => `.analysis-mode-content[data-mode="${mode}"]`;

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
    'Current UI fixture'
  );
}

async function openMode(page, mode) {
  const header = page.locator(`#analysis-header-${mode}`);
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  const panel = page.locator(panelFor(mode));
  await expect(panel).toBeVisible();
  // A panel that fills in asynchronously is `aria-busy` until it settles;
  // every header below it moves when it does.
  await expect(panel).not.toHaveAttribute('aria-busy', 'true');
  return header;
}

const DETAILED = panelFor('detailed');
const typeSelect = page => page.locator(`${DETAILED} select[id$="detailed-type"]`);
const variableSelect = page =>
  page.locator(`${DETAILED} select[id$="-categorical"], ${DETAILED} select[id$="-continuous"]`);

// One opening: the Detailed panel's selects first, then a Correlation run and its preview.
test("Detailed's Variable type select keeps the first choice in every direction; Correlation's preview offers a keyboard-operable Expand button", async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);

  await test.step('the Variable type select obeys the first interaction, both directions', async () => {
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

  await test.step('every analysis preview offers the same keyboard-operable Expand button', async () => {
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
    // Correlation runs on Run, never on a choice.
    await page.locator(correlation).getByRole('button', { name: 'Run correlation' }).click();

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
});
