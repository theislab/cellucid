/**
 * The data-mapping groups beside the embeddings, end to end on a file opened
 * in the browser (`.h5ad` and Zarr ZIP): the neighbour graph (Phase E).
 *
 * Fixture: `data-mapping-full` from `scripts/generate-data-mapping-fixtures.py`
 * (three graphs: `connectivities`, `scvi_connectivities` and an asymmetric
 * `distances`; edge counts from `data-mapping-full.expected.json`).
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { chooseFiles } from './helpers/file-input.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FULL_H5AD = path.join(FIXTURES, 'data-mapping-full.h5ad');
const FULL_ZARR = path.join(FIXTURES, 'data-mapping-full.zarr.zip');
const EXPECTED = JSON.parse(readFileSync(path.join(FIXTURES, 'data-mapping-full.expected.json'), 'utf8'));
const START_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=data-mapping-groups-ci';

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function openFullFixture(page, input, file) {
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await openCollapsedPanels(page);
  await chooseFiles(page.locator(input), file);
  await expect(page.locator('#dataset-name')).toHaveText('data-mapping-full');
  await expect.poll(() => page.evaluate(
    () => window._cellucidState.getMappingCandidates() !== null
  )).toBe(true);
  const header = page.locator('#data-mapping-disclosure > .disclosure-header-row > .disclosure-header');
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  // Arrays that are off and wider than 3 columns, or cannot be drawn, are
  // listed under "Other arrays", collapsed; open it so every row is listed.
  const others = page.locator('#data-mapping-more > .disclosure-header');
  if (await others.isVisible() && (await others.getAttribute('aria-expanded')) !== 'true') await others.click();
  // Every further group is a collapsed disclosure; open them all.
  for (const section of ['genes', 'knn', 'latent', 'vectors']) {
    const groupHeader = page.locator(`[data-mapping-section="${section}"] .disclosure-header`);
    if ((await groupHeader.getAttribute('aria-expanded')) !== 'true') await groupHeader.click();
  }
}

/** The checklist row of one obsm array (any column selection of it). */
function rowOf(page, key) {
  return page.locator('.data-mapping-row').filter({
    // A usable array is titled by its columns; an unusable one by its key.
    has: page.locator(`.data-mapping-name[title^="obsm['${key}']"], .data-mapping-name[title="${key}"]`),
  });
}

const mappingGroup = (page, group) => page.evaluate(
  name => window._cellucidState.getDataMapping()[name],
  group,
);

const edgeCount = page => page.evaluate(() => window._cellucidState.getConnectivityGraphFact()?.edges ?? null);

async function apply(page) {
  await page.locator('#data-mapping-apply').click();
  await expect(page.locator('.data-mapping-status')).not.toHaveText('Loading…');
}

async function findCellPoint(page) {
  const point = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    for (let y = 60; y < 960; y += 6) {
      for (let x = 360; x < 1420; x += 6) {
        if (viewer.pickCellAtScreen(x, y) >= 0) return { x, y };
      }
    }
    return null;
  });
  expect(point).not.toBeNull();
  return point;
}

