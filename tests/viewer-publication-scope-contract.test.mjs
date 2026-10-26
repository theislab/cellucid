/**
 * What a viewer publication touches is what it changed.
 *
 * - Another dataset: a built smoke volume is a function of one dataset's
 *   positions, colours and visibility (`captureSmokeInputs` keeps the
 *   positions and copies of the colours, alpha and outlier quantiles to
 *   answer an identical rebuild without GPU work). The viewer drops it
 *   (`clearVolume`) in the same publication, so a 2M-cell dataset's ~10 MB of
 *   copies, its positions and its 3D textures do not stay resident until
 *   smoke is built again.
 * - A live filter publication that moved no cell across the visible
 *   boundary (`updateAlphas` returned false) keeps the vector field's spawn
 *   table: rebuilding it respawned every particle and cleared the trails, as
 *   the kept-view path already did not.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const viewer = readFileSync(new URL('../assets/js/rendering/viewer.js', import.meta.url), 'utf8');

function publicMethod(name) {
  const start = viewer.indexOf(`\n    ${name}(`);
  assert.ok(start > 0, name);
  return viewer.slice(start, viewer.indexOf('\n    },\n', start));
}

test('publishing another dataset clears the smoke volume built from the previous one', () => {
  const body = publicMethod('setData');
  assert.match(body, /hpRenderer\.loadData\(/);
  assert.match(body, /smokeRenderer\.clearVolume\(\);\s*publishSmokeSourceChange\(\);/);
});

test('the live view respawns vector field particles only when visibility moved', () => {
  const body = publicMethod('updateTransparency');
  assert.match(body, /alphaGenerationMoved = hpRenderer\.updateAlphas\(alphaArray\)/);
  assert.match(body, /if \(alphaGenerationMoved && vectorFieldOverlay\?\.enabled\) \{\s*vectorFieldOverlay\.markVisibilityDirty\(LIVE_VIEW_ID\);/);
  assert.equal((body.match(/markVisibilityDirty/g) ?? []).length, 1);
});
