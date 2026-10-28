/**
 * Levels of detail as the renderer draws them: the ladder's counts
 * (`draw-order.js`, `lodLadder`), each level the first cells of the priority
 * order, and the adaptive choice of a level from the camera distance.
 *
 * Two owners publish levels. A spatial tree (`spatial-index.js`) publishes
 * them in its draw order, with frustum culling, once its store holds that
 * order. Before that, a store whose slots are in rank order
 * (`store-order.js`) is drawn by `RankLevels`: a level of `m` cells is the
 * store's first `m` slots, so nothing is built and nothing is gathered. A
 * level holds the same cells either way; only the order they are drawn in
 * differs.
 *
 * @module rendering/high-perf/lod-levels
 */

import { requireDimensionLevel } from './renderer-contracts.js';
import { LOD_FULL_DETAIL_ADMISSION_LEVEL, LOD_LADDER_FIRST_COUNT, lodLadder } from './draw-order.js';
import { formatCount, formatCountOf } from '../../utils/format-units.js';

/**
 * How far adaptive selection may go, from both ends.
 *
 * Adaptive selection is a frame-rate control, not a data-reduction policy, so
 * its coarsest useful answer is bounded. Two bounds, and the smaller count
 * wins: once a level draws `ADAPTIVE_LOD_POINT_BUDGET` points, drawing is
 * comfortable and further reduction buys nothing a viewer can see (the bound
 * that binds on an atlas); `ADAPTIVE_LOD_MAXIMUM_REDUCTION` caps the ratio,
 * which is satisfiable at every size, so the camera drives the level on a
 * 3,696-cell trajectory and an 18M-cell atlas alike.
 *
 * The forced-level slider is deliberately not bounded by either. Asking for a
 * coarser level explicitly is a legitimate request on hardware that needs it.
 */
export const ADAPTIVE_LOD_POINT_BUDGET = 2_000_000;
export const ADAPTIVE_LOD_MAXIMUM_REDUCTION = 8;

/**
 * The reduction the farthest camera asks for (distance at or past 3x the
 * data's size), and that point sizes stop growing at: the coarsest level the
 * earlier fixed ladder of 18 reductions had.
 */
const FARTHEST_REDUCTION = 44;

/**
 * The point-size multiplier of a level drawing `count` of `pointCount`
 * cells: points grow with the square root of the reduction, so a reduced
 * level covers about the area all cells do.
 *
 * @param {number} pointCount
 * @param {number} count
 * @returns {number}
 */
export function lodSizeMultiplier(pointCount, count) {
  const reduction = Math.min(FARTHEST_REDUCTION, pointCount / Math.max(1, count));
  return Math.sqrt(reduction) * 0.2 + 0.8;
}

/**
 * The coarsest level adaptive selection may choose: the first level holding
 * at least the smaller of the two bounds (the full-detail level always does).
 *
 * @param {ReadonlyArray<{pointCount: number}>} levels - Coarse to fine.
 * @param {number} pointCount
 * @returns {number}
 */
export function adaptiveMinimumLevel(levels, pointCount) {
  const floorCount = Math.min(ADAPTIVE_LOD_POINT_BUDGET, pointCount / ADAPTIVE_LOD_MAXIMUM_REDUCTION);
  for (let level = 0; level < levels.length; level++) {
    if (levels[level].pointCount >= floorCount) return level;
  }
  return levels.length - 1;
}

/**
 * The level for a camera distance (0 = coarsest, the last = full detail).
 *
 * The camera's distance over the data's size, clamped to [0.3, 3], asks for
 * a reduction from 1 (near) to `FARTHEST_REDUCTION` (far) on a log scale;
 * the level is the ladder position of that count, fractional between two
 * levels. Hysteresis keeps the previous level until the asked position is
 * more than 0.7 of a level away, then moves one level a frame. The answer
 * is never coarser than `minimumLevel`.
 *
 * @param {ReadonlyArray<{pointCount: number}>} levels - Coarse to fine.
 * @param {number} minimumLevel
 * @param {{minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number}} bounds
 * @param {number} distance - Camera distance from its target.
 * @param {number} previousLevel - The view's previous level, or -1.
 * @param {number} dimensionLevel
 * @returns {number}
 */
