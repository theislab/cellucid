/**
 * Every view's copy of a user-defined categorical is the same field.
 *
 * A kept view starts with a copy of each field of the view it was kept from,
 * and a user-defined categorical's definition (its categories, codes and
 * centroids) belongs to the field, not to a view: the session saves one
 * definition per field. An edit in place (deleting or merging a category, a
 * consensus column rebuilt) replaced the definition of the edited view's copy
 * and the stored field only, so another view kept the old one:
 *
 * - a kept view then switched to an embedding not yet loaded computed the
 *   centroids into the stored field's table, which its copy no longer shared,
 *   and failed with "Normalized user-defined centroids of layout ... were not
 *   published";
 * - an edit made in a kept view gave the live view's copy (the stored field
 *   itself) the new categories under its old per-category colours, and
 *   selecting the live view again failed with "Category colors must contain
 *   one RGB triplet per category".
 *
 * Each view keeps its own colours and hidden categories, carried through the
 * edit by category, and a view that shows the field is drawn again from the
 * new codes.
 */

import { expect, test } from './helpers/test.mjs';

import { serveSyntheticCatalog } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const ROOT = appUrl('/tests/browser/fixtures/generated-user-defined-kept-views/');
const DATASET_ID = 'user-defined-kept-views';
const CELL_COUNT = 12;
const FIELD_KEY = 'regions';
// Cells 0-3, 4-6 and 7-9 are selected; 10 and 11 fall into the uncovered category.
const SELECTIONS = Object.freeze([
  Object.freeze({ label: 'left', cells: Object.freeze([0, 1, 2, 3]) }),
  Object.freeze({ label: 'middle', cells: Object.freeze([4, 5, 6]) }),
  Object.freeze({ label: 'right', cells: Object.freeze([7, 8, 9]) }),
]);
const UNCOVERED_LABEL = 'rest';

function rawLayout(dimension) {
  const values = new Float32Array(CELL_COUNT * dimension);
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    for (let axis = 0; axis < dimension; axis++) {
      values[cell * dimension + axis] =
        Math.cos(cell * 1.3 + axis * 0.7 + dimension) * (2.5 + axis * 1.75)
        + (cell % 3) * 0.41 * (axis + 1)
        + dimension * 5;
    }
  }
  return values;
}

function observeErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

/**
 * The dataset opens on its 3D layout; its 1D and 2D layouts are read when a
 * view first shows them. The field is coloured with its labels shown, and a
 * view is kept: the kept view is selected.
 */
