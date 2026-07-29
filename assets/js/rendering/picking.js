// GLSL float literals and the CPU transparency owner are both float32. Using
// the same representable threshold keeps an authored 0.01 value interactive
// exactly when the point shader keeps it visible.
const PICK_VISIBILITY_THRESHOLD = Math.fround(0.01);
const PICK_SEARCH_RADIUS = 0.03;
const PICK_MIN_SAMPLE_STEP = 0.02;
const PICK_MAX_SAMPLE_COUNT = 500;

function requireFiniteVector3(value, label) {
  if (
    (!Array.isArray(value) && !ArrayBuffer.isView(value)) ||
    value.length !== 3
  ) {
    throw new TypeError(`${label} must contain exactly three numeric values.`);
  }
  for (let axis = 0; axis < 3; axis++) {
    if (!Number.isFinite(value[axis])) {
      throw new TypeError(`${label}[${axis}] must be finite.`);
    }
  }
  return value;
}

function requireRaySamplePickInput(input) {
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new TypeError('Ray-sample picking input must be one plain object.');
  }
  const {
    maxDistance,
    positions,
    ray,
    spatialIndex = null,
    transparency,
  } = input;
  if (
    !(positions instanceof Float32Array) ||
    positions.length % 3 !== 0
  ) {
    throw new TypeError(
      'Ray-sample picking positions must contain complete Float32 XYZ triples.'
    );
  }
  const pointCount = positions.length / 3;
  if (
    !(transparency instanceof Float32Array) ||
    transparency.length !== pointCount
  ) {
    throw new TypeError(
      'Ray-sample picking transparency must be a Float32Array matching the point count.'
    );
  }
  if (
    ray === null ||
    typeof ray !== 'object' ||
    Array.isArray(ray)
  ) {
    throw new TypeError('Ray-sample picking ray must be an object.');
  }
  requireFiniteVector3(ray.origin, 'Ray-sample picking origin');
  requireFiniteVector3(ray.direction, 'Ray-sample picking direction');
  if (!Number.isFinite(maxDistance) || maxDistance <= 0) {
    throw new RangeError(
      'Ray-sample picking maxDistance must be a positive finite number.'
    );
  }
  if (spatialIndex !== null) {
    if (
      typeof spatialIndex !== 'object' ||
      spatialIndex.pointCount !== pointCount ||
      spatialIndex.positions !== positions ||
      typeof spatialIndex.visitRaySegmentCandidates !== 'function'
    ) {
      throw new TypeError(
        'Ray-sample picking spatialIndex must be null or an exact matching spatial owner.'
      );
    }
  }
  return {
    maxDistance,
    pointCount,
    positions,
    ray,
    spatialIndex,
    transparency,
  };
}

/**
 * Find the visible point selected by the historical ray-sampling contract
 * without revisiting the complete point cloud for every sample.
 *
 * Points are ranked by:
 * 1. the earliest discrete ray sample whose search sphere contains the point;
 * 2. perpendicular distance to the ray;
 * 3. stable original cell index.
 *
 * @param {Object} input
 * @param {Float32Array} input.positions
 * @param {Float32Array} input.transparency
 * @param {{origin: ArrayLike<number>, direction: ArrayLike<number>}} input.ray
 * @param {number} input.maxDistance
 * @param {import('./high-perf-renderer.js').SpatialIndex|null} [input.spatialIndex]
 * @returns {{
 *   cellIndex: number,
 *   examinedPointCount: number,
 *   firstSampleIndex: number,
 *   perpendicularDistanceSquared: number
 * }}
 */
