/**
 * The field, color, filter and data actions in the real app
 * (`assets/js/app/actions/definitions/{fields,coloring,filters,mapping}.js`):
 * every control of the area dispatches exactly the action it stands for,
 * naming fields, categories and genes; each action dispatched directly
 * changes exactly what it says; the legend follows a change made by an
 * action from anywhere; and a category keeps exactly the N cells the seeded
 * sample names (filter by cell count).
 *
 * The fixture (`current-ui`): 120 cells, `cell_type` (alpha, beta, gamma: 40
 * each), a continuous `score`, six genes, a latent space.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { applyUndoRedo, waitForHistory } from './helpers/state-history.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { whenActionsDone } from './helpers/dataset-ready.mjs';
import { rankOf } from '../../assets/js/data/subsample.js';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=actions-fields-ci`;
const CELL_TYPE = Object.freeze({ source: 'obs', key: 'cell_type' });
const SCORE = Object.freeze({ source: 'obs', key: 'score' });

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function openFixture(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
  // Every action dispatched from now on, as the dispatcher reports it.
  await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    window.__dispatched = [];
    getActions().subscribe(event => {
      if (event.kind === 'start') window.__dispatched.push({ type: event.type, params: event.params, origin: event.meta.origin });
    });
  });
}

/** The actions dispatched since the last call, and forget them. */
function takeDispatched(page) {
  return page.evaluate(() => window.__dispatched.splice(0).map(entry => ({
    ...entry,
    params: JSON.parse(JSON.stringify(entry.params)),
  })));
}

/** Dispatch an action in the page (origin as given) and return its outcome, or the refusal's words. */
function dispatch(page, type, params, meta = {}) {
  return page.evaluate(async ({ type, params, meta }) => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    try {
      const { outcome } = await getActions().dispatch(type, params, meta);
      return { outcome };
    } catch (error) {
      return { refused: `${error.name}: ${error.message}` };
    }
  }, { type, params, meta });
}

/** What the state shows: the coloring, the cell_type field's filter and colors, the visible count. */
function shown(page) {
  return page.evaluate(() => {
    const state = window._cellucidState;
    const active = state.getActiveField();
    const cellType = state.getFields().find(field => field.key === 'cell_type' && field._isDeleted !== true) ?? null;
    return {
      active: active === null ? null : { source: state.activeFieldSource, key: active.key },
      // Read through the state (the legend's model), never the field's own arrays.
      visible: cellType?.codes == null ? null : [...state.getLegendModel(cellType).visible],
      missingVisible: cellType?._missingVisible ?? null,
      limits: cellType?._categoryCellLimits === undefined ? [] : cellType._categoryCellLimits.map(limit => ({ ...limit })),
      shown: state.getFilteredCount().shown,
      categories: cellType === null ? null : [...cellType.categories],
      fields: state.getFields().filter(field => field._isDeleted !== true).map(field => field.key),
    };
  });
}

/** The cells of a category, all of them or the ones shown now, by original position. */
function cellsOf(page, category, { shownOnly = true } = {}) {
  return page.evaluate(({ code, shownOnly }) => {
    const state = window._cellucidState;
    const field = state.getFields().find(candidate => candidate.key === 'cell_type' && candidate._isDeleted !== true);
    const out = [];
    for (let i = 0; i < state.pointCount; i++) {
      if (field.codes[i] === code && (!shownOnly || state.categoryTransparency[i] === 1)) out.push(state.cellIdentity.originalAt(i));
    }
    return out.sort((a, b) => a - b);
  }, { code: category, shownOnly });
}

/**
 * The `count` cells of beta (category 1) a sample under `seed` keeps: its
 * cells with the lowest rank, by original position (`data/subsample.js`
 * `rankOf`, the uniform subsample's rule), worked out here from the rule.
 */
async function expectedBetaSample(page, count, seed) {
  const beta = await cellsOf(page, 1, { shownOnly: false });
  expect(beta).toHaveLength(40);
  return beta.sort((a, b) => rankOf(seed, a) - rankOf(seed, b)).slice(0, count).sort((a, b) => a - b);
}

function legendRow(page, label) {
  return page.locator('.legend-item', { has: page.locator('.legend-label-main', { hasText: new RegExp(`^${label}$`) }) });
}

