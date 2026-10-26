/**
 * Unified 1D/2D/3D spatial index for LOD and frustum culling.
 *
 * Depends on the renderer contracts, the tree builder (`spatial-tree.js`)
 * and the draw order (`draw-order.js`); the renderer depends on it, and
 * nothing in this module references HighPerfRenderer. A tree and its draw
 * order are usually built off the main thread (`spatial-tree-job.js`) and
 * handed in (`prebuiltTree`, `prebuiltOrder`).
 */
import {
  requireDimensionLevel,
  requireFiniteNumber,
  requireNumericVector,
} from './renderer-contracts.js';
import { buildSpatialTree, requirePrebuiltSpatialTree } from './spatial-tree.js';
import {
  LOD_FULL_DETAIL_ADMISSION_LEVEL,
  LOD_REDUCTION_FACTORS,
  buildDrawOrder,
  buildHierarchicalOrder,
  lodPrefixCounts,
} from './draw-order.js';
import { formatCountOf, formatCount } from '../../utils/format-units.js';


/**
 * The point count an adaptive LOD level is allowed to fall to.
 *
 * How far adaptive selection may go, from both ends.
 *
 * Adaptive selection is a frame-rate control, not a data-reduction policy, so
 * its coarsest useful answer is bounded. A fixed reduction ratio is what made a
 * large dataset unusable: at 18.1M cells the coarsest ladder step is 44x, which
 * the selector reaches on any pull-back and which discards 97.7% of the cells
 * whether or not the frame needed it.
 *
 * Two bounds, and the smaller count wins.
 *
 * `ADAPTIVE_LOD_POINT_BUDGET` is the absolute one: once a level draws this many
 * points, drawing is comfortable and further reduction buys nothing a viewer can
 * see. It is the bound that binds on an atlas.
 *
 * `ADAPTIVE_LOD_MAXIMUM_REDUCTION` is the relative one, and it is the bound that
 * binds on everything else. Expressing the floor as an absolute count alone made
 * it unsatisfiable below the budget -- no level of a 200k cloud holds 2M points,
 * so the floor landed on full detail and adaptive selection answered full detail
 * at every camera distance. On the datasets most people open, `Auto` did nothing
 * at all: the level readout never moved, and the only working control was the
 * forced-level slider. A cap on the ratio is satisfiable at every size, so the
 * camera drives the level on a 3,696-cell trajectory and an 18M-cell atlas
 * alike, while the absolute budget still stops the atlas short of the 44x step
 * that started this.
 *
 * The forced-level slider is deliberately not bounded by either. Asking for a
 * coarser level explicitly is a legitimate request on hardware that needs it.
 */
const ADAPTIVE_LOD_POINT_BUDGET = 2_000_000;
const ADAPTIVE_LOD_MAXIMUM_REDUCTION = 8;

// ============================================================================
// SPATIAL INDEX FOR LOD AND FRUSTUM CULLING (1D/2D/3D)
// ============================================================================

/**
 * Unified spatial index that adapts to data dimensionality:
 * - 1D: Binary tree (2 children) - for 1D layouts/histograms
 * - 2D: Quadtree (4 children) - for 2D projections (UMAP, t-SNE)
 * - 3D: Octree (8 children) - for 3D embeddings (PCA, etc.)
 *
 * Enables frustum culling and spatially-uniform LOD sampling in the
 * appropriate dimension space.
 */
