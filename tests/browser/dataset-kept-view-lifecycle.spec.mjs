import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';
import { dismissWelcome } from './helpers/welcome.mjs';

const EXPORTS_ROOT =
  'http://127.0.0.1:4173/tests/browser/fixtures/exports/';
const PREPARED_FIXTURE_ROOT = new URL(
  './fixtures/exports/current-ui-prepared/',
  import.meta.url,
);
const PREPARED_CATALOG_URL = new URL(
  './fixtures/exports/datasets.json',
  import.meta.url,
);
const PREPARED_DATASET_URL =
  `/?exportsBaseUrl=${encodeURIComponent(EXPORTS_ROOT)}` +
  '&dataset=current-ui-prepared&acceptance=dataset-kept-view-lifecycle';
const ALTERNATE_DATASET_ID = 'current-ui-alternate';
const ALTERNATE_DATASET_NAME = 'Current UI alternate fixture';
const ALTERNATE_DATASET_OPTION =
  `dataset:local-demo:${ALTERNATE_DATASET_ID}`;
const ZERO_DATASET_ID = 'current-ui-zero';
const ZERO_DATASET_NAME = 'Unsupported zero-cell fixture';
const ZERO_DATASET_OPTION = `dataset:local-demo:${ZERO_DATASET_ID}`;
const ALTERNATE_CATEGORY_LABELS = Object.freeze([
  'delta',
  'epsilon',
  'zeta',
]);

async function readPreparedCatalog() {
  const body = await readFile(PREPARED_CATALOG_URL);
  const catalog = JSON.parse(body.toString('utf8'));
  if (
    catalog === null ||
    typeof catalog !== 'object' ||
    !Array.isArray(catalog.datasets)
  ) {
    throw new TypeError(
      'Prepared fixture catalog must publish a datasets array.'
    );
  }
  return catalog;
}

async function readPreparedArtifact(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.startsWith('/') ||
    relativePath.split('/').some(part => part === '..')
  ) {
    throw new TypeError(
      'Prepared fixture requests require one safe relative path.'
    );
  }
  return readFile(new URL(relativePath, PREPARED_FIXTURE_ROOT));
}

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

function mapFloat32Body(body, transform) {
  if (body.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error('Fixture Float32 payload is not element-aligned.');
  }
  const output = Buffer.from(body);
  const values = new DataView(
    output.buffer,
    output.byteOffset,
    output.byteLength,
  );
  for (
    let byteOffset = 0, index = 0;
    byteOffset < output.byteLength;
    byteOffset += Float32Array.BYTES_PER_ELEMENT, index += 1
  ) {
    const current = values.getFloat32(byteOffset, true);
    const next = Math.fround(transform(current, index));
    if (!Number.isFinite(next)) {
      throw new Error(`Fixture Float32 transform ${index} is not finite.`);
    }
    values.setFloat32(byteOffset, next, true);
  }
  return output;
}

function rotatePreparedPoints(body) {
  if (body.byteLength % (2 * Float32Array.BYTES_PER_ELEMENT) !== 0) {
    throw new Error('Prepared 2D positions are not point-aligned.');
  }
  const output = Buffer.from(body);
  const values = new DataView(
    output.buffer,
    output.byteOffset,
    output.byteLength,
  );
  for (let byteOffset = 0; byteOffset < output.byteLength; byteOffset += 8) {
    const x = values.getFloat32(byteOffset, true);
    const y = values.getFloat32(byteOffset + 4, true);
    values.setFloat32(byteOffset, Math.fround(-y), true);
    values.setFloat32(byteOffset + 4, Math.fround(x), true);
  }
  return output;
}

function readFloat32At(body, index) {
  return new DataView(
    body.buffer,
    body.byteOffset,
    body.byteLength,
  ).getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
}

