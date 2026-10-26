/**
 * Smoke waiting for its noise textures needs no frames: the generation runs
 * on its own schedule, and the viewer redrew the studio, grid and backdrop
 * every display frame until it landed, changing no pixel. The renderer now
 * asks for one frame when the generation settles.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { SmokeRenderer } from '../assets/js/rendering/smoke-cloud/smoke-renderer.js';

function renderer(state) {
  return Object.assign(Object.create(SmokeRenderer.prototype), {
    contextLost: false,
    disposed: false,
    _disposeStarted: false,
    textureInfo: {},
    animationSpeed: 0,
    noiseTextures: null,
    ...state,
  });
}

test('a still smoke volume waiting for noise asks for no frames', () => {
  assert.equal(renderer({}).needsContinuousFrames(), false);
  assert.equal(renderer({ animationSpeed: 0.5 }).needsContinuousFrames(), true);
});

test('a settled noise generation asks the viewer for its frame', () => {
  const smoke = renderer({});
  let woken = 0;
  smoke.setNoiseSettledHandler(() => { woken += 1; });
  smoke._noiseSettled();
  assert.equal(woken, 1);
  const source = readFileSync(new URL('../assets/js/rendering/smoke-cloud/smoke-renderer.js', import.meta.url), 'utf8');
  // Both the published and the failed generation wake it.
  assert.equal((source.match(/this\._noiseSettled\(\);/g) ?? []).length, 2);
  const viewer = readFileSync(new URL('../assets/js/rendering/viewer.js', import.meta.url), 'utf8');
  assert.match(viewer, /smokeRenderer\.setNoiseSettledHandler\(\(\) => \{\s*if \(!disposed && !webglContextLost\) invalidateFrame\(\);/);
});
