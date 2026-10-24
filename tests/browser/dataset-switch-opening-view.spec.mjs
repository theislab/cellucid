/**
 * A file opened after another dataset opens on its own terms: its embedding,
 * the camera framing its cells, the point size its cell count wants, and the
 * colours its file stores. Nothing the previous dataset (or its published
 * preset) left behind carries over.
 *
 * The owner opened a 28,317-cell segmentation export after Suo (562k cells,
 * 3D, whose preset puts the camera inside the cloud and the point size at
 * 0.64) and saw a canvas of giant grey spheres: the new 2D file was framed by
 * Suo's camera. Here the 96-cell 3D catalog dataset stands in for Suo, given
 * the same kind of pose and point size, and `data-mapping-crowded.h5ad` (the
 * same shape as that export: three 2-column UMAPs, a 3-column t-SNE and
 * spatial array, a 4-column integer `coordinates`, wide PCA and latent
 * matrices, no `X_umap`, no `uns['cellucid']`, and Scanpy's colours for
 * `cell_type`) is opened over it.
 *
 * Fixture: `scripts/generate-data-mapping-fixtures.py`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { DEVELOPMENT, SAMPLE_CATALOG } from './helpers/dataset-loading.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CROWDED_H5AD = path.join(FIXTURES, 'data-mapping-crowded.h5ad');
const CROWDED_CELLS = 300;
// `uns['cell_type_colors']` of the fixture, in category order.
const CELL_TYPE_COLORS = ['#8c564b', '#17becf', '#bcbd22'];

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function settleFrames(page) {
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

/**
 * What the live view shows: its camera, where the corners of the normalized
 * box land in clip space, the point size, and its embedding.
 */
function readOpeningView(page) {
  return page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const matrix = viewer.getRenderState().mvpMatrix;
    // Every normalized embedding spans [-1, 1] on its longest axis; a camera
    // that frames the cells shows all four corners of that square.
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
      const clipX = matrix[0] * x + matrix[4] * y + matrix[12];
      const clipY = matrix[1] * x + matrix[5] * y + matrix[13];
      const clipW = matrix[3] * x + matrix[7] * y + matrix[15];
      return [clipX / clipW, clipY / clipW];
    });
    return {
      camera: viewer.getCameraState(),
      cornersInView: corners.every(([x, y]) => Math.abs(x) <= 1 && Math.abs(y) <= 1),
      pointSize: document.getElementById('point-size').value,
      layoutKey: state.getViewLayoutKey('live'),
      dimension: state.getViewDimensionLevel('live'),
    };
  });
}

test('a file opened after a 3D dataset with a close-up preset opens on its own embedding, camera, point size and palette', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectBrowserErrors(page);
  const url = new URL(appUrl('/'));
  url.searchParams.set('sampleCatalog', SAMPLE_CATALOG);
  url.searchParams.set('dataset', DEVELOPMENT.id);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getPointCount())).toBe(DEVELOPMENT.cells);
  await expect.poll(() => page.evaluate(() => window._cellucidState.getViewDimensionLevel('live'))).toBe(3);

  // What Suo's preset leaves: an orbit camera inside the cloud and a small
  // point size.
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const camera = viewer.getCameraState();
    viewer.setCameraState({
      ...camera,
      orbit: { ...camera.orbit, radius: 0.5, targetRadius: 0.5, theta: 2.86, phi: 1.7 },
    });
    const slider = document.getElementById('point-size');
    slider.value = '14';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settleFrames(page);
  const before = await readOpeningView(page);
  expect(before.camera.orbit.radius).toBe(0.5);
  expect(before.cornersInView).toBe(false);

  await page.locator('#user-data-file-input').setInputFiles(CROWDED_H5AD);
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getPointCount())).toBe(CROWDED_CELLS);
  await expect(page.locator('#dataset-name')).toHaveText('data-mapping-crowded');
  await settleFrames(page);

  // The embedding: the file's UMAP in 2D. The best guess fills 3D with the
  // 3-column t-SNE, which stays available, but a view starts on the UMAP.
  const expectedSliderPosition = await page.evaluate(async cells => {
    const { pointSizeSliderPositionForCellCount } = await import('/assets/js/rendering/point-size-scale.js');
    return String(pointSizeSliderPositionForCellCount(cells));
  }, CROWDED_CELLS);
  await expect.poll(() => readOpeningView(page)).toMatchObject({
    layoutKey: 'X_umap_scale0_latents',
    dimension: 2,
    pointSize: expectedSliderPosition,
    cornersInView: true,
  });
  const after = await readOpeningView(page);
  await expect(page.locator('#view-representation-select option:checked')).toHaveText('UMAP scale0 latents · 2D');
  expect(await page.evaluate(() => window._cellucidState.getDataMapping().embeddings.defaults['3d']))
    .toEqual({ key: 'X_tsne_scale0_latents', columns: [0, 1, 2] });

  // The camera is the default framing of a 2D view, the one the same file
  // gets when it is the first dataset opened.
  expect(after.camera.navigationMode).toBe('planar');
  expect(after.camera.orbit.radius).toBe(3);
  expect(after.camera.orbit.target).toEqual([0, 0, 0]);
  await page.goto('about:blank');
  const freshUrl = new URL(url);
  freshUrl.searchParams.delete('dataset');
  // A catalog that is not there: the page opens with no dataset, and the
  // file is the first one it shows.
  freshUrl.searchParams.set('sampleCatalog', appUrl('/tests/browser/fixtures/missing-catalog/'));
  await page.goto(freshUrl.toString(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await page.locator('#user-data-file-input').setInputFiles(CROWDED_H5AD);
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getPointCount())).toBe(CROWDED_CELLS);
  await settleFrames(page);
  const fresh = await readOpeningView(page);
  expect(after.camera).toEqual(fresh.camera);
  expect(after.pointSize).toBe(fresh.pointSize);

  // Scanpy's colours: `cell_type` opens in the palette its file stores.
  await page.locator('#categorical-field').selectOption('cell_type', { force: true });
  await expect.poll(() => page.evaluate(() => {
    const field = window._cellucidState.getActiveField();
    if (field?.key !== 'cell_type' || !Array.isArray(field._categoryColors)) return null;
    return field._categoryColors.map(color => `#${color
      .map(channel => Math.round(channel * 255).toString(16).padStart(2, '0'))
      .join('')}`);
  })).toEqual(CELL_TYPE_COLORS);

  // The missing catalog of the fresh page is the one expected failure.
  expect(errors.filter(error => !error.includes('missing-catalog') && !error.includes('404'))).toEqual([]);
});
