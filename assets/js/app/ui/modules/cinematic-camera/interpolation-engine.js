/**
 * @fileoverview Pure-math interpolation engine for cinematic camera paths.
 *
 * Supports Catmull-Rom, Linear, and Bezier position interpolation plus SLERP
 * (spherical linear interpolation) for rotational angles.  All functions are
 * dependency-free — no gl-matrix, no DOM.
 *
 * **Time is honored.** Each keyframe is reached at its time on the timeline:
 * the sum of the transitions and holds before it (`transitionDuration`, or
 * the automatic pace; `hold`). A transition of 5 s takes 5 s, a hold of 2 s
 * rests the camera at its keyframe for 2 s before the next transition, and
 * the transport bar's keyframe marks (with their rest spans) are where the
 * camera is at each keyframe (`resolvePathTiming`).
 *
 * **Easing is how the path starts and ends**: from rest (`ease-in`), to rest
 * (`ease-out`), both (`ease-in-out`), or moving at once and to the last
 * frame (`linear`). It never stretches one transition at another's expense.
 * (Warping the whole timeline would play a transition in the middle of an
 * eased path faster than its time and the first one slower, and the bar's
 * marks would not be where the keyframes are.)
 *
 * **The Catmull-Rom spline is the cinematic one**: a cubic through every
 * keyframe whose velocity is continuous across keyframes, with tangents
 * scaled by the keyframes' times (so uneven transition times do not jolt the
 * speed at a keyframe) and clamped where a coordinate turns (the monotone
 * cubic of Fritsch and Carlson, as animation tools' "auto clamped" tangents):
 * no coordinate overshoots the keyframes on either side of it. The camera
 * therefore never comes closer to the data than the keyframes it moves
 * between (the radius is interpolated in log space and never dips below its
 * neighbors), never tilts past a keyframe's elevation (so it never crosses
 * a pole and flips), and at a keyframe that holds the camera eases into it,
 * rests for the hold, and eases out (a hold is the keyframe twice on the
 * plan's timeline, `stops`; a keyframe saved twice in a row rests the same way).
 *
 * @module ui/modules/cinematic-camera/interpolation-engine
 */

import { assertCameraKeyframe, keyframeHold } from './keyframe-store.js';

const POSITION_METHODS = new Set(['catmull-rom', 'linear', 'bezier']);
const ROTATION_METHODS = new Set(['slerp', 'linear']);
const CAMERA_PATH_OPTION_KEYS = [
  'autoPaceSpeed',
  'easing',
  'loop',
  'positionMethod',
  'rotationMethod'
];

// ---------------------------------------------------------------------------
// Easing: how the path starts and ends
// ---------------------------------------------------------------------------

const EASINGS = new Set(['linear', 'ease-in-out', 'ease-in', 'ease-out']);

/** Whether the path starts from rest. */
function easesIn(easing) {
  return easing === 'ease-in' || easing === 'ease-in-out';
}

/** Whether the path comes to rest at its end. */
function easesOut(easing) {
  return easing === 'ease-out' || easing === 'ease-in-out';
}

/**
 * The progress through one transition of a per-transition method (linear
 * positions, Bezier, SLERP, linear angles): the first transition starts from
 * rest when the path eases in, the last ends at rest when it eases out, and
 * the speed where an eased transition meets the next is the speed of a
 * linear one (the curves' slope there is 1), so no keyframe jolts.
 *
 * @param {number} t  0..1 through segment `segIndex` of `segmentCount`.
 */
function easeSegment(t, segIndex, segmentCount, easing) {
  const from = segIndex === 0 && easesIn(easing);
  const to = segIndex === segmentCount - 1 && easesOut(easing);
  if (from && to) return t * t * (3 - 2 * t);
  if (from) return t * t * (2 - t);
  if (to) return 1 - (1 - t) * (1 - t) * (1 + t);
  return t;
}

function assertKeyframes(keyframes) {
  if (!Array.isArray(keyframes)) {
    throw new TypeError('Camera path keyframes must be an array.');
  }
  keyframes.forEach((keyframe, index) => {
    assertCameraKeyframe(keyframe, `Camera path keyframe ${index}`);
  });
}

function assertAutoPaceSpeed(autoPaceSpeed) {
  if (!Number.isFinite(autoPaceSpeed) || autoPaceSpeed <= 0) {
    throw new TypeError('Camera path autoPaceSpeed must be a positive finite number.');
  }
  return autoPaceSpeed;
}

