import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { isFirefoxSafeResolveReorderingWarning } from './helpers/engine-console.mjs';
import { shownDomainValue, startingViewBytes } from './helpers/session-files.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { clickSaveSession, clickLoadSession } from './helpers/session-buttons.mjs';

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
  await clickSaveSession(page);
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
  await clickLoadSession(page);
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

test('session restore catches a real control-owner failure: that part is not restored and keeps what was shown', async ({
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
  await clickSaveSession(page);
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
  await clickLoadSession(page);
  const chooser = await chooserPromise;
  await chooser.setFiles(sessionPath);

  // The rest of the file is restored; the settings, whose owner refused, are
  // one part not restored, said once in their own words, and keep what was
  // shown (the control and the renderer agree on it).
  await expect(
    page.locator('#notification-center .notification-warning .notification-message')
      .filter({ hasText: /^Session restored but for 1 part\. Settings could not be restored: synthetic smoke target owner failure\. It is left as it was shown\.$/ }),
  ).toHaveCount(1);
  await expect(page.locator('#notification-center .notification-error')).toHaveCount(0);
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
  'session Save drains a deferred field selection before capture',
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

    // The forms catalog's Zarr folder dataset. It opens colored by its one
    // categorical field (`stage`, `first-coloring.js`); its continuous
    // `pseudotime` is one key (`obs/pseudotime/0`) not read yet, that can be
    // held.
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
      `${FORMS_CATALOG_URL}forms-zarr.zarr/obs/pseudotime/0`,
      async route => {
        codesRequests++;
        await codesGate;
        await route.continue();
      },
    );

    await expect(page.locator('#categorical-field option:checked')).toHaveText('stage');
    const field = page.locator('#continuous-field');
    await field.selectOption({ label: 'pseudotime' });
    await expect.poll(() => codesRequests).toBe(1);
    await expect(field.locator('option:checked')).toHaveText('pseudotime');

    let downloadObserved = false;
    page.once('download', () => {
      downloadObserved = true;
    });
    const downloadPromise = page.waitForEvent('download');
    await clickSaveSession(page);
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
    // The session's colored field is the one chosen while its values were
    // still read: the shown value of the active-field domain names it.
    const activeField = await shownDomainValue(await readFile(sessionPath), 'active-field');
    expect(JSON.stringify(activeField)).toContain('"pseudotime"');
    expect(browserErrors).toEqual([]);
  },
);

