import assert from 'node:assert/strict';
import test from 'node:test';

import { rasterizePoints } from '../assets/js/app/analysis/plots/point-raster-worker.js';

const draw = (points, options = {}) => rasterizePoints({
  xs: Float32Array.from(points.map(p => p[0])),
  ys: Float32Array.from(points.map(p => p[1])),
  width: 20,
  height: 10,
  scale: 1,
  radius: 2,
  rgb: [10, 20, 30],
  alpha: 0.8,
  ...options
});

const alphaAt = (image, x, y) => image.pixels[(y * image.width + x) * 4 + 3];

test('a point is a disc of the marker colour at the marker opacity', () => {
  const image = draw([[10.5, 5.5]]);
  assert.equal(image.width, 20);
  assert.equal(image.height, 10);
  assert.equal(alphaAt(image, 10, 5), Math.round(0.8 * 255));
  let mass = 0;
  for (let p = 0; p < image.width * image.height; p++) {
    const a = image.pixels[p * 4 + 3];
    if (a > 0) {
      assert.deepEqual(Array.from(image.pixels.subarray(p * 4, p * 4 + 3)), [10, 20, 30]);
      mass += a / 255 / 0.8;
    }
  }
  // The disc's area, measured on 64 samples a pixel (8-bit alpha rounding).
  assert.ok(Math.abs(mass - Math.PI * 4) < 0.25, String(mass));
  // Nothing beyond the radius.
  assert.equal(alphaAt(image, 14, 5), 0);
  assert.equal(alphaAt(image, 0, 0), 0);
});

test('overlapping points compose as Plotly draws them, one over another', () => {
  const one = draw([[10.5, 5.5]]);
  const two = draw([[10.5, 5.5], [10.5, 5.5]]);
  assert.equal(alphaAt(one, 10, 5), Math.round(0.8 * 255));
  assert.equal(alphaAt(two, 10, 5), Math.round((1 - 0.2 * 0.2) * 255));
});

test('points off the image or without a position draw nothing and do not fail', () => {
  const image = draw([[-50, 5], [5, 500], [NaN, 3], [4, Infinity]]);
  assert.ok(image.pixels.every(v => v === 0));
  const scaled = draw([[10.5, 5.5]], { scale: 2 });
  assert.equal(scaled.width, 40);
  assert.equal(scaled.height, 20);
  assert.equal(alphaAt(scaled, 21, 11), Math.round(0.8 * 255));
});
