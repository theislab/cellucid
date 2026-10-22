import { expect, test } from './helpers/test.mjs';

import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=snapshot-connectivity-transparency-ci`;

test('a pane\'s shown edges follow only its accepted transparency, through failure and retry', async ({
  page,
}) => {
  const pageErrors = [];
  const consoleDiagnostics = [];
  const responseFailures = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const text = `${message.type()}: ${message.text()}`;
    if (!/GPU stall due to ReadPixels/i.test(text)) {
      consoleDiagnostics.push(text);
    }
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      responseFailures.push(
        `${response.status()} ${response.request().method()} ${response.url()}`,
      );
    }
  });

  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );

  const proof = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const ui = window._cellucidUi;
    const gl = viewer.getGLContext();
    viewer.setAdaptiveLOD(false);
    await new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    viewer.pause();

    const prototype = WebGL2RenderingContext.prototype;
    const originalTexSubImage3D = prototype.texSubImage3D;
    // Reject the next R8 row upload, a pane's point-alpha publication, as
    // WebGL rejects a write it refuses: synchronously, writing nothing.
    let injectNextAlphaUpload = false;
    let injectedFailure = false;
    prototype.texSubImage3D = function (...args) {
      if (
        injectNextAlphaUpload &&
        args[8] === this.RED &&
        args[9] === this.UNSIGNED_BYTE
      ) {
        injectNextAlphaUpload = false;
        injectedFailure = true;
        throw new TypeError('WebGL rejected the alpha texSubImage3D upload.');
      }
      return Reflect.apply(originalTexSubImage3D, this, args);
    };

    try {
      const pointCount = viewer.getPointCount();
      // Edge 0: cells 0-1. Edge 1: cells 1-2.
      viewer.setupEdgesV2({
        sources: Uint32Array.from([0, 1]),
        destinations: Uint32Array.from([1, 2]),
        weights: Float64Array.from([1, 0.5]),
        nEdges: 2,
        nCells: pointCount,
      });
      viewer.setEdgeVisibleTarget(2);
      const shown = viewId => viewer.getEdgeSelectionStatsForView(viewId).shownCount;

      const payload = state.getSnapshotPayload();
      const snapshot = ui.publishSnapshotView({
        label: 'Direct transparency',
        fieldKey: payload.fieldKey,
        fieldKind: payload.fieldKind,
        colors: payload.colors,
        transparency: payload.transparency,
        centroidPositions: payload.centroidPositions,
        centroidColors: payload.centroidColors,
        dimensionLevel: viewer.getViewDimension('live'),
        sourceViewId: 'live',
        meta: { filtersText: payload.filtersText },
        cameraState: viewer.getViewCameraState('live'),
      });

      // Hiding cell 0 hides edge 0 only.
      const baseline = new Uint8Array(pointCount).fill(1);
      baseline[0] = 0;
      viewer.updateSnapshotAttributes(snapshot.id, { transparency: baseline });
      const baselineShown = shown(snapshot.id);

      // Hiding cell 1 instead would hide both; the publication fails.
      const candidate = new Uint8Array(pointCount).fill(1);
      candidate[1] = 0;
      injectNextAlphaUpload = true;
      let publicationError = null;
      try {
        viewer.updateSnapshotAttributes(snapshot.id, { transparency: candidate });
      } catch (error) {
        publicationError = error.message;
      }
      const stateAfterFailure = Array.from(
        viewer.getViewTransparency(snapshot.id).subarray(0, 3),
      );
      const shownAfterFailure = shown(snapshot.id);
      const retryResult = viewer.updateSnapshotAttributes(snapshot.id, { transparency: candidate });
      const stateAfterRetry = Array.from(
        viewer.getViewTransparency(snapshot.id).subarray(0, 3),
      );
      const shownAfterRetry = shown(snapshot.id);

      // The live pane: same contract through updateTransparency.
      const liveOwner = state.categoryTransparency;
      const liveBaseline = new Uint8Array(pointCount).fill(1);
      liveBaseline[0] = 0;
      liveOwner.set(liveBaseline);
      viewer.updateTransparency(liveOwner);
      const liveBaselineShown = shown('live');

      const liveCandidate = new Uint8Array(pointCount).fill(1);
      injectNextAlphaUpload = true;
      let livePublicationError = null;
      try {
        liveOwner.set(liveCandidate);
        viewer.updateTransparency(liveOwner);
      } catch (error) {
        livePublicationError = error.message;
      }
      const liveStateAfterFailure = Array.from(
        viewer.getViewTransparency('live').subarray(0, 3),
      );
      const applicationStateAfterFailure = Array.from(liveOwner.subarray(0, 3));
      const liveShownAfterFailure = shown('live');
      liveOwner.set(liveCandidate);
      viewer.updateTransparency(liveOwner);
      const liveStateAfterRetry = Array.from(
        viewer.getViewTransparency('live').subarray(0, 3),
      );
      const liveShownAfterRetry = shown('live');

      return {
        applicationStateAfterFailure,
        baselineShown,
        glError: gl.getError(),
        injectedFailure,
        liveBaselineShown,
        livePublicationError,
        liveShownAfterFailure,
        liveShownAfterRetry,
        liveStateAfterFailure,
        liveStateAfterRetry,
        publicationError,
        retryResult,
        shownAfterFailure,
        shownAfterRetry,
        stateAfterFailure,
        stateAfterRetry,
      };
    } finally {
      prototype.texSubImage3D = originalTexSubImage3D;
    }
  });

  // A pane's shown edges follow only its accepted visibility: a failed
  // publication keeps the accepted state and its edges, and a retry moves both.
  expect(proof.injectedFailure).toBe(true);
  expect(proof.baselineShown).toBe(1);
  expect(proof.publicationError).toMatch(/rejected the alpha texSubImage3D upload/);
  expect(proof.stateAfterFailure).toEqual([0, 1, 1]);
  expect(proof.shownAfterFailure).toBe(1);
  expect(proof.retryResult).toBe(true);
  expect(proof.stateAfterRetry).toEqual([1, 0, 1]);
  expect(proof.shownAfterRetry).toBe(0);
  expect(proof.liveBaselineShown).toBe(1);
  expect(proof.livePublicationError).toMatch(/rejected the alpha texSubImage3D upload/);
  expect(proof.liveStateAfterFailure).toEqual([0, 1, 1]);
  expect(proof.applicationStateAfterFailure).toEqual([0, 1, 1]);
  expect(proof.liveShownAfterFailure).toBe(1);
  expect(proof.liveStateAfterRetry).toEqual([1, 1, 1]);
  expect(proof.liveShownAfterRetry).toBe(2);
  expect(proof.glError).toBe(0);
  expect(pageErrors).toEqual([]);
  expect(responseFailures).toEqual([]);
  expect(consoleDiagnostics).toEqual([]);
});