export function selectLodLevel(levels, minimumLevel, bounds, distance, previousLevel, dimensionLevel) {
  const numLevels = levels.length;
  if (numLevels === 0) return -1;
  const validDimLevel = requireDimensionLevel(dimensionLevel, 'Level-of-detail dimensionLevel');
  const dx = bounds.maxX - bounds.minX;
  const dy = bounds.maxY - bounds.minY;
  const dz = bounds.maxZ - bounds.minZ;
  // Data size from the significant extents (data may be along any axis).
  let dataSize;
  if (validDimLevel === 1) {
    dataSize = Math.max(dx, dy, dz) || 1;
  } else if (validDimLevel === 2) {
    const maxExtent = Math.max(dx, dy, dz);
    const minExtent = Math.min(dx, dy, dz);
    const midExtent = dx + dy + dz - maxExtent - minExtent;
    dataSize = Math.sqrt(maxExtent * maxExtent + midExtent * midExtent) || 1;
  } else {
    dataSize = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  }
  const minRatio = 0.3;
  const maxRatio = 3.0;
  const clampedRatio = Math.max(minRatio, Math.min(maxRatio, distance / dataSize));
  // 1 at the nearest distance, 0 at the farthest.
  const t = 1.0 - (Math.log(clampedRatio / minRatio) / Math.log(maxRatio / minRatio));
  const pointCount = levels[numLevels - 1].pointCount;
  const wanted = pointCount / FARTHEST_REDUCTION ** (1 - t);
  const targetLevel = ladderPosition(levels, wanted);

  const HYSTERESIS = 0.7;
  const currentLevel = previousLevel >= 0 ? Math.min(previousLevel, numLevels - 1) : Math.round(targetLevel);
  let newLevel = currentLevel;
  if (targetLevel > currentLevel + HYSTERESIS && currentLevel < numLevels - 1) {
    newLevel = currentLevel + 1;
  } else if (targetLevel < currentLevel - HYSTERESIS && currentLevel > 0) {
    newLevel = currentLevel - 1;
  }
  const floorLevel = Math.min(numLevels - 1, Math.max(0, minimumLevel));
  return Math.max(floorLevel, Math.min(numLevels - 1, newLevel));
}

/** The fractional ladder position of `count` cells (log scale between two levels). */
function ladderPosition(levels, count) {
  if (count <= levels[0].pointCount) return 0;
  for (let level = 1; level < levels.length; level++) {
    const upper = levels[level].pointCount;
    if (count <= upper) {
      const lower = levels[level - 1].pointCount;
      return level - 1 + Math.log(count / lower) / Math.log(upper / lower);
    }
  }
  return levels.length - 1;
}

/**
 * The levels of a store whose slots are in rank order (`store-order.js`,
 * `ranked`): level `j` is the store's first `lodLadder(n)[j]` slots, drawn as
 * one prefix, with no tree and no permutation. `slotSources()` (the store's
 * cell of each slot, or null when each slot holds its own cell) gives the
 * cells a level draws, in the order it draws them, for the consumers that
 * iterate them (`indices`, built when first asked for and only up to the
 * level's count).
 */