for (const [format, input, file] of [
  ['H5AD', '#user-data-file-input', FULL_H5AD],
  ['Zarr ZIP', '#user-data-file-input', FULL_ZARR],
]) {
  test.describe(`${format}: the neighbour graph is chosen, redrawn, refused and restored`, () => {
    // Two tests, one dataset load each, so neither runs into the other's
    // time budget on a slow runner; the second restores the session the
    // first saved.
    test.describe.configure({ mode: 'serial' });
    let sessionPath = null;

    test('the neighbour graph is chosen', async ({ page }, testInfo) => {
      const errors = collectBrowserErrors(page);
      await openFullFixture(page, input, file);

      // Every obsp matrix is offered; the file opens with its connectivities.
      const select = page.locator('#data-mapping-knn');
      await expect(select).toHaveValue('connectivities');
      await expect(select.locator('option')).toHaveText([
        'None',
        'connectivities · sparse 300 × 300',
        'distances · sparse 300 × 300',
        'scvi_connectivities · sparse 300 × 300',
      ]);
      // The graph the file opens with is not read at open, so its edges are
      // not counted yet; they are once its edges are read.
      expect(await edgeCount(page)).toBeNull();

      // Edges are shown, then the graph changes under them.
      await page.locator('#toggle-connectivity').check();
      await expect.poll(() => page.evaluate(() => window._cellucidViewer.hasConnectivityData())).toBe(true);
      await expect.poll(() => edgeCount(page)).toBe(EXPECTED.knn.connectivities.n_edges);
      await select.selectOption('scvi_connectivities');
      await expect(page.locator('.data-mapping-status')).toHaveText('Apply replaces the neighbour graph.');
      await apply(page);
      await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
      expect(await mappingGroup(page, 'knn')).toBe('scvi_connectivities');
      expect(await edgeCount(page)).toBe(EXPECTED.knn.scvi_connectivities.n_edges);
      await expect(page.locator('#toggle-connectivity')).toBeChecked();
      await expect.poll(() => page.evaluate(() => window._cellucidViewer.hasConnectivityData())).toBe(true);
      await expect(page.locator('#dataset-connectivity')).toHaveText('1.2K edges');

      // The KNN drag tool reads the new graph on its next use.
      expect(await page.evaluate(() => window._cellucidViewer.isKnnEdgesLoaded())).toBe(false);
      await page.locator('.highlight-mode-btn[data-mode="knn"]').click();
      await expect.poll(() => page.evaluate(() => window._cellucidViewer.isKnnEdgesLoaded())).toBe(true);
      const point = await findCellPoint(page);
      await page.mouse.move(point.x, point.y);
      await page.keyboard.down('Alt');
      await page.mouse.down();
      await page.mouse.up();
      await page.keyboard.up('Alt');

      // A graph that is not symmetric is refused, and stays refused.
      await select.selectOption('distances');
      await apply(page);
      await expect(page.locator('[data-mapping-group="knn"] .data-mapping-row-error'))
        .toHaveText('distances: not symmetric — choose a connectivities matrix.');
      expect(await mappingGroup(page, 'knn')).toBe('scvi_connectivities');
      await expect(select).toHaveValue('scvi_connectivities');
      await expect(select.locator('option[value="distances"]')).toBeDisabled();
      await expect(select.locator('option[value="distances"]'))
        .toHaveText('distances · sparse 300 × 300 · not symmetric — choose a connectivities matrix');

      // The session records the graph (restored by the next test).
      const downloadPromise = page.waitForEvent('download');
      await page.locator('#save-state-btn').click();
      sessionPath = testInfo.outputPath('knn.cellucid-session');
      await (await downloadPromise).saveAs(sessionPath);
      expect(errors).toEqual([]);
    });

    test('a fresh open restores the saved neighbour graph, and None removes it', async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await openFullFixture(page, input, file);
      expect(await mappingGroup(page, 'knn')).toBe('connectivities');
      const chooserPromise = page.waitForEvent('filechooser');
      await page.locator('#load-state-btn').click();
      await (await chooserPromise).setFiles(sessionPath);
      await expect.poll(() => mappingGroup(page, 'knn')).toBe('scvi_connectivities');
      expect(await edgeCount(page)).toBe(EXPECTED.knn.scvi_connectivities.n_edges);

      // None removes the graph: no edges, and the KNN tool says so.
      await page.locator('#data-mapping-knn').selectOption('');
      await apply(page);
      await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
      expect(await mappingGroup(page, 'knn')).toBeNull();
      await expect(page.locator('#connectivity-controls')).toBeHidden();
      await expect(page.locator('#dataset-connectivity')).toHaveText('None');
      expect(errors).toEqual([]);
    });
  });
}