test('every control of the area dispatches the action it stands for, naming what it changes', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openFixture(page);

  // Coloring by a field, then a gene, then clearing: color.by, one step each.
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  // The fixture opens colored by cell_type already (`first-coloring.js`), so
  // the legend's three rows are there before the choice and say nothing of
  // it: the control's action is waited for as itself (read at once, it may
  // not have been dispatched yet).
  await expect.poll(() => page.evaluate(() => window.__dispatched.length)).toBeGreaterThan(0);
  await whenActionsDone(page);
  expect(await takeDispatched(page)).toEqual([{ type: 'color.by', params: { field: CELL_TYPE }, origin: 'user' }]);
  expect((await shown(page)).active).toEqual(CELL_TYPE);

  // A category hidden from the legend.
  await legendRow(page, 'alpha').locator('.legend-checkbox').uncheck();
  await expect(page.locator('#filter-count')).toHaveText('Showing 80 of 120 cells');
  expect(await takeDispatched(page)).toEqual([{
    type: 'filter.category.visibility', params: { field: CELL_TYPE, categories: ['alpha'], visible: false }, origin: 'user',
  }]);

  // The count keeps 10 of beta's 40 cells: typed in place of the count.
  const betaCount = legendRow(page, 'beta').locator('.legend-count');
  await expect(betaCount).toHaveText('40 cells');
  await betaCount.click();
  const editor = legendRow(page, 'beta').locator('input.inline-rename-input');
  await expect(editor).toHaveValue('all');
  await editor.fill('10');
  await editor.press('Enter');
  await expect(page.locator('#filter-count')).toHaveText('Showing 50 of 120 cells');
  expect(await takeDispatched(page)).toEqual([{
    type: 'filter.category.cell-count', params: { field: CELL_TYPE, category: 'beta', count: 10, seed: 0 }, origin: 'user',
  }]);
  await expect(betaCount).toHaveText('10 / 40 cells');
  await expect(betaCount).toHaveClass(/is-limited/);
  await expect(betaCount).toHaveAttribute('title', 'Keeps a random 10 cells of beta (seed 0); click to change, or type all');
  await expect(page.locator('#active-filters')).toContainText('cell_type: hiding alpha; keeping 10 of beta');
  expect(await cellsOf(page, 1)).toEqual(await expectedBetaSample(page, 10, 0));
  // "all" shows every cell of it again.
  await betaCount.click();
  await legendRow(page, 'beta').locator('input.inline-rename-input').fill('all');
  await legendRow(page, 'beta').locator('input.inline-rename-input').press('Enter');
  await expect(page.locator('#filter-count')).toHaveText('Showing 80 of 120 cells');
  expect(await takeDispatched(page)).toEqual([{
    type: 'filter.category.cell-count', params: { field: CELL_TYPE, category: 'beta', count: null, seed: 0 }, origin: 'user',
  }]);
  await expect(betaCount).not.toHaveClass(/is-limited/);

  // Show all: one step, every category.
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
  expect(await takeDispatched(page)).toEqual([{ type: 'filter.category.all', params: { field: CELL_TYPE, visible: true }, origin: 'user' }]);
  await expect(legendRow(page, 'alpha').locator('.legend-checkbox')).toBeChecked();

  // A category renamed in place.
  await legendRow(page, 'gamma').locator('.legend-rename-btn').click();
  const rename = page.locator('#legend input.inline-rename-input');
  await rename.fill('Gamma cells');
  await rename.press('Enter');
  await expect(legendRow(page, 'Gamma cells')).toHaveCount(1);
  expect(await takeDispatched(page)).toEqual([{
    type: 'category.rename', params: { field: CELL_TYPE, category: 'gamma', name: 'Gamma cells' }, origin: 'user',
  }]);
  // The field's own category order, whatever the labels: a rename
  // keeps a category in its place, as the Group dialog and the figure legend.
  await expect(page.locator('#legend .legend-label-main')).toHaveText(['alpha', 'beta', 'Gamma cells']);
  await legendRow(page, 'Gamma cells').locator('.legend-rename-btn').click();
  await rename.fill('beta 10');
  await rename.press('Enter');
  await legendRow(page, 'alpha').locator('.legend-rename-btn').click();
  await rename.fill('beta 9');
  await rename.press('Enter');
  await expect(page.locator('#legend .legend-label-main')).toHaveText(['beta 9', 'beta', 'beta 10']);
  for (const [from, to] of [['beta 9', 'alpha'], ['beta 10', 'Gamma cells']]) {
    await legendRow(page, from).locator('.legend-rename-btn').click();
    await rename.fill(to);
    await rename.press('Enter');
    await expect(legendRow(page, to)).toHaveCount(1);
  }
  await takeDispatched(page);

  // Group categories: one row a category, a group typed for each; Group is one action, one step.
  await page.locator('#group-categorical-field').click();
  const groupDialog = page.locator('#group-categories-dialog');
  await expect(groupDialog).toBeVisible();
  await expect(groupDialog.locator('.group-categories-row')).toHaveCount(3);
  await expect(page.locator('#group-categories-status')).toHaveText('Type a group for the categories it holds.');
  await expect(page.locator('#group-categories-apply')).toBeDisabled();
  await groupDialog.getByRole('combobox', { name: 'The group alpha joins' }).fill('Early');
  await groupDialog.getByRole('combobox', { name: 'The group beta joins' }).fill('Early');
  await expect(page.locator('#group-categories-status')).toHaveText('1 group from 2 categories; 1 other keeps its name.');
  await expect(page.locator('#group-categories-name')).toHaveValue('cell_type (grouped)');
  // A group called as a kept category is refused in the dialog, which stays open.
  await groupDialog.getByRole('combobox', { name: 'The group beta joins' }).fill('Gamma cells');
  await page.locator('#group-categories-apply').click();
  await expect(page.locator('#group-categories-status')).toHaveText(/^"Gamma cells" is kept as it is \(no group lists it\), and a group is called "Gamma cells"/);
  await expect(groupDialog).toBeVisible();
  await groupDialog.getByRole('combobox', { name: 'The group beta joins' }).fill('Early');
  await page.locator('#group-categories-rest-on').check();
  await expect(page.locator('#group-categories-status')).toHaveText('1 group from 2 categories; 1 other into Other.');
  await takeDispatched(page);
  await page.locator('#group-categories-apply').click();
  await expect(groupDialog).toBeHidden();
  expect((await takeDispatched(page)).filter(entry => entry.type === 'field.group')).toEqual([{
    type: 'field.group',
    params: { field: CELL_TYPE, groups: [{ label: 'Early', categories: ['alpha', 'beta'] }], rest: 'Other', name: 'cell_type (grouped)' },
    origin: 'user',
  }]);
  await expect.poll(async () => (await shown(page)).active).toEqual({ source: 'obs', key: 'cell_type (grouped)' });
  // The menu names the field shown.
  await expect(page.locator('#categorical-field option:checked')).toHaveText('cell_type (grouped)');
  await expect(page.locator('.legend-item')).toHaveCount(2);
  await expect(legendRow(page, 'Early')).toHaveCount(1);
  await expect(legendRow(page, 'Other')).toHaveCount(1);
  // Back to cell_type for the rest of the walk.
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  await takeDispatched(page);

  // A color picked: the drag is one action of the last color.
  await legendRow(page, 'alpha').locator('.legend-color-input').fill('#00ff00');
  await expect.poll(async () => (await takeDispatched(page)).map(entry => entry.type)).toContain('color.category');
  expect(await page.evaluate(() => {
    const state = window._cellucidState;
    return state.getColorForCategory(state.getActiveField(), 0);
  })).toEqual([0, 1, 0]);

  // A continuous field: the range typed, the log switch, Reset.
  await page.locator('#continuous-field').selectOption({ label: 'score' });
  await expect(page.locator('#legend .slider-row input[type="range"]')).toHaveCount(2);
  expect(await takeDispatched(page)).toEqual([{ type: 'color.by', params: { field: SCORE }, origin: 'user' }]);
  const minBox = page.locator('#legend .legend-range-bounds input[type="text"]').first();
  await minBox.fill('0.5');
  await minBox.press('Enter');
  await expect(page.locator('#active-filters')).toContainText('score:');
  const ranged = await takeDispatched(page);
  expect(ranged.map(entry => entry.type)).toEqual(['filter.continuous.range']);
  expect(ranged[0].params.field).toEqual(SCORE);
  expect(ranged[0].params.min).toBe(0.5);
  await page.getByRole('switch', { name: 'Log color scale' }).click();
  await expect.poll(() => page.evaluate(() => window._cellucidState.getActiveField()._useLogScale)).toBe(true);
  expect(await takeDispatched(page)).toEqual([{ type: 'color.continuous.log', params: { field: SCORE, enabled: true }, origin: 'user' }]);
  await page.locator('#legend').getByRole('button', { name: 'Reset' }).click();
  await expect(page.locator('#active-filters')).not.toContainText('score:');
  expect((await takeDispatched(page)).map(entry => entry.type)).toEqual(['filter.continuous.reset']);

  // The filter list removes cell_type's... none left; clear the coloring.
  await page.locator('#clear-continuous-field').click();
  await expect.poll(async () => (await shown(page)).active).toBe(null);
  expect(await takeDispatched(page)).toEqual([{ type: 'color.by', params: { field: null }, origin: 'user' }]);

  // A gene chosen in the search box.
  await page.locator('#gene-expression-search').fill('CD3E');
  await page.locator('#gene-expression-search').press('Enter');
  await expect.poll(async () => (await shown(page)).active).toEqual({ source: 'var', key: 'CD3E' });
  expect(await takeDispatched(page)).toEqual([{ type: 'color.by', params: { field: { source: 'var', key: 'CD3E' } }, origin: 'user' }]);

  expect(productErrors).toEqual([]);
});