export function assertCameraPathOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Camera path interpolation options must be an object.');
  }
  const keys = Object.keys(options).sort();
  if (
    keys.length !== CAMERA_PATH_OPTION_KEYS.length ||
    keys.some((key, index) => key !== CAMERA_PATH_OPTION_KEYS[index])
  ) {
    throw new TypeError(
      `Camera path options must contain exactly ${CAMERA_PATH_OPTION_KEYS.join(', ')}.`
    );
  }
  if (!POSITION_METHODS.has(options.positionMethod)) {
    throw new RangeError(`Unsupported camera path position method: ${String(options.positionMethod)}.`);
  }
  if (!ROTATION_METHODS.has(options.rotationMethod)) {
    throw new RangeError(`Unsupported camera path rotation method: ${String(options.rotationMethod)}.`);
  }
  if (!EASINGS.has(options.easing)) {
    throw new RangeError(`Unsupported camera path easing: ${String(options.easing)}.`);
  }
  if (typeof options.loop !== 'boolean') {
    throw new TypeError('Camera path loop must be boolean.');
  }
  assertAutoPaceSpeed(options.autoPaceSpeed);
  return options;
}

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Shortest-path angle lerp (handles 2π wrapping). */
function lerpAngle(a, b, t) {
  let d = b - a;
  // wrap into [-π, π]
  d = d - Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
  return a + d * t;
}

/** The shortest turn from `base` to `value`, as an angle near `base`. */
function unwrapAngle(base, value) {
  let d = value - base;
  d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
  return base + d;
}

/**
 * The tangents (per second) of a time-honored, clamped cubic through
 * `values` at `times`: the monotone cubic of Fritsch and Carlson (as
 * Fritsch–Butland weighted), so no value overshoots its neighbors, and a
 * value equal to a neighbor (a hold) has a zero tangent. The ends start
 * from rest or end at rest when the path eases there, else move at the
 * first or last transition's own rate.
 *
 * @param {number[]} values
 * @param {number[]} times  Increasing.
 * @param {boolean} restAtStart
 * @param {boolean} restAtEnd
 * @returns {number[]}
 */
function clampedTangents(values, times, restAtStart, restAtEnd, periodic = false) {
  const n = values.length;
  const tangents = new Array(n).fill(0);
  if (n < 2) return tangents;
  const slopes = [];
  for (let i = 0; i < n - 1; i++) {
    slopes.push((values[i + 1] - values[i]) / (times[i + 1] - times[i]));
  }
  const clamped = (before, after, hBefore, hAfter) => {
    if (before * after <= 0) return 0;
    const wBefore = 2 * hAfter + hBefore;
    const wAfter = hAfter + 2 * hBefore;
    return (wBefore + wAfter) / (wBefore / before + wAfter / after);
  };
  for (let i = 1; i < n - 1; i++) {
    tangents[i] = clamped(slopes[i - 1], slopes[i], times[i] - times[i - 1], times[i + 1] - times[i]);
  }
  if (periodic) {
    // The seam of a seamless loop: the last transition flows into the first.
    const seam = clamped(slopes[n - 2], slopes[0], times[n - 1] - times[n - 2], times[1] - times[0]);
    tangents[0] = seam;
    tangents[n - 1] = seam;
    return tangents;
  }
  tangents[0] = restAtStart ? 0 : slopes[0];
  tangents[n - 1] = restAtEnd ? 0 : slopes[n - 2];
  return tangents;
}

/** A cubic Hermite segment from `p0` (tangent `m0`) to `p1` (tangent `m1`) lasting `h`, at `s` in 0..1. */
function hermite(p0, p1, m0, m1, h, s) {
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p0 +
    (s3 - 2 * s2 + s) * h * m0 +
    (-2 * s3 + 3 * s2) * p1 +
    (s3 - s2) * h * m1;
}

/**
 * One coordinate of every keyframe as a clamped time spline: its values
 * (angles unwrapped so each hop turns the short way), and their tangents.
 */
function spline(keyframes, times, read, { angle = false, log = false, restAtStart, restAtEnd, periodic = false }) {
  const values = [];
  for (let i = 0; i < keyframes.length; i++) {
    let value = read(keyframes[i]);
    if (log) value = Math.log(value);
    if (angle && i > 0) value = unwrapAngle(values[i - 1], value);
    values.push(value);
  }
  return Object.freeze({
    values: Object.freeze(values),
    tangents: Object.freeze(clampedTangents(values, times, restAtStart, restAtEnd, periodic)),
    log
  });
}