function buildAlternateObsManifest({
  manifest,
  positions,
  codes,
  outliers,
}) {
  const alternate = structuredClone(manifest);
  const categorical = alternate._categoricalFields.find(
    field => field[0] === 'cell_type',
  );
  if (!categorical) {
    throw new Error('Prepared fixture has no cell_type categorical field.');
  }
  categorical[1] = [...ALTERNATE_CATEGORY_LABELS];

  const centroids = ALTERNATE_CATEGORY_LABELS.map((category, code) => {
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    for (let index = 0; index < codes.byteLength; index += 1) {
      if (
        codes[index] !== code ||
        readFloat32At(outliers, index) >
          alternate.centroid_outlier_quantile
      ) {
        continue;
      }
      count += 1;
      sumX += readFloat32At(positions, index * 2);
      sumY += readFloat32At(positions, index * 2 + 1);
    }
    if (count === 0) {
      throw new Error(`Alternate category "${category}" has no centroid.`);
    }
    return {
      category,
      position: [sumX / count, sumY / count],
      n_points: count,
    };
  });
  categorical[4] = { 2: centroids };
  return alternate;
}

async function createAlternatePreparedArtifacts() {
  const [
    identityBody,
    manifestBody,
    positionsBody,
    codesBody,
    outliersBody,
    scoreBody,
  ] = await Promise.all([
    readFile(new URL('dataset_identity.json', PREPARED_FIXTURE_ROOT)),
    readFile(new URL('obs_manifest.json', PREPARED_FIXTURE_ROOT)),
    readFile(new URL('points_2d.bin', PREPARED_FIXTURE_ROOT)),
    readFile(
      new URL('obs/cell_type.codes.u8', PREPARED_FIXTURE_ROOT),
    ),
    readFile(
      new URL('obs/cell_type.outliers.f32', PREPARED_FIXTURE_ROOT),
    ),
    readFile(new URL('obs/score.values.f32', PREPARED_FIXTURE_ROOT)),
  ]);

  const positions = rotatePreparedPoints(positionsBody);
  const codes = Buffer.from(codesBody);
  for (let index = 0; index < codes.length; index += 1) {
    codes[index] = (codes[index] + 1) % 3;
  }
  const outliers = mapFloat32Body(outliersBody, value => 1 - value);
  const score = mapFloat32Body(scoreBody, value => 1 - value);

  const identity = JSON.parse(identityBody.toString('utf8'));
  identity.id = ALTERNATE_DATASET_ID;
  identity.name = ALTERNATE_DATASET_NAME;
  identity.description =
    'Distinct same-cell-count browser lifecycle fixture';

  const manifest = buildAlternateObsManifest({
    manifest: JSON.parse(manifestBody.toString('utf8')),
    positions,
    codes,
    outliers,
  });

  if (
    positions.byteLength !== positionsBody.byteLength ||
    codes.byteLength !== codesBody.byteLength ||
    outliers.byteLength !== outliersBody.byteLength ||
    score.byteLength !== scoreBody.byteLength
  ) {
    throw new Error('Alternate fixture changed a canonical array length.');
  }
  for (const [name, before, after] of [
    ['positions', positionsBody, positions],
    ['category codes', codesBody, codes],
    ['outlier quantiles', outliersBody, outliers],
    ['continuous values', scoreBody, score],
  ]) {
    if (before.equals(after)) {
      throw new Error(`Alternate fixture ${name} bytes did not change.`);
    }
  }

  return new Map([
    ['dataset_identity.json', Buffer.from(JSON.stringify(identity))],
    ['obs_manifest.json', Buffer.from(JSON.stringify(manifest))],
    ['points_2d.bin', positions],
    ['obs/cell_type.codes.u8', codes],
    ['obs/cell_type.outliers.f32', outliers],
    ['obs/score.values.f32', score],
  ]);
}

