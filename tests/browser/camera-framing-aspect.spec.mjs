/**
 * A camera frames the same data on every screen shape.
 *
 * The field of view was 45° vertically on every screen, so on a phone held
 * upright (a portrait presented area) a camera framed to the data's height —
 * the default of each dimension, a sample's preset — cut the data off at both
 * sides. The 45° now applies to the presented area's shorter side
 * (`rendering/viewer/field-of-view.js`): a landscape screen is unchanged, and
 * on a portrait one the horizontal extent equals the landscape's vertical one.
 *
 * Measured here on the projection the viewer draws with: every cell's
 * normalized device coordinates, for the default camera of 1D, 2D and 3D.
 */

import { closeContextWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { serveSyntheticCatalog } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const ROOT = appUrl('/tests/browser/fixtures/framing-aspect/');
const DATASET_ID = 'framing-aspect';

/** The eight corners of the unit cube and its center: the data's extremes. */
const CORNERS = [
  [-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1], [0, 0, 0],
];

function columns(width) {
  const data = new Float32Array(CORNERS.length * width);
  CORNERS.forEach((corner, cell) => {
    for (let axis = 0; axis < width; axis += 1) data[(cell * width) + axis] = corner[axis];
  });
  return { data, columns: width };
}

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1440, height: 1000 } };

/** The largest |x| and |y| of every cell in normalized device coordinates. */
function readExtent(page) {
  return page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const matrix = viewer.getRenderState().mvpMatrix;
    const positions = viewer.getPositions();
    let maxX = 0;
    let maxY = 0;
    for (let offset = 0; offset < positions.length; offset += 3) {
      const [x, y, z] = [positions[offset], positions[offset + 1], positions[offset + 2]];
      const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
      maxX = Math.max(maxX, Math.abs((matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w));
      maxY = Math.max(maxY, Math.abs((matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w));
    }
    const canvas = document.getElementById('glcanvas');
    return { maxX, maxY, aspect: canvas.clientWidth / canvas.clientHeight };
  });
}

/** The extent once the camera has stopped moving: equal over half a second. */
async function settledExtent(page) {
  const samples = [];
  await expect.poll(async () => {
    samples.push(await readExtent(page));
    if (samples.length < 5) return false;
    const recent = samples.slice(-5);
    return recent.every(sample => Math.abs(sample.maxX - recent[0].maxX) < 1e-6
      && Math.abs(sample.maxY - recent[0].maxY) < 1e-6);
  }, { intervals: [100] }).toBe(true);
  return samples.at(-1);
}

