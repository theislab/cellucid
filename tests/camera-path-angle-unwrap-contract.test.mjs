import assert from 'node:assert/strict';
import test from 'node:test';

import { interpolateCameraState } from '../assets/js/app/ui/modules/cinematic-camera/interpolation-engine.js';

const TAU = 2 * Math.PI;

function orbitKeyframe(id, theta, phi = Math.PI / 3, radius = 3) {
  const eye = [
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  ];
  const forward = eye.map(value => -value / radius);
  return {
    id,
    label: id,
    navigationMode: 'orbit',
    orbit: { radius, targetRadius: radius, theta, phi, target: [0, 0, 0] },
    freefly: {
      position: eye,
      yaw: Math.atan2(forward[2], forward[0]),
      pitch: Math.asin(forward[1]),
    },
    representation: null,
    transitionDuration: 2,
  };
}

const SPLINE = Object.freeze({
  positionMethod: 'catmull-rom',
  rotationMethod: 'slerp',
  easing: 'linear',
  loop: false,
  autoPaceSpeed: 1,
});

function thetaSteps(thetas, samples = 400) {
  const keyframes = thetas.map((theta, index) => orbitKeyframe(`k${index}`, theta));
  const steps = [];
  let previous = null;
  for (let sample = 0; sample <= samples; sample++) {
    const { theta } = interpolateCameraState(keyframes, sample / samples, SPLINE).orbit;
    if (previous !== null) {
      let delta = theta - previous;
      delta -= Math.round(delta / TAU) * TAU;
      steps.push(delta);
    }
    previous = theta;
  }
  return steps;
}

function assertTurntable(thetas, expectedSweep) {
  const steps = thetaSteps(thetas);
  const backwards = steps.filter(step => step < 0);
  assert.equal(
    backwards.length,
    0,
    `camera reversed ${backwards.length} times, worst ${Math.min(...steps)} rad`,
  );
  const sweep = steps.reduce((sum, step) => sum + step, 0);
  assert.ok(Math.abs(sweep - expectedSweep) < 1e-9, `sweep ${sweep}`);
}

test('a turntable of 90 degree keyframes turns forward through every keyframe', () => {
  assertTurntable([0, Math.PI / 2, Math.PI, 1.5 * Math.PI, TAU], TAU);
});

test('wrapped captured angles still turn forward through every keyframe', () => {
  assertTurntable([0, Math.PI / 2, Math.PI, 1.5 * Math.PI, 0], TAU);
});

test('three keyframes 120 degrees apart that return to the start keep turning forward', () => {
  assertTurntable([0, TAU / 3, 2 * TAU / 3, 0], TAU);
});