async function colourByGene(page, name) {
  const search = page.locator('#gene-expression-search');
  await search.click();
  await search.fill(name);
  await search.press('Enter');
  await expect.poll(() => page.evaluate(() => {
    const state = window._cellucidState;
    return state.activeFieldSource === 'var'
      ? state.varData.fields[state.activeVarFieldIndex].key
      : null;
  })).toBe(name);
}

const activeGene = page => page.evaluate(() => {
  const state = window._cellucidState;
  if (state.activeFieldSource !== 'var') return null;
  const field = state.varData.fields[state.activeVarFieldIndex];
  return { key: field.key, index: state.activeVarFieldIndex, filter: field._continuousFilter ?? null };
});

for (const [format, input, file] of [
  ['H5AD', '#user-data-file-input', FULL_H5AD],
  ['Zarr ZIP', '#user-data-file-input', FULL_ZARR],
]) {
  test.describe(`${format}: gene names and expression change the gene list, keeping cells and the coloured gene`, () => {
    // Two tests, one dataset load each, so neither runs into the other's
    // time budget on a slow runner; the second restores the session the
    // first saved.
    test.describe.configure({ mode: 'serial' });
    let sessionPath = null;

    test('gene names and expression change the gene list', async ({ page }, testInfo) => {
      const errors = collectBrowserErrors(page);
      await openFullFixture(page, input, file);
      const expression = page.locator('#data-mapping-expression');
      const names = page.locator('#data-mapping-gene-names');
      await expect(expression).toHaveValue('X');
      await expect(expression.locator('option')).toHaveText([
        'None', 'X', "layers['counts']", "layers['log1p']", 'raw.X · 8 genes',
      ]);
      // An Ensembl index with gene_symbols beside it: the symbols name the
      // genes, guessed by content.
      await expect(names).toHaveValue('column:gene_symbols');
      await expect(names.locator('option')).toHaveText([
        'var index',
        'gene_symbols',
        'feature_type',
        'highly_variable · true/false values cannot name genes',
        'dispersions · floating-point values cannot name genes',
      ]);
      // One short line: what was guessed from the file, then the names note.
      const symbolsHint = "Guessed: gene names, highly variable genes. "
        + "1 gene has no 'gene_symbols' value and uses its var index name. "
        + "1 duplicate name was made unique, e.g. 'LYZ' → 'LYZ-1'.";
      await expect(page.locator('[data-mapping-section="genes"] .data-mapping-hint')).toHaveText(symbolsHint);

      // A highlight and a filtered gene colouring are in place.
      await page.evaluate(() => {
        const state = window._cellucidState;
        state.ensureHighlightPage();
        state.addHighlightDirect({ type: 'annotation', label: 'kept', cellIndices: Uint32Array.of(1, 2, 3) });
      });
      await colourByGene(page, 'LYZ');
      const range = await page.evaluate(() => {
        const state = window._cellucidState;
        const stats = state.ensureContinuousMetadata(state.varData.fields[state.activeVarFieldIndex]).stats;
        const min = stats.min + (stats.max - stats.min) * 0.25;
        const max = stats.max;
        state.applyContinuousFilter(null, min, max);
        return { min, max };
      });

      // Ensembl ids instead of symbols: the same gene, now called by its id.
      await names.selectOption('index');
      await expect(page.locator('.data-mapping-status')).toHaveText('Apply keeps each coloured gene it finds and closes analysis windows.');
      await apply(page);
      await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
      expect(await activeGene(page)).toEqual({ key: 'ENSG00000000003', index: 2, filter: range });
      await expect(page.locator('[data-mapping-section="genes"] .data-mapping-hint'))
        .toHaveText("Guessed: highly variable genes. Gene names are identifiers; 'gene_symbols' holds symbols.");

      // Back to the symbols: the same gene again, called LYZ.
      await names.selectOption('column:gene_symbols');
      await apply(page);
      await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
      expect(await activeGene(page)).toEqual({ key: 'LYZ', index: 2, filter: range });
      expect(await page.evaluate(() => window._cellucidState.getDataMapping().geneNames)).toBe('column:gene_symbols');
      await expect(page.locator('[data-mapping-section="genes"] .data-mapping-hint')).toHaveText(symbolsHint);
      expect(await page.evaluate(() => window._cellucidState.getHighlightedCellCount())).toBe(3);

      // raw.X has its own, longer gene list: the gene is found there by name.
      await expression.selectOption('raw');
      await expect(names).toHaveValue('column:gene_symbols');
      await expect(names.locator('option')).toHaveText(['var index', 'gene_symbols']);
      await apply(page);
      await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
      expect((await activeGene(page)).key).toBe('LYZ');
      expect(await page.evaluate(() => window._cellucidState.getVarAxisGeneCount())).toBe(8);
      await expect(page.locator('#dataset-genes')).toHaveText('8');

      // A gene only raw has is dropped, and the panel says so.
      await colourByGene(page, 'PPBP');
      const downloadPromise = page.waitForEvent('download');
      await page.locator('#save-state-btn').click();
      sessionPath = testInfo.outputPath('genes.cellucid-session');
      await (await downloadPromise).saveAs(sessionPath);
      await expression.selectOption('X');
      await apply(page);
      await expect(page.locator('.data-mapping-status')).toHaveText(
        "Applied. 'PPBP' is not on the new gene list; its colouring was removed."
      );
      expect(await activeGene(page)).toBeNull();

      expect(errors).toEqual([]);
    });

    test('a fresh open restores raw.X named by gene_symbols and the coloured gene', async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await openFullFixture(page, input, file);
      const chooserPromise = page.waitForEvent('filechooser');
      await page.locator('#load-state-btn').click();
      await (await chooserPromise).setFiles(sessionPath);
      await expect.poll(() => page.evaluate(() => {
        const mapping = window._cellucidState.getDataMapping();
        return [mapping.expression, mapping.geneNames];
      })).toEqual(['raw', 'column:gene_symbols']);
      await expect.poll(() => activeGene(page).then(gene => gene?.key ?? null)).toBe('PPBP');
      expect(errors).toEqual([]);
    });
  });
}

