/**
 * Every place the app asks a canvas for a WebGL2 context, and why it makes no
 * context that outlives its use. A browser keeps a page's live contexts to a
 * limit (16 in WebKit and Chromium) and, past it, loses the oldest one --
 * the viewer's. A probe made for each benchmark report and never released
 * would do exactly that after eight reports; a new
 * call site is added here with its reason, or the test says where it is.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../assets/js/', import.meta.url));

/** `file: [call sites, why none outlives its use]`. */
const OWNERS = new Map([
  ['rendering/viewer.js', [1, 'the viewer\'s own context, one per viewer, lost with its canvas']],
  ['rendering/backdrops/backdrop-look-raster.js', [1, 'one cached context for the backdrop raster, reused']],
  ['app/ui/modules/figure-export/utils/webgl-point-rasterizer.js', [1, 'figure export: at most one cached context per antialias setting']],
  ['app/startup-failure.js', [1, 'a probe on a failed start, lost at once (`loseContext`)']],
  ['app/analysis/plots/plotly-loader.js', [1, 'a probe once a page, lost at once (`loseContext`)']],
  ['app/ui/modules/benchmark/benchmark-controls.js', [1, 'the viewer canvas: the viewer\'s context, no new one']],
  ['app/ui/modules/benchmark/index.js', [1, 'the viewer canvas: the viewer\'s context, no new one']],
  ['dev/benchmark.js', [1, 'the viewer canvas (`_getGL`): the viewer\'s context, no new one']],
]);

function sources(directory, found = []) {
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    if (statSync(file).isDirectory()) sources(file, found);
    else if (name.endsWith('.js')) found.push(file);
  }
  return found;
}

test('every WebGL2 context the app asks for is one with a named owner that does not outlive its use', () => {
  const sites = new Map();
  for (const file of sources(ROOT)) {
    // Calls, not the comments that name one.
    const count = readFileSync(file, 'utf8').split('\n')
      .filter(line => !/^\s*(\*|\/\/)/.test(line))
      .reduce((sum, line) => sum + (line.match(/getContext\(\s*['"]webgl2?['"]/g) ?? []).length, 0);
    if (count > 0) sites.set(path.relative(ROOT, file).split(path.sep).join('/'), count);
  }
  assert.deepEqual(
    Object.fromEntries([...sites].sort()),
    Object.fromEntries([...OWNERS].map(([file, [count]]) => [file, count]).sort()),
    'a WebGL context asked for where none is listed (or a listed one gone): add it to OWNERS with why it does not outlive its use'
  );
});
