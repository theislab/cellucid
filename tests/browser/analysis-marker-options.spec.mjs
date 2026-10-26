/**
 * Marker genes, end to end on a fixture with a 4-cell and a 9-cell group:
 * small groups skipped with a chip (default), pooled, or tested anyway and
 * flagged; a subset of groups; one group as the reference; the filters and
 * ranking re-applied to the shown statistics without testing again; the
 * all-genes CSV with scanpy's column names; Recompute after a cached run.
 */
import { expect, test } from './helpers/test.mjs';
import { anndataZarrZip, fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET = 'analysis-markers';
const ROOT = appUrl('/tests/browser/fixtures/generated-analysis-markers/');
const GROUPS = ['A', 'B', 'C', 'D', 'tiny', 'small'];
const SIZES = [120, 100, 80, 60, 4, 9];
const CELLS = SIZES.reduce((sum, size) => sum + size, 0);
const GENES = Array.from({ length: 12 }, (_, gene) => `G${gene}`);

/** Gene g marks group floor(g / 2); every other value is low with zeros. */
function fixture() {
  const codes = new Int8Array(CELLS);
  let cell = 0;
  SIZES.forEach((size, group) => { for (let i = 0; i < size; i++) codes[cell++] = group; });
  const X = new Float32Array(CELLS * GENES.length);
  for (let c = 0; c < CELLS; c++) {
    for (let g = 0; g < GENES.length; g++) {
      const marker = Math.floor(g / 2) === codes[c];
      X[c * GENES.length + g] = marker
        ? (c % 5 === 0 ? 0 : 2 + (c % 7) / 4)
        : (c % 3 === 0 ? 0.25 * ((c + g) % 4) : 0);
    }
  }
  return anndataZarrZip({
    cells: CELLS,
    genes: [...GENES],
    X,
    obs: { cluster: { categories: [...GROUPS], codes } },
    obsm: {
      X_umap: { data: Float32Array.from({ length: CELLS * 2 }, (_, i) => Math.sin(i * 0.37) * 4), columns: 2 },
    },
    uns: { cellucid: { schema: 1, id: DATASET, name: 'Marker genes fixture' } },
  });
}

async function serve(page) {
  const bytes = fixture();
  const file = `${DATASET}.zarr.zip`;
  const catalog = JSON.stringify({ schema: 2, default: DATASET, datasets: [{ id: DATASET, path: file }] });
  const prefix = new URL(ROOT).pathname;
  await page.route(`${ROOT}**`, async route => {
    const relative = new URL(route.request().url()).pathname.slice(prefix.length);
    if (relative === 'datasets.json') {
      await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: catalog });
      return;
    }
    if (relative !== file) {
      await route.fulfill({ status: 404, body: `Unexpected fixture request: ${relative}\n` });
      return;
    }
    await fulfillFile(route, bytes);
  });
}

function observeProductErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function openMarkers(page) {
  await serve(page);
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await page.waitForFunction(count => window._comparisonModule?.state?.pointCount === count, CELLS);
  await page.evaluate(() => { document.getElementById('page-analysis-section').open = true; });
  const header = page.locator('#analysis-header-genesPanel');
  await header.scrollIntoViewIfNeeded();
  await header.click();
  const panel = page.locator('#analysis-panel-genesPanel');
  await expect(panel).toBeVisible();
  return panel;
}

/** Set options as the form does (the record merged, then validated). */
function setOptions(page, patch) {
  return page.evaluate(next => {
    const ui = window._comparisonModule.getUI('genesPanel');
    ui._setOptions({ ...ui._options, ...next });
  }, patch);
}

function shown(page) {
  return page.evaluate(() => {
    const result = window._comparisonModule.getUI('genesPanel')._lastResult;
    if (result === null) return null;
    return {
      tested: result.stats.groups.filter(group => group.tested).map(group => String(group.groupName)),
      reference: result.stats.groups.filter(group => group.reference).map(group => String(group.groupName)),
      markers: Object.fromEntries(result.selection.groups
        .filter(entry => entry.group.tested)
        .map(entry => [String(entry.group.groupName), entry.markers.map(marker => marker.gene)])),
      skipped: result.metadata.skippedGroups.map(group => group.name),
      pooled: result.metadata.pooledGroups.map(group => group.name),
      lowN: result.metadata.lowNGroups.map(group => group.name),
      cached: result.metadata.cached === true,
    };
  });
}

async function run(panel) {
  const button = panel.getByRole('button', { name: 'Run marker genes' });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toHaveText('Run');
  await expect(panel.locator('.analysis-result-header')).toBeVisible();
}