test('each action dispatched directly changes exactly what it names, and the controls follow it', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openFixture(page);

  // Coloring, from anywhere: the field selector's own choice, so the selects follow.
  expect((await dispatch(page, 'color.by', { field: CELL_TYPE })).outcome).toEqual({ field: 'cell_type', source: 'obs', kind: 'category' });
  await expect(page.locator('#categorical-field option:checked')).toHaveText('cell_type');
  await expect(page.locator('.legend-item')).toHaveCount(3);
  expect((await dispatch(page, 'color.by', { field: { source: 'obs', key: 'nope' } })).refused)
    .toBe('ActionRefused: There is no field "nope"; the fields are "score" and "cell_type".');

  // Categories by label; the legend's boxes follow.
  await dispatch(page, 'filter.category.visibility', { field: CELL_TYPE, categories: ['alpha', 'gamma'], visible: false });
  expect(await shown(page)).toMatchObject({ visible: [0, 1, 0], shown: 40 });
  await expect(legendRow(page, 'alpha').locator('.legend-checkbox')).not.toBeChecked();
  expect((await dispatch(page, 'filter.category.visibility', { field: CELL_TYPE, categories: ['delta'], visible: false })).refused)
    .toBe('ActionRefused: There is no category "delta" in "cell_type"; the categories are "alpha", "beta" and "gamma".');
  await dispatch(page, 'filter.category.all', { field: CELL_TYPE, visible: true });
  expect(await shown(page)).toMatchObject({ visible: [1, 1, 1], shown: 120 });
  await dispatch(page, 'filter.category.missing', { field: CELL_TYPE, visible: false });
  expect((await shown(page)).missingVisible).toBe(false);
  await dispatch(page, 'filter.category.missing', { field: CELL_TYPE, visible: true });

  // N cells of a category, a seeded sample: exactly the cells the rule names.
  await dispatch(page, 'filter.category.cell-count', { field: CELL_TYPE, category: 'beta', count: 10, seed: 5 });
  expect(await shown(page)).toMatchObject({ limits: [{ category: 1, count: 10, seed: 5 }], shown: 90 });
  const sample = await expectedBetaSample(page, 10, 5);
  expect(await cellsOf(page, 1)).toEqual(sample);
  await expect(legendRow(page, 'beta').locator('.legend-count')).toHaveText('10 / 40 cells');
  // A larger count keeps every cell the smaller one did.
  await dispatch(page, 'filter.category.cell-count', { field: CELL_TYPE, category: 'beta', count: 25, seed: 5 });
  const larger = await cellsOf(page, 1);
  expect(larger).toEqual(await expectedBetaSample(page, 25, 5));
  expect(sample.every(cell => larger.includes(cell))).toBe(true);
  // Turned off with the field's category filter, removed with it.
  await dispatch(page, 'filter.enable', { field: CELL_TYPE, kind: 'category', enabled: false });
  expect((await shown(page)).shown).toBe(120);
  await dispatch(page, 'filter.enable', { field: CELL_TYPE, kind: 'category', enabled: true });
  expect((await shown(page)).shown).toBe(105);
  await dispatch(page, 'filter.remove', { field: CELL_TYPE, kind: 'category' });
  expect(await shown(page)).toMatchObject({ limits: [], shown: 120 });

  // A category's color; the legend's swatch follows (no visibility change).
  await dispatch(page, 'color.category', { field: CELL_TYPE, category: 'beta', color: '#ff0000' });
  await expect(legendRow(page, 'beta').locator('.legend-color-input')).toHaveValue('#ff0000');

  // Labels: rename, merge, delete into unassigned, by label.
  await dispatch(page, 'category.rename', { field: CELL_TYPE, category: 'alpha', name: 'A' });
  expect((await shown(page)).categories).toEqual(['A', 'beta', 'gamma']);
  await expect(legendRow(page, 'A')).toHaveCount(1);
  expect((await dispatch(page, 'category.rename', { field: CELL_TYPE, category: 'beta', name: 'gamma' })).refused)
    .toBe('ActionRefused: "cell_type" has a category "gamma" already; choose another label.');

  // Fields: rename and its revert, duplicate (colored by the copy), delete, restore, purge.
  await dispatch(page, 'field.rename', { field: SCORE, name: 'quality' });
  expect((await shown(page)).fields).toEqual(['quality', 'cell_type']);
  expect((await dispatch(page, 'field.revert-name', { field: { source: 'obs', key: 'quality' } })).outcome).toEqual({ name: 'score' });
  expect((await shown(page)).fields).toEqual(['score', 'cell_type']);
  expect((await dispatch(page, 'field.duplicate', { field: CELL_TYPE, name: 'cell_type_v2' })).outcome).toEqual({ name: 'cell_type_v2' });
  expect((await shown(page)).active).toEqual({ source: 'obs', key: 'cell_type_v2' });
  await expect(page.locator('#categorical-field option:checked')).toHaveText('cell_type_v2');
  await dispatch(page, 'category.merge', { field: { source: 'obs', key: 'cell_type_v2' }, category: 'beta', into: 'gamma' });
  expect(await page.evaluate(() => [...window._cellucidState.getActiveField().categories].sort())).toEqual(['A', 'merged beta + gamma']);
  // A label names the merged category: "into A" keeps A; a name another category holds is refused.
  expect((await dispatch(page, 'category.merge', { field: { source: 'obs', key: 'cell_type_v2' }, category: 'merged beta + gamma', into: 'A', label: 'merged beta + gamma ' })).refused)
    .toBe('ActionRefused: "merged beta + gamma " cannot be a category label: it starts or ends with a space; give it without.');
  expect((await dispatch(page, 'category.merge', { field: { source: 'obs', key: 'cell_type_v2' }, category: 'merged beta + gamma', into: 'A', label: 'A' })).outcome)
    .toMatchObject({ merged: 'A', in_place: true });
  expect(await page.evaluate(() => window._cellucidState.getActiveField().categories)).toEqual(['A']);
  // Grouped into a new field: its codes by group, the field it is made from untouched, shown at once.
  const before = await page.evaluate(() => {
    const field = window._cellucidState.getFields().find(each => each.key === 'cell_type_v2' && each._isDeleted !== true);
    return { categories: [...field.categories], codes: [...field.codes] };
  });
  expect((await dispatch(page, 'field.group', { field: { source: 'obs', key: 'cell_type_v2' }, groups: [{ label: 'All of it', categories: ['A'] }], name: 'grouped v2' })).outcome)
    .toEqual({ name: 'grouped v2', categories: 1, kept: 0 });
  const grouped = await page.evaluate(() => {
    const state = window._cellucidState;
    const field = state.getFields().find(each => each.key === 'grouped v2');
    const source = state.getFields().find(each => each.key === 'cell_type_v2' && each._isDeleted !== true);
    return { active: state.getActiveField().key, categories: [...field.categories], codes: [...field.codes], source: { categories: [...source.categories], codes: [...source.codes] } };
  });
  expect(grouped.active).toBe('grouped v2');
  expect(grouped.categories).toEqual(['All of it']);
  expect(grouped.codes).toEqual(before.codes);
  expect(grouped.source).toEqual(before);
  await dispatch(page, 'field.delete', { field: { source: 'obs', key: 'grouped v2' } });
  await dispatch(page, 'field.purge', { field: { source: 'obs', key: 'grouped v2' } });
  await dispatch(page, 'field.delete', { field: { source: 'obs', key: 'cell_type_v2' } });
  expect((await shown(page)).fields).toEqual(['score', 'cell_type']);
  await dispatch(page, 'field.restore', { field: { source: 'obs', key: 'cell_type_v2' } });
  expect((await shown(page)).fields).toEqual(['score', 'cell_type', 'cell_type_v2']);
  await dispatch(page, 'field.delete', { field: { source: 'obs', key: 'cell_type_v2' } });
  await dispatch(page, 'field.purge', { field: { source: 'obs', key: 'cell_type_v2' } });
  expect((await dispatch(page, 'field.restore', { field: { source: 'obs', key: 'cell_type_v2' } })).refused)
    .toMatch(/^ActionRefused: There is no deleted field "cell_type_v2"/);

  // A continuous field's colors and range, on the field shown.
  await dispatch(page, 'color.by', { field: SCORE });
  expect((await dispatch(page, 'color.category', { field: SCORE, category: 'x', color: '#000000' })).refused)
    .toBe('ActionRefused: "score" is a continuous field, not a categorical one.');
  await dispatch(page, 'color.continuous.colormap', { field: SCORE, colormap: 'magma' });
  await dispatch(page, 'color.continuous.log', { field: SCORE, enabled: true });
  await dispatch(page, 'color.continuous.rescale', { field: SCORE, enabled: true });
  await dispatch(page, 'filter.continuous.range', { field: SCORE, min: 0.25, max: 0.75 });
  const score = await page.evaluate(() => {
    const field = window._cellucidState.getActiveField();
    return { colormap: field._colormapId, log: field._useLogScale, rescale: field._useFilterColorRange, filter: { ...field._continuousFilter }, colors: { ...field._continuousColorRange } };
  });
  expect(score).toEqual({ colormap: 'magma', log: true, rescale: true, filter: { min: 0.25, max: 0.75 }, colors: { min: 0.25, max: 0.75 } });
  await expect(page.locator('#legend .section-title').first()).toHaveText('Color scale (Magma)');
  await expect(page.locator('#legend .legend-range-bounds input[type="text"]').first()).toHaveValue('0.25');
  await dispatch(page, 'filter.continuous.reset', { field: SCORE });
  expect((await shown(page)).shown).toBe(120);
  expect((await dispatch(page, 'color.continuous.log', { field: CELL_TYPE, enabled: true })).refused)
    .toBe('ActionRefused: "cell_type" is a categorical field, not a continuous one.');

  // Cells hidden one by one, by original position.
  expect((await dispatch(page, 'cells.visibility.set', { cells: [0, 1, 2], visible: false })).outcome).toEqual({ cells: 3, not_open: 0 });
  expect((await shown(page)).shown).toBe(117);
  await dispatch(page, 'cells.visibility.set', { cells: null, visible: true });
  expect((await shown(page)).shown).toBe(120);

  // A notebook's column and gene set, from a host: named by the host.
  const pushed = await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    const values = new Float32Array(120).map((_, cell) => cell / 120);
    const { outcome } = await getActions().dispatch('field.push', {
      key: 'pseudotime', kind: 'continuous', categories: null, n_obs: 120, cells: null, values,
    }, { origin: 'host', host: 'python' });
    const field = window._cellucidState.getFields().find(candidate => candidate.key === 'pseudotime');
    return { outcome: { name: outcome.name, kind: outcome.kind }, last: field.values[119] };
  });
  expect(pushed).toEqual({ outcome: { name: 'pseudotime', kind: 'continuous' }, last: Math.fround(119 / 120) });
  // A color setting names the field it is for: another than the one shown is refused.
  expect((await dispatch(page, 'color.continuous.log', { field: { source: 'obs', key: 'pseudotime' }, enabled: true })).refused)
    .toBe('ActionRefused: The view in focus is colored by "score", not by "pseudotime"; color it by "pseudotime" first.');
  expect((await dispatch(page, 'gene-set.save', { name: 'T cells', genes: ['CD3E'] }, { origin: 'host', host: 'r' })).outcome)
    .toMatchObject({ name: 'T cells', genes: 1 });

  // A data mapping group, by itself.
  await dispatch(page, 'mapping.set', { latent: null });
  expect(await page.evaluate(() => window._cellucidState.getDataMapping().latent)).toBe(null);
  await dispatch(page, 'mapping.set', { latent: 'latent_space' });
  expect(await page.evaluate(() => window._cellucidState.getDataMapping().latent)).toBe('latent_space');

  // A share of the cells, then every cell again.
  await dispatch(page, 'cells.open', { mode: 'subsample', count: 60, method: 'uniform', seed: 1 });
  await expect(page.locator('#filter-count')).toHaveText('Showing all 60 of 120 cells');
  expect(await page.evaluate(() => window._cellucidState.pointCount)).toBe(60);
  await dispatch(page, 'cells.open', { mode: 'all' });
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
  // No gene sample here (genes read for every open cell): nothing to read.
  expect((await dispatch(page, 'cells.read-genes', { cells: 120 })).outcome).toBe(null);

  expect(productErrors).toEqual([]);
});