async function installAlternatePreparedDataset(page) {
  const [artifacts, catalog] = await Promise.all([
    createAlternatePreparedArtifacts(),
    readPreparedCatalog(),
  ]);
  const requestedPaths = [];
  const source = catalog.datasets.find(
    dataset => dataset.id === 'current-ui-prepared',
  );
  if (source === undefined) {
    throw new Error('Prepared fixture is missing from its dataset catalog.');
  }
  catalog.datasets.push({
    ...source,
    id: ALTERNATE_DATASET_ID,
    name: ALTERNATE_DATASET_NAME,
    path: `${ALTERNATE_DATASET_ID}/`,
  });
  await page.route(
    '**/tests/browser/fixtures/exports/datasets.json',
    route => route.fulfill({ status: 200, json: catalog }),
  );

  await page.route(
    `**/tests/browser/fixtures/exports/${ALTERNATE_DATASET_ID}/**`,
    async route => {
      const alternateUrl = new URL(route.request().url());
      const alternatePrefix =
        `/tests/browser/fixtures/exports/${ALTERNATE_DATASET_ID}/`;
      if (!alternateUrl.pathname.startsWith(alternatePrefix)) {
        throw new Error(
          `Unexpected alternate fixture URL: ${alternateUrl.pathname}`,
        );
      }
      const relativePath =
        alternateUrl.pathname.slice(alternatePrefix.length);
      requestedPaths.push(relativePath);
      const artifact = artifacts.get(relativePath);
      if (artifact !== undefined) {
        await route.fulfill({
          status: 200,
          contentType: relativePath.endsWith('.json')
            ? 'application/json'
            : 'application/octet-stream',
          body: artifact,
        });
        return;
      }
      const canonicalArtifact = await readPreparedArtifact(relativePath);
      await route.fulfill({
        status: 200,
        contentType: relativePath.endsWith('.json')
          ? 'application/json'
          : 'application/octet-stream',
        body: canonicalArtifact,
      });
    },
  );
  return requestedPaths;
}

async function installZeroCellPreparedDataset(page) {
  const requestedPaths = [];
  const [identityBody, obsManifestBody, varManifestBody, catalog] =
    await Promise.all([
      readFile(new URL('dataset_identity.json', PREPARED_FIXTURE_ROOT)),
      readFile(new URL('obs_manifest.json', PREPARED_FIXTURE_ROOT)),
      readFile(new URL('var_manifest.json', PREPARED_FIXTURE_ROOT)),
      readPreparedCatalog(),
    ]);
  const identity = JSON.parse(identityBody.toString('utf8'));
  identity.id = ZERO_DATASET_ID;
  identity.name = ZERO_DATASET_NAME;
  identity.description = 'Unsupported zero-cell browser policy fixture';
  identity.stats.n_cells = 0;

  const obsManifest = JSON.parse(obsManifestBody.toString('utf8'));
  obsManifest.n_points = 0;
  for (const categorical of obsManifest._categoricalFields) {
    categorical[4] = Object.fromEntries(
      Object.keys(categorical[4]).map(dimension => [dimension, []]),
    );
  }
  const varManifest = JSON.parse(varManifestBody.toString('utf8'));
  varManifest.n_points = 0;
  const source = catalog.datasets.find(
    dataset => dataset.id === 'current-ui-prepared',
  );
  if (source === undefined) {
    throw new Error('Prepared fixture is missing from its dataset catalog.');
  }
  catalog.datasets.push({
    ...source,
    id: ZERO_DATASET_ID,
    name: ZERO_DATASET_NAME,
    path: `${ZERO_DATASET_ID}/`,
    n_cells: 0,
  });

  await page.route(
    '**/tests/browser/fixtures/exports/datasets.json',
    route => route.fulfill({ status: 200, json: catalog }),
  );

  await page.route(
    `**/tests/browser/fixtures/exports/${ZERO_DATASET_ID}/**`,
    async route => {
      const url = new URL(route.request().url());
      const prefix =
        `/tests/browser/fixtures/exports/${ZERO_DATASET_ID}/`;
      if (!url.pathname.startsWith(prefix)) {
        throw new Error(`Unexpected zero-cell fixture URL: ${url.pathname}`);
      }
      const relativePath = url.pathname.slice(prefix.length);
      requestedPaths.push(relativePath);
      const json = relativePath === 'dataset_identity.json'
        ? identity
        : relativePath === 'obs_manifest.json'
          ? obsManifest
          : relativePath === 'var_manifest.json'
            ? varManifest
            : null;
      await route.fulfill({
        status: 200,
        contentType: json === null
          ? 'application/octet-stream'
          : 'application/json',
        body: json === null
          ? Buffer.alloc(0)
          : Buffer.from(JSON.stringify(json)),
      });
    },
  );
  return requestedPaths;
}

