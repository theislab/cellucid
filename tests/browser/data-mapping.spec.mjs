/**
 * The data mapping, end to end in a real browser: the Embeddings checklist at
 * the bottom of the Session panel (which `obsm` arrays of an `.h5ad` or Zarr
 * ZIP opened in the browser views can show, and each dimension's default), the
 * best guess for a file without a UMAP, the column picker of a wide array, a
 * different representation per view through the "View N shows" picker, the
 * phone layout, and a session that restores all of it.
 *
 * Fixtures: `scripts/generate-data-mapping-fixtures.py`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL, encodedAppUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const GUESS_H5AD = path.join(FIXTURES, 'data-mapping-guess.h5ad');
const GUESS_ZARR = path.join(FIXTURES, 'data-mapping-guess.zarr.zip');
const WIDE_H5AD = path.join(FIXTURES, 'data-mapping-wide.h5ad');
const MULTI_H5AD = path.join(FIXTURES, 'data-mapping-multi.h5ad');
const START_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}`
  + '&dataset=current-ui-prepared&acceptance=data-mapping-ci';

/** Open one group's disclosure in the Data mapping panel. */
async function openGroup(page, section) {
  const header = page.locator(`[data-mapping-section="${section}"] .disclosure-header`);
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
}

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function openApp(page) {
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');
}

async function openFile(page, input, file, name) {
  await page.locator(input).setInputFiles(file);
  await expect(page.locator('#dataset-name')).toHaveText(name);
  await expect.poll(() => page.evaluate(
    () => window._cellucidState.getMappingCandidates() !== null
  )).toBe(true);
}

/** The default of one dimension slot in the current data mapping. */
function mappingDefault(page, slot) {
  return page.evaluate(
    target => window._cellucidState.getDataMapping().embeddings.defaults[target],
    slot,
  );
}