export class SpatialIndex {
  /**
   * @param {Float32Array} positions - Position data, `dimensionLevel`
   *   components per point (x, xy or xyz; see rendering/position-layout.js)
   * @param {Uint8Array} colors - RGBA color data
   * @param {number} dimensionLevel - 1, 2, or 3: tree type and position stride
   * @param {number} maxPointsPerNode - Max points before subdivision
   * @param {number} maxDepth - Maximum tree depth
   * @param {Object} options
   * @param {boolean} options.buildLOD - Whether to generate LOD levels.
   * @param {{bounds: object, root: object}|null} [options.prebuiltTree] - A tree
   *   `buildSpatialTree` already built over exactly these positions.
   * @param {object|null} [options.prebuiltOrder] - That tree's draw order,
   *   computed with it off the main thread (`computeTreeDrawOrder`): banded by
   *   LOD when `buildLOD`, else one band.
   */
  constructor(positions, colors, dimensionLevel, maxPointsPerNode, maxDepth, options) {
    const exactDimensionLevel = requireDimensionLevel(
      dimensionLevel,
      'SpatialIndex dimensionLevel'
    );
    if (
      !(positions instanceof Float32Array) ||
      positions.length === 0 ||
      positions.length % exactDimensionLevel !== 0
    ) {
      throw new TypeError(
        'SpatialIndex positions must be a non-empty Float32Array with exactly dimensionLevel values per point.'
      );
    }
    const pointCount = positions.length / exactDimensionLevel;
    if (!Number.isInteger(maxPointsPerNode) || maxPointsPerNode <= 0) {
      throw new TypeError('SpatialIndex maxPointsPerNode must be a positive integer.');
    }
    if (!Number.isInteger(maxDepth) || maxDepth <= 0) {
      throw new TypeError('SpatialIndex maxDepth must be a positive integer.');
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('SpatialIndex options must be an object.');
    }
    const { buildLOD, prebuiltTree, prebuiltOrder } = options;
    if (typeof buildLOD !== 'boolean') {
      throw new TypeError('SpatialIndex buildLOD option must be a boolean.');
    }
    if (
      colors !== null &&
      (
        !(colors instanceof Uint8Array) ||
        colors.length !== pointCount * 4
      )
    ) {
      throw new TypeError(
        `SpatialIndex colors must be null or an RGBA Uint8Array with exactly ${formatCountOf(pointCount * 4, 'byte')}.`
      );
    }

    this._buildLOD = buildLOD;
    // The one order the GPU draws this tree's points in (see
    // `buildDrawOrder`). Every reduced LOD level is a prefix of it.
    this.drawOrder = null;
    // Built lazily only when a CPU consumer needs random-access LOD
    // membership (highlights, connectivity, or export). All reduced LODs are
    // nested prefixes of the draw order, so one byte per source point is
    // sufficient for every level and every view sharing this spatial owner.
    this._lodMembershipOwner = null;
    // The coarsest level adaptive selection may return, published by
    // `_generateLODLevels`. Zero imposes no bound, which is unreachable before
    // generation: `getLODLevel` answers -1 while there is no inventory.
    this._adaptiveMinimumLevel = 0;

    this.maxPointsPerNode = maxPointsPerNode;
    this.maxDepth = maxDepth;
    this.positions = positions;
    this.colors = colors;
    this.dimensionLevel = exactDimensionLevel;
    this.childCount = 1 << this.dimensionLevel; // 2, 4, or 8

    this.pointCount = pointCount;

    const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
    const treeName = treeNames[this.dimensionLevel];

    // The tree: built here, or built off the main thread by
    // spatial-tree-worker.js over the same positions and handed in.
    if (prebuiltTree !== undefined && prebuiltTree !== null) {
      requirePrebuiltSpatialTree(prebuiltTree, pointCount);
      this.bounds = prebuiltTree.bounds;
      this.root = prebuiltTree.root;
    } else {
      console.time(`${treeName} build`);
      const tree = buildSpatialTree(positions, exactDimensionLevel, maxPointsPerNode, maxDepth);
      console.timeEnd(`${treeName} build`);
      this.bounds = tree.bounds;
      this.root = tree.root;
    }

    // LOD is optional (many consumers just need the tree for queries/picking).
    if (prebuiltOrder !== undefined && prebuiltOrder !== null) {
      if (prebuiltTree === undefined || prebuiltTree === null) {
        throw new TypeError('SpatialIndex prebuiltOrder requires the prebuilt tree it was computed with.');
      }
      const banded = prebuiltOrder.bandCount === LOD_REDUCTION_FACTORS.length;
      if (
        prebuiltOrder.pointCount !== pointCount ||
        !(prebuiltOrder.indices instanceof Uint32Array) ||
        prebuiltOrder.indices.length !== pointCount ||
        (this._buildLOD ? !banded : prebuiltOrder.bandCount !== 1)
      ) {
        throw new TypeError(
          `SpatialIndex prebuiltOrder must be the ${this._buildLOD ? 'LOD-banded' : 'one-band'} draw order of these ${formatCountOf(pointCount, 'point')}.`
        );
      }
      this._publishDrawOrder(prebuiltOrder);
      this.lodLevels = this._buildLOD ? this._levelsFromDrawOrder() : [];
    } else if (this._buildLOD) {
      console.time('LOD generation');
      this.lodLevels = this._generateLODLevels();
      console.timeEnd('LOD generation');
    } else {
      this.lodLevels = [];
    }
  }

  /**
   * Compute and publish the LOD-banded draw order, and return the levels.
   * @private
   */
  _generateLODLevels() {
    const hierarchy = buildHierarchicalOrder(this.positions, this.bounds, this.dimensionLevel);
    this._publishDrawOrder(buildDrawOrder(
      this.root,
      this.dimensionLevel,
      this.pointCount,
      hierarchy,
      lodPrefixCounts(this.pointCount)
    ));
    return this._levelsFromDrawOrder();
  }

  /**
   * Publish a computed draw order as this index's (frozen, with a fresh
   * token), dropping the LOD membership built for the previous one.
   * @private
   */
  _publishDrawOrder(order) {
    this._lodMembershipOwner = null;
    this.drawOrder = Object.freeze({
      indices: order.indices,
      bandCount: order.bandCount,
      bandEnds: order.bandEnds,
      leafCount: order.leafCount,
      leafOffsets: order.leafOffsets,
      pointCount: order.pointCount,
      token: Object.freeze({}),
    });
    return this.drawOrder;
  }

