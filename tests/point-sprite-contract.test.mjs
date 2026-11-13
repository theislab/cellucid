/**
 * The one sprite every point is drawn at (rendering/point-sprite.js): the
 * perspective size and the cap (`POINT_SPRITE_MAX_PX`, 160, within the GPU's
 * own largest point), and nothing else that depends on the camera's distance.
 *
 * - Every vertex shader that sizes a sprite of a cell (the Full, Sculpted,
 *   Light and Ultra-light point passes, the highlight ring's dot, the
 *   centroid markers) calls the one GLSL function; no shader keeps a cap or a
 *   formula of its own (a quality selects shading, never geometry: a higher
 *   ceiling in one quality would make a faster quality draw larger, slower
 *   points, and a ring sized by its own copy of the clamp would sit inside
 *   its dot).
 * - The GLSL and the JavaScript that picking, the read-cell layer and the
 *   figure export size with are the same function: the GLSL is evaluated
 *   here, transliterated, against the JavaScript.
 * - The cap never exceeds the GPU's `ALIASED_POINT_SIZE_RANGE` (asking for
 *   more is undefined, not clamped), and a figure export raises it by its
 *   raster scale.
 * - No near fade: no shader hides, thins or dithers a cell by its eye depth,
 *   and the module offers no fade to call. `tests/browser/point-near-camera-
 *   solid.spec.mjs` checks the same on the GPU.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as pointSpriteModule from '../assets/js/rendering/point-sprite.js';
import {
  POINT_SPRITE_GLSL,
  POINT_SPRITE_MAX_PX,
  POINT_SPRITE_MIN_PX,
  gpuPointSizeMax,
  pointScaleFor,
  pointSpriteCap,
  pointSpriteSize,
} from '../assets/js/rendering/point-sprite.js';
import * as highPerfShaders from '../assets/js/rendering/shaders/high-perf-shaders.js';
import * as centroidShaders from '../assets/js/rendering/shaders/centroid-shaders.js';
import { drawnPointRadiusCss } from '../assets/js/rendering/picking.js';
import { createViewportPointDiameter } from '../assets/js/app/ui/modules/figure-export/utils/point-size.js';

const { HP_VS_FULL, HP_VS_HIGHLIGHT, HP_VS_LIGHT } = highPerfShaders;
const { CENTROID_VS } = centroidShaders;

const SPRITE_SHADERS = Object.freeze({ HP_VS_FULL, HP_VS_LIGHT, HP_VS_HIGHLIGHT, CENTROID_VS });

/** A function of POINT_SPRITE_GLSL as a JavaScript function of eyeDepth and the uniforms. */
function glslFunction(name) {
  const body = POINT_SPRITE_GLSL.match(new RegExp(`float ${name}\\(float eyeDepth\\) \\{([\\s\\S]*?)\\n\\}`))[1];
  const js = body.replaceAll(/\bfloat\s+/g, 'let ');
  // GLSL's built-ins the body uses.
  const prelude = `
    const max = Math.max;
    const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
    const mix = (a, b, t) => a * (1 - t) + b * t;`;
  // eslint-disable-next-line no-new-func
  return new Function(
    'eyeDepth', 'u_pointSize', 'u_pointScale', 'u_sizeAttenuation', 'u_pointSizeMax',
    `${prelude}\n${js}`,
  );
}

