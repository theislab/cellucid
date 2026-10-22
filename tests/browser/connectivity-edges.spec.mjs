import { expect, test } from './helpers/test.mjs';

import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=connectivity-edges-ci`;

/**
 * Connectivity edges in the real viewer (rendering/connectivity-edge-layer.js):
 * every pane draws the first K of its own visible edges, from 28-byte
 * instance records that exist only for those K edges; a pane's filters, a
 * kept view, a geometry change and a dataset replacement each keep that
 * exact.
 */
test('every pane draws exactly the first K of its own visible edges from K records', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');

  const proof = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const ui = window._cellucidUi;
    const gl = viewer.getGLContext();
    const prototype = WebGL2RenderingContext.prototype;
    const { createConnectivityEdgeOrder } = await import(
      '/assets/js/rendering/connectivity-edge-selection.js'
    );
    const nCells = viewer.getPointCount();
    viewer.pause();
    viewer.setAdaptiveLOD(false);
    viewer.setFrustumCulling(false);

    // A ring plus chords: every cell has edges, ordered by source.
    const pairs = [];
    for (let cell = 0; cell < nCells; cell++) {
      for (const step of [1, 2, 7]) {
        const other = (cell + step) % nCells;
        if (other !== cell) pairs.push([Math.min(cell, other), Math.max(cell, other)]);
      }
    }
    const unique = Array.from(new Set(pairs.map(([a, b]) => a * nCells + b))).sort((x, y) => x - y);
    const edgeCount = unique.length;
    const sources = Uint32Array.from(unique, key => Math.floor(key / nCells));
    const destinations = Uint32Array.from(unique, key => key % nCells);
    const weights = Float64Array.from(unique, (_key, index) => 1 + (index % 3));

    viewer.setupEdgesV2({ sources, destinations, weights, nEdges: edgeCount, nCells });

    // A kept view that hides the first half of the cells.
    const payload = state.getSnapshotPayload();
    const snapshotTransparency = new Uint8Array(nCells);
    for (let cell = Math.floor(nCells / 2); cell < nCells; cell++) snapshotTransparency[cell] = 1;
    const snapshot = ui.publishSnapshotView({
      label: 'Half hidden',
      fieldKey: payload.fieldKey,
      fieldKind: payload.fieldKind,
      colors: payload.colors,
      transparency: snapshotTransparency,
      centroidPositions: payload.centroidPositions,
      centroidColors: payload.centroidColors,
      dimensionLevel: viewer.getViewDimension('live'),
      sourceViewId: 'live',
      meta: { filtersText: payload.filtersText },
      cameraState: viewer.getViewCameraState('live'),
    });
    viewer.setupEdgesV2ForView(snapshot.id);
    viewer.updateEdgeVisibilityV2ForViewFromLod(snapshot.id, snapshotTransparency, null);
    viewer.refreshEdgeSelectionForView('live');
    viewer.refreshEdgeSelectionForView(snapshot.id);

    const target = Math.min(40, edgeCount);
    viewer.setEdgeVisibleTarget(target);
    viewer.setViewLayout('grid', 'live');
    viewer.setShowConnectivity(true);

    const counts = [];
    const unsubscribe = viewer.onConnectivityVisibleCount((viewId, stats) => {
      counts.push([viewId, stats.visibleCount]);
    });
    const capture = async () => {
      const original = prototype.drawArraysInstanced;
      const submissions = [];
      prototype.drawArraysInstanced = function (...args) {
        if (this === gl && args[0] === this.TRIANGLE_STRIP && args[2] === 4) {
          submissions.push(args[3]);
        }
        return Reflect.apply(original, this, args);
      };
      try {
        viewer.resume();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      } finally {
        viewer.pause();
        prototype.drawArraysInstanced = original;
      }
      return submissions;
    };
    const frames = await capture();
    // The counts land in slices after the selection.
    await new Promise(resolve => setTimeout(resolve, 50));
    unsubscribe();

    const order = createConnectivityEdgeOrder(edgeCount);
    const expectedFor = transparency => {
      const shown = [];
      let visible = 0;
      for (let edge = 0; edge < edgeCount; edge++) {
        if (transparency[sources[edge]] && transparency[destinations[edge]]) visible++;
      }
      for (let index = 0; index < edgeCount && shown.length < target; index++) {
        const edge = order.at(index);
        if (transparency[sources[edge]] && transparency[destinations[edge]]) shown.push(edge);
      }
      return { shown: shown.length, visible };
    };
    const live = expectedFor(viewer.getViewTransparency('live'));
    const kept = expectedFor(snapshotTransparency);
    const memory = viewer.getConnectivityMemoryStats();

    // A geometry change re-gathers records; nothing is re-selected.
    const positions = viewer.getViewPositions('live').map(value => value * 0.5);
    viewer.updatePositions(positions, viewer.getViewDimension('live'));
    const afterMove = await capture();

    // A new dataset publication drops the graph and every pane's records.
    const error = gl.getError();
    return {
      afterMove,
      counts,
      edgeCount,
      error,
      frames,
      kept,
      live,
      liveStats: viewer.getEdgeSelectionStatsForView('live'),
      memory: {
        gpuBytes: memory.gpuBytes,
        panes: memory.panes.map(pane => [pane.viewId, pane.gpuBytes, pane.shownCount]),
      },
      snapshotId: snapshot.id,
      snapshotStats: viewer.getEdgeSelectionStatsForView(snapshot.id),
      target,
    };
  });

  expect(pageErrors).toEqual([]);
  expect(proof.error).toBe(0);
  // One instanced draw a pane, each exactly its own selection.
  expect(proof.frames.slice(-2).sort((a, b) => a - b)).toEqual(
    [proof.live.shown, proof.kept.shown].sort((a, b) => a - b),
  );
  expect(proof.liveStats.shownCount).toBe(proof.live.shown);
  expect(proof.snapshotStats.shownCount).toBe(proof.kept.shown);
  expect(proof.kept.shown).toBeLessThan(proof.live.shown + 1);
  // GPU memory is K records a pane, never per edge.
  for (const [, gpuBytes] of proof.memory.panes) {
    expect(gpuBytes).toBe(Math.min(proof.target, proof.edgeCount) * 28);
  }
  // Visible counts arrive and equal a full pass over the graph.
  expect(proof.counts).toEqual(
    expect.arrayContaining([[proof.snapshotId, proof.kept.visible]]),
  );
  expect(proof.snapshotStats.visibleCount).toBe(proof.kept.visible);
  expect(proof.liveStats.visibleCount).toBe(proof.live.visible);
  // After a geometry change the same edges are drawn.
  expect(proof.afterMove.slice(-2).sort((a, b) => a - b)).toEqual(
    proof.frames.slice(-2).sort((a, b) => a - b),
  );
});

test('a dataset replacement drops the connectivity graph and every pane\'s records', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');

  const proof = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const nCells = viewer.getPointCount();
    viewer.setupEdgesV2({
      sources: Uint32Array.from([0, 1]),
      destinations: Uint32Array.from([1, 2]),
      weights: Float64Array.from([1, 2]),
      nEdges: 2,
      nCells,
    });
    viewer.setEdgeVisibleTarget(2);
    viewer.refreshEdgeSelectionForView('live');
    viewer.setShowConnectivity(true);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const before = viewer.getConnectivityMemoryStats();
    viewer.clearEdgesV2();
    const after = viewer.getConnectivityMemoryStats();
    return {
      beforeGpu: before.gpuBytes,
      afterGpu: after.gpuBytes,
      afterGraph: after.graphBytes,
      hasData: viewer.hasConnectivityData(),
    };
  });
  expect(pageErrors).toEqual([]);
  expect(proof.beforeGpu).toBe(2 * 28);
  expect(proof.afterGpu).toBe(0);
  expect(proof.afterGraph).toBe(0);
  expect(proof.hasData).toBe(false);
});