  /**
   * The LOD levels of the published banded draw order: each reduced level a
   * view of its prefix, the last every point.
   * @private
   */
  _levelsFromDrawOrder() {
    const levels = [];
    const totalPoints = this.pointCount;
    const drawOrder = this.drawOrder;
    for (let levelIdx = 0; levelIdx < LOD_REDUCTION_FACTORS.length; levelIdx++) {
      const factor = LOD_REDUCTION_FACTORS[levelIdx];
      if (factor === 1) {
        levels.push({
          depth: levelIdx,
          pointCount: totalPoints,
          positions: this.positions,
          colors: this.colors, // RGBA uint8 with alpha packed
          sizes: null,
          isFullDetail: true
        });
        continue;
      }
      const pointCount = drawOrder.bandEnds[levelIdx];
      levels.push({
        depth: levelIdx,
        pointCount,
        // Exact original IDs for source-data lookup: a view of the draw order.
        indices: drawOrder.indices.subarray(0, pointCount),
        sizes: null,
        isFullDetail: false,
        sizeMultiplier: Math.sqrt(factor) * 0.2 + 0.8
      });
    }

    // The coarsest level adaptive selection may choose. Levels are ordered
    // coarse-to-fine and their counts are non-decreasing, so the first level
    // that meets the floor count is that bound. The floor count is the smaller
    // of the absolute budget and the reduction cap, so it is satisfiable at
    // every dataset size -- the full-detail level always holds `totalPoints`,
    // which is above `totalPoints / ADAPTIVE_LOD_MAXIMUM_REDUCTION` -- and the
    // loop therefore always terminates on a real level.
    const adaptiveFloorCount = Math.min(
      ADAPTIVE_LOD_POINT_BUDGET,
      totalPoints / ADAPTIVE_LOD_MAXIMUM_REDUCTION
    );
    let adaptiveMinimumLevel = levels.length - 1;
    for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
      if (levels[levelIdx].pointCount >= adaptiveFloorCount) {
        adaptiveMinimumLevel = levelIdx;
        break;
      }
    }
    this._adaptiveMinimumLevel = adaptiveMinimumLevel;

    const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
    const treeName = treeNames[this.dimensionLevel] || 'Octree';
    console.log(`[${treeName}] Generated ${levels.length} LOD levels (dim=${this.dimensionLevel}):`,
      levels.map(l => `${formatCount(l.pointCount)} pts`).join(', '),
      `| adaptive floor: level ${adaptiveMinimumLevel} `
      + `(${formatCount(levels[adaptiveMinimumLevel].pointCount)} pts)`);

