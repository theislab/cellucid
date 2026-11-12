// A keyframe's hold (F91, owner decision 2026-11-11): the camera reaches each
// keyframe at its time, rests there for its hold, then moves on; every
// transition keeps its own time, the path's length includes the holds, and
// the transport bar's marks show where each keyframe is reached and how long
// the camera rests (`interpolation-engine.js` `resolvePathTiming`,
// `keyframe-store.js`). A hold is no `hold` key when it is 0, so a path
// without holds is the value it was before holds (session format 4).
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCameraPathPlan,
  interpolatePlannedCameraState,
  resolvePathTiming,
} from '../assets/js/app/ui/modules/cinematic-camera/interpolation-engine.js';
import {
  createKeyframeStore,
  isValidCameraKeyframe,
  keyframeHold,
} from '../assets/js/app/ui/modules/cinematic-camera/keyframe-store.js';

function orbitKeyframe(id, { target = [0, 0, 0], radius = 3, theta = 0.5, phi = 1.2, seconds = 2, hold = 0 } = {}) {
  const eye = [
    target[0] + radius * Math.sin(phi) * Math.cos(theta),
    target[1] + radius * Math.cos(phi),
    target[2] + radius * Math.sin(phi) * Math.sin(theta),
  ];
  const forward = eye.map((value, axis) => (target[axis] - value) / radius);
  return {
    id, label: id, navigationMode: 'orbit',
    orbit: { radius, targetRadius: radius, theta, phi, target },
    freefly: { position: eye, yaw: Math.atan2(forward[2], forward[0]), pitch: Math.asin(forward[1]) },
    representation: null, transitionDuration: seconds,
    ...(hold > 0 ? { hold } : {}),
  };
}

const options = (overrides = {}) => ({
  positionMethod: 'catmull-rom', rotationMethod: 'slerp', easing: 'ease-in-out', loop: false, autoPaceSpeed: 1, ...overrides,
});

