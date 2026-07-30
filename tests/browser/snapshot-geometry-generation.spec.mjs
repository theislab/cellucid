import { expect, test } from '@playwright/test';

import { dismissWelcome } from './helpers/welcome.mjs';

test('same-reference live publication preserves immutable kept-view geometry', async ({ page }) => {
  const browserErrors = [];
  const consoleDiagnostics = [];
  const responseFailures = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      const diagnostic = `${message.type()}: ${message.text()}`;
      if (!/GPU stall due to ReadPixels/i.test(diagnostic)) {
        consoleDiagnostics.push(diagnostic);
      }
    }
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      responseFailures.push(
        `${response.status()} ${response.request().method()} ${response.url()}`,
      );
    }
  });

  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=snapshot-geometry-generation-ci',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );

  const publication = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const ui = window._cellucidUi;
    const renderer = viewer.getHPRenderer();
    const payload = state.getSnapshotPayload();
    const makeConfig = label => ({
      label,
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

    const first = ui.publishSnapshotView(makeConfig('Frozen 1'));
    const second = ui.publishSnapshotView(makeConfig('Frozen 2'));
    const firstSnapshot = renderer.snapshotBuffers.get(first.id);
    const secondSnapshot = renderer.snapshotBuffers.get(second.id);
    const frozenGeneration =
      renderer.getViewGeometryGeneration(first.id);
    const initialLiveGeneration =
      renderer.getViewGeometryGeneration('live');
    const geometry =
      renderer._snapshotGeometryPools.get(frozenGeneration);
    const livePositions = viewer.getViewPositions('live');
    const firstPositions = viewer.getViewPositions(first.id);
    const secondPositions = viewer.getViewPositions(second.id);
    const frozenFirstValue = firstPositions[0];
    firstPositions[0] = frozenFirstValue + 500;
    const publicMutationIsolated =
      viewer.getViewPositions(first.id)[0] === frozenFirstValue &&
      viewer.getViewPositions(second.id)[0] === frozenFirstValue;
    const internalCopiesShared =
      firstSnapshot.positions === secondSnapshot.positions;

    livePositions[0] = frozenFirstValue + 100;
    const expectedLiveFirstValue = livePositions[0];
    viewer.updatePositions(
      livePositions,
      viewer.getViewDimension('live'),
    );
    viewer.setAdaptiveLOD(true);
    viewer.setFrustumCulling(true);
    viewer.setForceLOD(0);
    viewer.setViewLayout('grid', 'live');

    await new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });

    const gl = document.querySelector('#glcanvas').getContext('webgl2');
    const firstLodMembership = viewer.getCurrentLodMembership(
      first.id,
      viewer.getViewDimension(first.id),
    );
    const secondLodMembership = viewer.getCurrentLodMembership(
      second.id,
      viewer.getViewDimension(second.id),
    );
    const inspectSnapshotVao = snapshot => {
      const previousVao =
        gl.getParameter(gl.VERTEX_ARRAY_BINDING);
      gl.bindVertexArray(snapshot.vao);
      const attributes = [0, 1].map(index => ({
        buffer: gl.getVertexAttrib(
          index,
          gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING,
        ),
        offset: gl.getVertexAttribOffset(
          index,
          gl.VERTEX_ATTRIB_ARRAY_POINTER,
        ),
        stride: gl.getVertexAttrib(
          index,
          gl.VERTEX_ATTRIB_ARRAY_STRIDE,
        ),
      }));
      gl.bindVertexArray(previousVao);
      return attributes;
    };
    const firstAttributes = inspectSnapshotVao(firstSnapshot);
    const secondAttributes = inspectSnapshotVao(secondSnapshot);
    return {
      firstId: first.id,
      internalCopiesShared,
      gpuPositionsShared:
        geometry.positionBuffer !== null &&
        firstAttributes[0].buffer === geometry.positionBuffer &&
        secondAttributes[0].buffer === geometry.positionBuffer,
      colorsIndependent:
        firstSnapshot.buffer !== secondSnapshot.buffer &&
        firstAttributes[1].buffer === firstSnapshot.buffer &&
        secondAttributes[1].buffer === secondSnapshot.buffer,
      splitAttributeLayout: {
        firstPosition: {
          offset: firstAttributes[0].offset,
          stride: firstAttributes[0].stride,
        },
        firstColor: {
          offset: firstAttributes[1].offset,
          stride: firstAttributes[1].stride,
        },
        secondPosition: {
          offset: secondAttributes[0].offset,
          stride: secondAttributes[0].stride,
        },
        secondColor: {
          offset: secondAttributes[1].offset,
          stride: secondAttributes[1].stride,
        },
      },
      splitByteOwnership: {
        firstColor: firstSnapshot.bufferByteLength,
        secondColor: secondSnapshot.bufferByteLength,
        positions: geometry.positionBufferByteLength,
        expectedColor: firstSnapshot.pointCount * 3,
        expectedPositions: firstSnapshot.pointCount * 12,
      },
      generationLifecycle: {
        first: renderer.getViewGeometryGeneration(first.id),
        second: renderer.getViewGeometryGeneration(second.id),
        frozen: frozenGeneration,
        initialLive: initialLiveGeneration,
        replacedLive: renderer.getViewGeometryGeneration('live'),
      },
      publicCopiesIndependent: firstPositions !== secondPositions,
      publicMutationIsolated,
      frozenFirstValue,
      expectedLiveFirstValue,
      liveFirstValue: viewer.getViewPositions('live')[0],
      firstSnapshotValue: viewer.getViewPositions(first.id)[0],
      secondSnapshotValue: viewer.getViewPositions(second.id)[0],
      firstHasStats: viewer.hasRendererStats(first.id),
      secondHasStats: viewer.hasRendererStats(second.id),
      firstLodLevel: viewer.getCurrentLODLevel(first.id),
      secondLodLevel: viewer.getCurrentLODLevel(second.id),
      firstLodIndicesAvailable:
        firstLodMembership?.admissionLevels instanceof Uint8Array &&
        firstLodMembership.admissionLevels.some(
          level => level <= firstLodMembership.lodLevel,
        ),
      secondLodIndicesAvailable:
        secondLodMembership?.admissionLevels instanceof Uint8Array &&
        secondLodMembership.admissionLevels.some(
          level => level <= secondLodMembership.lodLevel,
        ),
      lodMembershipShared:
        firstLodMembership === secondLodMembership,
      glError: gl.getError(),
    };
  });

  expect(publication.internalCopiesShared).toBe(true);
  expect(publication.gpuPositionsShared).toBe(true);
  expect(publication.colorsIndependent).toBe(true);
  expect(publication.splitAttributeLayout).toEqual({
    firstPosition: { offset: 0, stride: 12 },
    firstColor: { offset: 0, stride: 3 },
    secondPosition: { offset: 0, stride: 12 },
    secondColor: { offset: 0, stride: 3 },
  });
  expect(publication.splitByteOwnership).toEqual({
    firstColor: publication.splitByteOwnership.expectedColor,
    secondColor: publication.splitByteOwnership.expectedColor,
    positions: publication.splitByteOwnership.expectedPositions,
    expectedColor: publication.splitByteOwnership.expectedColor,
    expectedPositions:
      publication.splitByteOwnership.expectedPositions,
  });
  expect(publication.generationLifecycle.first).toBe(
    publication.generationLifecycle.frozen,
  );
  expect(publication.generationLifecycle.second).toBe(
    publication.generationLifecycle.frozen,
  );
  expect(publication.generationLifecycle.initialLive).toBe(
    publication.generationLifecycle.frozen,
  );
  expect(publication.generationLifecycle.replacedLive).not.toBe(
    publication.generationLifecycle.frozen,
  );
  expect(publication.publicCopiesIndependent).toBe(true);
  expect(publication.publicMutationIsolated).toBe(true);
  expect(publication.liveFirstValue).toBe(
    publication.expectedLiveFirstValue,
  );
  expect(publication.firstSnapshotValue).toBe(
    publication.frozenFirstValue,
  );
  expect(publication.secondSnapshotValue).toBe(
    publication.frozenFirstValue,
  );
  expect(publication.firstHasStats).toBe(true);
  expect(publication.secondHasStats).toBe(true);
  expect(publication.firstLodLevel).toBe(0);
  expect(publication.secondLodLevel).toBe(0);
  expect(publication.firstLodIndicesAvailable).toBe(true);
  expect(publication.secondLodIndicesAvailable).toBe(true);
  expect(publication.lodMembershipShared).toBe(true);
  expect(publication.glError).toBe(0);
  expect(browserErrors).toEqual([]);
  expect(consoleDiagnostics).toEqual([]);
  expect(responseFailures).toEqual([]);
});