async function settleRendering(page) {
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function selectCategoricalOutlierView(page) {
  await page.locator('#categorical-field').selectOption({
    label: 'cell_type',
  });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  await expect(page.locator('#outlier-filter-container')).toHaveClass(
    /visible/,
  );
  await page.locator('#outlier-filter').fill('50');
  await page.locator('#outlier-filter').dispatchEvent('change');
}

async function capturePublishedView(page) {
  return page.evaluate(() => {
    const hashTypedArray = value => {
      const bytes = new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      let hash = 0x811c9dc5;
      for (const byte of bytes) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193);
      }
      return hash >>> 0;
    };
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const presented = viewer.getPresentedViewState('live');
    const arrays = viewer.withBorrowedViewData('live', borrowed => ({
      positions: {
        hash: hashTypedArray(borrowed.positions),
        length: borrowed.positions.length,
      },
      colors: {
        hash: hashTypedArray(borrowed.colors),
        length: borrowed.colors.length,
      },
      transparency: {
        hash: hashTypedArray(borrowed.transparency),
        length: borrowed.transparency.length,
      },
    }));
    return {
      arrays,
      certificate: {
        cacheKey: presented.certificate.cacheKey,
        dataGeneration: presented.certificate.dataGeneration,
        geometryGeneration: presented.certificate.geometryGeneration,
      },
      datasetGeneration: state.getDatasetGeneration(),
      pointCount: viewer.getPointCount(),
    };
  });
}

async function openFigureExportDownload(page) {
  const section = page.locator('#figure-export-section');
  if (await section.getAttribute('open') === null) {
    await page.locator('#figure-export-section > summary').click();
  }
  const downloadPanel = page.getByRole('button', { name: /^Download\b/ });
  if (await downloadPanel.getAttribute('aria-expanded') !== 'true') {
    await downloadPanel.click();
  }
  await page.getByLabel('Download format').selectOption('svg');
  await page.getByLabel('SVG point strategy').selectOption('full-vector');
}

async function configureSmallPngExport(page) {
  const section = page.locator('#figure-export-section');
  if (await section.getAttribute('open') === null) {
    await page.locator('#figure-export-section > summary').click();
  }
  const framingPanel = page.getByRole('button', { name: /^Framing\b/ });
  if (await framingPanel.getAttribute('aria-expanded') !== 'true') {
    await framingPanel.click();
  }
  await page.getByLabel('Export width (px)').fill('320');
  await page.getByLabel('Export height (px)').fill('240');
  const downloadPanel = page.getByRole('button', { name: /^Download\b/ });
  if (await downloadPanel.getAttribute('aria-expanded') !== 'true') {
    await downloadPanel.click();
  }
  await page.getByLabel('Download format').selectOption('png');
  await page.getByLabel('PNG DPI').selectOption('150');
}

async function exportSvg(page, testInfo, artifactName) {
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#figure-export-btn').click();
  const download = await downloadPromise;
  await expect(page.locator('#figure-export-btn')).toHaveText('Export');
  expect(await download.failure()).toBeNull();
  const outputPath = testInfo.outputPath(`${artifactName}.svg`);
  await download.saveAs(outputPath);
  return readFile(outputPath, 'utf8');
}

async function readDownload(page, testInfo, artifactName) {
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#figure-export-btn').click();
  const download = await downloadPromise;
  await expect(page.locator('#figure-export-btn')).toHaveText('Export');
  expect(await download.failure()).toBeNull();
  const outputPath = testInfo.outputPath(artifactName);
  await download.saveAs(outputPath);
  return readFile(outputPath);
}

function readPngIdat(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!bytes.subarray(0, signature.length).equals(signature)) {
    throw new Error('Export did not publish a PNG signature.');
  }
  const chunks = [];
  let offset = signature.length;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw new Error(`PNG ${type} chunk is truncated.`);
    }
    if (type === 'IDAT') {
      chunks.push(bytes.subarray(dataStart, dataEnd));
    }
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  if (chunks.length === 0) {
    throw new Error('PNG export has no IDAT payload.');
  }
  return Buffer.concat(chunks);
}

