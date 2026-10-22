/**
 * The data mapping of an AnnData file served by a real `cellucid serve`: the
 * viewer reads the server's candidate catalog, plots any obsm array the
 * server reads on request (`_cellucid/mapping/embeddings/...`), and a choice
 * the server refuses at load time (HTTP 422) is marked unusable with the
 * server's reason while the previous mapping stays.
 *
 * Nothing is stubbed: each test starts `cellucid serve` on a
 * fixture from `scripts/generate-data-mapping-fixtures.py`. Set
 * CELLUCID_PYTHON to an interpreter that has cellucid's dependencies; without
 * it the file is skipped, as the other live-server specs are without their
 * servers. The server runs the cellucid-python checkout beside this repository
 * (or CELLUCID_PYTHON_ROOT), never whichever `cellucid` the interpreter has
 * installed, so the spec exercises the code it is paired with.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { APP_ORIGIN, APP_PORT, ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const PYTHON = process.env.CELLUCID_PYTHON ?? null;
const PYTHON_SOURCE = path.join(
  process.env.CELLUCID_PYTHON_ROOT
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cellucid-python'),
  'src',
);
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
// One port per fixture, offset from the application's own so a moved run
// moves these too.
const SERVED_PORTS = Object.freeze({
  'data-mapping-guess.h5ad': APP_PORT + 2101,
  'data-mapping-multi.h5ad': APP_PORT + 2102,
  'data-mapping-full.h5ad': APP_PORT + 2103,
});

test.skip(PYTHON === null, 'CELLUCID_PYTHON names no interpreter for cellucid serve');

async function waitForHealth(url, child) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`cellucid serve exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${url}/_cellucid/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`cellucid serve did not answer on ${url}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/**
 * Start `cellucid serve` on one fixture for the duration of one test.
 *
 * @returns {Promise<{url: string, stop: () => Promise<void>}>}
 */
