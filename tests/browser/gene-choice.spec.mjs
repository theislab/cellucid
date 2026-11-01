/**
 * Every way a gene is chosen in the Gene expression search colours by it or
 * says why not (`app/utils/gene-lookup.js`,
 * `ui/modules/field-selector-gene-expression.js`).
 *
 * - Enter colours by a gene id with a dot (`AC058791.1`), a symbol typed in
 *   another case, and an Ensembl accession typed with another version than
 *   the one listed; a name that is no gene is said.
 * - Before the gene names are read, the search says so and cannot be typed
 *   in, and a gene chosen from elsewhere (an analysis result) is refused with
 *   the reason; once they are, the gene is chosen.
 * - A gene chosen while the open cells grow (a progressive opening's step,
 *   Apply) is shown on the cells after the change. On the live site, Suo
 *   opened from a link took `AC058791.1` + Enter and showed nothing.
 * - A gene chosen while a slow gene-list read replaces the list (Data
 *   mapping, here the expression matrix) is shown from the list in use. On
 *   `hf:datavil/pbmc3k` the list was replaced while the gene was read (the
 *   values refuted the file's log1p) and the choice was lost.
 *
 * Fixture: a synthetic `.zarr.zip` of 2,400 cells and 40 genes with a
 * `counts` layer, served by a stub host whose answers can be slowed.
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

/**
 * Serve the fixture from a stub host; `host.delayMs` slows every answer
 * from then on, as a slow link does.
 */
async function serve(page) {
  const bytes = dataset();
  const host = { delayMs: 0, slowed: 0 };
  await page.route(URL_OF_FILE, async route => {
    if (host.delayMs > 0) {
      host.slowed += 1;
      await new Promise(resolve => setTimeout(resolve, host.delayMs));
    }
    return fulfillFile(route, bytes);
  });
  return host;
}

