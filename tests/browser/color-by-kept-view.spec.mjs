/**
 * F95 (2026-11-11): coloring a kept view by a gene did nothing, and
 * `color.by` answered null. Every view holds its own copies of the field
 * objects (`_cloneVarData`), and the gene search's entries held the objects
 * of the view the list was built in, so a gene chosen on another view was
 * "no longer on the gene list" and was not shown. A field of any kind is now
 * shown on any view, by the action and by the gene search alike, and a choice
 * that ends unshown is refused with a sentence, never answered with null.
 */
import { expect, test } from './helpers/test.mjs';

import { serveSyntheticCatalog } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { waitForDatasetReady } from './helpers/dataset-ready.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const DATASET = 'color-by-kept-view';
const ROOT = appUrl('/tests/browser/fixtures/generated-color-by-kept-view/');
const CELLS = 60;
const GENES = Object.freeze(['Ins1', 'Gcg']);

function observeErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  return errors;
}

function dispatch(page, type, params) {
  return page.evaluate(async ([actionType, actionParams]) => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    try {
      return { outcome: (await getActions().dispatch(actionType, actionParams)).outcome };
    } catch (error) {
      return { refused: error.name === 'ActionRefused', message: error.message };
    }
  }, [type, params]);
}

/** Each view's name, whether it is selected, and what it is colored by. */
async function views(page) {
  const { outcome } = await dispatch(page, 'views.state', {});
  return outcome.views.map(view => [view.name, view.active, view.colored_by?.key ?? null]);
}

async function open(page) {
  await serveSyntheticCatalog(page, ROOT, {
    id: DATASET,
    name: 'Kept view coloring fixture',
    cells: CELLS,
    genes: [...GENES],
    X: Float32Array.from({ length: CELLS * GENES.length }, (_, index) => (index % 7) * 0.5),
    obs: {
      cell_type: { categories: ['alpha', 'beta', 'delta'], codes: Int8Array.from({ length: CELLS }, (_, cell) => cell % 3) },
      score: Float32Array.from({ length: CELLS }, (_, cell) => Math.sin(cell)),
    },
    obsm: { X_umap: { data: Float32Array.from({ length: CELLS * 2 }, (_, index) => Math.cos(index * 0.37) * 4), columns: 2 } },
  });
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await waitForDatasetReady(page, CELLS);
  await openCollapsedPanels(page);
}

test('every kind of field colors a kept view and the live view, by the action and by the gene search', async ({ page }) => {
  const errors = observeErrors(page);
  await open(page);
  expect((await dispatch(page, 'color.by', { field: { source: 'obs', key: 'cell_type' } })).outcome.field).toBe('cell_type');
  expect((await dispatch(page, 'view.keep', {})).outcome).toEqual({ view: 'View 2' });

  // On the kept view: a gene, a continuous column, a category, a gene's copy.
  for (const [field, kind] of [
    [{ source: 'var', key: 'Ins1' }, 'continuous'],
    [{ source: 'obs', key: 'score' }, 'continuous'],
    [{ source: 'var', key: 'Gcg' }, 'continuous'],
    [{ source: 'obs', key: 'cell_type' }, 'category'],
  ]) {
    expect((await dispatch(page, 'color.by', { field })).outcome).toEqual({ field: field.key, source: field.source, kind });
    expect(await views(page)).toEqual([['View 1', false, 'cell_type'], ['View 2', true, field.key]]);
  }
  expect((await dispatch(page, 'field.duplicate', { field: { source: 'var', key: 'Ins1' } })).outcome).toEqual({ name: 'Ins1 (copy)' });
  expect(await views(page)).toEqual([['View 1', false, 'cell_type'], ['View 2', true, 'Ins1 (copy)']]);
  expect((await dispatch(page, 'color.by', { field: { source: 'var', key: 'Gcg' } })).outcome.field).toBe('Gcg');

  // The person's gene search on the kept view.
  const search = page.locator('#gene-expression-search');
  await search.click();
  await search.fill('Ins1');
  await search.press('Enter');
  await expect.poll(() => views(page)).toEqual([['View 1', false, 'cell_type'], ['View 2', true, 'Ins1']]);

  // Back on the live view, whose fields are other objects again.
  expect((await dispatch(page, 'view.focus', { view: 'View 1' })).outcome).toEqual({ view: 'View 1' });
  expect((await dispatch(page, 'color.by', { field: { source: 'var', key: 'Gcg' } })).outcome.field).toBe('Gcg');
  expect(await views(page)).toEqual([['View 1', true, 'Gcg'], ['View 2', false, 'Ins1']]);
  expect(errors).toEqual([]);
});
