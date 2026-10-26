/**
 * Several representations at once, end to end in a real browser: two 3D and
 * two 2D embeddings of one `.h5ad` (fixture: `data-mapping-representations`,
 * 12,000 cells, see `scripts/generate-data-mapping-fixtures.py`), shown in any
 * mix of views.
 *
 * - Every view navigates by its own dimension: a 3D view keeps orbiting
 *   beside a 2D one, and focus carries each view's own mode (the "camera stuck
 *   to planar" reproduction: with linked cameras, one global mode used to be
 *   shared by a 3D and a 2D view).
 * - Link cameras links only views of one representation.
 * - Four live views of four representations each pick, highlight, build LOD,
 *   draw their own centroid labels, export, and survive a session round trip.
 * - Keys 1, 2 and 3 step through a dimension's representations and say so.
 * - The checklist turns a column selection of a wide array on as a 3D
 *   representation.
 * - An allocation failure while loading a representation releases what no
 *   view shows and succeeds on the retry; a GPU allocation failure releases
 *   the geometry kept for unshown representations.
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
const REPRESENTATIONS_H5AD = path.join(FIXTURES, 'data-mapping-representations.h5ad');
const START_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=multi-representation-ci';

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function openRepresentations(page) {
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await openCollapsedPanels(page);
  await chooseFiles(page.locator('#user-data-file-input'), REPRESENTATIONS_H5AD);
  await expect(page.locator('#dataset-name')).toHaveText('data-mapping-representations');
  await expect.poll(() => page.evaluate(
    () => window._cellucidState.getEnabledRepresentations().length
  )).toBe(4);
}

/** layoutKey of the enabled representation named `name` in `dimension`. */
function layoutOf(page, name, dimension) {
  return page.evaluate(({ name, dimension }) => {
    const found = window._cellucidState.getEnabledRepresentations()
      .find(item => item.name === name && item.dimension === dimension);
    return found?.layoutKey ?? null;
  }, { name, dimension });
}

function viewIds(page) {
  return page.evaluate(() => [...window._cellucidState.viewContexts.keys()]);
}

function shows(page, viewId) {
  return page.evaluate(id => window._cellucidState.getViewLayoutKey(id), viewId);
}

function modeOf(page, viewId) {
  return page.evaluate(id => window._cellucidViewer.getViewNavigationMode(id), viewId);
}

async function keepView(page, count) {
  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('.split-badge')).toHaveCount(count);
}

/** Select row `index` (1-based) and show `layoutKey` in it with the picker. */
async function showInRow(page, index, layoutKey) {
  await page.locator('.split-badge').nth(index - 1).locator('.split-badge-select').click();
  await expect(page.locator('#view-representation-label')).toHaveText(`View ${index} shows`);
  await page.locator('#view-representation-select').selectOption(layoutKey);
  const viewId = await page.evaluate(() => window._cellucidState.getActiveViewId());
  await expect.poll(() => shows(page, viewId)).toBe(layoutKey);
  return viewId;
}

