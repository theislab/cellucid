import { createHash } from 'node:crypto';
import { PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE } from '../../assets/js/app/session/published-default.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { chooseDirectory } from './helpers/directory-upload.mjs';
import {
  readBundle,
} from '../../assets/js/app/session/bundle/reader.js';
import {
  writeBundle,
} from '../../assets/js/app/session/bundle/writer.js';
import {
  gzipDecompress,
} from '../../assets/js/app/session/codecs/gzip.js';
import { ENCODED_SAMPLE_CATALOG_URL, appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const PUBLISHED_DEFAULT_CHUNK_IDS = Object.freeze(
  PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE.map(profile => profile.id),
);

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
// The one Zarr store folder of the browser tests: 48 cells on a 1-D
// trajectory.
const zarrFolderFixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'forms-catalog',
  'forms-zarr.zarr',
);
const FORMS_CATALOG_URL = appUrl('/tests/browser/fixtures/forms-catalog/');
const catalogPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'catalog',
  'datasets.json',
);

async function expectPlanarCurrentDataset(page, name) {
  await expect(page.locator('#dataset-name')).toHaveText(name);
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  await expect(page.locator('#dataset-genes')).toHaveText('6');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
  await expect(page.locator('#view-representation-select option:checked')).toHaveText(/ · 2D$/);
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');
  await expect(page.locator('.cinematic-transport-bar')).toHaveCount(0);
}

