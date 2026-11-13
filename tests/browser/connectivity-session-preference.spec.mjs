/**
 * A session saved with connectivity edges shown loads back on a page whose
 * graph is not read yet, and shows the edge count it recorded.
 *
 * The Max edges slider's range is the graph's visible edges, which are read
 * only when edges are switched on; until then it spans 0..0. A session
 * records the person's preference (`data-session-preference`,
 * `state-serializer/ui-controls.js`), not the slider's *value*: a value would
 * be checked against that range before any control is applied, and every
 * session saved with edges shown would be refused on load (`Session UI
 * control "connectivity-limit" value is above its current maximum`). The
 * slider shows what the graph allows of the preference once the graph is read.
 *
 * Fixture: `data-mapping-full.h5ad` (300 cells, three graphs).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { chooseFiles } from './helpers/file-input.mjs';
import { clickSaveSession, clickLoadSession } from './helpers/session-buttons.mjs';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'data-mapping-full.h5ad',
);
const START_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=connectivity-session-preference';

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function openFixture(page) {
  await chooseFiles(page.locator('#user-data-file-input'), FIXTURE);
  await expect.poll(() => page.evaluate(() => window._cellucidState.pointCount)).toBe(300);
}

const shownEdges = page => page.evaluate(
  () => window._cellucidViewer.getEdgeSelectionStatsForView('live')?.shownCount ?? 0,
);

test('a session saved with edges shown restores the edge count it recorded', async ({ page }, testInfo) => {
  const errors = collectBrowserErrors(page);
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await openCollapsedPanels(page);
  await openFixture(page);

  await page.locator('#toggle-connectivity').check();
  await expect(page.locator('#connectivity-sliders')).toBeVisible();
  await expect.poll(() => shownEdges(page)).toBeGreaterThan(0);
  const visible = Number(await page.locator('#connectivity-limit').getAttribute('max'));
  const minimum = Number(await page.locator('#connectivity-limit').getAttribute('min'));
  expect(visible).toBeGreaterThan(minimum);

  // Fewer edges than the graph shows, chosen as a person does.
  const chosen = await page.locator('#connectivity-limit').evaluate(input => {
    input.value = String(Number(input.min));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return Number(input.value);
  });
  expect(chosen).toBe(minimum);
  await expect.poll(() => shownEdges(page)).toBe(chosen);

  const downloadPromise = page.waitForEvent('download');
  await clickSaveSession(page);
  const download = await downloadPromise;
  const sessionPath = testInfo.outputPath('edges.cellucid-session');
  await download.saveAs(sessionPath);

  // The same dataset opened again: its graph is not read, and the slider
  // spans 0..0 until edges are switched on.
  await openFixture(page);
  await expect(page.locator('#toggle-connectivity')).not.toBeChecked();
  await expect(page.locator('#connectivity-limit')).toHaveAttribute('max', '0');

  const chooserPromise = page.waitForEvent('filechooser');
  await clickLoadSession(page);
  const chooser = await chooserPromise;
  await chooser.setFiles(sessionPath);

  await expect(page.locator('#toggle-connectivity')).toBeChecked();
  await expect.poll(() => shownEdges(page)).toBe(chosen);
  await expect(page.locator('#connectivity-limit')).toHaveAttribute('max', String(visible));
  await expect(page.locator('#connectivity-limit')).toHaveValue(String(chosen));
  await expect(page.locator('#connectivity-limit')).toHaveAttribute(
    'data-session-preference',
    String(chosen),
  );
  expect(errors).toEqual([]);
});
