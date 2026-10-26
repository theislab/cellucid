/**
 * The Data mapping panel of a file with many embeddings, as a segmentation
 * export has them (`data-mapping-crowded.h5ad`): the checklist is one compact
 * row per array with its editor closed, nothing in it overflows the sidebar on
 * a desktop or a phone, every control it had is still there and works, a 2- or
 * 3-column array can be shown in any dimension its columns allow (through
 * views, sessions, highlights and figure export), and changing anything in
 * the panel leaves the sidebar's scroll position and the focus where they
 * were.
 *
 * Fixture: `scripts/generate-data-mapping-fixtures.py`.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { chooseFiles } from './helpers/file-input.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CROWDED_H5AD = path.join(FIXTURES, 'data-mapping-crowded.h5ad');
const START_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=data-mapping-layout-ci';
const SECTIONS = Object.freeze(['genes', 'knn', 'latent', 'vectors']);

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function openCrowded(page) {
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await openCollapsedPanels(page);
  await chooseFiles(page.locator('#user-data-file-input'), CROWDED_H5AD);
  await expect(page.locator('#dataset-name')).toHaveText('data-mapping-crowded');
  await expect.poll(() => page.evaluate(
    () => window._cellucidState.getMappingCandidates() !== null
  )).toBe(true);
  await page.evaluate(async () => {
    const { getNotificationCenter } = await import('/assets/js/app/notification-center.js');
    getNotificationCenter().dismissAll();
  });
  const header = page.locator('#data-mapping-disclosure > .disclosure-header-row > .disclosure-header');
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  // Arrays that are off and wider than 3 columns, or cannot be drawn, are
  // listed under "Other arrays", collapsed; open it so every row is listed.
  const others = page.locator('#data-mapping-more > .disclosure-header');
  if (await others.isVisible() && (await others.getAttribute('aria-expanded')) !== 'true') await others.click();
}

async function openSections(page) {
  for (const section of SECTIONS) {
    const header = page.locator(`[data-mapping-section="${section}"] .disclosure-header`);
    if (!(await header.isVisible())) continue;
    if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  }
}

/** The checklist row whose name is exactly `name`. */
function row(page, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page.locator('.data-mapping-row').filter({
    has: page.locator('.data-mapping-name', { hasText: new RegExp(`^${escaped}$`) }),
  });
}

/**
 * Every visible element of the panel that sticks out of its row (or of the
 * sidebar), and whether the sidebar scrolls sideways.
 */
function overflow(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector('.sidebar-scroll');
    const out = [];
    for (const element of document.querySelectorAll('#data-mapping-root *')) {
      if (element.closest('[hidden]') || element.getClientRects().length === 0) continue;
      const box = element.getBoundingClientRect();
      const container = element.parentElement.closest('.list-item, .disclosure-content, #data-mapping-root');
      const bounds = container.getBoundingClientRect();
      if (box.right > bounds.right + 0.5 || box.left < bounds.left - 0.5) {
        out.push(`${element.className || element.tagName} in ${container.className || container.id}`);
      }
    }
    return { out, sideways: scroller.scrollWidth > scroller.clientWidth };
  });
}

