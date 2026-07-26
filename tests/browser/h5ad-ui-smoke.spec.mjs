import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'current-ui-smoke.h5ad',
);
const zarrFixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'current-ui-smoke.zarr.zip',
);
const preparedFixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'exports',
  'current-ui-prepared',
);

async function expectPlanarCurrentDataset(page, name) {
  await expect(page.locator('#dataset-name')).toHaveText(name);
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  await expect(page.locator('#dataset-genes')).toHaveText('6');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 points');
  await expect(page.locator('#dimension-select')).toHaveValue('2');
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');
  await expect(page.locator('.cinematic-transport-bar')).toHaveCount(0);
}

async function captureReadableDataset(page, outputPath) {
  await page.evaluate(async () => {
    const pointSize = document.getElementById('point-size');
    pointSize.value = '48';
    pointSize.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.sidebar-scroll').scrollTop = 0;
    await new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  });
  await page.screenshot({ path: outputPath, fullPage: true });
}

async function dismissVisibleNotifications(page) {
  const notifications = page.locator('#notification-center .notification');
  while (await notifications.count() > 0) {
    await notifications.first().locator('.notification-dismiss').click();
    await expect(notifications).toHaveCount(
      Math.max(0, await notifications.count() - 1),
    );
  }
}

async function retainUserDataReadyNotification(page) {
  const notifications = page.locator('#notification-center .notification');
  const userReady = notifications.filter({ hasText: 'User data ready:' });
  const other = notifications.filter({ hasNotText: 'User data ready:' });
  await expect(userReady).toHaveCount(1);
  while (await other.count() > 0) {
    const first = other.first();
    await expect(first.locator('.notification-dismiss')).toHaveCount(1);
    await first.locator('.notification-dismiss').click();
    await expect(first).toHaveCount(0);
  }
}

async function colorByCellType(page) {
  const field = page.locator('#categorical-field');
  await field.selectOption({ label: 'cell_type' });
  await expect(field.locator('option:checked')).toHaveText('cell_type');
}

test('loads the current H5AD contract with a planar 2-D camera and no playback', async ({ page }) => {
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      browserErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=browser-ci',
    { waitUntil: 'domcontentloaded' },
  );

  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 points');
  await expect(page.locator('#dimension-select')).toHaveValue('2');
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');
  await expect(page.locator('.cinematic-transport-bar')).toHaveCount(0);

  await page.locator('#user-data-h5ad-input').setInputFiles(fixturePath);

  await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  await expect(page.locator('#dataset-genes')).toHaveText('6');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 points');
  await expect(page.locator('#dimension-select')).toHaveValue('2');
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');
  await expect(page.locator('.cinematic-transport-bar')).toHaveCount(0);

  expect(browserErrors).toEqual([]);
});

test('replaces prepared, Zarr ZIP, and H5AD datasets through the visible controls', async ({ page }, testInfo) => {
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      browserErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=all-local-loaders-ci',
    { waitUntil: 'domcontentloaded' },
  );
  await expectPlanarCurrentDataset(page, 'Current UI prepared fixture');

  await expect(page.locator('#user-data-file-input')).toHaveAttribute('webkitdirectory', '');
  await expect(page.locator('#user-data-h5ad-input')).toHaveAttribute('accept', '.h5ad');
  await expect(page.locator('#user-data-zarr-archive-input')).toHaveAttribute(
    'accept',
    '.zarr.zip,.zip,application/zip',
  );

  await page.locator('#user-data-zarr-archive-input').setInputFiles(zarrFixturePath);
  await expect(page.locator('#user-data-zarr-archive-input')).toHaveValue('');
  await expectPlanarCurrentDataset(page, 'current-ui-smoke');
  await colorByCellType(page);
  await retainUserDataReadyNotification(page);
  await captureReadableDataset(
    page,
    testInfo.outputPath(`zarr-zip-loaded-${testInfo.project.name}.png`),
  );
  await dismissVisibleNotifications(page);

  await page.locator('#user-data-h5ad-input').setInputFiles(fixturePath);
  await expect(page.locator('#user-data-h5ad-input')).toHaveValue('');
  await expectPlanarCurrentDataset(page, 'current-ui-smoke');
  await colorByCellType(page);
  await retainUserDataReadyNotification(page);
  await captureReadableDataset(
    page,
    testInfo.outputPath(`h5ad-loaded-${testInfo.project.name}.png`),
  );
  await dismissVisibleNotifications(page);
  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#sidebar-toggle')).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect.poll(
    () => page.locator('#sidebar').evaluate(
      sidebar => sidebar.getBoundingClientRect().right <= 0,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath(
      `h5ad-visualization-${testInfo.project.name}.png`,
    ),
    fullPage: true,
  });
  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#sidebar-toggle')).toHaveAttribute(
    'aria-expanded',
    'true',
  );

  await page.locator('#user-data-file-input').setInputFiles(preparedFixturePath);
  await expect(page.locator('#user-data-file-input')).toHaveValue('');
  await expectPlanarCurrentDataset(page, 'Current UI prepared fixture');
  await expect(page.locator('#notification-center .notification')).toHaveCount(0);

  await captureReadableDataset(
    page,
    testInfo.outputPath('all-local-loaders-current-ui.png'),
  );
  await page.locator('#sidebar').screenshot({
    path: testInfo.outputPath(`session-panel-${testInfo.project.name}.png`),
  });
  expect(browserErrors).toEqual([]);
});

