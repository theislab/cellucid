/**
 * A highlight reads against any coloring.
 *
 * A highlighted cell is a dot and a ring; with both in the highlight's cyan
 * (the flat ring 0.75 of it, the torus lit cyan), a larger cyan point changes
 * nothing among cells of a close color (Garcia's germ cells, sky blue #4CAFEE,
 * when colored by LVL1), though the same highlight shows when colored by a
 * gene. The ring cannot know the colors of the cells around it, so the rule is
 * a pair that reads against every color: the dot in `HIGHLIGHT_COLOR` inside a
 * ring of `highlightRingColorFor` it (black around the light cyan), on screen
 * and in every figure format.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  HIGHLIGHT_COLOR,
  HIGHLIGHT_RING_COLOR,
  HIGHLIGHT_RING_INNER_GAP,
  HIGHLIGHT_RING_RATIO,
  HIGHLIGHT_STYLES_BY_QUALITY,
  HP_FS_HIGHLIGHT,
  highlightRingColorFor,
  highlightRingRadii,
} from '../assets/js/rendering/shaders/high-perf-shaders.js';
import { colorDistance, MIN_DISTINCT_COLOR_DISTANCE } from '../assets/js/data/distinct-colors.js';
import { getCategoryColor, getCategoryColorSeedCount } from '../assets/js/data/palettes.js';
import { HIGHLIGHT_RGB } from '../assets/js/app/ui/modules/figure-export/utils/highlight-legend.js';
import { writeSvgPointMarkup } from '../assets/js/app/ui/modules/figure-export/renderers/svg-point-markup.js';
import { POINT_SPRITE_MAX_PX } from '../assets/js/rendering/point-sprite.js';
import { createFogEvaluator } from '../assets/js/app/ui/modules/figure-export/utils/fog.js';
import { fogOpacityAt } from '../assets/js/rendering/shaders/fog-shaders.js';

/** Every color a cell or a background can have, on a 1/16 grid of the RGB cube. */
const RGB_GRID = (() => {
  const steps = 16;
  const colors = [];
  for (let r = 0; r <= steps; r++) {
    for (let g = 0; g <= steps; g++) {
      for (let b = 0; b <= steps; b++) colors.push([r / steps, g / steps, b / steps]);
    }
  }
  return colors;
})();

/** How far `color` is from the farther of the highlight's two colors (OKLab). */
function contrastWithHighlight(color, dot, ring) {
  return Math.max(colorDistance(color, dot), colorDistance(color, ring));
}

/**
 * The threshold: any color stays this far (OKLab) from the dot or the ring,
 * five times `MIN_DISTINCT_COLOR_DISTANCE` (two colors closer read as one).
 */
const MIN_HIGHLIGHT_CONTRAST = 5 * MIN_DISTINCT_COLOR_DISTANCE;

test('every color, a category, a colormap or a background, is far from the dot or its ring', () => {
  assert.deepEqual(HIGHLIGHT_RING_COLOR, [0, 0, 0], 'a light dot is ringed in black');
  let worst = Infinity;
  for (const color of RGB_GRID) {
    worst = Math.min(worst, contrastWithHighlight(color, HIGHLIGHT_COLOR, HIGHLIGHT_RING_COLOR));
  }
  assert.ok(worst >= MIN_HIGHLIGHT_CONTRAST, `worst contrast ${worst.toFixed(3)}`);
  // The finding's colors: Garcia's germ cells (sky blue) and the cyan itself.
  for (const color of [[0.298, 0.686, 0.933], HIGHLIGHT_COLOR]) {
    assert.ok(contrastWithHighlight(color, HIGHLIGHT_COLOR, HIGHLIGHT_RING_COLOR) >= MIN_HIGHLIGHT_CONTRAST);
  }
  for (let index = 0; index < getCategoryColorSeedCount() + 40; index++) {
    const color = getCategoryColor(index);
    assert.ok(
      contrastWithHighlight(color, HIGHLIGHT_COLOR, HIGHLIGHT_RING_COLOR) >= MIN_HIGHLIGHT_CONTRAST,
      `category color ${index}`
    );
  }
  // The ring the shader drew before (0.75 of the cyan): the sky blue sat
  // between the two, as near the dot as two colors that read as one.
  const before = HIGHLIGHT_COLOR.map(channel => channel * 0.75);
  assert.ok(contrastWithHighlight([0.298, 0.686, 0.933], HIGHLIGHT_COLOR, before) < 2 * MIN_DISTINCT_COLOR_DISTANCE);
});