async function serve(fixture) {
  const port = SERVED_PORTS[fixture];
  // The `cellucid` console script, run through the named interpreter.
  const child = spawn(PYTHON, [
    '-c', 'import sys; from cellucid.cli import main; sys.exit(main(sys.argv[1:]))',
    'serve', path.join(FIXTURES, fixture),
    '--dataset-name', fixture.replace(/\.h5ad$/, ''),
    '--dataset-id', fixture.replace(/\.h5ad$/, ''),
    '--port', String(port),
    '--host', '127.0.0.1',
    '--no-browser',
    '--no-web-ui',
  ], {
    env: {
      ...process.env,
      PYTHONPATH: [PYTHON_SOURCE, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(url, child);
  } catch (error) {
    child.kill('SIGTERM');
    throw new Error(`${error.message}\n${output}`);
  }
  return {
    url,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    },
  };
}

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function openServed(page, server) {
  const url = new URL('/', APP_ORIGIN);
  url.searchParams.set('source', 'remote');
  url.searchParams.set('remote', server.url);
  url.searchParams.set('anndata', 'true');
  await page.goto(`${url.toString()}&exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}`, {
    waitUntil: 'domcontentloaded',
  });
  // A startup intent that names a source opens no welcome dialog.
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expect.poll(() => page.evaluate(
    () => window._cellucidState?.getMappingCandidates?.() ?? null
  ), { timeout: 60_000 }).not.toBeNull();
  await openCollapsedPanels(page);
}

function mappingSlot(page, slot) {
  return page.evaluate(
    target => window._cellucidState.getDataMapping().embeddings.defaults[target],
    slot,
  );
}

async function revealPanel(page) {
  const header = page.locator('#data-mapping-disclosure .disclosure-header');
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
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

test('a served file plots another obsm array, at chosen columns, from the server', async ({ page }) => {
  const server = await serve('data-mapping-multi.h5ad');
  try {
    const errors = collectBrowserErrors(page);
    await openServed(page, server);
    expect(await mappingSlot(page, '2d')).toEqual({ key: 'X_umap', columns: [0, 1] });
    await revealPanel(page);

    // Routes address the catalog by position, never by key.
    const pca = await page.evaluate(() => window._cellucidState
      .getMappingCandidates().obsm.findIndex(item => item.key === 'X_pca'));
    const embeddingRoute = page.waitForResponse(
      response => response.url() === `${server.url}/_cellucid/mapping/embeddings/${pca}/3-1.bin`,
    );
    const row = rowOf(page, 'X_pca');
    await row.locator('.data-mapping-enable').check();
    await row.locator('.data-mapping-edit').click();
    await row.locator('.data-mapping-axes').selectOption('2');
    const index = await row.getAttribute('data-row');
    await page.locator(`#data-mapping-row-${index}-x`).selectOption({ value: '3' });
    await page.locator(`#data-mapping-row-${index}-y`).selectOption({ value: '1' });
    await rowOf(page, 'X_pca').locator('.data-mapping-default').click();
    await page.locator('#data-mapping-apply').click();
    await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
    expect((await embeddingRoute).status()).toBe(200);
    expect(await mappingSlot(page, '2d')).toEqual({ key: 'X_pca', columns: [3, 1] });
    expect(await page.evaluate(() => window._cellucidState.getViewLayoutKey('live'))).toBe('X_pca[3,1]');

    // Centroid labels of the mapped layout come from its positions, as for a
    // file read in the browser.
    await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
    await expect.poll(() => page.evaluate(() => {
      const field = window._cellucidState.obsData.fields.find(entry => entry.key === 'cell_type');
      return field.centroidsByLayout?.get('X_pca[3,1]')?.length ?? 0;
    })).toBe(3);
    expect(errors).toEqual([]);
  } finally {
    await server.stop();
  }
});

test('a served guess lists the array it refused, as the browser does', async ({ page }) => {
  const server = await serve('data-mapping-guess.h5ad');
  try {
    await openServed(page, server);
    // The server guessed past X_umap_old (NaN at cell 17) to X_tsne.
    expect(await mappingSlot(page, '2d')).toEqual({ key: 'X_tsne', columns: [0, 1] });
    await revealPanel(page);
    await expect(rowOf(page, 'X_tsne').locator('.data-mapping-tag')).toHaveText('guessed');
    const old = rowOf(page, 'X_umap_old');
    await expect(old.locator('.data-mapping-reason')).toHaveText('NaN at cell 17');
    await expect(old.locator('.data-mapping-enable')).toBeDisabled();
  } finally {
    await server.stop();
  }
});

test('a served array the server refuses at load time stays unusable, with its reason', async ({ page }) => {
  const server = await serve('data-mapping-full.h5ad');
  try {
    const errors = collectBrowserErrors(page);
    await openServed(page, server);
    expect(await mappingSlot(page, '2d')).toEqual({ key: 'X_umap', columns: [0, 1] });
    await revealPanel(page);
    const refused = page.waitForResponse(
      response => response.url().startsWith(`${server.url}/_cellucid/mapping/embeddings/`)
        && response.status() === 422,
    );
    const broken = rowOf(page, 'X_broken');
    await broken.locator('.data-mapping-enable').check();
    await broken.locator('.data-mapping-default').click();
    await page.locator('#data-mapping-apply').click();
    const body = await (await refused).json();
    expect(body.key).toBe('X_broken');
    expect(body.reason).toBe('NaN at cell 5');
    // The same words a file read in the browser gives.
    await expect(page.locator('.data-mapping-status')).toContainText('NaN at cell 5');
    // The previous mapping stays, and the array is now listed with the reason.
    expect(await mappingSlot(page, '2d')).toEqual({ key: 'X_umap', columns: [0, 1] });
    await expect(rowOf(page, 'X_broken').locator('.data-mapping-reason')).toHaveText('NaN at cell 5');
    await expect(rowOf(page, 'X_broken').locator('.data-mapping-enable')).toBeDisabled();
    // A refused choice is not a page error. (The browser itself logs the
    // failed request line for the 422.)
    expect(errors.filter(line => !/status of 422/.test(line))).toEqual([]);
  } finally {
    await server.stop();
  }
});

test('a served file switches its neighbour graph, and the server refuses an asymmetric one', async ({ page }) => {
  const server = await serve('data-mapping-full.h5ad');
  try {
    const errors = collectBrowserErrors(page);
    await openServed(page, server);
    // cellucid serve starts without a graph unless --knn names one.
    expect(await page.evaluate(() => window._cellucidState.getDataMapping().knn)).toBeNull();
    await revealPanel(page);
    const select = page.locator('#data-mapping-knn');
    await expect(select).toHaveValue('');
    const graphs = await page.evaluate(() => window._cellucidState.getMappingCandidates().obsp.map(item => item.key));
    const manifestRoute = page.waitForResponse(
      response => response.url()
        === `${server.url}/_cellucid/mapping/knn/${graphs.indexOf('scvi_connectivities')}/connectivity_manifest.json`,
    );
    await select.selectOption('scvi_connectivities');
    await page.locator('#data-mapping-apply').click();
    await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
    expect((await manifestRoute).status()).toBe(200);
    expect(await page.evaluate(() => window._cellucidState.getConnectivityEdgeCount())).toBe(1178);
    await expect(page.locator('#connectivity-controls')).toBeVisible();
    await page.locator('#toggle-connectivity').check();
    await expect.poll(() => page.evaluate(() => window._cellucidViewer.hasConnectivityData())).toBe(true);

    const refused = page.waitForResponse(
      response => response.url().startsWith(`${server.url}/_cellucid/mapping/knn/`) && response.status() === 422,
    );
    await select.selectOption('distances');
    await page.locator('#data-mapping-apply').click();
    expect((await (await refused).json()).reason).toBe('not symmetric — choose a connectivities matrix');
    await expect(page.locator('[data-mapping-group="knn"] .data-mapping-row-error'))
      .toHaveText('distances: not symmetric — choose a connectivities matrix.');
    expect(await page.evaluate(() => window._cellucidState.getDataMapping().knn)).toBe('scvi_connectivities');
    expect(errors.filter(line => !/status of 422/.test(line))).toEqual([]);
  } finally {
    await server.stop();
  }
});

test('a served file switches gene names and expression, reading genes from the server', async ({ page }) => {
  const server = await serve('data-mapping-full.h5ad');
  try {
    const errors = collectBrowserErrors(page);
    await openServed(page, server);
    await revealPanel(page);
    const expression = page.locator('#data-mapping-expression');
    const names = page.locator('#data-mapping-gene-names');
    await expect(expression).toHaveValue('X');
    await expect(names).toHaveValue('index');
    // The server's catalog refuses the same columns the browser does.
    await expect(names.locator('option')).toHaveText([
      'var index',
      'gene_symbols',
      'feature_type',
      'highly_variable · true/false values cannot name genes',
      'dispersions · floating-point values cannot name genes',
    ]);
    const columns = await page.evaluate(() => {
      const candidates = window._cellucidState.getMappingCandidates();
      return {
        var: candidates.var.columns.map(column => column.key),
        raw: candidates.raw.var.columns.map(column => column.key),
      };
    });

    const search = page.locator('#gene-expression-search');
    await search.click();
    await search.fill('ENSG00000000003');
    await search.press('Enter');
    await expect.poll(() => page.evaluate(() => {
      const state = window._cellucidState;
      return state.activeFieldSource === 'var' ? state.varData.fields[state.activeVarFieldIndex].key : null;
    })).toBe('ENSG00000000003');

    // Symbols: the server lists the same gene list under other names; the
    // coloured gene keeps its column, so nothing else is read.
    const symbols = page.waitForResponse(
      response => response.url()
        === `${server.url}/_cellucid/mapping/genes/X/column-${columns.var.indexOf('gene_symbols')}/var_manifest.json`,
    );
    await names.selectOption('column:gene_symbols');
    await page.locator('#data-mapping-apply').click();
    await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
    expect((await symbols).status()).toBe(200);
    const gene = () => page.evaluate(() => {
      const state = window._cellucidState;
      if (state.activeFieldSource !== 'var') return null;
      return { key: state.varData.fields[state.activeVarFieldIndex].key, index: state.activeVarFieldIndex };
    });
    expect(await gene()).toEqual({ key: 'LYZ', index: 2 });

    // raw.X: another axis, so the gene is found by name and its values are
    // read from the server's raw matrix.
    const rawValues = page.waitForResponse(
      response => response.url().startsWith(
        `${server.url}/_cellucid/mapping/genes/raw/column-${columns.raw.indexOf('gene_symbols')}/var/`,
      ) && response.url().endsWith('.values.f32'),
    );
    await expression.selectOption('raw');
    await page.locator('#data-mapping-apply').click();
    await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
    expect((await rawValues).status()).toBe(200);
    expect((await gene()).key).toBe('LYZ');
    expect(await page.evaluate(() => window._cellucidState.getVarAxisGeneCount())).toBe(8);
    expect(await page.evaluate(() => window._cellucidState.getDataMapping().expression)).toBe('raw');
    expect(errors).toEqual([]);
  } finally {
    await server.stop();
  }
});

test('a served file computes outliers in a chosen latent space and binds a vector field on request', async ({ page }) => {
  const server = await serve('data-mapping-full.h5ad');
  try {
    const errors = collectBrowserErrors(page);
    await openServed(page, server);
    await revealPanel(page);
    // cellucid serve binds no vector field unless --vector-fields asks.
    expect(await page.evaluate(() => window._cellucidState.getDataMapping().vectorFields)).toEqual([]);
    await page.locator('#categorical-field').selectOption({ label: 'cell_type' });

    const outliers = page.waitForResponse(
      response => /\/_cellucid\/mapping\/latent\/\d+\/obs\/\d+\.outliers\.f32$/.test(response.url()),
    );
    await page.locator('#data-mapping-latent').selectOption('X_scVI');
    await page.locator('#data-mapping-apply').click();
    await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
    expect((await outliers).status()).toBe(200);
    await expect(page.locator('#outlier-filter-container')).toBeVisible();

    const box = page.locator(
      '[data-mapping-section="vectors"] fieldset[data-embedding="X_umap"] .data-mapping-vector-option',
      { hasText: 'velocity_umap_2d' },
    ).locator('input');
    await box.check();
    await page.locator('#data-mapping-apply').click();
    await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
    const vectors = page.waitForResponse(
      response => /\/_cellucid\/mapping\/vectors\/\d+\/0-1\/\d+\/0-1\.bin$/.test(response.url()),
    );
    await page.locator('#velocity-overlay-enabled').check();
    expect((await vectors).status()).toBe(200);
    await expect.poll(() => page.evaluate(
      () => window._cellucidViewer.hasVectorFieldForLayout('velocity_umap', 'X_umap')
    )).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await server.stop();
  }
});
