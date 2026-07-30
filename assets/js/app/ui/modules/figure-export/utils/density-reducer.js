/**
 * @fileoverview Density-preserving point reduction for large exports.
 *
 * PURPOSE:
 * Reduces the number of points while preserving visual appearance.
 * Essential for exporting large datasets (50k-200k points) as SVG without
 * creating massive files that are slow to render.
 *
 * ALGORITHM:
 * Uses viewport-space grid-based reservoir sampling:
 * 1. Project all visible points to viewport coordinates
 * 2. Divide viewport into grid cells (default 160×160)
 * 3. Apportion exactly targetCount slots across occupied cells
 * 4. Sampling uses a deterministic Mulberry32 PRNG
 *
 * WHY THIS APPROACH:
 * - Preserves density: dense clusters remain dense, sparse regions remain sparse
 * - Deterministic: same seed produces same output (reproducible exports)
 * - Memory efficient: O(k + grid²) over the currently rendered K-point prefix
 * - Fast: O(k + c log c) for c occupied grid cells
 * - Exact: returns min(targetCount, visible candidates) points
 *
 * OUTPUT:
 * Returns viewport-space coordinates (not clip-space or NDC) for direct
 * use in Canvas2D rendering without additional projection.
 *
 * @module ui/modules/figure-export/utils/density-reducer
 */

import { clamp } from '../../../../utils/number-utils.js';
import { createMulberry32 } from '../../../../utils/random-utils.js';
import { assertCropRect01, cropRect01ToPx } from './crop.js';
import {
  assertLodMembership,
  MIN_VISIBLE_ALPHA_BYTE,
  POINT_VISIBILITY_THRESHOLD,
} from './lod-membership.js';

/**
 * @typedef {object} ReducedViewportPoints
 * @property {Float32Array} x - viewport-space x (0..viewportWidth)
 * @property {Float32Array} y - viewport-space y (0..viewportHeight)
 * @property {Uint8Array} rgba - packed RGBA uint8 (n*4), alpha is NOT premultiplied
 * @property {Float32Array} alpha - per-point alpha (0..1)
 * @property {Uint32Array} index - source point index for each reduced point
 * @property {Float32Array} sourcePositions - packed source xyz values (n*3)
 * @property {Uint8Array} highlighted - sampled renderer highlight byte per point
 * @property {number} scannedSourceCount - unique primary/sparse source IDs examined
 * @property {number} candidateSourceCount - source IDs eligible before the preview scan cap
 * @property {number} viewportWidth
 * @property {number} viewportHeight
 */

function clampInt(value, lo, hi) {
  return clamp(value | 0, lo, hi);
}

function createEmptyReducedViewportPoints(
  viewportWidth,
  viewportHeight,
  scannedSourceCount = 0,
  candidateSourceCount = 0
) {
  return {
    x: new Float32Array(0),
    y: new Float32Array(0),
    rgba: new Uint8Array(0),
    alpha: new Float32Array(0),
    index: new Uint32Array(0),
    sourcePositions: new Float32Array(0),
    highlighted: new Uint8Array(0),
    scannedSourceCount,
    candidateSourceCount,
    viewportWidth,
    viewportHeight,
  };
}

/**
 * Apportion one exact target across density cells with deterministic Hamilton
 * remainders. When possible, reserve one slot per occupied cell before
 * distributing the remaining capacity proportionally.
 *
 * @param {Uint32Array} populations
 * @param {number} populationTotal
 * @param {number} targetTotal
 * @returns {Uint32Array}
 */