/** The default camera of each dimension, with the sidebar closed. */
async function extentsAt(browser, contextOptions) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await serveSyntheticCatalog(page, ROOT, {
    id: DATASET_ID,
    name: 'Framing fixture',
    cells: CORNERS.length,
    obsm: {
      X_umap_1d: columns(1),
      X_umap_2d: columns(2),
      X_umap_3d: columns(3),
    },
  });
  await page.goto(
    `/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET_ID}&acceptance=framing-aspect-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#filter-count')).toHaveText(`Showing all ${CORNERS.length} cells`);
  // A phone opens on the plot, its sidebar already hidden (the bar at its
  // foot); elsewhere the sidebar is open and is hidden here.
  if (!(await page.locator('#sidebar').evaluate(sidebar => sidebar.classList.contains('hidden')))) {
    await page.locator('#sidebar-toggle').click();
  }
  await expect(page.locator('#sidebar')).toHaveClass(/\bhidden\b/);
  // The presented area is final once the sidebar's slide has finished.
  await expect.poll(() => page.evaluate(
    () => document.getElementById('sidebar').getAnimations().length,
  )).toBe(0);
  const extents = {};
  let previousPositions = null;
  for (const dimension of [3, 2, 1]) {
    await page.keyboard.press(String(dimension));
    // The view shows that dimension's positions (they differ from the last).
    await expect.poll(() => page.evaluate(([level, before]) => {
      const state = window._cellucidState;
      if (state.getViewDimensionLevel(state.getActiveViewId()) !== level) return false;
      const positions = Array.from(window._cellucidViewer.getPositions());
      return before === null || positions.some((value, index) => value !== before[index]);
    }, [dimension, previousPositions])).toBe(true);
    previousPositions = await page.evaluate(() => Array.from(window._cellucidViewer.getPositions()));
    await page.keyboard.press('r');
    extents[dimension] = await settledExtent(page);
  }
  await closeContextWithApplicationRetirement(context);
  return extents;
}

test('a portrait screen shows across what a landscape one shows down, in 1D, 2D and 3D', async ({ browser }) => {
  const phone = await extentsAt(browser, PHONE);
  const desktop = await extentsAt(browser, DESKTOP);
  for (const dimension of [1, 2, 3]) {
    // The phone's horizontal angle is the desktop's vertical one. So what the
    // desktop shows across its width (aspect × its height) the phone shows
    // across its own, and down the phone shows more, by its own aspect.
    expect(phone[dimension].maxX, `${dimension}D across`)
      .toBeCloseTo(desktop[dimension].maxX * desktop[dimension].aspect, 4);
    expect(phone[dimension].maxY, `${dimension}D down`)
      .toBeCloseTo(desktop[dimension].maxY * phone[dimension].aspect, 4);
  }
});

test('a kept view\'s portrait pane shows across what the single view shows down: no map cropped at the sides', async ({ browser }) => {
  // Found 2026-11-11 (Pancreas, 2-D UMAP): two views side by side make two portrait panes, which
  // took the presented area's landscape field of view and cut the map off at both sides. Each
  // pane now takes its own (`presented-view-layout.js`).
  const context = await browser.newContext(DESKTOP);
  const page = await context.newPage();
  await serveSyntheticCatalog(page, ROOT, {
    id: DATASET_ID, name: 'Framing fixture', cells: CORNERS.length,
    obsm: { X_umap_1d: columns(1), X_umap_2d: columns(2), X_umap_3d: columns(3) },
  });
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET_ID}&acceptance=framing-aspect-ci`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#filter-count')).toHaveText(`Showing all ${CORNERS.length} cells`);
  await page.keyboard.press('2');
  await expect.poll(() => page.evaluate(() => {
    const state = window._cellucidState;
    return state.getViewDimensionLevel(state.getActiveViewId());
  })).toBe(2);
  await page.keyboard.press('r');
  await settledExtent(page);
  await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    await getActions().dispatch('view.keep', {});
  });
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getPresentedLayout().panes.length)).toBe(2);
  // Every pane's projection as it is drawn (`getPresentedViewState`), against the cells' corners.
  const measured = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    return viewer.getPresentedLayout().panes.map(pane => {
      const matrix = viewer.getPresentedViewState(pane.viewId).renderState.mvpMatrix;
      let maxX = 0;
      let maxY = 0;
      for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const w = matrix[3] * x + matrix[7] * y + matrix[15];
        maxX = Math.max(maxX, Math.abs((matrix[0] * x + matrix[4] * y + matrix[12]) / w));
        maxY = Math.max(maxY, Math.abs((matrix[1] * x + matrix[5] * y + matrix[13]) / w));
      }
      // A planar camera straight above the plane at its distance: the corners' reach across is
      // 1 / (distance · tan(half the horizontal angle)).
      const distance = viewer.getViewCameraState(pane.viewId).freefly.position[2];
      return { maxX, maxY, aspect: pane.cssWidth / pane.cssHeight, distance };
    });
  });
  for (const pane of measured) {
    expect(pane.aspect).toBeLessThan(1);
    // 45° across the upright pane (the landscape single view's 45° down): before, the
    // presented area's 45° down gave the pane 2·atan(tan 22.5° · aspect) across, and a map
    // framed to its height was cut at both sides.
    expect(pane.maxX * pane.distance * Math.tan(Math.PI / 8)).toBeCloseTo(1, 4);
    expect(pane.maxY).toBeCloseTo(pane.maxX * pane.aspect, 4);
  }
  await closeContextWithApplicationRetirement(context);
});
