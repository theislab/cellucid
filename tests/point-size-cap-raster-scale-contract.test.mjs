/**
 * @fileoverview A sprite must clamp at the same fraction of the image whether
 * it is drawn to the screen or to a figure export.
 *
 * The vertex shaders cap `gl_PointSize` at 128 pixels *of whatever they are
 * drawing into*. A figure export rasterises the same scene at a multiple of the
 * screen size, so with a fixed cap a point that clamps on screen and the same
 * point in the export occupy different fractions of the image, and the exported
 * figure stops being the view it claims to reproduce.
 *
 * It is reachable in an ordinary 3D close-up rather than at extremes. With
 * attenuation the shader computes
 * `u_pointSize * 0.01 * (viewportHeight / (2 tan(fov/2))) / eyeDepth`, so in a
 * 900-pixel viewport at 45 degrees the cap is reached at eyeDepth ~1.7 for a
 * point size of 20.
 *
 * The cap is a uniform now, with a floor baked into the shader so that a
 * program which never sets it behaves exactly as the fixed cap did. That makes
 * the change incapable of shrinking anything: the export can raise the cap, and
 * nothing can lower it.
 */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const SHADER_DIR = new URL('../assets/js/rendering/shaders/', import.meta.url);
const RASTERIZER_URL = new URL(
  '../assets/js/app/ui/modules/figure-export/utils/webgl-point-rasterizer.js',
  import.meta.url
);

async function shaderSources() {
  const sources = new Map();
  for (const entry of await readdir(SHADER_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    sources.set(
      entry.name,
      await readFile(new URL(entry.name, SHADER_DIR), 'utf8')
    );
  }
  return sources;
}

test('no shader hardcodes the sprite cap', async () => {
  const offenders = [];
  for (const [name, source] of await shaderSources()) {
    source.split('\n').forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (!/clamp\s*\(\s*(gl_PointSize|dotSize)/.test(line)) return;
      if (!/u_pointSizeMax/.test(line)) {
        offenders.push(`${name}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    'a sprite cap must come from u_pointSizeMax so an export can scale it'
  );
});

test('every capped shader floors the uniform at the viewer cap', async () => {
  // GLSL has no default uniform value, so an unset uniform reads as zero. The
  // floor is what makes this change unable to shrink a point: a program that
  // does not set the uniform clamps exactly where it clamped before.
  let capped = 0;
  for (const [name, source] of await shaderSources()) {
    for (const line of source.split('\n')) {
      if (!/clamp\s*\(\s*(gl_PointSize|dotSize)/.test(line)) continue;
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      capped += 1;
      assert.match(
        line,
        /max\s*\(\s*u_pointSizeMax\s*,\s*128\.0\s*\)/,
        `${name} must floor the cap at the viewer's own 128, so an unset `
          + 'uniform keeps today\'s behaviour'
      );
    }
  }
  assert.ok(capped >= 4, `expected every capped shader, saw ${capped}`);
});

test('a shader that declares the uniform also uses it', async () => {
  for (const [name, source] of await shaderSources()) {
    if (!source.includes('uniform float u_pointSizeMax;')) continue;
    assert.match(
      source,
      /max\s*\(\s*u_pointSizeMax/,
      `${name} declares the cap uniform without applying it`
    );
  }
});

test('the export raises the cap by its raster scale and respects the driver', async () => {
  const source = await readFile(RASTERIZER_URL, 'utf8');
  assert.match(
    source,
    /ALIASED_POINT_SIZE_RANGE/,
    'asking for a sprite larger than the driver allows is undefined, not '
      + 'clamped, so the driver maximum has to bound the request'
  );

  const module = await import(RASTERIZER_URL);
  assert.equal(
    typeof module.rasterizePointsWebgl,
    'function',
    'the rasteriser must still export its entry point'
  );

  // Every pass that sets a point size must set the cap with it; a pass that
  // forgets draws smaller sprites than the pass beside it in the same image.
  const sizeSetters = source.match(/u\('u_pointSize'\)|hu\('u_pointSize'\)/g) ?? [];
  const capSetters = source.match(/u\('u_pointSizeMax'\)|hu\('u_pointSizeMax'\)/g) ?? [];
  assert.equal(
    capSetters.length,
    sizeSetters.length,
    `${sizeSetters.length} passes set a point size but ${capSetters.length} set the cap`
  );
});