test('the ring follows the dot: black around a light dot, white around a dark one', () => {
  assert.deepEqual(highlightRingColorFor([1, 1, 1]), [0, 0, 0]);
  assert.deepEqual(highlightRingColorFor([1, 1, 0]), [0, 0, 0]);
  assert.deepEqual(highlightRingColorFor([0, 0, 0]), [1, 1, 1]);
  assert.deepEqual(highlightRingColorFor([0, 0, 0.6]), [1, 1, 1]);
  assert.equal(highlightRingColorFor(HIGHLIGHT_COLOR), HIGHLIGHT_RING_COLOR);
  // Whatever the dot, its ring is far from it.
  const steps = 4;
  for (let r = 0; r <= steps; r++) {
    for (let g = 0; g <= steps; g++) {
      for (let b = 0; b <= steps; b++) {
        const dot = [r / steps, g / steps, b / steps];
        const ring = highlightRingColorFor(dot);
        assert.ok(colorDistance(dot, ring) >= 0.45, `dot ${dot}`);
      }
    }
  }
});

test('every shader quality draws its ring in the ring color, the dot in the highlight color', () => {
  assert.match(HP_FS_HIGHLIGHT, /uniform vec3 u_highlightRingColor;/);
  const torusRing = HP_FS_HIGHLIGHT.slice(
    HP_FS_HIGHLIGHT.indexOf('=== RENDER THE RING ==='),
    HP_FS_HIGHLIGHT.indexOf('if (finalAlpha < 0.01) discard;')
  );
  assert.ok(torusRing.length > 0);
  assert.doesNotMatch(torusRing, /u_highlightColor/, 'the torus ring (full, sculpted) is lit in the ring color');
  assert.match(torusRing, /vec3 litColor = u_highlightRingColor \* \(ambient \+ diffuse\)/);
  const flat = HP_FS_HIGHLIGHT.slice(HP_FS_HIGHLIGHT.indexOf('FLAT RING + DOT VARIANTS'));
  assert.match(flat, /\/\/ RING AREA[^\n]*\n\s*if \(baseR <= outerRadius\) \{\n\s*fragColor = vec4\(u_highlightRingColor, v_alpha \* 0\.95\);/);
  assert.match(flat, /\/\/ DOT AREA[^\n]*\n\s*if \(baseR < innerRadius\) \{\n\s*fragColor = vec4\(u_highlightColor, v_alpha\);/);
  // One ring geometry: the shader's constants are the vector figure's.
  assert.match(HP_FS_HIGHLIGHT, new RegExp(`const float INNER_GAP = ${HIGHLIGHT_RING_INNER_GAP.toFixed(2)};`));
  assert.match(HP_FS_HIGHLIGHT, new RegExp(`const float RING_RATIO = ${HIGHLIGHT_RING_RATIO.toFixed(2)};`));
  for (const [quality, style] of Object.entries(HIGHLIGHT_STYLES_BY_QUALITY)) {
    const { inner, outer } = highlightRingRadii(style);
    assert.ok(inner > 1 && outer > inner, quality);
    assert.ok(outer <= 0.95 * style.scale + 1e-12, `${quality}: within its sprite`);
  }
});

test('the screen and the figure raster set the same ring color', async () => {
  const read = path => readFile(new URL(path, import.meta.url), 'utf8');
  const renderer = await read('../assets/js/rendering/highlight-renderer.js');
  assert.match(renderer, /highlightRingColor: gl\.getUniformLocation\(this\.program, 'u_highlightRingColor'\)/);
  assert.match(renderer, /this\.uniformLocations\.highlightRingColor,\s*highlightRingColorFor\(this\.highlightColor\)/);
  const raster = await read('../assets/js/app/ui/modules/figure-export/utils/webgl-point-rasterizer.js');
  assert.match(raster, /setHV3\(hu\('u_highlightColor'\), HIGHLIGHT_COLOR\);/);
  assert.match(raster, /setHV3\(hu\('u_highlightRingColor'\), HIGHLIGHT_RING_COLOR\);/);
});

test('a vector figure draws a highlighted cell as the screen does: the dot inside a black ring', async () => {
  const identity = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const renderState = {
    viewportWidth: 400,
    viewportHeight: 400,
    fov: Math.PI / 4,
    projectionMatrix: identity,
    viewMatrix: identity,
    modelMatrix: identity,
    mvpMatrix: identity,
    lightDir: Float32Array.from([0, 0, 1]),
    sizeAttenuation: 0,
    pointSize: 8,
    pointSizeMax: POINT_SPRITE_MAX_PX,
    shaderQuality: 'light',
    fogDensity: 0,
    fogNear: 0,
    fogFar: 1,
    fogColor: Float32Array.from([1, 1, 1]),
  };
  // Two sky-blue cells (Garcia's germ cells), the second highlighted.
  const sky = [76, 175, 238, 255];
  for (const strategy of ['full-vector', 'optimized-vector']) {
    const markup = await writeSvgPointMarkup({
      strategy,
      positions: Float32Array.from([-0.5, 0, 0.5, 0]),
      dimension: 2,
      colors: Uint8Array.from([...sky, ...sky]),
      transparency: null,
      lodMembership: null,
      drawOrder: null,
      renderState,
      fogRenderState: renderState,
      highlightArray: Uint8Array.from([0, 255]),
      emphasizeSelection: false,
      selectionMutedOpacity: 0.15,
      plotRect: { x: 0, y: 0, width: 400, height: 400 },
      crop: null,
      pointDiameterViewportPx: 8,
      sortByDepth: false,
      targetCount: 2,
      seed: 1,
    }).text();
    const circles = [...markup.matchAll(/<circle [^>]*\/>/g)].map(match => match[0]);
    assert.equal(circles.length, 4, `${strategy}: two cells, the highlighted one's dot and ring`);
    const radius = 4;
    const { inner, outer } = highlightRingRadii(HIGHLIGHT_STYLES_BY_QUALITY.light);
    const dot = circles.find(circle => circle.includes(`fill="rgb(${HIGHLIGHT_RGB.join(',')})"`));
    assert.ok(dot, `${strategy}: the dot in the highlight color`);
    assert.match(dot, new RegExp(` r="${(radius * inner).toFixed(2)}"`));
    const ring = circles.find(circle => circle.includes('fill="none"'));
    assert.match(ring, /stroke="rgb\(0,0,0\)"/, `${strategy}: the ring in black`);
    assert.match(ring, new RegExp(` r="${(radius * (inner + outer) / 2).toFixed(2)}"`));
    assert.match(ring, new RegExp(` stroke-width="${(radius * (outer - inner)).toFixed(2)}"`));
    assert.match(ring, / stroke-opacity="0\.950"/);
    // The cell's own circle comes first, the highlight over it.
    assert.ok(markup.indexOf(dot) > markup.indexOf('fill="rgb(76,175,238)"'));
  }

  // Fog thins the dot and the ring, in every quality, as HP_FS_HIGHLIGHT's
  // v_fogOpacity does (the vector rings are fogged too).
  const fogged = { ...renderState, shaderQuality: 'full', fogDensity: 1 };
  const markup = await writeSvgPointMarkup({
    strategy: 'full-vector',
    positions: Float32Array.from([0.5, 0]),
    dimension: 2,
    colors: Uint8Array.from(sky),
    transparency: null,
    lodMembership: null,
    drawOrder: null,
    renderState: fogged,
    fogRenderState: fogged,
    highlightArray: Uint8Array.from([255]),
    emphasizeSelection: false,
    selectionMutedOpacity: 0.15,
    plotRect: { x: 0, y: 0, width: 400, height: 400 },
    crop: null,
    pointDiameterViewportPx: 8,
    sortByDepth: false,
  }).text();
  const transmittance = createFogEvaluator(fogged).transmittanceAt(0.5, 0, 0);
  assert.ok(transmittance < 1);
  const opacity = fogOpacityAt(transmittance);
  assert.match(markup, new RegExp(`fill="rgb\\(${HIGHLIGHT_RGB.join(',')}\\)" fill-opacity="${opacity.toFixed(3)}"`));
  assert.match(markup, new RegExp(`stroke-opacity="${(0.95 * opacity).toFixed(3)}"`));
});