test(
  'direct dataset replacement retires every kept view before refreshing active-view UI',
  async ({ page }, testInfo) => {
    const productErrors = observeProductErrors(page);
    const alternateRequests = await installAlternatePreparedDataset(page);
    await page.goto(PREPARED_DATASET_URL, {
      waitUntil: 'domcontentloaded',
    });
    await dismissWelcome(page);

    await expect(page.locator('#dataset-name')).toHaveText(
      'Current UI prepared fixture',
    );
    await expect(
      page.locator(
        `#dataset-select option[value="${ALTERNATE_DATASET_OPTION}"]`,
      ),
    ).toContainText(ALTERNATE_DATASET_NAME);

    await selectCategoricalOutlierView(page);
    await expect(page.locator('#filter-count')).toHaveText(
      'Showing 60 of 120 points',
    );
    await openFigureExportDownload(page);
    await settleRendering(page);
    const beforePublication = await capturePublishedView(page);
    const beforeCanvas = await page.locator('#glcanvas').screenshot();
    const beforeSvg = await exportSvg(
      page,
      testInfo,
      `${testInfo.project.name}-same-n-before`,
    );
    expect(beforeSvg).toContain('Current UI prepared fixture');
    for (const label of ['alpha', 'beta', 'gamma']) {
      expect(beforeSvg).toContain(label);
    }

    await page.locator('#split-keep-view-btn').click();
    await expect.poll(() => page.evaluate(() => {
      const viewer = window._cellucidViewer;
      const state = window._cellucidState;
      return {
        snapshots: viewer.getSnapshotViews().map(snapshot => snapshot.id),
        activeId: state.getActiveViewId(),
        contexts: Array.from(state.viewContexts.keys()),
        layout: viewer.getViewLayout(),
      };
    })).toEqual({
      snapshots: ['snap_1'],
      activeId: 'snap_1',
      contexts: ['live', 'snap_1'],
      layout: {
        mode: 'grid',
        activeId: 'snap_1',
        liveViewHidden: false,
      },
    });
    await expect(page.locator('.split-badge')).toHaveCount(2);

    await page.locator('#dataset-select').selectOption(
      ALTERNATE_DATASET_OPTION,
    );
    await expect.poll(
      async () => ({
        ...await page.evaluate(() => ({
          activeId: window._cellucidState.getActiveViewId(),
          datasetGeneration:
            window._cellucidState.getDatasetGeneration(),
          error: [
            ...document.querySelectorAll('.notification-error'),
          ].at(-1)?.textContent.trim() ?? null,
          name: document.querySelector('#dataset-name')?.textContent ?? null,
          selected:
            document.querySelector('#dataset-select')?.value ?? null,
        })),
        productErrors: [...productErrors],
        requests: [...alternateRequests],
      }),
      { timeout: 15_000 },
    ).toEqual({
      activeId: 'live',
      datasetGeneration: beforePublication.datasetGeneration + 1,
      error: null,
      name: ALTERNATE_DATASET_NAME,
      productErrors: [],
      requests: expect.arrayContaining([
        'dataset_identity.json',
        'obs_manifest.json',
        'var_manifest.json',
        'points_2d.bin',
      ]),
      selected: ALTERNATE_DATASET_OPTION,
    });
    await expect.poll(() => page.evaluate(() => {
      const viewer = window._cellucidViewer;
      const state = window._cellucidState;
      return {
        snapshots: viewer.getSnapshotViews().map(snapshot => snapshot.id),
        activeId: state.getActiveViewId(),
        contexts: Array.from(state.viewContexts.keys()),
        layout: viewer.getViewLayout(),
      };
    })).toEqual({
      snapshots: [],
      activeId: 'live',
      contexts: ['live'],
      layout: {
        mode: 'grid',
        activeId: 'live',
        liveViewHidden: false,
      },
    });

    await expect(page.locator('#split-view-badges-box')).toBeHidden();
    await expect(page.locator('.split-badge')).toHaveCount(1);
    await expect(page.locator('.split-badge.active')).toHaveCount(1);
    await expect(page.locator('#split-clear-btn')).toBeDisabled();
    await expect(page.locator('#camera-lock-btn')).toBeDisabled();
    await selectCategoricalOutlierView(page);
    await expect(page.locator('#filter-count')).toHaveText(
      'Showing 63 of 120 points',
    );
    expect(
      await page.locator('.legend-item').allTextContents(),
    ).toEqual(
      ALTERNATE_CATEGORY_LABELS.map(label => expect.stringContaining(label)),
    );
    await settleRendering(page);
    const afterPublication = await capturePublishedView(page);
    const afterCanvas = await page.locator('#glcanvas').screenshot();
    const afterSvg = await exportSvg(
      page,
      testInfo,
      `${testInfo.project.name}-same-n-after`,
    );
    expect(afterSvg).toContain(ALTERNATE_DATASET_NAME);
    for (const label of ALTERNATE_CATEGORY_LABELS) {
      expect(afterSvg).toContain(label);
    }
    expect(afterSvg).not.toBe(beforeSvg);
    expect(afterCanvas.equals(beforeCanvas)).toBe(false);
    expect(afterPublication.pointCount).toBe(beforePublication.pointCount);
    expect(afterPublication.arrays.positions.length).toBe(
      beforePublication.arrays.positions.length,
    );
    expect(afterPublication.arrays.colors.length).toBe(
      beforePublication.arrays.colors.length,
    );
    expect(afterPublication.arrays.transparency.length).toBe(
      beforePublication.arrays.transparency.length,
    );
    expect(afterPublication.arrays.positions.hash).not.toBe(
      beforePublication.arrays.positions.hash,
    );
    expect(afterPublication.arrays.colors.hash).not.toBe(
      beforePublication.arrays.colors.hash,
    );
    expect(afterPublication.arrays.transparency.hash).not.toBe(
      beforePublication.arrays.transparency.hash,
    );
    expect(afterPublication.datasetGeneration).toBeGreaterThan(
      beforePublication.datasetGeneration,
    );
    expect(afterPublication.certificate.dataGeneration).not.toBe(
      beforePublication.certificate.dataGeneration,
    );
    expect(afterPublication.certificate.geometryGeneration).not.toBe(
      beforePublication.certificate.geometryGeneration,
    );
    expect(afterPublication.certificate.cacheKey).not.toBe(
      beforePublication.certificate.cacheKey,
    );
    await expect(page.locator('.notification-error')).toHaveCount(0);
    await settleRendering(page);
    expect(productErrors).toEqual([]);
  },
);

