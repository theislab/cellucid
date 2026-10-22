import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createDefaultCameraPose } from '../assets/js/rendering/camera-state-contract.js';

const viewerSource = await readFile(
  new URL('../assets/js/rendering/viewer.js', import.meta.url),
  'utf8',
);

test('the free-fly reset pose looks at the orbit reset target from the orbit eye', () => {
  const { orbit, freefly } = createDefaultCameraPose();
  // The viewer's orbit eye convention.
  const eye = [
    orbit.target[0] + orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta),
    orbit.target[1] + orbit.radius * Math.cos(orbit.phi),
    orbit.target[2] + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta),
  ];
  freefly.position.forEach((value, index) => {
    assert.ok(Math.abs(value - eye[index]) < 1e-12);
  });
  // The viewer's free-fly forward convention.
  const forward = [
    Math.cos(freefly.pitch) * Math.cos(freefly.yaw),
    Math.sin(freefly.pitch),
    Math.cos(freefly.pitch) * Math.sin(freefly.yaw),
  ];
  const toTarget = orbit.target.map((value, index) => value - eye[index]);
  const length = Math.hypot(...toTarget);
  const alignment = forward.reduce(
    (sum, value, index) => sum + value * (toTarget[index] / length),
    0,
  );
  assert.ok(alignment > 1 - 1e-12, `free-fly reset faces ${alignment} of the way to the data`);
});

test('leaving free-fly after a reset recovers the orbit reset angles', () => {
  const { orbit, freefly } = createDefaultCameraPose();
  // Mirrors syncOrbitFromFreefly().
  const offset = freefly.position.map((value, index) => value - orbit.target[index]);
  const radius = Math.hypot(...offset);
  assert.ok(Math.abs(radius - orbit.radius) < 1e-12);
  assert.ok(Math.abs(Math.atan2(offset[2], offset[0]) - orbit.theta) < 1e-12);
  assert.ok(Math.abs(Math.acos(offset[1] / radius) - orbit.phi) < 1e-12);
});

test('the viewer starts from and resets to the shared pose, with no private copy', () => {
  const resetBody = viewerSource.slice(
    viewerSource.indexOf('    resetCamera() {'),
    viewerSource.indexOf('    getCameraState() {'),
  );
  assert.match(resetBody, /createDefaultCameraPose\(\)/);
  assert.doesNotMatch(resetBody, /Math\.PI \/ 4|0, 0, 3\.0/);
  assert.match(viewerSource, /const initialCameraPose = createDefaultCameraPose\(\);/);
});