function splineAt(channel, times, segIndex, s, label) {
  const i = segIndex;
  const value = hermite(
    channel.values[i],
    channel.values[i + 1],
    channel.tangents[i],
    channel.tangents[i + 1],
    times[i + 1] - times[i],
    s
  );
  if (!channel.log) return value;
  const scale = Math.exp(value);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError(`${label} interpolation exceeded the finite positive camera range.`);
  }
  return scale;
}

// ---------------------------------------------------------------------------
// SLERP on spherical angles (no quaternion library needed)
// ---------------------------------------------------------------------------

/**
 * SLERP between two directions described by spherical coordinates.
 *
 * Works for both orbit (theta, phi) and freefly (yaw, pitch) by converting
 * to Cartesian unit vectors, interpolating on the great circle, and converting
 * back.
 *
 * The mapping used:
 *   x = sin(phi) * sin(theta)
 *   y = cos(phi)
 *   z = sin(phi) * cos(theta)
 *
 * For freefly the caller passes (yaw, pitch) and we map:
 *   x = cos(pitch) * cos(yaw)
 *   y = sin(pitch)
 *   z = cos(pitch) * sin(yaw)
 *
 * @param {number} t1  First angle A (theta or yaw)
 * @param {number} t2  First angle B
 * @param {number} p1  Second angle A (phi or pitch)
 * @param {number} p2  Second angle B
 * @param {number} t   Interpolation factor [0, 1]
 * @param {boolean} [isFreefly=false]  Use freefly angle convention.
 * @returns {{ a: number, b: number }}  Interpolated (theta/yaw, phi/pitch).
 */
function slerpAngles(t1, p1, t2, p2, t, isFreefly) {
  if (t === 0) return { a: t1, b: p1 };
  if (t === 1) return { a: t2, b: p2 };

  let ax, ay, az, bx, by, bz;

  if (isFreefly) {
    ax = Math.cos(p1) * Math.cos(t1);
    ay = Math.sin(p1);
    az = Math.cos(p1) * Math.sin(t1);
    bx = Math.cos(p2) * Math.cos(t2);
    by = Math.sin(p2);
    bz = Math.cos(p2) * Math.sin(t2);
  } else {
    ax = Math.sin(p1) * Math.sin(t1);
    ay = Math.cos(p1);
    az = Math.sin(p1) * Math.cos(t1);
    bx = Math.sin(p2) * Math.sin(t2);
    by = Math.cos(p2);
    bz = Math.sin(p2) * Math.cos(t2);
  }

  let dot = ax * bx + ay * by + az * bz;
  dot = Math.max(-1, Math.min(1, dot));

  const omega = Math.acos(dot);
  if (omega < 1e-6) {
    // This is the exact zero-angle limiting form of SLERP.
    return { a: lerpAngle(t1, t2, t), b: lerp(p1, p2, t) };
  }

  let cx;
  let cy;
  let cz;
  if (Math.PI - omega < 1e-6) {
    // Antipodal directions have infinitely many great-circle paths. Choose a
    // deterministic orthogonal direction instead of dividing by sin(π), whose
    // round-off noise otherwise causes cross-browser path flips.
    const absX = Math.abs(ax);
    const absY = Math.abs(ay);
    const absZ = Math.abs(az);
    let ox;
    let oy;
    let oz;
    if (absX <= absY && absX <= absZ) {
      ox = 0;
      oy = az;
      oz = -ay;
    } else if (absY <= absZ) {
      ox = -az;
      oy = 0;
      oz = ax;
    } else {
      ox = ay;
      oy = -ax;
      oz = 0;
    }
    const orthogonalLength = Math.hypot(ox, oy, oz);
    ox /= orthogonalLength;
    oy /= orthogonalLength;
    oz /= orthogonalLength;

    const angle = Math.PI * t;
    const startWeight = Math.cos(angle);
    const orthogonalWeight = Math.sin(angle);
    cx = startWeight * ax + orthogonalWeight * ox;
    cy = startWeight * ay + orthogonalWeight * oy;
    cz = startWeight * az + orthogonalWeight * oz;
  } else {
    const sinOmega = Math.sin(omega);
    const s0 = Math.sin((1 - t) * omega) / sinOmega;
    const s1 = Math.sin(t * omega) / sinOmega;
    cx = s0 * ax + s1 * bx;
    cy = s0 * ay + s1 * by;
    cz = s0 * az + s1 * bz;
  }

  const directionLength = Math.hypot(cx, cy, cz);
  cx /= directionLength;
  cy /= directionLength;
  cz /= directionLength;

  if (isFreefly) {
    const pitch = Math.asin(Math.max(-1, Math.min(1, cy)));
    const yaw = Math.atan2(cz, cx);
    return { a: yaw, b: pitch };
  }

  const phi = Math.acos(Math.max(-1, Math.min(1, cy)));
  const theta = Math.atan2(cx, cz);
  return { a: theta, b: phi };
}

