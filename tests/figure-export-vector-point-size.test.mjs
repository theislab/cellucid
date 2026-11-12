/**
 * L6-1 (2026-11-11): the vector strategies draw each cell at the size the
 * viewer draws it.
 *
 * The point shaders take `u_pointSize` as a scale: with size attenuation the
 * sprite is `mix(u_pointSize, u_pointSize · pointScale / eyeDepth, a)` pixels.
 * Full Vector and Optimized Vector circles (and the centroid discs of every
 * format) took `u_pointSize` as the pixel diameter, so at the default
 * attenuation of 0.8 a 3-D figure drew specks where the screen drew spheres
 * several times larger, and near and far cells the same size.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { createViewportPointDiameter } from '../assets/js/app/ui/modules/figure-export/utils/point-size.js';
import { POINT_SPRITE_MAX_PX } from '../assets/js/rendering/point-sprite.js';
import { forEachProjectedPoint } from '../assets/js/app/ui/modules/figure-export/utils/point-projector.js';
import { writeSvgPointMarkup } from '../assets/js/app/ui/modules/figure-export/renderers/svg-point-markup.js';
import { renderSvgCentroidOverlay } from '../assets/js/app/ui/modules/figure-export/components/centroid-overlay.js';

const IDENTITY = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** A 900 px tall pane, its camera 3 units from the origin looking down -z. */
function renderState({ sizeAttenuation = 0.8, pointSize = 5 } = {}) {
  const fov = Math.PI / 4;
  const projectionMatrix = perspective(fov, 1440 / 900, 0.01, 100);
  const viewMatrix = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -3, 1]);
  return {
    viewportWidth: 1440,
    viewportHeight: 900,
    fov,
    projectionMatrix,
    viewMatrix,
    modelMatrix: IDENTITY,
    mvpMatrix: multiply(projectionMatrix, viewMatrix),
    lightDir: Float32Array.from([0, 0, 1]),
    sizeAttenuation,
    pointSize,
    pointSizeMax: POINT_SPRITE_MAX_PX,
    shaderQuality: 'ultralight',
    fogDensity: 0,
    fogNear: 0,
    fogFar: 1,
    fogColor: Float32Array.from([1, 1, 1]),
  };
}

/** The shader's sprite size, written out: HP_VS_* and CENTROID_VS. */
function shaderSprite({ pointSize, eyeDepth, attenuation }) {
  const pointScale = (900 / (2 * Math.tan(Math.PI / 8))) * 0.01;
  const perspectiveSize = (pointSize * pointScale) / Math.max(eyeDepth, 0.001);
  const size = pointSize * (1 - attenuation) + perspectiveSize * attenuation;
  return Math.min(Math.max(size, 0.5), POINT_SPRITE_MAX_PX);
}

test('the shaders size a sprite as the export reproduces it', async () => {
  // One sizing function for every point shader (rendering/point-sprite.js,
  // whose GLSL and JavaScript agree: tests/point-sprite-contract.test.mjs).
  const highPerf = await readFile(new URL('../assets/js/rendering/shaders/high-perf-shaders.js', import.meta.url), 'utf8');
  assert.equal(highPerf.match(/gl_PointSize = pointSpriteSize\(eyeDepth\);/g)?.length, 2);
  const centroid = await readFile(new URL('../assets/js/rendering/shaders/centroid-shaders.js', import.meta.url), 'utf8');
  assert.match(centroid, /gl_PointSize = pointSpriteSize\(eyeDepth\);/);
});

test('a sprite is its shader size at its own depth', () => {
  const diameterAt = createViewportPointDiameter(renderState());
  for (const [z, eyeDepth] of [[0, 3], [1, 2], [-2, 5]]) {
    const expected = shaderSprite({ pointSize: 5, eyeDepth, attenuation: 0.8 });
    assert.ok(Math.abs(diameterAt(0, 0, z, 5) - expected) < 1e-9, `z = ${z}`);
  }
  // Nearer is larger; without attenuation every sprite is u_pointSize.
  assert.ok(diameterAt(0, 0, 1, 5) > diameterAt(0, 0, 0, 5));
  const flat = createViewportPointDiameter(renderState({ sizeAttenuation: 0 }));
  assert.equal(flat(0, 0, 1, 5), 5);
  // The shader's cap.
  assert.equal(diameterAt(0, 0, 2.999, 5), POINT_SPRITE_MAX_PX);
  assert.equal(flat(0, 0, 0, 0.1), 0.5);
  assert.throws(() => createViewportPointDiameter({ ...renderState(), sizeAttenuation: 2 }), /size attenuation/);
});

