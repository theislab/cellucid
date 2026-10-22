import { POINT_VISIBILITY_THRESHOLD } from './alpha-visibility.js';

/**
 * Screen-space cell picking: the cell is the dot drawn under the pointer.
 *
 * Every point is projected with the pane's own matrices and given the size the
 * vertex shader draws it at (shaders/high-perf-shaders.js: the same point size,
 * perspective attenuation and clamp). A cell is under the pointer when its
 * drawn disc covers it; of those, the front-most wins, which is the dot the
 * depth test leaves on top. When no disc covers the pointer, the nearest dot
 * within PICK_TOLERANCE_CSS_PX of its edge is taken, so a near miss on a small
 * dot still lands. Hidden cells and cells the current level of detail does not
 * draw are never picked.
 *
 * This replaced a ray search with a fixed world-space radius, which ignored
 * drawn size and preferred the cell nearest the camera: zoomed in it picked a
 * neighbour of the dot under the pointer, zoomed out it missed dots entirely.
 */

/** How far outside a dot's drawn edge a click still selects it, in CSS px. */
export const PICK_TOLERANCE_CSS_PX = 3;

/** The vertex shader's clamp on gl_PointSize, in device pixels. */
const MIN_DRAWN_POINT_SIZE_PX = 0.5;
const MAX_DRAWN_POINT_SIZE_PX = 128;

const LOD_MEMBERSHIP_KEYS = Object.freeze([
  'admissionLevels',
  'dimensionLevel',
  'generationToken',
  'indices',
  'lodLevel',
  'pointCount',
]);

function requireLodMembership(
  lodMembership,
  pointCount,
  spatialIndex
) {
  if (lodMembership === null) return null;
  if (
    typeof lodMembership !== 'object' ||
    Array.isArray(lodMembership) ||
    Object.getPrototypeOf(lodMembership) !== Object.prototype ||
    !Object.isFrozen(lodMembership) ||
    Object.keys(lodMembership).length !== LOD_MEMBERSHIP_KEYS.length ||
    !LOD_MEMBERSHIP_KEYS.every(key => (
      Object.prototype.hasOwnProperty.call(lodMembership, key)
    ))
  ) {
    throw new TypeError(
      'Picking lodMembership must be null or one frozen renderer certificate.'
    );
  }
  const {
    admissionLevels,
    dimensionLevel,
    generationToken,
    indices,
    lodLevel,
    pointCount: membershipPointCount,
  } = lodMembership;
  if (
    !(admissionLevels instanceof Uint8Array) ||
    admissionLevels.length !== pointCount ||
    !(indices instanceof Uint32Array) ||
    indices.length > pointCount ||
    membershipPointCount !== pointCount ||
    !Number.isInteger(dimensionLevel) ||
    dimensionLevel < 1 ||
    dimensionLevel > 3 ||
    !Number.isInteger(lodLevel) ||
    lodLevel < 0 ||
    lodLevel >= 0xff ||
    generationToken === null ||
    typeof generationToken !== 'object' ||
    !Object.isFrozen(generationToken)
  ) {
    throw new TypeError(
      'Picking lodMembership must exactly match the point-count, dimension, and reduced-LOD certificate contract.'
    );
  }
  if (
    spatialIndex !== null &&
    (
      spatialIndex.dimensionLevel !== dimensionLevel ||
      typeof spatialIndex.getLodMembership !== 'function' ||
      spatialIndex.getLodMembership(lodLevel) !== lodMembership
    )
  ) {
    throw new TypeError(
      'Picking lodMembership must belong to the exact matching spatial owner.'
    );
  }
  return lodMembership;
}

function requireFinite(value, label, { positive = false } = {}) {
  if (!Number.isFinite(value) || (positive && value <= 0)) {
    throw new RangeError(`${label} must be a ${positive ? 'positive ' : ''}finite number.`);
  }
  return value;
}

