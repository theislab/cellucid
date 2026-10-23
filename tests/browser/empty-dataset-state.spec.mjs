/**
 * Choosing **None** in the Sample dataset dropdown publishes the empty runtime:
 * zero cells, no fields, no genes. Every dataset-dependent action must then be
 * either unavailable with a short reason, or refuse truthfully; none may throw.
 *
 * These assertions come from defects found by driving the running app after
 * None: Keep view, Figure export and Save session threw on the empty runtime;
 * Differential expression and Marker genes threw "Performance settings require
 * an exact positive dataset pointCount" while building their forms; Analyze
 * performance raised a page error waiting for renderer statistics no empty
 * frame publishes; and Load quoted "0 cells and 0 genes now" as if an empty
 * runtime were a dataset.
 */
import { SESSION_BUNDLE_MAGIC_BYTES } from '../../assets/js/app/session/bundle/format.js';
import { readFile, writeFile } from 'node:fs/promises';

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

// No `dataset` parameter: the app opens on the catalog default sample.
const APP_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&acceptance=empty-dataset-state-ci`;
const SAMPLE_OPTION = 'dataset:local-demo:current-ui';
const SAMPLE_NAME = 'Current UI fixture';
const NO_CELLS_TO_MEASURE = 'Load a dataset or generate benchmark data first.';
const GENE_MODES = Object.freeze(['differential', 'signature', 'genesPanel']);
const OTHER_MODES = Object.freeze(['simple', 'detailed', 'correlation']);

function observeProductErrors(page) {
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => {
    pageErrors.push(error.stack || error.message);
  });
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('dialog', dialog => {
    pageErrors.push(`unexpected dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
  return { pageErrors, consoleErrors };
}

async function openSections(page) {
  await openCollapsedPanels(page);
  await page.evaluate(() => {
    for (const id of [
      'page-analysis-section',
      'figure-export-section',
      'benchmark-section',
      'community-annotation-section',
      'highlighted-cells-section',
    ]) {
      const section = document.getElementById(id);
      if (!(section instanceof HTMLDetailsElement)) {
        throw new Error(`#${id} is not a panel`);
      }
      section.open = true;
    }
  });
}

async function saveSession(page, testInfo) {
  const download = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const sessionPath = testInfo.outputPath('sample.cellucid-session');
  await (await download).saveAs(sessionPath);
  return sessionPath;
}

/**
 * Make a saved session one that records no source, as a session saved on a
 * local file does, so loading it cannot open its dataset by itself. The
 * manifest is re-framed in place: `[magic][u32 length][manifest]…`.
 */
async function forgetSessionSource(sessionPath) {
  const bytes = await readFile(sessionPath);
  const magicLength = SESSION_BUNDLE_MAGIC_BYTES.byteLength;
  const length = bytes.readUInt32LE(magicLength);
  const start = magicLength + 4;
  const manifest = JSON.parse(bytes.subarray(start, start + length).toString('utf8'));
  const next = Buffer.from(JSON.stringify({ ...manifest, source: null }), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(next.byteLength, 0);
  await writeFile(sessionPath, Buffer.concat([
    bytes.subarray(0, magicLength),
    header,
    next,
    bytes.subarray(start + length),
  ]));
}

async function openMode(page, mode) {
  const header = page.locator(`#analysis-header-${mode}`);
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  const panel = page.locator(`.analysis-mode-content[data-mode="${mode}"]`);
  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveAttribute('aria-busy', 'true');
  return panel;
}

async function closeMode(page, mode) {
  const header = page.locator(`#analysis-header-${mode}`);
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'false');
}

async function expectInfo(page, text) {
  await expect(
    page.locator('.notification-info .notification-message', { hasText: text }),
  ).toHaveCount(1);
  await page.locator('.notification-info', { hasText: text })
    .locator('.notification-dismiss[data-role="dismiss"]')
    .click();
  await expect(
    page.locator('.notification-info', { hasText: text }),
  ).toHaveCount(0);
}

async function selectAcrossCanvas(page) {
  const box = await page.locator('#glcanvas').boundingBox();
  if (box === null) throw new Error('The plot canvas has no box.');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.keyboard.down('Alt');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 4 });
  await page.mouse.move(x, y + 80, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.mouse.move(x + 10, y + 10);
}