async function frames(page, count = 3) {
  await page.evaluate(count => new Promise(resolve => {
    const step = () => (count-- <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  }), count);
}

test('a 3D view keeps orbiting beside a 2D view, and focus carries each view’s own mode', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectBrowserErrors(page);
  await openRepresentations(page);
  const umap3d = await layoutOf(page, 'UMAP', 3);
  const tsne = await layoutOf(page, 't-SNE', 2);
  expect(await shows(page, 'live')).toBe(umap3d);
  expect(await modeOf(page, 'live')).toBe('orbit');

  // One view: 3D -> 2D -> 3D follows the dimension each time.
  await page.locator('#view-representation-select').selectOption(tsne);
  await expect.poll(() => modeOf(page, 'live')).toBe('planar');
  await page.locator('#view-representation-select').selectOption(umap3d);
  await expect.poll(() => modeOf(page, 'live')).toBe('orbit');

  // Two views, linked cameras on (the default): the kept view turns 2D.
  expect(await page.evaluate(() => window._cellucidViewer.getCamerasLocked())).toBe(true);
  await keepView(page, 2);
  const kept = await showInRow(page, 2, tsne);
  await expect.poll(() => modeOf(page, kept)).toBe('planar');
  expect(await modeOf(page, 'live')).toBe('orbit');
  // Cameras of a 3D and a 2D view cannot be linked: the button says why.
  await expect(page.locator('#camera-lock-btn')).toBeDisabled();
  await expect(page.locator('#camera-lock-btn')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#camera-lock-btn')).toHaveAttribute('title', /No two views show the same embedding/);

  // Focus moves the Navigation panel and the keys to each view's own mode.
  await page.locator('.split-badge').nth(0).locator('.split-badge-select').click();
  await expect(page.locator('#navigation-mode')).toHaveValue('orbit');
  await page.keyboard.press('g');
  await expect.poll(() => modeOf(page, 'live')).toBe('free');
  expect(await modeOf(page, kept)).toBe('planar');
  await page.locator('.split-badge').nth(1).locator('.split-badge-select').click();
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');
  await page.locator('.split-badge').nth(0).locator('.split-badge-select').click();
  await expect(page.locator('#navigation-mode')).toHaveValue('free');
  expect(errors).toEqual([]);
});

test('Link cameras links only the views that show one representation', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectBrowserErrors(page);
  await openRepresentations(page);
  const phate = await layoutOf(page, 'PHATE', 3);
  await keepView(page, 2);
  await keepView(page, 3);
  const third = await showInRow(page, 3, phate);
  const [live, second] = await viewIds(page);
  await expect(page.locator('#camera-lock-btn')).toBeEnabled();
  await expect(page.locator('#camera-lock-btn')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window._cellucidViewer.getCameraLinkGroups())).toEqual([[live, second]]);
  await expect(page.locator('.split-badge').nth(0).locator('.split-badge-link')).toHaveText('linked');
  await expect(page.locator('.split-badge').nth(2).locator('.split-badge-link')).toHaveCount(0);

  // Turning the focused (live) camera moves its linked twin, not the PHATE view.
  await page.locator('.split-badge').nth(0).locator('.split-badge-select').click();
  const before = await page.evaluate(id => window._cellucidViewer.getViewCameraState(id), third);
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const camera = viewer.getCameraState();
    camera.orbit.theta += 0.6;
    viewer.setCameraState(camera);
  });
  await frames(page);
  const cameras = await page.evaluate(ids => ids.map(id => window._cellucidViewer.getViewCameraState(id).orbit.theta), [live, second, third]);
  expect(cameras[1]).toBeCloseTo(cameras[0], 10);
  expect(cameras[2]).toBeCloseTo(before.orbit.theta, 10);

  // Unlinked, the twin keeps its own camera.
  await page.locator('#camera-lock-btn').click();
  await expect(page.locator('#camera-lock-btn')).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const camera = viewer.getCameraState();
    camera.orbit.theta += 0.4;
    viewer.setCameraState(camera);
  });
  await frames(page);
  const after = await page.evaluate(ids => ids.map(id => window._cellucidViewer.getViewCameraState(id).orbit.theta), [live, second]);
  expect(Math.abs(after[0] - after[1])).toBeGreaterThan(0.3);
  expect(errors).toEqual([]);
});

