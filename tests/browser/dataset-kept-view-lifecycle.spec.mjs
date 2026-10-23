import { readFile } from 'node:fs/promises';

import { expect, test } from './helpers/test.mjs';
import { anndataZarrZip } from './helpers/anndata-zarr-zip.mjs';
import { currentUiLike, listCatalogDatasets } from './helpers/catalog-datasets.mjs';
import { SAMPLE_CATALOG_URL as CATALOG_ROOT } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const CATALOG_DATASET_URL =
  `/?sampleCatalog=${encodeURIComponent(CATALOG_ROOT)}` +
  '&dataset=current-ui&acceptance=dataset-kept-view-lifecycle';
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
const GENES = Object.freeze(['GAPDH', 'ACTB', 'CD3E', 'MS4A1', 'NKG7', 'LYZ']);

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

/**
 * The same number of cells as `current-ui` with different everything else:
 * positions, categories and codes, scores, latent space and expression.
 */
async function installAlternateDataset(page) {
  const bytes = currentUiLike({
    id: ALTERNATE_DATASET_ID,
    name: ALTERNATE_DATASET_NAME,
    description: 'Distinct same-cell-count browser lifecycle fixture',
    categories: [...ALTERNATE_CATEGORY_LABELS],
  });
  const reads = await listCatalogDatasets(page, [{ id: ALTERNATE_DATASET_ID, bytes }]);
  return reads.get(ALTERNATE_DATASET_ID);
}

