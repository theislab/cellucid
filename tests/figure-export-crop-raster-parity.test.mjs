/**
 * A framed (cropped) export must place every point where the vector
 * projector, the preview, the reference grid and the centroid labels place it:
 * the crop rectangle is letterboxed into the plot, never stretched
 * (`fitCropIntoRect`). Its point raster draws only the crop, at the pixels it
 * lands on (`planCropRaster`, the rasterizer's `viewRect01`), so a frame is as
 * sharp as an unframed figure instead of a magnified part of one.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  fitCropIntoRect,
  planCropRaster,
} from '../assets/js/app/ui/modules/figure-export/utils/crop.js';
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
    renderState: {
      mvpMatrix: IDENTITY,
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

/** Where the raster pass draws `ndc`: the zoomed clip transform, then the device rectangle. */
function projectRaster({ ndc, viewport, plotRect, crop }) {
  const crop01 = { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
  const fitted = fitCropIntoRect({
    crop01,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    destRect: plotRect,
  });
  // Device pixels equal CSS pixels here; the renderers snap the same way.
  const x = Math.round(fitted.x);
  const y = Math.round(fitted.y);
  const device = {
    x,
    y,
    width: Math.round(fitted.x + fitted.width) - x,
    height: Math.round(fitted.y + fitted.height) - y,
  };
  const zoom = viewRectClipTransform(crop01);
  const clipX = zoom[0] * ndc[0] + zoom[12];
  const clipY = zoom[5] * ndc[1] + zoom[13];
  return {
    x: device.x + (clipX * 0.5 + 0.5) * device.width,
    y: device.y + (1 - (clipY * 0.5 + 0.5)) * device.height,
    fitted,
  };
}

const CASES = [
  {
    name: 'untouched frame on a wide viewport exported square',
    viewport: { width: 1000, height: 500 },
    plotRect: { x: 0, y: 0, width: 600, height: 600 },
    crop: { enabled: true, x: 0, y: 0, width: 1, height: 1 },
  },
  {
    name: 'narrow frame on a wide plot',
    viewport: { width: 1000, height: 500 },
    plotRect: { x: 40, y: 20, width: 900, height: 300 },
    crop: { enabled: true, x: 0.25, y: 0.1, width: 0.3, height: 0.8 },
  },
  {
    name: 'wide frame on a tall plot',
    viewport: { width: 800, height: 800 },
    plotRect: { x: 10, y: 30, width: 300, height: 700 },
    crop: { enabled: true, x: 0.1, y: 0.4, width: 0.8, height: 0.2 },
  },
];

for (const testCase of CASES) {
  test(`a framed raster places points where the vector projection does: ${testCase.name}`, () => {
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.75], [0.8, 0.1], [0.02, 0.03], [0.97, 0.98]]) {
      const { crop } = testCase;
      const ndc = [
        (crop.x + fx * crop.width) * 2 - 1,
        1 - (crop.y + fy * crop.height) * 2,
      ];
      const vector = projectVector({ ...testCase, ndc });
      const raster = projectRaster({ ...testCase, ndc });
      // Within the whole-pixel snap of the raster's rectangle.
      assert.ok(
        Math.abs(raster.x - vector.x) <= 1 && Math.abs(raster.y - vector.y) <= 1,
        `ndc ${ndc}: raster (${raster.x}, ${raster.y}) !== vector (${vector.x}, ${vector.y})`
      );
    }
  });
}

test('a crop is rasterized at its own pixels, and scaled only past the sprite range', () => {
  const crop01 = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
  // 500x250 viewer pixels of crop onto 1000x500 device pixels: zoom 2.
  const exact = planCropRaster({
    crop01,
    viewportWidth: 1000,
    viewportHeight: 500,
    deviceRect: { x: 0, y: 0, width: 1000, height: 500 },
    zoomLimit: 4,
  });
  assert.deepEqual(exact, { width: 1000, height: 500, zoom: 2, exact: true });
  const limited = planCropRaster({
    crop01,
    viewportWidth: 1000,
    viewportHeight: 500,
    deviceRect: { x: 0, y: 0, width: 1000, height: 500 },
    zoomLimit: 1,
  });
  assert.deepEqual(limited, { width: 500, height: 250, zoom: 1, exact: false });
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

test('every framed raster goes through the shared crop plan', async () => {
  const root = new URL('../assets/js/app/ui/modules/figure-export/', import.meta.url);
  const [pngSource, svgSource] = await Promise.all([
    readFile(new URL('renderers/png-renderer.js', root), 'utf8'),
    readFile(new URL('renderers/svg-renderer.js', root), 'utf8'),
  ]);
  // One prepare step plans every panel's raster; both layouts draw it.
  assert.equal((pngSource.match(/= planPointRaster\(ctx, plotRect, crop01, renderState, zoomLimit\)/g) ?? []).length, 1);
  assert.equal((pngSource.match(/drawPointRaster\(ctx, raster, rasterPlan\)/g) ?? []).length, 2);
  assert.match(svgSource, /planCropRaster\(\{/);
  for (const source of [pngSource, svgSource]) {
    assert.match(source, /viewRect01: (rasterPlan\.viewRect01|crop01),/);
    assert.doesNotMatch(source, /mapCropToRasterDraw/);
  }
});