export function findRaySamplePick(input) {
  const {
    maxDistance,
    pointCount,
    positions,
    ray,
    spatialIndex,
    transparency,
  } = requireRaySamplePickInput(input);

  const directionLength = Math.hypot(
    ray.direction[0],
    ray.direction[1],
    ray.direction[2]
  );
  if (!Number.isFinite(directionLength) || directionLength <= 0) {
    throw new RangeError(
      'Ray-sample picking direction must have a positive finite length.'
    );
  }
  const inverseDirectionLength = 1 / directionLength;
  const directionX = ray.direction[0] * inverseDirectionLength;
  const directionY = ray.direction[1] * inverseDirectionLength;
  const directionZ = ray.direction[2] * inverseDirectionLength;
  const originX = ray.origin[0];
  const originY = ray.origin[1];
  const originZ = ray.origin[2];

  const sampleStep = Math.max(
    PICK_MIN_SAMPLE_STEP,
    maxDistance / PICK_MAX_SAMPLE_COUNT
  );
  const sampleCount = Math.ceil(maxDistance / sampleStep);
  const lastSampleDistance = (sampleCount - 1) * sampleStep;
  const searchRadiusSquared = PICK_SEARCH_RADIUS * PICK_SEARCH_RADIUS;

  let bestCellIndex = -1;
  let bestSampleIndex = sampleCount;
  let bestPerpendicularDistanceSquared = Infinity;
  let examinedPointCount = 0;

  const evaluatePoint = cellIndex => {
    examinedPointCount++;
    if (!(transparency[cellIndex] >= PICK_VISIBILITY_THRESHOLD)) return;

    const positionOffset = cellIndex * 3;
    const offsetX = positions[positionOffset] - originX;
    const offsetY = positions[positionOffset + 1] - originY;
    const offsetZ = positions[positionOffset + 2] - originZ;
    const projectedDistance =
      offsetX * directionX +
      offsetY * directionY +
      offsetZ * directionZ;

    // Preserve the established contract that points behind the near-plane ray
    // origin are not interactive, even if the first search sphere overlaps.
    if (projectedDistance < 0) return;

    const crossX = offsetY * directionZ - offsetZ * directionY;
    const crossY = offsetZ * directionX - offsetX * directionZ;
    const crossZ = offsetX * directionY - offsetY * directionX;
    const perpendicularDistanceSquared =
      crossX * crossX + crossY * crossY + crossZ * crossZ;
    if (perpendicularDistanceSquared > searchRadiusSquared) return;

    const longitudinalReach = Math.sqrt(
      Math.max(
        0,
        searchRadiusSquared - perpendicularDistanceSquared
      )
    );
    const firstCandidateDistance = projectedDistance - longitudinalReach;
    const nominalFirstSampleIndex = firstCandidateDistance <= 0
      ? 0
      : Math.ceil(firstCandidateDistance / sampleStep);
    // `ceil(lowerBound / step)` is the analytic answer, but the lower bound
    // contains a square root and can land microscopically on either side of an
    // exact sample boundary. Check its immediate neighbors with the original
    // sphere equation and keep the first actual discrete hit.
    const firstCheckedSampleIndex = Math.max(
      0,
      nominalFirstSampleIndex - 1
    );
    const lastCheckedSampleIndex = Math.min(
      sampleCount - 1,
      nominalFirstSampleIndex + 1
    );
    let firstSampleIndex = -1;
    for (
      let sampleIndex = firstCheckedSampleIndex;
      sampleIndex <= lastCheckedSampleIndex;
      sampleIndex++
    ) {
      const sampleDistance = sampleIndex * sampleStep;
      const longitudinalDelta = projectedDistance - sampleDistance;
      if (
        perpendicularDistanceSquared +
          longitudinalDelta * longitudinalDelta <=
        searchRadiusSquared
      ) {
        firstSampleIndex = sampleIndex;
        break;
      }
    }
    if (firstSampleIndex === -1) return;

    if (
      firstSampleIndex < bestSampleIndex ||
      (
        firstSampleIndex === bestSampleIndex &&
        (
          perpendicularDistanceSquared <
            bestPerpendicularDistanceSquared ||
          (
            perpendicularDistanceSquared ===
              bestPerpendicularDistanceSquared &&
            (bestCellIndex === -1 || cellIndex < bestCellIndex)
          )
        )
      )
    ) {
      bestCellIndex = cellIndex;
      bestSampleIndex = firstSampleIndex;
      bestPerpendicularDistanceSquared =
        perpendicularDistanceSquared;
    }
  };

  if (spatialIndex === null) {
    for (let cellIndex = 0; cellIndex < pointCount; cellIndex++) {
      evaluatePoint(cellIndex);
    }
  } else {
    spatialIndex.visitRaySegmentCandidates(
      ray.origin,
      [directionX, directionY, directionZ],
      lastSampleDistance,
      PICK_SEARCH_RADIUS,
      evaluatePoint
    );
  }

  return {
    cellIndex: bestCellIndex,
    examinedPointCount,
    firstSampleIndex:
      bestCellIndex === -1 ? -1 : bestSampleIndex,
    perpendicularDistanceSquared:
      bestCellIndex === -1
        ? Infinity
        : bestPerpendicularDistanceSquared,
  };
}