for (const [layout, viewport] of [
  ['a desktop', { width: 1440, height: 900 }],
  ['a phone', { width: 390, height: 844 }],
]) {
  test.describe(`on ${layout}`, () => {
    test.use({ viewport, ...(viewport.width < 720 ? { hasTouch: true } : {}) });

    test('the checklist is one compact row per array, its editors closed, nothing overflowing', async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await openCrowded(page);
      if (await page.locator('#sidebar').evaluate(element => element.classList.contains('hidden'))) {
        await page.locator('#sidebar-toggle').click();
      }
      const rows = page.locator('.data-mapping-row');
      await expect(rows).toHaveCount(12);
      // The guess turns the narrow arrays on, the 3-column t-SNE as the 3D
      // default; the view opens on the UMAP in 2D.
      await expect(page.locator('#data-mapping-disclosure > .disclosure-header-row .disclosure-desc'))
        .toHaveText('5 on · t-SNE scale0 latents 3D · UMAP scale0 latents 2D · guessed');
      // Every array can change its dimension; every editor starts closed.
      await expect(page.locator('.data-mapping-edit')).toHaveCount(12);
      await expect(page.locator('.data-mapping-editor:visible')).toHaveCount(0);
      for (const edit of await page.locator('.data-mapping-edit').all()) {
        await expect(edit).toHaveAttribute('aria-expanded', 'false');
      }
      // A row that is off is one line: no Default, no second line.
      const off = page.locator('.data-mapping-row[data-disabled="true"]');
      await expect(off).toHaveCount(7);
      // An off row has no Default or guessed line; a wide one says only how
      // wide it is.
      await expect(off.locator('.data-mapping-default:visible, .data-mapping-tag:visible')).toHaveCount(0);
      for (const meta of await off.locator('.data-mapping-row-meta:visible').all()) {
        await expect(meta).toHaveText(/^\d[\d,]* columns$/, { useInnerText: true });
      }
      // Add columns lives in the editors, not between the rows.
      await expect(page.locator('#data-mapping-embeddings > .data-mapping-add')).toHaveCount(0);
      expect(await overflow(page)).toEqual({ out: [], sideways: false });

      // Every editor open, every section open: still nothing sticks out, and
      // each editor's axis selects share one line, each under its label.
      for (const edit of await page.locator('.data-mapping-edit').all()) await edit.click();
      await openSections(page);
      expect(await overflow(page)).toEqual({ out: [], sideways: false });
      for (const name of ['coordinates 1,2', 'Spatial', 'UMAP scale1 latents']) {
        const target = row(page, name);
        const boxes = await target.locator('.data-mapping-axis-field:visible').evaluateAll(fields => fields.map(field => {
          const label = field.querySelector('label').getBoundingClientRect();
          const select = field.querySelector('select').getBoundingClientRect();
          return { labelBottom: label.bottom, selectTop: select.top, selectWidth: select.width };
        }));
        expect(boxes.length).toBe(name === 'Spatial' ? 3 : 2);
        for (const box of boxes) {
          expect(box.selectTop).toBeGreaterThanOrEqual(box.labelBottom - 0.5);
          expect(box.selectTop).toBeCloseTo(boxes[0].selectTop, 0);
          expect(box.selectWidth).toBeGreaterThanOrEqual(48);
        }
      }
      expect(errors).toEqual([]);
    });
  });
}