async function openWithKeptView(page) {
  await serveSyntheticCatalog(page, ROOT, {
    id: DATASET_ID,
    name: 'User-defined kept-view fixture',
    cells: CELL_COUNT,
    obsm: Object.fromEntries([1, 2, 3].map(dimension => [
      `X_umap_${dimension}d`,
      { data: rawLayout(dimension), columns: dimension },
    ])),
  });
  await page.goto(
    `/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET_ID}&acceptance=user-defined-kept-views-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-cells')).toHaveText(String(CELL_COUNT));
  await expect(page.locator('#view-representation-select option:checked')).toHaveText(/ · 3D$/);

  // The entry point the Category Builder's Create button calls.
  await page.evaluate(({ fieldKey, selections, uncoveredLabel }) => {
    const state = window._cellucidState;
    const pages = selections.map(({ label, cells }) => {
      const highlightPage = state.createHighlightPage(label);
      state.switchToPage(highlightPage.id);
      state.addHighlightDirect({ type: 'lasso', label, cellIndices: Uint32Array.from(cells) });
      return { pageId: highlightPage.id, label };
    });
    state.createCategoricalFromPages({
      key: fieldKey,
      pages,
      uncoveredLabel,
      overlapStrategy: 'first',
      overlapLabel: '',
      intersectionLabels: {},
    });
  }, { fieldKey: FIELD_KEY, selections: SELECTIONS, uncoveredLabel: UNCOVERED_LABEL });
  await page.locator('#categorical-field').selectOption({ label: FIELD_KEY });
  await page.locator('#toggle-centroid-points').check();
  await page.locator('#toggle-centroid-labels').check();
  await expect(page.locator('.legend-item')).toHaveCount(4);

  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('.split-badge')).toHaveCount(2);
  const keptId = await page.evaluate(() => window._cellucidState.activeViewId);
  expect(keptId).not.toBe('live');
  return keptId;
}

async function selectView(page, number) {
  await page.locator('.split-badge').filter({
    has: page.locator('.split-badge-pill', { hasText: new RegExp(`^${number}$`) }),
  }).click();
  await expect(page.locator('.split-badge.active .split-badge-pill')).toHaveText(String(number));
}

/**
 * Show the selected view's first embedding of `dimension`. A refused switch
 * fails here with what it said: an error notification, or a page error.
 */
async function showDimension(page, errors, viewId, dimension) {
  const option = page
    .locator(`#view-representation-select optgroup[label="${dimension}D"] option`)
    .first();
  await page.locator('#view-representation-select').selectOption(await option.getAttribute('value'));
  const refusals = page.locator('#notification-center .notification-error .notification-message');
  await expect.poll(async () => {
    const refused = await refusals.allTextContents();
    if (refused.length > 0 || errors.length > 0) return [...refused, ...errors].join('\n');
    return page.evaluate(id => window._cellucidState.getViewDimensionLevel(id), viewId);
  }).toBe(dimension);
}

function legendRow(page, label) {
  return page.locator('.legend-item', {
    has: page.locator('.legend-label-main', { hasText: new RegExp(`^${label}$`) }),
  });
}

/**
 * Each view's copy of the field next to the stored one, and what each view
 * draws for it: its centroid labels in the order drawn, which must be the
 * categories with cells, in category order, at the means of their cells.
 */
function readViews(page) {
  return page.evaluate(fieldKey => {
    const state = window._cellucidState;
    const focused = state.activeViewId;
    const copyIn = fields => fields.find(f => f.key === fieldKey && f._isDeleted !== true) ?? null;
    const focusedCopy = copyIn(state.obsData.fields);
    const template = state._userDefinedFields.getField(focusedCopy._userDefinedId);
    const views = {};
    for (const viewId of state.viewContexts.keys()) {
      const view = viewId === focused ? state : state.viewContexts.get(viewId);
      const copy = copyIn(view.obsData.fields);
      const layoutKey = state.getViewLayoutKey(viewId);
      const shown = view.activeFieldSource === 'obs' && view.obsData.fields[view.activeFieldIndex] === copy;
      // A label is drawn while its centroid is: its alpha is not zero.
      const centroidColors = view.centroidColors ?? new Uint8Array(0);
      const labels = (view.centroidLabels ?? [])
        .filter((_, index) => centroidColors[index * 4 + 3] > 0)
        .map(entry => entry.el.textContent);
      const centroids = copy.centroidsByLayout.get(layoutKey) ?? null;
      // The mean of each category's cells in the layout the view draws.
      const positions = state.dimensionManager.getResidentPositions(layoutKey);
      const dimension = state.dimensionManager.getLayout(layoutKey).dimension;
      const means = [];
      copy.categories.forEach((category, index) => {
        const sum = [0, 0, 0];
        let count = 0;
        for (let cell = 0; cell < copy.codes.length; cell++) {
          if (copy.codes[cell] !== index) continue;
          count++;
          for (let axis = 0; axis < dimension; axis++) sum[axis] += positions[cell * dimension + axis];
        }
        if (count > 0) means.push({ category, position: sum.slice(0, dimension).map(total => total / count) });
      });
      const colors = viewId === 'live' && focused === 'live' ? state.colorsArray : view.colorsArray;
      views[viewId] = {
        shown,
        layoutKey,
        categories: [...copy.categories],
        codes: Array.from(copy.codes),
        // The same codes and centroid tables as the stored field, and its
        // categories (a rename gives each view its own list of the same labels).
        sharesDefinition: copy.codes === template.codes
          && copy.centroidsByLayout === template.centroidsByLayout
          && copy._normalizedLayouts === template._normalizedLayouts
          && copy.categories.length === template.categories.length
          && copy.categories.every((category, index) => category === template.categories[index]),
        centroidCategories: centroids === null ? null : centroids.map(c => c.category),
        centroidsAreMeans: centroids !== null && centroids.length === means.length && centroids.every(
          (c, i) => c.category === means[i].category
            && c.position.every((value, axis) => Math.abs(value - means[i].position[axis]) < 1e-6)
        ),
        labels,
        visible: copy.categories.map((_, index) => copy._categoryVisible?.[index] ?? true),
        // The colour each shown category is drawn in, from the view's own
        // colour buffer, at the first cell of each category with cells.
        drawnColors: Object.fromEntries(copy.categories.flatMap((category, index) => {
          const cell = copy.codes.indexOf(index);
          return cell < 0 || copy._categoryVisible?.[index] === false
            ? []
            : [[category, Array.from(colors.subarray(cell * 4, cell * 4 + 3))]];
        })),
        ownColors: Object.fromEntries(copy.categories.map((category, index) => [
          category,
          copy._categoryColors[index].map(channel => Math.round(channel * 255)),
        ])),
      };
    }
    return { focused, templateCategories: [...template.categories], views };
  }, FIELD_KEY);
}

function fieldIndexOf(page) {
  return page.evaluate(fieldKey => window._cellucidState.obsData.fields.findIndex(
    field => field.key === fieldKey && field._isDeleted !== true
  ), FIELD_KEY);
}

/** Every view holds the stored definition and draws it. */
function expectCoherent(read, categories) {
  expect(read.templateCategories).toEqual(categories);
  for (const [viewId, view] of Object.entries(read.views)) {
    expect(view.categories, `${viewId} categories`).toEqual(categories);
    expect(view.sharesDefinition, `${viewId} holds the stored definition`).toBe(true);
    expect(view.centroidsAreMeans, `${viewId} centroids are the means of its drawn layout`).toBe(true);
    expect(view.shown, `${viewId} shows the field`).toBe(true);
    // A drawn colour is the view's own colour of the category it is drawn for.
    for (const [category, rgb] of Object.entries(view.drawnColors)) {
      expect(rgb, `${viewId} draws ${category} in its own colour`).toEqual(view.ownColors[category]);
    }
  }
}

test('a category deleted in the live view reaches the kept view, which then shows another embedding', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = observeErrors(page);
  const keptId = await openWithKeptView(page);

  await selectView(page, 1);
  const fieldIndex = await fieldIndexOf(page);
  await page.evaluate(index => window._cellucidState.deleteCategoryToUnassigned(index, 0, {
    editInPlace: true,
    unassignedLabel: 'unassigned',
  }), fieldIndex);
  await expect(legendRow(page, 'left')).toHaveCount(0);

  // The kept view switches to 2D, which no view has loaded: its centroids are
  // computed from the field's codes into the table every copy shares.
  await selectView(page, 2);
  await showDimension(page, errors, keptId, 2);
  const read = await readViews(page);
  expectCoherent(read, ['middle', 'right', 'rest', 'unassigned']);
  expect(read.views[keptId].labels).toEqual(['middle', 'right', 'rest', 'unassigned']);
  expect(read.views.live.labels).toEqual(['middle', 'right', 'rest', 'unassigned']);
  expect(errors).toEqual([]);
});