function requireScreenPickInput(input) {
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new TypeError('Picking input must be one plain object.');
  }
  const {
    dimension,
    lodMembership = null,
    positions,
    spatialIndex = null,
    transparency,
    mvpMatrix,
    cursor,
    pane,
    pointSize,
    sizeAttenuation,
    fov,
  } = input;
  if (dimension !== 1 && dimension !== 2 && dimension !== 3) {
    throw new RangeError('Picking dimension must be exactly 1, 2, or 3.');
  }
  if (!(positions instanceof Float32Array) || positions.length % dimension !== 0) {
    throw new TypeError('Picking positions must contain exactly dimension Float32 values per point.');
  }
  const pointCount = positions.length / dimension;
  if (!(transparency instanceof Uint8Array) || transparency.length !== pointCount) {
    throw new TypeError('Picking transparency must be a Uint8Array matching the point count.');
  }
  if ((!Array.isArray(mvpMatrix) && !ArrayBuffer.isView(mvpMatrix)) || mvpMatrix.length !== 16) {
    throw new TypeError('Picking mvpMatrix must hold exactly 16 values.');
  }
  for (let index = 0; index < 16; index++) requireFinite(mvpMatrix[index], `Picking mvpMatrix[${index}]`);
  if (cursor === null || typeof cursor !== 'object') {
    throw new TypeError('Picking cursor must be an object.');
  }
  requireFinite(cursor.x, 'Picking cursor.x');
  requireFinite(cursor.y, 'Picking cursor.y');
  if (pane === null || typeof pane !== 'object') {
    throw new TypeError('Picking pane must be an object.');
  }
  requireFinite(pane.cssWidth, 'Picking pane.cssWidth', { positive: true });
  requireFinite(pane.cssHeight, 'Picking pane.cssHeight', { positive: true });
  requireFinite(pane.framebufferHeight, 'Picking pane.framebufferHeight', { positive: true });
  requireFinite(pointSize, 'Picking pointSize', { positive: true });
  requireFinite(sizeAttenuation, 'Picking sizeAttenuation');
  requireFinite(fov, 'Picking fov', { positive: true });
  if (spatialIndex !== null) {
    if (
      typeof spatialIndex !== 'object' ||
      spatialIndex.pointCount !== pointCount ||
      spatialIndex.positions !== positions ||
      spatialIndex.dimensionLevel !== dimension ||
      typeof spatialIndex.visitProjectedRectCandidates !== 'function'
    ) {
      throw new TypeError('Picking spatialIndex must be null or an exact matching spatial owner.');
    }
  }
  return {
    dimension,
    lodMembership: requireLodMembership(lodMembership, pointCount, spatialIndex),
    pointCount,
    positions,
    spatialIndex,
    transparency,
    mvpMatrix,
    cursor,
    pane,
    pointSize,
    sizeAttenuation,
    fov,
  };
}

/**
 * The drawn radius of a point at clip-space w, in CSS pixels. Mirrors the
 * vertex shader: mix(pointSize, perspectiveSize, attenuation), clamped, in
 * device pixels; halved for a radius and divided by the device pixel ratio.
 */
export function drawnPointRadiusCss({ w, pointSize, sizeAttenuation, fov, framebufferHeight, devicePixelRatio }) {
  const projectionFactor = framebufferHeight / (2 * Math.tan(fov * 0.5));
  const perspectiveSize = (pointSize * 0.01 * projectionFactor) / Math.max(w, 0.001);
  const size = pointSize + (perspectiveSize - pointSize) * sizeAttenuation;
  const clamped = Math.min(MAX_DRAWN_POINT_SIZE_PX, Math.max(MIN_DRAWN_POINT_SIZE_PX, size));
  return clamped / 2 / devicePixelRatio;
}

/**
 * Find the cell drawn under a screen point of one pane.
 *
 * @param {Object} input
 * @param {1|2|3} input.dimension
 * @param {Float32Array} input.positions - `dimension` values per point.
 * @param {Uint8Array} input.transparency - Per-cell visibility; below
 *   POINT_VISIBILITY_THRESHOLD the shader discards the cell.
 * @param {ArrayLike<number>} input.mvpMatrix - The pane's projection × view ×
 *   model matrix, column-major, as drawn.
 * @param {{x: number, y: number}} input.cursor - Pointer in pane CSS pixels.
 * @param {{cssWidth: number, cssHeight: number, framebufferHeight: number}} input.pane
 * @param {number} input.pointSize - u_pointSize.
 * @param {number} input.sizeAttenuation - u_sizeAttenuation.
 * @param {number} input.fov - u_fov, radians.
 * @param {import('./high-perf/spatial-index.js').SpatialIndex|null} [input.spatialIndex]
 * @param {Object|null} [input.lodMembership] - The renderer's frozen LOD
 *   certificate for the pane, or null at full detail.
 * @returns {{ cellIndex: number, examinedPointCount: number, screenDistance: number, depth: number }}
 */
