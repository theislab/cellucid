import { expect, test } from '@playwright/test';

import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=highlight-geometry-generation-ci';

async function installHighlightUploadAudit(page) {
  await page.addInitScript(() => {
    const prototype = WebGL2RenderingContext.prototype;
    const originalBufferData = prototype.bufferData;
    const originalGetError = prototype.getError;
    let active = false;
    let failNextUpload = false;
    let records = [];
    const syntheticErrors = new WeakMap();

    const copyClientBytes = source => {
      if (source instanceof ArrayBuffer) {
        return new Uint8Array(source).slice();
      }
      if (ArrayBuffer.isView(source)) {
        return new Uint8Array(
          source.buffer,
          source.byteOffset,
          source.byteLength,
        ).slice();
      }
      return null;
    };

    prototype.bufferData = function (...args) {
      const [target, source, usage] = args;
      if (
        active &&
        target === this.ARRAY_BUFFER &&
        usage === this.DYNAMIC_DRAW
      ) {
        const bytes = copyClientBytes(source);
        if (bytes?.byteLength === 16) {
          const failed = failNextUpload;
          failNextUpload = false;
          records.push(Object.freeze({
            bytes: Object.freeze(Array.from(bytes)),
            failed,
          }));
          if (failed) {
            let errors = syntheticErrors.get(this);
            if (errors === undefined) {
              errors = [];
              syntheticErrors.set(this, errors);
            }
            errors.push(this.OUT_OF_MEMORY);
            return undefined;
          }
        }
      }
      return Reflect.apply(originalBufferData, this, args);
    };
    prototype.getError = function (...args) {
      const errors = syntheticErrors.get(this);
      if (errors?.length > 0) {
        return errors.shift();
      }
      return Reflect.apply(originalGetError, this, args);
    };

    Object.defineProperty(window, '__cellucidHighlightUploadAudit', {
      configurable: false,
      value: Object.freeze({
        reset() {
          records = [];
          active = true;
        },
        failNextUpload() {
          failNextUpload = true;
        },
        snapshot() {
          return records.map(record => ({
            bytes: [...record.bytes],
            failed: record.failed,
          }));
        },
        stop() {
          active = false;
          return this.snapshot();
        },
      }),
      writable: false,
    });
  });
}