test('four views of four representations pick, highlight, build LOD, label, export and restore', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const errors = collectBrowserErrors(page);
  await openRepresentations(page);
  const keys = {
    umap3d: await layoutOf(page, 'UMAP', 3),
    phate: await layoutOf(page, 'PHATE', 3),
    umap2d: await layoutOf(page, 'UMAP', 2),
    tsne: await layoutOf(page, 't-SNE', 2),
  };
  // Colour by cell type first: kept views copy it.
  await page.locator('#categorical-field').selectOption('cell_type');
  await expect.poll(() => page.evaluate(() => window._cellucidState.centroidLabels.length)).toBe(3);
  await keepView(page, 2);
  await keepView(page, 3);
  await keepView(page, 4);
  await showInRow(page, 2, keys.phate);
  await showInRow(page, 3, keys.umap2d);
  await showInRow(page, 4, keys.tsne);
  const ids = await viewIds(page);
  expect(await Promise.all(ids.map(id => shows(page, id)))).toEqual([keys.umap3d, keys.phate, keys.umap2d, keys.tsne]);
  expect(await Promise.all(ids.map(id => modeOf(page, id)))).toEqual(['orbit', 'orbit', 'planar', 'planar']);
  await expect(page.locator('.split-badge .split-badge-label')).toHaveText([
    'UMAP · 3D', 'PHATE · 3D', 'UMAP · 2D', 't-SNE · 2D',
  ]);
  await expect(page.locator('.split-badge .split-badge-sub')).toHaveText(Array(4).fill('cell_type'));

  // Each view draws its own representation's centroid labels.
  const centroids = await page.evaluate(ids => ids.map(id => {
    const context = window._cellucidState.viewContexts.get(id);
    return Array.from(context.centroidPositions ?? []).map(value => Math.round(value * 1000));
  }), ids);
  for (const positions of centroids) expect(positions.length).toBe(9);
  expect(new Set(centroids.map(positions => positions.join(','))).size).toBe(4);

  // LOD and frustum culling: one tree per representation, a ladder in every view.
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    viewer.setAdaptiveLOD(true);
    viewer.setFrustumCulling(true);
  });
  // The trees are built off the main thread, so a fixed number of frames is
  // no promise they have landed; each view's ladder is awaited.
  const ladders = () => page.evaluate(ids => {
    const state = window._cellucidState;
    const renderer = window._cellucidViewer.getHPRenderer();
    return ids.map(id => renderer.getViewLODLevelCount(id, state.getViewDimensionLevel(id)));
  }, ids);
  await expect.poll(async () => Math.min(...await ladders())).toBeGreaterThan(1);

  // Picking: a cell is found in every pane, from that pane's own geometry.
  const picks = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const canvas = document.getElementById('glcanvas');
    const rect = canvas.getBoundingClientRect();
    return viewer.getPresentedLayout().panes.map(pane => {
      for (let row = 1; row < 12; row++) {
        for (let col = 1; col < 12; col++) {
          const x = rect.left + pane.cssLeft + (pane.cssWidth * col) / 12;
          const y = rect.top + pane.cssTop + (pane.cssHeight * row) / 12;
          const picked = viewer.pickCellAtScreen(x, y);
          if (Number.isInteger(picked) && picked >= 0) return { viewId: pane.viewId, picked };
        }
      }
      return { viewId: pane.viewId, picked: -1 };
    });
  });
  expect(picks.map(pick => pick.viewId)).toEqual(ids);
  for (const pick of picks) expect(pick.picked).toBeGreaterThanOrEqual(0);

  // Highlight one category in view 1: the same cells are highlighted in all.
  await page.locator('.split-badge').nth(0).locator('.split-badge-select').click();
  await page.evaluate(() => {
    const state = window._cellucidState;
    const fieldIndex = state.obsData.fields.findIndex(field => field.key === 'cell_type');
    state.addHighlightFromCategory(fieldIndex, 0, 'obs');
  });
  // Highlight state belongs to cells: one array serves every view, and each
  // view's highlight pass draws the same 4,000 cells from its own geometry.
  await expect.poll(() => page.evaluate(
    () => window._cellucidState.highlightArray.reduce((count, value) => count + (value > 0 ? 1 : 0), 0)
  )).toBe(4000);
  for (const index of [1, 2, 3, 0]) {
    await page.locator('.split-badge').nth(index).locator('.split-badge-select').click();
    expect(await page.evaluate(
      () => window._cellucidState.getTotalHighlightedCellCount()
    )).toBe(4000);
  }

  // A figure of the 2x2 grid draws four panes.
  await page.locator('#figure-export-section > summary').click();
  await page.getByRole('button', { name: /^Download\b/ }).click();
  await page.getByLabel('Download format').selectOption('svg');
  await page.getByLabel('SVG point strategy').selectOption('full-vector');
  await page.getByLabel(/Export all views/).check();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#figure-export-btn').click();
  const figure = await downloadPromise;
  const figurePath = testInfo.outputPath('four-representations.svg');
  await figure.saveAs(figurePath);
  const svg = await readFile(figurePath, 'utf8');
  expect((svg.match(/<clipPath id=/g) ?? []).length).toBeGreaterThanOrEqual(8);

  // Session round trip: every view's representation, mode and camera.
  const saved = await page.evaluate(ids => ids.map(id => ({
    layout: window._cellucidState.getViewLayoutKey(id),
    mode: window._cellucidViewer.getViewNavigationMode(id),
    theta: window._cellucidViewer.getViewCameraState(id).orbit.theta,
  })), ids);
  const sessionDownload = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const sessionPath = testInfo.outputPath('four-representations.cellucid-session');
  await (await sessionDownload).saveAs(sessionPath);

  await openRepresentations(page);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  await (await chooser).setFiles(sessionPath);
  await expect(page.locator('.split-badge')).toHaveCount(4);
  await expect.poll(() => page.evaluate(() => [...window._cellucidState.viewContexts.keys()].map(
    id => window._cellucidState.getViewLayoutKey(id)
  ))).toEqual(saved.map(view => view.layout));
  const restored = await page.evaluate(() => [...window._cellucidState.viewContexts.keys()].map(id => ({
    layout: window._cellucidState.getViewLayoutKey(id),
    mode: window._cellucidViewer.getViewNavigationMode(id),
    theta: window._cellucidViewer.getViewCameraState(id).orbit.theta,
  })));
  for (let index = 0; index < saved.length; index++) {
    expect(restored[index].layout).toBe(saved[index].layout);
    expect(restored[index].mode).toBe(saved[index].mode);
    expect(restored[index].theta).toBeCloseTo(saved[index].theta, 6);
  }
  expect(errors).toEqual([]);
});

