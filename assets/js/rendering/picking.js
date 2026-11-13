import { BENEATH_ALPHA_BYTE, POINT_VISIBILITY_THRESHOLD, UNREAD_ALPHA_BYTE } from './alpha-visibility.js';
import { requireLodMembership } from './high-perf/renderer-contracts.js';
import { pointScaleFor, pointSpriteSize } from './point-sprite.js';

/**
 * Screen-space cell picking: the cell is the dot drawn under the pointer.
 *
 * Every point is projected with the pane's own matrices and given the size the
 * vertex shader draws it at (`pointSpriteSize`, rendering/point-sprite.js: the
 * same point size, perspective attenuation and cap). A cell is under the
 * pointer when its drawn disc covers it; of those, the front-most wins, which
 * is the dot the depth test leaves on top. When no disc covers the pointer,
 * the nearest dot within PICK_TOLERANCE_CSS_PX of its edge is taken, so a
 * near miss on a small dot still lands. Hidden cells and cells the current
 * level of detail does not draw are never picked.
 *
 * A field's colors layer the cells (`alpha-visibility.js`, `pointLayers`):
 * a cell drawn in an upper layer wins over one beneath it, as drawn -- in a
 * flat layout by layer, in 3-D by depth among the cells read, every cell not
 * read lying under them (drawn without depth writes). The cells read are
 * found at the size they are drawn (`readPointSize`, larger while some cells
 * are not read) and, when the renderer drew them at every level of detail,
 * whatever the level.
 *
 * A ray search with a fixed world-space radius is not used: it ignores drawn
 * size and prefers the cell nearest the camera, so zoomed in it would pick a
 * neighbor of the dot under the pointer and zoomed out miss dots entirely.
 */

/** How far outside a dot's drawn edge a click still selects it, in CSS px. */
export const PICK_TOLERANCE_CSS_PX = 3;

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
    pointSizeMax,
    pointLayers = null,
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
  requireFinite(pointSizeMax, 'Picking pointSizeMax', { positive: true });
  if (pointLayers !== null) {
    if (
      typeof pointLayers !== 'object'
      || !(pointLayers.colors instanceof Uint8Array)
      || pointLayers.colors.length !== pointCount * 4
      || typeof pointLayers.readEveryLevel !== 'boolean'
    ) {
      throw new TypeError('Picking pointLayers must be null or {colors: RGBA8 of every point, readEveryLevel, readPointSize}.');
    }
    requireFinite(pointLayers.readPointSize, 'Picking pointLayers.readPointSize', { positive: true });
  }
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
    // Admission is a test on the cell, so it holds whichever tree visits
    // the candidates.
    lodMembership: requireLodMembership(lodMembership, {
      pointCount,
      dimensionLevel: dimension,
      owner: 'Picking lodMembership',
    }),
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
    pointSizeMax,
    pointLayers,
  };
}

/**
 * The drawn radius of a point at clip-space w (its eye depth), in CSS pixels:
 * the vertex shader's sprite (`pointSpriteSize`) in device pixels, halved
 * for a radius and divided by the device pixel ratio.
 */