test('full and optimized vector circles, and centroid discs, are the sprites the screen draws', async () => {
  const state = renderState();
  // A plot at half the screen's size: a viewport pixel is half a plot unit.
  const plotRect = { x: 0, y: 0, width: 720, height: 450 };
  const positions = Float32Array.from([0, 0, 0, 0.2, 0.1, 1]);
  const colors = Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]);
  const expected = [
    shaderSprite({ pointSize: 5, eyeDepth: 3, attenuation: 0.8 }) / 2 * 0.5,
    shaderSprite({ pointSize: 5, eyeDepth: 2, attenuation: 0.8 }) / 2 * 0.5,
  ];
  const radii = new Map();
  forEachProjectedPoint({
    positions,
    dimension: 3,
    colors,
    colorAlpha: 'layer',
    renderState: state,
    plotRect,
    pointDiameterViewportPx: 5,
    onPoint: (_x, _y, _r, _g, _b, _a, radius, index) => radii.set(index, radius),
  });
  for (const index of [0, 1]) assert.ok(Math.abs(radii.get(index) - expected[index]) < 1e-6, `cell ${index}`);
  // Before the fix both were 1.25 (5 / 2 · 0.5): three to four times too
  // small, and near and far alike.
  assert.ok(radii.get(0) > 3 * 1.25 && radii.get(1) > radii.get(0));

  for (const strategy of ['full-vector', 'optimized-vector']) {
    const markup = await writeSvgPointMarkup({
      strategy,
      positions,
      dimension: 3,
      colors,
      transparency: null,
      lodMembership: null,
      drawOrder: null,
      renderState: state,
      fogRenderState: state,
      highlightArray: null,
      emphasizeSelection: false,
      selectionMutedOpacity: 0.15,
      plotRect,
      crop: null,
      pointDiameterViewportPx: 5,
      sortByDepth: false,
      targetCount: 2,
      seed: 1,
    }).text();
    const drawn = [...markup.matchAll(/ r="([\d.]+)"/g)].map(match => Number(match[1])).sort((a, b) => a - b);
    assert.deepEqual(drawn, expected.map(radius => Number(radius.toFixed(2))).sort((a, b) => a - b), strategy);
  }

  // A centroid is drawn with four times the point size, by the same law.
  const svg = renderSvgCentroidOverlay({
    positions: Float32Array.from([0, 0, 0]),
    colors: Uint8Array.from([0, 128, 0, 255]),
    flags: { points: true, labels: false },
    renderState: state,
    plotRect,
    pointDiameterViewportPx: 20,
  });
  const [, centroidRadius] = svg.match(/ r="([\d.]+)"/);
  const sprite = shaderSprite({ pointSize: 20, eyeDepth: 3, attenuation: 0.8 });
  assert.equal(Number(centroidRadius), Number((sprite / 2 * 0.5).toFixed(2)));
});

test('a cell near the camera is in every vector figure whole, opaque and at the cap (no near fade)', async () => {
  // The camera is 3 from the origin: cells at 0.13, 0.3 and 0.52 of that
  // distance from it, beside the origin's cell. A near fade (F97, removed on
  // the owner's decision 2026-11-11) left the first out and the second
  // translucent; every one is drawn whole.
  const state = renderState();
  const plotRect = { x: 0, y: 0, width: 720, height: 450 };
  const depths = [0.39, 0.9, 1.56];
  const positions = Float32Array.from([0, 0, 0, ...depths.flatMap(eyeDepth => [0.01, 0.01, 3 - eyeDepth])]);
  const colors = new Uint8Array(4 * 4).fill(255);
  const seen = new Map();
  const { drawn } = forEachProjectedPoint({
    positions,
    dimension: 3,
    colors,
    colorAlpha: 'layer',
    renderState: state,
    plotRect,
    pointDiameterViewportPx: 8,
    onPoint: (_x, _y, _r, _g, _b, alpha, radius, index) => seen.set(index, { alpha, radius }),
  });
  assert.equal(drawn, 4);
  for (const [k, depth] of depths.entries()) {
    const cell = seen.get(k + 1);
    assert.equal(cell.alpha, 1, `cell at ${depth} drawn opaque`);
    // Its eye depth as stored (Float32 positions).
    const eyeDepth = 3 - Math.fround(3 - depth);
    const expected = shaderSprite({ pointSize: 8, eyeDepth, attenuation: 0.8 }) / 2 * 0.5;
    assert.ok(Math.abs(cell.radius - expected) < 1e-6, `cell at ${depth} at its full size`);
  }
  assert.equal(seen.get(1).radius, POINT_SPRITE_MAX_PX / 2 * 0.5, 'the nearest cell at the cap');
  for (const strategy of ['full-vector', 'optimized-vector']) {
    const markup = await writeSvgPointMarkup({
      strategy,
      positions,
      dimension: 3,
      colors,
      transparency: null,
      lodMembership: null,
      drawOrder: null,
      renderState: state,
      fogRenderState: state,
      highlightArray: null,
      emphasizeSelection: false,
      selectionMutedOpacity: 0.15,
      plotRect,
      crop: null,
      pointDiameterViewportPx: 8,
      sortByDepth: false,
      targetCount: 4,
      seed: 1,
    }).text();
    assert.equal(markup.match(/<circle /g)?.length, 4, strategy);
    assert.doesNotMatch(markup, /opacity="/, `${strategy}: no circle is translucent`);
  }
});
