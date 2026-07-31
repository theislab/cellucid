/**
 * @fileoverview Deterministic scripted camera paths for the render benchmark.
 *
 * A benchmark that never moves the camera cannot observe the renderer's
 * motion-dependent work. `HighPerfRenderer._prepareFrustumCache()` short
 * circuits whenever none of the sixteen MVP floats changed, so with a fixed
 * camera the frustum classification, the visible-index gather, the per-view
 * element-buffer publication and the orbit-anchor rebuild all provably do not
 * run. Every one of those is the work this harness exists to price.
 *
 * Two regimes are therefore mandatory for every configuration:
 *
 * - `static` — the camera holds the path's first pose for the whole window.
 * - `orbit`  — the camera follows the scripted path.
 *
 * Both regimes publish the camera through the same call at the same cadence,
 * so the STATIC/ORBIT difference isolates the renderer's motion-dependent CPU
 * work rather than the cost of publishing a camera state.
 *
 * The path is a closed-form function of the integer frame index, never of wall
 * clock, so two runs at different frame rates visit exactly the same poses.
 * All randomness is derived from an integer seed once, at construction.
 *
 * The radius sweep is geometric because LOD selection is logarithmic:
 * `SpatialIndex.getLODLevel()` maps `distance / dataDiagonal` through
 * `1 - log(ratio / 0.3) / log(10)` onto the level range, clamped to a ratio of
 * 0.3 at the near end and 3.0 at the far end. Sweeping the radius over that
 * full decade is what makes the path cross LOD transitions; a linear sweep
 * would spend most of its frames in the coarse half.
 *
 * @module app/ui/modules/benchmark/camera-path
 */

/** Ratio of camera distance to data diagonal at which LOD saturates near. */
export const LOD_NEAR_DISTANCE_RATIO = 0.3;

/** Ratio of camera distance to data diagonal at which LOD saturates far. */
export const LOD_FAR_DISTANCE_RATIO = 3.0;

const TWO_PI = Math.PI * 2;
const PHI_LIMIT = 0.08;

function requireFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be one finite number.`);
  }
  return value;
}

function requirePositiveNumber(value, label) {
  requireFiniteNumber(value, label);
  if (value <= 0) {
    throw new RangeError(`${label} must be greater than zero.`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be one positive safe integer.`);
  }
  return value;
}

function requireVec3(value, label) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every(Number.isFinite)
  ) {
    throw new TypeError(`${label} must be three finite numbers.`);
  }
  return value;
}

/**
 * SplitMix32. One integer seed in, a repeatable stream of unit floats out.
 * Used only at construction to place the path's phase offsets, so the sampled
 * path stays a pure function of the frame index.
 *
 * @param {number} seed - Exact 32-bit seed.
 * @returns {() => number} Generator producing values in [0, 1).
 */
export function createSeededUnitStream(seed) {
  if (!Number.isSafeInteger(seed)) {
    throw new TypeError('Camera path seed must be one safe integer.');
  }
  let state = seed >>> 0;
  return function nextUnit() {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 4294967296;
  };
}

/**
 * Allocate one reusable camera-state object matching the viewer contract.
 * The benchmark mutates this object in place every frame so the measurement
 * window allocates nothing of its own.
 *
 * @returns {{
 *   navigationMode: string,
 *   orbit: {
 *     radius: number, targetRadius: number, theta: number, phi: number,
 *     target: number[]
 *   },
 *   freefly: { position: number[], yaw: number, pitch: number }
 * }} Mutable camera state.
 */
export function createMutableCameraState() {
  return {
    navigationMode: 'orbit',
    orbit: {
      radius: 3,
      targetRadius: 3,
      theta: 0,
      phi: Math.PI / 4,
      target: [0, 0, 0]
    },
    freefly: {
      position: [0, 0, 3],
      yaw: 0,
      pitch: 0
    }
  };
}

/**
 * A deterministic orbit path over radius, azimuth, elevation and target pan.
 *
 * Radius and target pan are expressed as multiples of `baseRadius`, which the
 * caller reads from the fitted camera, so the same path description works for
 * any dataset scale.
 */