function apportionDensitySlots(
  populations,
  populationTotal,
  targetTotal
) {
  const cellCount = populations.length;
  const desired = new Uint32Array(cellCount);
  if (targetTotal === 0) return desired;
  if (
    !Number.isSafeInteger(populationTotal) ||
    !Number.isSafeInteger(targetTotal) ||
    populationTotal < 0 ||
    targetTotal < 0 ||
    targetTotal > populationTotal
  ) {
    throw new RangeError(
      'Figure-export density allocation requires an exact target within its population.'
    );
  }

  const remainders = new Float64Array(cellCount);
  const remainderCells = [];
  let nonEmptyCells = 0;
  for (let cell = 0; cell < cellCount; cell++) {
    if (populations[cell] > 0) nonEmptyCells++;
  }
  const reserveOnePerCell = targetTotal >= nonEmptyCells;
  const reservedTotal = reserveOnePerCell ? nonEmptyCells : 0;
  const remainingTarget = targetTotal - reservedTotal;
  const remainingPopulation = populationTotal - reservedTotal;
  let desiredSum = 0;

  for (let cell = 0; cell < cellCount; cell++) {
    const population = populations[cell];
    if (!population) continue;
    const reserved = reserveOnePerCell ? 1 : 0;
    const weight = population - reserved;
    const exactExtra =
      remainingTarget > 0 && remainingPopulation > 0
        ? (weight / remainingPopulation) * remainingTarget
        : 0;
    const extra = Math.floor(exactExtra);
    const keep = reserved + extra;
    desired[cell] = keep;
    desiredSum += keep;
    if (keep < population) {
      remainders[cell] = exactExtra - extra;
      remainderCells.push(cell);
    }
  }

  let unallocated = targetTotal - desiredSum;
  if (unallocated > 0) {
    remainderCells.sort((cellA, cellB) => {
      const remainderDifference =
        remainders[cellB] - remainders[cellA];
      return remainderDifference || cellA - cellB;
    });
    for (
      let remainderIndex = 0;
      remainderIndex < remainderCells.length && unallocated > 0;
      remainderIndex++
    ) {
      desired[remainderCells[remainderIndex]]++;
      unallocated--;
    }
  }
  if (unallocated !== 0) {
    throw new Error(
      'Figure-export density allocation could not satisfy the exact target.'
    );
  }
  return desired;
}

/**
 * Reduce points by density in viewport space.
 *
 * @param {object} options
 * @param {Float32Array|null} options.positions - n*3
 * @param {Uint8Array|null} options.colors - n*4
 * @param {Float32Array|null} [options.transparency] - n (0..1)
 * @param {import('./lod-membership.js').LodMembership|null} [options.lodMembership]
 * @param {Uint8Array|null} [options.highlightArray] - exact renderer highlight bytes
 * @param {number[]|Uint32Array|null} [options.highlightedIndices] - complete unique sparse highlight IDs
 * @param {{ mvpMatrix: Float32Array; viewportWidth: number; viewportHeight: number }} options.renderState
 * @param {number} options.targetCount
 * @param {{ enabled?: boolean; x?: number; y?: number; width?: number; height?: number } | null} [options.crop]
 * @param {number} [options.gridSize=160]
 * @param {number|null} [options.maxScanPoints=null] - Optional exact cap for evenly distributed preview sampling
 * @param {number} [options.seed=1337]
 * @returns {ReducedViewportPoints}
 */
