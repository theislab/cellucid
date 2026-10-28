/**
 * Applying another share of the cells (Session › Open data › Cells to open)
 * keeps where the person was: the camera, the field the view is coloured by
 * and its filters (`ui/modules/subsample-control.js`, `viewCarry`). And what
 * the dataset shows after Apply is exactly what opening it at that share
 * directly shows: positions, colours and visibility, byte for byte.
 *
 * Fixture: `data-mapping-full.h5ad` (300 cells), served at one address for
 * both openings.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { closeContextWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL, SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { fulfillFile } from './helpers/anndata-zarr-zip.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FILE = path.join(FIXTURES, 'data-mapping-full.h5ad');
const URL_OF_FILE = `${SAMPLE_ORIGIN}/subsample-keeps-view/data-mapping-full.h5ad`;

async function open(page, extra = '') {
  const bytes = await readFile(FILE);
  await page.route(URL_OF_FILE, route => fulfillFile(route, bytes));
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&data=${encodeURIComponent(URL_OF_FILE)}${extra}`, { waitUntil: 'domcontentloaded' });
}

/** Colour by the first categorical field and hide its first category. */
async function colourAndFilter(page) {
  return page.evaluate(async () => {
    const state = window._cellucidState;
    const index = state.obsData.fields.findIndex(field => field.kind === 'category' && field._isUserDefined !== true);
    const field = state.obsData.fields[index];
    await state.ensureFieldLoaded(index);
    state.setActiveField(index);
    state.setVisibilityForCategory(state.obsData.fields[index], 0, false);
    return field.key;
  });
}

async function shown(page) {
  return page.evaluate(() => {
    const state = window._cellucidState;
    const viewer = window._cellucidViewer;
    const active = state.obsData.fields[state.activeFieldIndex] ?? null;
    return {
      n: state.pointCount,
      field: active?.key ?? null,
      hidden: active === null ? null : JSON.stringify(active._categoryVisible ?? null),
      camera: viewer.getCameraState(),
      positions: Array.from(state.positionsArray),
      colors: Array.from(state.colorsArray),
      transparency: Array.from(state.categoryTransparency),
    };
  });
}

test('Apply keeps the camera, the coloured field and its filter, and shows what opening at that share shows', async ({ browser }) => {
  // Opened whole, coloured, filtered, camera moved; then 40 % applied.
  const context = await browser.newContext();
  const page = await context.newPage();
  await open(page);
  await expect.poll(() => page.evaluate(() => window._cellucidState?.pointCount)).toBe(300);
  const key = await colourAndFilter(page);
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const camera = structuredClone(viewer.getCameraState());
    camera.orbit.theta += 0.7;
    camera.orbit.phi = Math.min(camera.orbit.phi + 0.3, 2.5);
    camera.orbit.radius *= 1.4;
    viewer.setCameraState(camera);
  });
  // The camera as it stands once nothing moves it any more.
  await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    for (let i = 0; i < 600 && !viewer.getFrameScheduleState().settled; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  });
  const before = await shown(page);
  await openCollapsedPanels(page);
  await page.locator('#subsample-percent').fill('40');
  await page.locator('#subsample-method').selectOption('uniform');
  await page.locator('#subsample-seed').fill('7');
  await page.locator('#subsample-apply').click();
  await expect.poll(() => page.evaluate(() => window._cellucidState.pointCount), { timeout: 30_000 }).toBe(120);
  await expect.poll(() => page.evaluate(() => window._cellucidState.obsData.fields[window._cellucidState.activeFieldIndex]?.key ?? null)).toBe(key);
  await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    for (let i = 0; i < 600 && !viewer.getFrameScheduleState().settled; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  });
  const after = await shown(page);
  await closeContextWithApplicationRetirement(context);

  expect(after.field).toBe(key);
  expect(after.hidden).toEqual(before.hidden);
  expect(after.camera).toEqual(before.camera);

  // Opened at 40 % directly, coloured and filtered the same way.
  const directContext = await browser.newContext();
  const direct = await directContext.newPage();
  await open(direct, '&cells=40%25&sample=uniform&seed=7');
  await expect.poll(() => direct.evaluate(() => window._cellucidState?.pointCount)).toBe(120);
  await colourAndFilter(direct);
  const opened = await shown(direct);
  await closeContextWithApplicationRetirement(directContext);

  expect(after.positions).toEqual(opened.positions);
  expect(after.colors).toEqual(opened.colors);
  expect(after.transparency).toEqual(opened.transparency);
});