test('a category deleted in a kept view leaves the live view coherent', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = observeErrors(page);
  const keptId = await openWithKeptView(page);
  // The legend's delete button, in the kept view.
  await legendRow(page, 'middle').locator('.legend-delete-btn').click();
  await expect(page.locator('.confirm-dialog-title')).toHaveText('Delete category label');
  await page.locator('.confirm-dialog-confirm').click();
  await expect(legendRow(page, 'middle')).toHaveCount(0);

  await selectView(page, 1);
  await expect(legendRow(page, 'middle')).toHaveCount(0);
  await expect(legendRow(page, 'unassigned')).toHaveCount(1);
  await showDimension(page, errors, 'live', 1);
  const read = await readViews(page);
  expectCoherent(read, ['left', 'right', 'rest', 'unassigned']);
  expect(read.views.live.labels).toEqual(['left', 'right', 'rest', 'unassigned']);
  expect(read.views[keptId].labels).toEqual(['left', 'right', 'rest', 'unassigned']);
  expect(errors).toEqual([]);
});

test('a merge keeps each view its own colours and hidden categories', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = observeErrors(page);
  const keptId = await openWithKeptView(page);

  // The kept view hides 'rest' and recolours 'right'; the live view keeps both.
  await legendRow(page, 'rest').locator('.legend-checkbox').uncheck();
  const keptRight = [0.1, 0.8, 0.3];
  await page.evaluate(({ color }) => {
    const state = window._cellucidState;
    const field = state.getActiveField();
    state.setColorForCategory(field, field.categories.indexOf('right'), color);
  }, { color: keptRight });

  await selectView(page, 1);
  const fieldIndex = await fieldIndexOf(page);
  // Merge 'left' into 'middle': 'left' (0) is dragged onto 'middle' (1).
  await page.evaluate(index => window._cellucidState.mergeCategoriesToNewField(index, 0, 1, {
    editInPlace: true,
  }), fieldIndex);
  const read = await readViews(page);
  const merged = read.views.live.categories[0];
  expect(merged).toBe('merged left + middle');
  expectCoherent(read, [merged, 'right', 'rest']);
  // Each view keeps what it set, by category.
  expect(read.views[keptId].visible).toEqual([true, true, false]);
  expect(read.views.live.visible).toEqual([true, true, true]);
  expect(read.views[keptId].ownColors.right).toEqual(keptRight.map(channel => Math.round(channel * 255)));
  expect(read.views.live.ownColors.right).not.toEqual(read.views[keptId].ownColors.right);
  expect(read.views[keptId].labels).toEqual([merged, 'right']);
  expect(read.views.live.labels).toEqual([merged, 'right', 'rest']);

  await selectView(page, 2);
  await expect(page.locator('#filter-count')).toHaveText('Showing 10 of 12 cells');
  await showDimension(page, errors, keptId, 2);
  expectCoherent(await readViews(page), [merged, 'right', 'rest']);
  expect(errors).toEqual([]);
});