test(
  'same-N publication inside a borrowed callback commits but fails its ownership fence',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await page.goto(PREPARED_DATASET_URL, {
      waitUntil: 'domcontentloaded',
    });
    await dismissWelcome(page);
    await expect(page.locator('#dataset-name')).toHaveText(
      'Current UI prepared fixture',
    );

    const result = await page.evaluate(() => {
      const viewer = window._cellucidViewer;
      const original = viewer.getPositions();
      const replacement = new Float32Array(original);
      replacement[0] = Math.fround(replacement[0] + 0.125);
      const before = viewer.getPresentedViewState('live').certificate;
      let error = null;
      try {
        viewer.withBorrowedViewData('live', borrowed => {
          if (borrowed.pointCount !== replacement.length / 3) {
            throw new Error('Replacement changed the point count.');
          }
          viewer.updatePositions(replacement, borrowed.dimensionLevel);
          return borrowed.positions[0];
        });
      } catch (caught) {
        error = {
          message: caught instanceof Error ? caught.message : String(caught),
          name: caught instanceof Error ? caught.name : null,
        };
      }
      const published = viewer.getPositions();
      const after = viewer.getPresentedViewState('live').certificate;
      viewer.updatePositions(original, 2);
      return {
        after: {
          cacheKey: after.cacheKey,
          dataGeneration: after.dataGeneration,
          geometryGeneration: after.geometryGeneration,
        },
        before: {
          cacheKey: before.cacheKey,
          dataGeneration: before.dataGeneration,
          geometryGeneration: before.geometryGeneration,
        },
        committedValue: published[0],
        error,
        expectedValue: replacement[0],
        pointCount: viewer.getPointCount(),
      };
    });

    expect(result.error).toMatchObject({
      name: 'Error',
    });
    expect(result.error.message).toMatch(
      /borrowed point data.*changed during capture/i,
    );
    expect(result.committedValue).toBe(result.expectedValue);
    expect(result.pointCount).toBe(120);
    expect(result.after.dataGeneration).not.toBe(
      result.before.dataGeneration,
    );
    expect(result.after.geometryGeneration).not.toBe(
      result.before.geometryGeneration,
    );
    expect(result.after.cacheKey).not.toBe(result.before.cacheKey);
    await settleRendering(page);
    expect(await page.evaluate(
      () => window._cellucidViewer.getGLContext().getError(),
    )).toBe(0);
    expect(productErrors).toEqual([]);
  },
);