test('apply then undo puts every state domain back exactly, action by action, on the page\'s own history', async ({ page }) => {
  await openFixture(page);
  await waitForHistory(page);
  const field = { source: 'obs', key: 'cell_type' };
  const score = { source: 'obs', key: 'score' };
  const steps = [
    // The fixture opens colored by cell_type (`first-coloring.js`): the
    // score first, so coloring by cell_type is a step again.
    ['color.by', { field: score }],
    ['color.by', { field }],
    ['filter.category.visibility', { field, categories: ['alpha'], visible: false }],
    ['filter.category.cell-count', { field, category: 'beta', count: 7, seed: 3 }],
    ['filter.category.missing', { field, visible: false }],
    ['filter.enable', { field, kind: 'category', enabled: false }],
    ['filter.remove', { field, kind: 'category' }],
    ['filter.category.all', { field, visible: false }],
    ['color.category', { field, category: 'gamma', color: '#123456' }],
    ['category.rename', { field, category: 'alpha', name: 'A' }],
    // By name: alpha shows as "A" now; gamma, left out, is pending.
    ['field.consensus', {
      key: 'consensus', field,
      mapping: [
        { category: 'A', status: 'consensus', label: 'Agreed', voters: 2 },
        { category: 'beta', status: 'disputed', label: null, voters: 1 },
      ],
      settings: { minAnnotators: 1, threshold: 0.5 },
      provenance: { repository: 'lab/annotations', branch: 'main', commit: null, pulledAt: null },
    }],
    ['field.rename', { field: score, name: 'quality' }],
    ['field.duplicate', { field, name: 'copy' }],
    // Groups of categories as a new field, the others kept, then into rest.
    ['field.group', { field, groups: [{ label: 'AB', categories: ['A', 'beta'] }] }],
    ['field.group', { field, groups: [{ label: 'G', categories: ['gamma'] }], rest: 'Other', name: 'lineage' }],
    ['category.merge', { field: { source: 'obs', key: 'copy' }, category: 'beta', into: 'gamma' }],
    // The merge made "merged beta + gamma"; alpha, renamed "A" before the copy, is still its own.
    ['category.delete', { field: { source: 'obs', key: 'copy' }, category: 'A' }],
    ['field.delete', { field: { source: 'obs', key: 'copy' } }],
    ['cells.visibility.set', { cells: [5, 6], visible: false }],
    ['color.by', { field: { source: 'obs', key: 'quality' } }],
    ['color.continuous.colormap', { field: { source: 'obs', key: 'quality' }, colormap: 'plasma' }],
    ['color.continuous.log', { field: { source: 'obs', key: 'quality' }, enabled: true }],
    ['color.continuous.zero-gray', { field: { source: 'obs', key: 'quality' }, enabled: true }],
    ['color.continuous.rescale', { field: { source: 'obs', key: 'quality' }, enabled: false }],
    ['filter.continuous.range', { field: { source: 'obs', key: 'quality' }, min: 0.2, max: 0.8 }],
    ['color.by', { field: { source: 'var', key: 'CD3E' } }],
    ['gene-set.save', { name: 'set', genes: ['CD3E'] }],
    ['mapping.set', { latent: null }],
  ];
  const report = await applyUndoRedo(page, steps);
  for (const entry of report) {
    expect(entry.refused, `${entry.type} applies`).toBeNull();
    expect(entry.step, `${entry.type} is a step`).toBe(true);
    expect(entry.untouched, `${entry.type}: changes only the domains it touches`).toEqual([]);
    expect(entry.differs, `${entry.type}: undo puts back every domain`).toEqual([]);
    expect(entry.redone, `${entry.type}: redo gives it again`).toEqual([]);
  }
});
