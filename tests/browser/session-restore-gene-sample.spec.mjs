/**
 * A session saved on a gene sample restores to the end. The flow is the one
 * a person takes on an atlas over a slow link: a gene read for a sample of
 * the cells and topped up, another share applied and then every cell again,
 * a highlight and four analyses (their rows closed but the last), Save, a
 * reload, Load. The restore says "Session fully restored." -- a restored
 * result in a closed row is drawn when the row opens, the restore never
 * waits for that -- the color controls are usable afterwards, and a gene
 * picked then is shown. The loaded history is kept in this browser as it is
 * (`app/history/autosave.js`), and a reload offers to continue it.
 *
 * Fixture: a synthetic CSR `.zarr.zip` served over one slow shared link, so
 * genes are read for a stated sample of the cells (`gene-sample.spec.mjs`).
 */

import { readFile } from 'node:fs/promises';

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { anndataZarrZip } from './helpers/anndata-zarr-zip.mjs';
import { openCollapsedPanels, openSessionSectionsOnLoad } from './helpers/panels.mjs';
import { clickSaveSession, clickLoadSession } from './helpers/session-buttons.mjs';

// Cells to open, Genes read for and the data mapping are in the Session
// panel's sections, collapsed by default: open, as a viewer who opened them.
test.beforeEach(async ({ page }) => {
  await openSessionSectionsOnLoad(page);
});

const CELLS = 2400;
const GENES = 1500;
const PER_CELL = 1200;
const LATENCY_MS = 40;
const BYTES_PER_MS = 400;

// The link is this spec's subject, and it is measured (`helpers/device.mjs`
// holds it for every other spec): the answers below are held back so the
// reader measures a slow link, and what it then plans is asserted only as
// far as any slow link gives it (genes for a sample of at least 2 cells and
// fewer than all; a runner that answers later measures a slower link and
// reads them for fewer, never for none or for all). The decoding rate, the
// order time and the opening cost stay held.
test.use({ device: { link: 'measured' } });
const RESTORED = 'Session fully restored.';
const MODES = ['differential', 'genesPanel', 'signature', 'dotplot'];

function atlas() {
  const data = new Float32Array(CELLS * PER_CELL);
  const indices = new Int32Array(CELLS * PER_CELL);
  const indptr = new Int32Array(CELLS + 1);
  for (let cell = 0; cell < CELLS; cell++) {
    for (let j = 0; j < PER_CELL; j++) {
      indices[cell * PER_CELL + j] = (cell + j) % GENES;
      data[cell * PER_CELL + j] = 1 + ((cell * 7 + j) % 13);
    }
    indices.subarray(cell * PER_CELL, (cell + 1) * PER_CELL).sort();
    indptr[cell + 1] = (cell + 1) * PER_CELL;
  }
  return anndataZarrZip({
    cells: CELLS,
    genes: Array.from({ length: GENES }, (_, g) => `g${g}`),
    X: { data, indices, indptr },
    obs: { cluster: { categories: ['a', 'b', 'c', 'd'], codes: Int8Array.from({ length: CELLS }, (_, i) => (i * 7) % 4) } },
    obsm: { X_umap: { data: Float32Array.from({ length: CELLS * 2 }, (_, i) => Math.sin(i) * 10), columns: 2 } },
  });
}

/** The file over one slow shared link, with a version (ETag). */
function serveSlowly(bytes) {
  let free = 0;
  return async route => {
    const request = route.request();
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'ETag, Content-Range, Content-Length',
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
      ETag: '"session-restore-gene-sample-v1"',
    };
    if (request.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...headers, 'Content-Length': String(bytes.length) }, body: '' });
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? '');
    const start = range === null ? 0 : Number(range[1]);
    const end = range === null ? bytes.length - 1 : Math.min(range[2] === '' ? bytes.length - 1 : Number(range[2]), bytes.length - 1);
    const now = performance.now();
    const at = Math.max(now + LATENCY_MS, free) + (end + 1 - start) / BYTES_PER_MS;
    free = at;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, at - performance.now())));
    if (range === null) return route.fulfill({ status: 200, headers, body: bytes });
    return route.fulfill({ status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }, body: bytes.subarray(start, end + 1) });
  };
}

