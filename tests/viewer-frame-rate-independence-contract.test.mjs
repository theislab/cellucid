import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * Camera motion advances by elapsed time, not by frame count.
 *
 * Orbit/pan inertia, the smooth-zoom ease and held-key acceleration do not
 * apply one fixed step per drawn frame: on a 120 Hz display that is twice the
 * motion per second of a 60 Hz one, and on a slow frame it is too little.
 * Every per-frame camera integrator scales by the elapsed reference ticks
 * (`dt * PHYSICS_TICK_RATE`), which reduces to a per-frame step at exactly
 * 60 Hz, as freefly's integrator does.
 */

const source = await readFile(
  new URL('../assets/js/rendering/viewer.js', import.meta.url),
  'utf8'
);

function functionBody(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `${name} is missing from viewer.js`);
  const end = source.indexOf('\n  }\n', start);
  return source.slice(start, end);
}

test('the frame loop hands elapsed time to every camera integrator', () => {
  assert.match(source, /updateOrbitPlanarKeys\(dt\);\n\s*updateSmoothZoom\(dt\);\n\s*updateInertia\(dt\);/);
  assert.match(source, /updateFreefly\(dt\);/);
});

test('inertia moves by the exact sum of its decaying ticks', () => {
  const body = functionBody('updateInertia');
  assert.match(body, /const ticks = dt \* PHYSICS_TICK_RATE;/);
  assert.match(body, /const friction = Math\.pow\(INERTIA_FRICTION, ticks\);/);
  assert.match(body, /const travel = \(1 - friction\) \/ \(1 - INERTIA_FRICTION\);/);
  for (const axis of ['velocityTheta', 'velocityPhi', 'velocityPanX', 'velocityPanY', 'velocityPanZ']) {
    assert.match(body, new RegExp(`\\+= ${axis} \\* travel;`));
    assert.match(body, new RegExp(`${axis} \\*= friction;`));
  }
  assert.doesNotMatch(body, /\*= INERTIA_FRICTION;/);
});

test('free-fly coasts by the closed form of its decaying ticks', () => {
  const freeflyBody = functionBody('updateFreefly');
  assert.match(
    freeflyBody,
    /const travelSeconds = INERTIA_FRICTION \* \(1 - friction\)\n\s*\/ \(1 - INERTIA_FRICTION\) \/ PHYSICS_TICK_RATE;/
  );
});

test('only a stall is cut short; projectiles still step finely', async () => {
  // Projectiles split any step into sub-steps no longer than a fraction of the
  // collision radius, so a long frame cannot carry a shot through a cell.
  assert.match(source, /const MAX_FRAME_DT = 0\.25;/);
  assert.match(
    source,
    /const dt = Math\.min\(MAX_FRAME_DT, Math\.max\(0\.001, \(now - lastFrameTime\) \/ 1000\)\);/
  );
  const projectiles = await readFile(
    new URL('../assets/js/rendering/projectiles.js', import.meta.url),
    'utf8'
  );
  assert.match(projectiles, /const maxStepDistance = collisionRadius \* 0\.4;/);
  assert.match(projectiles, /const subDt = dt \/ numSubSteps;/);
});

test('the zoom ease and held-key acceleration scale with elapsed ticks', () => {
  assert.match(
    functionBody('updateSmoothZoom'),
    /radius \+= diff \* \(1 - Math\.pow\(1 - SMOOTH_ZOOM_RATE, dt \* PHYSICS_TICK_RATE\)\);/
  );
  const keys = functionBody('updateOrbitPlanarKeys');
  assert.match(keys, /const ticks = dt \* PHYSICS_TICK_RATE;/);
  assert.match(keys, /const panAccel = .* \* ticks;/);
  assert.match(keys, /const orbitAccel = .* \* ticks;/);
});
