import { expect, test } from './helpers/test.mjs';

import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

test('a thrown grid pane releases scissor before the next scheduled full-frame clear', async ({
  page,
}) => {
  const unexpectedPageErrors = [];
  page.on('pageerror', error => {
    if (
      !error.message.includes(
        'synthetic grid pane render failure',
      )
    ) {
      unexpectedPageErrors.push(
        error.stack || error.message,
      );
    }
  });

  await page.goto(
    `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=render-failure-state-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );

  const result = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const ui = window._cellucidUi;
    const renderer = viewer.getHPRenderer();
    const payload = state.getSnapshotPayload();
    const snapshot = ui.publishSnapshotView({
      cameraState: viewer.getViewCameraState('live'),
      centroidColors: payload.centroidColors,
      centroidPositions: payload.centroidPositions,
      colors: payload.colors,
      dimensionLevel: payload.dimensionLevel,
      fieldKey: payload.fieldKey,
      fieldKind: payload.fieldKind,
      label: 'Failure-state snapshot',
      meta: {
        filtersText: payload.filtersText,
      },
      sourceViewId: 'live',
      transparency: payload.transparency,
    });
    viewer.setViewLayout('grid', 'live');

    await new Promise(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });

    const canvas = document.querySelector('#glcanvas');
    const gl = canvas?.getContext('webgl2');
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error(
        'Grid failure-state acceptance requires WebGL2.',
      );
    }

    const marker = 'synthetic grid pane render failure';
    const originalSnapshotRender =
      renderer.renderWithSnapshot;
    const prototype = WebGL2RenderingContext.prototype;
    const originalClear = prototype.clear;
    const clearRecords = [];
    let armed = true;
    let failureObserved = false;
    let scissorAfterUnwind = null;
    let successfulSnapshotRendersAfterFailure = 0;
    let timeoutId = null;

    const completion = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new Error(
            'Timed out waiting for scheduled-frame recovery.',
          ),
        );
      }, 5000);
      window.addEventListener(
        'error',
        event => {
          if (
            event.error instanceof Error &&
            event.error.message === marker
          ) {
            event.preventDefault();
            failureObserved = true;
            scissorAfterUnwind =
              gl.isEnabled(gl.SCISSOR_TEST);
            requestAnimationFrame(() => {
              resolve();
            });
          }
        },
        { once: true },
      );
    });

    prototype.clear = function (mask) {
      if (this === gl && failureObserved) {
        clearRecords.push({
          mask,
          scissor:
            this.isEnabled(this.SCISSOR_TEST),
        });
      }
      return Reflect.apply(
        originalClear,
        this,
        [mask],
      );
    };
    renderer.renderWithSnapshot = function (
      id,
      params,
    ) {
      if (id === snapshot.id && armed) {
        armed = false;
        throw new Error(marker);
      }
      const renderResult = Reflect.apply(
        originalSnapshotRender,
        this,
        [id, params],
      );
      if (
        id === snapshot.id &&
        failureObserved
      ) {
        successfulSnapshotRendersAfterFailure++;
      }
      return renderResult;
    };

    try {
      await completion;
      return {
        clearRecords,
        finalScissor:
          gl.isEnabled(gl.SCISSOR_TEST),
        fullClearMask:
          gl.COLOR_BUFFER_BIT |
          gl.DEPTH_BUFFER_BIT,
        scissorAfterUnwind,
        successfulSnapshotRendersAfterFailure,
      };
    } finally {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      renderer.renderWithSnapshot =
        originalSnapshotRender;
      prototype.clear = originalClear;
      ui.retireSnapshotView(snapshot.id);
    }
  });

  expect(result.scissorAfterUnwind).toBe(false);
  expect(result.clearRecords.length).toBeGreaterThan(0);
  expect(result.clearRecords[0]).toEqual({
    mask: result.fullClearMask,
    scissor: false,
  });
  expect(
    result.successfulSnapshotRendersAfterFailure,
  ).toBeGreaterThan(0);
  expect(result.finalScissor).toBe(false);
  expect(unexpectedPageErrors).toEqual([]);
});