// Wide (rests 1.5 s at the start), two close-ups (the first rests 2 s), a pull-back that rests 3 s at the end.
const TOUR = [
  orbitKeyframe('wide', { radius: 3, theta: 0.2, phi: 1.3, seconds: 4, hold: 1.5 }),
  orbitKeyframe('ductal', { target: [-0.4, 0.6, -0.3], radius: 0.9, theta: 2.3, phi: 1.2, seconds: 5, hold: 2 }),
  orbitKeyframe('beta', { target: [0.4, -0.7, -0.2], radius: 0.6, theta: -1, phi: 1.7, seconds: 3 }),
  orbitKeyframe('pull-back', { radius: 3.2, theta: 0.9, phi: 1.2, hold: 3 }),
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

test('the timeline: each keyframe is reached after the transitions and holds before it, and the length includes every hold', () => {
  const timing = resolvePathTiming(TOUR, 1);
  assert.deepEqual([...timing.transitions], [4, 5, 3]);
  assert.deepEqual([...timing.holds], [1.5, 2, 0, 3]);
  assert.deepEqual([...timing.arrivals], [0, 5.5, 12.5, 15.5]);
  assert.deepEqual([...timing.departures], [1.5, 7.5, 12.5, 18.5]);
  assert.equal(timing.total, 18.5);
  const plan = createCameraPathPlan(TOUR, options());
  assert.deepEqual([...plan.times], [...timing.arrivals]);
  assert.equal(plan.totalDuration, 18.5);
});

test('the camera rests at a keyframe for its hold, whatever the easing and the position and rotation methods', () => {
  for (const easing of ['linear', 'ease-in-out', 'ease-in', 'ease-out']) {
    for (const positionMethod of ['catmull-rom', 'linear', 'bezier']) {
      for (const rotationMethod of ['slerp', 'linear']) {
        const plan = createCameraPathPlan(TOUR, options({ easing, positionMethod, rotationMethod }));
        const label = `${easing}/${positionMethod}/${rotationMethod}`;
        TOUR.forEach((keyframe, index) => {
          const [from, to] = [plan.times[index], plan.departures[index]];
          for (let k = 0; k <= 10; k++) {
            const time = from + (to - from) * (k / 10);
            sameOrbit(interpolatePlannedCameraState(plan, time / plan.totalDuration), keyframe, `${label} ${keyframe.label} at ${time.toFixed(2)} s`);
          }
        });
        // Between a departure and the next arrival the camera moves.
        const mid = (plan.departures[1] + plan.times[2]) / 2;
        const moving = interpolatePlannedCameraState(plan, mid / plan.totalDuration);
        assert.ok(Math.abs(moving.orbit.radius - TOUR[1].orbit.radius) > 1e-3, `${label}: it moves after the hold`);
      }
    }
  }
});

test('the camera leaves and reaches a hold at rest (no jolt), and each transition keeps its time', () => {
  const eye = state => {
    const { target, radius, theta, phi } = state.orbit;
    return [target[0] + radius * Math.sin(phi) * Math.cos(theta), target[1] + radius * Math.cos(phi), target[2] + radius * Math.sin(phi) * Math.sin(theta)];
  };
  const plan = createCameraPathPlan(TOUR, options({ easing: 'linear' }));
  const at = seconds => eye(interpolatePlannedCameraState(plan, seconds / plan.totalDuration));
  const speed = (a, b, dt) => Math.hypot(...a.map((v, i) => v - b[i])) / dt;
  // Catmull-Rom: the hold at ductal starts and ends at rest.
  assert.ok(speed(at(plan.times[1] - 0.01), at(plan.times[1]), 0.01) < 0.05, 'arrives at the hold at rest');
  assert.ok(speed(at(plan.departures[1] + 0.01), at(plan.departures[1]), 0.01) < 0.05, 'leaves the hold from rest');
  // A path without holds plays its transitions in the same times as with them, shifted only by the holds.
  const still = TOUR.map(({ hold, ...keyframe }) => keyframe);
  const timing = resolvePathTiming(still, 1);
  assert.deepEqual([...timing.transitions], [4, 5, 3]);
  assert.equal(timing.total, 12);
});

test('holds do not change a path that has none: the same plan, the same cameras', () => {
  const still = TOUR.map(({ hold, ...keyframe }) => keyframe);
  const plan = createCameraPathPlan(still, options());
  assert.deepEqual([...plan.times], [0, 4, 9, 12]);
  assert.deepEqual([...plan.departures], [...plan.times]);
  assert.equal(plan.stops.length, still.length);
});

test('the keyframe store keeps a hold as a positive number of seconds, and none as no key', () => {
  const store = createKeyframeStore();
  const camera = keyframe => ({ navigationMode: keyframe.navigationMode, orbit: keyframe.orbit, freefly: keyframe.freefly });
  const a = store.add(camera(TOUR[0]), 'A', null, 2);
  store.add(camera(TOUR[1]), 'B', null);
  assert.equal(keyframeHold(store.getById(a)), 2);
  let exported = store.exportAll().keyframes;
  assert.equal(exported[0].hold, 2);
  assert.equal(Object.hasOwn(exported[1], 'hold'), false, 'no hold is no key');
  store.setHold(0, 0);
  assert.equal(Object.hasOwn(store.exportAll().keyframes[0], 'hold'), false, 'a hold set to 0 leaves no key');
  store.setAllHolds(1.25);
  exported = store.exportAll().keyframes;
  assert.deepEqual(exported.map(kf => kf.hold), [1.25, 1.25]);
  // Renamed, moved or retimed, a keyframe keeps its hold.
  store.rename(a, 'A2');
  store.setDuration(0, 3);
  store.reorder(a, 1);
  assert.deepEqual(store.getAll().map(kf => [kf.label, keyframeHold(kf)]), [['B', 1.25], ['A2', 1.25]]);
  // Round trip.
  const other = createKeyframeStore();
  assert.equal(other.importAll(store.exportAll()), true);
  assert.deepEqual(other.exportAll(), store.exportAll());
  for (const bad of [-1, Number.NaN, Infinity, '2']) {
    assert.throws(() => store.setHold(0, bad), /hold/i, `refuses a hold of ${String(bad)}`);
    assert.throws(() => store.add(camera(TOUR[2]), `bad ${String(bad)}`, null, bad), /hold/i);
  }
});

test('a stored or session keyframe holds a positive finite number of seconds, or has no hold key', () => {
  const plain = orbitKeyframe('plain');
  assert.equal(isValidCameraKeyframe(plain), true);
  assert.equal(isValidCameraKeyframe({ ...plain, hold: 2.5 }), true);
  for (const hold of [0, -1, Number.NaN, Infinity, null, '2']) {
    assert.equal(isValidCameraKeyframe({ ...plain, hold }), false, `hold ${String(hold)}`);
  }
});
