// A camera path plays as a director sets it: each keyframe is reached at its
// own time, easing shapes only the path's start and end, a repeated keyframe
// is a hold, and the spline never overshoots its keyframes (closer to the data
// than either keyframe, or tilted past one, over a pole) nor jolts its speed
// at a keyframe whose transitions have different times
// (`interpolation-engine.js`, lane-director L2-4).
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCameraPathPlan,
  interpolatePlannedCameraState,
} from '../assets/js/app/ui/modules/cinematic-camera/interpolation-engine.js';

function orbitKeyframe(id, { target = [0, 0, 0], radius = 3, theta = 0.5, phi = 1.2, seconds = 2 } = {}) {
  const eye = [
    target[0] + radius * Math.sin(phi) * Math.cos(theta),
    target[1] + radius * Math.cos(phi),
    target[2] + radius * Math.sin(phi) * Math.sin(theta),
  ];
  const forward = eye.map((value, axis) => (target[axis] - value) / radius);
  return {
    id: id.replaceAll(' ', '-'), label: id, navigationMode: 'orbit',
    orbit: { radius, targetRadius: radius, theta, phi, target },
    freefly: { position: eye, yaw: Math.atan2(forward[2], forward[0]), pitch: Math.asin(forward[1]) },
    representation: null, transitionDuration: seconds,
  };
}

const options = (overrides = {}) => ({
  positionMethod: 'catmull-rom', rotationMethod: 'slerp', easing: 'ease-in-out', loop: false, autoPaceSpeed: 1, ...overrides,
});

// A documentary tour: wide, three close-ups at different distances and sides, wide again.
const TOUR = [
  orbitKeyframe('wide', { radius: 3, theta: 0.2, phi: 1.3, seconds: 7 }),
  orbitKeyframe('ductal', { target: [-0.4, 0.6, -0.3], radius: 0.9, theta: 2.3, phi: 1.2, seconds: 5 }),
  orbitKeyframe('ngn3', { target: [0.5, 0.5, -0.1], radius: 1.1, theta: 1.3, phi: 1.0, seconds: 3 }),
  orbitKeyframe('beta', { target: [0.4, -0.7, -0.2], radius: 0.6, theta: -1, phi: 1.7, seconds: 9 }),
  orbitKeyframe('pull back', { radius: 3.2, theta: 0.9, phi: 1.2 }),
];

function sameOrbit(state, keyframe, label) {
  for (const key of ['radius', 'targetRadius', 'phi']) {
    assert.ok(Math.abs(state.orbit[key] - keyframe.orbit[key]) < 1e-9, `${label}: ${key} ${state.orbit[key]} ≠ ${keyframe.orbit[key]}`);
  }
  let dTheta = state.orbit.theta - keyframe.orbit.theta;
  dTheta -= Math.round(dTheta / (2 * Math.PI)) * 2 * Math.PI;
  assert.ok(Math.abs(dTheta) < 1e-9, `${label}: theta`);
  state.orbit.target.forEach((value, axis) => assert.ok(Math.abs(value - keyframe.orbit.target[axis]) < 1e-9, `${label}: target`));
}

function eyeOf(state) {
  const { target, radius, theta, phi } = state.orbit;
  return [
    target[0] + radius * Math.sin(phi) * Math.cos(theta),
    target[1] + radius * Math.cos(phi),
    target[2] + radius * Math.sin(phi) * Math.sin(theta),
  ];
}

test('every keyframe is reached at its own time, whatever the easing and the position method', () => {
  for (const easing of ['linear', 'ease-in-out', 'ease-in', 'ease-out']) {
    for (const positionMethod of ['catmull-rom', 'linear', 'bezier']) {
      const plan = createCameraPathPlan(TOUR, options({ easing, positionMethod }));
      assert.deepEqual([...plan.times], [0, 7, 12, 15, 24]);
      plan.times.forEach((time, index) => {
        sameOrbit(interpolatePlannedCameraState(plan, time / plan.totalDuration), TOUR[index], `${easing}/${positionMethod} keyframe ${index}`);
      });
    }
  }
});

test('easing is how the path starts and ends: from rest, to rest, or moving', () => {
  const speedAt = (plan, t, dt = 1e-4) => {
    const a = eyeOf(interpolatePlannedCameraState(plan, Math.max(0, t - dt)));
    const b = eyeOf(interpolatePlannedCameraState(plan, Math.min(1, t + dt)));
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / ((Math.min(1, t + dt) - Math.max(0, t - dt)) * plan.totalDuration);
  };
  for (const positionMethod of ['catmull-rom', 'linear', 'bezier']) {
    const eased = createCameraPathPlan(TOUR, options({ positionMethod, easing: 'ease-in-out' }));
    const linear = createCameraPathPlan(TOUR, options({ positionMethod, easing: 'linear' }));
    const easeIn = createCameraPathPlan(TOUR, options({ positionMethod, easing: 'ease-in' }));
    assert.ok(speedAt(eased, 0) < 0.01, `${positionMethod}: ease-in-out starts from rest (${speedAt(eased, 0)})`);
    assert.ok(speedAt(eased, 1) < 0.01, `${positionMethod}: ease-in-out ends at rest`);
    assert.ok(speedAt(linear, 0) > 0.1, `${positionMethod}: linear starts moving`);
    assert.ok(speedAt(easeIn, 0) < 0.01 && speedAt(easeIn, 1) > 0.1, `${positionMethod}: ease-in rests at the start only`);
  }
});