test(
  'delayed PNG encoding remains wholly old across same-N replacement and the next export is wholly new',
  async ({ page }, testInfo) => {
    const productErrors = observeProductErrors(page);
    await installAlternatePreparedDataset(page);
    await page.addInitScript(() => {
      const originalToBlob = HTMLCanvasElement.prototype.toBlob;
      const gate = {
        armed: false,
        lastRelease: null,
        pause: null,
        arm() {
          if (this.pause !== null) {
            throw new Error('A PNG encoding callback is already paused.');
          }
          this.armed = true;
          this.lastRelease = null;
        },
        inspect() {
          if (this.pause === null) return this.lastRelease;
          return {
            height: this.pause.canvas.height,
            pausedHash: this.pause.pausedHash,
            releasedHash: this.pause.releasedHash,
            state: 'paused',
            width: this.pause.canvas.width,
          };
        },
        release() {
          if (this.pause === null) {
            throw new Error('No PNG encoding callback is paused.');
          }
          const pending = this.pause;
          const context = pending.canvas.getContext('2d');
          pending.releasedHash = pending.hashPixels(
            context.getImageData(
              0,
              0,
              pending.canvas.width,
              pending.canvas.height,
            ).data,
          );
          originalToBlob.call(
            pending.canvas,
            pending.callback,
            ...pending.args,
          );
          this.lastRelease = {
            height: pending.canvas.height,
            pausedHash: pending.pausedHash,
            releasedHash: pending.releasedHash,
            state: 'released',
            width: pending.canvas.width,
          };
          this.pause = null;
        },
      };
      Object.defineProperty(window, '__sameNToBlobGate', {
        configurable: false,
        value: gate,
        writable: false,
      });
      HTMLCanvasElement.prototype.toBlob = function toBlob(
        callback,
        ...args
      ) {
        if (!gate.armed) {
          return originalToBlob.call(this, callback, ...args);
        }
        gate.armed = false;
        const context = this.getContext('2d');
        if (context === null) {
          throw new Error('Paused PNG export canvas has no 2D context.');
        }
        const hashPixels = pixels => {
          let hash = 0x811c9dc5;
          for (const byte of pixels) {
            hash ^= byte;
            hash = Math.imul(hash, 0x01000193);
          }
          return hash >>> 0;
        };
        gate.pause = {
          args,
          callback,
          canvas: this,
          hashPixels,
          pausedHash: hashPixels(
            context.getImageData(0, 0, this.width, this.height).data,
          ),
          releasedHash: null,
        };
      };
    });
    await page.goto(PREPARED_DATASET_URL, {
      waitUntil: 'domcontentloaded',
    });
    await dismissWelcome(page);
    await selectCategoricalOutlierView(page);
    await openFigureExportDownload(page);
    await configureSmallPngExport(page);
    await page.evaluate(() => window.__sameNToBlobGate.arm());

    const delayedDownload = page.waitForEvent('download');
    await page.locator('#figure-export-btn').click();
    await expect.poll(
      () => page.evaluate(() => window.__sameNToBlobGate.inspect()),
    ).not.toBeNull();

    await page.locator('#dataset-select').selectOption(
      ALTERNATE_DATASET_OPTION,
    );
    await expect(page.locator('#dataset-name')).toHaveText(
      ALTERNATE_DATASET_NAME,
    );
    await selectCategoricalOutlierView(page);
    const pausedBeforeRelease = await page.evaluate(
      () => window.__sameNToBlobGate.inspect(),
    );
    await page.evaluate(() => window.__sameNToBlobGate.release());
    const delayed = await delayedDownload;
    expect(await delayed.failure()).toBeNull();
    const delayedPath = testInfo.outputPath(
      `${testInfo.project.name}-same-n-delayed-old.png`,
    );
    await delayed.saveAs(delayedPath);
    const oldBytes = await readFile(delayedPath);
    const pausedAfterRelease = await page.evaluate(
      () => window.__sameNToBlobGate.inspect(),
    );
    expect(pausedBeforeRelease).toMatchObject({
      pausedHash: expect.any(Number),
      releasedHash: null,
      state: 'paused',
    });
    expect(pausedAfterRelease).toMatchObject({
      pausedHash: pausedBeforeRelease.pausedHash,
      releasedHash: pausedBeforeRelease.pausedHash,
      state: 'released',
    });
    expect(oldBytes.includes(Buffer.from('Current UI prepared fixture'))).toBe(
      true,
    );
    expect(oldBytes.includes(Buffer.from(ALTERNATE_DATASET_NAME))).toBe(false);
    await expect(page.locator('#figure-export-btn')).toHaveText('Export');

    await configureSmallPngExport(page);
    const newBytes = await readDownload(
      page,
      testInfo,
      `${testInfo.project.name}-same-n-new.png`,
    );
    expect(newBytes.includes(Buffer.from(ALTERNATE_DATASET_NAME))).toBe(true);
    expect(
      readPngIdat(newBytes).equals(readPngIdat(oldBytes)),
    ).toBe(false);
    expect(productErrors).toEqual([]);
  },
);