export function reducePointsByDensity({
  positions,
  colors,
  transparency = null,
  lodMembership = null,
  highlightArray = null,
  highlightedIndices = null,
  renderState,
  targetCount,
  crop = null,
  gridSize = 160,
  maxScanPoints = null,
  seed = 1337
}) {
  if (!positions || !colors || !renderState?.mvpMatrix) {
    return createEmptyReducedViewportPoints(
      renderState?.viewportWidth || 1,
      renderState?.viewportHeight || 1
    );
  }

  const n = Math.min(Math.floor(positions.length / 3), Math.floor(colors.length / 4));
  const sourcePointCount = Math.floor(positions.length / 3);
  const requestedTotal = Number.isFinite(targetCount)
    ? Math.max(0, Math.floor(targetCount))
    : 0;
  if (
    maxScanPoints !== null &&
    (
      !Number.isSafeInteger(maxScanPoints) ||
      maxScanPoints < 1
    )
  ) {
    throw new RangeError(
      'Figure-export density maxScanPoints must be null or a positive safe integer.'
    );
  }
  assertLodMembership(lodMembership, {
    pointCount: sourcePointCount,
  });
  if (
    highlightArray !== null &&
    (!(highlightArray instanceof Uint8Array) ||
      highlightArray.length !== sourcePointCount)
  ) {
    throw new TypeError(
      'Figure-export density highlightArray must be null or one exact Uint8 value per source point.'
    );
  }
  if (
    highlightedIndices !== null &&
    (
      highlightArray === null ||
      (!Array.isArray(highlightedIndices) &&
        !(highlightedIndices instanceof Uint32Array))
    )
  ) {
    throw new TypeError(
      'Figure-export density highlightedIndices require highlightArray and must be an Array or Uint32Array.'
    );
  }
  let sparseHighlightIds = null;
  // Exact sparse preservation is intentionally limited to H <= target. A
  // huge highlight inventory must not turn a capped preview back into an O(N)
  // scan merely to validate or preserve more points than can be returned.
  if (
    highlightedIndices !== null &&
    highlightedIndices.length <= requestedTotal
  ) {
    sparseHighlightIds = new Set();
    for (const pointIndex of highlightedIndices) {
      if (
        !Number.isSafeInteger(pointIndex) ||
        pointIndex < 0 ||
        pointIndex >= sourcePointCount ||
        sparseHighlightIds.has(pointIndex) ||
        highlightArray[pointIndex] < MIN_VISIBLE_ALPHA_BYTE
      ) {
        throw new RangeError(
          'Figure-export density highlightedIndices must be unique visible highlight IDs in the current source generation.'
        );
      }
      sparseHighlightIds.add(pointIndex);
    }
  }
  const admittedIndices = lodMembership?.indices ?? null;
  const candidateCount = admittedIndices?.length ?? n;
  const primaryScanCount = maxScanPoints === null
    ? candidateCount
    : Math.min(candidateCount, maxScanPoints);
  // Exact integer quotient/remainder stepping implements
  // floor(sampleIndex * candidateCount / primaryScanCount) without a
  // potentially imprecise large multiplication. It consumes the full K
  // budget even when N is only slightly above the cap.
  const scanBaseStep = primaryScanCount === 0
    ? 0
    : Math.floor(candidateCount / primaryScanCount);
  const scanRemainderStep = primaryScanCount === 0
    ? 0
    : candidateCount % primaryScanCount;
  const randomAdmissionLevels = lodMembership?.admissionLevels ?? null;
  const randomAdmissionLevel = lodMembership?.lodLevel ?? -1;
  const viewportW = Math.max(1, renderState.viewportWidth || 1);
  const viewportH = Math.max(1, renderState.viewportHeight || 1);
  const mvp = renderState.mvpMatrix;

  const crop01 = assertCropRect01(crop);
  const cropPx = cropRect01ToPx(crop01, viewportW, viewportH);
  const hasCrop = Boolean(
    cropPx &&
    (cropPx.width < viewportW - 0.5 || cropPx.height < viewportH - 0.5 || cropPx.x > 0.5 || cropPx.y > 0.5)
  );
  const effW = hasCrop ? cropPx.width : viewportW;
  const effH = hasCrop ? cropPx.height : viewportH;
  if (requestedTotal === 0) {
    return createEmptyReducedViewportPoints(
      effW,
      effH,
      0,
      candidateCount
    );
  }

  const cols = clampInt(gridSize, 32, 512);
  const rows = clampInt(gridSize, 32, 512);
  const cellCount = cols * rows;

  const counts = new Uint32Array(cellCount);
  const highlightCounts =
    highlightArray === null ? null : new Uint32Array(cellCount);
  const stridedHighlightIds =
    sparseHighlightIds !== null &&
    primaryScanCount < candidateCount &&
    (
      lodMembership === null ||
      randomAdmissionLevels !== null
    )
      ? new Set()
      : null;
  let visibleTotal = 0;
  let visibleHighlightTotal = 0;
  let supplementalScanCount = 0;

  // Pass 1: count points per cell (only visible + within clip).
  let candidateIndex = 0;
  let scanRemainder = 0;
  for (
    let sampleIndex = 0;
    sampleIndex < primaryScanCount;
    sampleIndex++
  ) {
    const sampledCandidateIndex = candidateIndex;
    candidateIndex += scanBaseStep;
    scanRemainder += scanRemainderStep;
    if (scanRemainder >= primaryScanCount) {
      candidateIndex++;
      scanRemainder -= primaryScanCount;
    }
    const i = admittedIndices === null
      ? sampledCandidateIndex
      : admittedIndices[sampledCandidateIndex];
    if (i >= n) continue;
    const isHighlighted =
      highlightArray !== null &&
      highlightArray[i] >= MIN_VISIBLE_ALPHA_BYTE;
    if (isHighlighted && stridedHighlightIds !== null) {
      stridedHighlightIds.add(i);
    }
    const rawAlpha = transparency ? (transparency[i] ?? 1.0) : (colors[i * 4 + 3] / 255);
    let a = Number.isFinite(rawAlpha) ? rawAlpha : 1.0;
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    if (a < POINT_VISIBILITY_THRESHOLD) continue;

    const ix = i * 3;
    const x = positions[ix];
    const y = positions[ix + 1];
    const z = positions[ix + 2];

    const clipX = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
    const clipY = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
    const clipZ = mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14];
    const clipW = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
    if (!Number.isFinite(clipW) || clipW <= 0) continue;

    const ndcX = clipX / clipW;
    const ndcY = clipY / clipW;
    const ndcZ = clipZ / clipW;
    if (
      ndcX < -1 ||
      ndcX > 1 ||
      ndcY < -1 ||
      ndcY > 1 ||
      ndcZ < -1 ||
      ndcZ > 1
    ) {
      continue;
    }

    let vx = (ndcX * 0.5 + 0.5) * viewportW;
    let vy = (-ndcY * 0.5 + 0.5) * viewportH;
    if (hasCrop && cropPx) {
      if (vx < cropPx.x || vx > cropPx.x + cropPx.width || vy < cropPx.y || vy > cropPx.y + cropPx.height) continue;
      vx -= cropPx.x;
      vy -= cropPx.y;
    }

    const cx = clampInt((vx / effW) * cols, 0, cols - 1);
    const cy = clampInt((vy / effH) * rows, 0, rows - 1);
    const cell = cy * cols + cx;
    counts[cell]++;
    if (isHighlighted) {
      highlightCounts[cell]++;
      visibleHighlightTotal++;
    }
    visibleTotal++;
  }

  // A capped preview scans a regular K-prefix stride, then visits only sparse
  // highlighted IDs that the stride missed. Random admission bytes are used
  // for these H points only; sequential export remains prefix-only.
  if (stridedHighlightIds !== null) {
    for (const i of sparseHighlightIds) {
      if (stridedHighlightIds.has(i)) continue;
      supplementalScanCount++;
      if (
        i >= n ||
        (
          randomAdmissionLevels !== null &&
          randomAdmissionLevels[i] > randomAdmissionLevel
        )
      ) {
        continue;
      }
      const rawAlpha = transparency
        ? (transparency[i] ?? 1.0)
        : (colors[i * 4 + 3] / 255);
      let a = Number.isFinite(rawAlpha) ? rawAlpha : 1.0;
      if (a < 0) a = 0;
      else if (a > 1) a = 1;
      if (a < POINT_VISIBILITY_THRESHOLD) continue;

      const ix = i * 3;
      const x = positions[ix];
      const y = positions[ix + 1];
      const z = positions[ix + 2];
      const clipX =
        mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
      const clipY =
        mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
      const clipZ =
        mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14];
      const clipW =
        mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
      if (!Number.isFinite(clipW) || clipW <= 0) continue;

      const ndcX = clipX / clipW;
      const ndcY = clipY / clipW;
      const ndcZ = clipZ / clipW;
      if (
        ndcX < -1 ||
        ndcX > 1 ||
        ndcY < -1 ||
        ndcY > 1 ||
        ndcZ < -1 ||
        ndcZ > 1
      ) {
        continue;
      }

      let vx = (ndcX * 0.5 + 0.5) * viewportW;
      let vy = (-ndcY * 0.5 + 0.5) * viewportH;
      if (hasCrop && cropPx) {
        if (
          vx < cropPx.x ||
          vx > cropPx.x + cropPx.width ||
          vy < cropPx.y ||
          vy > cropPx.y + cropPx.height
        ) {
          continue;
        }
        vx -= cropPx.x;
        vy -= cropPx.y;
      }

      const cx = clampInt((vx / effW) * cols, 0, cols - 1);
      const cy = clampInt((vy / effH) * rows, 0, rows - 1);
      const cell = cy * cols + cx;
      counts[cell]++;
      highlightCounts[cell]++;
      visibleTotal++;
      visibleHighlightTotal++;
    }
  }

  if (visibleTotal <= 0) {
    return createEmptyReducedViewportPoints(
      effW,
      effH,
      primaryScanCount + supplementalScanCount,
      candidateCount
    );
  }

  const desiredTotal = Math.min(requestedTotal, visibleTotal);
  if (desiredTotal === 0) {
    return createEmptyReducedViewportPoints(
      effW,
      effH,
      primaryScanCount + supplementalScanCount,
      candidateCount
    );
  }

  // Highlights own a separate quota so ordinary reservoir replacement can
  // never sample them away. Preserve every renderer-visible highlight when
  // it fits. If highlights alone exceed the target, apply the same exact,
  // deterministic density apportionment to highlights and spend no ordinary
  // quota.
  let highlightDesired = new Uint32Array(cellCount);
  let regularDesired;
  if (
    highlightCounts !== null &&
    visibleHighlightTotal > 0
  ) {
    if (visibleHighlightTotal <= desiredTotal) {
      highlightDesired = highlightCounts;
      const regularCounts = new Uint32Array(cellCount);
      for (let cell = 0; cell < cellCount; cell++) {
        regularCounts[cell] = counts[cell] - highlightCounts[cell];
      }
      regularDesired = apportionDensitySlots(
        regularCounts,
        visibleTotal - visibleHighlightTotal,
        desiredTotal - visibleHighlightTotal
      );
    } else {
      highlightDesired = apportionDensitySlots(
        highlightCounts,
        visibleHighlightTotal,
        desiredTotal
      );
      regularDesired = new Uint32Array(cellCount);
    }
  } else {
    regularDesired = apportionDensitySlots(
      counts,
      visibleTotal,
      desiredTotal
    );
  }

  // Compute per-cell offsets into packed output arrays.
  const offsets = new Uint32Array(cellCount);
  let cursor = 0;
  for (let c = 0; c < cellCount; c++) {
    offsets[c] = cursor;
    cursor += highlightDesired[c] + regularDesired[c];
  }
  const outCount = cursor;
  if (outCount !== desiredTotal) {
    throw new Error(
      'Figure-export density quotas do not match the exact output target.'
    );
  }

  const outX = new Float32Array(outCount);
  const outY = new Float32Array(outCount);
  const outRGBA = new Uint8Array(outCount * 4);
  const outA = new Float32Array(outCount);
  const outIndex = new Uint32Array(outCount);
  const outSourcePositions = new Float32Array(outCount * 3);
  const outHighlighted = new Uint8Array(outCount);

  const seenHighlights = new Uint32Array(cellCount);
  const seenRegular = new Uint32Array(cellCount);
  const rnd = createMulberry32(seed);

  // Pass 2: per-cell reservoir sampling.
  candidateIndex = 0;
  scanRemainder = 0;
  for (
    let sampleIndex = 0;
    sampleIndex < primaryScanCount;
    sampleIndex++
  ) {
    const sampledCandidateIndex = candidateIndex;
    candidateIndex += scanBaseStep;
    scanRemainder += scanRemainderStep;
    if (scanRemainder >= primaryScanCount) {
      candidateIndex++;
      scanRemainder -= primaryScanCount;
    }
    const i = admittedIndices === null
      ? sampledCandidateIndex
      : admittedIndices[sampledCandidateIndex];
    if (i >= n) continue;
    const isHighlighted =
      highlightArray !== null &&
      highlightArray[i] >= MIN_VISIBLE_ALPHA_BYTE;
    const rawAlpha = transparency ? (transparency[i] ?? 1.0) : (colors[i * 4 + 3] / 255);
    let a = Number.isFinite(rawAlpha) ? rawAlpha : 1.0;
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    if (a < POINT_VISIBILITY_THRESHOLD) continue;

    const ix = i * 3;
    const x = positions[ix];
    const y = positions[ix + 1];
    const z = positions[ix + 2];

    const clipX = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
    const clipY = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
    const clipZ = mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14];
    const clipW = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
    if (!Number.isFinite(clipW) || clipW <= 0) continue;

    const ndcX = clipX / clipW;
    const ndcY = clipY / clipW;
    const ndcZ = clipZ / clipW;
    if (
      ndcX < -1 ||
      ndcX > 1 ||
      ndcY < -1 ||
      ndcY > 1 ||
      ndcZ < -1 ||
      ndcZ > 1
    ) {
      continue;
    }

    let vx = (ndcX * 0.5 + 0.5) * viewportW;
    let vy = (-ndcY * 0.5 + 0.5) * viewportH;
    if (hasCrop && cropPx) {
      if (vx < cropPx.x || vx > cropPx.x + cropPx.width || vy < cropPx.y || vy > cropPx.y + cropPx.height) continue;
      vx -= cropPx.x;
      vy -= cropPx.y;
    }

    const cx = clampInt((vx / effW) * cols, 0, cols - 1);
    const cy = clampInt((vy / effH) * rows, 0, rows - 1);
    const cell = cy * cols + cx;
    const desired = isHighlighted
      ? highlightDesired
      : regularDesired;
    const seen = isHighlighted
      ? seenHighlights
      : seenRegular;
    const want = desired[cell];
    if (!want) continue;

    const k = ++seen[cell];
    let slot;
    if (k <= want) {
      slot =
        offsets[cell] +
        (isHighlighted ? 0 : highlightDesired[cell]) +
        (k - 1);
    } else {
      const j = Math.floor(rnd() * k);
      if (j >= want) continue;
      slot =
        offsets[cell] +
        (isHighlighted ? 0 : highlightDesired[cell]) +
        j;
    }

    outX[slot] = vx;
    outY[slot] = vy;
    const cj = i * 4;
    const oj = slot * 4;
    outRGBA[oj] = colors[cj];
    outRGBA[oj + 1] = colors[cj + 1];
    outRGBA[oj + 2] = colors[cj + 2];
    outRGBA[oj + 3] = 255;
    outA[slot] = a;
    outIndex[slot] = i;
    const outputPositionIndex = slot * 3;
    outSourcePositions[outputPositionIndex] = x;
    outSourcePositions[outputPositionIndex + 1] = y;
    outSourcePositions[outputPositionIndex + 2] = z;
    outHighlighted[slot] = isHighlighted
      ? highlightArray[i]
      : 0;
  }

  if (stridedHighlightIds !== null) {
    for (const i of sparseHighlightIds) {
      if (
        stridedHighlightIds.has(i) ||
        i >= n ||
        (
          randomAdmissionLevels !== null &&
          randomAdmissionLevels[i] > randomAdmissionLevel
        )
      ) {
        continue;
      }
      const rawAlpha = transparency
        ? (transparency[i] ?? 1.0)
        : (colors[i * 4 + 3] / 255);
      let a = Number.isFinite(rawAlpha) ? rawAlpha : 1.0;
      if (a < 0) a = 0;
      else if (a > 1) a = 1;
      if (a < POINT_VISIBILITY_THRESHOLD) continue;

      const ix = i * 3;
      const x = positions[ix];
      const y = positions[ix + 1];
      const z = positions[ix + 2];
      const clipX =
        mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
      const clipY =
        mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
      const clipZ =
        mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14];
      const clipW =
        mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
      if (!Number.isFinite(clipW) || clipW <= 0) continue;

      const ndcX = clipX / clipW;
      const ndcY = clipY / clipW;
      const ndcZ = clipZ / clipW;
      if (
        ndcX < -1 ||
        ndcX > 1 ||
        ndcY < -1 ||
        ndcY > 1 ||
        ndcZ < -1 ||
        ndcZ > 1
      ) {
        continue;
      }

      let vx = (ndcX * 0.5 + 0.5) * viewportW;
      let vy = (-ndcY * 0.5 + 0.5) * viewportH;
      if (hasCrop && cropPx) {
        if (
          vx < cropPx.x ||
          vx > cropPx.x + cropPx.width ||
          vy < cropPx.y ||
          vy > cropPx.y + cropPx.height
        ) {
          continue;
        }
        vx -= cropPx.x;
        vy -= cropPx.y;
      }

      const cx = clampInt((vx / effW) * cols, 0, cols - 1);
      const cy = clampInt((vy / effH) * rows, 0, rows - 1);
      const cell = cy * cols + cx;
      const want = highlightDesired[cell];
      if (!want) continue;

      const k = ++seenHighlights[cell];
      let slot;
      if (k <= want) {
        slot = offsets[cell] + (k - 1);
      } else {
        const replacementIndex = Math.floor(rnd() * k);
        if (replacementIndex >= want) continue;
        slot = offsets[cell] + replacementIndex;
      }

      outX[slot] = vx;
      outY[slot] = vy;
      const colorIndex = i * 4;
      const outputColorIndex = slot * 4;
      outRGBA[outputColorIndex] = colors[colorIndex];
      outRGBA[outputColorIndex + 1] = colors[colorIndex + 1];
      outRGBA[outputColorIndex + 2] = colors[colorIndex + 2];
      outRGBA[outputColorIndex + 3] = 255;
      outA[slot] = a;
      outIndex[slot] = i;
      const outputPositionIndex = slot * 3;
      outSourcePositions[outputPositionIndex] = x;
      outSourcePositions[outputPositionIndex + 1] = y;
      outSourcePositions[outputPositionIndex + 2] = z;
      outHighlighted[slot] = highlightArray[i];
    }
  }

  return {
    x: outX,
    y: outY,
    rgba: outRGBA,
    alpha: outA,
    index: outIndex,
    sourcePositions: outSourcePositions,
    highlighted: outHighlighted,
    scannedSourceCount:
      primaryScanCount + supplementalScanCount,
    candidateSourceCount: candidateCount,
    viewportWidth: effW,
    viewportHeight: effH
  };
}