test('every point vertex shader sizes its sprite with the one shared function', () => {
  for (const [name, source] of Object.entries(SPRITE_SHADERS)) {
    assert.ok(source.includes(POINT_SPRITE_GLSL), `${name} splices POINT_SPRITE_GLSL`);
    // The shader's own code, its comments left out.
    const own = source.replace(POINT_SPRITE_GLSL, '').replaceAll(/\/\/.*$/gm, '');
    assert.match(own, /pointSpriteSize\(eyeDepth\)/, `${name} calls pointSpriteSize`);
    // No cap, minimum or perspective formula of its own.
    assert.doesNotMatch(own, /uniform float u_pointSizeMax|uniform float u_pointSize;|u_pointSize \* u_pointScale/, name);
    assert.doesNotMatch(own, /\b128(\.0)?\b|\b192(\.0)?\b|\b256(\.0)?\b/, `${name} holds no literal sprite cap`);
  }
  // The point passes clamp nothing else; the ring alone is bounded, by the GPU.
  for (const name of ['HP_VS_FULL', 'HP_VS_LIGHT', 'CENTROID_VS']) {
    assert.doesNotMatch(SPRITE_SHADERS[name].replace(POINT_SPRITE_GLSL, ''), /clamp\(gl_PointSize/, name);
  }
  assert.match(HP_VS_HIGHLIGHT, /gl_PointSize = clamp\(dotSize \* u_highlightScale, 1\.0, u_gpuPointSizeMax\);/);
});

test('the shaders and the CPU readers size a sprite exactly alike', () => {
  const glsl = glslFunction('pointSpriteSize');
  const pointScale = pointScaleFor(900, Math.PI / 4);
  let compared = 0;
  for (const pointSizeMax of [64, POINT_SPRITE_MAX_PX]) {
    for (const sizeAttenuation of [0, 0.8, 1]) {
      for (const pointSize of [0.2, 2.9, 36]) {
        for (const eyeDepth of [0.05, 0.4, 0.6, 0.9, 1.2, 1.5, 2, 3, 7]) {
          const sprite = { pointSize, pointScale, sizeAttenuation, pointSizeMax };
          const expected = glsl(eyeDepth, pointSize, pointScale, sizeAttenuation, pointSizeMax);
          assert.equal(pointSpriteSize(eyeDepth, sprite), expected, JSON.stringify({ eyeDepth, ...sprite }));
          // Picking: half the sprite in CSS pixels.
          assert.equal(drawnPointRadiusCss({
            w: eyeDepth, pointSize, sizeAttenuation, fov: Math.PI / 4, framebufferHeight: 900,
            devicePixelRatio: 2, pointSizeMax,
          }), expected / 4);
          compared++;
        }
      }
    }
  }
  assert.equal(compared, 162);
});

test('the figure export draws each cell at the sprite the pane draws it', () => {
  const view = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -3, 1]);
  const identity = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const pane = {
    viewMatrix: view, modelMatrix: identity, lightDir: [0, 0, 1], viewportHeight: 900, fov: Math.PI / 4,
    sizeAttenuation: 0.8, pointSizeMax: POINT_SPRITE_MAX_PX,
  };
  const diameterAt = createViewportPointDiameter(pane);
  const sprite = { pointSize: 5, pointScale: pointScaleFor(900, Math.PI / 4), sizeAttenuation: 0.8, pointSizeMax: POINT_SPRITE_MAX_PX };
  for (const z of [2.6, 2, 1.8, 0, -4]) {
    assert.equal(diameterAt(0, 0, z, 5), pointSpriteSize(3 - z, sprite), `z = ${z}`);
  }
  assert.ok(diameterAt(0, 0, 2.6, 5) > diameterAt(0, 0, 0, 5), 'a cell near the camera is drawn larger');
});