async function recordNotifications(page) {
  await page.addInitScript(() => {
    const published = [];
    window.__publishedNotifications = published;
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('notification') && !published.includes(node)) published.push(node);
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

function messages(page) {
  return page.evaluate(() => window.__publishedNotifications.map(element => element.querySelector('.notification-message')?.textContent.trim() ?? ''));
}

async function chooseGene(page, name) {
  const search = page.locator('#gene-expression-search');
  await search.click();
  await search.fill(name);
  await search.press('Enter');
  await expect.poll(() => page.evaluate(gene => {
    const state = window._cellucidState;
    const field = state.varData?.fields?.[state.activeVarFieldIndex];
    return state.activeFieldSource === 'var' && field?.key === gene && field.loaded === true;
  }, name), { timeout: 120_000 }).toBe(true);
}

async function applyShare(page, percent, cells) {
  await page.locator('#subsample-percent').fill(String(percent));
  await page.locator('#subsample-percent').press('Tab');
  // Apply stays where the pointer found it, every frame it is shown from the
  // click until the dataset is read again and its read line settles (every
  // cell open again, it goes): the Dataset box above keeps its room
  // (`dataset-card.js`): a button that moves under the pointer between its
  // press and its release takes no click.
  await page.evaluate(() => {
    const apply = document.getElementById('subsample-apply');
    const tops = [];
    window.__applyTops = tops;
    const watch = () => {
      if (apply.getClientRects().length > 0) tops.push(apply.getBoundingClientRect().top);
      if (window.__applyTops === tops) requestAnimationFrame(watch);
    };
    watch();
  });
  await page.locator('#subsample-apply').click();
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 120_000 }).toBe(cells);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.startupPhase), { timeout: 120_000 }).toBe('ready');
  await expect(page.locator('#dataset-read')).not.toHaveText(/^Reading…/);
  const tops = await page.evaluate(() => {
    const seen = [...new Set(window.__applyTops)];
    window.__applyTops = null;
    return seen;
  });
  expect(tops, 'Apply did not move').toHaveLength(1);
}

/** Open an analysis in the docked panel with `preset`, press Run, and wait for its result. */
async function runAnalysis(page, modeId, preset, runLabel) {
  await page.evaluate(() => { document.getElementById('page-analysis-section').open = true; });
  await page.evaluate(({ modeId, preset }) => window._comparisonModule.openAnalysis(modeId, preset), { modeId, preset });
  const panel = page.locator(`#analysis-panel-${modeId}`);
  await expect(panel).toBeVisible();
  const button = panel.getByRole('button', { name: runLabel });
  await expect(button).toBeEnabled();
  await page.evaluate(id => { window.__previousResult = window._comparisonModule.getUI(id)._lastResult ?? null; }, modeId);
  await button.click();
  await expect.poll(() => page.evaluate(id => {
    const result = window._comparisonModule.getUI(id)._lastResult;
    return result != null && result !== window.__previousResult;
  }, modeId), { timeout: 120_000 }).toBe(true);
}

