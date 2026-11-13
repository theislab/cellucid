/**
 * A session restores on the cells it was saved on, however they were opened
 * (`data/cell-order-digest.js`): its cell check is taken over the stored
 * coordinates of the cells, each named by its original position, never over
 * the display coordinates, whose frame is the bounds of the cells an
 * embedding was first read for and stays when an opening grows or is cut in
 * place.
 *
 * - Saved after a progressive opening grew in place to its share, the
 *   session restores in a fresh tab where the file opens whole, and in one
 *   where it opens at another share: the restore opens the session's cells,
 *   checks them, and restores its highlight on the same cells.
 *
 * Fixture: a synthetic `.zarr.zip` of 2,400 cells whose UMAP spreads wider
 * on the cells a first view leaves out, so a first view's frame differs from
 * every cell's.
 */

import { readFile } from 'node:fs/promises';

import { closeContextWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { anndataZarrZip, fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { openCollapsedPanels, openSessionSectionsOnLoad } from './helpers/panels.mjs';
import { clickSaveSession, clickLoadSession } from './helpers/session-buttons.mjs';

// Cells to open, Genes read for and the data mapping are in the Session
// panel's sections, collapsed by default: open, as a viewer who opened them.
test.beforeEach(async ({ page }) => {
  await openSessionSectionsOnLoad(page);
});

const CELLS = 2400;
const GENES = 12;
const URL_OF_FILE = `${SAMPLE_ORIGIN}/session-cells-check/cells.zarr.zip`;
const RESTORED = 'Session fully restored.';

function dataset() {
  const indptr = Int32Array.from({ length: CELLS + 1 }, (_, cell) => cell);
  return anndataZarrZip({
    cells: CELLS,
    genes: Array.from({ length: GENES }, (_, g) => `g${g}`),
    X: {
      data: Float32Array.from({ length: CELLS }, (_, cell) => 1 + (cell % 5)),
      indices: Int32Array.from({ length: CELLS }, (_, cell) => cell % GENES),
      indptr,
    },
    obs: { cluster: { categories: ['a', 'b', 'c'], codes: Int8Array.from({ length: CELLS }, (_, i) => (i * 7) % 3) } },
    // Every eleventh cell far out: a first view of a few hundred cells has
    // other bounds than every cell.
    obsm: { X_umap: { data: Float32Array.from({ length: CELLS * 2 }, (_, i) => Math.sin(i * 0.37) * 10 + ((i >> 1) % 11 === 0 ? 40 : 0)), columns: 2 } },
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

/**
 * A tab with the file opened under `query`; a cost of showing a cell (held
 * at 2 ms, the fixture's opening cost) makes the opening progressive.
 */
async function openTab(browser, query, { progressive = false } = {}) {
  const context = await browser.newContext(progressive ? { device: { openingMsPerCell: 2 } } : {});
  const page = await context.newPage();
  const errors = collectBrowserErrors(page);
  await recordNotifications(page);
  const bytes = dataset();
  await page.route(URL_OF_FILE, route => fulfillFile(route, bytes));
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(URL_OF_FILE)}${query}`, { waitUntil: 'domcontentloaded' });
  return { context, page, errors };
}

async function cellsOpen(page, count) {
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount ?? 0), { timeout: 120_000 }).toBe(count);
}

/** Highlight some cells, by original position, and save the session. */
async function highlightAndSave(page, testInfo, name) {
  await page.evaluate(() => {
    const state = window._cellucidState;
    state.ensureHighlightPage();
    state.addHighlightDirect({ type: 'lasso', label: 'picked', cellIndices: Uint32Array.from([0, 3, 17, 250, 999]) });
  });
  const picked = await highlightedOriginals(page);
  const downloadPromise = page.waitForEvent('download');
  await clickSaveSession(page);
  // A save that fails says so at once; the test says why instead of waiting.
  const failed = page.waitForFunction(() => window.__publishedNotifications.some(node => /Failed to save/.test(node.textContent)), null, { timeout: 0 })
    .then(() => { throw new Error('Saving the session failed (see the console).'); });
  failed.catch(() => {});
  const download = await Promise.race([downloadPromise, failed]);
  const path = testInfo.outputPath(name);
  await download.saveAs(path);
  return { bytes: await readFile(path), picked };
}

/** The original positions of the cells of the page's groups, ascending. */
function highlightedOriginals(page) {
  return page.evaluate(() => {
    const state = window._cellucidState;
    const cells = state.getHighlightPages().flatMap(item => item.highlightedGroups.flatMap(group => Array.from(group.cellIndices)));
    return Array.from(state.cellIdentity.toOriginal(Uint32Array.from(cells))).sort((a, b) => a - b);
  });
}

async function loadAndExpectRestored(page, bytes, cells, picked) {
  await openCollapsedPanels(page);
  const chooserPromise = page.waitForEvent('filechooser');
  await clickLoadSession(page);
  await (await chooserPromise).setFiles({ name: 'grown.cellucid-session', mimeType: 'application/octet-stream', buffer: bytes });
  await expect.poll(() => messages(page), { timeout: 120_000 }).toContain(RESTORED);
  expect((await messages(page)).filter(text => /not the one this session was saved on/.test(text))).toEqual([]);
  expect(await page.evaluate(() => window._cellucidState.pointCount)).toBe(cells);
  expect(await highlightedOriginals(page)).toEqual(picked);
}

test('a session saved after a progressive opening grew restores where the file opens whole, and at another share', async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const saved = await openTab(browser, '&cells=2000&sample=uniform&seed=3', { progressive: true });
  await cellsOpen(saved.page, 2000);
  await openCollapsedPanels(saved.page);
  const { bytes, picked } = await highlightAndSave(saved.page, testInfo, 'grown.cellucid-session');
  expect(saved.errors).toEqual([]);
  await closeContextWithApplicationRetirement(saved.context);

  for (const query of ['&cells=100%', '&cells=1200&sample=uniform&seed=3']) {
    const tab = await openTab(browser, query);
    await cellsOpen(tab.page, query === '&cells=100%' ? CELLS : 1200);
    await loadAndExpectRestored(tab.page, bytes, 2000, picked);
    expect(tab.errors).toEqual([]);
    await closeContextWithApplicationRetirement(tab.context);
  }
});