export class BenchmarkCameraPath {
  /**
   * @param {Object} options - Exact path description.
   * @param {number} options.baseRadius - Fitted camera radius, > 0.
   * @param {number[]} [options.center] - Orbit centre, three finite numbers.
   * @param {number} [options.seed] - Integer seed for the phase offsets.
   * @param {number} [options.periodFrames] - Frames in one full path cycle.
   * @param {number} [options.nearFactor] - Closest radius / baseRadius.
   * @param {number} [options.farFactor] - Furthest radius / baseRadius.
   * @param {number} [options.azimuthTurns] - Full turns per cycle.
   * @param {number} [options.elevationCycles] - Elevation oscillations/cycle.
   * @param {number} [options.radiusCycles] - Radius oscillations per cycle.
   * @param {number} [options.panCycles] - Target-pan oscillations per cycle.
   * @param {number} [options.panFactor] - Pan amplitude / baseRadius.
   */
  constructor(options = {}) {
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options)
    ) {
      throw new TypeError('Camera path options must be one plain object.');
    }
    this.baseRadius = requirePositiveNumber(
      options.baseRadius,
      'Camera path baseRadius'
    );
    const center = options.center ?? [0, 0, 0];
    requireVec3(center, 'Camera path center');
    this.centerX = center[0];
    this.centerY = center[1];
    this.centerZ = center[2];

    this.seed = Number.isSafeInteger(options.seed) ? options.seed : 0x5ce11c1d;
    this.periodFrames = requirePositiveInteger(
      options.periodFrames ?? 600,
      'Camera path periodFrames'
    );
    // The defaults bracket the renderer's LOD domain with margin: with the
    // fitted radius equal to the data diagonal the swept ratio runs 0.25 to
    // 4.0, against a mapping that saturates at 0.3 and 3.0. The margin covers
    // fitted radii from 0.8x to 1.2x the diagonal, because the fitted radius
    // is not exactly the diagonal on real data.
    this.nearFactor = requirePositiveNumber(
      options.nearFactor ?? 0.25,
      'Camera path nearFactor'
    );
    this.farFactor = requirePositiveNumber(
      options.farFactor ?? 4,
      'Camera path farFactor'
    );
    if (this.farFactor <= this.nearFactor) {
      throw new RangeError(
        'Camera path farFactor must exceed nearFactor.'
      );
    }
    this.azimuthTurns = requireFiniteNumber(
      options.azimuthTurns ?? 1,
      'Camera path azimuthTurns'
    );
    this.elevationCycles = requireFiniteNumber(
      options.elevationCycles ?? 2,
      'Camera path elevationCycles'
    );
    this.radiusCycles = requireFiniteNumber(
      options.radiusCycles ?? 1,
      'Camera path radiusCycles'
    );
    this.panCycles = requireFiniteNumber(
      options.panCycles ?? 3,
      'Camera path panCycles'
    );
    this.panFactor = requireFiniteNumber(
      options.panFactor ?? 0.45,
      'Camera path panFactor'
    );
    if (this.panFactor < 0) {
      throw new RangeError('Camera path panFactor must not be negative.');
    }

    // Geometric mid-point and log half-amplitude, so the radius spends equal
    // parameter time in each octave and the LOD mapping is swept uniformly.
    this.radiusLogMid = 0.5 * Math.log(this.nearFactor * this.farFactor);
    this.radiusLogAmplitude =
      0.5 * Math.log(this.farFactor / this.nearFactor);

    const nextUnit = createSeededUnitStream(this.seed);
    this.azimuthPhase = nextUnit() * TWO_PI;
    this.elevationPhase = nextUnit() * TWO_PI;
    this.radiusPhase = nextUnit() * TWO_PI;
    this.panPhaseX = nextUnit() * TWO_PI;
    this.panPhaseY = nextUnit() * TWO_PI;
    this.panPhaseZ = nextUnit() * TWO_PI;
    this.elevationCenter = Math.PI * 0.5;
    this.elevationAmplitude = Math.PI * 0.32;
    Object.freeze(this);
  }

  /**
   * The near and far camera distances this path visits, in world units.
   * A caller can compare them against the data diagonal to prove in advance
   * that the swept distance ratio covers the LOD mapping's whole domain.
   *
   * @returns {{ nearDistance: number, farDistance: number }} Sweep bounds.
   */
  getDistanceBounds() {
    return {
      nearDistance: this.baseRadius * this.nearFactor,
      farDistance: this.baseRadius * this.farFactor
    };
  }

  /**
   * Does this path's distance sweep span the whole LOD selection domain for a
   * dataset of the given diagonal? Reported, never assumed.
   *
   * @param {number} dataDiagonal - Data bounding-box diagonal, > 0.
   * @returns {{
   *   nearRatio: number, farRatio: number, spansLodDomain: boolean
   * }} Ratio coverage against the renderer's LOD mapping.
   */
  describeLodCoverage(dataDiagonal) {
    requirePositiveNumber(dataDiagonal, 'Camera path dataDiagonal');
    const bounds = this.getDistanceBounds();
    const nearRatio = bounds.nearDistance / dataDiagonal;
    const farRatio = bounds.farDistance / dataDiagonal;
    return {
      nearRatio,
      farRatio,
      spansLodDomain:
        nearRatio <= LOD_NEAR_DISTANCE_RATIO &&
        farRatio >= LOD_FAR_DISTANCE_RATIO
    };
  }

  /**
   * Write the pose for one frame index into a caller-owned camera state.
   * Allocation-free: every write lands in an existing slot.
   *
   * @param {Object} state - Object from `createMutableCameraState()`.
   * @param {number} frameIndex - Integer frame index, >= 0.
   * @returns {Object} The same state object.
   */
  sampleInto(state, frameIndex) {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
      throw new TypeError(
        'Camera path frame index must be one non-negative safe integer.'
      );
    }
    const u = frameIndex / this.periodFrames;

    const theta = this.azimuthPhase + TWO_PI * this.azimuthTurns * u;
    const rawPhi =
      this.elevationCenter +
      this.elevationAmplitude *
        Math.sin(TWO_PI * this.elevationCycles * u + this.elevationPhase);
    const phi = Math.min(
      Math.PI - PHI_LIMIT,
      Math.max(PHI_LIMIT, rawPhi)
    );
    const radius =
      this.baseRadius *
      Math.exp(
        this.radiusLogMid +
          this.radiusLogAmplitude *
            Math.sin(TWO_PI * this.radiusCycles * u + this.radiusPhase)
      );

    const panScale = this.baseRadius * this.panFactor;
    const targetX =
      this.centerX +
      panScale * Math.sin(TWO_PI * this.panCycles * u + this.panPhaseX);
    const targetY =
      this.centerY +
      panScale *
        0.6 *
        Math.sin(TWO_PI * this.panCycles * 1.37 * u + this.panPhaseY);
    const targetZ =
      this.centerZ +
      panScale * Math.cos(TWO_PI * this.panCycles * 0.83 * u + this.panPhaseZ);

    const orbit = state.orbit;
    orbit.radius = radius;
    orbit.targetRadius = radius;
    orbit.theta = theta;
    orbit.phi = phi;
    orbit.target[0] = targetX;
    orbit.target[1] = targetY;
    orbit.target[2] = targetZ;

    // Keep the freefly representation exactly consistent with the orbit one.
    // The viewer's camera-state contract requires both halves to be finite,
    // and a consistent pair means a regime switch never teleports the camera.
    const sinPhi = Math.sin(phi);
    const offsetX = radius * sinPhi * Math.cos(theta);
    const offsetY = radius * Math.cos(phi);
    const offsetZ = radius * sinPhi * Math.sin(theta);
    const freefly = state.freefly;
    freefly.position[0] = targetX + offsetX;
    freefly.position[1] = targetY + offsetY;
    freefly.position[2] = targetZ + offsetZ;
    const inverseRadius = 1 / radius;
    const forwardX = -offsetX * inverseRadius;
    const forwardY = -offsetY * inverseRadius;
    const forwardZ = -offsetZ * inverseRadius;
    freefly.yaw = Math.atan2(forwardZ, forwardX);
    freefly.pitch = Math.asin(Math.min(1, Math.max(-1, forwardY)));
    state.navigationMode = 'orbit';
    return state;
  }
}

/** The camera regimes every benchmark configuration must be run under. */
export const CAMERA_REGIMES = Object.freeze(['static', 'orbit']);

/**
 * Resolve the frame index a regime samples the path at.
 *
 * `static` pins the path's first pose; `orbit` advances one path frame per
 * rendered frame. Both regimes publish a camera every frame, so the cost of
 * publishing cancels in the STATIC/ORBIT difference.
 *
 * @param {string} regime - Exactly `'static'` or `'orbit'`.
 * @param {number} frameIndex - Integer frame index, >= 0.
 * @returns {number} Path frame index to sample.
 */
export function pathFrameForRegime(regime, frameIndex) {
  if (!CAMERA_REGIMES.includes(regime)) {
    throw new RangeError(
      `Camera regime must be exactly ${CAMERA_REGIMES.map(
        value => `"${value}"`
      ).join(' or ')}; received ${String(regime)}.`
    );
  }
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
    throw new TypeError(
      'Camera regime frame index must be one non-negative safe integer.'
    );
  }
  return regime === 'static' ? 0 : frameIndex;
}
