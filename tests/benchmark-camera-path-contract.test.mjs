import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BenchmarkCameraPath,
  CAMERA_REGIMES,
  createMutableCameraState,
  createSeededUnitStream,
  LOD_FAR_DISTANCE_RATIO,
  LOD_NEAR_DISTANCE_RATIO,
  pathFrameForRegime
} from '../assets/js/app/ui/modules/benchmark/camera-path.js';
import { isExactCameraState } from '../assets/js/rendering/camera-state-contract.js';

const BASE_RADIUS = 3;

function samplePose(path, state, frameIndex) {
  path.sampleInto(state, frameIndex);
  return {
    radius: state.orbit.radius,
    theta: state.orbit.theta,
    phi: state.orbit.phi,
    target: [...state.orbit.target]
  };
}

test('the scripted camera path is a pure function of the frame index', () => {
  const first = new BenchmarkCameraPath({ baseRadius: BASE_RADIUS, seed: 7 });
  const second = new BenchmarkCameraPath({ baseRadius: BASE_RADIUS, seed: 7 });
  const stateA = createMutableCameraState();
  const stateB = createMutableCameraState();

  for (const frameIndex of [0, 1, 37, 599, 600, 1201]) {
    assert.deepEqual(
      samplePose(first, stateA, frameIndex),
      samplePose(second, stateB, frameIndex),
      `frame ${frameIndex} must be identical across runs`
    );
  }

  // Re-sampling an earlier frame reproduces it exactly, so a repeated run
  // visits the same poses rather than merely a similar path.
  const early = samplePose(first, stateA, 42);
  samplePose(first, stateA, 900);
  assert.deepEqual(samplePose(first, stateA, 42), early);
});

test('a different seed places a different path', () => {
  const stateA = createMutableCameraState();
  const stateB = createMutableCameraState();
  const poseA = samplePose(
    new BenchmarkCameraPath({ baseRadius: BASE_RADIUS, seed: 1 }),
    stateA,
    11
  );
  const poseB = samplePose(
    new BenchmarkCameraPath({ baseRadius: BASE_RADIUS, seed: 2 }),
    stateB,
    11
  );
  assert.notDeepEqual(poseA, poseB);
});

test('every sampled pose satisfies the viewer camera-state contract', () => {
  const path = new BenchmarkCameraPath({ baseRadius: BASE_RADIUS, seed: 3 });
  const state = createMutableCameraState();
  for (let frameIndex = 0; frameIndex < 400; frameIndex += 7) {
    path.sampleInto(state, frameIndex);
    assert.equal(
      isExactCameraState(state),
      true,
      `frame ${frameIndex} must be publishable to the viewer`
    );
  }
});

test('sampling reuses the caller state and allocates no new slots', () => {
  const path = new BenchmarkCameraPath({ baseRadius: BASE_RADIUS });
  const state = createMutableCameraState();
  const orbitTarget = state.orbit.target;
  const freeflyPosition = state.freefly.position;
  const returned = path.sampleInto(state, 12);
  assert.equal(returned, state);
  assert.equal(state.orbit.target, orbitTarget);
  assert.equal(state.freefly.position, freeflyPosition);
});

test('the freefly half stays consistent with the orbit half', () => {
  const path = new BenchmarkCameraPath({ baseRadius: BASE_RADIUS, seed: 5 });
  const state = createMutableCameraState();
  for (const frameIndex of [0, 13, 250, 977]) {
    path.sampleInto(state, frameIndex);
    const dx = state.freefly.position[0] - state.orbit.target[0];
    const dy = state.freefly.position[1] - state.orbit.target[1];
    const dz = state.freefly.position[2] - state.orbit.target[2];
    const distance = Math.hypot(dx, dy, dz);
    assert.ok(
      Math.abs(distance - state.orbit.radius) < 1e-9,
      `frame ${frameIndex}: freefly eye must sit at the orbit radius`
    );
    // The freefly heading must look back at the orbit target.
    const forwardX = Math.cos(state.freefly.pitch) * Math.cos(state.freefly.yaw);
    const forwardY = Math.sin(state.freefly.pitch);
    const forwardZ = Math.cos(state.freefly.pitch) * Math.sin(state.freefly.yaw);
    assert.ok(Math.abs(forwardX + dx / distance) < 1e-9);
    assert.ok(Math.abs(forwardY + dy / distance) < 1e-9);
    assert.ok(Math.abs(forwardZ + dz / distance) < 1e-9);
  }
});