test('highlight upload follows exact same-reference geometry generations', async ({
  page,
}) => {
  const pageErrors = [];
  const consoleDiagnostics = [];
  const responseFailures = [];
  const requestFailures = [];

  page.on('pageerror', error => {
    pageErrors.push(error.stack || error.message);
  });
  page.on('console', message => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const diagnostic = `${message.type()}: ${message.text()}`;
    if (!/GPU stall due to ReadPixels/i.test(diagnostic)) {
      consoleDiagnostics.push(diagnostic);
    }
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      responseFailures.push(
        `${response.status()} ${response.request().method()} ${response.url()}`,
      );
    }
  });
  page.on('requestfailed', request => {
    requestFailures.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
    );
  });

  await installHighlightUploadAudit(page);
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );

  const proof = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const renderer = viewer.getHPRenderer();
    const audit = window.__cellucidHighlightUploadAudit;
    const gl = viewer.getGLContext();
    const targetPoint = 1;
    const targetOffset = targetPoint * 3;
    const lodEvents = [];
    const lodObserverDiagnostics = [];

    const waitFrames = async count => {
      for (let frame = 0; frame < count; frame++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    };
    const waitForUploadCount = async expectedCount => {
      for (let frame = 0; frame < 120; frame++) {
        if (audit.snapshot().length >= expectedCount) return;
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      throw new Error(
        `Timed out waiting for ${expectedCount} exact highlight uploads.`,
      );
    };
    const legacySparsePositionFingerprints = positions => {
      const len = positions.length;
      const step = Math.max(3, Math.floor(len / 300)) * 3;
      let rendererSum = 0;
      let toolsSum = 0;
      for (let offset = 0; offset < len; offset += step) {
        rendererSum +=
          positions[offset] +
          positions[offset + 1] +
          positions[offset + 2];
        toolsSum += positions[offset];
      }
      const pointCount = len / 3;
      const q1 = Math.floor(pointCount * 0.25) * 3;
      const mid = Math.floor(pointCount * 0.5) * 3;
      const q3 = Math.floor(pointCount * 0.75) * 3;
      const last = len - 3;
      return [
        len * 31 + rendererSum,
        `${positions[0]},${positions[1]},${positions[2]},` +
          `${positions[q1]},${positions[mid]},${positions[q3]},` +
          `${positions[last]},${positions[last + 1]},` +
          `${positions[last + 2]},${toolsSum.toFixed(2)},${len}`,
      ];
    };
    const decodeUpload = record => {
      const bytes = Uint8Array.from(record.bytes);
      const xyz = new Float32Array(bytes.buffer, 0, 3);
      return {
        rgba: Array.from(bytes.subarray(12, 16)),
        xyz: Array.from(xyz),
      };
    };

    viewer.pause();
    viewer.setAdaptiveLOD(false);
    viewer.setForceLOD(0);
    viewer.setFrustumCulling(false);
    const initialGlError = gl.getError();
    const positions = renderer.getPositions();
    const dimensionLevel = viewer.getViewDimension('live');
    const initialGeneration =
      renderer.getViewGeometryGeneration('live');
    const initialXyz = Array.from(
      positions.subarray(targetOffset, targetOffset + 3),
    );
    const highlightData = new Uint8Array(viewer.getPointCount());
    highlightData[targetPoint] = 255;

    audit.reset();
    viewer.updateHighlight(highlightData, [targetPoint]);
    viewer.resume();
    await waitForUploadCount(1);
    viewer.pause();
    const firstUploads = audit.snapshot();

    viewer.resume();
    await waitFrames(4);
    viewer.pause();
    const stableFirstUploads = audit.snapshot();
    const stableFirstGeneration =
      renderer.getViewGeometryGeneration('live');
    lodEvents.length = 0;
    const originalConsoleError = console.error;
    console.error = (...args) => {
      if (
        args[0] ===
          '[Viewer] LOD change observer failed.'
      ) {
        lodObserverDiagnostics.push(
          args[1]?.message ?? String(args[1]),
        );
        return;
      }
      Reflect.apply(originalConsoleError, console, args);
    };
    const unsubscribeThrowingLod =
      viewer.onLodChanged(() => {
        throw new Error(
          'synthetic first LOD observer failure',
        );
      });
    const unsubscribeLod = viewer.onLodChanged(event => {
      lodEvents.push({
        dimensionLevel: event.dimensionLevel,
        geometryGeneration: event.geometryGeneration,
        lodLevel: event.lodLevel,
        viewId: event.viewId,
      });
    });

    const rendererOwnedPositions = renderer.getPositions();
    const legacyFingerprintsBefore =
      legacySparsePositionFingerprints(rendererOwnedPositions);
    const replacementY = Math.fround(901);
    rendererOwnedPositions[targetOffset + 1] = replacementY;
    const legacyFingerprintsAfter =
      legacySparsePositionFingerprints(rendererOwnedPositions);
    const sameReferenceBeforePublication =
      renderer.getPositions() === rendererOwnedPositions;

    viewer.updatePositions(rendererOwnedPositions, dimensionLevel);
    const replacementGeneration =
      renderer.getViewGeometryGeneration('live');
    const postPublicationProjection = renderer.getPositions();
    const detachedProjectionAfterPublication =
      postPublicationProjection !== rendererOwnedPositions;
    const stableProjectionAfterPublication =
      renderer.getPositions() === postPublicationProjection;
    const projectedReplacementY =
      postPublicationProjection[targetOffset + 1];

    viewer.resume();
    await waitForUploadCount(2);
    viewer.pause();
    const secondUploads = audit.snapshot();

    viewer.resume();
    await waitFrames(4);
    viewer.pause();
    const stableSecondUploads = audit.stop();
    const stableSecondGeneration =
      renderer.getViewGeometryGeneration('live');
    const finalGlError = gl.getError();
    unsubscribeThrowingLod();
    unsubscribeLod();
    await Promise.resolve();
    console.error = originalConsoleError;

    return {
      finalGlError,
      first: decodeUpload(firstUploads[0]),
      firstUploadCount: firstUploads.length,
      initialGeneration,
      initialGlError,
      initialXyz,
      detachedProjectionAfterPublication,
      legacyFingerprintsAfter,
      legacyFingerprintsBefore,
      lodEvents,
      lodObserverDiagnostics,
      projectedReplacementY,
      replacementGeneration,
      replacementY,
      sameReferenceBeforePublication,
      stableProjectionAfterPublication,
      second: decodeUpload(secondUploads[1]),
      secondUploadCount: secondUploads.length,
      stableFirstGeneration,
      stableFirstUploadCount: stableFirstUploads.length,
      stableSecondGeneration,
      stableSecondUploadCount: stableSecondUploads.length,
    };
  });

  expect(proof.initialGlError).toBe(0);
  expect(proof.finalGlError).toBe(0);
  expect(proof.firstUploadCount).toBe(1);
  expect(proof.first.xyz).toEqual(proof.initialXyz);
  expect(proof.first.rgba).toEqual([255, 255, 255, 255]);

  expect(proof.stableFirstGeneration).toBe(proof.initialGeneration);
  expect(proof.stableFirstUploadCount).toBe(1);
  expect(proof.legacyFingerprintsAfter).toEqual(
    proof.legacyFingerprintsBefore,
  );
  expect(proof.sameReferenceBeforePublication).toBe(true);
  expect(proof.detachedProjectionAfterPublication).toBe(true);
  expect(proof.stableProjectionAfterPublication).toBe(true);
  expect(proof.projectedReplacementY).toBe(proof.replacementY);
  expect(proof.replacementGeneration).not.toBe(proof.initialGeneration);
  expect(proof.lodEvents).toContainEqual({
    dimensionLevel: 2,
    geometryGeneration: proof.replacementGeneration,
    lodLevel: -1,
    viewId: 'live',
  });
  expect(proof.lodObserverDiagnostics).toEqual([
    'synthetic first LOD observer failure',
  ]);

  expect(proof.secondUploadCount).toBe(2);
  expect(proof.second.xyz).toEqual([
    proof.initialXyz[0],
    proof.replacementY,
    proof.initialXyz[2],
  ]);
  expect(proof.second.rgba).toEqual([255, 255, 255, 255]);
  expect(proof.stableSecondGeneration).toBe(proof.replacementGeneration);
  expect(proof.stableSecondUploadCount).toBe(2);

  expect(pageErrors).toEqual([]);
  expect(consoleDiagnostics).toEqual([]);
  expect(responseFailures).toEqual([]);
  expect(requestFailures).toEqual([]);
});

