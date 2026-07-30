import { expect, test } from '@playwright/test';

import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=centroid-label-lifecycle-ci';

test.beforeEach(async ({ page }) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
});

test('centroid labels reject element aliasing and roll back hostile staging exactly', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  const proof = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const ui = window._cellucidUi;
    const labelLayer = document.querySelector('#label-layer');
    viewer.setCentroidLabels([], 'live');

    const payload = state.getSnapshotPayload();
    const snapshot = ui.publishSnapshotView({
      label: 'Centroid label ownership',
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

    const oldElement = document.createElement('div');
    oldElement.textContent = 'published-live-label';
    const oldEntry = {
      el: oldElement,
      position: [0, 0, 0],
    };
    viewer.setCentroidLabels([oldEntry], 'live');

    let duplicateError = null;
    try {
      viewer.setCentroidLabels([
        { el: oldElement, position: [0, 0, 0] },
        { el: oldElement, position: [1, 1, 1] },
      ], 'live');
    } catch (error) {
      duplicateError = {
        message: error.message,
        name: error.name,
      };
    }

    let crossViewError = null;
    try {
      viewer.setCentroidLabels([
        { el: oldElement, position: [0, 0, 0] },
      ], snapshot.id);
    } catch (error) {
      crossViewError = {
        message: error.message,
        name: error.name,
      };
    }

    const externalParent = document.createElement('div');
    const before = document.createElement('span');
    const candidateA = document.createElement('div');
    const after = document.createElement('span');
    candidateA.setAttribute('data-view-id', 'external-owner');
    externalParent.append(before, candidateA, after);
    document.body.appendChild(externalParent);
    const candidateB = document.createElement('div');

    const originalAppendChild = labelLayer.appendChild;
    let appendAttempts = 0;
    labelLayer.appendChild = function (element) {
      appendAttempts += 1;
      const result = Reflect.apply(originalAppendChild, this, [element]);
      if (appendAttempts === 2) {
        throw new Error(
          'synthetic centroid candidate append-after-mutation failure',
        );
      }
      return result;
    };
    let stagingError = null;
    try {
      viewer.setCentroidLabels([
        { el: candidateA, position: [1, 0, 0] },
        { el: candidateB, position: [0, 1, 0] },
      ], 'live');
    } catch (error) {
      stagingError = {
        message: error.message,
        name: error.name,
      };
    } finally {
      labelLayer.appendChild = originalAppendChild;
    }

    const externalOrder = Array.from(externalParent.children);
    const rollbackOrphan = document.createElement('div');
    const originalRemoveChild = labelLayer.removeChild;
    labelLayer.appendChild = function (element) {
      const result = Reflect.apply(originalAppendChild, this, [element]);
      if (element === rollbackOrphan) {
        throw new Error('synthetic centroid rollback staging failure');
      }
      return result;
    };
    labelLayer.removeChild = function (element) {
      if (element === rollbackOrphan) {
        throw new Error('synthetic centroid rollback removal failure');
      }
      return Reflect.apply(originalRemoveChild, this, [element]);
    };
    let incompleteRollbackError = null;
    try {
      viewer.setCentroidLabels([
        { el: rollbackOrphan, position: [0, 0, 1] },
      ], 'live');
    } catch (error) {
      incompleteRollbackError = {
        errorCount: error instanceof AggregateError
          ? error.errors.length
          : 0,
        message: error.message,
        name: error.name,
      };
    } finally {
      labelLayer.appendChild = originalAppendChild;
      labelLayer.removeChild = originalRemoveChild;
    }
    const rollbackOrphanHidden = (
      rollbackOrphan.parentNode === labelLayer &&
      rollbackOrphan.style.display === 'none'
    );
    viewer.setCentroidLabels([oldEntry], 'live');
    const rollbackOrphanRetired = rollbackOrphan.parentNode === null;

    const result = {
      appendAttempts,
      candidateAViewId: candidateA.getAttribute('data-view-id'),
      candidateBHasViewId: candidateB.hasAttribute('data-view-id'),
      candidateBParent: candidateB.parentNode,
      crossViewError,
      duplicateError,
      externalOrderRestored: (
        externalOrder[0] === before &&
        externalOrder[1] === candidateA &&
        externalOrder[2] === after
      ),
      incompleteRollbackError,
      oldDataset: oldElement.dataset.viewId,
      oldStillPublished: oldElement.parentNode === labelLayer,
      rollbackOrphanHidden,
      rollbackOrphanRetired,
      snapshotId: snapshot.id,
      stagingError,
    };
    viewer.setCentroidLabels([], 'live');
    ui.retireSnapshotView(snapshot.id);
    externalParent.remove();
    return result;
  });

  expect(proof.duplicateError?.name).toBe('TypeError');
  expect(proof.duplicateError?.message).toMatch(/aliases an element/);
  expect(proof.crossViewError?.name).toBe('TypeError');
  expect(proof.crossViewError?.message).toContain(
    `already owned by view "live"`,
  );
  expect(proof.appendAttempts).toBe(2);
  expect(proof.stagingError?.message).toBe(
    'synthetic centroid candidate append-after-mutation failure',
  );
  expect(proof.oldStillPublished).toBe(true);
  expect(proof.oldDataset).toBe('live');
  expect(proof.externalOrderRestored).toBe(true);
  expect(proof.candidateAViewId).toBe('external-owner');
  expect(proof.candidateBParent).toBeNull();
  expect(proof.candidateBHasViewId).toBe(false);
  expect(proof.incompleteRollbackError?.name).toBe('AggregateError');
  expect(proof.incompleteRollbackError?.message).toMatch(
    /were not published and rollback was incomplete/,
  );
  expect(proof.incompleteRollbackError?.errorCount).toBe(2);
  expect(proof.rollbackOrphanHidden).toBe(true);
  expect(proof.rollbackOrphanRetired).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('centroid replacement commits once, attempts all retirements, and retries exact failures', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  const proof = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const labelLayer = document.querySelector('#label-layer');
    viewer.setCentroidLabels([], 'live');

    const oldA = document.createElement('div');
    const oldB = document.createElement('div');
    const oldAEntry = { el: oldA, position: [0, 0, 0] };
    const oldBEntry = { el: oldB, position: [1, 0, 0] };
    viewer.setCentroidLabels([oldAEntry, oldBEntry], 'live');

    // Published ownership must retain the exact accepted element even if the
    // caller later mutates its record.
    const decoy = document.createElement('div');
    const decoyParent = document.createElement('div');
    decoyParent.appendChild(decoy);
    document.body.appendChild(decoyParent);
    oldAEntry.el = decoy;

    const candidate = document.createElement('div');
    const originalRemoveChild = labelLayer.removeChild;
    const rejectedElements = new Set();
    let retirementAttempts = 0;
    labelLayer.removeChild = function (element) {
      if (
        (element === oldA || element === oldB) &&
        !rejectedElements.has(element)
      ) {
        rejectedElements.add(element);
        retirementAttempts += 1;
        throw new Error(
          `synthetic centroid retirement rejection ${retirementAttempts}`,
        );
      }
      return Reflect.apply(originalRemoveChild, this, [element]);
    };

    let committedRetirementError = null;
    try {
      viewer.setCentroidLabels([
        { el: candidate, position: [0, 1, 0] },
      ], 'live');
    } catch (error) {
      committedRetirementError = {
        errorCount: error instanceof AggregateError
          ? error.errors.length
          : 0,
        message: error.message,
        name: error.name,
      };
    } finally {
      labelLayer.removeChild = originalRemoveChild;
    }

    const committedBeforeRetry = (
      candidate.parentNode === labelLayer &&
      candidate.dataset.viewId === 'live'
    );
    const failedOldHidden = (
      oldA.style.display === 'none' &&
      oldB.style.display === 'none'
    );
    const stableElementRetained = (
      oldA.parentNode === labelLayer &&
      decoy.parentNode === decoyParent
    );

    viewer.setCentroidLabels([
      { el: candidate, position: [0, 1, 0] },
    ], 'live');
    const retrySettled = (
      oldA.parentNode === null &&
      oldB.parentNode === null &&
      candidate.parentNode === labelLayer
    );

    const finalElement = document.createElement('div');
    labelLayer.removeChild = function (element) {
      const result = Reflect.apply(originalRemoveChild, this, [element]);
      if (element === candidate) {
        throw new Error(
          'synthetic centroid delete-then-throw report',
        );
      }
      return result;
    };
    let deleteThenThrowError = null;
    try {
      viewer.setCentroidLabels([
        { el: finalElement, position: [0, 0, 1] },
      ], 'live');
    } catch (error) {
      deleteThenThrowError = error.message;
    } finally {
      labelLayer.removeChild = originalRemoveChild;
    }
    const deleteThenThrowSettled = (
      candidate.parentNode === null &&
      finalElement.parentNode === labelLayer
    );

    viewer.setCentroidLabels([], 'live');
    decoyParent.remove();
    return {
      committedBeforeRetry,
      committedRetirementError,
      deleteThenThrowError,
      deleteThenThrowSettled,
      failedOldHidden,
      retirementAttempts,
      retrySettled,
      stableElementRetained,
    };
  });

  expect(proof.retirementAttempts).toBe(2);
  expect(proof.committedRetirementError?.name).toBe('AggregateError');
  expect(proof.committedRetirementError?.message).toMatch(
    /published, but prior-generation settlement was incomplete/,
  );
  expect(proof.committedRetirementError?.errorCount).toBe(2);
  expect(proof.committedBeforeRetry).toBe(true);
  expect(proof.failedOldHidden).toBe(true);
  expect(proof.stableElementRetained).toBe(true);
  expect(proof.retrySettled).toBe(true);
  expect(proof.deleteThenThrowError).toBeNull();
  expect(proof.deleteThenThrowSettled).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('terminal disposal retains failed centroid DOM owners for a later exact retry', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  const proof = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const labelLayer = document.querySelector('#label-layer');
    viewer.setCentroidLabels([], 'live');
    const first = document.createElement('div');
    const second = document.createElement('div');
    viewer.setCentroidLabels([
      { el: first, position: [0, 0, 0] },
      { el: second, position: [1, 0, 0] },
    ], 'live');

    const originalRemoveChild = labelLayer.removeChild;
    let rejectedRetirements = 0;
    labelLayer.removeChild = function (element) {
      if (element === first || element === second) {
        rejectedRetirements += 1;
        throw new Error(
          `synthetic terminal centroid retirement ${rejectedRetirements}`,
        );
      }
      return Reflect.apply(originalRemoveChild, this, [element]);
    };

    let firstError = null;
    try {
      viewer.dispose();
    } catch (error) {
      const messages = [];
      const collect = value => {
        messages.push(value.message);
        if (value instanceof AggregateError) {
          value.errors.forEach(collect);
        }
      };
      collect(error);
      firstError = {
        messages,
        name: error.name,
      };
    } finally {
      labelLayer.removeChild = originalRemoveChild;
    }

    const pendingHidden = (
      first.parentNode === labelLayer &&
      second.parentNode === labelLayer &&
      first.style.display === 'none' &&
      second.style.display === 'none'
    );
    let secondError = null;
    try {
      viewer.dispose();
    } catch (error) {
      secondError = error.message;
    }
    return {
      firstError,
      pendingHidden,
      rejectedRetirements,
      retiredAfterRetry: (
        first.parentNode === null &&
        second.parentNode === null
      ),
      secondError,
    };
  });

  expect(proof.rejectedRetirements).toBe(2);
  expect(proof.firstError?.name).toBe('AggregateError');
  expect(proof.firstError?.messages).toContain(
    'synthetic terminal centroid retirement 1',
  );
  expect(proof.firstError?.messages).toContain(
    'synthetic terminal centroid retirement 2',
  );
  expect(proof.pendingHidden).toBe(true);
  expect(proof.secondError).toBeNull();
  expect(proof.retiredAfterRetry).toBe(true);
  expect(pageErrors).toEqual([]);
});
