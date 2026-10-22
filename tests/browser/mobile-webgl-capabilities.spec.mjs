// The app on an iPhone's WebGL2 capability set (helpers/ios-webgl-capabilities).
//
// iOS Safari, and many Android GPUs, offer float32 render targets but neither
// float32 blending (EXT_float_blend) nor filtering (OES_texture_float_linear).
// Volumetric smoke needs float32 blending and cannot run there: choosing it,
// or restoring a session that stores it, must say so in plain words and leave
// a working Points view. Everything else -- points, highlights, figure export
// -- must work unchanged.

import { readFile } from 'node:fs/promises';

import { expect, test } from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { installIosWebGLCapabilities } from './helpers/ios-webgl-capabilities.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { decodePng } from './helpers/png-pixels.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}`
  + '&dataset=current-ui-prepared&acceptance=mobile-webgl-capabilities-ci';

const SMOKE_UNAVAILABLE_MESSAGE =
  "Volumetric smoke isn't available on this device: its graphics driver can't "
  + 'blend high-precision colour, which the smoke cloud needs to add up the '
  + 'cells. Points rendering works as usual.';

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  return errors;
}

async function openDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing all 120 cells',
  );
}

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

/** Pixels that differ from the image's corner (the background) by > 24. */
function foregroundPixels({ width, height, channels, pixels }) {
  const background = [pixels[0], pixels[1], pixels[2]];
  let count = 0;
  for (let index = 0; index < width * height; index++) {
    const at = index * channels;
    const distance = Math.abs(pixels[at] - background[0])
      + Math.abs(pixels[at + 1] - background[1])
      + Math.abs(pixels[at + 2] - background[2]);
    if (distance > 24) count++;
  }
  return count;
}

function differingPixels(left, right) {
  let count = 0;
  for (let index = 0; index < left.pixels.length; index += left.channels) {
    if (
      left.pixels[index] !== right.pixels[index]
      || left.pixels[index + 1] !== right.pixels[index + 1]
      || left.pixels[index + 2] !== right.pixels[index + 2]
    ) count++;
  }
  return count;
}

async function captureCanvas(page) {
  await settle(page);
  return decodePng(await page.locator('#glcanvas').screenshot());
}

async function expectSmokeUnavailableNotice(page) {
  const notice = page.locator('#notification-center .notification')
    .filter({ hasText: SMOKE_UNAVAILABLE_MESSAGE });
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText('Volumetric smoke unavailable');
}

test('the emulated context reports an iPhone capability set', async ({ page }) => {
  await installIosWebGLCapabilities(page);
  await page.goto('/tests/browser/fixtures/webgl-harness.html');
  const probe = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    return {
      colorBufferFloat: gl.getExtension('EXT_color_buffer_float') !== null,
      floatBlend: gl.getExtension('EXT_float_blend'),
      floatLinear: gl.getExtension('OES_texture_float_linear'),
      listed: gl.getSupportedExtensions().filter(
        name => name === 'EXT_float_blend' || name === 'OES_texture_float_linear'
      ),
      max3D: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      emulated: window.__cellucidIosWebGLEmulation === true,
    };
  });
  expect(probe).toMatchObject({
    colorBufferFloat: true,
    floatBlend: null,
    floatLinear: null,
    listed: [],
    emulated: true,
  });
  expect(probe.max3D).toBeLessThanOrEqual(2048);
  expect(probe.maxTexture).toBeLessThanOrEqual(4096);
});

test('choosing smoke on an iPhone-class device explains why and keeps Points working', async ({
  page,
}, testInfo) => {
  const productErrors = observeProductErrors(page);
  await installIosWebGLCapabilities(page);
  await openDataset(page);
  const before = await captureCanvas(page);
  expect(foregroundPixels(before)).toBeGreaterThan(200);

  await page.locator('#render-mode').selectOption('smoke');
  await expectSmokeUnavailableNotice(page);
  await expect(page.locator('#render-mode')).toHaveValue('points');
  await expect(page.locator('#smoke-controls')).not.toHaveClass(/visible/);
  expect(await page.evaluate(() => ({
    support: window._cellucidViewer.getSmokeSupport().reason,
    volume: window._cellucidViewer.hasSmokeVolume(),
  }))).toEqual({ support: 'float-blend', volume: false });
  await testInfo.attach('smoke-unavailable-notice.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  // Points are still drawn.
  const after = await captureCanvas(page);
  expect(foregroundPixels(after)).toBeGreaterThan(200);
  expect(productErrors).toEqual([]);
});

test('a smoke session restored on an iPhone-class device opens in Points with the same message', async ({
  page,
}, testInfo) => {
  // Save a smoke session where smoke can run ...
  await openDataset(page);
  await page.locator('#render-mode').selectOption('smoke');
  await expect(page.locator('#render-mode')).toHaveValue('smoke');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const download = await downloadPromise;
  const sessionPath = testInfo.outputPath('smoke.cellucid-session');
  await download.saveAs(sessionPath);

  // ... and restore it where it cannot.
  const productErrors = observeProductErrors(page);
  await installIosWebGLCapabilities(page);
  await openDataset(page);
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(sessionPath);

  await expectSmokeUnavailableNotice(page);
  await expect(page.locator('#render-mode')).toHaveValue('points');
  await expect(
    page.locator('#notification-center .notification-error'),
  ).toHaveCount(0);
  expect(foregroundPixels(await captureCanvas(page))).toBeGreaterThan(200);
  expect(productErrors).toEqual([]);
});

test('points, highlights and figure export work on an iPhone-class device', async ({
  page,
}, testInfo) => {
  const productErrors = observeProductErrors(page);
  await installIosWebGLCapabilities(page);
  await openDataset(page);

  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => {
    const state = window._cellucidState;
    const field = state.obsData.fields[state.activeFieldIndex];
    return field?.key === 'cell_type' && field.codes != null;
  })).toBe(true);
  const coloured = await captureCanvas(page);
  expect(foregroundPixels(coloured)).toBeGreaterThan(200);

  const highlighted = await page.evaluate(() => {
    const state = window._cellucidState;
    state.addHighlightFromCategory(state.activeFieldIndex, 0, 'obs');
    return state.getHighlightedCellCount();
  });
  expect(highlighted).toBeGreaterThan(0);
  const withHighlight = await captureCanvas(page);
  expect(differingPixels(coloured, withHighlight)).toBeGreaterThan(20);

  await page.locator('#figure-export-section > summary').click();
  await expect(page.locator('#figure-export-section')).toHaveAttribute('open', '');
  await page.getByRole('button', { name: /^Download\b/ }).click();
  await page.getByLabel('Download format').selectOption('png');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#figure-export-btn').click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  const outputPath = testInfo.outputPath('ios-figure-export.png');
  await download.saveAs(outputPath);
  const exported = decodePng(await readFile(outputPath));
  expect(exported.width).toBeGreaterThan(100);
  expect(foregroundPixels(exported)).toBeGreaterThan(200);

  expect(productErrors).toEqual([]);
});