test('saves and restores the exact current UI state through one file-input contract', async ({ page }, testInfo) => {
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      browserErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=session-ci',
    { waitUntil: 'domcontentloaded' },
  );
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');
  await expect(page.locator('#dimension-select')).toHaveValue('2');
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');
  await expect(page.locator('.cinematic-transport-bar')).toHaveCount(0);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const download = await downloadPromise;
  const sessionPath = testInfo.outputPath('current.cellucid-session');
  await download.saveAs(sessionPath);

  await page.locator('#theme-select').selectOption('dark');
  await page.locator('#background-select').selectOption('black');
  await page.locator('#point-size').fill('42');
  await page.locator('#point-size').dispatchEvent('input');
  await page.locator('#visualization-section > summary').click();
  await expect(page.locator('#theme-select')).toHaveValue('dark');
  await expect(page.locator('#background-select')).toHaveValue('black');
  await expect(page.locator('#point-size')).toHaveValue('42');
  await expect(page.locator('#visualization-section')).not.toHaveAttribute('open', '');

  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(sessionPath);

  await expect(page.locator('#theme-select')).toHaveValue('light');
  await expect(page.locator('#background-select')).toHaveValue('grid');
  await expect(page.locator('#point-size')).toHaveValue('16.5');
  await expect(page.locator('#visualization-section')).toHaveAttribute('open', '');
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');
  await expect(page.locator('#dimension-select')).toHaveValue('2');
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');
  await expect(page.locator('.cinematic-transport-bar')).toHaveCount(0);

  expect(browserErrors).toEqual([]);
});

test('viewer controls reject invalid values atomically and persist one exact background', async ({ page }) => {
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      browserErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=viewer-contract-ci',
    { waitUntil: 'domcontentloaded' },
  );
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');

  const outcome = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const before = viewer.getRenderState();
    const cameraBefore = viewer.getCameraState();
    const storedBefore = localStorage.getItem('cellucid_viewer_background');
    const datasetBefore = document.documentElement.dataset.viewerBackground;
    const attempt = operation => {
      try {
        operation();
        return null;
      } catch (error) {
        return error.message;
      }
    };
    const failures = {
      background: attempt(() => viewer.setBackground('sepia')),
      renderMode: attempt(() => viewer.setRenderMode('legacy-mode')),
      pointSize: attempt(() => viewer.setPointSize('12px')),
      lighting: attempt(() => viewer.setLightingStrength(Infinity)),
      fog: attempt(() => viewer.setFogDensity(Number.NaN)),
      sizeAttenuation: attempt(() => viewer.setSizeAttenuation(null)),
    };
    const after = viewer.getRenderState();
    return {
      failures,
      preserved: {
        stored: localStorage.getItem('cellucid_viewer_background') === storedBefore,
        dataset: document.documentElement.dataset.viewerBackground === datasetBefore,
        pointSize: after.pointSize === before.pointSize,
        lighting: after.lightingStrength === before.lightingStrength,
        fog: after.fogDensity === before.fogDensity,
        sizeAttenuation: after.sizeAttenuation === before.sizeAttenuation,
        camera: JSON.stringify(viewer.getCameraState()) === JSON.stringify(cameraBefore),
        pointCount: viewer.getPointCount(),
        matrices: after.mvpMatrix instanceof Float32Array,
      },
    };
  });

  expect(outcome.failures.background).toMatch(/exactly.*grid.*grid-dark.*white.*black/i);
  expect(outcome.failures.renderMode).toMatch(/exactly.*points.*smoke/i);
  expect(outcome.failures.pointSize).toMatch(/finite number/i);
  expect(outcome.failures.lighting).toMatch(/finite number/i);
  expect(outcome.failures.fog).toMatch(/finite number/i);
  expect(outcome.failures.sizeAttenuation).toMatch(/finite number/i);
  expect(outcome.preserved).toEqual({
    stored: true,
    dataset: true,
    pointSize: true,
    lighting: true,
    fog: true,
    sizeAttenuation: true,
    camera: true,
    pointCount: 120,
    matrices: true,
  });

  await page.locator('#background-select').selectOption('black');
  await expect(page.locator('#background-select')).toHaveValue('black');
  await expect.poll(() => page.evaluate(() => ({
    stored: localStorage.getItem('cellucid_viewer_background'),
    dataset: document.documentElement.dataset.viewerBackground,
    color: [...window._cellucidViewer.getRenderState().bgColor],
  }))).toEqual({
    stored: 'black',
    dataset: 'black',
    color: [0, 0, 0],
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#background-select')).toHaveValue('black');
  await expect.poll(() => page.evaluate(() => ({
    stored: localStorage.getItem('cellucid_viewer_background'),
    dataset: document.documentElement.dataset.viewerBackground,
    color: [...window._cellucidViewer.getRenderState().bgColor],
  }))).toEqual({
    stored: 'black',
    dataset: 'black',
    color: [0, 0, 0],
  });

  await page.locator('#split-keep-view-btn').click();
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.getSnapshotViews().length),
  ).toBe(1);
  await page.locator('#render-mode').selectOption('smoke');
  await expect(page.locator('#render-mode')).toHaveValue('points');
  await expect(page.locator('.notification-warning')).toContainText(
    'Volumetric smoke requires a single view. Clear snapshots first.',
  );

  expect(browserErrors).toEqual([]);
});