test(
  'the field menus name and hold the choice under way through every refresh of them',
  async ({ page }) => {
    const browserErrors = [];
    page.on('console', message => {
      if (message.type() === 'error') {
        browserErrors.push(`console: ${message.text()}`);
      }
    });
    page.on('pageerror', error => {
      browserErrors.push(`page: ${error.stack || error.message}`);
    });
    /** Every request for `url` waits until `release()`. */
    const holdRequests = async url => {
      let release;
      const gate = new Promise(resolve => {
        release = resolve;
      });
      const held = { requests: 0, release };
      await page.route(url, async route => {
        held.requests++;
        await gate;
        await route.continue();
      });
      return held;
    };
    // A refresh of the menus that is no field change: the community
    // annotation connection changing (`connection-events.js`). Its listeners
    // run before `dispatchEvent` returns.
    const refreshMenus = () => page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('cellucid:annotation-connection-changed', { detail: null }));
    });

    // The gene list of a dataset just shown is read after its first view
    // (`DataState.listPublishedGenes`), and its arrival refreshes the menus
    // (`genes:listed`). It can land while a categorical choice is
    // read, and the menu then says None until the read ends.
    // The choice under way is the dataset's first coloring (`stage`, its
    // one categorical field: `first-coloring.js`), read as it opens.
    const geneNames = await holdRequests(`${FORMS_CATALOG_URL}forms-zarr.zarr/var/_index/0`);
    const codes = await holdRequests(`${FORMS_CATALOG_URL}forms-zarr.zarr/obs/stage/codes/0`);
    await page.goto(
      `/?sampleCatalog=${encodeURIComponent(FORMS_CATALOG_URL)}&dataset=forms-zarr&acceptance=session-field-owner-ci`,
      { waitUntil: 'domcontentloaded' },
    );
    await dismissWelcome(page);
    await openCollapsedPanels(page);
    await expect(page.locator('#dataset-cells')).toHaveText('48');
    await expect.poll(() => geneNames.requests).toBeGreaterThan(0);
    const search = page.locator('#gene-expression-search');
    await expect(search).toHaveAttribute('placeholder', 'Reading gene names…');

    const categorical = page.locator('#categorical-field');
    const continuous = page.locator('#continuous-field');
    await expect.poll(() => codes.requests).toBe(1);
    await expect(categorical.locator('option:checked')).toHaveText('stage');
    await expect(categorical).toBeDisabled();

    // The gene list arrives while the choice is read: the refresh it makes
    // has ended once the search offers the genes.
    geneNames.release();
    await expect(search).toHaveAttribute('placeholder', 'Search genes…');
    await expect(categorical.locator('option:checked')).toHaveText('stage');
    await expect(categorical).toBeDisabled();
    await expect(continuous).toBeDisabled();
    await refreshMenus();
    await expect(categorical.locator('option:checked')).toHaveText('stage');
    await expect(categorical).toBeDisabled();

    codes.release();
    await expect(categorical).toBeEnabled();
    await expect(categorical.locator('option:checked')).toHaveText('stage');

    // A gene chosen while "stage" is shown: the menus show no obs field and
    // stay held while it is read, whatever refreshes them.
    const gene = await page.evaluate(() => window._cellucidState.getVarFields()[0].key);
    const expression = await holdRequests(`${FORMS_CATALOG_URL}forms-zarr.zarr/X/**`);
    await search.fill(gene);
    await search.press('Enter');
    await expect.poll(() => expression.requests).toBeGreaterThan(0);
    await expect(categorical.locator('option:checked')).toHaveText('None');
    await refreshMenus();
    await expect(search).toHaveValue(gene);
    await expect(categorical.locator('option:checked')).toHaveText('None');
    await expect(categorical).toBeDisabled();

    expression.release();
    await expect(categorical).toBeEnabled();
    await expect(search).toHaveValue(gene);
    await expect(categorical.locator('option:checked')).toHaveText('None');
    expect(browserErrors).toEqual([]);
  },
);

test('a published no-vector sample replaces a prior vector-field select generation', async ({
  browserName,
  page,
}, testInfo) => {
  const browserErrors = [];
  const browserDiagnostics = [];
  page.on('console', message => {
    if (isFirefoxSafeResolveReorderingWarning(message)) return;
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
  await clickSaveSession(page);
  const download = await downloadPromise;
  const statePath = testInfo.outputPath(
    'published-no-vector.cellucid-session',
  );
  await download.saveAs(statePath);
  const stateBytes = await startingViewBytes(
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

test('the viewer refuses what it cannot hold', async ({ page }) => {
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

  // The snapshots first, on the page as it opened: their ids count from one.
  // The step after reloads the page, so it starts without them.
  await test.step('viewer owns snapshot atomicity, exact identity, any number of snapshots, and smoke exclusion', async () => {
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
      const finalSnapshotCount = viewer.getSnapshotViews().length;
      // Made on the viewer alone, they are removed before the app sees a
      // view it holds no state for.
      viewer.clearSnapshotViews();

      return {
        snapshotWhileSmoke,
        countAfterSmokeConflict,
        invalidSource,
        countAfterInvalidSource,
        invalidIdentity,
        invalidIdentityPublication,
        created,
        smokeConflict,
        finalSnapshotCount,
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

  await test.step('viewer controls reject invalid values atomically and persist one exact background', async () => {
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

    // Picked as a person picks (the browser's own, trusted change): only a
    // person's pick is kept (`render-controls.js`); `selectOption` dispatches a
    // page event, which a restore or an action also is.
    await page.locator('#background-select').focus();
    await page.keyboard.type('Black');
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
    // Smoke draws one view: its choice is off while a view is kept, and says why.
    const smokeChoice = page.locator('#render-mode option[value="smoke"]');
    await expect(smokeChoice).toBeDisabled();
    await expect(smokeChoice).toHaveAttribute(
      'title',
      'volumetric smoke draws one view; remove the kept views first (Clear, beside Layout)',
    );
    await expect(page.locator('#render-mode')).toHaveValue('points');

    expect(browserErrors).toEqual([]);
  });
});
