/**
 * A view's geometry is its layout, not its dimension.
 *
 * This registers and enables a second layout of the live dimension
 * programmatically (the synthetic dataset has one) and switches a kept view
 * and the live view between the two. A same-dimension switch must
 * publish the other layout's positions and drop every per-view cache derived
 * from the previous geometry: keyed by dimension, the switch was a no-op and a
 * view kept LOD, frustum and spawn state describing the embedding it no
 * longer showed.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { loadSyntheticDataset } from './helpers/synthetic-dataset.mjs';

const FIXTURE_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}` +
  '&dataset=current-ui&acceptance=view-layout-invalidation-ci';
// Large enough that the live and kept views build spatial indices and LOD.
const POINT_COUNT = 30_000;

test('switching between two layouts of one dimension rebuilds the view geometry', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await loadSyntheticDataset(page, { pointCount: POINT_COUNT, pattern: 'atlas' });

  // A second layout of the live dimension: the same cells mirrored in x.
  await page.evaluate(() => {
    const state = window._cellucidState;
    const viewer = window._cellucidViewer;
    const manager = state.getDimensionManager();
    const dimension = state.getDimensionLevel();
    const mirrored = viewer.getPositions();
    for (let index = 0; index < mirrored.length; index += dimension) {
      mirrored[index] = -mirrored[index];
    }
    manager.registerLayouts([{
      layoutKey: 'mirror',
      dimension,
      label: 'Mirror',
      path: null,
      provenance: null,
      origin: 'mapping',
    }]);
    manager.normalizedPositionCache.set('mirror', mirrored);
    manager.normTransformCache.set('mirror', { center: [0, 0, 0], scale: 1 });
    // Only an enabled representation can be shown.
    manager.setRepresentations(
      [...manager.getEnabledLayoutKeys(), 'mirror'],
      new Map([[dimension, manager.getDefaultLayout(dimension)]])
    );
    viewer.setAdaptiveLOD(true);
    viewer.setFrustumCulling(true);
  });

  await openCollapsedPanels(page);
  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('.split-badge')).toHaveCount(2);

  const proof = await page.evaluate(async () => {
    const state = window._cellucidState;
    const viewer = window._cellucidViewer;
    const renderer = viewer.getHPRenderer();
    // At rest: the frame loop has settled and every view drew its final
    // geometry (its tree built in the worker and adopted), so a culled frame
    // of it has been drawn; a count of frames is no proof of that where a
    // tree takes longer to land than the frames do.
    const rest = async () => {
      for (let frame = 0; frame < 1800; frame++) {
        if (viewer.getFrameScheduleState().settled && viewer.isPresentedGeometrySettled()) return;
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      throw new Error(`The views never came to rest: ${JSON.stringify(viewer.getFrameScheduleState())}`);
    };
    const snapshotId = viewer.getSnapshotViews()[0].id;
    const dimension = state.getViewDimensionLevel(snapshotId);
    const slot = state.getViewLayoutKey(snapshotId);
    const viewCache = viewId => {
      const viewState = renderer._perViewState.get(viewId);
      return {
        culled: viewState.lastFrustumMVP !== null,
        lodLevel: viewState.lastLodLevel,
      };
    };
    const firstPositionOf = viewId => viewer.getCellPosition(0, viewId).x;

    await rest();
    const before = viewCache(snapshotId);
    const slotX = firstPositionOf(snapshotId);

    await state.setViewRepresentation(snapshotId, 'mirror', { followsDefault: false });
    // Measured before any frame can rebuild them.
    const afterSwitch = viewCache(snapshotId);
    const switched = {
      layoutKey: viewer.getViewLayoutKey(snapshotId),
      managerLayoutKey: state.getViewLayoutKey(snapshotId),
      dimension: viewer.getViewDimension(snapshotId),
      x: firstPositionOf(snapshotId),
      liveLayoutKey: viewer.getViewLayoutKey('live'),
      liveX: firstPositionOf('live'),
    };
    await rest();
    const rebuilt = viewCache(snapshotId);

    await state.showDefaultRepresentation(snapshotId, dimension);
    const afterReturn = viewCache(snapshotId);
    const returned = {
      layoutKey: viewer.getViewLayoutKey(snapshotId),
      x: firstPositionOf(snapshotId),
    };

    // The live view switches the same way.
    await rest();
    await state.setViewRepresentation('live', 'mirror', { followsDefault: false });
    const live = {
      layoutKey: viewer.getViewLayoutKey('live'),
      x: firstPositionOf('live'),
    };
    await rest();
    await state.showDefaultRepresentation('live', dimension);
    await rest();

    return {
      afterReturn,
      afterSwitch,
      before,
      dimension,
      live,
      liveFinalLayoutKey: viewer.getViewLayoutKey('live'),
      rebuilt,
      returned,
      slot,
      slotX,
      switched,
    };
  });

  expect(proof.before.culled).toBe(true);
  expect(proof.switched).toEqual({
    layoutKey: 'mirror',
    managerLayoutKey: 'mirror',
    dimension: proof.dimension,
    x: -proof.slotX,
    liveLayoutKey: proof.slot,
    liveX: proof.slotX,
  });
  // The same-dimension switch dropped the kept view's frustum and LOD caches.
  expect(proof.afterSwitch).toEqual({ culled: false, lodLevel: -1 });
  expect(proof.rebuilt.culled).toBe(true);
  expect(proof.afterReturn).toEqual({ culled: false, lodLevel: -1 });
  expect(proof.returned).toEqual({ layoutKey: proof.slot, x: proof.slotX });
  expect(proof.live).toEqual({ layoutKey: 'mirror', x: -proof.slotX });
  expect(proof.liveFinalLayoutKey).toBe(proof.slot);
  expect(pageErrors).toEqual([]);
});