async function open(page, query = '') {
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(URL_OF_FILE)}${query}`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);
  await openCollapsedPanels(page);
}

/** The gene the cells are coloured by, with its values read, or null. */
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

test('Enter colours by a dotted id, a symbol in any case and an Ensembl accession of another version, and says when a name is no gene', async ({ page }) => {
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

test('before the gene names are read the search says so, a gene from elsewhere is refused with the reason, and once read the gene is chosen', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  // Hold the gene list's read until the test lets it go.
  await page.addInitScript(() => {
    window.__genesRead = new Promise(resolve => { window.__readGenes = resolve; });
    let state;
    Object.defineProperty(window, '_cellucidState', {
      configurable: true,
      get: () => state,
      set(value) {
        state = value;
        const listPublishedGenes = value.listPublishedGenes;
        value.listPublishedGenes = function held(...args) {
          return window.__genesRead.then(() => listPublishedGenes.apply(this, args));
        };
      },
    });
  });
  await serve(page);
  await open(page);
  const search = page.locator('#gene-expression-search');
  await expect(search).toBeDisabled();
  await expect(search).toHaveAttribute('placeholder', 'Reading gene names…');
  expect(await page.evaluate(() => window._cellucidState.areGenesPending())).toBe(true);
  // An analysis result's "colour by this gene" link.
  const refused = await page.evaluate(() => window._cellucidUi.colorByGene('CD3E').then(() => null, error => error.message));
  expect(refused).toBe('Gene names are still being read: CD3E can be chosen once they are listed.');

  await page.evaluate(() => window.__readGenes());
  await expect(search).toBeEnabled({ timeout: 60_000 });
  await expect(search).toHaveAttribute('placeholder', 'Search genes…');
  await typeAndEnter(page, 'AC058791.1');
  await expect.poll(async () => (await shownGene(page))?.key ?? null).toBe('AC058791.1');
  expect(errors).toEqual([]);
});

test('a gene chosen while the open cells grow is shown on the cells after the change', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectBrowserErrors(page);
  // Hold the reader's reopening of the file at the new cells (the change's
  // read) until the test lets it go: the change is under way meanwhile.
  await page.addInitScript(() => {
    window.__holdReopen = false;
    window.__heldReopen = null;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function postMessage(message, ...rest) {
      if (window.__holdReopen && message?.method === 'open' && message.args?.[0]?.reopen === true) {
        window.__heldReopen = () => Reflect.apply(post, this, [message, ...rest]);
        return undefined;
      }
      return Reflect.apply(post, this, [message, ...rest]);
    };
  });
  await serve(page);
  await open(page, '&cells=1000&sample=uniform&seed=3');
  await expect.poll(() => page.evaluate(() => window._cellucidState.pointCount), { timeout: 60_000 }).toBe(1000);
  await expect(page.locator('#gene-expression-search')).toBeEnabled({ timeout: 60_000 });

  await page.evaluate(() => { window.__holdReopen = true; });
  await page.locator('#subsample-percent').fill(String((100 * 2000) / CELLS));
  await page.locator('#subsample-method').selectOption('uniform');
  await page.locator('#subsample-seed').fill('3');
  await page.locator('#subsample-apply').click();
  await expect.poll(() => page.evaluate(() => typeof window.__heldReopen === 'function')).toBe(true);

  // A gene choice holds the field menus until its gene is shown
  // (`onBusyChanged`): taken, it waits for the change, which cannot end while
  // its read is held, and is not shown on the cells it is replacing.
  const fieldMenu = page.locator('#categorical-field');
  await expect(fieldMenu).toBeEnabled();
  await typeAndEnter(page, 'AC058791.1');
  await expect(page.locator('#gene-expression-search')).toHaveValue('AC058791.1');
  await expect(fieldMenu).toBeDisabled();
  expect(await shownGene(page)).toBeNull();

  await page.evaluate(() => { window.__holdReopen = false; window.__heldReopen(); });
  await expect.poll(() => page.evaluate(() => window._cellucidState.pointCount), { timeout: 60_000 }).toBe(2000);
  await expect.poll(async () => shownGene(page), { timeout: 60_000 }).toEqual({ key: 'AC058791.1', cells: 2000, min: 0 });
  await expect(page.locator('#gene-expression-search')).toHaveValue('AC058791.1');
  expect(errors).toEqual([]);
});

test('a gene chosen while a slow gene-list read replaces the list is shown from the list in use', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectBrowserErrors(page);
  const host = await serve(page);
  await open(page);
  await expect(page.locator('#gene-expression-search')).toBeEnabled({ timeout: 60_000 });

  // The order the pbmc3k case took, made certain: the gene's read on the
  // list being replaced starts, then the new list (read slowly) is
  // published, then that read ends.
  await page.evaluate(() => {
    const state = window._cellucidState;
    let geneReadStarted;
    const started = new Promise(resolve => { geneReadStarted = resolve; });
    let release;
    const replaced = new Promise(resolve => { release = resolve; });
    state.on('var-axis:changed', () => release());
    const loader = state.varFieldLoader;
    state.varFieldLoader = new Proxy(loader, {
      apply: (target, self, args) => {
        geneReadStarted();
        return replaced.then(() => Reflect.apply(target, self, args));
      },
    });
    const stage = state.stageVarAxisReplacement;
    state.stageVarAxisReplacement = function slowNames(...args) {
      return started.then(() => stage.apply(this, args));
    };
  });
  // The link slows; the expression matrix changes to the counts layer, whose
  // gene list is read again over it.
  host.delayMs = 400;
  await page.evaluate(() => {
    const state = window._cellucidState;
    window.__mapping = state.applyDataMapping({ ...state.getDataMapping(), expression: 'layer:counts' }, { origin: 'user' })
      .then(() => 'applied', error => `failed: ${error.message}`);
  });
  await typeAndEnter(page, 'MS4A1');
  await expect(page.locator('#gene-expression-search')).toHaveValue('MS4A1');
  expect(await page.evaluate(() => window.__mapping)).toBe('applied');
  // The new list is published while the gene is read: the search still
  // names it (it used to empty).
  expect(await page.locator('#gene-expression-search').inputValue()).toBe('MS4A1');
  host.delayMs = 0;
  // Shown, read from the counts layer (100 + cell % 5 + 3 at least).
  await expect.poll(async () => shownGene(page), { timeout: 60_000 }).toEqual({ key: 'MS4A1', cells: CELLS, min: 103 });
  await expect(page.locator('#gene-expression-search')).toHaveValue('MS4A1');
  expect(errors).toEqual([]);
});