test('snapshot cleanup errors cannot leave viewer inventory half-published', async ({ page }) => {
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=snapshot-cleanup-generation-ci',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );

  const outcome = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const ui = window._cellucidUi;
    const renderer = viewer.getHPRenderer();
    const payload = state.getSnapshotPayload();
    const makeConfig = label => ({
      label,
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
    const first = ui.publishSnapshotView(makeConfig('Cleanup 1'));
    const second = ui.publishSnapshotView(makeConfig('Cleanup 2'));
    viewer.setViewLayout('grid', first.id);

    const originalDelete = renderer.deleteSnapshotBuffer.bind(renderer);
    renderer.deleteSnapshotBuffer = id => {
      originalDelete(id);
      throw new Error('synthetic single retirement report');
    };
    let removeError = null;
    try {
      viewer.removeSnapshotView(first.id);
    } catch (error) {
      removeError = {
        name: error.name,
        messages: error.errors.map(entry => entry.message),
      };
    } finally {
      renderer.deleteSnapshotBuffer = originalDelete;
    }

    const afterRemove = {
      inventory: viewer.getSnapshotViews().map(entry => entry.id),
      rendererHasFirst: renderer.hasSnapshotBuffer(first.id),
      layout: viewer.getViewLayout(),
      firstPositionsRetired: (() => {
        try {
          viewer.getViewPositions(first.id);
          return false;
        } catch {
          return true;
        }
      })(),
    };

    const originalDeleteAll =
      renderer.deleteAllSnapshotBuffers.bind(renderer);
    renderer.deleteAllSnapshotBuffers = () => {
      originalDeleteAll();
      throw new Error('synthetic all retirement report');
    };
    let clearError = null;
    try {
      viewer.clearSnapshotViews();
    } catch (error) {
      clearError = {
        name: error.name,
        messages: error.errors.map(entry => entry.message),
      };
    } finally {
      renderer.deleteAllSnapshotBuffers = originalDeleteAll;
    }

    const result = {
      firstId: first.id,
      secondId: second.id,
      removeError,
      afterRemove,
      clearError,
      finalInventory: viewer.getSnapshotViews(),
      finalHasSnapshots: viewer.hasSnapshots(),
      rendererHasSecond: renderer.hasSnapshotBuffer(second.id),
      secondPositionsRetired: (() => {
        try {
          viewer.getViewPositions(second.id);
          return false;
        } catch {
          return true;
        }
      })(),
      finalLayout: viewer.getViewLayout(),
    };
    // The raw viewer retirements above deliberately exercise renderer cleanup
    // failure contracts. Reconcile application ownership after recording them.
    ui.clearSnapshotViews();
    return result;
  });

  expect(outcome.removeError).toEqual({
    name: 'AggregateError',
    messages: ['synthetic single retirement report'],
  });
  expect(outcome.afterRemove.inventory).toEqual([outcome.secondId]);
  expect(outcome.afterRemove.rendererHasFirst).toBe(false);
  expect(outcome.afterRemove.firstPositionsRetired).toBe(true);
  expect(outcome.afterRemove.layout.activeId).toBe('live');
  expect(outcome.clearError).toEqual({
    name: 'AggregateError',
    messages: ['synthetic all retirement report'],
  });
  expect(outcome.finalInventory).toEqual([]);
  expect(outcome.finalHasSnapshots).toBe(false);
  expect(outcome.rendererHasSecond).toBe(false);
  expect(outcome.secondPositionsRetired).toBe(true);
  expect(outcome.finalLayout).toEqual({
    mode: 'grid',
    activeId: 'live',
    liveViewHidden: false,
  });
  expect(browserErrors).toEqual([]);
});

