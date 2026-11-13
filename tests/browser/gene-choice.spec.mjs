/**
 * Every way a gene is chosen in the Gene expression search colors by it or
 * says why not (`app/utils/gene-lookup.js`,
 * `ui/modules/field-selector-gene-expression.js`).
 *
 * Enter colors by a gene id with a dot (`AC058791.1`), a symbol typed in
 * another case, and an Ensembl accession typed with another version than
 * the one listed; a name that is no gene is said. What a choice does while
 * the gene names are read, the open cells grow or the gene list is replaced
 * is held by `tests/gene-choice-contract.test.mjs`.
 *
 * Fixture: a synthetic `.zarr.zip` of 2,400 cells and 40 genes with a
 * `counts` layer, served by a stub host.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { anndataZarrZip, fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { openCollapsedPanels, openSessionSectionsOnLoad } from './helpers/panels.mjs';

test.beforeEach(async ({ page }) => {
  await openSessionSectionsOnLoad(page);
});

const CELLS = 2400;
const NAMED = ['AC058791.1', 'CD3E', 'ENSG00000141510', 'MS4A1', 'ENSG00000168484.12'];
const GENES = [...NAMED, ...Array.from({ length: 35 }, (_, g) => `g${g + 5}`)];
const URL_OF_FILE = `${SAMPLE_ORIGIN}/gene-choice/genes.zarr.zip`;

/** X: `cell % 7 + gene`; the counts layer: `100 + cell % 5 + gene`. */
function dataset() {
  const X = new Float32Array(CELLS * GENES.length);
  const counts = new Float32Array(CELLS * GENES.length);
  for (let cell = 0; cell < CELLS; cell++) {
    for (let gene = 0; gene < GENES.length; gene++) {
      X[cell * GENES.length + gene] = (cell % 7) + gene;
      counts[cell * GENES.length + gene] = 100 + (cell % 5) + gene;
    }
  }
  return anndataZarrZip({
    cells: CELLS,
    genes: GENES,
    X,
    layers: { counts },
    obs: { cluster: { categories: ['a', 'b', 'c'], codes: Int8Array.from({ length: CELLS }, (_, i) => i % 3) } },
    obsm: { X_umap: { data: Float32Array.from({ length: CELLS * 2 }, (_, i) => Math.sin(i * 0.37) * 10), columns: 2 } },
  });
}

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

/** Serve the fixture from a stub host. */
async function serve(page) {
  const bytes = dataset();
  await page.route(URL_OF_FILE, route => fulfillFile(route, bytes));
}

async function open(page, query = '') {
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(URL_OF_FILE)}${query}`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);
  await openCollapsedPanels(page);
}

/** The gene the cells are colored by, with its values read, or null. */
function shownGene(page) {
  return page.evaluate(() => {
    const state = window._cellucidState;
    if (state.activeFieldSource !== 'var') return null;
    const field = state.varData.fields[state.activeVarFieldIndex];
    if (!(field?.values instanceof Float32Array) || field.values.length !== state.pointCount) return null;
    let min = Infinity;
    for (const value of field.values) if (value < min) min = value;
    return { key: field.key, cells: field.values.length, min };
  });
}

async function typeAndEnter(page, text) {
  const search = page.locator('#gene-expression-search');
  await search.click();
  await search.fill(text);
  await search.press('Enter');
}

const geneStatus = page => page.locator('#gene-expression-container [role="status"]');

test('Enter colors by a dotted id, a symbol in any case and an Ensembl accession of another version, and says when a name is no gene', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await serve(page);
  await open(page);
  await expect(page.locator('#gene-expression-search')).toBeEnabled({ timeout: 60_000 });

  for (const [typed, gene] of [
    ['AC058791.1', 'AC058791.1'],
    ['cd3e', 'CD3E'],
    ['ENSG00000141510.17', 'ENSG00000141510'],
    ['ENSG00000168484.3', 'ENSG00000168484.12'],
  ]) {
    await typeAndEnter(page, typed);
    await expect.poll(async () => (await shownGene(page))?.key ?? null, { message: typed }).toBe(gene);
    await expect(page.locator('#gene-expression-search')).toHaveValue(gene);
  }

  await typeAndEnter(page, 'NOTAGENE1');
  await expect(geneStatus(page)).toHaveText('NOTAGENE1 is not a gene in this dataset.');
  await expect(page.locator('#gene-expression-dropdown')).toBeVisible();
  await expect(page.locator('#gene-expression-dropdown .dropdown-no-results')).toContainText('No gene matches');
  // What was shown stays shown.
  expect((await shownGene(page))?.key).toBe('ENSG00000168484.12');
  expect(errors).toEqual([]);
});