test(
  'unsupported zero-cell prepared selection rejects before publication and preserves the active UI',
  async ({ page }) => {
    const zeroRequests = await installZeroCellPreparedDataset(page);
    const pageErrors = [];
    page.on('pageerror', error => {
      pageErrors.push(error.stack || error.message);
    });
    await page.goto(PREPARED_DATASET_URL, {
      waitUntil: 'domcontentloaded',
    });
    await dismissWelcome(page);
    await expect(page.locator('#dataset-name')).toHaveText(
      'Current UI prepared fixture',
    );
    await expect(
      page.locator(`#dataset-select option[value="${ZERO_DATASET_OPTION}"]`),
    ).toContainText(ZERO_DATASET_NAME);
    await page.locator('#split-keep-view-btn').click();
    await expect(page.locator('.split-badge')).toHaveCount(2);
    const before = await capturePublishedView(page);

    await page.locator('#dataset-select').selectOption(ZERO_DATASET_OPTION);
    await expect(page.locator('.notification-error').last()).toContainText(
      'n_points must be a positive safe integer',
    );
    await expect(page.locator('#dataset-name')).toHaveText(
      'Current UI prepared fixture',
    );
    await expect(page.locator('#dataset-cells')).toHaveText('120');
    await expect(page.locator('#dataset-select')).toHaveValue(
      'dataset:local-demo:current-ui-prepared',
    );
    await expect(page.locator('.split-badge')).toHaveCount(2);

    const after = await capturePublishedView(page);
    expect(after).toEqual(before);
    expect(zeroRequests).toEqual(expect.arrayContaining([
      'dataset_identity.json',
      'obs_manifest.json',
    ]));
    expect(zeroRequests).not.toContain('points_2d.bin');
    expect(pageErrors).toEqual([]);
    expect(await page.evaluate(
      () => window._cellucidViewer.getGLContext().getError(),
    )).toBe(0);
  },
);