export class RankLevels {
  /**
   * @param {number} pointCount
   * @param {number} dimensionLevel
   * @param {{minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number}} bounds
   * @param {() => Uint32Array|null} slotSources
   */
  constructor(pointCount, dimensionLevel, bounds, slotSources) {
    this.pointCount = pointCount;
    this.dimensionLevel = requireDimensionLevel(dimensionLevel, 'RankLevels dimensionLevel');
    this.bounds = bounds;
    this._slotSources = slotSources;
    this._identity = null;
    this._membership = null;
    const ladder = lodLadder(pointCount);
    const owner = this;
    this.lodLevels = Object.freeze(ladder.map((count, depth) => {
      if (depth === ladder.length - 1) {
        return Object.freeze({ depth, pointCount: count, isFullDetail: true, sizes: null });
      }
      let indices = null;
      return Object.freeze({
        depth,
        pointCount: count,
        isFullDetail: false,
        sizes: null,
        sizeMultiplier: lodSizeMultiplier(pointCount, count),
        // The level's cells in the order the store draws them.
        get indices() {
          indices ??= owner._prefix(count);
          return indices;
        },
      });
    }));
    this._adaptiveMinimumLevel = adaptiveMinimumLevel(this.lodLevels, pointCount);
    console.log(
      `[RankLevels] ${formatCountOf(this.lodLevels.length, 'level')} of detail in rank order over ${formatCountOf(pointCount, 'cell')} `
        + `(from ${formatCount(Math.min(LOD_LADDER_FIRST_COUNT, pointCount))}; adaptive floor: level ${this._adaptiveMinimumLevel})`
    );
  }

  /** See `selectLodLevel`. */
  getLODLevel(distance, previousLevel, dimensionLevel, overrideBounds = null) {
    return selectLodLevel(
      this.lodLevels, this._adaptiveMinimumLevel, overrideBounds || this.bounds,
      distance, previousLevel, dimensionLevel
    );
  }

  /**
   * The cells a reduced level draws, as `getLodMembership` publishes them for
   * a tree (`SpatialIndex#getLodMembership`): one `admissionLevels` byte a
   * cell, shared by every level, and the level's `indices`. Null for full
   * detail.
   *
   * @param {number} lodLevel
   * @returns {object|null}
   */
  getLodMembership(lodLevel) {
    if (lodLevel === -1) return null;
    if (!Number.isInteger(lodLevel) || lodLevel < 0 || lodLevel >= this.lodLevels.length) {
      throw new RangeError(`RankLevels membership level ${String(lodLevel)} is outside the published inventory.`);
    }
    if (this.lodLevels[lodLevel].isFullDetail) return null;
    if (this._membership === null) {
      // A cell's rank is its open position, and a ranked store holds the
      // cells of ranks [a, b) in slots [a, b) whatever their order there, so
      // a level admits the cells below its count.
      const admissionLevels = new Uint8Array(this.pointCount);
      admissionLevels.fill(LOD_FULL_DETAIL_ADMISSION_LEVEL);
      let previous = 0;
      for (let level = 0; level < this.lodLevels.length - 1; level++) {
        const count = this.lodLevels[level].pointCount;
        admissionLevels.fill(level, previous, count);
        previous = count;
      }
      this._membership = { admissionLevels, generationToken: Object.freeze({}), descriptors: new Map() };
    }
    let descriptor = this._membership.descriptors.get(lodLevel);
    if (descriptor === undefined) {
      descriptor = Object.freeze({
        admissionLevels: this._membership.admissionLevels,
        dimensionLevel: this.dimensionLevel,
        generationToken: this._membership.generationToken,
        indices: this.lodLevels[lodLevel].indices,
        lodLevel,
        pointCount: this.pointCount,
        // The level's cells are the store's first slots, whatever order the
        // store holds them in.
        slotPrefix: true,
      });
      this._membership.descriptors.set(lodLevel, descriptor);
    }
    return descriptor;
  }

  /** The first `count` slots' cells, in slot order. @private */
  _prefix(count) {
    const sources = this._slotSources();
    if (sources !== null) return sources.subarray(0, count);
    if (this._identity === null || this._identity.length < count) {
      // One growing array of 0..k-1 serves every level asked for so far.
      const identity = new Uint32Array(count);
      for (let i = 0; i < count; i++) identity[i] = i;
      this._identity = identity;
    }
    return this._identity.subarray(0, count);
  }
}
