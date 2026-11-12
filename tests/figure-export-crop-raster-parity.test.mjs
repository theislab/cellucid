/**
 * An export — framed (cropped) or not — must place every point where the
 * vector projector, the preview, the reference grid and the centroid labels
 * place it: the plot takes its source's aspect (the view's, or the crop's;
 * `fitPlotSize`) and the source fills it, never letterboxed or stretched. Its
 * point raster draws only the source, at the pixels it lands on
 * (`planPlotRaster`, the rasterizer's `viewRect01`), so a frame is as sharp as
 * an unframed figure instead of a magnified part of one.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  figureSourceAspect,
  figureSourceRect,
  fitPlotSize,
  planPlotRaster,
  sourceRect01,
} from '../assets/js/app/ui/modules/figure-export/utils/plot-fit.js';
import { forEachProjectedPoint } from '../assets/js/app/ui/modules/figure-export/utils/point-projector.js';
import { viewRectClipTransform } from '../assets/js/app/ui/modules/figure-export/utils/webgl-point-rasterizer.js';

const IDENTITY = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function projectVector({ ndc, viewport, plotRect, crop }) {
  let projected = null;
  forEachProjectedPoint({
    positions: new Float32Array([ndc[0], ndc[1], 0]),
    dimension: 3,
    colors: new Uint8Array([255, 0, 0, 255]),
    colorAlpha: 'layer',
    pointDiameterViewportPx: 3,
    renderState: {
      mvpMatrix: IDENTITY,
      viewMatrix: IDENTITY,
      modelMatrix: IDENTITY,
      lightDir: Float32Array.from([0, 0, 1]),
      fov: Math.PI / 4,
      sizeAttenuation: 0,
      pointSizeMax: 160,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      pointSize: 5,
    },
    plotRect,
    crop,
    onPoint: (x, y) => {
      projected = { x, y };
    },
  });
  assert.ok(projected, 'vector projector must draw the probe point');
  return projected;
}

/** The case's plot: the largest rectangle of the source's aspect in its box. */
function fittedPlotRect({ viewport, box, crop }) {
  const renderState = { viewportWidth: viewport.width, viewportHeight: viewport.height };
  const fitted = fitPlotSize({ aspect: figureSourceAspect({ renderState, crop }), width: box.width, height: box.height });
  return { x: box.x, y: box.y, ...fitted };
}

/** Where the raster pass draws `ndc`: the zoomed clip transform, then the device rectangle. */
function projectRaster({ ndc, viewport, plotRect, crop }) {
  const source = figureSourceRect({
    renderState: { viewportWidth: viewport.width, viewportHeight: viewport.height },
    crop,
  });
  // Device pixels equal CSS pixels here; the renderers snap the same way.
  const x = Math.round(plotRect.x);
  const y = Math.round(plotRect.y);
  const device = {
    x,
    y,
    width: Math.round(plotRect.x + plotRect.width) - x,
    height: Math.round(plotRect.y + plotRect.height) - y,
  };
  const zoom = viewRectClipTransform(sourceRect01(source));
  const clipX = zoom[0] * ndc[0] + zoom[12];
  const clipY = zoom[5] * ndc[1] + zoom[13];
  return {
    x: device.x + (clipX * 0.5 + 0.5) * device.width,
    y: device.y + (1 - (clipY * 0.5 + 0.5)) * device.height,
  };
}

const CASES = [
  {
    name: 'unframed wide viewport in a square box',
    viewport: { width: 1000, height: 500 },
    box: { x: 0, y: 0, width: 600, height: 600 },
    crop: null,
  },
  {
    name: 'unframed 16:10 viewport exported at 720 x 500',
    viewport: { width: 1440, height: 900 },
    box: { x: 82, y: 30, width: 720, height: 500 },
    crop: null,
  },
  {
    name: 'untouched frame on a wide viewport exported square',
    viewport: { width: 1000, height: 500 },
    box: { x: 0, y: 0, width: 600, height: 600 },
    crop: { enabled: true, x: 0, y: 0, width: 1, height: 1 },
  },
  {
    name: 'narrow frame in a wide box',
    viewport: { width: 1000, height: 500 },
    box: { x: 40, y: 20, width: 900, height: 300 },
    crop: { enabled: true, x: 0.25, y: 0.1, width: 0.3, height: 0.8 },
  },
  {
    name: 'wide frame in a tall box',
    viewport: { width: 800, height: 800 },
    box: { x: 10, y: 30, width: 300, height: 700 },
    crop: { enabled: true, x: 0.1, y: 0.4, width: 0.8, height: 0.2 },
  },
];