// ---------------------------------------------------------------------------
// Distance helpers (for auto-pacing)
// ---------------------------------------------------------------------------

function vec3Dist(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Approximate distance between two keyframes for auto-pacing.
 *
 * Uses the freefly (eye-position) representation for cross-mode segments since
 * it is the universal space shared by all modes.  Same-mode orbit/planar
 * segments use the orbit target + radius metric which better reflects the
 * user's perceived motion.
 */
function keyframeDistance(kfA, kfB) {
  const modeA = kfA.navigationMode;
  const modeB = kfB.navigationMode;

  // Cross-mode or freefly: measure world-space eye-position distance
  if (modeA !== modeB || modeA === 'free') {
    const posA = kfA.freefly.position;
    const posB = kfB.freefly.position;
    return vec3Dist(posA, posB) + 0.5; // +0.5 baseline so identical positions still move
  }

  // Same-mode orbit / planar: target movement + radius change + arc travel
  const tA = kfA.orbit.target;
  const tB = kfB.orbit.target;
  const rA = kfA.orbit.radius;
  const rB = kfB.orbit.radius;
  // Account for angular travel (theta, phi) so large orbits around the same
  // target don't collapse to zero distance and whip the camera around.
  let dTheta = kfB.orbit.theta - kfA.orbit.theta;
  dTheta -= Math.round(dTheta / (2 * Math.PI)) * 2 * Math.PI; // wrap to [-π, π]
  const dPhi = kfB.orbit.phi - kfA.orbit.phi;
  const avgR = (rA + rB) / 2;
  const arcLength = avgR * Math.sqrt(dTheta * dTheta + dPhi * dPhi);
  return vec3Dist(tA, tB) + Math.abs(rA - rB) + arcLength + 0.5;
}

// ---------------------------------------------------------------------------
// Segment timing resolver
// ---------------------------------------------------------------------------

/** Segment timing for an already-validated path. */
function segmentDurations(keyframes, speed) {
  const n = keyframes.length;
  if (n < 2) return [];
  const durations = [];
  for (let i = 0; i < n - 1; i++) {
    const d = keyframes[i].transitionDuration;
    if (d != null && d > 0) {
      durations.push(d);
    } else {
      // Auto-pace
      const dist = keyframeDistance(keyframes[i], keyframes[i + 1]);
      durations.push(Math.max(0.3, dist / speed));
    }
  }
  return durations;
}

/** The timeline of an already-validated path (`resolvePathTiming`). */
function pathTiming(keyframes, speed) {
  const transitions = segmentDurations(keyframes, speed);
  const holds = keyframes.map(keyframeHold);
  const arrivals = [];
  const departures = [];
  let at = 0;
  for (let i = 0; i < keyframes.length; i++) {
    arrivals.push(at);
    at += holds[i];
    departures.push(at);
    if (i < transitions.length) at += transitions[i];
  }
  return Object.freeze({
    transitions: Object.freeze(transitions),
    holds: Object.freeze(holds),
    arrivals: Object.freeze(arrivals),
    departures: Object.freeze(departures),
    total: at
  });
}

/**
 * The path's timeline: each transition's seconds (set, or paced by the
 * speed), each keyframe's hold, when the camera reaches each keyframe and
 * when it leaves it (after its hold), and the whole length. The one source
 * of a path's times: playback, the transport bar's marks, the Camera path
 * panel and `camera-path.get` all read it.
 *
 * @param {import('./keyframe-store.js').Keyframe[]} keyframes
 * @param {number} autoPaceSpeed  Positive finite units/s for auto-paced segments.
 * @returns {Readonly<{transitions: number[], holds: number[], arrivals: number[],
 *   departures: number[], total: number}>} Seconds; `transitions` has
 *   `keyframes.length - 1` entries, the others one per keyframe.
 */
export function resolvePathTiming(keyframes, autoPaceSpeed) {
  assertKeyframes(keyframes);
  return pathTiming(keyframes, assertAutoPaceSpeed(autoPaceSpeed));
}

/**
 * Validate a path and its settings once, and resolve its timing table once.
 *
 * A playback run walks the same keyframes on every frame: the store freezes
 * each keyframe and announces every mutation, and the playback controller stops
 * on that announcement, so the path cannot change under a running loop. Proving
 * the schema again on each frame therefore costs work proportional to the path
 * length without being able to reach a different answer (a 100-keyframe path
 * would re-derive 1,200 key arrays per frame). The plan moves that proof to the one
 * place where the input can actually differ.
 *
 * @param {import('./keyframe-store.js').Keyframe[]} keyframes
 * @param {Object} options  Exact camera-path options; see assertCameraPathOptions.
 * @returns {Readonly<Object>} Frozen, validated path plan.
 */
export function createCameraPathPlan(keyframes, options) {
  assertKeyframes(keyframes);
  assertCameraPathOptions(options);
  const timing = pathTiming(keyframes, options.autoPaceSpeed);
  // The timeline the camera follows: every keyframe at its arrival, and a
  // keyframe that holds once more at its departure. Between the two copies
  // the camera rests; each other span is a transition (`stopMoves`).
  const stops = [];
  const stopTimes = [];
  const stopMoves = [];
  for (let i = 0; i < keyframes.length; i++) {
    stops.push(keyframes[i]);
    stopTimes.push(timing.arrivals[i]);
    if (timing.holds[i] > 0) {
      stopMoves.push(null);
      stops.push(keyframes[i]);
      stopTimes.push(timing.departures[i]);
    }
    if (i < timing.transitions.length) stopMoves.push(i);
  }
  return Object.freeze({
    keyframes: Object.freeze(keyframes.slice()),
    durations: timing.transitions,
    holds: timing.holds,
    times: timing.arrivals,
    departures: timing.departures,
    totalDuration: timing.total,
    stops: Object.freeze(stops),
    stopTimes: Object.freeze(stopTimes),
    stopMoves: Object.freeze(stopMoves),
    positionMethod: options.positionMethod,
    rotationMethod: options.rotationMethod,
    easing: options.easing,
    autoPaceSpeed: options.autoPaceSpeed,
    loop: options.loop,
    splines: options.positionMethod === 'catmull-rom' && stops.length >= 2
      ? cameraSplines(stops, stopTimes, options.easing, isSeamlessLoop(keyframes, options))
      : null
  });
}

/**
 * Whether the path loops seamlessly: it loops, moves at a constant pace
 * (linear easing: nothing rests at the seam), and ends where it starts (the
 * return to start), so its last transition flows into its first with no
 * change of speed or direction at the seam.
 */
function isSeamlessLoop(keyframes, options) {
  return options.loop && options.easing === 'linear' && keyframes.length >= 3 &&
    sameCameraPose(keyframes[0], keyframes[keyframes.length - 1]);
}

/**
 * Every coordinate of both camera poses as a clamped time spline (module
 * overview): the orbit's target, radius (in log space), azimuth and
 * elevation, and the free-fly position, yaw and pitch. Built once per plan.
 */
function cameraSplines(keyframes, times, easing, periodic) {
  const ends = { restAtStart: easesIn(easing), restAtEnd: easesOut(easing), periodic };
  const channel = (read, kind = {}) => spline(keyframes, times, read, { ...ends, ...kind });
  return Object.freeze({
    target: Object.freeze([0, 1, 2].map(axis => channel(kf => kf.orbit.target[axis]))),
    radius: channel(kf => kf.orbit.radius, { log: true }),
    targetRadius: channel(kf => kf.orbit.targetRadius, { log: true }),
    theta: channel(kf => kf.orbit.theta, { angle: true }),
    phi: channel(kf => kf.orbit.phi),
    position: Object.freeze([0, 1, 2].map(axis => channel(kf => kf.freefly.position[axis]))),
    yaw: channel(kf => kf.freefly.yaw, { angle: true }),
    pitch: channel(kf => kf.freefly.pitch)
  });
}

// ---------------------------------------------------------------------------
// Main interpolation
// ---------------------------------------------------------------------------

/**
 * Interpolate a camera state across the full keyframe path.
 *
 * @param {import('./keyframe-store.js').Keyframe[]} keyframes
 * @param {number}  globalT   0 = start, 1 = end.
 * @param {Object}  options
 * @param {string}  options.positionMethod   'catmull-rom' | 'linear' | 'bezier'
 * @param {string}  options.rotationMethod   'slerp' | 'linear'
 * @param {string}  options.easing           'linear' | 'ease-in-out' | 'ease-in' | 'ease-out'
 * @returns {Object|null}  Camera state object for viewer.setCameraState(), or null.
 */
export function interpolateCameraState(keyframes, globalT, options) {
  assertKeyframes(keyframes);
  if (keyframes.length === 0) return null;
  if (!Number.isFinite(globalT) || globalT < 0 || globalT > 1) {
    throw new RangeError(
      `Camera path progress must be a finite number from 0 through 1; received ${String(globalT)}.`
    );
  }
  return interpolatePlannedCameraState(
    createCameraPathPlan(keyframes, options),
    globalT
  );
}

/**
 * Interpolate along an already-validated plan.
 *
 * Only the progress is checked here, because it is the one input a frame loop
 * changes. Everything else was proved when the plan was built.
 *
 * @param {Readonly<Object>} plan  A plan from createCameraPathPlan().
 * @param {number} globalT  0 = start, 1 = end.
 * @returns {Object|null}
 */
export function interpolatePlannedCameraState(plan, globalT) {
  const keyframes = plan.keyframes;
  const n = keyframes.length;
  if (n === 0) return null;
  if (!Number.isFinite(globalT) || globalT < 0 || globalT > 1) {
    throw new RangeError(
      `Camera path progress must be a finite number from 0 through 1; received ${String(globalT)}.`
    );
  }
  if (n === 1) return buildCameraState(keyframes[0]);
  if (globalT === 0) return buildCameraState(keyframes[0]);
  if (globalT === 1) return buildCameraState(keyframes[n - 1]);

  // Time is honored: each keyframe is reached at its own time, and rests
  // there for its hold.
  const times = plan.stopTimes;
  const absTime = globalT * plan.totalDuration;
  let segIndex = times.length - 2;
  for (let i = 0; i < times.length - 1; i++) {
    if (absTime <= times[i + 1]) {
      segIndex = i;
      break;
    }
  }
  const move = plan.stopMoves[segIndex];
  const a = plan.stops[segIndex];
  const b = plan.stops[segIndex + 1];

  // A hold, or two keyframes with the same camera: the camera rests there.
  if (move === null || sameCameraPose(a, b)) return buildCameraState(a);
  const localT = Math.max(0, Math.min(1, (absTime - times[segIndex]) / plan.durations[move]));

  // Cross-mode segments always use freefly (world-space) interpolation because
  // both representations are synced at capture time, giving every keyframe valid
  // eye-position + yaw/pitch data.  This avoids the discontinuity that would
  // happen from switching between orbit's spherical math and freefly's linear
  // math at a mode boundary.
  //
  // Same-mode segments use their native interpolation:
  //   orbit/planar → spherical (theta, phi, target, radius)
  //   freefly      → world-space (position, yaw, pitch)
  const segment = {
    plan,
    i: segIndex,
    s: localT,
    // Per-transition methods ease the path's first and last transitions.
    t: easeSegment(localT, move, plan.durations.length, plan.easing)
  };
  if (a.navigationMode !== b.navigationMode || a.navigationMode === 'free') {
    return interpolateFreefly(segment);
  }
  return interpolateOrbit(segment, a.navigationMode);
}

/** Whether two keyframes hold the same camera (a hold, when consecutive). */
function sameCameraPose(a, b) {
  return a.navigationMode === b.navigationMode &&
    a.orbit.radius === b.orbit.radius &&
    a.orbit.targetRadius === b.orbit.targetRadius &&
    a.orbit.theta === b.orbit.theta &&
    a.orbit.phi === b.orbit.phi &&
    a.orbit.target.every((value, axis) => value === b.orbit.target[axis]) &&
    a.freefly.yaw === b.freefly.yaw &&
    a.freefly.pitch === b.freefly.pitch &&
    a.freefly.position.every((value, axis) => value === b.freefly.position[axis]);
}

// ---------------------------------------------------------------------------
// Orbit / Planar interpolation
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Segment
 * @property {Readonly<Object>} plan
 * @property {number} i  The transition: from stop i to stop i + 1 of the plan's
 *   timeline (`plan.stops`: the keyframes, a keyframe that holds twice).
 * @property {number} s  Time through it, 0..1 (the time splines' parameter).
 * @property {number} t  Progress through it for per-transition methods, eased
 *   on the path's first and last transitions (`easeSegment`).
 */

/** @param {Segment} segment */
function interpolateOrbit(segment, mode) {
  const { plan, i, s, t } = segment;
  const kf = plan.stops;
  const a = kf[i];
  const b = kf[i + 1];
  const splines = plan.splines;

  // --- Position (target) and distance ---
  let target, radius, targetRadius;
  if (splines !== null) {
    target = splines.target.map(channel => splineAt(channel, plan.stopTimes, i, s, 'Camera path target'));
    radius = splineAt(splines.radius, plan.stopTimes, i, s, 'Camera path radius');
    targetRadius = splineAt(splines.targetRadius, plan.stopTimes, i, s, 'Camera path target radius');
  } else {
    target = plan.positionMethod === 'bezier'
      ? bezierVec3(kf, i, t, 'orbit')
      : [0, 1, 2].map(axis => lerp(a.orbit.target[axis], b.orbit.target[axis], t));
    radius = lerp(a.orbit.radius, b.orbit.radius, t);
    targetRadius = lerp(a.orbit.targetRadius, b.orbit.targetRadius, t);
  }

  // --- Rotation (theta, phi) ---
  let theta, phi;
  if (mode === 'planar') {
    // Planar mode: theta/phi are fixed
    theta = a.orbit.theta;
    phi = a.orbit.phi;
  } else if (plan.rotationMethod === 'slerp') {
    if (splines !== null) {
      // The time splines turn with the position splines.
      theta = splineAt(splines.theta, plan.stopTimes, i, s, 'Camera path azimuth');
      phi = splineAt(splines.phi, plan.stopTimes, i, s, 'Camera path elevation');
    } else {
      const res = slerpAngles(
        a.orbit.theta, a.orbit.phi,
        b.orbit.theta, b.orbit.phi,
        t, false
      );
      theta = res.a;
      phi = res.b;
    }
  } else {
    theta = lerpAngle(a.orbit.theta, b.orbit.theta, t);
    phi = lerp(a.orbit.phi, b.orbit.phi, t);
  }

  // Sync freefly from interpolated orbit params so both representations are consistent.
  // This ensures setCameraState applies correct values when modes are mixed.
  const sinP = Math.sin(phi);
  const cosP = Math.cos(phi);
  const eyeX = target[0] + radius * sinP * Math.cos(theta);
  const eyeY = target[1] + radius * cosP;
  const eyeZ = target[2] + radius * sinP * Math.sin(theta);
  const fwdX = target[0] - eyeX;
  const fwdY = target[1] - eyeY;
  const fwdZ = target[2] - eyeZ;
  const fLen = Math.sqrt(fwdX * fwdX + fwdY * fwdY + fwdZ * fwdZ);
  const syncYaw = Math.atan2(fwdZ / fLen, fwdX / fLen);
  const syncPitch = Math.asin(Math.max(-1, Math.min(1, fwdY / fLen)));

  return {
    navigationMode: mode,
    orbit: { radius, targetRadius, theta, phi, target },
    freefly: { position: [eyeX, eyeY, eyeZ], yaw: syncYaw, pitch: syncPitch }
  };
}

// ---------------------------------------------------------------------------
// Freefly interpolation
// ---------------------------------------------------------------------------

/** @param {Segment} segment */
function interpolateFreefly(segment) {
  const { plan, i, s, t } = segment;
  const kf = plan.stops;
  const a = kf[i];
  const b = kf[i + 1];
  const splines = plan.splines;

  // --- Position ---
  let position;
  if (splines !== null) {
    position = splines.position.map(channel => splineAt(channel, plan.stopTimes, i, s, 'Camera path position'));
  } else if (plan.positionMethod === 'bezier') {
    position = bezierVec3(kf, i, t, 'freefly');
  } else {
    position = [0, 1, 2].map(axis => lerp(a.freefly.position[axis], b.freefly.position[axis], t));
  }

  // --- Rotation (yaw, pitch) ---
  let yaw, pitch;
  if (plan.rotationMethod === 'slerp') {
    if (splines !== null) {
      yaw = splineAt(splines.yaw, plan.stopTimes, i, s, 'Camera path yaw');
      pitch = splineAt(splines.pitch, plan.stopTimes, i, s, 'Camera path pitch');
    } else {
      const res = slerpAngles(
        a.freefly.yaw, a.freefly.pitch,
        b.freefly.yaw, b.freefly.pitch,
        t, true
      );
      yaw = res.a;
      pitch = res.b;
    }
  } else {
    yaw = lerpAngle(a.freefly.yaw, b.freefly.yaw, t);
    pitch = lerp(a.freefly.pitch, b.freefly.pitch, t);
  }

  // Sync orbit from interpolated freefly params so the viewer's orbit variables
  // are reasonable if the next segment switches back to orbit rendering.
  // Place the synthetic target along the freefly look direction at a blended
  // radius so the transition to orbit (which always looks at target) is smooth.
  const syncRadius = lerp(a.orbit.radius, b.orbit.radius, t);
  const cosP = Math.cos(pitch);
  const syncTarget = [
    position[0] + syncRadius * cosP * Math.cos(yaw),
    position[1] + syncRadius * Math.sin(pitch),
    position[2] + syncRadius * cosP * Math.sin(yaw)
  ];

  // Derive orbit angles from position-relative-to-target (viewer convention)
  const offX = position[0] - syncTarget[0];
  const offY = position[1] - syncTarget[1];
  const offZ = position[2] - syncTarget[2];
  const offLen = Math.sqrt(offX * offX + offY * offY + offZ * offZ);
  const syncTheta = Math.atan2(offZ, offX);
  const syncPhi = Math.acos(Math.max(-1, Math.min(1, offY / offLen)));

  return {
    navigationMode: 'free',
    orbit: { radius: offLen, targetRadius: offLen, theta: syncTheta, phi: syncPhi, target: syncTarget },
    freefly: { position, yaw, pitch }
  };
}

// ---------------------------------------------------------------------------
// Bezier (cubic Bezier with auto-generated control points)
// ---------------------------------------------------------------------------

function bezierVec3(keyframes, segIndex, t, mode) {
  const n = keyframes.length;
  const i = segIndex;
  const j = Math.min(i + 1, n - 1);

  const getVec = mode === 'freefly' ? getFreeflyPos : getOrbitTarget;

  const prev = getVec(keyframes, i - 1);
  const curr = getVec(keyframes, i);
  const next = getVec(keyframes, j);
  const nextNext = getVec(keyframes, j + 1);

  // Auto control points (C1 continuous); a keyframe next to a hold (the same
  // place twice) is left and entered at rest.
  const same = (u, v) => u[0] === v[0] && u[1] === v[1] && u[2] === v[2];
  const c0 = same(prev, curr) ? curr : [
    curr[0] + (next[0] - prev[0]) / 6,
    curr[1] + (next[1] - prev[1]) / 6,
    curr[2] + (next[2] - prev[2]) / 6
  ];
  const c1 = same(next, nextNext) ? next : [
    next[0] - (nextNext[0] - curr[0]) / 6,
    next[1] - (nextNext[1] - curr[1]) / 6,
    next[2] - (nextNext[2] - curr[2]) / 6
  ];

  const u = 1 - t;
  return [
    u * u * u * curr[0] + 3 * u * u * t * c0[0] + 3 * u * t * t * c1[0] + t * t * t * next[0],
    u * u * u * curr[1] + 3 * u * u * t * c0[1] + 3 * u * t * t * c1[1] + t * t * t * next[1],
    u * u * u * curr[2] + 3 * u * u * t * c0[2] + 3 * u * t * t * c1[2] + t * t * t * next[2]
  ];
}

// ---------------------------------------------------------------------------
// Bezier boundary accessors (mirror extrapolation)
// ---------------------------------------------------------------------------

function getOrbitTarget(kf, idx) {
  const n = kf.length;
  if (idx < 0) {
    const a = kf[0].orbit.target;
    const b = kf[Math.min(1, n - 1)].orbit.target;
    return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
  }
  if (idx >= n) {
    const a = kf[n - 1].orbit.target;
    const b = kf[Math.max(0, n - 2)].orbit.target;
    return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
  }
  return kf[idx].orbit.target;
}

function getFreeflyPos(kf, idx) {
  const n = kf.length;
  if (idx < 0) {
    const a = kf[0].freefly.position;
    const b = kf[Math.min(1, n - 1)].freefly.position;
    return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
  }
  if (idx >= n) {
    const a = kf[n - 1].freefly.position;
    const b = kf[Math.max(0, n - 2)].freefly.position;
    return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
  }
  return kf[idx].freefly.position;
}

// ---------------------------------------------------------------------------
// Build a full camera-state object from a single keyframe
// ---------------------------------------------------------------------------

function buildCameraState(kf) {
  return {
    navigationMode: kf.navigationMode,
    orbit: {
      radius: kf.orbit.radius,
      targetRadius: kf.orbit.targetRadius,
      theta: kf.orbit.theta,
      phi: kf.orbit.phi,
      target: [kf.orbit.target[0], kf.orbit.target[1], kf.orbit.target[2]]
    },
    freefly: {
      position: [kf.freefly.position[0], kf.freefly.position[1], kf.freefly.position[2]],
      yaw: kf.freefly.yaw,
      pitch: kf.freefly.pitch
    }
  };
}