test('a consensus column rebuilt in place reaches every view that shows it', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = observeErrors(page);
  await serveSyntheticCatalog(page, ROOT, {
    id: DATASET_ID,
    name: 'User-defined kept-view fixture',
    cells: CELL_COUNT,
    obsm: Object.fromEntries([1, 2, 3].map(dimension => [
      `X_umap_${dimension}d`,
      { data: rawLayout(dimension), columns: dimension },
    ])),
  });
  await page.goto(
    `/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET_ID}&acceptance=user-defined-kept-views-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-cells')).toHaveText(String(CELL_COUNT));
  const upsert = codes => page.evaluate(({ key, codes: values }) => window._cellucidState.upsertUserDefinedCategoricalField({
    key,
    categories: ['Resolved', 'Disputed', 'Pending'],
    codes: Uint8Array.from(values),
  }), { key: FIELD_KEY, codes });
  // 'Disputed' holds no cell yet.
  await upsert([0, 0, 0, 0, 2, 2, 2, 2, 0, 0, 2, 2]);
  await page.locator('#categorical-field').selectOption({ label: FIELD_KEY });
  await page.locator('#toggle-centroid-labels').check();
  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('.split-badge')).toHaveCount(2);
  const keptId = await page.evaluate(() => window._cellucidState.activeViewId);

  await selectView(page, 1);
  await upsert([0, 1, 1, 0, 2, 2, 1, 2, 0, 0, 2, 1]);
  const read = await readViews(page);
  expectCoherent(read, ['Resolved', 'Disputed', 'Pending']);
  expect(read.views.live.labels).toEqual(['Resolved', 'Disputed', 'Pending']);
  expect(read.views[keptId].labels).toEqual(['Resolved', 'Disputed', 'Pending']);

  await selectView(page, 2);
  await showDimension(page, errors, keptId, 1);
  expectCoherent(await readViews(page), ['Resolved', 'Disputed', 'Pending']);
  expect(errors).toEqual([]);
});

test('a category renamed in one view is renamed in every view that shows it', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = observeErrors(page);
  const keptId = await openWithKeptView(page);
  const fieldIndex = await fieldIndexOf(page);
  await page.evaluate(index => window._cellucidState.renameCategory('obs', index, 2, 'east'), fieldIndex);

  await selectView(page, 1);
  await showDimension(page, errors, 'live', 2);
  const read = await readViews(page);
  expectCoherent(read, ['left', 'middle', 'east', 'rest']);
  expect(read.views.live.labels).toEqual(['left', 'middle', 'east', 'rest']);
  expect(read.views[keptId].labels).toEqual(['left', 'middle', 'east', 'rest']);
  expect(errors).toEqual([]);
});

test('a field deleted, restored or purged in one view is so in every view', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = observeErrors(page);
  const keptId = await openWithKeptView(page);
  const option = page.locator('#categorical-field option', { hasText: new RegExp(`^${FIELD_KEY}$`) });
  const copies = () => page.evaluate(fieldKey => {
    const state = window._cellucidState;
    const lists = [['focused', state.obsData.fields]];
    for (const [viewId, context] of state.viewContexts) {
      if (viewId !== state.activeViewId) lists.push([viewId, context.obsData.fields]);
    }
    const id = lists[0][1].find(field => (field._originalKey ?? field.key) === fieldKey)._userDefinedId;
    const template = state._userDefinedFields.getField(id);
    return {
      template: { deleted: template._isDeleted, purged: template._isPurged, codes: template.codes !== null },
      copies: Object.fromEntries(lists.map(([viewId, fields]) => {
        const copy = fields.find(field => field._userDefinedId === id);
        return [viewId, { deleted: copy._isDeleted === true, purged: copy._isPurged === true, codes: copy.codes !== null }];
      })),
    };
  }, FIELD_KEY);
  const fieldIndex = await fieldIndexOf(page);

  await selectView(page, 1);
  await page.evaluate(index => window._cellucidState.deleteField('obs', index), fieldIndex);
  await expect(option).toHaveCount(0);
  // The kept view, shown again, no longer lists the field or is coloured by it.
  await selectView(page, 2);
  await expect(option).toHaveCount(0);
  expect(await page.evaluate(() => window._cellucidState.getActiveField())).toBeNull();
  expect((await copies()).copies).toEqual({
    focused: { deleted: true, purged: false, codes: true },
    live: { deleted: true, purged: false, codes: true },
  });

  await selectView(page, 1);
  await page.evaluate(index => window._cellucidState.restoreField('obs', index), fieldIndex);
  await expect(option).toHaveCount(1);
  await selectView(page, 2);
  await expect(option).toHaveCount(1);

  // Purged from the Deleted fields list of the live view: every copy lets go
  // of the codes the field released.
  await selectView(page, 1);
  await page.evaluate(index => {
    const state = window._cellucidState;
    state.deleteField('obs', index);
    state.purgeDeletedField('obs', index);
  }, fieldIndex);
  await selectView(page, 2);
  expect(await copies()).toEqual({
    template: { deleted: true, purged: true, codes: false },
    copies: {
      focused: { deleted: true, purged: true, codes: false },
      live: { deleted: true, purged: true, codes: false },
    },
  });
  expect(keptId).not.toBe('live');
  expect(errors).toEqual([]);
});
