/**
 * @fileoverview Exact current camera-state contract shared by rendering,
 * session serialization, camera paths, snapshots, and figure export.
 */

const NAVIGATION_MODES = new Set(['orbit', 'planar', 'free']);
const CAMERA_STATE_KEYS = Object.freeze(['navigationMode', 'orbit', 'freefly']);
const ORBIT_STATE_KEYS = Object.freeze([
  'radius', 'targetRadius', 'theta', 'phi', 'target'
]);
const FREEFLY_STATE_KEYS = Object.freeze(['position', 'yaw', 'pitch']);

/**
 * Whether `value` is a plain object whose own enumerable keys are exactly
 * `keys`. Cinematic playback validates a camera state every frame, so this
 * counts and probes keys instead of building and sorting key arrays.
 */
function hasExactKeys(value, keys) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  let ownKeyCount = 0;
  // for-in visits enumerable string keys; the own ones are exactly the set
  // Object.keys() returns.
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    ownKeyCount++;
  }
  if (ownKeyCount !== keys.length) return false;
  for (let index = 0; index < keys.length; index++) {
    if (!Object.prototype.propertyIsEnumerable.call(value, keys[index])) {
      return false;
    }
  }
  return true;
}

function isFiniteVec3(value) {
  return Array.isArray(value) &&
    value.length === 3 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Number.isFinite(value[2]);
}

/**
 * @param {unknown} mode
 * @returns {'orbit'|'planar'|'free'}
 */
export function assertNavigationMode(mode) {
  if (!NAVIGATION_MODES.has(mode)) {
    throw new RangeError(
      `Navigation mode must be exactly "orbit", "planar", or "free"; received ${String(mode)}.`
    );
  }
  return mode;
}

/**
 * Both camera representations are mandatory and synchronized in the current
 * contract. Consumers therefore never invent coordinates or a navigation
 * mode when a state is incomplete.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isExactCameraState(value) {
  if (!hasExactKeys(value, CAMERA_STATE_KEYS)) {
    return false;
  }
  if (!NAVIGATION_MODES.has(value.navigationMode)) return false;

  const orbit = value.orbit;
  const freefly = value.freefly;
  return Boolean(
    hasExactKeys(orbit, ORBIT_STATE_KEYS) &&
    Number.isFinite(orbit.radius) &&
    orbit.radius > 0 &&
    Number.isFinite(orbit.targetRadius) &&
    orbit.targetRadius > 0 &&
    Number.isFinite(orbit.theta) &&
    Number.isFinite(orbit.phi) &&
    isFiniteVec3(orbit.target) &&
    hasExactKeys(freefly, FREEFLY_STATE_KEYS) &&
    isFiniteVec3(freefly.position) &&
    Number.isFinite(freefly.yaw) &&
    Number.isFinite(freefly.pitch)
  );
}

/**
 * @template T
 * @param {T} value
 * @param {string} [boundary]
 * @returns {T}
 */
export function assertCameraState(value, boundary = 'Camera state') {
  if (!isExactCameraState(value)) {
    throw new TypeError(
      `${boundary} must contain an exact navigationMode plus complete orbit and freefly state.`
    );
  }
  return value;
}

export function cloneCameraState(value, boundary = 'Camera state') {
  const exact = assertCameraState(value, boundary);
  return {
    navigationMode: exact.navigationMode,
    orbit: {
      radius: exact.orbit.radius,
      targetRadius: exact.orbit.targetRadius,
      theta: exact.orbit.theta,
      phi: exact.orbit.phi,
      target: [...exact.orbit.target]
    },
    freefly: {
      position: [...exact.freefly.position],
      yaw: exact.freefly.yaw,
      pitch: exact.freefly.pitch
    }
  };
}

function sameVec3(left, right) {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

/**
 * Whether two camera states hold the same pose.
 *
 * A camera state carries both representations, but only one of them is
 * authoritative: the one its navigation mode drives. The viewer reports the
 * other one by deriving it from the authoritative one through `Math.sin`,
 * `Math.atan2`, and `Math.asin`, whose results ECMAScript leaves
 * implementation-approximated. A session saved in one engine therefore carries
 * derived values that another engine reproduces only to the last few bits:
 * a pitch of `-0.16539816339745403` from WebKit is `-0.16539816339745406` in
 * Chromium and Firefox. Comparing the derived half would refuse every such
 * session, so this compares exactly what the mode drives and nothing else:
 *
 * - `orbit` and `planar` — the whole orbit record; free-fly is derived.
 * - `free` — the whole free-fly record and the orbit target, which free-fly
 *   navigation keeps; the orbit radius and angles are derived.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function cameraStatesHaveSamePose(left, right) {
  const exactLeft = assertCameraState(left, 'Compared camera state');
  const exactRight = assertCameraState(right, 'Compared camera state');
  if (exactLeft.navigationMode !== exactRight.navigationMode) return false;
  if (!sameVec3(exactLeft.orbit.target, exactRight.orbit.target)) {
    return false;
  }
  if (exactLeft.navigationMode === 'free') {
    return (
      sameVec3(exactLeft.freefly.position, exactRight.freefly.position)
      && exactLeft.freefly.yaw === exactRight.freefly.yaw
      && exactLeft.freefly.pitch === exactRight.freefly.pitch
    );
  }
  return (
    exactLeft.orbit.radius === exactRight.orbit.radius
    && exactLeft.orbit.targetRadius === exactRight.orbit.targetRadius
    && exactLeft.orbit.theta === exactRight.orbit.theta
    && exactLeft.orbit.phi === exactRight.orbit.phi
  );
}

const DEFAULT_ORBIT_RADIUS = 3.0;
const DEFAULT_ORBIT_THETA = Math.PI / 4;
const DEFAULT_ORBIT_PHI = Math.PI / 4;

/**
 * The one reset pose, shared by orbit and free-fly.
 *
 * The free-fly pose is derived from the orbit pose — the eye the orbit camera
 * would occupy, looking at the orbit target — using the viewer's own orbit-eye
 * and free-fly-forward conventions:
 *   eye     = target + r·(sinφ·cosθ, cosφ, sinφ·sinθ)
 *   forward = (cos pitch·cos yaw, sin pitch, cos pitch·sin yaw)
 * so resetting in free-fly frames the data exactly as resetting in orbit does,
 * and switching modes after a reset round-trips to the same orbit angles.
 *
 * @returns {{
 *   orbit: { radius: number, theta: number, phi: number, target: number[] },
 *   freefly: { position: number[], yaw: number, pitch: number }
 * }}
 */
export function createDefaultCameraPose() {
  const radius = DEFAULT_ORBIT_RADIUS;
  const theta = DEFAULT_ORBIT_THETA;
  const phi = DEFAULT_ORBIT_PHI;
  const target = [0, 0, 0];
  const offset = [
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  ];
  const position = [
    target[0] + offset[0],
    target[1] + offset[1],
    target[2] + offset[2],
  ];
  const forward = [
    -offset[0] / radius,
    -offset[1] / radius,
    -offset[2] / radius,
  ];
  return {
    orbit: { radius, theta, phi, target },
    freefly: {
      position,
      yaw: Math.atan2(forward[2], forward[0]),
      pitch: Math.asin(forward[1]),
    },
  };
}