export function drawnPointRadiusCss({
  w, pointSize, sizeAttenuation, fov, framebufferHeight, devicePixelRatio, pointSizeMax,
}) {
  const size = pointSpriteSize(w, {
    pointSize, pointScale: pointScaleFor(framebufferHeight, fov), sizeAttenuation, pointSizeMax,
  });
  return size / 2 / devicePixelRatio;
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
 * @param {number} input.pointSizeMax - u_pointSizeMax: the cap the pane drew with.
 * @param {import('./high-perf/spatial-index.js').SpatialIndex|null} [input.spatialIndex]
 * @param {import('./high-perf/renderer-contracts.js').LodMembership|null} [input.lodMembership] -
 *   The cells the pane's level of detail draws, or null at full detail.
 * @param {{colors: Uint8Array, readEveryLevel: boolean, readPointSize: number}|null} [input.pointLayers] -
 *   The layers the pane was drawn with (`HighPerfRenderer#getCurrentPointLayers`):
 *   the colors (alpha byte = layer), whether the cells read were drawn at
 *   every level, and their u_pointSize; null: every cell on top at `pointSize`.
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
    pointSizeMax,
    pointLayers,
  } = requireScreenPickInput(input);
  // The level's cells (`LodMembership`): by admission level, or the first
  // `count` cells (every cell at full detail).
  const lodAdmissionLevels = lodMembership === null ? null : lodMembership.admissionLevels;
  const lodLevel = lodMembership === null ? -1 : lodMembership.lodLevel;
  const lodPrefix = lodMembership === null || lodAdmissionLevels !== null ? pointCount : lodMembership.count;
  const { cssWidth, cssHeight, framebufferHeight } = pane;
  const devicePixelRatio = framebufferHeight / cssHeight;
  const sizeInput = { w: 1, pointSize, sizeAttenuation, fov, framebufferHeight, devicePixelRatio, pointSizeMax };
  const layerColors = pointLayers === null ? null : pointLayers.colors;
  const readEveryLevel = pointLayers !== null && pointLayers.readEveryLevel;
  const readPointSize = pointLayers === null ? pointSize : pointLayers.readPointSize;
  // Without depth (1-D and 2-D, `NO_DEPTH_MAX_DIMENSION`) the layer drawn
  // last is on top; with it, only the cells not read lie under every other.
  const flat = dimension < 3;

  let bestCovering = -1;
  let bestCoveringRank = Infinity;
  let bestCoveringTieRank = Infinity;
  let bestCoveringDepth = Infinity;
  let bestCoveringDistance = Infinity;
  let bestNear = -1;
  let bestNearGap = Infinity;
  let bestNearDistance = Infinity;
  let bestNearDepth = Infinity;
  let examinedPointCount = 0;

  const evaluatePoint = cellIndex => {
    examinedPointCount++;
    // The layer its color names: 0 on top, 1 the gray beneath, 2 not read.
    const layerByte = layerColors === null ? 255 : layerColors[cellIndex * 4 + 3];
    const layer = layerByte === UNREAD_ALPHA_BYTE ? 2 : layerByte === BENEATH_ALPHA_BYTE ? 1 : 0;
    const read = layer !== 2;
    if (!(read && readEveryLevel)
      && (lodAdmissionLevels !== null ? lodAdmissionLevels[cellIndex] > lodLevel : cellIndex >= lodPrefix)) return;
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
    sizeInput.pointSize = read ? readPointSize : pointSize;
    const radius = drawnPointRadiusCss(sizeInput);
    if (distance <= radius) {
      // The upper layer first, as drawn; then front-most: what the depth
      // test leaves on top. In a flat layout every dot has the same depth,
      // so the nearer center decides.
      const rank = flat ? layer : (read ? 0 : 1);
      const tieRank = flat ? 0 : layer;
      if (
        rank < bestCoveringRank
        || (rank === bestCoveringRank && (
          w < bestCoveringDepth - 1e-6 * bestCoveringDepth
          || (Math.abs(w - bestCoveringDepth) <= 1e-6 * bestCoveringDepth
            && (tieRank < bestCoveringTieRank
              || (tieRank === bestCoveringTieRank && (distance < bestCoveringDistance
                || (distance === bestCoveringDistance && cellIndex < bestCovering)))))
        ))
      ) {
        bestCovering = cellIndex;
        bestCoveringRank = rank;
        bestCoveringTieRank = tieRank;
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
    const lodIndices = lodMembership === null || lodAdmissionLevels === null ? null : lodMembership.indices;
    if (lodIndices === null || readEveryLevel) {
      // Every cell, or a level's first `count` cells; every cell when the
      // cells read are drawn whatever the level (the level's test above
      // still leaves out the others it does not draw).
      const end = readEveryLevel ? pointCount : lodPrefix;
      for (let cellIndex = 0; cellIndex < end; cellIndex++) evaluatePoint(cellIndex);
    } else {
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
    const reachCss = pointSizeMax / 2 / devicePixelRatio + PICK_TOLERANCE_CSS_PX;
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