const activeOutliers = page => page.evaluate(async () => {
  const state = window._cellucidState;
  const field = state.getActiveField();
  if (!field?.outlierQuantiles) return null;
  const bytes = new Uint8Array(
    field.outlierQuantiles.buffer,
    field.outlierQuantiles.byteOffset,
    field.outlierQuantiles.byteLength
  );
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return {
    key: field.key,
    threshold: field._outlierThreshold ?? null,
    sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''),
  };
});

for (const [format, input, file] of [
  ['H5AD', '#user-data-file-input', FULL_H5AD],
  ['Zarr ZIP', '#user-data-file-input', FULL_ZARR],
]) {
  test.describe(`${format}: the latent space of outlier filters is chosen, computed as the server does, and restored`, () => {
    // Two tests, one dataset load each, so neither runs into the other's
    // time budget on a slow runner; the second restores the session the
    // first saved.
    test.describe.configure({ mode: 'serial' });
    let sessionPath = null;

    test('the latent space of outlier filters is chosen', async ({ page }, testInfo) => {
      const errors = collectBrowserErrors(page);
      await openFullFixture(page, input, file);
      const latent = page.locator('#data-mapping-latent');
      const note = page.locator('#outlier-filter-note');
      await expect(latent).toHaveValue('');
      await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
      // No latent space: one button, whose title names the file's candidates.
      await expect(page.locator('#outlier-filter-container')).toBeVisible();
      await expect(page.locator('#outlier-filter')).toBeHidden();
      await expect(note).toBeHidden();
      await expect(page.locator('#outlier-filter-action')).toHaveText('Choose latent space');
      await expect(page.locator('#outlier-filter-action')).toHaveAttribute('title', /X_scVI/);

      await latent.selectOption('X_scVI');
      await expect(page.locator('.data-mapping-status')).toHaveText('Apply measures outliers in the new space.');
      await apply(page);
      await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
      // Applying reads nothing; the control says what the first use reads.
      await expect(page.locator('#outlier-filter')).toBeEnabled();
      await expect(note).toHaveText(/^First use reads X_scVI \(.+\)\.$/);
      expect(await activeOutliers(page)).toBeNull();
      await page.evaluate(() => window._cellucidState.setOutlierThresholdForActive(0.5));
      expect(await activeOutliers(page)).toEqual({
        key: 'cell_type',
        threshold: 0.5,
        sha256: EXPECTED.latent.X_scVI.cell_type,
      });

      // Another space: the filter in use gets new quantiles, the same threshold.
      await latent.selectOption('X_pca');
      await apply(page);
      await expect.poll(() => activeOutliers(page)).toEqual({
        key: 'cell_type',
        threshold: 0.5,
        sha256: EXPECTED.latent.X_pca.cell_type,
      });

      // A space with a NaN is refused when it is read: the control says why,
      // the threshold is back at 100%, and the space is offered no more.
      await latent.selectOption('X_broken');
      await apply(page);
      await expect(note).toHaveText('This latent space cannot be used.');
      await expect(note).toHaveAttribute('title', /NaN at cell 5/);
      await expect(page.locator('#outlier-filter-action')).toHaveText('Choose latent space');
      await expect(latent.locator('option[value="X_broken"]')).toContainText('NaN at cell 5');
      expect(await activeOutliers(page)).toBeNull();
      await expect(page.locator('#outlier-filter')).toHaveValue('100');

      await latent.selectOption('X_pca');
      await apply(page);
      // Left, it is offered no more.
      await expect(latent.locator('option[value="X_broken"]')).toBeDisabled();
      await page.evaluate(() => window._cellucidState.setOutlierThresholdForActive(0.5));
      expect(await activeOutliers(page)).toEqual({
        key: 'cell_type',
        threshold: 0.5,
        sha256: EXPECTED.latent.X_pca.cell_type,
      });

      // The session restores the space and the threshold.
      const downloadPromise = page.waitForEvent('download');
      await page.locator('#save-state-btn').click();
      sessionPath = testInfo.outputPath('latent.cellucid-session');
      await (await downloadPromise).saveAs(sessionPath);
      expect(errors).toEqual([]);
    });

    test('a fresh open restores the latent space and the threshold, and None removes them', async ({ page }) => {
      const errors = collectBrowserErrors(page);
      const latent = page.locator('#data-mapping-latent');
      await openFullFixture(page, input, file);
      const chooserPromise = page.waitForEvent('filechooser');
      await page.locator('#load-state-btn').click();
      await (await chooserPromise).setFiles(sessionPath);
      await expect.poll(() => mappingGroup(page, 'latent')).toBe('X_pca');
      await expect.poll(() => activeOutliers(page)).toEqual({
        key: 'cell_type',
        threshold: 0.5,
        sha256: EXPECTED.latent.X_pca.cell_type,
      });

      // None removes the outlier filter: the control waits for a latent space.
      await latent.selectOption('');
      await apply(page);
      expect(await activeOutliers(page)).toBeNull();
      await expect(page.locator('#outlier-filter')).toBeHidden();
      await expect(page.locator('#outlier-filter-action')).toHaveText('Choose latent space');
      expect(errors).toEqual([]);
    });
  });

  test.describe(`${format}: vector fields are bound per embedding, drawn only where bound, and restored`, () => {
    // Two tests, one dataset load each, so neither runs into the other's
    // time budget on a slow runner; the second restores the session the
    // first saved.
    test.describe.configure({ mode: 'serial' });
    let sessionPath = null;

    test('vector fields are bound per embedding', async ({ page }, testInfo) => {
      const errors = collectBrowserErrors(page);
      await openFullFixture(page, input, file);
      const section = page.locator('[data-mapping-section="vectors"]');
      const box = (embedding, label) => section
        .locator(`fieldset[data-embedding="${embedding}"] .data-mapping-vector-option`, { hasText: label })
        .locator('input');
      // Each vector is bound to the embedding it is named for, as scVelo names
      // them: velocity_umap to X_umap and velocity_tsne to X_tsne.
      await expect(section.locator('fieldset[data-embedding="X_umap"] .data-mapping-vector-option')).toHaveText([
        'velocity_umap suggested',
        'velocity_tsne',
      ]);
      await expect(box('X_umap', 'velocity_umap')).toBeChecked();
      await expect(box('X_tsne', 'velocity_tsne')).toBeChecked();
      await expect(page.locator('#velocity-overlay-controls')).toBeVisible();

      // PCA columns 2 and 3 turned on as the 2D default, with velocity_pca read
      // at the same columns.
      const pca = rowOf(page, 'X_pca');
      await pca.locator('.data-mapping-enable').check();
      await pca.locator('.data-mapping-edit').click();
      await pca.locator('.data-mapping-axes').selectOption('2');
      const index = await pca.getAttribute('data-row');
      await page.locator(`#data-mapping-row-${index}-x`).selectOption({ value: '2' });
      await page.locator(`#data-mapping-row-${index}-y`).selectOption({ value: '3' });
      await rowOf(page, 'X_pca').locator('.data-mapping-default').click();
      await expect(section.locator('fieldset[data-embedding="X_pca[2,3]"]')).toHaveCount(1);
      await box('X_pca[2,3]', 'velocity_pca').check();
      await apply(page);
      await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
      expect(await mappingGroup(page, 'vectorFields')).toEqual([
        { key: 'velocity_pca', embedding: { key: 'X_pca', columns: [2, 3] } },
        { key: 'velocity_tsne', embedding: { key: 'X_tsne', columns: [0, 1] } },
        { key: 'velocity_umap', embedding: { key: 'X_umap', columns: [0, 1] } },
      ]);
      // Each is bound to the embedding it is named for, so all three are the
      // one field `velocity`, drawn over whichever of them a view shows.
      // It is the default field, so it is chosen already: the overlay
      // settings, the field list among them, open once the overlay is on.
      await expect(page.locator('#velocity-field option:not([disabled])')).toHaveText(['velocity']);
      await page.locator('#velocity-overlay-enabled').check();
      await expect(page.locator('#velocity-field')).toBeVisible();
      await expect(page.locator('#velocity-field')).toHaveValue('velocity');
      await expect.poll(() => page.evaluate(
        () => window._cellucidViewer.hasVectorFieldForLayout('velocity', 'X_pca[2,3]')
      )).toBe(true);

      // Unbinding every field hides the overlay and drops its GPU data.
      await box('X_pca[2,3]', 'velocity_pca').uncheck();
      await box('X_tsne', 'velocity_tsne').uncheck();
      await box('X_umap', 'velocity_umap').uncheck();
      await expect(page.locator('.data-mapping-status')).toHaveText('Apply rebinds vector fields; the overlay turns off.');
      const downloadPromise = page.waitForEvent('download');
      await apply(page);
      await expect(page.locator('#velocity-overlay-controls')).toBeHidden();
      expect(await page.evaluate(
        () => window._cellucidViewer.hasVectorFieldForLayout('velocity', 'X_pca[2,3]')
      )).toBe(false);
      await page.locator('#save-state-btn').click();
      sessionPath = testInfo.outputPath('vectors.cellucid-session');
      await (await downloadPromise).saveAs(sessionPath);
      expect(errors).toEqual([]);
    });

    test('a fresh open restores the unbound vector fields', async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await openFullFixture(page, input, file);
      expect((await mappingGroup(page, 'vectorFields')).length).toBe(2);
      const chooserPromise = page.waitForEvent('filechooser');
      await page.locator('#load-state-btn').click();
      await (await chooserPromise).setFiles(sessionPath);
      await expect.poll(() => mappingGroup(page, 'vectorFields')).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}
