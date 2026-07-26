/**
 * @fileoverview Exact current camera-state contract shared by rendering,
 * session serialization, camera paths, snapshots, and figure export.
 */

const NAVIGATION_MODES = new Set(['orbit', 'planar', 'free']);

function hasExactKeys(value, keys) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = keys.slice().sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isFiniteVec3(value) {
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every(Number.isFinite);
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
  if (!hasExactKeys(value, ['navigationMode', 'orbit', 'freefly'])) {
    return false;
  }
  if (!NAVIGATION_MODES.has(value.navigationMode)) return false;

  const orbit = value.orbit;
  const freefly = value.freefly;
  return Boolean(
    hasExactKeys(
      orbit,
      ['radius', 'targetRadius', 'theta', 'phi', 'target']
    ) &&
    Number.isFinite(orbit.radius) &&
    orbit.radius > 0 &&
    Number.isFinite(orbit.targetRadius) &&
    orbit.targetRadius > 0 &&
    Number.isFinite(orbit.theta) &&
    Number.isFinite(orbit.phi) &&
    isFiniteVec3(orbit.target) &&
    hasExactKeys(freefly, ['position', 'yaw', 'pitch']) &&
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