async function expectFileInputCleared(page, selector) {
  await expect.poll(
    () => page.locator(selector).evaluate(input => ({
      fileCount: input.files.length,
      value: input.value,
    })),
  ).toEqual({ fileCount: 0, value: '' });
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

async function dismissAllNotifications(page) {
  await expect.poll(() => page.evaluate(async () => {
    const { getNotificationCenter } = await import(
      '/assets/js/app/notification-center.js'
    );
    const activeNotification = document.querySelector(
      '#notification-center .notification-loading, '
        + '#notification-center .notification-progress'
    );
    if (activeNotification !== null) return false;
    getNotificationCenter().dismissAll();
    return true;
  })).toBe(true);
  await expect(page.locator('#notification-center .notification')).toHaveCount(0);
}

async function expectUserDataReadyNotification(page) {
  const notifications = page.locator('#notification-center .notification');
  const userReady = notifications.filter({ hasText: 'User data ready:' });
  await expect(userReady).toHaveCount(1);
}

async function colorByCellType(page) {
  const field = page.locator('#categorical-field');
  await field.selectOption({ label: 'cell_type' });
  await expect(field.locator('option:checked')).toHaveText('cell_type');
}

async function createPublishedDefaultBytes(genericBytes) {
  const { manifest, chunkStream } = await readBundle(
    new Blob([genericBytes]),
    {
      signal: null,
      onProgress: null,
    },
  );
  const chunksById = new Map();
  for await (const chunk of chunkStream) {
    if (chunksById.has(chunk.meta.id)) {
      throw new Error(
        `Generic browser fixture duplicated chunk "${chunk.meta.id}".`,
      );
    }
    chunksById.set(chunk.meta.id, chunk);
  }
  const selected = PUBLISHED_DEFAULT_CHUNK_IDS.map(chunkId => {
    const chunk = chunksById.get(chunkId);
    if (chunk === undefined) {
      throw new Error(
        `Generic browser fixture omitted published chunk "${chunkId}".`,
      );
    }
    return chunk;
  });
  const published = writeBundle({
    manifest: {
      ...manifest,
      // A published default is applied to the sample it ships beside.
      source: null,
      chunks: selected.map(chunk => chunk.meta),
    },
    chunks: selected.map(chunk => chunk.bytes),
  });
  return Buffer.from(await published.arrayBuffer());
}

async function readCoreStatePayload(sessionPath) {
  const bytes = await readFile(sessionPath);
  const { chunkStream } = await readBundle(
    new Blob([bytes]),
    {
      signal: null,
      onProgress: null,
    },
  );
  for await (const chunk of chunkStream) {
    if (chunk.meta.id !== 'core/state') continue;
    const payloadBytes = chunk.meta.codec === 'gzip'
      ? await gzipDecompress(chunk.bytes, {
          maxOutputBytes: chunk.meta.uncompressedBytes,
          signal: null,
        })
      : chunk.bytes;
    return JSON.parse(new TextDecoder().decode(payloadBytes));
  }
  throw new Error('Downloaded session omitted the core/state chunk.');
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
    `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=browser-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);

  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
  await expect(page.locator('#view-representation-select option:checked')).toHaveText(/ · 2D$/);
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');
  await expect(page.locator('.cinematic-transport-bar')).toHaveCount(0);

  await page.locator('#user-data-h5ad-input').setInputFiles(fixturePath);

  await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  await expect(page.locator('#dataset-genes')).toHaveText('6');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
  await expect(page.locator('#view-representation-select option:checked')).toHaveText(/ · 2D$/);
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');
  await expect(page.locator('.cinematic-transport-bar')).toHaveCount(0);

  expect(browserErrors).toEqual([]);
});

test('replaces Zarr folder, Zarr ZIP, and H5AD datasets through the visible controls', async ({ page }, testInfo) => {
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
    `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=all-local-loaders-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expectPlanarCurrentDataset(page, 'Current UI fixture');

  await expect(page.locator('#user-data-zarr-folder-input')).toHaveAttribute('webkitdirectory', '');
  await expect(page.locator('#user-data-h5ad-input')).toHaveAttribute('accept', '.h5ad');
  await expect(page.locator('#user-data-zarr-archive-input')).toHaveAttribute(
    'accept',
    '.zarr.zip,.zip,application/zip',
  );

  await page.locator('#user-data-zarr-archive-input').setInputFiles(zarrFixturePath);
  // Completion is a four-second production notification. Observe that exact
  // operation boundary before performing independent UI and field work, which
  // can legitimately outlive the notification on a loaded hosted runner.
  await expectUserDataReadyNotification(page);
  await expectFileInputCleared(page, '#user-data-zarr-archive-input');
  await expectPlanarCurrentDataset(page, 'current-ui-smoke');
  await colorByCellType(page);
  await captureReadableDataset(
    page,
    testInfo.outputPath(`zarr-zip-loaded-${testInfo.project.name}.png`),
  );
  await dismissAllNotifications(page);

  await page.locator('#user-data-h5ad-input').setInputFiles(fixturePath);
  await expectUserDataReadyNotification(page);
  await expectFileInputCleared(page, '#user-data-h5ad-input');
  await expectPlanarCurrentDataset(page, 'current-ui-smoke');
  await colorByCellType(page);
  await captureReadableDataset(
    page,
    testInfo.outputPath(`h5ad-loaded-${testInfo.project.name}.png`),
  );
  await dismissAllNotifications(page);
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

  await chooseDirectory(
    page.locator('#user-data-zarr-folder-input'),
    zarrFolderFixturePath,
  );
  await expectUserDataReadyNotification(page);
  await expectFileInputCleared(page, '#user-data-zarr-folder-input');
  await expect(page.locator('#dataset-name')).toHaveText('Forms — Zarr folder');
  await expect(page.locator('#dataset-cells')).toHaveText('48');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 48 cells');
  await dismissAllNotifications(page);

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
    `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=session-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await expect(page.locator('#view-representation-select option:checked')).toHaveText(/ · 2D$/);
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');
  await expect(page.locator('.cinematic-transport-bar')).toHaveCount(0);

  // Captured, not hardcoded. The point size a dataset opens at is derived from its
  // cell count, so the value this session records is a property of the fixture
  // rather than a constant — and what this test is about is that whatever was
  // saved comes back, not what that value happens to be.
  const savedPointSize = await page.locator('#point-size').inputValue();

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
  await expect(page.locator('#background-select')).toHaveValue('studio');
  await expect(page.locator('#point-size')).toHaveValue(savedPointSize);
  await expect(page.locator('#visualization-section')).toHaveAttribute('open', '');
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await expect(page.locator('#view-representation-select option:checked')).toHaveText(/ · 2D$/);
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');
  await expect(page.locator('.cinematic-transport-bar')).toHaveCount(0);

  expect(browserErrors).toEqual([]);
});

test('session restore rebuilds saved smoke once after retiring current snapshots', async ({
  page,
}, testInfo) => {
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });

  await page.goto(
    `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=session-smoke-replay-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expectPlanarCurrentDataset(page, 'Current UI fixture');
  await page.locator('#smoke-grid').evaluate(input => {
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#noise-resolution').evaluate(input => {
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#render-mode').selectOption('smoke');
  await expect(page.locator('#render-mode')).toHaveValue('smoke');
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.hasSmokeVolume()),
  ).toBe(true);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const download = await downloadPromise;
  const sessionPath = testInfo.outputPath('saved-smoke.cellucid-session');
  await download.saveAs(sessionPath);

  await page.locator('#render-mode').selectOption('points');
  await page.locator('#split-keep-view-btn').click();
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.getSnapshotViews().length),
  ).toBe(1);
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const buildSmokeVolumeGPU = viewer.buildSmokeVolumeGPU.bind(viewer);
    window.__sessionSmokeBuildCount = 0;
    viewer.buildSmokeVolumeGPU = (...args) => {
      window.__sessionSmokeBuildCount += 1;
      return buildSmokeVolumeGPU(...args);
    };
  });

  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(sessionPath);
  await expect(page.locator('#render-mode')).toHaveValue('smoke');
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.getSnapshotViews().length),
  ).toBe(0);
  await page.evaluate(() => new Promise(resolve => {
    let remainingFrames = 5;
    const advance = () => {
      remainingFrames -= 1;
      if (remainingFrames === 0) {
        resolve();
      } else {
        requestAnimationFrame(advance);
      }
    };
    requestAnimationFrame(advance);
  }));
  expect(await page.evaluate(() => window.__sessionSmokeBuildCount)).toBe(1);
  expect(browserErrors).toEqual([]);
});