test('the default sweep spans the renderer LOD selection domain', () => {
  // SpatialIndex.getLODLevel() clamps distance / dataDiagonal into
  // [0.3, 3.0] and maps it logarithmically onto the level range. A path that
  // does not visit both ends measures a single LOD level and calls it a sweep.
  const dataDiagonal = 2 * Math.sqrt(3);
  // The fitted camera radius is not exactly the data diagonal on real data,
  // so the default sweep must still span the domain across the plausible band.
  for (const fittedRatio of [0.8, 0.9, 1, 1.1, 1.2]) {
    const fitted = new BenchmarkCameraPath({
      baseRadius: dataDiagonal * fittedRatio
    });
    const fittedCoverage = fitted.describeLodCoverage(dataDiagonal);
    assert.equal(
      fittedCoverage.spansLodDomain,
      true,
      `fitted radius ${fittedRatio}x the diagonal must span the LOD domain`
    );
  }

  const path = new BenchmarkCameraPath({ baseRadius: dataDiagonal });
  const coverage = path.describeLodCoverage(dataDiagonal);
  assert.ok(coverage.nearRatio <= LOD_NEAR_DISTANCE_RATIO, 'near end');
  assert.ok(coverage.farRatio >= LOD_FAR_DISTANCE_RATIO, 'far end');
  assert.equal(coverage.spansLodDomain, true);

  const state = createMutableCameraState();
  let minRadius = Infinity;
  let maxRadius = -Infinity;
  for (let frameIndex = 0; frameIndex < path.periodFrames; frameIndex++) {
    path.sampleInto(state, frameIndex);
    minRadius = Math.min(minRadius, state.orbit.radius);
    maxRadius = Math.max(maxRadius, state.orbit.radius);
  }
  assert.ok(minRadius / dataDiagonal <= LOD_NEAR_DISTANCE_RATIO);
  assert.ok(maxRadius / dataDiagonal >= LOD_FAR_DISTANCE_RATIO);
});

test('the path pans the orbit target away from the data centre', () => {
  // Frustum culling only does work when geometry leaves the view. A path that
  // orbits a fixed centre keeps the whole cloud on screen at every angle.
  const path = new BenchmarkCameraPath({ baseRadius: BASE_RADIUS, seed: 9 });
  const state = createMutableCameraState();
  let maxOffset = 0;
  for (let frameIndex = 0; frameIndex < path.periodFrames; frameIndex++) {
    path.sampleInto(state, frameIndex);
    maxOffset = Math.max(
      maxOffset,
      Math.hypot(
        state.orbit.target[0],
        state.orbit.target[1],
        state.orbit.target[2]
      )
    );
  }
  assert.ok(
    maxOffset > BASE_RADIUS * 0.3,
    `target pan reached only ${maxOffset} world units`
  );
});

test('consecutive orbit frames exceed the orbit-anchor rebuild threshold', () => {
  // The orbit anchor rebuilds its whole geometry whenever the view angle moves
  // more than 0.01 rad since its last rebuild, or the anchor position changes
  // at all. A benchmark that moves slower than that never prices it.
  const path = new BenchmarkCameraPath({ baseRadius: BASE_RADIUS });
  const state = createMutableCameraState();
  path.sampleInto(state, 0);
  let previousTheta = state.orbit.theta;
  let framesAboveThreshold = 0;
  for (let frameIndex = 1; frameIndex < 240; frameIndex++) {
    path.sampleInto(state, frameIndex);
    if (Math.abs(state.orbit.theta - previousTheta) > 0.01) {
      framesAboveThreshold++;
    }
    previousTheta = state.orbit.theta;
  }
  assert.equal(framesAboveThreshold, 239);
});

test('the static regime pins the path start and orbit advances', () => {
  assert.deepEqual([...CAMERA_REGIMES], ['static', 'orbit']);
  for (const frameIndex of [0, 1, 999]) {
    assert.equal(pathFrameForRegime('static', frameIndex), 0);
    assert.equal(pathFrameForRegime('orbit', frameIndex), frameIndex);
  }
  assert.throws(() => pathFrameForRegime('spin', 0), /Camera regime/);
  assert.throws(() => pathFrameForRegime('orbit', -1), /non-negative/);
});

test('the seeded unit stream is repeatable and bounded', () => {
  const first = createSeededUnitStream(12345);
  const second = createSeededUnitStream(12345);
  for (let i = 0; i < 64; i++) {
    const value = first();
    assert.equal(value, second());
    assert.ok(value >= 0 && value < 1);
  }
  assert.throws(() => createSeededUnitStream(1.5), /safe integer/);
});

test('path construction rejects an unusable description', () => {
  assert.throws(
    () => new BenchmarkCameraPath({ baseRadius: 0 }),
    /greater than zero/
  );
  assert.throws(
    () => new BenchmarkCameraPath({ baseRadius: 1, nearFactor: 3, farFactor: 2 }),
    /farFactor must exceed nearFactor/
  );
  assert.throws(
    () => new BenchmarkCameraPath({ baseRadius: 1, periodFrames: 0 }),
    /positive safe integer/
  );
  assert.throws(
    () => new BenchmarkCameraPath({ baseRadius: 1, center: [0, 0] }),
    /three finite numbers/
  );
  assert.throws(
    () => new BenchmarkCameraPath({ baseRadius: 1, panFactor: -1 }),
    /must not be negative/
  );
  assert.throws(
    () => new BenchmarkCameraPath({ baseRadius: 1 }).sampleInto(
      createMutableCameraState(),
      -1
    ),
    /non-negative safe integer/
  );
  assert.throws(
    () => new BenchmarkCameraPath({ baseRadius: 1 }).describeLodCoverage(0),
    /greater than zero/
  );
});