test('small groups: skipped and listed by default, pooled, or tested and flagged', async ({ page }) => {
  const errors = observeProductErrors(page);
  const panel = await openMarkers(page);
  await setOptions(page, { groupBy: 'cluster' });
  await run(panel);

  let result = await shown(page);
  expect(result.tested).toEqual(['A', 'B', 'C', 'D']);
  expect(result.skipped.sort()).toEqual(['small', 'tiny']);
  await expect(panel.locator('.analysis-chip', { hasText: '2 skipped' })).toBeVisible();
  // Each tested group's markers are its own two genes, best first.
  expect(result.markers.A.slice(0, 2).sort()).toEqual(['G0', 'G1']);
  expect(result.markers.D.slice(0, 2).sort()).toEqual(['G6', 'G7']);

  // A test option leaves the result stale until Run.
  await setOptions(page, { smallGroups: 'pool' });
  await expect(panel.locator('.analysis-stale-chip')).toBeVisible();
  await run(panel);
  await expect(panel.locator('.analysis-stale-chip')).toHaveCount(0);
  result = await shown(page);
  expect(result.pooled.sort()).toEqual(['small', 'tiny']);
  expect(result.tested).toHaveLength(5);
  await expect(panel.locator('.analysis-chip', { hasText: '2 pooled' })).toBeVisible();

  await setOptions(page, { smallGroups: 'test' });
  await run(panel);
  result = await shown(page);
  // Groups are listed largest first.
  expect(result.tested).toEqual(['A', 'B', 'C', 'D', 'small', 'tiny']);
  expect(result.lowN.sort()).toEqual(['small', 'tiny']);
  await expect(panel.locator('.analysis-chip', { hasText: '2 low n' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a subset against one reference group, then filters re-applied without testing again', async ({ page }) => {
  const errors = observeProductErrors(page);
  const panel = await openMarkers(page);
  await setOptions(page, {
    groupBy: 'cluster',
    compareAgainst: 'group',
    referenceGroup: 'B',
    testGroups: { mode: 'subset', ids: ['A', 'C'] },
  });
  await run(panel);
  let result = await shown(page);
  expect(result.tested).toEqual(['A', 'C']);
  expect(result.reference).toEqual(['B']);
  await expect(panel.locator('.analysis-result-line')).toContainText('2 groups vs B');

  // Display options: the same statistics object, no stale chip, new markers.
  await page.evaluate(() => { window.__markerStats = window._comparisonModule.getUI('genesPanel')._lastResult.stats; });
  await setOptions(page, { direction: 'down', topN: 3 });
  await expect.poll(async () => (await shown(page)).markers.A.length).toBeLessThanOrEqual(3);
  result = await shown(page);
  expect(result.markers.A).not.toContain('G0');
  expect(await page.evaluate(() => window._comparisonModule.getUI('genesPanel')._lastResult.stats === window.__markerStats)).toBe(true);
  await expect(panel.locator('.analysis-stale-chip')).toHaveCount(0);

  // The strictest filters leave nothing: the empty state offers to relax them.
  await panel.locator('.analysis-result-controls').getByRole('button', { name: 'List', exact: true }).click();
  await setOptions(page, { direction: 'up', minLog2FC: 100 });
  await expect(panel.locator('.marker-ranked-preview .empty-state')).toContainText('No genes pass the filters');
  await panel.getByRole('button', { name: 'Relax filters' }).click();
  await expect.poll(async () => (await shown(page)).markers.A.length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('the all-genes CSV uses scanpy names; a cached run offers Recompute', async ({ page }) => {
  const errors = observeProductErrors(page);
  const panel = await openMarkers(page);
  await setOptions(page, { groupBy: 'cluster' });
  await run(panel);

  await panel.getByRole('button', { name: /Expand/ }).click();
  const modal = page.locator('.analysis-modal.open');
  await expect(modal).toBeVisible();
  const download = page.waitForEvent('download');
  await modal.getByRole('button', { name: 'All genes CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^marker_genes_all.*\.csv$/);
  const text = await (await file.createReadStream()).toArray().then(chunks => Buffer.concat(chunks).toString('utf8'));
  const lines = text.trim().split('\n');
  expect(lines[0]).toBe('group,names,scores,logfoldchanges,pvals,pvals_adj,pct_nz_group,pct_nz_reference,auroc,small_group,tested');
  // Every gene of every group, tested or skipped.
  expect(lines).toHaveLength(1 + GROUPS.length * GENES.length);
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);

  // The same run again is answered from memory, and Recompute tests again.
  await run(panel);
  expect((await shown(page)).cached).toBe(true);
  await panel.getByRole('button', { name: 'Recompute' }).click();
  await expect.poll(async () => (await shown(page)).cached).toBe(false);
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the form fits the width, the group picker is a bottom sheet, and a run completes', async ({ page }) => {
    const errors = observeProductErrors(page);
    await serve(page);
    await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await page.waitForFunction(count => window._comparisonModule?.state?.pointCount === count, CELLS);
    if (await page.locator('#sidebar').evaluate(sidebar => sidebar.classList.contains('hidden'))) {
      await page.locator('#sidebar-toggle').click();
    }
    await page.evaluate(() => { document.getElementById('page-analysis-section').open = true; });
    const header = page.locator('#analysis-header-genesPanel');
    await header.scrollIntoViewIfNeeded();
    await header.click();
    const panel = page.locator('#analysis-panel-genesPanel');
    await panel.getByRole('combobox', { name: 'Group by', exact: true }).selectOption('cluster');

    // Every option open: nothing wider than the screen.
    await panel.locator('.analysis-more-options > .disclosure-header').click();
    for (const group of await panel.locator('.analysis-options-group > .disclosure-header-row > .disclosure-header').all()) {
      await group.click();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const overflowing = await panel.evaluate(root => {
      const right = root.getBoundingClientRect().right;
      return [...root.querySelectorAll('*')]
        .filter(element => element.getClientRects().length > 0 && element.getBoundingClientRect().right > right + 1)
        .map(element => element.className || element.localName);
    });
    expect(overflowing).toEqual([]);

    // The group picker opens along the bottom edge, full width.
    const toggle = panel.locator('.group-picker-toggle').first();
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    const sheet = page.locator('.group-picker-panel:popover-open');
    await expect(sheet).toBeVisible();
    const box = await sheet.boundingBox();
    expect(Math.round(box.width)).toBe(390);
    expect(Math.round(box.y + box.height)).toBe(844);
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(sheet).toHaveCount(0);

    await run(panel);
    expect((await shown(page)).tested).toEqual(['A', 'B', 'C', 'D']);
    expect(errors).toEqual([]);
  });
});
