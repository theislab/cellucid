/**
 * Opening another dataset while the shown one is in use: everything that
 * belongs to the shown cells (connectivity edges, the coloured gene or
 * field, kept views) is retired with it, the new dataset opens, and nothing
 * the old one left behind is read against the new one's cells, fields or
 * genes.
 *
 * Fixtures: `data-mapping-full.h5ad` (300 cells, 6 genes, three graphs) and
 * `byte-order-little-endian.h5ad` (8 cells, 3 genes, one graph).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { chooseFiles } from './helpers/file-input.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const LARGER = path.join(FIXTURES, 'data-mapping-full.h5ad');
const SMALLER = path.join(FIXTURES, 'byte-order-little-endian.h5ad');
const START_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=dataset-switch-owned-state';

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function openFile(page, file, cells) {
  await chooseFiles(page.locator('#user-data-file-input'), file);
  await expect.poll(() => page.evaluate(() => window._cellucidState.pointCount)).toBe(cells);
}

async function openLarger(page) {
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await openCollapsedPanels(page);
  await openFile(page, LARGER, 300);
}

async function showEdges(page) {
  await page.locator('#toggle-connectivity').check();
  await expect(page.locator('#connectivity-sliders')).toBeVisible();
  await expect.poll(() => page.evaluate(
    () => window._cellucidViewer.getEdgeSelectionStatsForView('live')?.shownCount ?? 0
  )).toBeGreaterThan(0);
}

/** The last gene of the larger file: an index the smaller one does not have. */
async function colourByLastGene(page) {
  // A dataset lists its genes after its first view (`areGenesPending`).
  await expect.poll(() => page.evaluate(() => {
    const state = window._cellucidState;
    return !state.areGenesPending() && state.varData.fields.length > 0;
  })).toBe(true);
  return page.evaluate(async () => {
    const state = window._cellucidState;
    const index = state.varData.fields.length - 1;
    await state.ensureVarFieldLoaded(index);
    state.setActiveVarField(index);
    return { index, source: state.activeFieldSource };
  });
}

async function keepView(page) {
  const before = await page.evaluate(() => window._cellucidViewer.getSnapshotViews().length);
  await page.locator('#split-keep-view-btn').click();
  await expect.poll(() => page.evaluate(
    () => window._cellucidViewer.getSnapshotViews().length
  )).toBe(before + 1);
}

/** Two frames, so a renderer error from the switch has a chance to surface. */
async function settleFrames(page) {
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function describeShownDataset(page) {
  return page.evaluate(() => {
    const state = window._cellucidState;
    const viewer = window._cellucidViewer;
    return {
      activeFieldIndex: state.activeFieldIndex,
      activeVarFieldIndex: state.activeVarFieldIndex,
      activeView: state.getActiveViewId(),
      contexts: Array.from(state.viewContexts.keys()),
      edgesChecked: document.getElementById('toggle-connectivity').checked,
      pointCount: state.pointCount,
      rendererPoints: viewer.getPointCount(),
      snapshots: viewer.getSnapshotViews().length,
      errors: [...document.querySelectorAll('.notification-error')]
        .map(node => node.textContent.trim()),
    };
  });
}

test('a dataset opened while edges are shown replaces the one with edges', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openLarger(page);
  await showEdges(page);
  await keepView(page);

  await openFile(page, SMALLER, 8);
  await settleFrames(page);
  expect(await describeShownDataset(page)).toEqual({
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    activeView: 'live',
    contexts: ['live'],
    edgesChecked: false,
    pointCount: 8,
    rendererPoints: 8,
    snapshots: 0,
    errors: [],
  });
  // The new dataset's own graph is read when its edges are turned on.
  await showEdges(page);
  expect(await page.evaluate(
    () => window._cellucidViewer.getEdgeSelectionStatsForView('live').current
  )).toBe(true);
  expect(errors).toEqual([]);
});

test('a dataset opened while a gene colours a kept view and the live view replaces both', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openLarger(page);
  const coloured = await colourByLastGene(page);
  expect(coloured).toEqual({ index: 5, source: 'var' });
  await keepView(page);
  // The kept view is focused; colour it by an obs field so the two views
  // index both inventories.
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect.poll(() => page.evaluate(() => window._cellucidState.activeFieldSource)).toBe('obs');
  await showEdges(page);

  await openFile(page, SMALLER, 8);
  await settleFrames(page);
  expect(await describeShownDataset(page)).toEqual({
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    activeView: 'live',
    contexts: ['live'],
    edgesChecked: false,
    pointCount: 8,
    rendererPoints: 8,
    snapshots: 0,
    errors: [],
  });

  // And back: the larger dataset opens again over the smaller one.
  await colourByLastGene(page);
  await openFile(page, LARGER, 300);
  await settleFrames(page);
  expect((await describeShownDataset(page)).errors).toEqual([]);
  expect(errors).toEqual([]);
});

test('a replaced dataset is released: nothing keeps its cells, fields or genes', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'A forced garbage collection needs the Chrome DevTools Protocol');
  const errors = collectBrowserErrors(page);
  await openLarger(page);
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect.poll(() => page.evaluate(() => window._cellucidState.activeFieldSource)).toBe('obs');
  await colourByLastGene(page);
  await showEdges(page);
  await keepView(page);
  // What the replaced dataset owned: its positions (also sent to the
  // spatial-index worker), a categorical field with its codes, and a gene's
  // values. Weak references only: holding them would keep them alive.
  await page.evaluate(() => {
    const state = window._cellucidState;
    const category = state.obsData.fields.find(field => field.key === 'cell_type');
    const gene = state.varData.fields[state.varData.fields.length - 1];
    window.__replaced = {
      positions: new WeakRef(state.positionsArray),
      category: new WeakRef(category),
      codes: new WeakRef(category.codes),
      gene: new WeakRef(gene),
      geneValues: new WeakRef(gene.values),
    };
  });

  await openFile(page, SMALLER, 8);
  await settleFrames(page);
  const cdp = await page.context().newCDPSession(page);
  await expect.poll(async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    return page.evaluate(() => Object.entries(window.__replaced)
      .filter(([, ref]) => ref.deref() !== undefined)
      .map(([name]) => name));
  }).toEqual([]);
  expect(errors).toEqual([]);
});