/** A dataset with no cells, which the viewer does not open. */
async function installZeroCellDataset(page) {
  const bytes = anndataZarrZip({
    cells: 0,
    genes: [...GENES],
    obs: { cell_type: { categories: ['alpha', 'beta', 'gamma'], codes: new Int8Array(0) } },
    obsm: { X_umap_2d: { data: new Float32Array(0), columns: 2 } },
    uns: {
      cellucid: {
        schema: 1,
        id: ZERO_DATASET_ID,
        name: ZERO_DATASET_NAME,
        description: 'Unsupported zero-cell browser policy fixture',
      },
    },
  });
  const reads = await listCatalogDatasets(page, [{ id: ZERO_DATASET_ID, bytes }]);
  return reads.get(ZERO_DATASET_ID);
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
  await expect(page.locator('#outlier-filter-container')).toBeVisible();
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
    const alternateRequests = await installAlternateDataset(page);
    await page.goto(CATALOG_DATASET_URL, {
      waitUntil: 'domcontentloaded',
    });
    await dismissWelcome(page);
    await openCollapsedPanels(page);

    await expect(page.locator('#dataset-name')).toHaveText(
      'Current UI fixture',
    );
    await expect(
      page.locator(
        `#dataset-select option[value="${ALTERNATE_DATASET_OPTION}"]`,
      ),
    ).toContainText(ALTERNATE_DATASET_NAME);

    await selectCategoricalOutlierView(page);
    await expect(page.locator('#filter-count')).toHaveText(
      'Showing 60 of 120 cells',
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
    expect(beforeSvg).toContain('Current UI fixture');
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
      // The alternate's file was read: listing it, and opening it.
      requests: expect.arrayContaining([expect.stringMatching(/^bytes=/)]),
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
    // The alternate's latent space keeps 60 cells under the 50% cut.
    await expect(page.locator('#filter-count')).toHaveText(
      'Showing 60 of 120 cells',
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
    await page.goto(CATALOG_DATASET_URL, {
      waitUntil: 'domcontentloaded',
    });
    await dismissWelcome(page);
    await openCollapsedPanels(page);
    await expect(page.locator('#dataset-name')).toHaveText(
      'Current UI fixture',
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
          if (
            borrowed.pointCount !==
              replacement.length / borrowed.dimensionLevel
          ) {
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
    await installAlternateDataset(page);
    await page.addInitScript(() => {
      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      const originalCreateImageBitmap = window.createImageBitmap.bind(window);
      const webgl2Contexts = [];
      HTMLCanvasElement.prototype.getContext = function getContext(
        type,
        ...args
      ) {
        const context = originalGetContext.call(this, type, ...args);
        if (
          type === 'webgl2' &&
          context !== null &&
          !webgl2Contexts.includes(context)
        ) {
          webgl2Contexts.push(context);
        }
        return context;
      };
      const gate = {
        armed: false,
        lastRelease: null,
        pause: null,
        webgl2Start: null,
        arm() {
          if (this.pause !== null) {
            throw new Error('A PNG frame handoff is already paused.');
          }
          this.armed = true;
          this.lastRelease = null;
          this.webgl2Start = webgl2Contexts.length;
        },
        inspect() {
          const webgl2ContextLost = this.webgl2Start === null
            ? []
            : webgl2Contexts
                .slice(this.webgl2Start)
                .map(context => context.isContextLost());
          if (this.pause === null) {
            return this.lastRelease === null
              ? null
              : { ...this.lastRelease, webgl2ContextLost };
          }
          return {
            height: this.pause.canvas.height,
            pausedHash: this.pause.pausedHash,
            releasedHash: this.pause.releasedHash,
            state: 'paused',
            webgl2ContextLost,
            width: this.pause.canvas.width,
          };
        },
        release() {
          if (this.pause === null) {
            throw new Error('No PNG frame handoff is paused.');
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
          originalCreateImageBitmap(pending.canvas, ...pending.args)
            .then(pending.resolve, pending.reject);
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
      Object.defineProperty(window, '__sameNFrameGate', {
        configurable: false,
        value: gate,
        writable: false,
      });
      // The composed PNG canvas is handed to the figure-export worker as an
      // ImageBitmap, which the worker encodes; holding that handoff holds the
      // export after its frame is complete.
      window.createImageBitmap = function createImageBitmap(source, ...args) {
        if (!gate.armed || !(source instanceof HTMLCanvasElement)) {
          return originalCreateImageBitmap(source, ...args);
        }
        gate.armed = false;
        const context = source.getContext('2d');
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
        return new Promise((resolve, reject) => {
          gate.pause = {
            args,
            canvas: source,
            hashPixels,
            pausedHash: hashPixels(
              context.getImageData(0, 0, source.width, source.height).data,
            ),
            reject,
            releasedHash: null,
            resolve,
          };
        });
      };
    });
    await page.goto(CATALOG_DATASET_URL, {
      waitUntil: 'domcontentloaded',
    });
    await dismissWelcome(page);
    await openCollapsedPanels(page);
    await selectCategoricalOutlierView(page);
    await openFigureExportDownload(page);
    await configureSmallPngExport(page);
    await page.evaluate(() => window.__sameNFrameGate.arm());

    const delayedDownload = page.waitForEvent('download');
    await page.locator('#figure-export-btn').click();
    await expect.poll(
      () => page.evaluate(() => window.__sameNFrameGate.inspect()),
    ).not.toBeNull();

    await page.locator('#dataset-select').selectOption(
      ALTERNATE_DATASET_OPTION,
    );
    await expect(page.locator('#dataset-name')).toHaveText(
      ALTERNATE_DATASET_NAME,
    );
    await selectCategoricalOutlierView(page);
    const pausedBeforeRelease = await page.evaluate(
      () => window.__sameNFrameGate.inspect(),
    );
    await page.evaluate(() => window.__sameNFrameGate.release());
    const delayed = await delayedDownload;
    expect(await delayed.failure()).toBeNull();
    const delayedPath = testInfo.outputPath(
      `${testInfo.project.name}-same-n-delayed-old.png`,
    );
    await delayed.saveAs(delayedPath);
    const oldBytes = await readFile(delayedPath);
    // The export creates no WebGL context on the page: its point passes run
    // on the figure-export worker's own contexts.
    expect(pausedBeforeRelease).toMatchObject({
      pausedHash: expect.any(Number),
      releasedHash: null,
      state: 'paused',
      webgl2ContextLost: [],
    });
    await expect.poll(
      () => page.evaluate(() => window.__sameNFrameGate.inspect()),
    ).toMatchObject({
      pausedHash: pausedBeforeRelease.pausedHash,
      releasedHash: pausedBeforeRelease.pausedHash,
      state: 'released',
      webgl2ContextLost: [],
    });
    expect(oldBytes.includes(Buffer.from('Current UI fixture'))).toBe(
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
  'unsupported zero-cell selection rejects before publication and preserves the active UI',
  async ({ page }) => {
    const zeroRequests = await installZeroCellDataset(page);
    const pageErrors = [];
    page.on('pageerror', error => {
      pageErrors.push(error.stack || error.message);
    });
    await page.goto(CATALOG_DATASET_URL, {
      waitUntil: 'domcontentloaded',
    });
    await dismissWelcome(page);
    await openCollapsedPanels(page);
    await expect(page.locator('#dataset-name')).toHaveText(
      'Current UI fixture',
    );
    await expect(
      page.locator(`#dataset-select option[value="${ZERO_DATASET_OPTION}"]`),
    ).toContainText(ZERO_DATASET_NAME);
    await page.locator('#split-keep-view-btn').click();
    await expect(page.locator('.split-badge')).toHaveCount(2);
    const before = await capturePublishedView(page);

    await page.locator('#dataset-select').selectOption(ZERO_DATASET_OPTION);
    // The file is what is wrong, so the message says so and names it: it is
    // never sent to check a connection that worked.
    const failure = page.locator('.notification-error').last();
    await expect(failure).toContainText(
      `${ZERO_DATASET_ID}.zarr.zip (dataset '${ZERO_DATASET_ID}' in datasets.json): ` +
        'This AnnData has no cells (n_obs is 0), so there is nothing to plot.',
    );
    await expect(failure).not.toContainText('connection');
    await expect(page.locator('#dataset-name')).toHaveText(
      'Current UI fixture',
    );
    await expect(page.locator('#dataset-cells')).toHaveText('120');
    await expect(page.locator('#dataset-select')).toHaveValue(
      'dataset:local-demo:current-ui',
    );
    await expect(page.locator('.split-badge')).toHaveCount(2);

    const after = await capturePublishedView(page);
    expect(after).toEqual(before);
    expect(zeroRequests.length).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
    expect(await page.evaluate(
      () => window._cellucidViewer.getGLContext().getError(),
    )).toBe(0);
  },
);
