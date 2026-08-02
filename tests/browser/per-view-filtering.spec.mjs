import { expect, test } from '@playwright/test';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const PREPARED_DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=per-view-filtering-ci`;

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      errors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return errors;
}

test('side-by-side filters stay with one view and survive coloring changes', async ({ page }, testInfo) => {
  const productErrors = observeProductErrors(page);
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);

  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 points');
  await expect(page.locator('#active-filters-container > div').first()).toContainText(
    'Active filters (selected view only)',
  );
  await page.locator('#active-filter-scope-btn').click();
  await expect(page.locator('#active-filter-scope-tooltip')).toContainText(
    'Filters stay with the selected panel',
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('#active-filter-scope-tooltip')).toBeHidden();

  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('.split-badge')).toHaveCount(2);
  await expect(page.locator('.split-badge.active')).toHaveCount(1);
  await expect(page.locator('#camera-lock-btn')).toBeEnabled();
  await expect(page.locator('#camera-lock-btn')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.locator('#camera-lock-btn').click();
  await expect(page.locator('#camera-lock-btn')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.getCamerasLocked()),
  ).toBe(false);
  await page.locator('#camera-lock-btn').click();
  await expect(page.locator('#camera-lock-btn')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  const alphaRow = page.locator('.legend-item', {
    has: page.locator('.legend-label-main', { hasText: /^alpha$/ }),
  });
  await expect(alphaRow).toHaveCount(1);
  await alphaRow.locator('.legend-checkbox').uncheck();
  await expect(page.locator('#filter-count')).toHaveText('Showing 80 of 120 points');

  await page.locator('#continuous-field').selectOption({ label: 'score' });
  await expect(page.locator('#filter-count')).toHaveText('Showing 80 of 120 points');
  await expect(page.locator('#active-filters')).toContainText('cell_type: hiding alpha');
  await expect(page.locator('#continuous-field option:checked')).toHaveText('score');

  const liveBadge = page.locator('.split-badge').filter({
    has: page.locator('.split-badge-pill', { hasText: /^1$/ }),
  });
  await liveBadge.click();
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 points');
  await expect(page.locator('#active-filters')).toHaveText('No filters active');

  await page.locator('.split-badge').filter({
    has: page.locator('.split-badge-pill', { hasText: /^2$/ }),
  }).click();
  await expect(page.locator('#filter-count')).toHaveText('Showing 80 of 120 points');
  await expect(page.locator('#continuous-field option:checked')).toHaveText('score');

  const screenshotPath = testInfo.outputPath('per-view-filtering.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach('per-view-filtering.png', {
    path: screenshotPath,
    contentType: 'image/png',
  });

  await page.locator('#split-clear-btn').click();
  await expect(page.locator('#split-view-badges-box')).toBeHidden();
  await expect(page.locator('.split-badge')).toHaveCount(1);
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 points');
  await expect(page.locator('#active-filters')).toHaveText('No filters active');

  expect(productErrors).toEqual([]);
});

test('Jupyter visibility replay stays isolated across live and snapshot views', async ({ page }, testInfo) => {
  const productErrors = observeProductErrors(page);
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');

  const proof = await page.evaluate(async () => {
    const [
      { DataStateColorMethods },
      { DataStateFilterMethods },
      { viewContextCoreMethods },
      { createJupyterCommandHandlers },
    ] = await Promise.all([
      import('/assets/js/app/state/managers/color-manager.js'),
      import('/assets/js/app/state/managers/filter-manager.js'),
      import('/assets/js/app/state/managers/view-context-core.js'),
      import('/assets/js/app/jupyter-command-handler.js'),
    ]);

    const pointCount = 4;
    const layouts = [];
    const viewer = {
      setViewLayout(mode, viewId) {
        layouts.push([mode, viewId]);
      },
      resetCamera() {},
    };
    const state = {
      pointCount,
      obsData: { fields: [] },
      varData: { fields: [] },
      activeFieldIndex: -1,
      activeVarFieldIndex: -1,
      activeFieldSource: null,
      activeDimensionLevel: 2,
      activeViewId: 'live',
      colorsArray: new Uint8Array(pointCount * 4),
      categoryTransparency: Float32Array.from([1, 1, 1, 1]),
      cellVisibilityMask: Float32Array.from([1, 1, 1, 1]),
      outlierQuantilesArray: Float32Array.from([-1, -1, -1, -1]),
      centroidPositions: new Float32Array(),
      centroidColors: new Uint8Array(),
      centroidOutliers: new Float32Array(),
      centroidLabels: [],
      filteredCount: { shown: pointCount, total: pointCount },
      viewContexts: new Map(),
      dimensionManager: null,
      viewer,
      _cloneFieldState: viewContextCoreMethods._cloneFieldState,
      _cloneObsData: viewContextCoreMethods._cloneObsData,
      _cloneVarData: viewContextCoreMethods._cloneVarData,
      _buildContextFromCurrent: viewContextCoreMethods._buildContextFromCurrent,
      _syncActiveContext: viewContextCoreMethods._syncActiveContext,
      createViewFromActive: viewContextCoreMethods.createViewFromActive,
      setActiveView: viewContextCoreMethods.setActiveView,
      setCellVisibility: DataStateFilterMethods.prototype.setCellVisibility,
      computeGlobalVisibility:
        DataStateFilterMethods.prototype.computeGlobalVisibility,
      _syncColorsAlpha: DataStateColorMethods.prototype._syncColorsAlpha,
      _applyOverlaysToFields() {},
      _injectUserDefinedFields() {},
      _ensureActiveSelectionNotDeleted() {},
      _reinitializeActiveField() {},
      _rebuildLabelLayerFromCentroids() {},
      _pushColorsToViewer() {},
      _pushTransparencyToViewer() {},
      _pushOutliersToViewer() {},
      _pushCentroidsToViewer() {},
      _pushOutlierThresholdToViewer() {},
      getCurrentOutlierThreshold() {
        return 1;
      },
      isOutlierFilterEnabledForActiveField() {
        return false;
      },
      _updateActiveCategoryCounts() {
        return false;
      },
      updateFilteredCount() {},
      updateFilterSummary() {},
      _notifyVisibilityChange() {},
    };

    state.viewContexts.set(
      'live',
      state._buildContextFromCurrent('live', { cloneArrays: false }),
    );
    state.createViewFromActive('snapshot-jupyter');

    const commands = createJupyterCommandHandlers({
      state,
      viewer,
      refreshUi() {},
    });
    const sequence = [];
    const record = label => {
      sequence.push({
        label,
        viewId: state.activeViewId,
        mask: Array.from(state.cellVisibilityMask),
        transparency: Array.from(state.categoryTransparency),
      });
    };

    state.setActiveView('snapshot-jupyter');
    await commands.handleMessage({
      type: 'setVisibility',
      cells: [0],
      visible: false,
    });
    record('snapshot hides cell 0');

    state.setActiveView('live');
    state.computeGlobalVisibility();
    record('live replay after snapshot command');

    await commands.handleMessage({
      type: 'setVisibility',
      cells: [2],
      visible: false,
    });
    record('live hides cell 2');

    state.setActiveView('snapshot-jupyter');
    state.computeGlobalVisibility();
    record('snapshot replay after live command');

    state.setActiveView('live');
    state.computeGlobalVisibility();
    record('live final replay');

    return {
      sequence,
      contexts: {
        live: Array.from(
          state.viewContexts.get('live').cellVisibilityMask,
        ),
        snapshot: Array.from(
          state.viewContexts.get('snapshot-jupyter').cellVisibilityMask,
        ),
      },
      independentBuffers: (
        state.cellVisibilityMask
          !== state.viewContexts.get('live').cellVisibilityMask
        && state.viewContexts.get('live').cellVisibilityMask
          !== state.viewContexts.get('snapshot-jupyter').cellVisibilityMask
      ),
      layouts,
    };
  });

  expect(proof.sequence).toEqual([
    {
      label: 'snapshot hides cell 0',
      viewId: 'snapshot-jupyter',
      mask: [0, 1, 1, 1],
      transparency: [0, 1, 1, 1],
    },
    {
      label: 'live replay after snapshot command',
      viewId: 'live',
      mask: [1, 1, 1, 1],
      transparency: [1, 1, 1, 1],
    },
    {
      label: 'live hides cell 2',
      viewId: 'live',
      mask: [1, 1, 0, 1],
      transparency: [1, 1, 0, 1],
    },
    {
      label: 'snapshot replay after live command',
      viewId: 'snapshot-jupyter',
      mask: [0, 1, 1, 1],
      transparency: [0, 1, 1, 1],
    },
    {
      label: 'live final replay',
      viewId: 'live',
      mask: [1, 1, 0, 1],
      transparency: [1, 1, 0, 1],
    },
  ]);
  expect(proof.contexts).toEqual({
    live: [1, 1, 0, 1],
    snapshot: [0, 1, 1, 1],
  });
  expect(proof.independentBuffers).toBe(true);
  expect(proof.layouts).toEqual([
    ['grid', 'snapshot-jupyter'],
    ['grid', 'live'],
    ['grid', 'snapshot-jupyter'],
    ['grid', 'live'],
  ]);

  await page.evaluate(result => {
    const card = document.createElement('section');
    card.setAttribute('aria-label', 'Jupyter multiview visibility proof');
    Object.assign(card.style, {
      position: 'fixed',
      inset: '24px 24px auto auto',
      zIndex: '2147483647',
      maxWidth: '520px',
      padding: '18px',
      border: '2px solid #35d07f',
      borderRadius: '12px',
      background: '#10221a',
      color: '#eafff2',
      boxShadow: '0 16px 40px rgba(0, 0, 0, 0.4)',
      font: '14px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
      whiteSpace: 'pre-wrap',
    });
    card.textContent = [
      'Jupyter multiview visibility replay: PASS',
      '',
      ...result.sequence.map(entry => (
        `${entry.viewId}: mask [${entry.mask.join(', ')}]`
      )),
      '',
      `Independent buffers: ${result.independentBuffers}`,
    ].join('\n');
    document.body.append(card);
  }, proof);

  const screenshotPath = testInfo.outputPath(
    'jupyter-multiview-visibility-isolation.png',
  );
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach('jupyter-multiview-visibility-isolation.png', {
    path: screenshotPath,
    contentType: 'image/png',
  });

  expect(productErrors).toEqual([]);
});