/** One checklist row, found by the short name it shows. */
function checklistRow(page, name) {
  return page.locator('.data-mapping-row').filter({
    has: page.locator('.data-mapping-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  });
}

/** The selected view and the other one, once a view has been kept. */
function viewIds(page) {
  return page.evaluate(() => {
    const state = window._cellucidState;
    const active = state.getActiveViewId();
    return {
      active,
      other: [...state.viewContexts.keys()].find(id => id !== active),
    };
  });
}

function viewLayout(page, viewId) {
  return page.evaluate(id => window._cellucidState.getViewLayoutKey(id), viewId);
}

const guessNotification = page => page
  .locator('#notification-center .notification')
  .filter({ hasText: 'This file has no default UMAP' });

for (const [format, input, file] of [
  ['H5AD', '#user-data-h5ad-input', GUESS_H5AD],
  ['Zarr ZIP', '#user-data-zarr-archive-input', GUESS_ZARR],
]) {
  test(`a ${format} without a UMAP opens on a best guess, says so, and opens the checklist`, async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await openApp(page);
    await openFile(page, input, file, 'data-mapping-guess');

    // X_umap_old ranks first but holds a NaN, so the guess shows X_tsne.
    expect(await mappingDefault(page, '2d')).toEqual({ key: 'X_tsne', columns: [0, 1] });
    await expect(guessNotification(page)).toContainText(
      "This file has no default UMAP (X_umap_1d, X_umap_2d, X_umap_3d or X_umap). "
        + "Showing 'X_tsne' as 2D. Change it under Session › Data mapping.",
    );

    const header = page.locator('#data-mapping-disclosure .disclosure-header');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#data-mapping-disclosure .disclosure-desc')).toHaveText('2 on · t-SNE 2D · guessed');
    const tsne = checklistRow(page, 't-SNE');
    await expect(tsne.locator('.data-mapping-tag')).toHaveText('guessed');
    await expect(tsne.locator('.data-mapping-tag')).toBeVisible();
    await expect(tsne.locator('.data-mapping-enable')).toBeChecked();
    await expect(tsne.locator('.data-mapping-default')).toHaveAttribute('aria-pressed', 'true');
    // The other narrow array is on beside it; the picker offers both.
    await expect(checklistRow(page, 'ForceAtlas2').locator('.data-mapping-enable')).toBeChecked();
    await expect(page.locator('#view-representation-select')).toHaveValue('X_tsne');
    await expect(page.locator('#view-representation-select option')).toHaveText([
      't-SNE · 2D', 'ForceAtlas2 · 2D',
    ]);
    // Arrays that cannot be drawn are listed, with their reason, and stay off.
    const umapOld = checklistRow(page, 'UMAP old');
    await expect(umapOld.locator('.data-mapping-reason')).toHaveText('NaN at cell 17');
    await expect(umapOld.locator('.data-mapping-enable')).toBeDisabled();
    await expect(umapOld.locator('.data-mapping-enable')).toHaveAttribute('title', 'NaN at cell 17');
    await expect(checklistRow(page, 'obs table').locator('.data-mapping-reason'))
      .toHaveText('obsm table, not an array');
    await expect(checklistRow(page, 'sparse').locator('.data-mapping-enable')).toBeDisabled();
    // A wide array is offered at its first columns, off until turned on.
    await expect(checklistRow(page, 'PCA 1,2,3').locator('.data-mapping-enable')).not.toBeChecked();
    await openGroup(page, 'genes');
    await expect(page.locator('#data-mapping-gene-names')).toHaveValue('index');

    // Show reopens the checklist after it was closed.
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await guessNotification(page).getByRole('button', { name: 'Show' }).click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(guessNotification(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('a wide X_pca is guessed at columns 0 and 1, and a column swap redraws it', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openApp(page);
  await openFile(page, '#user-data-h5ad-input', WIDE_H5AD, 'data-mapping-wide');
  await expect(guessNotification(page)).toContainText("Showing columns 0 and 1 of 'X_pca' as 2D.");
  expect(await viewLayout(page, 'live')).toBe('X_pca[0,1]');
  const pca = checklistRow(page, 'PCA 1,2');
  // The only embedding stays on, and says why.
  await expect(pca.locator('.data-mapping-enable')).toBeDisabled();
  await expect(pca.locator('.data-mapping-enable')).toHaveAttribute('title', 'At least one embedding stays on.');
  // The dimension opens the row's editor: its dimension and a column per axis.
  await expect(pca.locator('.data-mapping-editor')).toBeHidden();
  await pca.locator('.data-mapping-edit').click();
  await expect(pca.locator('.data-mapping-edit')).toHaveAttribute('aria-expanded', 'true');
  await expect(pca.locator('.data-mapping-axes')).toHaveValue('2');
  await expect(page.locator('#data-mapping-row-0-x')).toHaveValue('0');
  await expect(page.locator('#data-mapping-row-0-y')).toHaveValue('1');
  const before = await page.evaluate(() => Array.from(window._cellucidState.positionsArray));

  // Column menus show 1-based numbers over 0-based values, so they are chosen
  // by value. One column on both axes is refused before anything loads.
  await page.locator('#data-mapping-row-0-y').selectOption({ value: '0' });
  await expect(page.locator('.data-mapping-status')).toHaveText('PCA 1,1: Each axis needs a different column.');
  await expect(page.locator('#data-mapping-apply')).toBeDisabled();
  await expect(page.locator('#data-mapping-apply')).toHaveAttribute('title', 'Fix the problem shown above first.');

  await page.locator('#data-mapping-row-0-x').selectOption({ value: '1' });
  await expect(page.locator('#data-mapping-apply')).toBeEnabled();
  // The live view shows the selection being replaced, so it moves.
  await expect(page.locator('.data-mapping-status')).toHaveText('Apply also switches 1 view to the new default.');
  await page.locator('#data-mapping-apply').click();
  await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
  expect(await mappingDefault(page, '2d')).toEqual({ key: 'X_pca', columns: [1, 0] });
  expect(await viewLayout(page, 'live')).toBe('X_pca[1,0]');
  await expect(page.locator('#data-mapping-disclosure .disclosure-desc')).toHaveText('1 on · PCA 2,1 2D');
  await expect(page.locator('.data-mapping-row .data-mapping-tag:visible')).toHaveCount(0);

  // Swapping the columns swaps every cell's coordinates exactly.
  const after = await page.evaluate(() => Array.from(window._cellucidState.positionsArray));
  expect(after.length).toBe(before.length);
  for (let cell = 0; cell < before.length / 2; cell += 37) {
    expect(after[cell * 2]).toBe(before[cell * 2 + 1]);
    expect(after[cell * 2 + 1]).toBe(before[cell * 2]);
  }

  // Revert drops a staged choice without loading anything.
  await page.locator('#data-mapping-row-0-y').selectOption({ value: '5' });
  await expect(page.locator('#data-mapping-revert')).toBeEnabled();
  await page.locator('#data-mapping-revert').click();
  await expect(page.locator('#data-mapping-row-0-y')).toHaveValue('0');
  await expect(page.locator('#data-mapping-revert')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('a grid shows t-SNE beside UMAP, and the velocity overlay follows each view', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openApp(page);
  await openCollapsedPanels(page);
  await openFile(page, '#user-data-h5ad-input', MULTI_H5AD, 'data-mapping-multi');
  // X_umap is the default: nothing is guessed, nothing is announced.
  expect(await mappingDefault(page, '2d')).toEqual({ key: 'X_umap', columns: [0, 1] });
  await expect(guessNotification(page)).toHaveCount(0);

  const picker = page.locator('#view-representation-select');
  await expect(page.locator('#representation-controls')).toBeVisible();
  await expect(page.locator('#view-representation-label')).toHaveText('Shows');
  // The default first, then every other representation that is on.
  await expect(picker.locator('option')).toHaveText(['UMAP · 2D', 't-SNE · 2D']);
  const velocity = page.locator('#velocity-overlay-enabled');
  await expect(velocity).toBeEnabled();

  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('.split-badge')).toHaveCount(2);
  const { active, other } = await viewIds(page);
  // The kept view is selected, and the picker says it edits it.
  await expect(page.locator('#view-representation-label')).toHaveText('View 2 shows');
  await picker.selectOption('X_tsne');
  await expect.poll(() => viewLayout(page, active)).toBe('X_tsne');
  expect(await viewLayout(page, other)).toBe('X_umap');
  await expect(page.locator('.split-badge .split-badge-label')).toHaveText(['UMAP · 2D', 't-SNE · 2D']);

  // The two views share their cells, not their coordinates.
  const [shown, kept] = await page.evaluate(ids => ids.map(id => (
    id === 'live'
      ? Array.from(window._cellucidState.positionsArray.slice(0, 4))
      : Array.from(window._cellucidViewer.getViewPositions(id).slice(0, 4))
  )), [active, other]);
  expect(shown).not.toEqual(kept);

  // Velocity is bound to X_umap, so it is unavailable while this view shows t-SNE.
  await expect(velocity).toBeDisabled();
  await expect(page.locator('#velocity-overlay-info')).toContainText('Vector fields are bound to X_umap');
  await picker.selectOption('X_umap');
  await expect.poll(() => viewLayout(page, active)).toBe('X_umap');
  await expect(velocity).toBeEnabled();
  expect(errors).toEqual([]);
});

test('a session saved with the vector-field controls on one embedding restores on a page showing another', async ({ page }, testInfo) => {
  // The vector-field select lists the fields bound to the embedding the
  // active view shows. A session saved while that view showed t-SNE (no
  // field; the select is empty) was refused by a page whose view showed UMAP
  // ("option is not available in current control velocity-field"), and the
  // other way round the saved field was overwritten when the embedding came
  // back. The controls that follow the embedding are restored after it.
  const errors = collectBrowserErrors(page);
  await openApp(page);
  await openCollapsedPanels(page);
  await openFile(page, '#user-data-h5ad-input', MULTI_H5AD, 'data-mapping-multi');
  const velocity = page.locator('#velocity-overlay-enabled');
  const field = page.locator('#velocity-field');

  // Saved with the overlay on, on UMAP, where velocity_umap_2d is bound.
  await expect(field).toHaveValue('velocity_umap');
  await velocity.check();
  await expect(page.locator('#velocity-overlay-settings')).toBeVisible();
  let downloadPromise = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const onUmap = testInfo.outputPath('vector-field-on-umap.cellucid-session');
  await (await downloadPromise).saveAs(onUmap);

  // Saved with a kept view showing t-SNE as the active view: no field there.
  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('.split-badge')).toHaveCount(2);
  const { active } = await viewIds(page);
  await page.locator('#view-representation-select').selectOption('X_tsne');
  await expect.poll(() => viewLayout(page, active)).toBe('X_tsne');
  await expect(velocity).toBeDisabled();
  await expect(field.locator('option')).toHaveCount(0);
  downloadPromise = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const onTsne = testInfo.outputPath('vector-field-on-tsne.cellucid-session');
  await (await downloadPromise).saveAs(onTsne);

  // A fresh page on UMAP (one field listed) restores the t-SNE session.
  await openApp(page);
  await openCollapsedPanels(page);
  await openFile(page, '#user-data-h5ad-input', MULTI_H5AD, 'data-mapping-multi');
  await expect(field).toHaveValue('velocity_umap');
  let chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  await (await chooserPromise).setFiles(onTsne);
  await expect(page.locator('.split-badge')).toHaveCount(2);
  await expect.poll(() => page.evaluate(
    () => window._cellucidState.getViewLayoutKey(window._cellucidState.getActiveViewId()),
  )).toBe('X_tsne');
  await expect(velocity).toBeDisabled();
  await expect(field.locator('option')).toHaveCount(0);
  await expect(page.locator('.notification-error')).toHaveCount(0);

  // And the same page, its live view turned to t-SNE, restores the UMAP
  // session with its overlay on and its field selected.
  await page.locator('#split-clear-btn').click();
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getSnapshotViews().length)).toBe(0);
  await page.locator('#view-representation-select').selectOption('X_tsne');
  await expect.poll(() => viewLayout(page, 'live')).toBe('X_tsne');
  await expect(field.locator('option')).toHaveCount(0);
  chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  await (await chooserPromise).setFiles(onUmap);
  await expect.poll(() => viewLayout(page, 'live')).toBe('X_umap');
  await expect(field).toHaveValue('velocity_umap');
  await expect(velocity).toBeChecked();
  await expect(page.locator('#velocity-overlay-settings')).toBeVisible();
  await expect(page.locator('.notification-error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a session restores the data mapping and every view’s embedding', async ({ page }, testInfo) => {
  const errors = collectBrowserErrors(page);
  await openApp(page);
  await openCollapsedPanels(page);
  await openFile(page, '#user-data-h5ad-input', MULTI_H5AD, 'data-mapping-multi');

  // The kept view is turned to t-SNE; the live view follows the 2D default.
  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('.split-badge')).toHaveCount(2);
  const { active, other } = await viewIds(page);
  await page.locator('#view-representation-select').selectOption('X_tsne');
  await expect.poll(() => viewLayout(page, active)).toBe('X_tsne');

  // Turn X_pca columns 2 and 3 on as a 2D representation, and make it the default.
  await page.locator('#data-mapping-disclosure .disclosure-header').click();
  const pca = checklistRow(page, 'PCA 1,2,3');
  await pca.locator('.data-mapping-enable').check();
  await pca.locator('.data-mapping-edit').click();
  await pca.locator('.data-mapping-axes').selectOption('2');
  const pca2d = checklistRow(page, 'PCA 1,2');
  await page.locator('#data-mapping-row-0-x').selectOption({ value: '2' });
  await page.locator('#data-mapping-row-0-y').selectOption({ value: '3' });
  const pca34 = checklistRow(page, 'PCA 3,4');
  await expect(pca2d).toHaveCount(0);
  await pca34.locator('.data-mapping-default').click();
  await expect(pca34.locator('.data-mapping-default')).toHaveAttribute('aria-pressed', 'true');
  // Only the live view follows the default; the kept view was turned to t-SNE.
  await expect(page.locator('.data-mapping-status')).toHaveText('Apply also switches 1 view to the new default.');
  await page.locator('#data-mapping-apply').click();
  await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
  expect(await viewLayout(page, other)).toBe('X_pca[2,3]');
  expect(await viewLayout(page, active)).toBe('X_tsne');
  const savedLayouts = await page.evaluate(() => Object.fromEntries(
    [...window._cellucidState.viewContexts.keys()].map(
      id => [id === 'live' ? 'live' : 'kept', window._cellucidState.getViewLayoutKey(id)]
    )
  ));

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const sessionPath = testInfo.outputPath('data-mapping.cellucid-session');
  await (await downloadPromise).saveAs(sessionPath);

  // A fresh page opens the file on its defaults, then restores the session.
  await openApp(page);
  await openCollapsedPanels(page);
  await openFile(page, '#user-data-h5ad-input', MULTI_H5AD, 'data-mapping-multi');
  expect(await mappingDefault(page, '2d')).toEqual({ key: 'X_umap', columns: [0, 1] });
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  await (await chooserPromise).setFiles(sessionPath);

  await expect.poll(() => mappingDefault(page, '2d')).toEqual({ key: 'X_pca', columns: [2, 3] });
  await expect.poll(() => page.evaluate(() => Object.fromEntries(
    [...window._cellucidState.viewContexts.keys()].map(
      id => [id === 'live' ? 'live' : 'kept', window._cellucidState.getViewLayoutKey(id)]
    )
  ))).toEqual(savedLayouts);
  await expect(page.locator('#data-mapping-disclosure .disclosure-desc')).toHaveText('3 on · PCA 3,4 2D');
  expect(errors).toEqual([]);
});

test('a prepared dataset switches between the embeddings it was exported with', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.goto(
    `/?exportsBaseUrl=${encodedAppUrl('/tests/browser/fixtures/demo-custom-exports/')}`
      + '&dataset=synthetic-cell-types-2d&acceptance=data-mapping-export-ci',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Synthetic cell-type islands — 2D');
  expect(await mappingDefault(page, '2d')).toEqual({ key: 'islands', columns: null });

  // Every exported embedding is on, and the gene-name sets it was exported
  // with are offered; graph, expression and latent space are fixed at export.
  await page.locator('#data-mapping-disclosure .disclosure-header').click();
  await expect(page.locator('.data-mapping-row .data-mapping-name')).toHaveText([
    'Island layout',
    'Marker scores',
  ]);
  await expect(page.locator('.data-mapping-row .data-mapping-enable:checked')).toHaveCount(2);
  await expect(page.locator('.data-mapping-row .data-mapping-dim')).toHaveText(['2D', '2D']);
  await openGroup(page, 'genes');
  await expect(page.locator('#data-mapping-expression')).toBeHidden();
  await expect(page.locator('#data-mapping-gene-names option')).toHaveText(['symbol', 'gene_id']);
  await expect(page.locator('#data-mapping-gene-names')).toHaveValue('column:symbol');
  await expect(page.locator('.data-mapping-facts .dataset-info-label')).toHaveText([
    'Vector fields',
  ]);

  // The live view shows the other embedding, and back: no mapping change.
  const picker = page.locator('#view-representation-select');
  await picker.selectOption('marker_scores');
  await expect.poll(() => viewLayout(page, 'live')).toBe('marker_scores');
  await picker.selectOption('islands');
  await expect.poll(() => viewLayout(page, 'live')).toBe('islands');

  // A new default changes no view that was turned to an embedding explicitly.
  await checklistRow(page, 'Marker scores').locator('.data-mapping-default').click();
  await expect(page.locator('.data-mapping-status')).toHaveText('Apply offers these embeddings to every view.');
  await page.locator('#data-mapping-apply').click();
  await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
  expect(await mappingDefault(page, '2d')).toEqual({ key: 'marker_scores', columns: null });
  expect(await viewLayout(page, 'live')).toBe('islands');
  await expect(picker.locator('option')).toHaveText(['Marker scores · 2D', 'Island layout · 2D']);
  await expect(page.locator('#data-mapping-disclosure .disclosure-desc')).toHaveText('2 on · Marker scores 2D');
  // Key 2 now shows the new default first.
  await page.locator('#glcanvas').click({ position: { x: 700, y: 400 } });
  await page.keyboard.press('2');
  await expect.poll(() => viewLayout(page, 'live')).toBe('marker_scores');

  // The other exported name set relabels the same genes: a view coloured by
  // a gene keeps that gene, now under its id, with the same values.
  const activeGene = () => page.evaluate(() => {
    const state = window._cellucidState;
    if (state.activeFieldSource !== 'var') return null;
    const field = state.varData.fields[state.activeVarFieldIndex];
    return { key: field.key, index: state.activeVarFieldIndex, sum: field.values.reduce((a, b) => a + b, 0) };
  });
  const search = page.locator('#gene-expression-search');
  await search.click();
  await search.fill('SYN_MARKER_B');
  await search.press('Enter');
  await expect.poll(() => activeGene().then(gene => gene?.key ?? null)).toBe('SYN_MARKER_B');
  const before = await activeGene();
  await page.locator('#data-mapping-gene-names').selectOption('column:gene_id');
  await page.locator('#data-mapping-apply').click();
  await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
  expect(await activeGene()).toEqual({ ...before, key: 'SYNC000002' });
  expect(await page.evaluate(() => window._cellucidState.getDataMapping().geneNames)).toBe('column:gene_id');
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the guess leaves the plot uncovered, and Show opens the checklist in the menu', async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await openApp(page);
    await page.locator('#sidebar-toggle').click();
    await expect(page.locator('#sidebar')).toHaveClass(/\bhidden\b/);
    await page.locator('#user-data-h5ad-input').setInputFiles(GUESS_H5AD);
    await expect(page.locator('#dataset-name')).toHaveText('data-mapping-guess');
    await expect(guessNotification(page)).toBeVisible();

    // The menu stays closed; only the disclosure is marked open.
    await expect(page.locator('#sidebar')).toHaveClass(/\bhidden\b/);
    await guessNotification(page).getByRole('button', { name: 'Show' }).click();
    await expect(page.locator('#sidebar')).not.toHaveClass(/\bhidden\b/);
    const header = page.locator('#data-mapping-disclosure .disclosure-header');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(checklistRow(page, 't-SNE')).toBeInViewport();

    // A wide array's editor sits on its own lines under its name;
    // Revert and Apply share one row, inside the screen.
    const pca = checklistRow(page, 'PCA 1,2,3');
    await pca.locator('.data-mapping-enable').check();
    await pca.locator('.data-mapping-edit').click();
    const name = await pca.locator('.data-mapping-name').boundingBox();
    const axes = await pca.locator('.data-mapping-axes').boundingBox();
    expect(axes.y).toBeGreaterThan(name.y + name.height - 1);
    const revert = await page.locator('#data-mapping-revert').boundingBox();
    const apply = await page.locator('#data-mapping-apply').boundingBox();
    expect(Math.abs(revert.y - apply.y)).toBeLessThan(2);
    expect(apply.x + apply.width).toBeLessThanOrEqual(390);
    const row = await pca.boundingBox();
    expect(row.x + row.width).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
  });
});