test('keys 1, 2 and 3 show a dimension’s default, then step through its representations', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectBrowserErrors(page);
  await openRepresentations(page);
  const umap2d = await layoutOf(page, 'UMAP', 2);
  const tsne = await layoutOf(page, 't-SNE', 2);
  const phate = await layoutOf(page, 'PHATE', 3);
  await page.locator('#glcanvas').click({ position: { x: 700, y: 400 } });
  await page.keyboard.press('2');
  await expect.poll(() => shows(page, 'live')).toBe(umap2d);
  await expect(page.locator('#notification-center .notification').filter({ hasText: '2D · UMAP (1 of 2)' })).toHaveCount(1);
  await page.keyboard.press('2');
  await expect.poll(() => shows(page, 'live')).toBe(tsne);
  await expect(page.locator('#notification-center .notification').filter({ hasText: '2D · t-SNE (2 of 2)' })).toHaveCount(1);
  await page.keyboard.press('3');
  await expect.poll(() => page.evaluate(() => window._cellucidState.getDimensionLevel())).toBe(3);
  await page.keyboard.press('3');
  await expect.poll(() => shows(page, 'live')).toBe(phate);
  await page.keyboard.press('1');
  await expect(page.locator('#notification-center .notification').filter({ hasText: 'No 1D embedding is on' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('the checklist turns three columns of a wide PCA on as a 3D representation', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectBrowserErrors(page);
  await openRepresentations(page);
  await page.locator('#data-mapping-disclosure > .disclosure-header-row > .disclosure-header').click();
  // A wide array that is off is listed under "Other arrays", collapsed.
  const others = page.locator('#data-mapping-more > .disclosure-header');
  if ((await others.getAttribute('aria-expanded')) !== 'true') await others.click();
  const pcaRow = page.locator('.data-mapping-row').filter({ hasText: 'PCA' });
  await expect(pcaRow).toHaveCount(1);
  await expect(pcaRow.locator('.data-mapping-enable')).not.toBeChecked();
  await pcaRow.locator('.data-mapping-enable').check();
  await pcaRow.locator('.data-mapping-edit').click();
  await pcaRow.locator('.data-mapping-axes').selectOption('3');
  await expect(pcaRow.locator('.data-mapping-dim')).toHaveText('3D');
  await page.locator('#data-mapping-apply').click();
  await expect(page.locator('.data-mapping-status')).toHaveText('Applied.');
  const pca = await layoutOf(page, 'PCA 1,2,3', 3);
  expect(pca).not.toBeNull();
  // Turning it on loaded nothing; showing it does.
  expect(await page.evaluate(key => window._cellucidState.getDimensionManager().getResidentPositions(key), pca)).toBeNull();
  await page.locator('#view-representation-select').selectOption(pca);
  await expect.poll(() => shows(page, 'live')).toBe(pca);
  expect(await page.evaluate(key => window._cellucidState.getDimensionManager().getResidentPositions(key) !== null, pca)).toBe(true);
  expect(errors).toEqual([]);
});

test('running out of memory releases what no view shows, and the switch succeeds', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectBrowserErrors(page);
  await openRepresentations(page);
  const phate = await layoutOf(page, 'PHATE', 3);
  const umap2d = await layoutOf(page, 'UMAP', 2);
  const tsne = await layoutOf(page, 't-SNE', 2);

  // CPU: the next position load fails once with an allocation error.
  const cpu = await page.evaluate(async ({ phate, umap2d }) => {
    const state = window._cellucidState;
    const manager = state.getDimensionManager();
    await state.setViewRepresentation('live', umap2d, { followsDefault: false });
    const original = manager.loadLayout.bind(manager);
    let failures = 0;
    let evictions = 0;
    const evictUnpinned = manager.evictUnpinned.bind(manager);
    manager.evictUnpinned = () => { evictions += 1; return evictUnpinned(); };
    manager.loadLayout = (key, options) => {
      if (key === phate && failures === 0) {
        failures += 1;
        return Promise.reject(new RangeError('Array buffer allocation failed'));
      }
      return original(key, options);
    };
    await state.setViewRepresentation('live', phate, { followsDefault: false });
    manager.loadLayout = original;
    manager.evictUnpinned = evictUnpinned;
    return { failures, evictions, shows: state.getViewLayoutKey('live') };
  }, { phate, umap2d });
  expect(cpu).toEqual({ failures: 1, evictions: 1, shows: phate });

  // GPU: geometry kept for unshown representations is released, then the
  // upload is retried once.
  const gpu = await page.evaluate(async ({ tsne }) => {
    const state = window._cellucidState;
    const viewer = window._cellucidViewer;
    const before = viewer.getRetainedGeometryBytes();
    const gl = document.getElementById('glcanvas').getContext('webgl2');
    const getError = gl.getError.bind(gl);
    const bufferData = gl.bufferData.bind(gl);
    let injected = false;
    gl.bufferData = (...args) => {
      bufferData(...args);
      if (!injected && typeof args[1] === 'object' && args[1]?.byteLength >= 12000 * 8) {
        injected = true;
        gl.getError = () => { gl.getError = getError; return gl.OUT_OF_MEMORY; };
      }
    };
    await state.setViewRepresentation('live', tsne, { followsDefault: false });
    gl.bufferData = bufferData;
    gl.getError = getError;
    return { before, injected, shows: state.getViewLayoutKey('live'), after: viewer.getRetainedGeometryBytes() };
  }, { tsne });
  expect(gpu.before).toBeGreaterThan(0);
  expect(gpu.injected).toBe(true);
  expect(gpu.shows).toBe(tsne);
  expect(errors).toEqual([]);
});

test('Compare views and the checklist fit a phone', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = collectBrowserErrors(page);
  await openRepresentations(page);
  await keepView(page, 2);
  const tsne = await layoutOf(page, 't-SNE', 2);
  await showInRow(page, 2, tsne);
  const overflow = await page.evaluate(() => {
    const sidebar = document.getElementById('sidebar');
    return [...sidebar.querySelectorAll('#split-view-controls *, #data-mapping-root *')]
      .filter(element => element.getBoundingClientRect().right > sidebar.getBoundingClientRect().right + 1)
      .map(element => element.className || element.tagName);
  });
  expect(overflow).toEqual([]);
  expect(errors).toEqual([]);
});
