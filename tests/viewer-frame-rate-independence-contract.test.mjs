import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * Camera motion advances by elapsed time, not by frame count.
 *
 * Orbit/pan inertia, the smooth-zoom ease and held-key acceleration used to
 * apply one fixed step per drawn frame. On a 120 Hz display that is twice the
 * motion per second of a 60 Hz one, and on a slow frame it is too little.
 * Every per-frame camera integrator now scales by the elapsed reference ticks
 * (`dt * PHYSICS_TICK_RATE`), which reduces to the old per-frame step at
 * exactly 60 Hz, as freefly's integrator already did.
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

test('one long step travels exactly as far as the same time in 60 Hz ticks', () => {
  // The integrators' closed forms, checked against stepping tick by tick:
  // a 10 fps frame must not coast the camera in slow motion or overshoot.
  const friction = 0.92;
  const tickRate = 60;
  const orbit = (velocity, dt) => {
    const decay = friction ** (dt * tickRate);
    return { travel: velocity * (1 - decay) / (1 - friction), velocity: velocity * decay };
  };
  const freefly = (velocity, dt) => {
    const decay = friction ** (dt * tickRate);
    return {
      travel: velocity * friction * (1 - decay) / (1 - friction) / tickRate,
      velocity: velocity * decay,
    };
  };
  for (const [integrate, tickTravel] of [
    [orbit, velocity => ({ travel: velocity, velocity: velocity * friction })],
    [freefly, velocity => ({ travel: velocity * friction / tickRate, velocity: velocity * friction })],
  ]) {
    let stepped = { travel: 0, velocity: 0.03 };
    for (let tick = 0; tick < 6; tick++) {
      const next = tickTravel(stepped.velocity);
      stepped = { travel: stepped.travel + next.travel, velocity: next.velocity };
    }
    const long = integrate(0.03, 6 / tickRate);
    assert.ok(Math.abs(long.travel - stepped.travel) < 1e-12);
    assert.ok(Math.abs(long.velocity - stepped.velocity) < 1e-12);
    const one = integrate(0.03, 1 / tickRate);
    const single = tickTravel(0.03);
    assert.ok(Math.abs(one.travel - single.travel) < 1e-12);
  }
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
