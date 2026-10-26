/**
 * The sculpted point pass changes blend state for its own draw and only for
 * it.
 *
 * Its depth pass replaces colour instead of blending it and, with antialiasing
 * on, turns each fragment's disc coverage into a multisample coverage mask
 * (SAMPLE_ALPHA_TO_COVERAGE). Every later pass of the frame — highlight rings,
 * connectivity, centroids, the orbit anchor — assumes the straight-alpha
 * baseline with no coverage mask, so the point pass must restore it after its
 * draw, in every pane.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=sculpted-point-pass-state-ci';

async function recordFrame(page) {
  return page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const gl = viewer.getGLContext();
    const pointCount = window._cellucidState.pointCount;
    const highlight = new Uint8Array(pointCount);
    highlight[0] = 255;
    highlight[1] = 255;
    viewer.updateHighlight(highlight);
    await new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const draws = [];
    const original = gl.drawArrays;
    gl.drawArrays = function recordedDraw(mode, first, count) {
      draws.push({
        count,
        coverageMask: gl.isEnabled(gl.SAMPLE_ALPHA_TO_COVERAGE),
        blendSource: gl.getParameter(gl.BLEND_SRC_RGB),
        blendDestination: gl.getParameter(gl.BLEND_DST_RGB),
        multisampled: gl.getParameter(gl.SAMPLES) > 0,
      });
      return Reflect.apply(original, this, [mode, first, count]);
    };
    try {
      viewer.setPointSize(3);
      await new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
    } finally {
      delete gl.drawArrays;
    }
    return {
      afterFrame: {
        coverageMask: gl.isEnabled(gl.SAMPLE_ALPHA_TO_COVERAGE),
        blendSource: gl.getParameter(gl.BLEND_SRC_RGB),
      },
      dimension: viewer.getViewDimension('live'),
      draws,
      pointCount,
      constants: {
        ONE: gl.ONE,
        ZERO: gl.ZERO,
        SRC_ALPHA: gl.SRC_ALPHA,
        ONE_MINUS_SRC_ALPHA: gl.ONE_MINUS_SRC_ALPHA,
      },
    };
  });
}

function expectBaselineAround(result, scatterOpaque) {
  const scatter = result.draws.filter(draw => draw.count === result.pointCount);
  const others = result.draws.filter(draw => draw.count !== result.pointCount);
  expect(scatter.length).toBeGreaterThan(0);
  expect(others.length).toBeGreaterThan(0);
  for (const draw of scatter) {
    if (scatterOpaque) {
      expect(draw.blendSource).toBe(result.constants.ONE);
      expect(draw.blendDestination).toBe(result.constants.ZERO);
      expect(draw.coverageMask).toBe(draw.multisampled);
    } else {
      // A pass without depth blends its antialiased rim like every quality.
      expect(draw.blendSource).toBe(result.constants.SRC_ALPHA);
      expect(draw.blendDestination).toBe(result.constants.ONE_MINUS_SRC_ALPHA);
      expect(draw.coverageMask).toBe(false);
    }
  }
  for (const draw of others) {
    expect(draw.coverageMask).toBe(false);
  }
  expect(result.afterFrame.coverageMask).toBe(false);
  expect(result.afterFrame.blendSource).toBe(result.constants.SRC_ALPHA);
}

test('the sculpted point pass masks coverage for itself and restores the baseline', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  await page.evaluate(() => {
    window._cellucidViewer.setAntialiasing(true);
    const select = document.getElementById('hp-shader-quality');
    select.value = 'sculpted';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // The fixture is a 2-D embedding: drawn without depth, blended.
  const flat = await recordFrame(page);
  expect(flat.dimension).toBe(2);
  expectBaselineAround(flat, false);

  // A 3-D embedding: the opaque depth pass, coverage-masked when multisampled.
  await page.locator('#benchmark-section > summary').click();
  await page.locator('#benchmark-count').fill('20000');
  await page.locator('#benchmark-pattern').selectOption('clusters');
  await page.locator('#benchmark-run').click();
  await expect
    .poll(() => page.evaluate(() => window._cellucidState.pointCount), {
      timeout: 120_000,
    })
    .toBe(20000);
  await page.evaluate(() => window._cellucidViewer.setAntialiasing(true));
  const deep = await recordFrame(page);
  expect(deep.dimension).toBe(3);
  expectBaselineAround(deep, true);
});