test('highlight OOM is report-once, pane-local, and recovers on a semantic generation', async ({
  page,
}) => {
  const pageErrors = [];
  const consoleDiagnostics = [];
  const responseFailures = [];
  const requestFailures = [];

  page.on('pageerror', error => {
    pageErrors.push(error.stack || error.message);
  });
  page.on('console', message => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const diagnostic = `${message.type()}: ${message.text()}`;
    if (!/GPU stall due to ReadPixels/i.test(diagnostic)) {
      consoleDiagnostics.push(diagnostic);
    }
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      responseFailures.push(
        `${response.status()} ${response.request().method()} ${response.url()}`,
      );
    }
  });
  page.on('requestfailed', request => {
    requestFailures.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
    );
  });

  await installHighlightUploadAudit(page);
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );

  const proof = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const audit = window.__cellucidHighlightUploadAudit;
    const payload = state.getSnapshotPayload();
    const reports = [];
    const waitFrames = async count => {
      for (let frame = 0; frame < count; frame++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    };
    const waitForUploadCount = async expectedCount => {
      for (let frame = 0; frame < 120; frame++) {
        if (audit.snapshot().length >= expectedCount) return;
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      throw new Error(
        `Timed out waiting for ${expectedCount} highlight upload attempts.`,
      );
    };

    viewer.pause();
    viewer.setAdaptiveLOD(false);
    viewer.setForceLOD(0);
    viewer.setFrustumCulling(false);
    const snapshot = viewer.createSnapshotView({
      label: 'Highlight OOM later pane',
      fieldKey: payload.fieldKey,
      fieldKind: payload.fieldKind,
      colors: payload.colors,
      transparency: payload.transparency,
      centroidPositions: payload.centroidPositions,
      centroidColors: payload.centroidColors,
      dimensionLevel: payload.dimensionLevel,
      sourceViewId: 'live',
      meta: { filtersText: payload.filtersText },
      cameraState: viewer.getViewCameraState('live'),
    });
    viewer.setHighlightRenderFailureHandler((error, viewId) => {
      reports.push({
        message: error.message,
        viewId,
      });
    });

    const highlightData = new Uint8Array(viewer.getPointCount());
    highlightData[1] = 255;
    audit.reset();
    viewer.updateHighlight(highlightData, [1]);
    viewer.resume();
    await waitForUploadCount(2);
    viewer.pause();
    const baseline = audit.snapshot();

    // Republish both panes while paused, then fail only the first compact
    // highlight upload. The snapshot pane must still reach its own upload.
    viewer.updateTransparency(
      new Float32Array(payload.transparency),
    );
    viewer.updateSnapshotAttributes(snapshot.id, {
      transparency: new Float32Array(payload.transparency),
    });
    audit.failNextUpload();
    viewer.resume();
    await waitForUploadCount(4);
    await waitFrames(4);
    viewer.pause();
    const afterFailure = audit.snapshot();
    const stableFailureReportCount = reports.length;

    // A new live filtering generation is a meaningful retry boundary.
    viewer.updateTransparency(
      new Float32Array(payload.transparency),
    );
    viewer.resume();
    await waitForUploadCount(5);
    await waitFrames(3);
    viewer.pause();
    const recovered = audit.stop();
    const finalGlError = viewer.getGLContext().getError();

    return {
      afterFailure,
      baseline,
      finalGlError,
      recovered,
      reports,
      snapshotId: snapshot.id,
      stableFailureReportCount,
    };
  });

  expect(proof.baseline).toHaveLength(2);
  expect(proof.baseline.every(record => record.failed === false)).toBe(true);
  expect(proof.afterFailure).toHaveLength(4);
  expect(proof.afterFailure[2].failed).toBe(true);
  expect(
    proof.afterFailure[3].failed,
    'the later snapshot pane must still publish after live-view OOM',
  ).toBe(false);
  expect(proof.stableFailureReportCount).toBe(1);
  expect(proof.reports).toHaveLength(1);
  expect(proof.reports[0].viewId).toBe('live');
  expect(proof.reports[0].message).toMatch(/0x505/i);
  expect(proof.recovered).toHaveLength(5);
  expect(proof.recovered[4].failed).toBe(false);
  expect(proof.finalGlError).toBe(0);

  expect(pageErrors).toEqual([]);
  expect(consoleDiagnostics).toEqual([]);
  expect(responseFailures).toEqual([]);
  expect(requestFailures).toEqual([]);
});