test('session restore catches a real control-owner failure and rolls back', async ({
  page,
}, testInfo) => {
  const pageErrors = [];
  page.on('pageerror', error => {
    pageErrors.push(error.stack || error.message);
  });

  await page.goto(
    `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=session-control-owner-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expectPlanarCurrentDataset(page, 'Current UI fixture');

  await page.locator('#cloud-resolution').evaluate(input => {
    input.value = '100';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#cloud-resolution')).toHaveValue('100');
  await expect.poll(
    () => page.evaluate(
      () => window._cellucidViewer.getCloudResolutionScale(),
    ),
  ).toBe(1);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const download = await downloadPromise;
  const sessionPath = testInfo.outputPath(
    'control-owner.cellucid-session',
  );
  await download.saveAs(sessionPath);

  await page.locator('#cloud-resolution').evaluate(input => {
    input.value = '15';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Render resolution steps by twentieths from 0.25x: position 15 is 0.35x.
  const rollbackScale = 0.35;
  await expect(page.locator('#cloud-resolution')).toHaveValue('15');
  await expect.poll(
    () => page.evaluate(
      () => window._cellucidViewer.getCloudResolutionScale(),
    ),
  ).toBe(rollbackScale);

  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const setCloudResolutionScale =
      viewer.setCloudResolutionScale.bind(viewer);
    viewer.setCloudResolutionScale = (scale) => {
      if (scale === 1) {
        throw new Error('synthetic smoke target owner failure');
      }
      return setCloudResolutionScale(scale);
    };
  });

  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(sessionPath);

  await expect(
    page.locator('#notification-center .notification-error')
      .filter({ hasText: 'synthetic smoke target owner failure' }),
  ).toHaveCount(1);
  await expect(page.locator('#cloud-resolution')).toHaveValue('15');
  await expect.poll(
    () => page.evaluate(
      () => window._cellucidViewer.getCloudResolutionScale(),
    ),
  ).toBe(rollbackScale);
  await expectPlanarCurrentDataset(page, 'Current UI fixture');
  expect(pageErrors).toEqual([]);
});

test(
  'session Save drains a deferred categorical selection before capture',
  async ({ page }, testInfo) => {
    const browserErrors = [];
    page.on('console', message => {
      if (message.type() === 'error') {
        browserErrors.push(`console: ${message.text()}`);
      }
    });
    page.on('pageerror', error => {
      browserErrors.push(`page: ${error.stack || error.message}`);
    });

    // The forms catalog's Zarr folder dataset, whose categorical codes are
    // one key (`obs/stage/codes/0`) that can be held.
    await page.goto(
      `/?sampleCatalog=${encodeURIComponent(FORMS_CATALOG_URL)}&dataset=forms-zarr&acceptance=session-field-owner-ci`,
      { waitUntil: 'domcontentloaded' },
    );
    await dismissWelcome(page);
    await openCollapsedPanels(page);
    await expect(page.locator('#dataset-name')).toHaveText('Forms — Zarr folder');
    await expect(page.locator('#dataset-cells')).toHaveText('48');

    let releaseCodes;
    const codesGate = new Promise(resolve => {
      releaseCodes = resolve;
    });
    let codesRequests = 0;
    await page.route(
      `${FORMS_CATALOG_URL}forms-zarr.zarr/obs/stage/codes/0`,
      async route => {
        codesRequests++;
        await codesGate;
        await route.continue();
      },
    );

    const field = page.locator('#categorical-field');
    await field.selectOption({ label: 'stage' });
    await expect.poll(() => codesRequests).toBe(1);
    await expect(field.locator('option:checked')).toHaveText('stage');

    let downloadObserved = false;
    page.once('download', () => {
      downloadObserved = true;
    });
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#save-state-btn').click();
    await page.evaluate(() => new Promise(resolve => {
      requestAnimationFrame(() => queueMicrotask(resolve));
    }));
    expect(downloadObserved).toBe(false);

    releaseCodes();
    const download = await downloadPromise;
    const sessionPath = testInfo.outputPath(
      'deferred-field.cellucid-session',
    );
    await download.saveAs(sessionPath);
    const coreState = await readCoreStatePayload(sessionPath);
    expect(coreState.activeFields).toEqual({
      activeFieldKey: 'stage',
      activeFieldSource: 'obs',
    });
    expect(browserErrors).toEqual([]);
  },
);

test('an advertised sample applies one verified static state without camera motion', async ({ page }, testInfo) => {
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      browserErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  const applicationUrl =
    `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=published-state-ci`;
  await page.goto(applicationUrl, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expectPlanarCurrentDataset(page, 'Current UI fixture');
  await colorByCellType(page);
  await page.locator('#point-size').fill('31');
  await page.locator('#point-size').dispatchEvent('input');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const download = await downloadPromise;
  const statePath = testInfo.outputPath(
    'published-default.cellucid-session',
  );
  await download.saveAs(statePath);
  const genericStateBytes = await readFile(statePath);
  const stateBytes = await createPublishedDefaultBytes(genericStateBytes);
  const stateSha256 = createHash('sha256')
    .update(stateBytes)
    .digest('hex');

  const catalog = JSON.parse(
    await readFile(catalogPath, 'utf8'),
  );
  catalog.datasets[0].session = {
    path: 'current-ui.cellucid-session',
    bytes: stateBytes.byteLength,
    sha256: stateSha256,
  };
  let stateRequests = 0;
  await page.route(
    '**/tests/browser/fixtures/catalog/datasets.json',
    async route => {
      await route.fulfill({
        body: JSON.stringify(catalog),
        contentType: 'application/json',
        status: 200,
      });
    },
  );
  await page.route(
    '**/tests/browser/fixtures/catalog/current-ui.cellucid-session',
    async route => {
      stateRequests++;
      await route.fulfill({
        body: stateBytes,
        contentType: 'application/octet-stream',
        status: 200,
      });
    },
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expectPlanarCurrentDataset(page, 'Current UI fixture');
  await expect(
    page.locator('#categorical-field option:checked'),
  ).toHaveText('cell_type');
  await expect(page.locator('#point-size')).toHaveValue('31');
  await expect(page.locator('#cinematic-camera-section')).not
    .toHaveAttribute('open', '');
  await expect(page.locator('.cinematic-transport-bar')).toHaveCount(0);
  await expect.poll(() => stateRequests).toBe(1);
  expect(browserErrors).toEqual([]);
});

test('a published no-vector sample replaces a prior vector-field select generation', async ({
  browserName,
  page,
}, testInfo) => {
  const browserErrors = [];
  const browserDiagnostics = [];
  page.on('console', message => {
    if (
      message.type() === 'warning'
      && /GL Driver Message .*GPU stall due to ReadPixels/.test(message.text())
    ) {
      browserDiagnostics.push(message.text());
    } else if (message.type() === 'error' || message.type() === 'warning') {
      browserErrors.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      browserErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  const applicationUrl =
    `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=vector-state-replacement-ci`;
  await page.goto(applicationUrl, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expectPlanarCurrentDataset(page, 'Current UI fixture');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const download = await downloadPromise;
  const statePath = testInfo.outputPath(
    'published-no-vector.cellucid-session',
  );
  await download.saveAs(statePath);
  const stateBytes = await createPublishedDefaultBytes(
    await readFile(statePath),
  );
  const stateSha256 = createHash('sha256')
    .update(stateBytes)
    .digest('hex');

  const catalog = JSON.parse(
    await readFile(catalogPath, 'utf8'),
  );
  const sessionEntry = {
    ...catalog.datasets[0],
    session: {
      path: 'current-ui.cellucid-session',
      bytes: stateBytes.byteLength,
      sha256: stateSha256,
    },
  };
  // The file beside the catalog that the same cells carry a vector field in
  // (`scripts/generate-browser-catalog-fixtures.py`).
  const vectorEntry = {
    id: 'current-ui-vector',
    path: 'current-ui-vector.h5ad',
  };
  catalog.default = vectorEntry.id;
  catalog.datasets = [vectorEntry, sessionEntry];

  await page.route(
    '**/tests/browser/fixtures/catalog/datasets.json',
    route => route.fulfill({
      body: JSON.stringify(catalog),
      contentType: 'application/json',
      status: 200,
    }),
  );

  let stateRequests = 0;
  await page.route(
    '**/tests/browser/fixtures/catalog/current-ui.cellucid-session',
    route => {
      stateRequests++;
      return route.fulfill({
        body: stateBytes,
        contentType: 'application/octet-stream',
        status: 200,
      });
    },
  );

  await page.goto(
    applicationUrl.replace(
      'dataset=current-ui',
      'dataset=current-ui-vector',
    ),
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expectPlanarCurrentDataset(page, 'Current UI vector fixture');
  await expect(page.locator('#velocity-field')).toHaveValue('velocity');
  await expect(page.locator('#velocity-field option')).toHaveCount(1);

  await page.locator('#dataset-select').selectOption(
    'dataset:local-demo:current-ui',
  );
  await expectPlanarCurrentDataset(page, 'Current UI fixture');
  await expect(page.locator('#velocity-field')).toHaveValue('');
  await expect(page.locator('#velocity-field option')).toHaveCount(0);
  await expect.poll(() => stateRequests).toBe(1);
  await expect(page.getByText(
    /published sample view could not be applied|Session UI select option/i,
  )).toHaveCount(0);
  expect(browserErrors).toEqual([]);
  expect(browserDiagnostics.length).toBeLessThanOrEqual(4);
  if (browserName !== 'chromium') {
    expect(browserDiagnostics).toEqual([]);
  }
});

test('camera path state round-trips every owned control and commits autoplay', async ({ page }, testInfo) => {
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
    `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=camera-session-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await page.locator('#cinematic-camera-section > summary').click();
  await page.locator('#cinematic-save-btn').click();
  await page.locator('#cinematic-save-btn').click();
  await expect(page.locator('.cinematic-keyframe-item')).toHaveCount(2);

  await page.locator('.cinematic-duration-input').first().fill('10');
  await page.locator('.cinematic-duration-input').first().dispatchEvent('change');
  await page.locator('.cinematic-loopback-list-toggle').check();
  await page.locator('#cinematic-position-interp').selectOption('linear');
  await page.locator('#cinematic-rotation-interp').selectOption('linear');
  await page.locator('#cinematic-easing').selectOption('ease-in-out');
  await page.evaluate(() => {
    const setRange = (id, value) => {
      const element = document.getElementById(id);
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const setCheckbox = (id, checked) => {
      const element = document.getElementById(id);
      element.checked = checked;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setRange('orbit-key-speed', '73');
    setRange('cinematic-default-speed', '47');
    setCheckbox('orbit-reverse', false);
    setCheckbox('show-orbit-anchor', false);
    setRange('planar-pan-speed', '61');
    setCheckbox('planar-zoom-to-cursor', false);
    setCheckbox('planar-invert-axes', true);
    setRange('look-sensitivity', '9');
    setRange('move-speed', '234');
    setCheckbox('invert-look', true);
  });
  await page.locator('#cinematic-loop').check();
  await page.locator('#cinematic-autoplay').check();
  await expect(page.locator('.cinematic-play-btn')).toHaveAttribute('title', 'Pause');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const download = await downloadPromise;
  const sessionPath = testInfo.outputPath('camera-autoplay.cellucid-session');
  await download.saveAs(sessionPath);

  await page.locator('[data-action="stop"]').click();
  await page.locator('#cinematic-clear-btn').click();
  await page.locator('#cinematic-loop').uncheck();
  await page.locator('#cinematic-autoplay').uncheck();
  await page.locator('#navigation-mode').selectOption('free');
  await page.locator('#cinematic-position-interp').selectOption('catmull-rom');
  await page.locator('#cinematic-rotation-interp').selectOption('slerp');
  await page.locator('#cinematic-easing').selectOption('linear');
  await page.evaluate(() => {
    for (const [id, value] of [
      ['cinematic-default-speed', '30'],
      ['orbit-key-speed', '40'],
      ['planar-pan-speed', '100'],
      ['look-sensitivity', '5'],
      ['move-speed', '100'],
    ]) {
      const element = document.getElementById(id);
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    for (const [id, checked] of [
      ['orbit-reverse', true],
      ['show-orbit-anchor', true],
      ['planar-zoom-to-cursor', true],
      ['planar-invert-axes', false],
      ['invert-look', false],
    ]) {
      const element = document.getElementById(id);
      element.checked = checked;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(sessionPath);

  await expect(page.locator('.cinematic-keyframe-item')).toHaveCount(3);
  await expect(page.locator('.cinematic-loopback-list-toggle')).toBeChecked();
  await expect(page.locator('.cinematic-duration-input').first()).toHaveValue('10');
  await expect(page.locator('#cinematic-loop')).toBeChecked();
  await expect(page.locator('#cinematic-autoplay')).toBeChecked();
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');
  await expect(page.locator('#cinematic-default-speed')).toHaveValue('47');
  await expect(page.locator('#cinematic-position-interp')).toHaveValue('linear');
  await expect(page.locator('#cinematic-rotation-interp')).toHaveValue('linear');
  await expect(page.locator('#cinematic-easing')).toHaveValue('ease-in-out');
  await expect(page.locator('#orbit-key-speed')).toHaveValue('73');
  await expect(page.locator('#orbit-reverse')).not.toBeChecked();
  await expect(page.locator('#show-orbit-anchor')).not.toBeChecked();
  await expect(page.locator('#planar-pan-speed')).toHaveValue('61');
  await expect(page.locator('#planar-zoom-to-cursor')).not.toBeChecked();
  await expect(page.locator('#planar-invert-axes')).toBeChecked();
  await expect(page.locator('#look-sensitivity')).toHaveValue('9');
  await expect(page.locator('#move-speed')).toHaveValue('234');
  await expect(page.locator('#invert-look')).toBeChecked();
  await expect(page.locator('.cinematic-play-btn')).toHaveAttribute('title', 'Pause');
  await page.locator('[data-action="stop"]').click();

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
    `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=viewer-contract-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');

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

  expect(outcome.failures.background).toMatch(
    /exactly one of "white", "grid", "studio", "atelier", "abyss", "aurora", "black", "grid-dark", "studio-dark", "nebula", "abyss-dark", "aurora-dark"/i
  );
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
  await dismissWelcome(page);
  await openCollapsedPanels(page);
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

test('viewer owns snapshot atomicity, exact identity, any number of snapshots, and smoke exclusion', async ({ page }) => {
  await page.goto(
    `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=viewer-snapshot-contract-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');

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

    viewer.setRenderMode('smoke');
    const snapshotWhileSmoke = attempt(
      () => viewer.createSnapshotView(makeConfig('live')),
    );
    const countAfterSmokeConflict = viewer.getSnapshotViews().length;
    viewer.setRenderMode('points');

    const invalidSource = attempt(
      () => viewer.createSnapshotView(makeConfig('missing-view')),
    );
    const countAfterInvalidSource = viewer.getSnapshotViews().length;
    viewer.clearSnapshotViews();

    const invalidIdentity = attempt(() => viewer.setViewEmbedding(7, { dimension: 2, layoutKey: '2d' }));
    const invalidIdentityPublication = attempt(() => viewer.getViewDimension('7'));

    const created = [
      viewer.createSnapshotView(makeConfig('live')),
      viewer.createSnapshotView(makeConfig('live')),
      viewer.createSnapshotView(makeConfig('live')),
    ];
    // No view-count ceiling: a fourth snapshot (a fifth view) is kept too.
    created.push(viewer.createSnapshotView(makeConfig('live')));
    const smokeConflict = attempt(() => viewer.setRenderMode('smoke'));

    return {
      snapshotWhileSmoke,
      countAfterSmokeConflict,
      invalidSource,
      countAfterInvalidSource,
      invalidIdentity,
      invalidIdentityPublication,
      created,
      smokeConflict,
      finalSnapshotCount: viewer.getSnapshotViews().length,
    };
  });

  expect(outcome.snapshotWhileSmoke.name).toBe('RangeError');
  expect(outcome.snapshotWhileSmoke.message).toMatch(
    /snapshot.*unavailable.*smoke render mode/i,
  );
  expect(outcome.countAfterSmokeConflict).toBe(0);
  expect(outcome.invalidSource.name).toBe('RangeError');
  expect(outcome.invalidSource.message).toMatch(
    /unknown renderer view.*missing-view/i,
  );
  expect(outcome.countAfterInvalidSource).toBe(0);
  expect(outcome.invalidIdentity.name).toBe('TypeError');
  expect(outcome.invalidIdentity.message).toMatch(/view id.*non-empty string/i);
  expect(outcome.invalidIdentityPublication.name).toBe('RangeError');
  expect(outcome.created.map(({ id }) => id)).toEqual(['snap_1', 'snap_2', 'snap_3', 'snap_4']);
  expect(outcome.smokeConflict.name).toBe('RangeError');
  expect(outcome.smokeConflict.message).toMatch(/smoke render mode.*snapshots/i);
  expect(outcome.finalSnapshotCount).toBe(4);
  await expect(page.locator('#render-mode')).toHaveValue('points');
});