    return levels;
  }

  /**
   * The draw order, built on first use. A tree without LOD gets the
   * one-band order; generating LOD later replaces it with the banded one.
   *
   * @returns {object}
   */
  ensureDrawOrder() {
    if (this.drawOrder !== null) return this.drawOrder;
    return this._publishDrawOrder(
      buildDrawOrder(this.root, this.dimensionLevel, this.pointCount, null, null)
    );
  }

  /**
   * Write the element ranges that draw the given leaf runs at one LOD band
   * limit: every band up to and including `lastBand`, each run of leaves one
   * range per band. Ranges that touch are merged.
   *
   * With `maxRanges`, the ranges are coarsened to fit it by bridging the
   * gaps that hide the fewest points: a gap is between two runs inside one
   * band, and bridging it draws the points it hides in that band. So a band
   * that holds few points between two runs merges there, while the band
   * that holds most of the points keeps its gaps -- the drawn total stays
   * close to the exact cull for the call budget.
   *
   * @param {Uint32Array} runs - `[leafStart, leafEnd)` pairs, ascending and
   *   disjoint.
   * @param {number} runCount - Pairs to read from `runs`.
   * @param {number} lastBand - The last band drawn (a reduced level, or the
   *   last band for full detail).
   * @param {Int32Array} starts - Out: first element of each range.
   * @param {Int32Array} counts - Out: element count of each range.
   * @param {number} [maxRanges=Infinity] - Most ranges to write.
   * @param {{gaps?: Uint32Array}} [scratch] - Reused gap scratch.
   * @returns {{ rangeCount: number, elementCount: number }}
   */
  writeDrawRanges(runs, runCount, lastBand, starts, counts, maxRanges = Infinity, scratch = {}) {
    const order = this.drawOrder;
    if (order === null) {
      throw new Error('SpatialIndex draw ranges require a published draw order.');
    }
    if (!Number.isInteger(lastBand) || lastBand < 0 || lastBand >= order.bandCount) {
      throw new RangeError(`SpatialIndex draw band ${String(lastBand)} is outside [0, ${order.bandCount - 1}].`);
    }
    const stride = order.leafCount + 1;
    const offsets = order.leafOffsets;
    // The smallest hidden-point count a kept gap may have: gaps hiding fewer
    // points are bridged. Ties at the threshold are kept left to right while
    // the budget lasts.
    let threshold = 0;
    let tiesKept = Infinity;
    if (Number.isFinite(maxRanges)) {
      let gaps = scratch.gaps;
      const capacity = runCount * (lastBand + 1);
      if (!(gaps instanceof Uint32Array) || gaps.length < capacity) {
        gaps = new Uint32Array(Math.max(capacity, 64));
        scratch.gaps = gaps;
      }
      let gapCount = 0;
      let bandsWithPoints = 0;
      for (let band = 0; band <= lastBand; band++) {
        const base = band * stride;
        let previousEnd = -1;
        for (let run = 0; run < runCount; run++) {
          const start = offsets[base + runs[run * 2]];
          const end = offsets[base + runs[run * 2 + 1]];
          if (end <= start) continue;
          if (previousEnd < 0) bandsWithPoints++;
          else if (start > previousEnd) gaps[gapCount++] = start - previousEnd;
          previousEnd = end;
        }
      }
      const keep = Math.max(0, maxRanges - bandsWithPoints);
      if (gapCount > keep) {
        const sorted = gaps.subarray(0, gapCount).slice().sort();
        // Keep the `keep` largest: everything above the threshold, plus as
        // many gaps equal to it as the budget still allows.
        threshold = keep === 0 ? Infinity : sorted[gapCount - keep];
        let above = 0;
        for (let i = gapCount - 1; i >= 0 && sorted[i] > threshold; i--) above++;
        tiesKept = keep - above;
      }
    }
    let rangeCount = 0;
    let elementCount = 0;
    let openStart = -1;
    let openEnd = -1;
    const close = () => {
      if (openEnd <= openStart) return;
      if (rangeCount >= starts.length) {
        throw new RangeError('SpatialIndex draw range capacity is too small.');
      }
      starts[rangeCount] = openStart;
      counts[rangeCount] = openEnd - openStart;
      elementCount += openEnd - openStart;
      rangeCount++;
    };
    for (let band = 0; band <= lastBand; band++) {
      const base = band * stride;
      let previousEnd = -1;
      for (let run = 0; run < runCount; run++) {
        const start = offsets[base + runs[run * 2]];
        const end = offsets[base + runs[run * 2 + 1]];
        if (end <= start) continue;
        if (start === openEnd) {
          openEnd = end;
        } else if (previousEnd >= 0) {
          // A gap inside this band: keep it, or bridge it.
          const hidden = start - previousEnd;
          const kept = hidden > threshold || (hidden === threshold && tiesKept > 0);
          if (kept) {
            if (hidden === threshold) tiesKept--;
            close();
            openStart = start;
          }
          openEnd = end;
        } else {
          close();
          openStart = start;
          openEnd = end;
        }
        previousEnd = end;
      }
    }
    close();
    return { rangeCount, elementCount };
  }

  /**
   * Build one exact, shared admission-level owner for every reduced LOD.
   *
   * `admissionLevels[originalId]` is the first reduced LOD level that admits
   * the source point. `0xff` means the point appears only at terminal full
   * detail. Because the LOD index arrays are nested views into one hierarchy,
   * this replaces every per-view Float32 membership mask with one immutable
   * byte owner per spatial generation.
   *
   * Publication is transactional: allocation and complete prefix validation
   * finish off-state before `_lodMembershipOwner` changes.
   *
   * @private
   * @returns {Object}
   */
  _ensureLodMembershipOwner() {
    if (this._lodMembershipOwner !== null) {
      return this._lodMembershipOwner;
    }
    if (
      !Array.isArray(this.lodLevels) ||
      this.lodLevels.length < 1
    ) {
      throw new Error(
        'SpatialIndex LOD membership requires a published LOD inventory.'
      );
    }

    const terminalLevel = this.lodLevels.length - 1;
    if (terminalLevel >= LOD_FULL_DETAIL_ADMISSION_LEVEL) {
      throw new RangeError(
        'SpatialIndex LOD membership exceeds the Uint8 admission-level contract.'
      );
    }
    const fullDetail = this.lodLevels[terminalLevel];
    if (
      fullDetail?.isFullDetail !== true ||
      fullDetail.pointCount !== this.pointCount
    ) {
      throw new Error(
        'SpatialIndex LOD membership requires one exact terminal full-detail level.'
      );
    }

    const hierarchy = this.drawOrder?.indices;
    if (
      !(hierarchy instanceof Uint32Array) ||
      hierarchy.length !== this.pointCount
    ) {
      throw new Error(
        'SpatialIndex LOD membership requires one exact full point hierarchy.'
      );
    }

    const admissionLevels = new Uint8Array(this.pointCount);
    admissionLevels.fill(LOD_FULL_DETAIL_ADMISSION_LEVEL);
    const generationToken = Object.freeze({});
    const descriptorsByLevel = new Array(this.lodLevels.length);
    let previousCount = 0;

    for (let lodLevel = 0; lodLevel < terminalLevel; lodLevel++) {
      const level = this.lodLevels[lodLevel];
      const indices = level?.indices;
      if (
        level?.isFullDetail !== false ||
        !(indices instanceof Uint32Array) ||
        !Number.isSafeInteger(level.pointCount) ||
        level.pointCount !== indices.length ||
        level.pointCount < previousCount ||
        level.pointCount > this.pointCount
      ) {
        throw new Error(
          `SpatialIndex LOD ${lodLevel} is not one exact monotonic reduced prefix.`
        );
      }
      if (
        indices.buffer !== hierarchy.buffer ||
        indices.byteOffset !== hierarchy.byteOffset
      ) {
        throw new Error(
          `SpatialIndex LOD ${lodLevel} does not share the exact hierarchical prefix owner.`
        );
      }

      for (
        let compactRank = previousCount;
        compactRank < level.pointCount;
        compactRank++
      ) {
        const originalId = hierarchy[compactRank];
        if (originalId >= this.pointCount) {
          throw new RangeError(
            `SpatialIndex LOD ${lodLevel} contains source ID ${originalId} outside ${formatCountOf(this.pointCount, 'point')}.`
          );
        }
        if (
          admissionLevels[originalId] !==
          LOD_FULL_DETAIL_ADMISSION_LEVEL
        ) {
          throw new Error(
            `SpatialIndex LOD hierarchy repeats source ID ${originalId}.`
          );
        }
        admissionLevels[originalId] = lodLevel;
      }

      descriptorsByLevel[lodLevel] = Object.freeze({
        admissionLevels,
        dimensionLevel: this.dimensionLevel,
        generationToken,
        indices,
        lodLevel,
        pointCount: this.pointCount,
      });
      previousCount = level.pointCount;
    }

    // Reduced descriptors only expose hierarchy prefixes, but the backing
    // hierarchy must still be one exact full-point permutation. Validate the
    // terminal tail without retaining another point-count allocation: use the
    // unpublished admission candidate as a temporary visited table, then
    // restore terminal-only points to the canonical 0xff sentinel.
    for (
      let compactRank = previousCount;
      compactRank < this.pointCount;
      compactRank++
    ) {
      const originalId = hierarchy[compactRank];
      if (originalId >= this.pointCount) {
        throw new RangeError(
          `SpatialIndex LOD hierarchy tail contains source ID ${originalId} outside ${formatCountOf(this.pointCount, 'point')}.`
        );
      }
      if (
        admissionLevels[originalId] !==
        LOD_FULL_DETAIL_ADMISSION_LEVEL
      ) {
        throw new Error(
          `SpatialIndex LOD hierarchy repeats source ID ${originalId} in its full-detail tail.`
        );
      }
      admissionLevels[originalId] = terminalLevel;
    }
    for (
      let compactRank = previousCount;
      compactRank < this.pointCount;
      compactRank++
    ) {
      admissionLevels[hierarchy[compactRank]] =
        LOD_FULL_DETAIL_ADMISSION_LEVEL;
    }
    descriptorsByLevel[terminalLevel] = null;

    const candidate = Object.freeze({
      admissionLevels,
      descriptorsByLevel: Object.freeze(descriptorsByLevel),
      generationToken,
    });
    this._lodMembershipOwner = candidate;
    return candidate;
  }

  /**
   * Return the exact shared membership descriptor for one LOD level.
   * Terminal full detail is represented by null (all points admitted).
   *
   * @param {number} lodLevel
   * @returns {Object|null}
   */
  getLodMembership(lodLevel) {
    if (lodLevel === -1) return null;
    if (
      !Number.isInteger(lodLevel) ||
      lodLevel < 0 ||
      lodLevel >= this.lodLevels.length
    ) {
      throw new RangeError(
        `SpatialIndex LOD membership level ${String(lodLevel)} is outside the published inventory.`
      );
    }
    if (this.lodLevels[lodLevel]?.isFullDetail === true) {
      return null;
    }
    const owner = this._ensureLodMembershipOwner();
    const descriptor = owner.descriptorsByLevel[lodLevel];
    if (descriptor === null || descriptor === undefined) {
      throw new Error(
        `SpatialIndex LOD ${lodLevel} has no exact membership descriptor.`
      );
    }
    return descriptor;
  }

  /**
   * Get LOD level for a given camera distance.
   * @param {number} distance - Camera distance from target
   * @param {number} previousLevel - Previous LOD level for this view (for hysteresis). Pass -1 or undefined for first call.
   * @param {number} dimensionLevel - Current dimension level (1, 2, or 3).
   * @param {Object} [overrideBounds] - Optional bounds override for view-specific positions.
   *   When positions differ from octree (e.g., 2D projection), pass actual bounds to get
   *   correct LOD selection. Format: { minX, maxX, minY, maxY, minZ, maxZ }
   * @returns {number} LOD level (0 = coarsest, `lodLevels.length - 1` = full
   *   detail). The answer is never coarser than the adaptive point budget
   *   allows; a forced level bypasses this selector entirely.
   */
  getLODLevel(distance, previousLevel, dimensionLevel, overrideBounds = null) {
    if (this.lodLevels.length === 0) return -1;

    const validDimLevel = requireDimensionLevel(
      dimensionLevel,
      'SpatialIndex LOD dimensionLevel'
    );

    const numLevels = this.lodLevels.length;

    // Calculate data diagonal size for scale-independent LOD selection
    // Use override bounds if provided (for view-specific positions), otherwise use the tree's bounds
    const bounds = overrideBounds || this.bounds;
    const dx = bounds.maxX - bounds.minX;
    const dy = bounds.maxY - bounds.minY;
    const dz = bounds.maxZ - bounds.minZ;
    // For lower dimensions, use only the significant extents (data may be along any axis)
    // Sort extents to find the largest ones regardless of which axis they're on
    let dataSize;
    if (validDimLevel === 1) {
      // 1D: use the largest extent (data could be along X, Y, or Z)
      dataSize = Math.max(dx, dy, dz) || 1;
	    } else if (validDimLevel === 2) {
	      // 2D: use the two largest extents (handles XY, XZ, or YZ planes)
	      // Avoid allocation/sort in a hot helper (used when adaptive LOD is enabled).
	      const maxExtent = Math.max(dx, dy, dz);
	      const minExtent = Math.min(dx, dy, dz);
	      const midExtent = dx + dy + dz - maxExtent - minExtent;
	      dataSize = Math.sqrt(maxExtent * maxExtent + midExtent * midExtent) || 1;
	    } else {
	      dataSize = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;  // 3D+: full diagonal
	    }

    // Normalize distance relative to data size
    const distanceRatio = distance / dataSize;

    // Map distance ratio to LOD level
    const minRatio = 0.3;
    const maxRatio = 3.0;
    const clampedRatio = Math.max(minRatio, Math.min(maxRatio, distanceRatio));

    const t = 1.0 - (Math.log(clampedRatio / minRatio) / Math.log(maxRatio / minRatio));
    const targetLevel = t * (numLevels - 1);

    // Apply hysteresis with large dead zone to prevent oscillation
    const HYSTERESIS = 0.7;

    // Use passed previousLevel for per-view hysteresis (instead of global state)
    const currentLevel = previousLevel >= 0 ? previousLevel : Math.round(targetLevel);
    let newLevel = currentLevel;

    if (targetLevel > currentLevel + HYSTERESIS && currentLevel < numLevels - 1) {
      newLevel = currentLevel + 1;
    } else if (targetLevel < currentLevel - HYSTERESIS && currentLevel > 0) {
      newLevel = currentLevel - 1;
    }

    const floorLevel = Math.min(
      numLevels - 1,
      Math.max(0, this._adaptiveMinimumLevel)
    );
    return Math.max(floorLevel, Math.min(numLevels - 1, newLevel));
  }

  _boundsIntersectsSphere(bounds, center, radius) {
    // Clamp point to AABB and measure distance to sphere center
    const cx = Math.max(bounds.minX, Math.min(center[0], bounds.maxX));
    const cy = Math.max(bounds.minY, Math.min(center[1], bounds.maxY));
    const cz = Math.max(bounds.minZ, Math.min(center[2], bounds.maxZ));
    const dx = cx - center[0];
    const dy = cy - center[1];
    const dz = cz - center[2];
    return (dx * dx + dy * dy + dz * dz) <= radius * radius;
  }

  /**
   * Visit every point in leaves whose bounds intersect a sphere. Node
   * rejection is conservative; the caller owns the exact point-level
   * predicate. Unlike queryRadius(), this traversal has no result cap.
   * Each original point ID is visited at most once.
   *
   * @param {ArrayLike<number>} center
   * @param {number} radius
   * @param {(cellIndex: number) => void} visitor
   */
  visitRadiusCandidates(center, radius, visitor) {
    requireNumericVector(center, 3, 'SpatialIndex radius center');
    if (!Number.isFinite(radius) || radius < 0) {
      throw new RangeError(
        'SpatialIndex radius must be a finite non-negative number.'
      );
    }
    if (typeof visitor !== 'function') {
      throw new TypeError('SpatialIndex radius visitor must be a function.');
    }
    if (!this.root) return;

    const stack = [this.root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (
        !node ||
        !this._boundsIntersectsSphere(node.bounds, center, radius)
      ) {
        continue;
      }
      if (node.indices) {
        for (let index = 0; index < node.indices.length; index++) {
          visitor(node.indices[index]);
        }
      } else if (node.children) {
        for (let index = 0; index < node.children.length; index++) {
          const child = node.children[index];
          if (child) stack.push(child);
        }
      }
    }
  }

  _boundsIntersectsProjectedRect(bounds, mvpMatrix, clipPlanes) {
    // Screen-space division reverses inequalities behind the eye. Only prune
    // boxes proven wholly in front of the clip-W singularity; boxes touching
    // or crossing it are traversed so the caller's exact projection predicate
    // remains authoritative.
    const wa = mvpMatrix[3];
    const wb = mvpMatrix[7];
    const wc = mvpMatrix[11];
    const wd = mvpMatrix[15];
    const minimumClipW =
      wd +
      wa * (wa >= 0 ? bounds.minX : bounds.maxX) +
      wb * (wb >= 0 ? bounds.minY : bounds.maxY) +
      wc * (wc >= 0 ? bounds.minZ : bounds.maxZ);
    if (minimumClipW <= 1e-10) return true;

    for (let planeOffset = 0; planeOffset < 24; planeOffset += 4) {
      const a = clipPlanes[planeOffset];
      const b = clipPlanes[planeOffset + 1];
      const c = clipPlanes[planeOffset + 2];
      const d = clipPlanes[planeOffset + 3];
      const maximum =
        d +
        a * (a >= 0 ? bounds.maxX : bounds.minX) +
        b * (b >= 0 ? bounds.maxY : bounds.minY) +
        c * (c >= 0 ? bounds.maxZ : bounds.minZ);
      if (maximum < 0) return false;
    }
    return true;
  }

  /**
   * Visit every point in leaves that can project into an NDC rectangle while
   * passing the canonical near/far clip planes. The six object-space planes
   * are derived exactly from the captured MVP matrix and rectangle. Boxes
   * crossing clip-W=0 are deliberately retained for exact point testing.
   *
   * @param {ArrayLike<number>} mvpMatrix Column-major MVP matrix.
   * @param {{minX:number,maxX:number,minY:number,maxY:number}} ndcBounds
   * @param {(cellIndex: number) => void} visitor
   */
  visitProjectedRectCandidates(mvpMatrix, ndcBounds, visitor) {
    requireNumericVector(
      mvpMatrix,
      16,
      'SpatialIndex projected-rectangle MVP matrix'
    );
    if (
      ndcBounds === null ||
      typeof ndcBounds !== 'object' ||
      Array.isArray(ndcBounds)
    ) {
      throw new TypeError(
        'SpatialIndex projected-rectangle NDC bounds must be an object.'
      );
    }
    const minX = requireFiniteNumber(
      ndcBounds.minX,
      'SpatialIndex projected-rectangle minX'
    );
    const maxX = requireFiniteNumber(
      ndcBounds.maxX,
      'SpatialIndex projected-rectangle maxX'
    );
    const minY = requireFiniteNumber(
      ndcBounds.minY,
      'SpatialIndex projected-rectangle minY'
    );
    const maxY = requireFiniteNumber(
      ndcBounds.maxY,
      'SpatialIndex projected-rectangle maxY'
    );
    if (minX > maxX || minY > maxY) {
      throw new RangeError(
        'SpatialIndex projected-rectangle NDC bounds must be ordered.'
      );
    }
    if (typeof visitor !== 'function') {
      throw new TypeError(
        'SpatialIndex projected-rectangle visitor must be a function.'
      );
    }
    if (!this.root) return;

    // Column-major clip rows: X=(0,4,8,12), Y=(1,5,9,13),
    // Z=(2,6,10,14), W=(3,7,11,15).
    const planes = new Float64Array(24);
    const setPlane = (offset, xFactor, yFactor, zFactor, wFactor) => {
      planes[offset] =
        xFactor * mvpMatrix[0] +
        yFactor * mvpMatrix[1] +
        zFactor * mvpMatrix[2] +
        wFactor * mvpMatrix[3];
      planes[offset + 1] =
        xFactor * mvpMatrix[4] +
        yFactor * mvpMatrix[5] +
        zFactor * mvpMatrix[6] +
        wFactor * mvpMatrix[7];
      planes[offset + 2] =
        xFactor * mvpMatrix[8] +
        yFactor * mvpMatrix[9] +
        zFactor * mvpMatrix[10] +
        wFactor * mvpMatrix[11];
      planes[offset + 3] =
        xFactor * mvpMatrix[12] +
        yFactor * mvpMatrix[13] +
        zFactor * mvpMatrix[14] +
        wFactor * mvpMatrix[15];
    };
    setPlane(0, 1, 0, 0, -minX);   // clipX >= minX * clipW
    setPlane(4, -1, 0, 0, maxX);   // clipX <= maxX * clipW
    setPlane(8, 0, 1, 0, -minY);   // clipY >= minY * clipW
    setPlane(12, 0, -1, 0, maxY);  // clipY <= maxY * clipW
    setPlane(16, 0, 0, 1, 1);      // clipZ >= -clipW
    setPlane(20, 0, 0, -1, 1);     // clipZ <= clipW

    const stack = [this.root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (
        !node ||
        !this._boundsIntersectsProjectedRect(
          node.bounds,
          mvpMatrix,
          planes
        )
      ) {
        continue;
      }
      if (node.indices) {
        for (let index = 0; index < node.indices.length; index++) {
          visitor(node.indices[index]);
        }
      } else if (node.children) {
        for (let index = 0; index < node.children.length; index++) {
          const child = node.children[index];
          if (child) stack.push(child);
        }
      }
    }
  }

  queryRadius(center, radius, maxResults = 64) {
    if (!this.root || radius <= 0) return [];
    const results = [];
    const stack = [this.root];
    const r2 = radius * radius;
    const stride = this.dimensionLevel;

    while (stack.length && results.length < maxResults) {
      const node = stack.pop();
      if (!node) continue;
      if (!this._boundsIntersectsSphere(node.bounds, center, radius)) continue;

      if (node.indices) {
        for (let i = 0; i < node.indices.length && results.length < maxResults; i++) {
          const idx = node.indices[i];
          const base = idx * stride;
          const px = this.positions[base];
          const py = stride > 1 ? this.positions[base + 1] : 0;
          const pz = stride > 2 ? this.positions[base + 2] : 0;
          const dx = px - center[0];
          const dy = py - center[1];
          const dz = pz - center[2];
          const dist2 = dx * dx + dy * dy + dz * dz;
          if (dist2 <= r2) {
            results.push(idx);
          }
        }
      } else if (node.children) {
        for (const child of node.children) {
          if (child) stack.push(child);
        }
      }
    }

    return results;
  }

  /**
   * Query points within radius at a specific LOD level.
   * Each result's lodIndex is its compact LOD-prefix position, while
   * originalIndex is the exact source-data point ID.
   * @param {Array} center - [x, y, z] center point
   * @param {number} radius - Search radius
   * @param {number} lodLevel - LOD level to query (0 = lowest detail, max = full detail)
   * @param {number} maxResults - Maximum results to return
   * @param {Float32Array} [customPositions] - Optional custom positions array for view-specific queries.
   *   If provided, queries against these positions instead of the spatial index's source positions.
   *   Must have the same point count and dimension (layout) as the source data.
   * @returns {Array} Array of { lodIndex, position, originalIndex }
   */
  queryRadiusAtLOD(center, radius, lodLevel, maxResults, customPositions = null) {
    if (radius <= 0) return [];

    const numLevels = this.lodLevels.length;
    if (!Number.isInteger(lodLevel) || lodLevel < 0 || lodLevel >= numLevels) {
      throw new RangeError(
        `SpatialIndex LOD level must be an integer in [0, ${numLevels - 1}].`
      );
    }
    if (!Number.isInteger(maxResults) || maxResults <= 0) {
      throw new TypeError('SpatialIndex maxResults must be a positive integer.');
    }
    if (
      customPositions !== null &&
      (!(customPositions instanceof Float32Array) ||
        customPositions.length !== this.positions.length)
    ) {
      throw new TypeError(
        `SpatialIndex customPositions must be null or a Float32Array with exactly ${formatCountOf(this.positions.length, 'value')}.`
      );
    }

    const level = this.lodLevels[lodLevel];
    const pointCount = level.pointCount;
    const isFullDetail = level.isFullDetail;
    const sourcePositions = customPositions ?? this.positions;

    const results = [];
    const r2 = radius * radius;

    // Simple brute force over the LOD candidate IDs (reduced levels are small enough).
    const stride = this.dimensionLevel;
    for (let i = 0; i < pointCount && results.length < maxResults; i++) {
      const originalIdx = isFullDetail ? i : level.indices[i];
      const sourceOffset = originalIdx * stride;
      const px = sourcePositions[sourceOffset];
      const py = stride > 1 ? sourcePositions[sourceOffset + 1] : 0;
      const pz = stride > 2 ? sourcePositions[sourceOffset + 2] : 0;

      const dx = px - center[0];
      const dy = py - center[1];
      const dz = pz - center[2];
      const dist2 = dx * dx + dy * dy + dz * dz;
      if (dist2 <= r2) {
        results.push({
          lodIndex: i,
          originalIndex: originalIdx,
          position: [px, py, pz]
        });
      }
    }

    return results;
  }

  getBoundingSphere() {
    const b = this.bounds;
    const centerX = (b.minX + b.maxX) * 0.5;
    const centerY = (b.minY + b.maxY) * 0.5;
    const centerZ = (b.minZ + b.maxZ) * 0.5;

    const dx = b.maxX - b.minX;
    const dy = b.maxY - b.minY;
    const dz = b.maxZ - b.minZ;
    const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5;

    return { center: [centerX, centerY, centerZ], radius };
  }

  /**
   * Publish one exact compact-rank-to-leaf mapping shared by every reduced
   * LOD. A query marks its visible leaf ordinals, then scans only [0, K) for
   * the requested prefix. The emitted EBO is therefore globally ordered by
   * compact rank and costs O(visible leaves + K), independent of Kmax.
   */
  /**
   * Validate that spatial index contains all original points.
   * Returns the total count of points in all leaf nodes.
   */
  validatePointCount() {
    let count = 0;
    const countLeaves = (node) => {
      if (!node) return;
      if (node.indices) {
        count += node.indices.length;
      } else if (node.children) {
        for (const child of node.children) {
          countLeaves(child);
        }
      }
    };
    countLeaves(this.root);
    const valid = count === this.pointCount;
    if (!valid) {
      const treeNames = { 1: 'BinaryTree', 2: 'Quadtree', 3: 'Octree' };
      console.error(`[${treeNames[this.dimensionLevel]}] Point count mismatch: tree has ${count}, expected ${this.pointCount}`);
    }
    return { count, expected: this.pointCount, valid };
  }
}

export { ADAPTIVE_LOD_MAXIMUM_REDUCTION, ADAPTIVE_LOD_POINT_BUDGET };