test('None leaves every dataset action unavailable or truthful, and a sample restores them', async (
  { page },
  testInfo,
) => {
  test.setTimeout(180_000);
  const { pageErrors, consoleErrors } = observeProductErrors(page);

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(SAMPLE_NAME);
  await openSections(page);
  const sessionPath = await saveSession(page, testInfo);
  // A session that records its sample would open it; one saved on a local
  // file records nothing, and loading it with no dataset open names the one
  // it needs.
  await forgetSessionSource(sessionPath);

  await page.locator('#dataset-select').selectOption('__none__');
  await expect(page.locator('#dataset-name')).toHaveText('—');
  await openSections(page);

  // Keep view, Figure export and Save act on cells: unavailable, with a reason.
  const keepView = page.locator('#split-keep-view-btn');
  await expect(keepView).toBeDisabled();
  await expect(keepView).toHaveAttribute('title', 'Load a dataset to keep views');
  const exportButton = page.locator('#figure-export-btn');
  await expect(exportButton).toBeDisabled();
  await expect(exportButton).toHaveAttribute(
    'title',
    'Load a dataset to export a figure',
  );
  const saveButton = page.locator('#save-state-btn');
  await expect(saveButton).toBeDisabled();
  await expect(saveButton).toHaveAttribute(
    'title',
    'Load a dataset to save a session',
  );

  // Load stays available and names the dataset the session needs.
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  await (await chooser).setFiles(sessionPath);
  const refusal = page.locator('.notification-error', {
    hasText: 'No dataset is open.',
  });
  await expect(refusal).toHaveCount(1);
  await expect(refusal).toContainText('"current-ui"');
  await expect(refusal).not.toContainText('0 cells');

  // The modes built on gene expression say so instead of building a form.
  for (const mode of GENE_MODES) {
    const panel = await openMode(page, mode);
    await expect(panel).toContainText('Requires gene expression data.');
    await expect(panel.locator('.analysis-run-btn')).toHaveCount(0);
    await closeMode(page, mode);
  }
  for (const mode of OTHER_MODES) {
    await openMode(page, mode);
    await closeMode(page, mode);
  }
  // Such a mode has no form, so there are no settings to copy into a window.
  for (const mode of GENE_MODES) {
    await page
      .locator(`.analysis-mode[data-mode="${mode}"] .analysis-mode-copy-btn`)
      .click({ force: true });
    await expectInfo(page, 'Requires gene expression data.');
  }
  await expect(
    page.locator('#floating-panels-root .analysis-window-panel'),
  ).toHaveCount(0);

  // The diagnostics measure drawn cells; with none they say what to do.
  await page.locator('#bottleneck-analyze-btn').click();
  await expectInfo(page, NO_CELLS_TO_MEASURE);
  await expect(page.locator('#bottleneck-analyze-btn')).toBeEnabled();
  await page.locator('#benchmark-report-btn').click();
  await expectInfo(page, NO_CELLS_TO_MEASURE);

  // A repository is connected per dataset.
  const annotation = page.locator('#community-annotation-controls');
  await expect(annotation).toContainText(
    'Load a dataset to connect a repository.',
  );
  await expect(
    annotation.locator('[data-community-annotation-action="github-connection"]'),
  ).toBeDisabled();

  // Every highlight tool, with and without Select mode, over an empty plot.
  for (const tool of ['annotation', 'knn', 'proximity', 'lasso']) {
    await page.locator(`#highlight-mode-${tool}`).click();
    await selectAcrossCanvas(page);
  }
  await page.locator('#highlight-select-mode').click();
  await expect(page.locator('#highlight-select-mode')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await selectAcrossCanvas(page);
  await page.locator('#highlight-select-mode').click();

  // The plot's keyboard shortcuts act on the camera and the empty runtime.
  await page.locator('#glcanvas').focus();
  for (const key of ['1', '2', '3', 'r', 'o', 'p', 'g', 'o', 'x', 'w', '=', '-']) {
    await page.keyboard.press(key);
  }

  // Choosing a sample again restores every action.
  await page.locator('#dataset-select').selectOption(SAMPLE_OPTION);
  await expect(page.locator('#dataset-name')).toHaveText(SAMPLE_NAME);
  await expect(keepView).toBeEnabled();
  await expect(exportButton).toBeEnabled();
  await expect(saveButton).toBeEnabled();
  await expect(
    annotation.locator('[data-community-annotation-action="github-connection"]'),
  ).toBeEnabled();
  const differential = await openMode(page, 'differential');
  await expect(differential.locator('.analysis-run-btn')).toHaveCount(1);
  await closeMode(page, 'differential');
  await page
    .locator('.analysis-mode[data-mode="differential"] .analysis-mode-copy-btn')
    .click({ force: true });
  await expect(
    page.locator('#floating-panels-root .analysis-window-panel'),
  ).toHaveCount(1);
  await keepView.click();
  await expect(page.locator('.split-badge')).toHaveCount(2);
  await saveSession(page, testInfo);
  await expect(
    page.locator('.notification-success', {
      hasText: 'Session saved successfully',
    }),
  ).not.toHaveCount(0);

  expect(pageErrors).toEqual([]);
  // The refused session load is the one error the app reports, by design.
  // Its text is asserted on the notification above: Firefox prints the
  // logged error as a handle, not as its message.
  expect(consoleErrors).toEqual([
    expect.stringMatching(/^Failed to load state: /),
  ]);
});