test('public retirement repairs hidden-live focus to a surviving snapshot', async ({ page }) => {
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=snapshot-public-retirement-focus-ci',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );

  const outcome = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const ui = window._cellucidUi;
    const payload = state.getSnapshotPayload();
    const makeConfig = label => ({
      label,
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
    const first = ui.publishSnapshotView(makeConfig('Retire active'));
    const second = ui.publishSnapshotView(makeConfig('Survivor'));
    state.setActiveView(first.id);
    viewer.setViewLayout('grid', first.id);
    const categoryFieldIndex = state
      .getFields()
      .findIndex(field => field.kind === 'category');
    if (categoryFieldIndex < 0) {
      throw new Error(
        'Retirement focus fixture requires one loaded category field.',
      );
    }
    await state.ensureFieldLoaded(categoryFieldIndex);
    state.setActiveField(categoryFieldIndex);
    ui.refreshUiAfterStateLoad();
    const beforeControls = {
      categorical: document.querySelector('#categorical-field').value,
      continuous: document.querySelector('#continuous-field').value,
      activeFieldKind: state.getActiveField()?.kind ?? null,
    };
    viewer.setLiveViewHidden(true);

    const remaining = ui.retireSnapshotView(first.id);
    const activeBadges = Array.from(
      document.querySelectorAll('.split-badge.active'),
      badge => badge.textContent,
    );
    return {
      firstId: first.id,
      secondId: second.id,
      remaining: remaining.map(snapshot => snapshot.id),
      stateActive: state.getActiveViewId(),
      layout: viewer.getViewLayout(),
      activeBadges,
      beforeControls,
      afterControls: {
        categorical: document.querySelector('#categorical-field').value,
        continuous: document.querySelector('#continuous-field').value,
        activeFieldKind: state.getActiveField()?.kind ?? null,
      },
      stateHasFirst: state.viewContexts.has(first.id),
      stateHasSecond: state.viewContexts.has(second.id),
      firstDimensionRetired: (() => {
        try {
          state.getDimensionManager().getViewDimension(first.id);
          return false;
        } catch {
          return true;
        }
      })(),
      secondDimension: state
        .getDimensionManager()
        .getViewDimension(second.id),
    };
  });

  expect(outcome.remaining).toEqual([outcome.secondId]);
  expect(outcome.stateActive).toBe(outcome.secondId);
  expect(outcome.layout).toEqual({
    mode: 'grid',
    activeId: outcome.secondId,
    liveViewHidden: true,
  });
  expect(outcome.activeBadges).toHaveLength(1);
  expect(outcome.beforeControls.activeFieldKind).toBe('category');
  expect(outcome.beforeControls.categorical).not.toBe('-1');
  expect(outcome.beforeControls.continuous).toBe('-1');
  expect(outcome.afterControls.activeFieldKind).toBe(null);
  expect(outcome.afterControls.categorical).toBe('-1');
  expect(outcome.afterControls.continuous).toBe('-1');
  expect(outcome.stateHasFirst).toBe(false);
  expect(outcome.stateHasSecond).toBe(true);
  expect(outcome.firstDimensionRetired).toBe(true);
  expect(outcome.secondDimension).toBe(2);
  expect(browserErrors).toEqual([]);
});