export function findScreenSpacePick(input) {
  const {
    dimension,
    lodMembership,
    pointCount,
    positions,
    spatialIndex,
    transparency,
    mvpMatrix: m,
    cursor,
    pane,
    pointSize,
    sizeAttenuation,
    fov,
  } = requireScreenPickInput(input);
  const lodAdmissionLevels = lodMembership === null ? null : lodMembership.admissionLevels;
  const lodLevel = lodMembership === null ? -1 : lodMembership.lodLevel;
  const { cssWidth, cssHeight, framebufferHeight } = pane;
  const devicePixelRatio = framebufferHeight / cssHeight;
  const sizeInput = { w: 1, pointSize, sizeAttenuation, fov, framebufferHeight, devicePixelRatio };

  let bestCovering = -1;
  let bestCoveringDepth = Infinity;
  let bestCoveringDistance = Infinity;
  let bestNear = -1;
  let bestNearGap = Infinity;
  let bestNearDistance = Infinity;
  let bestNearDepth = Infinity;
  let examinedPointCount = 0;

  const evaluatePoint = cellIndex => {
    examinedPointCount++;
    if (lodAdmissionLevels !== null && lodAdmissionLevels[cellIndex] > lodLevel) return;
    if (!(transparency[cellIndex] >= POINT_VISIBILITY_THRESHOLD)) return;
    const offset = cellIndex * dimension;
    const x = positions[offset];
    const y = dimension > 1 ? positions[offset + 1] : 0;
    const z = dimension > 2 ? positions[offset + 2] : 0;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!(w > 0)) return;
    const ndcZ = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    if (ndcZ < -1 || ndcZ > 1) return;
    const ndcX = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    const ndcY = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    const dx = (ndcX * 0.5 + 0.5) * cssWidth - cursor.x;
    const dy = (0.5 - ndcY * 0.5) * cssHeight - cursor.y;
    const distance = Math.hypot(dx, dy);
    sizeInput.w = w;
    const radius = drawnPointRadiusCss(sizeInput);
    if (distance <= radius) {
      // Front-most first: what the depth test leaves on top. In a flat layout
      // every dot has the same depth, so the nearer centre decides.
      if (
        w < bestCoveringDepth - 1e-6 * bestCoveringDepth
        || (Math.abs(w - bestCoveringDepth) <= 1e-6 * bestCoveringDepth
          && (distance < bestCoveringDistance
            || (distance === bestCoveringDistance && cellIndex < bestCovering)))
      ) {
        bestCovering = cellIndex;
        bestCoveringDepth = w;
        bestCoveringDistance = distance;
      }
      return;
    }
    const gap = distance - radius;
    if (gap > PICK_TOLERANCE_CSS_PX) return;
    if (gap < bestNearGap || (gap === bestNearGap && cellIndex < bestNear)) {
      bestNear = cellIndex;
      bestNearGap = gap;
      bestNearDistance = distance;
      bestNearDepth = w;
    }
  };

  if (spatialIndex === null) {
    if (lodMembership === null) {
      for (let cellIndex = 0; cellIndex < pointCount; cellIndex++) evaluatePoint(cellIndex);
    } else {
      const lodIndices = lodMembership.indices;
      for (let compactIndex = 0; compactIndex < lodIndices.length; compactIndex++) {
        const cellIndex = lodIndices[compactIndex];
        if (cellIndex >= pointCount || lodAdmissionLevels[cellIndex] > lodLevel) {
          throw new RangeError(
            `Picking LOD compact index ${compactIndex} does not name an admitted source point.`
          );
        }
        evaluatePoint(cellIndex);
      }
    }
  } else {
    // Every dot that can reach the pointer lies in a screen rectangle as wide
    // as the largest drawable radius plus the tolerance.
    const reachCss = MAX_DRAWN_POINT_SIZE_PX / 2 / devicePixelRatio + PICK_TOLERANCE_CSS_PX;
    const centreX = (cursor.x / cssWidth) * 2 - 1;
    const centreY = 1 - (cursor.y / cssHeight) * 2;
    const halfX = (reachCss / cssWidth) * 2;
    const halfY = (reachCss / cssHeight) * 2;
    spatialIndex.visitProjectedRectCandidates(
      m,
      { minX: centreX - halfX, maxX: centreX + halfX, minY: centreY - halfY, maxY: centreY + halfY },
      evaluatePoint
    );
  }

  if (bestCovering !== -1) {
    return { cellIndex: bestCovering, examinedPointCount, screenDistance: bestCoveringDistance, depth: bestCoveringDepth };
  }
  return {
    cellIndex: bestNear,
    examinedPointCount,
    screenDistance: bestNear === -1 ? Infinity : bestNearDistance,
    depth: bestNear === -1 ? Infinity : bestNearDepth,
  };
}
