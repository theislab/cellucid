// Shader quality selects shading, never geometry.
//
// `full`, `light` and `ultralight` are presented to the user as three levels of
// *shading* -- lighting and fog, then flat circles, then flat squares. Nothing
// in the UI, the docs or the session format says they draw points of different
// sizes, and two things downstream assume they do not:
//
//   * HP_VS_HIGHLIGHT recomputes the dot size with its own clamp and derives
//     the whole ring geometry from it ("Same clamp as main dots!"). If the main
//     dot clamps higher than the highlight's copy, the ring is drawn inside the
//     dot instead of around it.
//   * Point area is quadratic in gl_PointSize, so a higher clamp is a direct
//     fill-rate multiplier. A clamp of 192 against 128 is 2.25x the fragments
//     for the clamped points, which measured as up to 1.90x the GPU frame time
//     at large point sizes -- the "faster" quality being the slower one.
//
// The clamp bounds are therefore a contract across the point vertex shaders,
// asserted here in source because there is no runtime signal that they have
// drifted apart: the picture still renders, just with the wrong point size in
// two of the three modes.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, '..');
const HIGH_PERF_SHADERS = path.join(
  REPOSITORY_ROOT,
  'assets/js/rendering/shaders/high-perf-shaders.js'
);

const SOURCE = fs.readFileSync(HIGH_PERF_SHADERS, 'utf8');

function exportedShader(name) {
  const marker = `export const ${name} = \``;
  const start = SOURCE.indexOf(marker);
  assert.notEqual(start, -1, `${name} is missing from high-perf-shaders.js`);
  const end = SOURCE.indexOf('`;', start + marker.length);
  assert.notEqual(end, -1, `${name} is not terminated`);
  return SOURCE.slice(start + marker.length, end);
}

/**
 * Every `clamp(<target>, lo, hi)` in one shader, as exact numeric pairs.
 * Returned in source order so a shader that clamps twice is not flattened into
 * one reading.
 */
function clampBounds(shaderSource, target) {
  // The upper bound is an expression rather than a literal, because a figure
  // export rasterises at a multiple of the screen and has to raise the cap to
  // keep a sprite at the same fraction of the image. It is compared as written
  // text, so every shader still has to agree exactly - which is what this file
  // is for - without this parser having to evaluate GLSL.
  const pattern = new RegExp(
    `clamp\\(\\s*${target}\\s*,\\s*([0-9.]+)\\s*,\\s*([^)]*\\([^)]*\\)|[0-9.]+)\\s*\\)`,
    'g'
  );
  const bounds = [];
  for (const match of shaderSource.matchAll(pattern)) {
    bounds.push({
      min: Number(match[1]),
      max: match[2].trim().replace(/\s+/g, ' ')
    });
  }
  return bounds;
}

// The three programs the user can select. `ultralight` shares HP_VS_LIGHT with
// `light`, so two vertex shaders cover all three qualities.
const QUALITY_VERTEX_SHADERS = ['HP_VS_FULL', 'HP_VS_LIGHT'];

test('every shader quality clamps gl_PointSize to the same bounds', () => {
  const readings = new Map();
  for (const name of QUALITY_VERTEX_SHADERS) {
    const bounds = clampBounds(exportedShader(name), 'gl_PointSize');
    assert.equal(
      bounds.length,
      1,
      `${name} must clamp gl_PointSize exactly once; found ${bounds.length}`
    );
    readings.set(name, bounds[0]);
  }
  const [reference, ...rest] = QUALITY_VERTEX_SHADERS;
  for (const name of rest) {
    assert.deepEqual(
      readings.get(name),
      readings.get(reference),
      `${name} clamps gl_PointSize to ` +
        `[${readings.get(name).min}, ${readings.get(name).max}] while ` +
        `${reference} clamps it to ` +
        `[${readings.get(reference).min}, ${readings.get(reference).max}]. ` +
        'Shader quality must change shading, not point geometry.'
    );
  }
});

test('the highlight shader sizes its ring from the same clamp as the dots', () => {
  const highlight = exportedShader('HP_VS_HIGHLIGHT');
  const dotBounds = clampBounds(highlight, 'dotSize');
  assert.equal(
    dotBounds.length,
    1,
    'HP_VS_HIGHLIGHT must clamp its reconstructed dot size exactly once'
  );
  const pointBounds = clampBounds(exportedShader('HP_VS_FULL'), 'gl_PointSize');
  assert.deepEqual(
    dotBounds[0],
    pointBounds[0],
    'HP_VS_HIGHLIGHT derives the ring inner radius from its own copy of the ' +
      'dot size. If that copy clamps differently from the point shaders, the ' +
      'ring stops tracking the dot it is meant to surround.'
  );
});