test('every control the panel had is still there and works', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openCrowded(page);
  const status = page.locator('.data-mapping-status');
  const revert = page.locator('#data-mapping-revert');
  const apply = page.locator('#data-mapping-apply');

  // Each disclosure keeps its (i) tip.
  await openSections(page);
  await expect(page.locator('#data-mapping-disclosure > .disclosure-header-row > .info-btn')).toBeVisible();
  for (const section of SECTIONS) {
    await expect(page.locator(`[data-mapping-section="${section}"] > .disclosure-header-row > .info-btn`)).toBeVisible();
  }

  // The guessed defaults are marked, and only the defaults.
  await expect(row(page, 't-SNE scale0 latents').locator('.data-mapping-tag')).toHaveText('guessed');
  await expect(row(page, 'UMAP scale0 latents').locator('.data-mapping-tag')).toHaveText('guessed');
  await expect(page.locator('.data-mapping-tag:visible')).toHaveCount(2);

  // On/off, then Default: a 4-column array is a matrix, not an embedding,
  // and is offered at its first two columns, in 2D.
  const coordinates = row(page, 'coordinates 1,2');
  await coordinates.locator('.data-mapping-enable').check();
  await expect(coordinates.locator('.data-mapping-default')).toBeVisible();
  await expect(coordinates.locator('.data-mapping-default')).toHaveAttribute('aria-pressed', 'false');
  await coordinates.locator('.data-mapping-default').click();
  await expect(coordinates.locator('.data-mapping-default')).toHaveAttribute('aria-pressed', 'true');
  await expect(row(page, 'UMAP scale0 latents').locator('.data-mapping-default')).toHaveAttribute('aria-pressed', 'false');
  // The live view opened on the 2D default, so it follows the new one.
  await expect(status).toHaveText('Apply also switches 1 view to the new default.');

  // The dimension opens the editor; the dimensions offered are the ones the
  // columns allow.
  const dimensions = async target => {
    const edit = target.locator('.data-mapping-edit');
    if ((await edit.getAttribute('aria-expanded')) !== 'true') await edit.click();
    await expect(target.locator('.data-mapping-editor')).toBeVisible();
    return target.locator('.data-mapping-axes option').allTextContents();
  };
  expect(await dimensions(coordinates)).toEqual(['1D', '2D', '3D']);
  expect(await dimensions(row(page, 'Spatial'))).toEqual(['1D', '2D', '3D']);
  expect(await dimensions(row(page, 'UMAP scale1 latents'))).toEqual(['1D', '2D']);
  // Column menus: 1-based labels over 0-based values, one per axis shown.
  await expect(coordinates.locator('.data-mapping-axis-select:visible')).toHaveCount(2);
  await expect(coordinates.locator('select[data-axis="0"] option')).toHaveText(['1', '2', '3', '4']);
  await coordinates.locator('select[data-axis="1"]').selectOption({ value: '3' });
  const coordinates14 = row(page, 'coordinates 1,4');
  await expect(coordinates14).toHaveCount(1);
  await expect(coordinates14.locator('.data-mapping-editor')).toBeVisible();

  // Add columns: only an array wider than three columns has it; the new
  // selection opens its editor, and its remove button takes it away again.
  await expect(row(page, 'Spatial').locator('.data-mapping-add')).toBeHidden();
  await expect(coordinates14.locator('.data-mapping-add')).toHaveText('Add columns');
  await coordinates14.locator('.data-mapping-add').click();
  // It takes the first two columns no selection uses.
  const addedRow = row(page, 'coordinates 2,3');
  await expect(addedRow).toHaveCount(1);
  await expect(addedRow.locator('.data-mapping-enable')).toBeChecked();
  await expect(addedRow.locator('.data-mapping-editor')).toBeVisible();
  await expect(addedRow.locator('.data-mapping-remove')).toBeVisible();
  await expect(page.locator(`#data-mapping-row-${await addedRow.getAttribute('data-row')}`)).toBeFocused();
  await addedRow.locator('.data-mapping-remove').click();
  await expect(page.locator('.data-mapping-row')).toHaveCount(12);

  // The editor closes again, from the keyboard too.
  const spatialEdit = row(page, 'Spatial').locator('.data-mapping-edit');
  await spatialEdit.focus();
  await page.keyboard.press('Enter');
  await expect(spatialEdit).toHaveAttribute('aria-expanded', 'false');
  await expect(row(page, 'Spatial').locator('.data-mapping-editor')).toBeHidden();
  await expect(spatialEdit).toBeFocused();

  // The other groups keep their selects.
  await expect(page.locator('#data-mapping-expression option')).toHaveText(['None', 'X', "layers['counts']"]);
  await page.locator('#data-mapping-expression').selectOption('layer:counts');
  await expect(page.locator('#data-mapping-gene-names')).toHaveValue('index');
  await expect(page.locator('#data-mapping-knn')).toHaveValue('connectivities');
  await page.locator('#data-mapping-knn').selectOption('');
  await expect(page.locator('#data-mapping-latent option').first()).toHaveText('None');
  await page.locator('#data-mapping-latent').selectOption({ index: 1 });
  const vector = page.locator('.data-mapping-vector-input').first();
  await expect(vector).not.toBeChecked();
  await vector.check();
  await expect(page.locator('[data-mapping-section="vectors"] .disclosure-desc')).toHaveText('1 bound');

  // Revert drops every staged choice.
  await expect(revert).toBeEnabled();
  await revert.click();
  await expect(revert).toBeDisabled();
  await expect(apply).toBeDisabled();
  await expect(row(page, 'coordinates 1,2').locator('.data-mapping-enable')).not.toBeChecked();
  await expect(page.locator('#data-mapping-expression')).toHaveValue('X');
  await expect(page.locator('#data-mapping-knn')).toHaveValue('connectivities');
  await expect(page.locator('#data-mapping-latent')).toHaveValue('');
  await expect(page.locator('.data-mapping-vector-input:checked')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a 3-column array in 2D and a 2-column one in 1D: views, highlight, figure and session', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors = collectBrowserErrors(page);
  await openCrowded(page);
  const spatial = row(page, 'Spatial');
  await spatial.locator('.data-mapping-edit').click();
  await spatial.locator('.data-mapping-axes').selectOption('2');
  const spatial2d = row(page, 'Spatial 1,2');
  await expect(spatial2d.locator('.data-mapping-edit')).toHaveText('2D');
  await spatial2d.locator('select[data-axis="1"]').selectOption({ value: '2' });
  const spatial13 = row(page, 'Spatial 1,3');
  await expect(spatial13).toHaveCount(1);
  const umap = row(page, 'UMAP scale1 latents');
  await umap.locator('.data-mapping-edit').click();
  await umap.locator('.data-mapping-axes').selectOption('1');
  const umap1d = row(page, 'UMAP scale1 latents 1');
  await expect(umap1d.locator('.data-mapping-edit')).toHaveText('1D');
  // The only 1D embedding is the 1D default.
  await expect(umap1d.locator('.data-mapping-default')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#data-mapping-apply').click();
  await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
  const mapping = await page.evaluate(() => window._cellucidState.getDataMapping().embeddings);
  expect(mapping.enabled).toContainEqual({ key: 'spatial', columns: [0, 2] });
  expect(mapping.enabled).toContainEqual({ key: 'X_umap_scale1_latents', columns: [0] });
  expect(mapping.defaults['1d']).toEqual({ key: 'X_umap_scale1_latents', columns: [0] });
  // Applied, the edited rows keep their open editors.
  await expect(spatial13.locator('.data-mapping-editor')).toBeVisible();

  // The live view shows the 2D selection of the 3-column array.
  const picker = page.locator('#view-representation-select');
  await picker.selectOption('spatial[0,2]');
  await expect.poll(() => page.evaluate(() => window._cellucidState.getViewLayoutKey('live'))).toBe('spatial[0,2]');
  expect(await page.evaluate(() => window._cellucidState.getViewDimensionLevel('live'))).toBe(2);
  const positions = await page.evaluate(() => Array.from(window._cellucidState.positionsArray));
  expect(positions.every(Number.isFinite)).toBe(true);

  // A second view shows the 1D selection of the 2-column array beside it.
  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('.split-badge')).toHaveCount(2);
  await page.locator('.split-badge').nth(1).locator('.split-badge-select').click();
  await picker.selectOption('X_umap_scale1_latents[0]');
  const ids = await page.evaluate(() => [...window._cellucidState.viewContexts.keys()]);
  await expect.poll(() => page.evaluate(
    viewIds => viewIds.map(id => window._cellucidState.getViewLayoutKey(id)).sort(),
    ids,
  )).toEqual(['X_umap_scale1_latents[0]', 'spatial[0,2]']);
  await expect.poll(async () => (
    await page.locator('.split-badge .split-badge-label').allTextContents()
  ).sort()).toEqual(['Spatial 1,3 · 2D', 'UMAP scale1 latents 1 · 1D']);

  // Highlights belong to cells: both views draw the same 100.
  await page.locator('#categorical-field').selectOption('cell_type');
  // The field loads before its categories can be highlighted.
  await expect.poll(() => page.evaluate(() => window._cellucidState.obsData.fields
    .find(field => field.key === 'cell_type').codes?.length ?? 0)).toBe(300);
  await page.evaluate(() => {
    const state = window._cellucidState;
    const fieldIndex = state.obsData.fields.findIndex(field => field.key === 'cell_type');
    state.addHighlightFromCategory(fieldIndex, 0, 'obs');
  });
  for (const index of [0, 1]) {
    await page.locator('.split-badge').nth(index).locator('.split-badge-select').click();
    await expect.poll(() => page.evaluate(
      () => window._cellucidState.getTotalHighlightedCellCount()
    )).toBe(100);
  }

  // A figure of both views draws both panes.
  await page.locator('#figure-export-section > summary').click();
  await page.getByRole('button', { name: /^Download\b/ }).click();
  await page.getByLabel('Download format').selectOption('svg');
  await page.getByLabel('SVG point strategy').selectOption('full-vector');
  await page.getByLabel(/Export all views/).check();
  const figureDownload = page.waitForEvent('download');
  await page.locator('#figure-export-btn').click();
  const figurePath = testInfo.outputPath('narrow-arrays.svg');
  await (await figureDownload).saveAs(figurePath);
  const svg = await readFile(figurePath, 'utf8');
  expect((svg.match(/<clipPath id=/g) ?? []).length).toBeGreaterThanOrEqual(4);

  // A session restores the mapping and what each view shows.
  const saved = await page.evaluate(() => ({
    embeddings: window._cellucidState.getDataMapping().embeddings,
    layouts: [...window._cellucidState.viewContexts.keys()].map(id => window._cellucidState.getViewLayoutKey(id)),
  }));
  const sessionDownload = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const sessionPath = testInfo.outputPath('narrow-arrays.cellucid-session');
  await (await sessionDownload).saveAs(sessionPath);

  await openCrowded(page);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  await (await chooser).setFiles(sessionPath);
  await expect(page.locator('.split-badge')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => ({
    embeddings: window._cellucidState.getDataMapping().embeddings,
    layouts: [...window._cellucidState.viewContexts.keys()].map(id => window._cellucidState.getViewLayoutKey(id)),
  }))).toEqual(saved);
  await expect(row(page, 'Spatial 1,3').locator('.data-mapping-enable')).toBeChecked();
  await expect(row(page, 'UMAP scale1 latents 1').locator('.data-mapping-edit')).toHaveText('1D');
  expect(errors).toEqual([]);
});