for (const testCase of CASES) {
  test(`a raster places points where the vector projection does: ${testCase.name}`, () => {
    const plotRect = fittedPlotRect(testCase);
    const crop = testCase.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.75], [0.8, 0.1], [0.02, 0.03], [0.97, 0.98], [0.001, 0.999], [0.999, 0.001]]) {
      const ndc = [
        (crop.x + fx * crop.width) * 2 - 1,
        1 - (crop.y + fy * crop.height) * 2,
      ];
      const vector = projectVector({ ...testCase, plotRect, ndc });
      const raster = projectRaster({ ...testCase, plotRect, ndc });
      // The source's corners are the plot's corners: no band (to the
      // Float32 positions' precision).
      const plotX = plotRect.x + fx * plotRect.width;
      const plotY = plotRect.y + fy * plotRect.height;
      assert.ok(
        Math.abs(vector.x - plotX) < 1e-4 && Math.abs(vector.y - plotY) < 1e-4,
        `ndc ${ndc}: vector (${vector.x}, ${vector.y}) is not at plot (${plotX}, ${plotY})`
      );
      // Within the whole-pixel snap of the raster's rectangle.
      assert.ok(
        Math.abs(raster.x - vector.x) <= 1 && Math.abs(raster.y - vector.y) <= 1,
        `ndc ${ndc}: raster (${raster.x}, ${raster.y}) !== vector (${vector.x}, ${vector.y})`
      );
    }
  });
}

test('a source is rasterized at its own pixels, and scaled only past the sprite range', () => {
  const source = figureSourceRect({
    renderState: { viewportWidth: 1000, viewportHeight: 500 },
    crop: { enabled: true, x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
  });
  // 500x250 viewer pixels of crop onto 1000x500 device pixels: zoom 2.
  const exact = planPlotRaster({ source, deviceWidth: 1000, deviceHeight: 500, zoomLimit: 4 });
  assert.deepEqual(exact, { width: 1000, height: 500, zoom: 2, exact: true });
  const limited = planPlotRaster({ source, deviceWidth: 1000, deviceHeight: 500, zoomLimit: 1 });
  assert.deepEqual(limited, { width: 500, height: 250, zoom: 1, exact: false });
  // The whole view: the raster's zoom is its device pixels per viewer pixel.
  const whole = figureSourceRect({ renderState: { viewportWidth: 1440, viewportHeight: 900 }, crop: null });
  assert.deepEqual(sourceRect01(whole), { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(
    planPlotRaster({ source: whole, deviceWidth: 720, deviceHeight: 450, zoomLimit: 8 }),
    { width: 720, height: 450, zoom: 0.5, exact: true }
  );
});

test('the zoomed projection maps the crop onto the whole clip square', () => {
  const crop01 = { x: 0.1, y: 0.2, width: 0.4, height: 0.5 };
  const zoom = viewRectClipTransform(crop01);
  const map = (u, v) => [zoom[0] * (2 * u - 1) + zoom[12], zoom[5] * (1 - 2 * v) + zoom[13]];
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !== ${b}`);
  const [left, top] = map(crop01.x, crop01.y);
  const [right, bottom] = map(crop01.x + crop01.width, crop01.y + crop01.height);
  close(left, -1);
  close(top, 1);
  close(right, 1);
  close(bottom, -1);
});

test('every raster goes through the one plot plan, never letterboxed', async () => {
  const root = new URL('../assets/js/app/ui/modules/figure-export/', import.meta.url);
  const [pngSource, svgSource, rasterSource] = await Promise.all([
    readFile(new URL('renderers/png-renderer.js', root), 'utf8'),
    readFile(new URL('renderers/svg-renderer.js', root), 'utf8'),
    readFile(new URL('utils/webgl-point-rasterizer.js', root), 'utf8'),
  ]);
  // One prepare step plans every panel's raster; both layouts draw it.
  assert.equal((pngSource.match(/= planPointRaster\(ctx, plotRect, crop, renderState, zoomLimit\)/g) ?? []).length, 1);
  assert.equal((pngSource.match(/drawPointRaster\(ctx, raster, rasterPlan\)/g) ?? []).length, 2);
  for (const source of [pngSource, svgSource]) {
    assert.match(source, /planPlotRaster\(\{/);
    assert.match(source, /viewRect01: (rasterPlan\.viewRect01|sourceRect01\(source\)),/);
    assert.doesNotMatch(source, /computeLetterboxedRect|fitCropIntoRect|planCropRaster/);
  }
  // The rasterizer always maps its source onto its whole canvas.
  assert.doesNotMatch(rasterSource, /viewRect === null|viewRect01 = null/);
  assert.match(rasterSource, /gl\.viewport\(0, 0, outW, outH\)/);
});