test('a session saved on a gene sample after a share round trip restores to the end and leaves the controls usable', async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await recordNotifications(page);
  const url = `${SAMPLE_ORIGIN}/session-restore-gene-sample/atlas.zarr.zip`;
  await page.route(url, serveSlowly(atlas()));
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(url)}`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 120_000 }).toBe(CELLS);
  await expect.poll(() => page.evaluate(() => window._cellucidState.getGeneSample()?.cells ?? null)).not.toBeNull();
  await openCollapsedPanels(page);

  // A gene on the sample, topped up.
  await chooseGene(page, 'g5');
  await expect.poll(() => page.evaluate(() => window._cellucidState.getGeneSampleGrowth()), { timeout: 60_000 }).toBeNull();
  const sample = await page.evaluate(() => window._cellucidState.getGeneSample());
  expect(sample.cells).toBeLessThan(CELLS);

  // Another share, then every cell again.
  await applyShare(page, 10, CELLS / 10);
  await applyShare(page, 100, CELLS);

  // A highlight on its own page, colored by the category.
  const saved = await page.evaluate(async () => {
    const state = window._cellucidState;
    const index = state.obsData.fields.findIndex(field => field.key === 'cluster');
    await state.ensureFieldLoaded(index);
    state.setActiveField(index);
    const created = state.createHighlightPage('walk');
    state.switchToPage(created.id);
    state.addHighlightFromCategory(index, 1, 'obs');
    return { field: state.getActiveField().key, highlighted: state.getTotalHighlightedCellCount(), pageId: created.id };
  });
  expect(saved.highlighted).toBeGreaterThan(0);

  // The analyses a person runs on it, each in the docked panel.
  const sets = [{ name: 'Set 1', genes: ['g1', 'g2', 'g3', 'g4', 'g5'] }];
  await runAnalysis(page, 'differential', { options: { compare: 'categories', field: 'cluster', categoriesA: { mode: 'subset', ids: ['a'] }, categoriesB: { mode: 'subset', ids: ['c'] } } }, 'Run differential expression');
  await runAnalysis(page, 'genesPanel', { options: { groupBy: 'cluster' } }, 'Run marker genes');
  await runAnalysis(page, 'signature', { selectedPages: [saved.pageId], options: { geneSets: sets } }, 'Run gene signature');
  await runAnalysis(page, 'dotplot', { options: { groupBy: 'cluster', geneSets: sets } }, 'Run dot plot');
  delete saved.pageId;

  // Save.
  const downloadPromise = page.waitForEvent('download');
  await clickSaveSession(page);
  const download = await downloadPromise;
  const sessionPath = testInfo.outputPath('gene-sample.cellucid-session');
  await download.saveAs(sessionPath);
  const bytes = await readFile(sessionPath);

  // Reload, Load.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 120_000 }).toBe(CELLS);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.startupPhase), { timeout: 120_000 }).toBe('ready');
  await openCollapsedPanels(page);
  const chooserPromise = page.waitForEvent('filechooser');
  await clickLoadSession(page);
  await (await chooserPromise).setFiles({ name: 'gene-sample.cellucid-session', mimeType: 'application/octet-stream', buffer: bytes });
  await expect.poll(() => messages(page), { timeout: 120_000 }).toContain(RESTORED);
  expect(await page.evaluate(() => ({ field: window._cellucidState.getActiveField()?.key ?? null, highlighted: window._cellucidState.getTotalHighlightedCellCount() }))).toEqual(saved);
  // Every analysis has its result back, the ones in closed rows (nothing
  // drawn there yet) as well as the open one.
  expect(await page.evaluate(ids => ids.filter(id => window._comparisonModule.getUI(id)._lastResult == null), MODES)).toEqual([]);

  // The controls are usable: a gene picked now is shown.
  await expect(page.locator('#categorical-field')).toBeEnabled();
  await chooseGene(page, 'g9');

  // A closed row draws its restored result once it is opened.
  await page.locator('#analysis-header-differential').scrollIntoViewIfNeeded();
  await page.locator('#analysis-header-differential').click();
  await expect(page.locator('#analysis-panel-differential .analysis-result-line')).toBeVisible();

  // The loaded history (with the gene picked since) is kept in this browser,
  // and a reload offers to continue it: reloaded once that is written (a
  // change is written moments after it is made, `app/history/autosave.js`).
  await page.evaluate(() => window._cellucidHistories.flush());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 120_000 }).toBe(CELLS);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.startupPhase), { timeout: 120_000 }).toBe('ready');
  await expect.poll(() => messages(page)).toContainEqual(expect.stringMatching(/^Continue where you left off\?/));
  expect(errors).toEqual([]);
});
