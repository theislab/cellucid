/**
 * Smoke mode and a dataset switch, repeated: the volume, its noise and its
 * render target are built, and a dataset is opened over them after leaving
 * smoke mode, while the noise is still being generated, and while smoke is
 * shown. Nothing smoke left bound or pending may reach the new dataset's
 * renderer: every switch opens it, the WebGL error queue is empty after
 * every step, and no failure is announced.
 *
 * Fixtures: `data-mapping-full.h5ad` (300 cells, three graphs) and
 * `byte-order-little-endian.h5ad` (8 cells).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const LARGER = path.join(FIXTURES, 'data-mapping-full.h5ad');
const SMALLER = path.join(FIXTURES, 'byte-order-little-endian.h5ad');
const START_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=smoke-dataset-switch';

function collectBrowserErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function settleFrames(page) {
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

/** What a step left: pending WebGL errors (read, so drained) and failures. */
async function residue(page) {
  return page.evaluate(() => {
    const gl = document.getElementById('glcanvas').getContext('webgl2');
    const codes = [];
    for (let read = 0; read < 8; read++) {
      const code = gl.getError();
      if (code === gl.NO_ERROR) break;
      codes.push(`0x${code.toString(16)}`);
    }
    return {
      glErrors: codes,
      failures: [...document.querySelectorAll('.notification-error')]
        .map(node => node.textContent.trim()),
    };
  });
}

async function openFile(page, file, cells) {
  await page.locator('#user-data-h5ad-input').setInputFiles(file);
  await expect.poll(() => page.evaluate(() => window._cellucidState.pointCount)).toBe(cells);
  await settleFrames(page);
  expect(await residue(page)).toEqual({ glErrors: [], failures: [] });
}

async function smokeOn(page, { ready }) {
  await page.locator('#render-mode').selectOption('smoke');
  await expect(page.locator('#render-mode')).toHaveValue('smoke');
  if (!ready) return;
  await expect.poll(() => page.evaluate(() => (
    window._cellucidViewer.hasSmokeVolume()
    && window._cellucidViewer.hasSmokeNoiseTextures()
  ))).toBe(true);
  await settleFrames(page);
  expect(await residue(page)).toEqual({ glErrors: [], failures: [] });
}

test('smoke mode followed by a dataset switch, repeated, leaves no GL state behind', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectBrowserErrors(page);
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await openCollapsedPanels(page);
  // The smallest volume and noise: the switches, not the build, are tested.
  for (const id of ['smoke-grid', 'noise-resolution']) {
    await page.locator(`#${id}`).evaluate(input => {
      input.value = '0';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  for (const [round, leave] of [
    'points after smoke',
    'during noise generation',
    'while smoke is shown',
    'points after smoke',
    'while smoke is shown',
  ].entries()) {
    await test.step(`round ${round}: switch ${leave}`, async () => {
      await openFile(page, LARGER, 300);
      await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
      if (round % 2 === 1) {
        await page.locator('#toggle-connectivity').check();
        await expect(page.locator('#connectivity-sliders')).toBeVisible();
      }
      await smokeOn(page, { ready: leave !== 'during noise generation' });
      if (leave === 'points after smoke') {
        await page.locator('#render-mode').selectOption('points');
        await settleFrames(page);
        expect(await residue(page)).toEqual({ glErrors: [], failures: [] });
      }
      await openFile(page, SMALLER, 8);
      expect(await page.evaluate(() => window._cellucidViewer.getPointCount())).toBe(8);
      if (await page.locator('#render-mode').inputValue() === 'smoke') {
        await page.locator('#render-mode').selectOption('points');
        await settleFrames(page);
      }
    });
  }
  expect(await residue(page)).toEqual({ glErrors: [], failures: [] });
  expect(errors).toEqual([]);
});

test('a smoke volume build never re-binds a texture deleted while Chrome still reports it bound', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  const outcome = await page.evaluate(async () => {
    const { createDensityTexture3D, buildDerivedVolumesGPU } = await import(
      '/assets/js/rendering/smoke-cloud/smoke-density.js'
    );
    const { deleteTextureTracked } = await import('/assets/js/rendering/gl-utils.js');
    const gl = document.getElementById('glcanvas').getContext('webgl2');
    const pending = gl.getError();
    const n = 8;
    const density = createDensityTexture3D(gl, {
      boundsMax: [1, 1, 1],
      boundsMin: [-1, -1, -1],
      data: new Float32Array(n * n * n).fill(0.5),
      gridSize: n,
    });
    // What smoke leaves on a dataset switch: a volume bound to TEXTURE_3D on a
    // unit whose 2D binding is null, then deleted. Chrome keeps reporting it
    // bound there, so a build that saves and restores that unit's bindings
    // would re-bind a deleted texture (INVALID_OPERATION, 0x502).
    const stale = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, stale);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    deleteTextureTracked(gl, stale);
    gl.activeTexture(gl.TEXTURE1);
    const reportedAfterDeletion = gl.getParameter(gl.TEXTURE_BINDING_3D) === stale;
    gl.activeTexture(gl.TEXTURE0);
    let failure = null;
    let derived = null;
    try {
      derived = buildDerivedVolumesGPU(gl, density.texture, { gridSize: n, lightDir: [0, 0, 1] });
    } catch (error) {
      failure = error.message;
    }
    const after = gl.getError();
    deleteTextureTracked(gl, derived?.lightTexture ?? null);
    deleteTextureTracked(gl, derived?.occupancyTexture ?? null);
    deleteTextureTracked(gl, density.texture);
    gl.activeTexture(gl.TEXTURE1);
    const restoredStale = gl.getParameter(gl.TEXTURE_BINDING_3D) === stale;
    gl.activeTexture(gl.TEXTURE0);
    return { pending, reportedAfterDeletion, failure, after, restoredStale };
  });
  // The browser condition the build must survive (if a later Chrome clears
  // the binding, the build is still exercised and must still be clean).
  expect(typeof outcome.reportedAfterDeletion).toBe('boolean');
  expect(outcome).toMatchObject({ pending: 0, failure: null, after: 0, restoredStale: false });
  expect(errors).toEqual([]);
});