test('viewer owns snapshot atomicity, exact identity, capacity, and smoke exclusion', async ({ page }) => {
  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=viewer-snapshot-contract-ci',
    { waitUntil: 'domcontentloaded' },
  );
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');

  const outcome = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const payload = state.getSnapshotPayload();
    const liveCameraState = viewer.getViewCameraState('live');
    const makeConfig = sourceViewId => ({
      label: payload.label,
      fieldKey: payload.fieldKey,
      fieldKind: payload.fieldKind,
      colors: payload.colors,
      transparency: payload.transparency,
      centroidPositions: payload.centroidPositions,
      centroidColors: payload.centroidColors,
      dimensionLevel: payload.dimensionLevel,
      sourceViewId,
      meta: { filtersText: payload.filtersText },
      cameraState: liveCameraState,
    });
    const attempt = operation => {
      try {
        return { name: null, message: null, value: operation() };
      } catch (error) {
        return { name: error.name, message: error.message, value: null };
      }
    };

    const invalidSource = attempt(
      () => viewer.createSnapshotView(makeConfig('missing-view')),
    );
    const countAfterInvalidSource = viewer.getSnapshotViews().length;
    viewer.clearSnapshotViews();

    const invalidIdentity = attempt(() => viewer.setViewDimension(7, 2));
    const invalidIdentityPublication = attempt(() => viewer.getViewDimension('7'));

    const created = [
      viewer.createSnapshotView(makeConfig('live')),
      viewer.createSnapshotView(makeConfig('live')),
      viewer.createSnapshotView(makeConfig('live')),
    ];
    const overCapacity = attempt(
      () => viewer.createSnapshotView(makeConfig('live')),
    );
    const smokeConflict = attempt(() => viewer.setRenderMode('smoke'));

    return {
      invalidSource,
      countAfterInvalidSource,
      invalidIdentity,
      invalidIdentityPublication,
      created,
      overCapacity,
      smokeConflict,
      finalSnapshotCount: viewer.getSnapshotViews().length,
    };
  });

  expect(outcome.invalidSource.name).toBe('RangeError');
  expect(outcome.invalidSource.message).toMatch(
    /unknown renderer view.*missing-view/i,
  );
  expect(outcome.countAfterInvalidSource).toBe(0);
  expect(outcome.invalidIdentity.name).toBe('TypeError');
  expect(outcome.invalidIdentity.message).toMatch(/view id.*non-empty string/i);
  expect(outcome.invalidIdentityPublication.name).toBe('RangeError');
  expect(outcome.created.map(({ id }) => id)).toEqual(['snap_1', 'snap_2', 'snap_3']);
  expect(outcome.overCapacity.name).toBe('RangeError');
  expect(outcome.overCapacity.message).toMatch(/maximum.*3.*snapshots/i);
  expect(outcome.smokeConflict.name).toBe('RangeError');
  expect(outcome.smokeConflict.message).toMatch(/smoke render mode.*snapshots/i);
  expect(outcome.finalSnapshotCount).toBe(3);
  await expect(page.locator('#render-mode')).toHaveValue('points');
});