test('the cap is 160 px within the GPU\'s largest point, never above it', () => {
  const gl = max => ({
    ALIASED_POINT_SIZE_RANGE: 0x846d,
    getParameter: name => (name === 0x846d ? max : null),
  });
  assert.equal(POINT_SPRITE_MAX_PX, 160);
  assert.equal(pointSpriteCap(gl(Float32Array.of(1, 1024))), 160);
  assert.equal(pointSpriteCap(gl(Float32Array.of(1, 160))), 160);
  assert.equal(pointSpriteCap(gl(Float32Array.of(1, 64))), 64, 'a GPU that draws at most 64 px caps at 64');
  assert.equal(pointSpriteCap(gl(null)), 160, 'a context that does not say: the cap');
  assert.equal(gpuPointSizeMax(gl(Float32Array.of(1, 511))), 511);
  assert.equal(gpuPointSizeMax(gl(Float32Array.of(1, 0))), null);
  // The sprite never exceeds the cap it is given, nor falls below the minimum while drawn.
  const huge = pointSpriteSize(0.01, { pointSize: 100, pointScale: 10, sizeAttenuation: 1, pointSizeMax: 64 });
  assert.equal(huge, 64);
  const tiny = pointSpriteSize(50, { pointSize: 0.01, pointScale: 1, sizeAttenuation: 1, pointSizeMax: 160 });
  assert.equal(tiny, POINT_SPRITE_MIN_PX);
});

test('no near fade: nothing hides, thins or dithers a cell by its distance from the camera', () => {
  // The module sizes sprites and nothing else: it exports no near-fade
  // constant, shader function, uniform or fade to call.
  assert.deepEqual(Object.keys(pointSpriteModule).sort(), [
    'POINT_SPRITE_GLSL', 'POINT_SPRITE_MAX_PX', 'POINT_SPRITE_MIN_PX',
    'gpuPointSizeMax', 'pointScaleFor', 'pointSpriteCap', 'pointSpriteSize',
  ]);
  assert.deepEqual(
    [...POINT_SPRITE_GLSL.matchAll(/uniform (\w+) (\w+);/g)].map(match => match[2]),
    ['u_pointSize', 'u_pointSizeMax', 'u_sizeAttenuation', 'u_pointScale'],
  );
  assert.deepEqual([...POINT_SPRITE_GLSL.matchAll(/^float (\w+)\(/gm)].map(match => match[1]), ['pointSpriteSize']);
  const shaders = Object.entries({ ...highPerfShaders, ...centroidShaders })
    .filter(([, value]) => typeof value === 'string' && value.startsWith('#version'));
  assert.ok(shaders.length >= 13, `${shaders.length} shaders checked`);
  for (const [name, source] of shaders) {
    const code = source.replaceAll(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /[Ff]ade\b|u_nearFade|v_fade|nearFade/, `${name} has no near fade`);
    // A dither keyed to the pixel is how a fade was drawn in depth.
    assert.doesNotMatch(code, /gl_FragCoord/, `${name} reads no pixel position`);
    // A cell's opacity is its own alpha, whatever its depth.
    for (const [assignment] of code.matchAll(/v_alpha = [^;]*;/g)) {
      assert.match(assignment, /^v_alpha = (alpha|a_color\.a);$/, `${name}: ${assignment}`);
    }
    // The hidden-cell rejection asks about the cell, never its depth.
    for (const [condition] of code.matchAll(/if \(([^{]*)\) \{\s*gl_PointSize = 0\.0;/g)) {
      assert.doesNotMatch(condition, /eyeDepth|eyePos/, `${name}: ${condition}`);
    }
  }
});

test('the figure export raises the cap by its raster scale, every pass that sizes a point sets it', async () => {
  const source = await readFile(new URL('../assets/js/app/ui/modules/figure-export/utils/webgl-point-rasterizer.js', import.meta.url), 'utf8');
  assert.match(source, /const scaled = viewerCap \* Math\.max\(1, rasterScale\);/);
  assert.match(source, /exportPointSizeMax\(gl, renderState\.pointSizeMax, s\)/);
  const sizeSetters = source.match(/u\('u_pointSize'\)|hu\('u_pointSize'\)/g) ?? [];
  const capSetters = source.match(/u\('u_pointSizeMax'\)|hu\('u_pointSizeMax'\)/g) ?? [];
  assert.equal(capSetters.length, sizeSetters.length, `${sizeSetters.length} passes set a point size, ${capSetters.length} the cap`);
  assert.match(source, /hu\('u_gpuPointSizeMax'\)/);
});