test('a change anywhere in the panel keeps the sidebar where it was and the focus on its control', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openCrowded(page);
  await openSections(page);

  /**
   * Put `locator` in the middle of the sidebar and focus it, as a keyboard
   * user is (WebKit does not focus a control on click), run `act`, then
   * return how far the sidebar scrolled and what holds the focus.
   */
  async function settle(locator, act) {
    await locator.evaluate(element => {
      const scroller = document.querySelector('.sidebar-scroll');
      const box = element.getBoundingClientRect();
      const frame = scroller.getBoundingClientRect();
      scroller.scrollTop += box.top - frame.top - frame.height / 2;
      element.focus({ preventScroll: true });
    });
    const before = await page.evaluate(() => document.querySelector('.sidebar-scroll').scrollTop);
    const focused = await locator.evaluate(element => element === document.activeElement);
    expect(focused).toBe(true);
    await act();
    // Two frames: any late layout or scroll anchoring has happened.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return {
      moved: Math.abs(await page.evaluate(() => document.querySelector('.sidebar-scroll').scrollTop) - before),
      focused: await locator.evaluate(element => element === document.activeElement),
    };
  }

  const steady = { moved: 0, focused: true };
  const expression = page.locator('#data-mapping-expression');
  expect(await settle(expression, () => expression.selectOption('layer:counts'))).toEqual(steady);
  const knn = page.locator('#data-mapping-knn');
  expect(await settle(knn, () => knn.selectOption(''))).toEqual(steady);
  const latent = page.locator('#data-mapping-latent');
  expect(await settle(latent, () => latent.selectOption({ index: 1 }))).toEqual(steady);

  const coordinates = row(page, 'coordinates 1,2');
  const enable = coordinates.locator('.data-mapping-enable');
  expect(await settle(enable, () => page.keyboard.press('Space'))).toEqual(steady);
  await expect(enable).toBeChecked();
  const isDefault = coordinates.locator('.data-mapping-default');
  expect(await settle(isDefault, () => page.keyboard.press('Enter'))).toEqual(steady);
  await expect(isDefault).toHaveAttribute('aria-pressed', 'true');
  const edit = row(page, 'scale1 latents 1,2').locator('.data-mapping-edit');
  expect(await settle(edit, () => page.keyboard.press('Enter'))).toEqual(steady);
  const index = await row(page, 'scale1 latents 1,2').getAttribute('data-row');
  const axis = page.locator(`#data-mapping-row-${index}-y`);
  // The row is renamed by its new columns; the select is the same element.
  expect(await settle(axis, () => axis.selectOption({ value: '5' }))).toEqual(steady);
  await expect(row(page, 'scale1 latents 1,6')).toHaveCount(1);
  const vectorHeader = page.locator('[data-mapping-section="vectors"] .disclosure-header');
  expect(await settle(vectorHeader, () => page.keyboard.press('Enter'))).toEqual(steady);
  expect(errors).toEqual([]);
});
