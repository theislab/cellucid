import { expect, test } from '@playwright/test';

import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=snapshot-connectivity-transparency-ci`;

test('direct snapshot transparency keeps connectivity exact and retryable', async ({
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
    const originalDeleteTexture = prototype.deleteTexture;
    const originalGetError = prototype.getError;
    const originalTexImage2D = prototype.texImage2D;
    const originalTexSubImage2D = prototype.texSubImage2D;
    const textureMirrors = new Map();
    const r8Allocations = [];
    const deletedTextures = new Set();
    let injectedFailure = false;
    let injectNextVisibilityUpload = false;
    let syntheticErrorPending = false;
    let snapshotTexture = null;
    let failureTexture = null;

    prototype.texImage2D = function (...args) {
      const texture = this.getParameter(this.TEXTURE_BINDING_2D);
      const result = Reflect.apply(originalTexImage2D, this, args);
      if (args[2] === this.R8) {
        textureMirrors.set(texture, {
          bytes: new Uint8Array(args[3] * args[4]),
          width: args[3],
        });
        r8Allocations.push(texture);
      }
      return result;
    };
    prototype.texSubImage2D = function (...args) {
      const texture = this.getParameter(this.TEXTURE_BINDING_2D);
      const result = Reflect.apply(originalTexSubImage2D, this, args);
      const mirror = textureMirrors.get(texture);
      if (
        mirror &&
        args[6] === this.RED &&
        args[7] === this.UNSIGNED_BYTE &&
        args[8] instanceof Uint8Array
      ) {
        const x = args[2];
        const y = args[3];
        const width = args[4];
        const height = args[5];
        const sourceOffset = args.length > 9 ? args[9] : 0;
        for (let row = 0; row < height; row++) {
          mirror.bytes.set(
            args[8].subarray(
              sourceOffset + row * width,
              sourceOffset + (row + 1) * width,
            ),
            (y + row) * mirror.width + x,
          );
        }
      }
      if (
        injectNextVisibilityUpload &&
        texture === failureTexture
      ) {
        injectNextVisibilityUpload = false;
        injectedFailure = true;
        syntheticErrorPending = true;
      }
      return result;
    };
    prototype.getError = function (...args) {
      if (syntheticErrorPending) {
        syntheticErrorPending = false;
        return this.OUT_OF_MEMORY;
      }
      return Reflect.apply(originalGetError, this, args);
    };
    prototype.deleteTexture = function (texture) {
      deletedTextures.add(texture);
      return Reflect.apply(originalDeleteTexture, this, [texture]);
    };

    try {
      const pointCount = viewer.getPointCount();
      const positions = viewer.getViewPositions('live');
      viewer.setupEdgesV2({
        sources: Uint32Array.from([0, 1]),
        destinations: Uint32Array.from([1, 2]),
        weights: Float64Array.from([1, 0.5]),
        nEdges: 2,
        nCells: pointCount,
      }, positions);
      let liveTexture = r8Allocations.at(-1);

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
      snapshotTexture = r8Allocations.at(-1);
      failureTexture = snapshotTexture;

      const baseline = new Float32Array(pointCount);
      baseline.fill(1);
      baseline[0] = 0;
      viewer.updateSnapshotAttributes(snapshot.id, {
        transparency: baseline,
      });
      const baselineBytes = Array.from(
        textureMirrors.get(snapshotTexture).bytes.subarray(0, 3),
      );

      const candidate = new Float32Array(pointCount);
      candidate.fill(1);
      candidate[1] = 0;
      injectNextVisibilityUpload = true;
      let publicationError = null;
      try {
        viewer.updateSnapshotAttributes(snapshot.id, {
          transparency: candidate,
        });
      } catch (error) {
        publicationError = error.message;
      }

      const restoredTexture = r8Allocations.at(-1);
      const stateAfterFailure = Array.from(
        viewer.getViewTransparency(snapshot.id).subarray(0, 3),
      );
      const bytesAfterFailure = Array.from(
        textureMirrors.get(restoredTexture).bytes.subarray(0, 3),
      );
      const failedTextureRetired = deletedTextures.has(snapshotTexture);
      const edgeInventoryRestored =
        viewer.hasEdgeTexturesForView(snapshot.id);

      snapshotTexture = restoredTexture;
      const retryResult = viewer.updateSnapshotAttributes(snapshot.id, {
        transparency: candidate,
      });
      const stateAfterRetry = Array.from(
        viewer.getViewTransparency(snapshot.id).subarray(0, 3),
      );
      const bytesAfterRetry = Array.from(
        textureMirrors.get(snapshotTexture).bytes.subarray(0, 3),
      );

      const liveBaseline = new Float32Array(pointCount);
      liveBaseline.fill(1);
      liveBaseline[0] = 0;
      const liveStateOwner = state.categoryTransparency;
      liveStateOwner.set(liveBaseline);
      viewer.updateTransparency(liveStateOwner);
      const liveBaselineBytes = Array.from(
        textureMirrors.get(liveTexture).bytes.subarray(0, 3),
      );

      const liveCandidate = new Float32Array(pointCount);
      liveCandidate.fill(1);
      liveCandidate[2] = 0;
      failureTexture = liveTexture;
      injectNextVisibilityUpload = true;
      let livePublicationError = null;
      try {
        liveStateOwner.set(liveCandidate);
        viewer.updateTransparency(liveStateOwner);
      } catch (error) {
        livePublicationError = error.message;
      }
      const restoredLiveTexture = liveTexture;
      const liveStateAfterFailure = Array.from(
        viewer.getViewTransparency('live').subarray(0, 3),
      );
      const applicationStateAfterFailure = Array.from(
        liveStateOwner.subarray(0, 3),
      );
      const liveBytesAfterFailure = Array.from(
        textureMirrors.get(restoredLiveTexture).bytes.subarray(0, 3),
      );
      const failedLiveTextureRetired =
        deletedTextures.has(liveTexture);
      liveTexture = restoredLiveTexture;
      liveStateOwner.set(liveCandidate);
      const liveRetryResult = viewer.updateTransparency(liveStateOwner);
      const liveStateAfterRetry = Array.from(
        viewer.getViewTransparency('live').subarray(0, 3),
      );
      const liveBytesAfterRetry = Array.from(
        textureMirrors.get(liveTexture).bytes.subarray(0, 3),
      );

      const alphaTexture = viewer.getHPRenderer().getAlphaTexture();
      const alphaCandidate = new Float32Array(pointCount);
      alphaCandidate.fill(1);
      alphaCandidate[1] = 0;
      failureTexture = alphaTexture;
      injectNextVisibilityUpload = true;
      let alphaPublicationError = null;
      try {
        liveStateOwner.set(alphaCandidate);
        viewer.updateTransparency(liveStateOwner);
      } catch (error) {
        alphaPublicationError = error.message;
      }
      const alphaStateAfterFailure = Array.from(
        viewer.getViewTransparency('live').subarray(0, 3),
      );
      const alphaApplicationStateAfterFailure = Array.from(
        liveStateOwner.subarray(0, 3),
      );
      const alphaConnectivityAfterFailure = Array.from(
        textureMirrors.get(liveTexture).bytes.subarray(0, 3),
      );
      liveStateOwner.set(alphaCandidate);
      viewer.updateTransparency(liveStateOwner);
      const alphaStateAfterRetry = Array.from(
        viewer.getViewTransparency('live').subarray(0, 3),
      );
      const alphaConnectivityAfterRetry = Array.from(
        textureMirrors.get(liveTexture).bytes.subarray(0, 3),
      );

      return {
        alphaApplicationStateAfterFailure,
        alphaConnectivityAfterFailure,
        alphaConnectivityAfterRetry,
        alphaPublicationError,
        alphaStateAfterFailure,
        alphaStateAfterRetry,
        applicationStateAfterFailure,
        baselineBytes,
        bytesAfterFailure,
        bytesAfterRetry,
        edgeInventoryRestored,
        failedTextureRetired,
        glError: gl.getError(),
        injectedFailure,
        failedLiveTextureRetired,
        liveBaselineBytes,
        liveBytesAfterFailure,
        liveBytesAfterRetry,
        livePublicationError,
        liveRetryResult,
        liveStateAfterFailure,
        liveStateAfterRetry,
        publicationError,
        retryResult,
        stateAfterFailure,
        stateAfterRetry,
      };
    } finally {
      prototype.deleteTexture = originalDeleteTexture;
      prototype.getError = originalGetError;
      prototype.texImage2D = originalTexImage2D;
      prototype.texSubImage2D = originalTexSubImage2D;
    }
  });

  expect(proof.baselineBytes).toEqual([0, 255, 255]);
  expect(proof.injectedFailure).toBe(true);
  expect(proof.publicationError).toMatch(
    /weighted connectivity visibility update.*WebGL error/i,
  );
  expect(proof.failedTextureRetired).toBe(false);
  expect(proof.edgeInventoryRestored).toBe(true);
  expect(proof.stateAfterFailure).toEqual([0, 1, 1]);
  expect(proof.bytesAfterFailure).toEqual([0, 255, 255]);
  expect(proof.retryResult).toBe(true);
  expect(proof.stateAfterRetry).toEqual([1, 0, 1]);
  expect(proof.bytesAfterRetry).toEqual([255, 0, 255]);
  expect(proof.liveBaselineBytes).toEqual([0, 255, 255]);
  expect(proof.livePublicationError).toMatch(
    /weighted connectivity visibility update.*WebGL error/i,
  );
  expect(proof.failedLiveTextureRetired).toBe(false);
  expect(proof.liveStateAfterFailure).toEqual([0, 1, 1]);
  expect(proof.applicationStateAfterFailure).toEqual([0, 1, 1]);
  expect(proof.liveBytesAfterFailure).toEqual([0, 255, 255]);
  expect(proof.liveRetryResult).toBeUndefined();
  expect(proof.liveStateAfterRetry).toEqual([1, 1, 0]);
  expect(proof.liveBytesAfterRetry).toEqual([255, 255, 0]);
  expect(proof.alphaPublicationError).toMatch(
    /alpha-value publication.*WebGL error/i,
  );
  expect(proof.alphaStateAfterFailure).toEqual([1, 1, 0]);
  expect(proof.alphaApplicationStateAfterFailure).toEqual([1, 1, 0]);
  expect(proof.alphaConnectivityAfterFailure).toEqual([255, 255, 0]);
  expect(proof.alphaStateAfterRetry).toEqual([1, 0, 1]);
  expect(proof.alphaConnectivityAfterRetry).toEqual([255, 0, 255]);
  expect(proof.glError).toBe(0);
  expect(pageErrors).toEqual([]);
  expect(responseFailures).toEqual([]);
  expect(consoleDiagnostics).toEqual([]);
});