test('a repeated keyframe is a hold: the camera eases in, rests for that transition, eases out', () => {
  const beta = TOUR[3];
  const path = [TOUR[0], TOUR[2], { ...beta, id: 'beta-hold', label: 'beta hold', transitionDuration: 4 }, { ...beta, transitionDuration: 6 }, TOUR[4]];
  for (const positionMethod of ['catmull-rom', 'linear', 'bezier']) {
    const plan = createCameraPathPlan(path, options({ positionMethod }));
    const [start, end] = [plan.times[2], plan.times[3]];
    for (let k = 0; k <= 20; k++) {
      const time = start + (end - start) * (k / 20);
      sameOrbit(interpolatePlannedCameraState(plan, time / plan.totalDuration), beta, `${positionMethod} hold at ${time.toFixed(2)} s`);
    }
  }
  // Catmull-Rom arrives at rest: no drift past the hold and back.
  const plan = createCameraPathPlan(path, options());
  const just = t => eyeOf(interpolatePlannedCameraState(plan, t / plan.totalDuration));
  const before = just(plan.times[2] - 0.01);
  const at = just(plan.times[2]);
  assert.ok(Math.hypot(...at.map((v, i) => v - before[i])) / 0.01 < 0.05, 'the camera arrives at the hold at rest');
});

test('no coordinate overshoots the keyframes it moves between: never closer to the data, never over a pole', () => {
  // Steep changes either side of a keyframe are where a uniform spline overshoots.
  const path = [
    orbitKeyframe('far', { radius: 4, phi: 0.3, seconds: 1 }),
    orbitKeyframe('near', { radius: 0.4, phi: 0.12, theta: 1.4, seconds: 8 }),
    orbitKeyframe('near too', { radius: 0.38, phi: 0.1, theta: 1.6, seconds: 1 }),
    orbitKeyframe('far again', { radius: 5, phi: 0.5, theta: 1.7 }),
  ];
  const plan = createCameraPathPlan(path, options({ easing: 'linear' }));
  for (let k = 0; k <= 4000; k++) {
    const time = (k / 4000) * plan.totalDuration;
    const i = Math.min(plan.times.findIndex(t => t >= time) - 1, path.length - 2);
    const segment = Math.max(0, i);
    const [a, b] = [path[segment], path[segment + 1]];
    const state = interpolatePlannedCameraState(plan, k / 4000);
    assert.ok(state.orbit.radius >= Math.min(a.orbit.radius, b.orbit.radius) - 1e-12, `radius ${state.orbit.radius} dips below its keyframes at ${time}`);
    assert.ok(state.orbit.radius <= Math.max(a.orbit.radius, b.orbit.radius) + 1e-12, `radius overshoots at ${time}`);
    assert.ok(state.orbit.phi >= Math.min(a.orbit.phi, b.orbit.phi) - 1e-12 && state.orbit.phi > 0, `phi ${state.orbit.phi} passes a keyframe at ${time}`);
  }
});

test('uneven transition times do not jolt the speed at a keyframe', () => {
  const path = [
    orbitKeyframe('a', { theta: 0, seconds: 1 }),
    orbitKeyframe('b', { theta: 0.5, seconds: 8 }),
    orbitKeyframe('c', { theta: 1.0, seconds: 1 }),
    orbitKeyframe('d', { theta: 1.5 }),
  ];
  const plan = createCameraPathPlan(path, options({ easing: 'linear' }));
  for (const index of [1, 2]) {
    const time = plan.times[index];
    const theta = t => interpolatePlannedCameraState(plan, t / plan.totalDuration).orbit.theta;
    const before = (theta(time) - theta(time - 1e-4)) / 1e-4;
    const after = (theta(time + 1e-4) - theta(time)) / 1e-4;
    assert.ok(Math.abs(before - after) / Math.max(Math.abs(before), 1e-9) < 0.01, `keyframe ${index}: ${before} rad/s before, ${after} after`);
  }
});

test('a looping path that returns to its start at a constant pace loops seamlessly: no change of speed at the seam', () => {
  // A turntable that comes back to where it began (the return to start).
  const thetas = [0, 1.5, 3.2, 4.6, 0];
  const path = thetas.map((theta, index) => orbitKeyframe(`k${index}`, { theta, radius: 3 - 0.3 * (index % 2), seconds: 3 }));
  path[4] = { ...path[0], id: 'return', label: 'return' };
  const velocity = (plan, t) => {
    const at = u => {
      const state = interpolatePlannedCameraState(plan, Math.min(1, Math.max(0, u)));
      return [state.orbit.theta, Math.log(state.orbit.radius)];
    };
    const [a, b] = [at(t - 1e-4), at(t + 1e-4)];
    const turn = Math.atan2(Math.sin(b[0] - a[0]), Math.cos(b[0] - a[0]));
    return [turn / 2e-4, (b[1] - a[1]) / 2e-4];
  };
  const seamless = createCameraPathPlan(path, options({ easing: 'linear', loop: true }));
  const [end, start] = [velocity(seamless, 1 - 1e-4), velocity(seamless, 1e-4)];
  end.forEach((value, k) => assert.ok(Math.abs(value - start[k]) < 0.02 * Math.max(1, Math.abs(start[k])), `seam: ${end} at the end, ${start} at the start`));
  // Not looping, the same path ends as it is told (moving at its last transition's own rate).
  const once = createCameraPathPlan(path, options({ easing: 'linear', loop: false }));
  const [endOnce, startOnce] = [velocity(once, 1 - 1e-4), velocity(once, 1e-4)];
  assert.ok(Math.abs(endOnce[1] - startOnce[1]) > 0.01, 'an open path does not join its ends');
  // Eased, a loop rests at its seam, as asked.
  const eased = createCameraPathPlan(path, options({ easing: 'ease-in-out', loop: true }));
  assert.ok(Math.abs(velocity(eased, 1e-4)[0]) < 0.05, 'an eased loop starts from rest');
});
