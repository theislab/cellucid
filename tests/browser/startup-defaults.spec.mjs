import { expect, test } from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';

const DEFAULT_STARTUP_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&acceptance=startup-defaults-ci`;

test('every startup shows onboarding and adopts the catalog default with exact UI defaults', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.removeItem('cellucid_viewer_background');
  });
  await page.goto(DEFAULT_STARTUP_URL, { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#welcome-modal')).toBeVisible();
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');
  await expect(page.locator('#dataset-select')).toHaveValue(
    'dataset:local-demo:current-ui-prepared',
  );
  await expect(page.locator('#cinematic-camera-section')).not.toHaveAttribute('open', '');
  await expect(page.locator('#community-annotation-section')).not.toHaveAttribute('open', '');
  await expect(page.locator('html')).toHaveAttribute('data-viewer-background', 'grid');
  await expect(page.locator('#background-select')).toHaveValue('grid');
  await expect(page.locator('#cinematic-autoplay')).not.toBeChecked();

  const buildIdentity = await page.evaluate(() => ({
    meta: document
      .querySelector('meta[name="cellucid-web-build-id"]')
      ?.getAttribute('content'),
    footer: document.getElementById('web-build-version')?.textContent,
  }));
  expect(buildIdentity.meta).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  expect(buildIdentity.footer).toBe(buildIdentity.meta);

  await page.keyboard.press('Escape');
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#welcome-modal')).toBeVisible();
});

test('the default light grid publishes stable light framebuffer pixels', async ({
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
  page.on('response', response => {
    if (response.status() >= 400) {
      browserErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  await page.addInitScript(() => {
    localStorage.removeItem('cellucid_viewer_background');
  });
  await page.goto(DEFAULT_STARTUP_URL, { waitUntil: 'domcontentloaded' });
  await page.keyboard.press('Escape');
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );

  const evidence = await page.evaluate(async () => {
    const canvas = document.getElementById('glcanvas');
    const gl = canvas.getContext('webgl2');
    const positions = [
      [0.55, 0.25],
      [0.70, 0.30],
      [0.82, 0.40],
      [0.50, 0.50],
      [0.65, 0.60],
      [0.80, 0.70],
    ];
    const frames = [];

    for (let frame = 0; frame < 8; frame += 1) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      gl.finish();
      const lumas = positions.map(([fractionX, fractionY]) => {
        const pixel = new Uint8Array(4);
        gl.readPixels(
          Math.floor(gl.drawingBufferWidth * fractionX),
          Math.floor(gl.drawingBufferHeight * fractionY),
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixel,
        );
        return (
          0.2126 * pixel[0] +
          0.7152 * pixel[1] +
          0.0722 * pixel[2]
        ) / 255;
      });
      frames.push({
        meanLuma:
          lumas.reduce((sum, value) => sum + value, 0) / lumas.length,
        lightPixelCount: lumas.filter(value => value >= 0.85).length,
        clearColor: [...gl.getParameter(gl.COLOR_CLEAR_VALUE)],
        framebufferIsDefault:
          gl.getParameter(gl.FRAMEBUFFER_BINDING) === null,
        error: gl.getError(),
      });
    }

    return {
      ui: {
        theme: document.getElementById('theme-select').value,
        background: document.getElementById('background-select').value,
        rootBackground:
          document.documentElement.dataset.viewerBackground,
      },
      renderBackground: [
        ...window._cellucidViewer.getRenderState().bgColor,
      ],
      frames,
    };
  });

  await testInfo.attach('light-grid-framebuffer.json', {
    body: Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`),
    contentType: 'application/json',
  });

  expect(evidence.ui).toEqual({
    theme: 'light',
    background: 'grid',
    rootBackground: 'grid',
  });
  expect(evidence.renderBackground).toEqual([
    Math.fround(0.965),
    Math.fround(0.965),
    Math.fround(0.970),
  ]);
  for (const frame of evidence.frames) {
    expect(frame.meanLuma).toBeGreaterThan(0.85);
    expect(frame.lightPixelCount).toBeGreaterThanOrEqual(5);
    expect(frame.clearColor).toEqual([
      Math.fround(0.965),
      Math.fround(0.965),
      Math.fround(0.970),
      1,
    ]);
    expect(frame.framebufferIsDefault).toBe(true);
    expect(frame.error).toBe(0);
  }
  const frameLumas = evidence.frames.map(frame => frame.meanLuma);
  expect(Math.max(...frameLumas) - Math.min(...frameLumas)).toBeLessThan(
    0.01,
  );
  expect(browserErrors).toEqual([]);
});
