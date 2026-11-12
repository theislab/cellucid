/**
 * Create categorical (Highlighting › Create categorical, `ui/category-builder.js`)
 * in the real app: what it waits for is a quiet hint, its column name follows
 * the one field-name rule (`requireNewName`, the writers' rule), its preview is
 * the field it makes (categories and colors), and the field is shown at once.
 *
 * The fixture (`current-ui`): 120 cells, `cell_type` (alpha, beta, gamma: 40 each).
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=category-builder`;
const CELL_TYPE = Object.freeze({ source: 'obs', key: 'cell_type' });

function dispatch(page, type, params) {
  return page.evaluate(async ({ type, params }) => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    return (await getActions().dispatch(type, params)).outcome;
  }, { type, params });
}

async function openBuilder(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
  // Page 1: alpha; Page 2: beta and gamma, so the two pages hold every cell.
  await dispatch(page, 'highlight.category', { field: CELL_TYPE, categories: ['alpha'], page: 'Page 1' });
  await dispatch(page, 'highlight.category', { field: CELL_TYPE, categories: ['beta'], page: 'Page 2' });
  await dispatch(page, 'highlight.category', { field: CELL_TYPE, categories: ['gamma'], page: 'Page 2' });
  await page.evaluate(() => { document.getElementById('highlighted-cells-section').open = true; });
  await page.locator('#cat-builder-accordion-item .disclosure-header').click();
  await expect(page.locator('#cat-builder-panel')).toBeVisible();
}

async function addPage(page, name) {
  await page.locator('#cat-builder-page-select').selectOption({ label: name });
  await page.locator('#cat-builder-add-page').click();
}

/** The preview's rows: label, count and the swatch's color. */
function previewRows(page) {
  return page.locator('#cat-builder-panel .preview-category').evaluateAll(rows => rows.map(row => ({
    label: row.querySelector('.preview-label').textContent,
    count: row.querySelector('.preview-count').textContent,
    color: getComputedStyle(row.querySelector('.preview-swatch')).getPropertyValue('--preview-swatch-color').trim(),
  })));
}

test('what the builder waits for is a hint, a name it refuses is refused as the action refuses it', async ({ page }) => {
  await openBuilder(page);
  const status = page.locator('#cat-builder-validation');
  const create = page.locator('#cat-builder-confirm');
  // Nothing added, nothing named: quiet hints, never a refusal in red.
  await expect(status).toHaveText('Add a highlight page to start.');
  await expect(status).toHaveAttribute('data-tone', 'muted');
  await expect(create).toBeDisabled();
  await addPage(page, 'Page 1');
  await expect(status).toHaveText('Name the new column.');
  await expect(status).toHaveAttribute('data-tone', 'muted');
  await expect(create).toBeDisabled();
  // A row's label that is its page's name does not repeat it.
  await expect(page.locator('#dropzone-items .dropzone-item-source')).toBeHidden();
  await page.locator('#dropzone-items input.dropzone-item-label').fill('Alpha cells');
  await expect(page.locator('#dropzone-items .dropzone-item-source')).toHaveText('Page 1');
  await expect(page.locator('#dropzone-items .dropzone-item-source')).toBeVisible();

  const name = page.locator('#cat-builder-name');
  // ':' is an ordinary character of a field name (ATAC peaks): accepted, as by a rename.
  await name.fill('peak chr1:100-200');
  await expect(status).toBeHidden();
  await expect(create).toBeEnabled();
  // A character without a glyph: refused here, before Create, in the action's words.
  await name.fill('lineage​');
  await expect(status).toHaveText('"lineage​" cannot be a field name: Field name cannot contain the zero-width character U+200B.');
  await expect(status).toHaveAttribute('data-tone', 'danger');
  await expect(create).toBeDisabled();
  await name.fill(' lineage');
  await expect(status).toHaveText('" lineage" cannot be a field name: Field name cannot have leading/trailing whitespace.');
  await expect(create).toBeDisabled();
  await name.fill('cell_type');
  await expect(status).toHaveText('A field named "cell_type" exists already; choose another name.');
  await expect(create).toBeDisabled();
});

test('the preview is the field made, which is shown at once; no empty category for uncovered cells', async ({ page }) => {
  await openBuilder(page);
  await addPage(page, 'Page 1');
  // 80 cells on no page: their category comes last, in the color the field gives it.
  const withUncovered = await previewRows(page);
  expect(withUncovered.map(row => [row.label, row.count])).toEqual([['Page 1', '40'], ['Unassigned', '80']]);
  await page.locator('#cat-builder-name').fill('one page');
  await page.locator('#cat-builder-confirm').click();
  await expect(page.locator('#categorical-field option:checked')).toHaveText('one page');
  await expect.poll(() => page.evaluate(() => window._cellucidState.getActiveField()?.key)).toBe('one page');
  const legendColors = await page.locator('#legend .legend-item').evaluateAll(rows => Object.fromEntries(rows.map(row => [
    row.querySelector('.legend-label-main').textContent,
    getComputedStyle(row.querySelector('.legend-swatch')).getPropertyValue('--legend-swatch-color').trim(),
  ])));
  const normalize = color => page.evaluate(value => {
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, color);
  for (const row of withUncovered) {
    expect(await normalize(row.color), row.label).toBe(await normalize(legendColors[row.label]));
  }
  // A page's category is drawn in its page's color: one color for one page,
  // in the builder's page row, its preview and the field made (F124).
  const pageOneColor = await page.evaluate(() => {
    const state = window._cellucidState;
    return state.getHighlightPageColor(state.highlightPages.find(entry => entry.name === 'Page 1').id);
  });
  expect(await normalize(legendColors['Page 1'])).toBe(await normalize(pageOneColor));

  // Both pages hold every cell: no uncovered row, and none made.
  await page.locator('#cat-builder-accordion-item .disclosure-header').click();
  if (!(await page.locator('#cat-builder-panel').isVisible())) {
    await page.locator('#cat-builder-accordion-item .disclosure-header').click();
  }
  await addPage(page, 'Page 1');
  await addPage(page, 'Page 2');
  expect((await previewRows(page)).map(row => [row.label, row.count])).toEqual([['Page 1', '40'], ['Page 2', '80']]);
  await expect(page.locator('#cat-builder-panel .preview-stats')).toContainText('2 categories');
  await page.locator('#cat-builder-name').fill('two pages');
  await page.locator('#cat-builder-confirm').click();
  await expect(page.locator('#categorical-field option:checked')).toHaveText('two pages');
  expect(await page.evaluate(() => window._cellucidState.getActiveField().categories)).toEqual(['Page 1', 'Page 2']);
  await expect(page.locator('#legend .legend-item')).toHaveCount(2);
});
