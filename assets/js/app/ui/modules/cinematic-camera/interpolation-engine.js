/**
 * @fileoverview Pure-math interpolation engine for cinematic camera paths.
 *
 * Supports Catmull-Rom, Linear, and Bezier position interpolation plus SLERP
 * (spherical linear interpolation) for rotational angles.  All functions are
 * dependency-free — no gl-matrix, no DOM.
 *
 * @module ui/modules/cinematic-camera/interpolation-engine
 */

// ---------------------------------------------------------------------------
// Easing functions
// ---------------------------------------------------------------------------

function easeLinear(t) {
  return t;
}
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
function easeIn(t) {
  return t * t;
}
function easeOut(t) {
  return 1 - (1 - t) * (1 - t);
}

const EASING = {
  'linear': easeLinear,
  'ease-in-out': easeInOut,
  'ease-in': easeIn,
  'ease-out': easeOut
};

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

/** Catmull-Rom on a single scalar. */
function catmullRomScalar(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

/** Catmull-Rom for an angle — unwrap neighbours before spline evaluation. */
function catmullRomAngle(p0, p1, p2, p3, t) {
  // Unwrap all angles relative to p1 so the spline doesn't jump
  const unwrap = (base, val) => {
    let d = val - base;
    d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
    return base + d;
  };
  const u0 = unwrap(p1, p0);
  const u2 = unwrap(p1, p2);
  const u3 = unwrap(p1, p3);
  return catmullRomScalar(u0, p1, u2, u3, t);
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
    // Nearly identical — fall back to linear
    return isFreefly
      ? { a: lerpAngle(t1, t2, t), b: lerp(p1, p2, t) }
      : { a: lerpAngle(t1, t2, t), b: lerp(p1, p2, t) };
  }

  const sinOmega = Math.sin(omega);
  const s0 = Math.sin((1 - t) * omega) / sinOmega;
  const s1 = Math.sin(t * omega) / sinOmega;

  const cx = s0 * ax + s1 * bx;
  const cy = s0 * ay + s1 * by;
  const cz = s0 * az + s1 * bz;

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

/** Approximate distance between two keyframes in their respective spaces. */
function keyframeDistance(kfA, kfB) {
  const mode = kfA.navigationMode;
  if (mode === 'free') {
    const posA = kfA.freefly?.position || [0, 0, 0];
    const posB = kfB.freefly?.position || [0, 0, 0];
    return vec3Dist(posA, posB) + 0.5; // +0.5 baseline so identical positions still move
  }
  // orbit / planar
  const tA = kfA.orbit?.target || [0, 0, 0];
  const tB = kfB.orbit?.target || [0, 0, 0];
  const rA = kfA.orbit?.radius ?? 3;
  const rB = kfB.orbit?.radius ?? 3;
  return vec3Dist(tA, tB) + Math.abs(rA - rB) + 0.5;
}

const DEFAULT_AUTO_PACE_SPEED = 1.5; // scene units per second

// ---------------------------------------------------------------------------
// Segment timing resolver
// ---------------------------------------------------------------------------

/**
 * Compute the duration of each segment.
 * @param {import('./keyframe-store.js').Keyframe[]} keyframes
 * @param {number} [autoPaceSpeed]  Units/s for auto-paced segments (default 1.5).
 * @returns {number[]} Array of durations (seconds), length = keyframes.length - 1.
 */
export function resolveSegmentDurations(keyframes, autoPaceSpeed) {
  const speed = (autoPaceSpeed != null && autoPaceSpeed > 0) ? autoPaceSpeed : DEFAULT_AUTO_PACE_SPEED;
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
  const n = keyframes.length;
  if (n === 0) return null;
  if (n === 1) return buildCameraState(keyframes[0]);

  const durations = resolveSegmentDurations(keyframes, options.autoPaceSpeed);
  const totalDuration = durations.reduce((s, d) => s + d, 0);
  if (totalDuration <= 0) return buildCameraState(keyframes[0]);

  // Clamp
  const clamped = Math.max(0, Math.min(1, globalT));
  const absTime = clamped * totalDuration;

  // Find segment
  let cumulative = 0;
  let segIndex = 0;
  for (let i = 0; i < durations.length; i++) {
    if (cumulative + durations[i] >= absTime || i === durations.length - 1) {
      segIndex = i;
      break;
    }
    cumulative += durations[i];
  }

  let localT = durations[segIndex] > 0
    ? (absTime - cumulative) / durations[segIndex]
    : 0;
  localT = Math.max(0, Math.min(1, localT));

  // Apply easing
  const easingFn = EASING[options.easing] || easeInOut;
  localT = easingFn(localT);

  const mode = keyframes[0].navigationMode;
  const posMethod = options.positionMethod || 'catmull-rom';
  const rotMethod = options.rotationMethod || 'slerp';

  if (mode === 'free') {
    return interpolateFreefly(keyframes, segIndex, localT, posMethod, rotMethod);
  }
  return interpolateOrbit(keyframes, segIndex, localT, posMethod, rotMethod, mode);
}

// ---------------------------------------------------------------------------
// Orbit / Planar interpolation
// ---------------------------------------------------------------------------

function interpolateOrbit(keyframes, segIndex, t, posMethod, rotMethod, mode) {
  const kf = keyframes;
  const i = segIndex;
  const n = kf.length;
  const a = kf[i];
  const b = kf[Math.min(i + 1, n - 1)];

  // --- Position (target) ---
  let target;
  if (posMethod === 'catmull-rom' && n >= 2) {
    const p0 = getOrbitTarget(kf, i - 1);
    const p1 = getOrbitTarget(kf, i);
    const p2 = getOrbitTarget(kf, i + 1);
    const p3 = getOrbitTarget(kf, i + 2);
    target = [
      catmullRomScalar(p0[0], p1[0], p2[0], p3[0], t),
      catmullRomScalar(p0[1], p1[1], p2[1], p3[1], t),
      catmullRomScalar(p0[2], p1[2], p2[2], p3[2], t)
    ];
  } else if (posMethod === 'bezier' && n >= 2) {
    target = bezierVec3(kf, i, t, 'orbit');
  } else {
    const tA = a.orbit?.target || [0, 0, 0];
    const tB = b.orbit?.target || [0, 0, 0];
    target = [lerp(tA[0], tB[0], t), lerp(tA[1], tB[1], t), lerp(tA[2], tB[2], t)];
  }

  // --- Radius ---
  let radius, targetRadius;
  if (posMethod === 'catmull-rom' && n >= 2) {
    const r0 = getOrbitScalar(kf, i - 1, 'radius');
    const r1 = getOrbitScalar(kf, i, 'radius');
    const r2 = getOrbitScalar(kf, i + 1, 'radius');
    const r3 = getOrbitScalar(kf, i + 2, 'radius');
    radius = catmullRomScalar(r0, r1, r2, r3, t);

    const tr0 = getOrbitScalar(kf, i - 1, 'targetRadius');
    const tr1 = getOrbitScalar(kf, i, 'targetRadius');
    const tr2 = getOrbitScalar(kf, i + 1, 'targetRadius');
    const tr3 = getOrbitScalar(kf, i + 2, 'targetRadius');
    targetRadius = catmullRomScalar(tr0, tr1, tr2, tr3, t);
  } else {
    const rA = a.orbit?.radius ?? 3;
    const rB = b.orbit?.radius ?? 3;
    radius = lerp(rA, rB, t);
    const trA = a.orbit?.targetRadius ?? rA;
    const trB = b.orbit?.targetRadius ?? rB;
    targetRadius = lerp(trA, trB, t);
  }

  // --- Rotation (theta, phi) ---
  let theta, phi;
  if (mode === 'planar') {
    // Planar mode: theta/phi are fixed
    theta = a.orbit?.theta ?? 0;
    phi = a.orbit?.phi ?? 0;
  } else if (rotMethod === 'slerp') {
    if (posMethod === 'catmull-rom' && n >= 4) {
      // Use Catmull-Rom on angles for consistency with position spline
      theta = catmullRomAngle(
        getOrbitScalar(kf, i - 1, 'theta'),
        getOrbitScalar(kf, i, 'theta'),
        getOrbitScalar(kf, i + 1, 'theta'),
        getOrbitScalar(kf, i + 2, 'theta'),
        t
      );
      phi = catmullRomAngle(
        getOrbitScalar(kf, i - 1, 'phi'),
        getOrbitScalar(kf, i, 'phi'),
        getOrbitScalar(kf, i + 1, 'phi'),
        getOrbitScalar(kf, i + 2, 'phi'),
        t
      );
    } else {
      const res = slerpAngles(
        a.orbit?.theta ?? 0, a.orbit?.phi ?? 0,
        b.orbit?.theta ?? 0, b.orbit?.phi ?? 0,
        t, false
      );
      theta = res.a;
      phi = res.b;
    }
  } else {
    theta = lerpAngle(a.orbit?.theta ?? 0, b.orbit?.theta ?? 0, t);
    phi = lerp(a.orbit?.phi ?? 0, b.orbit?.phi ?? 0, t);
  }

  return {
    navigationMode: mode,
    orbit: { radius, targetRadius, theta, phi, target },
    freefly: a.freefly
      ? {
          position: [
            a.freefly.position[0],
            a.freefly.position[1],
            a.freefly.position[2]
          ],
          yaw: a.freefly.yaw,
          pitch: a.freefly.pitch
        }
      : { position: [0, 0, 3], yaw: 0, pitch: 0 }
  };
}

// ---------------------------------------------------------------------------
// Freefly interpolation
// ---------------------------------------------------------------------------

function interpolateFreefly(keyframes, segIndex, t, posMethod, rotMethod) {
  const kf = keyframes;
  const i = segIndex;
  const n = kf.length;
  const a = kf[i];
  const b = kf[Math.min(i + 1, n - 1)];

  // --- Position ---
  let position;
  if (posMethod === 'catmull-rom' && n >= 2) {
    const p0 = getFreeflyPos(kf, i - 1);
    const p1 = getFreeflyPos(kf, i);
    const p2 = getFreeflyPos(kf, i + 1);
    const p3 = getFreeflyPos(kf, i + 2);
    position = [
      catmullRomScalar(p0[0], p1[0], p2[0], p3[0], t),
      catmullRomScalar(p0[1], p1[1], p2[1], p3[1], t),
      catmullRomScalar(p0[2], p1[2], p2[2], p3[2], t)
    ];
  } else if (posMethod === 'bezier' && n >= 2) {
    position = bezierVec3(kf, i, t, 'freefly');
  } else {
    const pA = a.freefly?.position || [0, 0, 0];
    const pB = b.freefly?.position || [0, 0, 0];
    position = [lerp(pA[0], pB[0], t), lerp(pA[1], pB[1], t), lerp(pA[2], pB[2], t)];
  }

  // --- Rotation (yaw, pitch) ---
  let yaw, pitch;
  if (rotMethod === 'slerp') {
    if (posMethod === 'catmull-rom' && n >= 4) {
      yaw = catmullRomAngle(
        getFreeflyScalar(kf, i - 1, 'yaw'),
        getFreeflyScalar(kf, i, 'yaw'),
        getFreeflyScalar(kf, i + 1, 'yaw'),
        getFreeflyScalar(kf, i + 2, 'yaw'),
        t
      );
      pitch = catmullRomAngle(
        getFreeflyScalar(kf, i - 1, 'pitch'),
        getFreeflyScalar(kf, i, 'pitch'),
        getFreeflyScalar(kf, i + 1, 'pitch'),
        getFreeflyScalar(kf, i + 2, 'pitch'),
        t
      );
    } else {
      const res = slerpAngles(
        a.freefly?.yaw ?? 0, a.freefly?.pitch ?? 0,
        b.freefly?.yaw ?? 0, b.freefly?.pitch ?? 0,
        t, true
      );
      yaw = res.a;
      pitch = res.b;
    }
  } else {
    yaw = lerpAngle(a.freefly?.yaw ?? 0, b.freefly?.yaw ?? 0, t);
    pitch = lerp(a.freefly?.pitch ?? 0, b.freefly?.pitch ?? 0, t);
  }

  return {
    navigationMode: 'free',
    orbit: a.orbit
      ? {
          radius: a.orbit.radius,
          targetRadius: a.orbit.targetRadius,
          theta: a.orbit.theta,
          phi: a.orbit.phi,
          target: [a.orbit.target[0], a.orbit.target[1], a.orbit.target[2]]
        }
      : { radius: 3, targetRadius: 3, theta: 0, phi: Math.PI / 4, target: [0, 0, 0] },
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

  // Auto control points (C1 continuous)
  const c0 = [
    curr[0] + (next[0] - prev[0]) / 6,
    curr[1] + (next[1] - prev[1]) / 6,
    curr[2] + (next[2] - prev[2]) / 6
  ];
  const c1 = [
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
// Safe keyframe accessors (clamp with mirror at boundaries)
// ---------------------------------------------------------------------------

function getOrbitTarget(kf, idx) {
  const n = kf.length;
  if (idx < 0) {
    const a = kf[0].orbit?.target || [0, 0, 0];
    const b = kf[Math.min(1, n - 1)].orbit?.target || [0, 0, 0];
    return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
  }
  if (idx >= n) {
    const a = kf[n - 1].orbit?.target || [0, 0, 0];
    const b = kf[Math.max(0, n - 2)].orbit?.target || [0, 0, 0];
    return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
  }
  return kf[idx].orbit?.target || [0, 0, 0];
}

function getOrbitScalar(kf, idx, prop) {
  const n = kf.length;
  const defaults = { radius: 3, targetRadius: 3, theta: 0, phi: Math.PI / 4 };
  if (idx < 0) {
    const a = kf[0].orbit?.[prop] ?? defaults[prop];
    const b = kf[Math.min(1, n - 1)].orbit?.[prop] ?? defaults[prop];
    return 2 * a - b;
  }
  if (idx >= n) {
    const a = kf[n - 1].orbit?.[prop] ?? defaults[prop];
    const b = kf[Math.max(0, n - 2)].orbit?.[prop] ?? defaults[prop];
    return 2 * a - b;
  }
  return kf[idx].orbit?.[prop] ?? defaults[prop];
}

function getFreeflyPos(kf, idx) {
  const n = kf.length;
  if (idx < 0) {
    const a = kf[0].freefly?.position || [0, 0, 0];
    const b = kf[Math.min(1, n - 1)].freefly?.position || [0, 0, 0];
    return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
  }
  if (idx >= n) {
    const a = kf[n - 1].freefly?.position || [0, 0, 0];
    const b = kf[Math.max(0, n - 2)].freefly?.position || [0, 0, 0];
    return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
  }
  return kf[idx].freefly?.position || [0, 0, 0];
}

function getFreeflyScalar(kf, idx, prop) {
  const n = kf.length;
  if (idx < 0) {
    const a = kf[0].freefly?.[prop] ?? 0;
    const b = kf[Math.min(1, n - 1)].freefly?.[prop] ?? 0;
    return 2 * a - b;
  }
  if (idx >= n) {
    const a = kf[n - 1].freefly?.[prop] ?? 0;
    const b = kf[Math.max(0, n - 2)].freefly?.[prop] ?? 0;
    return 2 * a - b;
  }
  return kf[idx].freefly?.[prop] ?? 0;
}

// ---------------------------------------------------------------------------
// Build a full camera-state object from a single keyframe
// ---------------------------------------------------------------------------

function buildCameraState(kf) {
  return {
    navigationMode: kf.navigationMode,
    orbit: kf.orbit
      ? {
          radius: kf.orbit.radius,
          targetRadius: kf.orbit.targetRadius,
          theta: kf.orbit.theta,
          phi: kf.orbit.phi,
          target: [kf.orbit.target[0], kf.orbit.target[1], kf.orbit.target[2]]
        }
      : { radius: 3, targetRadius: 3, theta: 0, phi: Math.PI / 4, target: [0, 0, 0] },
    freefly: kf.freefly
      ? {
          position: [kf.freefly.position[0], kf.freefly.position[1], kf.freefly.position[2]],
          yaw: kf.freefly.yaw,
          pitch: kf.freefly.pitch
        }
      : { position: [0, 0, 3], yaw: 0, pitch: 0 }
  };
}
